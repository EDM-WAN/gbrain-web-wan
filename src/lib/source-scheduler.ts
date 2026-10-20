import { listRegisteredSources } from "@/lib/code-source"
import { listSdkSourceConfigs, updateSdkSourceConfig, type SdkSourceConfig } from "@/lib/sdk-sources"
import { getSyncJob, listSyncJobs, startSyncJob, type SyncJob } from "@/lib/sync-runner"
import { runManifestSyncForConfig, startManifestSync } from "@/lib/manifest-sync-runner"

const TICK_MS = 30_000
const MAX_FAILURES = 3
const activeSources = new Set<string>()
type SchedulerState = {
  timer?: ReturnType<typeof setInterval>
  started?: boolean
  reconciling?: Promise<void>
  monitoredJobs?: Set<string>
}
const globalKey = "__gbrainSourceScheduler" as const

type GlobalWithScheduler = typeof globalThis & { [globalKey]?: SchedulerState }

function nowIso(): string {
  return new Date().toISOString()
}

function nextRun(config: SdkSourceConfig, from = Date.now()): string {
  return new Date(from + Math.max(config.intervalMinutes, 5) * 60_000).toISOString()
}

function isDue(config: SdkSourceConfig, now = Date.now()): boolean {
  return config.enabled && (!config.nextRunAt || Date.parse(config.nextRunAt) <= now)
}

function rootFor(config: SdkSourceConfig, registered: Array<{ id: string; local_path: string | null }>): string | null {
  if (config.kind === "directory") return config.path || null
  return registered.find((source) => source.id === config.sourceId)?.local_path || null
}

async function recordSchedule(config: SdkSourceConfig, job: SyncJob): Promise<void> {
  const status = job.status
  await updateSdkSourceConfig(config.sourceId, (current) => {
    const failed = status === "failed"
    const failures = failed ? (current.consecutiveFailures ?? 0) + 1 : 0
    const paused = failures >= MAX_FAILURES
    return {
      ...current,
      enabled: paused ? false : current.enabled,
      lastStatus: paused ? "paused" : status,
      lastRunAt: job.startedAt,
      nextRunAt: nextRun(current),
      lastSuccessAt: status === "completed" ? nowIso() : current.lastSuccessAt,
      lastError: failed ? (job.message || "同步失败") : undefined,
      consecutiveFailures: failures,
    }
  })
}

async function reconcileRunningSchedules(): Promise<void> {
  const state = (globalThis as GlobalWithScheduler)[globalKey] ??= {}
  if (state.reconciling) return state.reconciling

  state.reconciling = (async () => {
    const configs = await listSdkSourceConfigs()
    const running = configs.filter((config) => config.lastStatus === "running" && config.lastRunAt)
    if (running.length === 0) return

    const jobs = await listSyncJobs()
    await Promise.all(running.map(async (config) => {
      const matching = jobs
        .filter((job) => job.sourceId === config.sourceId)
        .sort((a, b) => Math.abs(Date.parse(a.startedAt) - Date.parse(config.lastRunAt!)) - Math.abs(Date.parse(b.startedAt) - Date.parse(config.lastRunAt!)))[0]
      if (!matching || Math.abs(Date.parse(matching.startedAt) - Date.parse(config.lastRunAt!)) >= 60_000) return
      const state = (globalThis as GlobalWithScheduler)[globalKey]
      if (state?.monitoredJobs?.has(matching.id)) return
      if (matching.status === "completed" || matching.status === "failed") {
        await recordSchedule(config, matching)
      } else {
        void monitorJob(config, matching.id)
      }
    }))
  })().finally(() => {
    state.reconciling = undefined
  })
  return state.reconciling
}

async function monitorJob(config: SdkSourceConfig, jobId: string): Promise<void> {
  const state = (globalThis as GlobalWithScheduler)[globalKey] ??= {}
  const monitoredJobs = state.monitoredJobs ??= new Set<string>()
  if (monitoredJobs.has(jobId)) return
  monitoredJobs.add(jobId)

  try {
    await monitorJobUntilTerminal(config, jobId)
  } finally {
    monitoredJobs.delete(jobId)
  }
}

async function monitorJobUntilTerminal(config: SdkSourceConfig, jobId: string): Promise<void> {
  for (let attempt = 0; attempt < 1800; attempt += 1) {
    const job = await getSyncJob(jobId)
    if (job && (job.status === "completed" || job.status === "failed")) {
      await recordSchedule(config, job)
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
  await updateSdkSourceConfig(config.sourceId, (current) => ({
    ...current,
    lastStatus: "failed",
    lastError: "同步任务超过监控时限，请查看任务日志",
    nextRunAt: nextRun(current),
  }))
}

async function runConfig(config: SdkSourceConfig, registered: Array<{ id: string; local_path: string | null }>): Promise<void> {
  if (activeSources.has(config.sourceId)) return
  if (config.kind === "manifest") {
    if (config.manifestTool !== "auto" && config.manifestTool !== "repo" && config.manifestTool !== "west" || !config.manifestUrl) {
      await updateSdkSourceConfig(config.sourceId, (current) => ({
        ...current,
        lastStatus: "failed",
        lastRunAt: nowIso(),
        nextRunAt: nextRun(current),
        lastError: "Manifest source 缺少工具类型或 Manifest URL",
        consecutiveFailures: (current.consecutiveFailures ?? 0) + 1,
      }))
      return
    }
    activeSources.add(config.sourceId)
    try {
      await runManifestSyncForConfig(config.sourceId, {
        sourceId: config.sourceId,
        manifestTool: config.manifestTool,
        manifestUrl: config.manifestUrl,
        branch: config.branch,
        workers: 2,
      })
    } finally {
      activeSources.delete(config.sourceId)
    }
    return
  }
  const root = rootFor(config, registered)
  if (!root) {
    await updateSdkSourceConfig(config.sourceId, (current) => ({
      ...current,
      lastStatus: "failed",
      lastRunAt: nowIso(),
      nextRunAt: nextRun(current),
      lastError: "找不到 source 的本地路径",
      consecutiveFailures: (current.consecutiveFailures ?? 0) + 1,
    }))
    return
  }
  activeSources.add(config.sourceId)
  try {
    const started = await startSyncJob({ root, sourceId: config.sourceId, workers: 2, syncPull: config.kind === "git", fullSync: false })
    if (started.duplicate) return
    await updateSdkSourceConfig(config.sourceId, (current) => ({ ...current, lastStatus: "running", lastRunAt: nowIso(), nextRunAt: nextRun(current) }))
    void monitorJob(config, started.job.id)
  } finally {
    activeSources.delete(config.sourceId)
  }
}

export async function runDueSources(now = Date.now()): Promise<number> {
  const configs = await listSdkSourceConfigs()
  const due = configs.filter((config) => isDue(config, now))
  if (due.length === 0) return 0
  const registered = await listRegisteredSources().catch(() => [])
  await Promise.all(due.map((config) => runConfig(config, registered)))
  return due.length
}

export async function startSourceScheduler(): Promise<void> {
  const global = globalThis as GlobalWithScheduler
  const state = global[globalKey] ?? {}
  global[globalKey] = state
  // Reconcile existing runs before launching any newly-due schedules.
  await reconcileRunningSchedules().catch(() => undefined)
  if (!state.started) {
    state.started = true
    state.timer = setInterval(() => void runDueSources(), TICK_MS)
    // Recover schedules that became due while Web was stopped.
    await runDueSources().catch(() => undefined)
  }
}

export function schedulerStatus(): { started: boolean; activeSources: string[]; tickMs: number } {
  const state = (globalThis as GlobalWithScheduler)[globalKey]
  return { started: state?.started === true, activeSources: Array.from(activeSources), tickMs: TICK_MS }
}

export async function runSourceNow(sourceId: string): Promise<{ job: SyncJob; duplicate: boolean }> {
  const config = (await listSdkSourceConfigs()).find((item) => item.sourceId === sourceId)
  if (!config) throw new Error(`找不到 source 配置：${sourceId}`)
  if (config.kind === "manifest") {
    if ((config.manifestTool !== "auto" && config.manifestTool !== "repo" && config.manifestTool !== "west") || !config.manifestUrl) throw new Error(`Manifest source ${sourceId} 配置不完整`)
    return startManifestSync({
      sourceId,
      manifestTool: config.manifestTool,
      manifestUrl: config.manifestUrl,
      branch: config.branch,
      workers: 2,
    })
  }
  const registered = await listRegisteredSources()
  const root = rootFor(config, registered)
  if (!root) throw new Error(`找不到 source 的本地路径：${sourceId}`)
  const result = await startSyncJob({ root, sourceId, workers: 2, syncPull: config.kind === "git", fullSync: false })
  if (!result.duplicate) {
    await updateSdkSourceConfig(sourceId, (current) => ({ ...current, enabled: true, lastStatus: "running", lastRunAt: nowIso(), nextRunAt: nextRun(current) }))
    void monitorJob(config, result.job.id)
  }
  return result
}
