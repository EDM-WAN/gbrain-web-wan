import { NextRequest, NextResponse } from "next/server"
import { callGBrainServerWithToken, getGBrainServerToken } from "@/lib/gbrain-server"
import { listCodeIndexJobs } from "@/lib/code-index-jobs"
import { getSdkSourceConfig } from "@/lib/sdk-sources"
import { canViewSource } from "@/lib/source-permissions"
import { requireUser } from "@/lib/api-guard"

export const runtime = "nodejs"

interface MinionJobProgress {
  done?: number
  total?: number
  embedded?: number
  phase?: string
}

interface SourceMinionJob {
  id: number
  name: "import" | "sync" | "embed" | "embed-backfill"
  status: string
  progress?: MinionJobProgress | null
  result?: { embedded?: number; failures?: number } | null
  error_text?: string | null
  created_at?: string | Date
  finished_at?: string | Date | null
}

function parseRows(raw: unknown): SourceMinionJob[] {
  const container = raw && typeof raw === "object" ? raw as { jobs?: unknown } : null
  const rows = Array.isArray(raw) ? raw : Array.isArray(container?.jobs) ? container.jobs : []
  return rows.filter((row): row is SourceMinionJob => Boolean(
    row && typeof row === "object" && !Array.isArray(row) &&
    typeof (row as Record<string, unknown>).id === "number" &&
    typeof (row as Record<string, unknown>).name === "string",
  ))
}

export async function GET(request: NextRequest) {
  const auth = await requireUser(request)
  if (!auth.ok) return auth.response
  const user = auth.value

  /** 该 source 对当前用户是否可见（无配置时仅 admin）。 */
  const visible = async (sid: string): Promise<boolean> => {
    const config = await getSdkSourceConfig(sid)
    if (config) return canViewSource(user, config)
    return user.role === "admin"
  }

  const sourceId = new URL(request.url).searchParams.get("sourceId")?.trim()
  if (!sourceId) {
    // 无 sourceId：只返回可见 source 的任务（默认 default 仅 admin 可见）。
    const all = await listCodeIndexJobs()
    const flags = await Promise.all(all.map((job) => visible(job.sourceId)))
    return NextResponse.json({ jobs: all.filter((_, index) => flags[index]) })
  }
  if (!await visible(sourceId)) return NextResponse.json({ error: `无权查看 source "${sourceId}" 的任务` }, { status: 403 })

  const token = await getGBrainServerToken()

  try {
    const statusOrder = ["active", "waiting", "delayed", "waiting-children", "paused"]
    const jobNames = ["import", "sync", "embed", "embed-backfill"]
    const activeJobs: SourceMinionJob[] = []
    for (const status of statusOrder) {
      for (const name of jobNames) {
        const raw = await callGBrainServerWithToken("list_jobs", { status, name, limit: 100 }, token)
        for (const job of parseRows(raw)) {
          const data = (job as SourceMinionJob & { data?: Record<string, unknown> }).data ?? {}
          if (data.sourceId === sourceId) activeJobs.push(job)
        }
      }
    }

    // Prefer embedding work over the import/sync task that enqueued it.
    activeJobs.sort((a, b) => {
      const rank = (job: SourceMinionJob) => job.name === "embed" || job.name === "embed-backfill" ? 0 : 1
      return rank(a) - rank(b) || b.id - a.id
    })
    return NextResponse.json({ activeJobs })
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "读取 SDK source 任务进度失败",
    }, { status: 502 })
  }
}
