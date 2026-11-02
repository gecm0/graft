import type { Io } from '../io.ts'
import { checkPrUrl, cli, rollup, type Forge, type Pr } from './forge.ts'

const fields = 'number,title,url,state,isDraft,headRefName,baseRefName,headRefOid,isCrossRepository,mergedAt,statusCheckRollup'

// statusCheckRollup holds CheckRuns (status, conclusion) and StatusContexts (state).
const failed = ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']

// `gh pr view|list --json <fields>` -> Pr.
export function fromGh(j: any): Pr {
  const checks: any[] = j.statusCheckRollup ?? []
  return {
    number: j.number,
    title: j.title,
    url: j.url,
    state: j.state === 'MERGED' ? 'merged' : j.state === 'CLOSED' ? 'closed' : j.isDraft ? 'draft' : 'open',
    head: j.headRefName,
    base: j.baseRefName,
    headSha: j.headRefOid,
    fork: j.isCrossRepository,
    mergedAt: j.mergedAt ?? undefined,
    ci: rollup(checks.map((c) => {
      const result = c.conclusion ?? c.state
      return { done: c.status ? c.status === 'COMPLETED' : !['PENDING', 'EXPECTED'].includes(result), failed: failed.includes(result) }
    })),
  }
}

export function gh(io: Io, repo: string): Forge {
  const list = async (args: string[]) => ((await cli(io, ['gh', 'pr', 'list', '-R', repo, '--json', fields, ...args])) as any[]).map(fromGh)
  return {
    name: 'gh',
    view: async (ref) => {
      checkPrUrl(ref, 'github.com', repo)
      return fromGh(await cli(io, ['gh', 'pr', 'view', ref, '-R', repo, '--json', fields]))
    },
    forBranch: async (branch) => (await list(['--head', branch, '--state', 'all', '-L', '1']))[0] ?? null,
    search: (query) => list(query ? ['--search', query] : []),
    pullRef: (n) => `refs/pull/${n}/head`,
  }
}
