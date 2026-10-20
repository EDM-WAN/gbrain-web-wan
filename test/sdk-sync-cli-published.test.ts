import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { join } from "node:path"
import test from "node:test"

/**
 * 本机同步脚本的**发布副本**必须与源文件一致。
 *
 * `scripts/gbrain-sdk-sync.mjs` 是权威源；`public/gbrain-sdk-sync.mjs` 是给最终
 * 用户下载的副本（Next.js 把 `public/` 作为静态资源根，用户 `curl -O` 即可拿到，
 * 不必访问代码仓库）。两份文件天然会漂移 —— 改了源忘记重新复制，用户就会下到
 * 旧版本，而且这种错误在本地开发时完全看不出来。
 *
 * 修法：重新执行 `cp scripts/gbrain-sdk-sync.mjs public/gbrain-sdk-sync.mjs`。
 */

const repoRoot = new URL("..", import.meta.url).pathname

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex")
}

test("public/ 的同步脚本副本与 scripts/ 源文件逐字节一致", async () => {
  const source = join(repoRoot, "scripts", "gbrain-sdk-sync.mjs")
  const published = join(repoRoot, "public", "gbrain-sdk-sync.mjs")
  assert.equal(
    await sha256(published),
    await sha256(source),
    "public/gbrain-sdk-sync.mjs 已与 scripts/gbrain-sdk-sync.mjs 不一致；" +
      "请重新执行 cp scripts/gbrain-sdk-sync.mjs public/gbrain-sdk-sync.mjs",
  )
})

test("发布副本是零依赖的 Node 脚本（用户无需安装任何包）", async () => {
  const text = await readFile(join(repoRoot, "public", "gbrain-sdk-sync.mjs"), "utf8")
  const imports = [...text.matchAll(/^\s*import\s+.*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1])
  assert.ok(imports.length > 0, "应当至少有一个 import")
  for (const specifier of imports) {
    assert.ok(
      specifier.startsWith("node:"),
      `发布脚本引入了非内置依赖 '${specifier}'，最终用户将无法直接运行`,
    )
  }
})
