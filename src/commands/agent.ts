import { loadRepoConfig } from '../config.ts'
import { GraftError } from '../errors.ts'
import { context } from '../git.ts'
import { setupMarker } from '../herdr.ts'
import type { Io } from '../io.ts'

export type AgentOpts = { waitSetup: boolean; task?: string; command: string[] }

const maxWaitSeconds = 2 * 60 * 60

// graft agent [--wait-setup] [--task <text>] [-- <command>…]: the program of a Herdr tab that
// starts after setup. Waits for the setup tab's marker; "ok" starts the command (default: the
// repo's [agent] command) in this terminal and returns its exit code; anything else starts nothing.
export async function agent(io: Io, opts: AgentOpts): Promise<number> {
  const ctx = await context(io)
  const command = opts.command.length ? opts.command : ((await loadRepoConfig(io, ctx.main)).agent?.command ?? [])
  if (!command.length) throw new GraftError('usage', 'no agent to start', 'set [agent] command in graft.toml, or pass one after --')

  if (opts.waitSetup) {
    // ponytail: no fail-fast if the setup tab is killed (no marker is written, so this waits out
    // the 2 h); add a check on the setup terminal (`hc get <t> --json`) if that bites.
    const marker = await setupMarker(io, ctx.root)
    io.warn('waiting for setup to finish…')
    let outcome: string | undefined
    for (let s = 0; s < maxWaitSeconds && !outcome; s++) {
      outcome = (await io.readText(marker))?.trim() || undefined
      if (!outcome) await io.sleep(1000)
    }
    if (outcome !== 'ok') {
      const why = outcome ? 'setup failed' : 'setup did not finish within 2 hours'
      throw new GraftError('setup-failed', `${why}; ${command.join(' ')} not started`, `fix it, run graft setup in ${ctx.root}, then start it yourself`)
    }
    io.warn(`setup finished, starting ${command.join(' ')}`)
  }

  if (opts.task) void sendTask(io, opts.task).catch((e) => io.warn(`could not send the task: ${(e as Error).message}`))
  return (await io.run(command, { stream: true })).code
}

// Herdr's own `task` is sent "once the agent is ready", and a send to a booting agent can be
// dropped; an agent that starts minutes later, after a wrapper waited, may miss it. So the
// wrapper sends the task itself, once this terminal's agent first reports idle.
// ponytail: gives up after 10 min; an agent that never reports status never gets the task.
async function sendTask(io: Io, task: string): Promise<void> {
  const self = io.env.HC_TERMINAL_ID
  if (!self) return io.warn('not inside an hc terminal, so the task was not sent')
  // A deadline, not a count: a blocked agent (trust dialog) makes each wait return at once.
  for (const end = Date.now() + 10 * 60_000; Date.now() < end; ) {
    const r = await io.run(['hc', 'wait', self, '--json', '--timeout', '30'])
    let status: unknown
    try {
      status = JSON.parse(r.out).status
    } catch {}
    if (status === 'idle' || status === 'done') {
      const sent = await io.run(['hc', 'send', self, task])
      if (sent.code !== 0) io.warn(`could not send the task: ${sent.err.trim() || `exit ${sent.code}`}`)
      return
    }
    // Still working, or blocked on a trust dialog (wait returns at once then): look again.
    await io.sleep(1000)
  }
  io.warn('the agent never became idle, so the task was not sent')
}
