export type ManifestTool = "repo" | "west"
export type ManifestToolChoice = ManifestTool | "auto"

export interface ManifestSourceInput {
  sourceId?: string
  manifestTool?: ManifestToolChoice
  manifestUrl: string
  branch?: string
}

export interface ValidatedManifestSourceInput {
  sourceId: string
  manifestTool: ManifestToolChoice
  manifestUrl: string
  branch?: string
}

const DEFAULT_ALLOWED_MANIFEST_HOSTS = ["cn3sd10-git.rtkbf.com", "cn3sd10-git-slave.rtkbf.com", "rswn.rtkbf.com"]

export function detectManifestTool(hasWest: boolean, hasRepo: boolean, hasRepoInclude: boolean): ManifestTool {
  if (hasWest && hasRepo) throw new Error("Manifest 仓库同时包含 west.yml 和 default.xml，格式有歧义；请手动选择 repo 或 west")
  if (hasWest) return "west"
  if (hasRepo || hasRepoInclude) return "repo"
  throw new Error("Manifest 仓库根目录没有可识别的 west.yml 或 Repo default.xml；请手动选择工具或检查仓库")
}

export function inferManifestSourceId(manifestUrl: string): string {
  let url: URL
  try {
    url = new URL(manifestUrl.trim())
  } catch {
    throw new Error("Manifest URL 格式无效")
  }
  const segments = url.pathname.split("/").filter(Boolean)
  let candidate = segments.at(-1)?.replace(/\.git$/i, "") || ""
  if (candidate.toLowerCase() === "manifest" && segments.length > 1) candidate = segments.at(-2) || candidate
  const sourceId = candidate.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/g, "")
  if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(sourceId)) {
    throw new Error("无法从 Manifest URL 推导 Source ID，请手动填写 Source ID")
  }
  return sourceId
}

export function validateManifestUrl(
  raw: string,
  extraAllowedHosts: readonly string[] = [],
): string {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new Error("Manifest URL 格式无效")
  }
  if (url.protocol !== "ssh:" && url.protocol !== "https:") throw new Error("Manifest URL 仅支持 ssh:// 或 https://")
  if (url.username || url.password || url.search || url.hash || !url.pathname || url.pathname === "/") {
    throw new Error("Manifest URL 不允许嵌入凭据、查询参数或片段，且必须包含仓库路径")
  }
  if (url.protocol === "ssh:" && url.port && !["22", "29418"].includes(url.port)) {
    throw new Error("SSH Manifest URL 只允许默认 SSH 端口或 Gerrit 29418 端口")
  }
  const allowedHosts = new Set([...extraAllowedHosts, ...DEFAULT_ALLOWED_MANIFEST_HOSTS].map((host) => host.trim().toLowerCase()).filter(Boolean))
  if (!allowedHosts.has(url.hostname.toLowerCase())) throw new Error(`Manifest 主机不在允许列表中：${url.hostname}`)
  return url.toString().replace(/\/$/, "")
}
