import { NextRequest, NextResponse } from "next/server"
import { requireUser } from "@/lib/api-guard"
import { listUsers } from "@/lib/web-users"

export const runtime = "nodejs"

/**
 * GET /api/users/search?q=xxx&limit=20
 * 按 userName / fullName / email 模糊搜索本地用户（团队管理加成员时的补全用）。
 * 仅登录用户可查；只返回非敏感字段（id/userName/fullName/email）。
 * 照 Wegent `GET /users/search`。
 */
export async function GET(request: NextRequest) {
  const auth = await requireUser(request)
  if (!auth.ok) return auth.response

  const q = (new URL(request.url).searchParams.get("q") ?? "").trim().toLowerCase()
  if (!q) return NextResponse.json({ users: [] })
  const limit = Math.min(Math.max(Number(new URL(request.url).searchParams.get("limit")) || 20, 1), 100)

  const users = await listUsers()
  const matched = users
    .filter((user) => user.isActive)
    .filter((user) => {
      const haystack = `${user.userName} ${user.fullName} ${user.email}`.toLowerCase()
      return haystack.includes(q)
    })
    .slice(0, limit)
    .map((user) => ({ id: user.id, userName: user.userName, fullName: user.fullName, email: user.email }))

  return NextResponse.json({ users: matched })
}
