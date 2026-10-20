#!/usr/bin/env node
// gbrain-sdk-sync — 把本机已下载好的 SDK 目录上传到 gbrain-web 服务端，
// 由服务端交给 GBrain Minions worker 建立 source 并做代码/文档向量化。
//
// V1 只支持“新增/更新文件”：本机清单比上次少文件时服务端会拒绝，
// 不支持从服务端或者 GBrain 索引中删除文件（避免误删）。
//
// 用法（admin 令牌从环境变量 GBRAIN_TOKEN 读取，绝不作为命令行参数）：
//   node scripts/gbrain-sdk-sync.mjs scan --path <local-sdk-dir>
//   node scripts/gbrain-sdk-sync.mjs sync --path <local-sdk-dir> --source <source-id> --url <gbrain-web-origin> [--workers 2] [--wait]
//   node scripts/gbrain-sdk-sync.mjs status --url <gbrain-web-origin> --session <session-id>
//   node scripts/gbrain-sdk-sync.mjs resume --url <gbrain-web-origin> --session <session-id> [--path <local-sdk-dir>] [--workers 2]
//   node scripts/gbrain-sdk-sync.mjs finalize --url <gbrain-web-origin> --session <session-id>
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, readdir, realpath, stat } from 'node:fs/promises'
import { extname, join, relative, resolve, sep } from 'node:path'

// 与服务端 safeSdkRelativePath 的允许集保持一致：不匹配的文件在创建会话时
// 会被服务端拒绝，因此这里直接不扫描它们。
const CODE = new Set([
  '.ts','.tsx','.mts','.cts','.js','.jsx','.mjs','.cjs','.py','.rb','.go','.rs',
  '.java','.cs','.c++','.cpp','.cc','.cxx','.hpp','.hxx','.hh','.c','.h','.xc',
  '.php','.swift','.kt','.kts','.scala','.sc','.lua','.ex','.exs','.elm','.ml','.mli',
  '.dart','.zig','.sol','.sh','.bash','.css','.html','.htm','.astro','.svelte','.vue',
  '.json','.yaml','.yml','.toml','.tf','.tfvars','.hcl','.sql',
])
const DOCS = new Set(['.md','.mdx'])
const SKIP = new Set(['.git','.repo','.west','.svn','.hg','node_modules','vendor','third_party','third-party','build','dist','out','target','coverage','.cache','__pycache__','.venv','venv','debug','release','x64','x86'])

function arg(name) {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
function hasFlag(name) {
  return process.argv.includes(name)
}
function usage() {
  console.log(`Usage:
  node scripts/gbrain-sdk-sync.mjs scan --path <local-sdk-dir>
  node scripts/gbrain-sdk-sync.mjs sync --path <local-sdk-dir> --source <source-id> --url <gbrain-web-origin> [--workers 2] [--wait]
  node scripts/gbrain-sdk-sync.mjs status --url <gbrain-web-origin> --session <session-id>
  node scripts/gbrain-sdk-sync.mjs resume --url <gbrain-web-origin> --session <session-id> [--path <local-sdk-dir>] [--workers 2]
  node scripts/gbrain-sdk-sync.mjs finalize --url <gbrain-web-origin> --session <session-id>

Options:
  --url        gbrain-web 服务地址,例如 https://gbrain.example.com
  --path       本机 SDK 目录
  --source     source id(小写字母数字与连字符)
  --workers    索引 worker 数(默认 2,最大 8)
  --wait       sync/resume 提交后阻塞轮询,任务成功时自动 finalize

令牌通过环境变量提供(不要用命令行参数,避免留痕):
  export GBRAIN_API_KEY=<gbk-...>                        # 推荐：Web Settings 里创建的个人 API 密钥
  export GBRAIN_WEB_ACCESS_TOKEN=<gbrain-web 访问令牌>   # 兼容旧部署
  export GBRAIN_TOKEN=<admin-token>                      # 无 OAuth 的本地模式兜底

V1 只上传新增/修改文件;文件删除/清理刻意不支持(本机清单变少会拒绝)。
SDK 代码始终在本机,按需上传到服务端;令牌只发送给 --url 指定的 HTTPS 源。`)
}
// 流式计算 SHA-256,避免大文件整读进内存。
async function hashFile(filePath) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}
async function collect(root) {
  const files = []
  let skippedDirectories = 0
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || SKIP.has(entry.name.toLowerCase()) || entry.name.toLowerCase().startsWith('generated')) {
          skippedDirectories += 1
          continue
        }
        await walk(fullPath)
        continue
      }
      if (!entry.isFile() || entry.name.startsWith('.')) continue
      const ext = extname(entry.name).toLowerCase()
      if (!CODE.has(ext) && !DOCS.has(ext)) continue
      const rel = relative(root, fullPath).split(sep).join('/')
      const info = await stat(fullPath)
      if (info.size > 2 * 1024 * 1024 * 1024) {
        console.error(`skip >2 GiB: ${rel}`)
        continue
      }
      const sha256 = await hashFile(fullPath)
      files.push({ path: rel, size: info.size, sha256, localPath: fullPath })
      if (files.length > 100_000) throw new Error('超过单次同步最多 100,000 个文件')
    }
  }
  await walk(root)
  files.sort((a, b) => a.path.localeCompare(b.path))
  return { files, skippedDirectories }
}
async function api(base, path, options = {}) {
  const token = requireToken()
  const response = await fetch(new URL(path, base), {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
  })
  const text = await response.text()
  let body
  try { body = text ? JSON.parse(text) : {} } catch { body = { error: text.slice(0, 500) } }
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
  return body
}
function requireToken() {
  // 优先使用个人 API 密钥（GBRAIN_API_KEY，gbk-…）：以该用户身份访问，权限按
  // 阶段 2 规则生效。其次 Web access token（旧/全局）；最后 GBRAIN_TOKEN 兜底。
  const token = process.env.GBRAIN_API_KEY?.trim()
    || process.env.GBRAIN_WEB_ACCESS_TOKEN?.trim()
    || process.env.GBRAIN_TOKEN?.trim()
  if (!token) throw new Error('缺少 GBRAIN_API_KEY(或 GBRAIN_WEB_ACCESS_TOKEN / GBRAIN_TOKEN)环境变量,请先 export')
  return token
}
function serviceOrigin(raw) {
  if (!raw) throw new Error('--url is required')
  const origin = new URL(raw)
  if (origin.protocol !== 'https:' && !['localhost','127.0.0.1'].includes(origin.hostname)) {
    // 内网测试/自托管 http 场景需要显式放行: GBRAIN_SYNC_ALLOW_HTTP=1
    // (只有用户显式设置才向非 HTTPS 源发送令牌; 生产请走 HTTPS)。
    if (process.env.GBRAIN_SYNC_ALLOW_HTTP === '1') return origin.origin
    throw new Error('拒绝向非 HTTPS 地址发送令牌(内网测试可设 GBRAIN_SYNC_ALLOW_HTTP=1)')
  }
  return origin.origin
}
async function scanCommand() {
  const input = arg('--path')
  if (!input) throw new Error('--path is required')
  const root = await realpath(resolve(input))
  const { files, skippedDirectories } = await collect(root)
  console.log(JSON.stringify({
    root,
    files: files.length,
    code: files.filter((f) => CODE.has(extname(f.path).toLowerCase())).length,
    documents: files.filter((f) => DOCS.has(extname(f.path).toLowerCase())).length,
    skippedDirectories,
  }, null, 2))
}
// 逐块上传指定路径;block chunksize 沿用服务端返回的 chunkBytes。
async function uploadFile(origin, session, file) {
  let offset = Number(session.offsets?.[file.path] || 0)
  const handle = await open(file.localPath, 'r')
  try {
    while (offset < file.size) {
      const length = Math.min(Number(session.chunkBytes) || 4 * 1024 * 1024, file.size - offset)
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, offset)
      if (bytesRead !== length) throw new Error(`读取本机文件中断:${file.path}`)
      const result = await api(origin, `/api/code-source/upload/chunk?sessionId=${encodeURIComponent(session.sessionId)}&path=${encodeURIComponent(file.path)}&offset=${offset}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(length) },
        body: buffer.subarray(0, bytesRead),
      })
      offset = Number(result.nextOffset)
      process.stdout.write(`\rUploading ${file.path}: ${offset}/${file.size}`)
    }
  } finally {
    await handle.close()
  }
  if (file.size) process.stdout.write('\n')
}
async function uploadChangedFiles(origin, session, pathArg) {
  if (!pathArg) throw new Error('--path is required(用于重读本机文件)')
  const root = await realpath(resolve(pathArg))
  const { files } = await collect(root)
  const fileMap = new Map(files.map((file) => [file.path, file]))
  for (const path of session.changed || []) {
    const file = fileMap.get(path)
    if (!file) throw new Error(`服务器请求的路径不在本机文件清单中:${path}`)
    await uploadFile(origin, session, file)
  }
}
async function pollAndFinalize(origin, sessionId, timeoutMs = 60 * 60 * 1000) {
  const pollMs = 15_000
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const status = await api(origin, `/api/code-source/upload/session?sessionId=${encodeURIComponent(sessionId)}`)
    console.log(`job ${status.jobId ?? '-'} status=${status.jobStatus}`, status.jobStatus === 'completed' ? '' : `(progress=${JSON.stringify(status.progress ?? {})})`)
    if (status.jobStatus === 'completed') {
      const result = await api(origin, '/api/code-source/upload/finalize', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId }),
      })
      console.log(JSON.stringify(result, null, 2))
      return
    }
    if (status.jobStatus === 'failed' || status.jobStatus === 'dead' || status.jobStatus === 'cancelled') {
      throw new Error(`GBrain 导入失败:${status.jobError || status.jobStatus}`)
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, pollMs))
  }
  throw new Error('等待索引任务超时,请稍后用 status/resume 轮询')
}
async function syncCommand() {
  const input = arg('--path'), source = arg('--source'), base = arg('--url')
  const workers = Math.min(8, Math.max(1, Number.parseInt(arg('--workers') || '2', 10) || 2))
  if (!input || !source) throw new Error('--path and --source are required')
  const origin = serviceOrigin(base)
  requireToken()
  const root = await realpath(resolve(input))
  const { files, skippedDirectories } = await collect(root)
  if (files.length === 0) throw new Error('本机扫描未找到可上传的 SDK 代码/文档;未创建上传会话')
  console.log(`Scanned ${files.length} indexable files locally; skipped ${skippedDirectories} metadata/dependency directories.`)
  const session = await api(origin, '/api/code-source/upload/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceId: source, files: files.map((file) => ({ path: file.path, size: file.size, sha256: file.sha256 })) }),
  })
  console.log(`Upload session ${session.sessionId}: ${session.changed.length} changed, ${session.deleted.length} deleted, ${session.unchanged} unchanged.`)
  await uploadChangedFiles(origin, session, input)
  const committed = await api(origin, '/api/code-source/upload/commit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: session.sessionId, workers }),
  })
  console.log(JSON.stringify({
    sourceId: committed.sourceId, workspace: committed.workspace, changed: committed.changed, deleted: committed.deleted,
    job: committed.job, status: committed.status,
  }, null, 2))
  if (committed.sessionId) {
    if (hasFlag('--wait')) {
      await pollAndFinalize(origin, committed.sessionId)
    } else {
      console.log(`索引任务已入队。后续操作:
  node scripts/gbrain-sdk-sync.mjs status --url ${origin} --session ${committed.sessionId}
  node scripts/gbrain-sdk-sync.mjs resume  --url ${origin} --session ${committed.sessionId} --path ${input}   # 轮询并在完成后 finalize`)
    }
  }
}
async function statusCommand() {
  const origin = serviceOrigin(arg('--url'))
  const sessionId = arg('--session')
  if (!sessionId) throw new Error('--session is required')
  const status = await api(origin, `/api/code-source/upload/session?sessionId=${encodeURIComponent(sessionId)}`)
  console.log(JSON.stringify({
    sessionId: status.sessionId, sourceId: status.sourceId, workspace: status.workspace,
    changed: status.changed?.length ?? 0, offsets: status.offsets, jobId: status.jobId,
    jobStatus: status.jobStatus, jobError: status.jobError, progress: status.progress, expiresAt: status.expiresAt,
  }, null, 2))
}
async function resumeCommand() {
  const origin = serviceOrigin(arg('--url'))
  const sessionId = arg('--session')
  if (!sessionId) throw new Error('--session is required')
  requireToken()
  const status = await api(origin, `/api/code-source/upload/session?sessionId=${encodeURIComponent(sessionId)}`)
  console.log(`session ${sessionId} job=${status.jobId ?? '-'} jobStatus=${status.jobStatus}`)
  if (status.jobId) {
    if (status.jobStatus === 'completed') {
      const result = await api(origin, '/api/code-source/upload/finalize', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId }),
      })
      console.log(JSON.stringify(result, null, 2))
      return
    }
    if (status.jobStatus === 'failed' || status.jobStatus === 'dead' || status.jobStatus === 'cancelled') {
      throw new Error(`GBrain 导入失败:${status.jobError || status.jobStatus}`)
    }
    console.log(JSON.stringify({ jobId: status.jobId, jobStatus: status.jobStatus, progress: status.progress, jobError: status.jobError }, null, 2))
    if (hasFlag('--wait')) await pollAndFinalize(origin, sessionId)
    return
  }
  // 尚未提交索引(上传中途断开):继续传剩余文件再 commit。
  const changed = status.changed || []
  if (changed.length) {
    const input = arg('--path')
    if (!input) throw new Error('--path is required(用于重读本机文件)')
    await uploadChangedFiles(origin, status, input)
    const workers = Math.min(8, Math.max(1, Number.parseInt(arg('--workers') || '2', 10) || 2))
    const committed = await api(origin, '/api/code-source/upload/commit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, workers }),
    })
    console.log(JSON.stringify(committed, null, 2))
    if (committed.sessionId && hasFlag('--wait')) await pollAndFinalize(origin, committed.sessionId)
    return
  }
  console.log(JSON.stringify(status, null, 2))
}
async function finalizeCommand() {
  const origin = serviceOrigin(arg('--url'))
  const sessionId = arg('--session')
  if (!sessionId) throw new Error('--session is required')
  requireToken()
  const status = await api(origin, `/api/code-source/upload/session?sessionId=${encodeURIComponent(sessionId)}`)
  console.log('当前索引任务:', JSON.stringify({ jobId: status.jobId, status: status.jobStatus, progress: status.progress, error: status.jobError }, null, 2))
  const result = await api(origin, '/api/code-source/upload/finalize', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId }),
  })
  console.log(JSON.stringify(result, null, 2))
}
try {
  const command = process.argv[2]
  if (command === 'scan') await scanCommand()
  else if (command === 'sync') await syncCommand()
  else if (command === 'status') await statusCommand()
  else if (command === 'resume') await resumeCommand()
  else if (command === 'finalize') await finalizeCommand()
  else usage()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
