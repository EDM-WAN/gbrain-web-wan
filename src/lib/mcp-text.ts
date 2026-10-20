/**
 * MCP 响应文本解析（纯函数，无 Next.js 依赖，便于单测）
 *
 * 背景：gbrain 0.60 起，MCP 工具返回的 `text` 字段可能是
 *   1) pretty-print 的多行 JSON（含裸换行/制表符），
 *   2) JSON 之后追加若干说明行（如 `Rate after use: rate_answer {...}`）。
 * 这类响应里存在**字符串内的裸控制字符**，直接 JSON.parse 会抛
 * `Bad control character in string literal in JSON at position N`，
 * 于是 web 侧把正常的 200 响应误判为 502。
 *
 * 这里的做法是逐个字符扫描，跟踪"是否位于 JSON 字符串内"：
 *   - 字符串内的裸控制字符 → 转义为 \uXXXX（JSON 规范禁止字符串内出现裸控制符）
 *   - 字符串外的裸控制符 → 归一为空格（结构空白）
 *   - 若整个文档无法解析，则截断到第一个完整的顶层值再试
 * 不改变语义：仅修复非法转义并丢弃尾随的非 JSON 文本。
 */

/** 跟踪字符串状态，转义字符串内的裸控制字符 */
export function repairJsonControlChars(text: string): string {
  let out = ""
  let inString = false
  let escaped = false

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    const code = text.charCodeAt(i)

    if (inString) {
      if (escaped) {
        escaped = false
        out += ch
        continue
      }
      if (ch === "\\") {
        escaped = true
        out += ch
        continue
      }
      if (ch === '"') {
        inString = false
        out += ch
        continue
      }
      if (code < 0x20) {
        // 字符串内的裸控制字符：转义
        out += `\\u${code.toString(16).padStart(4, "0")}`
        continue
      }
      out += ch
      continue
    }

    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (code < 0x20 && ch !== "\n" && ch !== "\r" && ch !== "\t") {
      out += " "
      continue
    }
    out += ch
  }

  return out
}

/**
 * 截断到第一个完整的顶层 JSON 值，丢弃其后的尾随文本。
 * 输入应为已修复控制字符的文本。
 */
export function truncateToCompleteValue(text: string): string {
  const trimmed = text.trimStart()
  const lead = trimmed[0]
  if (lead !== "{" && lead !== "[") return text

  const open = lead
  const close = lead === "{" ? "}" : "]"
  let depth = 0
  let inString = false
  let escaped = false

  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === open) depth += 1
    else if (ch === close) {
      depth -= 1
      if (depth === 0) return trimmed.slice(0, i + 1)
    }
  }
  // 未闭合：返回原文，交给上层报错
  return trimmed
}

/**
 * 容错 JSON.parse：先按原样试，再修控制字符，再截断尾随文本。
 * 全部失败返回 null。
 */
export function parseJsonTolerant<T = unknown>(text: string): T | null {
  const attempts = [
    text,
    repairJsonControlChars(text),
    truncateToCompleteValue(repairJsonControlChars(text)),
  ]
  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate) as T
    } catch {
      // 继续尝试下一种修复
    }
  }
  return null
}

/**
 * 从 MCP HTTP body 中取出 data 载荷。
 * 兼容标准 SSE（可多行 data，取最后一个 data 事件）与纯 JSON body。
 */
export function extractMcpData(raw: string): string {
  // 先按空行切成 SSE 事件；同一事件内的多个 data: 行用换行拼接，
  // 取最后一个带 data 的事件（与原实现一致）。
  let lastEvent: string[] | null = null

  for (const block of raw.split(/\r?\n\r?\n+/)) {
    const dataLines: string[] = []
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""))
    }
    if (dataLines.length > 0) lastEvent = dataLines
  }

  if (lastEvent) return lastEvent.join("\n")
  return raw
}

interface McpEnvelope {
  result?: { isError?: boolean; content?: Array<{ text?: string }> }
  error?: { message?: string }
}

function messageFrom(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object") return null
  const detail = parsed as { error?: unknown; message?: unknown; suggestion?: unknown }
  const message = detail.message || detail.error || detail.suggestion
  if (typeof message === "string" && message.trim()) return message.trim()
  return null
}

/**
 * 解析 gbrain MCP 响应，返回内层工具结果。
 * 内层不是 JSON 时按纯文本返回（0.60 起部分结果会追加说明行）。
 */
export function parseMcpText(raw: string): unknown {
  const data = extractMcpData(raw)
  const envelope = parseJsonTolerant<McpEnvelope>(data)
  if (envelope === null) {
    throw new Error(`GBrain MCP 返回格式无效: ${data.slice(0, 200)}`)
  }
  if (envelope.error) throw new Error(envelope.error.message || "GBrain MCP 请求失败")

  const text = envelope.result?.content?.[0]?.text
  if (typeof text !== "string" || text.length === 0) throw new Error("GBrain MCP 返回为空")

  const parsed = parseJsonTolerant(text)
  if (parsed === null) {
    // 非 JSON 的纯文本结果：原样返回，避免把正常响应误判为失败
    if (envelope.result?.isError) throw new Error(text.slice(0, 300))
    return text
  }

  if (envelope.result?.isError) {
    throw new Error(messageFrom(parsed)?.slice(0, 300) || "GBrain MCP 操作失败")
  }
  const errorMessage = messageFrom(parsed)
  if (errorMessage && parsed && typeof parsed === "object" && "error" in parsed) {
    throw new Error(errorMessage.slice(0, 300))
  }
  return parsed
}
