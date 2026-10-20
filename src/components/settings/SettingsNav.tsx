"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { KeyRound, Settings2 } from "lucide-react"
import { cn } from "@/lib/utils"

const ITEMS = [
  { name: "通用", href: "/settings", icon: Settings2 },
  { name: "API 密钥", href: "/settings/apikeys", icon: KeyRound },
]

/** Settings 内的左侧子导航（照 Wegent 的“开发者凭据 → API 密钥”分层）。 */
export function SettingsNav() {
  const pathname = usePathname()
  return (
    <nav className="space-y-1">
      {ITEMS.map((item) => {
        const active = pathname === item.href
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
              active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <item.icon className="h-4 w-4" />
            {item.name}
          </Link>
        )
      })}
    </nav>
  )
}
