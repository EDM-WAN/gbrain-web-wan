"use client"

import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { AlertCircle, Copy, KeyRound, Loader2, Plus, Trash2 } from "lucide-react"

interface ApiKeyPublic {
  id: number
  keyPrefix: string
  name: string
  description: string
  isActive: boolean
  expiresAt: number
  lastUsedAt: number | null
  createdAt: string
}

/**
 * API 密钥管理（方案 A）。创建后明文 key 只显示一次。
 * 用途：命令行/脚本（如 gbrain-sdk-sync.mjs）以该用户身份访问，权限按
 * 阶段 2 的 source-permissions 生效。
 */
export function ApiKeysCard() {
  const [keys, setKeys] = useState<ApiKeyPublic[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [newName, setNewName] = useState("")
  const [createdSecret, setCreatedSecret] = useState<string | null>(null)
  const [unauthorized, setUnauthorized] = useState(false)

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/auth/keys", { cache: "no-store" })
      if (response.status === 401) { setUnauthorized(true); return }
      if (!response.ok) throw new Error("读取密钥失败")
      const payload = await response.json() as { keys?: ApiKeyPublic[] }
      setKeys(payload.keys || [])
      setUnauthorized(false)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "读取密钥失败")
    } finally {
      setLoading(false)
    }
  }, [])

  // 与仓库其它页面一致：在 effect 里异步拉取（不直接 setState in effect body）。
  useEffect(() => {
    void (async () => { await load() })()
  }, [load])

  const createKey = async () => {
    const name = newName.trim()
    if (!name || busy) return
    setBusy(true); setError(null); setCreatedSecret(null)
    try {
      const response = await fetch("/api/auth/keys", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      })
      const payload = await response.json() as { secret?: string; error?: string }
      if (!response.ok || !payload.secret) throw new Error(payload.error || "创建密钥失败")
      setCreatedSecret(payload.secret)
      setNewName("")
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "创建密钥失败")
    } finally { setBusy(false) }
  }

  const toggleKey = async (id: number) => {
    setBusy(true); setError(null)
    try {
      const response = await fetch(`/api/auth/keys?id=${id}`, { method: "PATCH" })
      if (!response.ok) throw new Error("操作失败")
      await load()
    } catch (caught) { setError(caught instanceof Error ? caught.message : "操作失败") }
    finally { setBusy(false) }
  }

  const deleteKey = async (id: number) => {
    if (!window.confirm("确定删除该密钥？使用它的脚本将立即失效。")) return
    setBusy(true); setError(null)
    try {
      const response = await fetch(`/api/auth/keys?id=${id}`, { method: "DELETE" })
      if (!response.ok) throw new Error("删除失败")
      await load()
    } catch (caught) { setError(caught instanceof Error ? caught.message : "删除失败") }
    finally { setBusy(false) }
  }

  if (unauthorized) {
    return (
      <Card>
        <CardHeader><CardTitle className="text-base">API 密钥</CardTitle></CardHeader>
        <CardContent><p className="text-sm text-muted-foreground">请先登录后再管理 API 密钥。</p></CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><KeyRound className="h-4 w-4" />API 密钥</CardTitle>
        <CardDescription>
          用于命令行/脚本访问（如 <code className="text-xs">gbrain-sdk-sync.mjs</code>）。
          密钥以你的身份访问，权限与你在网页上一致。明文只显示一次。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-2">
            <label htmlFor="api-key-name" className="text-sm font-medium">新建密钥</label>
            <Input id="api-key-name" value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="例如 dsp-upload / local-cli" />
          </div>
          <Button variant="outline" className="gap-2" disabled={!newName.trim() || busy} onClick={() => void createKey()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}创建
          </Button>
        </div>

        {createdSecret && (
          <div className="space-y-1 rounded-lg bg-emerald-500/10 p-3 text-sm">
            <p className="font-medium text-emerald-700">密钥已创建（此明文只显示一次，请立即保存）：</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 break-all rounded bg-background px-2 py-1 text-xs">{createdSecret}</code>
              <Button size="sm" variant="outline" className="gap-1" onClick={() => void navigator.clipboard.writeText(createdSecret)}>
                <Copy className="h-3.5 w-3.5" />复制
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">用法：<code>export GBRAIN_API_KEY=&lt;密钥&gt;</code>（脚本用 X-API-Key 或 Bearer 头携带）</p>
          </div>
        )}

        {error && <div role="alert" className="flex gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive"><AlertCircle className="h-4 w-4 shrink-0" />{error}</div>}

        {loading ? <p className="text-sm text-muted-foreground">加载中…</p> : keys.length === 0 ? (
          <p className="text-sm text-muted-foreground">暂无密钥</p>
        ) : (
          <div className="space-y-2">
            {keys.map((key) => (
              <div key={key.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm">
                <div className="min-w-0">
                  <div className="font-medium">{key.name} <span className="text-xs text-muted-foreground">{key.keyPrefix}</span></div>
                  <div className="text-xs text-muted-foreground">
                    {key.isActive ? "启用" : "已停用"}
                    {key.lastUsedAt ? ` · 最近使用 ${new Date(key.lastUsedAt).toLocaleString()}` : " · 未使用"}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void toggleKey(key.id)}>{key.isActive ? "停用" : "启用"}</Button>
                  <Button size="sm" variant="destructive" className="gap-1" disabled={busy} onClick={() => void deleteKey(key.id)}><Trash2 className="h-3.5 w-3.5" />删除</Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
