import { basename } from 'node:path'
import type { Io } from './io.ts'

export type HookCtx = {
  main: string // main checkout
  worktree: string
  branch: string
  base: string | null
}

export type HookResult = { ran: boolean; exit: number | null }

// Runs a hook script with bash -e (stop at the first failing line), cwd = the worktree.
// Its output streams to stderr so stdout stays free for graft's own result.
export async function runHook(io: Io, script: string | undefined, ctx: HookCtx): Promise<HookResult> {
  if (!script?.trim()) return { ran: false, exit: null }
  const r = await io.run(['bash', '-e', '-c', script], {
    cwd: ctx.worktree,
    stream: true,
    env: {
      GRAFT_ROOT: ctx.main,
      GRAFT_WORKTREE: ctx.worktree,
      GRAFT_BRANCH: ctx.branch,
      GRAFT_NAME: basename(ctx.worktree),
      GRAFT_BASE: ctx.base ?? '',
    },
  })
  return { ran: true, exit: r.code }
}
