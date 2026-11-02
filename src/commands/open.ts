import { GraftError } from '../errors.ts'
import { findWorktree, listWorktrees } from '../git.ts'
import { ensureMainSpace, herdrDo, requireHerdr, showing } from '../herdr.ts'
import type { Io } from '../io.ts'

export type OpenResult = { worktree: string; space: string; created: boolean }

// graft open <wt> [--open herdr]: show the Herdr space showing the worktree, or make one.
export async function open(io: Io, name: string, target = 'herdr'): Promise<OpenResult> {
  if (target !== 'herdr') throw new GraftError('unsupported', `cannot open in "${target}"`, 'the only target is: --open herdr')
  const { ctx, wt } = await findWorktree(io, name)
  if (!io.exists(wt.path)) throw new GraftError('not-found', `${wt.path} no longer exists`, 'run: git worktree prune')
  const all = await requireHerdr(io)
  const worktrees = (await listWorktrees(io, ctx)).map((w) => w.path)
  const space = showing(all, wt.path, worktrees)[0]
  if (space) {
    await herdrDo(io, 'space.select', { id: space.id })
    return { worktree: wt.path, space: space.id, created: false }
  }
  if (!wt.main) await ensureMainSpace(io, all, ctx.main, worktrees)
  const made = await herdrDo(io, 'space.new', { folder: wt.path })
  return { worktree: wt.path, space: made.space, created: true }
}
