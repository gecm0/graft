import { existsSync, readlinkSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline/promises'

export type Env = Record<string, string | undefined>

// True in the binary built by `bun run build`, false when Bun runs the TypeScript (bun link, tests).
export const compiled = import.meta.dir.startsWith('/$bunfs/')

export type RunOpts = {
  cwd?: string
  env?: Env
  // Stream the child's output to our stderr instead of capturing it (hooks).
  stream?: boolean
}

export type RunResult = { code: number; out: string; err: string }

// Every side effect graft has goes through this, so tests can swap it out.
export type Io = {
  run(cmd: string[], opts?: RunOpts): Promise<RunResult>
  exists(path: string): boolean
  // The symlink's target, or null when the path is not a symlink (a broken one still counts).
  readlink(path: string): string | null
  readText(path: string): Promise<string | null>
  // Creates missing parent folders. Bytes for binaries (graft update), text for the rest.
  writeText(path: string, data: string | Uint8Array): Promise<void>
  // Permission bits (e.g. 0o600), or null when the path doesn't exist.
  mode(path: string): number | null
  // HTTP, for ticket sources (Linear).
  fetch(url: string, init?: RequestInit): Promise<Response>
  sleep(ms: number): Promise<void>
  warn(message: string): void
  // Whether a person can answer `ask` (stdin is a terminal).
  isTTY: boolean
  // Asks a yes/no question on stderr and reads the answer from stdin; anything but y/yes is no.
  ask(question: string): Promise<boolean>
  env: Env
  cwd: string
  home: string
}

export function systemIo(env: Env = process.env, cwd = process.cwd()): Io {
  return {
    env,
    cwd,
    home: env.HOME || homedir(),
    async run(cmd, opts = {}) {
      const proc = Bun.spawn(cmd, {
        cwd: opts.cwd ?? cwd,
        env: { ...env, ...opts.env },
        stdin: opts.stream ? 'inherit' : 'ignore',
        // stdout is reserved for graft's own result, so streamed output goes to fd 2.
        stdout: opts.stream ? 2 : 'pipe',
        stderr: opts.stream ? 'inherit' : 'pipe',
      })
      const [out, err, code] = await Promise.all([
        proc.stdout instanceof ReadableStream ? new Response(proc.stdout).text() : '',
        proc.stderr instanceof ReadableStream ? new Response(proc.stderr).text() : '',
        proc.exited,
      ])
      return { code, out, err }
    },
    exists: existsSync,
    readlink(path) {
      try {
        return readlinkSync(path)
      } catch {
        return null
      }
    },
    async readText(path) {
      const file = Bun.file(path)
      return (await file.exists()) ? file.text() : null
    },
    async writeText(path, data) {
      await Bun.write(path, data)
    },
    mode(path) {
      try {
        return statSync(path).mode & 0o777
      } catch {
        return null
      }
    },
    fetch: (url, init) => fetch(url, init),
    sleep: (ms) => Bun.sleep(ms),
    warn(message) {
      process.stderr.write(`graft: ${message}\n`)
    },
    isTTY: process.stdin.isTTY === true,
    async ask(question) {
      const rl = createInterface({ input: process.stdin, output: process.stderr })
      try {
        return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim())
      } finally {
        rl.close()
      }
    },
  }
}
