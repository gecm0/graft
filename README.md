# graft

Git worktrees with per-repo setup and teardown. One CLI for terminals, UIs and agents.

`graft create` adds a worktree next to your repository, runs the repository's `setup` hook in it, and prints the result as text or as one JSON object. The repository describes what a fresh checkout needs in a versioned `graft.toml`.

Status: early. `create` (from a new branch, a title, an existing branch, a pull request, a Linear or Jira issue, or another worktree), `setup`, `teardown`, `remove`, `clean`, `list`, `status` and `search branches|prs|linear|jira` work today, gitignored files can be linked or copied into new worktrees, worktrees can open in [Herdr](#herdr) with an agent that starts after setup, a Herdr [picker](#picker) creates them from any source and a [side panel](#side-panel) lists and removes them, and pull requests work on GitHub, GitLab and Cursor Origin (see [Pull requests](#pull-requests)), and Linear and Jira issues name branches and brief the agent (see [Linear](#linear) and [Jira](#jira)). It ships as a single binary that updates itself (`graft update`).

## Install

graft needs `git` 2.38 or later. Download the binary for your system from the [latest release](https://github.com/gecm0/graft/releases/latest) (`graft-darwin-arm64`, `graft-darwin-x64`, `graft-linux-arm64` or `graft-linux-x64`) into a folder on your `PATH`:

```sh
os=$(uname -s | tr A-Z a-z); arch=$(uname -m | sed 's/x86_64/x64/; s/aarch64/arm64/')
mkdir -p ~/.local/bin && curl -fL -o ~/.local/bin/graft "https://github.com/gecm0/graft/releases/latest/download/graft-$os-$arch"
chmod +x ~/.local/bin/graft
codesign -s - -f ~/.local/bin/graft   # macOS only: the release binaries are unsigned, and macOS kills them until signed
graft --version
```

`graft update` replaces it with the latest release later; see [`graft update`](#graft-update).

### From source

With [Bun](https://bun.com) 1.4 or later:

```sh
git clone https://github.com/gecm0/graft.git
cd graft
bun install
bun link        # puts `graft` on your PATH, running the TypeScript directly
```

Or build the binary yourself: `bun run build` writes `dist/graft`, signed ad hoc (macOS; elsewhere run `bun run compile --outfile dist/graft`).

## Quick start

Add a `graft.toml` at the root of your repository's main checkout:

```toml
[hooks]
setup = "pnpm install"
```

Then, from anywhere inside the repository:

```sh
graft create --branch fix-login     # ../<repo>.worktrees/fix-login, from origin/<default branch>
graft create --title "Fix login"    # branch name from the repo's template
graft create --remote their-branch  # check out a branch that already exists
graft create --pr 42                # check out a pull request's branch
graft create --linear ABC-123       # new branch named from a Linear issue
graft create --jira ABC-123         # new branch named from a Jira issue
graft create --title "Fix signup" --open herdr   # in a Herdr space with setup and agent tabs
graft open fix-login                # go to its Herdr space
graft list
graft remove fix-login              # runs teardown, removes the worktree, deletes the branch if merged
graft clean                         # removes every clean, merged worktree (asks first)
```

## Commands

Every command accepts `--json`. With it, stdout is exactly one JSON object (or array, for `list`); progress and hook output always go to stderr.

### `graft create`

Creates a worktree, then runs `setup`. It takes exactly one source:

| Source | Meaning |
|---|---|
| `--branch <name>` | New branch, named exactly as written (it must pass `git check-ref-format --branch` and must not exist yet). The branch template is never applied. |
| `--title <text>` | New branch, named by the [branch template](#branch-names) from the text, e.g. `--title "Fix login"` → `fix-login`. |
| `--remote <branch>` | Existing branch, checked out with no base. graft fetches `<remote>/<branch>`; if a local branch of that name exists it is used as it is, otherwise a local branch is created tracking `<remote>/<branch>`. The branch is marked `branch.<name>.graft-preserve`, so `remove` never deletes it. |
| `--pr <number\|url>` | A pull or merge request's head branch, under its own name, with no base; see [Pull requests](#pull-requests). Also marked `graft-preserve`. |
| `--linear <ID>` | New branch, named by the [branch template](#branch-names) from a Linear issue (`{key}` is its ID, `{slug}` its title, `{linear}` Linear's suggested branch name); see [Linear](#linear). |
| `--jira <KEY>` | New branch, named by the [branch template](#branch-names) from a Jira issue (`{key}` is its key, `{slug}` its summary); see [Jira](#jira). |

| Option | Meaning |
|---|---|
| `--base <branch>` | Branch to start a new branch from, fetched and taken from the remote when it has it. `refs/heads/<branch>` takes the local branch instead. Default: the remote's default branch. |
| `--from <worktree>` | Start a new branch from another worktree's branch (a path, branch or folder name), as it is locally. Not with `--base`. |
| `--name <dir>` | Folder name for the worktree. Default: the branch name with `/` and other unsafe characters turned into `-`. |
| `--no-setup` | Skip the `setup` hook. |
| `--open herdr` | Open the worktree in a Herdr space; see [Herdr](#herdr). |
| `--setup inline` | With `--open herdr`: run `setup` here first, then open the space. |
| `--task <text>` | With `--open herdr`: the agent's first message. Needs `[agent] command`. With `--linear` or `--jira` it defaults to the issue's key, title and URL. |

`--base` and `--from` only apply to new branches (`--branch`, `--title`, `--linear`, `--jira`).

Steps for a new branch:

1. Pick the remote: `remote` in the config, else the current branch's upstream remote, else the only remote, else `origin`.
2. Fetch the base (`git fetch --no-tags <remote> +refs/heads/<base>:refs/remotes/<remote>/<base>`). If the fetch fails graft warns and goes on with local refs.
3. Start from `<remote>/<base>` if it exists, else the local `<base>`.
4. `git worktree add --no-track -b <name> <path> <base>`, and record the base in `git config branch.<name>.graft-base`.
5. Bring in gitignored files from the main checkout: symlink the `link` paths, then copy the `.worktreeinclude` paths (see [Gitignored files](#gitignored-files)).
6. Run `setup` in the new worktree.

The worktree goes to `<repo parent>/<repo>.worktrees/<folder>`; if that path is taken, `-2`, `-3`, … are appended.

```json
{"worktree":"/code/app.worktrees/fix-login","branch":"fix-login","base":"origin/main","files":{"linked":[".env.local"],"copied":[],"skipped":[{"path":"apps/api/.env.local","reason":"missing"}]},"setup":{"ran":true,"exit":0}}
```

With `--remote` and `--pr`, `base` is `null` and steps 2 to 4 are replaced by the fetch and checkout described above. With `--from`, the base is that worktree's local branch (e.g. `"base":"fix-login"`) and nothing is fetched.

If `setup` fails, the worktree is kept and graft exits with `setup-failed`. Fix the cause and run `graft setup <path>`.

#### Branch names

`--title` (and, later, tickets) name the branch with the template in `[branch] template`, from `graft.toml` or the user config's `[repos."<path>"]` entry. Without one the template is `{key}-{slug}`.

| Variable | Value |
|---|---|
| `{slug}` | the title, lowercased, accents folded, anything but letters and digits turned into `-`, at most 48 characters |
| `{key}` | the ticket key, e.g. `abc-123` (empty for `--title`) |
| `{user}` | `user` in the user config, else `git config github.user`, else `user.email` before the `@` |
| `{date}` | today, `YYYY-MM-DD` |
| `{linear}` | Linear's suggested branch name (empty outside Linear tickets) |

An empty variable is dropped together with the separator it would leave behind:

```text
template "{user}/{key}-{slug}", --title "Fix login"   → alice/fix-login
no template,                    --title "Fix login"   → fix-login
--branch fix-login                                     → fix-login   (always literal)
```

Because `{user}` comes from each person's own config, a shared `graft.toml` can use it and everyone gets their own prefix.

### `graft setup [path]`

Runs the `setup` hook again in an existing checkout (default: the current one). Useful when a gitignored file went missing or setup failed halfway. In a linked worktree it first recreates missing links and copies, and reports them in `files` like `create` (`files` is `null` in the main checkout).

`--report` also writes `ok` or `failed` to `graft-setup-done` in the worktree's git dir, for `graft agent --wait-setup`. The Herdr setup tab uses it.

### `graft teardown [path]`

Runs the `teardown` hook in an existing checkout (default: the current one), without removing anything.

### `graft remove <worktree>`

Runs `teardown`, removes the worktree, and deletes its branch only when git proves it merged. `<worktree>` is a path, a branch name or a worktree folder name.

| Option | Meaning |
|---|---|
| `--force` | Remove even with modified or untracked files or initialized submodules, and even if `teardown` fails. |
| `--ignore-teardown` | Go on when `teardown` fails. |
| `--keep-branch` | Never delete the branch. |

Steps:

1. Refuse the main checkout (`usage`) and locked worktrees (`locked`), even with `--force`.
2. Unless `--force`: refuse modified or untracked files, or initialized submodules (`dirty`). graft's own symlinks (from `link`) don't count. Also refuse when an agent is working in a Herdr space showing the worktree (`agent-working`).
3. Run `teardown` in the worktree, while it still exists. If it fails, nothing else happens and graft exits with `teardown-failed`, unless `--ignore-teardown` or `--force`.
4. Close every Herdr space showing the worktree, wait (up to about 5 seconds) for its terminals to end, and remove them from `hc ls --all`. Without Herdr this step is skipped.
5. Delete graft's symlinks (only paths from `link` that are still symlinks into the main checkout), then `git worktree remove [--force] <path>`. The main checkout's files are never touched.
6. Fetch the merge targets: the base recorded at create time and the remote's default branch. The branch counts as merged if its tip is an ancestor of a target (fast-forward or merge commit), or if merging it into the target changes nothing (`git merge-tree --write-tree` equals the target's tree: squash and rebase merges).
7. A merged branch is deleted with `git update-ref -d refs/heads/<branch> <tip>`, which refuses if the branch moved meanwhile. Otherwise it is kept and reported. Branches marked `branch.<name>.graft-preserve` are always kept.

```json
{"removed":"/code/app.worktrees/fix-login","teardown":{"ran":true,"exit":0},"branch":{"name":"fix-login","deleted":false,"reason":"not-merged","head":"9c1f0e2…"}}
```

`branch.reason` is `not-merged`, `preserved`, `kept` (`--keep-branch`) or `checked-out` (another worktree has the same branch). `remove` refuses a worktree with another worktree inside it: remove the inner one first. `branch` is `null` for a detached worktree.

### `graft clean`

Removes every clean, merged worktree in one go, deleting its branch, by running `remove` on each. `graft clean <path>...` considers only those worktrees, each checked again as below; a path that is no longer a worktree is skipped as `not-found`.

| Option | Meaning |
|---|---|
| `--dry-run` | Only list what would be removed. |
| `--yes` | Remove without asking. |

Steps:

1. Fetch the remote's default branch and every remote base recorded by a worktree, once each.
2. Check each linked worktree (the main checkout is never touched). Skipped, with a reason: `locked`, `prunable` (its folder is gone), `dirty` (modified or untracked files, not counting graft's symlinks), `not-merged` (not proven merged as in `remove`, or detached), `submodules` (initialized submodules, which `remove` only removes with `--force`), `open-space` (a Herdr space shows it: close it or use `graft remove`) and `no-commits` (the branch never had a commit of its own, e.g. a worktree just created: its tip is still its base, so it looks merged; told by the branch reflog having only its creation entry, not checked for `graft-preserve` branches or when there is no reflog). The rest are candidates.
3. Without `--yes` or `--dry-run`, on a terminal graft lists the candidates and asks once. When stdin is not a terminal (an agent, a UI) it removes nothing, as with `--dry-run`.
4. `remove` each candidate, deepest path first, with its usual checks and `teardown`. A failure is reported in `failed` and the others still go ahead; graft then exits with the first failure's code.

```json
{"dryRun":false,"candidates":[{"path":"/code/app.worktrees/fix-login","branch":"fix-login"}],"removed":[{"path":"/code/app.worktrees/fix-login","branch":{"name":"fix-login","deleted":true,"head":"9c1f0e2…"}}],"skipped":[{"path":"/code/app.worktrees/wip","branch":"wip","reason":"dirty"}],"failed":[]}
```

`dryRun` is `true` when nothing was removed on purpose (`--dry-run`, no terminal without `--yes`, or "no" at the prompt). `removed[].branch` is `remove`'s branch result; a branch marked `graft-preserve` is kept even when merged. `failed[].error` has the same shape as a command error.

### `graft list`

Lists the repository's worktrees, main checkout first. The facts per row come from local refs only (no fetch), so `list` is fast and works offline; `merged` may lag until the next fetch.

`--pr` adds each worktree's pull request as `pr` (see `status`), with one forge CLI call per worktree, so it needs the network. Without it rows have no `pr` key.

```json
[{"path":"/code/app","branch":"main","head":"3e93bed…","main":true,"locked":false,"prunable":false,"dirty":false,"ahead":0,"behind":0,"merged":false,"space":"sp…"}]
```

| Field | Meaning |
|---|---|
| `dirty` | modified or untracked files, not counting graft's own symlinks |
| `ahead`, `behind` | commits ahead of and behind the upstream, else the recorded base; `null` when there is neither |
| `merged` | proven merged, as in `remove` (always `false` for the main checkout and detached worktrees) |
| `space` | the id of the [Herdr](#herdr) space showing the worktree, `null` without one or without Herdr |

### `graft status [worktree]`

The same facts for one worktree (default: the current one), plus its base, upstream, Herdr space and pull request. Unlike `list`, it fetches the merge targets first and asks the forge for the PR.

```json
{"path":"/code/app.worktrees/fix-login","branch":"fix-login","base":"origin/main","upstream":null,"dirty":false,"ahead":2,"behind":0,"merged":false,"space":{"id":"sp…","tabs":[{"id":"tb…","name":"setup"}]},"pr":{"number":42,"title":"Fix login","url":"https://github.com/acme/app/pull/42","state":"open","head":"fix-login","base":"main","headSha":"9c1f0e2…","fork":false,"ci":"pending"}}
```

`space` is the Herdr space showing the worktree, or `null` (also when Herdr isn't installed).

`pr` is the newest pull request whose head is the worktree's branch, in any state, as a [PR object](#pull-requests). It is `null` for the main checkout, a detached worktree, a branch with no pull request, or a remote on an unknown host; when the forge CLI is missing or fails (network, auth) graft warns on stderr and reports `null` rather than failing. `merged` still comes from git; the PR's state is only shown, never used to delete a branch.

### `graft open <worktree>`

Shows the Herdr space showing the worktree (`space.select`), or opens a new one in it. `--open herdr` is the default and the only target.

```json
{"worktree":"/code/app.worktrees/fix-login","space":"sp…","created":false}
```

### `graft agent`

`graft agent [--wait-setup] [--task <text>] [-- <command>…]` is what the Herdr tabs of `create --open herdr` run; you rarely call it yourself. With `--wait-setup` it waits (up to 2 hours) for the setup tab's `graft setup --report`. If setup failed it starts nothing and exits with `setup-failed`; otherwise it runs `<command>` (default: the repo's `[agent] command`) in the terminal and exits with its code. With `--task` it sends the text to the agent with `hc send` once the agent first reports `idle`.

### `graft search branches [query]`

Lists local branches and the remote's branches, newest commit first, for pickers and agents. A branch that exists both locally and on the remote is listed twice, once with `"where":"local"` and once with `"where":"remote"`. `query` is a case-insensitive substring of the name. It reads local refs only: run `git fetch` first to see branches pushed since.

```json
[{"name":"fix-login","where":"remote","ref":"refs/remotes/origin/fix-login","date":"2026-11-01T10:12:00+01:00"},{"name":"main","where":"local","ref":"refs/heads/main","date":"…"}]
```

Pass a remote branch's `name` to `graft create --remote <name>`.

### `graft search prs [query]`

Lists the open pull requests (and drafts) of the repository on its forge, as [PR objects](#pull-requests), for pickers and agents. A PR number such as `21044` or `#21044` looks up that exact PR, including closed or merged PRs. An unknown number returns no results. Other queries use the forge's text search (`gh pr list --search`, `glab mr list --search`, `origin pr list --search`), including titles. Pass a `number` to `graft create --pr <number>`.

### `graft search jira [query]`

Without `query`, lists your Jira issues that are not done (`assignee = currentUser() AND statusCategory != Done`), most recently updated first. An exact key such as `AIR-2` looks up that issue directly, including completed issues. Keys accept lowercase and surrounding spaces; an unknown or inaccessible key returns no results. Other queries use Jira's text search over all issues you can see (`text ~ "<query>"`). At most 50 issues either way, following `nextPageToken` across pages. It needs no repository. Pass a `key` to `graft create --jira <KEY>`.

```json
[{"key":"ABC-123","summary":"Fix the login page","url":"https://acme.atlassian.net/browse/ABC-123","status":"In Progress"}]
```

### `graft search linear [query]`

Without `query`, lists your assigned Linear issues that are not completed or canceled, most recently updated first. With `query`, Linear's full-text search over all issues (`searchIssues`, which Linear limits to 30 requests a minute). At most 50 issues either way. It needs no repository. Pass an `identifier` to `graft create --linear <ID>`.

```json
[{"identifier":"ABC-123","title":"Fix the login page","url":"https://linear.app/acme/issue/ABC-123/fix-the-login-page","branchName":"alice/abc-123-fix-the-login-page","state":"In Progress"}]
```

### `graft herdr install`

Installs graft's Herdr mods and layout: see [Picker](#picker) and [Side panel](#side-panel).

```json
{"home":"/Users/me/.config/herdr-app","mods":[{"name":"graft-new","path":"/Users/me/.config/herdr-app/mods/graft-new","status":"linked"},{"name":"graft-panel","path":"…/mods/graft-panel","status":"linked"},{"name":"graft-tabs","path":"…/mods/graft-tabs","status":"linked"}],"layout":{"name":"graft","path":"/Users/me/.config/herdr-app/layouts/graft.json","status":"linked"},"key":{"keys":"cmd-g","action":"mod.open:graft-new","status":"added"}}
```

### `graft init`

Creates the [user config](#user-config-configgraftconfigtoml) with every option commented out, and sets it to mode 600 because it can hold tokens. An existing file is never overwritten; only its mode is fixed.

```json
{"path":"/Users/me/.config/graft/config.toml","created":true}
```

### `graft update`

Replaces the running binary with the latest [GitHub release](https://github.com/gecm0/graft/releases), if it is newer than `graft --version`:

1. Read the latest release from the GitHub API and compare its tag with the running version. Same or older: nothing happens.
2. Download the `graft-<os>-<arch>` asset next to the binary (`<binary>.update`), make it executable and, on macOS, sign it ad hoc (`codesign -s - -f`).
3. Check that it runs (`--version`), then rename it over the binary, so the swap is atomic. If any step fails the download is deleted and the old binary stays.

```json
{"path":"/Users/me/.local/bin/graft","from":"0.1.0","to":"0.2.0","updated":true}
```

It needs write access to the binary's folder. A `graft` run from source (`bun link`) refuses with `unsupported`: update it with `git pull`. After an update, run `graft herdr install` again to refresh the Herdr mods.

## Herdr

graft works without [Herdr](https://herdr.dev); with it, `--open herdr` puts a new worktree in its own space. It needs `herdr-app` and `hc` on `PATH`, the Herdr window open, and `graft` on the `PATH` of your login shell (the tabs run `graft …` there).

`graft create … --open herdr`:

1. Checks that Herdr answers (`herdr-app ls`) before touching git; otherwise exits with `unsupported`.
2. Creates the worktree and brings in gitignored files as usual.
3. Opens a space on the main checkout if none shows it, so the sidebar nests the worktree under its repository.
4. Opens a space in the worktree with these tabs:
   - `setup`: runs `graft setup --report`, so setup's output stays visible there. Left out with `--setup inline` (setup runs in `create` first), `--no-setup`, or no `setup` hook.
   - `agent`: the `[agent] command`, if any. While a `setup` tab runs, it waits through `graft agent --wait-setup` and starts the agent only if setup succeeded.
   - one per `[[tabs]]`, running its `command` with `sh -c`, also after setup.

```json
{"worktree":"/code/app.worktrees/fix-login","branch":"fix-login","base":"origin/main","files":{"linked":[],"copied":[],"skipped":[]},"setup":{"ran":false,"exit":null},"herdr":{"space":"sp…","tabs":{"setup":"tb…","agent":"tb…","dev":"tb…"}}}
```

`--task <text>` is the agent's first message. When the agent starts at once, Herdr sends it. When it waits for setup, `graft agent` sends it with `hc send` once the agent reports `idle`, because an agent that starts minutes after its tab may miss Herdr's own first message.

A space "shows" a folder the way Herdr's sidebar decides: the folder its first terminal's program is in now (`foreground.cwd` in `hc get`, not where the terminal started), else the folder it was opened in. A folder inside another worktree (with a `worktrees_dir` inside the repository) counts as that worktree's, not the outer one's. `remove` closes those spaces, `clean` skips their worktrees and `status` reports them.

### Picker

`graft herdr install` adds a picker to Herdr, opened with `cmd-g` on macOS or `ctrl-shift-g` on Linux (or `herdr-app do mod.open --name graft-new`):

1. Pick a source: a new branch (type a name, used as typed, or a title the [branch template](#branch-names) names), an existing local or remote branch, a pull request, or a Linear or Jira issue, or **Remove worktree** (below). Typing filters each list; branches, pull requests and issues come from `graft search … --json`.
2. For a new branch, pick its base: the remote's default branch, another worktree's branch (`--from`), or any branch (`--base`).
3. Enter runs `graft create … --open herdr --json` in a hidden `hc` terminal, with a spinner. On success the picker closes and the new space opens with its `setup` tab; on failure it shows graft's message and the last output lines. Esc goes back a level; while creating, it stops the create.

**Remove worktree**, the last source, lists the repository's worktrees (all but the main checkout, filterable, with `dirty`, `merged` and `open` badges). Enter asks, then runs `graft remove <path> --json` from the main checkout in a hidden `hc` terminal: teardown runs, the worktree's spaces close, and the branch is deleted only if merged. The picker then says what happened to the branch. A refusal, such as uncommitted changes, shows graft's message; the picker never passes `--force`. A running remove can't be cancelled, since stopping it mid-teardown would leave a half-removed worktree.

graft runs in the focused terminal's folder (else the shown space's), so open the picker from the repository you want a worktree of. The mod only calls `graft`; it needs `graft` on the `PATH` Herdr's `exec` sees.

`graft herdr install`:

- Symlinks `herdr/mods/graft-new`, `graft-panel` and `graft-tabs` into `$HERDR_APP_HOME/mods` (default `~/.config/herdr-app/mods`), and `herdr/layouts/graft.json` into `$HERDR_APP_HOME/layouts`. It copies the Worktrees icon to `$HERDR_APP_HOME/graft-icons/graft.svg`, overwritten every run, because Herdr loads no SVG through a symlinked mod folder. Run from source, the links point into this repository, so a `git pull` updates them. The binary carries the mods inside it: it writes them to `~/.config/graft/herdr` (overwritten on every run; `$XDG_CONFIG_HOME/graft/herdr` when set) and links those, so rerun `graft herdr install` after `graft update`. Anything already there that isn't graft's symlink is left alone (`exists`). Herdr may not reload a symlinked mod when its files change: restart Herdr after an update.
- Binds `cmd-g` on macOS or `ctrl-shift-g` on Linux to `mod.open:graft-new` in the `global` section of `keys.json`, after asking on a terminal, or at once with `--yes`. Without a terminal and without `--yes` it binds nothing (`declined`), and it never replaces a key bound to something else (`taken`) or creates a missing `keys.json` (`missing`).
- Run it again at any time: what is already there is reported as `present`.

On Linux, rerun `graft herdr install --yes` after updating to add `ctrl-shift-g`. Existing bindings, including an older `cmd-g` binding, stay unchanged.

To uninstall, remove the symlinks and graft's `cmd-g` or `ctrl-shift-g` entries from `keys.json`.

### Side panel

A Worktrees panel on the right of the Herdr window lists the worktrees of the repository you are in (the focused terminal's folder, else the shown space's), from `graft list --json`:

- Each row shows the branch and its state: `main`, `locked`, `prunable`, `dirty`, `↑ahead`/`↓behind`, `merged`, and the pull request (`#12 open`). The dot is filled when a Herdr space shows the worktree.
- Click a row to go to its space, or open one (`graft open`).
- **Remove** asks, then runs `graft remove <path>` (teardown, space closed, branch deleted only if merged). A refusal, such as uncommitted changes, is shown with graft's message; the panel never passes `--force`.
- **Clean merged** lists what `graft clean --dry-run` would remove, asks, then runs `graft clean --yes` on exactly those paths: one that stopped qualifying meanwhile is skipped, and nothing else is touched.
- Remove and clean run in a hidden `hc` terminal, like the picker's create, because teardown can take minutes. Only one runs at a time.
- It refreshes every 10 seconds, when branches, HEADs or worktrees change in the repository's `.git`, and when you move to another space or pane. Pull requests come from `graft list --pr --json` at most once a minute. Spaces on other machines aren't supported.

Herdr's own layouts and mods can't be changed, so graft ships a copy of Herdr's `main` layout (`graft`) whose panel stack has a `graft` block showing the `graft-panel` mod, and a copy of the `tabs` mod (`graft-tabs`) with a **Worktrees** button next to Files and Changes. `graft herdr install` adds them; switch to the layout with `cmd-shift-l` (or `herdr-app do layout.switch --name graft`). Your current layout is left as it was.

If you use a layout of your own, add the panel to it instead: a `{"id": "graft", "type": "block", "content": {"mod": "graft-panel"}}` child in its `panel-body` stack, and a button with the icon `graft-icons/graft.svg` that runs `layout.select {stack: "panel-body", child: "graft"}` then `layout.show {id: "panel"}` in its tab bar (see `herdr/mods/graft-tabs/main.js`, two lines marked `graft:`). The copies don't follow Herdr's updates to `main` and `tabs`.

## Pull requests

`create --pr`, `search prs`, `status` and `list --pr` talk to the forge through its own CLI, chosen by the host of the remote's URL (`git remote get-url <remote>`, with the remote picked as for `create`):

| Host | CLI | Head of a fork PR |
|---|---|---|
| `github.com` | [`gh`](https://cli.github.com) | `refs/pull/<n>/head` |
| `gitlab.com` | [`glab`](https://gitlab.com/gitlab-org/cli) | `refs/merge-requests/<n>/head` |
| `origin.cursor.com` | [`origin`](https://cursor.com/docs/origin/cli) | none: Origin pull requests come from branches of the repository |

Install the CLI and log in with it; graft stores no forge token. Every call names the repository explicitly (`-R owner/name`, taken from the remote URL), so a checkout with several remotes is never ambiguous. Other hosts (including self-hosted GitHub Enterprise or GitLab) are `unsupported`.

The three CLIs are mapped to one shape:

```json
{"number":42,"title":"Fix login","url":"https://github.com/acme/app/pull/42","state":"open","head":"fix-login","base":"main","headSha":"9c1f0e2…","fork":false,"mergedAt":"2026-10-30T18:24:32Z","ci":"success"}
```

| Field | Meaning |
|---|---|
| `state` | `open`, `draft`, `merged` or `closed` (a GitLab MR being merged, `locked`, is `open`) |
| `head`, `base` | head and target branch names |
| `fork` | the head lives in another repository (GitHub `isCrossRepository`, GitLab source project ≠ target project; always `false` on Origin) |
| `mergedAt` | only when merged |
| `ci` | the head's checks rolled up: `failure` if any failed, else `pending` if any hasn't finished, else `success`. Absent when there are no checks or the CLI doesn't report them: `glab` and `origin` only report checks for one PR (`status`, `create`), not in lists |

`graft create --pr <number|url>` checks out the PR's head branch under its own name:

1. Look the PR up (`gh pr view`, `glab mr view`, `origin pr view`).
2. Same repository: exactly like `--remote <head>` (fetch `<remote>/<head>`, use the local branch if there is one, else track the remote one).
3. A fork, or a head branch already deleted from the remote: fetch the forge's pull ref into a new local branch, `git fetch --no-tags <remote> refs/pull/<n>/head:refs/heads/<head>`, and check it out. It has no upstream. If a local branch of that name already exists, graft stops with `exists`; check it out with `--remote <head>` instead.

Errors: no CLI or an unknown host is `unsupported`, a PR the forge doesn't know is `not-found`, other CLI failures (network, auth) are `network`.

## Linear

`create --linear <ID>` and `search linear` call Linear's GraphQL API (`https://api.linear.app/graphql`) with a [personal API key](https://linear.app/settings/account/security). Put it in the [user config](#user-config-configgraftconfigtoml), or in `LINEAR_API_KEY`, which wins over the file:

```toml
# ~/.config/graft/config.toml   (chmod 600)
[linear]
api_key = "lin_api_…"
```

graft warns when the file holding the key can be read by other users. graft only reads issues; it never changes them.

`graft create --linear ABC-123`:

1. Looks the issue up (`issue(id:)`); an unknown ID is `not-found`, a missing key `usage`, other API failures `network`.
2. Names a new branch with the [branch template](#branch-names): `{key}` is the ID lowercased (`abc-123`), `{slug}` the title's slug, `{linear}` Linear's suggested `branchName`. With no template that is `abc-123-fix-the-login-page`; `template = "{linear}"` uses Linear's name as it is.
3. Goes on like `--title`: from `--base`, `--from` or the default branch, then links, copies and `setup`.
4. With `--open herdr` and an `[agent] command`, the agent's first message is `ABC-123 Fix the login page` and the issue URL on the next line, unless `--task` is given.

## Jira

`create --jira <KEY>` and `search jira` call Jira Cloud's REST API v3 (`GET /rest/api/3/issue/<KEY>`, `POST /rest/api/3/search/jql`) with Basic auth: your Atlassian email and an [API token](https://id.atlassian.com/manage-profile/security/api-tokens). Put them in the [user config](#user-config-configgraftconfigtoml), or in `JIRA_SITE`, `JIRA_EMAIL` and `JIRA_API_TOKEN`, which win over the file one by one:

```toml
# ~/.config/graft/config.toml   (chmod 600)
[jira]
site = "acme.atlassian.net"     # https:// is optional
email = "me@example.com"
api_token = "…"
```

graft warns when the file holding the token can be read by other users. graft only reads issues; it never changes them.

`graft create --jira ABC-123`:

1. Looks the issue up; an unknown key (or one you can't see) is `not-found`, a missing setting `usage`, bad credentials and other API failures `network`.
2. Names a new branch with the [branch template](#branch-names): `{key}` is the key lowercased (`abc-123`), `{slug}` the summary's slug. Jira has no branch-name field, so `{linear}` is empty. With no template that is `abc-123-fix-the-login-page`.
3. Goes on like `--title`: from `--base`, `--from` or the default branch, then links, copies and `setup`.
4. With `--open herdr` and an `[agent] command`, the agent's first message is `ABC-123 Fix the login page` and the issue URL (`https://<site>/browse/ABC-123`) on the next line, unless `--task` is given.

## Configuration

### `graft.toml` (per repository, versioned)

graft reads `graft.toml` from the root of the main checkout, whichever worktree you run it from.

```toml
remote = "origin"            # optional; see `create` for the default
link = [".env.local"]        # gitignored files or folders to symlink from the main checkout

[hooks]
setup = """
pnpm install
pnpm run db:migrate
"""
teardown = "pnpm run db:drop"  # run by `remove` (and `graft teardown`), before the worktree is deleted

[branch]
template = "{user}/{key}-{slug}"   # for --title and tickets; see Branch names

[[tabs]]                       # extra tabs for `--open herdr`
title = "dev"
command = "pnpm dev"

[agent]                        # the agent tab for `--open herdr`
command = ["claude"]
```

Unknown keys are reported on stderr and ignored. A key with the wrong type is an error.

### Gitignored files

A new worktree has none of the main checkout's gitignored files (`.env.local`, local settings, certificates). graft brings them in two ways, right after `git worktree add` and before `setup`:

- `link` in `graft.toml`: each path is symlinked to the main checkout's copy, so every worktree shares one file. Use it for files you edit in one place, like `.env.local`.
- `.worktreeinclude` at the root of the main checkout: each path is copied, so the worktree gets its own version. One path per line, `#` starts a comment; globs (`*`, `?`) and negation (`!`) are not supported and are skipped with a warning. On macOS copies are APFS clones when possible. Copies are capped at 2 GiB and 50,000 entries in total.

```text
# .worktreeinclude
certs/
data/seed.sqlite
```

For both, a path is relative to the repository root and is skipped, never an error, when:

| Reason | Meaning |
|---|---|
| `invalid` | absolute, or has a `..` segment |
| `missing` | not in the main checkout |
| `exists` | already in the worktree (even a broken symlink): graft never overwrites. A path in both lists stays a link. |
| `not-ignored` | not gitignored in the main checkout (tracked files come from git) |
| `too-large` | over the copy budget |
| `error` | `ln`, `cp` or `git check-ignore` failed |

`remove` deletes graft's symlinks before removing the worktree; the files they point to stay in the main checkout.

### Hooks

Hooks run with `bash -e -c <script>`, so the first failing line stops the hook and its exit code is reported. The working directory is the worktree, stdin is inherited and output is streamed to stderr. These variables are set:

| Variable | Value |
|---|---|
| `GRAFT_ROOT` | main checkout path |
| `GRAFT_WORKTREE` | the worktree's path (also the working directory) |
| `GRAFT_BRANCH` | branch name |
| `GRAFT_NAME` | the worktree's folder name |
| `GRAFT_BASE` | base the branch was created from, e.g. `origin/main` (empty for `--remote` or if unknown) |

### User config (`~/.config/graft/config.toml`)

Private settings, never committed. `$XDG_CONFIG_HOME/graft/config.toml` when `XDG_CONFIG_HOME` is set. Optional: `graft init` creates it with these examples commented out.

```toml
user = "alice"                  # optional: {user} in branch templates
worktrees_dir = "~/worktrees"   # optional: worktrees go to <worktrees_dir>/<repo>/<folder> instead (a relative path is relative to the main checkout)

# Config for a repository that has no graft.toml (e.g. a team repo you don't want to change).
[repos."~/code/team-app"]
link = [".env"]

[repos."~/code/team-app".hooks]
setup = "pnpm install"

[linear]
api_key = "lin_api_…"           # for --linear and search linear; LINEAR_API_KEY wins over it

[jira]                          # for --jira and search jira; JIRA_SITE, JIRA_EMAIL, JIRA_API_TOKEN win over it
site = "acme.atlassian.net"
email = "me@example.com"
api_token = "…"
```

The file can hold tokens, so keep it private: `chmod 600 ~/.config/graft/config.toml`. graft warns when a token is read from it while others can read it.

If the repository has a `graft.toml`, it wins and the `[repos."…"]` entry is ignored, with a warning. The two are never merged.

### Examples

- [`examples/node-env-links.toml`](examples/node-env-links.toml): link `.env.local` files, then `pnpm install`.
- [`examples/db-per-worktree.toml`](examples/db-per-worktree.toml): setup and teardown scripts that own a database and ports per worktree.

## Errors and exit codes

With `--json`, errors are printed on stdout as `{"error":{"kind":"…","message":"…","hint":"…"}}`.

| Exit | Kind |
|---|---|
| 1 | unexpected error |
| 2 | `usage` |
| 3 | `not-a-repo` |
| 4 | `not-found` |
| 5 | `exists` |
| 6 | `dirty` |
| 7 | `locked` |
| 8 | `setup-failed` |
| 9 | `teardown-failed` |
| 10 | `agent-working` |
| 11 | `unsupported` |
| 12 | `network` |

## Development

```sh
bun test
bun run typecheck
bun run build    # dist/graft: compiled with the herdr/ folder embedded, signed ad hoc (macOS)
```

CI (`.github/workflows/ci.yml`) runs the tests, the typecheck and a compiled `graft list --json` on every push and pull request. To release, set `version` in `package.json`, commit, and push a matching tag (`v0.2.0`): `.github/workflows/release.yml` builds the four binaries and publishes them as a GitHub release, which `graft update` then finds.

Most tests run against a fake `Io` (`src/test/fake-io.ts`). Tests named `*.real.test.ts` use real git in a temp directory, with the host's git config shut out.

The Herdr mods live in `herdr/mods`: the picker `graft-new`, the side panel `graft-panel` and the tab bar copy `graft-tabs`; the layout copy is `herdr/layouts/graft.json`. The picker's and the panel's logic is in `lib.js`, tested by `bun test` (`lib.test.js`, with a stand-in for `hc`). Herdr refuses imports from outside a mod's folder, so the panel's `lib.js` carries copies of the picker's `runLong` and JSON helpers; a test keeps them identical. `main.js` imports Herdr's runtime modules, so it is left out of `bun run typecheck` and checked with:

```sh
herdr-app check herdr/mods/graft-new
herdr-app check herdr/mods/graft-panel
herdr-app check herdr/mods/graft-tabs
```

## License

MIT
