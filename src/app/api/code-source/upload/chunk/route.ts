import { NextRequest, NextResponse } from "next/server"
import { uploadFileChunk } from "@/lib/sdk-upload"
import { getGBrainUploadRequestToken } from "@/lib/gbrain-server"

export const runtime = "nodejs"
export const maxDuration = 120

async function requestToken(request: NextRequest): Promise<string | null> {
  return getGBrainUploadRequestToken(request)
}

export async function PUT(request: NextRequest) {
  const token = await requestToken(request)
  if (!token) return NextResponse.json({ error: "请在 Web Settings 配置 GBrain token" }, { status: 401 })
  const sessionId = request.nextUrl.searchParams.get("sessionId") || ""
  const path = request.nextUrl.searchParams.get("path") || ""
  const offset = Number(request.nextUrl.searchParams.get("offset"))
  const length = Number(request.headers.get("content-length") || 0)
  if (!Number.isSafeInteger(length) || length < 0 || length > 4 * 1024 * 1024) {
    return NextResponse.json({ error: "每个上传分块最多 4 MiB" }, { status: 413 })
  }
  try {
    const bytes = Buffer.from(await request.arrayBuffer())
    if (bytes.length !== length || bytes.length > 4 * 1024 * 1024) {
      return NextResponse.json({ error: `分块实际大小 ${bytes.length} 与 Content-Length 不一致` }, { status: 413 })
    }
    const result = await uploadFileChunk(sessionId, path, offset, bytes, token)
    return NextResponse.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : "上传 SDK 文件块失败"
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
