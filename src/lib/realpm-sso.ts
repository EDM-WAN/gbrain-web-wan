import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

/**
 * PMS（realpm）Discourse SSO 协议的 SP 侧实现。
 *
 * 与标准 OIDC 不同：Discourse SSO 用 base64(payload) + HMAC-SHA256 签名：
 *   发起：payload = urlencode({nonce, return_sso_url, app_id})
 *         sso = base64(payload); sig = HMAC-SHA256(secret, sso).hexdigest()
 *   回调：重新计算 sig 比对；解 base64 得 claims；核对一次性 nonce。
 *
 * 安全要点（来自 PMS 文档）：
 *   - sig 必须是 64 位小写 hex
 *   - nonce 一次性（PMS 侧 sso_used_nonces 保留 24h；SP 侧也应各用各的）
 *   - 回调必须顶层跳转（带 PMS 的 realpm_session cookie），不能 iframe
 */

export interface SsoClaims {
  nonce: string
  username: string
  email?: string
  fullname?: string
  id?: string
}

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`缺少 ${name} 环境变量`)
  return value
}

function ssoSign(sso: string): string {
  return createHmac("sha256", required("REALPM_SSO_SECRET")).update(sso).digest("hex")
}

/**
 * 构造发起登录所需的 PMS URL。
 * callbackUrl 必须与注册时的 allowed_return_urls 同 origin。
 */
export function buildSsoRedirect(opts: { callbackUrl: string; nonce: string }): string {
  const providerUrl = process.env.REALPM_SSO_PROVIDER_URL?.trim() || "https://pms.realmcu.com/api/sso/provider"
  const appId = required("REALPM_SSO_APP_ID")
  const payload = new URLSearchParams({
    nonce: opts.nonce,
    return_sso_url: opts.callbackUrl,
    app_id: appId,
  }).toString()
  const sso = Buffer.from(payload, "utf8").toString("base64")
  const sig = ssoSign(sso)
  return `${providerUrl}?sso=${encodeURIComponent(sso)}&sig=${sig}`
}

/** 生成一次性 nonce。 */
export function newNonce(): string {
  return randomBytes(16).toString("hex")
}

/**
 * 公开访问 origin（用于构造跳转目标）。
 *
 * 不能用 request.url 构造重定向：服务器上的 Next.js 会把它解析成固定的
 * localhost（实测 Host 头也不会覆盖），导致回调后浏览器跳到 localhost:3000。
 * 这里从已配置的 GBRAIN_SSO_CALLBACK_URL 取 origin，确保跳转始终指向真实
 * 公网地址（如 http://172.29.57.34:3000）。
 */
export function publicOrigin(): string {
  const callback = process.env.GBRAIN_SSO_CALLBACK_URL?.trim()
  if (callback) {
    try {
      return new URL(callback).origin
    } catch {
      // 配置非法 → 落到下面的默认值
    }
  }
  return "http://localhost:3000"
}

/**
 * 校验 PDP 回调：验签 + 解 payload。nonce 的一次性校验由调用方用
 * consumeNonce() 完成（保持本函数纯函数、便于测试）。
 */
export function verifySsoCallback(input: { sso: string; sig: string }): { claims: SsoClaims } {
  const { sso, sig } = input
  const expected = ssoSign(sso)
  const expectedBuf = Buffer.from(expected, "utf8")
  const providedBuf = Buffer.from(sig, "utf8")
  if (expectedBuf.length !== providedBuf.length || !timingSafeEqual(expectedBuf, providedBuf)) {
    throw new Error("bad_sig")
  }
  let decoded: string
  try {
    decoded = Buffer.from(sso, "base64").toString("utf8")
  } catch {
    throw new Error("bad_payload")
  }
  const params = new URLSearchParams(decoded)
  const claims: SsoClaims = {
    nonce: params.get("nonce") ?? "",
    username: params.get("username") ?? "",
    email: params.get("email") ?? undefined,
    fullname: params.get("fullname") ?? undefined,
    id: params.get("id") ?? undefined,
  }
  if (!claims.nonce) throw new Error("missing_nonce")
  if (!claims.username) throw new Error("missing_username")
  return { claims }
}

// ─── nonce 一次性存储（进程内）──────────────────────────────────────────────
// 阶段 1 单实例部署可用；多实例/重启会丢 → 将来挪到 web-state 持久化。
const NONCE_TTL_MS = 5 * 60 * 1000
const pendingNonces = new Map<string, number>()

function sweepExpired(now = Date.now()): void {
  for (const [nonce, expireAt] of pendingNonces) {
    if (expireAt <= now) pendingNonces.delete(nonce)
  }
}

export function rememberNonce(nonce: string): void {
  sweepExpired()
  pendingNonces.set(nonce, Date.now() + NONCE_TTL_MS)
}

/** 消费 nonce：存在且未过期 → true 并删除；否则 false（防重放）。 */
export function consumeNonce(nonce: string): boolean {
  sweepExpired()
  const expireAt = pendingNonces.get(nonce)
  if (expireAt === undefined) return false
  pendingNonces.delete(nonce)
  return expireAt > Date.now()
}

/** 测试用：清空 nonce 存储。 */
export function __resetNoncesForTests(): void {
  pendingNonces.clear()
}
