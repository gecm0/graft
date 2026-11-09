import { loadRepoConfig } from '../config.ts'
import { GraftError } from '../errors.ts'
import { findWorktree, hasInitializedSubmodules, isDirty, listWorktrees, pickRemote, recordedBase } from '../git.ts'
import { closeSpace, showing, spaces as herdrSpaces, working } from '../herdr.ts'
import { runHook, type HookResult } from '../hooks.ts'
import type { Io } from '../io.ts'
import { ownLinks, restoreLinks, unlinkLinks } from '../materialize.ts'
import { deleteBranch, isMerged, mergeTargets } from '../merged.ts'

export type RemoveOpts = { worktree: string; force: boolean; keepBranch: boolean; ignoreTeardown: boolean }

export type BranchOutcome = {
  name: string
  deleted: boolean
  // checked-out: another worktree has the same branch (worktree add --force allows it).
  reason?: 'not-merged' | 'preserved' | 'kept' | 'checked-out'
  head: string
}

export type RemoveResult = { removed: string; teardown: HookResult; branch: BranchOutcome | null }

export async function remove(io: Io, opts: RemoveOpts): Promise<RemoveResult> {
  const { ctx, wt } = await findWorktree(io, opts.worktree)
  const path = wt.path
  // Everything below runs in the main checkout: the worktree may be the cwd, and it goes away.
  const cwd = ctx.main

  if (wt.main) throw new GraftError('usage', `${path} is the main checkout`, 'pass a linked worktree')
  if (wt.locked) throw new GraftError('locked', `${path} is locked`, `unlock it first: git worktree unlock ${path}`)
  if (!io.exists(path)) throw new GraftError('not-found', `${path} no longer exists`, 'run: git worktree prune')
  // `git worktree remove` deletes the whole folder, so a worktree nested inside (gitignored) would go too.
  const others = (await listWorktrees(io, ctx)).filter((w) => w.path !== path)
  const nested = others.find((w) => w.path.startsWith(`${path}/`) && io.exists(w.path))
  if (nested) throw new GraftError('usage', `${nested.path} is a worktree inside ${path}`, `remove it first: graft remove ${nested.path}`)

  const cfg = await loadRepoConfig(io, ctx.main)
  if (!opts.force) {
    if (await isDirty(io, path, ownLinks(io, ctx.main, path, cfg.link))) {
      throw new GraftError('dirty', `${path} has modified or untracked files`, 'commit or stash them, or pass --force')
    }
    if (await hasInitializedSubmodules(io, path)) {
      throw new GraftError('dirty', `${path} has initialized submodules`, 'pass --force to remove it anyway')
    }
  }

  // Herdr spaces showing the worktree: closed after teardown; a working agent in one refuses.
  const spaces = showing(await herdrSpaces(io), path, others.map((w) => w.path))
  if (!opts.force && spaces.some(working)) {
    throw new GraftError('agent-working', `an agent is working in a Herdr space showing ${path}`, 'wait for it to finish, or pass --force')
  }

  // Teardown runs while the checkout still exists. A failure stops here, before anything is removed.
  const base = wt.branch ? await recordedBase(io, cwd, wt.branch) : null
  const teardown = await runHook(io, cfg.hooks.teardown, { main: ctx.main, worktree: path, branch: wt.branch ?? '', base })
  if (teardown.ran && teardown.exit !== 0) {
    if (!opts.ignoreTeardown && !opts.force) {
      throw new GraftError(
        'teardown-failed',
        `teardown exited ${teardown.exit} in ${path}; the worktree and branch were not touched`,
        'fix it and retry, or pass --ignore-teardown',
      )
    }
    io.warn(`teardown exited ${teardown.exit}, removing anyway`)
  }

  if (!opts.force && (await isDirty(io, path, ownLinks(io, ctx.main, path, cfg.link)) || await hasInitializedSubmodules(io, path))) {
    throw new GraftError('dirty', `${path} changed during teardown`, 'commit or stash changes, or pass --force')
  }

  // The space this graft runs in closes last: closing it ends graft, so everything else is done first.
  const self = io.env.HC_TERMINAL_ID
  const isOwn = (s: (typeof spaces)[number]) => !!self && s.tabs.some((t) => t.terminals.some((x) => x.address === self))
  io.warn(`removing ${path}`)
  // Untracked symlinks would make `git worktree remove` refuse; real files and other links stay.
  const unlinked = await unlinkLinks(io, ctx.main, path, cfg.link)
  try {
    const r = await io.run(['git', 'worktree', 'remove', ...(opts.force ? ['--force'] : []), path], { cwd })
    if (r.code !== 0) throw new GraftError('dirty', `git worktree remove failed: ${r.err.trim()}`, 'pass --force')
  } catch (e) {
    await restoreLinks(io, ctx.main, path, unlinked)
    throw e
  }
  // Keep spaces intact until git accepts the removal.
  for (const space of spaces.filter((s) => !isOwn(s))) await closeSpace(io, space)

  const shared = others.some((w) => w.branch === wt.branch)
  const branch = !wt.branch || !wt.head
    ? null
    : shared
      ? { name: wt.branch, deleted: false, reason: 'checked-out' as const, head: wt.head }
      : await settleBranch(io, cwd, wt.branch, wt.head, cfg.remote, opts.keepBranch)
  for (const space of spaces.filter(isOwn)) await closeSpace(io, space)
  return { removed: path, teardown, branch }
}

// Deletes the branch only when it is proven merged and nothing asked to keep it.
async function settleBranch(io: Io, cwd: string, name: string, head: string, remote: string | undefined, keep: boolean): Promise<BranchOutcome> {
  if (keep) return { name, deleted: false, reason: 'kept', head }
  const preserve = await io.run(['git', 'config', '--type=bool', '--get', `branch.${name}.graft-preserve`], { cwd })
  if (preserve.code !== 0 && preserve.code !== 1) io.warn(`could not read graft-preserve for ${name}; keeping the branch`)
  if ((preserve.code !== 0 && preserve.code !== 1) || preserve.out.trim() === 'true') return { name, deleted: false, reason: 'preserved', head }
  const targets = await mergeTargets(io, cwd, name, await pickRemote(io, cwd, remote), true)
  if (!(await isMerged(io, cwd, head, targets))) return { name, deleted: false, reason: 'not-merged', head }
  await deleteBranch(io, cwd, name, head)
  return { name, deleted: true, head }
}
