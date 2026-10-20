// 相对导入（而非 `@/lib/...`）：与 lib 内其他模块保持一致。
import { callGBrainServer } from "./gbrain-server.ts"
import { filterVisibleSources } from "./source-permissions.ts"
import { effectiveNamespace, effectiveScope, listSdkSourceConfigs, type SdkSourceConfig } from "./sdk-sources.ts"
import type { SourceAccess, SourceScopeGroup } from "./source-scope-filter.ts"
import type { WebUser } from "./web-users.ts"

/**
 * ★ source 可见性的**唯一裁决点**（服务端）。
 *
 * ## 为什么必须有这个模块
 *
 * gbrain 的 `sources_list` 只按 **OAuth client** 的 `federated_read` 授权返回，
 * 而本部署所有浏览器会话共用同一个服务端 OAuth client
 * （`gbrain-server.ts` → `getGBrainOAuthToken()` 是进程级单例、单一凭据），
 * 于是那份结果**对所有登录用户完全相同**。直接下发给前端，非 owner 就会在
 * source 下拉里看到别人的 source —— 曾实际发生：普通账号看到 `nuwa` / `wegent`。
 *
 * 真正的 per-user 裁决在这里：gbrain 给的原始列表 × Web 侧归属配置
 * → `filterVisibleSources`（个人源仅本人、团队源成员、系统源所有人）。
 *
 * **任何把 source 标识（id / name / 页数）送往浏览器的路径，都必须经过本模块。**
 *
 * ## 未注册 source
 *
 * gbrain 里有、但 Web 侧没有归属配置的 source（如内建 `default`）默认可见，
 * 与 `/api/sources/grouped` 既有语义一致。
 *
 * ## 调用方注意
 *
 * 调用方应先 `backfillSourceOwnership(firstAdminUserId())` 回填历史归属：老数据
 * 缺 scope 时 `effectiveScope()` 按 personal 处理且 owner 为 null，会变成
 * 「谁都看不到」，表现为下拉空白。
 */

/** gbrain `sources_list` 单行的字段（本项目只消费这三个）。 */
export interface RawGBrainSource {
  id?: string
  name?: string
  page_count?: number
}

export interface VisibleSource {
  id: string
  name: string
  pageCount: number
  scope: SourceScopeGroup
  namespace: string
}

/** 一次拉取：gbrain 的原始列表（＝授权全集）+ Web 侧归属配置。 */
async function fetchRawAndConfigs(): Promise<{ registered: RawGBrainSource[]; configById: Map<string, SdkSourceConfig> }> {
  const [rawSources, allConfigs] = await Promise.all([
    callGBrainServer("sources_list", { include_archived: false }) as Promise<{ sources?: RawGBrainSource[] }>,
    listSdkSourceConfigs(),
  ])
  return {
    registered: rawSources.sources ?? [],
    configById: new Map(allConfigs.map((config) => [config.sourceId, config])),
  }
}

/** 由「原始列表 + 归属配置」算出当前用户可见的 source。纯计算，不发请求。 */
async function visibleFromRaw(
  user: WebUser,
  registered: RawGBrainSource[],
  configById: Map<string, SdkSourceConfig>,
): Promise<VisibleSource[]> {
  const configsForVisible = registered
    .map((source) => configById.get(String(source.id ?? "")))
    .filter((config): config is SdkSourceConfig => Boolean(config))
  const visibleIds = new Set(
    (await filterVisibleSources(user, configsForVisible)).map((config) => config.sourceId),
  )

  const result: VisibleSource[] = []
  for (const source of registered) {
    const id = String(source.id ?? "")
    if (!id) continue
    const config = configById.get(id)
    if (config) {
      if (!visibleIds.has(id)) continue
      result.push({
        id,
        name: source.name || id,
        pageCount: Number(source.page_count) || 0,
        scope: effectiveScope(config),
        namespace: effectiveNamespace(config),
      })
    } else {
      result.push({
        id,
        name: source.name || id,
        pageCount: Number(source.page_count) || 0,
        scope: "unregistered",
        namespace: "",
      })
    }
  }
  return result
}

/** 当前用户可见的 source 列表（已按归属域过滤）。 */
export async function listVisibleSources(user: WebUser): Promise<VisibleSource[]> {
  const { registered, configById } = await fetchRawAndConfigs()
  return visibleFromRaw(user, registered, configById)
}

/**
 * 判断某 source 对当前用户是否可见（单个）。用于按 source 拒绝越权读取时复用
 * 同一套规则，避免各处各写一份判定。
 */
export async function isSourceVisibleTo(user: WebUser, sourceId: string): Promise<boolean> {
  const visible = await listVisibleSources(user)
  return visible.some((source) => source.id === sourceId)
}

// ─────────────────────────── 读取结果的越权收敛 ───────────────────────────
// 纯逻辑放在 source-scope-filter.ts（不 import 服务端模块，可被 node --test 覆盖）。

export {
  filterForeignRows,
  isForeignResult,
  isForeignRow,
  type SourceAccess,
  type SourceScopeGroup,
} from "./source-scope-filter.ts"

/**
 * 解析一次读取的 source 访问范围。调用方应先确保 identity 非 legacy。
 *
 * 只发一次 `sources_list`：授权全集与可见集出自同一份原始列表（可见集是它的
 * 子集），分两次取纯属浪费 —— 这条路径在每次无 source_id 的读取上都会走。
 */
export async function resolveSourceAccess(user: WebUser): Promise<SourceAccess> {
  const { registered, configById } = await fetchRawAndConfigs()
  const visible = await visibleFromRaw(user, registered, configById)
  const visibleIds = new Set(visible.map((source) => source.id))
  const grantedCount = registered.filter((source) => String(source.id ?? "").length > 0).length
  const narrowed = grantedCount > visibleIds.size
  return { visibleIds, narrowed, visible }
}
