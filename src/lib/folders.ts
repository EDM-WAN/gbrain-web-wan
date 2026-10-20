export interface BrainFolder {
  path: string
  createdAt: string
}

export const FOLDER_STORAGE_KEY = "gbrain-web-folders"

export function normalizeFolderPath(value: string): string {
  return value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/+/g, "/")
}

export function isValidFolderPath(value: string): boolean {
  return Boolean(
    value &&
    /^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/.test(value),
  )
}

export function loadStoredFolders(): BrainFolder[] {
  if (typeof window === "undefined") return []
  try {
    const parsed = JSON.parse(window.localStorage.getItem(FOLDER_STORAGE_KEY) || "[]") as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (folder): folder is BrainFolder =>
        Boolean(folder && typeof folder === "object" && typeof (folder as BrainFolder).path === "string"),
    )
  } catch {
    return []
  }
}

export function saveStoredFolders(folders: BrainFolder[]): void {
  if (typeof window === "undefined") return
  window.localStorage.setItem(FOLDER_STORAGE_KEY, JSON.stringify(folders))
  window.dispatchEvent(new Event("gbrain-folders-changed"))
}

export function addStoredFolder(path: string): BrainFolder[] {
  const normalized = normalizeFolderPath(path)
  const folders = loadStoredFolders()
  if (!normalized || folders.some((folder) => folder.path === normalized)) return folders
  const next = [...folders, { path: normalized, createdAt: new Date().toISOString() }]
    .sort((a, b) => a.path.localeCompare(b.path))
  saveStoredFolders(next)
  return next
}

export function removeStoredFolderTree(paths: string[]): BrainFolder[] {
  const targets = paths.map(normalizeFolderPath).filter(Boolean)
  if (targets.length === 0) return loadStoredFolders()
  const targetKeys = new Set(targets.map((target) => target.toLocaleLowerCase()))
  const next = loadStoredFolders().filter((folder) => {
    const key = normalizeFolderPath(folder.path).toLocaleLowerCase()
    return !Array.from(targetKeys).some((target) => key === target || key.startsWith(`${target}/`))
  })
  saveStoredFolders(next)
  return next
}

/** Remove local folder metadata that no longer has a page path in the DB. */
export function pruneStoredFoldersToPages(pages: FolderPage[]): BrainFolder[] {
  const valid = new Set(folderPathsFromPages(pages).map((path) => path.toLocaleLowerCase()))
  const current = loadStoredFolders()
  const next = current.filter((folder) => valid.has(normalizeFolderPath(folder.path).toLocaleLowerCase()))
  if (next.length !== current.length || next.some((folder, index) => folder.path !== current[index]?.path)) {
    saveStoredFolders(next)
  }
  return next
}

export interface FolderPage {
  slug: string
  title?: string
  type?: string
}

/**
 * Code pages currently use flattened slugs for compatibility with code-ref
 * resolution (for example, `example_gdma-app_example-c`). Their titles retain
 * the original relative file path, so use that path for the library tree.
 */
export function pagePathForFolders(page: FolderPage): string {
  if (page.type === "code") {
    const titlePath = page.title?.trim().replace(/\s+\([^()]+\)$/, "")
    if (titlePath?.includes("/")) return titlePath
  }
  return page.slug
}

export function pageFolderPath(page: FolderPage): string {
  const segments = pagePathForFolders(page).split("/").filter(Boolean)
  return segments.length > 1 ? segments.slice(0, -1).join("/") : ""
}

export function folderPathsFromPages(pages: FolderPage[]): string[] {
  const paths = new Set<string>()
  for (const page of pages) {
    const segments = pageFolderPath(page).split("/").filter(Boolean)
    for (let i = 1; i <= segments.length; i += 1) {
      paths.add(segments.slice(0, i).join("/"))
    }
  }
  return Array.from(paths).sort()
}

/** Backward-compatible helper for callers that only have slash-separated slugs. */
export function folderPathsFromSlugs(slugs: string[]): string[] {
  return folderPathsFromPages(slugs.map((slug) => ({ slug })))
}

export function mergeFolderPaths(stored: BrainFolder[], discoveredPaths: string[]): string[] {
  return Array.from(new Set([
    ...stored.map((folder) => folder.path),
    ...discoveredPaths.map(normalizeFolderPath).filter(Boolean),
  ])).sort()
}

export function directChildFolders(allPaths: string[], parent: string): string[] {
  const prefix = parent ? `${parent}/` : ""
  return Array.from(new Set(
    allPaths
      .filter((path) => path.startsWith(prefix) && path !== parent)
      .map((path) => {
        const remainder = path.slice(prefix.length)
        const first = remainder.split("/")[0]
        return first ? `${prefix}${first}` : ""
      })
      .filter(Boolean),
  )).sort()
}

export function isPageInFolder(page: FolderPage, folder: string): boolean {
  const pagePath = pagePathForFolders(page)
  if (!folder) return !pagePath.includes("/")
  const prefix = `${folder}/`
  const remainder = pagePath.startsWith(prefix) ? pagePath.slice(prefix.length) : ""
  return Boolean(remainder) && !remainder.includes("/")
}

/** Include pages in a folder and all of its descendant folders. */
export function isPageInFolderTree(page: FolderPage, folder: string): boolean {
  if (!folder) return true
  const pageFolder = pageFolderPath(page)
  return pageFolder === folder || pageFolder.startsWith(`${folder}/`)
}
