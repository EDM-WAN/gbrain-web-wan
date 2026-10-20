import { NextRequest } from "next/server"
import { getGBrainServerToken, hasGBrainServerAuthForRequest } from "@/lib/gbrain-server"
import { backfillSourceOwnership } from "@/lib/sdk-sources"
import { firstAdminUserId, resolveRequestIdentity } from "@/lib/request-user"
import { requireGBrainBrowserRequestToken } from "@/lib/gbrain-server"
import { isSourceVisibleTo, resolveSourceAccess } from "@/lib/visible-sources"

const GBRAIN_BASE_URL = process.env.GBRAIN_URL || "http://localhost:8787"

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

export const runtime = "nodejs"

/**
 * Progressive Chat envelope around the existing non-streaming think MCP call.
 * It emits lifecycle/retrieval events immediately and chunks the final answer
 * for the UI. The canonical ThinkResult remains unchanged; this route is an
 * additive transport and can later swap its final-answer source for provider
 * token deltas without changing the browser contract.
 */
export async function POST(request: NextRequest): Promise<Response> {
  const body = await request.json().catch(() => null)
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Invalid think stream request" }, { status: 400 })
  }

  if (!await hasGBrainServerAuthForRequest(request)) return Response.json({ error: "请先登录，或配置 GBrain token" }, { status: 401 })

  // source 越权闸门：think 的 source_id 决定检索范围，而 gbrain 侧的可见性按
  // **共享的**服务端 OAuth client 判定（见 app/api/gbrain/route.ts 头注释）。
  // 合成类 op 的输出是一段文本，无法事后按行剔除他人内容 —— 必须改请求。
  const identity = await resolveRequestIdentity(request, requireGBrainBrowserRequestToken)
  if (!identity.user && !identity.legacy) return Response.json({ error: "请先登录" }, { status: 401 })

  // 省略 source_id（「全部 source」）时，用窄化头把 gbrain 的展开范围收敛到
  // 当前用户可见集 —— 这样合成文本也只会基于可见 source（行级过滤做不到）。
  let scopeSourceIds: string[] | undefined
  const requested = (body as { source_id?: unknown }).source_id
  if (!identity.legacy) {
    await backfillSourceOwnership(await firstAdminUserId())
    const hasExplicit = typeof requested === "string" && requested !== "__all__"
    if (hasExplicit && !await isSourceVisibleTo(identity.user!, requested as string)) {
      return Response.json({ error: `无权访问 source "${requested}"` }, { status: 403 })
    }
    if (!hasExplicit) {
      const access = await resolveSourceAccess(identity.user!)
      if (access.narrowed) {
        const ids = access.visible.map((source) => source.id)
        if (ids.length === 0) {
          return Response.json({ error: "当前账号没有可访问的 source，无法发起对话。" }, { status: 403 })
        }
        scopeSourceIds = ids
      }
    }
  }

  const token = await getGBrainServerToken()
  const upstream = await fetch(`${GBRAIN_BASE_URL}/think/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Authorization: `Bearer ${token}`,
      ...(scopeSourceIds ? { "X-Gbrain-Source-Scope": scopeSourceIds.join(",") } : {}),
    },
    body: JSON.stringify(body),
    cache: "no-store",
  })
  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "")
    return Response.json({ error: text || "GBrain think stream failed" }, { status: upstream.status || 502 })
  }
  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  })
}
