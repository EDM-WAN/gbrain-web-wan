import { readJson, writeJsonAtomic } from "./web-state.ts"

/**
 * 团队命名空间（阶段 2）。参照 Wegent 的 namespace + 成员角色模型：
 *   - "default" 保留给个人空间（不在本表里）
 *   - 每个 namespace 有一个成员列表，成员带角色（Owner/Maintainer/Developer/Reporter）
 *
 * 角色层级与 Wegent `schemas/base_role.py` 一致（数字越小权限越高）。
 */

export type GroupRole = "Owner" | "Maintainer" | "Developer" | "Reporter"

export const ROLE_RANK: Record<GroupRole, number> = {
  Owner: 0,
  Maintainer: 1,
  Developer: 2,
  Reporter: 3,
}

export interface NamespaceMember {
  userId: number
  role: GroupRole
}

export interface Namespace {
  id: number
  /** 团队名（小写字母数字连字符），作为 source.namespace 的值。 */
  name: string
  level: "organization"
  members: NamespaceMember[]
  createdBy: number
  createdAt: string
  updatedAt: string
}

const NAMESPACES_FILE = "namespaces.json"

/** 团队名规则：与 sourceId 一致（小写字母数字、内部连字符，1-32）。 */
export const NAMESPACE_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/

export async function listNamespaces(): Promise<Namespace[]> {
  return readJson<Namespace[]>(NAMESPACES_FILE, [])
}

export async function findNamespace(name: string): Promise<Namespace | null> {
  return (await listNamespaces()).find((ns) => ns.name === name) ?? null
}

export async function createNamespace(input: { name: string; createdBy: number }): Promise<Namespace> {
  const name = input.name.trim()
  if (!NAMESPACE_NAME_RE.test(name)) throw new Error("团队名只能是小写字母、数字与连字符（1-32 位）")
  if (name === "default" || name === "system") throw new Error(`团队名 "${name}" 是保留名称`)
  const all = await listNamespaces()
  if (all.some((ns) => ns.name === name)) throw new Error(`团队 "${name}" 已存在`)
  const now = new Date().toISOString()
  const created: Namespace = {
    id: all.reduce((max, ns) => Math.max(max, ns.id), 0) + 1,
    name,
    level: "organization",
    // 创建者自动是 Owner
    members: [{ userId: input.createdBy, role: "Owner" }],
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  }
  all.push(created)
  await writeJsonAtomic(NAMESPACES_FILE, all.sort((a, b) => a.name.localeCompare(b.name)))
  return created
}

/** 设置/变更某成员的角色；role 为 null 表示移除成员。 */
export async function setMemberRole(
  name: string,
  userId: number,
  role: GroupRole | null,
): Promise<Namespace | null> {
  const all = await listNamespaces()
  const index = all.findIndex((ns) => ns.name === name)
  if (index < 0) return null
  const ns = all[index]
  const members = ns.members.filter((member) => member.userId !== userId)
  if (role) members.push({ userId, role })
  const updated: Namespace = { ...ns, members, updatedAt: new Date().toISOString() }
  all[index] = updated
  await writeJsonAtomic(NAMESPACES_FILE, all)
  return updated
}

export async function removeNamespace(name: string): Promise<void> {
  await writeJsonAtomic(NAMESPACES_FILE, (await listNamespaces()).filter((ns) => ns.name !== name))
}

/** 某用户在某团队里的角色（非成员返回 null）。 */
export async function groupRole(userId: number, namespaceName: string): Promise<GroupRole | null> {
  const ns = await findNamespace(namespaceName)
  if (!ns) return null
  return ns.members.find((member) => member.userId === userId)?.role ?? null
}

/** 角色是否达到某要求（数字越小权限越高）。 */
export function hasPermission(role: GroupRole | null, required: GroupRole): boolean {
  if (!role) return false
  return ROLE_RANK[role] <= ROLE_RANK[required]
}
