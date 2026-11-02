import { GraftError } from './errors.ts'
import { git } from './git.ts'
import type { Io } from './io.ts'

// Optional adapter for the Herdr desktop app (`herdr-app`) and its terminal core (`hc`).
// Nothing here is needed when Herdr is not installed: spaces() is then null.

export type Terminal = { address: string; cwd: string | null; state: string | null; status: string | null }
export type Tab = { id: string; name: string; terminals: Terminal[] }
// place: the folder the space shows, as Herdr's sidebar decides it (first terminal's current cwd, else its folder).
export type Space = { id: string; place: string | null; tabs: Tab[] }

type Json = Record<string, any>

// Runs a command and parses its JSON stdout; null when it is missing, fails or prints no JSON.
// Herdr calls run in home: `graft remove .` has deleted graft's own cwd by the time it closes its space.
async function json(io: Io, cmd: string[]): Promise<Json | null> {
  try {
    const r = await io.run(cmd, { cwd: io.home })
    return r.code === 0 ? JSON.parse(r.out) : null
  } catch {
    return null
  }
}

// This machine's spaces: `herdr-app ls` joined with `hc ls --json` by terminal address,
// which adds each terminal's live cwd and state. null when Herdr isn't there or its window is closed.
export async function spaces(io: Io): Promise<Space[] | null> {
  const app = await json(io, ['herdr-app', 'ls'])
  if (!Array.isArray(app?.spaces)) return null
  const live = new Map<string, Json>(((await json(io, ['hc', 'ls', '--json']))?.terminals ?? []).map((t: Json) => [t.address, t]))
  return Promise.all(
    app.spaces
      .filter((s: Json) => !s.machine)
      .map(async (s: Json): Promise<Space> => {
        const tabs: Tab[] = (s.tabs ?? []).map((tab: Json) => ({
          id: tab.id,
          name: tab.name,
          terminals: (tab.terminals ?? []).map((t: Json) => {
            const core = live.get(t.terminal)
            return { address: t.terminal, cwd: core?.cwd ?? null, state: core?.state ?? null, status: t.status ?? null }
          }),
        }))
        const first = tabs[0]?.terminals[0]
        // `hc ls` cwd is where the terminal started; the sidebar follows where its program is now
        // (`foreground.cwd`, only in `hc get`), e.g. a shell opened elsewhere that cd'd into the repo.
        const now = first ? (await json(io, ['hc', 'get', first.address, '--json']))?.foreground?.cwd : null
        return { id: s.id, place: now ?? first?.cwd ?? s.folder ?? null, tabs }
      }),
  )
}

const within = (place: string, folder: string) => place === folder || place.startsWith(`${folder}/`)

// The spaces showing `folder` or a folder inside it, except one inside another of `worktrees`
// nested in `folder` (a worktrees_dir such as ".worktrees" puts them inside the main checkout).
export function showing(all: Space[] | null, folder: string, worktrees: string[] = []): Space[] {
  const inner = worktrees.filter((w) => w !== folder && within(w, folder))
  return (all ?? []).filter((s) => s.place && within(s.place, folder) && !inner.some((w) => within(s.place!, w)))
}

export async function findSpace(io: Io, folder: string, worktrees: string[] = []): Promise<Space | null> {
  return showing(await spaces(io), folder, worktrees)[0] ?? null
}

// `herdr-app do <command> <json>`: prints what it made ({space, tab, terminal}) or {error} and exits 1.
export async function herdrDo(io: Io, command: string, args: Json): Promise<Json> {
  const r = await io.run(['herdr-app', 'do', command, JSON.stringify(args)], { cwd: io.home })
  let out: Json = {}
  try {
    out = JSON.parse(r.out)
  } catch {}
  if (r.code !== 0 || out.error) throw new Error(`herdr-app do ${command} failed: ${out.error ?? (r.err.trim() || `exit ${r.code}`)}`)
  return out
}

// For `--open herdr`: fails before anything is created when Herdr can't be reached.
export async function requireHerdr(io: Io): Promise<Space[]> {
  const all = await spaces(io)
  if (!all) throw new GraftError('unsupported', 'Herdr is not available: `herdr-app ls` failed', 'install Herdr and open its window, or leave out --open herdr')
  return all
}

// The sidebar nests a worktree's space under its repository only while a space shows the
// main checkout, so one is opened first when none does.
export async function ensureMainSpace(io: Io, all: Space[], main: string, worktrees: string[]): Promise<void> {
  if (!showing(all, main, worktrees).length) await herdrDo(io, 'space.new', { folder: main })
}

// space.close returns before its terminals end, and ended terminals stay in `hc ls --all`
// until removed: wait for them to finish (up to ~5 s), then `hc rm` them.
export async function closeSpace(io: Io, space: Space): Promise<void> {
  await herdrDo(io, 'space.close', { id: space.id, confirmed: true })
  const addresses = space.tabs.flatMap((t) => t.terminals.map((x) => x.address))
  for (let i = 0; i < 50; i++) {
    const all: Json[] = (await json(io, ['hc', 'ls', '--all', '--json']))?.terminals ?? []
    if (!all.some((t) => addresses.includes(t.address) && t.state === 'live')) break
    await io.sleep(100)
  }
  for (const address of addresses) {
    const r = await io.run(['hc', 'rm', address], { cwd: io.home })
    if (r.code !== 0) io.warn(`could not remove terminal ${address}: ${r.err.trim() || `exit ${r.code}`}`)
  }
}

export function working(space: Space): boolean {
  return space.tabs.some((t) => t.terminals.some((x) => x.status === 'working'))
}

// How the setup tab tells the agent tab it is done: `graft setup --report` writes "ok" or
// "failed" here, in the worktree's private git dir (git deletes it with the worktree).
// A file, because a Herdr tab runs its program inside an interactive shell that stays open
// after the program exits, so the setup terminal never ends and `hc wait` can't see the exit.
export async function setupMarker(io: Io, worktree: string): Promise<string> {
  return git(io, worktree, ['rev-parse', '--path-format=absolute', '--git-path', 'graft-setup-done'])
}
