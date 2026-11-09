import { expect, test } from 'bun:test'
import { agent } from './commands/agent.ts'
import { clean } from './commands/clean.ts'
import { create } from './commands/create.ts'
import { list } from './commands/list.ts'
import { open } from './commands/open.ts'
import { remove, type RemoveOpts } from './commands/remove.ts'
import { setup } from './commands/setup.ts'
import { status } from './commands/status.ts'
import { showing, spaces } from './herdr.ts'
import { cloneScript, fakeIo, type FakeIo, type Reply } from './test/fake-io.ts'

// Shapes recorded in the research (§8): `herdr-app ls` is {spaces: [{id, name, folder, machine,
// active, tabs: [{id, name, terminals: [{terminal, pane, status, app}]}]}]}; `hc ls --json` gives each
// terminal's address, live cwd and where (inside {terminals: […]}, with state "live" | "finished");
// `herdr-app do space.new` prints {space, tab, terminal}, `space.close` prints {"ok":true}.
const wt = '/r/repo.worktrees/foo'
const herdrLs = (spaces: unknown[]) => ({ out: JSON.stringify({ spaces }) })
const term = (terminal: string, status: string | null = null) => ({ terminal, pane: `p${terminal}`, status, app: status ? 'claude-code' : null })
const space = (id: string, folder: string, terminals: ReturnType<typeof term>[], machine: string | null = null) => ({
  id, name: id, folder, machine, active: false, tabs: [{ id: `tb-${id}`, name: '1', terminals }],
})
const hcLs = (terminals: { address: string; cwd: string; state?: string }[]) => ({
  out: JSON.stringify({ terminals: terminals.map((t) => ({ state: 'live', where: 'x / 1', ...t })) }),
})

const wtSpace = space('sp1', wt, [term('t14'), term('t15', 'idle')])
const mainSpace = space('sp0', '/r/repo', [term('t3')])
const liveTerminals = [{ address: 't14', cwd: wt }, { address: 't15', cwd: `${wt}/apps/api` }, { address: 't3', cwd: '/r/repo' }]
const herdrScript: Record<string, Reply> = {
  'herdr-app ls': herdrLs([mainSpace, wtSpace]),
  'hc ls --json': hcLs(liveTerminals),
  'herdr-app do space.close': { out: '{"ok":true}' },
  'herdr-app do space.new': { out: '{"space":"sp9","tab":"tb9","terminal":"t20"}' },
  'herdr-app do tab.new': { out: '{"space":"sp9","tab":"tb10","terminal":"t21"}' },
}
const removeScript: Record<string, Reply> = {
  ...cloneScript,
  'git worktree list --porcelain': {
    out: `worktree /r/repo\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD bbb\nbranch refs/heads/foo\n\n`,
  },
  'git merge-base --is-ancestor': { code: 1 },
  'git merge-tree': { code: 1 },
  ...herdrScript,
}
const opts: RemoveOpts = { worktree: wt, force: false, keepBranch: false, ignoreTeardown: false }
const index = (f: FakeIo, prefix: string) => f.calls.findIndex((c) => c.join(' ').startsWith(prefix))
const doArgs = (f: FakeIo, command: string) => f.calls.filter((c) => c[0] === 'herdr-app' && c[2] === command).map((c) => JSON.parse(c[3]!))

// `hc ls --all` answers "live" for the closed terminals the first time, "finished" after.
function closingTerminals(f: FakeIo) {
  const run = f.run
  let polls = 0
  f.run = async (cmd, o) => {
    if (cmd.join(' ') !== 'hc ls --all --json') return run(cmd, o)
    f.calls.push(cmd)
    const state = polls++ === 0 ? 'live' : 'finished'
    return { code: 0, err: '', ...hcLs(liveTerminals.map((t) => ({ ...t, state: t.address === 't3' ? 'live' : state }))) }
  }
  return () => polls
}

test('spaces: herdr-app ls joined with hc ls by address; a space shows its first terminal cwd', async () => {
  const f = fakeIo({ ...herdrScript, 'herdr-app ls': herdrLs([mainSpace, wtSpace, space('sp7', wt, [term('r1')], 'vps')]) })
  const all = await spaces(f)
  expect(all).toEqual([
    { id: 'sp0', place: '/r/repo', tabs: [{ id: 'tb-sp0', name: '1', terminals: [{ address: 't3', cwd: '/r/repo', state: 'live', status: null }] }] },
    {
      id: 'sp1', place: wt, tabs: [{ id: 'tb-sp1', name: '1', terminals: [
        { address: 't14', cwd: wt, state: 'live', status: null },
        { address: 't15', cwd: `${wt}/apps/api`, state: 'live', status: 'idle' },
      ] }],
    },
  ])
  expect(showing(all, wt).map((s) => s.id)).toEqual(['sp1'])
  // The main checkout's space doesn't show <repo>.worktrees, which only shares a name prefix.
  expect(showing(all, '/r/repo').map((s) => s.id)).toEqual(['sp0'])
})

test('showing: a space of a worktree nested in the main checkout is not the main checkout\'s', () => {
  const inner = '/r/repo/.worktrees/repo/feature'
  const all = [{ id: 'a', place: inner, tabs: [] }, { id: 'b', place: '/r/repo/src', tabs: [] }]
  expect(showing(all, '/r/repo', ['/r/repo', inner]).map((s) => s.id)).toEqual(['b'])
  expect(showing(all, inner, ['/r/repo', inner]).map((s) => s.id)).toEqual(['a'])
})

test('spaces: a first terminal started elsewhere that moved into the repo shows the repo', async () => {
  // hc ls reports t3 where it started; hc get's foreground is where its program runs now.
  const f = fakeIo({
    ...herdrScript,
    'hc ls --json': hcLs([{ address: 't3', cwd: '/elsewhere' }]),
    'hc get t3 --json': { out: JSON.stringify({ address: 't3', cwd: '/elsewhere', foreground: { cwd: '/r/repo' } }) },
  })
  expect(showing(await spaces(f), '/r/repo').map((s) => s.id)).toEqual(['sp0'])
})

test('spaces is null without Herdr: missing binary, failing or non-JSON output', async () => {
  const missing = fakeIo()
  missing.run = async () => {
    throw new Error('Executable not found in $PATH: "herdr-app"')
  }
  expect(await spaces(missing)).toBeNull()
  expect(await spaces(fakeIo({ 'herdr-app ls': { code: 1 } }))).toBeNull()
  expect(await spaces(fakeIo())).toBeNull()
})

test('remove: git accepts removal before space.close, then waits for terminals and removes them', async () => {
  const f = fakeIo(removeScript, { paths: [wt] })
  const polls = closingTerminals(f)
  await remove(f, opts)
  expect(doArgs(f, 'space.close')).toEqual([{ id: 'sp1', confirmed: true }])
  expect(polls()).toBe(2)
  const order = ['git worktree remove', 'herdr-app do space.close', 'hc ls --all --json', 'hc rm t14', 'hc rm t15']
  const at = order.map((p) => index(f, p))
  expect(at.every((i) => i >= 0)).toBe(true)
  expect(at).toEqual([...at].sort((a, b) => a - b))
  // The finished poll comes before the first hc rm.
  expect(f.calls.findLastIndex((c) => c.join(' ') === 'hc ls --all --json')).toBeLessThan(index(f, 'hc rm'))
  expect(f.calls.some((c) => c.join(' ') === 'hc rm t3')).toBe(false)
})

test('remove refuses a working agent unless --force, before teardown', async () => {
  const busy = { 'herdr-app ls': herdrLs([space('sp1', wt, [term('t14', 'working')])]) }
  const files = { '/r/repo/graft.toml': '[hooks]\nteardown = "make down"\n' }
  const f = fakeIo({ ...removeScript, ...busy }, { paths: [wt], files })
  await expect(remove(f, opts)).rejects.toMatchObject({ kind: 'agent-working' })
  expect(f.calls.some((c) => c[0] === 'bash' || c[0] === 'herdr-app' && c[1] === 'do')).toBe(false)

  const forced = fakeIo({ ...removeScript, ...busy }, { paths: [wt], files })
  await remove(forced, { ...opts, force: true })
  expect(doArgs(forced, 'space.close')).toEqual([{ id: 'sp1', confirmed: true }])
})

test('without Herdr, remove and status work as before', async () => {
  const f = fakeIo({ ...removeScript, 'herdr-app ls': { code: 127 } }, { paths: [wt] })
  await remove(f, opts)
  expect(f.calls.some((c) => c[0] === 'herdr-app' && c[1] === 'do')).toBe(false)
  expect(f.calls).toContainEqual(['git', 'worktree', 'remove', wt])
  expect((await status(fakeIo({ ...removeScript, 'herdr-app ls': { code: 127 } }, { paths: [wt] }), wt)).space).toBeNull()
})

test('status reports the space showing the worktree; clean skips it', async () => {
  const r = await status(fakeIo(removeScript, { paths: [wt] }), wt)
  expect(r.space).toEqual({ id: 'sp1', tabs: [{ id: 'tb-sp1', name: '1' }] })
  const merged = { 'git merge-base --is-ancestor': { code: 0 } }
  const c = await clean(fakeIo({ ...removeScript, ...merged }, { paths: [wt] }), { dryRun: true, yes: false })
  expect(c.candidates).toEqual([])
  expect(c.skipped).toEqual([{ path: wt, branch: 'foo', reason: 'open-space' }])
})

test('list gives each row the id of the space showing it, null without one or without Herdr', async () => {
  expect((await list(fakeIo(removeScript, { paths: [wt] }))).map((w) => w.space)).toEqual(['sp0', 'sp1'])
  expect((await list(fakeIo({ ...removeScript, 'herdr-app ls': { code: 1 } }, { paths: [wt] }))).map((w) => w.space)).toEqual([null, null])
})

const createScript: Record<string, Reply> = { ...cloneScript, ...herdrScript, 'herdr-app ls': herdrLs([]) }
const createFiles = { '/r/repo/graft.toml': '[hooks]\nsetup = "make setup"\n\n[agent]\ncommand = ["claude"]\n\n[[tabs]]\ntitle = "dev"\ncommand = "pnpm dev"\n' }

test('create --open herdr: setup runs in a "setup" tab; agent and tabs wait for it; main space opened for nesting', async () => {
  const f = fakeIo(createScript, { files: createFiles })
  const r = await create(f, { branch: 'foo', setup: true, open: 'herdr', task: 'ABC-1 Fix login' })
  expect(r.setup).toEqual({ ran: false, exit: null })
  expect(f.calls.some((c) => c[0] === 'bash')).toBe(false)
  expect(r.herdr).toEqual({ space: 'sp9', tabs: { setup: 'tb9', agent: 'tb10', dev: 'tb10' } })
  expect(doArgs(f, 'space.new')).toEqual([
    { folder: '/r/repo' },
    { folder: wt, tab: 'setup', argv: ['graft', 'setup', '--report'] },
  ])
  expect(doArgs(f, 'tab.new')).toEqual([
    // The task goes to the wrapper, not to Herdr: the agent starts late.
    { space: 'sp9', folder: wt, name: 'agent', argv: ['graft', 'agent', '--wait-setup', '--task=ABC-1 Fix login'] },
    { space: 'sp9', folder: wt, name: 'dev', argv: ['graft', 'agent', '--wait-setup', '--', 'sh', '-c', 'pnpm dev'] },
  ])
  // Herdr is checked before any git work.
  expect(index(f, 'herdr-app ls')).toBeLessThan(index(f, 'git'))
})

test('create --open herdr --setup inline: setup here, then the agent starts at once with Herdr task', async () => {
  const f = fakeIo({ ...createScript, 'herdr-app ls': herdrLs([mainSpace]) }, { files: createFiles })
  const r = await create(f, { branch: 'foo', setup: true, open: 'herdr', setupInline: true, task: 'do it' })
  expect(r.setup).toEqual({ ran: true, exit: 0 })
  expect(index(f, 'bash -e -c make setup')).toBeLessThan(index(f, 'herdr-app do space.new'))
  expect(doArgs(f, 'space.new')).toEqual([{ folder: wt, tab: 'agent', argv: ['claude'], task: 'do it' }])
  expect(doArgs(f, 'tab.new')).toEqual([{ space: 'sp9', folder: wt, name: 'dev', argv: ['sh', '-c', 'pnpm dev'] }])
})

test('create --open herdr fails before any git work without Herdr; bad --open is unsupported', async () => {
  const f = fakeIo({ ...createScript, 'herdr-app ls': { code: 1 } }, { files: createFiles })
  await expect(create(f, { branch: 'foo', setup: true, open: 'herdr' })).rejects.toMatchObject({ kind: 'unsupported' })
  expect(f.calls.some((c) => c[0] === 'git')).toBe(false)
  await expect(create(fakeIo(createScript), { branch: 'foo', setup: true, open: 'tmux' })).rejects.toMatchObject({ kind: 'unsupported' })
  await expect(create(fakeIo(createScript), { branch: 'foo', setup: true, task: 'x' })).rejects.toMatchObject({ kind: 'usage' })
})

const marker = '/r/repo/.git/worktrees/foo/graft-setup-done'
const agentScript = { ...cloneScript, 'git rev-parse --path-format=absolute --git-path graft-setup-done': { out: `${marker}\n` } }

test('setup --report writes ok or failed to the marker', async () => {
  const ok = fakeIo(agentScript, { paths: ['/r/repo'], files: { '/r/repo/graft.toml': '[hooks]\nsetup = "make setup"\n' } })
  await setup(ok, undefined, true)
  expect(await ok.readText(marker)).toBe('ok')
  const bad = fakeIo({ ...agentScript, 'bash -e -c make setup': { code: 2 } }, { paths: ['/r/repo'], files: { '/r/repo/graft.toml': '[hooks]\nsetup = "make setup"\n' } })
  await expect(setup(bad, undefined, true)).rejects.toMatchObject({ kind: 'setup-failed' })
  expect(await bad.readText(marker)).toBe('failed')
})

test('agent --wait-setup: failed setup starts nothing; ok starts the agent and sends the task once idle', async () => {
  const files = { '/r/repo/graft.toml': '[agent]\ncommand = ["claude"]\n' }
  const failed = fakeIo(agentScript, { files: { ...files, [marker]: 'failed' } })
  await expect(agent(failed, { waitSetup: true, command: [] })).rejects.toMatchObject({ kind: 'setup-failed' })
  expect(failed.calls.some((c) => c[0] === 'claude')).toBe(false)

  const f = fakeIo(
    { ...agentScript, 'hc wait t20': { out: '{"ended":true,"exit_code":null,"reason":"status","status":"idle"}' }, claude: { code: 3 } },
    { files: { ...files, [marker]: 'ok\n' }, env: { HC_TERMINAL_ID: 't20' } },
  )
  expect(await agent(f, { waitSetup: true, task: 'ABC-1 Fix login', command: [] })).toBe(3)
  await Bun.sleep(1)
  expect(f.runs.find((r) => r.cmd[0] === 'claude')!.opts).toMatchObject({ stream: true })
  expect(f.calls).toContainEqual(['hc', 'send', 't20', 'ABC-1 Fix login'])
})

test('open selects the space showing the worktree, else makes one', async () => {
  const f = fakeIo(removeScript, { paths: [wt] })
  expect(await open(f, 'foo')).toEqual({ worktree: wt, space: 'sp1', created: false })
  expect(doArgs(f, 'space.select')).toEqual([{ id: 'sp1' }])

  const none = fakeIo({ ...removeScript, 'herdr-app ls': herdrLs([]) }, { paths: [wt] })
  expect(await open(none, 'foo')).toEqual({ worktree: wt, space: 'sp9', created: true })
  expect(doArgs(none, 'space.new')).toEqual([{ folder: '/r/repo' }, { folder: wt }])
})
