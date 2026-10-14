# opencode-codex-usage-plugin

## Local OpenCode V2 port

This checkout was migrated and cold-start verified against OpenCode **2.0.29**
on 2026-10-14. It restores Codex quota gauges and the customized
`used / model ceiling` Context panel. Two separate fresh CLI launches rendered
both, with one Context block; no model limits or OAuth files were changed.

V2 must load the **directory** containing `tui.js`, not the file itself:

```jsonc
// ~/.config/opencode/cli.json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [
    "file:///home/sam/.config/opencode/local-plugins/codex-usage/dist",
    "-opencode.sidebar.context"
  ]
}
```

The transport now uses the host's Effect **4.0.1** and `Schema.TaggedError`.
Old beta Effect releases and npm aliases are not restart-safe under V2's shared
module rules. The tests install those real host rules, exercise late model data,
and use a fake Codex subprocess without making inference requests.

```sh
npx --yes pnpm@10.33.0 install --ignore-scripts
npx --yes pnpm@10.33.0 build
npm test
npm run typecheck
npm run test:render
npm run test:discovery
```

V2 removed the public `client.app.log` endpoint; quota errors stay visible in
the panel rather than being sent to that unsupported method. Codex CLI
authentication remains separate from OpenCode authentication. Reset times in
this local customization are absolute weekday/local-time values.

The upstream installation instructions below describe the original V1 plugin,
not this local V2 build. Do not replace this checkout with an upstream package
until that package's V2 support has been independently verified.

## Upstream V1 documentation

An [OpenCode](https://opencode.ai) TUI sidebar plugin that shows Codex 5-hour and weekly quota usage as compact gauges with reset countdowns.

```text
Codex Usage
5h   ███░░░░  week █████▋░
42% · 2h      81% · 7d
```

This is a maintained fork of [zaniluca/opencode-codex-usage-plugin](https://github.com/zaniluca/opencode-codex-usage-plugin). It keeps the original Codex App/CLI integration and presents the usage data in the gauge style used by the other David Ayers OpenCode plugins.

## Features

- **Quota gauges** — compact eighth-block gauges for the available 5-hour and weekly Codex limits
- **Proximity colors** — gauge and percentage use the active theme: `success` <50% → `accent` 50–74% → `warning` 75–89% → `error` ≥90%
- **Reset countdowns** — short reset times appear beneath each available window
- **Compact prompt line** — identifies the most constrained window when the sidebar is hidden
- **Codex App/CLI support** — reads usage through the Codex app-server protocol with command discovery and fallback handling
- **Live updates** — refreshes every 60 seconds and on message/session events
- **Silent by design** — hidden for non-Codex sessions

## Install

```sh
opencode plugin --global @davidaayers/opencode-codex-usage-plugin
```

Or from inside OpenCode: press `ctrl+p` → "Install Plugin" → `@davidaayers/opencode-codex-usage-plugin`. Restart OpenCode and the gauges appear once the session uses an OpenAI/Codex model.

### From source

OpenCode TUI plugins load from the `plugin` array in **`~/.config/opencode/tui.json`** (or a project-level `tui.json`) — _not_ from `opencode.jsonc`, whose `plugin` array is server-side only.

```jsonc
// ~/.config/opencode/tui.json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["file:///absolute/path/to/opencode-codex-usage-plugin/dist/tui.js"],
}
```

## Requirements

Install either **Codex App** or the **Codex CLI**. The plugin looks for Codex in common locations and on your `PATH`.

If your Codex command lives somewhere else, set `OPENCODE_CODEX_USAGE_COMMAND`:

```sh
export OPENCODE_CODEX_USAGE_COMMAND="/path/to/codex"
```

## How It Works

- **Usage source**: the Codex app-server provides normalized 5-hour and weekly rate-limit windows.
- **Rendering**: the plugin uses OpenTUI and the active OpenCode theme, with the gauge renderer kept separate from the Codex transport.
- **Lifecycle**: the existing Effect-based service owns command discovery, socket reuse, stdio fallback, request timeouts, and cleanup.

## Development

```sh
pnpm install
pnpm check
pnpm test
pnpm build
```

The published plugin entrypoint is [`dist/tui.js`](dist/tui.js), generated from [`src/tui.ts`](src/tui.ts).

## Roadmap

Cross-repository follow-up work is tracked in the [OpenCode Plugins project](https://github.com/users/davidaayers/projects/1).

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history.

## Credits

The Codex integration is forked from [zaniluca/opencode-codex-usage-plugin](https://github.com/zaniluca/opencode-codex-usage-plugin). The gauge presentation is inspired by [@davidaayers/opencode-go-usage-plugin](https://github.com/davidaayers/opencode-go-usage-plugin) and [@davidaayers/opencode-context-gauge-plugin](https://github.com/davidaayers/opencode-context-gauge-plugin).

## License

[MIT](LICENSE). See the upstream project for the original implementation and attribution.
