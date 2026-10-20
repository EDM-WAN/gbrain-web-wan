"use client"

import { useCallback, useEffect, useState } from "react"
import { useParams, useRouter, useSearchParams } from "next/navigation"
import { Header } from "@/components/layout/Header"
import { MemoryEditor } from "@/components/memory/MemoryEditor"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { ArrowLeft, Link2, Clock, Tag, Calendar, ExternalLink, Trash2 } from "lucide-react"
import {
  addLink,
  deletePage,
  getBacklinks,
  getLinks,
  getPage,
  getTimeline,
  removeLink,
  searchPages,
} from "@/lib/gbrain"
import type { GBrainLink, GBrainPage, GBrainPageDetail } from "@/types/gbrain"

function formatDate(dateStr: string): string {
  const date = new Date(dateStr)
  return date.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

export default function MemoryDetailPage() {
  const params = useParams()
  const router = useRouter()
  const searchParams = useSearchParams()
  const slug = params.slug ? decodeURIComponent(params.slug as string) : ""
  const sourceId = searchParams.get("source_id") || undefined

  const [page, setPage] = useState<GBrainPageDetail | null>(null)
  const [links, setLinks] = useState<GBrainLink[]>([])
  const [backlinks, setBacklinks] = useState<GBrainLink[]>([])
  const [timeline, setTimeline] = useState<unknown[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<"content" | "links" | "timeline">("content")
  const [isDeleting, setIsDeleting] = useState(false)
  const [allPages, setAllPages] = useState<GBrainPage[]>([])
  const [linkSearch, setLinkSearch] = useState("")
  const [isLoadingLinkTargets, setIsLoadingLinkTargets] = useState(false)
  const [linkTarget, setLinkTarget] = useState("")
  const [linkType, setLinkType] = useState("")
  const [linkContext, setLinkContext] = useState("")
  const [isLinkSaving, setIsLinkSaving] = useState(false)
  const [linkError, setLinkError] = useState<string | null>(null)
  const [linkNotice, setLinkNotice] = useState<string | null>(null)

  const loadPageData = useCallback(async () => {
    if (!slug) return
    await Promise.resolve()
    setIsLoading(true)
    setError(null)

    try {
      const pageData = await getPage(slug, { includeContent: true, sourceId })
      setPage(pageData)
      // 关系/时间线和链接目标列表均按需加载，避免点击一个代码节点时
      // 同步拉取数千个页面和所有附属数据。
      setLinks([])
      setBacklinks([])
      setTimeline([])
      setAllPages([])
    } catch (err) {
      console.error("Failed to load page:", err)
      setError(err instanceof Error ? err.message : "加载记忆失败")
      setPage(null)
      setLinks([])
      setBacklinks([])
      setTimeline([])
    } finally {
      setIsLoading(false)
    }
  }, [slug, sourceId])

  useEffect(() => {
    void Promise.resolve().then(loadPageData)
  }, [loadPageData])

  useEffect(() => {
    if (activeTab !== "links" || !slug) return
    let active = true
    void Promise.all([getLinks(slug, sourceId), getBacklinks(slug, sourceId)])
      .then(([linksData, backlinksData]) => {
        if (!active) return
        setLinks(linksData)
        setBacklinks(backlinksData)
      })
      .catch((err) => {
        if (active) setLinkError(err instanceof Error ? err.message : "加载关系失败")
      })
    return () => { active = false }
  }, [activeTab, slug, sourceId])

  useEffect(() => {
    if (activeTab !== "timeline" || !slug) return
    let active = true
    void getTimeline(slug, sourceId)
      .then((timelineData) => {
        if (active) setTimeline(Array.isArray(timelineData) ? timelineData : [])
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : "加载时间线失败")
      })
    return () => { active = false }
  }, [activeTab, slug, sourceId])

  useEffect(() => {
    if (activeTab !== "links" || !linkSearch.trim()) {
      setAllPages([])
      return
    }
    let active = true
    setIsLoadingLinkTargets(true)
    void searchPages({ query: linkSearch.trim(), limit: 20, ...(sourceId ? { source_id: sourceId } : {}) })
      .then((results) => {
        if (!active) return
        setAllPages(results.map((result) => ({
          slug: result.slug,
          title: result.title,
          type: result.type,
          source_id: result.source_id,
          tags: [],
          updated_at: "",
        })))
      })
      .catch((err) => {
        if (active) setLinkError(err instanceof Error ? err.message : "搜索目标页面失败")
      })
      .finally(() => { if (active) setIsLoadingLinkTargets(false) })
    return () => { active = false }
  }, [activeTab, linkSearch, sourceId])

  const handleContentSave = (newValues: {
    slug: string
    title: string
    type: string
    tags: string[]
    content: string
  }) => {
    if (page) {
      setPage({
        ...page,
        title: newValues.title,
        type: newValues.type,
        tags: newValues.tags,
        compiled_truth: newValues.content,
        updated_at: new Date().toISOString(),
      })
    }
  }

  const handleDelete = async () => {
    if (!page || isDeleting) return
    const confirmed = window.confirm(
      `确定要删除“${page.title || page.slug}”吗？删除后可以通过 gbrain 的恢复能力处理，但当前页面会从列表中移除。`
    )
    if (!confirmed) return

    setIsDeleting(true)
    setError(null)
    try {
      await deletePage(page.slug, { sourceId: page.source_id })
      router.push("/memory")
    } catch (err) {
      console.error("Failed to delete page:", err)
      setError(err instanceof Error ? err.message : "删除失败")
      setIsDeleting(false)
    }
  }

  const handleEditorCancel = () => {
    setError(null)
  }

  const reloadLinks = async () => {
    const [linksData, backlinksData] = await Promise.all([
      getLinks(slug, sourceId),
      getBacklinks(slug, sourceId),
    ])
    setLinks(linksData)
    setBacklinks(backlinksData)
  }

  const handleAddLink = async () => {
    if (!linkTarget || linkTarget === slug || isLinkSaving) return

    setIsLinkSaving(true)
    setLinkError(null)
    setLinkNotice(null)
    try {
      await addLink({
        from: slug,
        to: linkTarget,
        ...(linkType.trim() ? { link_type: linkType.trim() } : {}),
        ...(linkContext.trim() ? { context: linkContext.trim() } : {}),
      })
      await reloadLinks()
      setLinkTarget("")
      setLinkType("")
      setLinkContext("")
      setLinkNotice("关系已建立")
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : "建立关系失败")
    } finally {
      setIsLinkSaving(false)
    }
  }

  const handleRemoveLink = async (link: GBrainLink) => {
    const from = link.from_slug
    const to = link.to_slug
    const type = link.link_type || ""
    const confirmed = window.confirm(
      `确定删除关系：${from} → ${to}${type ? `（${type}）` : ""}？`
    )
    if (!confirmed || isLinkSaving) return

    setIsLinkSaving(true)
    setLinkError(null)
    setLinkNotice(null)
    try {
      await removeLink({
        from,
        to,
        ...(type ? { link_type: type } : {}),
        ...(link.link_source ? { link_source: link.link_source } : {}),
      })
      await reloadLinks()
      setLinkNotice("关系已删除")
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : "删除关系失败")
    } finally {
      setIsLinkSaving(false)
    }
  }

  const renderLink = (link: GBrainLink, direction: "out" | "in") => {
    const targetSlug = direction === "out" ? link.to_slug : link.from_slug
    return (
      <div
        key={`${link.from_slug}-${link.to_slug}-${link.link_type || "untyped"}-${link.link_source || ""}`}
        className="flex items-center justify-between gap-3 rounded-lg border p-2"
      >
        <a
          href={`/memory/${encodeURIComponent(targetSlug)}`}
          className="min-w-0 flex-1 text-sm hover:text-primary"
        >
          <span className="block truncate">{targetSlug}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {link.link_type || "未分类关系"}
            {link.context ? ` · ${link.context}` : ""}
          </span>
        </a>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void handleRemoveLink(link)}
          disabled={isLinkSaving}
          className="shrink-0 text-destructive hover:text-destructive"
        >
          删除
        </Button>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="min-h-screen">
        <Header title="Loading..." />
        <div className="p-6">
          <div className="animate-pulse space-y-4">
            <div className="h-8 w-64 bg-muted rounded" />
            <div className="h-4 w-32 bg-muted rounded" />
            <div className="h-4 w-full bg-muted rounded mt-8" />
            <div className="h-4 w-3/4 bg-muted rounded" />
          </div>
        </div>
      </div>
    )
  }

  if (error || !page) {
    return (
      <div className="min-h-screen">
        <Header title="Error" />
        <div className="p-6">
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <p className="text-destructive mb-4">{error || "Page not found"}</p>
              <Button variant="outline" onClick={() => router.back()}>
                <ArrowLeft className="h-4 w-4 mr-2" />
                返回
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen">
      <Header
        title={page.title || slug}
        description={slug}
        action={
          <div className="flex items-center gap-2">
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={isDeleting}
              className="gap-1.5"
            >
              <Trash2 className="h-4 w-4" />
              {isDeleting ? "删除中..." : "删除"}
            </Button>
            <Button variant="outline" onClick={() => router.back()}>
              <ArrowLeft className="h-4 w-4 mr-2" />
              返回
            </Button>
          </div>
        }
      />

      <div className="p-6">
        <div className="grid gap-6 lg:grid-cols-3">
          {/* 主体内容 */}
          <div className="lg:col-span-2 space-y-6">
            {/* 元信息 */}
            <Card>
              <CardContent className="p-4">
                <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
                  <div className="flex items-center gap-1.5">
                    <Clock className="h-4 w-4" />
                    更新于 {formatDate(page.updated_at)}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Calendar className="h-4 w-4" />
                    创建于 {formatDate(page.created_at)}
                  </div>
                </div>
                {page.tags && page.tags.length > 0 && (
                  <div className="flex flex-wrap gap-2 mt-3">
                    {page.tags.map((tag) => (
                      <span
                        key={tag}
                        className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-muted"
                      >
                        <Tag className="h-3 w-3" />
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* 标签页切换 */}
            <div className="flex gap-2 border-b">
              <button
                onClick={() => setActiveTab("content")}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === "content"
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                内容
              </button>
              <button
                onClick={() => setActiveTab("links")}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === "links"
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                链接 ({links.length + backlinks.length})
              </button>
              <button
                onClick={() => setActiveTab("timeline")}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === "timeline"
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                时间线
              </button>
            </div>

            {/* 内容 Tab - 使用 MemoryEditor */}
            {activeTab === "content" && (
              <MemoryEditor
                slug={slug}
                initialTitle={page.title}
                initialType={page.type}
                initialTags={page.tags || []}
                initialFrontmatter={page.frontmatter || {}}
                initialTimeline={page.timeline || ""}
                initialContent={page.compiled_truth || ""}
                onSave={handleContentSave}
                onCancel={handleEditorCancel}
              />
            )}

            {/* 链接 Tab */}
            {activeTab === "links" && (
              <div className="space-y-6">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                      <Link2 className="h-4 w-4" />
                      建立关系
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid gap-3 md:grid-cols-2">
                      <div className="space-y-1.5">
                        <label htmlFor="link-target-search" className="text-sm font-medium">目标记忆</label>
                        <input
                          id="link-target-search"
                          value={linkSearch}
                          onChange={(event) => {
                            setLinkSearch(event.target.value)
                            setLinkTarget("")
                          }}
                          placeholder="输入标题或路径搜索目标页面"
                          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                        />
                        <select
                          id="link-target"
                          value={linkTarget}
                          onChange={(event) => setLinkTarget(event.target.value)}
                          className="mt-2 h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                        >
                          <option value="">{isLoadingLinkTargets ? "搜索中..." : linkSearch ? "请选择目标记忆" : "先输入关键词搜索"}</option>
                          {allPages
                            .filter((candidate) => candidate.slug !== slug)
                            .map((candidate) => (
                              <option key={`${candidate.source_id || "default"}:${candidate.slug}`} value={candidate.slug}>
                                {candidate.title || candidate.slug} · {candidate.slug}
                              </option>
                            ))}
                        </select>
                      </div>
                      <div className="space-y-1.5">
                        <label htmlFor="link-type" className="text-sm font-medium">关系类型（可选）</label>
                        <select
                          id="link-type"
                          value={linkType}
                          onChange={(event) => setLinkType(event.target.value)}
                          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                        >
                          <option value="">无类型关系</option>
                          <option value="partner_of">partner_of（伴侣/夫妻）</option>
                          <option value="related_to">related_to（相关）</option>
                          <option value="works_at">works_at（任职于）</option>
                          <option value="founded">founded（创立）</option>
                          <option value="invested_in">invested_in（投资）</option>
                          <option value="advises">advises（指导/顾问）</option>
                          <option value="attended">attended（参加）</option>
                          <option value="mentions">mentions（提及）</option>
                          <option value="owes_to">owes_to（欠/应付）</option>
                          <option value="derived_from">derived_from（来源于）</option>
                        </select>
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <label htmlFor="link-context" className="text-sm font-medium">关系说明（可选）</label>
                      <input
                        id="link-context"
                        value={linkContext}
                        onChange={(event) => setLinkContext(event.target.value)}
                        placeholder="例如 Alice 是张三的配偶"
                        className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                      />
                    </div>
                    <div className="flex items-center gap-3">
                      <Button
                        onClick={() => void handleAddLink()}
                        disabled={!linkTarget || isLinkSaving}
                        className="gap-1.5"
                      >
                        {isLinkSaving ? "处理中..." : "建立关系"}
                      </Button>
                      <span className="text-xs text-muted-foreground">
                        起点：{slug}
                      </span>
                    </div>
                    {linkNotice && <p className="text-sm text-green-600">✅ {linkNotice}</p>}
                    {linkError && <p className="text-sm text-destructive">{linkError}</p>}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                      <ExternalLink className="h-4 w-4" />
                      出链 ({links.length})
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {links.length > 0 ? (
                      <div className="space-y-2">{links.map((link) => renderLink(link, "out"))}</div>
                    ) : (
                      <p className="text-sm text-muted-foreground">暂无出链</p>
                    )}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                      <Link2 className="h-4 w-4" />
                      入链 ({backlinks.length})
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {backlinks.length > 0 ? (
                      <div className="space-y-2">{backlinks.map((link) => renderLink(link, "in"))}</div>
                    ) : (
                      <p className="text-sm text-muted-foreground">暂无入链</p>
                    )}
                  </CardContent>
                </Card>
              </div>
            )}

            {/* 时间线 Tab */}
            {activeTab === "timeline" && (
              <Card>
                <CardContent className="p-6">
                  {timeline.length > 0 ? (
                    <div className="space-y-4 border-l-2 border-muted pl-4">
                      {timeline.map((entry: unknown, index: number) => {
                        const e = entry as { timestamp?: string; content?: string }
                        return (
                          <div key={index} className="relative">
                            <div className="absolute -left-[21px] w-3 h-3 rounded-full bg-primary" />
                            <div className="text-xs text-muted-foreground mb-1">
                              {e.timestamp ? formatDate(e.timestamp) : ""}
                            </div>
                            <div className="text-sm">{e.content || ""}</div>
                          </div>
                        )
                      })}
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center py-8">
                      <Calendar className="h-8 w-8 text-muted-foreground mb-2" />
                      <p className="text-muted-foreground">暂无时间线记录</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
          </div>

          {/* 侧边栏 */}
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">信息</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="text-sm">
                  <span className="text-muted-foreground">类型：</span>
                  <span className="ml-1 font-medium">{page.type || "default"}</span>
                </div>
                <div className="text-sm">
                  <span className="text-muted-foreground">Slug：</span>
                  <code className="ml-1 text-xs bg-muted px-1 py-0.5 rounded">
                    {page.slug}
                  </code>
                </div>
                <div className="text-sm">
                  <span className="text-muted-foreground">来源：</span>
                  <span className="ml-1 font-medium">{page.source_id}</span>
                </div>
                <div className="text-sm">
                  <span className="text-muted-foreground">链接：</span>
                  <span className="ml-1 font-medium">{links.length + backlinks.length}</span>
                </div>
                <div className="text-sm">
                  <span className="text-muted-foreground">内容哈希：</span>
                  <code className="ml-1 text-xs bg-muted px-1 py-0.5 rounded">
                    {page.content_hash?.slice(0, 12)}...
                  </code>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}
