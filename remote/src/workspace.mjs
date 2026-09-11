import { existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { SharedChat } from "./shared-chat.mjs";
import { PathTabs, directoryPath } from "./path-tabs.mjs";
import { CodeBrowser } from "./code-browser.mjs";
import { Attachments } from "./attachments.mjs";
import { threadPermissionOverrides } from "./agent-settings.mjs";
import { Codex } from "./codex.mjs";
import { Tmux, hasCodexProcess, codexProcessAncestors, isControlSession } from "./tmux.mjs";
import { check, requestID, textInput, now, migrationCwd } from "./config.mjs";
import { runTiming } from "./run-timing.mjs";
import { EMPTY_THREAD_NAME, ThreadTitles } from "./thread-titles.mjs";
import { WorkspacePresentation } from "./workspace-presentation.mjs";
import { TabLifecycle } from "./tab-lifecycle.mjs";

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
// Use the last actual user item, including a steer within the same turn. A
// thread preview or the latest assistant answer is not the user's last query.
export function lastUserQuery(thread) {
  for (const turn of [...(thread.turns ?? [])].reverse()) {
    const item = [...(turn.items ?? [])].reverse().find((i) => i.type === "userMessage");
    if (item) return (item.text ?? (item.content ?? []).filter((i) => i.type === "text").map((i) => i.text).join("\n"))
      .trim().slice(0, 1000) || "添付のみのメッセージ";
  }
  return "";
}
export function conversationSummary(thread, previous = {}) {
  const turn = thread.turns?.at(-1);
  const latest = [...(turn?.items ?? [])].reverse().find((i) => i.type === "agentMessage")?.text;
  return { state: threadState(thread, previous.state), latest: latest?.slice(0, 220) ?? previous.latest ?? "",
    lastUserQuery: lastUserQuery(thread), runTiming: runTiming(turn, previous.runTiming),
    turnId: turn?.id ?? previous.turnId ?? null, observedAt: now() };
}
export class Workspace {
  constructor(store, config, tmux = new Tmux(config.tmux)) {
    this.store = store; this.chat = new SharedChat(this); this.config = config; this.tmux = tmux;
    this.paths = new PathTabs(this);
    this.titles = new ThreadTitles(this);
    this.code = new CodeBrowser(this);
    this.attachments = new Attachments(store, join(config.dataDir, "attachments"));
    this.socket = join(config.dataDir, "codex.sock");
    this.controlName = "hati-control-" + createHash("sha256").update(this.socket).digest("hex").slice(0, 10);
    this.snapshot = { spaces: [], agents: [], syncedAt: null, error: null };
    this.store.db.exec("CREATE TABLE IF NOT EXISTS terminal_tabs(id TEXT PRIMARY KEY,data TEXT NOT NULL)");
    this.store.db.exec("CREATE TABLE IF NOT EXISTS workspace_spaces(id TEXT PRIMARY KEY,data TEXT NOT NULL)");
    this.presentation = new WorkspacePresentation(this);
    this.lifecycle = new TabLifecycle(this);
    this.observations = new Map();
    this.dirtyThreads = new Set();
    this.store.db.exec("CREATE INDEX IF NOT EXISTS terminal_thread ON terminal_tabs(json_extract(data,'$.threadId'))");
  }
  records() { return this.store.db.prepare("SELECT data FROM terminal_tabs").all().map((r) => JSON.parse(r.data)); }
  record(id) {
    const row = this.store.db.prepare("SELECT data FROM terminal_tabs WHERE id=?").get(id);
    return row && JSON.parse(row.data);
  }
  recordForThread(threadId) {
    if (!threadId) return null;
    const row = this.store.db.prepare("SELECT data FROM terminal_tabs WHERE json_extract(data,'$.threadId')=? ORDER BY json_extract(data,'$.closedAt') IS NOT NULL LIMIT 1").get(threadId);
    return row && JSON.parse(row.data);
  }
  save(t) {
    this.store.db.prepare("INSERT INTO terminal_tabs VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data")
      .run(t.id, JSON.stringify(t));
  }
  async shared(create = false) {
    if (this.client?.alive) return this.client;
    if (this.connecting) return this.connecting;
    if (!existsSync(this.socket) && !create) return null;
    this.connecting = (async () => {
      check(Buffer.byteLength(this.socket) < 100, "socket_path", "hatiデータディレクトリのパスを短くしてください。");
      if (!existsSync(this.socket)) {
        await this.tmux.create({ name: this.controlName, directory: this.config.projects[0].path,
          command: [this.config.codexBin, "app-server", "--listen", `unix://${this.socket}`] });
        for (let n = 0; n < 80 && !existsSync(this.socket); n++) await new Promise((r) => setTimeout(r, 100));
      }
      check(existsSync(this.socket) && statSync(this.socket).isSocket() && statSync(this.socket).uid === process.getuid(),
        "socket_missing", "共有Codexのソケットを確認できません。", 503);
      const c = new Codex(this.config.codexBin, this.config.projects[0].path, { socket: this.socket });
      c.on("message", (m) => { if (!this.closed) { this.chat.onMessage(m, c); this.onMessage(m); } });
      c.on("closed", () => {
        for (const [id, a] of this.chat.approvals) if (a.client === c) this.chat.approvals.delete(id);
      });
      await c.start();
      if (this.closed) { c.stop(); return null; }
      this.client = c;
      this.observations.clear();
      // Only reconnect threads explicitly created by hati, never arbitrary CLI history.
      // No turn/start here, and no sandbox/approval/model overrides on resume.
      for (const t of this.records().filter((t) => t.threadId && !t.archived && !t.closedAt)) {
        try { await c.call("thread/resume", { threadId: t.threadId, ...migrationCwd(this.config, t.directory) }, 8000); } catch { /* Visible as unknown in snapshot. */ }
      }
      return c;
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }
  onMessage(m) {
    if (!["turn/started", "turn/completed", "thread/status/changed", "item/started", "item/completed"].includes(m.method)) return;
    if (m.method.startsWith("item/") && m.params?.item?.type !== "userMessage") return;
    const id = m.params?.threadId ?? m.params?.thread?.id;
    const t = this.recordForThread(id);
    if (!t || t.closedAt) return;
    this.dirtyThreads.add(id);
    const p = m.params;
    // A TUI connected to this same server owns its approvals. This observer never
    // approves, rejects, or fabricates answers to a server-initiated request.
    if (m.method === "turn/started") {
      this.save({ ...t, state: "running", turnId: p.turn.id,
        runTiming: runTiming(p.turn, t.runTiming, { startedAt: now() }), updatedAt: now() });
    } else if (["item/started", "item/completed"].includes(m.method) && p.item?.type === "userMessage") {
      this.save({ ...t, lastUserQuery: lastUserQuery({ turns: [{ items: [p.item] }] }), updatedAt: now() });
    } else if (m.method === "turn/completed") {
      if (t.turnId && t.turnId !== p.turn.id) return;
      const state = { completed: "completed", failed: "failed", interrupted: "stopped" }[p.turn.status] ?? "unknown";
      this.transition({ ...t, runTiming: runTiming(p.turn, t.runTiming, { completedAt: now() }) }, state, `turn:${p.turn.id}:${state}`);
    } else if (m.method === "thread/status/changed") {
      const state = threadState({ status: p.status }, t.state);
      if (state === "waiting" && t.state !== "waiting") {
        this.transition(t, state, `wait:${t.turnId ?? "none"}:${t.waitCounter ?? 0}`);
        this.save({ ...this.records().find((r) => r.id === t.id), waitingSource: "status" });
      }
      else if (state !== t.state) this.save({ ...t, state, updatedAt: now(),
        waitCounter: (t.waitCounter ?? 0) + (t.state === "waiting" ? 1 : 0) });
    }
  }
  transition(t, state, identity) {
    this.store.transaction(() => {
      this.save({ ...t, state, updatedAt: t.state === state ? t.updatedAt : now() });
      const event = this.store.event(t.id, "terminal/state", { state }, `terminal:${t.threadId}:${identity}`);
      if (event && ["completed", "waiting", "failed"].includes(state))
        this.store.enqueue(event, t, state, basename(t.directory ?? "") || t.spaceName || "作業");
    });
  }
  async refresh({ force = true } = {}) {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.refreshNow(force).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  async refreshNow(force) {
    try {
      let c;
      try { c = await this.shared(); } catch { /* Existing ordinary shells still work. */ }
      this.observerAvailable = !!c;
      const records = this.records();
      if (c) {
        for (const t of records.filter((t) => t.threadId && !t.archived && !t.closedAt && !t.closeRequestId)) {
          const previous = this.observations.get(t.threadId);
          const dirty = this.dirtyThreads.delete(t.threadId);
          const interval = ["running", "waiting", "unknown"].includes(t.state) ? 10000 : 60000;
          if (!force && previous && !dirty && now() - previous.checkedAt < interval) continue;
          try {
            if (!force && previous && !dirty && t.observedAt && !previous.retryHistory) {
              const metadata = await this.chat.readStatus(c, t.threadId);
              if (metadata.updatedAt === previous.updatedAt && threadState(metadata, t.state) === t.state) {
                this.observations.set(t.threadId, { ...previous, checkedAt: now() });
                continue;
              }
            }
            const thread = await this.chat.readThread(c, t.threadId);
            if (this.closed) return this.snapshot;
            this.observations.set(t.threadId, { checkedAt: now(), updatedAt: thread.updatedAt });
            // Updates desktop as well as mobile thread titles, including missed events
            // after a daemon restart. A naming failure must not hide run status.
            try { await this.titles.update(c, thread); }
            catch { this.observations.get(t.threadId).retryHistory = true; }
            if (this.closed) return this.snapshot;
            const live = this.record(t.id);
            if (live?.threadId !== t.threadId || live.closedAt || live.closeRequestId) continue;
            const state = threadState(thread, t.state), lastTurn = thread.turns?.at(-1);
            if (live.turnId !== t.turnId && lastTurn?.id !== live.turnId) continue;
            // Polling repairs missed structured events after an observer restart.
            if (lastTurn && ["completed", "failed", "stopped"].includes(state))
              this.transition(this.record(t.id), state, `turn:${lastTurn.id}:${state}`);
            const before = this.record(t.id);
            if (state === "waiting" && before.state !== "waiting") {
              this.transition(before, state, `wait:${lastTurn?.id ?? before.turnId ?? "none"}:${before.waitCounter ?? 0}`);
              this.save({ ...this.record(t.id), waitingSource: "status" });
            }
            const current = this.record(t.id);
            this.save({ ...current, ...conversationSummary(thread, current),
              updatedAt: Math.max(current.updatedAt ?? 0, (thread.updatedAt ?? 0) * 1000,
                (lastTurn?.startedAt ?? 0) * 1000, (lastTurn?.completedAt ?? 0) * 1000),
              waitCounter: (current.waitCounter ?? 0) + (current.state === "waiting" && state !== "waiting" ? 1 : 0) });
            this.store.progress.reconcile(this.record(t.id), lastTurn);
          } catch {
            this.observations.set(t.threadId, { ...previous, checkedAt: now() });
            const current = this.record(t.id);
            if (!this.closed && current?.threadId === t.threadId && !current.closedAt && !current.closeRequestId) this.save({ ...current, observedAt: null });
          }
        }
      }
    } catch (e) {
      this.snapshot = { ...this.snapshot, error: e.message };
    }
    return this.refreshLayout();
  }
  // Tab operations and HTTP reads only need tmux and local metadata. Full
  // conversation reads run in the background poll and must not delay them.
  async refreshLayout() {
    // Queue a fresh read after any in-flight enumeration: a mutation must never
    // reuse a pane list captured before it created or changed a tab.
    const previous = this.layoutRefresh;
    const task = (async () => { await previous; return this.refreshLayoutNow(); })();
    this.layoutRefresh = task;
    try { return await task; }
    finally { if (this.layoutRefresh === task) this.layoutRefresh = null; }
  }
  async refreshLayoutNow() {
    try {
      const [all, processes] = await Promise.all([this.tmux.panes(), this.tmux.processes()]);
      if (this.closed) return this.snapshot;
      const panes = all.filter((p) => !isControlSession(p.sessionName));
      const c = this.client ? this.client.alive : this.observerAvailable;
      const current = this.records(), spaces = new Map(), agents = [];
      const codexPids = codexProcessAncestors(processes);
      const tabNumbers = new Map();
      for (const t of current) {
        const key = `${t.epoch}:${t.sessionId}`;
        tabNumbers.set(key, Math.max(tabNumbers.get(key) ?? 0, Number(t.tabNumber) || 0));
      }
      const metadata = new Map(this.store.db.prepare("SELECT id,data FROM workspace_spaces").all().map((r) => [r.id, JSON.parse(r.data)]));
      for (const p of panes) {
        if (current.some((t) => t.pathTab && t.contexts?.some((v) => v.paneId === p.paneId && v.panePid === p.panePid && v.epoch === p.epoch))) continue;
        // Older registrations can contain both a shell and a Codex record for one pane.
        const matches = current.filter((r) => r.epoch === p.epoch && r.paneId === p.paneId && r.panePid === p.panePid);
        const owned = matches.find((r) => r.threadId && !r.archived) ?? matches.find((r) => r.threadId) ?? matches[0];
        const codex = !p.dead && hasCodexProcess(p, codexPids);
        const tab = { ...p, id: owned?.id ?? `${p.epoch}:${p.paneId}`, name: owned?.name ?? p.windowName,
          kind: owned?.threadId ? "codex" : codex ? "externalCodex" : "shell",
          state: p.dead ? "stopped" : owned?.threadId ? (c && owned.observedAt ? owned.state : "unknown") : codex ? "untracked" : "shell",
          threadId: owned?.threadId ?? null, latest: owned?.latest ?? "", lastUserQuery: owned?.lastUserQuery ?? null, updatedAt: owned?.updatedAt ?? now(),
          runTiming: owned?.runTiming ?? null,
          archived: owned?.archived ?? false, pathTab: owned?.pathTab ?? false,
          directory: owned?.pathTab ? owned.directory : p.directory, terminalDirectory: p.directory };
        const spaceId = `${p.epoch}:${p.sessionId}`;
        const settings = metadata.get(spaceId);
        const space = spaces.get(spaceId) ?? { id: spaceId, sessionId: p.sessionId, epoch: p.epoch,
          name: settings?.customName ?? (basename(p.directory) || p.directory), customName: settings?.customName ?? null,
          archived: settings?.archived ?? false, directory: p.directory,
          baseDirectory: owned?.baseDirectory ?? p.directory, tabs: [] };
        tab.tabNumber = owned?.tabNumber ?? String((tabNumbers.get(spaceId) ?? 0) + 1);
        tabNumbers.set(spaceId, Math.max(tabNumbers.get(spaceId) ?? 0, Number(tab.tabNumber) || 0));
        tab.customName = owned?.customName ?? null;
        tab.name = tab.customName ?? tab.tabNumber;
        if (!owned?.tabNumber) this.save({ ...(owned ?? tab), tabNumber: tab.tabNumber });
        space.tabs.push(tab); spaces.set(spaceId, space);
        if (tab.kind !== "shell") agents.push({ ...tab, spaceId, spaceName: space.name });
      }
      // Keep finished/closed managed Codex entries visible; never call them "running" without a fresh observation.
      for (const t of current.filter((t) => (t.threadId || t.closedAt) && !agents.some((a) => a.id === t.id))) {
        const spaceId = `${t.epoch}:${t.sessionId}`, settings = metadata.get(spaceId);
        const tab = { ...t, kind: t.threadId ? "codex" : "shell", state: t.closedAt || (c && t.observedAt && !t.archived) ? t.state : "unknown", dead: true,
          spaceId, spaceName: settings?.customName ?? (basename(t.directory ?? "") || t.spaceName) };
        if (t.threadId) agents.push(tab);
        if (t.closedAt) {
          const space = spaces.get(spaceId) ?? { id: spaceId, sessionId: t.sessionId, epoch: t.epoch,
            name: tab.spaceName, customName: settings?.customName ?? null, archived: settings?.archived ?? false,
            directory: t.baseDirectory ?? t.directory, baseDirectory: t.baseDirectory ?? t.directory, tabs: [] };
          space.tabs.push(tab); spaces.set(spaceId, space);
        }
      }
      const visibleSpaces = [...spaces.values()];
      const presentation = this.presentation.observe(visibleSpaces);
      this.snapshot = { spaces: visibleSpaces.map((s) => ({ ...s, tabs: s.tabs.map((t) => this.store.progress.attach(t)) })),
        agents: agents.map((t) => this.store.progress.attach(t)), presentation,
        syncedAt: Math.max(now(), (this.snapshot.syncedAt ?? 0) + 1), error: null };
    } catch (e) {
      this.snapshot = { ...this.snapshot, error: e.message };
    }
    return this.snapshot;
  }
  start() {
    this.refresh();
    this.timer = setInterval(() => { if (!this.closed) this.refresh({ force: false }); }, 2500);
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
        await this.refreshLayout();
        space = this.snapshot.spaces.find((s) => s.id === body.spaceId);
        check(space, "space_stale", "Spaceが見つかりません。再同期してください。", 409);
      }
      const project = this.config.projects.find((p) => p.id === body.projectId);
      const directory = body.directory !== undefined
        ? await directoryPath(body.directory)
        : space?.directory ?? project?.path;
      check(directory, "project", "新しいSpaceの作業場所を選んでください。");
      let threadId = null, command;
      if (body.kind === "codex") {
        const c = await this.shared(true);
        const { thread } = await c.call("thread/start", { historyMode: "legacy", cwd: directory,
          ...threadPermissionOverrides(body.permissionLevel) });
        threadId = thread.id;
        // Persist an empty rollout before the TUI's remote resume bootstrap.
        await c.call("thread/name/set", { threadId, name: EMPTY_THREAD_NAME });
        command = [this.config.codexBin, "resume", "--no-alt-screen", "--remote", `unix://${this.socket}`, threadId];
      }
      const liveSpace = space && (await this.tmux.panes()).some((p) => p.sessionId === space.sessionId && p.epoch === space.epoch);
      const paneId = await this.tmux.create({ space: liveSpace ? space.sessionId : undefined, name: body.name, directory, command });
      const pane = (await this.tmux.panes()).find((p) => p.paneId === paneId);
      check(pane, "terminal_unknown", "端末の作成結果を確認できません。自動再実行しません。", 503);
      const tab = { ...pane, id: body.requestId, name: body.name, threadId,
        permissionLevel: body.permissionLevel || null, spaceName: pane.sessionName, state: "idle", latest: "", archived: false, updatedAt: now() };
      this.save(tab);
      const receipt = this.store.finishRequest(body.requestId, "accepted", { tabId: tab.id });
      await this.refreshLayout();
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
      const matches = this.records().filter((r) => r.epoch === p.epoch && r.paneId === p.paneId && r.panePid === p.panePid);
      const existing = matches.find((r) => r.threadId && !r.archived) ?? matches.find((r) => r.threadId) ?? matches[0];
      if (existing?.threadId) {
        await c.call("thread/resume", { threadId: existing.threadId, ...migrationCwd(this.config, existing.directory) });
        this.save({ ...existing, archived: false });
        return this.store.finishRequest(body.requestId, "accepted", { tabId: existing.id, threadId: existing.threadId, socket: this.socket });
      }
      const { thread } = await c.call("thread/start", { historyMode: "legacy", cwd: p.directory, ...threadPermissionOverrides(body.permissionLevel) });
      // Naming materializes the empty rollout required by codex resume --remote.
      await c.call("thread/name/set", { threadId: thread.id, name: EMPTY_THREAD_NAME });
      const t = { ...existing, ...p, id: existing?.id ?? body.requestId, name: existing?.name ?? p.windowName, threadId: thread.id, permissionLevel: body.permissionLevel || null, spaceName: p.sessionName,
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
  async archiveTab(id, body) {
    requestID(body.requestId);
    return this.chat.exclusive(id, () => this.store.transaction(() => {
      if (this.store.request(body.requestId)) {
        this.store.claim(body.requestId, id, "tab:archive", body);
        return this.store.request(body.requestId);
      }
      const tab = this.record(id);
      check(tab, "tab_missing", "タブが見つかりません。再同期してください。", 404);
      check(body.expectedThreadId === (tab.threadId ?? null), "stale_thread", "タブの会話が変わりました。再同期してください。", 409);
      check(!tab.closeRequestId, "tab_closing", "タブの終了結果を確認してください。", 409);
      check(body.archived === true, "archive", "アーカイブを指定してください。");
      check(tab.closedAt || this.presentation.read().hiddenTabIds.includes(id),
        "tab_active", "非アクティブにしてからアーカイブしてください。", 409);
      this.store.claim(body.requestId, id, "tab:archive", body);
      this.archive(id, true);
      return this.store.finishRequest(body.requestId, "accepted", { tabId: id, archived: true });
    }));
  }
  async updateSpace(id, body) {
    check((typeof body.name === "string") !== (typeof body.archived === "boolean"), "space", "名前または表示の指定が必要です。");
    let name;
    if (typeof body.name === "string") {
      name = body.name.trim();
      check(name.length > 0 && !/[\x00-\x1f\x7f]/.test(name), "name", "Space名を入力してください。");
      textInput(name, 80);
    }
    return this.chat.exclusive(`space:${id}`, async () => {
      await this.refreshLayout();
      const space = this.snapshot.spaces.find((s) => s.id === id);
      check(space, "space_missing", "Spaceが見つかりません。再同期してください。", 404);
      // Verify the tmux server generation and a pane, never rename directories
      // or terminate work when changing the mobile sidebar's presentation.
      const live = space.tabs.find((t) => !t.dead);
      // A Space retained after its last tab closed still has editable metadata.
      if (live) await this.tmux.verified(live);
      const old = this.store.db.prepare("SELECT data FROM workspace_spaces WHERE id=?").get(id);
      const settings = { ...(old ? JSON.parse(old.data) : {}), ...(name ? { customName: name } : { archived: body.archived }) };
      this.store.db.prepare("INSERT INTO workspace_spaces VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(id, JSON.stringify(settings));
      await this.refreshLayout();
      return settings;
    });
  }
  async rename(id, name) {
    textInput(name, 80);
    name = name.trim();
    check(name.length > 0 && !/[\x00-\x1f\x7f]/.test(name), "name", "タブ名を入力してください。");
    return this.chat.exclusive(id, async () => {
      await this.refreshLayout();
      const live = this.snapshot.spaces.flatMap((s) => s.tabs).find((t) => t.id === id);
      const current = this.record(id) ?? live;
      check(current, "tab_missing", "タブが見つかりません。", 404);
      check(!current.closeRequestId, "tab_closing", "タブの終了結果を確認してください。", 409);
      // Renaming inactive history must not recreate or touch a terminal.
      if (live && !live.dead && !current.closedAt) await this.tmux.verified(live);
      this.save({ ...current, name, customName: name, tabNumber: live?.tabNumber ?? current.tabNumber });
      await this.refreshLayout();
      return { name };
    });
  }
}
