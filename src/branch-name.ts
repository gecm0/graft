import { GraftError } from './errors.ts'
import type { Io } from './io.ts'

// Branch names for --title (and later tickets) come from a template; --branch never does.

export type NameVars = { user?: string; key?: string; slug?: string; date?: string; linear?: string }

export const defaultTemplate = '{key}-{slug}'

const vars = ['user', 'key', 'slug', 'date', 'linear']

// Empty variables drop together with the separators they leave dangling:
// "{user}/{key}-{slug}" with no key -> "alice/fix-login", with no user either -> "fix-login".
export function render(template: string, values: NameVars): string {
  const out = template.replace(/\{([^}]*)\}/g, (_, name: string) => {
    if (!vars.includes(name)) {
      throw new GraftError('usage', `branch template "${template}": unknown variable {${name}}`, `use ${vars.map((v) => `{${v}}`).join(', ')}`)
    }
    return values[name as keyof NameVars] ?? ''
  })
  return out
    .replace(/[-_.]*\/[-_./]*/g, '/')
    .replace(/([-_.])[-_.]+/g, '$1')
    .replace(/^[-_./]+|[-_./]+$/g, '')
}

// "Fix the Login page!" -> "fix-the-login-page"; accents folded, at most 48 characters.
export function slug(text: string, max = 48): string {
  const trim = (s: string) => s.replace(/^-+|-+$/g, '')
  const plain = text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  return trim(trim(plain.replace(/[^a-z0-9]+/g, '-')).slice(0, max))
}

// {user}: the user config's `user`, else git's github.user, else user.email before the "@".
export async function templateUser(io: Io, cwd: string, configured?: string): Promise<string> {
  if (configured) return configured
  const get = async (key: string) => (await io.run(['git', 'config', '--get', key], { cwd })).out.trim()
  return (await get('github.user')) || ((await get('user.email')).split('@')[0] ?? '')
}

export function today(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// A ticket's key ("ABC-123") and, for Linear, its suggested branch name.
export type Ticket = { key: string; linear?: string }

// --title and tickets: slug the title and render the repo's template.
export async function titleBranch(io: Io, cwd: string, title: string, template = defaultTemplate, user?: string, ticket?: Ticket): Promise<string> {
  const s = slug(title)
  if (!s && !ticket) throw new GraftError('usage', `title "${title}" has no letters or digits to name a branch`)
  const name = render(template, {
    user: template.includes('{user}') ? await templateUser(io, cwd, user) : '',
    key: ticket?.key.toLowerCase(),
    slug: s,
    date: today(),
    linear: ticket?.linear,
  })
  if (!name) throw new GraftError('usage', `branch template "${template}" gives an empty name for "${title}"`)
  return name
}
