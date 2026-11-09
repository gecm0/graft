import { expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { clean } from './commands/clean.ts'
import { create } from './commands/create.ts'
import { remove } from './commands/remove.ts'
import { loadUserConfig } from './config.ts'
import { forgeFor } from './forge/forge.ts'
import { systemIo } from './io.ts'
import { copyIncludes, ownLinks, restoreLinks, unlinkLinks } from './materialize.ts'
import { deleteBranch } from './merged.ts'
import { cloneScript, fakeIo, type Reply } from './test/fake-io.ts'

const main = '/r/repo'
const wt = '/r/repo.worktrees/foo'
const script: Record<string, Reply> = {
  ...cloneScript,
  'git worktree list --porcelain': { out: `worktree ${main}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD bbb\nbranch refs/heads/foo\n\n` },
  'git rev-parse --verify HEAD': { out: 'bbb\n' },
  'git reflog show --format=%H refs/heads/foo': { out: 'bbb\naaa\n' },
}
const opts = { worktree: wt, force: false, keepBranch: false, ignoreTeardown: false }
const openSpace = { out: JSON.stringify({ spaces: [{ id: 'sp1', folder: wt, tabs: [] }] }) }
const removed = (calls: string[][]) => calls.some((c) => c.slice(0, 3).join(' ') === 'git worktree remove')
const closed = (calls: string[][]) => calls.some((c) => c[2] === 'space.close')

test('remove keeps links and spaces when teardown creates dirt', async () => {
  const f = fakeIo({ ...script, 'herdr-app ls': openSpace }, {
    paths: [wt], links: { [`${wt}/.env`]: `${main}/.env` },
    files: { [`${main}/graft.toml`]: 'link = [".env"]\n[hooks]\nteardown = "make down"\n' },
  })
  const run = f.run
  let tornDown = false
  f.run = async (cmd, o) => {
    if (cmd[0] === 'bash') tornDown = true
    const r = await run(cmd, o)
    return cmd[1] === 'status' && tornDown ? { ...r, out: '?? scratch\0' } : r
  }
  await expect(remove(f, opts)).rejects.toMatchObject({ kind: 'dirty' })
  expect(removed(f.calls)).toBe(false)
  expect(closed(f.calls)).toBe(false)
  expect(f.calls.some((c) => c[0] === 'rm')).toBe(false)
})

test('remove restores its links and keeps spaces if git refuses', async () => {
  const links: Record<string, string> = { [`${wt}/.env`]: `${main}/.env` }
  const f = fakeIo({ ...script, 'herdr-app ls': openSpace, 'git worktree remove': { code: 128, err: 'locked concurrently' } }, {
    paths: [wt], links, files: { [`${main}/graft.toml`]: 'link = [".env"]\n' },
  })
  const run = f.run
  f.run = async (cmd, o) => {
    const r = await run(cmd, o)
    if (cmd[0] === 'rm') delete links[cmd.at(-1)!]
    if (cmd[0] === 'ln') links[cmd.at(-1)!] = cmd.at(-2)!
    return r
  }
  await expect(remove(f, opts)).rejects.toMatchObject({ kind: 'dirty' })
  expect(links[`${wt}/.env`]).toBe(`${main}/.env`)
  expect(closed(f.calls)).toBe(false)
})

test.each([128, 3])('invalid or unreadable preserve config (%i) keeps a merged branch', async (code) => {
  const f = fakeIo({ ...script, 'git config --type=bool --get branch.foo.graft-preserve': { code, err: 'invalid config' } }, { paths: [wt] })
  expect((await remove(f, opts)).branch).toMatchObject({ deleted: false, reason: 'preserved' })
  expect(f.calls.some((c) => c[1] === 'update-ref')).toBe(false)
})

test('clean skips a candidate whose HEAD changed while confirming', async () => {
  const replies = { ...script }
  const f = fakeIo(replies, { paths: [wt], tty: true })
  f.ask = async () => {
    replies['git rev-parse --verify HEAD'] = { out: 'new-commit\n' }
    return true
  }
  const r = await clean(f, { dryRun: false, yes: false })
  expect(r.skipped).toContainEqual({ path: wt, branch: 'foo', reason: 'changed' })
  expect(removed(f.calls)).toBe(false)
})

test('clean skips a space opened while confirming', async () => {
  const replies = { ...script, 'herdr-app ls': { out: '{"spaces":[]}' } }
  const f = fakeIo(replies, { paths: [wt], tty: true })
  f.ask = async () => {
    replies['herdr-app ls'] = openSpace
    return true
  }
  const r = await clean(f, { dryRun: false, yes: false })
  expect(r.skipped).toContainEqual({ path: wt, branch: 'foo', reason: 'open-space' })
  expect(removed(f.calls)).toBe(false)
  expect(closed(f.calls)).toBe(false)
})

test('clean treats repeated identical reflog SHAs as no commits', async () => {
  const f = fakeIo({ ...script, 'git reflog show --format=%H refs/heads/foo': { out: 'bbb\nbbb\nbbb\n' } }, { paths: [wt] })
  const r = await clean(f, { dryRun: false, yes: true })
  expect(r.skipped).toContainEqual({ path: wt, branch: 'foo', reason: 'no-commits' })
  expect(removed(f.calls)).toBe(false)
})

test('invalid TOML never includes the unquoted token', async () => {
  const f = fakeIo({}, { files: { '/home/me/.config/graft/config.toml': '[jira]\napi_token = abc_SECRET\n' } })
  const error = await loadUserConfig(f).catch((e) => e)
  expect(error).toMatchObject({ kind: 'usage', message: '/home/me/.config/graft/config.toml: invalid TOML' })
  expect(JSON.stringify(error)).not.toContain('abc_SECRET')
})

test('empty HOME falls back to the OS home', () => {
  expect(systemIo({ HOME: '' }).home).toBe(homedir())
})

test('forge errors retain the useful second line and bound the output', async () => {
  const f = fakeIo({ 'glab mr view': { code: 1, err: '\n ERROR\n\n Authentication required\n' + 'x'.repeat(500) } })
  const error = await forgeFor(f, 'git@gitlab.com:octo/example.git').view('1').catch((e) => e)
  expect(error.message).toContain('ERROR Authentication required')
  expect(error.message.length).toBeLessThan(340)
})

test('Origin validates the URL host and codebase repository before invoking its CLI', async () => {
  const f = fakeIo({ 'origin pr view': { out: '{"number":31,"headRef":"foo"}' } })
  const forge = forgeFor(f, 'git@origin.cursor.com:octo/example.git')
  for (const ref of ['https://cursor.com/codebase/other/project/pull/31', 'https://evil.test/codebase/octo/example/pull/31', 'https://cursor.com/octo/example/pull/31']) {
    await expect(forge.view(ref)).rejects.toMatchObject({ kind: 'usage' })
  }
  expect(f.calls).toEqual([])
  expect((await forge.view('https://cursor.com/codebase/octo/example/pull/31')).number).toBe(31)
  expect((await forge.view('31')).number).toBe(31)
})

test('unlink never follows a symlinked parent, and returns only removed links', async () => {
  const f = fakeIo({ [`rm -- ${wt}/bad`]: { code: 1 } }, {
    links: { [`${wt}/dir`]: '/outside', [`${wt}/dir/secret`]: `${main}/dir/secret`, [`${wt}/ok`]: `${main}/ok`, [`${wt}/bad`]: `${main}/bad` },
  })
  expect(ownLinks(f, main, wt, ['dir/secret'])).toEqual([])
  expect(await unlinkLinks(f, main, wt, ['dir/secret', 'ok', 'bad'])).toEqual(['ok'])
  expect(f.calls.some((c) => c.includes(`${wt}/dir/secret`))).toBe(false)
})

test('link rollback does not overwrite files or follow replaced parents', async () => {
  const f = fakeIo({ ln: { code: 1, err: 'permission denied' } }, {
    paths: [`${wt}/taken`], links: { [`${wt}/dir`]: '/outside' },
  })
  await restoreLinks(f, main, wt, ['taken', 'dir/secret', 'free'])
  expect(f.calls).toEqual([['ln', '-s', '--', `${main}/free`, `${wt}/free`]])
  expect(f.warnings).toHaveLength(3)
})

test.each(['du', 'find'])('failed %s measurements never allow a copy', async (command) => {
  const f = fakeIo({
    'git -c core.quotePath=false check-ignore': { out: 'data\n' },
    du: { out: '1\tdata\n' }, find: { out: 'data\n' },
    [command]: { code: 1, out: '1\n', err: 'permission denied' },
  }, { files: { [`${main}/.worktreeinclude`]: 'data\n' }, paths: [`${main}/data`] })
  expect((await copyIncludes(f, main, wt)).skipped).toEqual([{ path: 'data', reason: 'error' }])
  expect(f.calls.some((c) => c[0] === 'cp')).toBe(false)
})

test('branch config cleanup warns on errors but not a missing section', async () => {
  for (const [err, warnings] of [['error: could not lock config file', 1], ['fatal: no such section: branch.foo', 0]] as const) {
    const f = fakeIo({ 'git config --remove-section': { code: 128, err } })
    await deleteBranch(f, main, 'foo', 'bbb')
    expect(f.warnings).toHaveLength(warnings)
  }
})

const createScript = {
  ...cloneScript,
  'herdr-app ls': { out: JSON.stringify({ spaces: [{ id: 'main', folder: main, tabs: [] }] }) },
  'herdr-app do space.new': { out: '{"space":"new","tab":"first"}' },
  'herdr-app do tab.new': { out: '{"tab":"second"}' },
}

test('failed tab creation closes only the newly created space, retaining the worktree', async () => {
  const f = fakeIo({ ...createScript, 'herdr-app do tab.new': { code: 1, err: 'tab failed' } }, {
    files: { [`${main}/graft.toml`]: '[[tabs]]\ntitle = "one"\n[[tabs]]\ntitle = "two"\n' },
  })
  await expect(create(f, { branch: 'foo', setup: false, open: 'herdr' })).rejects.toThrow('tab failed')
  expect(f.calls.filter((c) => c[2] === 'space.close').map((c) => JSON.parse(c[3]!))).toEqual([{ id: 'new', confirmed: true }])
  expect(removed(f.calls)).toBe(false)
})

test('duplicate tab titles do not overwrite result IDs', async () => {
  const f = fakeIo(createScript, { files: { [`${main}/graft.toml`]: '[agent]\ncommand = ["claude"]\n[[tabs]]\ntitle = "agent"\n' } })
  const r = await create(f, { branch: 'foo', setup: false, open: 'herdr' })
  expect(Object.values(r.herdr!.tabs).sort()).toEqual(['first', 'second'])
  expect(r.herdr!.tabs.agent).toBe('first')
})
