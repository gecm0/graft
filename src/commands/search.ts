import { loadRepoConfig } from '../config.ts'
import { GraftError } from '../errors.ts'
import { forgeOf, type Pr } from '../forge/forge.ts'
import { context, pickRemote, searchBranches, type BranchHit } from '../git.ts'
import type { Io } from '../io.ts'
import { jira, type JiraIssue } from '../jira.ts'
import { linear, type Issue } from '../linear.ts'

export type SearchResult = { kind: 'branches'; hits: BranchHit[] } | { kind: 'prs'; hits: Pr[] } | { kind: 'linear'; hits: Issue[] } | { kind: 'jira'; hits: JiraIssue[] }

// graft search <kind> [query]: feeds pickers and agents.
export async function search(io: Io, kind: string | undefined, query?: string): Promise<SearchResult> {
  if (kind !== 'branches' && kind !== 'prs' && kind !== 'linear' && kind !== 'jira') throw new GraftError('usage', `unknown search "${kind ?? ''}"`, 'graft search branches|prs|linear|jira [query]')
  // Tickets need no repository.
  if (kind === 'linear') return { kind, hits: await (await linear(io)).search(query) }
  if (kind === 'jira') return { kind, hits: await (await jira(io)).search(query) }
  const ctx = await context(io)
  const cfg = await loadRepoConfig(io, ctx.main)
  // ctx.root, like create: its results are passed to create --remote / --pr.
  const remote = await pickRemote(io, ctx.root, cfg.remote)
  if (kind === 'prs') return { kind, hits: await (await forgeOf(io, ctx.root, remote)).search(query) }
  return { kind, hits: await searchBranches(io, ctx.main, remote, query) }
}
