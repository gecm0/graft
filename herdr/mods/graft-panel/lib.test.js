import { expect, test } from "bun:test";
import * as picker from "../graft-new/lib.js";
import { badges, cleanArgv, commonDir, outcome, panelRows, relevant, removeArgv, runLong, summary } from "./lib.js";
import * as panel from "./lib.js";

const main = { path: "/r/app", branch: "main", main: true, locked: false, prunable: false, dirty: false, ahead: null, behind: null, merged: false, space: "sp1" };
const wip = { path: "/r/app.worktrees/wip", branch: "wip", main: false, locked: false, prunable: false, dirty: true, ahead: 2, behind: 1, merged: false, space: null };

test("the copies of the picker's helpers stay identical", () => {
  for (const name of ["parseResult", "lastJson", "runLong"]) expect(panel[name].toString()).toBe(picker[name].toString());
});

test("the last list --pr keeps its PRs on the rows of a later plain list", () => {
  const pr = { number: 7, state: "open" };
  const rows = panelRows([main, wip], [{ ...wip, pr }, { path: "/gone", pr: { number: 1 } }]);
  expect(rows.map((r) => r.pr)).toEqual([null, pr]);
  expect(panelRows([main], null)[0].pr).toBeNull();
  expect(panelRows(null, null)).toEqual([]);
});

test("badges", () => {
  expect(badges({ ...wip, pr: { number: 7, state: "draft" } })).toEqual(["dirty", "↑2", "↓1", "#7 draft"]);
  expect(badges({ ...main, merged: true, locked: true })).toEqual(["main", "locked", "merged"]);
});

test("only ref, HEAD and worktree changes refresh; graft's own index and object writes don't", () => {
  const common = commonDir([wip, main]);
  expect(common).toBe("/r/app/.git");
  const yes = ["HEAD", "packed-refs", "refs/heads/wip", "worktrees/wip", "worktrees/wip/HEAD"];
  const no = ["index", "worktrees/wip/index", "objects/ab/cdef", "refs/heads/wip.lock", "FETCH_HEAD", "logs/HEAD"];
  for (const p of yes) expect(relevant([`${common}/${p}`], common)).toBe(true);
  for (const p of no) expect(relevant([`${common}/${p}`], common)).toBe(false);
  expect(relevant(["/elsewhere/HEAD"], common)).toBe(false);
  expect(commonDir([wip])).toBeNull();
});

test("remove and clean argv, and what they did", () => {
  expect(removeArgv("/r/app.worktrees/wip")).toEqual(["remove", "/r/app.worktrees/wip", "--json"]);
  expect(cleanArgv(true)).toEqual(["clean", "--dry-run", "--json"]);
  expect(cleanArgv(false, ["/w/a", "/w/b"])).toEqual(["clean", "/w/a", "/w/b", "--yes", "--json"]);
  const removed = { removed: "/r/app.worktrees/wip", branch: { name: "wip", deleted: false, reason: "not-merged" } };
  expect(summary(removeArgv("x"), removed)).toBe("Removed wip, branch wip kept (not-merged)");
  const cleaned = { removed: [{ path: "/a" }], failed: [{ error: { message: "dirty" } }] };
  expect(summary(cleanArgv(false), cleaned)).toBe("Cleaned 1 worktree, 1 failed: dirty");
  // A confirmed worktree that stopped qualifying is skipped, and said so.
  expect(summary(cleanArgv(false), { removed: [], failed: [], skipped: [{ reason: "dirty" }] })).toBe("Cleaned 0 worktrees, 1 skipped (dirty)");
});

test("a clean with a failed removal still reports its result; a refused remove is a failure", () => {
  const cleaned = { dryRun: false, candidates: [], removed: [], skipped: [], failed: [{ error: { message: "x" } }] };
  expect(outcome(4, `progress\n${JSON.stringify(cleaned)}`, "clean")).toEqual({ ok: true, result: cleaned });
  const refused = '{"error":{"kind":"dirty","message":"wip has changes","hint":"pass --force"}}';
  expect(outcome(4, `teardown…\n${refused}`, "remove")).toEqual({ ok: false, message: "wip has changes\npass --force", tail: "teardown…" });
  expect(outcome(1, "boom", "remove").message).toBe("graft remove exited 1");
});

test("remove runs in a hidden terminal with the given PATH, then the terminal is removed", async () => {
  const calls = [];
  const replies = { run: { stdout: '{"address":"t3"}' }, wait: { stdout: '{"ended":true,"exit_code":0}' }, read: { stdout: '{"text":"{\\"removed\\":\\"/w\\"}"}' } };
  const hc = async (args) => (calls.push(args), { code: 0, stdout: "", stderr: "", ...replies[args[0]] });
  const r = await runLong(hc, ["/bin/graft", ...removeArgv("/w")], { cwd: "/r/app", env: ["PATH=/x"] });
  expect(r).toEqual({ exit: 0, text: '{"removed":"/w"}' });
  expect(calls[0]).toEqual(["run", "--bg", "--json", "--no-parent", "--no-notify", "--cwd", "/r/app", "--", "env", "PATH=/x", "/bin/graft", "remove", "/w", "--json"]);
  expect(calls.at(-1)).toEqual(["rm", "t3"]);
});

