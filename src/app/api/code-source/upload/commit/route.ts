import { NextRequest, NextResponse } from "next/server"
import { commitUploadSession, getUploadSessionStatus } from "@/lib/sdk-upload"
import { getGBrainUploadRequestToken, requireGBrainBrowserRequestToken } from "@/lib/gbrain-server"
import { recordContentOwners } from "@/lib/content-owners"
import { filePathToSlug } from "@/lib/gbrain-slug"
import { resolveRequestIdentity } from "@/lib/request-user"

export const runtime = "nodejs"
export const maxDuration = 120

async function requestToken(request: NextRequest): Promise<string | null> {
  return getGBrainUploadRequestToken(request)
}

export async function POST(request: NextRequest) {
  const token = await requestToken(request)
  if (!token) return NextResponse.json({ error: "请在 Web Settings 配置 GBrain 令牌" }, { status: 401 })
  try {
    const body = await request.json().catch(() => ({})) as { sessionId?: unknown; workers?: unknown }
    if (typeof body.sessionId !== "string") return NextResponse.json({ error: "缺少上传 sessionId" }, { status: 400 })
    const workers = typeof body.workers === "number" && Number.isInteger(body.workers) ? body.workers : 2
    const sessionId = body.sessionId

    // 上传者身份。legacy 全局 token 的虚拟 admin（id 0）视作「无具体上传者」，
    // 传 null 让它退回按首个 admin 回填（保持旧部署行为）。
    const identity = await resolveRequestIdentity(request, requireGBrainBrowserRequestToken)
    const uploaderId = identity.user && identity.user.id !== 0 ? identity.user.id : null

    // 记录内容级 owner（阶段 3）：本次上传的 changed 文件 → 当前用户。
    // 按 gbrain page slug 记录（用 gbrain-slug 复刻把相对路径换算成 slug），
    // 这样删除/权限判定发生时（前端只有 slug）能直接命中。
    try {
      if (uploaderId !== null) {
        const status = await getUploadSessionStatus(sessionId, token) as { sourceId?: string; changed?: string[] }
        if (status.sourceId && Array.isArray(status.changed) && status.changed.length > 0) {
          const slugs = status.changed.map((path) => filePathToSlug(path))
          await recordContentOwners(status.sourceId, slugs, uploaderId)
        }
      }
    } catch {
      // owner 记录失败不阻塞索引提交
    }

    const result = await commitUploadSession(sessionId, token, workers, uploaderId)
    return NextResponse.json(result, { status: result.status === "indexing" ? 202 : 200 })
  } catch (error) {
    const message = error instanceof Error ? error.message : "SDK 上传索引提交失败"
    return NextResponse.json({ error: message }, { status: /permission|unauthorized|令牌|token/i.test(message) ? 403 : 400 })
  }
}
