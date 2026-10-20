// 纯函数部分（无 Next.js / 路径别名依赖），可被 Node 直接 import：
// 上传路径校验 + 文件清单校验。被 sdk-upload.ts 与 test/sdk-upload-files.test.ts 共用。
import { extname, isAbsolute } from "node:path"

export const SDK_UPLOAD_IGNORED_DIRS = new Set([".git", ".repo", ".west", ".svn", ".hg", "node_modules", "vendor", "build", "dist", "out", "target", "coverage", ".cache", "__pycache__", ".venv", "venv", "third_party", "third-party"])
export const SDK_UPLOAD_CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rb", ".go", ".rs",
  ".java", ".cs", ".c++", ".cpp", ".cc", ".cxx", ".hpp", ".hxx", ".hh", ".c", ".h", ".xc",
  ".php", ".swift", ".kt", ".kts", ".scala", ".sc", ".lua", ".ex", ".exs", ".elm", ".ml", ".mli",
  ".dart", ".zig", ".sol", ".sh", ".bash", ".css", ".html", ".htm", ".astro", ".svelte", ".vue",
  ".json", ".yaml", ".yml", ".toml", ".tf", ".tfvars", ".hcl", ".sql",
])
export const SDK_UPLOAD_DOC_EXTENSIONS = new Set([".md", ".mdx"])

export const SDK_UPLOAD_MAX_FILES = 100_000
export const SDK_UPLOAD_MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024
export const SDK_UPLOAD_MAX_MANIFEST_BYTES = 10 * 1024 * 1024 * 1024

export type UploadFile = { path: string; size: number; sha256: string }

export function safeSdkRelativePath(raw: string): string {
  if (typeof raw !== "string" || !raw || raw.includes("\\") || raw.includes("\0") || isAbsolute(raw)) {
    throw new Error("上传文件路径必须是相对 POSIX 路径")
  }
  const parts = raw.split("/")
  if (parts.some((part) => !part || part === "." || part === ".." || part.startsWith("."))) {
    throw new Error(`上传路径包含隐藏或越界目录：${raw}`)
  }
  if (parts.slice(0, -1).some((part) => SDK_UPLOAD_IGNORED_DIRS.has(part.toLowerCase()))) {
    throw new Error(`上传路径位于被排除的元数据/依赖目录：${raw}`)
  }
  const ext = extname(parts.at(-1)!).toLowerCase()
  if (!SDK_UPLOAD_CODE_EXTENSIONS.has(ext) && !SDK_UPLOAD_DOC_EXTENSIONS.has(ext)) {
    throw new Error(`GBrain SDK 索引不接受该文件类型：${raw}`)
  }
  return parts.join("/")
}

export function validateUploadFiles(value: unknown): UploadFile[] {
  if (!Array.isArray(value) || value.length > SDK_UPLOAD_MAX_FILES) {
    throw new Error(`files 必须是最多 ${SDK_UPLOAD_MAX_FILES} 项的数组`)
  }
  const seen = new Set<string>()
  let total = 0
  const files = value.map((item): UploadFile => {
    if (!item || typeof item !== "object") throw new Error("files 项格式无效")
    const row = item as Record<string, unknown>
    const path = safeSdkRelativePath(row.path as string)
    if (seen.has(path)) throw new Error(`文件清单中有重复路径：${path}`)
    seen.add(path)
    if (!Number.isSafeInteger(row.size) || Number(row.size) < 0 || Number(row.size) > SDK_UPLOAD_MAX_FILE_BYTES) {
      throw new Error(`文件大小无效或超过 2 GiB：${path}`)
    }
    if (typeof row.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(row.sha256)) throw new Error(`SHA-256 格式无效：${path}`)
    total += Number(row.size)
    if (total > SDK_UPLOAD_MAX_MANIFEST_BYTES) throw new Error("单次同步清单总大小不能超过 10 GiB")
    return { path, size: Number(row.size), sha256: row.sha256.toLowerCase() }
  })
  files.sort((a, b) => a.path.localeCompare(b.path))
  return files
}
