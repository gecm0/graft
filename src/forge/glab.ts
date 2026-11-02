import type { Io } from '../io.ts'
import { checkPrUrl, cli, type Forge, type Pr } from './forge.ts'

// GitLab pipeline statuses; anything else (running, pending, created, manual, …) is still pending.
const pipeline: Record<string, Pr['ci']> = { success: 'success', skipped: 'success', failed: 'failure', canceled: 'failure' }

// `glab mr view|list -F json` -> Pr. head_pipeline is only filled by view.
export function fromGlab(j: any): Pr {
  return {
    number: j.iid,
    title: j.title,
    url: j.web_url,
    // "locked" is a merge in progress.
    state: j.state === 'merged' ? 'merged' : j.state === 'closed' ? 'closed' : j.draft ? 'draft' : 'open',
    head: j.source_branch,
    base: j.target_branch,
    headSha: j.sha,
    fork: j.source_project_id !== j.target_project_id,
    mergedAt: j.merged_at ?? undefined,
    ci: j.head_pipeline ? (pipeline[j.head_pipeline.status] ?? 'pending') : undefined,
  }
}

export function glab(io: Io, repo: string): Forge {
  const list = async (args: string[]) => ((await cli(io, ['glab', 'mr', 'list', '-R', repo, '-F', 'json', ...args])) as any[]).map(fromGlab)
  return {
    name: 'glab',
    // glab takes an id or a branch, not a URL.
    view: async (ref) => {
      checkPrUrl(ref, 'gitlab.com', repo)
      return fromGlab(await cli(io, ['glab', 'mr', 'view', ref.match(/\/merge_requests\/(\d+)/)?.[1] ?? ref, '-R', repo, '-F', 'json']))
    },
    forBranch: async (branch) => (await list(['--source-branch', branch, '--all', '-P', '1']))[0] ?? null,
    search: (query) => list(query ? ['--search', query] : []),
    pullRef: (n) => `refs/merge-requests/${n}/head`,
  }
}
