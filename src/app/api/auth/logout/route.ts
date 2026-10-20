import { NextResponse } from "next/server"
import { SESSION_COOKIE_NAME } from "@/lib/web-session"

export const runtime = "nodejs"

/** POST /api/auth/logout — 清除会话 cookie。 */
export async function POST(): Promise<Response> {
  const response = NextResponse.json({ ok: true })
  response.cookies.set(SESSION_COOKIE_NAME, "", { path: "/", maxAge: 0 })
  return response
}
