"use client"

import { useEffect, useRef, useState } from "react"
import { Input } from "@/components/ui/input"
import { Loader2 } from "lucide-react"

interface SearchUser {
  id: number
  userName: string
  fullName: string
  email: string
}

interface UserSearchSelectProps {
  /** 选中后回调（用于填入成员用户名等）。 */
  onSelect: (user: SearchUser) => void
  placeholder?: string
  className?: string
  disabled?: boolean
  "aria-label"?: string
}

/**
 * 用户名搜索补全下拉（照 Wegent `UserSearchSelect`）。
 * 输入即 300ms 防抖调 `/api/users/search?q=`，下拉显示匹配用户，点击选中。
 * 不限制必须是 userName —— 选中后传回完整 user 对象。
 */
export function UserSearchSelect({ onSelect, placeholder = "输入用户名…", className, disabled, ...rest }: UserSearchSelectProps) {
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<SearchUser[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // 300ms 防抖搜索（异步在 effect 内定义、由定时器/微任务触发 setState，
  // 符合 react-hooks/set-state-in-effect：不在 effect body 同步 setState）。
  useEffect(() => {
    const q = query.trim()
    let cancelled = false
    const run = async () => {
      if (q.length === 0) { if (!cancelled) setResults([]); return }
      setLoading(true)
      try {
        const response = await fetch(`/api/users/search?q=${encodeURIComponent(q)}&limit=10`, { cache: "no-store" })
        if (!response.ok) { if (!cancelled) setResults([]); return }
        const payload = await response.json() as { users?: SearchUser[] }
        if (!cancelled) { setResults(payload.users ?? []); setOpen(true) }
      } catch {
        if (!cancelled) setResults([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    const timer = setTimeout(() => void run(), 300)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [query])

  // 点击外部关闭。
  useEffect(() => {
    if (!open) return
    const onClick = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onClick)
    return () => document.removeEventListener("mousedown", onClick)
  }, [open])

  const choose = (user: SearchUser) => {
    setQuery(user.userName)
    setOpen(false)
    setResults([])
    onSelect(user)
  }

  return (
    <div className={`relative ${className ?? ""}`} ref={containerRef} {...rest}>
      <div className="relative">
        <Input
          value={query}
          disabled={disabled}
          onChange={(event) => { setQuery(event.target.value); setOpen(true) }}
          onFocus={() => { if (results.length > 0) setOpen(true) }}
          placeholder={placeholder}
          className="h-8 w-44 pr-7"
        />
        {loading && <Loader2 className="absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-muted-foreground" />}
      </div>
      {open && query.trim().length > 0 && (
        <div className="absolute z-50 mt-1 max-h-56 w-56 overflow-auto rounded-md border border-border bg-background p-1 shadow-md">
          {results.length === 0 && !loading ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">无匹配用户</div>
          ) : results.map((user) => (
            <button
              key={user.id}
              type="button"
              onClick={() => choose(user)}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs">{(user.fullName || user.userName).charAt(0).toUpperCase()}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{user.userName}</span>
                <span className="block truncate text-xs text-muted-foreground">{user.fullName}{user.email ? ` · ${user.email}` : ""}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
