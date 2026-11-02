import { loadUserConfig, secret, type UserConfig } from './config.ts'
import { GraftError } from './errors.ts'
import type { Io } from './io.ts'

// One Linear issue. identifier is the key ("ABC-123"); branchName is Linear's suggested branch
// name ({linear} in branch templates); state is the workflow state's name ("In Progress").
export type Issue = { identifier: string; title: string; url: string; branchName: string; state: string }

const endpoint = 'https://api.linear.app/graphql'
const fields = 'identifier title url branchName state { name }'

// Personal API keys go in Authorization as they are, with no "Bearer".
async function gql(io: Io, key: string, query: string, variables: Record<string, unknown> = {}): Promise<any> {
  let res: Response
  let body: any
  try {
    res = await io.fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: key },
      body: JSON.stringify({ query, variables }),
    })
  } catch (e) {
    throw new GraftError('network', `could not reach Linear: ${(e as Error).message}`)
  }
  try {
    body = await res.json()
  } catch {
    throw new GraftError('network', `Linear answered HTTP ${res.status} without JSON`)
  }
  const err = body?.errors?.[0]
  if (err) {
    const message: string = err.extensions?.userPresentableMessage ?? err.message ?? 'unknown error'
    if (/not found|could not find/i.test(`${err.message} ${message}`)) throw new GraftError('not-found', `Linear: ${message}`)
    const auth = res.status === 401 || /authenticat/i.test(`${err.extensions?.code} ${err.message}`)
    throw new GraftError('network', `Linear: ${message}`, auth ? 'check LINEAR_API_KEY or [linear] api_key' : undefined)
  }
  if (!res.ok || !body?.data) throw new GraftError('network', `Linear answered HTTP ${res.status}`)
  return body.data
}

function toIssue(n: any): Issue {
  return { identifier: n.identifier, title: n.title, url: n.url, branchName: n.branchName, state: n.state?.name ?? '' }
}

export type Linear = { issue(id: string): Promise<Issue>; search(query?: string): Promise<Issue[]> }

export async function linear(io: Io, user?: UserConfig): Promise<Linear> {
  user ??= await loadUserConfig(io)
  const key = secret(io, 'LINEAR_API_KEY', user.linear?.api_key, '[linear] api_key')
  return {
    // id: the key ("ABC-123") or the issue's UUID.
    async issue(id) {
      return toIssue((await gql(io, key, `query($id: String!) { issue(id: $id) { ${fields} } }`, { id })).issue)
    },
    // With a query: Linear's full-text search over every issue. Without: my assigned open issues.
    // ponytail: first 50 only, no paging; add pageInfo/after if a picker needs more.
    async search(query) {
      if (query?.trim()) {
        const data = await gql(io, key, `query($term: String!) { searchIssues(term: $term, first: 50) { nodes { ${fields} } } }`, { term: query })
        return data.searchIssues.nodes.map(toIssue)
      }
      const open = '{ state: { type: { nin: ["completed", "canceled"] } } }'
      const data = await gql(io, key, `query { viewer { assignedIssues(first: 50, orderBy: updatedAt, filter: ${open}) { nodes { ${fields} } } } }`)
      return data.viewer.assignedIssues.nodes.map(toIssue)
    },
  }
}
