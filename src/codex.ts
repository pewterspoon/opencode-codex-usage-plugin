import { spawn, type SpawnOptions } from "node:child_process"
import { createRequire } from "node:module"
import { accessSync, constants, unlinkSync } from "node:fs"
import { createConnection } from "node:net"
import { delimiter, join } from "node:path"
import { createInterface, type Interface as ReadlineInterface } from "node:readline"
import type { Readable, Writable } from "node:stream"
import { Clock, Context, Effect, Layer, Predicate, Schema, Semaphore } from "effect"
import { Logger } from "./logger.ts"
import { Usage } from "./usage.ts"

const packageJson = createRequire(import.meta.url)("../package.json") as { version: string }

export type RequestId = typeof RequestId.Type
export const RequestId = Schema.Union([Schema.String, Schema.Number])

export class CommandMissingError extends Schema.TaggedError<CommandMissingError>()(
  "CodexService.CommandMissingError",
  {
    message: Schema.String,
  },
) {}

export class ServerStartError extends Schema.TaggedError<ServerStartError>()("CodexService.ServerStartError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

export class TransportError extends Schema.TaggedError<TransportError>()("CodexService.TransportError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

export class RequestTimeoutError extends Schema.TaggedError<RequestTimeoutError>()(
  "CodexService.RequestTimeoutError",
  {
    id: RequestId,
    method: Schema.String,
    timeoutMs: Schema.Number,
    message: Schema.String,
  },
) {}

export class ProtocolParseError extends Schema.TaggedError<ProtocolParseError>()(
  "CodexService.ProtocolParseError",
  {
    message: Schema.String,
    line: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export class ProtocolError extends Schema.TaggedError<ProtocolError>()("CodexService.ProtocolError", {
  message: Schema.String,
}) {}

export class InvalidPayloadError extends Schema.TaggedError<InvalidPayloadError>()(
  "CodexService.InvalidPayloadError",
  {
    message: Schema.String,
  },
) {}

export type Error =
  | CommandMissingError
  | ServerStartError
  | TransportError
  | RequestTimeoutError
  | ProtocolParseError
  | ProtocolError
  | InvalidPayloadError

export interface Interface {
  readonly readUsage: () => Effect.Effect<Usage.CodexUsage, Error>
  readonly dispose: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("CodexService") {}

type CommandExists = (command: string) => boolean

interface CodexProcess {
  readonly stdin: Writable | null
  readonly stdout: Readable | null
  readonly stderr: Readable | null
  readonly kill: () => unknown
  readonly unref?: () => unknown
  readonly removeAllListeners?: () => unknown
  readonly once: {
    (event: "error", listener: (error: globalThis.Error) => void): unknown
    (event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  }
}

type TransportProcess = CodexProcess & {
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable
}

type SpawnCodex = (command: string, args: ReadonlyArray<string>, options: SpawnOptions) => CodexProcess

export interface Options {
  readonly command?: string
  readonly commandExists?: CommandExists
  readonly env?: Partial<NodeJS.ProcessEnv>
  readonly socketPath?: string
  readonly spawn?: SpawnCodex
  readonly timeoutMs?: number
}

interface PendingRequest {
  readonly method: string
  readonly resume: (effect: Effect.Effect<unknown, Error>) => void
  readonly timer: NodeJS.Timeout
}

interface TransportState {
  readonly process: TransportProcess
  readonly lines: ReadlineInterface
}

class ProtocolMessage extends Schema.Class<ProtocolMessage>("CodexService.ProtocolMessage")({
  id: Schema.optionalKey(RequestId),
  method: Schema.optionalKey(Schema.String),
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Unknown),
  params: Schema.optionalKey(Schema.Unknown),
}) {}

const decodeProtocolMessage = Schema.decodeUnknownEffect(ProtocolMessage)

const MISSING_CODEX_MESSAGE =
  "Codex is not installed. Install Codex.app or the Codex CLI, or set OPENCODE_CODEX_USAGE_COMMAND."
const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_SOCKET_PATH = join(
  "/tmp",
  `opencode-codex-usage-plugin-${typeof process.getuid === "function" ? process.getuid() : "user"}.sock`,
)
const CODEX_COMMAND_CANDIDATES = [
  "/opt/homebrew/bin/codex",
  "/usr/local/bin/codex",
  "/Applications/Codex.app/Contents/Resources/codex",
]

export const layer = (options: Options = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const command = options.command ?? resolveCodexCommand(options.commandExists, options.env)
      const socketPath = options.socketPath ?? DEFAULT_SOCKET_PATH
      const spawnProcess = options.spawn ?? spawn
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
      const pending = new Map<RequestId, PendingRequest>()

      let transport: TransportState | undefined
      let nextId = 1
      let initialized = false

      const context = yield* Effect.context()
      // Node callbacks below run outside Effect, so they need a runtime entrypoint that preserves this layer context.
      const runCallbackEffect = Effect.runForkWith(context)

      // Only one read should initialize or reconnect the Codex transport at a time.
      const mutex = yield* Semaphore.make(1)

      const rejectAll = (error: Error) =>
        Effect.sync(() => {
          for (const request of pending.values()) {
            clearTimeout(request.timer)
            request.resume(Effect.fail(error))
          }
          pending.clear()
        })

      const cleanupTransport = (expected?: TransportProcess, shouldKill = true) =>
        Effect.sync(() => {
          const current = transport
          if (!current || (expected && current.process !== expected)) return
          current.lines.close()
          if (shouldKill) current.process.kill()
          transport = undefined
          initialized = false
        })

      const failTransport = (target: TransportProcess, error: TransportError) =>
        Effect.gen(function* () {
          if (transport?.process !== target) return
          yield* Effect.logError("server.error", { error: error.message })
          yield* rejectAll(error)
          yield* cleanupTransport(target)
        })

      const writeProtocol = Effect.fn("CodexService.writeProtocol")(function* (
        target: TransportProcess,
        payload: unknown,
      ) {
        if (transport?.process !== target)
          return yield* new TransportError({ message: "Codex app-server transport is stale." })

        yield* Effect.try({
          try: () => target.stdin.write(`${JSON.stringify(payload)}\n`),
          catch: (cause) => new TransportError({ message: "Failed to write to Codex app-server.", cause }),
        })
      })

      const dispose = Effect.fn("CodexService.dispose")(function* () {
        yield* Effect.logDebug("client.dispose", { pending: pending.size, running: transport !== undefined })
        yield* rejectAll(new TransportError({ message: "Codex app-server stopped before pending requests completed." }))
        yield* cleanupTransport()
      })

      yield* Effect.logDebug("client.created", { command, socketPath, timeoutMs })
      yield* Effect.addFinalizer(() => dispose())

      const spawnCodex = Effect.fn("CodexService.spawn")(function* (
        args: ReadonlyArray<string>,
        spawnOptions: SpawnOptions,
        message: string,
      ) {
        if (!command) return yield* new CommandMissingError({ message: MISSING_CODEX_MESSAGE })
        const child = yield* Effect.try({
          try: () => spawnProcess(command, [...args], spawnOptions),
          catch: (cause) => new ServerStartError({ message: "Failed to start Codex app-server.", cause }),
        })
        yield* Effect.logDebug(message, { command, args })
        return child
      })

      const startSharedServer = Effect.fn("CodexService.startSharedServer")(function* () {
        const args = ["app-server", "--listen", `unix://${socketPath}`]
        const server = yield* spawnCodex(
          args,
          { detached: true, stdio: ["ignore", "ignore", "pipe"] },
          "server.shared.spawn",
        )
        let stderr = ""
        server.stderr?.on("data", (chunk: Buffer | string) => {
          stderr += chunk.toString()
        })

        const exited = Effect.callback<never, ServerStartError>((resume) => {
          const settle = (error: ServerStartError) => {
            server.removeAllListeners?.()
            resume(Effect.fail(error))
          }
          server.once("error", (cause) =>
            settle(new ServerStartError({ message: "Codex shared app-server failed to start.", cause })),
          )
          server.once("exit", (code, signal) =>
            settle(
              new ServerStartError({
                message: stderr.trim() || `Codex app-server exited with ${signal ?? code ?? "unknown status"}.`,
              }),
            ),
          )
          return Effect.sync(() => server.removeAllListeners?.())
        })

        yield* waitForSocket(socketPath, timeoutMs).pipe(
          Effect.raceFirst(exited),
          Effect.tap(() =>
            Effect.sync(() => {
              server.unref?.()
            }),
          ),
          Effect.onError(() => Effect.sync(() => server.kill())),
        )
      })

      const ensureSharedServer = Effect.fn("CodexService.ensureSharedServer")(function* () {
        if (yield* canConnectToSocket(socketPath)) {
          yield* Effect.logDebug("server.socket.reuse", { socketPath })
          return
        }
        yield* removeStaleSocket(socketPath)
        yield* startSharedServer()
      })

      const startTransport = Effect.fn("CodexService.startTransport")(function* (
        args: ReadonlyArray<string>,
        event: string,
      ) {
        const child = yield* spawnCodex(args, { stdio: ["pipe", "pipe", "pipe"] }, event)
        if (!isTransportProcess(child)) {
          child.kill()
          return yield* new TransportError({ message: "Codex app-server proxy did not expose stdio." })
        }

        child.once("error", (cause) => {
          runCallbackEffect(
            Effect.gen(function* () {
              if (transport?.process !== child) return
              const error = new TransportError({ message: "Codex app-server transport failed.", cause })
              yield* failTransport(child, error)
            }),
          )
        })

        child.stdin.on("error", (cause) => {
          runCallbackEffect(
            failTransport(child, new TransportError({ message: "Codex app-server stdin failed.", cause })),
          )
        })

        child.once("exit", (code, signal) => {
          runCallbackEffect(
            Effect.gen(function* () {
              if (transport?.process !== child) return
              const message = `Codex app-server exited with ${signal ?? code ?? "unknown status"}.`
              yield* Effect.logWarning("server.exit", { code, signal })
              yield* rejectAll(new TransportError({ message }))
              yield* cleanupTransport(child, false)
            }),
          )
        })

        const lines = createInterface({ input: child.stdout })
        lines.on("line", (line) => {
          if (transport?.process === child) runCallbackEffect(handleLine(child, line))
        })
        child.stderr.on("data", (chunk: Buffer | string) => {
          if (transport?.process !== child) return
          const message = chunk.toString().trim()
          if (message) runCallbackEffect(Effect.logWarning("server.stderr", { message: message.slice(0, 500) }))
        })
        transport = { process: child, lines }
      })

      const send = Effect.fn("CodexService.send")(function* (method: string, params: unknown) {
        const current = transport
        if (!current) return yield* new TransportError({ message: "Codex app-server is not running." })

        const id = `opencode-codex-usage-plugin-${nextId++}`
        const payload = { id, method, params }
        yield* Effect.logDebug("protocol.send", { id, method })

        return yield* Effect.callback<unknown, Error>((resume) => {
          const timer = setTimeout(() => {
            pending.delete(id)
            resume(
              Effect.logWarning("protocol.timeout", { id, method, timeoutMs }).pipe(
                Effect.andThen(
                  Effect.fail(
                    new RequestTimeoutError({
                      id,
                      method,
                      timeoutMs,
                      message: `Timed out waiting for ${method}.`,
                    }),
                  ),
                ),
              ),
            )
          }, timeoutMs)

          pending.set(id, { method, resume, timer })
          runCallbackEffect(
            writeProtocol(current.process, payload).pipe(
              Effect.catch((error) =>
                Effect.gen(function* () {
                  clearTimeout(timer)
                  pending.delete(id)
                  yield* failTransport(current.process, error)
                  resume(Effect.fail(error))
                }),
              ),
            ),
          )

          return Effect.sync(() => {
            clearTimeout(timer)
            pending.delete(id)
          })
        })
      })

      const start = Effect.fn("CodexService.start")(function* () {
        if (!command) {
          yield* Effect.logWarning("server.command.missing")
          return yield* new CommandMissingError({ message: MISSING_CODEX_MESSAGE })
        }

        yield* Effect.gen(function* () {
          yield* ensureSharedServer()
          yield* startTransport(["app-server", "proxy", "--sock", socketPath], "server.proxy.spawn")
        }).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              // Fallback to stdio if the proxy fails
              yield* Effect.logDebug("server.shared.fallback_stdio", { command, socketPath, error: error.message })
              yield* startTransport(["app-server", "--listen", "stdio://"], "server.stdio.spawn")
            }),
          ),
        )

        yield* send("initialize", {
          clientInfo: {
            name: "opencode-codex-usage-plugin",
            title: "OpenCode Codex Usage Plugin",
            version: packageJson.version,
          },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
          },
        })
        initialized = true
      })

      const readUsage = Effect.fn("CodexService.readUsage")(function* () {
        yield* Effect.logDebug("usage.read.start")
        yield* mutex.withPermit(
          Effect.gen(function* () {
            if (initialized && transport) return
            yield* start().pipe(Effect.onError(() => cleanupTransport()))
          }),
        )
        const response = yield* send("account/rateLimits/read", undefined).pipe(
          Effect.flatMap(Usage.decodeRateLimitsResponse),
          Effect.catchTag(
            "SchemaError",
            (error) => new InvalidPayloadError({ message: `Invalid Codex rate-limit payload: ${error.message}` }),
          ),
        )
        const usage = Usage.mapRateLimitsToUsage(response)
        yield* Effect.logDebug("usage.read.success", {
          fiveHour: usage.fiveHour?.usedPercent ?? null,
          weekly: usage.weekly?.usedPercent ?? null,
        })
        return usage
      })

      const handleLine = Effect.fn("CodexService.handleLine")(function* (source: TransportProcess, line: string) {
        const trimmed = line.trim()
        if (!trimmed) return

        const message = yield* parseProtocolMessage(trimmed).pipe(
          Effect.catchTag("CodexService.ProtocolParseError", (error) =>
            Effect.logWarning("protocol.parse_error", { line: error.line, error: error.message }).pipe(Effect.asVoid),
          ),
        )
        if (!message) return
        if (transport?.process !== source) return

        if (message.id === undefined) {
          yield* Effect.logDebug("protocol.notification", { method: message.method })
          return
        }

        if (message.method !== undefined && !Object.hasOwn(message, "result") && !Object.hasOwn(message, "error")) {
          yield* Effect.logDebug("protocol.server_request", { id: message.id, method: message.method })
          if (message.method === "currentTime/read") {
            const unixTimestampMs = yield* Clock.currentTimeMillis
            yield* Effect.logDebug("protocol.server_response", {
              id: message.id,
              method: message.method,
              action: "current_time",
            })
            yield* writeProtocol(source, { id: message.id, result: { unixTimestampMs } }).pipe(
              Effect.catch((error) => failTransport(source, error)),
            )
            return
          }

          yield* Effect.logWarning("protocol.server_response", {
            id: message.id,
            method: message.method,
            action: "unsupported",
          })
          yield* writeProtocol(source, {
            id: message.id,
            error: {
              message: `opencode-codex-usage-plugin does not support Codex app-server request ${message.method}.`,
            },
          }).pipe(Effect.catch((error) => failTransport(source, error)))
          return
        }

        const request = pending.get(message.id)
        if (!request) {
          yield* Effect.logWarning("protocol.unmatched_response", {
            id: message.id,
            hasError: Object.hasOwn(message, "error"),
          })
          return
        }

        pending.delete(message.id)
        clearTimeout(request.timer)
        yield* Effect.logDebug("protocol.response", { id: message.id, hasError: Object.hasOwn(message, "error") })

        if (Object.hasOwn(message, "error")) {
          request.resume(Effect.fail(new ProtocolError({ message: formatProtocolError(message.error) })))
          return
        }

        request.resume(Effect.succeed(Object.hasOwn(message, "result") ? message.result : message))
      })

      return Service.of({
        readUsage,
        dispose,
      })
    }),
  )

export const defaultLayer = layer().pipe(Layer.provideMerge(Logger.noopLayer))

export function resolveCodexCommand(
  commandExists: CommandExists = commandAvailable,
  env: Partial<NodeJS.ProcessEnv> = process.env,
): string | null {
  const configured = env.OPENCODE_CODEX_USAGE_COMMAND
  if (configured) return configured

  return CODEX_COMMAND_CANDIDATES.find(commandExists) ?? (commandExists("codex") ? "codex" : null)
}

const parseProtocolMessage = Effect.fn("CodexService.parseProtocolMessage")(function* (line: string) {
  const parsed = yield* Effect.try({
    try: (): unknown => JSON.parse(line),
    catch: (cause) =>
      new ProtocolParseError({ message: "Invalid Codex protocol JSON.", line: line.slice(0, 200), cause }),
  })
  return yield* decodeProtocolMessage(parsed).pipe(
    Effect.catchTag(
      "SchemaError",
      (cause) => new ProtocolParseError({ message: cause.message, line: line.slice(0, 200), cause }),
    ),
  )
})

function isTransportProcess(process: CodexProcess): process is TransportProcess {
  return process.stdin !== null && process.stdout !== null && process.stderr !== null
}

function commandAvailable(command: string): boolean {
  if (command.includes("/")) return isExecutable(command)

  return (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .some((directory) => isExecutable(join(directory, command)))
}

function canConnectToSocket(socketPath: string): Effect.Effect<boolean> {
  return Effect.callback<boolean>((resume) => {
    let settled = false
    let socket: ReturnType<typeof createConnection> | undefined
    const done = (connected: boolean) => {
      if (settled) return
      settled = true
      socket?.removeAllListeners()
      socket?.destroy()
      resume(Effect.succeed(connected))
    }

    try {
      socket = createConnection(socketPath)
      socket.setTimeout(250)
      socket.once("connect", () => done(true))
      socket.once("error", () => done(false))
      socket.once("timeout", () => done(false))
    } catch {
      done(false)
    }

    return Effect.sync(() => done(false))
  })
}

const waitForSocket = Effect.fn("CodexService.waitForSocket")(function* (socketPath: string, timeoutMs: number) {
  const deadline = (yield* Clock.currentTimeMillis) + timeoutMs

  while ((yield* Clock.currentTimeMillis) < deadline) {
    if (yield* canConnectToSocket(socketPath)) return
    yield* Effect.sleep(100)
  }

  return yield* new ServerStartError({ message: `Timed out waiting for Codex app-server socket at ${socketPath}.` })
})

function removeStaleSocket(socketPath: string): Effect.Effect<void> {
  return Effect.try({
    try: () => unlinkSync(socketPath),
    catch: (cause) => new ServerStartError({ message: "Failed to remove stale Codex app-server socket.", cause }),
  }).pipe(
    Effect.tap(() => Effect.logDebug("server.socket.unlink_stale", { socketPath })),
    Effect.catch((error) =>
      isNodeError(error.cause) && error.cause.code === "ENOENT"
        ? Effect.void
        : Effect.logError("server.socket.unlink_stale_error", { socketPath, error: error.message }),
    ),
  )
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return Predicate.hasProperty(error, "code")
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function formatProtocolError(error: unknown): string {
  if (typeof error === "string") return error
  if (Predicate.hasProperty(error, "message") && typeof error.message === "string") {
    return error.message
  }
  return "Codex app-server request failed."
}

export * as CodexService from "./codex.ts"
