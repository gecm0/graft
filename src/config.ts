import { join, resolve } from 'node:path'
import { GraftError } from './errors.ts'
import type { Io } from './io.ts'

export type RepoConfig = {
  remote?: string
  link: string[]
  hooks: { setup?: string; teardown?: string }
  branch: { template?: string }
  tabs: { title: string; command?: string }[]
  agent?: { command: string[] }
}

export type UserConfig = {
  user?: string
  worktrees_dir?: string
  repos: Record<string, RepoConfig>
  linear?: { api_key?: string }
  jira?: { site?: string; email?: string; api_token?: string }
}

const repoKeys = ['remote', 'link', 'hooks', 'branch', 'tabs', 'agent']
const userKeys = ['user', 'worktrees_dir', 'repos', 'linear', 'jira']

type Table = Record<string, unknown>

function isTable(v: unknown): v is Table {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function bad(source: string, key: string, expected: string): never {
  throw new GraftError('usage', `${source}: "${key}" must be ${expected}`)
}

function str(t: Table, key: string, source: string, prefix = ''): string | undefined {
  const v = t[key]
  if (v === undefined) return undefined
  if (typeof v !== 'string') bad(source, prefix + key, 'a string')
  return v
}

function strList(v: unknown, key: string, source: string): string[] {
  if (v === undefined) return []
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) bad(source, key, 'a list of strings')
  return v as string[]
}

function table(t: Table, key: string, source: string): Table {
  const v = t[key] ?? {}
  if (!isTable(v)) bad(source, key, 'a table')
  return v
}

function warnUnknown(io: Io, t: Table, known: string[], source: string) {
  for (const key of Object.keys(t)) if (!known.includes(key)) io.warn(`${source}: unknown key "${key}" ignored`)
}

export function parseRepoConfig(io: Io, raw: Table, source: string): RepoConfig {
  warnUnknown(io, raw, repoKeys, source)
  const hooks = table(raw, 'hooks', source)
  warnUnknown(io, hooks, ['setup', 'teardown'], `${source} [hooks]`)
  const branch = table(raw, 'branch', source)
  warnUnknown(io, branch, ['template'], `${source} [branch]`)
  const tabs = raw.tabs ?? []
  if (!Array.isArray(tabs) || !tabs.every(isTable)) bad(source, 'tabs', 'an array of tables ([[tabs]])')
  for (const tab of tabs) warnUnknown(io, tab, ['title', 'command'], `${source} [[tabs]]`)
  const agent = raw.agent === undefined ? undefined : table(raw, 'agent', source)
  if (agent) warnUnknown(io, agent, ['command'], `${source} [agent]`)
  return {
    remote: str(raw, 'remote', source),
    link: strList(raw.link, 'link', source),
    hooks: { setup: str(hooks, 'setup', source, 'hooks.'), teardown: str(hooks, 'teardown', source, 'hooks.') },
    branch: { template: str(branch, 'template', source, 'branch.') },
    tabs: tabs.map((tab) => {
      const title = str(tab, 'title', source, 'tabs.')
      if (!title) bad(source, 'tabs.title', 'a non-empty string')
      return { title, command: str(tab, 'command', source, 'tabs.') }
    }),
    agent: agent && { command: strList(agent.command, 'agent.command', source) },
  }
}

async function readToml(io: Io, path: string): Promise<Table | null> {
  const text = await io.readText(path)
  if (text === null) return null
  try {
    return Bun.TOML.parse(text) as Table
  } catch {
    // Parser messages can quote credentials from the invalid input.
    throw new GraftError('usage', `${path}: invalid TOML`)
  }
}

export function userConfigPath(io: Io): string {
  return join(io.env.XDG_CONFIG_HOME || join(io.home, '.config'), 'graft', 'config.toml')
}

export async function loadUserConfig(io: Io): Promise<UserConfig> {
  const path = userConfigPath(io)
  const raw = (await readToml(io, path)) ?? {}
  warnUnknown(io, raw, userKeys, path)
  const repos = table(raw, 'repos', path)
  const linear = raw.linear === undefined ? undefined : table(raw, 'linear', path)
  if (linear) warnUnknown(io, linear, ['api_key'], `${path} [linear]`)
  const jira = raw.jira === undefined ? undefined : table(raw, 'jira', path)
  if (jira) warnUnknown(io, jira, ['site', 'email', 'api_token'], `${path} [jira]`)
  return {
    user: str(raw, 'user', path),
    worktrees_dir: str(raw, 'worktrees_dir', path),
    repos: Object.fromEntries(
      Object.entries(repos).map(([key, value]) => {
        if (!isTable(value)) bad(path, `repos."${key}"`, 'a table')
        return [key, parseRepoConfig(io, value, `${path} [repos."${key}"]`)]
      }),
    ),
    linear: linear && { api_key: str(linear, 'api_key', path, 'linear.') },
    jira: jira && {
      site: str(jira, 'site', path, 'jira.'),
      email: str(jira, 'email', path, 'jira.'),
      api_token: str(jira, 'api_token', path, 'jira.'),
    },
  }
}

// A token from the environment, else from the user config. A token read from the file warns
// when the file is readable by anyone but you.
export function secret(io: Io, env: string, fromFile: string | undefined, key: string): string {
  const fromEnv = io.env[env]?.trim()
  if (fromEnv) return fromEnv
  const path = userConfigPath(io)
  if (!fromFile) throw new GraftError('usage', `no ${key}`, `set ${env}, or ${key} in ${path} (chmod 600)`)
  const mode = io.mode(path)
  if (mode !== null && mode & 0o077) io.warn(`${path} holds tokens but has mode ${mode.toString(8)}; run: chmod 600 ${path}`)
  return fromFile
}

export function expandHome(io: Io, p: string): string {
  return p === '~' || p.startsWith('~/') ? join(io.home, p.slice(1)) : p
}

// The main checkout's graft.toml wins; otherwise the user config's [repos."<path>"] entry.
// Never merged: when both exist the private entry is ignored, with a warning.
export async function loadRepoConfig(io: Io, main: string, user?: UserConfig): Promise<RepoConfig> {
  user ??= await loadUserConfig(io)
  const file = join(main, 'graft.toml')
  const raw = await readToml(io, file)
  // ponytail: plain path compare after ~ expansion; resolve symlinked keys if that ever bites.
  const entry = Object.entries(user.repos).find(([key]) => resolve(expandHome(io, key)) === main)
  if (raw) {
    if (entry) io.warn(`${file} exists, so [repos."${entry[0]}"] in ${userConfigPath(io)} is ignored`)
    return parseRepoConfig(io, raw, file)
  }
  return entry?.[1] ?? parseRepoConfig(io, {}, file)
}
