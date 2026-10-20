import { NextResponse } from "next/server"
import { buildSsoRedirect, newNonce, publicOrigin, rememberNonce } from "@/lib/realpm-sso"

export const runtime = "nodejs"

/**
 * GET /api/auth/sso/login
 * 生成一次性 nonce，构造 PMS SSO 跳转 URL，302 过去。
 * 必须是浏览器顶层跳转（用户点登录按钮 → location.href），因为 PMS 靠
 * realpm_session cookie 认人，fetch/XHR 带不上。
 *
 * 失败回跳用 publicOrigin()：request.url 在服务器上会被解析成 localhost。
 */
export async function GET(): Promise<Response> {
  try {
    const callbackUrl = process.env.GBRAIN_SSO_CALLBACK_URL?.trim()
      || new URL("/api/auth/sso/callback", publicOrigin()).toString()
    const nonce = newNonce()
    rememberNonce(nonce)
    const url = buildSsoRedirect({ callbackUrl, nonce })
    return NextResponse.redirect(url)
  } catch (error) {
    const message = error instanceof Error ? error.message : "SSO 登录初始化失败"
    return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(message)}`, publicOrigin()))
  }
}
