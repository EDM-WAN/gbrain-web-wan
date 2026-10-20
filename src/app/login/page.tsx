"use client"

import { Suspense } from "react"
import { useSearchParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { AlertCircle, LogIn } from "lucide-react"

const ERROR_TEXT: Record<string, string> = {
  bad_sig: "签名校验失败，请重试或联系管理员。",
  bad_nonce: "登录请求已失效或重复，请重新发起登录。",
  bad_payload: "PMS 返回数据格式异常。",
  missing_params: "缺少登录参数。",
  missing_nonce: "缺少 nonce。",
  missing_username: "PMS 未返回用户名。",
  disabled: "该账号已被禁用。",
}

/**
 * 登录页。
 *
 * 关键：登录按钮必须是浏览器顶层跳转（window.location.href），不能 fetch——
 * PMS 靠 realpm_session cookie 识别用户，只有顶层跳转才会带上它。
 *
 * useSearchParams 读取回调错误码，Next 要求包裹在 Suspense 边界内。
 */
function LoginCard() {
  const searchParams = useSearchParams()
  // 直接读 query（useSearchParams 本身是响应式的），避免 effect 内 setState。
  const errorCode = searchParams.get("error")

  const handleLogin = () => {
    window.location.href = "/api/auth/sso/login"
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>登录 GBrain</CardTitle>
        <CardDescription>使用 PMS（realpm）账号登录</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Button className="w-full gap-2" onClick={handleLogin}>
          <LogIn className="h-4 w-4" />
          用 PMS 账号登录
        </Button>
        {errorCode && (
          <div role="alert" className="flex gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {ERROR_TEXT[errorCode] ?? `登录失败：${errorCode}`}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <Suspense fallback={null}>
        <LoginCard />
      </Suspense>
    </div>
  )
}
