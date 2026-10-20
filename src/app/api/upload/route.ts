import { createHash, randomUUID } from "node:crypto"
import { execFile as execFileCallback } from "node:child_process"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, extname, join } from "node:path"
import { inflateRawSync } from "node:zlib"
import { promisify } from "node:util"
import { NextRequest, NextResponse } from "next/server"
import { getGBrainServerToken, hasGBrainServerAuthForRequest } from "@/lib/gbrain-server"

export const runtime = "nodejs"
export const maxDuration = 120

const execFile = promisify(execFileCallback)
const GBRAIN_BASE_URL = process.env.GBRAIN_URL || "http://localhost:8787"
const MAX_FILE_BYTES = 25 * 1024 * 1024
const MAX_TEXT_BYTES = 20 * 1024 * 1024

const TEXT_EXTENSIONS = new Set([
  ".csv", ".html", ".htm", ".json", ".log", ".md", ".markdown",
  ".txt", ".xml", ".yaml", ".yml",
])
const OFFICE_EXTENSIONS = new Set([
  ".doc", ".docx", ".odp", ".ods", ".odt", ".ppt", ".pptx", ".rtf", ".xls", ".xlsx",
])
const PDF_EXTENSIONS = new Set([".pdf"])

const PDF_TEXT_REGEX = /\(([^()]*)\)\s*Tj/g

function parseSseOrJson(text: string): Record<string, unknown> {
  const trimmed = text.trim()
  if (trimmed.startsWith("{")) return JSON.parse(trimmed) as Record<string, unknown>

  let lastData = ""
  for (const block of trimmed.split(/\n\n+/)) {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
    if (data) lastData = data
  }
  if (!lastData) throw new Error("gbrain returned an empty MCP response")
  return JSON.parse(lastData) as Record<string, unknown>
}

async function callGBrainPutPage(slug: string, content: string): Promise<unknown> {
  const token = await getGBrainServerToken()
  const response = await fetch(`${GBRAIN_BASE_URL}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "tools/call",
      params: {
        name: "put_page",
        arguments: { slug, content },
      },
    }),
    signal: AbortSignal.timeout(110_000),
  })

  const responseText = await response.text()
  if (!response.ok) throw new Error(`gbrain MCP HTTP ${response.status}`)

  const rpc = parseSseOrJson(responseText)
  if (rpc.error && typeof rpc.error === "object") {
    throw new Error(String((rpc.error as { message?: unknown }).message || "gbrain MCP error"))
  }

  const result = rpc.result as { content?: Array<{ text?: string }>; isError?: boolean } | undefined
  const text = result?.content?.[0]?.text
  if (!text) throw new Error("gbrain returned no tool result")
  const parsed = JSON.parse(text) as Record<string, unknown>
  if (result?.isError || parsed.error) {
    throw new Error(String(parsed.message || parsed.error || text))
  }
  return parsed
}

function safeSlugPart(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return normalized || "document"
}

function safePrefix(value: string): string {
  const prefix = value.trim().replace(/^\/+|\/+$/g, "")
  if (!prefix) return "uploads"
  if (!/^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/.test(prefix)) {
    throw new Error("slug 前缀只能包含小写字母、数字、下划线、短横线和斜线")
  }
  return prefix
}

function stripMarkdownFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content
  const end = content.indexOf("\n---", 3)
  if (end < 0) return content
  return content.slice(end + "\n---".length).replace(/^\s+/, "")
}

interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  uncompressedSize: number
  dataOffset: number
}

function parseZipEntries(buffer: Buffer): ZipEntry[] {
  // Read the central directory instead of walking local headers. Office Open
  // XML commonly uses data descriptors, so local header sizes may be zero.
  const eocdSignature = 0x06054b50
  let eocd = -1
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === eocdSignature) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) return []

  const entryCount = buffer.readUInt16LE(eocd + 10)
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  const entries: ZipEntry[] = []
  let offset = centralOffset
  for (let index = 0; index < entryCount && offset + 46 <= buffer.length; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const uncompressedSize = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8")
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) break
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      dataOffset: localOffset + 30 + localNameLength + localExtraLength,
    })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function readZipEntry(buffer: Buffer, entry: ZipEntry): string {
  const compressed = buffer.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize)
  const raw = entry.method === 0 ? compressed : entry.method === 8 ? inflateRawSync(compressed) : null
  if (!raw) throw new Error(`不支持 ZIP 压缩方式 ${entry.method}`)
  if (raw.length > MAX_TEXT_BYTES) throw new Error("文档内部文本超过大小限制")
  return raw.toString("utf8")
}

function xmlText(xml: string): string {
  return xml
    .replace(/<w:tab\s*\/?>(?=\S)/g, "\t")
    .replace(/<w:br\s*\/?>(?=\S)/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<\/a:p>/g, "\n")
    .replace(/<\/c>/g, "\t")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function extractOfficeOpenXml(buffer: Buffer, extension: string): string {
  const entries = parseZipEntries(buffer)
  if (entries.length === 0) throw new Error("不是有效的 Office Open XML 文件")
  const names = entries.map((entry) => entry.name)
  const textEntries = extension === ".docx"
    ? entries.filter((entry) => entry.name === "word/document.xml" || entry.name.startsWith("word/header") || entry.name.startsWith("word/footer"))
    : extension === ".pptx"
      ? entries.filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name))
      : extension === ".xlsx"
        ? entries.filter((entry) => entry.name === "xl/sharedStrings.xml" || /^xl\/worksheets\/sheet\d+\.xml$/.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name))
        : extension === ".xlsm"
          ? entries.filter((entry) => entry.name === "xl/sharedStrings.xml" || /^xl\/worksheets\/sheet\d+\.xml$/.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name))
          : []
  if (textEntries.length === 0) throw new Error(`未找到 ${extension} 的可读文本 XML（已有 ${names.slice(0, 5).join(", ")}）`)
  return textEntries.map((entry) => xmlText(readZipEntry(buffer, entry))).filter(Boolean).join("\n\n")
}

function extractSimplePdfText(buffer: Buffer): string {
  const raw = buffer.toString("latin1")
  const chunks: string[] = []
  for (const match of raw.matchAll(PDF_TEXT_REGEX)) {
    const value = match[1]
      .replace(/\\([\\()])/g, "$1")
      .replace(/\\n/g, "\n")
    if (value.trim()) chunks.push(value)
  }
  return chunks.join("\n").trim()
}

async function extractDocument(file: File, extension: string): Promise<string> {
  const bytes = Buffer.from(await file.arrayBuffer())
  if (bytes.length > MAX_FILE_BYTES) {
    throw new Error(`文件超过 ${MAX_FILE_BYTES / 1024 / 1024} MB 限制`)
  }

  if (TEXT_EXTENSIONS.has(extension)) {
    if (bytes.subarray(0, Math.min(bytes.length, 8192)).includes(0)) {
      throw new Error("检测到二进制内容，请上传可提取文本的文档格式")
    }
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes)
  }

  if (!OFFICE_EXTENSIONS.has(extension) && !PDF_EXTENSIONS.has(extension)) {
    throw new Error(`暂不支持 ${extension || "该文件类型"}`)
  }

  if ([".docx", ".pptx", ".xlsx"].includes(extension)) {
    const extracted = extractOfficeOpenXml(bytes, extension)
    if (!extracted) throw new Error("Office 文件中没有可提取的文本")
    return extracted
  }

  const workDir = await mkdtemp(join(tmpdir(), "gbrain-upload-"))
  const inputPath = join(workDir, `input${extension}`)
  try {
    await writeFile(inputPath, bytes)
    let outputPath: string | undefined

    if (PDF_EXTENSIONS.has(extension)) {
      try {
        await execFile("pdftotext", ["-enc", "UTF-8", inputPath, join(workDir, "output.txt")], { timeout: 90_000 })
        outputPath = join(workDir, "output.txt")
      } catch {
        const fallback = extractSimplePdfText(bytes)
        if (fallback) return fallback
      }
    }

    if (!outputPath) {
      const outputFormat = PDF_EXTENSIONS.has(extension) ? "html" : "txt:Text"
      await execFile(
        "libreoffice",
        ["--headless", "--convert-to", outputFormat, "--outdir", workDir, inputPath],
        { timeout: 90_000 },
      )
      const outputName = (await readdir(workDir)).find((name) =>
        PDF_EXTENSIONS.has(extension) ? name.endsWith(".html") : name.endsWith(".txt")
      )
      if (!outputName) throw new Error("文档转换没有生成文本结果")
      outputPath = join(workDir, outputName)
    }

    const rawExtracted = await readFile(outputPath, "utf8")
    const extracted = outputPath.endsWith(".html") ? xmlText(rawExtracted) : rawExtracted
    if (Buffer.byteLength(extracted, "utf8") > MAX_TEXT_BYTES) {
      throw new Error(`提取后的文本超过 ${MAX_TEXT_BYTES / 1024 / 1024} MB 限制`)
    }
    return extracted
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`无法提取 ${file.name} 的文本：${detail}`)
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

function pageContent(title: string, file: File, body: string, type: string): string {
  const cleanBody = file.name.toLowerCase().endsWith(".md") || file.name.toLowerCase().endsWith(".markdown")
    ? stripMarkdownFrontmatter(body)
    : body
  const safeTitle = JSON.stringify(title)
  const safeFilename = JSON.stringify(file.name)
  const safeMime = JSON.stringify(file.type || "application/octet-stream")
  return `---\ntitle: ${safeTitle}\ntype: ${type}\noriginal_filename: ${safeFilename}\ncontent_type: ${safeMime}\ningested_via: gbrain-web-upload\n---\n\n# ${title}\n\n${cleanBody.trim()}\n`
}

export async function POST(request: NextRequest) {
  try {
    if (!await hasGBrainServerAuthForRequest(request)) return NextResponse.json({ error: "请先登录，或配置 GBrain token" }, { status: 401 })
    const formData = await request.formData()
    const entries = formData.getAll("files").filter((value): value is File => value instanceof File)
    if (entries.length === 0) {
      return NextResponse.json({ error: "请选择至少一个文件" }, { status: 400 })
    }

    const type = String(formData.get("type") || "note").trim()
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(type)) {
      return NextResponse.json({ error: "页面类型格式无效" }, { status: 400 })
    }
    const prefix = safePrefix(String(formData.get("slug_prefix") || "uploads"))
    const requestedTitle = String(formData.get("title") || "").trim()
    const results: Array<Record<string, unknown>> = []

    for (const file of entries) {
      const extension = extname(file.name).toLowerCase()
      const body = await extractDocument(file, extension)
      const title = entries.length === 1 && requestedTitle
        ? requestedTitle
        : basename(file.name, extension)
      const hash = createHash("sha256").update(Buffer.from(await file.arrayBuffer())).digest("hex").slice(0, 10)
      const slug = `${prefix}/${safeSlugPart(title)}-${hash}`
      const content = pageContent(title, file, body, type)
      const result = await callGBrainPutPage(slug, content)
      results.push({ slug, title, filename: file.name, status: "created_or_updated", result })
    }

    return NextResponse.json({ results })
  } catch (error) {
    console.error("Document upload failed:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "文件上传失败" },
      { status: 400 },
    )
  }
}
