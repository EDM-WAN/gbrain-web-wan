/**
 * GBrain MCP Client
 *
 * 封装 MCP JSON-RPC over HTTP 的调用逻辑
 * GBrain 通过 gbrain serve --http --port 8787 暴露 MCP 端点
 *
 * Token 通过 httpOnly cookie 自动携带，客户端无需手动传递
 */

import { summarizeMCPError, summarizeNetworkError } from "@/lib/chat-errors"
import { parseJsonTolerant } from "@/lib/mcp-text"
import type {
  MCPRPCRequest,
  MCPRPCResponse,
  GBrainPage,
  GBrainPageDetail,
  GBrainStats,
  GBrainHealth,
  GBrainLink,
  GBrainSource,
  SearchResult,
  QueryOptions,
  GraphData,
  GraphNode,
  GraphEdge,
} from "@/types/gbrain"

// Token 管理 — 通过 /api/auth/token 端点操作 httpOnly cookie
export async function setGbrainToken(token: string): Promise<void> {
  const res = await fetch("/api/auth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  })
  if (!res.ok) throw new Error("Failed to save token")
}

export async function clearGbrainToken(): Promise<void> {
  await fetch("/api/auth/token", { method: "DELETE" })
}

export async function hasGbrainToken(): Promise<boolean> {
  const res = await fetch("/api/auth/token")
  const data = await res.json()
  return data.hasToken
}

// Source scoping is now explicit per-call: every UI caller passes source_id
// (or omits it to use the caller's default). The legacy "configured source"
// fallback was removed because it hijacked any call without a source_id to a
// hardcoded value (sdk-dsp-realgpt), which after the PostgreSQL migration is
// gone — routing reads there caused "Source not found or is archived".
function withConfiguredSource(name: string, arguments_: Record<string, unknown>): Record<string, unknown> {
  return arguments_
}

// 创建 MCP JSON-RPC 请求
function createRequest(
  method: string,
  name: string,
  arguments_: Record<string, unknown> = {}
): MCPRPCRequest {
  return {
    jsonrpc: "2.0",
    id: Date.now(),
    method,
    params: {
      name,
      arguments: withConfiguredSource(name, arguments_),
    },
  }
}

/**
 * 解析 SSE 响应文本为 MCP RPC Response
 *
 * 支持标准 SSE、多行 data、多个 event，以及部分版本返回的纯 JSON。
 */
function parseSSEResponse(text: string): MCPRPCResponse {
  const trimmed = text.trim()

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const direct = parseJsonTolerant<MCPRPCResponse>(trimmed)
    if (direct !== null) return direct
    // 不是有效 JSON，继续尝试 SSE 解析
  }

  const blocks = trimmed.split(/\n\n+/)
  let lastData = ""

  for (const block of blocks) {
    const lines = block.split("\n")
    const dataLines: string[] = []

    for (const line of lines) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart())
      } else if (line.startsWith("data")) {
        dataLines.push("")
      }
    }

    if (dataLines.length > 0) {
      lastData = dataLines.join("\n")
    }
  }

  if (!lastData) {
    throw new Error(`Invalid SSE response: no data field found. Raw: ${trimmed.slice(0, 200)}`)
  }

  const parsed = parseJsonTolerant<MCPRPCResponse>(lastData)
  if (parsed === null) {
    throw new Error(`Failed to parse SSE data as JSON. Data: ${lastData.slice(0, 200)}`)
  }
  return parsed
}

function parseMCPResult(text: string): unknown {
  const rpcResponse = parseSSEResponse(text)

  if (rpcResponse.error) {
    throw new Error(`MCP error: ${rpcResponse.error.message}`)
  }

  if (!rpcResponse.result?.content?.[0]?.text) {
    throw new Error("No content in MCP response")
  }

  const textContent = rpcResponse.result.content[0].text
  const parsed = parseJsonTolerant(textContent)
  if (parsed === null) {
    if (rpcResponse.result.isError) throw new Error(textContent.slice(0, 300))
    return textContent
  }
  if (
    parsed &&
    typeof parsed === "object" &&
    "error" in parsed &&
    typeof (parsed as { error?: unknown }).error === "string"
  ) {
    const detail = parsed as { error: string; message?: string; suggestion?: string }
    throw new Error(detail.message || detail.error + (detail.suggestion ? ` ${detail.suggestion}` : ""))
  }
  if (rpcResponse.result.isError) {
    throw new Error(typeof parsed === "string" ? parsed : textContent)
  }

  return parsed
}

// 调用 MCP 工具（通过 Next.js API Route，token 由 cookie 自动携带）
export async function callMCP(
  name: string,
  arguments_: Record<string, unknown> = {},
  options: { retryNetworkError?: boolean } = {},
): Promise<unknown> {
  const maxAttempts = options.retryNetworkError ? 3 : 1
  let lastError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch("/api/gbrain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createRequest("tools/call", name, arguments_)),
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(summarizeMCPError(response.status, errorText))
      }

      return parseMCPResult(await response.text())
    } catch (error) {
      lastError = error
      const isNetworkError = error instanceof TypeError
      if (!isNetworkError || attempt === maxAttempts) {
        if (isNetworkError) throw new Error(summarizeNetworkError(error))
        throw error
      }
      await new Promise((resolve) => window.setTimeout(resolve, attempt * 500))
    }
  }

  throw lastError instanceof Error ? lastError : new Error("MCP request failed")
}

// ==================== 页面与 Markdown ====================

export interface PageMetadata {
  title: string
  type: string
  tags: string[]
  frontmatter?: Record<string, unknown>
  timeline?: string
}

function yamlScalar(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value)
  if (value === null || value === undefined) return "null"
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return JSON.stringify(value)
}

/**
 * 把页面元数据和正文重新组装成 gbrain put_page 所需的完整 Markdown。
 * 更新页面时保留已有 frontmatter，避免编辑正文时丢失 type/tag。
 */
export function buildPageContent(metadata: PageMetadata, body: string, timeline = ""): string {
  const fields: Record<string, unknown> = {
    ...(metadata.frontmatter ?? {}),
    title: metadata.title.trim(),
    type: metadata.type.trim() || "note",
    tags: metadata.tags,
  }

  const lines = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null)
    .flatMap(([key, value]) => {
      if (key === "tags" && Array.isArray(value)) {
        return [
          "tags:",
          ...value.filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0)
            .map((tag) => `  - ${yamlScalar(tag.trim())}`),
        ]
      }
      return [`${key}: ${yamlScalar(value)}`]
    })

  const normalizedBody = body.trim()
  const normalizedTimeline = timeline.trim()
  const timelineBlock = normalizedTimeline
    ? `\n\n<!-- timeline -->\n\n${normalizedTimeline}\n`
    : ""
  return `---\n${lines.join("\n")}\n---\n\n${normalizedBody}${normalizedBody ? "\n" : ""}${timelineBlock}`
}

// ==================== GBrain API 封装 ====================

export async function getStats(): Promise<GBrainStats> {
  return callMCP("get_stats") as Promise<GBrainStats>
}

export async function getHealth(): Promise<GBrainHealth> {
  return callMCP("get_health") as Promise<GBrainHealth>
}

export async function runDoctor(): Promise<unknown> {
  return callMCP("run_doctor")
}

export interface ListPagesOptions {
  type?: string
  tag?: string
  sort?: "updated_desc" | "updated_asc" | "created_desc" | "slug"
  limit?: number
  offset?: number
  /** v0.46.25+: scope listing to one source, e.g. sdk-dsp-realgpt. */
  source_id?: string
  /** Request tags in the list response to avoid one get_page request per row. */
  include_tags?: boolean
  /** v0.51.x: request { total, limit, offset, has_more, pages } from the server. */
  include_total?: boolean
  /** Literal path prefix for source folder browsing. */
  slug_prefix?: string
}

interface ListPagesBatchWithTotal {
  pages: GBrainPage[]
  total: number
  limit: number
  offset: number
  has_more: boolean
  /** True when the server returned real include_total metadata (not a bare-array legacy fallback). */
  hasMetadata: boolean
}

export async function listPages(options: ListPagesOptions = {}): Promise<GBrainPage[]> {
  const result = await callMCP("list_pages", options as unknown as Record<string, unknown>)
  return Array.isArray(result) ? result : []
}

/**
 * 当前用户可见的 source 列表（已按归属域过滤），供各页面的 source 下拉使用。
 *
 * ⚠ 不要改成直接 `callMCP("sources_list")`。gbrain 的可见性按 OAuth client 判定，
 * 而本部署所有浏览器会话共用同一个服务端 client，那条通道返回的是**部署级**列表
 * —— 非 owner 会看到别人的 source（曾实际发生：普通账号看到 nuwa / wegent）。
 * 过滤由服务端 `/api/graph` 与 `/api/sources/grouped` 完成（唯一裁决点见
 * `lib/visible-sources.ts`）。
 *
 * 返回值补齐成 `GBrainSource` 形状（本地不提供的字段置空），让调用方无需改动。
 */
export async function listSources(options: { includeArchived?: boolean } = {}): Promise<GBrainSource[]> {
  const params = new URLSearchParams()
  if (options.includeArchived) params.set("includeArchived", "true")
  const response = await fetch(`/api/sources/grouped${params.size > 0 ? `?${params}` : ""}`, { cache: "no-store" })
  if (!response.ok) throw new Error(`读取 source 列表失败（HTTP ${response.status}）`)
  const payload = await response.json() as { sources?: Array<{ id?: string; name?: string; pageCount?: number }> }
  return (payload.sources ?? []).map((source) => ({
    id: String(source.id ?? ""),
    name: source.name || String(source.id ?? ""),
    local_path: null,
    remote_url: null,
    federated: false,
    page_count: Number(source.pageCount) || 0,
    last_sync_at: null,
  }))
}

/** Plain list_pages that returns only the page array (used for parallel page fetches). */
async function listPagesRaw(options: ListPagesOptions): Promise<GBrainPage[]> {
  const result = await callMCP("list_pages", options as unknown as Record<string, unknown>)
  if (Array.isArray(result)) return result
  if (result && typeof result === "object" && Array.isArray((result as { pages?: unknown }).pages)) {
    return (result as { pages: GBrainPage[] }).pages
  }
  return []
}

/**
 * Single list_pages batch that may carry Wegent-style pagination metadata.
 * Falls back to `{ pages: result, total: result.length, ... }` when the
 * server returns the legacy bare array (no include_total support).
 */
async function listPageBatchWithTotal(options: ListPagesOptions): Promise<ListPagesBatchWithTotal> {
  const result = (await callMCP("list_pages", options as unknown as Record<string, unknown>)) as
    | GBrainPage[]
    | { pages?: unknown; total?: unknown; limit?: unknown; offset?: unknown; has_more?: unknown }
  if (Array.isArray(result)) {
    return { pages: result, total: result.length, limit: options.limit ?? result.length, offset: options.offset ?? 0, has_more: false, hasMetadata: false }
  }
  return {
    pages: Array.isArray(result.pages) ? result.pages as GBrainPage[] : [],
    total: typeof result.total === "number" ? result.total : 0,
    limit: typeof result.limit === "number" ? result.limit : options.limit ?? 100,
    offset: typeof result.offset === "number" ? result.offset : options.offset ?? 0,
    has_more: result.has_more === true,
    hasMetadata: true,
  }
}

/**
 * Serial page-probe loop (legacy gbrain servers without include_total).
 * Peeks one row past the limit; stops when a batch comes back short.
 */
async function listPagesSerialProbe(options: Omit<ListPagesOptions, "limit" | "offset">, pageSize: number, startOffset: number): Promise<GBrainPage[]> {
  const pages: GBrainPage[] = []
  let offset = startOffset
  while (true) {
    const batch = await listPages({ ...options, limit: pageSize, offset })
    pages.push(...batch)
    if (batch.length < pageSize) return pages
    offset += batch.length
  }
}

/**
 * Fetch every page through the remote MCP page-size limit.
 *
 * v0.51.x optimization (Wegent-informed): the first batch requests
 * `include_total` so the server returns the full count alongside the rows.
 * We then fetch the remaining pages CONCURRENTLY (one request per page)
 * instead of serial `while` probing. This turns an N-page Memory Library
 * load from N serial RTTs into 1 RTT + parallel page fetches. Falls back
 * to the legacy serial loop when the server returns a bare array (older
 * gbrain — no include_total support).
 */
export async function listAllPages(options: Omit<ListPagesOptions, "limit" | "offset"> = {}): Promise<GBrainPage[]> {
  const pageSize = 100
  const first = await listPageBatchWithTotal({ ...options, limit: pageSize, offset: 0, include_total: true })
  if (!first.hasMetadata) {
    // Legacy gbrain: bare array, no metadata. Detect "more" by page-fullness
    // (exactly 100 rows from a 100-row page is provably incomplete) and walk
    // serially — same behavior as the original listAllPages.
    if (first.pages.length < pageSize) return first.pages
    const rest = await listPagesSerialProbe(options, pageSize, first.pages.length)
    return [...first.pages, ...rest]
  }
  if (first.pages.length < pageSize) return first.pages
  if (first.total <= first.pages.length) return first.pages

  // We know the real total → fetch the remaining pages in PARALLEL
  // (one request per page, Wegent-style count-then-fetch) instead of N
  // serial round trips.
  const offsets: number[] = []
  for (let offset = pageSize; offset < first.total; offset += pageSize) offsets.push(offset)
  const pages = [...first.pages]

  const settledBatch = await Promise.allSettled(
    offsets.map((offset) => listPagesRaw({ ...options, limit: pageSize, offset })),
  )
  const batched = settledBatch.flatMap((result) => result.status === "fulfilled" ? result.value : [])
  pages.push(...batched)

  // Defensive fallback: if the server's total was stale/low (rows added
  // between COUNT and paging), keep probing like the legacy loop so we
  // never silently drop pages.
  if (batched.length > 0) {
    const rest = await listPagesSerialProbe(options, pageSize, (offsets.at(-1) ?? 0) + batched.length)
    pages.push(...rest)
  }
  return pages
}

export async function listPageBatch(options: ListPagesOptions = {}): Promise<{ pages: GBrainPage[]; total?: number; has_more?: boolean }> {
  const result = await callMCP("list_pages", options as unknown as Record<string, unknown>) as unknown
  if (Array.isArray(result)) return { pages: result, total: result.length, has_more: result.length >= (options.limit ?? result.length) }
  if (result && typeof result === "object" && Array.isArray((result as { pages?: unknown }).pages)) {
    const batch = result as { pages: GBrainPage[]; total?: number; has_more?: boolean }
    return { pages: batch.pages, total: batch.total, has_more: batch.has_more }
  }
  return { pages: [], total: 0, has_more: false }
}

export interface SourceInventoryResult {
  source_id: string
  folder: string
  total: number
  has_more: boolean
  pages: GBrainPage[]
  folders: Array<{ name: string; path: string; source_id?: string | null; source_ids?: string[] | null; subtree_count: number; direct_count: number; child_folder_count: number }>
}

export async function getSourceInventory(sourceId: string, folder = "", options: { limit?: number; offset?: number; type?: string; tag?: string; sort?: ListPagesOptions["sort"]; recursive?: boolean; includeSourceId?: boolean } = {}): Promise<SourceInventoryResult> {
  return callMCP("source_inventory", {
    source_id: sourceId,
    folder,
    limit: options.limit ?? 48,
    offset: options.offset ?? 0,
    ...(options.type ? { type: options.type } : {}),
    ...(options.tag ? { tag: options.tag } : {}),
    ...(options.sort ? { sort: options.sort } : {}),
    ...(options.recursive ? { recursive: true } : {}),
    ...(options.includeSourceId ? { include_source_id: true } : {}),
  }) as Promise<SourceInventoryResult>
}

export async function listPagesWithTags(options: Omit<ListPagesOptions, "limit" | "offset"> = {}): Promise<GBrainPage[]> {
  const pages = await listAllPages({ ...options, include_tags: true })
  // New GBrain servers return tags in the list response. Keep a bounded
  // compatibility fallback for older servers, but never issue one request per
  // page when the batch projection is available.
  if (pages.every((page) => Array.isArray(page.tags))) return pages
  const missing = pages.filter((page) => !Array.isArray(page.tags)).slice(0, 20)
  const enriched = await Promise.allSettled(
    missing.map(async (page) => ({
      key: `${page.source_id || "default"}:${page.slug}`,
      tags: (await getPage(page.slug, { sourceId: page.source_id })).tags || [],
    })),
  )
  const tagsByKey = new Map(enriched.flatMap((result) => result.status === "fulfilled" ? [[result.value.key, result.value.tags] as const] : []))
  return pages.map((page) => ({
    ...page,
    tags: page.tags || tagsByKey.get(`${page.source_id || "default"}:${page.slug}`) || [],
  }))
}

export async function getPage(
  slug: string,
  options: { includeContent?: boolean; includeDeleted?: boolean; sourceId?: string } = {},
): Promise<GBrainPageDetail> {
  return callMCP("get_page", {
    slug,
    ...(options.includeContent ? { include_content: true } : {}),
    ...(options.includeDeleted ? { include_deleted: true } : {}),
    ...(options.sourceId ? { source_id: options.sourceId } : {}),
  }) as Promise<GBrainPageDetail>
}

export async function putPage(slug: string, content: string): Promise<unknown> {
  return callMCP("put_page", { slug, content })
}

export async function deletePage(slug: string, options: { sourceId?: string } = {}): Promise<unknown> {
  return callMCP("delete_page", {
    slug,
    ...(options.sourceId ? { source_id: options.sourceId } : {}),
  })
}

export async function purgePages(slugs: string[], sourceId: string, dryRun = false): Promise<unknown> {
  return callMCP("purge_pages", {
    slugs,
    source_id: sourceId,
    confirm_destructive: !dryRun,
    ...(dryRun ? { dry_run: true } : {}),
  })
}

export interface ThinkCitation {
  page_slug: string
  row_num: number | null
  citation_index?: number
}

export interface ThinkResult {
  question: string
  retrieval_query?: string
  scope_applied?: { source_id?: string; slug_prefix?: string }
  retrieval_arm?: string
  answer: string
  citations: ThinkCitation[]
  gaps: string[]
  pagesGathered: number
  takesGathered: number
  graphHits: number
  modelUsed: string
  rounds: number
  warnings: string[]
  synthesisOk?: boolean
  synthesis_status?: string
  /**
   * Extractive material the server attaches when synthesis did NOT produce an
   * answer (llm_error / empty_answer / not_json / output_truncated). `answer`
   * stays empty in exactly those cases, so without reading this the UI can
   * only say "no answer" and hide the retrieved pages the server already
   * picked. Present only on a degraded result.
   */
  extractive?: {
    answer: string
    citations?: ThinkCitation[]
  }
  evidence_truncated?: boolean
  usage?: {
    input_tokens: number
    output_tokens: number
  }
}

export interface ThinkOptions {
  question: string
  retrieval_query?: string
  conversation_context?: string
  anchor?: string
  rounds?: number
  since?: string
  until?: string
  model?: string
  source_id?: string
}

export async function think(options: ThinkOptions): Promise<ThinkResult> {
  return callMCP("think", options as unknown as Record<string, unknown>) as Promise<ThinkResult>
}

export interface ThinkStreamHandlers {
  onStart?: (data: { status?: string; job_id?: string }) => void
  onRetrieval?: (data: { pages?: number; takes?: number; graph?: number; source_id?: string; prefix?: string }) => void
  onDelta?: (data: { text?: string; offset?: number }) => void
  onDone?: (data: { result: ThinkResult; offset?: number }) => void
  onError?: (data: { code?: string; message?: string }) => void
  onCancelled?: (data: { offset?: number; partial_answer?: string }) => void
}

/** Consume the additive progressive think transport. */
export async function thinkStream(
  options: ThinkOptions,
  handlers: ThinkStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch("/api/gbrain/think-stream", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(options),
    signal,
  })
  if (!response.ok || !response.body) throw new Error(`GBrain stream failed (${response.status})`)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let event = "message"
  const dispatch = (payload: string) => {
    let data: any
    try { data = JSON.parse(payload) } catch { return }
    if (event === "start") handlers.onStart?.(data)
    else if (event === "retrieval") handlers.onRetrieval?.(data)
    else if (event === "delta") handlers.onDelta?.(data)
    else if (event === "done" && data?.result) handlers.onDone?.(data)
    else if (event === "error") handlers.onError?.(data)
    else if (event === "cancelled") handlers.onCancelled?.(data)
    event = "message"
  }
  while (true) {
    const { done, value } = await reader.read()
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
    const frames = buffer.split(/\r?\n\r?\n/)
    buffer = frames.pop() || ""
    for (const frame of frames) {
      const dataLines: string[] = []
      for (const line of frame.split(/\r?\n/)) {
        if (line.startsWith("event:")) event = line.slice(6).trim()
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim())
      }
      if (dataLines.length) dispatch(dataLines.join("\n"))
    }
    if (done) break
  }
}

export async function getThinkStreamJob(jobId: string): Promise<Record<string, unknown>> {
  const response = await fetch(`/api/gbrain/think-stream/${encodeURIComponent(jobId)}`)
  if (!response.ok) throw new Error(`Stream job lookup failed (${response.status})`)
  return response.json() as Promise<Record<string, unknown>>
}

export async function cancelThinkStreamJob(jobId: string): Promise<void> {
  const response = await fetch(`/api/gbrain/think-stream/${encodeURIComponent(jobId)}/cancel`, { method: "POST", headers: { "Content-Type": "application/json" } })
  if (!response.ok) throw new Error(`Stream job cancellation failed (${response.status})`)
}

export interface SearchOptions {
  query: string
  limit?: number
  offset?: number
  source_id?: string
  types?: string[]
  snippet_chars?: number
}

export async function searchPages(options: SearchOptions): Promise<SearchResult[]> {
  const result = await callMCP("search", options as unknown as Record<string, unknown>)
  return Array.isArray(result) ? result : []
}

export async function queryPages(options: QueryOptions): Promise<SearchResult[]> {
  const result = await callMCP("query", options as unknown as Record<string, unknown>)
  return Array.isArray(result) ? result : []
}

export async function getTags(): Promise<string[]> {
  const result = await callMCP("get_tags")
  return Array.isArray(result) ? result : []
}

function normalizeLinks(result: unknown): GBrainLink[] {
  const value = result && typeof result === "object" && !Array.isArray(result)
    ? (result as { links?: unknown; backlinks?: unknown }).links ?? (result as { backlinks?: unknown }).backlinks
    : result
  return Array.isArray(value) ? value.filter((link): link is GBrainLink => {
    return Boolean(link && typeof link === "object" && "from_slug" in link && "to_slug" in link)
  }) : []
}

export async function getLinks(slug: string, sourceId?: string): Promise<GBrainLink[]> {
  return normalizeLinks(await callMCP("get_links", {
    slug,
    ...(sourceId ? { source_id: sourceId } : {}),
  }))
}

export async function getBacklinks(slug: string, sourceId?: string): Promise<GBrainLink[]> {
  return normalizeLinks(await callMCP("get_backlinks", {
    slug,
    ...(sourceId ? { source_id: sourceId } : {}),
  }))
}

export async function addLink(options: {
  from: string
  to: string
  link_type?: string
  context?: string
  link_source?: string
}): Promise<unknown> {
  return callMCP("add_link", options)
}

export async function removeLink(options: {
  from: string
  to: string
  link_type?: string
  link_source?: string
}): Promise<unknown> {
  return callMCP("remove_link", options)
}

export async function getLinkSources(): Promise<unknown> {
  return callMCP("list_link_sources")
}

export async function traverseGraphWithLinks(slug: string, depth = 2): Promise<GraphData> {
  const raw = await callMCP("traverse_graph", { slug, depth, direction: "both" })
  return normalizeGraphResult(raw, slug)
}

export async function getTimeline(slug: string, sourceId?: string): Promise<unknown> {
  return callMCP("get_timeline", {
    slug,
    ...(sourceId ? { source_id: sourceId } : {}),
  })
}

// ==================== Knowledge Graph ====================

function normalizeGraphResult(raw: unknown, fallbackSlug?: string): GraphData {
  const data = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {}
  const rawNodes = Array.isArray(data.nodes) ? data.nodes : []
  const rawEdges = Array.isArray(data.edges) ? data.edges : (Array.isArray(data.links) ? data.links : [])
  const pathRows = Array.isArray(raw) ? raw : []

  const edgeRows = [...rawEdges, ...pathRows]
    .filter((edge): edge is Record<string, unknown> => Boolean(edge && typeof edge === "object"))
    .filter((edge) => typeof edge.from_slug === "string" && typeof edge.to_slug === "string")

  const edgeMap = new Map<string, GraphEdge>()
  for (const edge of edgeRows) {
    const source = String(edge.from_slug)
    const target = String(edge.to_slug)
    const key = `${source}|${target}|${String(edge.link_type || "link")}`
    edgeMap.set(key, {
      source,
      target,
      type: String(edge.link_type || "link"),
      weight: typeof edge.weight === "number" ? edge.weight : 1,
    })
  }

  const nodeMap = new Map<string, GraphNode>()
  for (const node of rawNodes) {
    if (!node || typeof node !== "object") continue
    const item = node as Record<string, unknown>
    const slug = typeof item.slug === "string" ? item.slug : typeof item.id === "string" ? item.id : ""
    if (!slug) continue
    nodeMap.set(slug, {
      id: slug,
      slug,
      title: typeof item.title === "string" ? item.title : slug,
      type: typeof item.type === "string" ? item.type : "default",
      tags: Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === "string") : [],
      weight: typeof item.weight === "number" ? item.weight : 1,
    })
  }

  if (fallbackSlug && !nodeMap.has(fallbackSlug)) {
    nodeMap.set(fallbackSlug, {
      id: fallbackSlug,
      slug: fallbackSlug,
      title: fallbackSlug,
      type: "default",
      tags: [],
      weight: 1,
    })
  }
  for (const edge of edgeMap.values()) {
    for (const slug of [edge.source, edge.target]) {
      if (!nodeMap.has(slug)) {
        nodeMap.set(slug, {
          id: slug,
          slug,
          title: slug,
          type: "default",
          tags: [],
          weight: 1,
        })
      }
    }
  }

  return { nodes: Array.from(nodeMap.values()), edges: Array.from(edgeMap.values()) }
}

export async function traverseGraph(slug: string, depth: number = 1, sourceId?: string): Promise<GraphData> {
  const args = { slug, depth, direction: "both", ...(sourceId ? { source_id: sourceId } : {}) }
  const raw = await callMCP("traverse_graph", args)
  return normalizeGraphResult(raw, slug)
}

export async function listCodeGraph(sourceId?: string): Promise<GraphData> {
  const raw = await callMCP("code_graph", {
    limit: 300,
    ...(sourceId ? { source_id: sourceId } : {}),
  }) as Record<string, unknown>
  const rawNodes = Array.isArray(raw?.nodes) ? raw.nodes : []
  const rawEdges = Array.isArray(raw?.edges) ? raw.edges : []
  return {
    nodes: rawNodes.filter((node): node is Record<string, unknown> => Boolean(node && typeof node === "object"))
      .map((node) => ({
        id: String(node.id ?? node.symbol ?? ""),
        slug: String(node.slug ?? node.id ?? ""),
        title: String(node.title ?? node.symbol ?? node.id ?? ""),
        type: String(node.type ?? "symbol"),
        tags: [],
        weight: typeof node.weight === "number" ? node.weight : 1,
        symbol: typeof node.symbol === "string" ? node.symbol : undefined,
        file: typeof node.file === "string" ? node.file : null,
        page_slug: typeof node.page_slug === "string" ? node.page_slug : null,
        source_id: typeof node.source_id === "string" ? node.source_id : null,
        start_line: typeof node.start_line === "number" ? node.start_line : null,
        end_line: typeof node.end_line === "number" ? node.end_line : null,
      })),
    edges: rawEdges.filter((edge): edge is Record<string, unknown> => Boolean(edge && typeof edge === "object"))
      .map((edge) => ({
        source: String(edge.source ?? ""),
        target: String(edge.target ?? ""),
        type: String(edge.type ?? "calls"),
        weight: typeof edge.weight === "number" ? edge.weight : 1,
        resolved: edge.resolved === true,
        resolution_kind: typeof edge.resolution_kind === "string" ? edge.resolution_kind : null,
      })),
  }
}

export async function buildFullGraph(options: { maxNodes?: number; centerSlug?: string; sourceId?: string } = {}): Promise<GraphData> {
  const { maxNodes = 100, centerSlug, sourceId } = options

  const scopedPages = () => listPages({
    sort: "updated_desc",
    limit: maxNodes,
    ...(sourceId ? { source_id: sourceId } : {}),
  })

  if (centerSlug) {
    const data = await traverseGraph(centerSlug, 2, sourceId)
    if (data.nodes.length > 0) return data
    const page = await getPage(centerSlug, { sourceId }).catch(() => null)
    if (page) {
      return {
        nodes: [{ id: page.slug, slug: page.slug, title: page.title, type: page.type, tags: page.tags || [], weight: 1 }],
        edges: [],
      }
    }
    return { nodes: [], edges: [] }
  }

  // Health is an admin-scoped operation on newer gbrain servers. It is an
  // optional optimization for choosing graph entry points, never a
  // prerequisite for a read-only graph view.
  const health = await getHealth().catch(() => null)
  const entryPoints = (health?.most_connected || [])
    .map((entry) => typeof entry === "string" ? entry : entry.slug)
    .filter(Boolean)

  if (entryPoints.length > 0) {
    const results = await Promise.allSettled(
      entryPoints.slice(0, 5).map((slug) => traverseGraph(slug, 1, sourceId))
    )
    const merged = mergeGraphs(results)
    if (merged.nodes.length > 0) return merged
  }

  const pages = await scopedPages()
  if (pages.length === 0) return { nodes: [], edges: [] }

  return {
    nodes: pages.map((p) => ({
      id: p.slug,
      slug: p.slug,
      title: p.title,
      type: p.type || "note",
      tags: p.tags || [],
      weight: 1,
    })),
    edges: [],
  }
}

function mergeGraphs(results: PromiseSettledResult<GraphData>[]): GraphData {
  const nodeMap = new Map<string, GraphNode>()
  const edgeSet = new Set<string>()

  for (const result of results) {
    if (result.status !== "fulfilled") continue
    const nodes = Array.isArray(result.value?.nodes) ? result.value.nodes : []
    const edges = Array.isArray(result.value?.edges) ? result.value.edges : []
    for (const n of nodes) {
      if (n?.slug) nodeMap.set(n.slug, n)
    }
    for (const e of edges) {
      if (e?.source && e?.target) edgeSet.add(`${e.source}|${e.target}`)
    }
  }

  return {
    nodes: Array.from(nodeMap.values()),
    edges: Array.from(edgeSet).map((k) => {
      const [source, target] = k.split("|")
      return { source, target, weight: 1, type: "link" }
    }),
  }
}
