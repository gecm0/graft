import { loadRepoConfig } from '../config.ts'
import { aheadBehind, findWorktree, isDirty, listWorktrees, pickRemote, recordedBase, upstreamOf, type WorktreeEntry } from '../git.ts'
import { prOf, type Pr } from '../forge/forge.ts'
import { showing, spaces } from '../herdr.ts'
import type { Io } from '../io.ts'
import { ownLinks } from '../materialize.ts'
import { isMerged, mergeTargets } from '../merged.ts'

export type Facts = { dirty: boolean; ahead: number | null; behind: number | null; merged: boolean }

// space: the Herdr space showing the worktree, null without one (or without Herdr).
// pr: the newest PR of the branch on the remote's forge, null without one (see prOf).
export type StatusResult = {
  path: string; branch: string | null; base: string | null; upstream: string | null
  space: { id: string; tabs: { id: string; name: string }[] } | null; pr: Pr | null
} & Facts

// dirty, ahead/behind (against the upstream, else the recorded base) and merged, for one worktree.
// `fetch` refreshes the merge targets first; list passes false to stay fast and offline.
// `cwd` is the main checkout; graft's symlinks from `links` don't count as dirty.
export async function worktreeFacts(io: Io, cwd: string, wt: WorktreeEntry, remote: string, fetch: boolean, links: string[]): Promise<Facts & { upstream: string | null }> {
  // A prunable entry has no checkout to run git in, even when its folder is still there.
  const dirty = !wt.prunable && io.exists(wt.path) ? await isDirty(io, wt.path, ownLinks(io, cwd, wt.path, links)) : false
  if (!wt.branch || !wt.head) return { dirty, ahead: null, behind: null, merged: false, upstream: null }
  const targets = wt.main ? [] : await mergeTargets(io, cwd, wt.branch, remote, fetch)
  // The main checkout's branch is never a removal candidate, so it is never reported merged.
  const merged = wt.main ? false : await isMerged(io, cwd, wt.head, targets)
  const upstream = await upstreamOf(io, cwd, wt.branch)
  const against = upstream ?? (await io.run(['git', 'config', '--get', `branch.${wt.branch}.graft-base`], { cwd })).out.trim()
  const counts = against ? await aheadBehind(io, cwd, wt.head, against) : { ahead: null, behind: null }
  return { dirty, ...counts, merged, upstream }
}

// The main checkout's branch and detached worktrees have no PR of their own.
export function worktreePr(io: Io, cwd: string, wt: WorktreeEntry, remote: string, detail = false): Promise<Pr | null> {
  return wt.main || !wt.branch ? Promise.resolve(null) : prOf(io, cwd, remote, wt.branch, detail)
}

// graft status [wt]: one worktree's facts, after fetching its merge targets.
export async function status(io: Io, name?: string): Promise<StatusResult> {
  const { ctx, wt } = await findWorktree(io, name)
  const cfg = await loadRepoConfig(io, ctx.main)
  const remote = await pickRemote(io, ctx.main, cfg.remote)
  const { upstream, ...facts } = await worktreeFacts(io, ctx.main, wt, remote, true, cfg.link)
  const base = wt.branch ? await recordedBase(io, ctx.main, wt.branch) : null
  const worktrees = (await listWorktrees(io, ctx)).map((w) => w.path)
  const space = showing(await spaces(io), wt.path, worktrees)[0]
  const herdr = space ? { id: space.id, tabs: space.tabs.map(({ id, name }) => ({ id, name })) } : null
  const pr = await worktreePr(io, ctx.main, wt, remote, true)
  return { path: wt.path, branch: wt.branch, base, upstream, ...facts, space: herdr, pr }
}
