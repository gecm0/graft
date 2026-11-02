import { realpathSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { GraftError } from './errors.ts'
import type { Io } from './io.ts'

export type Ctx = { root: string; common: string; gitdir: string; main: string; linked: boolean }

export type WorktreeEntry = {
  path: string
  head: string | null
  branch: string | null // short name, null when detached or bare
  main: boolean
  bare: boolean
  locked: boolean
  prunable: boolean
}

export type Base = { name: string; ref: string } // "origin/main", "refs/remotes/origin/main"

// Runs git and returns trimmed stdout; any non-zero exit throws with git's stderr.
export async function git(io: Io, cwd: string, args: string[]): Promise<string> {
  const r = await io.run(['git', ...args], { cwd })
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.err.trim() || `exit ${r.code}`}`)
  return r.out.trim()
}

async function ok(io: Io, cwd: string, args: string[]): Promise<boolean> {
  return (await io.run(['git', ...args], { cwd })).code === 0
}

export function refExists(io: Io, cwd: string, ref: string): Promise<boolean> {
  return ok(io, cwd, ['show-ref', '--verify', '--quiet', ref])
}

export async function context(io: Io, cwd = io.cwd): Promise<Ctx> {
  const r = await io.run(
    ['git', 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir', '--git-dir'],
    { cwd },
  )
  const [root, common, gitdir] = r.out.trim().split('\n')
  if (r.code !== 0 || !root || !common || !gitdir) {
    throw new GraftError('not-a-repo', `${cwd} is not inside a git checkout`, 'run graft inside a checkout of the repository')
  }
  const main = parseWorktreeList(await git(io, root, ['worktree', 'list', '--porcelain']))[0]?.path ?? root
  return { root, common, gitdir, main, linked: common !== `${root}/.git` }
}

export async function listWorktrees(io: Io, ctx: Ctx): Promise<WorktreeEntry[]> {
  return parseWorktreeList(await git(io, ctx.root, ['worktree', 'list', '--porcelain']))
}

// A worktree named by path, branch or folder name; no name means the current checkout.
// A path outside the cwd's repository is looked up in its own repository.
export async function findWorktree(io: Io, name?: string): Promise<{ ctx: Ctx; wt: WorktreeEntry }> {
  const path = name === undefined ? undefined : canonical(resolve(io.cwd, name))
  const ctx = await context(io, path && io.exists(path) ? path : io.cwd)
  const entries = (await listWorktrees(io, ctx)).filter((w) => !w.bare)
  const wt =
    entries.find((w) => w.path === (path ?? ctx.root)) ??
    // A branch name wins over a folder name: feature-foo may be the folder of branch feature/foo.
    (name ? entries.find((w) => w.branch === name) ?? entries.find((w) => basename(w.path) === name) : undefined)
  if (!wt) throw new GraftError('not-found', `no worktree "${name ?? ctx.root}" in ${ctx.main}`, 'run graft list')
  return { ctx, wt }
}

// Git lists worktrees by their real path (/private/tmp, not /tmp on macOS).
function canonical(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

// `git worktree list --porcelain`: blank-line separated blocks, main checkout first.
export function parseWorktreeList(text: string): WorktreeEntry[] {
  return text
    .split(/\n\s*\n/)
    .map((block) => block.split('\n').filter(Boolean))
    .filter((lines) => lines[0]?.startsWith('worktree '))
    .map((lines, i) => {
      const field = (name: string) => lines.find((l) => l === name || l.startsWith(`${name} `))
      const value = (name: string) => field(name)?.slice(name.length + 1) ?? null
      const branch = value('branch')
      return {
        path: value('worktree')!,
        head: value('HEAD'),
        branch: branch?.replace(/^refs\/heads\//, '') ?? null,
        main: i === 0,
        bare: field('bare') !== undefined,
        locked: field('locked') !== undefined,
        prunable: field('prunable') !== undefined,
      }
    })
}

// cfg.remote ?? current branch's upstream remote ?? the only remote ?? "origin".
export async function pickRemote(io: Io, cwd: string, configured?: string): Promise<string> {
  if (configured) return configured
  const branch = (await io.run(['git', 'symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd })).out.trim()
  if (branch) {
    const upstream = (await io.run(['git', 'config', '--get', `branch.${branch}.remote`], { cwd })).out.trim()
    if (upstream && upstream !== '.') return upstream
  }
  const remotes = (await io.run(['git', 'remote'], { cwd })).out.split('\n').filter(Boolean)
  return remotes.length === 1 ? remotes[0]! : 'origin'
}

// The remote's default branch: refs/remotes/<remote>/HEAD, else ask the remote.
export async function defaultBranch(io: Io, cwd: string, remote: string): Promise<string> {
  const local = await io.run(['git', 'symbolic-ref', '--quiet', `refs/remotes/${remote}/HEAD`], { cwd })
  const prefix = `refs/remotes/${remote}/`
  if (local.code === 0 && local.out.trim().startsWith(prefix)) return local.out.trim().slice(prefix.length)
  const remoteHead = await io.run(['git', 'ls-remote', '--symref', remote, 'HEAD'], { cwd })
  const match = remoteHead.out.match(/^ref: refs\/heads\/(\S+)\s+HEAD/m)
  if (remoteHead.code === 0 && match) return match[1]!
  throw new GraftError('not-found', `cannot tell the default branch of remote "${remote}"`, 'pass --base <branch>')
}

// base = --base ?? remote default; fetch it; prefer <remote>/<base>, else local <base>.
export async function resolveBase(io: Io, cwd: string, remote: string, requested?: string): Promise<Base> {
  // refs/heads/<b> asks for the local branch even when <remote>/<b> exists (the picker's "local" row).
  if (requested?.startsWith('refs/heads/')) {
    if (await refExists(io, cwd, requested)) return { name: requested.slice('refs/heads/'.length), ref: requested }
    throw new GraftError('not-found', `base branch "${requested}" does not exist`)
  }
  const base = requested ?? (await defaultBranch(io, cwd, remote))
  await fetchBranch(io, cwd, remote, base)
  const remoteRef = `refs/remotes/${remote}/${base}`
  if (await refExists(io, cwd, remoteRef)) return { name: `${remote}/${base}`, ref: remoteRef }
  const localRef = `refs/heads/${base}`
  if (await refExists(io, cwd, localRef)) return { name: base, ref: localRef }
  throw new GraftError('not-found', `base branch "${base}" exists neither on ${remote} nor locally`)
}

// "refs/remotes/upstream/main" -> upstream + main, by the longest remote name that prefixes it
// (names may hold "/"). `known` counts even when `git remote` doesn't list it. null for other refs.
export async function splitRemoteRef(io: Io, cwd: string, ref: string, known: string): Promise<{ remote: string; branch: string } | null> {
  const remotes = [known, ...(await io.run(['git', 'remote'], { cwd })).out.split('\n').filter(Boolean)]
  const remote = remotes.filter((r) => ref.startsWith(`refs/remotes/${r}/`)).sort((a, b) => b.length - a.length)[0]
  return remote ? { remote, branch: ref.slice(`refs/remotes/${remote}/`.length) } : null
}

// Updates refs/remotes/<remote>/<branch> only; a failure warns and leaves local refs as they are.
export async function fetchBranch(io: Io, cwd: string, remote: string, branch: string): Promise<void> {
  const fetch = await io.run(
    ['git', 'fetch', '--no-tags', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`],
    { cwd },
  )
  if (fetch.code !== 0) io.warn(`could not fetch ${branch} from ${remote}, using local refs: ${fetch.err.trim()}`)
}

// Names are used as written, so they must already be valid.
export async function checkBranchName(io: Io, cwd: string, branch: string): Promise<void> {
  const r = await io.run(['git', 'check-ref-format', '--branch', branch], { cwd })
  if (r.code !== 0 || r.out.trim() !== branch) {
    throw new GraftError('usage', `"${branch}" is not a valid branch name`)
  }
}

// A new branch must be a valid name that doesn't exist yet.
export async function checkNewBranch(io: Io, cwd: string, branch: string): Promise<void> {
  await checkBranchName(io, cwd, branch)
  if (await refExists(io, cwd, `refs/heads/${branch}`)) {
    throw new GraftError('exists', `branch "${branch}" already exists`, `pick another name, or check it out: graft create --remote ${branch}`)
  }
}

export async function addWorktree(io: Io, cwd: string, opts: { branch: string; path: string; base: Base }) {
  await git(io, cwd, ['worktree', 'add', '--no-track', '-b', opts.branch, opts.path, opts.base.ref])
  await git(io, cwd, ['config', `branch.${opts.branch}.graft-base`, opts.base.ref])
}

// An existing branch: the local one as it is, else a new one tracking <remote>/<branch>.
// It isn't graft's to delete, so it is marked graft-preserve.
export async function addExistingWorktree(io: Io, cwd: string, opts: { branch: string; path: string; remote: string }) {
  if (await refExists(io, cwd, `refs/heads/${opts.branch}`)) {
    await git(io, cwd, ['worktree', 'add', opts.path, opts.branch])
  } else {
    // Upstream set by hand: --track infers it from remote.<name>.fetch, which a --single-branch
    // clone limits to one branch, so it would fail for any other.
    await git(io, cwd, ['worktree', 'add', '--no-track', '-b', opts.branch, opts.path, `refs/remotes/${opts.remote}/${opts.branch}`])
    await git(io, cwd, ['config', `branch.${opts.branch}.remote`, opts.remote])
    await git(io, cwd, ['config', `branch.${opts.branch}.merge`, `refs/heads/${opts.branch}`])
  }
  await git(io, cwd, ['config', `branch.${opts.branch}.graft-preserve`, 'true'])
}

export type BranchHit = { name: string; where: 'local' | 'remote'; ref: string; date: string }

// Local branches and <remote>'s branches, newest commit first; a branch on both shows twice.
// Case-insensitive substring match on the name. Local refs only, no fetch.
export async function searchBranches(io: Io, cwd: string, remote: string, query = ''): Promise<BranchHit[]> {
  const prefix = `refs/remotes/${remote}/`
  const out = await git(io, cwd, [
    'for-each-ref', '--sort=-committerdate', '--format=%(refname)%00%(committerdate:iso-strict)%00%(symref)',
    'refs/heads', `refs/remotes/${remote}`,
  ])
  const q = query.toLowerCase()
  return out.split('\n').flatMap((line) => {
    const [ref = '', date = '', symref] = line.split('\0')
    if (!ref || symref) return [] // refs/remotes/<remote>/HEAD
    const where = ref.startsWith('refs/heads/') ? 'local' : 'remote'
    const name = ref.slice(where === 'local' ? 'refs/heads/'.length : prefix.length)
    return name.toLowerCase().includes(q) ? [{ name, where, ref, date }] : []
  })
}

export async function currentBranch(io: Io, cwd: string): Promise<string | null> {
  return (await io.run(['git', 'symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd })).out.trim() || null
}

// The base recorded at create time, as a short name ("origin/main"), or null.
export async function recordedBase(io: Io, cwd: string, branch: string): Promise<string | null> {
  const ref = (await io.run(['git', 'config', '--get', `branch.${branch}.graft-base`], { cwd })).out.trim()
  return ref ? shortRef(ref) : null
}

export function shortRef(ref: string): string {
  return ref.replace(/^refs\/(heads|remotes)\//, '')
}

// Modified or untracked files, including inside submodules. `ignore` lists paths whose
// untracked entry doesn't count (graft's own symlinks).
export async function isDirty(io: Io, wt: string, ignore: string[] = []): Promise<boolean> {
  const out = await git(io, wt, ['status', '--porcelain', '-z', '--untracked-files=all', '--ignore-submodules=none'])
  return out.split('\0').some((entry) => entry && !(entry.startsWith('?? ') && ignore.includes(entry.slice(3))))
}

// `git worktree remove` refuses these even when clean; uninitialized ones start with "-".
export async function hasInitializedSubmodules(io: Io, wt: string): Promise<boolean> {
  const r = await io.run(['git', 'submodule', 'status'], { cwd: wt })
  return r.code === 0 && r.out.split('\n').some((l) => l && !l.startsWith('-'))
}

// A --single-branch clone's fetch refspec only maps its one branch, so git can't resolve
// @{upstream} for a branch graft checked out with --remote; branch.<b>.remote/merge then name it.
// Read-only on purpose: an exact refspec added for the branch would fail every fetch once it is deleted.
export async function upstreamOf(io: Io, cwd: string, branch: string): Promise<string | null> {
  const r = await io.run(['git', 'rev-parse', '--abbrev-ref', `${branch}@{upstream}`], { cwd })
  if (r.code === 0) return r.out.trim() || null
  const get = async (key: string) => (await io.run(['git', 'config', '--get', `branch.${branch}.${key}`], { cwd })).out.trim()
  const remote = await get('remote')
  const merge = await get('merge')
  if (!remote || remote === '.' || !merge.startsWith('refs/heads/')) return null
  const name = `${remote}/${merge.slice('refs/heads/'.length)}`
  return (await refExists(io, cwd, `refs/remotes/${name}`)) ? name : null
}

// Commits on `tip` not in `against` (ahead), and the reverse (behind).
// null counts when git can't compare (e.g. the recorded base was deleted), not a fake 0/0.
export async function aheadBehind(io: Io, cwd: string, tip: string, against: string): Promise<{ ahead: number | null; behind: number | null }> {
  const r = await io.run(['git', 'rev-list', '--left-right', '--count', `${against}...${tip}`], { cwd })
  if (r.code !== 0) return { ahead: null, behind: null }
  const [behind, ahead] = r.out.trim().split(/\s+/).map((n) => Number.parseInt(n, 10) || 0)
  return { ahead: ahead ?? 0, behind: behind ?? 0 }
}
