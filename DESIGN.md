# Codex Usage Gauges

## Purpose

Create a maintained derivative of `zaniluca/opencode-codex-usage-plugin` that
keeps its Codex app-server integration but presents usage with the compact,
visual gauge language used by the OpenCode Go usage plugin.

This document records the intended behavior and boundaries before any
implementation changes are made.

## Implemented V2 state (2026-10-14)

The original V1 design below is retained as history; its `tui.json`, countdown, and application-logger references are not the current runtime contract. The local build now targets OpenCode 2.0.29:

- Load the `dist` directory through `~/.config/opencode/cli.json`; a direct `dist/tui.js` target is silently skipped by V2. Disable the native duplicate with `-opencode.sidebar.context` only after the replacement loads.
- Register `setup`, `context.ui.slot` (`sidebar.content` and `prompt.footer.status`), V2 `context.data`, and semantic theme tokens.
- Display used/model-ceiling context from current model metadata, with the host's compaction/revert usage rules. The 628k GPT-6.1 Sol ceiling observed during verification was not an override introduced by this plugin.
- Retain Codex's `account/rateLimits/read`, independent authentication ownership, fallback transport, cleanup, and absolute local reset times. Show whichever quota windows actually exist, including a single weekly gauge.
- Use the host-owned Effect 4.0.1 and `Schema.TaggedError`; V2 rejects old beta dependencies and aliases. Its public SDK removed `client.app.log`, so quota errors remain visible in the panel instead of calling that unavailable method.
- Start polling when both the view is enabled and OpenAI model data becomes available, including delayed model arrival after mounting. Scope compact-mode visibility to mounted sidebars for the same session.
- Verification: 36 tests, typecheck/build, native rendering with `ensurePluginRuntime` foreign-package checks, discovery from the installed CLI configuration, and two fresh actual CLI launches showing live quota and one Context block.

## Original V1 Goals

- Show Codex 5-hour and weekly usage as compact gauges in the OpenCode TUI
  sidebar.
- Use the active OpenCode theme for gauge severity and text colors.
- Show a short reset countdown beneath each available gauge.
- Show a compact prompt-area indicator when the sidebar is hidden.
- Make the compact indicator reflect the more constrained available window.
- Preserve the existing Codex app-server transport, fallback behavior, typed
  response mapping, diagnostics, and lifecycle cleanup.
- Keep the plugin TUI-only and installable through `tui.json`.
- Add tests for formatting, gauge boundaries, usage mapping, and relevant UI
  state transitions.

## Non-goals

- Do not change the Codex app-server protocol or usage endpoint behavior.
- Do not scrape the Codex app or maintain a separate authentication flow.
- Do not add OpenCode Go, OpenAI, or other provider usage to this plugin.
- Do not add configuration options until the fixed layout and behavior prove
  insufficient.
- Do not turn this into a general-purpose gauge component library.

## Intended UI

The sidebar should use the existing fixed-width sidebar geometry and render two
columns, one for each Codex window:

```text
Codex Usage
5h ████░░░ weekly ██████░
42% · 2h     81% · 7d
```

The exact bar width and labels must be chosen against the real sidebar width.
The layout must remain stable when a window is unavailable, a reset time is
unknown, or the terminal is narrow.

Gauge colors should follow quota pressure rather than error-only emphasis:

- `success`: below 50%
- `accent`: 50% through 74%
- `warning`: 75% through 89%
- `error`: 90% and above

Unavailable data should be represented clearly without implying zero usage.
The plugin should remain silent when the current session is not using Codex.

## Data and transport

The existing `CodexService` remains the source of truth. It should continue to
own:

- Codex command discovery and the environment override
- Shared Unix socket startup and reuse
- stdio fallback
- request correlation and timeouts
- protocol validation and typed errors
- disposal of processes, sockets, timers, and pending requests

The TUI layer should consume the normalized `Usage.CodexUsage` model rather than
rendering raw protocol payloads.

## Polling and lifecycle

Sidebar and compact prompt views should share usage state where practical,
rather than independently starting equivalent polling loops for the same
session. Refreshes should still occur on a reasonable interval and on the
existing message/session events.

Polling must be bounded and cancellable. A failed refresh should not crash the
TUI, leak a Codex process, or replace a previously valid display with misleading
zeroes. Diagnostics should continue to use OpenCode's application logger.

## Session behavior

- Render usage only for sessions whose active or most recent assistant provider
  is Codex/OpenAI, matching the existing plugin behavior.
- Hide the sidebar block for unrelated providers and child sessions where the
  existing plugin already suppresses it.
- Use the prompt-area indicator only when the sidebar is hidden.
- Do not show a missing-Codex warning repeatedly; retain the existing
  user-facing warning policy.

## Implementation boundaries

- `src/codex.ts`: transport/service changes only if required by shared polling or
  lifecycle cleanup.
- `src/usage.ts`: normalized data and formatting helpers where appropriate.
- `src/tui.ts`: gauge rendering, responsive placement, shared polling state, and
  prompt compact mode.
- Tests should prefer pure helper tests for formatting and deterministic
  service tests for protocol behavior.
- The package remains a TUI plugin loaded from `tui.json`, not the server-side
  `opencode.json` plugin array.

## Acceptance criteria

- A normal Codex session shows readable 5-hour and weekly gauges.
- Gauge fill, percentage, and reset countdown remain aligned at maximum values.
- Threshold colors are correct at each boundary, including exactly 50%, 75%,
  and 90%.
- Missing or partial windows render safely and do not appear as 0% usage.
- The compact prompt indicator identifies the binding window.
- Non-Codex sessions remain visually unaffected.
- Transport, fallback, timeout, malformed-payload, and cleanup tests continue to
  pass.
- Typecheck, tests, and a TUI/render verification run succeed before release.

## Sequencing

1. Establish this design document as the first authored change in the fork.
2. Bring the fork baseline and branch history into alignment with the intended
   source revision without changing behavior.
3. Implement the gauge presentation and shared state carefully in small steps.
4. Add or update tests and verify the real TUI layout.
5. Update README, package metadata, and release instructions only after the
   behavior is stable.
