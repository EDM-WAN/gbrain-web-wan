import { NextRequest, NextResponse } from "next/server"
import { requireUser } from "@/lib/api-guard"
import { getSdkSourceConfig } from "@/lib/sdk-sources"
import { canModifyContent, canManageSource } from "@/lib/source-permissions"
import { contentOwnerOf } from "@/lib/content-owners"
import { callGBrainServer } from "@/lib/gbrain-server"

export const runtime = "nodejs"
export const maxDuration = 120

/**
 * POST /api/memory/purge
 * body: { sourceId, slugs: string[] }
 * 物理删除选中页面（页面 + 数据库），带**内容级权限门**（阶段 3）：
 *   - 个人 source：仅 owner 本人可删
 *   - 团队 source：能管整个源，或删的是自己上传的（contentOwnerOf == 自己）
 *   - 系统 source：仅 admin
 * 逐条校验，只删有权限的；返回 { purged, skipped }。
 */
export async function POST(request: NextRequest) {
  const auth = await requireUser(request)
  if (!auth.ok) return auth.response
  const user = auth.value

  try {
    const body = await request.json() as { sourceId?: unknown; slugs?: unknown }
    const sourceId = typeof body.sourceId === "string" ? body.sourceId.trim() : ""
    const slugs = Array.isArray(body.slugs) ? body.slugs.filter((s): s is string => typeof s === "string" && s.length > 0) : []
    if (!sourceId || slugs.length === 0) return NextResponse.json({ error: "需要 sourceId 和非空 slugs" }, { status: 400 })

    const config = await getSdkSourceConfig(sourceId)
    if (!config) return NextResponse.json({ error: `找不到 source：${sourceId}` }, { status: 404 })

    // 能否管整个源（是的话所有页面都能删）
    const manageAll = await canManageSource(user, config)
    const allowed: string[] = []
    const skipped: string[] = []
    for (const slug of slugs) {
      if (manageAll) { allowed.push(slug); continue }
      const ownerId = await contentOwnerOf(sourceId, slug)
      if (await canModifyContent(user, config, ownerId)) allowed.push(slug)
      else skipped.push(slug)
    }
    if (allowed.length === 0) {
      return NextResponse.json({ error: "无权删除所选内容（团队 source 中只能删除自己上传的部分）", skipped }, { status: 403 })
    }

    // gbrain purge_pages 单次上限 200：分批。
    let purged = 0
    const BATCH = 200
    for (let i = 0; i < allowed.length; i += BATCH) {
      const batch = allowed.slice(i, i + BATCH)
      await callGBrainServer("purge_pages", { slugs: batch, source_id: sourceId, confirm_destructive: true })
      purged += batch.length
    }
    return NextResponse.json({ ok: true, purged, skipped })
  } catch (error) {
    const message = error instanceof Error ? error.message : "删除失败"
    const status = /permission|scope|forbidden|unauthorized/i.test(message) ? 403 : 400
    return NextResponse.json({ error: message }, { status })
  }
}
