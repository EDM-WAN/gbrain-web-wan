"use client"

import { useCallback, useEffect, useState } from "react"
import { Header } from "@/components/layout/Header"
import { SettingsNav } from "@/components/settings/SettingsNav"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { AlertCircle, Check, Copy, KeyRound, Loader2, Plus, Trash2, X } from "lucide-react"
import { copyToClipboard } from "@/lib/clipboard"

interface ApiKeyPublic {
  id: number
  keyPrefix: string
  name: string
  description: string
  isActive: boolean
  lastUsedAt: number | null
  createdAt: string
}

/**
 * API 密钥管理页（照 Wegent：Settings 左侧导航 → API 密钥）。
 * 用途：命令行/脚本（如 gbrain-sdk-sync.mjs）以该用户身份访问 gbrain-web。
 */
export default function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKeyPublic[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState("")
  const [busy, setBusy] = useState(false)
  const [createdSecret, setCreatedSecret] = useState<string | null>(null)
  /** 复制结果反馈：null=未操作，'ok'=已复制，'fail'=复制失败。 */
  const [copyState, setCopyState] = useState<"ok" | "fail" | null>(null)

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/auth/keys", { cache: "no-store" })
      if (response.status === 401) { setError("请先登录后再管理 API 密钥"); return }
      if (!response.ok) throw new Error("读取密钥失败")
      const payload = await response.json() as { keys?: ApiKeyPublic[] }
      setKeys(payload.keys || [])
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "读取密钥失败")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void (async () => { await load() })() }, [load])

  /**
   * 复制明文密钥。必须给用户反馈：内网 http 下浏览器可能禁用剪贴板 API，
   * 静默失败会让用户以为按钮坏了（这正是之前的体验问题）。
   */
  const handleCopy = async (text: string) => {
    const ok = await copyToClipboard(text)
    setCopyState(ok ? "ok" : "fail")
    if (ok) {
      window.setTimeout(() => setCopyState((current) => (current === "ok" ? null : current)), 2000)
    }
  }

  const createKey = async () => {
    const name = newName.trim()
    if (!name || busy) return
    setBusy(true); setError(null); setCreatedSecret(null); setCopyState(null)
    try {
      const response = await fetch("/api/auth/keys", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      })
      const payload = await response.json() as { secret?: string; error?: string }
      if (!response.ok || !payload.secret) throw new Error(payload.error || "创建失败")
      setCreatedSecret(payload.secret)
      setNewName("")
      setShowCreate(false)
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "创建失败")
    } finally { setBusy(false) }
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

  return (
    <div className="min-h-screen">
      <Header title="Settings" description="管理 GBrain Web 的配置与凭据" />
      <div className="flex">
        <aside className="w-56 shrink-0 border-r border-border p-4">
          <SettingsNav />
        </aside>
        <main className="flex-1 p-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base"><KeyRound className="h-4 w-4" />API 密钥</CardTitle>
              <CardDescription>管理用于程序化访问 GBrain Web 的 API 密钥（如命令行上传 SDK）。密钥以你的身份访问，权限与网页一致。</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {error && <div role="alert" className="flex gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive"><AlertCircle className="h-4 w-4 shrink-0" />{error}</div>}

              {loading ? <p className="text-sm text-muted-foreground">加载中…</p> : keys.length === 0 && !showCreate ? (
                <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-10 text-center">
                  <KeyRound className="h-10 w-10 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium">暂无 API 密钥</p>
                    <p className="text-xs text-muted-foreground">创建 API 密钥以程序化方式访问 GBrain</p>
                  </div>
                  <Button className="gap-2" onClick={() => setShowCreate(true)}><Plus className="h-4 w-4" />创建 API 密钥</Button>
                </div>
              ) : (
                <div className="space-y-3">
                  {showCreate && (
                    <div className="flex flex-wrap items-end gap-2 rounded-lg border p-3">
                      <div className="space-y-2">
                        <label htmlFor="api-key-name" className="text-sm font-medium">API 密钥名称</label>
                        <Input id="api-key-name" autoFocus value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="例如 dsp-upload" />
                      </div>
                      <Button className="gap-2" disabled={!newName.trim() || busy} onClick={() => void createKey()}>
                        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}创建
                      </Button>
                      <Button variant="outline" className="gap-1" onClick={() => { setShowCreate(false); setNewName("") }}><X className="h-4 w-4" />取消</Button>
                    </div>
                  )}
                  {keys.map((key) => (
                    <div key={key.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm">
                      <div className="min-w-0">
                        <div className="font-medium">{key.name} <span className="text-xs text-muted-foreground">{key.keyPrefix}</span></div>
                        <div className="text-xs text-muted-foreground">{key.isActive ? "启用" : "已停用"}{key.lastUsedAt ? ` · 最近使用 ${new Date(key.lastUsedAt).toLocaleString()}` : " · 未使用"}</div>
                      </div>
                      <Button size="sm" variant="destructive" className="gap-1" disabled={busy} onClick={() => void deleteKey(key.id)}><Trash2 className="h-3.5 w-3.5" />删除</Button>
                    </div>
                  ))}
                  {!showCreate && <Button variant="outline" className="gap-2" onClick={() => setShowCreate(true)}><Plus className="h-4 w-4" />创建 API 密钥</Button>}
                </div>
              )}
            </CardContent>
          </Card>
        </main>
      </div>

      {/* 创建成功弹窗：显示明文密钥（只此一次），点「确定」关闭。 */}
      {createdSecret && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label="API 密钥已创建">
          <div className="w-full max-w-md space-y-4 rounded-lg border border-border bg-background p-5 shadow-lg">
            <div className="space-y-1">
              <h3 className="text-base font-semibold">API 密钥已创建</h3>
              <p className="text-sm text-muted-foreground">此明文只显示一次，请立即复制保存。关闭后无法再次查看。</p>
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 break-all rounded bg-muted px-2 py-2 text-xs">{createdSecret}</code>
              <Button
                size="sm"
                variant="outline"
                className="gap-1 shrink-0"
                onClick={() => void handleCopy(createdSecret)}
              >
                {copyState === "ok"
                  ? <><Check className="h-3.5 w-3.5" />已复制</>
                  : <><Copy className="h-3.5 w-3.5" />复制</>}
              </Button>
            </div>
            {copyState === "fail" && (
              <p className="text-xs text-destructive">
                复制失败，请手动选中上方密钥后按 Ctrl+C（或 Command+C）。
              </p>
            )}
            <p className="text-xs text-muted-foreground">用法：<code>export GBRAIN_API_KEY=&lt;密钥&gt;</code></p>
            <div className="flex justify-end">
              <Button onClick={() => { setCreatedSecret(null); setCopyState(null) }}>确定</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
