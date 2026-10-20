"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { Header } from "@/components/layout/Header"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Clock, FileText, Tag, Filter, Search as SearchIcon, Plus, X, Trash2, Folder } from "lucide-react"
import { useGBrainStore } from "@/lib/store"
import { getSourceInventory, listPageBatch, listSources, searchPages, purgePages } from "@/lib/gbrain"
import type { GBrainPage, GBrainSource } from "@/types/gbrain"
import { MemoryEditor } from "@/components/memory/MemoryEditor"
import {
  addStoredFolder,
  folderPathsFromPages,
  isPageInFolderTree,
  isValidFolderPath,
  loadStoredFolders,
  mergeFolderPaths,
  normalizeFolderPath,
  pruneStoredFoldersToPages,
  removeStoredFolderTree,
} from "@/lib/folders"

function formatDate(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  const days = Math.floor(diff / (1000 * 60 * 60 * 24))

  if (days === 0) return "今天"
  if (days === 1) return "昨天"
  if (days < 7) return `${days} 天前`
  if (days < 30) return `${Math.floor(days / 7)} 周前`
  return date.toLocaleDateString("zh-CN")
}

// purge_pages 后端硬性限制单次 1-200 个 slug；超量必须分批。
const MAX_PURGE_SLUGS = 200

/**
 * 通过带权限门的 API 物理删除页面（阶段 3）。服务端逐条校验内容级 owner：
 * 团队 source 内只有内容 owner 本人（或能管整个源者）可删。返回实际删除数。
 */
async function purgePagesViaApi(sourceId: string, slugs: string[]): Promise<number> {
  const response = await fetch("/api/memory/purge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourceId, slugs }),
  })
  const payload = await response.json().catch(() => ({})) as { purged?: number; error?: string }
  if (!response.ok) throw new Error(payload.error || `删除失败（HTTP ${response.status}）`)
  return typeof payload.purged === "number" ? payload.purged : slugs.length
}

type InventoryFolder = { name: string; path: string; source_id?: string | null; source_ids?: string[] | null; subtree_count: number; direct_count: number; child_folder_count: number; sourceIds?: string[] }
type InventoryBatch = { source_id: string; folder: string; total: number; has_more: boolean; pages: GBrainPage[]; folders: InventoryFolder[] }
type SourcePageProgress = Record<string, { offset: number; total: number }>

function mergeFolderInventories(inventories: InventoryFolder[][]): InventoryFolder[] {
  const merged = new Map<string, InventoryFolder>()
  for (const inventory of inventories) {
    for (const item of inventory) {
      const key = item.path
      const sources = item.source_ids ?? item.sourceIds ?? (item.source_id ? [item.source_id] : [])
      const current = merged.get(key)
      if (current) {
        const knownSources = new Set(current.sourceIds ?? [])
        const newSources = sources.filter((sourceId) => !knownSources.has(sourceId))
        // Inventory requests are source-scoped. A source can reappear when a
        // later page is loaded; do not add its same folder counts a second time.
        if (newSources.length > 0) {
          current.subtree_count += item.subtree_count
          current.direct_count += item.direct_count
          current.child_folder_count += item.child_folder_count
          current.sourceIds = Array.from(new Set([...(current.sourceIds ?? []), ...sources]))
        }
      } else {
        merged.set(key, { ...item, sourceIds: sources })
      }
    }
  }
  return Array.from(merged.values()).sort((a, b) => a.path.localeCompare(b.path))
}

function withFolderSource(item: InventoryFolder, sourceId: string): InventoryFolder {
  const sourceIds = item.source_ids?.length ? item.source_ids : item.sourceIds?.length ? item.sourceIds : [sourceId]
  return { ...item, source_id: item.source_id || sourceId, source_ids: sourceIds, sourceIds }
}

async function fetchSourceInventoryBatch(
  sourceId: string,
  folder: string,
  options: { limit: number; offset: number; type?: string; tag?: string; sort?: "updated_desc" | "updated_asc" | "created_desc" | "slug"; recursive?: boolean; includeSourceId?: boolean },
): Promise<InventoryBatch> {
  let inventory: InventoryBatch | null = null
  try {
    inventory = await getSourceInventory(sourceId, folder, {
      ...options,
      includeSourceId: options.includeSourceId,
    })
  } catch {
    // Older servers may not publish source_inventory; use list_pages for root
    // pagination below. A non-root folder cannot be safely guessed from slugs.
  }

  const legacyRecursiveRoot = Boolean(
    inventory && options.recursive && !folder && inventory.total === 0 && inventory.folders.length > 0,
  )
  if (inventory && !legacyRecursiveRoot) {
    return {
      ...inventory,
      folders: inventory.folders.map((item) => withFolderSource(item, sourceId)),
    }
  }

  if (folder) {
    throw new Error(`GBrain 未能返回 ${sourceId}/${folder} 的文件夹清单；请确认服务端版本支持 source_inventory`)
  }

  const batch = await listPageBatch({
    source_id: sourceId,
    type: options.type,
    tag: options.tag,
    sort: options.sort,
    limit: options.limit,
    offset: options.offset,
    include_total: true,
    include_tags: true,
  })
  return {
    source_id: sourceId,
    folder,
    total: batch.total ?? batch.pages.length,
    has_more: batch.has_more === true,
    pages: batch.pages,
    // Legacy recursive calls often returned a root folder whose subtree_count
    // is larger than the root's direct-page total. Flattened page slugs cannot
    // safely rebuild that hierarchy, so retain the authoritative root folders
    // only on the first page; later pages append memory cards, not tree counts.
    folders: options.offset === 0
      ? inventory?.folders.map((item) => withFolderSource(item, sourceId)) ?? []
      : [],

  }
}

async function fetchInventories(sources: string[], folder: string, options: { limit: number; offset: number; type?: string; tag?: string; sort?: "updated_desc" | "updated_asc" | "created_desc" | "slug"; recursive?: boolean; includeSourceId?: boolean }) {
  const results: InventoryBatch[] = []
  const failures: string[] = []
  const concurrency = 4
  for (let index = 0; index < sources.length; index += concurrency) {
    const group = sources.slice(index, index + concurrency)
    const settled = await Promise.allSettled(group.map((sourceId) => fetchSourceInventoryBatch(
      sourceId,
      folder,
      { ...options, includeSourceId: options.includeSourceId ?? sources.length > 1 },
    )))
    settled.forEach((result, itemIndex) => {
      if (result.status === "fulfilled") results.push(result.value)
      else failures.push(`${group[itemIndex]}: ${result.reason instanceof Error ? result.reason.message : "加载失败"}`)
    })
  }
  if (results.length === 0 && failures.length > 0) {
    throw new Error(`所有 source 的目录加载都失败：${failures.join("；")}`)
  }
  return { batches: results, failures }
}

function chunkSlugs(slugs: string[], size: number): string[][] {
  const batches: string[][] = []
  for (let i = 0; i < slugs.length; i += size) {
    batches.push(slugs.slice(i, i + size))
  }
  return batches
}

const typeColors: Record<string, string> = {
  concept: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300",
  project: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300",
  decision: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-300",
  note: "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300",
  person: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300",
  default: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300",
}

export default function MemoryLibraryPage() {
  const [searchQuery, setSearchQuery] = useState("")
  const [allTags, setAllTags] = useState<string[]>([])
  const [showFilters, setShowFilters] = useState(false)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [folder, setFolder] = useState("")
  const [, setFolderPaths] = useState<string[]>([])
  const [folderLoading, setFolderLoading] = useState(true)
  const [showFolderForm, setShowFolderForm] = useState(false)
  const [newFolder, setNewFolder] = useState("")
  const [folderError, setFolderError] = useState<string | null>(null)
  const [selectedFolders, setSelectedFolders] = useState<string[]>([])
  const [isDeletingFolders, setIsDeletingFolders] = useState(false)
  const [folderDeleteNotice, setFolderDeleteNotice] = useState<string | null>(null)
  const [isPermanentFolderDelete, setIsPermanentFolderDelete] = useState(false)
  const [deletingSlug, setDeletingSlug] = useState<string | null>(null)
  // 列表"窗口"渲染上限：数据仍全量在内存（搜索/筛选作用全量），但 DOM 只挂载
  // 前 visibleCount 个卡片。默认 48，防 8 千条记忆一次全量渲染拖垮首帧/整页。
  // 滚动到底自动 +48（INFO_WINDOW_STEP）。
  const INFO_WINDOW_STEP = 48
  const [visibleCount, setVisibleCount] = useState(INFO_WINDOW_STEP)
  const [pageTotal, setPageTotal] = useState(0)
  const [, setPageOffset] = useState(0)
  const [sourceProgress, setSourceProgress] = useState<SourcePageProgress>({})
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [inventoryFolders, setInventoryFolders] = useState<InventoryFolder[]>([])
  const [serverSearchResults, setServerSearchResults] = useState<GBrainPage[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const pageCache = useRef(new Map<string, { pages: GBrainPage[]; tags: string[]; folders: string[]; total: number; inventoryFolders: InventoryFolder[]; sourceProgress: SourcePageProgress }>())
  const sourcesLoaded = useRef(false)
  const sourceListRef = useRef<GBrainSource[]>([])
  // 带归属域的 source 列表（用于下拉分组：个人 / 团队·xx / 系统 / 未注册）
  const [groupedSources, setGroupedSources] = useState<Array<{ id: string; name: string; pageCount: number; scope: string; namespace: string }>>([])

  const {
    pages,
    setPages,
    error,
    sources,
    setSources,
    filterSource,
    setFilterSource,
    filterType,
    setFilterType,
    filterTag,
    setFilterTag,
    sortOrder,
    setSortOrder,
    setLoading,
    setError,
  } = useGBrainStore()

  // 当前选中的 source（下拉）— 传给 list_pages 作为 source_id
  const activeSourceId = filterSource || undefined
  const pageSourceId = (page: { source_id?: string }) => page.source_id || activeSourceId

  const loadData = useCallback(async (force = false) => {
    if (force) {
      pageCache.current.clear()
      sourcesLoaded.current = false
    }
    await Promise.resolve()
    setLoading(true)
    setFolderLoading(true)
    setError(null)
    try {
      // listSources() 已由服务端按归属域过滤（/api/sources/grouped，唯一裁决点见
      // lib/visible-sources.ts）—— 早前这里还要再取一次 grouped 做前端交集，
      // 因为 listSources() 当时返回的是 gbrain 的部署级列表。现已收敛到一处。
      let grouped: typeof groupedSources = groupedSources
      if (!sourcesLoaded.current) {
        try {
          const groupedResponse = await fetch("/api/sources/grouped", { cache: "no-store" })
          if (groupedResponse.ok) {
            const payload = await groupedResponse.json() as { sources?: typeof groupedSources }
            grouped = payload.sources ?? []
            setGroupedSources(grouped)
          }
        } catch { /* 分组展示降级：不影响可见性过滤（已由 listSources 完成） */ }
      }
      const sourcesData = sourcesLoaded.current ? sourceListRef.current : await listSources()
      if (sourcesData.length === 0) throw new Error("未从 GBrain 获取到可访问的 source 列表；请检查服务连接和授权")
      if (!sourcesLoaded.current) {
        sourcesLoaded.current = true
        sourceListRef.current = sourcesData
        if (sources.length === 0) setSources(sourcesData)
      }

      const cacheKey = JSON.stringify({ source: activeSourceId || "__all__", folder, sort: sortOrder, type: filterType || "", tag: filterTag || "" })
      const cached = pageCache.current.get(cacheKey)
      if (cached) {
        setPages(cached.pages)
        setAllTags(cached.tags)
        setFolderPaths(cached.folders)
        setInventoryFolders(cached.inventoryFolders)
        setPageTotal(cached.total)
        setPageOffset(cached.pages.length)
        setSourceProgress(cached.sourceProgress)
        setFolderLoading(false)
        setLoading(false)
        return
      }

      // An unqualified list_pages call follows the server's ambient source
      // scope and excludes non-federated SDK sources. Enumerate each visible
      // source explicitly so “全部 source” really means all source pages.
      const sourceIds = activeSourceId ? [activeSourceId] : sourcesData.map((source) => source.id)
      if (sourceIds.length === 0) throw new Error("没有找到当前账号可访问的 source；请检查 GBrain 连接和 source 权限")
      const inventoryResult = await fetchInventories(sourceIds, folder, { limit: INFO_WINDOW_STEP, offset: 0, type: filterType || undefined, tag: filterTag || undefined, sort: sortOrder, recursive: folder.length === 0, includeSourceId: !activeSourceId })
      const batches = inventoryResult.batches
      const pagesData = batches.flatMap((batch) => batch.pages)
      const total = batches.reduce((sum, batch) => sum + batch.total, 0)
      const nextProgress = Object.fromEntries(batches.map((batch) => [batch.source_id, { offset: batch.pages.length, total: batch.total }])) as SourcePageProgress
      if (inventoryResult.failures.length > 0) {
        setError(`部分 source 加载失败（已显示可访问的数据）：${inventoryResult.failures.join("；")}`)
      }
      const nextInventoryFolders = mergeFolderInventories(batches.map((batch) => batch.folders))
      setInventoryFolders(nextInventoryFolders)
      setSourceProgress(nextProgress)

      const tags = Array.from(new Set(pagesData.flatMap((page) => page.tags || []))).sort()
      const discoveredFolders = folderPathsFromPages(pagesData)
      const cleanedStored = pruneStoredFoldersToPages(pagesData)
      const nextFolders = mergeFolderPaths(cleanedStored, discoveredFolders)
      pageCache.current.set(cacheKey, { pages: pagesData, tags, folders: nextFolders, total, inventoryFolders: nextInventoryFolders, sourceProgress: nextProgress })
      setFolderPaths(nextFolders)
      setPages(pagesData)
      setAllTags(tags)
      setPageTotal(total)
      setPageOffset(pagesData.length)
      setFolderLoading(false)
    } catch (err) {
      console.error("Failed to load memory library:", err)
      sourcesLoaded.current = false
      setError(err instanceof Error ? err.message : "加载记忆失败")
      setPages([])
      setAllTags([])
      setFolderPaths([])
      setInventoryFolders([])
      setPageTotal(0)
      setPageOffset(0)
      setSourceProgress({})
      setFolderLoading(false)
    } finally {
      setLoading(false)
    }
  }, [activeSourceId, filterTag, filterType, folder, setError, setLoading, setPages, setSources, sortOrder, sources.length])

  useEffect(() => {
    void Promise.resolve().then(() => loadData())
  }, [loadData])

  // 切换 source 时重置文件夹位置，避免停留在旧 source 的路径
  useEffect(() => {
    setFolder("")
    setSelectedFolders([])
  }, [filterSource])

  useEffect(() => {
    const query = searchQuery.trim()
    if (!query || !activeSourceId) {
      setServerSearchResults([])
      setIsSearching(false)
      return
    }
    const controller = new AbortController()
    setIsSearching(true)
    const timer = window.setTimeout(() => {
      void searchPages({ query, limit: 48, source_id: activeSourceId, snippet_chars: 0, ...(filterType ? { types: [filterType] } : {}) })
        .then((results) => {
          if (controller.signal.aborted) return
          setServerSearchResults(results.map((result) => ({
            slug: result.slug, title: result.title, type: result.type,
            updated_at: "", source_id: result.source_id, tags: [],
          })))
        })
        .catch((err) => {
          if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "搜索失败")
        })
        .finally(() => {
          if (!controller.signal.aborted) setIsSearching(false)
        })
    }, 250)
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [activeSourceId, filterType, searchQuery, setError])

  useEffect(() => {
    const refreshFolders = () => {
      const stored = loadStoredFolders()
      setFolderPaths((current) => mergeFolderPaths(stored, current))
    }
    refreshFolders()
    window.addEventListener("gbrain-folders-changed", refreshFolders)
    return () => window.removeEventListener("gbrain-folders-changed", refreshFolders)
  }, [])

  const visibleFolderPages = useMemo(
    () => pages.filter((page) => isPageInFolderTree(page, folder)),
    [folder, pages],
  )

  const childFolders = useMemo(
    () => Array.from(new Set(inventoryFolders.map((item) => item.path))).sort(),
    [inventoryFolders],
  )

  // 每个文件夹子树内的页面总数（含所有后代）。DSP 这类深层目录里
  // 中间文件夹可能没有任何直接文件，只有子文件夹 —— 卡片上显示一个
  // 文件数徽标，避免用户误以为文件夹是空的。
  const folderInventoryByPath = useMemo(() => {
    const map = new Map<string, InventoryFolder>()
    for (const item of inventoryFolders) {
      const current = map.get(item.path)
      if (current) {
        current.subtree_count += item.subtree_count
        current.direct_count += item.direct_count
        current.child_folder_count += item.child_folder_count
        current.sourceIds = Array.from(new Set([...(current.sourceIds ?? []), ...(item.sourceIds ?? (item.source_id ? [item.source_id] : []))]))
      } else {
        map.set(item.path, { ...item, sourceIds: item.sourceIds ?? (item.source_id ? [item.source_id] : []) })
      }
    }
    return map
  }, [inventoryFolders])
  const folderSubtreeCount = useMemo(
    () => new Map(Array.from(folderInventoryByPath, ([path, item]) => [path, item.subtree_count])),
    [folderInventoryByPath],
  )

  const handleCreateFolder = () => {
    const normalized = normalizeFolderPath(newFolder)
    if (!isValidFolderPath(normalized)) {
      setFolderError("文件夹名称只能包含小写字母、数字、下划线、短横线和斜线")
      return
    }
    addStoredFolder(normalized)
    setFolderPaths((current) => mergeFolderPaths(current.map((path) => ({ path, createdAt: "" })), [normalized]))
    setNewFolder("")
    setFolderError(null)
    setShowFolderForm(false)
    setFolder(normalized)
  }

  const filteredPages = useMemo(() => {
    if (!searchQuery.trim()) return visibleFolderPages
    if (activeSourceId) return serverSearchResults.filter((page) => !filterType || page.type === filterType)

    const q = searchQuery.toLowerCase()
    return visibleFolderPages.filter(
      (page) => page.title?.toLowerCase().includes(q) || page.slug?.toLowerCase().includes(q)
    )
  }, [activeSourceId, filterType, searchQuery, serverSearchResults, visibleFolderPages])

  // 数据源变化（切 source / 筛选 / 搜索 / 文件夹）时重置分页窗口，避免
  // 新筛选下仍停留在旧的大窗口或空窗口。
  const windowKey = `${filterSource}|${filterType}|${filterTag}|${searchQuery}|${folder}`
  useEffect(() => {
    setVisibleCount(INFO_WINDOW_STEP)
  }, [windowKey])

  // 列表只渲染前 visibleCount 条；数据本身仍全量在 pages/filteredPages，
  // 所以计数"共 X 条记忆"与搜索/筛选结果都是全量的。
  const visibleWindow = useMemo(() => filteredPages.slice(0, visibleCount), [filteredPages, visibleCount])
  const hasMoreVisible = filteredPages.length > visibleCount
  const hasMorePages = Object.values(sourceProgress).some((progress) => progress.offset < progress.total)

  const loadMorePages = async () => {
    if (isLoadingMore || !hasMorePages) return
    setIsLoadingMore(true)
    try {
      const pendingSources = Object.entries(sourceProgress).filter(([, progress]) => progress.offset < progress.total)
      const settled = await Promise.allSettled(pendingSources.map(async ([sourceId, progress]) => {
        return fetchSourceInventoryBatch(sourceId, folder, {
          limit: INFO_WINDOW_STEP,
          offset: progress.offset,
          type: filterType || undefined,
          tag: filterTag || undefined,
          sort: sortOrder,
          recursive: folder.length === 0,
          includeSourceId: !activeSourceId,
        })
      }))
      const nextBatches = settled.flatMap((result, index) => {
        if (result.status === "fulfilled") return [result.value]
        setError(`source ${pendingSources[index][0]} 加载更多失败：${result.reason instanceof Error ? result.reason.message : "未知错误"}`)
        return []
      })
      if (nextBatches.length === 0) return
      const appended = nextBatches.flatMap((batch) => batch.pages)
      const merged = [...pages, ...appended]
      const nextProgress = { ...sourceProgress }
      for (const batch of nextBatches) {
        nextProgress[batch.source_id] = { offset: nextProgress[batch.source_id].offset + batch.pages.length, total: batch.total }
      }
      const nextTags = Array.from(new Set(merged.flatMap((page) => page.tags || []))).sort()
      const nextFolders = folderPathsFromPages(merged)
      setPages(merged)
      setPageOffset(merged.length)
      setSourceProgress(nextProgress)
      setAllTags(nextTags)
      setFolderPaths(nextFolders)
      const nextInventoryFolders = activeSourceId
        ? nextBatches[0]?.folders ?? inventoryFolders
        : mergeFolderInventories([inventoryFolders, ...nextBatches.map((batch) => batch.folders)])
      setInventoryFolders(nextInventoryFolders)
      const cacheKey = JSON.stringify({ source: activeSourceId || "__all__", folder, sort: sortOrder, type: filterType || "", tag: filterTag || "" })
      pageCache.current.set(cacheKey, { pages: merged, tags: nextTags, folders: nextFolders, total: pageTotal, inventoryFolders: nextInventoryFolders, sourceProgress: nextProgress })
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载更多记忆失败")
    } finally {
      setIsLoadingMore(false)
    }
  }

  const clearFilters = () => {
    setFilterSource(null)
    setFilterType(null)
    setFilterTag(null)
    setSearchQuery("")
  }

  const handleCreate = () => {
    setShowCreateForm(false)
    setCreateError(null)
    void loadData()
  }

  const toggleFolderSelection = (path: string) => {
    setSelectedFolders((current) => current.includes(path)
      ? current.filter((item) => item !== path)
      : [...current, path])
  }

  const handleDeleteSelectedFolders = async () => {
    if (selectedFolders.length === 0 || isDeletingFolders) return
    if (filterType || filterTag) {
      setError("永久删除文件夹前请先清除类型和标签筛选")
      return
    }
    if (!activeSourceId) {
      setError("永久删除时请先选择一个具体 source；请逐个 source 操作，避免跨 source 批量误删")
      return
    }
    const sourceIdsToDelete = [activeSourceId]
    const groups = new Map<string, GBrainPage[]>()
    const uniquePages = new Map<string, GBrainPage>()
    setIsDeletingFolders(true)
    setError(null)
    try {
      // Selection can span more pages than the current UI batch (48). Enumerate
      // the complete subtree from the server, source-scoped and paginated, before
      // building the dry-run preview. The synthetic top-level `source` folder
      // maps to the source-relative root, not a literal `source/` subdirectory.
      for (const sourceId of sourceIdsToDelete) {
        for (const selectedFolder of selectedFolders) {
          const relativeFolder = selectedFolder === "source" ? "" : selectedFolder
          let offset = 0
          let expectedTotal: number | undefined
          while (expectedTotal === undefined || offset < expectedTotal) {
            const inventory = await getSourceInventory(sourceId, relativeFolder, {
              limit: 100,
              offset,
              recursive: true,
            })
            if (inventory.source_id !== sourceId || inventory.folder !== relativeFolder) {
              throw new Error(`source ${sourceId} 返回的文件夹预览范围不匹配，未执行删除`)
            }
            if (expectedTotal === undefined) expectedTotal = inventory.total
            else if (inventory.total !== expectedTotal) {
              throw new Error(`source ${sourceId} 的文件夹内容在预览期间发生变化，请刷新后重试`)
            }
            if (inventory.pages.length === 0 && offset < expectedTotal) {
              throw new Error(`source ${sourceId} 的文件夹分页不完整，未执行删除`)
            }
            for (const page of inventory.pages) {
              if (page.source_id !== sourceId) {
                throw new Error(`页面 ${page.slug} 的 source 不匹配，未执行删除`)
              }
              uniquePages.set(`${sourceId}:${page.slug}`, page)
            }
            offset += inventory.pages.length
            if (!inventory.has_more) break
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "无法完整枚举选中文件夹，未执行删除")
      setIsDeletingFolders(false)
      return
    }
    for (const page of uniquePages.values()) {
      const sourceId = page.source_id
      if (!sourceId) {
        setError(`页面 ${page.slug} 缺少 source_id，无法安全删除`)
        setIsDeletingFolders(false)
        return
      }
      groups.set(sourceId, [...(groups.get(sourceId) ?? []), page])
    }
    setIsDeletingFolders(false)
    const allSelectedPages = Array.from(groups.values()).flat()
    if (allSelectedPages.length === 0) {
      setError("选中的文件夹中没有可删除页面；请刷新后重试")
      return
    }
    // 每个 source 的 slug 分批（后端单次最多 200，超量报 1-200 slugs 错误）
    let batchCount = 0
    const batches: { sourceId: string; pages: GBrainPage[]; slugs: string[] }[] = []
    for (const [sourceId, sourcePages] of groups) {
      for (const batch of chunkSlugs(sourcePages.map((page) => page.slug), MAX_PURGE_SLUGS)) {
        const slugSet = new Set(batch)
        batches.push({
          sourceId,
          pages: sourcePages.filter((page) => slugSet.has(page.slug)),
          slugs: batch,
        })
        batchCount += 1
      }
    }

    setIsDeletingFolders(true)
    try {
      // 先对每一批 dry-run，全部命中才进入确认
      for (const batch of batches) {
        const result = await purgePages(batch.slugs, batch.sourceId, true) as { status?: string; found?: number }
        if (result.status !== "dry_run" || result.found !== batch.slugs.length) {
          throw new Error(`预览删除失败：${batch.sourceId} 预计 ${batch.slugs.length} 页，后端只找到 ${result.found ?? 0} 页`)
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "无法确认删除范围，未执行删除")
      setIsDeletingFolders(false)
      return
    }
    setIsDeletingFolders(false)

    const batchNote = batchCount > 1 ? `（将分 ${batchCount} 批，每批最多 ${MAX_PURGE_SLUGS} 个文件）` : ""
    const confirmed = window.confirm(
      `确定永久删除选中的 ${selectedFolders.length} 个文件夹及其中的 ${allSelectedPages.length} 个文件吗？${batchNote}\n\n` +
      "此操作不可恢复，将删除 PostgreSQL 页面、chunks、embeddings、links、代码边和图谱数据；不会删除原始 SDK 文件。",
    )
    if (!confirmed) return

    setIsDeletingFolders(true)
    setError(null)
    setFolderDeleteNotice(null)
    setIsPermanentFolderDelete(true)
    const succeededPages: GBrainPage[] = []
    const failedBatches: { sourceId: string; count: number; reason: string }[] = []
    try {
      // 逐批顺序执行；某个批次失败只记录，继续其余批次，最后如实报告部分成功
      for (const batch of batches) {
        try {
          // 走带权限门的 API（内容级 owner 校验）；返回实际删除数。
          const purged = await purgePagesViaApi(batch.sourceId, batch.slugs)
          if (purged < batch.slugs.length) {
            throw new Error(`仅 ${purged}/${batch.slugs.length} 页有权删除；其余为他人上传（团队 source 只能删自己传的）`)
          }
          succeededPages.push(...batch.pages)
        } catch (err) {
          console.error(`Failed to purge batch (${batch.sourceId}, ${batch.slugs.length} 页):`, err)
          failedBatches.push({
            sourceId: batch.sourceId,
            count: batch.slugs.length,
            reason: err instanceof Error ? err.message : "后端拒绝永久删除",
          })
        }
      }

      const deleted = new Set(succeededPages.map((page) => `${pageSourceId(page)}:${page.slug}`))
      setPages(pages.filter((page) => !deleted.has(`${pageSourceId(page)}:${page.slug}`)))

      if (failedBatches.length === 0) {
        removeStoredFolderTree(selectedFolders)
        setFolderPaths((current) => current.filter((path) => (
          !selectedFolders.some((target) => path === target || path.startsWith(`${target}/`))
        )))
        setSelectedFolders([])
        setFolderDeleteNotice(`已永久删除 ${succeededPages.length} 个文件，${selectedFolders.length} 个文件夹已移除`)
        await loadData(true)
      } else {
        const firstFailure = failedBatches[0]?.reason ?? "后端拒绝永久删除"
        const permissionHint = /scope|permission|admin|unauthorized|forbidden/i.test(firstFailure)
          ? "当前 Token 需要 admin 权限，请在 Settings 更换可执行永久删除的 Token。"
          : "请刷新后重试。"
        const failedCount = failedBatches.reduce((sum, batch) => sum + batch.count, 0)
        setError(`已永久删除 ${succeededPages.length} 个文件，但 ${failedBatches.length} 个批次（共 ${failedCount} 个文件）删除失败；${permissionHint}`)
        if (succeededPages.length > 0) await loadData()
      }
    } catch (err) {
      console.error("Failed to permanently delete selected folders:", err)
      setError(err instanceof Error ? err.message : "永久删除文件夹失败")
    } finally {
      setIsPermanentFolderDelete(false)
      setIsDeletingFolders(false)
    }
  }

  const handleDeletePage = async (page: { slug: string; title?: string; source_id?: string }) => {
    const confirmed = window.confirm(
      `确定要删除“${page.title || page.slug}”吗？此操作不可恢复，将永久删除该页面（页面 + 数据库），并受内容级权限限制。`
    )
    if (!confirmed) return
    setDeletingSlug(page.slug)
    setError(null)
    try {
      await purgePagesViaApi(pageSourceId(page) || "default", [page.slug])
      setPages(pages.filter((p) => !(`${pageSourceId(p) || "default"}:${p.slug}` === `${pageSourceId(page) || "default"}:${page.slug}`)))
    } catch (err) {
      console.error("Failed to delete page:", err)
      setError(err instanceof Error ? err.message : "删除失败")
    } finally {
      setDeletingSlug(null)
    }
  }

  const hasFilters = Boolean(filterSource || filterType || filterTag || searchQuery)

  return (
    <div className="min-h-screen">
      <Header
        title="Memory Library"
        description="浏览和管理所有记忆"
        onRefresh={() => void loadData(true)}
        action={
          <Button
            onClick={() => {
              setCreateError(null)
              setShowCreateForm(true)
            }}
            className="gap-1.5"
          >
            <Plus className="h-4 w-4" />
            新建记忆
          </Button>
        }
      />

      <div className="p-6 space-y-6">
        {showCreateForm && (
          <Card>
            <CardContent className="p-6">
              <div className="mb-4 flex items-start justify-between">
                <div>
                  <h2 className="text-lg font-semibold">新建记忆</h2>
                  <p className="text-sm text-muted-foreground mt-1">
                    保存后会通过 MCP 的 put_page 真实写入 gbrain。
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setShowCreateForm(false)}
                  aria-label="关闭新建表单"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
              {createError && (
                <div className="mb-4 rounded bg-destructive/10 p-3 text-sm text-destructive">
                  {createError}
                </div>
              )}
              <MemoryEditor
                mode="create"
                initialSlug={folder ? `${folder}/` : ""}
                initialContent=""
                initialType="note"
                onSave={handleCreate}
                onCancel={() => setShowCreateForm(false)}
              />
            </CardContent>
          </Card>
        )}

        {/* 搜索和过滤栏 */}
        <div className="flex flex-col gap-4 sm:flex-row">
          <div className="relative flex-1">
            <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="搜索记忆..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>
          <Button
            variant="outline"
            onClick={() => setShowFilters(!showFilters)}
            className="gap-2"
          >
            <Filter className="h-4 w-4" />
            筛选
            {hasFilters && (
              <span className="ml-1 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-xs text-primary-foreground">
                {(filterSource ? 1 : 0) + (filterType ? 1 : 0) + (filterTag ? 1 : 0) + (searchQuery ? 1 : 0)}
              </span>
            )}
          </Button>
          {/* Source 下拉：按归属域分组（个人 / 团队 / 系统 / 未注册），照 Wegent 的个人-团队分离。 */}
          <select
            value={filterSource ?? ""}
            onChange={(e) => setFilterSource(e.target.value || null)}
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
            aria-label="按 source 筛选"
          >
            <option value="">全部 source</option>
            {(() => {
              if (groupedSources.length === 0) {
                // 降级：拿不到归属信息时用平面列表。
                return sources.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.name && source.name !== source.id ? `${source.name} (${source.id})` : source.id}
                    {source.page_count > 0 ? ` · ${source.page_count}` : ""}
                  </option>
                ))
              }
              const groups: Array<{ key: string; label: string; items: typeof groupedSources }> = [
                { key: "personal", label: "个人", items: [] },
                { key: "system", label: "系统", items: [] },
                { key: "unregistered", label: "其他（未配置归属）", items: [] },
              ]
              const teamGroups = new Map<string, typeof groupedSources>()
              for (const item of groupedSources) {
                if (item.scope === "personal") groups[0].items.push(item)
                else if (item.scope === "system") groups[1].items.push(item)
                else if (item.scope === "team") {
                  const list = teamGroups.get(item.namespace) ?? []
                  list.push(item)
                  teamGroups.set(item.namespace, list)
                } else groups[2].items.push(item)
              }
              const teamEntries = Array.from(teamGroups.entries()).map(([namespace, items]) => ({ key: `team:${namespace}`, label: `团队 · ${namespace}`, items }))
              const all = [...groups, ...teamEntries]
              const renderOption = (item: typeof groupedSources[number]) => (
                <option key={item.id} value={item.id}>
                  {item.name && item.name !== item.id ? `${item.name} (${item.id})` : item.id}
                  {item.pageCount > 0 ? ` · ${item.pageCount}` : ""}
                </option>
              )
              return all.filter((group) => group.items.length > 0).map((group) => (
                <optgroup key={group.key} label={group.label}>
                  {group.items.map(renderOption)}
                </optgroup>
              ))
            })()}
          </select>
          <select
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value as typeof sortOrder)}
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
          >
            <option value="updated_desc">最近更新</option>
            <option value="updated_asc">最早更新</option>
            <option value="created_desc">最近创建</option>
            <option value="slug">按 slug</option>
          </select>
        </div>

        {/* 过滤面板 */}
        {showFilters && (
          <Card>
            <CardContent className="p-4">
              <div className="flex flex-wrap gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">类型</label>
                  <div className="flex flex-wrap gap-2">
                    {["person", "company", "concept", "project", "decision", "note"].map((type) => (
                      <Button
                        key={type}
                        variant={filterType === type ? "default" : "outline"}
                        size="sm"
                        onClick={() => setFilterType(filterType === type ? null : type)}
                      >
                        {type}
                      </Button>
                    ))}
                  </div>
                </div>

                {allTags.length > 0 && (
                  <div className="space-y-2">
                    <label className="text-sm font-medium">标签</label>
                    <div className="flex flex-wrap gap-2">
                      {allTags.slice(0, 15).map((tag) => (
                        <Button
                          key={tag}
                          variant={filterTag === tag ? "default" : "outline"}
                          size="sm"
                          onClick={() => setFilterTag(filterTag === tag ? null : tag)}
                        >
                          {tag}
                        </Button>
                      ))}
                    </div>
                  </div>
                )}

                {hasFilters && (
                  <Button variant="ghost" size="sm" onClick={clearFilters}>
                    清除筛选
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {showFolderForm && (
          <Card>
            <CardContent className="flex flex-wrap items-end gap-3 p-4">
              <div className="min-w-64 flex-1 space-y-1.5">
                <label htmlFor="new-folder" className="text-sm font-medium">新文件夹路径</label>
                <Input
                  id="new-folder"
                  value={newFolder}
                  onChange={(event) => setNewFolder(event.target.value)}
                  placeholder="例如 ics/aurora-x1"
                />
              </div>
              <Button onClick={handleCreateFolder}>创建文件夹</Button>
              <Button variant="ghost" onClick={() => setShowFolderForm(false)}>取消</Button>
              {folderError && <p className="basis-full text-sm text-destructive">{folderError}</p>}
            </CardContent>
          </Card>
        )}

        {folderDeleteNotice && (
          <div role="status" className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800 dark:border-green-900 dark:bg-green-950/30 dark:text-green-200">
            {folderDeleteNotice}
          </div>
        )}
        {error && (
          <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">文件夹：</span>
          <Button variant={!folder ? "default" : "outline"} size="sm" onClick={() => setFolder("")}>全部</Button>
          {folder && (
            <>
              {folder.split("/").map((segment, index, parts) => {
                const path = parts.slice(0, index + 1).join("/")
                return <Button key={path} variant="outline" size="sm" onClick={() => setFolder(path)}>{segment}</Button>
              })}
            </>
          )}
          <Button variant="outline" size="sm" onClick={() => setShowFolderForm(true)}>+ 新建文件夹</Button>
          {selectedFolders.length > 0 && (
            <Button
              variant="destructive"
              size="sm"
              className="gap-1.5"
              onClick={() => void handleDeleteSelectedFolders()}
              disabled={isDeletingFolders}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {isDeletingFolders ? (isPermanentFolderDelete ? "永久删除中..." : "删除中...") : `永久删除选中文件夹 (${selectedFolders.length})`}
            </Button>
          )}
        </div>

        {folderLoading ? (
          <div role="status" className="rounded-lg border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
            正在加载文件夹...
          </div>
        ) : childFolders.length > 0 ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {childFolders.map((child) => {
              const selected = selectedFolders.includes(child)
              const childSourceIds = folderInventoryByPath.get(child)?.sourceIds ?? []
              return (
                <div
                  key={child}
                  className={`relative rounded-lg border bg-card p-4 text-left transition-colors hover:bg-muted ${selected ? "border-primary ring-2 ring-primary/20" : ""}`}
                >
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={() => toggleFolderSelection(child)}
                    disabled={!activeSourceId && childSourceIds.length > 1}
                    aria-label={`选择文件夹 ${child}`}
                    className="absolute right-3 top-3 h-4 w-4 accent-primary"
                  />
                  <button
                    type="button"
                    onClick={() => setFolder(child)}
                    className="w-full text-left"
                  >
                    <div className="text-sm font-medium">📁 {child.split("/").pop()}</div>
                    <div className="mt-1 text-xs text-muted-foreground">{child}</div>
                    <div className="mt-1 inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                      <Folder className="h-3 w-3" />
                      {folderSubtreeCount.get(child) ?? 0} 个子文件
                      {!activeSourceId && childSourceIds.length > 1 && <span>· 跨 {childSourceIds.length} 个 source</span>}
                    </div>
                  </button>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
            暂无文件夹
          </div>
        )}

        <div className="text-sm text-muted-foreground">
          {isSearching ? "正在搜索..." : `共 ${activeSourceId && searchQuery.trim() ? "约 " : ""}${filteredPages.length} 条记忆`}
          {filterSource && ` · source: ${filterSource}`}
          {folder && ` · 文件夹: ${folder}`}
          {filterType && ` · 类型: ${filterType}`}
          {filterTag && ` · 标签: ${filterTag}`}
        </div>

        {folderLoading ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <FileText className="h-12 w-12 animate-pulse text-muted-foreground mb-4" />
              <p className="text-muted-foreground">正在加载记忆数据...</p>
            </CardContent>
          </Card>
        ) : filteredPages.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <FileText className="h-12 w-12 text-muted-foreground mb-4" />
              <p className="text-muted-foreground">暂无记忆数据</p>
              {hasFilters && (
                <Button variant="link" onClick={clearFilters} className="mt-2">
                  清除筛选
                </Button>
              )}
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {visibleWindow.map((page) => (
              <Link
                key={`${page.source_id || "default"}:${page.slug}`}
                href={`/memory/${encodeURIComponent(page.slug)}${page.source_id ? `?source_id=${encodeURIComponent(page.source_id)}` : ""}`}
              >
                <Card className="group relative h-full transition-colors hover:bg-muted/50">
                  <CardContent className="p-4">
                    <button
                      type="button"
                      aria-label="删除此记忆"
                      onClick={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        void handleDeletePage(page)
                      }}
                      disabled={deletingSlug === page.slug}
                      className="absolute right-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                    <div className="flex items-start gap-3">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                        <FileText className="h-5 w-5 text-muted-foreground" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <h3 className="font-medium truncate">{page.title}</h3>
                        <p className="text-xs text-muted-foreground truncate mt-0.5">
                          {page.slug}
                        </p>
                      </div>
                    </div>

                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      {page.type && (
                        <span className={`px-2 py-0.5 rounded text-xs ${typeColors[page.type] || typeColors.default}`}>
                          {page.type}
                        </span>
                      )}
                      {page.tags?.slice(0, 2).map((tag) => (
                        <span
                          key={tag}
                          className="flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-muted"
                        >
                          <Tag className="h-2.5 w-2.5" />
                          {tag}
                        </span>
                      ))}
                    </div>

                    <div className="mt-3 flex items-center gap-1 text-xs text-muted-foreground">
                      <Clock className="h-3 w-3" />
                      {formatDate(page.updated_at)}
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}
        {(hasMoreVisible || hasMorePages) && (
          <div className="mt-4 flex justify-center">
            <Button
              variant="outline"
              size="sm"
              disabled={isLoadingMore}
              onClick={() => {
                if (hasMoreVisible) setVisibleCount((count) => count + INFO_WINDOW_STEP)
                else void loadMorePages()
              }}
            >
              {isLoadingMore ? "加载中..." : hasMoreVisible ? `加载更多（已显示 ${visibleWindow.length} / ${filteredPages.length}）` : `加载更多（已加载 ${pages.length} / ${pageTotal}）`}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
