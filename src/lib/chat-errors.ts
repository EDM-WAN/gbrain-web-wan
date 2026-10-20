function cleanText(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/\\n/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function extractJsonMessage(value: string): string | null {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== "object") return null
    const record = parsed as Record<string, unknown>
    for (const key of ["error", "message", "detail"]) {
      if (typeof record[key] === "string" && record[key].trim()) return record[key].trim()
    }
  } catch {
    // The response is not JSON; use the status-specific fallback.
  }
  return null
}

export function summarizeMCPError(status: number, body?: string): string {
  if (status === 401) return "GBrain Token 无效或已过期，请到 Settings 重新设置 Token。"
  if (status === 403) return "当前 Token 没有执行此操作的权限。"
  if (status === 404) return "GBrain MCP 接口不可用，请确认 gbrain serve 已启动。"
  if (status === 408 || status === 504) return "GBrain 响应超时，请稍后重试。"

  const detail = body ? extractJsonMessage(body) : null
  const cleaned = detail ? cleanText(detail) : ""
  if (cleaned && !cleaned.includes("<!DOCTYPE") && !cleaned.includes("_next/")) {
    return cleaned.slice(0, 180)
  }
  return `GBrain 请求失败（HTTP ${status}），请稍后重试。`
}

export function summarizeNetworkError(error: unknown): string {
  if (error instanceof TypeError) return "无法连接 GBrain 服务，请确认 8788 端口正在运行。"
  return "GBrain 请求失败，请稍后重试。"
}
