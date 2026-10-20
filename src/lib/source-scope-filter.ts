/**
 * source 越权收敛的**纯逻辑**（无服务端依赖，可被 `node --test` 直接覆盖）。
 *
 * 背景：gbrain 的读权限按 **OAuth client** 判定，而本部署所有浏览器会话共用
 * 同一个服务端 client，于是「省略 source_id」时 gbrain 按 client 的整个
 * `federated_read` 授权展开 —— 跨用户返回内容。网关必须在出口按行剔除他人
 * source 的行，并在这类「合成文本」op 上改写请求。
 *
 * 服务端相关的取数在 `visible-sources.ts`（它 import gbrain-server，会拉起
 * `next/headers`，故不放在本模块）。
 */

/** 归属分组：三档归属域之外，另加「未注册」——gbrain 里有、但 Web 侧无归属配置。 */
export type SourceScopeGroup = "personal" | "team" | "system" | "unregistered"

export interface ScopeVisibleSource {
  id: string
  name: string
  pageCount: number
  scope: SourceScopeGroup
  namespace: string
}

/** 当前用户可见 source 的 id 集合 + gbrain 授权给服务端 client 的全集。 */
export interface SourceAccess {
  visibleIds: ReadonlySet<string>
  /**
   * true 表示「省略 source_id 时 gbrain 的展开范围」严格大于用户的可见集
   * —— 此时必须收敛（否则读到他人内容）。
   */
  narrowed: boolean
  visible: ScopeVisibleSource[]
}

/**
 * 某一行是否为「属于他人 source 的行」。
 *
 * 只认行对象上字符串型 `source_id`；不含该字段的对象（如 source_inventory 的
 * folder，它带的是复数 `source_ids`）一律不算 —— 避免误删结构节点。
 */
export function isForeignRow(item: unknown, visibleIds: ReadonlySet<string>): boolean {
  if (!item || typeof item !== "object" || Array.isArray(item)) return false
  const sid = (item as { source_id?: unknown }).source_id
  return typeof sid === "string" && sid.length > 0 && !visibleIds.has(sid)
}

/** 顶层结果本身是否就是一条他人 source 的行（用于 403 而非静默返回空）。 */
export function isForeignResult(value: unknown, visibleIds: ReadonlySet<string>): boolean {
  return isForeignRow(value, visibleIds)
}

/**
 * 递归剔除结果里属于他人 source 的行。
 *
 * 为什么不改请求而改结果：gbrain 的读 op 只接受单个 `source_id`（无复数参数，
 * 见 gbrain `ops/context.ts` 的 `parseSourceIdParam`），而 UI 的「全部 source」
 * 是**省略**该参数 —— 此时 gbrain 按服务端共享 client 的整个 `federated_read`
 * 授权展开（`sourceScopeOpts`），会跨用户返回内容。收窄请求无法表达「我可见的
 * 这 N 个子集」，所以在网关按行剔除是唯一不需要改 gbrain 的可行做法。
 *
 * 副作用：可能留下的计数类字段（total 等）与实际行数不一致。属外观问题，
 * 不涉及内容泄漏，可接受。
 */
export function filterForeignRows<T>(value: T, visibleIds: ReadonlySet<string>): T {
  if (Array.isArray(value)) {
    return value
      .filter((item) => !isForeignRow(item, visibleIds))
      .map((item) => filterForeignRows(item, visibleIds)) as unknown as T
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = filterForeignRows(item, visibleIds)
    }
    return out as unknown as T
  }
  return value
}
