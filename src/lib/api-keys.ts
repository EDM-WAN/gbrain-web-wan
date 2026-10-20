import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { readJson, writeJsonAtomic } from "./web-state.ts"

/**
 * API 密钥（方案 A，参照 Wegent `models/api_key.py` + `api_key_service.py`）。
 *
 * 每个 key 绑定一个 userId —— 拿着 key = 以该用户身份访问，权限自动按阶段 2 的
 * source-permissions 生效。
 *
 * 安全（对齐 Wegent）：
 *   - 格式 `gbk-<随机>`；**只存 SHA256 哈希**，明文只在创建时返回一次
 *   - 存 keyPrefix 供列表显示（不暴露全 key）
 *   - 可启用/停用、可删除、有过期时间（默认永不过期）
 *   - 鉴权时用 timingSafeEqual 比对哈希
 */

export interface ApiKeyRecord {
  id: number
  userId: number
  /** SHA256 hex of the full key. */
  keyHash: string
  /** 显示用前缀，如 "gbk-ab12cd34..."。 */
  keyPrefix: string
  name: string
  description: string
  isActive: boolean
  /** epoch ms；永不从未过期用 FAR_FUTURE。 */
  expiresAt: number
  lastUsedAt: number | null
  createdAt: string
  updatedAt: string
}

/** 对外返回（不含 keyHash）。 */
export type ApiKeyPublic = Omit<ApiKeyRecord, "keyHash">

const KEYS_FILE = "api-keys.json"
const KEY_PREFIX = "gbk-"
export const API_KEY_NEVER_EXPIRES = 253402300799000 // 9999-12-31T23:59:59Z

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex")
}

function toPublic(record: ApiKeyRecord): ApiKeyPublic {
  return {
    id: record.id,
    userId: record.userId,
    keyPrefix: record.keyPrefix,
    name: record.name,
    description: record.description,
    isActive: record.isActive,
    expiresAt: record.expiresAt,
    lastUsedAt: record.lastUsedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

export async function listApiKeys(userId?: number): Promise<ApiKeyPublic[]> {
  const all = await readJson<ApiKeyRecord[]>(KEYS_FILE, [])
  const scoped = userId === undefined ? all : all.filter((record) => record.userId === userId)
  return scoped.map(toPublic)
}

/**
 * 创建一把 key，返回明文（**只此一次**）。
 * name 必填；expiresAt 可选（默认永不过期）。
 */
export async function createApiKey(input: {
  userId: number
  name: string
  description?: string
  expiresAt?: number
}): Promise<{ record: ApiKeyPublic; key: string }> {
  const name = input.name.trim()
  if (!name) throw new Error("密钥名称不能为空")
  const all = await readJson<ApiKeyRecord[]>(KEYS_FILE, [])
  const random = randomBytes(24).toString("base64url")
  const key = `${KEY_PREFIX}${random}`
  const now = new Date().toISOString()
  const record: ApiKeyRecord = {
    id: all.reduce((max, item) => Math.max(max, item.id), 0) + 1,
    userId: input.userId,
    keyHash: hashKey(key),
    keyPrefix: `${KEY_PREFIX}${random.slice(0, 8)}...`,
    name,
    description: input.description?.trim() ?? "",
    isActive: true,
    expiresAt: input.expiresAt ?? API_KEY_NEVER_EXPIRES,
    lastUsedAt: null,
    createdAt: now,
    updatedAt: now,
  }
  all.push(record)
  await writeJsonAtomic(KEYS_FILE, all)
  return { record: toPublic(record), key }
}

/** 停用/启用。返回更新后的记录或 null。 */
export async function toggleApiKey(id: number, userId: number, isAdmin: boolean): Promise<ApiKeyPublic | null> {
  const all = await readJson<ApiKeyRecord[]>(KEYS_FILE, [])
  const index = all.findIndex((record) => record.id === id)
  if (index < 0) return null
  if (!isAdmin && all[index].userId !== userId) return null
  all[index] = { ...all[index], isActive: !all[index].isActive, updatedAt: new Date().toISOString() }
  await writeJsonAtomic(KEYS_FILE, all)
  return toPublic(all[index])
}

/** 删除。返回是否删掉。 */
export async function deleteApiKey(id: number, userId: number, isAdmin: boolean): Promise<boolean> {
  const all = await readJson<ApiKeyRecord[]>(KEYS_FILE, [])
  const target = all.find((record) => record.id === id)
  if (!target) return false
  if (!isAdmin && target.userId !== userId) return false
  await writeJsonAtomic(KEYS_FILE, all.filter((record) => record.id !== id))
  return true
}

/**
 * 校验一个 API key，返回所属 userId（无效/过期/停用 → null）。
 * 命中时更新 lastUsedAt。
 */
export async function resolveApiKeyUserId(key: string): Promise<number | null> {
  if (!key || !key.startsWith(KEY_PREFIX)) return null
  const all = await readJson<ApiKeyRecord[]>(KEYS_FILE, [])
  const digest = Buffer.from(hashKey(key), "hex")
  const match = all.find((record) => {
    const stored = Buffer.from(record.keyHash, "hex")
    return stored.length === digest.length && timingSafeEqual(stored, digest)
  })
  if (!match) return null
  if (!match.isActive) return null
  if (match.expiresAt <= Date.now()) return null
  // best-effort 更新 lastUsedAt（失败不影响鉴权）
  try {
    const updated = all.map((record) => record.id === match.id ? { ...record, lastUsedAt: Date.now() } : record)
    await writeJsonAtomic(KEYS_FILE, updated)
  } catch { /* ignore */ }
  return match.userId
}

/** 从请求头提取 API key（X-API-Key 或 Authorization: Bearer gbk-xxx）。 */
export function apiKeyFromRequest(request: Request): string | null {
  const xApiKey = request.headers.get("x-api-key")?.trim()
  if (xApiKey && xApiKey.startsWith(KEY_PREFIX)) return xApiKey
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
  if (bearer && bearer.startsWith(KEY_PREFIX)) return bearer
  return null
}
