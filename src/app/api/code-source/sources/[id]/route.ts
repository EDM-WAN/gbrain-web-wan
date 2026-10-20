import { NextRequest, NextResponse } from "next/server"
import { callGBrainOp } from "@/lib/gbrain-cli"
import { resolveCodeRoot } from "@/lib/code-source"
import { requireManageSource, requireUser } from "@/lib/api-guard"

export const runtime = "nodejs"

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = await requireUser(request)
  if (!auth.ok) return auth.response
  const { id } = await context.params
  try {
    const body = await request.json() as { action?: unknown; path?: unknown; confirm?: unknown; noFederate?: unknown }
    const action = body.action
    // 这些动作都改变 source 归属/存在性 → 需要 manage 权限。
    // restore 属归档恢复，通常由 admin 操作；这里也走 manage（系统 source 的 restore
    // 由 admin 通过 system 规则放行）。
    const guard = await requireManageSource(auth.value, id)
    if (!guard.ok) return guard.response
    // source 生命周期写操作统一走本机 CLI（gbrain call，受信本机语义）：
    // 0.60 给 sources_remove 加了写围栏，且远端通道对 path 类参数另有身份限制
    // （sources_add: "path is not honored over MCP"）。权限由上面的
    // requireManageSource 裁决，执行走受信通道。详见 lib/gbrain-cli.ts 头注释。
    if (action === "set-path") {
      if (typeof body.path !== "string" || !body.path.trim()) return NextResponse.json({ error: "请输入新目录路径" }, { status: 400 })
      const path = await resolveCodeRoot(body.path.trim())
      return NextResponse.json({ result: await callGBrainOp("sources_set_path", { id, path }) })
    }
    if (action === "archive") {
      return NextResponse.json({ result: await callGBrainOp("sources_archive", { id }) })
    }
    if (action === "restore") {
      return NextResponse.json({ result: await callGBrainOp("sources_restore", { id, no_federate: body.noFederate === true }) })
    }
    if (action === "remove") {
      if (body.confirm !== id) return NextResponse.json({ error: "永久删除必须输入准确的 Source ID 确认" }, { status: 400 })
      const impact = await callGBrainOp("sources_remove", { id, dry_run: true })
      return NextResponse.json({
        impact,
        result: await callGBrainOp("sources_remove", {
          id,
          confirm_destructive: true,
          revoke_oauth_clients: true,
        }),
      })
    }
    return NextResponse.json({ error: "不支持的 source 操作" }, { status: 400 })
  } catch (error) {
    const message = error instanceof Error ? error.message : "source 操作失败"
    const status = /scope|permission|admin|unauthorized|forbidden/i.test(message) ? 403 : /not found/i.test(message) ? 404 : 400
    return NextResponse.json({ error: message }, { status })
  }
}
