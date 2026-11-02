import { expect, test } from 'bun:test'
import { create } from '../commands/create.ts'
import { status } from '../commands/status.ts'
import { cloneScript, fakeIo, type Reply } from '../test/fake-io.ts'
import { forgeFor, parseRemoteUrl, prOf, type Pr } from './forge.ts'

// Recorded with the real CLIs and scrubbed (gh 2.102.0, glab 1.121.0). Origin had no PR to observe:
// its *.from-docs.json fixtures follow the origin CLI's own JSON serializer (2026.10.28).
const fixture = (name: string) => Bun.file(`${import.meta.dir}/fixtures/${name}.json`).text()
const reply = async (name: string): Promise<Reply> => ({ out: await fixture(name) })

const ghFields = 'number,title,url,state,isDraft,headRefName,baseRefName,headRefOid,isCrossRepository,mergedAt,statusCheckRollup'
const originFields = 'number,title,url,status,isDraft,headRef,baseRef,headSha,mergedAt'

test('gh maps view and list output to Pr', async () => {
  const io = fakeIo({
    [`gh pr view 12 -R octo/example --json ${ghFields}`]: await reply('gh-view-fork-draft'),
    [`gh pr view 11 -R octo/example --json ${ghFields}`]: await reply('gh-view-merged'),
    [`gh pr list -R octo/example --json ${ghFields}`]: await reply('gh-list'),
  })
  const forge = forgeFor(io, 'git@github.com:octo/example.git')
  expect(await forge.view('12')).toEqual({
    number: 12, title: 'Example change 12', url: 'https://github.com/octo/example/pull/12', state: 'draft',
    head: 'fix-login', base: 'main', headSha: '1'.repeat(40), fork: true, ci: 'success',
  } satisfies Pr)
  expect(await forge.view('11')).toMatchObject({ state: 'merged', fork: false, head: 'alice/add-sizes', mergedAt: '2026-10-30T18:24:32Z', ci: 'success' })
  const hits = await forge.search('login')
  expect(hits.map((p) => [p.number, p.state, p.fork, p.ci])).toEqual([[15, 'open', false, 'success'], [14, 'closed', true, 'failure'], [13, 'closed', true, undefined]])
  expect(io.calls.at(-1)).toEqual(['gh', 'pr', 'list', '-R', 'octo/example', '--json', ghFields, '--search', 'login'])
  expect(forge.pullRef(12)).toBe('refs/pull/12/head')
})

test('gh: a pending check or status context is pending, failure wins', async () => {
  const io = fakeIo({ 'gh pr view': { out: JSON.stringify({ ...JSON.parse(await fixture('gh-view-merged')), statusCheckRollup: [
    { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: '' },
    { __typename: 'StatusContext', state: 'SUCCESS' },
  ] }) } })
  const forge = forgeFor(io, 'https://github.com/octo/example')
  expect((await forge.view('11')).ci).toBe('pending')
  io.run = async () => ({ code: 0, err: '', out: JSON.stringify({ statusCheckRollup: [{ status: 'IN_PROGRESS' }, { state: 'ERROR' }] }) })
  expect((await forge.view('11')).ci).toBe('failure')
})

test('glab maps view and list output to Pr; a URL becomes its iid', async () => {
  const io = fakeIo({
    'glab mr view 22 -R octo/example -F json': await reply('glab-view-fork'),
    'glab mr view 23 -R octo/example -F json': await reply('glab-view-draft'),
    'glab mr list -R octo/example -F json --source-branch alice/retry --all -P 1': await reply('glab-list'),
  })
  const forge = forgeFor(io, 'git@gitlab.com:octo/example.git')
  expect(await forge.view('https://gitlab.com/octo/example/-/merge_requests/22')).toEqual({
    number: 22, title: 'Example change 22', url: 'https://gitlab.com/octo/example/-/merge_requests/22', state: 'open',
    head: 'fix-login', base: 'main', headSha: '6'.repeat(40), fork: true, ci: 'success',
  } satisfies Pr)
  expect(await forge.view('23')).toMatchObject({ state: 'draft', fork: false, head: 'alice/add-sizes' })
  // list has no pipeline, so no ci.
  expect(await forge.forBranch('alice/retry')).toEqual({
    number: 21, title: 'Example change 21', url: 'https://gitlab.com/octo/example/-/merge_requests/21', state: 'merged',
    head: 'alice/retry', base: 'main', headSha: '8'.repeat(40), fork: false, mergedAt: '2026-10-29T17:18:27.04Z',
  } satisfies Pr)
  expect(forge.pullRef(22)).toBe('refs/merge-requests/22/head')
})

test('prOf with detail views a PR whose list entry has no CI (status); without it, list only', async () => {
  const io = fakeIo({
    'git remote get-url origin': { out: 'git@gitlab.com:octo/example.git\n' },
    'glab mr list -R octo/example -F json --source-branch alice/retry --all -P 1': await reply('glab-list'),
    'glab mr view 21 -R octo/example -F json': await reply('glab-view-fork'),
  })
  expect((await prOf(io, '/r/repo', 'origin', 'alice/retry'))?.ci).toBeUndefined()
  expect((await prOf(io, '/r/repo', 'origin', 'alice/retry', true))?.ci).toBe('success')
})

test('origin maps view and list output to Pr; ciState only comes with view', async () => {
  const io = fakeIo({
    [`origin pr view 31 -R octo/example --json ${originFields},ciState`]: await reply('origin-view.from-docs'),
    [`origin pr list -R octo/example --json ${originFields}`]: await reply('origin-list.from-docs'),
  })
  const forge = forgeFor(io, 'https://origin.cursor.com/octo/example.git')
  expect(await forge.view('31')).toEqual({
    number: 31, title: 'Example change 31', url: 'https://cursor.com/codebase/octo/example/pull/31', state: 'open',
    head: 'alice/fix-login', base: 'main', headSha: 'a'.repeat(40), fork: false, ci: 'pending',
  } satisfies Pr)
  expect((await forge.search()).map((p) => [p.number, p.state, p.mergedAt, p.ci])).toEqual([[32, 'draft', undefined, undefined], [30, 'merged', '2026-10-30T18:24:32.000Z', undefined]])
  expect(forge.pullRef(31)).toBeNull()
})

test('forgeFor picks the CLI by host; other hosts are unsupported', () => {
  expect(parseRemoteUrl('git@gitlab.com:group/sub/app.git')).toEqual({ host: 'gitlab.com', repo: 'group/sub/app' })
  expect(parseRemoteUrl('ssh://git@github.com:22/octo/example.git')).toEqual({ host: 'github.com', repo: 'octo/example' })
  expect(parseRemoteUrl('git@GitHub.com:octo/example.git')).toEqual({ host: 'github.com', repo: 'octo/example' })
  expect(parseRemoteUrl('/tmp/origin.git')).toBeNull()
  const io = fakeIo()
  expect(forgeFor(io, 'https://github.com/octo/example.git').name).toBe('gh')
  expect(forgeFor(io, 'git@gitlab.com:octo/example.git').name).toBe('glab')
  expect(forgeFor(io, 'git@origin.cursor.com:octo/example.git').name).toBe('origin')
  expect(() => forgeFor(io, 'git@bitbucket.org:octo/example.git')).toThrow(expect.objectContaining({ kind: 'unsupported' }))
  expect(() => forgeFor(io, '/tmp/origin.git')).toThrow(expect.objectContaining({ kind: 'unsupported' }))
})

test('CLI failures: missing binary is unsupported, unknown PR not-found, anything else network', async () => {
  const io = fakeIo({
    'gh pr view 9': { code: 1, err: 'GraphQL: Could not resolve to a PullRequest with the number of 9. (repository.pullRequest)\n' },
    'gh pr view 8': { code: 1, err: 'error connecting to api.github.com\n' },
  })
  const forge = forgeFor(io, 'git@github.com:octo/example.git')
  expect(await forge.view('9').catch((e) => e)).toMatchObject({ kind: 'not-found' })
  expect(await forge.view('8').catch((e) => e)).toMatchObject({ kind: 'network' })
  io.run = async () => {
    throw new Error('ENOENT')
  }
  expect(await forge.view('1').catch((e) => e)).toMatchObject({ kind: 'unsupported' })
})

// A linked worktree on branch foo, in a clone whose origin is on GitHub.
const ghClone: Record<string, Reply> = {
  ...cloneScript,
  'git remote get-url origin': { out: 'git@github.com:octo/example.git\n' },
}

// refs/heads/<branch> exists once a fetch has written it.
function fetchCreatesBranch(io: ReturnType<typeof fakeIo>, branch: string) {
  const run = io.run
  let fetched = false
  io.run = async (cmd, o) => {
    const line = cmd.join(' ')
    if (line.startsWith('git fetch') && line.endsWith(`:refs/heads/${branch}`)) fetched = true
    if (fetched && line === `git show-ref --verify --quiet refs/heads/${branch}`) {
      io.calls.push(cmd)
      return { code: 0, out: '', err: '' }
    }
    return run(cmd, o)
  }
}

const gitCalls = (io: ReturnType<typeof fakeIo>) =>
  io.calls.filter((c) => c[0] === 'git' && ['fetch', 'worktree', 'config'].includes(c[1]!) && !['list', '--get'].includes(c[2]!)).map((c) => c.join(' '))

test('create --pr: a fork PR is fetched from refs/pull/<n>/head into a preserved local branch', async () => {
  const io = fakeIo({
    ...ghClone,
    'gh pr view 12': await reply('gh-view-fork-draft'),
    'git check-ref-format --branch fix-login': { out: 'fix-login\n' },
    'git show-ref --verify --quiet refs/heads/fix-login': { code: 1 },
  })
  fetchCreatesBranch(io, 'fix-login')
  const r = await create(io, { pr: '12', setup: false })
  expect(r).toMatchObject({ worktree: '/r/repo.worktrees/fix-login', branch: 'fix-login', base: null })
  expect(gitCalls(io)).toEqual([
    'git fetch --no-tags origin refs/pull/12/head:refs/heads/fix-login',
    'git worktree add /r/repo.worktrees/fix-login fix-login',
    'git config branch.fix-login.graft-preserve true',
  ])
})

test('create --pr: a same-repo PR is checked out like --remote; --base is refused', async () => {
  const io = fakeIo({
    ...ghClone,
    'gh pr view https://github.com/octo/example/pull/11': await reply('gh-view-merged'),
    'git check-ref-format --branch alice/add-sizes': { out: 'alice/add-sizes\n' },
    'git show-ref --verify --quiet refs/heads/alice/add-sizes': { code: 1 },
    'git rev-parse --verify --quiet refs/remotes/origin/alice/add-sizes': { out: `${'2'.repeat(40)}\n` },
  })
  await create(io, { pr: 'https://github.com/octo/example/pull/11', setup: false })
  expect(io.calls).toContainEqual(['gh', 'pr', 'view', 'https://github.com/octo/example/pull/11', '-R', 'octo/example', '--json', ghFields])
  expect(gitCalls(io)).toEqual([
    'git fetch --no-tags origin +refs/heads/alice/add-sizes:refs/remotes/origin/alice/add-sizes',
    'git worktree add --no-track -b alice/add-sizes /r/repo.worktrees/alice-add-sizes refs/remotes/origin/alice/add-sizes',
    'git config branch.alice/add-sizes.remote origin',
    'git config branch.alice/add-sizes.merge refs/heads/alice/add-sizes',
    'git config branch.alice/add-sizes.graft-preserve true',
  ])
  expect(await create(io, { pr: '11', base: 'main', setup: false }).catch((e) => e)).toMatchObject({ kind: 'usage' })
  // A PR URL of another repository is refused before gh is asked.
  expect(await create(io, { pr: 'https://github.com/other/project/pull/11', setup: false }).catch((e) => e)).toMatchObject({ kind: 'usage' })
})

test('create --pr: a same-repo PR whose branch was deleted falls back to the pull ref', async () => {
  const io = fakeIo({
    ...ghClone,
    'gh pr view 11': await reply('gh-view-merged'),
    'git check-ref-format --branch alice/add-sizes': { out: 'alice/add-sizes\n' },
    'git show-ref --verify --quiet refs/heads/alice/add-sizes': { code: 1 },
    'git show-ref --verify --quiet refs/remotes/origin/alice/add-sizes': { code: 1 },
    'git fetch --no-tags origin +refs/heads/alice/add-sizes': { code: 128, err: "fatal: couldn't find remote ref" },
  })
  fetchCreatesBranch(io, 'alice/add-sizes')
  await create(io, { pr: '11', setup: false })
  expect(gitCalls(io)).toContain('git fetch --no-tags origin refs/pull/11/head:refs/heads/alice/add-sizes')
  expect(gitCalls(io)).toContain('git worktree add /r/repo.worktrees/alice-add-sizes alice/add-sizes')
})

test('create --pr: a stale remote-tracking ref of a deleted head is not used; the pull ref is', async () => {
  const io = fakeIo({
    ...ghClone,
    'gh pr view 11': await reply('gh-view-merged'),
    'git check-ref-format --branch alice/add-sizes': { out: 'alice/add-sizes\n' },
    'git show-ref --verify --quiet refs/heads/alice/add-sizes': { code: 1 },
    'git fetch --no-tags origin +refs/heads/alice/add-sizes': { code: 128, err: "fatal: couldn't find remote ref" },
    // The old tracking ref survives, at a commit before the PR's last one.
    'git rev-parse --verify --quiet refs/remotes/origin/alice/add-sizes': { out: `${'1'.repeat(40)}\n` },
  })
  fetchCreatesBranch(io, 'alice/add-sizes')
  await create(io, { pr: '11', setup: false })
  expect(gitCalls(io)).toContain('git fetch --no-tags origin refs/pull/11/head:refs/heads/alice/add-sizes')
  expect(gitCalls(io)).toContain('git worktree add /r/repo.worktrees/alice-add-sizes alice/add-sizes')
})

test('status includes the branch PR; null for the main checkout and when the CLI fails', async () => {
  const wt = '/r/repo.worktrees/foo'
  const script: Record<string, Reply> = {
    ...ghClone,
    'git worktree list --porcelain': { out: `worktree /r/repo\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD bbb\nbranch refs/heads/foo\n\n` },
    [`gh pr list -R octo/example --json ${ghFields} --head foo --state all -L 1`]: { out: `[${await fixture('gh-view-merged')}]` },
  }
  const io = fakeIo(script, { paths: [wt] })
  expect((await status(io, wt)).pr).toMatchObject({ number: 11, state: 'merged' })
  expect((await status(io, '/r/repo')).pr).toBeNull()
  expect(io.calls.filter((c) => c[0] === 'gh')).toHaveLength(1)

  const failing = fakeIo({ ...script, [`gh pr list -R octo/example --json ${ghFields} --head foo --state all -L 1`]: { code: 1, err: 'HTTP 502\n' } }, { paths: [wt] })
  expect((await status(failing, wt)).pr).toBeNull()
  expect(failing.warnings.some((w) => w.includes('no PR state for foo'))).toBe(true)
})

test('list --pr asks the forge a few rows at a time and keeps the rows in order', async () => {
  const { list } = await import('../commands/list.ts')
  const sample = JSON.parse(await fixture('gh-list'))[0]
  const branches = ['b0', 'b1', 'b2', 'b3', 'b4', 'b5']
  const blocks = branches.map((b, i) => `worktree /r/repo.worktrees/${b}\nHEAD ${i}\nbranch refs/heads/${b}\n`)
  const io = fakeIo({
    ...cloneScript,
    'git remote get-url origin': { out: 'git@github.com:octo/example.git\n' },
    'git worktree list --porcelain': { out: [`worktree /r/repo\nHEAD aaa\nbranch refs/heads/main\n`, ...blocks].join('\n') },
  })
  const run = io.run
  let open = 0
  let most = 0
  io.run = async (cmd, opts) => {
    if (cmd[0] !== 'gh') return run(cmd, opts)
    const branch = cmd[cmd.indexOf('--head') + 1]!
    const n = branches.indexOf(branch)
    most = Math.max(most, ++open)
    await Bun.sleep(5 * (branches.length - n)) // later rows answer first
    open--
    return { code: 0, out: JSON.stringify([{ ...sample, number: n, headRefName: branch }]), err: '' }
  }
  const rows = await list(io, true)
  expect(rows.map((r) => r.pr?.number ?? null)).toEqual([null, 0, 1, 2, 3, 4, 5])
  expect(most).toBe(4)
})
