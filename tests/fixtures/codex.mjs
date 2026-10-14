#!/usr/bin/env node
import { createInterface } from "node:readline"

// Force the existing transport's stdio fallback instead of creating a shared
// socket. The fixture never contacts Codex or OpenAI.
if (process.argv.some((arg) => arg.startsWith("unix://"))) process.exit(1)

for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line)
  if (request.method === "initialize") {
    console.log(JSON.stringify({ id: request.id, result: { userAgent: "fixture" } }))
  } else if (request.method === "account/rateLimits/read") {
    console.log(JSON.stringify({ id: request.id, result: { rateLimits: {
      primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1900000000 },
      secondary: { usedPercent: 81, windowDurationMins: 10080, resetsAt: 1900000000 },
    } } }))
  } else if (request.id !== undefined) {
    console.log(JSON.stringify({ id: request.id, error: { code: -1, message: `Unexpected request: ${request.method}` } }))
  }
}
