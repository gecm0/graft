import { resolve } from 'node:path'
import { loadRepoConfig } from '../config.ts'
import { GraftError } from '../errors.ts'
import { context, currentBranch, recordedBase } from '../git.ts'
import { setupMarker } from '../herdr.ts'
import { runHook, type HookResult } from '../hooks.ts'
import type { Io } from '../io.ts'
import { materialize, type Files } from '../materialize.ts'

export type SetupResult = { worktree: string; files: Files | null; setup: HookResult }
export type TeardownResult = { worktree: string; teardown: HookResult }

// graft setup [path] / graft teardown [path]: run one of the repo's hooks in an existing checkout.
// Setup first brings back missing links and copies (the "`.env` is missing" case), in linked worktrees only.
async function runWorktreeHook(io: Io, name: 'setup' | 'teardown', path?: string): Promise<{ worktree: string; files: Files | null; result: HookResult }> {
  const dir = path ? resolve(io.cwd, path) : io.cwd
  if (!io.exists(dir)) throw new GraftError('not-found', `${dir} does not exist`)
  const ctx = await context(io, dir)
  const cfg = await loadRepoConfig(io, ctx.main)
  const branch = (await currentBranch(io, ctx.root)) ?? ''
  const base = branch ? await recordedBase(io, ctx.root, branch) : null
  const files = name === 'setup' && ctx.linked ? await materialize(io, ctx.main, ctx.root, cfg.link) : null
  const result = await runHook(io, cfg.hooks[name], { main: ctx.main, worktree: ctx.root, branch, base })
  if (!result.ran) io.warn(`no ${name} hook configured`)
  if (result.ran && result.exit !== 0) throw new GraftError(`${name}-failed`, `${name} exited ${result.exit} in ${ctx.root}`)
  return { worktree: ctx.root, files, result }
}

// report: write "ok" or "failed" to the setup marker, for `graft agent --wait-setup` (the Herdr setup tab).
export async function setup(io: Io, path?: string, report = false): Promise<SetupResult> {
  const dir = path ? resolve(io.cwd, path) : io.cwd
  // A waiter started during this run must not read the previous run's outcome.
  if (report) await setupMarker(io, dir).then((m) => io.run(['rm', '-f', '--', m])).catch(() => {})
  try {
    const { worktree, files, result } = await runWorktreeHook(io, 'setup', path)
    if (report) await io.writeText(await setupMarker(io, worktree), 'ok')
    return { worktree, files, setup: result }
  } catch (e) {
    // Best effort: outside a checkout there is no marker to write, and the waiter times out.
    if (report) await setupMarker(io, dir).then((m) => io.writeText(m, 'failed')).catch(() => {})
    throw e
  }
}

export async function teardown(io: Io, path?: string): Promise<TeardownResult> {
  const { worktree, result } = await runWorktreeHook(io, 'teardown', path)
  return { worktree, teardown: result }
}
