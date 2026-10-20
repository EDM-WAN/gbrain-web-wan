import { NextRequest, NextResponse } from "next/server"
import { createApiKey, deleteApiKey, listApiKeys, toggleApiKey } from "@/lib/api-keys"
import { requireUser } from "@/lib/api-guard"

export const runtime = "nodejs"

/**
 * API 密钥管理（方案 A，参照 Wegent）。
 *   GET    /api/auth/keys           列出当前用户（admin 可看全部）的密钥
 *   POST   /api/auth/keys           创建（返回明文 key，仅此一次）
 *   PATCH  /api/auth/keys?id=       启用/停用
 *   DELETE /api/auth/keys?id=       删除
 */
export async function GET(request: NextRequest) {
  const auth = await requireUser(request)
  if (!auth.ok) return auth.response
  const user = auth.value
  // 只暴露非 legacy 用户（legacy 虚拟用户没有真实 key）
  if (user.id === 0) return NextResponse.json({ keys: [] })
  return NextResponse.json({ keys: await listApiKeys(user.role === "admin" ? undefined : user.id) })
}

export async function POST(request: NextRequest) {
  const auth = await requireUser(request)
  if (!auth.ok) return auth.response
  const user = auth.value
  if (user.id === 0) return NextResponse.json({ error: "该身份不支持创建 API 密钥" }, { status: 403 })
  try {
    const body = await request.json() as { name?: unknown; description?: unknown; expiresInDays?: unknown }
    const name = typeof body.name === "string" ? body.name.trim() : ""
    if (!name) return NextResponse.json({ error: "请输入密钥名称" }, { status: 400 })
    const expiresInDays = Number(body.expiresInDays)
    const expiresAt = Number.isFinite(expiresInDays) && expiresInDays > 0
      ? Date.now() + expiresInDays * 24 * 60 * 60 * 1000
      : undefined
    const { record, key } = await createApiKey({
      userId: user.id,
      name,
      description: typeof body.description === "string" ? body.description : undefined,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    })
    // key 明文只在这里返回一次
    return NextResponse.json({ key: record, secret: key }, { status: 201 })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "创建密钥失败" }, { status: 400 })
  }
}

export async function PATCH(request: NextRequest) {
  const auth = await requireUser(request)
  if (!auth.ok) return auth.response
  const user = auth.value
  const id = Number(new URL(request.url).searchParams.get("id"))
  if (!Number.isInteger(id)) return NextResponse.json({ error: "需要有效 id" }, { status: 400 })
  const updated = await toggleApiKey(id, user.id, user.role === "admin")
  if (!updated) return NextResponse.json({ error: "密钥不存在或无权限" }, { status: 404 })
  return NextResponse.json({ key: updated })
}

export async function DELETE(request: NextRequest) {
  const auth = await requireUser(request)
  if (!auth.ok) return auth.response
  const user = auth.value
  const id = Number(new URL(request.url).searchParams.get("id"))
  if (!Number.isInteger(id)) return NextResponse.json({ error: "需要有效 id" }, { status: 400 })
  const removed = await deleteApiKey(id, user.id, user.role === "admin")
  if (!removed) return NextResponse.json({ error: "密钥不存在或无权限" }, { status: 404 })
  return NextResponse.json({ ok: true })
}
