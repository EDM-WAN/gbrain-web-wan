import { cookies } from "next/headers"
import { getGBrainOAuthToken, hasGBrainOAuthConfig } from "./gbrain-oauth"
import { getCurrentUser } from "./web-session.ts"
import { apiKeyFromRequest, resolveApiKeyUserId } from "./api-keys.ts"
import { parseMcpText } from "./mcp-text.ts"

export { parseMcpText }

async function cookieToken(): Promise<string | null> {
  return (await cookies()).get("gbrain_token")?.value ?? null
}

async function legacyToken(): Promise<string | null> {
  const cookie = await cookieToken()
  const env = process.env.NODE_ENV !== "production" ? process.env.GBRAIN_TOKEN?.trim() : undefined
  return cookie || env || null
}

function configuredWebAccessToken(): string | undefined {
  return process.env.GBRAIN_WEB_ACCESS_TOKEN?.trim() || process.env.GBRAIN_TOKEN?.trim() || undefined
}

/** Browser/API credential is distinct from the upstream OAuth client secret. */
export function isGBrainBrowserToken(token: string | undefined): boolean {
  if (!token) return false
  if (hasGBrainOAuthConfig()) return token === configuredWebAccessToken()
  const env = process.env.NODE_ENV !== "production" ? process.env.GBRAIN_TOKEN?.trim() : undefined
  return token === env || Boolean(token)
}

export async function hasGBrainBrowserToken(): Promise<boolean> {
  if (isGBrainBrowserToken(await cookieToken() ?? undefined)) return true
  const env = process.env.NODE_ENV !== "production" ? process.env.GBRAIN_TOKEN?.trim() : undefined
  return !hasGBrainOAuthConfig() && Boolean(env)
}

export async function getGBrainWebRequestToken(request: Request): Promise<string | null> {
  // 阶段 1/方案 A：有效身份 = 用户会话 cookie **或** API key（gbk-…）。
  // 任一存在即视为已认证请求（限权在各自 API 用 requireUser/canManageSource 做）。
  // 上游 gbrain token 由 getGBrainServerToken() 负责，这里返回它即可。
  const apiKey = apiKeyFromRequest(request)
  const hasApiKey = apiKey !== null && (await resolveApiKeyUserId(apiKey)) !== null
  if ((await getCurrentUser(request)) || hasApiKey) {
    try {
      return await getGBrainServerToken()
    } catch {
      // 身份有效但上游 token 暂不可得（如 OAuth 未配置）→ 落到下面的旧路径兜底。
    }
  }
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
  const candidate = bearer || await cookieToken() || undefined
  if (isGBrainBrowserToken(candidate)) return candidate!
  if (!hasGBrainOAuthConfig() && process.env.NODE_ENV !== "production") return process.env.GBRAIN_TOKEN?.trim() || null
  return null
}

export async function getGBrainUploadRequestToken(request: Request): Promise<string | null> {
  return getGBrainWebRequestToken(request)
}

export async function requireGBrainBrowserRequestToken(request: Request): Promise<boolean> {
  return Boolean(await getGBrainWebRequestToken(request))
}

export async function getGBrainServerToken(): Promise<string> {
  if (hasGBrainOAuthConfig()) {
    const token = await getGBrainOAuthToken()
    if (token) return token
  }
  const token = await legacyToken()
  if (!token) throw new Error("请在 Settings 配置 GBrain token")
  return token
}

// 浏览器/API 层的鉴权闸门：只认“有效的 Web access token”。
// 绝不能因为配置了 OAuth client 就放行——OAuth 凭据只用于 Web 后端
// 访问 GBrain 的上游身份，浏览器请求必须单独持有 GBRAIN_WEB_ACCESS_TOKEN。
export async function hasGBrainServerAuth(): Promise<boolean> {
  return hasGBrainBrowserToken()
}

/**
 * 会话感知的鉴权（Memory Library 等前端读通道用）：已登录用户会话 **或**
 * API key **或** 全局 token，任一有效即放行。与 getGBrainWebRequestToken 一致，
 * 让"新用户登录后零配置即可用"成立。
 */
export async function hasGBrainServerAuthForRequest(request: Request): Promise<boolean> {
  if (await getCurrentUser(request)) return true
  const apiKey = apiKeyFromRequest(request)
  if (apiKey !== null && (await resolveApiKeyUserId(apiKey)) !== null) return true
  return hasGBrainBrowserToken()
}

/** 每次调用可选的收窄参数。 */
export interface GBrainCallOptions {
  /**
   * 收窄本次读取的 source 范围（narrow-only，见 gbrain `mcp/request-scope.ts`）。
   *
   * gbrain 的读权限按 **OAuth client** 判定，而本部署所有浏览器会话共用同一个
   * 服务端 client —— 不传这个头时，gbrain 会按 client 的整个 `federated_read`
   * 授权展开，跨用户返回内容。传入当前用户可见的 source id 集合后，gbrain 侧
   * 的读取（含 `think` 这类合成 op）就会收敛到该集合。
   *
   * 只能收窄：gbrain 会与授权集求交，越权项被忽略；全部越权则 fail-closed 到
   * 「什么都读不到」。写权限（sourceId）不受影响。
   */
  scopeSourceIds?: readonly string[]
}

export async function callGBrainServer(
  name: string,
  arguments_: Record<string, unknown> = {},
  options: GBrainCallOptions = {},
): Promise<unknown> {
  const base = process.env.GBRAIN_URL || "http://localhost:8787"
  const oauthConfigured = hasGBrainOAuthConfig()
  const cookie = oauthConfigured ? null : await cookieToken()
  const envToken = !oauthConfigured && process.env.NODE_ENV !== "production" ? process.env.GBRAIN_TOKEN?.trim() : undefined
  const tokens = oauthConfigured
    ? [await getGBrainOAuthToken()].filter((value): value is string => Boolean(value))
    : cookie && envToken && cookie !== envToken
      ? [cookie, envToken]
      : [cookie || envToken].filter((value): value is string => Boolean(value))
  if (tokens.length === 0) throw new Error("请先在 Settings 配置 GBrain token")

  for (let index = 0; index < tokens.length; index += 1) {
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokens[index]}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(options.scopeSourceIds && options.scopeSourceIds.length > 0
          ? { "X-Gbrain-Source-Scope": options.scopeSourceIds.join(",") }
          : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: { name, arguments: arguments_ },
      }),
      cache: "no-store",
    })
    const text = await response.text()
    if (response.ok) return parseMcpText(text)
    if (response.status === 401 && index < tokens.length - 1) continue
    throw new Error(`GBrain MCP ${response.status}: ${text.slice(0, 300)}`)
  }
  throw new Error("GBrain MCP authentication failed")
}

/** Call the configured GBrain MCP endpoint using a server-only bearer token. */
export async function callGBrainServerWithToken(
  name: string,
  arguments_: Record<string, unknown>,
  token: string,
): Promise<unknown> {
  const base = process.env.GBRAIN_URL || "http://localhost:8787"
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name, arguments: arguments_ },
    }),
    cache: "no-store",
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`GBrain MCP ${response.status}: ${text.slice(0, 300)}`)
  return parseMcpText(text)
}
