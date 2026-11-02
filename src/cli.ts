#!/usr/bin/env bun
import { parseArgs } from 'node:util'
import { agent } from './commands/agent.ts'
import { clean } from './commands/clean.ts'
import { create } from './commands/create.ts'
import { init } from './commands/init.ts'
import { herdrInstall } from './commands/herdr-install.ts'
import { list } from './commands/list.ts'
import { open } from './commands/open.ts'
import { remove } from './commands/remove.ts'
import { search } from './commands/search.ts'
import { setup, teardown } from './commands/setup.ts'
import { status } from './commands/status.ts'
import { update } from './commands/update.ts'
import { exitCodes, GraftError, type ErrorKind } from './errors.ts'
import type { Pr } from './forge/forge.ts'
import { compiled, systemIo, type Io } from './io.ts'
import pkg from '../package.json'

const usage = `graft: git worktrees with per-repo setup and teardown

usage:
  graft create --branch <name> | --title <text> [--base <branch> | --from <worktree>] [--name <dir>] [--no-setup] [--json]
  graft create --remote <branch> | --pr <number|url> [--name <dir>] [--no-setup] [--json]
  graft create --linear <ID> | --jira <KEY> [--base <branch> | --from <worktree>] [--name <dir>] [--no-setup] [--json]
      create also takes: --open herdr [--setup inline] [--task <text>]
  graft open <worktree> [--open herdr] [--json]
  graft agent [--wait-setup] [--task <text>] [-- <command>...]
  graft setup [path] [--report] [--json]
  graft teardown [path] [--json]
  graft remove <worktree> [--force] [--keep-branch] [--ignore-teardown] [--json]
  graft list [--pr] [--json]
  graft status [worktree] [--json]
  graft clean [<worktree>...] [--dry-run] [--yes] [--json]
  graft search branches|prs|linear|jira [query] [--json]
  graft herdr install [--yes] [--json]
  graft init [--json]
  graft update [--json]
  graft --version

<worktree> is a path, a branch name or a worktree folder name.

stdout is a human summary, or with --json exactly one JSON object.
Progress and hook output go to stderr.`

type Command = { options: Record<string, { type: 'string' | 'boolean' }>; run(io: Io, a: Args): Promise<{ json: unknown; text: string; code?: number }> }
type Args = { values: Record<string, string | boolean | undefined>; positionals: string[] }

const commands: Record<string, Command> = {
  create: {
    options: {
      branch: { type: 'string' },
      title: { type: 'string' },
      remote: { type: 'string' },
      pr: { type: 'string' },
      linear: { type: 'string' },
      jira: { type: 'string' },
      base: { type: 'string' },
      from: { type: 'string' },
      name: { type: 'string' },
      'no-setup': { type: 'boolean' },
      open: { type: 'string' },
      setup: { type: 'string' },
      task: { type: 'string' },
    },
    async run(io, { values, positionals }) {
      // `--title Fix login` would otherwise create "Fix" and drop "login" without a word.
      if (positionals.length) throw new GraftError('usage', `create takes no arguments, got "${positionals.join(' ')}"`, 'quote values with spaces: graft create --title "Fix login"')
      const str = (k: string) => values[k] as string | undefined
      const r = await create(io, {
        branch: str('branch'),
        title: str('title'),
        remote: str('remote'),
        pr: str('pr'),
        linear: str('linear'),
        jira: str('jira'),
        base: str('base'),
        from: str('from'),
        name: str('name'),
        setup: !values['no-setup'],
        open: str('open'),
        setupInline: inline(str('setup')),
        task: str('task'),
      })
      const { linked, copied, skipped } = r.files
      const files = linked.length || copied.length || skipped.length ? `\n${linked.length} linked, ${copied.length} copied, ${skipped.length} skipped` : ''
      const from = r.base ? ` from ${r.base}` : ' (existing branch)'
      const herdr = r.herdr ? `\nHerdr space ${r.herdr.space}${r.herdr.tabs.setup ? ', setup running in its "setup" tab' : ''}` : ''
      return { json: r, text: `${r.worktree}\n${r.branch}${from}${r.setup.ran ? ', setup ok' : ''}${files}${herdr}` }
    },
  },
  setup: {
    options: { report: { type: 'boolean' } },
    async run(io, { values, positionals }) {
      if (positionals.length > 1) throw new GraftError('usage', 'setup takes at most one path', 'graft setup [path]')
      const r = await setup(io, positionals[0], !!values.report)
      return { json: r, text: r.setup.ran ? `setup ok in ${r.worktree}` : `no setup hook for ${r.worktree}` }
    },
  },
  teardown: {
    options: {},
    async run(io, { positionals }) {
      if (positionals.length > 1) throw new GraftError('usage', 'teardown takes at most one path', 'graft teardown [path]')
      const r = await teardown(io, positionals[0])
      return { json: r, text: r.teardown.ran ? `teardown ok in ${r.worktree}` : `no teardown hook for ${r.worktree}` }
    },
  },
  remove: {
    options: { force: { type: 'boolean' }, 'keep-branch': { type: 'boolean' }, 'ignore-teardown': { type: 'boolean' } },
    async run(io, { values, positionals }) {
      if (positionals.length !== 1) throw new GraftError('usage', 'remove needs exactly one worktree', 'graft remove <path|branch>')
      const r = await remove(io, {
        worktree: positionals[0]!,
        force: !!values.force,
        keepBranch: !!values['keep-branch'],
        ignoreTeardown: !!values['ignore-teardown'],
      })
      const b = r.branch
      const branch = !b ? 'detached, no branch' : b.deleted ? `branch ${b.name} deleted (merged)` : `branch ${b.name} kept (${b.reason}, head ${b.head.slice(0, 12)})`
      return { json: r, text: `removed ${r.removed}\n${branch}` }
    },
  },
  open: {
    options: { open: { type: 'string' } },
    async run(io, { values, positionals }) {
      if (positionals.length !== 1) throw new GraftError('usage', 'open needs exactly one worktree', 'graft open <path|branch>')
      const r = await open(io, positionals[0]!, values.open as string | undefined)
      return { json: r, text: `${r.created ? 'opened a new space' : 'showing space'} ${r.space} for ${r.worktree}` }
    },
  },
  agent: {
    options: { 'wait-setup': { type: 'boolean' }, task: { type: 'string' } },
    async run(io, { values, positionals }) {
      const code = await agent(io, { waitSetup: !!values['wait-setup'], task: values.task as string | undefined, command: positionals })
      return { json: { exit: code }, text: '', code }
    },
  },
  clean: {
    options: { 'dry-run': { type: 'boolean' }, yes: { type: 'boolean' } },
    async run(io, { values, positionals }) {
      const r = await clean(io, { dryRun: !!values['dry-run'], yes: !!values.yes, paths: positionals.length ? positionals : undefined })
      const lines = r.dryRun
        ? r.candidates.map((c) => `would remove ${c.path} (${c.branch})`)
        : r.removed.map((x) => `removed ${x.path}${x.branch?.deleted ? `, branch ${x.branch.name} deleted` : ''}`)
      lines.push(...r.failed.map((f) => `failed ${f.path}: ${f.error.message}`))
      lines.push(...r.skipped.map((s) => `skipped ${s.path}: ${s.reason}`))
      if (!r.candidates.length) lines.unshift('nothing to clean')
      // A partial failure still prints the full result, but doesn't exit 0.
      const failed = r.failed[0]?.error.kind
      return { json: r, text: lines.join('\n'), code: failed ? (exitCodes[failed as ErrorKind] ?? 1) : 0 }
    },
  },
  list: {
    options: { pr: { type: 'boolean' } },
    async run(io, { values, positionals }) {
      if (positionals.length) throw new GraftError('usage', 'list takes no arguments', 'graft list [--pr]')
      const rows = await list(io, !!values.pr)
      const text = rows.map((w) => [w.path, w.branch ?? '(detached)', ...flags(w), ...(w.space ? ['[space]'] : []), ...(w.pr ? [prLine(w.pr)] : [])].join('  '))
      return { json: rows, text: text.join('\n') }
    },
  },
  search: {
    options: {},
    async run(io, { positionals }) {
      if (positionals.length > 2) throw new GraftError('usage', 'search takes a kind and at most one query', 'graft search branches "fix login"')
      const r = await search(io, positionals[0], positionals[1])
      const text = r.kind === 'prs'
        ? r.hits.map((p) => `${prLine(p)}  ${p.head}  ${p.title}`)
        : r.kind === 'linear'
          ? r.hits.map((i) => `${i.identifier}  ${i.state}  ${i.title}`)
          : r.kind === 'jira'
            ? r.hits.map((i) => `${i.key}  ${i.status}  ${i.summary}`)
            : r.hits.map((h) => `${h.where === 'local' ? h.name : h.ref.replace(/^refs\/remotes\//, '')}  ${h.where}  ${h.date}`)
      return { json: r.hits, text: text.join('\n') }
    },
  },
  herdr: {
    options: { yes: { type: 'boolean' } },
    async run(io, { values, positionals }) {
      if (positionals.join(' ') !== 'install') throw new GraftError('usage', 'the only herdr command is install', 'graft herdr install [--yes]')
      const r = await herdrInstall(io, { yes: !!values.yes })
      const key = {
        added: `bound ${r.key.keys} to the picker`,
        present: `${r.key.keys} already opens the picker`,
        taken: `${r.key.keys} is bound to ${r.key.current}; left alone (bind ${r.key.action} to a free key in keys.json)`,
        declined: `${r.key.keys} not bound (rerun with --yes, or add "${r.key.keys}": "${r.key.action}" to keys.json)`,
        missing: `no keys.json in ${r.home}; ${r.key.keys} not bound`,
      }[r.key.status]
      const layout = `${r.layout.status} ${r.layout.path}${r.layout.status === 'exists' ? '' : ` (switch to it in Herdr with cmd-shift-l for the Worktrees panel)`}`
      return { json: r, text: [...r.mods.map((m) => `${m.status} ${m.path}`), layout, key].join('\n') }
    },
  },
  init: {
    options: {},
    async run(io, { positionals }) {
      if (positionals.length) throw new GraftError('usage', 'init takes no arguments', 'graft init')
      const r = await init(io)
      return { json: r, text: r.created ? `created ${r.path} (mode 600); uncomment what you need` : `${r.path} already exists, left as is (mode set to 600)` }
    },
  },
  update: {
    options: {},
    async run(io, { positionals }) {
      if (positionals.length) throw new GraftError('usage', 'update takes no arguments', 'graft update')
      const r = await update(io, { version: pkg.version, exec: compiled ? process.execPath : null, os: process.platform, arch: process.arch })
      return { json: r, text: r.updated ? `updated ${r.path} from ${r.from} to ${r.to}` : `graft ${r.from} is up to date (latest ${r.to})` }
    },
  },
  status: {
    options: {},
    async run(io, { positionals }) {
      if (positionals.length > 1) throw new GraftError('usage', 'status takes at most one worktree', 'graft status [path|branch]')
      const r = await status(io, positionals[0])
      const lines = [r.path, `branch ${r.branch ?? '(detached)'}${r.base ? ` from ${r.base}` : ''}${r.upstream ? `, upstream ${r.upstream}` : ''}`, flags(r).join('  '), r.pr ? `${prLine(r.pr)}  ${r.pr.url}` : '']
      return { json: r, text: lines.filter(Boolean).join('\n') }
    },
  },
}

// create --setup takes one value: inline.
function inline(value: string | undefined): boolean {
  if (value !== undefined && value !== 'inline') throw new GraftError('usage', `--setup takes "inline", not "${value}"`)
  return value === 'inline'
}

// "#12 open, ci success"
function prLine(p: Pr): string {
  return `#${p.number} ${p.state}${p.fork ? ' (fork)' : ''}${p.ci ? `, ci ${p.ci}` : ''}`
}

type Flags = { main?: boolean; locked?: boolean; prunable?: boolean; dirty: boolean; merged: boolean; ahead: number | null; behind: number | null }

function flags(w: Flags): string[] {
  const names = (['main', 'locked', 'prunable', 'dirty', 'merged'] as const).filter((k) => w[k]).map((k) => `[${k}]`)
  if (w.ahead) names.push(`+${w.ahead}`)
  if (w.behind) names.push(`-${w.behind}`)
  return names
}

export async function main(argv: string[], io: Io = systemIo()): Promise<number> {
  const [name, ...rest] = argv
  // Not past `--`: what follows belongs to the child command (graft agent -- …).
  const end = rest.indexOf('--')
  const json = (end === -1 ? rest : rest.slice(0, end)).includes('--json')
  try {
    if (!name || name === 'help' || name === '--help' || name === '-h') {
      process.stdout.write(`${usage}\n`)
      return name ? 0 : exitCodes.usage
    }
    if (name === '--version' || name === 'version') {
      process.stdout.write(`${pkg.version}\n`)
      return 0
    }
    const command = Object.hasOwn(commands, name) ? commands[name] : undefined
    if (!command) throw new GraftError('usage', `unknown command "${name}"`, 'run graft --help')
    let args: Args
    try {
      args = parseArgs({ args: rest, options: { ...command.options, json: { type: 'boolean' } }, allowPositionals: true, strict: true })
    } catch (e) {
      throw new GraftError('usage', (e as Error).message, `run graft --help`)
    }
    const out = await command.run(io, args)
    process.stdout.write(json ? `${JSON.stringify(out.json)}\n` : out.text ? `${out.text}\n` : '')
    return out.code ?? 0
  } catch (e) {
    const err = e instanceof GraftError ? e : null
    if (json) {
      const body = err ? err.toJSON() : { kind: 'internal', message: (e as Error).message }
      process.stdout.write(`${JSON.stringify({ error: body })}\n`)
    } else {
      process.stderr.write(`graft: ${(e as Error).message}\n${err?.hint ? `hint: ${err.hint}\n` : ''}`)
    }
    return err ? exitCodes[err.kind] : 1
  }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)))
