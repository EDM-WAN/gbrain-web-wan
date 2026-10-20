"use client"

import { useState, useEffect } from "react"
import { Header } from "@/components/layout/Header"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { AlertCircle, CheckCircle2, Key, Terminal, ExternalLink } from "lucide-react"
import { setGbrainToken, clearGbrainToken, hasGbrainToken } from "@/lib/gbrain"
import { SettingsNav } from "@/components/settings/SettingsNav"

export default function SettingsPage() {
  const [token, setToken] = useState("")
  const [hasToken, setHasToken] = useState(false)
  const [status, setStatus] = useState<"idle" | "success" | "error">("idle")
  const [statusMessage, setStatusMessage] = useState("")

  useEffect(() => {
    hasGbrainToken().then(setHasToken)
  }, [])

  const handleSave = async () => {
    if (!token.trim()) return

    try {
      await setGbrainToken(token.trim())
      setHasToken(true)
      setToken("")
      setStatus("success")
      setStatusMessage("Token 已保存")
      setTimeout(() => setStatus("idle"), 3000)
    } catch {
      setStatus("error")
      setStatusMessage("保存失败")
      setTimeout(() => setStatus("idle"), 3000)
    }
  }

  const handleClear = async () => {
    try {
      await clearGbrainToken()
      setHasToken(false)
      setToken("")
      setStatus("success")
      setStatusMessage("Token 已清除")
      setTimeout(() => setStatus("idle"), 3000)
    } catch {
      setStatus("error")
      setStatusMessage("清除失败")
      setTimeout(() => setStatus("idle"), 3000)
    }
  }

  return (
    <div className="min-h-screen">
      <Header title="Settings" description="配置 GBrain 连接" />
      <div className="flex">
        <aside className="w-56 shrink-0 border-r border-border p-4">
          <SettingsNav />
        </aside>
        <div className="flex-1 p-6 space-y-6 max-w-2xl">
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Key className="h-4 w-4" />
              Web 访问令牌
            </CardTitle>
            <CardDescription>
              设置 Web 自身的访问令牌（GBRAIN_WEB_ACCESS_TOKEN），用于访问本页及全部 API。它与服务端 OAuth 凭据分离，浏览器不会接触到 OAuth client secret。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Web Access Token</label>
              <Input
                type="password"
                placeholder="gbrain_web_xxx"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
              {hasToken && (
                <p className="text-xs text-muted-foreground">
                  已配置（存储在 httpOnly cookie 中，与服务端 OAuth 凭据分离）
                </p>
              )}
            </div>
            <div className="flex gap-2">
              <Button onClick={handleSave} disabled={!token.trim()}>
                保存
              </Button>
              {hasToken && (
                <Button variant="outline" onClick={handleClear}>
                  清除
                </Button>
              )}
            </div>
            {status === "success" && (
              <div className="flex items-center gap-2 text-sm text-green-600">
                <CheckCircle2 className="h-4 w-4" />
                {statusMessage}
              </div>
            )}
            {status === "error" && (
              <div className="flex items-center gap-2 text-sm text-destructive">
                <AlertCircle className="h-4 w-4" />
                {statusMessage}
              </div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Terminal className="h-4 w-4" />
              如何配置
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-3">
              <p className="text-sm">这是一个浏览器访问 Web 页面的独立令牌。服务端访问 GBrain 时使用它自己的 OAuth 凭据（GBRAIN_OAUTH_CLIENT_ID / GBRAIN_OAUTH_CLIENT_SECRET），浏览器不会接触到这些凭据。</p>
              <p className="text-sm">1. 在 Web 服务的 .env 中配置 OAuth 客户端（仅服务端可见）：</p>
              <pre className="bg-muted p-3 rounded-lg text-xs overflow-x-auto">
                {`GBRAIN_URL=http://127.0.0.1:9000
GBRAIN_OAUTH_CLIENT_ID=gbrain-web-global
GBRAIN_OAUTH_CLIENT_SECRET=<从 register-client 输出获取>
GBRAIN_WEB_ACCESS_TOKEN=<随机生成的高熵 Web 访问令牌>`}
              </pre>
              <p className="text-sm">2. 将上方 GBRAIN_WEB_ACCESS_TOKEN 的值粘贴到本输入框。CLI（scripts/gbrain-sdk-sync.mjs）也通过环境变量 GBRAIN_WEB_ACCESS_TOKEN 使用同一个令牌。</p>
              <p className="text-sm">3. 本机无 OAuth 的纯本地模式仍可沿用 GBRAIN_TOKEN（legacy token）作为兜底。</p>
              <a
                href="https://github.com/garrytan/gbrain"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-sm text-primary hover:underline"
              >
                <ExternalLink className="h-3 w-3" />
                查看 GBrain 文档
              </a>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">环境配置</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">GBrain URL</span>
                <code className="text-xs bg-muted px-2 py-1 rounded">
                  {process.env.NEXT_PUBLIC_GBRAIN_URL || "http://localhost:8787"}
                </code>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">API Route</span>
                <code className="text-xs bg-muted px-2 py-1 rounded">
                  /api/gbrain
                </code>
              </div>
            </div>
          </CardContent>
        </Card>
        </div>
      </div>
    </div>
  )
}