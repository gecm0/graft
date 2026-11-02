import { expect, test } from "bun:test";
import { SOURCES, baseRows, createArgv, itemRows, outcome, parseResult, removeArgv, removeSummary, runLong, sourceRows } from "./lib.js";

const source = (id) => SOURCES.find((s) => s.id === id);

// A stand-in for the herdr module's hc(): scripted replies by subcommand, calls recorded.
function fakeHc(replies) {
  const calls = [];
  const hc = async (args) => {
    calls.push(args);
    const r = replies[args[0]];
    const next = Array.isArray(r) ? r.shift() : r;
    return { code: 0, stdout: "", stderr: "", ...next };
  };
  return { hc, calls };
}

test("sources filter by label", () => {
  expect(sourceRows("").map((r) => r.key)).toEqual(["new", "branch", "pr", "linear", "jira", "remove"]);
  expect(sourceRows("rem").map((r) => r.key)).toEqual(["remove"]);
  expect(sourceRows("issue").map((r) => r.key)).toEqual(["linear", "jira"]);
  // A word's start, in the name only: "l" isn't "New branch" (its detail says "title") nor "pull".
  expect(sourceRows("l").map((r) => r.key)).toEqual(["linear"]);
  expect(sourceRows("linear iss").map((r) => r.key)).toEqual(["linear"]);
  expect(sourceRows("e").map((r) => r.key)).toEqual(["branch"]);
});

test("a typed new branch offers a name and a title, a phrase only a title", () => {
  expect(itemRows(source("new"), null, "fix-login").map((r) => r.args)).toEqual([["--branch", "fix-login"], ["--title", "fix-login"]]);
  expect(itemRows(source("new"), null, "Fix login").map((r) => r.args)).toEqual([["--title", "Fix login"]]);
  expect(itemRows(source("new"), null, "  ")).toEqual([]);
});

test("search hits become create flags, local and remote branches kept apart", () => {
  const branches = [
    { name: "feat", where: "local", ref: "refs/heads/feat", date: "" },
    { name: "feat", where: "remote", ref: "refs/remotes/origin/feat", date: "" },
  ];
  const rows = itemRows(source("branch"), branches, "");
  expect(rows.map((r) => [r.badge, r.detail, r.args])).toEqual([
    ["local", "feat", ["--remote", "feat"]],
    ["remote", "origin/feat", ["--remote", "feat"]],
  ]);
  expect(itemRows(source("pr"), [{ number: 42, title: "Fix", head: "fix", base: "main", state: "open" }], "")[0].args).toEqual(["--pr", "42"]);
  expect(itemRows(source("linear"), [{ identifier: "ABC-1", title: "T", url: "u", state: "Todo" }], "")[0].args).toEqual(["--linear", "ABC-1"]);
  expect(itemRows(source("jira"), [{ key: "KEY-1", summary: "S", url: "u", status: "Open" }], "")[0].args).toEqual(["--jira", "KEY-1"]);
});

test("bases: the default first, then worktrees (filtered here), then branches (filtered by graft)", () => {
  const worktrees = [
    { path: "/r/app", branch: "main", main: true, prunable: false },
    { path: "/r/app.worktrees/wip", branch: "wip", main: false, prunable: false },
    { path: "/r/app.worktrees/gone", branch: "gone", main: false, prunable: true },
    { path: "/r/app.worktrees/det", branch: null, main: false, prunable: false },
  ];
  const branches = [
    { name: "release", where: "remote", ref: "refs/remotes/origin/release", date: "" },
    { name: "release", where: "local", ref: "refs/heads/release", date: "" },
  ];
  // The local row names its ref: plain "release" would resolve to origin/release.
  expect(baseRows(worktrees, branches, "").map((r) => r.args)).toEqual([[], ["--from", "/r/app"], ["--from", "/r/app.worktrees/wip"], ["--base", "release"], ["--base", "refs/heads/release"]]);
  expect(baseRows(worktrees, [], "wip").map((r) => r.key)).toEqual(["default", "wt-/r/app.worktrees/wip"]);
});

test("create always opens Herdr and prints JSON", () => {
  const item = { args: ["--linear", "ABC-1"] };
  expect(createArgv(item, { args: ["--base", "release"] })).toEqual(["create", "--linear", "ABC-1", "--base", "release", "--open", "herdr", "--json"]);
  expect(createArgv({ args: ["--pr", "4"] }, null)).toEqual(["create", "--pr", "4", "--open", "herdr", "--json"]);
});

test("graft's JSON errors become thrown messages with the hint", () => {
  expect(parseResult('[{"name":"main"}]', 0)).toEqual([{ name: "main" }]);
  expect(() => parseResult('{"error":{"kind":"usage","message":"no key","hint":"set LINEAR_API_KEY"}}', 2)).toThrow("no key\nset LINEAR_API_KEY");
  expect(() => parseResult("", 127)).toThrow("graft exited 127");
});

test("runLong polls hc wait until the terminal ends, reads it, then removes it", async () => {
  const { hc, calls } = fakeHc({
    run: { stdout: '{"address":"t9"}' },
    wait: [{ stdout: '{"ended":false}' }, { stdout: '{"ended":true,"exit_code":0}' }],
    read: { stdout: JSON.stringify({ text: 'graft: creating /w\n{"worktree":"/w","branch":"b"}' }) },
  });
  const r = await runLong(hc, ["/bin/graft", "create"], { cwd: "/r/app", env: ["PATH=/x"] });
  expect(r).toEqual({ exit: 0, text: 'graft: creating /w\n{"worktree":"/w","branch":"b"}' });
  expect(calls[0]).toEqual(["run", "--bg", "--json", "--no-parent", "--no-notify", "--cwd", "/r/app", "--", "env", "PATH=/x", "/bin/graft", "create"]);
  expect(calls.map((c) => c[0])).toEqual(["run", "wait", "wait", "read", "rm"]);
  expect(outcome(r.exit, r.text)).toEqual({ ok: true, result: { worktree: "/w", branch: "b" } });
});

test("runLong kills and removes a job past its 15 minutes", async () => {
  let t = 0;
  const { hc, calls } = fakeHc({ run: { stdout: '{"address":"t9"}' }, wait: { stdout: '{"ended":false}' } });
  const now = () => (t += 10 * 60 * 1000);
  await expect(runLong(hc, ["graft", "create"], { cwd: "/r", now })).rejects.toThrow("timed out");
  expect(calls.map((c) => c[0])).toEqual(["run", "wait", "kill", "rm"]);
});

test("a failed create shows graft's message, hint and the output before it", () => {
  const text = 'graft: creating /w\nfatal: invalid reference\n{"error":{"kind":"not-found","message":"no such branch","hint":"run: graft search branches"}}';
  expect(outcome(4, text)).toEqual({ ok: false, message: "no such branch\nrun: graft search branches", tail: "graft: creating /w\nfatal: invalid reference" });
  expect(outcome(null, "")).toMatchObject({ ok: false, message: "graft create exited without a code" });
});

test("remove lists every worktree but the main checkout, filtered, and removes by path", () => {
  const list = [
    { path: "/r", branch: "main", main: true },
    { path: "/r.worktrees/fix-login", branch: "fix-login", main: false, dirty: true, space: "sp1" },
    { path: "/r.worktrees/old", branch: null, main: false, merged: true },
  ];
  const rows = itemRows(source("remove"), list, "");
  expect(rows.map((r) => [r.label, r.badge])).toEqual([["fix-login", "dirty · open"], ["(detached)", "merged"]]);
  expect(itemRows(source("remove"), list, "LOGIN").map((r) => r.label)).toEqual(["fix-login"]);
  expect(itemRows(source("remove"), null, "")).toEqual([]);
  expect(removeArgv(rows[0])).toEqual(["remove", "/r.worktrees/fix-login", "--json"]);
});

test("a remove's summary says what happened to the branch", () => {
  expect(removeSummary({ removed: "/r.worktrees/fix-login", branch: { name: "fix-login", deleted: true } })).toBe("Removed fix-login, branch fix-login deleted");
  expect(removeSummary({ removed: "/r.worktrees/x", branch: { name: "x", deleted: false, reason: "not-merged" } })).toBe("Removed x, branch x kept (not-merged)");
  expect(removeSummary({ removed: "/r.worktrees/d", branch: null })).toBe("Removed d");
  expect(outcome(1, "", "remove")).toMatchObject({ ok: false, message: "graft remove exited 1" });
});
