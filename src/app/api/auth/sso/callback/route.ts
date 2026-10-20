import { NextRequest, NextResponse } from "next/server"
import { consumeNonce, publicOrigin, verifySsoCallback } from "@/lib/realpm-sso"
import { upsertUserFromSso } from "@/lib/web-users"
import { SESSION_COOKIE_NAME, sessionCookieOptions, signSession } from "@/lib/web-session"

export const runtime = "nodejs"

/**
 * GET /api/auth/sso/callback?sso=..&sig=..
 * PMS 认证后回跳：验签 → 解 claims → 核对一次性 nonce → 建/找用户 →
 * 签会话 cookie → 302 到 /chat。
 *
 * 跳转目标用 publicOrigin()（来自 GBRAIN_SSO_CALLBACK_URL）而非 request.url——
 * 服务器上的 Next 会把 request.url 解析成 localhost，导致跳到 localhost:3000。
 */
export async function GET(request: NextRequest): Promise<Response> {
  const sso = request.nextUrl.searchParams.get("sso")
  const sig = request.nextUrl.searchParams.get("sig")
  const origin = publicOrigin()
  const fail = (code: string): Response =>
    NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(code)}`, origin))

  if (!sso || !sig) return fail("missing_params")

  try {
    const { claims } = verifySsoCallback({ sso, sig })
    if (!consumeNonce(claims.nonce)) return fail("bad_nonce")

    const user = await upsertUserFromSso({
      userName: claims.username,
      email: claims.email ?? "",
      fullName: claims.fullname ?? claims.username,
    })
    if (!user.isActive) return fail("disabled")

    const token = signSession(user)
    const response = NextResponse.redirect(new URL("/chat", origin))
    response.cookies.set(SESSION_COOKIE_NAME, token, sessionCookieOptions())
    return response
  } catch (error) {
    const code = error instanceof Error ? error.message : "sso_error"
    return fail(code)
  }
}
