import assert from "node:assert/strict"
import test from "node:test"
import { resolveOwnership } from "../src/lib/sdk-sources.ts"

/**
 * source 归属解析（`resolveOwnership`）。
 *
 * 回归背景：API key 上传路径（`sdk-upload.ts` 的 `commitUploadSession`）保存配置时
 * 曾**不写** `scope`/`ownerUserId`/`namespace`，这些记录随后被
 * `backfillSourceOwnership` 补成「**首个 admin**」——于是非 admin 用户上传的 source
 * 归到了 admin 名下，上传者本人反而看不见（个人源仅 owner 可见）。
 *
 * 两条不变式：
 *  1. 新建（无已有配置）时归**上传者**，而不是任何全局默认；
 *  2. 已有配置的归属**不可变** —— 换个人重传不得夺走归属。
 */

test("新建：无已有配置 → 归上传者、个人源、default 命名空间", () => {
  assert.deepEqual(resolveOwnership(null, 2), {
    scope: "personal",
    namespace: "default",
    ownerUserId: 2,
  })
})

test("新建：无上传者（legacy 全局 token）→ owner 为 null，交给后续回填", () => {
  assert.deepEqual(resolveOwnership(undefined, null), {
    scope: "personal",
    namespace: "default",
    ownerUserId: null,
  })
})

test("已有配置：归属不可变 —— 换个人重传不夺走归属", () => {
  const existing = { scope: "personal" as const, namespace: "default", ownerUserId: 1 }
  assert.equal(resolveOwnership(existing, 2).ownerUserId, 1)
})

test("已有团队源：沿用 team + 团队命名空间", () => {
  const existing = { scope: "team" as const, namespace: "team1", ownerUserId: 5 }
  assert.deepEqual(resolveOwnership(existing, 9), {
    scope: "team",
    namespace: "team1",
    ownerUserId: 5,
  })
})

test("已有系统源：沿用 system，owner 保持 null（公共源不该被私有化）", () => {
  const existing = { scope: "system" as const, namespace: "system", ownerUserId: null }
  assert.deepEqual(resolveOwnership(existing, 2), {
    scope: "system",
    namespace: "system",
    ownerUserId: null,
  })
})

test("历史脏数据：有 scope 但缺 owner → 补上传者", () => {
  const existing = { scope: "personal" as const, namespace: "default", ownerUserId: undefined }
  assert.equal(resolveOwnership(existing, 2).ownerUserId, 2)
})

test("bug 复现：非 admin 上传者的 source 必须归上传者，而非首个 admin", () => {
  const firstAdminId = 1
  const uploaderId = 2
  const { ownerUserId } = resolveOwnership(null, uploaderId)
  assert.equal(ownerUserId, uploaderId)
  assert.notEqual(ownerUserId, firstAdminId)
})
