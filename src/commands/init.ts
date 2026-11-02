import { userConfigPath } from '../config.ts'
import { GraftError } from '../errors.ts'
import type { Io } from '../io.ts'

// Everything is commented out, so the new file changes nothing until a line is uncommented.
export const template = `# graft user config: private settings, never committed.
# Uncomment what you need. Full reference: https://github.com/gecm0/graft#user-config-configgraftconfigtoml

# user = "alice"                  # {user} in branch templates
# worktrees_dir = "~/worktrees"   # worktrees go to <worktrees_dir>/<repo>/<folder>

# Config for a repository that has no graft.toml.
# [repos."~/code/team-app"]
# link = [".env"]
#
# [repos."~/code/team-app".hooks]
# setup = "pnpm install"

# For --linear and search linear. LINEAR_API_KEY wins over it.
# Create a key at https://linear.app/settings/account/security
# [linear]
# api_key = "lin_api_..."

# For --jira and search jira. JIRA_SITE, JIRA_EMAIL, JIRA_API_TOKEN win over these.
# [jira]
# site = "acme.atlassian.net"
# email = "me@example.com"
# api_token = "..."
`

export type InitResult = { path: string; created: boolean }

// Creates the user config if it is missing and makes it private (0600), since it can hold tokens.
// An existing file is never overwritten; it only gets its mode fixed.
export async function init(io: Io): Promise<InitResult> {
  const path = userConfigPath(io)
  const created = !io.exists(path)
  if (created) await io.writeText(path, template)
  const chmod = await io.run(['chmod', '600', path])
  if (chmod.code !== 0) throw new GraftError('usage', `could not chmod 600 ${path}: ${chmod.err.trim()}`)
  return { path, created }
}
