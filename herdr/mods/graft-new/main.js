// New worktree, through graft: pick a source, an item, a base, then create it in a new space.
// Lists come from `graft search … --json` and `graft list --json`; create runs
// `graft create … --open herdr --json` in a hidden core terminal and closes on success.
// The "Remove worktree" source lists the repository's worktrees instead and runs `graft remove`
// on the picked one, from the main checkout, then says what happened to its branch.
// ↑/↓ choose, Enter picks, Esc goes back a level (closes on the first).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar } from "gpui-base";
import { exec, hc, focused, spaces, home, props, closeOverlay, theme } from "herdr";
import { baseRows, createArgv, itemRows, outcome, parseResult, removeArgv, removeSummary, runLong, sourceRows } from "./lib.js";

const PLACEHOLDER = {
  source: "Where does the worktree come from?",
  new: "Branch name or title…",
  branch: "Search branches…",
  pr: "Search pull requests…",
  linear: "Search Linear issues (empty: yours)…",
  jira: "Search Jira issues (empty: yours)…",
  remove: "Filter worktrees…",
  base: "Base: filter branches and worktrees…",
  confirm: "",
  run: "",
};

// The folder graft runs in: the focused terminal's, else the shown space's.
function where() {
  return focused()?.cwd || spaces().find((s) => s.active)?.folder || home();
}

export default class GraftNew extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.makeInput("source");
    cx.timer.after(600, () => this.focusInput());
    this.cwd = where();
    this.level = "source"; // source | item | base | confirm | run
    this.source = null;
    this.item = null;
    this.base = null;
    this.hits = null; // the level's search result; null while loading
    this.worktrees = null;
    this.error = null;
    this.at = 0;
    this.gen = 0; // drops answers to searches the typing has moved past
    this.job = null; // the hidden terminal running create
    this.failed = null;
    this.done = null; // a finished remove's summary
    this.main = null; // the main checkout, where remove runs
    // exec sees the person's real PATH; the core terminal create runs in may not, so it gets this one.
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", 'printf "%s\\n" "$PATH"; command -v graft'], { cwd: this.cwd }).catch(() => null);
      const [path, bin] = (r?.stdout ?? "").trim().split("\n");
      this.bin = bin || null;
      this.env = [`PATH=${path ?? ""}`, "GIT_TERMINAL_PROMPT=0"];
      if (!this.bin) this.error = "graft is not on your PATH: install it (see graft's README), then reopen this picker.";
      // A remote machine's folder means nothing to the local graft, as in the panel.
      if (spaces().find((s) => s.active)?.machine) {
        this.bin = null;
        this.error = "graft runs on this machine only.";
      }
      cx.notify();
    });
  }

  // On the overlay going away: a create still running is stopped.
  async close() {
    // Closed before `hc run` answered: onStart kills the terminal once its address arrives.
    this.closed = true;
    if (!this.job) return;
    // ponytail: a remove is left to finish, since stopping it mid-teardown leaves a half-removed worktree;
    // its finished terminal then stays in `hc ls --all`.
    if (this.removing()) return;
    await exec("hc", ["kill", this.job]).catch(() => {});
    // ponytail: may fail while it's still ending; a finished terminal then stays in `hc ls --all`.
    await exec("hc", ["rm", this.job]).catch(() => {});
  }

  // A fresh input per level, for its placeholder (only init and event handlers may make one).
  makeInput(level) {
    this.input = InputState.new({ placeholder: PLACEHOLDER[level] });
    this.input.on("change", (_e, cx) => this.changed(cx));
    this.input.on("submit", (_e, cx) => this.pick(this.rows()[this.at], cx));
    this.input.focus();
  }

  focusInput() {
    if (this.level !== "confirm" && this.level !== "run") this.input.focus();
  }

  dismiss() {
    closeOverlay(props().overlay);
  }

  removing() {
    return this.source?.id === "remove";
  }

  // Whether the item level's rows come from graft: a search, or the worktree list for remove.
  listed() {
    return this.level === "item" && Boolean(this.source.search || this.removing());
  }

  async graft(args) {
    const r = await exec(this.bin, args, { cwd: this.cwd });
    return parseResult(r.stdout, r.code);
  }

  rows() {
    const q = this.input.value();
    if (this.level === "source") return sourceRows(q);
    if (this.level === "item") return itemRows(this.source, this.hits, q);
    if (this.level === "base") return this.hits ? baseRows(this.worktrees, this.hits, q) : [];
    if (this.level === "confirm" && this.removing()) return [{ key: "remove", label: "Remove", detail: `graft ${removeArgv(this.item).join(" ")}`, badge: this.item.badge, args: [] }];
    if (this.level === "confirm") return [{ key: "create", label: "Create", detail: `graft ${createArgv(this.item, this.base).join(" ")}`, badge: "", args: [] }];
    return [];
  }

  enter(level, cx) {
    this.level = level;
    this.at = 0;
    if (this.bin) this.error = null;
    this.hits = null;
    if (level === "confirm") this.handle.focus(); // no input: Enter and Esc come to key()
    else {
      this.makeInput(level === "item" ? this.source.id : level);
      cx.timer.after(50, () => this.focusInput()); // again once its Input has rendered
    }
    this.load(cx);
    cx.notify();
  }

  back(cx) {
    if (this.level === "run" && !this.failed) return this.dismiss(); // close() stops the create
    const to = { item: "source", base: "item", confirm: this.source?.base ? "base" : "item", run: "confirm" }[this.level];
    if (!to) return this.dismiss();
    this.failed = null;
    this.enter(to, cx);
  }

  changed(cx) {
    this.at = 0;
    const searching = (this.level === "item" && this.source.search) || this.level === "base";
    if (searching) {
      // The old query's hits must not be picked by an Enter before the new answer arrives.
      this.hits = null;
      // Wait for a pause in typing: prs, Linear and Jira go over the network.
      const g = ++this.gen;
      cx.timer.after(250, (cx) => g === this.gen && this.load(cx));
    }
    cx.notify();
  }

  load(cx) {
    if (!this.bin || !(this.listed() || this.level === "base")) return;
    const g = ++this.gen;
    const q = this.input.value().trim();
    const kind = this.level === "base" ? "branches" : this.source.search;
    cx.spawn(async (cx) => {
      try {
        if (this.removing()) {
          // Listed once; typing filters these rows (search is null, so changed() doesn't reload).
          const list = await this.graft(["list", "--json"]);
          if (g !== this.gen) return;
          this.main = list.find((w) => w.main)?.path ?? null;
          this.hits = list;
          this.error = null;
          return cx.notify();
        }
        if (this.level === "base" && !this.worktrees) this.worktrees = await this.graft(["list", "--json"]);
        const hits = await this.graft(["search", kind, ...(q ? [q] : []), "--json"]);
        if (g !== this.gen) return;
        this.hits = hits;
        this.error = null;
      } catch (e) {
        if (g !== this.gen) return;
        this.hits = [];
        this.error = e.message;
      }
      cx.notify();
    });
  }

  pick(row, cx) {
    if (!row || !this.bin) return;
    if (this.level === "source") {
      this.source = row.source;
      this.enter("item", cx);
    } else if (this.level === "item") {
      this.item = row;
      this.base = null;
      this.enter(this.source.base ? "base" : "confirm", cx);
    } else if (this.level === "base") {
      this.base = row;
      this.enter("confirm", cx);
    } else if (this.level === "confirm") this.go(cx);
  }

  go(cx) {
    if (this.removing()) this.remove(cx);
    else this.create(cx);
  }

  // Runs in the main checkout, so removing the worktree graft was opened from doesn't pull the floor away.
  remove(cx) {
    if (!this.main) {
      this.failed = { message: "graft list showed no main checkout to run remove from.", tail: "" };
      this.level = "run";
      return cx.notify();
    }
    this.level = "run";
    this.failed = null;
    this.done = null;
    this.handle.focus();
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const { exit, text } = await runLong(hc, [this.bin, ...removeArgv(this.item)], {
          cwd: this.main,
          env: this.env,
          onStart: (address) => (this.job = address),
        });
        const done = outcome(exit, text, "remove");
        if (done.ok) this.done = removeSummary(done.result);
        else this.failed = done;
      } catch (e) {
        this.failed = { message: e.message, tail: "" };
      }
      cx.notify();
    });
  }

  create(cx) {
    this.level = "run";
    this.failed = null;
    this.handle.focus();
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const { exit, text } = await runLong(hc, [this.bin, ...createArgv(this.item, this.base)], {
          cwd: this.cwd,
          env: this.env,
          onStart: (address) => {
            this.job = address;
            if (this.closed) exec("hc", ["kill", address]).catch(() => {});
          },
        });
        const done = outcome(exit, text);
        if (done.ok) return this.dismiss(); // graft opened the new space itself
        this.failed = done;
      } catch (e) {
        this.failed = { message: e.message, tail: "" };
      }
      cx.notify();
    });
  }

  key(e, cx) {
    const n = this.rows().length;
    // A running remove can't be cancelled: Esc waits for it (see close()).
    if (e.key === "escape" && this.level === "run" && this.removing() && !this.done && !this.failed) return cx.stop_propagation();
    if (e.key === "escape") this.back(cx);
    else if (e.key === "enter" && this.level === "run" && this.done) this.dismiss();
    else if (e.key === "enter" && this.level === "confirm") this.go(cx);
    else if ((e.key === "down" || e.key === "up") && n) this.at = (this.at + (e.key === "down" ? 1 : n - 1)) % n;
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  renderRun(t) {
    const f = this.failed, rm = this.removing();
    const status = f ? (rm ? "Remove failed" : "Create failed") : this.done ?? (rm ? "Removing the worktree (teardown, then its space)…" : "Creating the worktree and its space…");
    const argv = rm ? removeArgv(this.item) : createArgv(this.item, this.base);
    return v_flex()
      .gap(8)
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .when(!f && !this.done, (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(14).text_color(t.working).spin(900)))
          .child(div().text_color(f ? t.blocked : t.foreground).child(status)),
      )
      .child(div().truncate().text_size(11.5).text_color(t.dim).child(`graft ${argv.join(" ")}`))
      .when(Boolean(f), (el) =>
        el
          .child(div().text_color(t.blocked).child(f.message))
          .when(Boolean(f.tail), (el) => el.child(div().p(8).rounded(6).bg(t.background).text_size(11.5).text_color(t.muted).child(f.tail))),
      );
  }

  render() {
    const t = theme();
    const rows = this.rows();
    this.at = Math.min(this.at, Math.max(0, rows.length - 1));
    const crumbs = [!this.removing() && this.source?.label, this.level !== "item" && this.item?.label, this.base?.label].filter(Boolean).join(" › ");
    const loading = (this.listed() || this.level === "base") && this.hits === null;
    const row = (r, i) => {
      const on = i === this.at;
      return v_flex()
        .id(`gn-${i}`)
        .flex_none()
        .h(44)
        .px(10)
        .justify_center()
        .rounded(7)
        .cursor_pointer()
        .when(on, (el) => el.bg(t.selected))
        .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => this.pick(r, cx))
        .child(
          h_flex()
            .gap(8)
            .items_center()
            .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(r.label))
            .when(Boolean(r.badge), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(r.badge))),
        )
        .child(div().truncate().text_size(11.5).text_color(t.dim).child(r.detail));
    };
    const empty = loading
      ? "…"
      : this.level === "item" && this.source.id === "new"
        ? "Type a branch name or a title."
        : this.level === "item" && this.removing() && !this.input.value().trim()
          ? "No worktrees besides the main checkout."
          : "Nothing matches.";
    return v_flex()
      .id("graft-new")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full()
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .child(
        h_flex()
          .gap(8)
          .child(div().flex_none().font_semibold().text_color(t.foreground).child(this.removing() ? "Remove worktree" : "New worktree"))
          .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(crumbs)),
      )
      .when(this.level === "run", (el) => el.child(this.renderRun(t)))
      .when(this.level !== "run", (el) =>
        el
          .when(this.level !== "confirm", (el) =>
            el.child(Input.new(this.input).h(32).px(10).items_center().rounded(6).border(1).border_color(t.accent).bg(t.background).text_color(t.foreground)),
          )
          .when(Boolean(this.error), (el) => el.child(div().text_color(t.blocked).child(this.error)))
          .child(
            // A popup is as tall as its content, so the list needs a height of its own (as Herdr's picker):
            // up to 8 rows, one for the empty or loading line.
            div()
              .relative()
              .h(Math.min(8, Math.max(1, rows.length)) * 44)
              .child(
                v_flex()
                  .id("gn-list")
                  .size_full()
                  .overflow_y_scroll()
                  .children(rows.map(row))
                  .when(rows.length === 0 && !this.error, (el) => el.child(div().p(10).text_color(t.dim).child(empty))),
              )
              .child(Scrollbar.vertical("gn-list").absolute().inset_0()),
          ),
      )
      .when(this.level === "run", (el) => el.child(div().flex_1()))
      .child(
        h_flex()
          .justify_end()
          .text_size(11)
          .text_color(t.dim)
          .child(
            this.level === "run"
              ? this.failed ? "esc back" : this.done ? "↵ close" : this.removing() ? "removing…" : "esc cancels"
              : `↑↓ choose · ↵ ${this.level === "confirm" ? (this.removing() ? "remove" : "create") : "pick"} · esc ${this.level === "source" ? "close" : "back"}`,
          ),
      );
  }
}
