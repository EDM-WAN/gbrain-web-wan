"use client"

import { FormEvent, memo, useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { Header } from "@/components/layout/Header"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { listSources } from "@/lib/gbrain"
import { cancelChatJob, recoverChatJob, startChatJob } from "@/lib/chat-jobs"
import {
  chatHistoryEventName,
  clearChatSessions,
  loadChatSessions,
  saveChatSessions,
  type StoredChatMessage,
  type StoredChatSession,
} from "@/lib/chat-history"
import type { GBrainSource } from "@/types/gbrain"
import {
  AlertCircle,
  Brain,
  ChevronDown,
  Clock3,
  ExternalLink,
  Loader2,
  MessageSquare,
  Plus,
  Send,
  Sparkles,
  Trash2,
} from "lucide-react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

type ChatMessage = StoredChatMessage

/**
 * Turn the server's `synthesis_status` into text an operator can act on. The
 * status is the difference between "the model returned nothing useful" and
 * "the request never reached the model" — the two have completely different
 * fixes, and the raw code alone does not say which happened.
 */
function describeSynthesisFailure(status: string | undefined, warnings: string[]): string {
  const detail = warnings.filter(w => w.startsWith('SYNTHESIS_') || w.startsWith('LLM_')).join('、')
  const suffix = detail ? `（${detail}）` : ""
  switch (status) {
    case "llm_error":
      return `模型调用失败，未生成回答${suffix}。请检查配置的模型名与 API 凭据。`
    case "empty_answer":
      return `模型返回了空回答${suffix}。`
    case "not_json":
      return `模型输出无法解析为结构化回答${suffix}。`
    case "output_truncated":
      return `模型输出被长度上限截断${suffix}。`
    default:
      return `未生成回答${status ? `（${status}）` : ""}${suffix}。`
  }
}

function formatCitationLabel(slug: string): string {
  return slug.split("/").pop() || slug
}

function formatSessionDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "刚刚"
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(date)
}

function createSession(question: string, message: ChatMessage): StoredChatSession {
  return {
    id: `chat-${Date.now()}`,
    title: question.replace(/\s+/g, " ").slice(0, 36),
    createdAt: message.createdAt,
    updatedAt: message.createdAt,
    messages: [message],
  }
}

const ChatMessageItem = memo(function ChatMessageItem({ message }: { message: ChatMessage }) {
  return (
    <section className="space-y-3">
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-4 py-3 text-sm text-primary-foreground">{message.question}</div>
      </div>
      {message.status === "pending" && !message.result && (
        <div className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-3 text-sm text-muted-foreground">
          <div className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />后台生成中</div>
          {message.draftAnswer && <div className="prose prose-sm mt-3 max-w-none dark:prose-invert whitespace-pre-wrap">{message.draftAnswer}</div>}
        </div>
      )}
      {message.result && (
        <Card><CardContent className="space-y-5 p-5">
          <div className="flex items-center gap-2 text-sm font-medium"><MessageSquare className="h-4 w-4 text-primary" />GBrain 回答</div>
          {message.result.answer
            ? <div className="prose prose-sm max-w-none dark:prose-invert"><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.result.answer}</ReactMarkdown></div>
            : (
              // Degraded synthesis. The server leaves `answer` empty and attaches
              // `extractive` excerpts instead; surfacing only "no answer" hid both
              // the retrieved pages and the reason. Name the status so the failure
              // is diagnosable from the UI, then show the extractive material.
              <div className="space-y-3">
                <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{describeSynthesisFailure(message.result.synthesis_status, message.result.warnings)}</span>
                </div>
                {message.result.extractive?.answer
                  ? <div className="prose prose-sm max-w-none dark:prose-invert"><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.result.extractive.answer}</ReactMarkdown></div>
                  : <p className="text-sm text-muted-foreground">没有可用的兜底内容（本次检索没有命中的页面）。</p>}
              </div>
            )}
          {message.result.citations.length > 0 && <div className="border-t pt-4"><h3 className="mb-2 text-sm font-medium">引用来源</h3><div className="flex flex-wrap gap-2">{message.result.citations.map((citation, index) => <Link key={`${citation.page_slug}-${index}`} href={`/memory/${encodeURIComponent(citation.page_slug)}${message.sourceId !== "__all__" ? `?source_id=${encodeURIComponent(message.sourceId)}` : ""}`} className="inline-flex items-center gap-1 rounded-md bg-muted px-2.5 py-1.5 text-xs"><ExternalLink className="h-3 w-3" />[{citation.citation_index ?? index + 1}] {formatCitationLabel(citation.page_slug)}</Link>)}</div></div>}
          {message.result.gaps.length > 0 && <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm"><h3 className="mb-2 flex items-center gap-2 font-medium"><AlertCircle className="h-4 w-4" />GBrain 认为还缺少</h3><ul className="list-disc space-y-1 pl-5">{message.result.gaps.map((gap, index) => <li key={`${gap}-${index}`}>{gap}</li>)}</ul></div>}
          <div className="flex flex-wrap items-center gap-x-4 border-t pt-3 text-xs text-muted-foreground"><span>{message.result.modelUsed}</span><span>检索 {message.result.pagesGathered} 页</span><span>图谱命中 {message.result.graphHits}</span></div>
        </CardContent></Card>
      )}
      {message.error && <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"><AlertCircle className="h-4 w-4 shrink-0" /><span>{message.error}</span></div>}
    </section>
  )
})

ChatMessageItem.displayName = "ChatMessageItem"

export default function ChatPage() {
  const [question, setQuestion] = useState("")
  const [anchor, setAnchor] = useState("")
  const [since, setSince] = useState("")
  const [until, setUntil] = useState("")
  const [rounds, setRounds] = useState("1")
  const [showOptions, setShowOptions] = useState(false)
  const [sources, setSources] = useState<GBrainSource[]>([])
  const [selectedSource, setSelectedSource] = useState("__all__")
  const [sessions, setSessions] = useState<StoredChatSession[]>([])
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)
  const [openSessionMenuId, setOpenSessionMenuId] = useState<string | null>(null)
  const [deleteCandidateId, setDeleteCandidateId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isThinking, setIsThinking] = useState(false)
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const scrollModeRef = useRef<"auto" | "smooth">("auto")

  const currentSession = useMemo(
    () => sessions.find((session) => session.id === currentSessionId) ?? null,
    [sessions, currentSessionId],
  )
  const recentContext = useMemo(() => {
    if (!currentSession) return ''
    // Keep conversational continuity within the selected source only. Retrieval
    // is source-scoped separately, but conversation_context is still shown to
    // the synthesizer; carrying a previous source's answer into this prompt can
    // make a source-specific answer cite or summarize unrelated content.
    const scopedMessages = currentSession.messages.filter((message) => message.sourceId === selectedSource)
    const lines = scopedMessages.slice(-4).flatMap((message) => {
      const source = message.sourceId && message.sourceId !== "__all__"
        ? ` [source=${message.sourceId}]`
        : ""
      const answer = message.result?.answer?.trim()
      return [
        `用户${source}：${message.question}`,
        ...(answer ? [`GBrain：${answer.slice(0, 1800)}`] : []),
      ]
    })
    return lines.join("\n").slice(-8000)
  }, [currentSession, selectedSource])
  const messages = currentSession?.messages ?? []

  useEffect(() => {
    const loaded = loadChatSessions()
    setSessions(loaded)
    setCurrentSessionId(loaded[0]?.id ?? null)
    for (const message of loaded.flatMap((session) => session.messages)) {
      if (message.status === "pending" && message.job?.id) void recoverChatJob(message.id)
    }

    const onHistoryChanged = () => {
      const next = loadChatSessions()
      setSessions(next)
      setCurrentSessionId((id) => id && next.some((session) => session.id === id) ? id : next[0]?.id ?? null)
    }
    window.addEventListener(chatHistoryEventName(), onHistoryChanged)
    window.addEventListener("storage", onHistoryChanged)
    return () => {
      window.removeEventListener(chatHistoryEventName(), onHistoryChanged)
      window.removeEventListener("storage", onHistoryChanged)
    }
  }, [])

  useEffect(() => {
    if (messages.length === 0) return
    const frame = window.requestAnimationFrame(() => {
      bottomRef.current?.scrollIntoView({ behavior: scrollModeRef.current, block: "end" })
      scrollModeRef.current = "auto"
    })
    return () => window.cancelAnimationFrame(frame)
  }, [currentSessionId, messages.length, messages.at(-1)?.status, messages.at(-1)?.result?.answer])

  useEffect(() => {
    if (!openSessionMenuId) return
    const closeOnPointerDown = () => setOpenSessionMenuId(null)
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenSessionMenuId(null)
    }
    document.addEventListener("pointerdown", closeOnPointerDown)
    document.addEventListener("keydown", closeOnEscape)
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown)
      document.removeEventListener("keydown", closeOnEscape)
    }
  }, [openSessionMenuId])

  useEffect(() => {
    let active = true
    void listSources().then((items) => {
      if (active) setSources(items)
    }).catch((err) => {
      console.error("Failed to load chat sources:", err)
    })
    return () => { active = false }
  }, [])

  const persist = (next: StoredChatSession[]) => {
    setSessions(next)
    saveChatSessions(next)
  }

  const updateSession = (sessionId: string, update: (session: StoredChatSession) => StoredChatSession) => {
    const next = sessions.map((session) => session.id === sessionId ? update(session) : session)
    persist(next)
  }

  const handleSubmit = async (event?: FormEvent) => {
    event?.preventDefault()
    const trimmedQuestion = question.trim()
    if (!trimmedQuestion || isThinking) return

    const messageId = Date.now()
    const createdAt = new Date().toISOString()
    const pendingMessage: ChatMessage = {
      id: messageId,
      question: trimmedQuestion,
      sourceId: selectedSource,
      createdAt,
    }
    const session = currentSession ?? createSession(trimmedQuestion, pendingMessage)
    const sessionId = session.id
    const nextSession: StoredChatSession = currentSession
      ? { ...session, updatedAt: createdAt, messages: [...session.messages, pendingMessage] }
      : session
    const nextSessions = [nextSession, ...sessions.filter((item) => item.id !== sessionId)]

    scrollModeRef.current = "smooth"
    setCurrentSessionId(sessionId)
    persist(nextSessions.map((item) => item.id === sessionId
      ? { ...item, messages: item.messages.map((message) => message.id === messageId ? { ...message, status: "pending" as const } : message) }
      : item))
    setQuestion("")
    setIsThinking(true)

    // 后台任务放进 try/finally：即使 startChatJob 或它内部的 localStorage
    // 写入抛异常，也要保证 isThinking 复位。否则 isThinking 一旦卡 true，
    // 所有删除/新建/发送按钮都会变成 disabled → “点击删除没反应”。
    try {
      startChatJob(messageId, {
        question: trimmedQuestion,
        retrieval_query: trimmedQuestion,
        ...(recentContext && session.messages.length > 0 ? { conversation_context: recentContext } : {}),
        ...(anchor.trim() ? { anchor: anchor.trim() } : {}),
        ...(since ? { since } : {}),
        ...(until ? { until } : {}),
        rounds: Math.max(1, Number.parseInt(rounds, 10) || 1),
        ...(selectedSource !== "__all__" ? { source_id: selectedSource } : {}),
      })
    } catch (error) {
      // localStorage 异常（隐私模式/配额满）会从 startChatJob 内部抛出；
      // 落到这里时在会话区给出可见错误，而不是静默让按钮变 disabled。
      console.error("Failed to start chat job:", error)
      setError("启动对话失败：本地存储不可用。请清理浏览器站点数据后重试。")
    }
    // The coordinator persists completion/error even if this Chat component
    // unmounts while the user visits Memory Library or Knowledge Graph.
    setIsThinking(false)
  }

  const startNewSession = () => {
    if (isThinking) return
    setCurrentSessionId(null)
    setQuestion("")
  }

  const requestDeleteSession = (session: StoredChatSession) => {
    setDeleteCandidateId(session.id)
  }

  const deleteSession = (session: StoredChatSession) => {
    const remaining = sessions.filter((item) => item.id !== session.id)
    persist(remaining)
    if (currentSessionId === session.id) setCurrentSessionId(remaining[0]?.id ?? null)
    setDeleteCandidateId(null)
  }

  const clearAllSessions = () => {
    if (isThinking || sessions.length === 0) return
    if (!window.confirm("确定清空全部会话记录吗？此操作会删除所有会话。")) return
    clearChatSessions()
    setSessions([])
    setCurrentSessionId(null)
    setOpenSessionMenuId(null)
  }

  return (
    <div className="min-h-screen">
      <Header
        title="与 GBrain 对话"
        description="使用 think 进行带引用的综合检索和 Gap 分析"
        action={
          <Button variant="outline" size="sm" onClick={clearAllSessions} disabled={sessions.length === 0 || isThinking} className="gap-1.5">
            <Trash2 className="h-4 w-4" />
            清空全部会话
          </Button>
        }
      />

      {error && (
        <div className="flex items-center gap-2 border-b border-destructive/30 bg-destructive/5 px-6 py-2.5 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} className="ml-auto text-xs underline">关闭</button>
        </div>
      )}

      <div className="box-border flex min-h-[calc(100vh-4rem)] gap-4 overflow-visible p-4 sm:p-6 md:h-[calc(100vh-4rem)] md:min-h-0 md:overflow-hidden">
        <aside className="flex w-64 shrink-0 flex-col rounded-xl border border-border bg-card p-3 shadow-sm max-md:w-48 md:h-full md:min-h-0">
          <div className="mb-3 flex items-center justify-between px-1">
            <div>
              <h2 className="text-sm font-semibold">会话</h2>
              <p className="text-xs text-muted-foreground">{sessions.length} 个会话</p>
            </div>
            <Button variant="ghost" size="icon" onClick={startNewSession} disabled={isThinking} title="新建会话" aria-label="新建会话">
              <Plus className="h-4 w-4" />
            </Button>
          </div>
          <Button variant="outline" size="sm" onClick={startNewSession} disabled={isThinking} className="mb-3 w-full justify-start gap-2">
            <Plus className="h-4 w-4" />
            新建会话
          </Button>
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto overscroll-contain">
            {sessions.length === 0 ? (
              <p className="px-2 py-6 text-center text-xs text-muted-foreground">发送第一条消息后，会话会显示在这里</p>
            ) : sessions.map((session) => (
              <div
                key={session.id}
                className={`group relative rounded-lg transition-colors ${session.id === currentSessionId ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
              >
                <button
                  type="button"
                  disabled={isThinking}
                  onClick={() => {
                    setCurrentSessionId(session.id)
                    setOpenSessionMenuId(null)
                  }}
                  className="w-full rounded-lg px-3 py-2 pr-10 text-left transition-colors disabled:cursor-not-allowed"
                >
                  <p className="truncate text-sm font-medium">{session.title || "未命名会话"}</p>
                  <p className={`mt-1 text-xs ${session.id === currentSessionId ? "text-primary-foreground/75" : "text-muted-foreground"}`}>
                    {formatSessionDate(session.updatedAt)} · {session.messages.length} 条
                  </p>
                </button>
                <button
                  type="button"
                  aria-label={`删除会话：${session.title || "未命名会话"}`}
                  title="删除会话"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    // Use a direct, always-addressable button instead of a
                    // hover-only nested menu. The previous menu depended on
                    // pointerdown/click ordering and could disappear before
                    // the delete click reached window.confirm.
                    event.preventDefault()
                    event.stopPropagation()
                    requestDeleteSession(session)
                  }}
                  className={`absolute right-1 top-1/2 z-20 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 focus:opacity-100 ${session.id === currentSessionId ? "text-primary-foreground hover:bg-primary-foreground/15" : "text-muted-foreground hover:bg-background/80 hover:text-destructive"}`}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
                {deleteCandidateId === session.id && (
                  <div role="alertdialog" aria-label="确认删除会话" className="absolute right-1 top-full z-30 mt-1 w-56 rounded-md border border-destructive/30 bg-popover p-3 text-popover-foreground shadow-lg">
                    <p className="text-xs">确定删除“{session.title || "未命名会话"}”吗？</p>
                    <div className="mt-2 flex justify-end gap-2">
                      <Button type="button" variant="outline" size="sm" onClick={() => setDeleteCandidateId(null)}>取消</Button>
                      <Button type="button" variant="destructive" size="sm" onClick={() => deleteSession(session)}>确认删除</Button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col md:h-full md:min-h-0">
          {messages.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center rounded-xl border border-dashed border-border px-4 py-16 text-center">
              <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
                <Brain className="h-8 w-8" />
              </div>
              <h2 className="text-2xl font-semibold">问问你的 GBrain</h2>
              <p className="mt-2 max-w-xl text-sm text-muted-foreground">
                选择左侧已有会话查看记录，或直接发送问题创建新会话。
              </p>
              <div className="mt-6 grid max-w-2xl gap-3 text-left sm:grid-cols-2">
                {["张三对我做了什么？", "我最近记录了哪些重要事情？", "哪些记忆和 gbrain MCP 有关？", "我的记录里还缺少哪些信息？"].map((suggestion) => (
                  <button key={suggestion} type="button" onClick={() => setQuestion(suggestion)} className="rounded-lg border border-border bg-card p-3 text-sm transition-colors hover:bg-muted">
                    <Sparkles className="mb-2 h-4 w-4 text-muted-foreground" />
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div ref={scrollContainerRef} className="min-h-0 flex-1 space-y-6 overflow-y-auto overscroll-contain pb-6">
              <div className="mx-auto w-full max-w-4xl space-y-6">
                {messages.map((message) => <ChatMessageItem key={message.id} message={message} />)}
                {isThinking && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />GBrain 正在检索和综合...</div>}
                <div ref={bottomRef} aria-hidden="true" className="h-px" />
              </div>
            </div>
          )}

          <div className="mx-auto mt-4 w-full max-w-4xl">
            <form onSubmit={handleSubmit} className="rounded-2xl border border-border bg-card p-3 shadow-sm">
              <div className="mb-3 flex items-center gap-2 border-b pb-3"><label htmlFor="chat-source" className="text-xs text-muted-foreground">查询 source</label><select id="chat-source" value={selectedSource} onChange={(event) => setSelectedSource(event.target.value)} className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"><option value="__all__">全部 source</option>{sources.map((source) => <option key={source.id} value={source.id}>{source.name && source.name !== source.id ? `${source.name} (${source.id})` : source.id}{source.page_count > 0 ? ` · ${source.page_count}` : ""}</option>)}</select></div>
              {showOptions && <div className="mb-3 grid gap-3 border-b pb-3 text-sm sm:grid-cols-3"><div><label htmlFor="chat-anchor" className="mb-1 block text-xs text-muted-foreground">Anchor（可选）</label><Input id="chat-anchor" value={anchor} onChange={(event) => setAnchor(event.target.value)} placeholder="例如 people/zhangsan" /></div><div><label htmlFor="chat-since" className="mb-1 block text-xs text-muted-foreground">起始日期</label><Input id="chat-since" type="date" value={since} onChange={(event) => setSince(event.target.value)} /></div><div><label htmlFor="chat-until" className="mb-1 block text-xs text-muted-foreground">结束日期 / 轮次</label><div className="flex gap-2"><Input id="chat-until" type="date" value={until} onChange={(event) => setUntil(event.target.value)} /><Input aria-label="综合轮次" type="number" min="1" max="5" value={rounds} onChange={(event) => setRounds(event.target.value)} className="w-20" title="综合轮次" /></div></div></div>}
              <div className="flex items-end gap-2"><Button type="button" variant="ghost" size="icon" onClick={() => setShowOptions((value) => !value)} title="高级选项" aria-label="高级选项"><ChevronDown className={`h-4 w-4 transition-transform ${showOptions ? "rotate-180" : ""}`} /></Button><textarea value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void handleSubmit() } }} placeholder="问问你的记忆...（Enter 发送，Shift+Enter 换行）" rows={1} className="max-h-32 min-h-10 flex-1 resize-none bg-transparent px-2 py-2 text-sm outline-none placeholder:text-muted-foreground" /><Button type="submit" size="icon" disabled={isThinking || !question.trim()} aria-label="发送">{isThinking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}</Button></div>
            </form>
            <p className="mt-2 text-center text-xs text-muted-foreground">回答由 gbrain think 生成；内容来自你的记忆库，结果可能需要人工核对。</p>
          </div>
        </main>
      </div>
    </div>
  )
}
