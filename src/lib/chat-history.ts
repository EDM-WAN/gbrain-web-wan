import type { ThinkResult } from "@/lib/gbrain"

export interface StoredChatMessage {
  id: number
  question: string
  sourceId: string
  createdAt: string
  status?: "pending" | "completed" | "failed"
  result?: ThinkResult
  error?: string
  /** Bounded in-progress answer used by the streaming UI; final result replaces it. */
  draftAnswer?: string
  /** Transient streaming/job metadata; not required by legacy stored sessions. */
  job?: {
    id?: string
    status: "queued" | "running" | "completed" | "failed" | "cancelled"
    startedAt?: string
    finishedAt?: string
    retrieval?: { pages?: number; takes?: number; graph?: number }
  }
}

export interface StoredChatSession {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messages: StoredChatMessage[]
}

const CHAT_HISTORY_KEY = "gbrain-web-chat-history-v1"
const CHAT_SESSIONS_KEY = "gbrain-web-chat-sessions-v2"
const CHAT_HISTORY_EVENT = "gbrain-chat-history-changed"
const MAX_CHAT_MESSAGES = 50
const MAX_CHAT_SESSIONS = 30

function isStoredChatMessage(value: unknown): value is StoredChatMessage {
  if (!value || typeof value !== "object") return false
  const message = value as Partial<StoredChatMessage>
  return typeof message.id === "number" && typeof message.question === "string"
}

function normalizeMessages(value: unknown): StoredChatMessage[] {
  if (!Array.isArray(value)) return []
  return value
    .filter(isStoredChatMessage)
    .map((message) => ({
      ...message,
      sourceId: typeof message.sourceId === "string" ? message.sourceId : "__all__",
      createdAt: typeof message.createdAt === "string" ? message.createdAt : new Date().toISOString(),
    }))
    .slice(-MAX_CHAT_MESSAGES)
}

function isStoredChatSession(value: unknown): value is StoredChatSession {
  if (!value || typeof value !== "object") return false
  const session = value as Partial<StoredChatSession>
  return typeof session.id === "string"
    && typeof session.title === "string"
    && typeof session.createdAt === "string"
    && typeof session.updatedAt === "string"
    && Array.isArray(session.messages)
}

function normalizeSessions(value: unknown): StoredChatSession[] {
  if (!Array.isArray(value)) return []
  return value
    .filter(isStoredChatSession)
    .map((session) => ({
      ...session,
      messages: normalizeMessages(session.messages),
    }))
    .filter((session) => session.messages.length > 0)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, MAX_CHAT_SESSIONS)
}

function emitHistoryChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CHAT_HISTORY_EVENT))
}

function writeSessions(sessions: StoredChatSession[]): void {
  if (typeof window === "undefined") return
  // 每个消息存完整 result（answer+citations），大量长会话很容易顶满
  // localStorage 配额。配额满时 setItem 抛 QuotaExceededError，若不做降级，
  // 删除/新建会话的持久化会静默失败——表现为“删了没反应（刷新又回来）”。
  // 这里降级：去掉每个结果里的 answer/citations 大字段（保留轻量元数据），
  // 仍满则移除最旧会话后重试一次。
  const serialize = (list: StoredChatSession[]) => JSON.stringify(normalizeSessions(list))
  const slim = (list: StoredChatSession[]): StoredChatSession[] => list.map((session) => ({
    ...session,
    messages: session.messages.map((message) => ({
      ...message,
      ...(message.result
        ? { result: { ...message.result, answer: (message.result.answer || "").slice(0, 4000), gaps: (message.result.gaps ?? []).slice(0, 5) } }
        : {}),
    })),
  }))
  try {
    window.localStorage.setItem(CHAT_SESSIONS_KEY, serialize(sessions))
    return
  } catch {
    // Fall through to slim retry: drop big answer/gaps per message.
  }
  try {
    window.localStorage.setItem(CHAT_SESSIONS_KEY, serialize(slim(sessions)))
    return
  } catch {
    // Still full — drop the oldest sessions (bounded) so the write succeeds
    // instead of every future edit throwing in the caller's face.
    const bounded = normalizeSessions(sessions).slice(-8)
    window.localStorage.setItem(CHAT_SESSIONS_KEY, serialize(slim(bounded)))
  }
}

/**
 * Read the session format and migrate the previous single-message-list format
 * into one session without discarding existing browser history.
 */
export function loadChatSessions(): StoredChatSession[] {
  if (typeof window === "undefined") return []
  try {
    const current = JSON.parse(window.localStorage.getItem(CHAT_SESSIONS_KEY) || "null")
    if (Array.isArray(current)) return normalizeSessions(current)

    const legacy = JSON.parse(window.localStorage.getItem(CHAT_HISTORY_KEY) || "[]")
    const messages = normalizeMessages(legacy)
    if (messages.length === 0) return []

    const now = new Date().toISOString()
    const migrated: StoredChatSession = {
      id: "migrated-chat-history",
      title: messages[0].question.slice(0, 36),
      createdAt: messages[0].createdAt || now,
      updatedAt: messages[messages.length - 1].createdAt || now,
      messages,
    }
    writeSessions([migrated])
    return [migrated]
  } catch {
    return []
  }
}

export function saveChatSessions(sessions: StoredChatSession[]): void {
  writeSessions(sessions)
  emitHistoryChanged()
}

export function clearChatSessions(): void {
  if (typeof window === "undefined") return
  window.localStorage.removeItem(CHAT_SESSIONS_KEY)
  window.localStorage.removeItem(CHAT_HISTORY_KEY)
  emitHistoryChanged()
}

// Kept for callers or data from the original single-conversation MVP.
export function loadChatHistory(): StoredChatMessage[] {
  return loadChatSessions().flatMap((session) => session.messages).slice(-MAX_CHAT_MESSAGES)
}

export function saveChatHistory(messages: StoredChatMessage[]): void {
  const current = loadChatSessions()
  const now = new Date().toISOString()
  const session: StoredChatSession = {
    id: "legacy-chat-history",
    title: messages[0]?.question.slice(0, 36) || "新会话",
    createdAt: messages[0]?.createdAt || now,
    updatedAt: messages[messages.length - 1]?.createdAt || now,
    messages: messages.slice(-MAX_CHAT_MESSAGES),
  }
  saveChatSessions([...current.filter((item) => item.id !== session.id), session])
}

export function clearChatHistory(): void {
  clearChatSessions()
}

export function chatHistoryEventName(): string {
  return CHAT_HISTORY_EVENT
}

export const chatHistoryLimits = {
  maxMessages: MAX_CHAT_MESSAGES,
  maxSessions: MAX_CHAT_SESSIONS,
}
