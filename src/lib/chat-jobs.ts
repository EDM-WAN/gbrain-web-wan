import { cancelThinkStreamJob, getThinkStreamJob, thinkStream, type ThinkOptions } from "@/lib/gbrain"
import { chatHistoryEventName, loadChatSessions, saveChatSessions, type StoredChatMessage } from "@/lib/chat-history"

const activeJobs = new Map<number, { task: Promise<void>; controller: AbortController }>()

function updateMessage(messageId: number, update: (message: StoredChatMessage) => StoredChatMessage): void {
  const sessions = loadChatSessions()
  let changed = false
  const next = sessions.map((session) => {
    const messages = session.messages.map((message) => {
      if (message.id !== messageId) return message
      changed = true
      return update(message)
    })
    return changed ? { ...session, messages, updatedAt: new Date().toISOString() } : session
  })
  if (changed) saveChatSessions(next)
}

function updateJob(messageId: number, job: NonNullable<StoredChatMessage["job"]>): void {
  updateMessage(messageId, (message) => ({ ...message, job }))
}

export function hasActiveChatJob(messageId: number): boolean { return activeJobs.has(messageId) }

export function cancelChatJob(messageId: number): boolean {
  const active = activeJobs.get(messageId)
  if (!active) return false
  active.controller.abort()
  updateJob(messageId, { status: "cancelled", finishedAt: new Date().toISOString() })
  void findJobId(messageId).then((jobId) => jobId ? cancelThinkStreamJob(jobId).catch(() => undefined) : undefined)
  return true
}

async function findJobId(messageId: number): Promise<string | undefined> {
  const session = loadChatSessions().flatMap((item) => item.messages).find((item) => item.id === messageId)
  return session?.job?.id
}

export async function recoverChatJob(messageId: number): Promise<boolean> {
  const jobId = await findJobId(messageId)
  if (!jobId) return false
  try {
    const job = await getThinkStreamJob(jobId)
    const status = String(job.status || "")
    const partial = typeof job.partial_answer === "string" ? job.partial_answer : undefined
    if (status === "completed" && job.final_result && typeof job.final_result === "object") {
      updateMessage(messageId, (message) => ({ ...message, status: "completed", result: job.final_result as any, draftAnswer: undefined, job: { ...message.job, status: "completed" } }))
      return true
    }
    if (status === "cancelled" || status === "failed") {
      updateMessage(messageId, (message) => ({ ...message, status: "failed", draftAnswer: partial || message.draftAnswer, error: status === "cancelled" ? "已停止生成" : message.error, job: { ...message.job, status: status as "cancelled" | "failed" } }))
      return true
    }
    if (partial) updateMessage(messageId, (message) => ({ ...message, draftAnswer: partial, job: { ...message.job, status: "running" } }))
  } catch {
    return false
  }
  return false
}

/** Start a browser-session stream job with cancellation and bounded draft persistence. */
export function startChatJob(messageId: number, options: ThinkOptions): boolean {
  if (activeJobs.has(messageId)) return false
  const controller = new AbortController()
  updateMessage(messageId, (message) => ({ ...message, status: "pending", error: undefined, result: undefined, draftAnswer: undefined, job: { status: "queued", startedAt: new Date().toISOString() } }))
  const task = Promise.resolve().then(async () => {
    updateJob(messageId, { status: "running", startedAt: new Date().toISOString() })
    let lastPersist = 0
    let draft = ""
    const persistDraft = () => {
      const now = Date.now()
      if (now - lastPersist < 200) return
      lastPersist = now
      updateMessage(messageId, (message) => ({ ...message, draftAnswer: draft.slice(-12000) }))
    }
    await thinkStream(options, {
      onStart: (data) => data.job_id && updateJob(messageId, { id: data.job_id, status: "running", startedAt: new Date().toISOString() }),
      onRetrieval: (data) => updateJob(messageId, { status: "running", startedAt: new Date().toISOString(), retrieval: { pages: data.pages, takes: data.takes, graph: data.graph } }),
      onDone: (data) => updateMessage(messageId, (message) => ({ ...message, status: "completed", result: data.result, draftAnswer: undefined, error: undefined, job: { ...message.job, status: "completed", finishedAt: new Date().toISOString(), retrieval: { pages: data.result.pagesGathered, takes: data.result.takesGathered, graph: data.result.graphHits } } })),
      onCancelled: (data) => updateMessage(messageId, (message) => ({ ...message, status: "failed", draftAnswer: data.partial_answer || draft || message.draftAnswer, error: "已停止生成", job: { ...message.job, status: "cancelled", finishedAt: new Date().toISOString() } })),
      onError: (data) => { throw new Error(data.message || "GBrain stream failed") },
      onDelta: (data) => { draft += data.text || ""; persistDraft() },
    }, controller.signal)
  }).catch((error: unknown) => {
    if (controller.signal.aborted) {
      updateMessage(messageId, (message) => ({ ...message, status: "failed", error: "已停止生成", job: { ...message.job, status: "cancelled", finishedAt: new Date().toISOString() } }))
    } else {
      updateMessage(messageId, (message) => ({ ...message, status: "failed", error: error instanceof Error ? error.message : "GBrain 请求失败，请稍后重试。", result: undefined, job: { ...message.job, status: "failed", finishedAt: new Date().toISOString() } }))
    }
  }).finally(() => {
    activeJobs.delete(messageId)
    if (typeof window !== "undefined") window.dispatchEvent(new Event(chatHistoryEventName()))
  })
  activeJobs.set(messageId, { task, controller })
  return true
}
