import { NextRequest, NextResponse } from "next/server"
import { callGBrainServer } from "@/lib/gbrain-server"
import { callGBrainOp } from "@/lib/gbrain-cli"
import { getCodeIndexJob } from "@/lib/code-index-jobs"
import { cancelAndWaitMinionJobsForSource, removeSyncJobsForSource, stopLocalJob, waitLocalJobStopped } from "@/lib/sync-runner"
import { getSdkSourceConfig, removeSdkSourceConfig } from "@/lib/sdk-sources"
import { canManageSource } from "@/lib/source-permissions"
import { requireUser } from "@/lib/api-guard"
import { cancelManifestSyncAndWait } from "@/lib/manifest-sync-runner"

export const runtime = "nodejs"

/**
 * 终止一条 SDK 索引任务并彻底清理(方案 C):只清理这一个 source,其他任务继续。
 *
 * 语义 = 恢复"从没导过"的状态:
 *   1) cancel_job 停住目标任务(cancel → worker 触发 AbortSignal → runImport 协作式中断)
 *   2) 轮询 get_job 等 worker 真正停下(避免 sources_remove 与仍跑的 import 竞态、空刷外键错误)
 *   3) sources_list 确认存在后 sources_remove(confirm_destructive) 级联删除该 source
 *      全部 pages/chunks/embeddings 与 source 行(不枚举 purge_pages,更彻底也免竞态)
 *   4) 删除该 source 的调度配置(已配置的 SDK source)
 *   5) 清掉 sync-jobs.json 里该 source 的历史任务卡
 *
 * 隔离性:按 job 的 sourceId 精确操作;别的 source 的任务(含正在跑的)不受影响。
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireUser(request)
    if (!auth.ok) return auth.response
    const { id } = await context.params
    const job = await getCodeIndexJob(id)
    if (!job) return NextResponse.json({ error: "找不到索引任务" }, { status: 404 })

    const sourceId = job.sourceId
    // 权限门：终止任务 + 清理数据 = 销毁 source，需 manage 权限。
    // 无对应配置（如 default）时，只允许 admin（视为系统 source）。
    const config = await getSdkSourceConfig(sourceId)
    if (config) {
      if (!await canManageSource(auth.value, config)) {
        return NextResponse.json({ error: `无权终止 source "${sourceId}" 的任务` }, { status: 403 })
      }
    } else if (auth.value.role !== "admin") {
      return NextResponse.json({ error: `无权终止 source "${sourceId}" 的任务` }, { status: 403 })
    }
    if (!/^[a-z0-9-]{1,64}$/.test(sourceId)) {
      return NextResponse.json({ error: `Source ID 非法:${sourceId}` }, { status: 400 })
    }

    const body = await request.json().catch(() => ({})) as { waitTimeoutMs?: number }
    const waitTimeoutMs = Number.isFinite(body.waitTimeoutMs) ? Math.min(Math.max(body.waitTimeoutMs as number, 1_000), 120_000) : 60_000

    // 1+2. 先停住目标任务并等待真正退出,再清理数据(避免 sources_remove 与
    // 仍跑的 import 竞态、空刷外键错误)。
    // - minion 任务:取消同 source 所有活动队列 job(prevent 兄弟 job 重建数据)。
    // - 本地 spawn 任务:kill active Map 里的 gbrain 子进程(不同 source 不受影响)。
    let stoppedJobs: { found: number; cancelled: number; stopped: boolean }
    if (job.mode === "manifest") {
      const stopped = await cancelManifestSyncAndWait(job.id, waitTimeoutMs)
      stoppedJobs = { found: stopped ? 1 : 0, cancelled: stopped ? 1 : 0, stopped }
    } else if (job.queue === "minion") {
      stoppedJobs = await cancelAndWaitMinionJobsForSource(sourceId, waitTimeoutMs)
    } else {
      await stopLocalJob(job.id)
      const stopped = await waitLocalJobStopped(job.id, waitTimeoutMs)
      stoppedJobs = { found: stopped ? 1 : 0, cancelled: 0, stopped }
    }
    if (!stoppedJobs.stopped) {
      return NextResponse.json({
        error: `source ${sourceId} 的索引任务未能在 ${waitTimeoutMs}ms 内全部停止,未删除 source 数据;请稍后重试。`,
        ...stoppedJobs,
      }, { status: 409 })
    }

    // 3. 删除该 source 全部数据 + source 行(级联 pages/chunks/embeddings)。
    let registeredRemoved = false
    try {
      const listed = await callGBrainServer("sources_list", { include_archived: true }) as { sources?: Array<{ id?: string }> }
      if (listed.sources?.some((source) => source.id === sourceId)) {
        // 本机 CLI（gbrain call，remote:false）：绕开 0.60 的 sources_remove 写围栏。
        // 读（sources_list）仍走 HTTP MCP —— 读通道有联邦放宽，工作正常。
        await callGBrainOp("sources_remove", { id: sourceId, dry_run: true })
        await callGBrainOp("sources_remove", {
          id: sourceId,
          confirm_destructive: true,
          revoke_oauth_clients: true,
        })
        registeredRemoved = true
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // 已取消但 source 已不在(可能被并发删除)不视作失败。
      if (!/not found/i.test(message)) throw error
    }

    // 4. 删调度配置。
    let configRemoved = false
    try {
      await removeSdkSourceConfig(sourceId)
      configRemoved = true
    } catch {
      configRemoved = false
    }

    // 5. 清本地历史任务卡。
    const historyRemoved = await removeSyncJobsForSource(sourceId)

    return NextResponse.json({
      ok: true,
      sourceId,
      cancelled: stoppedJobs.cancelled,
      foundJobs: stoppedJobs.found,
      registeredRemoved,
      configRemoved,
      historyRemoved,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "终止任务失败"
    const status = /scope|permission|admin|unauthorized|forbidden/i.test(message) ? 403 : /not found/i.test(message) ? 404 : 400
    return NextResponse.json({ error: message }, { status })
  }
}
