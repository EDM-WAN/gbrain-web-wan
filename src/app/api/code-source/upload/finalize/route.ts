import { NextRequest, NextResponse } from "next/server"
import { finalizeUploadSession } from "@/lib/sdk-upload"
import { getGBrainUploadRequestToken } from "@/lib/gbrain-server"

export const runtime = "nodejs"
export const maxDuration = 120

async function requestToken(request: NextRequest): Promise<string | null> {
  return getGBrainUploadRequestToken(request)
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
