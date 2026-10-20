import { NextRequest, NextResponse } from "next/server"
import { getCurrentUser } from "@/lib/web-session"

export const runtime = "nodejs"

/** GET /api/auth/me — 返回当前登录用户（供顶栏显示）；未登录 401。 */
export async function GET(request: NextRequest): Promise<Response> {
  const user = await getCurrentUser(request)
  if (!user) return NextResponse.json({ user: null }, { status: 401 })
  return NextResponse.json({
    user: {
      userName: user.userName,
      email: user.email,
      fullName: user.fullName,
      avatar: user.avatar,
      role: user.role,
    },
  })
}
