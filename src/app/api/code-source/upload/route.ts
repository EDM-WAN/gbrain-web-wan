import { cookies } from "next/headers"
import { NextRequest, NextResponse } from "next/server"
import { finalizeUploadSession } from "@/lib/sdk-upload"

export const runtime = "nodejs"
export const maxDuration = 120

async function requestToken(request: NextRequest): Promise<string | null> {
  // CLI 文件上传走 Bearer 管理员令牌直连; 只在它与 .env 配置的管理员令牌一致时放行。
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
  const configured = process.env.GBRAIN_TOKEN?.trim()
  if (bearer && configured && bearer === configured) return bearer
  const cookie = (await cookies()).get("gbrain_token")?.value
  const env = process.env.NODE_ENV !== "production" ? process.env.GBRAIN_TOKEN?.trim() : undefined
  return cookie || env || null
}

export async function POST(request: NextRequest) {
  const token = await requestToken(request)
  if (!token) return NextResponse.json({ error: "请在 Web Settings 配置 GBrain 令牌" }, { status: 401 })
  try {
    const body = await request.json().catch(() => ({})) as { sessionId?: unknown }
    if (typeof body.sessionId !== "string") return NextResponse.json({ error: "缺少上传 sessionId" }, { status: 400 })
    return NextResponse.json(await finalizeUploadSession(body.sessionId, token))
  } catch (error) {
    const message = error instanceof Error ? error.message : "完成 SDK 上传失败"
    return NextResponse.json({ error: message }, { status: /permission|unauthorized|令牌|token/i.test(message) ? 403 : 409 })
  }
}
