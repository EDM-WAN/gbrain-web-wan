import { readJson, writeJsonAtomic } from "./web-state.ts"

/**
 * 内容级 owner 映射（阶段 3，sidecar 方案 —— 不改 gbrain）。
 *
 * gbrain 的 code 页 frontmatter 由引擎硬编码（import-file.ts:1557，无注入入口），
 * 所以"这一页是谁传的"不在 gbrain 里。改为在 gbrain-web 侧维护一张映射表：
 *
 *   { "<sourceId>": { "<pageSlug>": userId, ... }, ... }
 *
 * **键是 gbrain 的 page slug**（不是文件路径）。原因：删除/权限判定发生时，
 * 前端只有 slug，而 `slugifyCodePath` 是单向的（多路径可能映射到同一 slug，
 * 无法从 slug 反推路径）。所以上传后调 gbrain `list_pages(sourceId)` 拿到
 * 真实 slug↔路径映射，按 **slug** 记录 owner（见 upload/commit 路由）。
 *
 * 团队 source 内只有内容 owner 本人可删改自己上传的部分；个人 source 归 owner。
 */

type SourceMap = Record<string, number>
type OwnerTable = Record<string, SourceMap>

const OWNERS_FILE = "content-owners.json"

async function readTable(): Promise<OwnerTable> {
  return readJson<OwnerTable>(OWNERS_FILE, {})
}

/** 记录一批页面（按 slug）的上传人（同 source 覆盖式写入）。 */
export async function recordContentOwners(sourceId: string, slugs: string[], userId: number): Promise<void> {
  if (slugs.length === 0) return
  const table = await readTable()
  const source = table[sourceId] ?? {}
  for (const slug of slugs) source[slug] = userId
  table[sourceId] = source
  await writeJsonAtomic(OWNERS_FILE, table)
}

/** 单页上传人。 */
export async function recordContentOwner(sourceId: string, slug: string, userId: number): Promise<void> {
  await recordContentOwners(sourceId, [slug], userId)
}

/** 查某页（按 slug）的上传人（无记录返回 null）。 */
export async function contentOwnerOf(sourceId: string, slug: string): Promise<number | null> {
  const table = await readTable()
  return table[sourceId]?.[slug] ?? null
}

/** 某 source 下属于某用户的全部 slug。 */
export async function contentOwnedSlugs(sourceId: string, userId: number): Promise<string[]> {
  const table = await readTable()
  const source = table[sourceId] ?? {}
  return Object.entries(source).filter(([, owner]) => owner === userId).map(([slug]) => slug)
}

/** 删除某 source 的全部 owner 记录（source 被删时清理）。 */
export async function clearSourceOwners(sourceId: string): Promise<void> {
  const table = await readTable()
  if (!(sourceId in table)) return
  delete table[sourceId]
  await writeJsonAtomic(OWNERS_FILE, table)
}
