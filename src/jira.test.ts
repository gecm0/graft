import { expect, test } from 'bun:test'
import { create } from './commands/create.ts'
import { search } from './commands/search.ts'
import { jira } from './jira.ts'
import { cloneScript, fakeIo, type Reply } from './test/fake-io.ts'

// No Jira site was available, so these fixtures follow Atlassian's documented REST API v3 shapes
// (GET /issue/{key}, POST /search/jql with nextPageToken/isLast, {errorMessages, errors}); not recorded live.
const fixture = (name: string) => Bun.file(`${import.meta.dir}/fixtures/jira-${name}.from-docs.json`).text()

type Sent = { url: string; method: string; headers: Record<string, string>; body: any }

// A fake fetch that answers by URL path ("/issue/", "/search/jql") or, for search pages, by the
// nextPageToken in the body; it records every request.
function fakeJira(replies: Record<string, { body: string; status?: number }>) {
  const sent: Sent[] = []
  const fetch = async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    sent.push({ url, method: String(init?.method), headers: init?.headers as Record<string, string>, body })
    const key = body?.nextPageToken ?? Object.keys(replies).find((k) => url.includes(k))
    const reply = key && replies[key]
    if (!reply) throw new Error(`unexpected request ${url}`)
    return new Response(reply.body, { status: reply.status ?? 200 })
  }
  return { sent, fetch }
}

const userConfig = '/home/me/.config/graft/config.toml'
const keyFile = {
  [userConfig]: 'user = "alice"\n[jira]\nsite = "https://acme.atlassian.net/"\nemail = "me@example.com"\napi_token = "file-token"\n',
}
const basic = (email: string, token: string) => `Basic ${btoa(`${email}:${token}`)}`

test('issue and search map to JiraIssue with Basic email:api_token; search follows nextPageToken', async () => {
  const net = fakeJira({
    '/issue/': { body: await fixture('issue') },
    '/search/jql': { body: await fixture('search-1') },
    'page-2-token': { body: await fixture('search-2') },
  })
  const io = fakeIo({}, { files: keyFile, fetch: net.fetch })
  const j = await jira(io)

  expect(await j.issue('ABC-123')).toEqual({
    key: 'ABC-123', summary: 'Fix the login page', url: 'https://acme.atlassian.net/browse/ABC-123', status: 'In Progress',
  })
  expect(net.sent[0]).toMatchObject({
    url: 'https://acme.atlassian.net/rest/api/3/issue/ABC-123?fields=summary,status',
    method: 'GET',
    headers: { Authorization: basic('me@example.com', 'file-token') },
  })

  expect((await j.search('say "hi"')).map((i) => [i.key, i.status])).toEqual([['ABC-123', 'In Progress'], ['ABC-98', 'To Do']])
  expect(net.sent[1]).toMatchObject({ url: 'https://acme.atlassian.net/rest/api/3/search/jql', method: 'POST' })
  expect(net.sent[1]!.body).toEqual({ jql: 'text ~ "say \\"hi\\"" ORDER BY updated DESC', fields: ['summary', 'status'], maxResults: 50 })
  expect(net.sent[2]!.body).toMatchObject({ nextPageToken: 'page-2-token', maxResults: 49 })

  // No query: my unresolved issues.
  await j.search()
  expect(net.sent[3]!.body.jql).toBe('assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC')
  expect(io.warnings).toEqual([])
})

test('JIRA_* env wins over the file; a missing setting is a usage error', async () => {
  const net = fakeJira({ '/issue/': { body: await fixture('issue') } })
  const env = { JIRA_SITE: 'other.atlassian.net', JIRA_EMAIL: 'env@example.com', JIRA_API_TOKEN: 'env-token' }
  await (await jira(fakeIo({}, { files: keyFile, env, fetch: net.fetch }))).issue('ABC-123')
  expect(net.sent[0]!.url).toStartWith('https://other.atlassian.net/')
  expect(net.sent[0]!.headers.Authorization).toBe(basic('env@example.com', 'env-token'))

  const err = await jira(fakeIo({}, { env: { JIRA_SITE: 'acme.atlassian.net', JIRA_EMAIL: 'me@example.com' } })).catch((e) => e)
  expect(err).toMatchObject({ kind: 'usage' })
  expect(err.hint).toContain('JIRA_API_TOKEN')
  await expect(jira(fakeIo())).rejects.toMatchObject({ kind: 'usage' })
})

test('a token file readable by others warns', async () => {
  const io = fakeIo({}, { files: keyFile, modes: { [userConfig]: 0o644 } })
  await jira(io)
  expect(io.warnings.join('\n')).toContain(`chmod 600 ${userConfig}`)
})

test('an unknown issue is not-found; offline, bad credentials and other failures are network', async () => {
  const notFound = fakeJira({ '/issue/': { body: await fixture('not-found'), status: 404 } })
  const err404 = await (await jira(fakeIo({}, { files: keyFile, fetch: notFound.fetch }))).issue('ABC-0').catch((e) => e)
  expect(err404).toMatchObject({ kind: 'not-found' })
  expect(err404.message).toContain('Issue does not exist')

  const down = await jira(fakeIo({}, { files: keyFile, fetch: async () => { throw new Error('offline') } }))
  await expect(down.issue('ABC-1')).rejects.toMatchObject({ kind: 'network' })

  // Jira answers a bad token with a plain-text 401.
  const auth = fakeJira({ '/issue/': { body: 'Client must be authenticated to access this resource.', status: 401 } })
  const err = await (await jira(fakeIo({}, { files: keyFile, fetch: auth.fetch }))).issue('ABC-1').catch((e) => e)
  expect(err).toMatchObject({ kind: 'network' })
  expect(err.hint).toContain('JIRA_API_TOKEN')

  const badJql = fakeJira({ '/search/jql': { body: '{"errorMessages":["Error in the JQL Query"],"errors":{}}', status: 400 } })
  const err400 = await (await jira(fakeIo({}, { files: keyFile, fetch: badJql.fetch }))).search('x').catch((e) => e)
  expect(err400).toMatchObject({ kind: 'network' })
  expect(err400.message).toContain('Error in the JQL Query')
})

const branch = 'alice/abc-123-fix-the-login-page'
const wt = '/r/repo.worktrees/alice-abc-123-fix-the-login-page'
const script: Record<string, Reply> = {
  ...cloneScript,
  [`git check-ref-format --branch ${branch}`]: { out: `${branch}\n` },
  [`git show-ref --verify --quiet refs/heads/${branch}`]: { code: 1 },
  'herdr-app ls': { out: '{"spaces":[]}' },
  'hc ls --json': { out: '{"terminals":[]}' },
  'herdr-app do space.new': { out: '{"space":"sp9","tab":"tb9","terminal":"t20"}' },
}

test('create --jira: the issue fills the template ({key} lowercased); the agent gets "<KEY> <summary>\\n<url>"', async () => {
  const net = fakeJira({ '/issue/': { body: await fixture('issue') } })
  const files = { ...keyFile, '/r/repo/graft.toml': '[branch]\ntemplate = "{user}/{key}-{slug}{linear}"\n[agent]\ncommand = ["claude"]\n' }
  const io = fakeIo(script, { files, fetch: net.fetch })
  const r = await create(io, { jira: 'ABC-123', setup: true, open: 'herdr' })
  expect(r).toMatchObject({ branch, worktree: wt, base: 'origin/main' })
  expect(io.calls).toContainEqual(['git', 'worktree', 'add', '--no-track', '-b', branch, wt, 'refs/remotes/origin/main'])
  const args = io.calls.filter((c) => c[2] === 'space.new').map((c) => JSON.parse(c[3]!))
  expect(args.find((a) => a.tab === 'agent')?.task).toBe('ABC-123 Fix the login page\nhttps://acme.atlassian.net/browse/ABC-123')
})

test('search jira works outside a repository', async () => {
  const net = fakeJira({ '/search/jql': { body: await fixture('search-2') } })
  const io = fakeIo({ 'git rev-parse': { code: 128 } }, { files: keyFile, fetch: net.fetch })
  const r = await search(io, 'jira', 'login')
  expect(r.kind).toBe('jira')
  expect(r.hits.map((h: any) => h.key)).toEqual(['ABC-98'])
  expect(io.calls).toEqual([])
})
