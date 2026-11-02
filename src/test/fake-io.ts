import type { Env, Io, RunOpts, RunResult } from '../io.ts'

export type Reply = Partial<RunResult>

export type FakeIo = Io & {
  calls: string[][]
  runs: { cmd: string[]; opts: RunOpts }[]
  warnings: string[]
  questions: string[]
}

// Scripted commands: each key is matched as a prefix of the space-joined command,
// longest key wins; unmatched commands succeed with empty output.
export function fakeIo(
  script: Record<string, Reply> = {},
  opts: { files?: Record<string, string>; paths?: string[]; links?: Record<string, string>; cwd?: string; env?: Env; tty?: boolean; answer?: boolean; modes?: Record<string, number>; fetch?: Io['fetch'] } = {},
): FakeIo {
  const files = opts.files ?? {}
  const paths = new Set([...(opts.paths ?? []), ...Object.keys(files)])
  const io: FakeIo = {
    calls: [],
    runs: [],
    warnings: [],
    questions: [],
    env: opts.env ?? {},
    cwd: opts.cwd ?? '/r/repo',
    home: '/home/me',
    async run(cmd, runOpts = {}) {
      io.calls.push(cmd)
      io.runs.push({ cmd, opts: runOpts })
      const line = cmd.join(' ')
      const key = Object.keys(script)
        .filter((k) => line === k || line.startsWith(`${k} `))
        .sort((a, b) => b.length - a.length)[0]
      const reply = key === undefined ? {} : script[key]!
      // A removed worktree's folder is gone, as git would leave it.
      if (line.startsWith('git worktree remove ') && (reply.code ?? 0) === 0) paths.delete(cmd.at(-1)!)
      return { code: reply.code ?? 0, out: reply.out ?? '', err: reply.err ?? '' }
    },
    exists: (p) => paths.has(p),
    readlink: (p) => opts.links?.[p] ?? null,
    readText: async (p) => files[p] ?? null,
    async writeText(p, data) {
      files[p] = typeof data === 'string' ? data : new TextDecoder().decode(data)
      paths.add(p)
    },
    mode: (p) => opts.modes?.[p] ?? (paths.has(p) ? 0o600 : null),
    fetch: opts.fetch ?? (async (url) => {
      throw new Error(`no network in tests: ${url}`)
    }),
    sleep: async () => {},
    warn: (m) => void io.warnings.push(m),
    isTTY: opts.tty ?? false,
    async ask(q) {
      io.questions.push(q)
      return opts.answer ?? false
    },
  }
  return io
}

// Replies for a plain clone at /r/repo with origin/main.
export const cloneScript: Record<string, Reply> = {
  'git rev-parse --path-format=absolute --show-toplevel --git-common-dir --git-dir': {
    out: '/r/repo\n/r/repo/.git\n/r/repo/.git\n',
  },
  'git worktree list --porcelain': { out: 'worktree /r/repo\nHEAD aaa\nbranch refs/heads/main\n\n' },
  'git symbolic-ref --quiet --short HEAD': { out: 'main\n' },
  'git config --get branch.main.remote': { out: 'origin\n' },
  'git symbolic-ref --quiet refs/remotes/origin/HEAD': { out: 'refs/remotes/origin/main\n' },
  'git check-ref-format --branch foo': { out: 'foo\n' },
  'git show-ref --verify --quiet refs/heads/foo': { code: 1 },
}
