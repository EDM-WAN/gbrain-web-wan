import { randomUUID } from "node:crypto"
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm } from "node:fs/promises"
import { spawn } from "node:child_process"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { configuredCodeRoots } from "@/lib/code-source"
import { detectManifestTool, inferManifestSourceId, validateManifestUrl, type ManifestTool, type ManifestSourceInput, type ValidatedManifestSourceInput } from "@/lib/manifest-shared"

export type { ManifestTool, ManifestSourceInput, ValidatedManifestSourceInput } from "@/lib/manifest-shared"

export interface ManifestWorkspace {
  root: string
  manifestTool: ManifestTool
  manifestUrl: string
  branch?: string
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function normalizeManifestUrl(raw: string): string {
  return validateManifestUrl(raw, (process.env.GBRAIN_MANIFEST_ALLOWED_HOSTS || "").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean))
}

export function validateManifestInput(input: ManifestSourceInput): ValidatedManifestSourceInput {
  const manifestUrl = normalizeManifestUrl(input.manifestUrl)
  const sourceId = input.sourceId?.trim() || inferManifestSourceId(manifestUrl)
  if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(sourceId)) {
    throw new Error("Source ID 只能包含小写字母、数字和中间短横线，长度为 1–32")
  }
  const manifestTool = input.manifestTool || "auto"
  if (manifestTool !== "auto" && manifestTool !== "repo" && manifestTool !== "west") {
    throw new Error("Manifest 工具必须为 auto、repo 或 west")
  }
  const branch = input.branch?.trim() || undefined
  if (branch && (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(branch) || branch.split("/").some((part) => part === ".."))) {
    throw new Error("Manifest 分支/ref 格式无效")
  }
  return { sourceId, manifestTool, manifestUrl, ...(branch ? { branch } : {}) }
}

export async function getManifestWorkspaceParent(): Promise<string> {
  const configuredRoots = configuredCodeRoots()
  if (configuredRoots.length === 0) throw new Error("未配置 GBRAIN_CODE_ROOTS")
  const allowedRoots = (await Promise.all(configuredRoots.map(async (root) => {
    try { return await realpath(resolve(root)) } catch { return null }
  }))).filter((root): root is string => root !== null)
  if (allowedRoots.length === 0) throw new Error("GBRAIN_CODE_ROOTS 中没有存在且可访问的目录")
  const codeRoot = allowedRoots[0]
  const parent = resolve(process.env.GBRAIN_MANIFEST_ROOT?.trim() || join(codeRoot, ".manifest-sources"))
  await mkdir(parent, { recursive: true })
  const canonicalParent = await realpath(parent)
  if (!allowedRoots.some((allowed) => isInside(allowed, canonicalParent))) {
    throw new Error("GBRAIN_MANIFEST_ROOT 必须位于 GBRAIN_CODE_ROOTS 允许的目录内")
  }
  return canonicalParent
}

export async function getManifestWorkspaceRoot(sourceId: string): Promise<string> {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(sourceId)) throw new Error("Source ID 格式无效")
  return join(await getManifestWorkspaceParent(), sourceId)
}

function gitOriginUrl(text: string): string | null {
  return text.match(/\[remote\s+"origin"\][\s\S]*?\n\s*url\s*=\s*([^\r\n]+)/i)?.[1]?.trim() ?? null
}

async function inspectWorkspaceManifest(workspace: string): Promise<{ tool: ManifestTool; url: string | null } | null> {
  const repoConfig = join(workspace, ".repo", "manifests.git", "config")
  try {
    const info = await lstat(repoConfig)
    if (info.isFile()) return { tool: "repo", url: gitOriginUrl(await readFile(repoConfig, "utf8")) }
  } catch { /* no initialized repo workspace */ }

  const westConfig = join(workspace, ".west", "config")
  try {
    const info = await lstat(westConfig)
    if (!info.isFile()) return null
    const text = await readFile(westConfig, "utf8")
    const manifestPath = text.match(/\[manifest\][\s\S]*?\n\s*path\s*=\s*([^\r\n]+)/i)?.[1]?.trim()
    if (!manifestPath) return { tool: "west", url: null }
    const manifestDir = resolve(workspace, manifestPath)
    if (!isInside(workspace, manifestDir) || manifestDir === workspace) return { tool: "west", url: null }
    const manifestConfig = await readFile(join(manifestDir, ".git", "config"), "utf8")
    return { tool: "west", url: gitOriginUrl(manifestConfig) }
  } catch {
    // A .west/config file still identifies the workspace even if its checkout is incomplete.
    try {
      const info = await lstat(westConfig)
      if (info.isFile()) return { tool: "west", url: null }
    } catch { /* no initialized west workspace */ }
  }
  return null
}

async function isolateFailedWestInit(workspace: string, parent: string, sourceId: string, expectedUrl: string): Promise<string | null> {
  try {
    const workspaceEntries = await readdir(workspace)
    if (workspaceEntries.length !== 1 || workspaceEntries[0] !== ".west") return null
    const westDir = join(workspace, ".west")
    const westEntries = await readdir(westDir)
    if (westEntries.length !== 1 || westEntries[0] !== "manifest-tmp") return null
    const manifestDir = join(westDir, "manifest-tmp")
    const manifestEntries = (await readdir(manifestDir)).sort()
    if (manifestEntries.join("\0") !== [".git", "default.xml", "gerrit.xml"].join("\0")) return null
    const gitDir = await lstat(join(manifestDir, ".git"))
    const defaultXml = await lstat(join(manifestDir, "default.xml"))
    const gerritXml = await lstat(join(manifestDir, "gerrit.xml"))
    if (!gitDir.isDirectory() || !defaultXml.isFile() || !gerritXml.isFile()) return null
    const config = await readFile(join(manifestDir, ".git", "config"), "utf8")
    const origin = gitOriginUrl(config)
    if (!origin || normalizeManifestUrl(origin) !== expectedUrl) return null

    const backup = join(parent, `${sourceId}.failed-${Date.now()}-${randomUUID().slice(0, 8)}`)
    await rename(workspace, backup)
    await mkdir(workspace)
    return backup
  } catch {
    return null
  }
}

function runCommand(command: string, args: string[], cwd: string, onOutput: (line: string) => void, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal?.aborted) return rejectPromise(new Error("Manifest 同步已取消"))
    const child = spawn(command, args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, stdio: ["ignore", "pipe", "pipe"] })
    let pending = ""
    let settled = false
    let timedOut = false
    let killTimeout: ReturnType<typeof setTimeout> | undefined
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (killTimeout) clearTimeout(killTimeout)
      signal?.removeEventListener("abort", onAbort)
      if (error) rejectPromise(error)
      else resolvePromise()
    }
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
      killTimeout = setTimeout(() => child.kill("SIGKILL"), 5000)
      killTimeout.unref()
    }, 45 * 60 * 1000)
    const onAbort = () => {
      child.kill("SIGTERM")
      killTimeout = setTimeout(() => child.kill("SIGKILL"), 5000)
      killTimeout.unref()
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    const collect = (chunk: Buffer) => {
      pending += chunk.toString("utf8")
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() || ""
      for (const line of lines) if (line.trim()) onOutput(line.slice(0, 1200))
      if (pending.length > 4096) { onOutput(pending.slice(0, 1200)); pending = "" }
    }
    child.stdout.on("data", collect)
    child.stderr.on("data", collect)
    child.on("error", (error) => finish(new Error(`无法启动 ${command}：${error.message}`)))
    child.on("close", (code, closeSignal) => {
      clearTimeout(killTimeout)
      if (pending.trim()) onOutput(pending.slice(0, 1200))
      if (signal?.aborted) return finish(new Error("Manifest 同步已取消"))
      if (timedOut) return finish(new Error(`${command} 执行超过 45 分钟，已终止`))
      if (code !== 0) return finish(new Error(`${command} 失败（退出码 ${code ?? closeSignal ?? "unknown"}）`))
      finish()
    })
  })
}

async function hasRepoManifestContent(root: string, manifestPath = join(root, "default.xml"), visited = new Set<string>()): Promise<boolean> {
  if (visited.has(manifestPath)) return false
  visited.add(manifestPath)
  const text = await readFile(manifestPath, "utf8")
  if (/<project\b/i.test(text)) return true
  const includes = [...text.matchAll(/<include\b[^>]*\bname=["']([^"']+)["']/gi)].map((match) => match[1])
  for (const include of includes) {
    const target = resolve(root, include)
    if (!isInside(root, target)) throw new Error("Repo manifest include 路径越界")
    try {
      const info = await lstat(target)
      if (!info.isFile() || !/\.xml$/i.test(target)) continue
      const includedText = await readFile(target, "utf8")
      if (/<project\b/i.test(includedText)) return true
      if (/<include\b/i.test(includedText) && await hasRepoManifestContent(root, target, visited)) return true
    } catch { /* invalid include is surfaced later by repo init */ }
  }
  return false
}

async function detectManifestToolFromRepository(manifestUrl: string, branch: string | undefined, parent: string, onOutput: (line: string) => void, signal?: AbortSignal): Promise<ManifestTool> {
  const probeDir = await mkdtemp(join(parent, ".manifest-detect-"))
  try {
    const branchArgs = branch ? ["--branch", branch] : []
    onOutput("[manifest] 自动检测格式：浅克隆 manifest 仓库并检查 west.yml/default.xml")
    await runCommand("git", ["clone", "--depth", "1", ...branchArgs, manifestUrl, probeDir], parent, onOutput, signal)
    const entries = await readdir(probeDir)
    const hasWest = entries.includes("west.yml")
    const hasRepo = entries.includes("default.xml") && await hasRepoManifestContent(probeDir)
    const hasRepoInclude = entries.includes("default.xml") && /<include\b/i.test(await readFile(join(probeDir, "default.xml"), "utf8"))
    const tool = detectManifestTool(hasWest, hasRepo, hasRepoInclude)
    if (tool === "repo" && !hasRepo) onOutput("[manifest] default.xml 使用 include，已识别为 repo；repo init 将继续验证完整 XML 清单")
    onOutput(`[manifest] 检测到 ${tool} 格式`)
    return tool
  } finally {
    await rm(probeDir, { recursive: true, force: true })
  }
}

export async function syncManifestWorkspace(input: ValidatedManifestSourceInput, options: { workers?: number; onOutput: (line: string) => void; signal?: AbortSignal }): Promise<ManifestWorkspace> {
  const normalized = validateManifestInput(input)
  const workspaceParent = await getManifestWorkspaceParent()
  const workspace = join(workspaceParent, normalized.sourceId)
  let exists = false
  try {
    const info = await lstat(workspace)
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Manifest workspace 必须是普通目录，不能是符号链接")
    exists = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  if (!exists) await mkdir(workspace, { recursive: false })

  let existing = await inspectWorkspaceManifest(workspace)
  if (!existing) {
    const isolated = await isolateFailedWestInit(workspace, workspaceParent, normalized.sourceId, normalized.manifestUrl)
    if (isolated) options.onOutput(`[manifest] 已将匹配 URL 的失败 west init 残留隔离保存到 ${isolated}`)
    existing = isolated ? null : await inspectWorkspaceManifest(workspace)
  }
  let manifestTool: ManifestTool
  if (existing) {
    if (!existing.url) throw new Error(`检测到不完整的 ${existing.tool} workspace，无法确认其 Manifest URL；为保护现有数据，拒绝覆盖`)
    if (normalizeManifestUrl(existing.url) !== normalized.manifestUrl) {
      throw new Error(`此 Source ID 已绑定另一个 Manifest URL：${existing.url}`)
    }
    if (normalized.manifestTool !== "auto" && normalized.manifestTool !== existing.tool) {
      throw new Error(`已有 workspace 是 ${existing.tool} 格式，与选择的 ${normalized.manifestTool} 不一致`)
    }
    manifestTool = existing.tool
    options.onOutput(`[manifest] 复用已有 ${manifestTool} workspace`)
  } else {
    if ((await readdir(workspace)).length > 0) {
      throw new Error("目标 workspace 已有文件但不是可识别的 repo/west 工作区；为避免覆盖，请先检查或移走该目录")
    }
    manifestTool = normalized.manifestTool === "auto"
      ? await detectManifestToolFromRepository(normalized.manifestUrl, normalized.branch, workspaceParent, options.onOutput, options.signal)
      : normalized.manifestTool
  }

  if (!existing) {
    if (manifestTool === "repo") {
      const branchArgs = normalized.branch ? ["-b", normalized.branch] : []
      options.onOutput(`[manifest] repo init -u ${normalized.manifestUrl}`)
      await runCommand(process.env.GBRAIN_REPO_BIN || "repo", ["init", "-u", normalized.manifestUrl, ...branchArgs], workspace, options.onOutput, options.signal)
    } else {
      const manifestRevisionArgs = normalized.branch ? ["--mr", normalized.branch] : []
      options.onOutput(`[manifest] west init -m ${normalized.manifestUrl}`)
      await runCommand(process.env.GBRAIN_WEST_BIN || "west", ["init", "-m", normalized.manifestUrl, ...manifestRevisionArgs], workspace, options.onOutput, options.signal)
    }
  }

  const workers = Math.min(Math.max(options.workers ?? 2, 1), 8)
  if (manifestTool === "repo") {
    options.onOutput(`[manifest] repo sync -j${workers}`)
    await runCommand(process.env.GBRAIN_REPO_BIN || "repo", ["sync", `-j${workers}`], workspace, options.onOutput, options.signal)
  } else {
    // west update 不接受 -j 并发参数（web 的 workers 只影响 repo/并发外层）。
    options.onOutput("[manifest] west update")
    await runCommand(process.env.GBRAIN_WEST_BIN || "west", ["update"], workspace, options.onOutput, options.signal)
  }
  return { root: workspace, manifestTool, manifestUrl: normalized.manifestUrl, ...(normalized.branch ? { branch: normalized.branch } : {}) }
}
