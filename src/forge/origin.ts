import type { Io } from '../io.ts'
import { checkPrUrl, cli, rollup, type Forge, type Pr } from './forge.ts'

// ciState is only offered by `origin pr view`.
const fields = 'number,title,url,status,isDraft,headRef,baseRef,headSha,mergedAt'

// Check run conclusions that fail; status is queued | in_progress | completed | rerequested | failing.
const failed = ['failure', 'timed_out', 'cancelled', 'action_required']

// `origin pr view|list --json <fields>` -> Pr. Origin has no fork PRs: heads are branches of the repo.
export function fromOrigin(j: any): Pr {
  const runs: any[] = (j.ciState?.checkRunGroups ?? []).flatMap((g: any) => g.checkRuns ?? [])
  return {
    number: j.number,
    title: j.title,
    url: j.url,
    state: ['draft', 'merged', 'closed'].includes(j.status) ? j.status : 'open',
    head: j.headRef,
    base: j.baseRef,
    headSha: j.headSha,
    fork: false,
    mergedAt: j.mergedAt ?? undefined,
    ci: rollup(runs.map((r) => ({ done: r.status === 'completed', failed: r.status === 'failing' || failed.includes(r.conclusion) }))),
  }
}

export function origin(io: Io, repo: string): Forge {
  const list = async (args: string[]) => ((await cli(io, ['origin', 'pr', 'list', '-R', repo, '--json', fields, ...args])) as any[]).map(fromOrigin)
  return {
    name: 'origin',
    view: async (ref) => {
      checkPrUrl(ref, 'cursor.com', repo, '/codebase')
      return fromOrigin(await cli(io, ['origin', 'pr', 'view', ref, '-R', repo, '--json', `${fields},ciState`]))
    },
    forBranch: async (branch) => (await list(['--head', branch, '--state', 'all', '-L', '1']))[0] ?? null,
    search: (query) => list(query ? ['--search', query] : []),
    pullRef: () => null,
  }
}
