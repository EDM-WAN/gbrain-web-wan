import { spawn } from "node:child_process"
import { mkdir } from "node:fs/promises"
// 相对导入（而非 `@/lib/...`）：本模块不依赖 Next.js，保持可被
// `node --test` 直接 import 的纯 Node 形态（同 sdk-upload.ts 的约定）。
import { statePath } from "./web-state.ts"

/**
 * 本机 gbrain CLI 通道（本机 spawn CLI = 本机受信语义）。
 *
 * 两个入口：
 *   1. `submitGBrainJob` —— `gbrain jobs submit`，写持久化 minions 队列；
 *   2. `callGBrainOp`     —— `gbrain call <op>`，直接派发单个 op（source 管理用）。
 *
 * ## 为什么不用 HTTP MCP
 *
 * **任务提交**（`submit_job`）：那条通道把调用方当作**不可信远端**
 * （core/minions/submission-authority.ts），四层限制——
 *   1. 任务名白名单：仅 sync/import/lint/lint-fix（embed 直接拒绝）；
 *   2. 参数白名单：sync 只放行 pull/noPull，import 只剩 dir/sourceId（
 *      strategy/exclude/workers/fresh 全被剥掉 → 源码页静默丢失）；
 *   3. 必须带标量 write source；
 *   4. 强制 `auto_embed_backfill: false`。
 * 而 gbrain-web 与 brain 同机、同库、本就受信，用远端闸门属错配。
 * CLI 入队带 `submission_authority = {kind:"application"}`，能力等价于 0.48，
 * 正是这套部署需要的语义。
 *
 * **source 管理**（`sources_remove` 等）：0.60 给 `sources_remove` 加了
 * `assertSourceInCallerWriteScope` 写围栏（core/ops/context.ts），它只认调用方
 * token 绑定的**那一个** write source：
 *
 *     写 source = ctx.auth.sourceId ?? ctx.sourceId
 *     若 id !== 写 source → not_found("Unknown source: <id>")
 *
 * 而远端 token 的写围栏与读通道**不对称**：读有 #3242 联邦放宽（
 * `federated_read` 里的 source 都可见、可列），写**没有**。gbrain-web 的 OAuth
 * client 是 `source_id=NULL` → 落到 `{kind:'default'}`（grants/model.ts）→
 * 写 source 恒为 `'default'` → 删任何非 default 的 source 都被拒，
 * 表现为界面「看得见却删不掉」。0.48 没有这道围栏，升级 0.60 才出现。
 *
 * 该围栏是上游**有意为之**的安全加固（CHANGELOG 0.47.3.0 #4433，maintainer
 * decision），不是缺陷；但它的「单 source 绑定」模型**无法表达**本项目的权限
 * 语义（个人源仅本人、团队源按角色、成员只能动自己传的——动态、多 source）。
 * 那套语义由 gbrain-web 自己的 lib/source-permissions.ts 裁决（照 Wegent
 * permission_policy.py 移植），API 层 `requireManageSource` 是统一闸门，
 * 浏览器会话与 API key 走同一套判定。
 *
 * 所以 source 写操作走 `gbrain call` —— `src/commands/call.ts` 文件头明确标注的
 * **"trusted local op-dispatch surface"**，经 `handleToolCall` 以 `remote: false`
 * 派发（src/mcp/server.ts），与 `gbrain` 命令行本身权限一致，不受远端围栏约束。
 * 权限仍由 gbrain-web 把守，**不是**放弃授权，只是换了一条受信通道执行。
 */

/** `gbrain jobs submit` 成功入队时打印在 stdout 的 job 对象（节选）。 */
export interface GBrainCliJob {
  id?: number | string
  name?: string
  status?: string
}

export interface SubmitGBrainJobOptions {
  /** 墙钟预算，透传 `--timeout-ms`。 */
  timeoutMs?: number
  /** 单次租约，透传 `--lock-duration-ms`。 */
  lockDurationMs?: number
  /** 幂等键，透传 `--idempotency-key`；同键重复提交由队列折叠。 */
  idempotencyKey?: string
  /** 计费类任务（如 embed 回填）需要 `--yes` 越过 consent 闸门。 */
  assumeYes?: boolean
  /** 提交阶段的墙钟上限，超时杀掉 CLI 进程；默认 120s。 */
  submitTimeoutMs?: number
}

const DEFAULT_SUBMIT_TIMEOUT_MS = 120_000

/**
 * gbrain 二进制路径。
 *
 * 复用旧回退路径已使用的 `GBRAIN_CODE_IMPORT_BIN`，让「用哪个版本 / 哪个路径的
 * gbrain」只由一处环境变量决定，便于本机与服务器整体切换版本。
 */
function gbrainBinary(): string {
  return process.env.GBRAIN_CODE_IMPORT_BIN?.trim() || "gbrain"
}

/**
 * 返回一个保证不含 `.env` 的目录，专供 spawn gbrain CLI 时作为 cwd。
 *
 * 背景（改动时务必保留）：gbrain 的 CLI 是 Bun 编译产物，Bun 在进程启动时会把
 * **cwd 下**的 `.env` / `.env.local` 等合并进 process.env；而 gbrain 认定 cwd 的
 * `.env` 不可信（core/env-trust.ts），凡是被它赋值的「受保护 key」——包含
 * `GBRAIN_HOME` 与 `GBRAIN_DATABASE_URL`——一律丢弃，**不看值**。
 * 后果：若 cwd 指向带 `.env` 的目录（gbrain-web 自身就是，SDK source root 也可能
 * 是），即使我们在 env 里显式传 `GBRAIN_HOME` 也会被丢掉，CLI 直接报
 * `no_brain`。所以提交任务统一在这个自有的空目录里执行。
 */
async function neutralCwd(): Promise<string> {
  const dir = await statePath("gbrain-cli-cwd")
  await mkdir(dir, { recursive: true })
  return dir
}

/**
 * 通过本机 gbrain CLI 提交一个任务到持久化 minions 队列。
 *
 * 返回队列分配的数字 job id；失败抛错（调用方决定回退或上抛）。
 */
export async function submitGBrainJob(
  name: string,
  data: Record<string, unknown>,
  options: SubmitGBrainJobOptions = {},
): Promise<{ id: number; job: GBrainCliJob }> {
  const args = ["jobs", "submit", name, "--params", JSON.stringify(data)]
  if (options.timeoutMs !== undefined) args.push("--timeout-ms", String(options.timeoutMs))
  if (options.lockDurationMs !== undefined) args.push("--lock-duration-ms", String(options.lockDurationMs))
  if (options.idempotencyKey) args.push("--idempotency-key", options.idempotencyKey)
  if (options.assumeYes) args.push("--yes")

  const { stdout, stderr, code } = await runCli(
    args,
    await neutralCwd(),
    options.submitTimeoutMs ?? DEFAULT_SUBMIT_TIMEOUT_MS,
  )
  if (code !== 0) {
    const detail = lastMeaningfulLine(stderr) || lastMeaningfulLine(stdout) || `exit ${code}`
    throw new Error(`gbrain jobs submit ${name} 失败：${detail}`)
  }
  const job = parseJsonObject<GBrainCliJob>(stdout)
  const id = Number(job?.id)
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`gbrain jobs submit ${name} 未返回有效任务 ID`)
  }
  return { id, job: job as GBrainCliJob }
}

export interface CallGBrainOpOptions {
  /** 墙钟上限，超时杀掉 CLI 进程；默认 120s。 */
  timeoutMs?: number
}

const DEFAULT_CALL_TIMEOUT_MS = 120_000

/**
 * 通过本机 gbrain CLI 派发一个 op（`gbrain call <op> <json>`）。
 *
 * 受信本机语义（`remote: false`）：不受远端 source 写围栏、参数白名单限制，
 * 权限由调用方（gbrain-web 的 API 层）自行裁决后再调用本函数。
 *
 * 失败契约（实测 0.60.219.0）：exit=1 时**错误详情在 stdout 的 JSON envelope**
 * 里（`{error, code, message, suggestion, ...}`），stderr 只有版本横幅加一行
 * `Error [code]: message`。所以优先取 stdout 的 `message`/`error`，再退回 stderr。
 */
export async function callGBrainOp<T = unknown>(
  name: string,
  args: Record<string, unknown> = {},
  options: CallGBrainOpOptions = {},
): Promise<T> {
  const { stdout, stderr, code } = await runCli(
    ["call", name, JSON.stringify(args)],
    await neutralCwd(),
    options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
  )
  if (code !== 0) {
    const envelope = parseJsonObject<{ message?: unknown; error?: unknown }>(stdout)
    const detail =
      (typeof envelope?.message === "string" && envelope.message.trim()) ||
      (typeof envelope?.error === "string" && envelope.error.trim()) ||
      lastMeaningfulLine(stderr) ||
      `exit ${code}`
    throw new Error(`gbrain call ${name} 失败：${detail}`)
  }
  try {
    return JSON.parse(stdout.trim()) as T
  } catch {
    throw new Error(`gbrain call ${name} 返回的不是合法 JSON`)
  }
}

/** gbrain 的版本横幅与 env 提示走 stderr，这里只挑出真正有信息量的那行。 */
function lastMeaningfulLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !/^UPGRADE_AVAILABLE\b/.test(line))
    .filter((line) => !/^gbrain\s+\S+\s+->\s+\S+\s+available/.test(line))
    .filter((line) => !/^\[env\]\s+Ignoring\b/.test(line))
  return lines.at(-1) ?? ""
}

/**
 * 解析 CLI stdout 上的 JSON 对象。
 *
 * 两种用途共用：`jobs submit` 非 `--follow` 分支输出
 * `JSON.stringify(job, null, 2)`；`gbrain call` 失败时 stdout 上是错误 envelope
 * `{error, code, message, …}`（stderr 只有版本横幅，取不到详情）。
 */
function parseJsonObject<T>(stdout: string): T | null {
  const text = stdout.trim()
  if (!text) return null
  try {
    return JSON.parse(text) as T
  } catch {
    // 兜底：stdout 若掺了别的前缀，取第一个对象再试一次。
    const start = text.indexOf("{")
    if (start < 0) return null
    try {
      return JSON.parse(text.slice(start)) as T
    } catch {
      return null
    }
  }
}

function runCli(
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(gbrainBinary(), args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill("SIGKILL") } catch { /* 进程可能已退出 */ }
      reject(new Error(`gbrain CLI 提交超时（${timeoutMs}ms）`))
    }, timeoutMs)

    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString() })
    child.on("error", (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout, stderr, code })
    })
  })
}
