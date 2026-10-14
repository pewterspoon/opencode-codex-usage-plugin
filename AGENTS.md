# AGENTS.md

# Module shape

Do not use `export namespace Foo { ... }` for module organization. It is not
standard ESM, it prevents tree-shaking, and it breaks Node's native TypeScript
runner. Use flat top-level exports combined with a self-reexport at the bottom
of the file:

```ts
// src/foo/foo.ts
export interface Interface { ... }
export class Service extends Context.Service<Service, Interface>()("@api/Foo") {}
export const layer = Layer.effect(Service, ...)
export const defaultLayer = layer.pipe(...)

export * as Foo from "./foo"
```

Consumers import the namespace projection:

```ts
import { Foo } from "@/foo/foo"

yield * Foo.Service
Foo.layer
Foo.defaultLayer
```

Namespace-private helpers stay as non-exported top-level declarations in the
same file — they remain inaccessible to consumers (they are not projected by
`export * as`) but are usable by the file's own code.

## When the file is an `index.ts`

If the module is `foo/index.ts` (single-namespace directory), use `"."` for
the self-reexport source rather than `"./index"`:

```ts
// src/foo/index.ts
export const thing = ...

export * as Foo from "."
```

## Multi-sibling directories

For directories with several independent modules (e.g. `src/session/`,
`src/config/`), keep each sibling as its own file with its own self-reexport,
and do not add a barrel `index.ts`. Consumers import the specific sibling:

```ts
import { SessionRetry } from "@/session/retry"
import { SessionStatus } from "@/session/status"
```

Barrels in multi-sibling directories force every import through the barrel to
evaluate every sibling, which defeats tree-shaking and slows module load.

# Effect rules

Use these rules when writing Effect code.

## Core

- Use `Effect.gen(function* () { ... })` for composition.
- Use `Effect.fn("Domain.method")` for named/traced effects; reserve `Effect.fnUntraced` for measured low-level hot paths.
- `Effect.fn` / `Effect.fnUntraced` accept pipeable operators as extra arguments, so avoid unnecessary outer `.pipe()` wrappers.
- Use `Effect.callback` for callback-based APIs.
- Use `Effect.void` instead of `Effect.succeed(undefined)` or `Effect.succeed(void 0)`.
- Prefer `DateTime.nowAsDate` over `new Date(yield* Clock.currentTimeMillis)` when you need a `Date`.

## Schemas and errors

- Use `Schema.Class` for multi-field data.
- Use branded schemas (`Schema.brand`) for single-value types.
- Use `Schema.TaggedError` for typed errors under the host's Effect 4.0.1 API.
- Use `Schema.Defect` instead of `unknown` for defect-like causes.
- In `Effect.gen` / `Effect.fn`, prefer `yield* new MyError(...)` over `yield* Effect.fail(new MyError(...))` for direct early-failure branches.

## Effect Best Practices

**IMPORTANT:** Always consult effect-solutions before writing Effect code.

1. Run `pnpm effect-solutions list` to see available guides
2. Run `pnpm effect-solutions show <topic>...` for relevant patterns (supports multiple topics)
3. Search `~/.local/share/opencode/repos/github.com/Effect-TS/effect-smol` for real implementations

Topics: quick-start, project-setup, tsconfig, basics, services-and-layers, data-modeling, error-handling, config, testing, cli.

Never guess at Effect patterns - check the guide first.

## Local Effect References

The Effect source is cloned to `~/.local/share/opencode/repos/github.com/Effect-TS/effect-smol` for implementation details when local guides and installed package types are not enough.

The OpenCode repository at `~/.local/share/opencode/repos/github.com/anomalyco/opencode` has useful examples for structuring an Effect codebase.

# OpenCode plugin rules

- This local port targets OpenCode 2.0.29 and its shared Effect 4.0.1. Use bare `effect` imports; older package-local copies and npm aliases are rejected by the CLI runtime. Validate the installed host API when a guide shows a beta-era API name.

- V2's public SDK has no `client.app.log` endpoint. Keep failures visible in the usage panel; the current logger layer is intentionally silent. Do not call the old V1 method or print diagnostics into the terminal renderer.
- OpenCode server logs are written under `~/.local/share/opencode/log/opencode.log`.
- Debug-level plugin logs require OpenCode `logLevel: "DEBUG"` or `OPENCODE_LOG_LEVEL=DEBUG`; the desktop app's `Export Logs...` action includes server logs.
