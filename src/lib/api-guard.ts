import { NextResponse } from "next/server"
import { requireGBrainBrowserRequestToken } from "./gbrain-server.ts"
import { resolveRequestIdentity } from "./request-user.ts"
import { getSdkSourceConfig, type SdkSourceConfig } from "./sdk-sources.ts"
import { canManageSource, canUploadToSource } from "./source-permissions.ts"
import type { WebUser } from "./web-users.ts"

/**
 * code-source API 的统一鉴权守卫（阶段 2）。
 * 每个路由先 requireUser(request)，再按需 requireManageSource / requireUploadSource。
 */

export type GuardOk<T> = { ok: true; value: T }
export type GuardFail = { ok: false; response: NextResponse }

const UNAUTH = NextResponse.json({ error: "请先登录（或配置 GBrain token）" }, { status: 401 })

/** 解析身份；未认证返回 401。 */
export async function requireUser(request: Request): Promise<GuardOk<WebUser> | GuardFail> {
  const identity = await resolveRequestIdentity(request, requireGBrainBrowserRequestToken)
  if (!identity.user) return { ok: false, response: UNAUTH }
  return { ok: true, value: identity.user }
}

/**
 * 加载 source 配置 + 校验“管理”权限。
 * sourceId 不存在 → 404（不泄露存在性给无权限者优先，但此处直接 404 亦可）。
 */
export async function requireManageSource(
  user: WebUser,
  sourceId: string,
): Promise<GuardOk<SdkSourceConfig> | GuardFail> {
  const config = await getSdkSourceConfig(sourceId)
  if (!config) return { ok: false, response: NextResponse.json({ error: `找不到 source：${sourceId}` }, { status: 404 }) }
  if (!await canManageSource(user, config)) {
    return { ok: false, response: NextResponse.json({ error: `无权管理 source "${sourceId}"` }, { status: 403 }) }
  }
  return { ok: true, value: config }
}

/** 加载 source 配置 + 校验“上传/索引”权限。 */
export async function requireUploadSource(
  user: WebUser,
  sourceId: string,
): Promise<GuardOk<SdkSourceConfig> | GuardFail> {
  const config = await getSdkSourceConfig(sourceId)
  if (!config) return { ok: false, response: NextResponse.json({ error: `找不到 source：${sourceId}` }, { status: 404 }) }
  if (!await canUploadToSource(user, config)) {
    return { ok: false, response: NextResponse.json({ error: `无权向 source "${sourceId}" 上传/索引` }, { status: 403 }) }
  }
  return { ok: true, value: config }
}
