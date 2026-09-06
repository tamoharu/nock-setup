import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Codex } from "./codex.mjs";
import { Tmux, hasCodexProcess } from "./tmux.mjs";
import { check, requestID, textInput, now } from "./config.mjs";

// Status comes exclusively from the 0.153.4 ThreadStatus/TurnStatus schema.
export function threadState(thread, previous = "idle") {
  const status = thread.status;
  if (status?.type === "active") return status.activeFlags?.length ? "waiting" : "running";
  if (status?.type === "systemError") return "failed";
  const turn = thread.turns?.at(-1);
  if (turn?.status === "failed") return "failed";
  if (turn?.status === "interrupted") return "stopped";
  if (turn?.status === "completed") return "completed";
  if (status?.type === "idle") return ["completed", "failed", "stopped"].includes(previous) ? previous : "idle";
  return "unknown";
}
export class Workspace {
  constructor(store, config, tmux = new Tmux(config.tmux)) {
    this.store = store; this.config = config; this.tmux = tmux;
    this.socket = join(config.dataDir, "codex.sock");
    this.controlName = "nock-control-" + createHash("sha256").update(this.socket).digest("hex").slice(0, 10);
    this.snapshot = { spaces: [], agents: [], syncedAt: null, error: null };
    this.store.db.exec("CREATE TABLE IF NOT EXISTS terminal_tabs(id TEXT PRIMARY KEY,data TEXT NOT NULL)");
  }
  records() { return this.store.db.prepare("SELECT data FROM terminal_tabs").all().map((r) => JSON.parse(r.data)); }
  save(t) {
    this.store.db.prepare("INSERT INTO terminal_tabs VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data")
      .run(t.id, JSON.stringify(t));
  }
  async shared(create = false) {
    if (this.client?.alive) return this.client;
    if (this.connecting) return this.connecting;
    if (!existsSync(this.socket) && !create) return null;
    this.connecting = (async () => {
      check(Buffer.byteLength(this.socket) < 100, "socket_path", "Nockデータディレクトリのパスを短くしてください。");
      if (!existsSync(this.socket)) {
        await this.tmux.create({ name: this.controlName, directory: this.config.projects[0].path,
          command: [this.config.codexBin, "app-server", "--listen", `unix://${this.socket}`] });
        for (let n = 0; n < 80 && !existsSync(this.socket); n++) await new Promise((r) => setTimeout(r, 100));
      }
      check(existsSync(this.socket) && statSync(this.socket).isSocket() && statSync(this.socket).uid === process.getuid(),
        "socket_missing", "共有Codexのソケットを確認できません。", 503);
      const c = new Codex(this.config.codexBin, this.config.projects[0].path, { socket: this.socket });
      c.on("message", (m) => { if (!this.closed) this.onMessage(m); });
      await c.start();
      if (this.closed) { c.stop(); return null; }
      this.client = c;
      // Only reconnect threads explicitly created by Nock, never arbitrary CLI history.
      // No turn/start here, and no sandbox/approval/model overrides on resume.
      for (const t of this.records().filter((t) => t.threadId && !t.archived)) {
        try { await c.call("thread/resume", { threadId: t.threadId }, 8000); } catch { /* Visible as unknown in snapshot. */ }
      }
      return c;
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }
  onMessage(m) {
    const id = m.params?.threadId ?? m.params?.thread?.id;
    const t = this.records().find((t) => t.threadId === id);
    if (!t) return;
    const p = m.params;
    // A TUI connected to this same server owns its approvals. This observer never
    // approves, rejects, or fabricates answers to a server-initiated request.
    if (m.method === "turn/started") {
      this.save({ ...t, state: "running", turnId: p.turn.id, updatedAt: now() });
    } else if (m.method === "turn/completed") {
      const state = { completed: "completed", failed: "failed", interrupted: "stopped" }[p.turn.status] ?? "unknown";
      this.transition(t, state, `turn:${p.turn.id}:${state}`);
    } else if (m.method === "thread/status/changed") {
      const state = threadState({ status: p.status }, t.state);
      if (state === "waiting" && t.state !== "waiting")
        this.transition(t, state, `wait:${t.turnId ?? "none"}:${t.waitCounter ?? 0}`);
      else if (state !== t.state) this.save({ ...t, state, updatedAt: now(),
        waitCounter: (t.waitCounter ?? 0) + (t.state === "waiting" ? 1 : 0) });
    }
  }
  transition(t, state, identity) {
    this.store.transaction(() => {
      this.save({ ...t, state, updatedAt: now() });
      const event = this.store.event(t.id, "terminal/state", { state }, `terminal:${t.threadId}:${identity}`);
      if (event && ["completed", "waiting", "failed"].includes(state))
        this.store.enqueue(event, t, state, t.spaceName);
    });
  }
  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.refreshNow().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  async refreshNow() {
    try {
      const [all, processes] = await Promise.all([this.tmux.panes(), this.tmux.processes()]);
      if (this.closed) return this.snapshot;
      const panes = all.filter((p) => !p.sessionName.startsWith("nock-control-"));
      let c;
      try { c = await this.shared(); } catch { /* Existing ordinary shells still work. */ }
      const records = this.records();
      if (c) {
        for (const t of records.filter((t) => t.threadId && !t.archived)) {
          try {
            const { thread } = await c.call("thread/read", { threadId: t.threadId, includeTurns: true }, 8000);
            if (this.closed) return this.snapshot;
            const state = threadState(thread, t.state), lastTurn = thread.turns?.at(-1);
            const latest = [...(lastTurn?.items ?? [])].reverse().find((i) => i.type === "agentMessage")?.text;
            // Polling repairs missed structured events after an observer restart.
            if (lastTurn && ["completed", "failed", "stopped"].includes(state))
              this.transition(this.records().find((r) => r.id === t.id), state, `turn:${lastTurn.id}:${state}`);
            const current = this.records().find((r) => r.id === t.id);
            this.save({ ...current, state, latest: latest?.slice(0, 220) ?? current.latest,
              observedAt: now(), turnId: lastTurn?.id ?? current.turnId });
          } catch { if (!this.closed) this.save({ ...this.records().find((r) => r.id === t.id), observedAt: null }); }
        }
      }
      if (this.closed) return this.snapshot;
      const current = this.records(), spaces = new Map(), agents = [];
      for (const p of panes) {
        const owned = current.find((r) => r.epoch === p.epoch && r.paneId === p.paneId && r.panePid === p.panePid);
        const codex = !p.dead && hasCodexProcess(p, processes);
        const tab = { ...p, id: owned?.id ?? `${p.epoch}:${p.paneId}`, name: owned?.name ?? p.windowName,
          kind: owned?.threadId ? "codex" : codex ? "externalCodex" : "shell",
          state: p.dead ? "stopped" : owned?.threadId ? (c && owned.observedAt ? owned.state : "unknown") : codex ? "untracked" : "shell",
          threadId: owned?.threadId ?? null, latest: owned?.latest ?? "", updatedAt: owned?.updatedAt ?? now(),
          archived: owned?.archived ?? false };
        const spaceId = `${p.epoch}:${p.sessionId}`;
        const space = spaces.get(spaceId) ?? { id: spaceId, sessionId: p.sessionId, epoch: p.epoch,
          name: p.sessionName, directory: p.directory, tabs: [] };
        space.tabs.push(tab); spaces.set(spaceId, space);
        if (tab.kind !== "shell") agents.push({ ...tab, spaceId, spaceName: space.name });
      }
      // Keep finished/closed managed Codex entries visible; never call them "running" without a fresh observation.
      for (const t of current.filter((t) => t.threadId && !agents.some((a) => a.id === t.id)))
        agents.push({ ...t, kind: "codex", state: c && t.observedAt ? t.state : "unknown", dead: true, spaceId: `${t.epoch}:${t.sessionId}` });
      this.snapshot = { spaces: [...spaces.values()], agents, syncedAt: now(), error: null };
    } catch (e) {
      this.snapshot = { ...this.snapshot, error: e.message };
    }
    return this.snapshot;
  }
  start() {
    this.refresh();
    this.timer = setInterval(() => { if (!this.closed) this.refresh(); }, 2500);
    this.timer.unref();
  }
  close() { this.closed = true; clearInterval(this.timer); this.client?.stop(); }
  async create(body) {
    requestID(body.requestId); textInput(body.name, 80);
    check(!/[\x00-\x1f\x7f.:]/.test(body.name), "name", "名前には制御文字や . : を使えません。");
    check(["shell", "codex"].includes(body.kind), "kind", "タブの種類を選んでください。");
    if (!this.store.claim(body.requestId, body.requestId, "terminal", body)) return this.store.request(body.requestId);
    try {
      let space;
      if (body.spaceId) {
        await this.refresh();
        space = this.snapshot.spaces.find((s) => s.id === body.spaceId);
        check(space, "space_stale", "Spaceが見つかりません。再同期してください。", 409);
      }
      const project = this.config.projects.find((p) => p.id === body.projectId);
      const directory = space?.directory ?? project?.path;
      check(directory, "project", "新しいSpaceの作業場所を選んでください。");
      let threadId = null, command;
      if (body.kind === "codex") {
        const c = await this.shared(true);
        const { thread } = await c.call("thread/start", { cwd: directory,
          approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "workspace-write" });
        threadId = thread.id;
        command = [this.config.codexBin, "resume", "--remote", `unix://${this.socket}`, threadId];
      }
      const paneId = await this.tmux.create({ space: space?.sessionId, name: body.name, directory, command });
      const pane = (await this.tmux.panes()).find((p) => p.paneId === paneId);
      check(pane, "terminal_unknown", "端末の作成結果を確認できません。自動再実行しません。", 503);
      const tab = { ...pane, id: body.requestId, name: body.name, threadId,
        spaceName: pane.sessionName, state: "idle", latest: "", archived: false, updatedAt: now() };
      this.save(tab);
      const receipt = this.store.finishRequest(body.requestId, "accepted", { tabId: tab.id });
      await this.refresh();
      return receipt;
    } catch (e) {
      return this.store.finishRequest(body.requestId, e.status === 400 || e.status === 409 ? "rejected" : "unknown",
        { message: e.message });
    }
  }
  async register(body) {
    requestID(body.requestId);
    if (!this.store.claim(body.requestId, body.requestId, "terminalRegister", body)) return this.store.request(body.requestId);
    try {
      const p = await this.tmux.verified(body);
      check(!hasCodexProcess(p, await this.tmux.processes()), "codex_exists", "この端末には既にCodexがいます。", 409);
      const c = await this.shared(true);
      const { thread } = await c.call("thread/start", { cwd: p.directory, approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "workspace-write" });
      const t = { ...p, id: body.requestId, name: p.windowName, threadId: thread.id, spaceName: p.sessionName,
        state: "idle", latest: "", archived: false, updatedAt: now() };
      this.save(t);
      return this.store.finishRequest(body.requestId, "accepted", { tabId: t.id, threadId: t.threadId, socket: this.socket });
    } catch (e) { return this.store.finishRequest(body.requestId, "unknown", { message: e.message }); }
  }
  archive(id, archived) {
    check(typeof archived === "boolean", "archive", "表示の指定が不正です。");
    const t = this.records().find((r) => r.id === id);
    check(t, "terminal_missing", "管理対象タブではありません。", 404);
    this.save({ ...t, archived });
    return { archived }; // Never kills a pane or a Codex process.
  }
}
