import { loadUserConfig, secret, userConfigPath, type UserConfig } from './config.ts'
import { GraftError } from './errors.ts'
import type { Io } from './io.ts'

// One Jira issue. key is "ABC-123"; url is the issue's page on the site; status is its workflow
// status's name ("In Progress"). Jira has no branch-name field.
export type JiraIssue = { key: string; summary: string; url: string; status: string }

export type Jira = { issue(key: string): Promise<JiraIssue>; search(query?: string): Promise<JiraIssue[]> }

const fields = ['summary', 'status']
const authHint = 'check JIRA_EMAIL and JIRA_API_TOKEN, or [jira] email and api_token'

function setting(io: Io, env: string, fromFile: string | undefined, key: string): string {
  const v = io.env[env]?.trim() || fromFile?.trim()
  if (!v) throw new GraftError('usage', `no ${key}`, `set ${env}, or ${key} in ${userConfigPath(io)}`)
  return v
}

// JQL string literal: backslashes and double quotes escaped.
const quote = (s: string) => `"${s.replace(/[\\"]/g, '\\$&')}"`

// Jira Cloud's REST API v3 with Basic email:api_token.
export async function jira(io: Io, user?: UserConfig): Promise<Jira> {
  user ??= await loadUserConfig(io)
  // "acme.atlassian.net" or "https://acme.atlassian.net/" both work.
  const site = setting(io, 'JIRA_SITE', user.jira?.site, '[jira] site').replace(/^https?:\/\//, '').replace(/\/+$/, '')
  const email = setting(io, 'JIRA_EMAIL', user.jira?.email, '[jira] email')
  const token = secret(io, 'JIRA_API_TOKEN', user.jira?.api_token, '[jira] api_token')
  const headers = { Authorization: `Basic ${btoa(`${email}:${token}`)}`, Accept: 'application/json', 'Content-Type': 'application/json' }

  async function call(path: string, body?: unknown): Promise<any> {
    let res: Response
    let text: string
    try {
      res = await io.fetch(`https://${site}${path}`, { method: body ? 'POST' : 'GET', headers, body: body === undefined ? undefined : JSON.stringify(body) })
      // In the try: the body can still fail to arrive after the headers did.
      text = await res.text()
    } catch (e) {
      throw new GraftError('network', `could not reach Jira at ${site}: ${(e as Error).message}`)
    }
    // Error bodies are {errorMessages: [...], errors: {...}}, or plain text (401).
    let json: any
    try {
      json = JSON.parse(text)
    } catch {}
    if (res.ok && json) return json
    const message = json?.errorMessages?.[0] ?? Object.values(json?.errors ?? {})[0] ?? (text.trim().slice(0, 200) || `HTTP ${res.status}`)
    if (res.status === 404) throw new GraftError('not-found', `Jira: ${message}`)
    throw new GraftError('network', `Jira answered HTTP ${res.status}: ${message}`, res.status === 401 || res.status === 403 ? authHint : undefined)
  }

  const toIssue = (i: any): JiraIssue => ({
    key: i.key,
    summary: i.fields?.summary ?? '',
    url: `https://${site}/browse/${i.key}`,
    status: i.fields?.status?.name ?? '',
  })

  return {
    async issue(key) {
      return toIssue(await call(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=${fields.join(',')}`))
    },
    // With a query: Jira's text search over every issue. Without: my unresolved issues.
    // ponytail: at most 50 issues across pages; raise the cap if a picker needs more.
    async search(query) {
      const filter = query?.trim() ? `text ~ ${quote(query.trim())}` : 'assignee = currentUser() AND statusCategory != Done'
      const jql = `${filter} ORDER BY updated DESC`
      const hits: JiraIssue[] = []
      let nextPageToken: string | undefined
      do {
        const page = await call('/rest/api/3/search/jql', { jql, fields, maxResults: 50 - hits.length, nextPageToken })
        hits.push(...(page.issues ?? []).map(toIssue))
        nextPageToken = page.isLast ? undefined : page.nextPageToken
      } while (nextPageToken && hits.length < 50)
      return hits
    },
  }
}
