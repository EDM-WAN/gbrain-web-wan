import assert from "node:assert/strict"
import test from "node:test"

/**
 * 复制到剪贴板的降级逻辑。
 *
 * 回归背景：API 密钥创建后的「复制」按钮用 `navigator.clipboard.writeText`
 * 直接调用，而本部署是内网 **http**（非安全上下文）—— 该 API 在此为
 * `undefined`，调用即抛异常，表现为「按钮点了没反应」。
 *
 * 这些用例锁住：安全上下文用现代 API；不可用/失败时退回 execCommand；
 * 两者都不行时明确返回 false（让调用方能提示用户手动复制，而不是静默失败）。
 *
 * 用假的 navigator/document 注入，避免依赖真实浏览器环境。
 */

type FakeEnv = {
  secure: boolean
  hasClipboard: boolean
  writeThrows?: boolean
  execResult?: boolean
}

/** Node 的 navigator/document 可能是只读 getter，用 defineProperty 覆盖。 */
function defineGlobal(name: string, value: unknown): () => void {
  const g = globalThis as Record<string, unknown>
  const descriptor = Object.getOwnPropertyDescriptor(g, name)
  Object.defineProperty(g, name, { value, configurable: true, writable: true })
  return () => {
    if (descriptor) Object.defineProperty(g, name, descriptor)
    else delete g[name]
  }
}

async function runWith(env: FakeEnv): Promise<boolean> {
  const restoreNav = defineGlobal(
    "navigator",
    env.hasClipboard
      ? {
          clipboard: {
            writeText: async (_t: string) => {
              if (env.writeThrows) throw new Error("denied")
            },
          },
        }
      : {},
  )
  const restoreDoc = defineGlobal("document", {
    createElement: () => ({
      value: "", style: {}, setAttribute: () => {}, select: () => {},
      setSelectionRange: () => {},
    }),
    body: { appendChild: () => {}, removeChild: () => {} },
    execCommand: () => env.execResult ?? true,
    getSelection: () => null,
  })
  const restoreWin = defineGlobal("window", { isSecureContext: env.secure })

  try {
    const mod = await import(`../src/lib/clipboard.ts?case=${Math.random()}`)
    return await mod.copyToClipboard("secret")
  } finally {
    restoreWin()
    restoreDoc()
    restoreNav()
  }
}

test("安全上下文 + 剪贴板可用 → 用现代 API", async () => {
  const ok = await runWith({ secure: true, hasClipboard: true })
  assert.equal(ok, true)
})

test("非安全上下文（内网 http）→ 走 execCommand 降级", async () => {
  const ok = await runWith({ secure: false, hasClipboard: true })
  assert.equal(ok, true, "http 环境下必须能复制成功（这是原 bug 的场景）")
})

test("剪贴板 API 不存在 → 不抛异常，走降级", async () => {
  const ok = await runWith({ secure: true, hasClipboard: false })
  assert.equal(ok, true)
})

test("现代 API 抛异常（权限拒绝）→ 仍尝试降级", async () => {
  const ok = await runWith({ secure: true, hasClipboard: true, writeThrows: true })
  assert.equal(ok, true)
})

test("两条路都失败 → 返回 false（调用方据此提示用户手动复制）", async () => {
  const ok = await runWith({ secure: false, hasClipboard: false, execResult: false })
  assert.equal(ok, false, "静默失败会让用户以为按钮坏了，必须返回 false")
})
