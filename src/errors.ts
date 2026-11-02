export type ErrorKind =
  | 'usage'
  | 'not-a-repo'
  | 'not-found'
  | 'exists'
  | 'dirty'
  | 'locked'
  | 'setup-failed'
  | 'teardown-failed'
  | 'agent-working'
  | 'unsupported'
  | 'network'

// 1 is left for unexpected errors (bugs).
export const exitCodes: Record<ErrorKind, number> = {
  usage: 2,
  'not-a-repo': 3,
  'not-found': 4,
  exists: 5,
  dirty: 6,
  locked: 7,
  'setup-failed': 8,
  'teardown-failed': 9,
  'agent-working': 10,
  unsupported: 11,
  network: 12,
}

export class GraftError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
    readonly hint?: string,
  ) {
    super(message)
    this.name = 'GraftError'
  }

  toJSON() {
    return { kind: this.kind, message: this.message, ...(this.hint ? { hint: this.hint } : {}) }
  }
}
