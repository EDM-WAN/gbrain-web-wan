import { readJson, writeJsonAtomic } from "./web-state.ts"

export type SdkSourceKind = "directory" | "git" | "manifest"
export type SdkManifestTool = "auto" | "repo" | "west"

/**
 * source 归属域（阶段 2）：
 *  - personal：个人 source，仅 owner 可见可改（admin 也不例外，保密性）
 *  - team：团队 source，指定 namespace 的成员可见；Developer+ 可改
 *  - system：系统/公共 source，所有人可见；仅 admin 可改
 *
 * 缺省（老数据没有该字段）按 personal 处理，见 effectiveScope()。
 */
export type SdkSourceScope = "personal" | "team" | "system"

export interface SdkSourceConfig {
  sourceId: string
  kind: SdkSourceKind
  path?: string
  url?: string
  branch?: string
  manifestTool?: SdkManifestTool
  manifestUrl?: string
  intervalMinutes: number
  enabled: boolean
  createdAt: string
  updatedAt: string
  lastRunAt?: string
  nextRunAt?: string
  lastSuccessAt?: string
  lastStatus?: "queued" | "running" | "completed" | "failed" | "paused"
  lastJobId?: string
  lastError?: string
  consecutiveFailures?: number
  // ── 阶段 2：归属与权限 ──
  scope?: SdkSourceScope
  /** 创建者 userId（personal/team 归属判定用；system 可为 null）。 */
  ownerUserId?: number | null
  /** personal → "default"；team → 团队 namespace 名；system → "system"。 */
  namespace?: string
}

/** 解析归属域：老数据无 scope 时按 personal 处理（向后兼容）。 */
export function effectiveScope(config: Pick<SdkSourceConfig, "scope">): SdkSourceScope {
  return config.scope ?? "personal"
}

/** 解析 namespace：老数据无值时按 "default"（个人空间）处理。 */
export function effectiveNamespace(config: Pick<SdkSourceConfig, "scope" | "namespace">): string {
  if (config.namespace) return config.namespace
  return effectiveScope(config) === "system" ? "system" : "default"
}

/**
 * 解析一条 source 配置的归属。
 *
 * 规则（与 `config/route.ts` 的 POST 归属解析一致）：
 *  - **已有配置的归属不可变** —— 沿用原 scope/namespace/owner，不因「换个人重传」
 *    而夺走归属；
 *  - 缺失时归给调用方（`fallbackOwnerUserId`），scope 按个人源。
 *
 * 为什么这条必须显式写：早先 `commitUploadSession` 保存配置时不带这三个字段，
 * 这些记录随后被 `backfillSourceOwnership` 补成「**首个 admin**」。于是非 admin
 * 用 API key 上传的 source 会归到 admin 名下，上传者本人反而看不到（个人源仅
 * owner 可见）。之所以长期没暴露，是因为首个 admin 恰好是最早的上传者。
 */
export function resolveOwnership(
  existing: Pick<SdkSourceConfig, "scope" | "namespace" | "ownerUserId"> | null | undefined,
  fallbackOwnerUserId: number | null,
): { scope: SdkSourceScope; namespace: string; ownerUserId: number | null } {
  const scope = existing?.scope ?? "personal"
  const namespace = existing?.namespace ?? (scope === "system" ? "system" : "default")
  // system 源是公共源（所有人可见、仅 admin 可管），没有「私人 owner」的概念：
  // 不能因为某个人传过一次就把 owner 写成他，否则会污染后续的归属判定。
  const ownerUserId = scope === "system" ? (existing?.ownerUserId ?? null) : existing?.ownerUserId ?? fallbackOwnerUserId
  return { scope, namespace, ownerUserId }
}

const CONFIG_FILE = "sdk-sources.json"

export async function listSdkSourceConfigs(): Promise<SdkSourceConfig[]> {
  return readJson<SdkSourceConfig[]>(CONFIG_FILE, [])
}

export async function getSdkSourceConfig(sourceId: string): Promise<SdkSourceConfig | null> {
  return (await listSdkSourceConfigs()).find((item) => item.sourceId === sourceId) ?? null
}

export async function saveSdkSourceConfig(config: SdkSourceConfig): Promise<SdkSourceConfig> {
  const configs = await listSdkSourceConfigs()
  const index = configs.findIndex((item) => item.sourceId === config.sourceId)
  const saved = index >= 0
    ? { ...configs[index], ...config, createdAt: configs[index].createdAt }
    : config
  if (index >= 0) configs[index] = saved
  else configs.push(saved)
  await writeJsonAtomic(CONFIG_FILE, configs.sort((itemA, itemB) => itemA.sourceId.localeCompare(itemB.sourceId)))
  return saved
}

export async function updateSdkSourceConfig(
  sourceId: string,
  update: (config: SdkSourceConfig) => SdkSourceConfig,
): Promise<SdkSourceConfig | null> {
  const configs = await listSdkSourceConfigs()
  const index = configs.findIndex((item) => item.sourceId === sourceId)
  if (index < 0) return null
  const next = update(configs[index])
  configs[index] = next
  await writeJsonAtomic(CONFIG_FILE, configs.sort((a, b) => a.sourceId.localeCompare(b.sourceId)))
  return next
}

export async function removeSdkSourceConfig(sourceId: string): Promise<void> {
  await writeJsonAtomic(CONFIG_FILE, (await listSdkSourceConfigs()).filter((item) => item.sourceId !== sourceId))
}

/**
 * 一次性归属回填（阶段 2 迁移）：给历史 source（无 scope/ownerUserId）补上
 * scope="personal" + ownerUserId + namespace="default"。
 *
 * 幂等：已有 scope 的条目不动。owner 由调用方传入（首个 admin 的 userId）。
 * 若 ownerUserId 为 null（没有可归属的管理员），保持 null —— 此时这些 source
 * 谁也不是 owner，只有 admin 能在"个人源仅本人"规则外……其实 personal 规则对
 * admin 不放宽，所以 null owner 的 personal source 会变得谁都管不了。为避免
 * 这种锁死，owner 为 null 时不写入 scope（留给下次有 admin 时再回填）。
 */
export async function backfillSourceOwnership(ownerUserId: number | null): Promise<number> {
  const configs = await listSdkSourceConfigs()
  let changed = 0
  if (ownerUserId === null) return changed
  const next = configs.map((config) => {
    if (config.scope) return config
    changed += 1
    return {
      ...config,
      scope: "personal" as const,
      ownerUserId,
      namespace: "default",
    }
  })
  if (changed > 0) {
    await writeJsonAtomic(CONFIG_FILE, next.sort((a, b) => a.sourceId.localeCompare(b.sourceId)))
  }
  return changed
}
