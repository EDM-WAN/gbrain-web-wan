import { NextRequest, NextResponse } from "next/server"
import { getSdkSourceConfig, saveSdkSourceConfig } from "@/lib/sdk-sources"
import { callGBrainServer } from "@/lib/gbrain-server"
import { requireUser } from "@/lib/api-guard"
import { canCreateSource, canManageSource } from "@/lib/source-permissions"
import { validateManifestInput } from "@/lib/manifest-source"
import { startManifestSync } from "@/lib/manifest-sync-runner"
import { startSourceScheduler } from "@/lib/source-scheduler"

export const runtime = "nodejs"

export async function POST(request: NextRequest) {
  try {
    const auth = await requireUser(request)
    if (!auth.ok) return auth.response
    const user = auth.value
    const body = await request.json() as {
      sourceId?: unknown
      manifestTool?: unknown
      manifestUrl?: unknown
      branch?: unknown
      workers?: unknown
      intervalMinutes?: unknown
    }
    const input = validateManifestInput({
      sourceId: typeof body.sourceId === "string" ? body.sourceId : undefined,
      manifestTool: body.manifestTool === "repo" || body.manifestTool === "west" || body.manifestTool === "auto" ? body.manifestTool : undefined,
      manifestUrl: typeof body.manifestUrl === "string" ? body.manifestUrl : "",
      branch: typeof body.branch === "string" ? body.branch : undefined,
    })
    const workers = typeof body.workers === "number" && Number.isInteger(body.workers)
      ? Math.min(Math.max(body.workers, 1), 8)
      : 2
    const intervalMinutes = Math.min(Math.max(Number(body.intervalMinutes) || 60, 5), 1440)
    // 权限：只认「自己有权管理」的已有配置；别人拥有的同名配置视为不可见（不泄露、不误挡）。
    const rawExisting = await getSdkSourceConfig(input.sourceId)
    const existing = rawExisting && await canManageSource(user, rawExisting) ? rawExisting : null
    if (rawExisting && !existing) {
      return NextResponse.json({ error: `Source ${input.sourceId} 已被其他用户占用，请换一个 Source ID` }, { status: 409 })
    }
    if (existing && existing.kind !== "manifest") {
      return NextResponse.json({
        error: `Source ${input.sourceId} 已配置为 ${existing.kind} 类型。请先删除该同步配置，再用 Manifest 类型重新导入。`,
      }, { status: 409 })
    }
    // 新建（无自己可管的配置）→ 需创建权限；归属个人、owner 为本人。
    if (!existing) {
      if (!await canCreateSource(user, { scope: "personal", namespace: "default" })) {
        return NextResponse.json({ error: "无权创建 source" }, { status: 403 })
      }
    }
    const registered = await callGBrainServer("sources_list", { include_archived: true }) as {
      sources?: Array<{ id?: string; archived?: boolean }>
    }
    const source = registered.sources?.find((item) => item.id === input.sourceId)
    if (source?.archived) return NextResponse.json({ error: `GBrain source ${input.sourceId} 已归档，请先恢复后重试` }, { status: 409 })
    if (source && !existing) return NextResponse.json({ error: `GBrain 已存在 source ${input.sourceId}，请先保存对应的 Manifest 配置或使用其他 Source ID` }, { status: 409 })
    if (existing && existing.manifestUrl !== input.manifestUrl) {
      return NextResponse.json({ error: `Source ${input.sourceId} 已绑定另一个 Manifest URL；为避免误更新，请使用新的 Source ID` }, { status: 409 })
    }

    const now = new Date().toISOString()
    await saveSdkSourceConfig({
      ...(existing ?? {}),
      sourceId: input.sourceId,
      kind: "manifest",
      manifestTool: input.manifestTool,
      manifestUrl: input.manifestUrl,
      ...(input.branch ? { branch: input.branch } : {}),
      intervalMinutes: existing?.intervalMinutes ?? intervalMinutes,
      enabled: true,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      // 新建时写入归属（个人、owner=本人）；编辑时保留原归属。
      scope: existing?.scope ?? "personal",
      namespace: existing?.namespace ?? "default",
      ownerUserId: existing?.ownerUserId ?? user.id,
    })
    const result = await startManifestSync({ ...input, workers })
    await startSourceScheduler()
    return NextResponse.json({ job: result.job, duplicate: result.duplicate, sourceId: input.sourceId }, { status: result.duplicate ? 409 : 202 })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Manifest SDK 导入失败"
    const status = /权限|permission|forbidden|unauthorized/i.test(message) ? 403 : 400
    return NextResponse.json({ error: message }, { status })
  }
}
