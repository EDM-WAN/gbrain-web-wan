import assert from "node:assert/strict"
import { test } from "node:test"
import { filterForeignRows, isForeignResult } from "../src/lib/source-scope-filter.ts"

/**
 * source 越权收敛的纯逻辑。
 *
 * 背景：gbrain 的读权限按 **OAuth client** 判定，而本部署所有浏览器会话共用
 * 同一个服务端 client —— 于是「省略 source_id」时 gbrain 会按 client 的整个
 * `federated_read` 授权展开，跨用户返回内容。网关（/api/gbrain 等）必须在
 * 出口按行剔除他人 source 的行。
 */

const visible = (...ids: string[]): ReadonlySet<string> => new Set(ids)

test("filterForeignRows 剔除他人 source 的行，保留可见行", () => {
  const rows = [
    { slug: "a", source_id: "mine" },
    { slug: "b", source_id: "theirs" },
    { slug: "c", source_id: "mine" },
  ]
  const out = filterForeignRows(rows, visible("mine"))
  assert.deepEqual(out.map((row) => row.slug), ["a", "c"])
})

test("filterForeignRows 递归处理嵌套结构（envelope 形状）", () => {
  const payload = {
    pages: [{ slug: "a", source_id: "theirs" }, { slug: "b", source_id: "mine" }],
    meta: { total: 2 },
  }
  const out = filterForeignRows(payload, visible("mine"))
  assert.deepEqual(out.pages.map((p) => p.slug), ["b"])
  assert.equal(out.meta.total, 2)
})

test("无 source_id 字段的对象不被误删（folder 带的是复数 source_ids）", () => {
  const folders = [
    { name: "src", source_ids: ["theirs"], path: "src/" },
    { name: "lib", source_id: "theirs", path: "lib/" },
  ]
  const out = filterForeignRows(folders, visible("mine"))
  assert.deepEqual(out.map((f) => f.name), ["src"])
})

test("isForeignResult 识别顶层就是他人 source 的单条结果", () => {
  assert.equal(isForeignResult({ slug: "x", source_id: "theirs" }, visible("mine")), true)
  assert.equal(isForeignResult({ slug: "x", source_id: "mine" }, visible("mine")), false)
  assert.equal(isForeignResult({ folders: [] }, visible("mine")), false)
  assert.equal(isForeignResult([{ slug: "x", source_id: "theirs" }], visible("mine")), false)
})
