import { spawn, type ChildProcess } from "node:child_process"
import { execFile as execFileCb } from "node:child_process"
import { randomUUID } from "node:crypto"
import { promisify } from "node:util"
import { acquireStateLock, readJson, releaseStateLock, writeJsonAtomic } from "@/lib/web-state"
import { isGitRepository } from "@/lib/code-source"
import { callGBrainServer } from "@/lib/gbrain-server"
import { submitGBrainJob } from "@/lib/gbrain-cli"

const execFile = promisify(execFileCb)

// gbrain 的 isCodeFilePath（sync.ts）用这套扩展名判定"代码页"。
// 这里只做轻量判定：仓库里只要存在这类文件，同步就必须用 --strategy auto，
// 否则源码被当作不可导入文件跳过，代码调用图永远是空的。
const CODE_FILE_RE = /\.(?:py|ts|tsx|go|rs|c|cc|cpp|h|hpp|java|js|jsx|rb|php|sh|kt|kts|swift|scala|cs|zig|nim|hs|lua|r|m|mm|dart|ex|exs|erl|clj|cljs|fs|fsi|vb|pas|asm|s)$/i

/**
 * 检测 Git 工作树是否含源码文件。用 `git ls-files`（跟踪 + 未跟踪非忽略），
 * 只统计命中代码扩展名的文件；命中即认为该 source 需要 auto 策略。
 * 非 Git 目录直接返回 false（本地目录导入保持 markdown/auto 原样）。
 */
async function detectCodeFiles(root: string): Promise<boolean> {
  try {
    const { stdout } = await execFile("git", [
      "-C", root,
      "ls-files", "--cached", "--others", "--exclude-standard", "-z",
    ], { maxBuffer: 512 * 1024 * 1024 })
    if (!stdout) return false
    const files = stdout.split("\0").filter(Boolean)
    return files.some((file) => CODE_FILE_RE.test(file))
  } catch {
    // git 不可用/非仓库 → 不施加 auto 策略
    return false
  }
}

export type SyncJobStatus = "queued" | "running" | "completed" | "failed"
export type SyncJobMode = "sync" | "import" | "manifest"

export interface SyncJob {
  id: string
  sourceId: string
  root: string
  status: SyncJobStatus
  startedAt: string
  finishedAt?: string
  processed?: number
  message?: string
  exitCode?: number | null
  output: string[]
  counts?: { added?: number; modified?: number; deleted?: number; renamed?: number; chunksCreated?: number }
  total?: number
  mode?: SyncJobMode
  /** "minion" = persisted in the gbrain minions queue (survives web restarts), undefined = legacy web-spawned child. */
  queue?: "minion"
  minionId?: number
}

const JOBS_FILE = "sync-jobs.json"
const MAX_OUTPUT_LINES = 120

type SyncRunnerRuntime = typeof globalThis & {
  __gbrainSyncActiveJobs?: Map<string, ChildProcess>
}

// Route handlers may load separate bundles in Next.js; keep the child-process
// registry on globalThis so job listing does not mistake a live job for an orphan.
const runtime = globalThis as SyncRunnerRuntime
const active = runtime.__gbrainSyncActiveJobs ??= new Map<string, ChildProcess>()

async function readJobs(): Promise<SyncJob[]> {
  return readJson<SyncJob[]>(JOBS_FILE, [])
}

async function saveJobs(jobs: SyncJob[]): Promise<void> {
  await writeJsonAtomic(JOBS_FILE, jobs.slice(-100))
}

export async function updateJob(job: SyncJob): Promise<void> {
  const jobs = await readJobs()
  const index = jobs.findIndex((item) => item.id === job.id)
  if (index >= 0) jobs[index] = job
  else jobs.push(job)
  await saveJobs(jobs)
}

export function appendOutput(job: SyncJob, chunk: Buffer | string): void {
  const lines = String(chunk).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  job.output.push(...lines)
  if (job.output.length > MAX_OUTPUT_LINES) job.output.splice(0, job.output.length - MAX_OUTPUT_LINES)
  job.message = lines.at(-1) || job.message
  // 从进度行提取"已处理文件数"，优先精确格式，避免误匹配摘要行。
  //   精确格式1: [import.files] 1573/1573 (100%) imported=1572 ... （N/M，含总数）
  //   精确格式2: import.collect_files done ... files=2781
  //   兜底格式: ...N pages imported
  // 误匹配案例（之前): "1 pages skipped (1 unchanged, ...)" 会把 processed 覆盖成 1。
  // 同一 chunk 可能含多条 tick 行，只取最后一次出现的进度，避免 processed/total 回退。
  const joined = lines.join(" ")
  const lastMatch = (re: RegExp): RegExpMatchArray | null => {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`)
    let match: RegExpMatchArray | null = null
    let m: RegExpMatchArray | null
    while ((m = g.exec(joined)) !== null) match = m
    return match
  }
  const progress =
    lastMatch(/\[import\.files\]\s+(\d+)\/(\d+)\s+\(\d+%\)/i) ??
    lastMatch(/\b(?:imported|files)=(\d+)/i) ??
    lastMatch(/(\d+)\s+pages? imported\b/i)
  if (progress) {
    const n = Number(progress[1])
    if (Number.isInteger(n) && n >= 0) job.processed = n
    // [import.files] N/M (P%) 格式同时给出总数，补齐进度分母 → 页面可显示 N/M。
    if (progress[2] !== undefined) {
      const m = Number(progress[2])
      if (Number.isInteger(m) && m > 0) job.total = m
    }
  }
}

function outputHasImportFailure(job: SyncJob): boolean {
  return job.output.some((line) =>
    /\b(?:errors?|failed)\s*[:=]\s*[1-9]\d*|\b\d+\s+files?\s+failed\b|Full sync blocked|Import complete .*\berrors?\s*[:=]?\s*[1-9]\d*/i.test(line),
  )
}

/**
 * 自愈护栏：纠正当前"卡死"的本地任务记录（见 startSyncJob 的 stale 检查）。
 * web 重启后 active Map 会丢，旧的 running/queued 本地记录再也没有子进程会在
 * close 时把它置为终态——这些是孤儿记录：任务区一直显示幽灵行，"已有任务"
 * 重复检查也永远被它挡住。返回修正后的记录；仍在 active Map（子进程真正在
 * 跑）或已提交给 minions 的记录不受影响。
 */
async function repairOrphanJobs(): Promise<SyncJob[]> {
  const local = await readJobs()
  // manifest 父任务由 manifest-sync-runner 驱动，不占 local ChildProcess/minion。
  // 它把仍在运行的 jobId 登记在 globalThis，孤儿修复不能误标为 failed。
  const manifestLive = (globalThis as typeof globalThis & { __gbrainManifestActiveJobIds?: Set<string> }).__gbrainManifestActiveJobIds
  let changed = false
  for (const item of local) {
    if (item.queue === "minion" || item.minionId != null) {
      // 已提交给 minions 队列的任务由队列侧驱动，不归 web 本地管。
      continue
    }
    if (item.status !== "running" && item.status !== "queued") continue
    if (item.id && active.has(item.id)) continue // 有活子进程 = 真任务
    if (item.id && manifestLive?.has(item.id)) continue // 活着的 manifest 父任务
    item.status = "failed"
    item.finishedAt = item.finishedAt ?? new Date().toISOString()
    item.message = item.message ? `${item.message} · 已中断（进程已结束或服务重启）` : "已中断（进程已结束或服务重启）"
    changed = true
  }
  if (changed) await saveJobs(local)
  return local
}

export async function listSyncJobs(): Promise<SyncJob[]> {
  const local = (await repairOrphanJobs()).sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  // 合并 minions 队列里的 sync/import 任务(sourceId/data.repoPath 标识),让页面
  // 刷新/重启后仍能看到持久化队列中的进行中任务。minions 结果在前,本地为准。
  const minions = await listMinionSyncJobs()
  const minionIds = new Set(minions.map((job) => job.id))
  return [...minions, ...local.filter((job) => !minionIds.has(job.id))]
}

export async function getSyncJob(id: string): Promise<SyncJob | null> {
  // minions 持久化任务:实时查询 gbrain 队列,而非本地 JSON(本地 JSON 只保留提交时快照)。
  if (id.startsWith("minion-")) {
    const minionId = id.slice("minion-".length)
    if (/^\d+$/.test(minionId)) {
      try {
        const row = (await callGBrainServer("get_job", { id: Number(minionId) })) as Record<string, unknown> | null
        if (row && typeof row === "object" && "id" in row) {
          const mapped = minionJobToSyncJob(row)
          if (mapped && mapped.id === id) return mapped
        }
        // gbrain 侧已不存在(被 prune 或清理)→ 查本地快照的最终状态。
      } catch {
        // fallthrough to local JSON snapshot
      }
    }
  }
  return (await readJobs()).find((job) => job.id === id) ?? null
}

/** Map a gbrain minion job row into the web-facing SyncJob shape. */
function minionJobToSyncJob(job: Record<string, unknown>): SyncJob | null {
  const id = String(job.id ?? "")
  if (!id) return null
  // gbrain stores processed-file progress under different keys depending on the
  // handler; the web UI only consumes `processed` as an informal "≈N files".
  const data = (job.data ?? {}) as Record<string, unknown>
  const statusRaw = String(job.status ?? "waiting")
  let status: SyncJobStatus = "queued"
  if (statusRaw === "active" || statusRaw === "running" || statusRaw === "claimed") status = "running"
  else if (statusRaw === "done" || statusRaw === "completed") status = "completed"
  else if (statusRaw === "failed" || statusRaw === "dead" || statusRaw === "cancelled") status = "failed"
  // rowToMinionJob 返回 Date 对象(created_at/started_at/finished_at),也兼容字符串。
  const toIso = (value: unknown): string | undefined => {
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString()
    if (typeof value === "string" && value) return value
    return undefined
  }
  // 进度可由 minion progress 字段提供(import handler)或直接任务日志提供。
  // 老任务/正在运行的任务可能刚好还没有 progress 写入,下面 listMinionSyncJobs
  // 会按需对这些任务调用 get_job_progress 补齐实时值。
  const progress = (job.progress ?? {}) as Record<string, unknown>
  const processed = typeof progress.done === "number" && Number.isFinite(progress.done) ? progress.done : undefined
  const progressTotal = typeof progress.total === "number" && Number.isFinite(progress.total) ? progress.total : undefined
  // 状态文案:把 gbrain 原始状态翻译成前端熟悉的表述;进行中优先显示文件进度。
  const statusMessage: Record<string, string> = {
    waiting: "排队中",
    active: "运行中",
    running: "运行中",
    claimed: "运行中",
    completed: "已完成",
    done: "已完成",
    failed: "失败",
    dead: "失败",
    cancelled: "已取消",
  }
  const messageText =
    typeof job.error_text === "string" && job.error_text
      ? String(job.error_text)
      : processed !== undefined && progressTotal !== undefined && progressTotal > 0
        ? `已处理 ${processed}/${progressTotal} 个文件`
        : processed !== undefined
          ? `已处理 ${processed} 个文件`
          : statusMessage[statusRaw] ?? `minions ${statusRaw}`
  return {
    id: `minion-${id}`,
    sourceId: typeof data.sourceId === "string" ? data.sourceId : "unknown",
    root: typeof data.repoPath === "string" ? String(data.repoPath) : typeof data.dir === "string" ? String(data.dir) : "",
    status,
    startedAt: toIso(job.created_at) ?? new Date().toISOString(),
    finishedAt: toIso(job.finished_at),
    message: messageText,
    output: [],
    queue: "minion",
    minionId: typeof job.id === "number" ? job.id : Number(id),
    processed,
    total: progressTotal,
  }
}

async function enrichMinionProgress(job: SyncJob): Promise<SyncJob> {
  if (job.status !== "running" || job.minionId == null || job.total !== undefined) return job
  try {
    const raw = await callGBrainServer("get_job_progress", { id: job.minionId }) as { progress?: unknown } | null
    const progress = (raw?.progress ?? {}) as Record<string, unknown>
    const processed = typeof progress.done === "number" && Number.isFinite(progress.done) ? progress.done : job.processed
    const total = typeof progress.total === "number" && Number.isFinite(progress.total) ? progress.total : job.total
    return { ...job, processed, total }
  } catch {
    return job
  }
}

/**
 * Query active minion jobs from the gbrain queue so the task list survives web
 * process restarts (the web-spawned child map is lost, but queued minion jobs
 * keep running).
 */
export async function removeSyncJobsForSource(sourceId: string): Promise<number> {
  const jobs = await readJobs()
  const remaining = jobs.filter((job) => job.sourceId !== sourceId)
  if (remaining.length !== jobs.length) await saveJobs(remaining)
  return jobs.length - remaining.length
}

/**
 * 取消某 source 在 minions 持久化队列里的非终结任务(waiting/active/delayed)。
 * 删除 source 前必须先取消,否则正在跑的 import 仍拿该 source_id 写 pages,
 * 会空转刷 "pages_source_id_fkey" 外键错误(nuwa job 21 的真实成因)。
 * 返回取消成功的数量;被取消/已终结的任务不计入。
 */
export async function cancelMinionJobsForSource(sourceId: string): Promise<number> {
  const jobs = (await listMinionSyncJobs()).filter((job) => job.sourceId === sourceId)
  let cancelled = 0
  for (const job of jobs) {
    if (job.minionId == null) continue
    try {
      await callGBrainServer("cancel_job", { id: job.minionId })
      cancelled += 1
    } catch {
      // 已终结或权限不足时忽略,继续取消其余任务。
    }
  }
  return cancelled
}

/**
 * 轮询 gbrain 队列直到任务的 status 进入终态(cancelled/failed/dead/completed)。
 * 终止流程需要等 worker 真正停下(现在 runImport 已协作式中断),再清理已导入页。
 * - minionId 缺省或超时上限耗尽返 false(调用方决定是否继续清理)。
 * - 等待上限 60s:worker 在每个文件的让出点检查 signal,文件级粒度足够快。
 */
export async function waitMinionJobTerminated(minionId: number, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  const TERMINAL = new Set(["completed", "failed", "dead", "cancelled"])
  while (Date.now() < deadline) {
    try {
      const row = (await callGBrainServer("get_job", { id: minionId })) as Record<string, unknown> | null
      if (row && typeof row === "object" && "status" in row) {
        const status = String((row as { status?: unknown }).status ?? "")
        if (TERMINAL.has(status)) return true
      }
    } catch {
      // 查询瞬时失败,继续等。
    }
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
  return false
}

/**
 * 精确取消单个 minion job(按 id,不按 source)。terminate 用它停住目标任务,
 * 别的不动——满足"只清理这一个,其他任务继续进行"的隔离语义。
 */
export async function cancelMinionJobById(minionId: number): Promise<boolean> {
  try {
    await callGBrainServer("cancel_job", { id: minionId })
    return true
  } catch {
    return false
  }
}

/**
 * 停止本进程 spawn 的本地任务(非 minion)并等待退出。
 * active Map 里存的 gbrain 子进程 terminate(直接 kill,进程退出后 finish() 把
 * 记录置为 failed)。web 进程自身重启过的任务不在 active Map,返回 false——由
 * 重启后的自愈/terminate 流程继续清理,或直接 kill 孤儿 PID。
 * 返回该子进程是否被找到并已发送 kill;调用方再用 wait 轮询确认实际退出。
 */
export async function stopLocalJob(jobId: string): Promise<boolean> {
  const child = active.get(jobId)
  if (!child) return false
  try {
    child.kill("SIGKILL")
    return true
  } catch {
    return false
  }
}

/** 等待本地 spawn 任务对应的 gbrain 子进程真正退出(最多 timeoutMs)。 */
export async function waitLocalJobStopped(jobId: string, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const child = active.get(jobId)
    if (!child || child.killed || child.signalCode !== null || child.exitCode !== null) return true
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
  return false
}

/**
 * 终止同一 source 的所有活动 minion 任务后再等待它们退出。
 * 清理 source 数据前必须确保没有同 source 的兄弟任务继续写入;其他 source 不受影响。
 */
export async function cancelAndWaitMinionJobsForSource(
  sourceId: string,
  timeoutMs = 60_000,
): Promise<{ found: number; cancelled: number; stopped: boolean }> {
  const jobs = (await listMinionSyncJobs()).filter(
    (job) => job.sourceId === sourceId && (job.status === "running" || job.status === "queued") && job.minionId != null,
  )
  const results = await Promise.all(jobs.map((job) => cancelMinionJobById(job.minionId!)))
  const stopped = await Promise.all(jobs.map((job) => waitMinionJobTerminated(job.minionId!, timeoutMs)))
  return {
    found: jobs.length,
    cancelled: results.filter(Boolean).length,
    stopped: stopped.every(Boolean),
  }
}

export async function listMinionSyncJobs(): Promise<SyncJob[]> {
  try {
    const raw: unknown = await callGBrainServer("list_jobs", { limit: 100 })
    const container = (raw ?? {}) as { jobs?: unknown }
    const candidate = Array.isArray(raw) ? raw : Array.isArray(container.jobs) ? container.jobs : []
    const jobs: unknown[] = candidate
    // 只展示 SDK 索引相关 job(sync/import,带 repoPath 定位目录),过滤掉
    // extract/embed 等无关后台任务。minionId 兼容数字与字符串两种形态。
    const mappedJobs = jobs
      .filter((row): row is Record<string, unknown> => Boolean(row && typeof row === "object" && !Array.isArray(row)))
      .filter((j) => {
        const name = String(j.name ?? "")
        const data = (j.data ?? {}) as Record<string, unknown>
        const dir = typeof data.repoPath === "string" ? data.repoPath : typeof data.dir === "string" ? data.dir : ""
        return (name === "sync" || name === "import") && dir.length > 0
      })
      .map(minionJobToSyncJob)
      .filter((job): job is SyncJob => Boolean(job && job.id && job.root && job.sourceId))
    return await Promise.all(mappedJobs.map((job) => enrichMinionProgress(job)))
  } catch {
    return []
  }
}

/**
 * 提交一个 `embed` minion 任务，为某个 source 补建缺失的向量。
 *
 * 背景：Web 的 sync/import 走 `--no-embed`（见下方 syncArgs 注释——先建页，
 * 让 Memory Library 立刻有内容；provider 不可用时不至于把 source 建空），
 * 但**补 embed 的责任落空了**：那批 CLI 任务不经过 gbrain 的 sync/import
 * handler，所以 handler 里「导入完成后自动补派 embed」的逻辑不会触发。
 * 结果就是 Memory Library 有页面、think 却检索不到（向量腿为空）。
 * 这个函数补上那个缺口：显式提交 `embed` 任务（stale 模式，只扫 NULL 向量
 * 的 chunk），由常驻 worker 消费。任务进度复用已有的 jobs 展示链路。
 *
 * 需要 sourceId；`stale: true` 只处理尚未向量化的 chunk（幂等，重复提交安全）。
 * 返回 minion job id（数字），或 duplicate=true 表示该 source 已有 embed 在跑。
 */
async function findActiveEmbedJobId(sourceId: string): Promise<number | null> {
  const statusOrder = ["active", "waiting", "delayed", "waiting-children", "paused"]
  for (const status of statusOrder) {
    for (const name of ["embed", "embed-backfill"]) {
      try {
        const raw = (await callGBrainServer("list_jobs", { status, name, limit: 100 })) as {
          jobs?: Array<{ id?: number | string; data?: { sourceId?: unknown } }>
        } | Array<{ id?: number | string; data?: { sourceId?: unknown } }> | null
        const rows = Array.isArray(raw) ? raw : Array.isArray(raw?.jobs) ? raw.jobs : []
        const hit = rows.find((row) => row && row.data?.sourceId === sourceId)
        if (hit && typeof hit.id !== "undefined" && Number.isFinite(Number(hit.id))) return Number(hit.id)
      } catch {
        // 单个查询失败继续尝试其余状态/名称。
      }
    }
  }
  return null
}

export async function startEmbedJob(
  sourceId: string,
  options: { force?: boolean } = {},
): Promise<{ minionId: number | null; duplicate: boolean; message?: string }> {
  // 同一 source 已有 embed/embed-backfill 在跑 → 去重，不重复排队。
  // 注意：listMinionSyncJobs() 只映射 sync/import，看不到 embed 任务，
  // 所以这里直接查 list_jobs 的 embed 名。
  if (!options.force) {
    const existingId = await findActiveEmbedJobId(sourceId)
    if (existingId !== null) return { minionId: existingId, duplicate: true }
  }
  // 方案 A：走本机 CLI 而非 HTTP MCP（`embed` 不在远端任务白名单里，远端直接拒绝）。
  // assumeYes 对应 0.60 的付费同意闸门：闸门只在 embedding provider 计费时才拦，
  // 本机 RealGPT provider 免费故当前不触发；传 --yes 是为了 provider 日后计费时
  // 不会在非交互环境下以 exit 3 静默失败。
  const submitted = await submitGBrainJob("embed", {
    sourceId,
    // stale: true 只扫没有向量的 chunk，重复提交幂等 —— 「向量化」按钮的恢复语义依赖这一点。
    stale: true,
    // catchUp: true 关闭 gbrain 的 30 分钟时间预算（embed.ts: BUDGET_MS = catchUp ? null : 30min）。
    // 否则大源（如 wegent 6.9 万 chunk）每跑满 30 分钟就主动 completed 退出，
    // 需要用户反复点「向量化」才能补齐；catchUp 让它一口气跑完。
    catchUp: true,
  }, {
    // 与 sync/import 相同的显式预算：默认 300s 墙钟会误杀大源回填。
    lockDurationMs: 10 * 60 * 1000,
    timeoutMs: 6 * 60 * 60 * 1000,
    assumeYes: true,
  })
  return { minionId: submitted.id, duplicate: false }
}

/**
 * 查询某个 source 的向量化覆盖度（用于 Web 显示「待向量化」状态与按钮）。
 * 复用 gbrain 的 get_health 现有 op（支持 source_id），不新增后端接口。
 * 返回 { embedCoverage: 0..1, chunks, pages } 或 null（查询失败时）。
 */
export async function getSourceEmbedStatus(
  sourceId: string,
): Promise<{ embedCoverage: number; chunks: number; pages: number } | null> {
  try {
    const health = (await callGBrainServer("get_health", { source_id: sourceId })) as {
      embed_coverage?: number | string
      chunks?: number | string
      pages?: number | string
    } | null
    if (!health) return null
    const coverage = Number(health.embed_coverage)
    const chunks = Number(health.chunks)
    const pages = Number(health.pages)
    return {
      embedCoverage: Number.isFinite(coverage) ? coverage : 0,
      chunks: Number.isFinite(chunks) ? chunks : 0,
      pages: Number.isFinite(pages) ? pages : 0,
    }
  } catch {
    return null
  }
}

export async function startSyncJob(options: { root: string; sourceId: string; workers?: number; syncPull?: boolean; fullSync?: boolean; staleMs?: number }): Promise<{ job: SyncJob; duplicate: boolean }> {
  const existingMinion = (await listMinionSyncJobs()).find((job) => job.sourceId === options.sourceId && (job.status === "queued" || job.status === "running"))
  if (existingMinion) return { job: existingMinion, duplicate: true }

  // 先自愈再查重：孤儿 running/queued 记录（web 重启/进程被杀）会被修正为
  // failed，不会再把该 source 永远锁死成"已有任务"。真任务（active Map 里
  // 有活子进程，或 minions 队列任务）不受影响。
  const repaired = await repairOrphanJobs()
  // manifest 父任务(mode==="manifest")是 manifest 流程自己的任务卡,不该被当成
  // "已有索引任务":否则 manifest 同步完成后 startSyncJob 查重会命中自己的父任务,
  // 误报 duplicate 而永远无法真正启动 SDK 索引。
  const existing = repaired.find((job) => job.sourceId === options.sourceId && (job.status === "queued" || job.status === "running") && job.mode !== "manifest")
  if (existing) {
    // 遗留 stale 检查仅兜底极短窗口的竞态（自愈刚跑完、子进程刚好退出）。
    const staleMs = options.staleMs ?? 10 * 60 * 1000
    const ageMs = Date.now() - new Date(existing.startedAt).getTime()
    const stale = ageMs > staleMs
    if (!stale) return { job: existing, duplicate: true }
    await updateJob({ ...existing, status: "failed", finishedAt: new Date().toISOString(), message: `${existing.message ?? "已中断任务"}[自动修复:陈旧任务超时，标记为 failed 以释放锁]`, exitCode: existing.exitCode ?? 1 })
  }

  const mode = await isGitRepository(options.root) ? "sync" : "import"
  const job: SyncJob = {
    id: randomUUID(),
    sourceId: options.sourceId,
    root: options.root,
    status: "queued",
    startedAt: new Date().toISOString(),
    output: [],
    mode,
  }
  await updateJob(job)

  // 源码检测与 full 策略在 minions 分支与回退分支都用到,提前到函数作用域计算一次。
  const hasCode = mode === "sync" ? await detectCodeFiles(options.root) : false
  const fullSync = options.fullSync ?? hasCode

  // 方案D阶段1:优先将任务提交到 gbrain 的 minions 持久化队列(由独立 supervisor
  // worker 消费,web 进程重启/切窗口不再中断任务)。
  // 用 GBRAIN_MINIONS_AVAILABLE=1 显式开启:只有 supervisor 真正常驻的部署(由
  // start-gbrain-web.sh 在启动 supervisor 成功后注入)才走队列;否则直接进程内,
  // 避免"提交成功但无 worker 消费"的任务卡死在 waiting。
  // minions 提交成功并已入队 → 直接返回;否则 fallthrough 到本进程 spawn(旧行为)。
  if (process.env.GBRAIN_MINIONS_AVAILABLE === "1") {
    try {
      // 本地目录(非 git)→ minions `import` job;git 目录 → minions `sync` job。
      // 与进程内回退路径保持一致的策略(excludes/strategy/workers)。
      const generatedDataExcludes = [
        "**/test_wav/**",
        "**/testwav_*.c",
        "**/testwav_*.h",
        "**/*_generated.c",
        "**/*_generated.h",
      ]
      const jobData: Record<string, unknown> =
        mode === "import"
          ? {
              dir: options.root,
              sourceId: options.sourceId,
              noEmbed: true,
              strategy: "auto",
              exclude: generatedDataExcludes,
              workers: Math.min(Math.max(options.workers ?? 1, 1), 8),
            }
          : {
              repoPath: options.root,
              sourceId: options.sourceId,
              // gbrain sync handler 单独跑 embed/extract;web 侧后续如需可主动触发。
              noEmbed: true,
              noExtract: true,
              noPull: options.syncPull === false,
            }
      if (mode === "sync") {
        if (hasCode) jobData.strategy = "auto"
        if (fullSync) jobData.full = true
      }
      // 方案B:minions `import` 直接把源目录写进 pages,依赖 sources 里已有该 source。
      // 若该 source 已被删除(如 nuwa),worker 侧 import handler 会用本地 addSource
      // 自动注册(force:true,见 gbrain jobs.ts)——import 走文件系统扫描,不读 git
      // 对象,所以非 git 目录也能导入,与旧 spawn 路径 `sources add --path --force`
      // 语义一致。这里不在 web 侧调 sources_add 远程注册:HTTP MCP 的 sources_add
      // 出于安全拒绝 path,且没有 force 参数,非 git 目录(如 nuwa)会被 #2707 弹回,
      // 反而阻断。缺失时仅记录提示,交由 worker 处理;仍失败才标记 failed。
      if (mode === "import") {
        try {
          const listed = (await callGBrainServer("sources_list", { include_archived: true })) as {
            sources?: Array<{ id?: string }>
          }
          const exists = listed.sources?.some((source) => source.id === options.sourceId)
          if (!exists) {
            appendOutput(job, `[gbrain-web] source ${options.sourceId} 未注册,将由 minions worker 自动注册后导入`)
            await updateJob(job)
          }
        } catch {
          // registry 查询失败不阻断,让 minions 提交自行失败并回退。
        }
      }
      // 方案D:导入/同步常超默认 300s 墙钟(2×30s 锁 × max_stalled),显式给足预算。
      // 否则长目录索引会被 wall-clock backstop 在 ~5 分钟误杀,锁丢失后进度也写不进 DB。
      const MINION_LOCK_MS = 10 * 60 * 1000
      const MINION_TIMEOUT_MS = 60 * 60 * 1000
      // 方案 A:走本机 CLI 而非 HTTP MCP。远端通道会剥掉 import 的
      // strategy/exclude/workers(源码页静默丢失)、并直接把 embed 拒之门外;
      // 本机 CLI 入队 `submission_authority = {kind:"application"}`，参数原样落库。
      const submitted = await submitGBrainJob(
        mode === "import" ? "import" : "sync",
        jobData,
        { lockDurationMs: MINION_LOCK_MS, timeoutMs: MINION_TIMEOUT_MS },
      )
      const minionId: number | null = submitted.id
      if (minionId && Number.isFinite(minionId)) {
        // 临时 UUID 快照(job)已使命完成:队列任务才是权威记录,把它从本地
        // 历史里删掉,避免与 minion-N 重复。
        const queued: SyncJob = {
          ...job,
          id: `minion-${minionId}`,
          queue: "minion",
          minionId,
          status: "queued",
          message: hasCode
            ? "[gbrain-web] 已提交到 minions 队列(独立 worker),检测到源码文件将用 auto 策略"
            : "[gbrain-web] 已提交到 minions 队列(独立 worker)",
        }
        await updateJob(queued)
        // 防止同一 source 出现"临时 UUID 行 + minion-N 行"两行:删除临时快照。
        // 此时队列里已存在 minion-N 且 status=queued,startSyncJob 不会再误判为重复。
        const jobs = (await readJobs()).filter((item) => item.id !== job.id)
        await saveJobs(jobs)
        return { job: queued, duplicate: false }
      }
      appendOutput(job, "[gbrain-web] gbrain 未返回 job id,回退到本进程内执行")
    } catch (error) {
      appendOutput(job, `[gbrain-web] minions 队列不可用(${error instanceof Error ? error.message : String(error)}),回退到本进程内执行`)
    }
  } else {
    appendOutput(job, "[gbrain-web] 未启用 minions 队列(GBRAIN_MINIONS_AVAILABLE!=1),使用本进程内执行")
  }
  const locked = await acquireStateLock(`sync-${options.sourceId}`)
  if (!locked) {
    const failed = { ...job, status: "failed" as const, message: "该 source 已有同步任务运行", finishedAt: new Date().toISOString() }
    await updateJob(failed)
    return { job: failed, duplicate: true }
  }

  const binary = process.env.GBRAIN_CODE_IMPORT_BIN || "gbrain"
  const generatedDataExcludes = [
    "**/test_wav/**",
    "**/testwav_*.c",
    "**/testwav_*.h",
    "**/*_generated.c",
    "**/*_generated.h",
  ]
  const importArgs = ["import", options.root, "--strategy", "auto", ...generatedDataExcludes.flatMap((pattern) => ["--exclude", pattern]), "--workers", String(Math.min(Math.max(options.workers ?? 1, 1), 8)), "--source-id", options.sourceId]
  // A Git source can already have an advanced bookmark after a failed import.
  // Force the full source walk so a frontend retry does not report “up to date”
  // while the source still has zero indexed pages. Pages are written before
  // embeddings are generated; defer embedding here so an unavailable provider
  // cannot leave Memory Library empty. A later `gbrain embed --stale` can fill
  // the vectors after the provider is repaired.
  //
  // 策略：Git source 只要检出代码扩展名文件，就自动切换到 auto 策略，
  // 这样 py/ts/rust 等源码会被建成 code 页并产出代码调用边。纯文档仓库
  // （无代码文件）走默认 markdown 策略，行为不变。
  //
  // 首次 full：bookmark 增量只 diff `last_commit..HEAD`。如果这个 source
  // 之前一直按 markdown 策略导入（源码文件从未进过库），即使切换成 auto，
  // 增量也不会补采存量源码文件（它们不在 diff 里，被误判为"已是最新"）。
  // 因此首次检测到源码文件且未显式要求增量时强制 --full 重扫一次，补齐
  // 全部代码页与调用边；之后远端新增源码仍会被 auto 增量正常采入。
  const syncArgs = [
    "sync", "--source", options.sourceId,
    ...generatedDataExcludes.flatMap((pattern) => ["--exclude", pattern]),
    ...(hasCode ? ["--strategy", "auto"] : []),
    ...(fullSync ? ["--full"] : []),
    "--no-embed", "--retry-failed", "--yes",
    ...(options.syncPull === false ? ["--no-pull"] : []),
  ]
  // Markdown page links are a separate derived graph from code edges. Run the
  // stale extractor after sync so Git URL sources don't have pages but an empty
  // document graph. Code symbol resolution is also a separate bounded pass.
  const postSyncArgs = ["extract", "--stale", "--source-id", options.sourceId, "--yes"]
  const postCodeArgs = hasCode ? ["edges-backfill", "--source", options.sourceId, "--json"] : null
  if (hasCode) appendOutput(job, `[gbrain-web] 检测到源码文件，使用 auto 策略首次全量同步（建立代码页与调用边）`)
  appendOutput(job, `[gbrain-web] 同步完成后自动维护文档链接边（extract --stale）${hasCode ? "与代码符号边（edges-backfill）" : ""}`)
  job.status = "running"
  await updateJob(job)

  let settled = false
  const finish = async (code: number | null, error?: Error) => {
    if (settled) return
    settled = true
    if (error) appendOutput(job, error.message)
    job.exitCode = code
    const importFailed = outputHasImportFailure(job)
    job.status = code === 0 && !error && !importFailed ? "completed" : "failed"
    job.finishedAt = new Date().toISOString()
    job.message = error?.message || (importFailed ? "同步完成但导入失败，请检查任务日志" : code === 0 ? `${job.mode === "import" ? "代码索引" : "增量同步"}完成` : `同步失败（退出码 ${code ?? "unknown"}）`)
    active.delete(job.id)
    await updateJob(job)
    await releaseStateLock(`sync-${options.sourceId}`)
  }

  const launch = (args: string[], onClose: (code: number | null) => void) => {
    const child = spawn(binary, args, { cwd: options.root, env: process.env, stdio: ["ignore", "pipe", "pipe"] })
    active.set(job.id, child)
    child.stdout.on("data", async (chunk) => { appendOutput(job, chunk); await updateJob(job) })
    child.stderr.on("data", async (chunk) => { appendOutput(job, chunk); await updateJob(job) })
    child.on("error", (error) => void finish(null, error))
    child.on("close", onClose)
  }

  const launchPostSync = () => {
    launch(postSyncArgs, (extractCode) => {
      if (extractCode !== 0 || !postCodeArgs) return void finish(extractCode)
      launch(postCodeArgs, (edgeCode) => void finish(edgeCode))
    })
  }

  if (mode === "sync") {
    launch(syncArgs, (code) => {
      if (code !== 0) return void finish(code)
      launchPostSync()
    })
  } else {
    const addArgs = ["sources", "add", options.sourceId, "--path", options.root, "--name", options.sourceId, "--no-federated", "--force"]
    launch(addArgs, (code) => {
      const alreadyRegistered = job.output.some((line) => /already (?:exists|registered)|duplicate|已存在/i.test(line))
      if (code !== 0 && !alreadyRegistered) void finish(code)
      else launch(importArgs, (importCode) => {
        if (importCode !== 0) return void finish(importCode)
        launchPostSync()
      })
    })
  }
  return { job, duplicate: false }
}
