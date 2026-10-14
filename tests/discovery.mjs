import assert from "node:assert/strict"
import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import { resolve, load } from "@opencode/plugin/host"

const path = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode/cli.json")
const config = JSON.parse(await readFile(path, "utf8"))
const target = config.plugins.find(value => typeof value === "string" && value.includes("/codex-usage/"))
assert.ok(target, "Codex sidebar must be configured")
const directory = fileURLToPath(target)
assert.equal((await stat(directory)).isDirectory(), true, "V2 skips direct local-file CLI plugin targets")
const entrypoint = resolve({ directory }).tui
assert.ok(entrypoint?.endsWith("/tui.js"), "configured directory must expose the V2 tui entrypoint")
const module = await load(entrypoint)
assert.equal(module.default.id, "opencode-codex-usage")
assert.equal(typeof module.default.setup, "function")
assert.ok(config.plugins.includes("-opencode.sidebar.context"), "disable the V2 built-in context by its actual ID")
console.log("Installed CLI discovery passed: configured directory resolves the V2 sidebar definition.")
