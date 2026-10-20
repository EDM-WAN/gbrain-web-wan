import { NextRequest, NextResponse } from "next/server"
import { requireUser } from "@/lib/api-guard"
import { callGBrainServer } from "@/lib/gbrain-server"
import { backfillSourceOwnership } from "@/lib/sdk-sources"
import { firstAdminUserId } from "@/lib/request-user"
import { filterForeignRows, isForeignResult, listVisibleSources, resolveSourceAccess } from "@/lib/visible-sources"

export const runtime = "nodejs"

/** 图谱只读接口允许的 op。 */
const ALLOWED_TOOLS = new Set(["sources_list", "list_pages", "traverse_graph", "code_graph"])

export async function GET() {
  // 共享 token 的「公共只读」通道已移除，恒为 false（见下方说明）。
  return NextResponse.json({ publicReadEnabled: false })
}

/**
 * 图谱只读接口。
 *
 * ## 为什么删掉了 GBRAIN_PUBLIC_READ_TOKEN 直连
 *
 * 原实现把请求原样转发给 gbrain，用一个**共享只读 token**，且**不校验身份**
 * （未登录也能打）。gbrain 的读可见性按 OAuth client 判定，共享 token 意味着
 * 「谁打都看到同一份 source 列表」—— 与 `/api/gbrain` 同源的泄漏
 * （普通账号看到 nuwa / wegent），只是这条更宽。
 *
 * 现在统一走服务端受信通道，并按当前登录用户的归属规则收敛可见范围：
 *  - `sources_list` → 返回按用户过滤后的列表；
 *  - 其余 op → 校验 `source_id` 在该用户可见集内才放行。
 */
export async function POST(request: NextRequest) {
  const auth = await requireUser(request)
  if (!auth.ok) return auth.response
  try {
    const body = await request.json() as { params?: { name?: unknown; arguments?: unknown } }
    const name = body.params?.name
    if (typeof name !== "string" || !ALLOWED_TOOLS.has(name)) {
      return NextResponse.json({ error: "图谱只读接口不允许调用此操作" }, { status: 403 })
    }
    const args = (body.params?.arguments ?? {}) as Record<string, unknown>

    await backfillSourceOwnership(await firstAdminUserId())
    const visible = await listVisibleSources(auth.value)
    const visibleIds = new Set(visible.map((source) => source.id))

    if (name === "sources_list") {
      return streamResult({
        sources: visible.map((source) => ({ id: source.id, name: source.name, page_count: source.pageCount })),
      })
    }

    // 其余 op 均按单个 source 读取：显式指定的必须在可见集内。
    const requested = args.source_id
    const hasExplicit = typeof requested === "string" && requested !== "__all__"
    if (hasExplicit && !visibleIds.has(requested as string)) {
      return NextResponse.json({ error: `无权访问 source "${requested}"` }, { status: 403 })
    }

    // 省略 / __all__ 时 gbrain 按共享 client 的整个授权展开 —— 首选让 gbrain
    // 原生收窄（X-Gbrain-Source-Scope），再退回行级剔除兜底。
    const access = hasExplicit ? null : await resolveSourceAccess(auth.value)
    const result = await callGBrainServer(name, args, access?.narrowed
      ? { scopeSourceIds: access.visible.map((source) => source.id) }
      : {})

    if (access?.narrowed) {
      if (isForeignResult(result, access.visibleIds)) {
        return NextResponse.json({ error: "无权访问该 source 的内容" }, { status: 403 })
      }
      return streamResult(filterForeignRows(result, access.visibleIds))
    }
    return streamResult(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : "图谱读取服务不可用"
    return NextResponse.json({ error: message }, { status: 502 })
  }
}

function streamResult(payload: unknown): Response {
  return new Response(
    `event: message\ndata: ${JSON.stringify({ result: { content: [{ type: "text", text: JSON.stringify(payload) }] }, jsonrpc: "2.0", id: null })}\n\n`,
    { headers: { "Content-Type": "text/event-stream" } },
  )
}
