import { NextRequest, NextResponse } from "next/server"
import { requireUser } from "@/lib/api-guard"
import { backfillSourceOwnership } from "@/lib/sdk-sources"
import { firstAdminUserId } from "@/lib/request-user"
import { listVisibleSources } from "@/lib/visible-sources"

export const runtime = "nodejs"

/**
 * GET /api/sources/grouped
 * 返回当前用户**可见的** source，带归属域（个人 / 团队·xx / 系统 / 未注册），
 * 供各页面的 source 下拉按组展示。
 *
 * 过滤逻辑在 `lib/visible-sources.ts`（唯一裁决点）：gbrain sources_list
 * （有哪些 source + 页数）合并 sdk-sources.json（归属/namespace），再按
 * 个人源仅本人 / 团队源成员 / 系统源所有人的规则过滤。
 */
export async function GET(request: NextRequest) {
  const auth = await requireUser(request)
  if (!auth.ok) return auth.response

  try {
    // 回填历史归属：缺 scope/owner 的条目否则会命中「个人源仅本人」而谁都不可见。
    await backfillSourceOwnership(await firstAdminUserId())
    const sources = await listVisibleSources(auth.value)
    return NextResponse.json({ sources })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "读取 source 列表失败" }, { status: 502 })
  }
}
