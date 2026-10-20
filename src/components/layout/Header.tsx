"use client"

import { useEffect, useRef, useState } from "react"
import { Bell, LogOut, RefreshCw, User as UserIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useGBrainStore } from "@/lib/store"

interface HeaderProps {
  title: string
  description?: string
  onRefresh?: () => void
  action?: React.ReactNode
}

interface CurrentUser {
  userName: string
  fullName: string
  avatar: string | null
  role: "admin" | "user"
}

/** 顶栏用户区：显示头像 + 用户名 + 登出；未登录则显示「登录」入口。 */
function UserMenu() {
  const [user, setUser] = useState<CurrentUser | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    void fetch("/api/auth/me", { cache: "no-store" })
      .then(async (response) => {
        if (cancelled) return
        if (!response.ok) { setUser(null); return }
        const payload = await response.json() as { user?: CurrentUser | null }
        setUser(payload.user ?? null)
      })
      .catch(() => { if (!cancelled) setUser(null) })
      .finally(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!open) return
    const onClick = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onClick)
    return () => document.removeEventListener("mousedown", onClick)
  }, [open])

  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined)
    window.location.href = "/login"
  }

  if (!loaded) return null

  if (!user) {
    return (
      <Button variant="outline" size="sm" className="gap-2" onClick={() => { window.location.href = "/login" }}>
        <UserIcon className="h-4 w-4" />
        登录
      </Button>
    )
  }

  const initial = (user.fullName || user.userName || "?").trim().charAt(0).toUpperCase()

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-2 rounded-full border border-border py-1 pl-1 pr-3 hover:bg-accent"
      >
        {/* 阶段 1 无头像 URL（avatar 恒为 null），统一用用户名首字母占位。
            将来接入头像时改用 next/image。 */}
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 text-sm font-medium">{initial}</span>
        <span className="max-w-[10rem] truncate text-sm">{user.fullName || user.userName}</span>
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-44 rounded-lg border border-border bg-background p-1 shadow-md">
          <div className="px-3 py-2 text-xs text-muted-foreground">
            {user.userName}{user.role === "admin" ? " · 管理员" : ""}
          </div>
          <button
            type="button"
            onClick={() => void handleLogout()}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent"
          >
            <LogOut className="h-4 w-4" />
            登出
          </button>
        </div>
      )}
    </div>
  )
}

export function Header({ title, description, onRefresh, action }: HeaderProps) {
  const isLoading = useGBrainStore((s) => s.isLoading)

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-border bg-background/95 px-6 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="flex flex-col gap-0.5">
        <h1 className="text-xl font-semibold">{title}</h1>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </div>

      <div className="flex items-center gap-2">
        {action}
        {onRefresh && (
          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={isLoading}
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        )}
        <Button variant="outline" size="icon">
          <Bell className="h-4 w-4" />
        </Button>
        <UserMenu />
      </div>
    </header>
  )
}
