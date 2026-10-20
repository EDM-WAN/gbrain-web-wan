"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { Header } from "@/components/layout/Header"
import { GraphViewer } from "@/components/graph/GraphViewer"
import { useGBrainStore } from "@/lib/store"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { buildFullGraph, listCodeGraph, listSources } from "@/lib/gbrain"
import type { GBrainSource, GraphData } from "@/types/gbrain"
import { Search, Network, AlertCircle, Loader2 } from "lucide-react"

export default function GraphPage() {
  const router = useRouter()
  const {
    graphData, setGraphData, graphMode, setGraphMode, graphSource: selectedSource,
    setGraphSource: setSelectedSource, graphSearchQuery: searchQuery,
    setGraphSearchQuery: setSearchQuery, graphSelectedSlug: selectedSlug,
    setGraphSelectedSlug: setSelectedSlug, graphTransform,
    setGraphTransform,
  } = useGBrainStore()
  const [isLoading, setIsLoading] = useState(graphData === null)
  const [error, setError] = useState<string | null>(null)
  const [nodeNotice, setNodeNotice] = useState<string | null>(null)
  const [sources, setSources] = useState<GBrainSource[]>([])

  useEffect(() => {
    let active = true
    void listSources().then((items) => {
      if (active) setSources(items)
    }).catch((err) => {
      console.error("Failed to load graph sources:", err)
    })
    return () => { active = false }
  }, [])

  const loadGraph = useCallback(async () => {
    setIsLoading(true)
    setError(null)

    try {
      let data: GraphData
      if (graphMode === "code") {
        // code_graph deliberately accepts one source only because its traversal
        // cache and edge joins are source-specific. When the UI is still on
        // “全部 source”, probe visible non-empty sources and select the first
        // source that actually contains code edges instead of sending an
        // impossible federated request to the MCP operation.
        if (selectedSource === "__all__") {
          const candidates = sources.filter((source) => source.page_count > 0)
          let selectedCodeSource: string | undefined
          data = { nodes: [], edges: [] }
          for (const candidate of candidates) {
            // 单个 source 的 code_graph 失败不应中断整个“全部 source”探测：
            // 遇到无代码边的/异常的 source 直接跳过，继续找下一个。
            let candidateData: GraphData
            try {
              candidateData = await listCodeGraph(candidate.id)
            } catch (err) {
              console.error(`code_graph probe failed for ${candidate.id}:`, err)
              continue
            }
            if (candidateData.nodes.length > 0 || candidateData.edges.length > 0) {
              data = candidateData
              selectedCodeSource = candidate.id
              break
            }
          }
          if (selectedCodeSource) setSelectedSource(selectedCodeSource)
        } else {
          data = await listCodeGraph(selectedSource)
        }
      } else {
        data = await buildFullGraph({
          maxNodes: 150,
          ...(selectedSource !== "__all__" ? { sourceId: selectedSource } : {}),
        })
      }
      setGraphData(data)
    } catch (err) {
      console.error("Failed to load graph:", err)
      setError(err instanceof Error ? err.message : "加载图谱失败")
      setGraphData(null)
    } finally {
      setIsLoading(false)
    }
  }, [graphMode, selectedSource, sources])

  /* eslint-disable react-hooks/set-state-in-effect -- initial data fetch synchronizes remote state */
  useEffect(() => {
    void loadGraph()
  }, [loadGraph])
  /* eslint-enable react-hooks/set-state-in-effect */


  // Derived from graphData + searchQuery, no separate state needed
  const filteredNodes = useMemo(() => {
    if (!graphData) return []
    if (!searchQuery.trim()) return graphData.nodes
    const q = searchQuery.toLowerCase()
    return graphData.nodes.filter(
      (n) =>
        n.title?.toLowerCase().includes(q) ||
        n.slug?.toLowerCase().includes(q) ||
        n.tags?.some((t) => t.toLowerCase().includes(q))
    )
  }, [searchQuery, graphData])

  const handleNodeClick = (node: { slug: string; page_slug?: string | null; type?: string; title?: string; source_id?: string | null }) => {
    setSelectedSlug(node.slug)
    setError(null)
    // 文件知识图谱的节点 slug 本身就是实际页面 slug；只有代码调用图
    // 的已解析符号才使用 page_slug。不能把 pages 图节点误判为 unresolved。
    if (graphMode === "pages") {
      setNodeNotice(null)
      router.push(`/memory/${encodeURIComponent(node.slug)}${selectedSource !== "__all__" ? `?source_id=${encodeURIComponent(selectedSource)}` : ""}`)
      return
    }
    // 代码调用图中的 unresolved 符号没有对应页面；保留当前图，只显示
    // 节点级提示，不复用全局 error（否则会误显示 source 选择错误）。
    if (!node.page_slug) {
      const label = node.title || node.slug
      setNodeNotice(`${label} 是未解析的代码符号，没有对应的页面可跳转（可能是宏、外部符号或尚未完成解析）`)
      return
    }
    setNodeNotice(null)
    router.push(`/memory/${encodeURIComponent(node.page_slug)}${node.source_id ? `?source_id=${encodeURIComponent(node.source_id)}` : selectedSource !== "__all__" ? `?source_id=${encodeURIComponent(selectedSource)}` : ""}`)
  }

  return (
    <div className="min-h-screen">
      <Header
        title="Knowledge Graph"
        description="记忆图谱可视化"
        onRefresh={loadGraph}
      />

      <div className="p-6 space-y-6">
        {/* Controls */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="搜索节点..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>

          <div className="flex items-center gap-2">
            <label htmlFor="graph-mode" className="whitespace-nowrap text-sm text-muted-foreground">图谱类型</label>
            <select
              id="graph-mode"
              value={graphMode}
              onChange={(event) => {
                setGraphMode(event.target.value as "pages" | "code")
                setSelectedSlug(null)
                setNodeNotice(null)
                setError(null)
              }}
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            >
              <option value="pages">文件知识图谱</option>
              <option value="code">代码调用图</option>
            </select>
          </div>

          <div className="flex items-center gap-2">
            <label htmlFor="graph-source" className="whitespace-nowrap text-sm text-muted-foreground">查询 source</label>
            <select
              id="graph-source"
              value={selectedSource}
              onChange={(event) => {
                setSelectedSource(event.target.value)
                setSelectedSlug(null)
                setNodeNotice(null)
                setError(null)
              }}
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            >
              <option value="__all__">全部 source</option>
              {sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.name && source.name !== source.id ? `${source.name} (${source.id})` : source.id}
                  {source.page_count > 0 ? ` · ${source.page_count}` : ""}
                </option>
              ))}
            </select>
          </div>

          {searchQuery && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm text-muted-foreground whitespace-nowrap">
                找到 {filteredNodes.length} 个节点
              </span>
              <Button variant="outline" size="sm" onClick={() => setSearchQuery("")}>
                清除
              </Button>
            </div>
          )}
        </div>

        {/* Graph area */}
        {isLoading ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-24">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground mb-4" />
              <p className="text-muted-foreground">构建知识图谱...</p>
            </CardContent>
          </Card>
        ) : error ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-24">
              <AlertCircle className="h-12 w-12 text-destructive mb-4" />
              <p className="text-destructive mb-2">{error}</p>
              <p className="text-sm text-muted-foreground mb-4">
                {graphMode === "code"
                  ? "代码调用图需要选择一个具体 source；全部 source 会自动尝试有代码边的 source。"
                  : "请确保 GBrain 服务正在运行，并确认本地 Web 已配置有效 Token。"}
              </p>
              <Button onClick={loadGraph} variant="outline">
                重试
              </Button>
            </CardContent>
          </Card>
        ) : graphData && graphData.nodes.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-24">
              <Network className="h-12 w-12 text-muted-foreground mb-4" />
              <p className="text-muted-foreground">图谱为空</p>
              <p className="text-sm text-muted-foreground mt-1">暂无记忆关联数据</p>
            </CardContent>
          </Card>
        ) : graphData ? (
          <>
            {nodeNotice && (
              <div role="status" className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                {nodeNotice}
              </div>
            )}
            <GraphViewer
            initialTransform={graphTransform}
            onTransformChange={setGraphTransform}
            data={
              searchQuery
                ? {
                    nodes: filteredNodes,
                    edges: graphData.edges.filter(
                      (e) =>
                        filteredNodes.some((n) => n.slug === e.source) &&
                        filteredNodes.some((n) => n.slug === e.target)
                    ),
                  }
                : graphData
            }
            onNodeClick={handleNodeClick}
            selectedSlug={selectedSlug}
          />
          </>
        ) : null}

        {/* Node list (filtered) */}
        {!isLoading && !error && filteredNodes.length > 0 && (
          <Card>
            <CardContent className="p-4">
              <div className="flex flex-wrap gap-2">
                {filteredNodes.slice(0, 50).map((node) => (
                  <Button
                    key={node.slug}
                    variant={selectedSlug === node.slug ? "default" : "outline"}
                    size="sm"
                    onClick={() => handleNodeClick({ slug: node.slug, page_slug: node.page_slug, type: node.type, title: node.title, source_id: node.source_id })}
                    className="text-xs"
                  >
                    {node.title || node.slug}
                  </Button>
                ))}
                {filteredNodes.length > 50 && (
                  <span className="text-xs text-muted-foreground self-center">
                    +{filteredNodes.length - 50} 更多
                  </span>
                )}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
