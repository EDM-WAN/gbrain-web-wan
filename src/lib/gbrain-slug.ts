/**
 * gbrain slug 复刻（用于把上传文件的相对路径映射到 gbrain page slug）。
 *
 * 忠实复刻 gbrain `src/core/sync.ts` 的 `slugifyCodePath` / `slugifyPath` /
 * `slugifySegment` / `isCodeFilePath`，以及 `src/core/cjk.ts` 的
 * `SLUG_WORD_CHARS`。让 gbrain-web 能在**上传时**算出每个文件的 page slug，
 * 从而按 slug 记录内容级 owner（阶段 3）。
 *
 * 为什么复刻而非回查 list_pages：wegent 这类 source 有 9000+ 页，上传后分页
 * 拉全量 slug 不现实；而 slugify 是确定性纯函数。正确性由单元测试钉住
 * （test/gbrain-slug.test.ts，与 gbrain 源码注释里的示例对拍）。
 *
 * 若 gbrain 未来改 slug 规则，这里要同步（测试会先失败，起到提醒作用）。
 */

// gbrain cjk.ts:43 —— 保留集：小写字母、修饰字母、其它字母、组合标记、数字。
const SLUG_WORD_CHARS = "\\p{Ll}\\p{Lm}\\p{Lo}\\p{M}\\p{N}"
// gbrain sync.ts:625 —— 删除所有“不在保留集、也不是 . 空格 _ -”的字符。
const SLUGIFY_KEEP_RE = new RegExp(`[^${SLUG_WORD_CHARS}.\\s_\\-]`, "gu")

// gbrain CODE_EXTENSIONS（sync.ts:62，逐项照抄，顺序无关）。决定文件被视为
// code 还是 markdown 页。注意 gbrain **不含** .md/.mdx（.md 是 markdown 页）。
const CODE_EXTENSIONS = [
  ".ts", ".tsx", ".mts", ".cts",
  ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rb", ".go", ".rs", ".java", ".cs",
  ".c++", ".cpp", ".cc", ".cxx", ".hpp", ".hxx", ".hh",
  ".c", ".h", ".xc",
  ".php", ".swift", ".kt", ".kts", ".scala", ".sc", ".lua",
  ".ex", ".exs", ".elm", ".ml", ".mli", ".dart", ".zig", ".sol",
  ".sh", ".bash", ".css", ".html", ".htm", ".astro", ".svelte", ".vue",
  ".json", ".yaml", ".yml", ".toml", ".tf", ".tfvars", ".hcl", ".sql",
]

export function isCodeFilePath(path: string): boolean {
  const lower = path.toLowerCase()
  return CODE_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

/**
 * 复刻 gbrain `slugifySegment`（sync.ts:627）。
 * 步骤：NFD → 去重音 → 去希伯来 niqqud → NFC → 小写 → 删非保留字符 →
 * 空格转连字符 → 合并连字符 → 去首尾连字符。
 */
export function slugifySegment(segment: string): string {
  return segment
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[֑-ׇ]/g, "")
    .normalize("NFC")
    .toLowerCase()
    .replace(SLUGIFY_KEEP_RE, "")
    .replace(/[\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
}

/** 复刻 gbrain `slugifyPath`（markdown 页：保留层级）。 */
export function slugifyPath(filePath: string): string {
  let path = filePath.replace(/\.mdx?$/i, "")
  path = path.replace(/\\/g, "/")
  path = path.replace(/^\.?\//, "")
  return path.split("/").map(slugifySegment).filter(Boolean).join("/")
}

/** 复刻 gbrain `slugifyCodePath`（code 页：拍平成单段，点号→连字符）。 */
export function slugifyCodePath(filePath: string): string {
  let path = filePath.replace(/\\/g, "/")
  path = path.replace(/^\.?\//, "")
  return path
    .split("/")
    .map((segment) => slugifySegment(segment.replace(/\./g, "-")))
    .filter(Boolean)
    .join("-")
}

/** 复刻 gbrain `pathToSlug` 的默认行为（无 repoPrefix）。 */
export function filePathToSlug(filePath: string): string {
  const slug = isCodeFilePath(filePath) ? slugifyCodePath(filePath) : slugifyPath(filePath)
  return slug.toLowerCase()
}

/** 把一批相对路径映射成 slug。 */
export function filePathsToSlugs(paths: string[]): Record<string, string> {
  const map: Record<string, string> = {}
  for (const path of paths) map[path] = filePathToSlug(path)
  return map
}
