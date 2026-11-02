import { expect, test } from 'bun:test'
import { create } from './commands/create.ts'
import { search } from './commands/search.ts'
import { linear } from './linear.ts'
import { cloneScript, fakeIo, type Reply } from './test/fake-io.ts'

// No Linear API key was available, so these fixtures follow Linear's published GraphQL schema
// (Issue, IssueSearchPayload, User.assignedIssues) and its documented error shape; not recorded live.
const fixture = (name: string) => Bun.file(`${import.meta.dir}/fixtures/linear-${name}.from-docs.json`).text()

type Sent = { url: string; headers: Record<string, string>; query: string; variables: Record<string, unknown> }

// A fake fetch that answers by the GraphQL root field in the query and records every request.
function fakeLinear(replies: Record<string, { body: string; status?: number }>) {
  const sent: Sent[] = []
  const fetch = async (url: string, init?: RequestInit) => {
    const { query, variables } = JSON.parse(String(init?.body))
    sent.push({ url, headers: init?.headers as Record<string, string>, query, variables })
    const root = Object.keys(replies).find((k) => query.includes(`${k}(`))
    if (!root) throw new Error(`unexpected query ${query}`)
    return new Response(replies[root]!.body, { status: replies[root]!.status ?? 200 })
  }
  return { sent, fetch }
}

const userConfig = '/home/me/.config/graft/config.toml'
const keyFile = { [userConfig]: 'user = "alice"\n[linear]\napi_key = "lin_api_file"\n' }

test('issue, search and assigned issues map to Issue; the key goes in Authorization as is', async () => {
  const net = fakeLinear({
    issue: { body: await fixture('issue') },
    searchIssues: { body: await fixture('search') },
    assignedIssues: { body: await fixture('assigned') },
  })
  const io = fakeIo({}, { files: keyFile, fetch: net.fetch })
  const lin = await linear(io)

  expect(await lin.issue('ABC-123')).toEqual({
    identifier: 'ABC-123', title: 'Fix the login page', url: 'https://linear.app/acme/issue/ABC-123/fix-the-login-page',
    branchName: 'alice/abc-123-fix-the-login-page', state: 'In Progress',
  })
  expect(net.sent[0]).toMatchObject({ url: 'https://api.linear.app/graphql', headers: { Authorization: 'lin_api_file' }, variables: { id: 'ABC-123' } })

  expect((await lin.search('login')).map((i) => [i.identifier, i.state])).toEqual([['ABC-123', 'In Progress'], ['ABC-98', 'Done']])
  expect(net.sent[1]!.variables).toEqual({ term: 'login' })

  // No query: my assigned issues that are not completed or canceled.
  expect((await lin.search()).map((i) => i.identifier)).toEqual(['ABC-123', 'XYZ-7'])
  expect(net.sent[2]!.query).toContain('nin: ["completed", "canceled"]')
  expect(io.warnings).toEqual([])
})

test('LINEAR_API_KEY wins over the file; no key at all is a usage error', async () => {
  const net = fakeLinear({ issue: { body: await fixture('issue') } })
  await (await linear(fakeIo({}, { files: keyFile, env: { LINEAR_API_KEY: 'lin_api_env' }, fetch: net.fetch }))).issue('ABC-123')
  expect(net.sent[0]!.headers.Authorization).toBe('lin_api_env')

  const err = await linear(fakeIo()).catch((e) => e)
  expect(err).toMatchObject({ kind: 'usage' })
  expect(err.hint).toContain('LINEAR_API_KEY')
})

test('a key file readable by others warns', async () => {
  const io = fakeIo({}, { files: keyFile, modes: { [userConfig]: 0o644 } })
  await linear(io)
  expect(io.warnings.join('\n')).toContain(`chmod 600 ${userConfig}`)
})

test('an unknown issue is not-found; transport and other API errors are network', async () => {
  const notFound = fakeLinear({ issue: { body: await fixture('not-found'), status: 400 } })
  await expect((await linear(fakeIo({}, { files: keyFile, fetch: notFound.fetch }))).issue('ABC-0')).rejects.toMatchObject({ kind: 'not-found' })

  const down = await linear(fakeIo({}, { files: keyFile, fetch: async () => { throw new Error('offline') } }))
  await expect(down.issue('ABC-1')).rejects.toMatchObject({ kind: 'network' })

  const auth = fakeLinear({ issue: { body: JSON.stringify({ errors: [{ message: 'Authentication required, not authenticated', extensions: { code: 'AUTHENTICATION_ERROR' } }] }), status: 400 } })
  const err = await (await linear(fakeIo({}, { files: keyFile, fetch: auth.fetch }))).issue('ABC-1').catch((e) => e)
  expect(err).toMatchObject({ kind: 'network' })
  expect(err.hint).toContain('LINEAR_API_KEY')
})

const branch = 'alice/abc-123-fix-the-login-page'
const wt = '/r/repo.worktrees/alice-abc-123-fix-the-login-page'
const script: Record<string, Reply> = {
  ...cloneScript,
  [`git check-ref-format --branch ${branch}`]: { out: `${branch}\n` },
  [`git show-ref --verify --quiet refs/heads/${branch}`]: { code: 1 },
}

test('create --linear: the issue fills the template ({key} lowercased); new branch from the base', async () => {
  const net = fakeLinear({ issue: { body: await fixture('issue') } })
  const files = { ...keyFile, '/r/repo/graft.toml': '[branch]\ntemplate = "{user}/{key}-{slug}"\n' }
  const io = fakeIo(script, { files, fetch: net.fetch })
  const r = await create(io, { linear: 'ABC-123', setup: true })
  expect(r).toMatchObject({ branch, worktree: wt, base: 'origin/main' })
  expect(io.calls).toContainEqual(['git', 'worktree', 'add', '--no-track', '-b', branch, wt, 'refs/remotes/origin/main'])

  // {linear} is Linear's own branchName.
  const own = fakeIo(script, { files: { ...keyFile, '/r/repo/graft.toml': '[branch]\ntemplate = "{linear}"\n' }, fetch: net.fetch })
  expect((await create(own, { linear: 'ABC-123', setup: true })).branch).toBe(branch)
})

test('create --linear --open herdr: the agent gets "<ID> <title>\\n<url>" unless --task is given', async () => {
  const net = fakeLinear({ issue: { body: await fixture('issue') } })
  const herdr: Record<string, Reply> = {
    ...script,
    'herdr-app ls': { out: '{"spaces":[]}' },
    'hc ls --json': { out: '{"terminals":[]}' },
    'herdr-app do space.new': { out: '{"space":"sp9","tab":"tb9","terminal":"t20"}' },
  }
  const files = { ...keyFile, '/r/repo/graft.toml': '[branch]\ntemplate = "{key}-{slug}"\n[agent]\ncommand = ["claude"]\n' }
  const sentTask = (io: ReturnType<typeof fakeIo>) => {
    const args = io.calls.filter((c) => c[2] === 'space.new').map((c) => JSON.parse(c[3]!))
    return args.find((a) => a.tab === 'agent')?.task
  }
  const script2 = { ...herdr, 'git check-ref-format --branch abc-123-fix-the-login-page': { out: 'abc-123-fix-the-login-page\n' }, 'git show-ref --verify --quiet refs/heads/abc-123-fix-the-login-page': { code: 1 } }

  const io = fakeIo(script2, { files, fetch: net.fetch })
  await create(io, { linear: 'ABC-123', setup: true, open: 'herdr' })
  expect(sentTask(io)).toBe('ABC-123 Fix the login page\nhttps://linear.app/acme/issue/ABC-123/fix-the-login-page')

  const own = fakeIo(script2, { files, fetch: net.fetch })
  await create(own, { linear: 'ABC-123', setup: true, open: 'herdr', task: 'just this' })
  expect(sentTask(own)).toBe('just this')
})

test('search linear works outside a repository; no query lists my assigned issues', async () => {
  const net = fakeLinear({ assignedIssues: { body: await fixture('assigned') } })
  const io = fakeIo({ 'git rev-parse': { code: 128 } }, { files: keyFile, fetch: net.fetch })
  const r = await search(io, 'linear')
  expect(r.kind).toBe('linear')
  expect(r.hits.map((h: any) => h.identifier)).toEqual(['ABC-123', 'XYZ-7'])
  expect(io.calls).toEqual([])
})
