import { NextRequest, NextResponse } from "next/server"
import { listRegisteredSources, resolveCodeRoot, sourceIdFromPath } from "@/lib/code-source"
import { startCodeIndexJob } from "@/lib/code-index-jobs"
import { callGBrainOp } from "@/lib/gbrain-cli"
import { requireUser } from "@/lib/api-guard"
import { canCreateSource, canUploadToSource } from "@/lib/source-permissions"
import { getSdkSourceConfig, saveSdkSourceConfig } from "@/lib/sdk-sources"

export const runtime = "nodejs"

export async function POST(request: NextRequest) {
  try {
    const auth = await requireUser(request)
    if (!auth.ok) return auth.response
    const user = auth.value
    const body = await request.json() as { path?: unknown; url?: unknown; branch?: unknown; sourceId?: unknown; workers?: unknown }
    const isGit = typeof body.url === "string" && body.url.trim().length > 0
    if (!isGit && (typeof body.path !== "string" || !body.path.trim())) {
      return NextResponse.json({ error: "请输入 SDK 目录路径或 Git HTTPS URL" }, { status: 400 })
    }
    if (isGit && !/^https:\/\//i.test(body.url as string)) {
      return NextResponse.json({ error: "Git URL 必须使用 HTTPS" }, { status: 400 })
    }
    const sourceId = typeof body.sourceId === "string" && body.sourceId.trim()
      ? body.sourceId.trim()
      : (isGit ? undefined : sourceIdFromPath(await resolveCodeRoot(body.path as string)))
    if (!sourceId) return NextResponse.json({ error: "Git URL 模式需要 Source ID" }, { status: 400 })

    // 权限：已有配置 → 需上传/索引权限；首次（无配置）→ 需创建权限，并以本人为 owner 建档。
    const existingConfig = await getSdkSourceConfig(sourceId)
    if (existingConfig) {
      if (!await canUploadToSource(user, existingConfig)) {
        return NextResponse.json({ error: `无权索引 source "${sourceId}"` }, { status: 403 })
      }
    } else {
      if (!await canCreateSource(user, { scope: "personal", namespace: "default" })) {
        return NextResponse.json({ error: "无权创建 source" }, { status: 403 })
      }
      // 建档（个人、归属本人），避免首次索引产生无归属 source。
      await saveSdkSourceConfig({
        sourceId,
        kind: isGit ? "git" : "directory",
        ...(isGit ? { url: (body.url as string).trim() } : { path: (body.path as string).trim() }),
        intervalMinutes: 60,
        enabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        scope: "personal",
        namespace: "default",
        ownerUserId: user.id,
      })
    }
    const root = isGit ? null : await resolveCodeRoot(body.path as string)
    if (!/^[a-z0-9-]{1,32}$/.test(sourceId)) {
      return NextResponse.json({ error: "source ID 只能包含小写字母、数字和短横线，最多 32 个字符" }, { status: 400 })
    }
    const workers = typeof body.workers === "number" && Number.isInteger(body.workers)
      ? Math.min(Math.max(body.workers, 1), 8)
      : 2
    const sourceResult = await listRegisteredSources()
    if (isGit) {
      let result: { local_path?: string }
      try {
        // 本机 CLI（gbrain call，remote:false）。走远端通道时 sources_add 另有
        // 两重限制：managed persistence 开启后直接 managedLifecycleRefusal 拒绝
        // （core/ops/sources.ts:139），且 `path` 参数被安全策略拒绝（:161）。当前
        // 部署两者都未触发，但 url 模式没有理由留在这条脆弱的通道上。
        result = await callGBrainOp("sources_add", {
          id: sourceId,
          name: sourceId,
          url: (body.url as string).trim(),
          federated: false,
        }) as { local_path?: string }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Git source 注册失败"
        if (!/already registered|already exists|source_id_taken/i.test(message)) throw error
        const existing = sourceResult.find((source) => source.id === sourceId)
        if (!existing?.local_path) throw error
        result = { local_path: existing.local_path }
      }
      if (!result.local_path) return NextResponse.json({ error: "Git source 已注册，但服务器没有返回 clone 路径" }, { status: 502 })
      const job = await startCodeIndexJob({ root: result.local_path, sourceId, workers, syncPull: true })
      if (job.duplicate) {
        return NextResponse.json({ error: `"${sourceId}" 已有同步/索引任务正在运行，请等待其完成或稍后再试`, job: job.job }, { status: 409 })
      }
      return NextResponse.json({ job: job.job }, { status: 202 })
    }
    const normalizedRoot = root!.replace(/\\/g, "/").replace(/\/+$/, "")
    const overlap = sourceResult.find((source) => {
      if (!source.local_path || source.id === sourceId) return false
      const existing = source.local_path.replace(/\\/g, "/").replace(/\/+$/, "")
      return normalizedRoot === existing || normalizedRoot.startsWith(`${existing}/`) || existing.startsWith(`${normalizedRoot}/`)
    })
    if (overlap) {
      return NextResponse.json({
        error: `目录与已有 source "${overlap.id}" 重叠（${overlap.local_path}，${overlap.page_count} 个页面）。请选择已有 source，或使用不重叠的目录。`,
      }, { status: 409 })
    }
    const result = await startCodeIndexJob({ root: root!, sourceId, workers })
    if (result.duplicate) {
      return NextResponse.json({ error: `"${sourceId}" 已有同步/索引任务正在运行，请等待其完成或稍后再试`, job: result.job }, { status: 409 })
    }
    return NextResponse.json({ job: result.job }, { status: 202 })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "启动代码索引失败" },
      { status: 400 },
    )
  }
}
