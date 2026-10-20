import { NextRequest, NextResponse } from "next/server"
import { resolveCodeRoot } from "@/lib/code-source"
import { callGBrainServer, requireGBrainBrowserRequestToken } from "@/lib/gbrain-server"
import { callGBrainOp } from "@/lib/gbrain-cli"
import { backfillSourceOwnership, listSdkSourceConfigs, removeSdkSourceConfig, resolveOwnership, saveSdkSourceConfig, type SdkSourceConfig, type SdkSourceScope } from "@/lib/sdk-sources"
import { listCodeIndexJobs } from "@/lib/code-index-jobs"
import { startSourceScheduler } from "@/lib/source-scheduler"
import { cancelMinionJobsForSource, removeSyncJobsForSource, waitMinionJobTerminated } from "@/lib/sync-runner"
import { cancelManifestSyncAndWait } from "@/lib/manifest-sync-runner"
import { annotatePermissions, canCreateSource, canManageSource, filterVisibleSources } from "@/lib/source-permissions"
import { clearSourceOwners } from "@/lib/content-owners"
import { firstAdminUserId, resolveRequestIdentity } from "@/lib/request-user"
import { findNamespace } from "@/lib/namespaces"
import type { WebUser } from "@/lib/web-users"

export const runtime = "nodejs"

const UNAUTH = NextResponse.json({ error: "请先登录（或配置 GBrain token）" }, { status: 401 })

/** 解析请求身份（会话 或 legacy token）；未认证返回 null。 */
async function identify(request: NextRequest): Promise<WebUser | null> {
  const identity = await resolveRequestIdentity(request, requireGBrainBrowserRequestToken)
  return identity.user
}

/** 迁移：把历史无归属的 source 补到首个 admin 名下（幂等）。 */
async function ensureOwnershipBackfilled(): Promise<void> {
  await backfillSourceOwnership(await firstAdminUserId())
}

export async function GET(request: NextRequest) {
  const user = await identify(request)
  if (!user) return UNAUTH
  await ensureOwnershipBackfilled()
  const [allConfigs, rawSources] = await Promise.all([
    listSdkSourceConfigs(),
    callGBrainServer("sources_list", { include_archived: true }) as Promise<{ sources?: Array<{ id?: string }> }>,
  ])
  const visible = await filterVisibleSources(user, allConfigs)
  const visibleIds = new Set(visible.map((config) => config.sourceId))
  const configIds = new Set(allConfigs.map((config) => config.sourceId))
  // 过滤「已注册 source」：只保留①有可见配置的，或②完全没有配置的（无归属，默认可见）。
  // 否则「有配置但无权看」的 source 会被前端误判为「无归属」而泄露。
  const sources = {
    ...rawSources,
    sources: (rawSources.sources ?? []).filter((source) => {
      const id = String(source.id ?? "")
      if (!id) return false
      if (configIds.has(id)) return visibleIds.has(id)   // 有配置 → 必须可见
      return true                                        // 无配置 → 未注册归属，可见
    }),
  }
  const permissions = await annotatePermissions(user, visible)
  return NextResponse.json({ sources, configs: visible, permissions, currentUser: { id: user.id, userName: user.userName, role: user.role } })
}

export async function DELETE(request: NextRequest) {
  try {
    const user = await identify(request)
    if (!user) return UNAUTH
    await ensureOwnershipBackfilled()
    const sourceId = new URL(request.url).searchParams.get("sourceId")?.trim()
    if (!sourceId || !/^[a-z0-9-]{1,32}$/.test(sourceId)) {
      return NextResponse.json({ error: "需要有效的 Source ID" }, { status: 400 })
    }

    const configs = await listSdkSourceConfigs()
    const config = configs.find((item) => item.sourceId === sourceId)
    // 权限：删除整条 source 配置属于“管理 source”。
    if (!config) return NextResponse.json({ error: `找不到 source 配置：${sourceId}` }, { status: 404 })
    if (!await canManageSource(user, config)) {
      return NextResponse.json({ error: `无权删除 source "${sourceId}"` }, { status: 403 })
    }

    let registered = false
    try {
      const listed = await callGBrainServer("sources_list", { include_archived: true }) as { sources?: Array<{ id?: string }> }
      registered = Boolean(listed.sources?.some((source) => source.id === sourceId))
    } catch {
      return NextResponse.json({ error: "无法确认 GBrain source 状态，未删除本地配置" }, { status: 503 })
    }

    if (config?.kind === "manifest" && config.lastJobId) {
      const stopped = await cancelManifestSyncAndWait(config.lastJobId)
      if (!stopped) return NextResponse.json({ error: `Manifest source ${sourceId} 的同步任务尚未停止；未删除 source 或 workspace。` }, { status: 409 })
    } else {
      const activeJobs = (await listCodeIndexJobs()).filter((job) => job.sourceId === sourceId && job.queue === "minion" && job.minionId != null && (job.status === "running" || job.status === "queued"))
      await cancelMinionJobsForSource(sourceId)
      const stopped = await Promise.all(activeJobs.map((job) => waitMinionJobTerminated(job.minionId!)))
      if (stopped.some((value) => !value)) return NextResponse.json({ error: `Source ${sourceId} 的索引任务尚未停止；未删除 source 或配置。` }, { status: 409 })
    }

    if (registered) {
      // 本机 CLI（gbrain call，remote:false）：0.60 的 sources_remove 带写围栏
      // （assertSourceInCallerWriteScope），远端 token 只能删自己绑定的那一个
      // write source，删别的报 "Unknown source: <id>"。权限已由上面的
      // canManageSource 裁决，这里走受信通道执行。详见 lib/gbrain-cli.ts 头注释。
      await callGBrainOp("sources_remove", { id: sourceId, dry_run: true })
      await callGBrainOp("sources_remove", { id: sourceId, confirm_destructive: true, revoke_oauth_clients: true })
    }
    await removeSdkSourceConfig(sourceId)
    await clearSourceOwners(sourceId).catch(() => undefined)
    const historyRemoved = await removeSyncJobsForSource(sourceId)
    return NextResponse.json({ ok: true, sourceId, registeredRemoved: registered, historyRemoved })
  } catch (error) {
    const message = error instanceof Error ? error.message : "删除 source 配置失败"
    const status = /scope|permission|admin|unauthorized|forbidden/i.test(message) ? 403 : /not found/i.test(message) ? 404 : 400
    return NextResponse.json({ error: message }, { status })
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await identify(request)
    if (!user) return UNAUTH
    await ensureOwnershipBackfilled()
    const body = await request.json() as Partial<SdkSourceConfig> & { scope?: SdkSourceScope; namespace?: unknown }
    const sourceId = body.sourceId?.trim()
    if (!sourceId || !/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(sourceId)) {
      return NextResponse.json({ error: "Source ID 格式无效" }, { status: 400 })
    }
    const kind = body.kind === "git" ? "git" : "directory"
    if (kind === "directory") {
      if (!body.path?.trim()) return NextResponse.json({ error: "目录 source 需要 path" }, { status: 400 })
      await resolveCodeRoot(body.path.trim())
    } else if (!body.url?.trim() || !/^https:\/\//i.test(body.url.trim())) {
      return NextResponse.json({ error: "Git source 需要 HTTPS URL" }, { status: 400 })
    }

    const now = new Date().toISOString()
    const existing = (await listSdkSourceConfigs()).find((item) => item.sourceId === sourceId)
    if (existing?.kind === "manifest") {
      return NextResponse.json({ error: `Source ${sourceId} 是 Manifest 类型，不能用普通 source 配置覆盖。` }, { status: 409 })
    }

    // 归属解析：编辑已有 source 时归属不可变；新建时按请求选择 personal/team。
    // 编辑分支复用 resolveOwnership —— 与 API 上传路径（sdk-upload.ts）同一实现，
    // 避免两条路径各写一份而在归属规则上漂移。
    let scope: SdkSourceScope
    let namespace: string
    let ownerUserId: number | null
    if (existing) {
      ({ scope, namespace, ownerUserId } = resolveOwnership(existing, user.id))
      if (!await canManageSource(user, existing)) {
        return NextResponse.json({ error: `无权修改 source "${sourceId}"` }, { status: 403 })
      }
    } else {
      const requested = body.scope === "team" ? "team" : "personal"
      scope = requested
      if (requested === "team") {
        const ns = typeof body.namespace === "string" ? body.namespace.trim() : ""
        if (!ns || !(await findNamespace(ns))) {
          return NextResponse.json({ error: "团队 source 需要有效的团队名" }, { status: 400 })
        }
        namespace = ns
      } else {
        namespace = "default"
      }
      if (!await canCreateSource(user, { scope: requested, namespace })) {
        return NextResponse.json({ error: "无权在该范围创建 source" }, { status: 403 })
      }
      ownerUserId = user.id
    }

    const config: SdkSourceConfig = {
      ...(existing ?? {}),
      sourceId,
      kind,
      ...(kind === "directory" ? { path: body.path!.trim() } : { url: body.url!.trim() }),
      ...(body.branch?.trim() ? { branch: body.branch.trim() } : {}),
      intervalMinutes: Math.min(Math.max(Number(body.intervalMinutes) || 60, 5), 1440),
      enabled: body.enabled !== false,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      scope,
      namespace,
      ownerUserId,
    }
    const saved = await saveSdkSourceConfig(config)
    await startSourceScheduler()
    return NextResponse.json({ source: saved }, { status: 200 })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "保存 SDK source 失败" }, { status: 400 })
  }
}
