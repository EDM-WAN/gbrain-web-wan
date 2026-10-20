import { NextRequest, NextResponse } from "next/server"
import { resolveCodeRoot, scanCodeDirectory } from "@/lib/code-source"
import { requireGBrainBrowserRequestToken } from "@/lib/gbrain-server"

export const runtime = "nodejs"
export const maxDuration = 120

export async function POST(request: NextRequest) {
  try {
    if (!await requireGBrainBrowserRequestToken(request)) {
      return NextResponse.json({ error: "请先在 Settings 配置 GBrain token" }, { status: 401 })
    }

    const body = await request.json() as { path?: unknown; maxFiles?: unknown }
    if (typeof body.path !== "string" || !body.path.trim()) {
      return NextResponse.json({ error: "请输入 SDK 目录路径" }, { status: 400 })
    }

    const root = await resolveCodeRoot(body.path.trim())
    const maxFiles = typeof body.maxFiles === "number" && Number.isInteger(body.maxFiles)
      ? Math.min(Math.max(body.maxFiles, 1), 100_000)
      : 100_000
    return NextResponse.json(await scanCodeDirectory(root, maxFiles))
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "扫描 SDK 目录失败" },
      { status: 400 },
    )
  }
}
