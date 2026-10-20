import { NextRequest, NextResponse } from "next/server"
import { getSourceEmbedStatus, startEmbedJob } from "@/lib/sync-runner"
import { requireUploadSource, requireUser } from "@/lib/api-guard"

export const runtime = "nodejs"
export const maxDuration = 120

function validSourceId(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const id = raw.trim()
  return /^[a-z0-9-]{1,32}$/.test(id) ? id : null
}

/**
 * GET /api/code-source/embed?sourceId=xxx
 * 返回该 source 的向量化覆盖度（embedCoverage 0..1 / chunks / pages），
 * 供 Web 显示「待向量化」徽标。
 */
export async function GET(request: NextRequest) {
  const auth = await requireUser(request)
  if (!auth.ok) return auth.response
  const sourceId = validSourceId(new URL(request.url).searchParams.get("sourceId"))
  if (!sourceId) return NextResponse.json({ error: "需要有效的 Source ID" }, { status: 400 })
  const status = await getSourceEmbedStatus(sourceId)
  if (!status) return NextResponse.json({ error: "无法读取该 source 的向量化状态" }, { status: 502 })
  return NextResponse.json(status)
}

/**
 * POST /api/code-source/embed
 * body: { sourceId, force? }
 * 为指定 source 提交一个 `embed`（stale）任务，补建缺失向量。
 * 同一 source 已有 embed/索引任务在跑时返回 409（除非 force=true）。
 */
export async function POST(request: NextRequest) {
  const auth = await requireUser(request)
  if (!auth.ok) return auth.response
  try {
    const body = await request.json().catch(() => ({})) as { sourceId?: unknown; force?: unknown }
    const sourceId = validSourceId(body.sourceId)
    if (!sourceId) return NextResponse.json({ error: "需要有效的 Source ID" }, { status: 400 })
    // 向量化会写入该 source 的内容 → 需要上传/索引权限。
    const guard = await requireUploadSource(auth.value, sourceId)
    if (!guard.ok) return guard.response
    const result = await startEmbedJob(sourceId, { force: body.force === true })
    if (result.duplicate) {
      return NextResponse.json(
        { error: `"${sourceId}" 已有索引/向量化任务正在运行，请等待其完成或稍后再试`, minionId: result.minionId },
        { status: 409 },
      )
    }
    return NextResponse.json({ ok: true, sourceId, minionId: result.minionId }, { status: 202 })
  } catch (error) {
    const message = error instanceof Error ? error.message : "启动向量化失败"
    const status = /scope|permission|admin|unauthorized|forbidden/i.test(message) ? 403 : 400
    return NextResponse.json({ error: message }, { status })
  }
}
