import { NextRequest, NextResponse } from "next/server"
import { createUploadSession, getUploadSessionStatus } from "@/lib/sdk-upload"
import { getGBrainUploadRequestToken, requireGBrainBrowserRequestToken } from "@/lib/gbrain-server"
import { resolveRequestIdentity } from "@/lib/request-user"
import { getSdkSourceConfig } from "@/lib/sdk-sources"
import { canCreateSource, canUploadToSource } from "@/lib/source-permissions"

export const runtime = "nodejs"
export const maxDuration = 120

async function requestToken(request: NextRequest): Promise<string | null> {
  return getGBrainUploadRequestToken(request)
}

export async function POST(request: NextRequest) {
  const token = await requestToken(request)
  if (!token) return NextResponse.json({ error: "请先登录，或配置 GBrain 令牌" }, { status: 401 })
  try {
    const body = await request.json() as { sourceId?: unknown; files?: unknown }
    // 权限门：向某个 source 上传 = 覆盖其内容，需 upload 权限。
    // 已有配置 → canUploadToSource；无配置（首次上传建源）→ canCreateSource。
    const sourceId = typeof body.sourceId === "string" ? body.sourceId.trim() : ""
    if (sourceId) {
      const identity = await resolveRequestIdentity(request, requireGBrainBrowserRequestToken)
      if (!identity.user) return NextResponse.json({ error: "未认证" }, { status: 401 })
      const config = await getSdkSourceConfig(sourceId)
      if (config) {
        if (!await canUploadToSource(identity.user, config)) {
          return NextResponse.json({ error: `无权向 source "${sourceId}" 上传` }, { status: 403 })
        }
      } else if (!await canCreateSource(identity.user, { scope: "personal", namespace: "default" })) {
        return NextResponse.json({ error: "无权创建 source" }, { status: 403 })
      }
    }
    // 会话身份绑定稳定的 Web access token：token 换发/Web 重启后
    // 指纹不变，status/resume/commit/finalize 都能继续同一个会话；
    // 内部 GBrain 调用由 sdk-upload 用短期 OAuth access token 完成。
    const result = await createUploadSession(body.sourceId, body.files, token)
    return NextResponse.json(result, { status: 201 })
  } catch (error) {
    const message = error instanceof Error ? error.message : "创建 SDK 上传会话失败"
    return NextResponse.json({ error: message }, { status: /permission|unauthorized|令牌|token/i.test(message) ? 403 : 400 })
  }
}

export async function GET(request: NextRequest) {
  const token = await requestToken(request)
  if (!token) return NextResponse.json({ error: "请在 Web Settings 配置 GBrain 令牌" }, { status: 401 })
  const sessionId = new URL(request.url).searchParams.get("sessionId") || ""
  try {
    return NextResponse.json(await getUploadSessionStatus(sessionId, token))
  } catch (error) {
    const message = error instanceof Error ? error.message : "读取 SDK 上传状态失败"
    return NextResponse.json({ error: message }, { status: /permission|unauthorized|令牌|token/i.test(message) ? 403 : 404 })
  }
}
