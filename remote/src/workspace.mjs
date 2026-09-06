import { existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { SharedChat } from "./shared-chat.mjs";
import { PathTabs } from "./path-tabs.mjs";
import { CodeBrowser } from "./code-browser.mjs";
import { Attachments } from "./attachments.mjs";
import { threadPermissionOverrides } from "./agent-settings.mjs";
import { Codex } from "./codex.mjs";
import { Tmux, hasCodexProcess } from "./tmux.mjs";
import { check, requestID, textInput, now } from "./config.mjs";
import { runTiming } from "./run-timing.mjs";
import { EMPTY_THREAD_NAME, ThreadTitles } from "./thread-titles.mjs";

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
    this.controlName = "nock-control-" + createHash("sha256").update(this.socket).digest("hex").slice(0, 10);
    this.snapshot = { spaces: [], agents: [], syncedAt: null, error: null };
    this.store.db.exec("CREATE TABLE IF NOT EXISTS terminal_tabs(id TEXT PRIMARY KEY,data TEXT NOT NULL)");
    this.store.db.exec("CREATE TABLE IF NOT EXISTS workspace_spaces(id TEXT PRIMARY KEY,data TEXT NOT NULL)");
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
      c.on("message", (m) => { if (!this.closed) { this.chat.onMessage(m, c); this.onMessage(m); } });
      c.on("closed", () => {
        for (const [id, a] of this.chat.approvals) if (a.client === c) this.chat.approvals.delete(id);
      });
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
  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.refreshNow().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  async refreshNow() {
    try {
      let c;
      try { c = await this.shared(); } catch { /* Existing ordinary shells still work. */ }
      this.observerAvailable = !!c;
      const records = this.records();
      if (c) {
        for (const t of records.filter((t) => t.threadId && !t.archived)) {
          try {
            const thread = await this.chat.readThread(c, t.threadId);
            if (this.closed) return this.snapshot;
            // Repairs desktop as well as mobile turns, including missed events
            // after a daemon restart. A naming failure must not hide run status.
            try { await this.titles.repair(c, thread); } catch { /* Retry on the next refresh. */ }
            if (this.closed) return this.snapshot;
            if (this.records().find((r) => r.id === t.id)?.threadId !== t.threadId) continue;
            const state = threadState(thread, t.state), lastTurn = thread.turns?.at(-1);
            // Polling repairs missed structured events after an observer restart.
            if (lastTurn && ["completed", "failed", "stopped"].includes(state))
              this.transition(this.records().find((r) => r.id === t.id), state, `turn:${lastTurn.id}:${state}`);
            const before = this.records().find((r) => r.id === t.id);
            if (state === "waiting" && before.state !== "waiting") {
              this.transition(before, state, `wait:${lastTurn?.id ?? before.turnId ?? "none"}:${before.waitCounter ?? 0}`);
              this.save({ ...this.records().find((r) => r.id === t.id), waitingSource: "status" });
            }
            const current = this.records().find((r) => r.id === t.id);
            this.save({ ...current, ...conversationSummary(thread, current),
              updatedAt: Math.max(current.updatedAt ?? 0, (thread.updatedAt ?? 0) * 1000,
                (lastTurn?.startedAt ?? 0) * 1000, (lastTurn?.completedAt ?? 0) * 1000),
              waitCounter: (current.waitCounter ?? 0) + (current.state === "waiting" && state !== "waiting" ? 1 : 0) });
          } catch {
            const current = this.records().find((r) => r.id === t.id);
            if (!this.closed && current?.threadId === t.threadId) this.save({ ...current, observedAt: null });
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
      const panes = all.filter((p) => !p.sessionName.startsWith("nock-control-"));
      const c = this.client ? this.client.alive : this.observerAvailable;
      const current = this.records(), spaces = new Map(), agents = [];
      const metadata = new Map(this.store.db.prepare("SELECT id,data FROM workspace_spaces").all().map((r) => [r.id, JSON.parse(r.data)]));
      for (const p of panes) {
        if (current.some((t) => t.pathTab && t.contexts?.some((v) => v.paneId === p.paneId && v.panePid === p.panePid && v.epoch === p.epoch))) continue;
        // Older registrations can contain both a shell and a Codex record for one pane.
        const matches = current.filter((r) => r.epoch === p.epoch && r.paneId === p.paneId && r.panePid === p.panePid);
        const owned = matches.find((r) => r.threadId && !r.archived) ?? matches.find((r) => r.threadId) ?? matches[0];
        const codex = !p.dead && hasCodexProcess(p, processes);
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
          archived: settings?.archived ?? false, directory: p.directory, tabs: [] };
        tab.tabNumber = owned?.tabNumber ?? String(Math.max(0,
          ...this.records().filter((r) => r.sessionId === p.sessionId && r.epoch === p.epoch).map((r) => Number(r.tabNumber) || 0)) + 1);
        tab.customName = owned?.customName ?? null;
        tab.name = tab.customName ?? tab.tabNumber;
        if (!owned?.tabNumber) this.save({ ...(owned ?? tab), tabNumber: tab.tabNumber });
        space.tabs.push(tab); spaces.set(spaceId, space);
        if (tab.kind !== "shell") agents.push({ ...tab, spaceId, spaceName: space.name });
      }
      // Keep finished/closed managed Codex entries visible; never call them "running" without a fresh observation.
      for (const t of current.filter((t) => t.threadId && !agents.some((a) => a.id === t.id)))
        agents.push({ ...t, kind: "codex", state: c && t.observedAt && !t.archived ? t.state : "unknown", dead: true,
          spaceId: `${t.epoch}:${t.sessionId}`, spaceName: metadata.get(`${t.epoch}:${t.sessionId}`)?.customName ?? (basename(t.directory ?? "") || t.spaceName) });
      this.snapshot = { spaces: [...spaces.values()], agents, syncedAt: Math.max(now(), (this.snapshot.syncedAt ?? 0) + 1), error: null };
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
        await this.refreshLayout();
        space = this.snapshot.spaces.find((s) => s.id === body.spaceId);
        check(space, "space_stale", "Spaceが見つかりません。再同期してください。", 409);
      }
      const project = this.config.projects.find((p) => p.id === body.projectId);
      const directory = space?.directory ?? project?.path;
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
      const paneId = await this.tmux.create({ space: space?.sessionId, name: body.name, directory, command });
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
        // Old Nock forced workspace-write/on-request without recording a choice.
        // Repair only those legacy registrations when the user opens them again.
        const permissions = {};
        if (!Object.hasOwn(existing, "permissionLevel")) {
          const { config } = await c.call("config/read", { cwd: p.directory, includeLayers: false });
          if (config.approval_policy != null) permissions.approvalPolicy = config.approval_policy;
          if (config.approvals_reviewer != null) permissions.approvalsReviewer = config.approvals_reviewer;
          if (config.default_permissions != null) permissions.permissions = config.default_permissions;
          else if (config.sandbox_mode === "danger-full-access") permissions.sandboxPolicy = { type: "dangerFullAccess" };
          else if (config.sandbox_mode === "read-only") permissions.sandboxPolicy = { type: "readOnly" };
          else if (config.sandbox_mode === "workspace-write") {
            const policy = config.sandbox_workspace_write ?? {};
            permissions.sandboxPolicy = { type: "workspaceWrite", writableRoots: policy.writable_roots ?? [],
              networkAccess: policy.network_access ?? false, excludeTmpdirEnvVar: policy.exclude_tmpdir_env_var ?? false,
              excludeSlashTmp: policy.exclude_slash_tmp ?? false };
          }
        }
        await c.call("thread/resume", { threadId: existing.threadId });
        if (Object.keys(permissions).length) {
          // Resume ignores overrides for an already-loaded shared thread.
          await c.call("thread/settings/update", { threadId: existing.threadId, ...permissions });
        }
        this.save({ ...existing, permissionLevel: existing.permissionLevel ?? null, archived: false });
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
      check(live, "space_missing", "Spaceは終了しています。再同期してください。", 409);
      await this.tmux.verified(live);
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
      check(live, "tab_missing", "タブが見つかりません。", 404);
      await this.tmux.verified(live);
      const current = this.records().find((r) => r.id === id) ?? live;
      this.save({ ...current, name, customName: name, tabNumber: live.tabNumber });
      await this.refreshLayout();
      return { name };
    });
  }
}
