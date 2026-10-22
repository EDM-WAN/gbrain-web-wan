"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Header } from "@/components/layout/Header"
import { UserSearchSelect } from "@/components/UserSearchSelect"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { AlertCircle, Clock, Code2, FolderSearch, Loader2, ListChecks, Play, Plus, Save, Square, Zap } from "lucide-react"
import type { SdkSourceConfig, SdkSourceKind } from "@/lib/sdk-sources"
import { inferManifestSourceId, validateManifestUrl, type ManifestToolChoice } from "@/lib/manifest-shared"

interface ScanFile {
  relativePath: string
  language: string | null
  category: "code" | "document"
  sizeBytes: number
}

interface ScanResult {
  root: string
  totalFiles: number
  codeFiles: number
  documentFiles: number
  skippedFiles: number
  skippedDirectories: number
  truncated: boolean
  byExtension: Record<string, number>
  byLanguage: Record<string, number>
  files: ScanFile[]
}

interface IndexJob {
  id: string
  sourceId: string
  root: string
  status: "queued" | "running" | "completed" | "failed"
  startedAt?: string
  finishedAt?: string
  message?: string
  processed?: number
  total?: number
  exitCode?: number | null
  output: string[]
  /** "minion" = persisted 在 gbrain minions 队列;undefined = 本进程内子进程。 */
  queue?: "minion"
  minionId?: number
  mode?: "sync" | "import" | "manifest"
}

interface SourceTaskProgress {
  id: number
  name: "import" | "sync" | "embed" | "embed-backfill"
  status: string
  progress?: { done?: number; total?: number; embedded?: number; phase?: string } | null
  result?: { embedded?: number; embedding_remaining?: number; import_errors?: number; failures?: number } | null
  error_text?: string | null
}

const ACTIVE_JOB_STORAGE_KEY = "gbrain-code-index-job-id"

/** /api/code-source/config 的响应形状（阶段 2 加了 permissions/currentUser）。 */
interface ConfigPayload {
  configs?: SdkSourceConfig[]
  sources?: { sources?: Array<{ id: string; local_path: string | null; page_count: number; archived?: boolean; archive_expires_at?: string | null }> }
  permissions?: Array<{ sourceId: string; canManage: boolean; canUpload: boolean }>
  currentUser?: { id: number; userName: string; role: "admin" | "user" }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function jobHasImportFailure(job: IndexJob): boolean {
  if (job.status === "failed" || job.message?.includes("导入失败")) return true
  return job.output.some((line) => (
    /\bUnauthorized\b/i.test(line) ||
    // 只把「N errors」/「N files failed」/「errors=N (N>0)」当失败。
    // 进度行 `imported=1541 skipped=1 errors=0` 里的 `1 errors=0` 不能误判
    // （旧正则 /\b[1-9]\d*\s+errors?\b/ 会匹配到 errors=0 前面的计数 1）。
    /\berrors?[=:]\s*[1-9]\d*/i.test(line) ||
    /\b[1-9]\d*\s+files?\s+failed\b/i.test(line) ||
    /\b(?:full sync|sync)\s+blocked\b/i.test(line) ||
    /\berror embedding\b/i.test(line)
  ))
}

export default function CodeSourcePage() {
  const [inputMode, setInputMode] = useState<"directory" | "git" | "manifest">("directory")
  const [path, setPath] = useState("")
  const [sourceId, setSourceId] = useState("")
  const [gitUrl, setGitUrl] = useState("")
  const [manifestToolOverride, setManifestToolOverride] = useState<ManifestToolChoice>("auto")
  const [manifestUrl, setManifestUrl] = useState("")
  const manifestTool = manifestToolOverride === "auto" ? null : manifestToolOverride
  const manifestSourceIdPreview = (() => {
    if (!manifestUrl.trim()) return ""
    try { return inferManifestSourceId(manifestUrl) } catch { return "" }
  })()
  const manifestUrlError = (() => {
    if (!manifestUrl.trim()) return ""
    try { validateManifestUrl(manifestUrl); return "" } catch (caught) { return caught instanceof Error ? caught.message : "Manifest URL 无效" }
  })()
  const [branch, setBranch] = useState("")
  const [workers, setWorkers] = useState("2")
  const [jobs, setJobs] = useState<IndexJob[]>([])
  const [terminating, setTerminating] = useState<string | null>(null)
  const [scan, setScan] = useState<ScanResult | null>(null)
  const [job, setJob] = useState<IndexJob | null>(null)
  const [configuredSources, setConfiguredSources] = useState<SdkSourceConfig[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [configSaved, setConfigSaved] = useState<string | null>(null)
  const [registeredSources, setRegisteredSources] = useState<Array<{ id: string; local_path: string | null; page_count: number; archived?: boolean; archive_expires_at?: string | null }>>([])
  const [success, setSuccess] = useState<string | null>(null)
  const [deletingSourceId, setDeletingSourceId] = useState<string | null>(null)
  const [sourceProgress, setSourceProgress] = useState<Record<string, SourceTaskProgress | null>>({})
  const [sourceProgressErrors, setSourceProgressErrors] = useState<Record<string, string | null>>({})
  const [scheduleBusy, setScheduleBusy] = useState<string | null>(null)
  const [embedBusy, setEmbedBusy] = useState<string | null>(null)
  const [embedStatus, setEmbedStatus] = useState<Record<string, { embedCoverage: number; chunks: number; pages: number } | null>>({})
  // 阶段 2：归属路由 + 权限
  const [newScope, setNewScope] = useState<"personal" | "team">("personal")
  const [newNamespace, setNewNamespace] = useState("")
  const [namespaces, setNamespaces] = useState<Array<{ id: number; name: string; members: Array<{ userId: number; role: string }> }>>([])
  const [sourcePermissions, setSourcePermissions] = useState<Record<string, { canManage: boolean; canUpload: boolean }>>({})
  const [currentUser, setCurrentUser] = useState<{ id: number; userName: string; role: "admin" | "user" } | null>(null)
  const [newTeamName, setNewTeamName] = useState("")
  const [addMemberInput, setAddMemberInput] = useState<Record<string, string>>({})
  const [addMemberRole, setAddMemberRole] = useState<Record<string, string>>({})
  // 加成员后重置搜索框（key 变化触发 UserSearchSelect 重挂载，清空已选）。
  const [memberSearchKey, setMemberSearchKey] = useState<Record<string, number>>({})

  const scanDirectory = async () => {
    if (inputMode === "git") return
    if (!path.trim()) return
    setBusy(true)
    setError(null)
    setScan(null)
    try {
      const response = await fetch("/api/code-source/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: path.trim() }),
      })
      const payload = await response.json() as ScanResult & { error?: string }
      if (!response.ok) throw new Error(payload.error || "扫描失败")
      setScan(payload)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "扫描失败")
    } finally {
      setBusy(false)
    }
  }

  const startManifestImport = async () => {
    if (!manifestUrl.trim()) return
    setBusy(true)
    setError(null)
    setSuccess(null)
    try {
      validateManifestUrl(manifestUrl)
      // auto: let the server inspect the manifest repository contents (west.yml/default.xml).

      const normalizedSourceId = sourceId.trim() || inferManifestSourceId(manifestUrl)
      if (!sourceId.trim()) setSourceId(normalizedSourceId)
      const response = await fetch("/api/code-source/manifest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceId: normalizedSourceId,
          manifestTool: manifestToolOverride,
          manifestUrl: manifestUrl.trim(),
          branch: branch.trim() || undefined,
          workers: Number.parseInt(workers, 10) || 2,
          intervalMinutes: 60,
        }),
      })
      const payload = await response.json() as { job?: IndexJob; error?: string; duplicate?: boolean }
      if (!response.ok) throw new Error(payload.error || (response.status === 409 ? "Source 已有任务运行" : "Manifest 导入失败"))
      if (!payload.job) throw new Error(payload.error || "Manifest 导入未返回任务")
      window.sessionStorage.setItem(ACTIVE_JOB_STORAGE_KEY, payload.job.id)
      setJob(payload.job)
      setJobs((current) => [payload.job!, ...current.filter((item) => item.id !== payload.job!.id)])
      const configsResponse = await fetch("/api/code-source/config", { cache: "no-store" })
      if (configsResponse.ok) {
        const next = await configsResponse.json() as { configs?: SdkSourceConfig[]; sources?: { sources?: typeof registeredSources } }
        const configs = next.configs || []
        setConfiguredSources(configs)
        setRegisteredSources(next.sources?.sources || [])
        void refreshSourceProgress(configs)
        void refreshEmbedStatus(configs)
      }
      setSuccess(payload.duplicate ? `Source ${normalizedSourceId} 已有 Manifest 同步任务运行` : `已提交 ${manifestTool || "自动检测"} 同步与索引任务`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Manifest 导入失败")
    } finally {
      setBusy(false)
    }
  }

  const startIndex = async () => {
    if (inputMode === "manifest") {
      void startManifestImport()
      return
    }
    if (job?.status === "running") return
    if (inputMode === "git") {
      if (!gitUrl.trim()) return
    } else if (!path.trim() || !scan) return
    setBusy(true)
    setError(null)
    try {
      const response = await fetch("/api/code-source/index", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(inputMode === "git" ? { url: gitUrl.trim(), branch: branch.trim() || undefined } : { path: path.trim() }),
          sourceId: sourceId.trim() || undefined,
          workers: Number.parseInt(workers, 10) || 2,
        }),
      })
      const payload = await response.json() as { job?: IndexJob; error?: string }
      if (!response.ok) throw new Error(payload.error || (response.status === 409 ? `"${sourceId.trim() || path.trim()}" 已有同步/索引任务正在运行，请等待其完成或稍后再试` : "启动索引失败"))
      if (!payload.job) throw new Error(payload.error || "启动索引失败")
      window.sessionStorage.setItem(ACTIVE_JOB_STORAGE_KEY, payload.job.id)
      setJob(payload.job)
      const configs = configuredSources.some((item) => item.sourceId === payload.job!.sourceId)
        ? configuredSources
        : [...configuredSources, { sourceId: payload.job.sourceId, kind: (inputMode === "git" ? "git" : "directory") as SdkSourceKind, intervalMinutes: 60, enabled: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }]
      setConfiguredSources(configs)
      void refreshSourceProgress(configs)
      void refreshEmbedStatus(configs)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "启动索引失败")
    } finally {
      setBusy(false)
    }
  }

  // 进度轮询:只 fetch + setState,不依赖 render 闭包数据,用 useCallback 固定引用,
  // 供首次加载、定时器与启动任务后共用;避免 effect 内写 ref(react-hooks/immutability)。
  const refreshSourceProgress = useCallback(async (configs: typeof configuredSources) => {
    const rows = await Promise.all(configs.map(async (source) => {
      try {
        const response = await fetch(`/api/code-source/jobs?sourceId=${encodeURIComponent(source.sourceId)}`, { cache: "no-store" })
        const payload = await response.json() as { activeJobs?: SourceTaskProgress[]; error?: string }
        if (!response.ok || payload.error) throw new Error(payload.error || `任务进度读取失败（HTTP ${response.status}）`)
        return [source.sourceId, { task: payload.activeJobs?.[0] ?? null, error: null }] as const
      } catch (caught) {
        return [source.sourceId, { task: null, error: caught instanceof Error ? caught.message : "读取任务进度失败" }] as const
      }
    }))
    setSourceProgress(Object.fromEntries(rows.map(([id, state]) => [id, state.task])))
    setSourceProgressErrors(Object.fromEntries(rows.map(([id, state]) => [id, state.error])))
  }, [])

  // 读取每个 source 的向量化覆盖度（0..1），用于显示「待向量化」徽标。
  const refreshEmbedStatus = useCallback(async (configs: typeof configuredSources) => {
    const rows = await Promise.all(configs.map(async (source) => {
      try {
        const response = await fetch(`/api/code-source/embed?sourceId=${encodeURIComponent(source.sourceId)}`, { cache: "no-store" })
        if (!response.ok) return [source.sourceId, null] as const
        const payload = await response.json() as { embedCoverage?: number; chunks?: number; pages?: number }
        return [source.sourceId, {
          embedCoverage: Number(payload.embedCoverage) || 0,
          chunks: Number(payload.chunks) || 0,
          pages: Number(payload.pages) || 0,
        }] as const
      } catch {
        return [source.sourceId, null] as const
      }
    }))
    setEmbedStatus(Object.fromEntries(rows))
  }, [])

  const startEmbedding = async (id: string) => {
    if (embedBusy) return
    setEmbedBusy(id)
    setError(null)
    setSuccess(null)
    try {
      const response = await fetch("/api/code-source/embed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceId: id }),
      })
      const payload = await response.json() as { ok?: boolean; minionId?: number | null; error?: string }
      if (!response.ok) throw new Error(payload.error || "启动向量化失败")
      setSuccess(`Source ${id} 已加入向量化任务${payload.minionId ? `（job ${payload.minionId}）` : ""}`)
      setTimeout(() => { void refreshEmbedStatus(progressRef.current) }, 1500)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "启动向量化失败")
    } finally {
      setEmbedBusy(null)
    }
  }

  // 定时轮询需要的"最新配置列表"由 effect 同步到 ref(render 期不写 ref)。
  const progressRef = useRef(configuredSources)
  useEffect(() => {
    progressRef.current = configuredSources
  }, [configuredSources])

  /** 统一消费 /api/code-source/config 的响应（configs/permissions/currentUser）。 */
  const applyConfigPayload = useCallback((payload: ConfigPayload) => {
    const configs = payload.configs || []
    setConfiguredSources(configs)
    setRegisteredSources(payload.sources?.sources || [])
    if (payload.permissions) {
      setSourcePermissions(Object.fromEntries(payload.permissions.map((p) => [p.sourceId, { canManage: p.canManage, canUpload: p.canUpload }])))
    }
    if (payload.currentUser) setCurrentUser(payload.currentUser)
    void refreshSourceProgress(configs)
    void refreshEmbedStatus(configs)
  }, [refreshSourceProgress, refreshEmbedStatus])

  const loadNamespaces = useCallback(async () => {
    try {
      const response = await fetch("/api/namespaces", { cache: "no-store" })
      if (!response.ok) return
      const payload = await response.json() as { namespaces?: Array<{ id: number; name: string; members: Array<{ userId: number; role: string }> }> }
      setNamespaces(payload.namespaces || [])
    } catch {
      // 团队读取失败不阻塞页面
    }
  }, [])

  const createTeam = async () => {
    const name = newTeamName.trim()
    if (!name || busy) return
    setBusy(true); setError(null); setSuccess(null)
    try {
      const response = await fetch("/api/namespaces", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", name }),
      })
      const payload = await response.json() as { error?: string }
      if (!response.ok) throw new Error(payload.error || "创建团队失败")
      setNewTeamName("")
      setSuccess(`团队 ${name} 已创建`)
      await loadNamespaces()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "创建团队失败")
    } finally { setBusy(false) }
  }

  const addTeamMember = async (namespace: string) => {
    const userName = (addMemberInput[namespace] ?? "").trim()
    const role = addMemberRole[namespace] || "Developer"
    if (!userName || busy) return
    setBusy(true); setError(null); setSuccess(null)
    try {
      const response = await fetch("/api/namespaces", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "addMember", name: namespace, userName, role }),
      })
      const payload = await response.json() as { error?: string }
      if (!response.ok) throw new Error(payload.error || "加入成员失败")
      setAddMemberInput((current) => ({ ...current, [namespace]: "" }))
      setMemberSearchKey((current) => ({ ...current, [namespace]: (current[namespace] ?? 0) + 1 }))
      setSuccess(`${userName} 已加入 ${namespace}（${role}）`)
      await loadNamespaces()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "加入成员失败")
    } finally { setBusy(false) }
  }

  const removeTeamMember = async (namespace: string, userId: number) => {
    if (busy) return
    if (!window.confirm(`确定从 ${namespace} 移除成员 #${userId}？`)) return
    setBusy(true); setError(null); setSuccess(null)
    try {
      const response = await fetch("/api/namespaces", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "removeMember", name: namespace, userId }),
      })
      const payload = await response.json() as { error?: string }
      if (!response.ok) throw new Error(payload.error || "移除成员失败")
      setSuccess(`已从 ${namespace} 移除成员 #${userId}`)
      await loadNamespaces()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "移除成员失败")
    } finally { setBusy(false) }
  }

  const deleteTeam = async (namespace: string) => {
    if (busy) return
    if (!window.confirm(`确定删除团队 ${namespace}？该团队 source 将失去团队归属，请先处理其 source。`)) return
    setBusy(true); setError(null); setSuccess(null)
    try {
      const response = await fetch("/api/namespaces", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", name: namespace }),
      })
      const payload = await response.json() as { error?: string }
      if (!response.ok) throw new Error(payload.error || "删除团队失败")
      setSuccess(`团队 ${namespace} 已删除`)
      await loadNamespaces()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "删除团队失败")
    } finally { setBusy(false) }
  }

  useEffect(() => {
    let cancelled = false

    const loadConfiguredSources = async () => {
      try {
        const response = await fetch("/api/code-source/config")
        if (!response.ok) return
        const payload = await response.json() as ConfigPayload
        if (cancelled) return
        applyConfigPayload(payload)
        void loadNamespaces()
        // This endpoint also starts/reconciles the scheduler; its status is not rendered here.
        void fetch("/api/code-source/scheduler").catch(() => undefined)
      } catch {
        // Refresh on the next page load if the source endpoint is unavailable.
      }
    }
    void loadConfiguredSources()

    const jobId = window.sessionStorage.getItem(ACTIVE_JOB_STORAGE_KEY)
    if (jobId) {
      void fetch(`/api/code-source/jobs/${encodeURIComponent(jobId)}`)
        .then(async (response) => {
          if (!response.ok) return
          const payload = await response.json() as { job?: IndexJob }
          if (payload.job && !cancelled) setJob(payload.job)
        })
        .catch(() => undefined)
    }
    const progressTimer = window.setInterval(() => {
      void refreshSourceProgress(progressRef.current)
    }, 3000)
    // 向量覆盖度用 get_health，较重，降低频率（每 15s）并与进度轮询错开。
    const embedTimer = window.setInterval(() => {
      void refreshEmbedStatus(progressRef.current)
    }, 15000)
    return () => {
      cancelled = true
      window.clearInterval(progressTimer)
      window.clearInterval(embedTimer)
    }
  }, [refreshSourceProgress, refreshEmbedStatus, applyConfigPayload, loadNamespaces])

  const removeConfiguredSource = async (id: string) => {
    if (busy) return
    if (!window.confirm(`确定删除 ${id}？这会删除 GBrain source 数据和本地配置，但不会删除原始 SDK 文件。`)) return
    setBusy(true)
    setError(null)
    setSuccess(null)
    try {
      const response = await fetch(`/api/code-source/config?sourceId=${encodeURIComponent(id)}`, { method: "DELETE" })
      const payload = await response.json() as { error?: string }
      if (!response.ok) throw new Error(payload.error || "删除 source 失败")
      setConfiguredSources((current) => current.filter((item) => item.sourceId !== id))
      setRegisteredSources((current) => current.filter((item) => item.id !== id))
      setSuccess(`Source ${id} 和本地配置已删除；原始 SDK 文件未删除`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "删除 source 失败")
    } finally {
      setBusy(false)
    }
  }

  const sourceAction = async (id: string, action: string, body: Record<string, unknown> = {}) => {
    setBusy(true)
    if (action === "remove") setDeletingSourceId(id)
    setError(null)
    setSuccess(null)
    try {
      const response = await fetch(`/api/code-source/sources/${encodeURIComponent(id)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...body }) })
      const payload = await response.json() as { error?: string; result?: { oauth_clients_revoked?: number } }
      if (!response.ok) throw new Error(payload.error || "source 操作失败")

      // Removing a source may revoke the browser's source-bound OAuth client.
      // Do not make the success path depend on an authenticated refresh: that
      // refresh would correctly fail after the source/client was removed and
      // would turn a completed destructive operation into a false error.
      if (action === "remove") {
        setRegisteredSources((current) => current.filter((item) => item.id !== id))
        setConfiguredSources((current) => current.filter((item) => item.sourceId !== id))
        const revoked = payload.result?.oauth_clients_revoked ?? 0
        setSuccess(revoked > 0
          ? `Source ${id} 已永久删除；${revoked} 个绑定 Token 已撤销，请重新配置 Web Token。`
          : `Source ${id} 已永久删除`)
      } else {
        const refresh = await fetch("/api/code-source/config")
        if (refresh.ok) {
          const next = await refresh.json() as { configs?: typeof configuredSources; sources?: { sources?: typeof registeredSources } }
          applyConfigPayload(next)
        }
        setSuccess(`Source ${id} 操作成功`)
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "source 操作失败")
    } finally {
      setBusy(false)
      if (action === "remove") setDeletingSourceId(null)
    }
  }

  const runScheduledSource = async (id: string) => {
    if (busy || scheduleBusy) return
    setBusy(true)
    setScheduleBusy(id)
    setError(null)
    try {
      const response = await fetch(`/api/code-source/scheduler?sourceId=${encodeURIComponent(id)}`, { method: "POST" })
      const payload = await response.json() as { job?: IndexJob; error?: string }
      // 409 = 该 source 已有任务在跑/排队，service 会连 job 一起返回。把它当成
      // 「已经在同步」而不是失败——之前这里只看 response.ok，一律抛
      // "启动同步失败"，用户看到的是错误但任务其实没任何问题。
      if (response.status === 409 && payload.job) {
        window.sessionStorage.setItem(ACTIVE_JOB_STORAGE_KEY, payload.job.id)
        setJob(payload.job)
        setJobs((current) => [payload.job!, ...current.filter((item) => item.id !== payload.job!.id)])
        setSuccess(`Source ${id} 已有同步任务在进行中，已跟随该任务`)
        return
      }
      if (!response.ok || !payload.job) throw new Error(payload.error || "启动同步失败")
      window.sessionStorage.setItem(ACTIVE_JOB_STORAGE_KEY, payload.job.id)
      setJob(payload.job)
      setJobs((current) => [payload.job!, ...current.filter((item) => item.id !== payload.job!.id)])
      const configs = configuredSources.some((item) => item.sourceId === id)
        ? configuredSources
        : [...configuredSources, { sourceId: id, kind: (configuredSources.find((item) => item.sourceId === id)?.kind === "git" ? "git" : "directory") as SdkSourceKind, intervalMinutes: 60, enabled: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }]
      setConfiguredSources(configs)
      void refreshSourceProgress(configs)
      void refreshEmbedStatus(configs)
      setSuccess(`Source ${id} 已加入同步任务`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "启动同步失败")
    } finally {
      setBusy(false)
      setScheduleBusy(null)
    }
  }

  const saveSourceConfig = async () => {
    const normalizedSourceId = sourceId.trim()
    const normalizedUrl = gitUrl.trim()
    const normalizedPath = path.trim()
    if (!normalizedSourceId) {
      setError("请先填写 Source ID")
      return
    }
    if (inputMode === "git" && !normalizedUrl) {
      setError("请先填写 Git HTTPS URL")
      return
    }
    if (inputMode === "directory" && !normalizedPath) {
      setError("请先填写本地目录")
      return
    }
    setBusy(true)
    setError(null)
    setConfigSaved(null)
    try {
      const response = await fetch("/api/code-source/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceId: normalizedSourceId,
          kind: inputMode,
          ...(inputMode === "git" ? { url: normalizedUrl, branch: branch.trim() || undefined } : { path: normalizedPath }),
          intervalMinutes: 60,
          enabled: true,
          // 阶段 2：新建 source 的归属（编辑已有 source 时服务端忽略，归属不可变）
          scope: newScope,
          ...(newScope === "team" ? { namespace: newNamespace.trim() } : {}),
        }),
      })
      const payload = await response.json() as { source?: typeof configuredSources[number]; error?: string }
      if (!response.ok || !payload.source) throw new Error(payload.error || "保存 source 配置失败")
      setConfiguredSources((current) => [...current.filter((item) => item.sourceId !== payload.source!.sourceId), payload.source!])
      setConfigSaved(`Source ${payload.source!.sourceId} 配置已保存，可用于后续同步`)
      setSuccess(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存 source 配置失败")
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!job || (job.status !== "running" && job.status !== "queued")) return
    const timer = window.setInterval(async () => {
      const response = await fetch(`/api/code-source/jobs/${encodeURIComponent(job.id)}`)
      if (!response.ok) return
      const payload = await response.json() as { job: IndexJob }
      setJob(payload.job)
      if (payload.job.status === "completed" || payload.job.status === "failed") {
        window.sessionStorage.removeItem(ACTIVE_JOB_STORAGE_KEY)
      }
    }, 2000)
    return () => window.clearInterval(timer)
  }, [job])

  // 任务列表轮询:显示所有进行中/已结束任务(minions 持久化队列 + 本地快照)。
  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      try {
        const response = await fetch("/api/code-source/jobs")
        if (!response.ok) return
        const payload = await response.json() as { jobs: IndexJob[] }
        if (cancelled) return
        setJobs(payload.jobs || [])
      } catch {
        // 轮询失败静默,下次再试。
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 3000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [])

  const terminateJob = async (target: IndexJob) => {
    if (terminating) return
    const sourceLabel = target.sourceId || target.root
    // 交互完善:终止是破坏性操作,先明确警告会彻底删除本次导入相关数据。
    if (!window.confirm(`确定终止任务 "${target.id}" 吗？\n\n这会停止并彻底删除 ${sourceLabel} 这次上传相关的全部已建索引(页面/向量/调度配置),其他任务不受影响。\n\n该操作不可撤销。`)) return
    setTerminating(target.id)
    setError(null)
    setSuccess(null)
    try {
      const response = await fetch(`/api/code-source/jobs/${encodeURIComponent(target.id)}/terminate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
      const payload = await response.json() as { error?: string; ok?: boolean }
      if (!response.ok) throw new Error(payload.error || "终止任务失败")

      // 终止成功:从列表立即移除(terminate 已级联删除本地任务卡),并清理高亮。
      setJobs((current) => current.filter((item) => item.id !== target.id))
      window.sessionStorage.removeItem(ACTIVE_JOB_STORAGE_KEY)
      setSuccess(`任务 ${target.id} 已终止，${sourceLabel} 上传相关数据已彻底清理`)
      // 终止后刷新已注册 source 列表,确认 source 行已被级联删除。
      void fetch("/api/code-source/config").then(async (response) => {
        if (!response.ok) return
        const next = await response.json() as ConfigPayload
        applyConfigPayload(next)
      }).catch(() => undefined)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "终止任务失败")
    } finally {
      setTerminating(null)
    }
  }

  useEffect(() => {
    if (job?.status !== "completed" && job?.status !== "failed") return
    void fetch("/api/code-source/config").then(async (response) => {
      if (!response.ok) return
      const payload = await response.json() as ConfigPayload
      const nextSources = payload.sources?.sources || []
      setConfiguredSources(payload.configs || [])
      setRegisteredSources(nextSources)
      const source = nextSources.find((item) => item.id === job.sourceId)
      const hasImportFailure = jobHasImportFailure(job)
      const importedPages = job.output.some((line) => /(?:^|\s)(?:[1-9]\d*) pages imported\b|\bimported=[1-9]\d*/i.test(line))
      if (hasImportFailure) {
        setError(`Source ${job.sourceId} 索引任务失败：${job.message || "请查看任务日志"}`)
      } else if (!source || (source.page_count === 0 && !importedPages)) {
        setError(`Source ${job.sourceId} 任务虽然返回 completed，但实际 page_count 仍为 0，Memory Library 未更新；请查看任务日志后重试。`)
      } else {
        setSuccess(`Source ${job.sourceId} 索引完成，Memory Library 已更新（${source.page_count} 页）`)
      }
    }).catch(() => undefined)
    // job 增速刷新时产生新引用也会重跑本 effect,但首行的终态守卫立即返回,零副作用;
    // 用整 job 作依赖可让 lint 感知回调读取的 job.output/job.sourceId。
  }, [job])

  const activeJobs = jobs.reduce<IndexJob[]>((unique, item) => {
    if (item.status !== "running" && item.status !== "queued") return unique
    const existingIndex = unique.findIndex((candidate) => candidate.sourceId === item.sourceId)
    if (existingIndex < 0) unique.push(item)
    else if (item.status === "running" && unique[existingIndex].status === "queued") unique[existingIndex] = item
    return unique
  }, [])

  /**
   * 合并视图（方案 A+E）：把「gbrain 已注册 source」与「Web 已配置 source」union 成
   * 单一实体列表，按归属域分组渲染（个人 / 团队xx / 系统 / 未配置）。
   * - 两侧都有 → 合并成一行（带完整信息 + 全部操作）
   * - 仅 gbrain 已注册（如 default）→ 只读行，提供「配置同步」引导
   * - 仅 Web 有配置 → 常规行
   */
  const mergedGroups = useMemo(() => {
    type Row = {
      sourceId: string
      registered?: typeof registeredSources[number]
      config?: SdkSourceConfig
    }
    const map = new Map<string, Row>()
    for (const item of registeredSources) map.set(item.id, { sourceId: item.id, registered: item })
    for (const item of configuredSources) {
      const row = map.get(item.sourceId) ?? { sourceId: item.sourceId }
      row.config = item
      map.set(item.sourceId, row)
    }
    const groups = new Map<string, { key: string; label: string; rows: Row[] }>()
    const groupKeyOf = (row: Row): { key: string; label: string } => {
      const scope = row.config?.scope ?? (row.config ? "personal" : "unconfigured")
      if (scope === "system") return { key: "system", label: "系统" }
      if (scope === "team") return { key: `team:${row.config?.namespace ?? ""}`, label: `团队 · ${row.config?.namespace ?? "未指定"}` }
      if (scope === "personal") return { key: "personal", label: "个人" }
      return { key: "unconfigured", label: "已注册（未配置同步）" }
    }
    // 固定分组顺序：个人 / 团队 / 系统 / 未配置
    const ORDER = ["personal", "team", "system", "unconfigured"]
    for (const row of map.values()) {
      const { key, label } = groupKeyOf(row)
      const group = groups.get(key) ?? { key, label, rows: [] }
      group.rows.push(row)
      groups.set(key, group)
    }
    return Array.from(groups.values())
      .sort((a, b) => {
        const rank = (key: string) => ORDER.findIndex((prefix) => key === prefix || key.startsWith(`${prefix}:`))
        return rank(a.key) - rank(b.key) || a.label.localeCompare(b.label)
      })
      .map((group) => ({ ...group, rows: group.rows.sort((a, b) => a.sourceId.localeCompare(b.sourceId)) }))
  }, [registeredSources, configuredSources])

  return (
    <div className="min-h-screen">
      <Header title="SDK 源码库" description="递归扫描源码目录，批量建立代码知识库索引" />
      <div className="mx-auto max-w-5xl space-y-6 p-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Code2 className="h-5 w-5" />源码目录扫描</CardTitle>
            <CardDescription>
              支持 C/C++、Python、Java、Go、Rust、JavaScript/TypeScript 等源码；自动跳过编译产物和常见依赖目录。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-[1fr_180px_120px]">
              <div className="space-y-2 md:col-span-2">
                <label className="text-sm font-medium">索引来源</label>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" size="sm" variant={inputMode === "directory" ? "default" : "outline"} onClick={() => setInputMode("directory")}>本地目录</Button>
                  <Button type="button" size="sm" variant={inputMode === "manifest" ? "default" : "outline"} onClick={() => setInputMode("manifest")}>Manifest</Button>
                  <Button type="button" size="sm" variant={inputMode === "git" ? "default" : "outline"} onClick={() => setInputMode("git")}>Git URL</Button>
                </div>
              </div>
              {inputMode === "git" ? (
                <div className="space-y-2 md:col-span-2">
                  <label htmlFor="code-git-url" className="text-sm font-medium">Git HTTPS URL</label>
                  <Input id="code-git-url" value={gitUrl} onChange={(event) => setGitUrl(event.target.value)} placeholder="https://github.com/owner/repository.git" />
                  <Input aria-label="Git 分支（可选）" value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="分支（可选，默认仓库默认分支）" />
                </div>
              ) : inputMode === "manifest" ? (
                <div className="space-y-3 rounded-lg border p-3 md:col-span-2">
                  <div className="space-y-2">
                    <label htmlFor="code-manifest-url" className="text-sm font-medium">Manifest SSH/HTTPS URL</label>
                    <Input id="code-manifest-url" value={manifestUrl} onChange={(event) => setManifestUrl(event.target.value)} placeholder="ssh://gerrit.example.com:29418/group/manifest" />
                    <p className="text-xs text-muted-foreground">服务器会在受控 workspace 中初始化并同步整个 SDK。自动模式会检查仓库根目录的 west.yml/default.xml；主机仅受允许列表控制，不决定工具类型。SSH 凭据必须已配置在 Web/GBrain 服务器。</p>
                    {manifestUrlError && <p role="alert" className="text-xs text-destructive">{manifestUrlError}</p>}
                  </div>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div className="space-y-2">
                      <label htmlFor="code-manifest-tool" className="text-sm font-medium">Manifest 工具</label>
                      <select id="code-manifest-tool" value={manifestToolOverride} onChange={(event) => setManifestToolOverride(event.target.value as ManifestToolChoice)} className="h-10 w-full rounded-md border border-input bg-transparent px-3 text-sm">
                        <option value="auto">自动检测 manifest 内容</option>
                        <option value="repo">repo</option>
                        <option value="west">west</option>
                      </select>
                    </div>
                    <div className="space-y-2 sm:col-span-2">
                      <label htmlFor="code-manifest-branch" className="text-sm font-medium">Manifest branch/ref（可选）</label>
                      <Input id="code-manifest-branch" value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="留空使用 manifest 默认分支" />
                    </div>
                  </div>
                  {manifestUrl.trim() && manifestToolOverride === "auto" && <p className="text-xs text-muted-foreground">服务器开始同步前会浅克隆 manifest 仓库并检查根目录文件来识别格式。</p>}
                </div>
              ) : (
                <div className="space-y-2 md:col-span-2">
                  <label htmlFor="code-root" className="text-sm font-medium">服务器上的 SDK 目录</label>
                  <Input id="code-root" value={path} onChange={(event) => setPath(event.target.value)} placeholder="例如 /home/wlan5/sdk-repos/my-sdk" />
                </div>
              )}
              <div className="space-y-2">
                <label htmlFor="code-source-id" className="text-sm font-medium">Source ID</label>
                <Input id="code-source-id" value={sourceId} onChange={(event) => setSourceId(event.target.value)} placeholder={inputMode === "manifest" ? (manifestSourceIdPreview || "根据 Manifest URL 自动生成") : "sdk-aurora"} />
              </div>
              <div className="space-y-2">
                <label htmlFor="code-workers" className="text-sm font-medium">并行数</label>
                <Input id="code-workers" type="number" min="1" max="8" value={workers} onChange={(event) => setWorkers(event.target.value)} />
              </div>
              {inputMode !== "manifest" && (
                <div className="space-y-2">
                  <label htmlFor="code-scope" className="text-sm font-medium">归属</label>
                  <select id="code-scope" value={newScope} onChange={(event) => setNewScope(event.target.value as "personal" | "team")} className="h-10 w-full rounded-md border border-input bg-transparent px-3 text-sm">
                    <option value="personal">个人（仅自己可见/可改）</option>
                    <option value="team">团队（团队成员可见）</option>
                  </select>
                </div>
              )}
              {inputMode !== "manifest" && newScope === "team" && (
                <div className="space-y-2">
                  <label htmlFor="code-namespace" className="text-sm font-medium">团队</label>
                  <select id="code-namespace" value={newNamespace} onChange={(event) => setNewNamespace(event.target.value)} className="h-10 w-full rounded-md border border-input bg-transparent px-3 text-sm">
                    <option value="">选择团队…</option>
                    {namespaces.map((ns) => <option key={ns.id} value={ns.name}>{ns.name}</option>)}
                  </select>
                </div>
              )}
            </div>
            {inputMode !== "manifest" && <p className="text-xs text-muted-foreground">出于安全考虑，目录必须位于服务器配置的 GBRAIN_CODE_ROOTS 允许范围内。</p>}
            <div className="flex gap-2">
              {inputMode === "directory" && <Button onClick={() => void scanDirectory()} disabled={!path.trim() || busy} className="gap-2">
                {busy && !scan ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderSearch className="h-4 w-4" />}扫描预览
              </Button>}
              {inputMode !== "manifest" && <Button variant="outline" onClick={() => void saveSourceConfig()} disabled={!sourceId.trim() || (inputMode === "directory" ? !path.trim() : !gitUrl.trim()) || busy} className="gap-2">
                <Save className="h-4 w-4" />保存 source 配置
              </Button>}
              <Button variant="outline" onClick={() => void startIndex()} disabled={busy || job?.status === "running" || (inputMode === "directory" ? !scan : inputMode === "git" ? !gitUrl.trim() : !manifestUrl.trim() || Boolean(manifestUrlError) || (manifestToolOverride !== "auto" && !manifestTool))} className="gap-2">
                {busy || job?.status === "running" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}{inputMode === "manifest" ? "导入并索引 SDK" : "开始代码索引"}
              </Button>
            </div>
            {error && <div role="alert" className="flex gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive"><AlertCircle className="h-4 w-4 shrink-0" />{error}</div>}
            {success && <div role="status" className="rounded-lg bg-emerald-500/10 p-3 text-sm text-emerald-700">{success}</div>}
            {configSaved && <div className="rounded-lg bg-emerald-500/10 p-3 text-sm text-emerald-700">{configSaved}</div>}
            {mergedGroups.map((group) => (
              <div key={group.key} className="space-y-2">
                <h3 className="text-sm font-medium">{group.label}</h3>
                {group.rows.map(({ sourceId: sid, registered, config }) => {
                  const task = sourceProgress[sid]
                  const progress = task?.progress
                  const isEmbedTask = task?.name === "embed" || task?.name === "embed-backfill"
                  const completed = typeof progress?.embedded === "number" ? progress.embedded : progress?.done
                  const total = progress?.total
                  const progressText = task
                    ? `${isEmbedTask ? "向量化" : progress?.phase?.startsWith("import") ? "导入" : "同步"}${typeof completed === "number" && typeof total === "number" ? ` ${completed}/${total}` : "进行中"}`
                    : null
                  const taskError = sourceProgressErrors[sid]
                  const embed = embedStatus[sid]
                  const embedPct = embed ? Math.round(embed.embedCoverage * 100) : null
                  const needsEmbed = Boolean(embed && embed.chunks > 0 && embedPct !== null && embedPct < 100)
                  const perm = sourcePermissions[sid]
                  const canManage = perm?.canManage ?? false
                  const canUpload = perm?.canUpload ?? false
                  const archived = registered?.archived
                  return (
                    <div key={sid} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm">
                      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                        <span className="font-medium">{sid}</span>
                        {archived && <span className="text-xs text-amber-600">（已归档）</span>}
                        {registered && <span className="text-xs text-muted-foreground">{registered.page_count} 页</span>}
                        <span className="text-muted-foreground">{config?.path || config?.url || registered?.local_path || "无本地路径"}</span>
                        {config && <span className="text-xs text-muted-foreground">每 {config.intervalMinutes} 分钟</span>}
                        {config?.nextRunAt && <span className="text-xs text-muted-foreground">下次：{new Date(config.nextRunAt).toLocaleString()}</span>}
                        {config?.lastStatus && <span className="text-xs text-muted-foreground">配置：{config.lastStatus}</span>}
                        {embedPct !== null && <span className={needsEmbed ? "text-xs font-medium text-amber-600" : "text-xs text-muted-foreground"} title={embed ? `${embed.pages} 页 · ${embed.chunks} chunk` : undefined}>{needsEmbed ? `向量化 ${embedPct}%（待补建）` : `向量化 ${embedPct}%`}</span>}
                        {progressText && <span className="text-xs font-medium text-blue-600">{progressText}</span>}
                        {taskError && <span title={taskError} className="text-xs text-amber-700">进度不可用</span>}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {config ? (
                          <>
                            <Button size="sm" variant="outline" onClick={() => void runScheduledSource(sid)} disabled={busy || scheduleBusy === sid || !canManage} title={canManage ? undefined : "无权管理该 source"}>立即同步</Button>
                            <Button size="sm" variant="outline" className="gap-1" onClick={() => void startEmbedding(sid)} disabled={busy || embedBusy === sid || Boolean(task) || !canUpload} title={canUpload ? (needsEmbed ? "为缺失的 chunk 补建向量" : "重新扫描并为缺失的 chunk 补建向量") : "无权操作该 source"}>{embedBusy === sid ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}{embedBusy === sid ? "启动中…" : "向量化"}</Button>
                            <Button size="sm" variant="destructive" onClick={() => void removeConfiguredSource(sid)} disabled={busy || !canManage} title={canManage ? undefined : "无权删除该 source"}>删除配置</Button>
                          </>
                        ) : (
                          <>
                            <Button size="sm" variant="outline" onClick={() => { setSourceId(sid); if (registered?.local_path) setPath(registered.local_path) }}>配置同步</Button>
                            {registered?.local_path && <Button size="sm" variant="outline" onClick={() => { const next = window.prompt("请输入新的本地 SDK 目录", registered.local_path || ""); if (next) void sourceAction(sid, "set-path", { path: next }) }}>修改路径</Button>}
                            {registered?.archived ? <Button size="sm" variant="outline" onClick={() => void sourceAction(sid, "restore")}>恢复</Button> : sid !== "default" && <Button size="sm" variant="outline" onClick={() => { if (window.confirm(`确定归档 ${sid}？数据保留，但不再默认参与检索。`)) void sourceAction(sid, "archive") }}>归档</Button>}
                            {sid !== "default" && <Button size="sm" variant="destructive" disabled={deletingSourceId === sid} onClick={() => { const typed = window.prompt(`永久删除 ${sid} 将删除 source 索引数据。请输入 Source ID 确认`, ""); if (typed) void sourceAction(sid, "remove", { confirm: typed }) }}>{deletingSourceId === sid ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />永久删除中…</> : "永久删除"}</Button>}
                          </>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">团队管理</CardTitle>
            <CardDescription>创建团队并把成员加入；团队 source 归某个团队后，成员按角色协作。{currentUser ? `（当前：${currentUser.userName}${currentUser.role === "admin" ? " · 管理员" : ""}）` : ""}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-2">
                <label htmlFor="ns-name" className="text-sm font-medium">新建团队</label>
                <Input id="ns-name" value={newTeamName} onChange={(event) => setNewTeamName(event.target.value)} placeholder="team-name（小写字母/数字/连字符）" />
              </div>
              <Button variant="outline" className="gap-2" disabled={!newTeamName.trim() || busy} onClick={() => void createTeam()}>
                <Plus className="h-4 w-4" />创建
              </Button>
            </div>
            {namespaces.length === 0 ? <p className="text-sm text-muted-foreground">暂无团队</p> : namespaces.map((ns) => (
              <div key={ns.id} className="rounded-lg border p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{ns.name}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">{ns.members.length} 名成员</span>
                    <Button size="sm" variant="destructive" disabled={busy} onClick={() => void deleteTeam(ns.name)}>删除团队</Button>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {ns.members.map((member) => (
                    <span key={member.userId} className="flex items-center gap-1 rounded bg-muted px-2 py-0.5 text-xs">
                      用户#{member.userId} · {member.role}
                      <button type="button" aria-label={`移除成员 ${member.userId}`} disabled={busy} onClick={() => void removeTeamMember(ns.name, member.userId)} className="text-destructive hover:opacity-70">×</button>
                    </span>
                  ))}
                </div>
                <div className="mt-2 flex flex-wrap items-end gap-2">
                  <UserSearchSelect
                    key={`${ns.name}-${memberSearchKey[ns.name] ?? 0}`}
                    aria-label={`向 ${ns.name} 加成员`}
                    placeholder="输入用户名搜索…"
                    onSelect={(user) => setAddMemberInput((current) => ({ ...current, [ns.name]: user.userName }))}
                  />
                  <select aria-label={`${ns.name} 成员角色`} value={addMemberRole[ns.name] ?? "Developer"} onChange={(event) => setAddMemberRole((current) => ({ ...current, [ns.name]: event.target.value }))} className="h-8 rounded-md border border-input bg-transparent px-2 text-xs">
                    <option value="Developer">Developer（可传/建）</option>
                    <option value="Maintainer">Maintainer（可管成员）</option>
                    <option value="Reporter">Reporter（只读）</option>
                  </select>
                  <Button size="sm" variant="outline" disabled={!(addMemberInput[ns.name] ?? "").trim() || busy} onClick={() => void addTeamMember(ns.name)}>加入成员</Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        {scan && (
          <Card>
            <CardHeader><CardTitle className="text-base">扫描结果</CardTitle><CardDescription>{scan.root}{scan.truncated ? "（达到扫描上限，结果被截断）" : ""}</CardDescription></CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-4">
                <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">源码文件</p><p className="text-2xl font-semibold">{scan.codeFiles}</p></div>
                <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">文档文件</p><p className="text-2xl font-semibold">{scan.documentFiles}</p></div>
                <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">跳过文件</p><p className="text-2xl font-semibold">{scan.skippedFiles}</p></div>
                <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">跳过目录</p><p className="text-2xl font-semibold">{scan.skippedDirectories}</p></div>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div><h3 className="mb-2 text-sm font-medium">语言</h3><div className="flex flex-wrap gap-2">{Object.entries(scan.byLanguage).map(([language, count]) => <span key={language} className="rounded bg-muted px-2 py-1 text-xs">{language}: {count}</span>)}</div></div>
                <div><h3 className="mb-2 text-sm font-medium">扩展名</h3><div className="flex flex-wrap gap-2">{Object.entries(scan.byExtension).map(([extension, count]) => <span key={extension} className="rounded bg-muted px-2 py-1 text-xs">{extension}: {count}</span>)}</div></div>
              </div>
              <div><h3 className="mb-2 text-sm font-medium">文件预览（最多显示 500 个）</h3><div className="max-h-72 overflow-auto rounded-lg border text-xs">{scan.files.map((file) => <div key={file.relativePath} className="flex items-center justify-between border-b px-3 py-2 last:border-0"><span className="truncate">{file.relativePath}</span><span className="ml-3 shrink-0 text-muted-foreground">{file.language || file.category} · {formatBytes(file.sizeBytes)}</span></div>)}</div></div>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><ListChecks className="h-5 w-5" />进行中的任务</CardTitle>
              <CardDescription>{activeJobs.length > 0 ? "显示正在索引的 source；终止后会清理该 source 的索引数据和配置，其他任务不受影响。" : "当前没有正在运行的 source。"}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {activeJobs.length === 0 ? <p className="text-sm text-muted-foreground">暂无进行中的任务</p> : activeJobs.map((task) => {
                const running = task.status === "running"
                const hasProgress = task.processed !== undefined && task.total !== undefined
                return (
                  <div key={task.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
                    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2">
                      {running
                        ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-blue-600" />
                        : <Clock className="h-4 w-4 shrink-0 text-amber-600" />}
                      <span className="text-sm font-medium">Source：{task.sourceId}</span>
                      <span className="text-xs text-muted-foreground">{running ? "运行中" : "排队中"}</span>
                      {running && <span className="text-xs tabular-nums text-muted-foreground">{hasProgress ? `${task.processed}/${task.total}` : "准备进度…"}</span>}
                    </div>
                    <Button size="sm" variant="destructive" disabled={Boolean(terminating)} onClick={() => void terminateJob(task)} className="gap-1 text-xs">
                      {terminating === task.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" />}
                      {terminating === task.id ? "清理中…" : "终止并清理"}
                    </Button>
                  </div>
                )
              })}
            </CardContent>
        </Card>
      </div>
    </div>
  )
}
