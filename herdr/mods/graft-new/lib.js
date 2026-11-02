// The picker's logic, kept free of the `herdr` module so `bun test` can load it.
// Every fact comes from `graft … --json`; nothing here knows git.

// The first level. `search`: the `graft search` kind that lists its items (none: typed text).
// `base`: the source makes a new branch, so a base level follows.
export const SOURCES = [
  { id: "new", label: "New branch", detail: "type a branch name or a title", search: null, base: true },
  { id: "branch", label: "From existing branch", detail: "a local or remote branch, checked out as is", search: "branches", base: false },
  { id: "pr", label: "From pull request", detail: "its head branch, checked out as is", search: "prs", base: false },
  { id: "linear", label: "From Linear issue", detail: "a new branch named from the issue", search: "linear", base: true },
  { id: "jira", label: "From Jira issue", detail: "a new branch named from the issue", search: "jira", base: true },
  // Not a create: its items are this repository's worktrees, from `graft list --json`.
  { id: "remove", label: "Remove worktree", detail: "teardown runs, its space closes, the branch is deleted only if merged", search: null, base: false },
];

// A row: { key, label, detail, badge, args } where args are the `graft create` flags it stands for.
// Filtered like the palette: the name only, from the start of a word, so "l" is Linear alone.
export function sourceRows(query) {
  const q = query.trim().toLowerCase();
  const rows = SOURCES.map((s) => ({ key: s.id, label: s.label, detail: s.detail, badge: "", args: [], source: s }));
  return q ? rows.filter((r) => ` ${r.label.toLowerCase()}`.includes(` ${q}`)) : rows;
}

// Rows for a source's level from what `graft search <kind> --json` printed (null for "new"),
// or for "remove", what `graft list --json` printed: every worktree but the main checkout.
export function itemRows(source, hits, query) {
  const q = query.trim();
  if (source.id === "remove") {
    const trees = (hits ?? []).filter((w) => !w.main).map((w) => ({
      key: `rm-${w.path}`,
      label: w.branch ?? "(detached)",
      detail: w.path,
      badge: [w.dirty && "dirty", w.locked && "locked", w.prunable && "prunable", w.merged && "merged", w.space && "open"].filter(Boolean).join(" · "),
      args: [w.path],
    }));
    return filter(trees, q);
  }
  if (source.id === "new") {
    if (!q) return [];
    const title = { key: "title", label: q, detail: "a title: the repository's branch template names it", badge: "title", args: ["--title", q] };
    // A name with spaces can't be a branch, so only the title row is offered.
    return /\s/.test(q) ? [title] : [{ key: "name", label: q, detail: "a branch name, used as typed", badge: "name", args: ["--branch", q] }, title];
  }
  const rows = (hits ?? []).map((h) => {
    if (source.id === "branch") return { key: h.ref, label: h.name, detail: h.ref.replace(/^refs\/(heads|remotes)\//, ""), badge: h.where, args: ["--remote", h.name] };
    if (source.id === "pr") return { key: `pr-${h.number}`, label: `#${h.number} ${h.title}`, detail: `${h.head} → ${h.base}`, badge: h.state, args: ["--pr", String(h.number)] };
    if (source.id === "linear") return { key: h.identifier, label: `${h.identifier} ${h.title}`, detail: h.url, badge: h.state, args: ["--linear", h.identifier] };
    return { key: h.key, label: `${h.key} ${h.summary}`, detail: h.url, badge: h.status, args: ["--jira", h.key] };
  });
  return rows;
}

// The base level: the remote's default branch, another worktree's branch (`--from`), or any branch.
// `worktrees`: `graft list --json`; `branches`: `graft search branches <q> --json` (already filtered).
export function baseRows(worktrees, branches, query) {
  const def = { key: "default", label: "Default branch", detail: "the remote's default branch, freshly fetched", badge: "", args: [] };
  const trees = (worktrees ?? [])
    .filter((w) => w.branch && !w.prunable)
    .map((w) => ({ key: `wt-${w.path}`, label: w.branch, detail: w.path, badge: w.main ? "main checkout" : "worktree", args: ["--from", w.path] }));
  const refs = (branches ?? []).map((h) => ({ key: `base-${h.ref}`, label: h.name, detail: h.ref.replace(/^refs\/(heads|remotes)\//, ""), badge: h.where, args: ["--base", h.where === "local" ? h.ref : h.name] }));
  return [def, ...filter(trees, query), ...refs];
}

// Case-insensitive substring over label and detail.
export function filter(rows, query) {
  const q = query.trim().toLowerCase();
  return q ? rows.filter((r) => `${r.label} ${r.detail}`.toLowerCase().includes(q)) : rows;
}

// `graft create` for the picked item and base, always in a new Herdr space.
export function createArgv(item, base) {
  return ["create", ...item.args, ...(base?.args ?? []), "--open", "herdr", "--json"];
}

// `graft remove` for a picked worktree row; it runs in the main checkout, never in the worktree it removes.
export function removeArgv(item) {
  return ["remove", ...item.args, "--json"];
}

// One line about what a finished remove did (the panel's summary says the same).
export function removeSummary(result) {
  const b = result.branch;
  const branch = !b ? "" : b.deleted ? `, branch ${b.name} deleted` : `, branch ${b.name} kept (${b.reason})`;
  return `Removed ${result.removed.split("/").pop()}${branch}`;
}

// What a `graft … --json` call printed: the value, or an Error with graft's message and hint.
export function parseResult(stdout, code) {
  let out;
  try {
    out = JSON.parse(stdout);
  } catch {
    throw new Error(code === 0 ? "graft printed no JSON" : `graft exited ${code}`);
  }
  if (out?.error) throw new Error(out.error.hint ? `${out.error.message}\n${out.error.hint}` : out.error.message);
  return out;
}

// The last line of a terminal's text that is a JSON object: graft's result, printed after its progress.
export function lastJson(text) {
  for (const line of text.split("\n").reverse()) {
    if (!line.startsWith("{")) continue;
    try {
      return JSON.parse(line);
    } catch {}
  }
  return null;
}

const LONG_LIMIT_MS = 15 * 60 * 1000;

// `exec` stops at 30 s and setup can take minutes, so create runs in a hidden core terminal
// (no herdr.* labels, so no space shows it), polled in 20 s waits.
// `hc`: the herdr module's hc(args). `env`: KEY=VALUE pairs for the program (PATH, mainly).
// Answers { exit, text }: the exit code and the terminal's whole text, then removes the terminal.
export async function runLong(hc, argv, { cwd, env = [], onStart, now = Date.now } = {}) {
  const started = await hc(["run", "--bg", "--json", "--no-parent", "--no-notify", "--cwd", cwd, "--", "env", ...env, ...argv]);
  if (started.code !== 0) throw new Error(`could not start ${argv[0]}: ${started.stderr.trim() || started.stdout.trim()}`);
  const { address } = JSON.parse(started.stdout);
  onStart?.(address);
  let ended = false;
  try {
    const deadline = now() + LONG_LIMIT_MS;
    let waited;
    do {
      if (now() > deadline) {
        throw new Error(`${argv[0]} ${argv[1] ?? ""} timed out after 15 minutes`);
      }
      const r = await hc(["wait", address, "--json", "--timeout", "20"]);
      try {
        waited = JSON.parse(r.stdout);
      } catch {
        throw new Error(`lost track of ${argv[0]}: ${r.stderr.trim() || r.stdout.trim() || "hc wait gave nothing"}`);
      }
    } while (!waited.ended);
    ended = true;
    const read = await hc(["read", address, "--json", "--lines", "500"]);
    let text = "";
    try {
      text = JSON.parse(read.stdout).text ?? "";
    } catch {}
    return { exit: waited.exit_code, text };
  } finally {
    // A timeout or a lost `hc wait` leaves graft running; `hc rm` can't remove a live terminal.
    if (!ended) await hc(["kill", address]);
    await hc(["rm", address]);
    onStart?.(null);
  }
}

// How a finished create or remove went: { ok: true, result } or { ok: false, message, tail }.
// tail: the last output lines other than the error JSON (git's, teardown's and graft's progress).
export function outcome(exit, text, what = "create") {
  const out = lastJson(text);
  if (exit === 0 && out && !out.error) return { ok: true, result: out };
  const tail = text.split("\n").filter((l) => l.trim() && !l.startsWith('{"error"')).slice(-8).join("\n");
  const message = out?.error ? (out.error.hint ? `${out.error.message}\n${out.error.hint}` : out.error.message) : `graft ${what} exited ${exit ?? "without a code"}`;
  return { ok: false, message, tail };
}
