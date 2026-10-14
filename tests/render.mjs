import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { testRender, createElement, insertNode, useRenderer } from "@opentui/solid"
import { createSignal } from "solid-js"
import { ensureRuntimePluginSupport } from "@opentui/solid/runtime-plugin-support/configure"
import { ensurePluginRuntime } from "@opencode/plugin/runtime"

// Match the real host's shared-module injection, not merely a direct import.
// In particular, V2 owns the bare "effect" specifier; legacy transports must
// not silently receive a different Effect release from the CLI.
ensureRuntimePluginSupport({ additional: ensurePluginRuntime() })
const { default: plugin } = await import("../dist/tui.js")

process.env.OPENCODE_CODEX_USAGE_COMMAND = fileURLToPath(new URL("./fixtures/codex.mjs", import.meta.url))

const color = "#cccccc"
const model = { providerID: "openai", id: "gpt-6.1-sol", limit: { context: 630_000 } }
const [tokens, setTokens] = createSignal(159_000)
const [provider, setProvider] = createSignal("freetoken")
const claims = []
const events = new Map()
const context = {
  theme: { text: { base: color, muted: color, action: { primary: { base: color } },
    feedback: Object.fromEntries(["success", "warning", "error"].map(key => [key, { base: color }])) } },
  data: {
    session: {
      get: () => ({ model: { providerID: provider(), id: model.id }, location: { directory: "/workspace" } }),
      cost: () => 0,
      message: { list: () => [{ id: "msg_one", type: "assistant", model: { providerID: model.providerID, id: model.id },
        tokens: { input: tokens(), output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }] },
    },
    location: { model: { list: () => [model] } },
    on: (name, handler) => { events.set(name, handler); return () => events.delete(name) },
  },
  ui: {
    slot: claim => { claims.push(claim); return () => { const index = claims.indexOf(claim); if (index !== -1) claims.splice(index, 1) } },
    toast: { show: () => assert.fail("Codex fixture should be available") },
    model: { current: () => ({ providerID: provider(), modelID: model.id }) },
  },
}

let setup
const app = await testRender(() => {
  context.renderer = useRenderer()
  setup = plugin.setup(context)
  const root = createElement("box")
  for (const claim of claims.filter(claim => claim.prepend === "sidebar.content")) {
    insertNode(root, claim.render({ sessionID: "ses_fixture" }))
  }
  return root
}, { width: 42, height: 16 })

try {
  await app.renderOnce()
  assert.equal(app.captureCharFrame().includes("Codex Usage"), false, "hide quotas for non-OpenAI sessions")
  // On cold startup session/model data can arrive after the slot mounts. Quota
  // polling must start reactively, not wait for the next 60-second timer tick.
  setProvider("openai")
  const deadline = Date.now() + 5000
  let frame = ""
  while (Date.now() < deadline) {
    await app.renderOnce()
    frame = app.captureCharFrame()
    if (frame.includes("42%") && frame.includes("81%")) break
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.ok(frame.includes("Context"), frame)
  assert.ok(frame.includes("159k / 630k"), frame)
  assert.ok(frame.includes("25% used"), frame)
  assert.ok(frame.includes("Codex Usage"), frame)
  assert.ok(frame.includes("42%") && frame.includes("81%"), frame)
  setTokens(200_000)
  await new Promise(resolve => setImmediate(resolve))
  await app.renderOnce()
  frame = app.captureCharFrame()
  assert.ok(frame.includes("200k / 630k"), frame)
  assert.ok(frame.includes("32% used"), frame)
  console.log("Terminal rendering passed: Context ceiling, reactive token update, Codex 5h/weekly gauges.")
} finally {
  app.renderer.destroy()
  const cleanup = await setup
  await cleanup?.()
}
assert.equal(claims.length, 0, "plugin cleanup must unregister slots")
assert.equal(events.size, 0, "view cleanup must unsubscribe events")
