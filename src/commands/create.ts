import { titleBranch } from '../branch-name.ts'
import { loadRepoConfig, loadUserConfig, type RepoConfig } from '../config.ts'
import { GraftError } from '../errors.ts'
import {
  addExistingWorktree, addWorktree, checkBranchName, checkNewBranch, context, fetchBranch, findWorktree,
  listWorktrees, pickRemote, refExists, resolveBase, type Base, type Ctx,
} from '../git.ts'
import { forgeOf } from '../forge/forge.ts'
import { ensureMainSpace, herdrDo, requireHerdr, type Space } from '../herdr.ts'
import { runHook, type HookResult } from '../hooks.ts'
import type { Io } from '../io.ts'
import { materialize, type Files } from '../materialize.ts'
import { jira } from '../jira.ts'
import { linear } from '../linear.ts'
import { worktreePath } from '../paths.ts'

// Exactly one source: --branch (literal new name), --title (templated new name), --remote (existing branch),
// --pr (a pull or merge request's head branch), --linear / --jira (a ticket: templated new name).
// New branches start from --base, or --from another worktree's branch, or the remote's default branch.
export type CreateOpts = {
  branch?: string
  title?: string
  remote?: string
  pr?: string
  linear?: string
  jira?: string
  base?: string
  from?: string
  name?: string
  setup: boolean
  // --open herdr: open the worktree in a Herdr space; setup runs in its "setup" tab unless setupInline.
  open?: string
  setupInline?: boolean
  // The agent's first message (needs --open herdr and an [agent] command). Default for --linear and
  // --jira: the issue's key, title and URL.
  task?: string
}

export type HerdrResult = { space: string; tabs: Record<string, string> }

// base is null for --remote and --pr: the branch already exists.
export type CreateResult = { worktree: string; branch: string; base: string | null; files: Files; setup: HookResult; herdr?: HerdrResult }

export async function create(io: Io, opts: CreateOpts): Promise<CreateResult> {
  const sources = [opts.branch, opts.title, opts.remote, opts.pr, opts.linear, opts.jira].filter((s) => s !== undefined)
  if (sources.length !== 1) throw new GraftError('usage', 'create needs exactly one source: --branch, --title, --remote, --pr, --linear or --jira', 'run graft --help')
  if (opts.base !== undefined && opts.from !== undefined) throw new GraftError('usage', '--base and --from both set the base; pass one')
  const existing = opts.remote !== undefined ? '--remote' : opts.pr !== undefined ? '--pr' : null
  if (existing && (opts.base !== undefined || opts.from !== undefined)) {
    throw new GraftError('usage', `${existing} checks out an existing branch, so it takes no --base or --from`)
  }
  if (opts.open !== undefined && opts.open !== 'herdr') throw new GraftError('unsupported', `cannot open in "${opts.open}"`, 'the only target is: --open herdr')
  if (!opts.open && (opts.setupInline || opts.task !== undefined)) throw new GraftError('usage', '--setup inline and --task need --open herdr')
  const herdr = opts.open ? await requireHerdr(io) : null

  const ctx = await context(io)
  const user = await loadUserConfig(io)
  const cfg = await loadRepoConfig(io, ctx.main, user)
  const remote = await pickRemote(io, ctx.root, cfg.remote)
  if (opts.task !== undefined && !cfg.agent?.command.length) throw new GraftError('usage', '--task needs an agent', 'set [agent] command in graft.toml')

  let task = opts.task
  let branch: string
  let base: Base | null = null
  if (opts.remote !== undefined) {
    branch = opts.remote
    await checkExisting(io, ctx, remote, branch)
  } else if (opts.pr !== undefined) {
    branch = await prBranch(io, ctx, remote, opts.pr)
  } else {
    if (opts.linear !== undefined) {
      const issue = await (await linear(io, user)).issue(opts.linear)
      branch = await titleBranch(io, ctx.root, issue.title, cfg.branch.template, user.user, { key: issue.identifier, linear: issue.branchName })
      task ??= `${issue.identifier} ${issue.title}\n${issue.url}`
    } else if (opts.jira !== undefined) {
      const issue = await (await jira(io, user)).issue(opts.jira)
      branch = await titleBranch(io, ctx.root, issue.summary, cfg.branch.template, user.user, { key: issue.key })
      task ??= `${issue.key} ${issue.summary}\n${issue.url}`
    } else {
      branch = opts.branch ?? (await titleBranch(io, ctx.root, opts.title!, cfg.branch.template, user.user))
    }
    await checkNewBranch(io, ctx.root, branch)
    base = opts.from !== undefined ? await worktreeBase(io, ctx, opts.from) : await resolveBase(io, ctx.root, remote, opts.base)
  }
  const registered = (await listWorktrees(io, ctx)).map((w) => w.path)
  const path = worktreePath(io, ctx.main, opts.name ?? branch, user.worktrees_dir, registered)

  io.warn(`creating ${path} (${branch} ${base ? `from ${base.name}` : 'checked out as is'})`)
  if (base) await addWorktree(io, ctx.root, { branch, path, base })
  else await addExistingWorktree(io, ctx.root, { branch, path, remote })
  const files = await materialize(io, ctx.main, path, cfg.link)

  // With Herdr, setup runs in the space's "setup" tab (when there is a hook), so the space opens at once.
  const setupTab = !!herdr && opts.setup && !opts.setupInline && !!cfg.hooks.setup?.trim()
  const setup = opts.setup && !setupTab
    ? await runHook(io, cfg.hooks.setup, { main: ctx.main, worktree: path, branch, base: base?.name ?? null })
    : { ran: false, exit: null }
  if (setup.ran && setup.exit !== 0) {
    // The worktree stays: fixing the cause and rerunning setup is cheaper than starting over.
    throw new GraftError('setup-failed', `setup exited ${setup.exit} in ${path} (worktree kept)`, `fix it, then run: graft setup ${path}`)
  }
  const result: CreateResult = { worktree: path, branch, base: base?.name ?? null, files, setup }
  if (herdr) result.herdr = await openInHerdr(io, herdr, { main: ctx.main, worktree: path, worktrees: [...registered, path], setupTab, agent: cfg.agent?.command, task, tabs: cfg.tabs })
  return result
}

type TabSpec = { name: string; argv?: string[]; task?: string }

// One space for the worktree: a "setup" tab running `graft setup --report`, an "agent" tab and one
// tab per [[tabs]]. While setup runs in its tab, the others wait for it through `graft agent --wait-setup`,
// which also sends the task itself (see agent.ts); without a setup tab they start at once and the
// task goes through Herdr.
async function openInHerdr(
  io: Io,
  all: Space[],
  o: { main: string; worktree: string; worktrees: string[]; setupTab: boolean; agent?: string[]; task?: string; tabs: RepoConfig['tabs'] },
): Promise<HerdrResult> {
  await ensureMainSpace(io, all, o.main, o.worktrees)
  const wait = ['graft', 'agent', '--wait-setup']
  const tabs: TabSpec[] = []
  if (o.setupTab) tabs.push({ name: 'setup', argv: ['graft', 'setup', '--report'] })
  if (o.agent?.length) {
    tabs.push(o.setupTab ? { name: 'agent', argv: [...wait, ...(o.task ? [`--task=${o.task}`] : [])] } : { name: 'agent', argv: o.agent, task: o.task })
  }
  for (const t of o.tabs) {
    const argv = t.command ? ['sh', '-c', t.command] : undefined
    tabs.push({ name: t.title, argv: argv && o.setupTab ? [...wait, '--', ...argv] : argv })
  }
  const [first, ...rest] = tabs
  // Unnamed, so the space is called after its folder and nests under the repository.
  const made = await herdrDo(io, 'space.new', { folder: o.worktree, tab: first?.name, argv: first?.argv, task: first?.task })
  const result: HerdrResult = { space: made.space, tabs: first ? { [first.name]: made.tab } : {} }
  try {
    for (const t of rest) {
      let key = t.name
      for (let n = 2; Object.hasOwn(result.tabs, key); n++) key = `${t.name} (${n})`
      const tab = await herdrDo(io, 'tab.new', { space: made.space, folder: o.worktree, name: t.name, argv: t.argv, task: t.task })
      result.tabs = { ...result.tabs, [key]: tab.tab }
    }
  } catch (e) {
    try {
      await herdrDo(io, 'space.close', { id: made.space, confirmed: true })
    } catch (cleanup) {
      io.warn(`could not close incomplete space ${made.space}: ${(cleanup as Error).message}`)
    }
    throw e
  }
  return result
}

// --remote <b>: fetch it; it must exist locally or on the remote, and not be checked out already.
async function checkExisting(io: Io, ctx: Ctx, remote: string, branch: string): Promise<void> {
  await checkBranchName(io, ctx.root, branch)
  await fetchBranch(io, ctx.root, remote, branch)
  if (!(await refExists(io, ctx.root, `refs/heads/${branch}`)) && !(await refExists(io, ctx.root, `refs/remotes/${remote}/${branch}`))) {
    throw new GraftError('not-found', `branch "${branch}" exists neither on ${remote} nor locally`, 'run: graft search branches')
  }
  const used = (await listWorktrees(io, ctx)).find((w) => w.branch === branch)
  if (used) throw new GraftError('exists', `branch "${branch}" is already checked out in ${used.path}`)
}

// --pr <n|url>: the PR's head branch, under its own name. A PR from the same repository is checked
// out like --remote. A fork's head (or a head branch deleted from the remote) is fetched from the
// forge's pull ref (refs/pull/<n>/head, refs/merge-requests/<n>/head) into a local branch.
async function prBranch(io: Io, ctx: Ctx, remote: string, ref: string): Promise<string> {
  const forge = await forgeOf(io, ctx.root, remote)
  const pr = await forge.view(ref)
  const branch = pr.head
  if (!pr.fork) {
    try {
      await checkExisting(io, ctx, remote, branch)
      if (!(await staleRemoteHead(io, ctx, remote, branch, pr.headSha, forge.pullRef(pr.number)))) return branch
    } catch (e) {
      if (!(e instanceof GraftError && e.kind === 'not-found')) throw e
    }
  }
  const pull = forge.pullRef(pr.number)
  if (!pull) throw new GraftError('not-found', `the head branch "${branch}" of PR ${pr.number} is not on ${remote}`)
  await checkNewBranch(io, ctx.root, branch)
  const fetch = await io.run(['git', 'fetch', '--no-tags', remote, `${pull}:refs/heads/${branch}`], { cwd: ctx.root })
  if (fetch.code !== 0) throw new GraftError('network', `could not fetch ${pull} from ${remote}: ${fetch.err.trim()}`)
  return branch
}

// A head deleted on the remote leaves its old remote-tracking ref behind, which may predate the
// PR's last commit; then the pull ref is the PR. A local branch is the person's and is used as it is.
async function staleRemoteHead(io: Io, ctx: Ctx, remote: string, branch: string, headSha: string, pull: string | null): Promise<boolean> {
  if (!pull || (await refExists(io, ctx.root, `refs/heads/${branch}`))) return false
  const tip = (await io.run(['git', 'rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${branch}`], { cwd: ctx.root })).out.trim()
  if (tip === headSha) return false
  io.warn(`${remote}/${branch} is not the PR's head ${headSha.slice(0, 12)}, using ${pull}`)
  return true
}

// --from <wt>: the new branch starts from that worktree's local branch.
async function worktreeBase(io: Io, ctx: Ctx, from: string): Promise<Base> {
  const { ctx: source, wt } = await findWorktree(io, from)
  if (source.common !== ctx.common) throw new GraftError('usage', `${wt.path} belongs to another repository`)
  if (!wt.branch) throw new GraftError('usage', `${wt.path} is detached; --from needs a worktree on a branch`)
  return { name: wt.branch, ref: `refs/heads/${wt.branch}` }
}
