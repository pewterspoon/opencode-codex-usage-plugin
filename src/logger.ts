import type { Plugin } from "@opencode/plugin/tui"
import { Logger as EffectLogger } from "effect"

export const noopLayer = EffectLogger.layer([])

// V2's public client has no app.log endpoint. Keep errors visible in the usage
// panel, rather than throwing from the removed SDK method or writing to the TUI.
export const layer = (_api: Plugin.Context) => noopLayer

export * as Logger from "./logger.js"
