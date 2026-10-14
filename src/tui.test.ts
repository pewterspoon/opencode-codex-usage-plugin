import { describe, expect, it } from "vitest"
import { Usage } from "./usage.js"
import type { Context } from "@opencode/plugin/tui/context"
import plugin, { CodexUsageFormat } from "./tui.js"

const theme = {
  success: "success",
  accent: "accent",
  warning: "warning",
  error: "error",
  textMuted: "muted",
} as never

function v2Context(messages: unknown[], models: unknown[] = [], model = { providerID: "openai", id: "gpt-6.1-sol" }) {
  return {
    data: {
      session: { get: () => ({ model, location: { directory: "/workspace" } }), message: { list: () => messages } },
      location: { model: { list: () => models } },
    },
    ui: { model: { current: () => ({ providerID: model.providerID, modelID: model.id }) } },
  } as unknown as Context
}

describe("OpenCode V2 sidebar compatibility", () => {
  it("exposes the V2 setup entrypoint and registers additive sidebar slots", async () => {
    expect(plugin).toHaveProperty("setup")
    const placements: string[] = []
    const context = {
      ui: { slot: (claim: { prepend?: string; append?: string }) => {
        placements.push(claim.prepend ?? claim.append ?? "")
        return () => undefined
      } },
    } as unknown as Context
    const cleanup = await plugin.setup(context)
    expect(placements).toContain("sidebar.content")
    expect(placements).toContain("prompt.footer.status")
    await cleanup?.()
  })

  it("reads the V2 message/model shape and includes zero-output usage", () => {
    const context = v2Context([
      { id: "msg_one", type: "assistant", model: { providerID: "openai", id: "gpt-6.1-sol" },
        tokens: { input: 120_000, output: 0, reasoning: 1_000, cache: { read: 38_000, write: 0 } } },
      { id: "msg_streaming", type: "assistant", model: { providerID: "openai", id: "gpt-6.1-sol" } },
    ], [{ providerID: "openai", id: "gpt-6.1-sol", limit: { context: 630_000 } }])
    expect(CodexUsageFormat.contextState(context, "ses_test")).toEqual({ tokens: 159_000, context: 630_000, percent: 25 })
  })

  it("does not show stale pre-compaction usage", () => {
    const context = v2Context([
      { id: "msg_old", type: "assistant", model: { providerID: "openai", id: "gpt-6.1-sol" },
        tokens: { input: 120_000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } } },
      { id: "msg_compact", type: "compaction", status: "completed" },
    ], [{ providerID: "openai", id: "gpt-6.1-sol", limit: { context: 630_000 } }])
    expect(CodexUsageFormat.contextState(context, "ses_test")).toEqual({ tokens: 0, context: 630_000, percent: 0 })
  })

  it("uses the V2 selected model ceiling when a new session has no recorded model", () => {
    const context = v2Context([], [{ providerID: "openai", id: "gpt-6.1-sol", limit: { context: 630_000 } }])
    context.data.session.get = (() => ({ location: { directory: "/workspace" } })) as never
    expect(CodexUsageFormat.contextState(context, "ses_test")).toEqual({ tokens: 0, context: 630_000, percent: 0 })
  })

  it("detects OpenAI before the first assistant response and respects provider switches", () => {
    expect(CodexUsageFormat.isOpenAISession(v2Context([]), "ses_test")).toBe(true)
    const context = v2Context([{ type: "assistant", model: { providerID: "openai", id: "old" } }], [],
      { providerID: "freetoken", id: "local" })
    expect(CodexUsageFormat.isOpenAISession(context, "ses_test")).toBe(false)
  })
})

describe("CodexUsageFormat.gauge", () => {
  it("clamps boundaries and renders partial cells", () => {
    expect(CodexUsageFormat.gauge(-1, 7)).toEqual({ fill: "", track: "░░░░░░░" })
    expect(CodexUsageFormat.gauge(0.5, 7)).toEqual({ fill: "███▌", track: "░░░" })
    expect(CodexUsageFormat.gauge(2, 7)).toEqual({ fill: "███████", track: "" })
  })

  it("converts usage percentages before rendering", () => {
    expect(CodexUsageFormat.usageGauge(42, 7)).toEqual({ fill: "███", track: "░░░░" })
    expect(CodexUsageFormat.usageGauge(81, 7)).toEqual({ fill: "█████▋", track: "░" })
    expect(CodexUsageFormat.usageGauge(100, 7)).toEqual({ fill: "███████", track: "" })
  })
})

describe("CodexUsageFormat.levelColor", () => {
  it("uses the Go plugin threshold boundaries", () => {
    expect(CodexUsageFormat.levelColor(49.9, theme)).toBe("success")
    expect(CodexUsageFormat.levelColor(50, theme)).toBe("accent")
    expect(CodexUsageFormat.levelColor(75, theme)).toBe("warning")
    expect(CodexUsageFormat.levelColor(90, theme)).toBe("error")
  })
})

describe("CodexUsageFormat.compactGaugeText", () => {
  it("identifies the window with the highest usage", () => {
    const usage = Usage.CodexUsage.make({
      fiveHour: Usage.UsageWindow.make({ label: "5h", usedPercent: 42, resetsAt: null }),
      weekly: Usage.UsageWindow.make({ label: "weekly", usedPercent: 81, resetsAt: null }),
    })

    expect(CodexUsageFormat.compactGaugeText(usage)).toBe("Codex weekly 81%")
  })
})

describe("CodexUsageFormat.resetAt", () => {
  it("shows the local weekday and time instead of a countdown", () => {
    expect(CodexUsageFormat.resetAt(null, new Date(0))).toBe("?")
    expect(CodexUsageFormat.resetAt(3_600, new Date(0))).toMatch(/^[A-Z][a-z]{2} \d{1,2}:\d{2} [AP]M$/)
  })
})

describe("CodexUsageFormat.context", () => {
  it("shows used and total context in thousands", () => {
    expect(CodexUsageFormat.formatContextTokens(80_756)).toBe("80k")
    expect(CodexUsageFormat.formatContextUsage(80_756, 1_050_000)).toBe("80k / 1,050k")
  })

  it("shows an unknown total when model metadata is unavailable", () => {
    expect(CodexUsageFormat.formatContextUsage(0, null)).toBe("0k / ?")
  })

  it("colors context pressure at the compaction thresholds", () => {
    expect(CodexUsageFormat.contextPressureColor(null, theme)).toBe("muted")
    expect(CodexUsageFormat.contextPressureColor(39, theme)).toBe("muted")
    expect(CodexUsageFormat.contextPressureColor(40, theme)).toBe("warning")
    expect(CodexUsageFormat.contextPressureColor(69, theme)).toBe("warning")
    expect(CodexUsageFormat.contextPressureColor(70, theme)).toBe("error")
  })
})
