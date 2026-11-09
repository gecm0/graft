// The side panel's logic, kept free of the `herdr` module so `bun test` can load it.
// Every fact comes from `graft … --json`; nothing here knows git beyond which paths to watch.

// One panel row per `graft list --json` entry. `prs`: the last `graft list --pr --json`,
// whose `pr` is kept on rows of the same path until the next one lands (it is slow and online).
export function panelRows(list, prs, cwd) {
  const byPath = new Map((prs ?? []).map((w) => [w.path, w.pr ?? null]));
  // The deepest match wins when worktrees live inside the main checkout.
  const current = (list ?? []).filter((w) => !w.prunable && (cwd === w.path || cwd?.startsWith(`${w.path}/`)))
    .sort((a, b) => b.path.length - a.path.length)[0];
  return (list ?? []).map((w) => ({ ...w, current: w === current, pr: w.pr !== undefined ? w.pr : byPath.get(w.path) ?? null }));
}

// Keep one refresh context while moving between known worktrees of the same repository.
export function panelContext(list, { cwd, on }) {
  const known = !on && (list ?? []).some((w) => !w.prunable && (cwd === w.path || cwd?.startsWith(`${w.path}/`)));
  return JSON.stringify({ cwd: known ? list.find((w) => w.main)?.path ?? cwd : cwd, on });
}

// Short state words for a row, in the order shown.
export function badges(w) {
  const out = [];
  if (w.current) out.push("current");
  if (w.main) out.push("main");
  if (w.locked) out.push("locked");
  if (w.prunable) out.push("prunable");
  if (w.dirty) out.push("dirty");
  if (w.ahead) out.push(`↑${w.ahead}`);
  if (w.behind) out.push(`↓${w.behind}`);
  if (w.merged) out.push("merged");
  if (w.pr) out.push(`#${w.pr.number} ${w.pr.state}`);
  return out;
}

// The git common dir to watch: the main checkout's .git.
// ponytail: assumes a non-bare repo with a .git folder; a bare main or a .git file just isn't watched usefully (the 10 s timer still refreshes).
export function commonDir(list) {
  const main = (list ?? []).find((w) => w.main);
  return main ? `${main.path}/.git` : null;
}

// Whether a watch batch under the common dir changed what the panel shows: a ref, a HEAD, or a
// worktree added or removed. graft list itself writes index files and objects there (git status,
// merge-tree), so anything else is ignored, or each refresh would trigger the next.
export function relevant(paths, common) {
  return paths.some((p) => {
    if (!p.startsWith(`${common}/`)) return false;
    const rel = p.slice(common.length + 1);
    if (rel.endsWith(".lock")) return false;
    return rel === "HEAD" || rel === "packed-refs" || rel.startsWith("refs/") || /^worktrees\/[^/]+(\/HEAD)?$/.test(rel);
  });
}

export const removeArgv = (path) => ["remove", path, "--json"];
// `paths`: with --yes, the confirmed candidates; clean checks each again and touches nothing else.
export const cleanArgv = (dryRun, paths = []) => ["clean", ...paths, dryRun ? "--dry-run" : "--yes", "--json"];

// One line about what a finished remove or clean did.
export function summary(argv, result) {
  if (argv[0] === "remove") {
    const b = result.branch;
    const branch = !b ? "" : b.deleted ? `, branch ${b.name} deleted` : `, branch ${b.name} kept (${b.reason})`;
    return `Removed ${result.removed.split("/").pop()}${branch}`;
  }
  const failed = result.failed.length ? `, ${result.failed.length} failed: ${result.failed.map((f) => f.error.message).join("; ")}` : "";
  const skipped = result.skipped?.length ? `, ${result.skipped.length} skipped (${result.skipped.map((s) => s.reason).join(", ")})` : "";
  return `Cleaned ${result.removed.length} worktree${result.removed.length === 1 ? "" : "s"}${failed}${skipped}`;
}

// The functions below are copies of graft-new/lib.js: Herdr refuses imports from outside a mod's folder.
// lib.test.js checks they stay identical.

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
    const start = line.indexOf("{");
    if (start < 0) continue;
    try {
      return JSON.parse(line.slice(start));
    } catch {}
  }
  return null;
}

const LONG_LIMIT_MS = 15 * 60 * 1000;

// `exec` stops at 30 s and setup or teardown can take minutes, so they run in a hidden core terminal
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

// How a finished graft command went: { ok: true, result } or { ok: false, message, tail }.
// tail: the last output lines other than the error JSON (teardown's and graft's progress).
// clean exits non-zero when one removal failed but still prints its full result: that is ok here.
export function outcome(exit, text, what) {
  const out = lastJson(text);
  if (out && !out.error && (exit === 0 || Array.isArray(out.failed))) return { ok: true, result: out };
  const tail = text.split("\n").filter((l) => l.trim() && !l.startsWith('{"error"')).slice(-8).join("\n");
  const message = out?.error ? (out.error.hint ? `${out.error.message}\n${out.error.hint}` : out.error.message) : `graft ${what} exited ${exit ?? "without a code"}`;
  return { ok: false, message, tail };
}
