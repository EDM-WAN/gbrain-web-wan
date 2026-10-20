type CachedToken = {
  key: string
  accessToken: string
  expiresAt: number
}

let cachedToken: CachedToken | null = null
let pendingToken: { key: string; promise: Promise<string> } | null = null

function oauthSettings(): { baseUrl: string; clientId: string; clientSecret: string } | null {
  const clientId = process.env.GBRAIN_OAUTH_CLIENT_ID?.trim() ?? ""
  const clientSecret = process.env.GBRAIN_OAUTH_CLIENT_SECRET?.trim() ?? ""
  if (!clientId && !clientSecret) return null
  if (!clientId || !clientSecret) {
    throw new Error("GBRAIN_OAUTH_CLIENT_ID 和 GBRAIN_OAUTH_CLIENT_SECRET 必须同时配置")
  }
  return {
    baseUrl: process.env.GBRAIN_URL?.trim() || "http://localhost:8787",
    clientId,
    clientSecret,
  }
}

export function hasGBrainOAuthConfig(): boolean {
  // 必须同时配置 ID 与 SECRET 才算 OAuth 模式；只配一个视为未配置，
  // 避免部分配置把 Web 鉴权切到严格模式却又拿不到 access token。
  return Boolean(process.env.GBRAIN_OAUTH_CLIENT_ID?.trim() && process.env.GBRAIN_OAUTH_CLIENT_SECRET?.trim())
}

async function requestAccessToken(settings: NonNullable<ReturnType<typeof oauthSettings>>, key: string): Promise<string> {
  const endpoint = new URL("token", `${settings.baseUrl.replace(/\/+$/, "")}/`)
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: settings.clientId,
    client_secret: settings.clientSecret,
    scope: "read write admin",
  })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: controller.signal,
      cache: "no-store",
    })
    const payload = await response.json().catch(() => null) as {
      access_token?: unknown
      expires_in?: unknown
      error?: unknown
      error_description?: unknown
    } | null
    if (!response.ok || typeof payload?.access_token !== "string" || !payload.access_token) {
      const detail = typeof payload?.error_description === "string"
        ? `: ${payload.error_description.slice(0, 180)}`
        : typeof payload?.error === "string" ? `: ${payload.error}` : ""
      throw new Error(`GBrain OAuth token 请求失败 (HTTP ${response.status})${detail}`)
    }
    const expiresIn = typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in)
      ? Math.max(1, payload.expires_in)
      : 300
    // Renew one minute before expiry, or at 80% of very short tokens.
    const renewEarlySeconds = Math.min(60, Math.floor(expiresIn * 0.2))
    cachedToken = {
      key,
      accessToken: payload.access_token,
      expiresAt: Date.now() + Math.max(1, expiresIn - renewEarlySeconds) * 1000,
    }
    return payload.access_token
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("GBrain OAuth token 请求超时")
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/** Server-only OAuth client-credentials token with in-process caching and renewal. */
export async function getGBrainOAuthToken(): Promise<string | null> {
  const settings = oauthSettings()
  if (!settings) return null
  const key = `${settings.baseUrl}\n${settings.clientId}\n${settings.clientSecret}`
  if (cachedToken?.key === key && cachedToken.expiresAt > Date.now()) return cachedToken.accessToken
  if (pendingToken?.key === key) return pendingToken.promise

  const promise = requestAccessToken(settings, key)
  pendingToken = { key, promise }
  try {
    return await promise
  } finally {
    if (pendingToken?.promise === promise) pendingToken = null
  }
}

/** Test seam: clear only the process-local token cache. */
export function resetGBrainOAuthTokenCacheForTests(): void {
  cachedToken = null
  pendingToken = null
}
