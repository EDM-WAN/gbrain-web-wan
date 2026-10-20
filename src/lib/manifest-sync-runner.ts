import { randomUUID } from "node:crypto"
import { updateSdkSourceConfig } from "@/lib/sdk-sources"
import { startCodeIndexJob } from "@/lib/code-index-jobs"
import { appendOutput, cancelMinionJobById, getSyncJob, listSyncJobs, stopLocalJob, updateJob, waitLocalJobStopped, waitMinionJobTerminated, type SyncJob } from "@/lib/sync-runner"
import { callGBrainServer } from "@/lib/gbrain-server"
import { callGBrainOp } from "@/lib/gbrain-cli"
import { getManifestWorkspaceRoot, syncManifestWorkspace } from "@/lib/manifest-source"
import type { ManifestToolChoice } from "@/lib/manifest-shared"

type ManifestRunInput = { sourceId: string; manifestTool: ManifestToolChoice; manifestUrl: string; branch?: string; workers: number }
type ManifestRunState = { jobId: string; controller: AbortController; promise: Promise<void>; childJobId?: string }
type ManifestRuntime = typeof globalThis & {
  __gbrainManifestRuns?: Map<string, ManifestRunState>
  __gbrainManifestStarts?: Map<string, Promise<{ job: SyncJob; duplicate: boolean }>>
  __gbrainManifestActiveJobIds?: Set<string>
}

function manifestRuntime(): ManifestRuntime { return globalThis as ManifestRuntime }
function manifestRuns(): Map<string, ManifestRunState> { return manifestRuntime().__gbrainManifestRuns ??= new Map() }
function manifestStarts(): Map<string, Promise<{ job: SyncJob; duplicate: boolean }>> { return manifestRuntime().__gbrainManifestStarts ??= new Map() }
// 与 sync-runner 共享的"运行中的 manifest jobId"集合（globalThis，避免循环导入）；
// 供孤儿修复区分活着的 manifest 父任务，误把它标 failed。
function manifestActiveJobIds(): Set<string> { return manifestRuntime().__gbrainManifestActiveJobIds ??= new Set() }

async function updateManifestStatus(job: SyncJob, status: "running" | "completed" | "failed", error?: string): Promise<void> {
  const now = new Date().toISOString()
  await updateSdkSourceConfig(job.sourceId, (current) => ({
    ...current,
    kind: "manifest",
    lastJobId: job.id,
    lastStatus: status,
    ...(status === "running" ? { lastRunAt: job.startedAt, nextRunAt: new Date(Date.now() + Math.max(current.intervalMinutes, 5) * 60_000).toISOString(), lastError: undefined } : {}),
    ...(status === "completed" ? { lastSuccessAt: now, lastError: undefined, consecutiveFailures: 0 } : {}),
    ...(status === "failed" ? { lastError: error || job.message || "Manifest 同步失败", consecutiveFailures: (current.consecutiveFailures ?? 0) + 1 } : {}),
  }))
}

async function bindGBrainSource(sourceId: string, root: string): Promise<void> {
  // 读走 HTTP MCP（有联邦放宽，正常）；写走本机 CLI（受信本机语义，
  // 不受 0.60 远端写围栏/参数限制）。详见 lib/gbrain-cli.ts 头注释。
  const listed = await callGBrainServer("sources_list", { include_archived: true }) as { sources?: Array<{ id?: string; local_path?: string | null; archived?: boolean }> }
  const existing = listed.sources?.find((source) => source.id === sourceId)
  if (!existing) return
  if (existing.archived) throw new Error(`GBrain source ${sourceId} 已归档，请先恢复该 source`)
  if (existing.local_path !== root) await callGBrainOp("sources_set_path", { id: sourceId, path: root })
}

async function stopIndexJob(childJob: SyncJob): Promise<boolean> {
  if (childJob.queue === "minion" && childJob.minionId != null) {
    await cancelMinionJobById(childJob.minionId)
    return waitMinionJobTerminated(childJob.minionId)
  }
  await stopLocalJob(childJob.id)
  return waitLocalJobStopped(childJob.id)
}

async function executeManifestRun(job: SyncJob, input: ManifestRunInput, controller: AbortController): Promise<void> {
  const onOutput = (line: string) => { appendOutput(job, line); void updateJob(job) }
  try {
    const { root, manifestTool } = await syncManifestWorkspace(input, { workers: input.workers, onOutput, signal: controller.signal })
    input.manifestTool = manifestTool
    job.root = root
    await updateSdkSourceConfig(input.sourceId, (current) => ({ ...current, manifestTool }))
    onOutput(`[manifest] workspace ready: ${root}`)
    if (controller.signal.aborted) throw new Error("Manifest 同步已取消")
    await bindGBrainSource(input.sourceId, root)

    const indexed = await startCodeIndexJob({ root, sourceId: input.sourceId, workers: input.workers })
    if (indexed.duplicate) throw new Error(`Source ${input.sourceId} 已有索引任务运行；Manifest workspace 已更新，请稍后重试索引`)
    const activeRun = manifestRuns().get(job.sourceId)
    if (activeRun) activeRun.childJobId = indexed.job.id

    while (true) {
      if (controller.signal.aborted) {
        if (!await stopIndexJob(indexed.job)) throw new Error("已请求取消 Manifest 索引，但索引子任务未能确认停止；请勿删除 workspace")
        throw new Error("Manifest 同步已取消")
      }
      const latest = await getSyncJob(indexed.job.id)
      if (!latest) throw new Error(`找不到索引子任务 ${indexed.job.id}`)
      job.processed = latest.processed
      job.total = latest.total
      job.message = latest.message || "正在索引 manifest workspace"
      if (latest.status === "completed" || latest.status === "failed") {
        if (latest.status === "failed") throw new Error(latest.message || "Manifest workspace 索引失败")
        break
      }
      await updateJob(job)
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }

    job.status = "completed"
    job.exitCode = 0
    job.finishedAt = new Date().toISOString()
    job.message = "Manifest 同步与 SDK 索引完成"
    await updateJob(job)
    await updateManifestStatus(job, "completed")
  } catch (error) {
    job.status = "failed"
    job.exitCode = 1
    job.finishedAt = new Date().toISOString()
    job.message = error instanceof Error ? error.message : "Manifest 同步失败"
    onOutput(`[manifest] ERROR: ${job.message}`)
    await updateJob(job)
    await updateManifestStatus(job, "failed", job.message)
  }
}

async function findActiveManifestRun(sourceId: string): Promise<SyncJob | null> {
  return (await listSyncJobs()).find((job) => job.mode === "manifest" && job.sourceId === sourceId && (job.status === "queued" || job.status === "running")) ?? null
}

export async function startManifestSync(input: ManifestRunInput): Promise<{ job: SyncJob; duplicate: boolean }> {
  const existingStart = manifestStarts().get(input.sourceId)
  if (existingStart) return existingStart.then((result) => ({ job: result.job, duplicate: true }))
  const operation = startManifestSyncUnlocked(input)
  manifestStarts().set(input.sourceId, operation)
  try { return await operation }
  finally { if (manifestStarts().get(input.sourceId) === operation) manifestStarts().delete(input.sourceId) }
}

async function startManifestSyncUnlocked(input: ManifestRunInput): Promise<{ job: SyncJob; duplicate: boolean }> {
  const existing = await findActiveManifestRun(input.sourceId)
  if (existing) return { job: existing, duplicate: true }
  const job: SyncJob = {
    id: `manifest-${randomUUID()}`,
    sourceId: input.sourceId,
    root: await getManifestWorkspaceRoot(input.sourceId),
    status: "running",
    startedAt: new Date().toISOString(),
    output: [],
    mode: "manifest",
    message: `${input.manifestTool} manifest 初始化/更新中`,
  }
  const controller = new AbortController()
  await updateJob(job)
  await updateManifestStatus(job, "running")
  manifestActiveJobIds().add(job.id)
  const promise = executeManifestRun(job, input, controller).finally(() => {
    manifestActiveJobIds().delete(job.id)
    const current = manifestRuns().get(input.sourceId)
    if (current?.controller === controller) manifestRuns().delete(input.sourceId)
  })
  manifestRuns().set(input.sourceId, { jobId: job.id, controller, promise })
  return { job, duplicate: false }
}

export async function cancelManifestSyncAndWait(jobId: string, timeoutMs = 60_000): Promise<boolean> {
  const job = await getSyncJob(jobId)
  if (!job || job.mode !== "manifest") return false
  const run = manifestRuns().get(job.sourceId)
  if (!run) return job.status === "completed" || job.status === "failed"
  run.controller.abort()
  let timer: ReturnType<typeof setTimeout> | undefined
  const stopped = await Promise.race([run.promise.then(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs) })])
  if (timer) clearTimeout(timer)
  return stopped
}

export async function runManifestSyncForConfig(sourceId: string, input: ManifestRunInput): Promise<void> {
  await startManifestSync({ ...input, sourceId })
}
