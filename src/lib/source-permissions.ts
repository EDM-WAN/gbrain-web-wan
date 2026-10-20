import { groupRole, hasPermission, type GroupRole } from "./namespaces.ts"
import { effectiveNamespace, effectiveScope, type SdkSourceConfig } from "./sdk-sources.ts"
import type { WebUser } from "./web-users.ts"

/**
 * source 权限判定（阶段 2）。四个函数照抄 Wegent
 * `services/knowledge/permission_policy.py` 的语义，映射到 gbrain 的
 * source / 团队模型上：
 *
 *   个人 source（scope=personal）：只有 owner 本人可管，**admin 也不例外**
 *     —— 这正是"管理员不能动别人的个人 source"的保密性要求。
 *   团队 source（scope=team）：namespace 成员按角色，Maintainer+ 可管；
 *     Developer 仅能管自己创建的。
 *   系统 source（scope=system）：所有人可见只读，仅 admin 可管。
 */

/** 能否在目标 namespace 下创建 source（对应 can_create_namespace_knowledge_base）。 */
export async function canCreateSource(
  user: WebUser,
  target: { scope: "personal" | "team"; namespace: string },
): Promise<boolean> {
  if (target.scope === "personal") return true // 个人源人人可建
  if (user.role === "admin") return true
  const role = await groupRole(user.id, target.namespace)
  return hasPermission(role, "Developer")
}

/** 能否管理某 source（对应 can_manage_namespace_knowledge_base）。 */
export async function canManageSource(user: WebUser, source: SdkSourceConfig): Promise<boolean> {
  const scope = effectiveScope(source)

  if (scope === "personal") {
    // ★ 个人源：仅本人；admin 不放宽（保密性）
    return source.ownerUserId === user.id
  }
  if (scope === "system") {
    return user.role === "admin"
  }
  // team：admin 可管；Maintainer+ 可管；Developer 仅能管自己创建的
  if (user.role === "admin") return true
  const role = await groupRole(user.id, effectiveNamespace(source))
  if (hasPermission(role, "Maintainer")) return true
  return role === "Developer" && source.ownerUserId === user.id
}

/** 能否向该 source 上传/索引内容（对应 can_manage_..._documents）。 */
export async function canUploadToSource(user: WebUser, source: SdkSourceConfig): Promise<boolean> {
  if (await canManageSource(user, source)) return true
  if (effectiveScope(source) !== "team") return false
  const role = await groupRole(user.id, effectiveNamespace(source))
  return hasPermission(role, "Developer")
}

/** 能否看到该 source（可见性；个人源仅本人、团队源成员、系统源所有人）。 */
export async function canViewSource(user: WebUser, source: SdkSourceConfig): Promise<boolean> {
  const scope = effectiveScope(source)
  if (scope === "system") return true
  if (scope === "personal") return source.ownerUserId === user.id
  // team：admin 或成员
  if (user.role === "admin") return true
  return (await groupRole(user.id, effectiveNamespace(source))) !== null
}

/**
 * 能否修改某条内容（阶段 3 用；对应 can_manage_accessible_knowledge_document）。
 * 公源里只能改自己传的 —— contentOwnerUserId 来自 gbrain pages.frontmatter.uploaded_by。
 */
export async function canModifyContent(
  user: WebUser,
  source: SdkSourceConfig,
  contentOwnerUserId: number | null,
): Promise<boolean> {
  if (await canManageSource(user, source)) return true
  return contentOwnerUserId !== null && contentOwnerUserId === user.id
}

/** 过滤出某用户可见的 source 列表。 */
export async function filterVisibleSources(
  user: WebUser,
  sources: SdkSourceConfig[],
): Promise<SdkSourceConfig[]> {
  const flags = await Promise.all(sources.map((source) => canViewSource(user, source)))
  return sources.filter((_, index) => flags[index])
}

/** 便捷：把 role 判定的结果收集成 {sourceId: {canManage, canUpload}} 供 UI 用。 */
export async function annotatePermissions(
  user: WebUser,
  sources: SdkSourceConfig[],
): Promise<Array<{ sourceId: string; canManage: boolean; canUpload: boolean }>> {
  return Promise.all(sources.map(async (source) => ({
    sourceId: source.sourceId,
    canManage: await canManageSource(user, source),
    canUpload: await canUploadToSource(user, source),
  })))
}

export type { GroupRole }
