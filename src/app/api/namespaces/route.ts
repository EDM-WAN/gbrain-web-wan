import { NextRequest, NextResponse } from "next/server"
import { requireUser } from "@/lib/api-guard"
import { createNamespace, groupRole, hasPermission, listNamespaces, removeNamespace, setMemberRole, type GroupRole } from "@/lib/namespaces"
import { findUserByName, findUserById } from "@/lib/web-users"

export const runtime = "nodejs"

const ROLES: GroupRole[] = ["Owner", "Maintainer", "Developer", "Reporter"]

/**
 * GET /api/namespaces
 * 列出当前用户可见的团队（admin 看全部；普通用户看自己所在的团队）。
 */
export async function GET(request: NextRequest) {
  const auth = await requireUser(request)
  if (!auth.ok) return auth.response
  const user = auth.value
  const all = await listNamespaces()
  if (user.role === "admin") return NextResponse.json({ namespaces: all })
  const mine = all.filter((ns) => ns.members.some((member) => member.userId === user.id))
  return NextResponse.json({ namespaces: mine })
}

/**
 * POST /api/namespaces
 * body: { action, ... }
 *   - create:    { name }                     任意登录用户可建团队（创建者即 Owner）
 *   - addMember: { name, userName, role }     需 Owner/Maintainer
 *   - removeMember: { name, userId }          需 Owner/Maintainer
 *   - delete:    { name }                     需 Owner（或 admin）
 */
export async function POST(request: NextRequest) {
  const auth = await requireUser(request)
  if (!auth.ok) return auth.response
  const user = auth.value
  try {
    const body = await request.json() as { action?: unknown; name?: unknown; userName?: unknown; userId?: unknown; role?: unknown }
    const action = typeof body.action === "string" ? body.action : ""
    const name = typeof body.name === "string" ? body.name.trim() : ""
    if (!name) return NextResponse.json({ error: "需要团队名" }, { status: 400 })

    /** 变更成员/删除需要 Owner/Maintainer；创建只需登录。 */
    const requireManager = async (): Promise<NextResponse | null> => {
      if (user.role === "admin") return null
      const role = await groupRole(user.id, name)
      if (!hasPermission(role, "Maintainer")) {
        return NextResponse.json({ error: `无权管理团队 "${name}"` }, { status: 403 })
      }
      return null
    }

    if (action === "create") {
      const created = await createNamespace({ name, createdBy: user.id })
      return NextResponse.json({ namespace: created }, { status: 201 })
    }
    if (action === "delete") {
      if (user.role !== "admin") {
        const role = await groupRole(user.id, name)
        if (role !== "Owner") return NextResponse.json({ error: "只有团队 Owner（或管理员）能删除团队" }, { status: 403 })
      }
      await removeNamespace(name)
      return NextResponse.json({ ok: true })
    }
    if (action === "addMember" || action === "removeMember") {
      const denied = await requireManager()
      if (denied) return denied
      if (action === "addMember") {
        const userName = typeof body.userName === "string" ? body.userName.trim() : ""
        const role = ROLES.includes(body.role as GroupRole) ? (body.role as GroupRole) : "Developer"
        const target = await findUserByName(userName)
        if (!target) return NextResponse.json({ error: `找不到用户 "${userName}"（该用户需先登录过一次）` }, { status: 404 })
        const updated = await setMemberRole(name, target.id, role)
        if (!updated) return NextResponse.json({ error: `找不到团队 "${name}"` }, { status: 404 })
        return NextResponse.json({ namespace: updated })
      }
      const userId = typeof body.userId === "number" ? body.userId : Number(body.userId)
      if (!Number.isInteger(userId)) return NextResponse.json({ error: "需要有效 userId" }, { status: 400 })
      if (!await findUserById(userId)) return NextResponse.json({ error: "用户不存在" }, { status: 404 })
      const updated = await setMemberRole(name, userId, null)
      if (!updated) return NextResponse.json({ error: `找不到团队 "${name}"` }, { status: 404 })
      return NextResponse.json({ namespace: updated })
    }
    return NextResponse.json({ error: "不支持的团队操作" }, { status: 400 })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "团队操作失败" }, { status: 400 })
  }
}
