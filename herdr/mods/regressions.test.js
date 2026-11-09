import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import * as picker from "./graft-new/lib.js";
import * as panel from "./graft-panel/lib.js";

// Load the real View methods with host bindings, without a running Herdr window.
function view(name, host = {}) {
  const source = readFileSync(new URL(`./${name}/main.js`, import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "")
    .replace("export default class", "return class");
  const bindings = { View: class {}, ...picker, ...panel, ...host };
  const Class = new Function(...Object.keys(bindings), source)(...Object.values(bindings));
  return new Class();
}

function context() {
  const tasks = [], timers = [];
  const cx = {
    notify() {},
    spawn(fn) { tasks.push(() => fn(cx)); },
    focus_handle: () => ({ focus() {} }),
    timer: { after(_ms, fn) { timers.push(fn); }, every() {} },
  };
  return { cx, tasks, timers };
}

test("picker passes leading hyphens as string option values", () => {
  for (const text of ["-1 off by one", "-branch"]) {
    for (const row of picker.itemRows({ id: "new" }, null, text)) {
      const { values } = parseArgs({ args: row.args, options: { title: { type: "string" }, branch: { type: "string" } } });
      expect(Object.values(values)).toEqual([text]);
    }
  }
});

test("both mods parse a result after hook output with no final newline", () => {
  for (const lib of [picker, panel]) {
    expect(lib.outcome(0, 'done{"removed":"/w","branch":null}', "remove")).toEqual({ ok: true, result: { removed: "/w", branch: null } });
    expect(lib.outcome(1, 'done{"error":{"message":"refused"}}', "remove").message).toBe("refused");
  }
});

test.each([false, true])("closing the panel leaves removal running (close before start: %s)", async (early) => {
  const calls = [];
  let started;
  const p = view("graft-panel", {
    exec: async (...args) => { calls.push(args); },
    runLong: async (_hc, _argv, opts) => { started = opts.onStart; return { exit: 0, text: '{"removed":"/w","branch":null}' }; },
    hc() {},
  });
  const { cx, tasks } = context();
  p.list = [{ main: true, path: "/r" }];
  p.confirm = { kind: "remove", row: { path: "/w" } };
  p.refresh = () => {};
  p.run(cx);
  if (early) await p.close?.();
  await tasks.shift()();
  started?.("job");
  if (!early) await p.close?.();
  expect(calls.some((c) => c[0] === "hc" && c[1][0] === "kill")).toBe(false);
});

test("clean discovery clears the old confirmation and blocks duplicate actions", () => {
  const p = view("graft-panel");
  const { cx, tasks } = context();
  p.bin = "/bin/graft";
  p.list = [{ main: true, path: "/r" }];
  p.confirm = { kind: "remove", row: { path: "/w" } };
  p.askClean(cx);
  expect(p.confirm).toBeNull();
  p.run(cx);
  p.confirm = { kind: "remove", row: { path: "/w" } };
  p.run(cx);
  expect(tasks).toHaveLength(1);
  p.busy = null;
  p.confirm = null;
  p.run(cx);
  expect(tasks).toHaveLength(1);
});

test("panel clears old rows when location changes during a pending refresh", async () => {
  let cwd = "/old";
  const p = view("graft-panel", { focused: () => ({ cwd }), spaces: () => [], panes: () => [] });
  const { cx, tasks } = context();
  p.bin = "/bin/graft";
  p.list = [{ main: true, path: cwd }];
  p.context = panel.panelContext(p.list, { cwd, on: null });
  p.graft = async () => [{ main: true, path: "/old" }];
  p.watch = () => {};
  p.loadPrs = () => {};
  p.refresh(cx);
  cwd = "/new";
  p.refresh(cx);
  expect(p.list).toBeNull();
  await tasks.shift()();
  expect(tasks).toHaveLength(1);
  p.graft = async () => [{ main: true, path: "/new" }];
  await tasks.shift()();
  expect(p.list[0].path).toBe("/new");
});

test.each(["confirm", "run"])("picker timers do not steal focus on %s", (level) => {
  let focused = 0;
  const p = view("graft-new", {
    InputState: { new: () => ({ on() {}, focus() { focused++; } }) },
    focused: () => ({ cwd: "/r" }), spaces: () => [], home: () => "/home",
  });
  const { cx, timers } = context();
  p.init({}, cx);
  p.enter("base", cx);
  p.level = level;
  focused = 0;
  for (const timer of timers) timer(cx);
  expect(focused).toBe(0);
});
