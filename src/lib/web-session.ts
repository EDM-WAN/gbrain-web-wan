import { createHmac, timingSafeEqual } from "node:crypto"
import { findUserById, type WebUser } from "./web-users.ts"

/**
 * gbrain-web 用户会话（阶段 1：身份层）。
 *
 * 会话值是一个紧凑的 HS256 JWT（自签自验，不引入 jsonwebtoken 依赖）。
 * 密钥来自 GBRAIN_SESSION_SECRET，仅服务端读取。
 *
 * cookie 属性刻意与现有 api/auth/token 的 gbrain_token 不同：
 * 会话 cookie 需要走过 SSO 顶层回跳，因此 sameSite 必须是 "lax"（strict 会在
 * 跨站回跳时被浏览器丢弃）。httpOnly + secure(可配) 保持一致。
 */

export const SESSION_COOKIE_NAME = "gbrain_session"
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 天

export interface SessionPayload {
  /** userName */
  sub: string
  /** userId */
  uid: number
  role: "admin" | "user"
  /** epoch 毫秒 */
  exp: number
}

function sessionSecret(): string {
  const secret = process.env.GBRAIN_SESSION_SECRET?.trim()
  if (!secret) throw new Error("缺少 GBRAIN_SESSION_SECRET 环境变量")
  return secret
}

function base64url(input: Buffer | string): string {
  const buffer = typeof input === "string" ? Buffer.from(input, "utf8") : input
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function fromBase64url(input: string): string {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/")
  return Buffer.from(padded, "base64").toString("utf8")
}

function sign(data: string): string {
  return base64url(createHmac("sha256", sessionSecret()).update(data).digest())
}

/** 签发会话 JWT。 */
export function signSession(user: WebUser, ttlMs = SESSION_TTL_MS): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const payload: SessionPayload = {
    sub: user.userName,
    uid: user.id,
    role: user.role,
    exp: Date.now() + ttlMs,
  }
  const body = base64url(JSON.stringify(payload))
  const signature = sign(`${header}.${body}`)
  return `${header}.${body}.${signature}`
}

/** 校验会话；签名错误或过期返回 null。 */
export function verifySession(token: string): SessionPayload | null {
  const parts = token.split(".")
  if (parts.length !== 3) return null
  const [header, body, signature] = parts
  try {
    const expected = sign(`${header}.${body}`)
    const expectedBuf = Buffer.from(expected)
    const providedBuf = Buffer.from(signature)
    if (expectedBuf.length !== providedBuf.length) return null
    if (!timingSafeEqual(expectedBuf, providedBuf)) return null
    const payload = JSON.parse(fromBase64url(body)) as SessionPayload
    if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null
    if (typeof payload.sub !== "string" || typeof payload.uid !== "number") return null
    return payload
  } catch {
    return null
  }
}

function tokenFromCookieHeader(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=")
    if (name === SESSION_COOKIE_NAME) return decodeURIComponent(rest.join("="))
  }
  return null
}

/** 从请求的 Cookie 头取当前用户（校验签名 + 查表确认 isActive）。 */
export async function getCurrentUser(request: Request): Promise<WebUser | null> {
  const token = tokenFromCookieHeader(request.headers.get("cookie"))
  if (!token) return null
  const payload = verifySession(token)
  if (!payload) return null
  const user = await findUserById(payload.uid)
  if (!user || !user.isActive || user.userName !== payload.sub) return null
  return user
}

// 服务端组件里用的 getCurrentUserFromCookies() 单独放在 web-session-cookies.ts：
// 那里 import next/headers，而本文件要保持可被 node --test 直接导入（不拉 Next 运行时）。

/** 会话 cookie 的写入属性（顶层回跳要求 lax）。 */
export function sessionCookieOptions(): {
  httpOnly: true
  sameSite: "lax"
  secure: boolean
  path: string
  maxAge: number
} {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.GBRAIN_COOKIE_SECURE === "true",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  }
}
