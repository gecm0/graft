import { dirname, join } from 'node:path'
import { userConfigPath } from '../config.ts'
import { GraftError } from '../errors.ts'
import { compiled, type Io } from '../io.ts'

// The mods graft ships, in the repo's herdr/mods/: the picker, the side panel, and a clone of
// Herdr's tab bar with a Worktrees button. Herdr's own layouts and mods refuse edits, so the
// panel comes with a clone of the `main` layout (herdr/layouts/graft.json) that shows both.
export const mods = ['graft-new', 'graft-panel', 'graft-tabs']
export const layout = 'graft'
export const binding = { keys: 'cmd-g', action: 'mod.open:graft-new' }
// Herdr doesn't load SVGs through a symlinked mod folder, so the Worktrees button's icon is copied
// (overwritten every run) to a real folder in Herdr's home, where graft-tabs and other tab bars find it.
export const icon = 'graft-icons/graft.svg'

// Run from the repository (bun link), the mods are next to the TypeScript.
export const modsSource = join(import.meta.dir, '..', '..', 'herdr', 'mods')

// The compiled binary carries herdr/ inside it (`bun build --asset herdr`), where Herdr can't read
// it, so it writes those files out to ~/.config/graft/herdr (graft's own folder, overwritten every
// time) and links them from there. Returns that copy's mods folder.
export async function unpackMods(io: Io, files: readonly { name?: string; arrayBuffer(): Promise<ArrayBuffer> }[]): Promise<string> {
  const root = dirname(userConfigPath(io))
  for (const f of files) {
    if (f.name?.startsWith('herdr/')) await io.writeText(join(root, f.name), new Uint8Array(await f.arrayBuffer()))
  }
  return join(root, 'herdr', 'mods')
}

export type ModStatus = 'linked' | 'present' | 'exists'
// added: written to keys.json; present: already bound to the picker; taken: bound to something else
// (left alone); declined: "no" at the prompt, or no terminal without --yes; missing: no keys.json.
export type KeyStatus = 'added' | 'present' | 'taken' | 'declined' | 'missing'

export type InstallResult = {
  home: string
  mods: { name: string; path: string; status: ModStatus }[]
  layout: { name: string; path: string; status: ModStatus }
  icon: string | null
  key: { keys: string; action: string; status: KeyStatus; current?: string }
}

// graft herdr install: symlinks graft's mods and layout into Herdr's folder, then asks before
// binding cmd-g to the picker in keys.json. Nothing that is already there is replaced.
// The layout is not switched to: that is the person's choice (cmd-shift-l in Herdr).
export async function herdrInstall(io: Io, opts: { yes: boolean; source?: string }): Promise<InstallResult> {
  const home = io.env.HERDR_APP_HOME || join(io.home, '.config', 'herdr-app')
  if (!io.exists(home)) throw new GraftError('unsupported', `Herdr's folder ${home} does not exist`, 'install Herdr and open it once, or set HERDR_APP_HOME')
  const source = opts.source ?? (compiled ? await unpackMods(io, Bun.embeddedFiles) : modsSource)

  const linked: InstallResult['mods'] = []
  for (const name of mods) linked.push({ name, ...(await link(io, join(source, name), join(home, 'mods', name))) })
  const file = `${layout}.json`
  const shown = { name: layout, ...(await link(io, join(source, '..', 'layouts', file), join(home, 'layouts', file))) }
  const svgPath = join(source, 'graft-panel', 'graft.svg')
  const svg = await io.readText(svgPath)
  if (svg === null) io.warn(`${svgPath} is missing; the Worktrees button has no icon`)
  else await io.writeText(join(home, icon), svg)
  const result: InstallResult = { home, mods: linked, layout: shown, icon: svg === null ? null : join(home, icon), key: { ...binding, status: 'missing' } }

  const keysPath = join(home, 'keys.json')
  const text = await io.readText(keysPath)
  // No keys.json: Herdr may read the file as the whole binding set, so graft doesn't start one.
  if (text === null) return result
  let keys: Record<string, Record<string, string>>
  try {
    keys = JSON.parse(text)
  } catch (e) {
    throw new GraftError('usage', `${keysPath} is not valid JSON: ${(e as Error).message}`, 'fix it, then rerun graft herdr install')
  }
  // An array root would drop the new binding on stringify; null would crash on keys.global.
  const isObject = (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v)
  if (!isObject(keys) || (keys.global !== undefined && !isObject(keys.global))) {
    throw new GraftError('usage', `${keysPath} must be a JSON object, with "global" an object when present`, 'fix it, then rerun graft herdr install')
  }
  const current = keys.global?.[binding.keys]
  if (current === binding.action) result.key.status = 'present'
  else if (current !== undefined) result.key = { ...binding, status: 'taken', current }
  else if (opts.yes || (io.isTTY && (await io.ask(`Bind ${binding.keys} to the graft picker in ${keysPath}?`)))) {
    keys.global = { ...keys.global, [binding.keys]: binding.action }
    await io.writeText(keysPath, `${JSON.stringify(keys, null, 2)}\n`)
    result.key.status = 'added'
  } else result.key.status = 'declined'
  return result
}

// Symlinks from → path unless something is already at path; graft's own link is `present`.
async function link(io: Io, from: string, path: string): Promise<{ path: string; status: ModStatus }> {
  const current = io.readlink(path)
  if (current === from) return { path, status: 'present' }
  if (current !== null || io.exists(path)) {
    io.warn(`${path} already exists and is not graft's; left alone`)
    return { path, status: 'exists' }
  }
  await io.run(['mkdir', '-p', dirname(path)])
  const r = await io.run(['ln', '-s', '--', from, path])
  if (r.code !== 0) throw new GraftError('unsupported', `could not link ${path}: ${r.err.trim() || `exit ${r.code}`}`)
  return { path, status: 'linked' }
}
