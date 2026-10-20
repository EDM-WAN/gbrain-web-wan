import { NextRequest, NextResponse } from "next/server"
import { getCodeIndexJob } from "@/lib/code-index-jobs"
import { getSdkSourceConfig } from "@/lib/sdk-sources"
import { canViewSource } from "@/lib/source-permissions"
import { requireUser } from "@/lib/api-guard"

export const runtime = "nodejs"

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = await requireUser(request)
  if (!auth.ok) return auth.response
  const { id } = await context.params
  const job = await getCodeIndexJob(id)
  if (!job) return NextResponse.json({ error: "找不到索引任务" }, { status: 404 })
  // 可见性：只能查自己可见 source 的任务（个人源仅本人、团队源成员、系统源所有人）。
  const config = await getSdkSourceConfig(job.sourceId)
  if (config) {
    if (!await canViewSource(auth.value, config)) return NextResponse.json({ error: "找不到索引任务" }, { status: 404 })
  } else if (auth.value.role !== "admin") {
    // 无配置（如 default）→ 仅 admin 可见。
    return NextResponse.json({ error: "找不到索引任务" }, { status: 404 })
  }
  return NextResponse.json({ job })
}
