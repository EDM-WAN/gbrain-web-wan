import { NextRequest, NextResponse } from "next/server"
import { runSourceNow, schedulerStatus, startSourceScheduler } from "@/lib/source-scheduler"
import { requireManageSource, requireUser } from "@/lib/api-guard"

export const runtime = "nodejs"

export async function GET(request: NextRequest) {
  const auth = await requireUser(request)
  if (!auth.ok) return auth.response
  await startSourceScheduler()
  return NextResponse.json(schedulerStatus())
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireUser(request)
    if (!auth.ok) return auth.response
    await startSourceScheduler()
    const sourceId = new URL(request.url).searchParams.get("sourceId")?.trim()
    if (!sourceId) return NextResponse.json({ error: "需要 Source ID" }, { status: 400 })
    // 立即同步 = 触发索引，属 source 管理动作
    const guard = await requireManageSource(auth.value, sourceId)
    if (!guard.ok) return guard.response
    const result = await runSourceNow(sourceId)
    return NextResponse.json(result, { status: result.duplicate ? 409 : 202 })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "启动同步失败" }, { status: 400 })
  }
}
