// Worktrees side panel, through graft: the current repository's worktrees with their state,
// from `graft list --json` (and `list --pr --json` at most once a minute). Click a row to open
// its space; remove and "clean merged" ask first, then run in a hidden core terminal.
// Refreshes like the shipped `changes` panel: every 10 s, on git changes, on a new location.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar } from "gpui-base";
import { spaces, panes, focused, exec, hc, watchFolder, theme } from "herdr";
import { badges, cleanArgv, commonDir, outcome, panelRows, parseResult, relevant, removeArgv, runLong, summary } from "./lib.js";

const PR_EVERY_MS = 60000;

// Where the person is: the focused pane's folder, else the shown space's; on: its machine (null: this one).
function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder || null, on: space?.machine ?? null };
}
const key = () => JSON.stringify(location());

export default class GraftPanel extends View {
  init(_props, cx) {
    this.list = null; // graft list --json; null until the first answer
    this.prs = null; // the last graft list --pr --json
    this.prAt = 0;
    this.error = null;
    this.confirm = null; // { kind: "remove", row } | { kind: "clean", candidates }
    this.busy = null; // what is running, shown instead of the actions
    this.job = null; // the hidden terminal running remove or clean
    this.note = null; // { text, tail?, failed }
    // exec sees the person's real PATH; the core terminal remove and clean run in may not, so it gets this one.
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", 'printf "%s\\n" "$PATH"; command -v graft']).catch(() => null);
      const [path, bin] = (r?.stdout ?? "").trim().split("\n");
      this.bin = bin || null;
      this.env = [`PATH=${path ?? ""}`, "GIT_TERMINAL_PROMPT=0"];
      if (!this.bin) this.error = "graft is not on your PATH: install it (see graft's README).";
      this.refresh(cx);
      cx.notify();
    });
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  // On the panel going away: a remove or clean still running is stopped.
  async close() {
    // Closed before `hc run` answered: onStart kills the terminal once its address arrives.
    this.closed = true;
    if (!this.job) return;
    await exec("hc", ["kill", this.job]).catch(() => {});
    await exec("hc", ["rm", this.job]).catch(() => {});
  }

  async graft(args, cwd) {
    const r = await exec(this.bin, args, { cwd });
    return parseResult(r.stdout, r.code);
  }

  // The main checkout: where actions run, so removing the focused worktree doesn't pull the floor away.
  main() {
    return this.list?.find((w) => w.main)?.path;
  }

  // A token per loop: refresh resets `watched` on a new location, and a loop still waiting on the
  // same folder must stop rather than run beside the new one.
  watch(common, cx) {
    if (!common || this.watched === common) return;
    const token = {};
    this.watched = common;
    this.watchToken = token;
    cx.spawn(async (cx) => {
      try {
        while (this.watchToken === token) {
          const changed = await watchFolder(common);
          if (this.watchToken === token && relevant(changed, common)) this.refresh(cx);
        }
      } catch {
        if (this.watchToken === token) this.watched = null;
      }
    });
  }

  refresh(cx) {
    if (this.loading || this.busy) return;
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context;
      this.list = null;
      this.prs = null;
      this.prAt = 0;
      this.confirm = null;
      this.note = null;
      this.watched = null;
      if (this.bin) this.error = null;
    }
    if (!this.bin || !cwd) return;
    if (on) {
      this.error = "graft runs on this machine only.";
      return;
    }
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const list = await this.graft(["list", "--json"], cwd);
        if (key() !== context) return;
        this.list = list;
        this.error = null;
        this.watch(commonDir(list), cx);
        if (Date.now() - this.prAt > PR_EVERY_MS) this.loadPrs(cwd, context, cx);
      } catch (e) {
        if (key() !== context) return;
        this.list = [];
        this.error = e.message;
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  // list --pr asks the forge once per worktree, so it runs at most once a minute, apart from list.
  // ponytail: a failure (no forge CLI, an unsupported host, exec's 30 s) just leaves PRs out.
  loadPrs(cwd, context, cx) {
    this.prAt = Date.now();
    cx.spawn(async (cx) => {
      const prs = await this.graft(["list", "--pr", "--json"], cwd).catch(() => null);
      if (!prs || key() !== context) return;
      this.prs = prs;
      cx.notify();
    });
  }

  open(row, cx) {
    if (this.busy || row.prunable) return;
    cx.spawn(async (cx) => {
      try {
        await this.graft(["open", row.path, "--json"], this.main());
      } catch (e) {
        this.note = { text: e.message, failed: true };
        cx.notify();
      }
    });
  }

  // Only with a resolved local main checkout: without one, graft would run in Herdr's own folder.
  askClean(cx) {
    const main = this.main();
    if (this.busy || !this.bin || !main) return;
    this.busy = "Looking for merged worktrees…";
    this.note = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await this.graft(cleanArgv(true), main);
        if (r.candidates.length) this.confirm = { kind: "clean", candidates: r.candidates };
        else this.note = { text: "Nothing to clean: no worktree is clean, merged and without an open space." };
      } catch (e) {
        this.note = { text: e.message, failed: true };
      }
      this.busy = null;
      cx.notify();
    });
  }

  // Runs the confirmed remove or clean in a hidden core terminal: teardown may take minutes.
  run(cx) {
    const c = this.confirm, main = this.main();
    this.confirm = null;
    if (!main) return cx.notify();
    const argv = c.kind === "remove" ? removeArgv(c.row.path) : cleanArgv(false, c.candidates.map((x) => x.path));
    this.busy = c.kind === "remove" ? `Removing ${c.row.branch ?? c.row.path}…` : `Removing ${c.candidates.length} merged worktrees…`;
    this.note = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const onStart = (address) => {
          this.job = address;
          if (this.closed) exec("hc", ["kill", address]).catch(() => {});
        };
        const { exit, text } = await runLong(hc, [this.bin, ...argv], { cwd: main, env: this.env, onStart });
        const done = outcome(exit, text, argv[0]);
        this.note = done.ok ? { text: summary(argv, done.result), failed: done.result.failed?.length > 0 } : { text: done.message, tail: done.tail, failed: true };
      } catch (e) {
        this.note = { text: e.message, failed: true };
      }
      this.busy = null;
      this.refresh(cx);
      cx.notify();
    });
  }

  renderConfirm(t) {
    const c = this.confirm;
    const what = c.kind === "remove"
      ? `Remove ${c.row.path}? Its teardown runs and its space closes; the branch is deleted only if merged.`
      : `Remove ${c.candidates.length} merged worktree${c.candidates.length === 1 ? "" : "s"} and their branches? ${c.candidates.map((x) => x.branch).join(", ")}`;
    const button = (id, label, primary, action) =>
      div().id(id).h(28).px(12).flex().items_center().rounded(8).cursor_pointer().text_size(12)
        .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
        .on_click((_e, cx) => { action(cx); cx.notify(); }).child(label);
    return v_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border)
      .child(div().text_size(12).child(what))
      .child(h_flex().gap(8).justify_end()
        .child(button("gp-cancel", "Cancel", false, () => (this.confirm = null)))
        .child(button("gp-yes", "Remove", true, (cx) => this.run(cx))));
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx);
    const t = theme();
    const rows = panelRows(this.list, this.prs);
    const linked = rows.filter((w) => !w.main).length;
    const stop = (_e, cx) => cx.stop_propagation();
    const row = (w) => {
      const tags = badges(w);
      return h_flex().id(`gp-${w.path}`).flex_none().h(44).px(8).gap(8).items_center().rounded(7)
        .when(!w.prunable, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => this.open(w, cx))
        .child(div().flex_none().size(7).rounded(4).bg(w.space ? t.done : t.border))
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().text_color(t.foreground).child(w.branch ?? "(detached)"))
          .child(div().truncate().text_size(11).text_color(t.dim).child(tags.length ? tags.join(" · ") : w.path.split("/").pop())))
        .when(!w.main, (el) => el.child(div().id(`gp-rm-${w.path}`).flex_none().px(6).py(2).rounded(5).text_size(11).text_color(t.dim)
          .hover((s) => s.bg(t.raised).text_color(t.foreground))
          .on_mouse_down("left", stop)
          .on_click((_e, cx) => { cx.stop_propagation(); if (!this.busy) this.confirm = { kind: "remove", row: w }; cx.notify(); })
          .child("Remove")));
    };
    const empty = this.error || (this.list === null ? "Loading worktrees…" : "No worktrees");
    return v_flex().id("graft-panel").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Worktrees"))
        .when(this.list !== null, (el) => el.child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${linked}`)))
        .child(div().flex_1())
        .child(div().id("gp-clean").px(8).py(3).rounded(6).text_size(12).text_color(this.busy || !this.main() ? t.dim : t.muted)
          .when(!this.busy && Boolean(this.main()), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)))
          .on_click((_e, cx) => this.askClean(cx)).child("Clean merged")))
      .child(div().relative().flex_1().min_h(0)
        .child(v_flex().id("gp-list").size_full().overflow_y_scroll().p(6)
          .children(rows.map(row))
          .when(rows.length === 0 || Boolean(this.error), (el) => el.child(div().p(8).text_color(this.error ? t.blocked : t.dim).child(empty))))
        .child(Scrollbar.vertical("gp-list").absolute().inset_0()))
      .when(Boolean(this.busy), (el) => el.child(div().flex_none().px(14).py(8).border_t(1).border_color(t.border).text_size(12).text_color(t.working).child(this.busy)))
      .when(Boolean(this.note), (el) => el.child(v_flex().flex_none().px(14).py(8).gap(6).border_t(1).border_color(t.border).text_size(12)
        .child(div().text_color(this.note.failed ? t.blocked : t.muted).child(this.note.text))
        .when(Boolean(this.note.tail), (el) => el.child(div().p(8).rounded(6).bg(t.raised).text_size(11).text_color(t.muted).child(this.note.tail)))))
      .when(Boolean(this.confirm), (el) => el.child(this.renderConfirm(t)));
  }
}
