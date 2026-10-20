import { getCurrentUser } from "./web-session.ts"
import { apiKeyFromRequest, resolveApiKeyUserId } from "./api-keys.ts"
import { findUserById, findUserByName, listUsers, type WebUser } from "./web-users.ts"

/**
 * 请求身份解析（阶段 2 + 方案 A）。三条路径，按优先级：
 *
 *   1. 有效会话 cookie → 该 WebUser
 *   2. API key（X-API-Key / Authorization: Bearer gbk-xxx）→ 解析所属 user
 *   3. legacy 全局 token（兼容旧部署/CLI）→ 虚拟 admin 用户
 *   都没有 → null（未认证）
 *
 * legacy 模式下没有真实用户身份；为不破坏现状，映射成一个虚拟的 admin 用户
 * （id=0, userName="legacy"）。API key 路径则能得到**真实用户**，权限按阶段 2
 * 的 source-permissions 规则生效。
 */

export interface RequestIdentity {
  user: WebUser | null
  /** true 表示用的是 legacy 全局 token（无真实用户），user 为虚拟 admin。 */
  legacy: boolean
}

const LEGACY_USER_ID = 0
const LEGACY_USER_NAME = "legacy"

function legacyUser(): WebUser {
  return {
    id: LEGACY_USER_ID,
    userName: LEGACY_USER_NAME,
    email: "",
    fullName: "Legacy Token",
    avatar: null,
    role: "admin",
    authSource: "sso",
    isActive: true,
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
  }
}

/**
 * 解析请求身份。legacy 判定委托给注入进来的 `isLegacyAuthorized`
 * （由 gbrain-server 提供，避免本文件与 next/headers 耦合）。
 */
export async function resolveRequestIdentity(
  request: Request,
  isLegacyAuthorized: (request: Request) => Promise<boolean>,
): Promise<RequestIdentity> {
  // 1) 会话 cookie
  const sessionUser = await getCurrentUser(request)
  if (sessionUser) return { user: sessionUser, legacy: false }

  // 2) API key（gbk-…）→ 真实用户
  const apiKey = apiKeyFromRequest(request)
  if (apiKey) {
    const userId = await resolveApiKeyUserId(apiKey)
    if (userId !== null) {
      const user = await findUserById(userId)
      if (user && user.isActive) return { user, legacy: false }
    }
    // key 无效 → 不落到 legacy（避免用无效 key 静默降级成 admin）
    return { user: null, legacy: false }
  }

  // 3) legacy 全局 token
  if (await isLegacyAuthorized(request)) return { user: legacyUser(), legacy: true }
  return { user: null, legacy: false }
}

/**
 * 首个 admin 用户（用于迁移回填 owner）：优先取用户名配置里第一个 admin，
 * 否则取 users.json 里第一个 role=admin 的活跃用户。
 */
export async function firstAdminUserId(): Promise<number | null> {
  const adminsEnv = (process.env.GBRAIN_ADMIN_USERS ?? "")
    .split(",").map((name) => name.trim()).filter(Boolean)
  if (adminsEnv.length > 0) {
    for (const name of adminsEnv) {
      const user = await findUserByName(name)
      if (user && user.isActive) return user.id
    }
  }
  const users = await listUsers()
  const admin = users.find((user) => user.role === "admin" && user.isActive)
  return admin?.id ?? null
}
