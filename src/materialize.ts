import { dirname, isAbsolute, join } from 'node:path'
import type { Io } from './io.ts'

// Brings gitignored files from the main checkout into a worktree:
// `link` entries become symlinks, `.worktreeinclude` entries become private copies.

export type SkipReason = 'invalid' | 'missing' | 'exists' | 'not-ignored' | 'too-large' | 'error'

export type Files = { linked: string[]; copied: string[]; skipped: { path: string; reason: SkipReason }[] }

const maxBytes = 2 * 1024 ** 3
const maxEntries = 50_000
const maxIncludeLines = 1000

function emptyFiles(): Files {
  return { linked: [], copied: [], skipped: [] }
}

// "./a/b/" -> "a/b"; null for absolute paths, drive prefixes and any ".." segment.
export function safeRel(path: string): string | null {
  const rel = path.trim().replace(/^(\.\/)+/, '').replace(/\/+$/, '')
  if (!rel || rel === '.' || isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) return null
  if (rel.split(/[/\\]/).includes('..')) return null
  return rel
}

// Orca-compatible: one literal path per line, `#` comments; globs and negation are not supported.
export function parseWorktreeInclude(text: string, warn: (m: string) => void): string[] {
  const paths: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (/[*?[]/.test(line) || line.startsWith('!')) {
      warn(`.worktreeinclude: "${line}" skipped, globs and negation are not supported`)
      continue
    }
    if (paths.length === maxIncludeLines) {
      warn(`.worktreeinclude: only the first ${maxIncludeLines} entries are used`)
      break
    }
    paths.push(line)
  }
  return paths
}

// A symlinked folder on the way to `rel` (the branch can track one) would send the write outside the worktree.
function throughSymlink(io: Io, wt: string, rel: string): boolean {
  const parts = rel.split('/')
  return parts.slice(0, -1).some((_, i) => io.readlink(join(wt, ...parts.slice(0, i + 1))) !== null)
}

// Never clobber, not even a broken symlink.
function taken(io: Io, wt: string, rel: string): boolean {
  return io.exists(join(wt, rel)) || io.readlink(join(wt, rel)) !== null
}

// Checked again right before each write: an earlier entry of the same batch ("certs" before
// "certs/dev") can put a symlink on the way or take the path.
function unsafeNow(io: Io, wt: string, rel: string, files: Files): boolean {
  const reason: SkipReason | null = throughSymlink(io, wt, rel) ? 'invalid' : taken(io, wt, rel) ? 'exists' : null
  if (reason) files.skipped.push({ path: rel, reason })
  return reason !== null
}

// The entries that may be materialized: valid, present in main, free in the worktree, gitignored.
async function candidates(io: Io, main: string, wt: string, paths: string[], files: Files, mine: (rel: string) => boolean): Promise<string[]> {
  const present: string[] = []
  const seen = new Set<string>()
  for (const path of paths) {
    const rel = safeRel(path)
    // "certs" and "./certs/" are one entry; a second `ln` would follow the first link into main.
    if (rel && seen.has(rel)) continue
    if (rel) seen.add(rel)
    if (!rel) files.skipped.push({ path, reason: 'invalid' })
    else if (throughSymlink(io, wt, rel)) files.skipped.push({ path: rel, reason: 'invalid' })
    else if (!io.exists(join(main, rel))) files.skipped.push({ path: rel, reason: 'missing' })
    else if (mine(rel)) files.linked.push(rel)
    else if (taken(io, wt, rel)) files.skipped.push({ path: rel, reason: 'exists' })
    else present.push(rel)
  }
  if (!present.length) return []
  // Sources exist by now, so git can tell `.claude` is a directory matching `.claude/`.
  // ponytail: args, not --stdin (Io has no stdin); git quotes paths with tabs, quotes or newlines,
  // so those read as not ignored and are skipped.
  const r = await io.run(['git', '-c', 'core.quotePath=false', 'check-ignore', '--', ...present], { cwd: main })
  if (r.code > 1) {
    io.warn(`git check-ignore failed, nothing copied or linked: ${r.err.trim()}`)
    for (const rel of present) files.skipped.push({ path: rel, reason: 'error' })
    return []
  }
  const ignored = new Set(r.out.split('\n'))
  for (const rel of present) if (!ignored.has(rel)) files.skipped.push({ path: rel, reason: 'not-ignored' })
  return present.filter((rel) => ignored.has(rel))
}

async function mkdirFor(io: Io, target: string): Promise<boolean> {
  return (await io.run(['mkdir', '-p', dirname(target)])).code === 0
}

// Symlinks each path to the main checkout's copy. A link graft made earlier counts as linked again.
export async function linkPaths(io: Io, main: string, wt: string, paths: string[]): Promise<Files> {
  const files = emptyFiles()
  const mine = (rel: string) => io.readlink(join(wt, rel)) === join(main, rel)
  for (const rel of await candidates(io, main, wt, paths, files, mine)) {
    if (unsafeNow(io, wt, rel, files)) continue
    const target = join(wt, rel)
    if ((await mkdirFor(io, target)) && (await io.run(['ln', '-s', '--', join(main, rel), target])).code === 0) {
      files.linked.push(rel)
    } else {
      io.warn(`could not link ${rel}`)
      files.skipped.push({ path: rel, reason: 'error' })
    }
  }
  return files
}

// ponytail: du + find through io.run; a walker that stops at the limit if huge trees ever show up here.
// -H follows a top-level symlink, as copy() does, so a link to a big folder is measured by its content.
// -l counts each hard link, since cp -R writes each one out as its own file.
async function measure(io: Io, path: string): Promise<{ bytes: number; entries: number }> {
  const kb = Number.parseInt((await io.run(['du', '-H', '-l', '-sk', path])).out, 10) || 0
  const entries = (await io.run(['find', '-H', path])).out.split('\n').filter(Boolean).length
  return { bytes: kb * 1024, entries }
}

// Copies the paths listed in the main checkout's .worktreeinclude, within a 2 GiB / 50k entries budget.
export async function copyIncludes(io: Io, main: string, wt: string): Promise<Files> {
  const files = emptyFiles()
  const text = await io.readText(join(main, '.worktreeinclude'))
  if (text === null) return files
  const used = { bytes: 0, entries: 0 }
  for (const rel of await candidates(io, main, wt, parseWorktreeInclude(text, io.warn), files, () => false)) {
    if (unsafeNow(io, wt, rel, files)) continue
    const source = join(main, rel)
    const target = join(wt, rel)
    const size = await measure(io, source)
    if (used.bytes + size.bytes > maxBytes || used.entries + size.entries > maxEntries) {
      io.warn(`${rel} not copied: copies are capped at 2 GiB and ${maxEntries} entries`)
      files.skipped.push({ path: rel, reason: 'too-large' })
      continue
    }
    used.bytes += size.bytes
    used.entries += size.entries
    if ((await mkdirFor(io, target)) && (await copy(io, source, target))) {
      files.copied.push(rel)
    } else {
      io.warn(`could not copy ${rel}`)
      files.skipped.push({ path: rel, reason: 'error' })
    }
  }
  return files
}

// -H follows a top-level symlink, so the worktree gets the file itself. APFS clone first on macOS.
async function copy(io: Io, source: string, target: string): Promise<boolean> {
  if (process.platform === 'darwin') {
    if ((await io.run(['cp', '-c', '-R', '-H', source, target])).code === 0) return true
    await io.run(['rm', '-rf', target]) // a half-done clone; target did not exist before
  }
  if ((await io.run(['cp', '-R', '-H', source, target])).code === 0) return true
  // A partial copy would read as `exists` on the next setup, so the retry could never finish it.
  await io.run(['rm', '-rf', target])
  return false
}

// Links first, so a path in both lists stays a link.
export async function materialize(io: Io, main: string, wt: string, links: string[]): Promise<Files> {
  const linked = await linkPaths(io, main, wt, links)
  const copied = await copyIncludes(io, main, wt)
  return { linked: linked.linked, copied: copied.copied, skipped: [...linked.skipped, ...copied.skipped] }
}

// The configured links that are still graft's symlinks into the main checkout.
export function ownLinks(io: Io, main: string, wt: string, links: string[]): string[] {
  return links.flatMap((path) => {
    const rel = safeRel(path)
    return rel && io.readlink(join(wt, rel)) === join(main, rel) ? [rel] : []
  })
}

// Removes graft's symlinks only; real files and other symlinks stay.
export async function unlinkLinks(io: Io, main: string, wt: string, links: string[]): Promise<void> {
  for (const rel of ownLinks(io, main, wt, links)) {
    // cwd: graft's own may be a worktree clean already removed.
    const r = await io.run(['rm', '--', join(wt, rel)], { cwd: main })
    if (r.code !== 0) io.warn(`could not unlink ${rel}: ${r.err.trim()}`)
  }
}
