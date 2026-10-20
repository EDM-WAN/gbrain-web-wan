"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Eye, Edit3, Save, X } from "lucide-react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { buildPageContent, putPage } from "@/lib/gbrain"

export interface MemoryFormValues {
  slug: string
  title: string
  type: string
  tags: string[]
  content: string
  fullContent: string
}

interface MemoryEditorProps {
  mode?: "create" | "edit"
  slug?: string
  initialSlug?: string
  initialTitle?: string
  initialType?: string
  initialTags?: string[]
  initialFrontmatter?: Record<string, unknown>
  initialTimeline?: string
  initialContent: string
  onSave?: (values: MemoryFormValues) => void
  onCancel?: () => void
}

export function MemoryEditor({
  mode = "edit",
  slug: slugProp,
  initialSlug = slugProp || "",
  initialTitle = "",
  initialType = "note",
  initialTags = [],
  initialFrontmatter = {},
  initialTimeline = "",
  initialContent,
  onSave,
  onCancel,
}: MemoryEditorProps) {
  const [slug, setSlug] = useState(initialSlug)
  const [title, setTitle] = useState(initialTitle)
  const [type, setType] = useState(initialType || "note")
  const [tagsText, setTagsText] = useState(initialTags.join(", "))
  const [content, setContent] = useState(initialContent)
  const [isEditing, setIsEditing] = useState(mode === "create")
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const tags = tagsText
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean)

  const handleSave = async () => {
    const normalizedSlug = slug.trim().replace(/^\/+|\/+$/g, "")
    const normalizedTitle = title.trim()

    if (!normalizedSlug) {
      setError("请填写 slug，例如 people/zhangsan")
      return
    }
    if (!normalizedTitle) {
      setError("请填写标题")
      return
    }
    if (!content.trim()) {
      setError("正文不能为空")
      return
    }

    setIsSaving(true)
    setError(null)
    setSuccess(false)

    try {
      const fullContent = buildPageContent(
        {
          title: normalizedTitle,
          type: type.trim() || "note",
          tags,
          frontmatter: initialFrontmatter,
        },
        content,
        initialTimeline,
      )

      await putPage(normalizedSlug, fullContent)
      setSlug(normalizedSlug)
      setSuccess(true)
      setIsEditing(false)
      onSave?.({
        slug: normalizedSlug,
        title: normalizedTitle,
        type: type.trim() || "note",
        tags,
        content,
        fullContent,
      })
      window.setTimeout(() => setSuccess(false), 3000)
    } catch (err) {
      console.error("Failed to save page:", err)
      setError(err instanceof Error ? err.message : "保存失败")
    } finally {
      setIsSaving(false)
    }
  }

  const cancelEditing = () => {
    setSlug(initialSlug)
    setTitle(initialTitle)
    setType(initialType || "note")
    setTagsText(initialTags.join(", "))
    setContent(initialContent)
    setError(null)
    if (mode === "create") {
      onCancel?.()
    } else {
      setIsEditing(false)
      onCancel?.()
    }
  }

  if (!isEditing) {
    return (
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-base">内容</CardTitle>
          <div className="flex items-center gap-2">
            {success && <span className="text-sm text-green-600">✅ 已保存</span>}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsEditing(true)}
              className="gap-1.5"
            >
              <Edit3 className="h-3.5 w-3.5" />
              编辑
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-6 prose prose-neutral dark:prose-invert max-w-none">
          {initialContent ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{initialContent}</ReactMarkdown>
          ) : (
            <p className="text-muted-foreground italic">暂无内容，点击编辑添加</p>
          )}
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-base">{mode === "create" ? "新建记忆" : "编辑记忆"}</CardTitle>
        <div className="flex gap-2">
          {success && <span className="text-sm text-green-600 flex items-center">✅ 已保存</span>}
          <Button
            variant="outline"
            size="sm"
            onClick={handleSave}
            disabled={isSaving}
            className="gap-1.5"
          >
            <Save className="h-3.5 w-3.5" />
            {isSaving ? "保存中..." : "保存"}
          </Button>
          <Button variant="ghost" size="sm" onClick={cancelEditing} disabled={isSaving}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-4 space-y-4">
        {error && (
          <div className="p-3 text-sm text-destructive bg-destructive/10 rounded">
            {error}
          </div>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <label htmlFor="memory-slug" className="text-sm font-medium">Slug</label>
            <input
              id="memory-slug"
              value={slug}
              onChange={(event) => setSlug(event.target.value)}
              disabled={mode === "edit"}
              placeholder="例如 people/zhangsan"
              className="w-full h-9 rounded-md border border-input bg-transparent px-3 text-sm disabled:opacity-60"
            />
            <p className="text-xs text-muted-foreground">页面的唯一地址；编辑已有页面时不能修改。</p>
          </div>
          <div className="space-y-2">
            <label htmlFor="memory-title" className="text-sm font-medium">标题</label>
            <input
              id="memory-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="例如 张三"
              className="w-full h-9 rounded-md border border-input bg-transparent px-3 text-sm"
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="memory-type" className="text-sm font-medium">类型</label>
            <input
              id="memory-type"
              value={type}
              onChange={(event) => setType(event.target.value)}
              placeholder="note / person / company / concept"
              className="w-full h-9 rounded-md border border-input bg-transparent px-3 text-sm"
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="memory-tags" className="text-sm font-medium">标签</label>
            <input
              id="memory-tags"
              value={tagsText}
              onChange={(event) => setTagsText(event.target.value)}
              placeholder="多个标签用逗号分隔"
              className="w-full h-9 rounded-md border border-input bg-transparent px-3 text-sm"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div>
            <label htmlFor="memory-content" className="text-sm font-medium text-muted-foreground mb-2 block">
              <Edit3 className="h-3.5 w-3.5 inline mr-1" />
              Markdown 正文
            </label>
            <textarea
              id="memory-content"
              value={content}
              onChange={(event) => setContent(event.target.value)}
              className="w-full h-96 p-3 rounded-lg border border-input bg-transparent text-sm font-mono resize-y focus:outline-none focus:ring-1 focus:ring-ring"
              placeholder="输入 Markdown 内容..."
            />
          </div>
          <div>
            <label className="text-sm font-medium text-muted-foreground mb-2 block">
              <Eye className="h-3.5 w-3.5 inline mr-1" />
              预览
            </label>
            <div className="w-full h-96 p-3 rounded-lg border border-input bg-muted/30 overflow-y-auto prose prose-neutral dark:prose-invert max-w-none text-sm">
              {content ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
              ) : (
                <p className="text-muted-foreground italic">预览区域</p>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
