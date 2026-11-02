import { basename, dirname, join, resolve } from 'node:path'
import { expandHome } from './config.ts'
import type { Io } from './io.ts'

// "alice/Fix login!" -> "alice-Fix-login"
export function slugify(name: string): string {
  return name
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[-.]+|[-.]+$/g, '')
}

// <repo parent>/<repo>.worktrees/<slug>, or <worktrees_dir>/<repo>/<slug>; -2, -3 on collision.
// A relative worktrees_dir is relative to the main checkout, wherever graft runs from.
// `registered`: worktree paths git still holds, even when their folder was deleted by hand.
export function worktreePath(io: Io, main: string, name: string, worktreesDir?: string, registered: string[] = []): string {
  const repo = basename(main)
  const dir = worktreesDir ? join(resolve(main, expandHome(io, worktreesDir)), repo) : join(dirname(main), `${repo}.worktrees`)
  const slug = slugify(name) || 'worktree'
  let path = join(dir, slug)
  for (let n = 2; io.exists(path) || io.readlink(path) !== null || registered.includes(path); n++) path = join(dir, `${slug}-${n}`)
  return path
}
