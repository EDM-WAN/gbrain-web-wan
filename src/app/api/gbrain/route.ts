/**
 * GBrain MCP 代理路由
 *
 * 前端通过此路由调用 GBrain MCP 工具
 * 路由：POST /api/gbrain
 *
 * Token 从 httpOnly cookie (gbrain_token) 读取，兜底环境变量
 *
 * ## 为什么这里必须做 source 权限裁决
 *
 * gbrain 的读权限是按 **OAuth client** 判定的（`federated_read` 授权），而本部署
 * 所有浏览器会话共用同一个服务端 client（`gbrain-server.ts` 的
 * `getGBrainOAuthToken()` 是进程级单例），所以 gbrain 眼里**只有一条调用方身份**，
 * 它对 `sources_list` 的过滤、对 `source_id` 的授权，**与被访问者的账号无关**。
 *
 * 后果（修复前）：
 *  1. 普通账号能在下拉看到 `nuwa` / `wegent` 等别人的 source；
 *  2. `/memory/<slug>?source_id=nuwa` 这类请求把 source_id 原样透传，直接读到
 *     无权访问的内容；
 *  3. 「全部 source」不传 `source_id` 时，gbrain 按共享 client 的**整个**授权
 *     展开（`sourceScopeOpts`），同样跨用户返回内容。
 *
 * 因此本路由做两件事，缺一不可：
 *  - **入口校验**：显式 `source_id` 必须在当前用户可见集内，否则 403；
 *  - **出口收敛**：结果里属于他人 source 的行一律剔除（应对省略 source_id 的读取）。
 *
 * 前端各页也应只展示可见 source，但不假设前端可信 —— 这里是兜底闸门。
 */

import { NextRequest, NextResponse } from "next/server"
import { callGBrainServer, hasGBrainServerAuthForRequest, requireGBrainBrowserRequestToken } from "@/lib/gbrain-server"
import { summarizeMCPError } from "@/lib/chat-errors"
import { firstAdminUserId, resolveRequestIdentity } from "@/lib/request-user"
import { backfillSourceOwnership } from "@/lib/sdk-sources"
import { filterForeignRows, isForeignResult, isSourceVisibleTo, listVisibleSources, resolveSourceAccess, type SourceAccess } from "@/lib/visible-sources"

export const runtime = "nodejs"

/** 返回 source 清单的 op：结果必须换成已过滤的版本，绝不透传原始列表。 */
const SOURCE_LISTING_OPS = new Set(["sources_list"])
const ALL_SOURCES = "__all__"

export async function POST(request: NextRequest) {
  try {
    if (!await hasGBrainServerAuthForRequest(request)) {
      return NextResponse.json({ error: "Unauthorized: 请先登录，或配置 GBrain token" }, { status: 401 })
    }
    const body = await request.json() as { params?: { name?: unknown; arguments?: unknown } }
    const name = body.params?.name
    const args = body.params?.arguments
    if (typeof name !== "string" || !args || typeof args !== "object" || Array.isArray(args)) {
      return NextResponse.json({ error: "Invalid MCP tool request" }, { status: 400 })
    }
    const argsRecord = args as Record<string, unknown>

    // legacy 全局 token 是部署级管理员凭据（旧部署兼容），不做 per-user 收敛。
    const identity = await resolveRequestIdentity(request, requireGBrainBrowserRequestToken)
    if (!identity.user && !identity.legacy) {
      return NextResponse.json({ error: "请先登录" }, { status: 401 })
    }
    const enforce = !identity.legacy

    if (enforce) await backfillSourceOwnership(await firstAdminUserId())

    // ── 出口：source 清单换成过滤版 ──
    if (SOURCE_LISTING_OPS.has(name)) {
      return streamResult(await filteredSourceListing(identity.user, identity.legacy))
    }

    // ── 入口：显式指定的 source 必须可见 ──
    const requested = argsRecord.source_id
    const hasExplicit = typeof requested === "string" && requested !== ALL_SOURCES
    if (enforce && hasExplicit && !await isSourceVisibleTo(identity.user!, requested as string)) {
      return NextResponse.json({ error: `无权访问 source "${requested}"` }, { status: 403 })
    }

    // ── 出口收敛 ──
    // 省略 / __all__ 时 gbrain 按共享 client 的整个授权展开。首选让 gbrain 原生
    // 收窄（X-Gbrain-Source-Scope，narrow-only），这样连 `think` 的**合成文本**
    // 也只基于可见 source 生成（行级过滤对文本无能为力）；不可用时退回行级剔除。
    let access: SourceAccess | null = null
    if (enforce && !hasExplicit) {
      access = await resolveSourceAccess(identity.user!)
    }

    try {
      const result = await callGBrainServer(name, argsRecord, access?.narrowed
        ? { scopeSourceIds: access.visible.map((source) => source.id) }
        : {})

      // 服务端未收窄（narrowed=false：可见集 ＝ 授权全集）时结果本就干净，跳过遍历。
      if (access?.narrowed) {
        if (isForeignResult(result, access.visibleIds)) {
          return NextResponse.json({ error: "无权访问该 source 的内容" }, { status: 403 })
        }
        // 行级剔除作为第二道防线：老版本 gbrain 不认这个头，只靠它兜底。
        return streamResult(filterForeignRows(result, access.visibleIds))
      }
      return streamResult(result)
    } catch (error) {
      const message = error instanceof Error ? error.message : "GBrain MCP 请求失败"
      return NextResponse.json({ error: summarizeMCPError(502, message) }, { status: /401|403|unauthorized|permission|scope/i.test(message) ? 403 : 502 })
    }
  } catch (error) {
    console.error("GBrain MCP proxy error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

function streamResult(payload: unknown): Response {
  return new Response(`event: message\ndata: ${JSON.stringify({ result: { content: [{ type: "text", text: JSON.stringify(payload) }] }, jsonrpc: "2.0", id: null })}\n\n`, {
    headers: { "Content-Type": "text/event-stream" },
  })
}

/**
 * `sources_list` 的过滤版本：保留 gbrain 的原始字段形状，但只留下当前用户可见的行。
 *
 * legacy 全局 token（部署级管理员）保持完整列表，行为不变。
 */
async function filteredSourceListing(
  user: Awaited<ReturnType<typeof resolveRequestIdentity>>["user"],
  legacy: boolean,
): Promise<{ sources: Array<Record<string, unknown>> }> {
  const raw = await callGBrainServer("sources_list", { include_archived: false }) as {
    sources?: Array<Record<string, unknown>>
  }
  const all = raw.sources ?? []
  if (legacy) return { sources: all }
  if (!user) return { sources: [] }
  const visibleIds = new Set((await listVisibleSources(user)).map((source) => source.id))
  return { sources: all.filter((source) => visibleIds.has(String(source.id ?? ""))) }
}
