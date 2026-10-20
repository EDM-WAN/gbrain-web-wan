"use client"

import { ChangeEvent, DragEvent, useEffect, useState } from "react"
import { Header } from "@/components/layout/Header"
import { loadStoredFolders, mergeFolderPaths, folderPathsFromPages, pruneStoredFoldersToPages } from "@/lib/folders"
import { listAllPages } from "@/lib/gbrain"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  CheckCircle2,
  FileArchive,
  FileText,
  Loader2,
  UploadCloud,
  X,
} from "lucide-react"

interface UploadResult {
  slug: string
  title: string
  filename: string
  status: string
}

const ACCEPT = ".md,.markdown,.txt,.json,.csv,.html,.htm,.xml,.yaml,.yml,.log,.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.odt,.ods,.odp,.rtf"

export default function UploadPage() {
  const [files, setFiles] = useState<File[]>([])
  const [type, setType] = useState("note")
  const [slugPrefix, setSlugPrefix] = useState("uploads")
  const [title, setTitle] = useState("")
  const [isDragging, setIsDragging] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<UploadResult[]>([])
  const [folders, setFolders] = useState<string[]>([])
  const [folder, setFolder] = useState("")

  useEffect(() => {
    void listAllPages()
      .then((pages) => setFolders(mergeFolderPaths(pruneStoredFoldersToPages(pages), folderPathsFromPages(pages))))
      .catch(() => setFolders(loadStoredFolders().map((item) => item.path)))
  }, [])

  const addFiles = (incoming: File[]) => {
    setError(null)
    setResults([])
    setFiles((current) => {
      const byKey = new Map(current.map((file) => [`${file.name}:${file.size}:${file.lastModified}`, file]))
      for (const file of incoming) {
        byKey.set(`${file.name}:${file.size}:${file.lastModified}`, file)
      }
      return Array.from(byKey.values())
    })
  }

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    addFiles(Array.from(event.target.files || []))
    event.target.value = ""
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setIsDragging(false)
    addFiles(Array.from(event.dataTransfer.files))
  }

  const removeFile = (file: File) => {
    setFiles((current) => current.filter((item) => item !== file))
  }

  const upload = async () => {
    if (files.length === 0 || isUploading) return
    setIsUploading(true)
    setError(null)
    setResults([])

    try {
      const formData = new FormData()
      for (const file of files) formData.append("files", file)
      formData.set("type", type.trim() || "note")
      formData.set("slug_prefix", folder || slugPrefix.trim() || "uploads")
      if (title.trim() && files.length === 1) formData.set("title", title.trim())

      const response = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      })
      const payload = await response.json() as { results?: UploadResult[]; error?: string }
      if (!response.ok) throw new Error(payload.error || "文件上传失败")
      setResults(payload.results || [])
      setFiles([])
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "文件上传失败")
    } finally {
      setIsUploading(false)
    }
  }

  return (
    <div className="min-h-screen">
      <Header title="文件导入" description="上传文件并转换为 GBrain 可检索的知识页面" />

      <div className="mx-auto max-w-4xl space-y-6 p-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <UploadCloud className="h-5 w-5" />
              上传知识文件
            </CardTitle>
            <CardDescription>
              支持 Markdown、TXT、JSON、CSV、HTML、XML、YAML、PDF、Word、PowerPoint、Excel 和 OpenDocument。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div
              onDragOver={(event) => {
                event.preventDefault()
                setIsDragging(true)
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
              className={`rounded-xl border-2 border-dashed p-10 text-center transition-colors ${
                isDragging ? "border-primary bg-primary/5" : "border-border"
              }`}
            >
              <UploadCloud className="mx-auto mb-3 h-10 w-10 text-muted-foreground" />
              <p className="font-medium">拖放文件到这里</p>
              <p className="mt-1 text-sm text-muted-foreground">或点击下面按钮选择文件，单个文件最大 25 MB</p>
              <label className="mt-4 inline-flex h-9 cursor-pointer items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90">
                <FileText className="h-4 w-4" />
                选择文件
                <input type="file" multiple accept={ACCEPT} onChange={handleFileChange} className="sr-only" />
              </label>
            </div>

            {files.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-sm font-medium">待上传文件（{files.length}）</h3>
                {files.map((file) => (
                  <div key={`${file.name}:${file.size}:${file.lastModified}`} className="flex items-center gap-3 rounded-lg border p-3">
                    <FileArchive className="h-5 w-5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{file.name}</p>
                      <p className="text-xs text-muted-foreground">{(file.size / 1024).toFixed(1)} KB</p>
                    </div>
                    <Button variant="ghost" size="icon" onClick={() => removeFile(file)} aria-label={`移除 ${file.name}`}>
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-4">
              <div className="space-y-2">
                <label htmlFor="upload-folder" className="text-sm font-medium">目标文件夹</label>
                <select
                  id="upload-folder"
                  value={folder}
                  onChange={(event) => setFolder(event.target.value)}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="">使用自定义前缀</option>
                  {folders.map((item) => (
                    <option key={item} value={item}>{item}</option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">上传页面将写入此 slug 前缀。</p>
              </div>
              <div className="space-y-2">
                <label htmlFor="upload-type" className="text-sm font-medium">页面类型</label>
                <Input id="upload-type" value={type} onChange={(event) => setType(event.target.value)} placeholder="note" />
                <p className="text-xs text-muted-foreground">例如 ic、ip、source、note。</p>
              </div>
              <div className="space-y-2">
                <label htmlFor="upload-prefix" className="text-sm font-medium">Slug 前缀</label>
                <Input id="upload-prefix" value={slugPrefix} onChange={(event) => setSlugPrefix(event.target.value)} placeholder="uploads" />
                <p className="text-xs text-muted-foreground">例如 ics、ips、documents。</p>
              </div>
              <div className="space-y-2">
                <label htmlFor="upload-title" className="text-sm font-medium">自定义标题</label>
                <Input id="upload-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="单文件时可填写" disabled={files.length !== 1} />
                <p className="text-xs text-muted-foreground">多文件上传会使用原文件名。</p>
              </div>
            </div>

            {error && <div className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}

            <Button onClick={() => void upload()} disabled={files.length === 0 || isUploading} className="gap-2">
              {isUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
              {isUploading ? "提取并写入中..." : `上传并导入 ${files.length || ""} 个文件`}
            </Button>
          </CardContent>
        </Card>

        {results.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <CheckCircle2 className="h-5 w-5 text-green-600" />
                导入完成
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {results.map((result) => (
                <a key={result.slug} href={`/memory/${encodeURIComponent(result.slug)}`} className="block rounded-lg border p-3 hover:bg-muted">
                  <p className="text-sm font-medium">{result.title}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{result.filename} → {result.slug}</p>
                </a>
              ))}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">导入说明</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>上传后，服务端会提取文档文本，并通过真实的 gbrain MCP put_page 写入知识库。</p>
            <p>原始文件不会自动保存为附件；本页面当前优先实现“文件内容进入可搜索知识库”。</p>
            <p>如果上传 IC/IP 文档，请先在 gbrain 中启用对应 schema 类型，再把页面类型填写为 ic、ip 或其他已声明类型。</p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
