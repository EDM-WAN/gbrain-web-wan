import { readdir, realpath, stat } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path"

const execFileAsync = promisify(execFile)

export const CODE_LANGUAGES: Record<string, string> = {
  ".c": "c",
  ".h": "c",
  // Xtensa DSP C source; gbrain chunks it with the C parser fallback.
  ".xc": "c",
  ".c++": "cpp",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".def": "cpp",
  ".hh": "cpp",
  ".hpp": "cpp",
  ".inl": "cpp",
  ".ipp": "cpp",
  ".hxx": "cpp",
  ".py": "python",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".ts": "typescript",
  ".tsx": "tsx",
  ".mts": "typescript",
  ".cts": "typescript",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".cs": "c_sharp",
  ".php": "php",
  ".swift": "swift",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".scala": "scala",
  ".sc": "scala",
  ".lua": "lua",
  ".ex": "elixir",
  ".exs": "elixir",
  ".elm": "elm",
  ".ml": "ocaml",
  ".mli": "ocaml",
  ".dart": "dart",
  ".zig": "zig",
  ".sol": "solidity",
  ".sh": "bash",
  ".bash": "bash",
  ".s": "asm",
  ".asm": "asm",
  ".S": "asm",
  ".m": "objective-c",
  ".mm": "objective-cpp",
  ".sql": "sql",
}

export const DOCUMENT_EXTENSIONS = new Set([
  ".md", ".markdown", ".txt", ".rst", ".csv", ".json", ".yaml", ".yml", ".xml",
  ".html", ".htm", ".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx",
])

const SKIPPED_DIRECTORIES = new Set([
  ".git", ".repo", ".west", ".svn", ".hg", "node_modules", "vendor", "third_party", "third-party",
  "build", "dist", "out", "target", "coverage", ".cache", "__pycache__", ".venv",
  "venv", "Debug", "Release", "x64", "x86",
])

export interface CodeSourceFile {
  path: string
  relativePath: string
  extension: string
  language: string | null
  category: "code" | "document"
  sizeBytes: number
}

export interface CodeScanResult {
  root: string
  totalFiles: number
  codeFiles: number
  documentFiles: number
  skippedFiles: number
  skippedDirectories: number
  truncated: boolean
  byExtension: Record<string, number>
  byLanguage: Record<string, number>
  files: CodeSourceFile[]
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

export function configuredCodeRoots(): string[] {
  return (process.env.GBRAIN_CODE_ROOTS || "")
    .split(process.platform === "win32" ? ";" : ":")
    .map((item) => item.trim())
    .filter(Boolean)
}

export async function resolveCodeRoot(input: string): Promise<string> {
  const requested = await realpath(resolve(input))
  const configured = configuredCodeRoots()
  if (configured.length === 0) {
    throw new Error("未配置 GBRAIN_CODE_ROOTS。请先把允许扫描的 SDK 根目录加入环境变量。")
  }

  const allowed = await Promise.all(configured.map(async (root) => {
    try {
      return await realpath(resolve(root))
    } catch {
      return null
    }
  }))
  const matched = allowed.find((root): root is string => Boolean(root && isInside(root, requested)))
  if (!matched) {
    throw new Error("目录不在 GBRAIN_CODE_ROOTS 允许的范围内。")
  }
  return requested
}

export async function scanCodeDirectory(root: string, maxFiles = 100_000): Promise<CodeScanResult> {
  const result: CodeScanResult = {
    root,
    totalFiles: 0,
    codeFiles: 0,
    documentFiles: 0,
    skippedFiles: 0,
    skippedDirectories: 0,
    truncated: false,
    byExtension: {},
    byLanguage: {},
    files: [],
  }

  async function walk(directory: string): Promise<void> {
    if (result.totalFiles >= maxFiles) {
      result.truncated = true
      return
    }

    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      result.skippedDirectories += 1
      return
    }

    for (const entry of entries) {
      if (result.totalFiles >= maxFiles) {
        result.truncated = true
        return
      }
      if (entry.name.startsWith(".")) {
        result.skippedFiles += 1
        continue
      }

      const fullPath = resolve(directory, entry.name)
      if (entry.isSymbolicLink()) {
        result.skippedFiles += 1
        continue
      }
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name) || entry.name.toLowerCase().startsWith("generated")) {
          result.skippedDirectories += 1
          continue
        }
        await walk(fullPath)
        continue
      }
      if (!entry.isFile()) {
        result.skippedFiles += 1
        continue
      }

      result.totalFiles += 1
      const extension = extname(entry.name).toLowerCase()
      const language = CODE_LANGUAGES[extension] || null
      const category = language ? "code" : DOCUMENT_EXTENSIONS.has(extension) ? "document" : null
      if (!category) {
        result.skippedFiles += 1
        continue
      }

      let sizeBytes = 0
      try {
        sizeBytes = (await stat(fullPath)).size
      } catch {
        result.skippedFiles += 1
        continue
      }

      result.byExtension[extension || "(none)"] = (result.byExtension[extension || "(none)"] || 0) + 1
      if (language) result.byLanguage[language] = (result.byLanguage[language] || 0) + 1
      if (category === "code") result.codeFiles += 1
      else result.documentFiles += 1

      if (result.files.length < 500) {
        result.files.push({
          path: fullPath,
          relativePath: relative(root, fullPath).split(sep).join("/"),
          extension,
          language,
          category,
          sizeBytes,
        })
      }
    }
  }

  await walk(root)
  return result
}

export function sourceIdFromPath(root: string): string {
  const value = basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return `sdk-${(value || "source").slice(0, 25)}`
}

export async function isGitRepository(root: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], { timeout: 10_000 })
    return true
  } catch {
    return false
  }
}

export interface RegisteredSourceSummary {
  id: string
  local_path: string | null
  page_count: number
  archived?: boolean
}

/** Read source metadata without requiring a live HTTP serve. */
export async function listRegisteredSources(): Promise<RegisteredSourceSummary[]> {
  const binary = process.env.GBRAIN_CODE_IMPORT_BIN || "gbrain"
  const home = process.env.GBRAIN_HOME
  if (!home) throw new Error("未配置 GBRAIN_HOME，无法读取 source 注册信息")
  const { stdout } = await execFileAsync(binary, ["sources", "list", "--json"], {
    cwd: home,
    env: process.env,
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  })
  const parsed = JSON.parse(stdout) as { sources?: unknown }
  return Array.isArray(parsed.sources) ? parsed.sources.filter((item): item is RegisteredSourceSummary => Boolean(
    item && typeof item === "object" && typeof (item as RegisteredSourceSummary).id === "string",
  )) : []
}
