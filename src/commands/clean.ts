import { resolve } from 'node:path'
import { loadRepoConfig } from '../config.ts'
import { GraftError } from '../errors.ts'
import { context, defaultBranch, fetchBranch, hasInitializedSubmodules, listWorktrees, pickRemote, splitRemoteRef, type WorktreeEntry } from '../git.ts'
import { showing, spaces as herdrSpaces } from '../herdr.ts'
import type { Io } from '../io.ts'
import { remove, type BranchOutcome } from './remove.ts'
import { worktreeFacts } from './status.ts'

// paths: only these worktrees are considered (the panel passes what the person confirmed).
export type CleanOpts = { dryRun: boolean; yes: boolean; paths?: string[] }

export type SkipReason = 'not-found' | 'locked' | 'prunable' | 'dirty' | 'submodules' | 'not-merged' | 'no-commits' | 'open-space' | 'changed'

export type CleanResult = {
  // True when nothing was removed on purpose: --dry-run, no TTY without --yes, or "no" at the prompt.
  dryRun: boolean
  candidates: { path: string; branch: string }[]
  removed: { path: string; branch: BranchOutcome | null }[]
  skipped: { path: string; branch: string | null; reason: SkipReason }[]
  failed: { path: string; branch: string; error: { kind: string; message: string; hint?: string } }[]
}

// graft clean [path…]: removes every clean, merged linked worktree (or only those of `paths` that are) through `remove`, deleting its branch.
export async function clean(io: Io, opts: CleanOpts): Promise<CleanResult> {
  const ctx = await context(io)
  const cwd = ctx.main
  const cfg = await loadRepoConfig(io, cwd)
  const remote = await pickRemote(io, cwd, cfg.remote)
  const registered = await listWorktrees(io, ctx)
  const paths = registered.map((w) => w.path)
  let entries = registered.filter((w) => !w.bare && !w.main)
  const result: CleanResult = { dryRun: true, candidates: [], removed: [], skipped: [], failed: [] }
  if (opts.paths) {
    // ponytail: paths compared after resolve(), not realpath; graft's own output is what gets passed back.
    const wanted = new Set(opts.paths.map((p) => resolve(io.cwd, p)))
    entries = entries.filter((w) => wanted.delete(w.path))
    for (const path of wanted) result.skipped.push({ path, branch: null, reason: 'not-found' })
  }

  await fetchTargets(io, cwd, remote, entries)

  // A worktree a Herdr space shows is in use; clean leaves it for `graft remove`.
  const spaces = await herdrSpaces(io)
  const heads = new Map(entries.map((w) => [w.path, w.head]))
  const skip = (w: WorktreeEntry, reason: SkipReason) => result.skipped.push({ path: w.path, branch: w.branch, reason })
  for (const w of entries) {
    if (w.locked) skip(w, 'locked')
    else if (w.prunable || !io.exists(w.path)) skip(w, 'prunable')
    else if (showing(spaces, w.path, paths).length) skip(w, 'open-space')
    else {
      // Merge targets were fetched once above; per worktree everything stays local.
      const facts = await worktreeFacts(io, cwd, w, remote, false, cfg.link)
      if (facts.dirty) skip(w, 'dirty')
      else if (!facts.merged || !w.branch) skip(w, 'not-merged')
      // remove refuses these without --force, so listing them would fail on every run.
      else if (await hasInitializedSubmodules(io, w.path)) skip(w, 'submodules')
      else if (await neverCommitted(io, cwd, w.branch)) skip(w, 'no-commits')
      else result.candidates.push({ path: w.path, branch: w.branch })
    }
  }
  // Deepest first, so a worktree nested inside another goes before its parent.
  result.candidates.sort((a, b) => b.path.split('/').length - a.path.split('/').length)

  if (opts.dryRun || !result.candidates.length || !(await confirmed(io, opts.yes, result.candidates))) return result

  result.dryRun = false
  for (const c of result.candidates) {
    try {
      const head = await io.run(['git', 'rev-parse', '--verify', 'HEAD'], { cwd: c.path })
      if (head.code !== 0 || head.out.trim() !== heads.get(c.path)) {
        result.skipped.push({ ...c, reason: 'changed' })
        continue
      }
      if (showing(await herdrSpaces(io), c.path, paths).length) {
        result.skipped.push({ ...c, reason: 'open-space' })
        continue
      }
      const r = await remove(io, { worktree: c.path, force: false, keepBranch: false, ignoreTeardown: false })
      result.removed.push({ path: c.path, branch: r.branch })
    } catch (e) {
      const error = e instanceof GraftError ? e.toJSON() : { kind: 'internal', message: (e as Error).message }
      io.warn(`could not remove ${c.path}: ${error.message}`)
      result.failed.push({ ...c, error })
    }
  }
  return result
}

// --yes goes ahead; a terminal is asked once for the whole list; anything else is a dry run.
async function confirmed(io: Io, yes: boolean, candidates: CleanResult['candidates']): Promise<boolean> {
  if (yes) return true
  if (!io.isTTY) {
    io.warn('not a terminal: nothing removed, pass --yes to remove them')
    return false
  }
  const list = candidates.map((c) => `  ${c.path} (${c.branch})`).join('\n')
  return io.ask(`${list}\nremove ${candidates.length} merged worktree${candidates.length === 1 ? '' : 's'} and their branches?`)
}

// Refreshes, once each, the remote's default branch and every remote base recorded by these worktrees,
// each base through its own remote. refs/remotes/<remote>/HEAD, which worktreeFacts checks against,
// follows the fresh default branch.
async function fetchTargets(io: Io, cwd: string, remote: string, entries: WorktreeEntry[]): Promise<void> {
  const prefix = `refs/remotes/${remote}/`
  const refs = new Set<string>()
  let main: string | undefined
  try {
    main = await defaultBranch(io, cwd, remote)
    refs.add(`${prefix}${main}`)
  } catch (e) {
    io.warn(`${(e as Error).message}; checking against recorded bases only`)
  }
  for (const w of entries) {
    if (!w.branch) continue
    const base = (await io.run(['git', 'config', '--get', `branch.${w.branch}.graft-base`], { cwd })).out.trim()
    if (base) refs.add(base)
  }
  for (const ref of refs) {
    const r = await splitRemoteRef(io, cwd, ref, remote)
    if (r) await fetchBranch(io, cwd, r.remote, r.branch)
  }
  // A repo made with `git init` + `remote add` has no <remote>/HEAD: defaultBranch asked the remote,
  // so record its answer, as clone does (a no-op when it is already there).
  if (main) await io.run(['git', 'symbolic-ref', `refs/remotes/${remote}/HEAD`, `${prefix}${main}`], { cwd })
}

// A fresh worktree's tip is its base, so it looks merged; clean must not tear it down.
// Repeated entries at the creation SHA (e.g. reset --hard HEAD) aren't new commits. A missing reflog
// can't tell, so it doesn't skip. Preserved branches existed before graft and aren't judged.
async function neverCommitted(io: Io, cwd: string, branch: string): Promise<boolean> {
  const preserve = await io.run(['git', 'config', '--type=bool', '--get', `branch.${branch}.graft-preserve`], { cwd })
  if ((preserve.code !== 0 && preserve.code !== 1) || preserve.out.trim() === 'true') return false
  const reflog = await io.run(['git', 'reflog', 'show', '--format=%H', `refs/heads/${branch}`], { cwd })
  const heads = reflog.out.split('\n').filter(Boolean)
  return reflog.code === 0 && heads.length > 0 && heads.every((head) => head === heads[0])
}
