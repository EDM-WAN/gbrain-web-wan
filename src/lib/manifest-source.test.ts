import assert from "node:assert/strict"
import test from "node:test"
import { detectManifestTool, inferManifestSourceId, validateManifestUrl } from "@/lib/manifest-shared"

test("source IDs derive from manifest repository paths regardless of host", () => {
  assert.equal(inferManifestSourceId("ssh://cn3sd10-git.rtkbf.com:29418/iot/sw/sdk/manifest"), "sdk")
  assert.equal(inferManifestSourceId("ssh://rswn.rtkbf.com:29418/iot/nuwa/manifest"), "nuwa")
  assert.equal(inferManifestSourceId("ssh://rswn.rtkbf.com:29418/iot/sw/dsp/manifest"), "dsp")
})

test("detects manifest tool from repository contents, not Gerrit host", () => {
  assert.equal(detectManifestTool(true, false, false), "west")
  assert.equal(detectManifestTool(false, true, false), "repo")
  assert.equal(detectManifestTool(false, false, true), "repo")
  assert.throws(() => detectManifestTool(true, true, true), /有歧义/)
  assert.throws(() => detectManifestTool(false, false, false), /没有可识别/)
})

test("rejects credentials, wrong scheme, unapproved hosts and invalid ports", () => {
  assert.throws(() => validateManifestUrl("ssh://user:secret@rswn.rtkbf.com:29418/iot/nuwa/manifest"), /不允许嵌入凭据/)
  assert.throws(() => validateManifestUrl("file:///tmp/manifest"), /仅支持 ssh/)
  assert.throws(() => validateManifestUrl("ssh://evil.example:29418/iot/nuwa/manifest"), /不在允许列表/)
  assert.throws(() => validateManifestUrl("ssh://rswn.rtkbf.com:9999/iot/nuwa/manifest"), /只允许默认 SSH 端口或 Gerrit 29418/)
})
