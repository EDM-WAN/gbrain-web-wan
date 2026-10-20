import { readJson, writeJsonAtomic } from "./web-state.ts"

/**
 * gbrain-web 本地用户表（阶段 1：身份层）。
 *
 * 身份来源是 PMS（realpm, Discourse SSO）断言里的 username/email/fullname。
 * 管理员由 .env 的 GBRAIN_ADMIN_USERS 白名单决定——登录用户名只证明"我是谁"，
 * 证明不了"我是不是管理员"，所以必须靠这个显式白名单。
 *
 * 存储沿用 web-state 的 JSON 文件模式（data/users.json），与 sources/jobs 一致。
 */

export type WebUserRole = "admin" | "user"

export interface WebUser {
  id: number
  /** PMS 断言的 username，唯一键。 */
  userName: string
  email: string
  fullName: string
  /** 头像 URL；null 表示前端用 userName 首字母占位。 */
  avatar: string | null
  role: WebUserRole
  authSource: "sso"
  isActive: boolean
  createdAt: string
  updatedAt: string
}

const USERS_FILE = "users.json"

export async function listUsers(): Promise<WebUser[]> {
  return readJson<WebUser[]>(USERS_FILE, [])
}

export async function findUserByName(userName: string): Promise<WebUser | null> {
  const users = await listUsers()
  return users.find((user) => user.userName === userName) ?? null
}

export async function findUserById(id: number): Promise<WebUser | null> {
  const users = await listUsers()
  return users.find((user) => user.id === id) ?? null
}

/**
 * 管理员判定：userName 是否在 GBRAIN_ADMIN_USERS（逗号分隔）内。
 * 大小写不敏感，去空白，空项忽略。未配置时无人是 admin。
 */
export function resolveRole(userName: string): WebUserRole {
  const admins = (process.env.GBRAIN_ADMIN_USERS ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean)
  return admins.includes(userName.trim().toLowerCase()) ? "admin" : "user"
}

/**
 * 登录回调调用：不存在则创建，存在则更新 email/fullName 并**重算 role**
 * （白名单可能已变）。只改 SSO 可提供的字段，不动 avatar/isActive 等本地字段。
 */
export async function upsertUserFromSso(input: {
  userName: string
  email: string
  fullName: string
}): Promise<WebUser> {
  const userName = input.userName.trim()
  if (!userName) throw new Error("SSO 断言缺少 username")
  const users = await listUsers()
  const now = new Date().toISOString()
  const index = users.findIndex((user) => user.userName === userName)
  const role = resolveRole(userName)

  if (index >= 0) {
    const updated: WebUser = {
      ...users[index],
      email: input.email || users[index].email,
      fullName: input.fullName || users[index].fullName,
      role,
      updatedAt: now,
    }
    users[index] = updated
    await writeJsonAtomic(USERS_FILE, users)
    return updated
  }

  const created: WebUser = {
    id: users.reduce((max, user) => Math.max(max, user.id), 0) + 1,
    userName,
    email: input.email,
    fullName: input.fullName || userName,
    avatar: null,
    role,
    authSource: "sso",
    isActive: true,
    createdAt: now,
    updatedAt: now,
  }
  users.push(created)
  await writeJsonAtomic(USERS_FILE, users)
  return created
}
