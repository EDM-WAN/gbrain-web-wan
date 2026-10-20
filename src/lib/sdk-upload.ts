import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { createReadStream } from "node:fs"
import { copyFile, lstat, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { configuredCodeRoots } from "./code-source"
import { callGBrainServerWithToken } from "./gbrain-server"
import { submitGBrainJob } from "./gbrain-cli"
import { getSdkSourceConfig, resolveOwnership, saveSdkSourceConfig } from "./sdk-sources"
import { updateJob, type SyncJob } from "./sync-runner"
import { readJson, statePath, writeJsonAtomic } from "./web-state"
import { SDK_UPLOAD_IGNORED_DIRS, safeSdkRelativePath, validateUploadFiles, type UploadFile } from "./sdk-upload-shared"
import { getGBrainServerToken } from "./gbrain-server"

const SESSION_DIR = "sdk-upload-sessions"
const MANIFEST_DIR = "sdk-upload-manifests"
const CHUNK_BYTES = 4 * 1024 * 1024
const SESSION_TTL_MS = 60 * 60 * 1000
const SOURCE_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/
export { SDK_UPLOAD_IGNORED_DIRS, safeSdkRelativePath, validateUploadFiles }

type UploadSession = {
  id: string
  sourceId: string
  createdAt: string
  expiresAt: number
  workspace: string
  files: UploadFile[]
  changed: string[]
  deleted: string[]
  offsets: Record<string, number>
  gbrainTokenHash: string
  jobId?: number
}
type PreviousManifest = { version: 1; sourceId: string; files: UploadFile[] }
type GBrainJob = { id?: number; name?: string; status?: string; progress?: Record<string, unknown>; result?: unknown; error_text?: string | null }
type GBrainSource = { id?: string; local_path?: string | null; remote_url?: string | null; archived?: boolean }

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

export async function allowedUploadRoot(): Promise<string> {
  const roots = configuredCodeRoots()
  if (!roots.length) throw new Error("未配置 GBRAIN_CODE_ROOTS")
  const allowed = (await Promise.all(roots.map(async (root) => {
    try { return await realpath(resolve(root)) } catch { return null }
  }))).filter((root): root is string => root !== null)
  if (!allowed.length) throw new Error("GBRAIN_CODE_ROOTS 中没有可用目录")
  // 上传 workspace 放在第一个可用 code root 下的 .gbrain-uploads，或由
  // GBRAIN_UPLOAD_ROOT 显式指定（必须仍在 GBRAIN_CODE_ROOTS 允许范围内，
  // 否则 GBrain worker 的路径围栏与 `gbrain import` 的 canonical-root 检查会拒绝）。
  const uploadRoot = resolve(process.env.GBRAIN_UPLOAD_ROOT?.trim() || join(allowed[0], ".gbrain-uploads"))
  await mkdir(uploadRoot, { recursive: true })
  const canonical = await realpath(uploadRoot)
  if (!allowed.some((item) => isInside(item, canonical))) throw new Error("GBRAIN_UPLOAD_ROOT 必须位于 GBRAIN_CODE_ROOTS 允许范围内")
  return canonical
}

function sessionFile(id: string): string {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("上传会话 ID 无效")
  return `${SESSION_DIR}/${id}.json`
}

async function statePathForSession(id: string): Promise<string> {
  return statePath(`${SESSION_DIR}/${id}`)
}

export async function loadUploadSession(id: string): Promise<UploadSession> {
  const session = await readJson<UploadSession | null>(sessionFile(id), null)
  if (!session) throw new Error("上传会话不存在或已过期")
  if (session.expiresAt < Date.now()) {
    await removeSessionFiles(session)
    throw new Error("上传会话已过期，请重新开始同步")
  }
  return session
}

async function saveSession(session: UploadSession): Promise<void> {
  await writeJsonAtomic(sessionFile(session.id), session)
}

async function removeSessionFiles(session: UploadSession): Promise<void> {
  await rm(await statePathForSession(session.id), { recursive: true, force: true })
  await rm(await statePath(sessionFile(session.id)), { force: true })
  const activePath = await statePath(`${SESSION_DIR}/active-${session.sourceId}.json`)
  const active = await readJson<{ id?: string } | null>(`${SESSION_DIR}/active-${session.sourceId}.json`, null)
  if (active?.id === session.id) await rm(activePath, { force: true })
}

async function sessionManifest(sourceId: string): Promise<PreviousManifest> {
  return readJson<PreviousManifest>(`${MANIFEST_DIR}/${sourceId}.json`, { version: 1, sourceId, files: [] })
}

// 令牌鉴权说明：GBrain legacy bearer http-transport 不做 op.scope 判定
// （whoami 对 legacy token 恒返回 scopes:[]），真正的权限围栏在
// `submit_job`（OAuth lane 要求 admin；legacy lane 由 operator 配置令牌）。
// 因此这里只绑定"创建会话的同一令牌"（token fingerprint），并把
// submit_job 失败透传给 Web 端用于提示配置正确的 admin 令牌。
export function timingSafeTokenEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

export async function gbrainSources(): Promise<GBrainSource[]> {
  const token = await getGBrainServerToken()
  const result = await callGBrainServerWithToken("sources_list", { include_archived: true }, token) as { sources?: unknown }
  return Array.isArray(result?.sources) ? result.sources as GBrainSource[] : []
}

async function assertSourceCanUpload(sourceId: string, workspace: string): Promise<void> {
  const config = await getSdkSourceConfig(sourceId)
  if (config && (config.kind !== "directory" || (config.path && resolve(config.path) !== workspace))) {
    throw new Error(`Source ${sourceId} 已绑定其他类型或路径，拒绝覆盖`)
  }
  const source = (await gbrainSources()).find((item) => item.id === sourceId)
  if (source?.archived) throw new Error(`GBrain source ${sourceId} 已归档，请先恢复`)
  if (source?.remote_url) throw new Error(`Source ${sourceId} 是远端 Git source，拒绝转换为上传目录 source`)
  if (source?.local_path && resolve(source.local_path) !== workspace) {
    throw new Error(`Source ${sourceId} 已绑定路径 ${source.local_path}；请使用新 Source ID 或先迁移该 source`)
  }
}

export async function createUploadSession(sourceIdRaw: unknown, filesRaw: unknown, token: string): Promise<{
  sessionId: string; workspace: string; changed: string[]; deleted: string[]; unchanged: number; chunkBytes: number; expiresAt: string
}> {
  const sourceId = typeof sourceIdRaw === "string" ? sourceIdRaw.trim() : ""
  if (!SOURCE_ID_RE.test(sourceId)) throw new Error("Source ID 格式无效")
  const active = await readJson<{ id?: string; expiresAt?: number } | null>(`${SESSION_DIR}/active-${sourceId}.json`, null)
  if (active?.id && Number(active.expiresAt) < Date.now()) {
    await rm(await statePath(sessionFile(active.id)), { force: true })
    await rm(await statePathForSession(active.id), { recursive: true, force: true })
  } else if (active?.id) {
    throw new Error(`Source ${sourceId} 已有上传会话 ${active.id}；请继续或过期后重试`)
  }
  const files = validateUploadFiles(filesRaw)
  const workspace = join(await allowedUploadRoot(), sourceId)
  const previous = await sessionManifest(sourceId)
  if (previous.files.length === 0 && files.length === 0) throw new Error("SDK 清单没有可索引的代码/文档文件，拒绝创建空 Source")
  await assertSourceCanUpload(sourceId, workspace)
  await mkdir(workspace, { recursive: true })
  for (const file of files) {
    const target = resolve(workspace, ...file.path.split("/"))
    await assertNoSymlinkPath(workspace, target)
    try { if ((await lstat(target)).isSymbolicLink()) throw new Error(`SDK 目标路径是符号链接：${file.path}`) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  }
  const previousByPath = new Map(previous.files.map((file) => [safeSdkRelativePath(file.path), file]))
  const nextByPath = new Map(files.map((file) => [file.path, file]))
  const allMissing = previous.files.map((file) => safeSdkRelativePath(file.path)).filter((path) => !nextByPath.has(path))
  if (allMissing.length > 0) throw new Error(`本机清单比上次少 ${allMissing.length} 个文件；v1 不执行 prune，未创建上传会话。`)
  const changed = files.filter((file) => {
    const old = previousByPath.get(file.path)
    return !old || old.size !== file.size || old.sha256 !== file.sha256
  }).map((file) => file.path)
  const now = Date.now()
  const session: UploadSession = {
    id: randomBytes(32).toString("hex"), sourceId, createdAt: new Date(now).toISOString(), expiresAt: now + SESSION_TTL_MS,
    workspace, files, changed, deleted: [], offsets: {},
    gbrainTokenHash: tokenFingerprint(token),
  }
  const stagingRoot = await statePathForSession(session.id)
  await mkdir(stagingRoot, { recursive: true })
  for (const path of changed) {
    const file = files.find((item) => item.path === path)!
    if (file.size === 0) {
      const staged = resolve(stagingRoot, ...path.split("/"))
      await mkdir(dirname(staged), { recursive: true })
      await writeFile(staged, Buffer.alloc(0))
    }
  }
  await saveSession(session)
  await writeJsonAtomic(`${SESSION_DIR}/active-${sourceId}.json`, { id: session.id, expiresAt: session.expiresAt })
  return {
    sessionId: session.id, workspace, changed, deleted: [], unchanged: files.length - changed.length,
    chunkBytes: CHUNK_BYTES, expiresAt: new Date(session.expiresAt).toISOString(),
  }
}

export async function uploadFileChunk(sessionId: string, pathRaw: string, offset: number, body: Buffer, token: string): Promise<{ nextOffset: number; complete: boolean }> {
  const session = await loadUploadSession(sessionId)
  if (!timingSafeTokenEqual(tokenFingerprint(token), session.gbrainTokenHash)) throw new Error("上传会话属于另一个 GBrain token")
  const path = safeSdkRelativePath(pathRaw)
  if (!session.changed.includes(path)) throw new Error("该文件不属于本次待上传清单")
  const entry = session.files.find((file) => file.path === path)!
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > entry.size || body.length > CHUNK_BYTES || offset + body.length > entry.size) {
    throw new Error("上传块 offset 或长度无效")
  }
  const expectedOffset = session.offsets[path] ?? 0
  if (offset === expectedOffset - body.length && expectedOffset > 0) return { nextOffset: expectedOffset, complete: expectedOffset === entry.size }
  if (offset !== expectedOffset) throw new Error(`上传块位置不连续：期望 ${expectedOffset}，收到 ${offset}`)
  const stagingRoot = await statePathForSession(session.id)
  const target = resolve(stagingRoot, ...path.split("/"))
  if (!isInside(stagingRoot, target)) throw new Error("上传路径越界")
  await mkdir(dirname(target), { recursive: true })
  for (let current = dirname(target); isInside(stagingRoot, current) && current !== stagingRoot; current = dirname(current)) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error("上传 staging 路径不允许符号链接") } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  }
  await writeFile(target, body, { flag: offset === 0 ? "w" : "a" })
  const nextOffset = offset + body.length
  session.offsets[path] = nextOffset
  await saveSession(session)
  return { nextOffset, complete: nextOffset === entry.size }
}

export async function getUploadSessionStatus(sessionId: string, token: string): Promise<Record<string, unknown>> {
  const session = await loadUploadSession(sessionId)
  if (!timingSafeTokenEqual(tokenFingerprint(token), session.gbrainTokenHash)) throw new Error("上传会话属于另一个 GBrain token；请使用创建该会话时的 token")
  let job: GBrainJob | null = null
  if (session.jobId) {
    const serverToken = await getGBrainServerToken()
    job = await callGBrainServerWithToken("get_job", { id: session.jobId }, serverToken) as GBrainJob
    if (job.status === "failed" || job.status === "dead" || job.status === "cancelled") throw new Error(`GBrain SDK 导入任务 ${session.jobId} ${job.status}: ${job.error_text || "无错误详情"}`)
  }
  return {
    sessionId: session.id, sourceId: session.sourceId, workspace: session.workspace, changed: session.changed,
    deleted: session.deleted, offsets: session.offsets, chunkBytes: CHUNK_BYTES, jobId: session.jobId ?? null,
    jobStatus: job?.status ?? (session.changed.length === 0 ? "ready_to_finalize" : "uploading"),
    jobError: job?.error_text ?? null, progress: job?.progress ?? null, result: job?.result ?? null,
    expiresAt: new Date(session.expiresAt).toISOString(),
  }
}

async function assertNoSymlinkPath(root: string, target: string): Promise<void> {
  if (!isInside(root, target)) throw new Error("目标路径越界")
  const rel = relative(root, target)
  let current = root
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part)
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error(`目标路径包含符号链接：${current}`) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  }
}

export async function publishStagedFiles(session: UploadSession, stagingRoot: string): Promise<void> {
  const root = await allowedUploadRoot()
  const workspace = await realpath(session.workspace)
  if (!isInside(root, workspace) || workspace !== session.workspace) throw new Error("Source workspace 不在允许的上传根目录内")
  for (const path of session.changed) {
    const staged = resolve(stagingRoot, ...path.split("/"))
    const destination = resolve(workspace, ...path.split("/"))
    const file = session.files.find((item) => item.path === path)!
    await assertNoSymlinkPath(workspace, destination)
    const stagedInfo = await lstat(staged).catch(() => null)
    if (stagedInfo?.isFile()) {
      if (stagedInfo.size !== file.size) throw new Error(`文件尚未完整上传：${path}`)
      const hash = createHash("sha256")
      for await (const chunk of createReadStream(staged)) hash.update(chunk)
      if (hash.digest("hex") !== file.sha256) throw new Error(`文件 SHA-256 校验失败：${path}`)
      await mkdir(dirname(destination), { recursive: true })
      const temporary = `${destination}.${session.id}.uploading`
      await copyFile(staged, temporary)
      await rename(temporary, destination)
      continue
    }
    const destinationInfo = await lstat(destination).catch(() => null)
    if (!destinationInfo?.isFile() || destinationInfo.size !== file.size) throw new Error(`文件尚未完整上传：${path}`)
    const hash = createHash("sha256")
    for await (const chunk of createReadStream(destination)) hash.update(chunk)
    if (hash.digest("hex") !== file.sha256) throw new Error(`已发布文件 SHA-256 校验失败：${path}`)
  }
}

const IMPORT_EXCLUDE_PATTERNS = [
  "**/test_wav/**", "**/testwav_*.c", "**/testwav_*.h", "**/*_generated.c", "**/*_generated.h",
]

/**
 * 提交上传会话：落盘、建档、入队 import。
 *
 * `ownerUserId` 是**上传者**的 userId（由 `upload/commit` 路由从请求身份解析后传入）。
 * 必须显式传入：本函数早先不写归属字段，这些记录随后会被 `backfillSourceOwnership`
 * 补成「**首个 admin**」——于是非 admin 用户用 API key 上传的 source 会归到 admin
 * 名下，上传者本人反而看不见（个人源仅 owner 可见）。之所以长期没暴露，是因为
 * 首个 admin 恰好是最早的上传者。
 */
export async function commitUploadSession(
  sessionId: string,
  token: string,
  workers = 2,
  ownerUserId?: number | null,
): Promise<Record<string, unknown>> {
  const session = await loadUploadSession(sessionId)
  if (!timingSafeTokenEqual(tokenFingerprint(token), session.gbrainTokenHash)) throw new Error("上传会话属于另一个 GBrain token；请重新创建上传会话")
  const stagingRoot = await statePathForSession(session.id)
  // Source 注册/路径绑定不在 Web 侧做：HTTP MCP 的 sources_add(path) 出于安全
  // 拒绝 path（"path is not honored over MCP"），sources_set_path 也要求
  // sources_admin；正确路径是提交 import 任务后由 Minions worker 用本地
  // addSource(force:true) 自动注册（jobs.ts import handler），与 sync-runner.ts
  // 的既有语义一致。这里只核验 source 状态是否允许上传。
  const sources = await gbrainSources()
  const source = sources.find((item) => item.id === session.sourceId)
  if (source?.archived) throw new Error(`GBrain source ${session.sourceId} 已归档，请先恢复`)
  if (source?.remote_url) throw new Error(`Source ${session.sourceId} 是远端 Git source，拒绝转换为上传目录 source`)
  await publishStagedFiles(session, stagingRoot)
  const now = new Date().toISOString()
  const existingConfig = await getSdkSourceConfig(session.sourceId)
  // 归属：已有配置不可变，缺失时归到**上传者**个人名下（见 resolveOwnership 注释）。
  const ownership = resolveOwnership(existingConfig, ownerUserId ?? null)
  await saveSdkSourceConfig({
    ...(existingConfig ?? {}), sourceId: session.sourceId, kind: "directory", path: session.workspace,
    intervalMinutes: existingConfig?.intervalMinutes ?? 60, enabled: false, createdAt: existingConfig?.createdAt ?? now, updatedAt: now,
    ...ownership,
  })
  if (!session.jobId && session.changed.length > 0) {
    // 方案 A：走本机 CLI 而非 HTTP MCP。远端通道会把 import 的参数剥到
    // 只剩 dir/sourceId —— strategy/exclude/workers/fresh 全部丢弃，SDK 源码
    // 会被当成 markdown 静默跳过（代码页与调用边永远建不起来）。本机 CLI
    // 入队 `submission_authority = {kind:"application"}`，参数原样落库。
    const submitted = await submitGBrainJob("import", {
      dir: session.workspace,
      sourceId: session.sourceId,
      noEmbed: true,
      strategy: "auto",
      fresh: true,
      allowNoncanonicalRoot: true,
      exclude: IMPORT_EXCLUDE_PATTERNS,
      workers: Math.min(Math.max(Math.floor(workers), 1), 8),
    }, {
      timeoutMs: 60 * 60 * 1000,
      lockDurationMs: 10 * 60 * 1000,
      idempotencyKey: `sdk-upload:${session.sourceId}:${session.id}`,
    })
    session.jobId = submitted.id
    await saveSession(session)
  }
  const job: SyncJob | null = session.jobId ? {
    id: `minion-${session.jobId}`, sourceId: session.sourceId, root: session.workspace, status: "queued",
    startedAt: now, output: [], mode: "import", queue: "minion", minionId: session.jobId,
    message: `SDK 增量上传已提交：${session.changed.length} 个新增/修改文件`,
  } : null
  if (job) await updateJob(job)
  return { sourceId: session.sourceId, workspace: session.workspace, changed: session.changed.length, deleted: session.deleted.length, job, sessionId: session.id, status: job ? "indexing" : "ready_to_finalize" }
}

export async function finalizeUploadSession(sessionId: string, token: string): Promise<{ sourceId: string; deletedPages: number; finalized: true }> {
  const session = await loadUploadSession(sessionId)
  if (!timingSafeTokenEqual(tokenFingerprint(token), session.gbrainTokenHash)) throw new Error("上传会话属于另一个 GBrain token")
  if (session.jobId) {
    const serverToken = await getGBrainServerToken()
    const job = await callGBrainServerWithToken("get_job", { id: session.jobId }, serverToken) as GBrainJob
    if (job?.status !== "completed") throw new Error(`GBrain 导入任务尚未成功完成（当前状态：${job?.status ?? "unknown"}）`)
  }
  const manifest = await sessionManifest(session.sourceId)
  const manifestFiles = new Map(manifest.files.map((file) => [file.path, file]))
  for (const file of session.files) manifestFiles.set(file.path, file)
  await writeJsonAtomic(`${MANIFEST_DIR}/${session.sourceId}.json`, { version: 1, sourceId: session.sourceId, files: [...manifestFiles.values()].sort((a, b) => a.path.localeCompare(b.path)) } satisfies PreviousManifest)
  await removeSessionFiles(session)
  return { sourceId: session.sourceId, deletedPages: 0, finalized: true }
}
