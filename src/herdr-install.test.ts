import { expect, test } from 'bun:test'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { herdrInstall, modsSource, unpackMods } from './commands/herdr-install.ts'
import { systemIo } from './io.ts'
import { fakeIo } from './test/fake-io.ts'

const home = '/home/me/.config/herdr-app'
const keys = `${home}/keys.json`
const src = '/src/herdr/mods'

test('links the mod, and binds the key only with --yes or a yes', async () => {
  const io = fakeIo({}, { paths: [home], files: { [keys]: '{"global":{"cmd-n":"space.new"}}' } })
  const r = await herdrInstall(io, { yes: false, source: src, os: 'darwin' })
  // Herdr may not have made mods/ or layouts/ yet.
  expect(io.calls).toContainEqual(['mkdir', '-p', `${home}/layouts`])
  expect(io.calls.filter((c) => c[0] === 'ln')).toEqual([
    ...['graft-new', 'graft-panel', 'graft-tabs'].map((m) => ['ln', '-s', '--', `${src}/${m}`, `${home}/mods/${m}`]),
    ['ln', '-s', '--', '/src/herdr/layouts/graft.json', `${home}/layouts/graft.json`],
  ])
  expect(r.mods[0]).toEqual({ name: 'graft-new', path: `${home}/mods/graft-new`, status: 'linked' })
  expect(r.layout).toEqual({ name: 'graft', path: `${home}/layouts/graft.json`, status: 'linked' })
  // No icon in this fake source: warned, not fatal.
  expect(r.icon).toBeNull()
  // Not a terminal and no --yes: nothing asked, nothing written.
  expect(r.key.status).toBe('declined')
  expect(io.questions).toEqual([])

  const tty = fakeIo({}, { paths: [home], files: { [keys]: '{"global":{"cmd-n":"space.new"}}' }, tty: true, answer: true })
  expect((await herdrInstall(tty, { yes: false, source: src, os: 'darwin' })).key.status).toBe('added')
  expect(tty.questions).toHaveLength(1)
  expect(JSON.parse((await tty.readText(keys))!)).toEqual({ global: { 'cmd-n': 'space.new', 'cmd-g': 'mod.open:graft-new' } })
})

test('never replaces a binding, a mod folder or a missing keys.json', async () => {
  const taken = fakeIo({}, { paths: [home, `${home}/mods/graft-new`, `${home}/layouts/graft.json`], files: { [keys]: '{"global":{"cmd-g":"tab.new"}}' } })
  const r = await herdrInstall(taken, { yes: true, source: src, os: 'darwin' })
  expect([r.mods[0]!.status, r.layout.status]).toEqual(['exists', 'exists'])
  expect(r.key).toMatchObject({ status: 'taken', current: 'tab.new' })
  expect(taken.calls.filter((c) => c[0] === 'ln').map((c) => c.at(-1))).toEqual([`${home}/mods/graft-panel`, `${home}/mods/graft-tabs`])
  expect(JSON.parse((await taken.readText(keys))!)).toEqual({ global: { 'cmd-g': 'tab.new' } })

  const ours = fakeIo({}, { paths: [home], links: { [`${home}/mods/graft-new`]: `${src}/graft-new` }, files: { [keys]: '{"global":{"cmd-g":"mod.open:graft-new"}}' } })
  const again = await herdrInstall(ours, { yes: true, source: src, os: 'darwin' })
  expect([again.mods[0]!.status, again.key.status]).toEqual(['present', 'present'])

  expect((await herdrInstall(fakeIo({}, { paths: [home] }), { yes: true, source: src, os: 'darwin' })).key.status).toBe('missing')

  for (const text of ['[]', 'null', '{"global":[]}']) {
    const odd = fakeIo({}, { paths: [home], files: { [keys]: text } })
    await expect(herdrInstall(odd, { yes: true, source: src, os: 'darwin' })).rejects.toMatchObject({ kind: 'usage' })
    expect(await odd.readText(keys)).toBe(text)
  }
})

for (const [os, shortcut] of [['linux', 'ctrl-shift-g'], ['darwin', 'cmd-g']] as const) {
  test(`binds ${shortcut} on ${os}, preserving existing shortcuts`, async () => {
    const global = { 'cmd-g': 'mod.open:graft-new', 'ctrl-g': 'terminal.action' }
    const io = fakeIo({}, { paths: [home], files: { [keys]: JSON.stringify({ global }) } })
    const opts = { yes: true, source: src, os }
    expect((await herdrInstall(io, opts)).key).toMatchObject({
      keys: shortcut, status: os === 'linux' ? 'added' : 'present',
    })
    expect(JSON.parse((await io.readText(keys))!)).toEqual({ global: { ...global, [shortcut]: 'mod.open:graft-new' } })
    expect((await herdrInstall(io, opts)).key.status).toBe('present')

    const occupied = JSON.stringify({ global: { [shortcut]: 'tab.new' } })
    await io.writeText(keys, occupied)
    expect((await herdrInstall(io, opts)).key.status).toBe('taken')
    expect(await io.readText(keys)).toBe(occupied)
  })
}

test('copies the icon to a real folder, since Herdr reads no SVG through a symlinked mod', async () => {
  const io = fakeIo({}, { paths: [home], files: { [`${src}/graft-panel/graft.svg`]: '<svg/>' } })
  const r = await herdrInstall(io, { yes: true, source: src, os: 'darwin' })
  expect(r.icon).toBe(`${home}/graft-icons/graft.svg`)
  expect(await io.readText(`${home}/graft-icons/graft.svg`)).toBe('<svg/>')
})

test('the compiled binary writes its embedded herdr/ files to ~/.config/graft/herdr', async () => {
  const io = fakeIo()
  const files = [new File(['export default 1'], 'herdr/mods/graft-new/main.js'), new File(['{}'], 'herdr/layouts/graft.json'), new File(['x'], 'other.txt')]
  expect(await unpackMods(io, files)).toBe('/home/me/.config/graft/herdr/mods')
  expect(await io.readText('/home/me/.config/graft/herdr/mods/graft-new/main.js')).toBe('export default 1')
  expect(await io.readText('/home/me/.config/graft/herdr/layouts/graft.json')).toBe('{}')
  expect(io.exists('/home/me/.config/graft/other.txt')).toBe(false)
})

test('HERDR_APP_HOME picks the folder; a missing one is unsupported', async () => {
  const io = fakeIo({}, { env: { HERDR_APP_HOME: '/elsewhere' } })
  await expect(herdrInstall(io, { yes: true })).rejects.toMatchObject({ kind: 'unsupported' })
})

// Real files in a temp folder standing in for ~/.config/herdr-app; the real one is never touched.
test('real: symlinks the repo mod and merges the key into keys.json', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'graft-herdr-')))
  try {
    const app = join(dir, 'herdr-app')
    mkdirSync(join(app, 'mods'), { recursive: true })
    mkdirSync(join(app, 'layouts'))
    writeFileSync(join(app, 'keys.json'), '{\n  "global": {\n    "cmd-n": "space.new"\n  },\n  "terminal": {\n    "alt-left": "send:\\u001bb"\n  }\n}\n')
    const io = systemIo({ HOME: dir, HERDR_APP_HOME: app, PATH: process.env.PATH }, dir)
    const r = await herdrInstall(io, { yes: true })
    expect(r.mods[0]!.status).toBe('linked')
    expect(lstatSync(join(app, 'mods', 'graft-new')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(app, 'mods', 'graft-new'))).toBe(join(modsSource, 'graft-new'))
    expect(lstatSync(join(modsSource, 'graft-new', 'main.js')).isFile()).toBe(true)
    expect(r.mods.map((m) => m.status)).toEqual(['linked', 'linked', 'linked'])
    // The layout link resolves to the repo's clone, which shows the panel and the tab bar with its button.
    const shown = JSON.parse(readFileSync(join(app, 'layouts', 'graft.json'), 'utf8'))
    expect(JSON.stringify(shown)).toContain('"mod":"graft-panel"')
    expect(JSON.stringify(shown)).toContain('"mod":"graft-tabs"')
    const written = JSON.parse(readFileSync(join(app, 'keys.json'), 'utf8'))
    expect(written).toEqual({ global: { 'cmd-n': 'space.new', [process.platform === 'linux' ? 'ctrl-shift-g' : 'cmd-g']: 'mod.open:graft-new' }, terminal: { 'alt-left': 'send:\u001bb' } })
    // Run twice: nothing changes.
    const again = await herdrInstall(io, { yes: true })
    expect([...again.mods.map((m) => m.status), again.layout.status, again.key.status]).toEqual(['present', 'present', 'present', 'present', 'present'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
