import { cookies } from "next/headers"
import { findUserById, type WebUser } from "@/lib/web-users"
import { SESSION_COOKIE_NAME, verifySession } from "@/lib/web-session"

/**
 * 服务端组件（RSC / route handler）里通过 next/headers 的 cookies() 取当前用户。
 * 单独成文件，使 web-session.ts 的纯逻辑可被 node --test 直接导入。
 */
export async function getCurrentUserFromCookies(): Promise<WebUser | null> {
  const store = await cookies()
  const token = store.get(SESSION_COOKIE_NAME)?.value
  if (!token) return null
  const payload = verifySession(token)
  if (!payload) return null
  const user = await findUserById(payload.uid)
  if (!user || !user.isActive || user.userName !== payload.sub) return null
  return user
}
