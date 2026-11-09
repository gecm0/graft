import { GraftError } from '../errors.ts'
import type { Io } from '../io.ts'
import { gh } from './gh.ts'
import { glab } from './glab.ts'
import { origin } from './origin.ts'

// One pull or merge request, the same shape whichever forge it comes from.
// ci: the head's checks rolled up; absent when there are none or the CLI doesn't say.
export type Pr = {
  number: number
  title: string
  url: string
  state: 'open' | 'draft' | 'merged' | 'closed'
  head: string
  base: string
  headSha: string
  fork: boolean
  mergedAt?: string
  ci?: 'success' | 'failure' | 'pending'
}

export type Forge = {
  name: 'gh' | 'glab' | 'origin'
  // ref: a number or a URL.
  view(ref: string): Promise<Pr>
  // The newest PR whose head is `branch`, in any state.
  forBranch(branch: string): Promise<Pr | null>
  // Open PRs, optionally matching a search query.
  search(query?: string): Promise<Pr[]>
  // The ref holding a fork PR's head on the base remote; null where PR heads are plain branches.
  pullRef(number: number): string | null
}

// Runs a forge CLI and parses its JSON stdout, turning failures into GraftErrors.
export async function cli(io: Io, cmd: string[]): Promise<any> {
  let r
  try {
    r = await io.run(cmd)
  } catch {
    throw new GraftError('unsupported', `${cmd[0]} is not installed`, `install the ${cmd[0]} CLI and log in`)
  }
  if (r.code !== 0) {
    const detail = (r.err.trim() || r.out.trim() || `exit ${r.code}`).split('\n').map((line) => line.trim()).filter(Boolean).join(' ').slice(0, 300)
    const message = `${cmd.slice(0, 3).join(' ')} failed: ${detail}`
    throw new GraftError(/not found|could not resolve|404/i.test(r.err + r.out) ? 'not-found' : 'network', message)
  }
  return JSON.parse(r.out)
}

// A PR given as a URL must belong to the remote's repository: the CLI would read the URL's PR,
// while graft fetches the head from the remote, which could be a different branch or PR.
export function checkPrUrl(ref: string, host: string, repo: string, prefix = ''): void {
  if (!/^https?:\/\//.test(ref)) return
  let u: URL
  try {
    u = new URL(ref)
  } catch {
    throw new GraftError('usage', `${ref} is not a valid URL`, 'pass a PR URL or its number')
  }
  if (u.hostname !== host || !u.pathname.toLowerCase().startsWith(`${prefix}/${repo.toLowerCase()}/`)) {
    throw new GraftError('usage', `${ref} is not a pull request of ${host}/${repo}`, 'pass a PR of this repository, or its number')
  }
}

// git@host:path, ssh://[user@]host[:port]/path, https://host/path -> {host, repo: "owner/name"}.
export function parseRemoteUrl(url: string): { host: string; repo: string } | null {
  const scp = url.match(/^[^/@:]+@([^:/]+):(.+)$/)
  let host: string
  let path: string
  if (scp) {
    host = scp[1]!.toLowerCase() // URL() lowercases the other forms
    path = scp[2]!
  } else {
    try {
      const u = new URL(url)
      host = u.hostname
      path = u.pathname
    } catch {
      return null
    }
  }
  const repo = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '')
  return host && repo.includes('/') ? { host, repo } : null
}

export function forgeFor(io: Io, remoteUrl: string): Forge {
  // ponytail: exact public hosts only; self-hosted GitHub Enterprise or GitLab would need a host map in config.
  // Looked up here, not at module load, because the adapters import this module.
  const hosts: Record<string, (io: Io, repo: string) => Forge> = { 'github.com': gh, 'gitlab.com': glab, 'origin.cursor.com': origin }
  const parsed = parseRemoteUrl(remoteUrl)
  const make = parsed && hosts[parsed.host]
  if (!parsed || !make) {
    throw new GraftError('unsupported', `no pull requests for remote ${remoteUrl.replace(/\/\/[^/@]*@/, '//')}`, 'graft knows GitHub (gh), GitLab (glab) and Cursor Origin (origin)')
  }
  return make(io, parsed.repo)
}

// The forge of the remote graft uses for this repository.
export async function forgeOf(io: Io, cwd: string, remote: string): Promise<Forge> {
  const r = await io.run(['git', 'remote', 'get-url', remote], { cwd })
  if (r.code !== 0) throw new GraftError('not-found', `no remote "${remote}"`, 'set remote in graft.toml')
  return forgeFor(io, r.out.trim())
}

// For status and list --pr: the PR of `branch`, or null without one, without a supported
// forge, or when the CLI fails (that one warns). Never throws.
// `detail` (status): glab and origin only report CI from view, so a PR without ci is viewed too.
export async function prOf(io: Io, cwd: string, remote: string, branch: string, detail = false): Promise<Pr | null> {
  let forge: Forge
  try {
    forge = await forgeOf(io, cwd, remote)
  } catch {
    return null
  }
  try {
    const pr = await forge.forBranch(branch)
    return detail && pr && pr.ci === undefined ? await forge.view(String(pr.number)) : pr
  } catch (e) {
    io.warn(`no PR state for ${branch}: ${(e as Error).message}`)
    return null
  }
}

// Check runs rolled up: any failed -> failure, any unfinished -> pending, else success.
export function rollup(runs: { done: boolean; failed: boolean }[]): Pr['ci'] {
  if (!runs.length) return undefined
  if (runs.some((r) => r.failed)) return 'failure'
  return runs.every((r) => r.done) ? 'success' : 'pending'
}

