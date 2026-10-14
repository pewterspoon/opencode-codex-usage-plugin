import type { Plugin } from "@opencode/plugin/tui"
import type { JSX } from "@opentui/solid"
import {
  createComponent,
  createElement,
  createTextNode,
  effect,
  insert,
  insertNode,
  setProp,
} from "@opentui/solid"
import { createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js"
import { Effect, Layer, ManagedRuntime, Predicate } from "effect"
import { CodexService } from "./codex.ts"
import { Logger } from "./logger.js"
import { Usage } from "./usage.js"

type UsageState =
  | { status: "loading"; usage: null; message: string }
  | { status: "ready"; usage: Usage.CodexUsage; message: string }
  | { status: "error"; usage: null; message: string }

type TuiPluginApi = Plugin.Context
type TuiColor = TuiPluginApi["theme"]["text"]["base"]
type TuiTheme = Record<"text" | "textMuted" | "success" | "accent" | "warning" | "error", TuiColor>
type Runtime = ReturnType<typeof createRuntime>
type SessionMessage = ReturnType<TuiPluginApi["data"]["session"]["message"]["list"]>[number]
type AssistantSessionMessage = Extract<SessionMessage, { type: "assistant" }>

const POLL_MS = 60_000
const UI_TIMEOUT_MS = 15_000
const GAUGE_WIDTH = 7
const EXPANDED_GAUGE_WIDTH = 28
const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"]
const OK_AT = 50
const WARN_AT = 75
const DANGER_AT = 90
const CONTEXT_WARN_AT = 40
const CONTEXT_DANGER_AT = 70
const MONEY = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

function ContextView(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => themeColors(props.api)
  const state = createMemo(() => contextState(props.api, props.session_id))

  const root = createElement("box")
  const title = createElement("text")
  const bold = createElement("b")
  insertNode(root, title)
  insertNode(title, bold)
  insertNode(bold, createTextNode("Context"))
  effect(() => setProp(title, "fg", theme().text))
  insertNode(
    root,
    textLine(
      () => formatContextUsage(state().tokens, state().context),
      () => theme().textMuted,
    ),
  )
  insertNode(
    root,
    textLine(
      () => `${state().percent ?? 0}% used`,
      () => contextPressureColor(state().percent, theme()),
    ),
  )
  insertNode(
    root,
    textLine(
      () => `${MONEY.format(props.api.data.session.cost(props.session_id))} spent`,
      () => theme().textMuted,
    ),
  )

  return root
}

function View(props: { api: TuiPluginApi; session_id: string; runtime: Runtime; onMissingCodex: () => void; mounted: (id: string) => () => void }) {
  const theme = () => themeColors(props.api)
  createEffect(() => onCleanup(props.mounted(props.session_id)))
  const { state, isOpenAI } = createUsagePolling(props)

  const root = createElement("box")

  insert(root, () => (isOpenAI() ? UsageBlock({ state, theme }) : null), null)

  return root
}

function CompactView(props: { api: TuiPluginApi; session_id: string; runtime: Runtime; onMissingCodex: () => void; sidebarVisible: (id: string) => boolean }) {
  const theme = () => themeColors(props.api)
  const sidebarHidden = createMemo(() => !props.sidebarVisible(props.session_id))
  const { state, isOpenAI } = createUsagePolling({
    api: props.api,
    get session_id() {
      return props.session_id
    },
    runtime: props.runtime,
    onMissingCodex: props.onMissingCodex,
    enabled: sidebarHidden,
  })
  const root = createElement("box")

  insert(root, () => (isOpenAI() && sidebarHidden() ? CompactUsageLine({ state, theme }) : null), null)

  return root
}

function createUsagePolling(props: {
  api: TuiPluginApi
  session_id: string
  runtime: Runtime
  onMissingCodex: () => void
  enabled?: () => boolean
}) {
  const [state, setState] = createSignal<UsageState>({
    status: "loading",
    usage: null,
    message: "Loading usage...",
  })

  const isOpenAI = createMemo(() => isOpenAISession(props.api, props.session_id))
  const enabled = props.enabled ?? (() => true)

  let disposed = false
  let timer: ReturnType<typeof setInterval> | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  let inFlight: Promise<void> | undefined
  let refreshAgain = false

  const refresh = () => {
    if (inFlight) {
      refreshAgain = true
      debug(props.runtime, "tui.refresh.join", { sessionID: props.session_id })
      return inFlight
    }

    inFlight = runRefresh().finally(() => {
      inFlight = undefined
      if (refreshAgain && !disposed) {
        refreshAgain = false
        void refresh()
      }
    })

    return inFlight
  }

  const runRefresh = async () => {
    if (!enabled()) return

    if (!isOpenAI()) {
      debug(props.runtime, "tui.refresh.skip", { reason: "provider_not_openai", sessionID: props.session_id })
      return
    }

    const startedAt = Date.now()
    debug(props.runtime, "tui.refresh.start", { sessionID: props.session_id })
    if (timeout) clearTimeout(timeout)
    timeout = setTimeout(() => {
      if (disposed || state().status !== "loading") return
      warn(props.runtime, "tui.refresh.ui_timeout", { sessionID: props.session_id, timeoutMs: UI_TIMEOUT_MS })
      setState({
        status: "error",
        usage: null,
        message: "Still waiting for Codex; retry or check Codex CLI sign-in.",
      })
      props.api.renderer.requestRender()
    }, UI_TIMEOUT_MS)

    try {
      const usage = await props.runtime.runPromise(
        Effect.gen(function* () {
          const codex = yield* CodexService.Service
          return yield* codex.readUsage()
        }),
      )
      if (disposed) return
      if (timeout) clearTimeout(timeout)
      debug(props.runtime, "tui.refresh.success", { sessionID: props.session_id, ms: Date.now() - startedAt })
      setState({ status: "ready", usage, message: "Usage loaded" })
      props.api.renderer.requestRender()
    } catch (error) {
      if (disposed) return
      if (timeout) clearTimeout(timeout)
      if (Predicate.isTagged(error, "CodexService.CommandMissingError")) props.onMissingCodex()
      warn(props.runtime, "tui.refresh.error", {
        sessionID: props.session_id,
        ms: Date.now() - startedAt,
        error: errorMessage(error),
      })
      setState({
        status: "error",
        usage: null,
        message: errorMessage(error),
      })
      props.api.renderer.requestRender()
    }
  }

  createEffect(() => {
    if (enabled() && isOpenAI()) untrack(() => void refresh())
  })
  timer = setInterval(() => void refresh(), POLL_MS)
  const unsubscribeMessage = props.api.data.on("session.step.ended", () => void refresh())
  const unsubscribeSession = props.api.data.on("session.model.selected", () => void refresh())

  onCleanup(() => {
    disposed = true
    unsubscribeMessage()
    unsubscribeSession()
    if (timer) clearInterval(timer)
    if (timeout) clearTimeout(timeout)
  })

  return { state, isOpenAI }
}

function UsageBlock(props: { state: () => UsageState; theme: () => TuiTheme }) {
  const root = createElement("box")
  const title = createElement("text")
  const bold = createElement("b")

  insertNode(root, title)
  insertNode(title, bold)
  insertNode(bold, createTextNode("Codex Usage"))
  effect(() => setProp(title, "fg", props.theme().text))

  insert(
    root,
    () => {
      const state = props.state()

      switch (state.status) {
        case "ready":
          return UsageGauges(state.usage, props.theme)
        case "error":
          return textLine(
            () => props.state().message,
            () => props.theme().warning,
          )
        case "loading":
          return textLine(
            () => "Loading...",
            () => props.theme().textMuted,
          )
      }
    },
    null,
  )

  return root
}

function textLine(text: () => string, color: () => TuiColor) {
  const line = createElement("text")

  insert(line, text)
  effect(() => setProp(line, "fg", color()))

  return line
}

function UsageGauges(usage: Usage.CodexUsage, theme: () => TuiTheme) {
  const root = createElement("box")
  const row = createElement("box")
  const gaugeWidth = usage.fiveHour ? GAUGE_WIDTH : EXPANDED_GAUGE_WIDTH
  setProp(row, "flexDirection", "row")
  setProp(row, "columnGap", 1)
  insertNode(root, row)
  if (usage.fiveHour) insertNode(row, UsageGauge("5h", usage.fiveHour, theme, gaugeWidth))
  if (usage.weekly) insertNode(row, UsageGauge("week", usage.weekly, theme, gaugeWidth, Boolean(usage.fiveHour)))
  return root
}

function UsageGauge(
  label: string,
  window: Usage.UsageWindow | null,
  theme: () => TuiTheme,
  width: number,
  separator = false,
) {
  const root = createElement("box")
  const barLine = createElement("box")
  const detailLine = createElement("box")
  setProp(root, "flexDirection", "column")
  setProp(barLine, "flexDirection", "row")
  setProp(detailLine, "flexDirection", "row")

  const labelText = createElement("text")
  insertNode(labelText, createTextNode(`${label} `))
  effect(() => setProp(labelText, "fg", theme().textMuted))

  const fillText = createElement("text")
  const trackText = createElement("text")
  const separatorText = createElement("text")
  const percentText = createElement("text")
  const resetText = createElement("text")
  insert(fillText, () => usageGauge(window?.usedPercent ?? 0, width).fill)
  insert(trackText, () => usageGauge(window?.usedPercent ?? 0, width).track)
  insert(separatorText, () => (separator && window ? " · " : ""))
  insert(percentText, () => (window ? Usage.formatPercent(window.usedPercent) : "--"))
  insert(resetText, () => (window ? ` ${resetAt(window.resetsAt)}` : ""))
  effect(() => {
    const color = window ? levelColor(window.usedPercent, theme()) : theme().textMuted
    setProp(fillText, "fg", color)
    setProp(percentText, "fg", color)
    setProp(trackText, "fg", theme().textMuted)
    setProp(separatorText, "fg", theme().textMuted)
    setProp(resetText, "fg", theme().textMuted)
  })

  insertNode(barLine, labelText)
  insertNode(barLine, fillText)
  insertNode(barLine, trackText)
  insertNode(detailLine, separatorText)
  insertNode(detailLine, percentText)
  insertNode(detailLine, resetText)
  insertNode(root, barLine)
  insertNode(root, detailLine)
  return root
}

function CompactUsageLine(props: { state: () => UsageState; theme: () => TuiTheme }) {
  return textLine(
    () => compactUsageText(props.state()),
    () => props.theme().textMuted,
  )
}

function compactUsageText(state: UsageState) {
  switch (state.status) {
    case "ready":
      return compactGaugeText(state.usage)
    case "error":
      return ""
    case "loading":
      return "5h ..."
  }
}

function gauge(fraction: number, width: number): { fill: string; track: string } {
  const cells = Math.min(1, Math.max(0, fraction)) * width
  let full = Math.floor(cells)
  let partial = EIGHTHS[Math.round((cells - full) * 8)] ?? ""
  if (partial === EIGHTHS[8]) {
    full += 1
    partial = ""
  }
  return {
    fill: "█".repeat(full) + partial,
    track: "░".repeat(width - full - (partial ? 1 : 0)),
  }
}

function usageGauge(percent: number, width: number): { fill: string; track: string } {
  return gauge(percent / 100, width)
}

function levelColor(percent: number, theme: TuiTheme): TuiColor {
  if (percent >= DANGER_AT) return theme.error
  if (percent >= WARN_AT) return theme.warning
  if (percent >= OK_AT) return theme.accent
  return theme.success
}

function resetAt(unixSeconds: number | null, now = new Date()): string {
  if (!unixSeconds) return "?"

  const reset = new Date(unixSeconds * 1000)
  if (!Number.isFinite(reset.getTime())) return "?"
  if (reset.getTime() <= now.getTime()) return "now"

  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(reset)
}

function compactGaugeText(usage: Usage.CodexUsage): string {
  const windows = [usage.fiveHour, usage.weekly].filter((window): window is Usage.UsageWindow => window !== null)
  const window = windows.reduce<Usage.UsageWindow | undefined>(
    (worst, current) => (!worst || current.usedPercent > worst.usedPercent ? current : worst),
    undefined,
  )
  return window ? `Codex ${window.label} ${Usage.formatPercent(window.usedPercent)}` : ""
}

function formatContextTokens(tokens: number): string {
  return `${Math.floor(tokens / 1_000).toLocaleString("en-US")}k`
}

function formatContextUsage(tokens: number, context: number | null): string {
  return `${formatContextTokens(tokens)} / ${context ? formatContextTokens(context) : "?"}`
}

function contextPressureColor(percent: number | null, theme: TuiTheme): TuiColor {
  if (percent === null || percent < CONTEXT_WARN_AT) return theme.textMuted
  if (percent >= CONTEXT_DANGER_AT) return theme.error
  return theme.warning
}

export const CodexUsageFormat = {
  gauge,
  usageGauge,
  levelColor,
  resetAt,
  compactGaugeText,
  formatContextTokens,
  formatContextUsage,
  contextPressureColor,
  contextState,
  isOpenAISession,
}

function isOpenAISession(api: TuiPluginApi, sessionID: string): boolean {
  const selected = api.data.session.get(sessionID)?.model
  if (selected) return selected.providerID === "openai"
  const last = api.data.session.message.list(sessionID).findLast((message) => message.type === "assistant")
  return (last?.type === "assistant" ? last.model : api.ui.model.current())?.providerID === "openai"
}

function contextState(api: TuiPluginApi, sessionID: string) {
  const messages = api.data.session.message.list(sessionID)
  const session = api.data.session.get(sessionID)
  const boundary = session?.revert?.messageID
  const boundaryIndex = boundary ? messages.findIndex((message) => message.id === boundary) : -1
  const end = boundary ? Math.max(0, boundaryIndex) : messages.length
  const compact = messages.findLastIndex((message, index) =>
    index < end && message.type === "compaction" && message.status === "completed")
  const last = messages.findLast((message, index): message is AssistantSessionMessage & { tokens: NonNullable<AssistantSessionMessage["tokens"]> } =>
    index > compact && index < end && message.type === "assistant" && message.tokens !== undefined)
  const tokens = last ? last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write : 0
  const selected = api.ui.model.current()
  const ref = last?.model ?? session?.model ?? (selected ? { providerID: selected.providerID, id: selected.modelID } : undefined)
  const model = api.data.location.model.list(session?.location)?.find((candidate) =>
    candidate.providerID === ref?.providerID && candidate.id === ref?.id)
  const context = model?.limit.context ?? null
  return { tokens, context, percent: context ? Math.round(tokens / context * 100) : null }
}

function themeColors(api: TuiPluginApi): TuiTheme {
  const theme = api.theme
  return {
    text: theme.text.base,
    textMuted: theme.text.muted,
    success: theme.text.feedback.success.base,
    accent: theme.text.action.primary.base,
    warning: theme.text.feedback.warning.base,
    error: theme.text.feedback.error.base,
  }
}

function createRuntime(api: TuiPluginApi) {
  const loggerLayer = Logger.layer(api)
  return ManagedRuntime.make(CodexService.layer().pipe(Layer.provideMerge(loggerLayer)))
}

function debug(runtime: Runtime, message: string, extra: Record<string, unknown> = {}) {
  void runtime.runPromise(Effect.logDebug(message, extra)).catch(() => undefined)
}

function warn(runtime: Runtime, message: string, extra: Record<string, unknown> = {}) {
  void runtime.runPromise(Effect.logWarning(message, extra)).catch(() => undefined)
}

function errorMessage(error: unknown): string {
  if (Predicate.isError(error)) return error.message
  if (Predicate.hasProperty(error, "message") && Predicate.isString(error.message)) {
    return error.message
  }
  return "Usage unavailable"
}

const plugin: Plugin.Definition = {
  id: "opencode-codex-usage",
  setup: async (api) => {
    const runtime = createRuntime(api)
    debug(runtime, "plugin.init", {})
    let warnedMissingCodex = false

    const warnMissingCodex = () => {
      if (warnedMissingCodex) return
      warnedMissingCodex = true
      api.ui.toast.show({
        variant: "warning",
        title: "Codex required",
        message: "Install Codex.app or the Codex CLI to see usage stats.",
      })
    }

    const [sidebars, setSidebars] = createSignal<Record<string, number>>({})
    const mounted = (id: string) => {
      setSidebars((state) => ({ ...state, [id]: (state[id] ?? 0) + 1 }))
      return () => setSidebars((state) => ({ ...state, [id]: Math.max(0, (state[id] ?? 1) - 1) }))
    }
    const removeContext = api.ui.slot({
      prepend: "sidebar.content",
      render(props) {
        return createComponent(ContextView, {
          api,
          get session_id() { return props.sessionID },
        }) as unknown as JSX.Element
      },
    })
    const removeUsage = api.ui.slot({
      prepend: "sidebar.content",
      render(props) {
        return createComponent(View, {
          api,
          get session_id() { return props.sessionID },
          runtime,
          onMissingCodex: warnMissingCodex,
          mounted,
        }) as unknown as JSX.Element
      },
    })
    const removeCompact = api.ui.slot({
      append: "prompt.footer.status",
      render(props) {
        if (!props.sessionID) return null as unknown as JSX.Element
        return createComponent(CompactView, {
          api,
          get session_id() { return props.sessionID! },
          runtime,
          onMissingCodex: warnMissingCodex,
          sidebarVisible: (id) => (sidebars()[id] ?? 0) > 0,
        }) as unknown as JSX.Element
      },
    })
    return async () => {
      removeContext()
      removeUsage()
      removeCompact()
      await runtime.dispose()
    }
  },
}

export default plugin
