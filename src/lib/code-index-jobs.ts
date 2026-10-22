import type { ChildProcess } from "node:child_process"
import {
  getSyncJob,
  listSyncJobs,
  startSyncJob,
  type SyncJob,
} from "@/lib/sync-runner"

export type CodeIndexJob = SyncJob

export function getCodeIndexJob(id: string): Promise<CodeIndexJob | null> {
  return getSyncJob(id)
}

export function listCodeIndexJobs(): Promise<CodeIndexJob[]> {
  return listSyncJobs()
}

export function startCodeIndexJob(options: { root: string; sourceId?: string; workers?: number; syncPull?: boolean; forceImport?: boolean }): Promise<{ job: CodeIndexJob; duplicate: boolean }> {
  if (!options.sourceId) {
    return Promise.resolve({
      job: {
        id: "",
        root: options.root,
        sourceId: "",
        status: "failed",
        startedAt: new Date().toISOString(),
        message: "Source ID 是增量同步所必需的",
        output: [],
      },
      duplicate: false,
    })
  }
  return startSyncJob({
    root: options.root,
    sourceId: options.sourceId,
    workers: options.workers,
    syncPull: options.syncPull,
    ...(options.forceImport === true ? { forceImport: true } : {}),
  })
}

// Retained as a type-level compatibility export for callers that previously
// imported ChildProcess while the importer was process-local.
export type { ChildProcess }
