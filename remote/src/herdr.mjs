import net from "node:net";
import { open, stat, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, join } from "node:path";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";

const execute = promisify(execFile);
export const HERDR_SOURCE = "hati.agents";
export const herdrSettingsPath = (config) => join(config.dataDir, "herdr.json");
const tokenNames = ["hati_host", "hati_tab", "hati_state", "hati_elapsed", "hati_query1", "hati_query2", "hati_running", "hati_activity"];

// Herdr 0.7.x serves one request per connection. Socket identity detects restarts.
export class HerdrRPC {
  constructor(path) { this.path = path; this.sockets = new Set(); this.generation = null; }
  async call(method, params = {}) {
    const info = await stat(this.path);
    if (!info.isSocket() || info.uid !== process.getuid()) throw new Error("Herdrソケットの所有者を確認できません。");
    this.generation = `${info.dev}:${info.ino}:${info.birthtimeMs}`;
    return new Promise((resolve, reject) => {
      const id = randomUUID(), socket = net.createConnection(this.path);
      this.sockets.add(socket);
      let buffer = "", finished = false;
      const finish = (error, result) => {
        if (finished) return;
        finished = true; clearTimeout(timeout); this.sockets.delete(socket); socket.destroy();
        if (error) reject(error); else resolve(result);
      };
      const timeout = setTimeout(() => finish(new Error("Herdr応答がタイムアウトしました。")), 5000);
      socket.setEncoding("utf8");
      socket.on("connect", () => socket.write(JSON.stringify({ id, method, params }) + "\n"));
      socket.on("data", (chunk) => {
        buffer += chunk;
        if (buffer.length > 8 * 1024 * 1024) { finish(new Error("Herdr応答が大きすぎます。")); return; }
        const end = buffer.indexOf("\n");
        if (end < 0) return;
        let message;
        try { message = JSON.parse(buffer.slice(0, end)); } catch { finish(new Error("Herdr応答を読み取れません。")); return; }
        if (message.id !== id) { finish(new Error("Herdr応答IDが一致しません。")); return; }
        if (message.error) finish(new Error(`Herdr: ${message.error.code ?? "api"}`));
        else finish(null, message.result);
      });
      socket.on("error", (error) => finish(error));
      socket.on("close", () => finish(new Error("Herdrとの接続が閉じました。")));
    });
  }
  close() { for (const socket of this.sockets) socket.destroy(); }
}

export function cleanText(text) {
  return String(text ?? "").replace(/[\p{Cc}\u200B\u200E-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/gu, " ").replace(/\s+/gu, " ").trim();
}

// Width-aware preview: do not split surrogate pairs, combining marks or emoji.
export function queryRows(text, width = 34) {
  const segments = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(cleanText(text))].map((s) => s.segment);
  const rows = [""]; let used = 0;
  for (let i = 0; i < segments.length; i++) {
    const c = segments[i], n = /[\p{Extended_Pictographic}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff01-\uff60]/u.test(c) ? 2 : 1;
    if (used + n > width || (rows.length === 2 && used + n > width - 1 && i < segments.length - 1)) {
      if (rows.length === 2) { rows[1] += "…"; break; }
      rows.push(""); used = 0;
    }
    rows[rows.length - 1] += c; used += n;
  }
  return [rows[0].trim(), rows[1]?.trim() || null];
}

const rolloutID = (path) => basename(path).match(/^rollout-.*-([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})\.jsonl$/i)?.[1];
function userText(payload) {
  const metadata = payload.internal_chat_message_metadata_passthrough;
  const kinds = metadata?.content_item_kinds;
  const content = (payload.content ?? []).filter((c, i) => !kinds || kinds[i]?.startsWith("user."));
  const text = content.filter((c) => ["input_text", "text"].includes(c.type)).map((c) => c.text ?? "").join("\n");
  // Older rollouts have no source metadata. Exclude their injected context records.
  if (!kinds && /^(?:# AGENTS\.md instructions|<environment_context>|<permissions instructions>|<turn_aborted>|<subagent_notification>)/u.test(text.trim())) return "";
  return cleanText(text) || (content.some((c) => ["input_image", "image"].includes(c.type)) ? "画像を添付" : "");
}

// Only files held open by this pane's foreground Codex are candidates. No cwd/time guessing.
export async function openRollouts(pids) {
  if (!pids.length) return new Map();
  let stdout;
  try { ({ stdout } = await execute(process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof",
    ["-nP", "-a", "-p", [...new Set(pids)].join(","), "-Fn"], { timeout: 4000, maxBuffer: 4 * 1024 * 1024 })); }
  catch (error) { if (error.code === 1 && typeof error.stdout === "string") stdout = error.stdout; else throw error; }
  const files = new Map(); let pid;
  for (const line of stdout.split("\n")) {
    if (/^p\d+$/.test(line)) { pid = Number(line.slice(1)); files.set(pid, new Set()); }
    if (line.startsWith("n/") && rolloutID(line.slice(1))) files.get(pid)?.add(line.slice(1));
  }
  return files;
}

export class RolloutSummaries {
  constructor() { this.files = new Map(); }
  async read(path, expectedID = rolloutID(path)) {
    if (!expectedID) return null;
    const file = await open(path, "r");
    try {
      const info = await file.stat();
      if (!info.isFile() || info.uid !== process.getuid()) return null;
      let cache = this.files.get(path);
      if (!cache || cache.ino !== info.ino || cache.offset > info.size || cache.id !== expectedID || (cache.size === info.size && cache.mtime !== info.mtimeMs)) {
        cache = { ino: info.ino, id: expectedID, offset: 0, remainder: Buffer.alloc(0), summary: {}, verified: false };
        this.files.set(path, cache);
      }
      if (info.size > cache.offset) {
        for await (const chunk of file.createReadStream({ autoClose: false, start: cache.offset, end: info.size - 1, highWaterMark: 65536 })) {
          cache.offset += chunk.length;
          const data = Buffer.concat([cache.remainder, chunk]); let start = 0, end;
          while ((end = data.indexOf(10, start)) >= 0) {
            if (!cache.skip && end - start <= 2 * 1024 * 1024) {
              try { this.consume(cache, JSON.parse(data.subarray(start, end).toString("utf8"))); } catch { /* Ignore incomplete/corrupt records. */ }
            }
            cache.skip = false; start = end + 1;
          }
          cache.remainder = data.subarray(start);
          if (cache.remainder.length > 2 * 1024 * 1024 || cache.skip) { cache.remainder = Buffer.alloc(0); cache.skip = true; }
        }
      }
      cache.size = info.size; cache.mtime = info.mtimeMs;
      return cache.verified ? { ...cache.summary, threadId: expectedID } : null;
    } finally { await file.close(); }
  }
  consume(cache, value) {
    const p = value.payload ?? {}, s = cache.summary;
    if (value.type === "session_meta") { cache.verified = p.id === cache.id; return; }
    if (!cache.verified) return;
    const time = Date.parse(value.timestamp), at = Number.isFinite(time) ? time : null;
    if (value.type === "event_msg") {
      if (p.type === "task_started") { s.turnId = p.turn_id; s.startedAt = at; s.completedAt = null; s.activityAt = at; }
      if (["task_complete", "turn_aborted"].includes(p.type) && (!p.turn_id || p.turn_id === s.turnId)) { s.completedAt = at; s.activityAt = at; }
      if (p.type === "user_message") { s.query = cleanText(p.message) || (p.images?.length ? "画像を添付" : ""); s.activityAt = at; }
    }
    if (value.type === "response_item" && p.type === "message" && p.role === "user") {
      const text = userText(p);
      if (text) { s.query = text; s.activityAt = at; }
    }
  }
  retain(paths) { for (const key of this.files.keys()) if (!paths.has(key)) this.files.delete(key); }
}

export function elapsedText(milliseconds, estimated = false) {
  if (!Number.isFinite(milliseconds)) return "時間不明";
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000), minutes = Math.floor(seconds / 60), hours = Math.floor(minutes / 60);
  const text = hours ? `${hours}:${String(minutes % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}` : `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
  return (estimated ? "≥" : "") + text;
}

export function agentTokens(agent, summary, observation, now, host, tab) {
  const running = agent.agent_status === "working", waiting = agent.agent_status === "blocked";
  let duration = null, estimated = false;
  if (summary?.startedAt != null) {
    if (summary.completedAt != null && !running) duration = summary.completedAt - summary.startedAt;
    else if (summary.completedAt == null && (running || waiting)) duration = now - summary.startedAt;
  }
  if (duration === null && observation.startedAt != null) {
    duration = (observation.completedAt ?? now) - observation.startedAt; estimated = observation.estimated;
  }
  const query = queryRows(summary?.query || "指示未取得");
  return {
    hati_host: cleanText(host).slice(0, 80), hati_tab: `↳ ${cleanText(tab || agent.tab_id)}`.slice(0, 80),
    hati_state: ({ working: "実行中", blocked: "確認待ち", idle: "待機中", done: "完了", unknown: "状態不明" })[agent.agent_status] ?? "状態不明",
    hati_elapsed: elapsedText(duration, estimated), hati_query1: query[0], hati_query2: query[1],
    hati_running: running ? "1" : "0",
    hati_activity: String(Math.max(summary?.activityAt ?? 0, observation.activityAt ?? 0)).padStart(16, "0"),
  };
}

export class HerdrBridge {
  constructor(config, dependencies = {}) {
    this.config = config; this.makeRPC = dependencies.makeRPC ?? ((path) => new HerdrRPC(path));
    this.workspace = dependencies.workspace;
    this.findFiles = dependencies.findFiles ?? openRollouts; this.reader = dependencies.reader ?? new RolloutSummaries();
    this.observations = new Map(); this.sent = new Map(); this.statusValue = { enabled: false, connected: false, agents: 0, matched: 0 };
  }
  status() { return { ...this.statusValue }; }
  async start() { await this.reload(); }
  async reload() {
    await this.stop();
    let settings;
    try { settings = JSON.parse(await readFile(herdrSettingsPath(this.config), "utf8")); }
    catch (error) { if (error.code !== "ENOENT") this.statusValue.error = "Herdr連携設定を読み取れません。"; return this.status(); }
    if (!settings.enabled) return this.status();
    this.settings = settings; this.rpc = this.makeRPC(settings.socketPath); this.viewGeneration = null;
    this.statusValue = { enabled: true, connected: false, agents: 0, matched: 0 };
    await this.sync();
    this.timer = setInterval(() => { void this.sync(); }, 1000); this.timer.unref();
    return this.status();
  }
  async sync() {
    if (this.pending) return this.pending;
    if (!this.rpc || !this.statusValue.enabled) return this.status();
    this.pending = this.refresh().catch((error) => {
      this.statusValue.connected = false; this.statusValue.error = error.code === "ENOENT" || error.code === "ECONNREFUSED" ? "Herdrの起動を待っています。" : error.message;
      return this.status();
    });
    try { return await this.pending; } finally { this.pending = null; }
  }
  async refresh() {
    const { snapshot } = await this.rpc.call("session.snapshot");
    const agents = snapshot.agents;
    if (this.viewGeneration !== this.rpc.generation) {
      // Set once per server; repeated sets reset Herdr's sidebar scroll position.
      await this.rpc.call("agent.view.set", { source: HERDR_SOURCE, label: "hati · all", sort: [
        { field: { token: "hati_running" }, order: "desc" }, { field: { token: "hati_activity" }, order: "desc" },
        { field: "state_change_seq", order: "desc" }, { field: "pane_order", order: "asc" },
      ] });
      this.viewGeneration = this.rpc.generation; this.sent.clear();
    }
    const now = Date.now();
    // Process/file discovery is slower than display refresh. Revalidate every five seconds,
    // and immediately on native lifecycle changes or new/replaced panes.
    const identity = JSON.stringify(agents.map((a) => [a.pane_id, a.terminal_id, a.agent, a.agent_status, a.agent_session]));
    if (identity !== this.identity || now - (this.discoveredAt ?? 0) >= 5000) {
      const processes = await Promise.all(agents.filter((a) => a.agent === "codex").map(async (a) => {
        try { const { process_info: p } = await this.rpc.call("pane.process_info", { pane_id: a.pane_id });
          return [a, p.foreground_processes ?? []];
        } catch { return [a, []]; }
      }));
      this.processes = processes;
      const codexPids = (ps) => ps.filter((p) => /codex/i.test(p.name) || /(?:^|\/)codex$/.test(p.argv0 ?? "")).map((p) => p.pid);
      let files;
      try { files = await this.findFiles(processes.flatMap(([, ps]) => codexPids(ps))); this.fileError = null; }
      catch { files = new Map(); this.fileError = "lsofで会話を取得できません。状態と観測時間のみ表示します。"; }
      this.bindings = new Map();
      for (const [a, ps] of processes) {
        const pids = codexPids(ps);
        const candidates = [...new Set(pids.flatMap((pid) => [...(files.get(pid) ?? [])]))];
        const ref = a.agent_session;
        const matching = ref?.agent === "codex" ? candidates.filter((path) => ref.kind === "path" ? path === ref.value : rolloutID(path) === ref.value) : candidates;
        if (matching.length === 1) this.bindings.set(a.pane_id, matching[0]);
      }
      this.identity = identity; this.discoveredAt = now;
    }
    const paths = new Set(this.bindings?.values()); this.reader.retain(paths);
    const summaries = new Map(await Promise.all([...paths].map(async (path) => {
      try { return [path, await this.reader.read(path)]; } catch { return [path, null]; }
    })));
    const shared = await this.sharedSummaries(now);
    let matched = 0;
    for (const a of agents) {
      const path = this.bindings?.get(a.pane_id), summary = shared.get(a.pane_id) ?? summaries.get(path);
      if (summary) matched++;
      const key = `${a.terminal_id}:${summary?.threadId ?? path ?? a.agent}`;
      let observation = this.observations.get(a.pane_id);
      if (observation?.key !== key) observation = { key, state: a.agent_status, estimated: true,
        startedAt: ["working", "blocked"].includes(a.agent_status) ? now : null };
      if (observation.state !== a.agent_status) {
        if (a.agent_status === "working" && !["working", "blocked"].includes(observation.state)) {
          observation.startedAt = now; observation.completedAt = null; observation.estimated = true;
        } else if (!["working", "blocked"].includes(a.agent_status)) observation.completedAt = now;
        observation.state = a.agent_status; observation.activityAt = now;
      }
      this.observations.set(a.pane_id, observation);
      const tab = snapshot.tabs.find((t) => t.tab_id === a.tab_id && t.workspace_id === a.workspace_id);
      const tokens = agentTokens(a, summary, observation, now, this.settings.hostName || hostname(), tab?.label);
      const previous = this.sent.get(a.pane_id);
      // TTL removes stale query/timing after daemon failure. Renew idle rows periodically.
      if (previous?.value !== JSON.stringify(tokens) || now - previous.at >= 10000) {
        await this.rpc.call("pane.report_metadata", { pane_id: a.pane_id, source: HERDR_SOURCE, agent: a.agent,
          tokens, ttl_ms: 15000 });
        this.sent.set(a.pane_id, { value: JSON.stringify(tokens), at: now });
      }
    }
    const live = new Set(agents.map((a) => a.pane_id));
    for (const id of this.observations.keys()) if (!live.has(id)) { this.observations.delete(id); this.sent.delete(id); }
    this.statusValue = { enabled: true, connected: true, agents: agents.length, matched, updatedAt: Date.now(), ...(this.fileError ? { error: this.fileError } : {}) };
    return this.status();
  }
  async sharedSummaries(now) {
    const result = new Map(), workspace = this.workspace;
    if (!workspace || workspace.snapshot.error || now - (workspace.snapshot.syncedAt ?? 0) > 10000) return result;
    const candidates = (this.processes ?? []).filter(([, ps]) => ps.some((p) => p.name === "tmux"));
    if (!candidates.length) return result;
    try {
      // Resolve the client's CURRENT pane, not its original attach command target.
      const rows = await workspace.tmux.run(["list-clients", "-F", "#{client_pid} #{pane_id}"]);
      const clients = new Map(rows.split("\n").flatMap((s) => {
        const m = s.match(/^(\d+) (%\d+)$/); return m ? [[Number(m[1]), m[2]]] : [];
      }));
      const panes = await workspace.tmux.panes();
      const tabs = workspace.snapshot.spaces.flatMap((s) => s.tabs);
      for (const [agent, ps] of candidates) {
        const ids = [...new Set(ps.filter((p) => p.name === "tmux").map((p) => clients.get(p.pid)).filter(Boolean))];
        if (ids.length !== 1) continue;
        const live = panes.find((p) => p.paneId === ids[0] && !p.dead);
        const tab = live && tabs.find((t) => t.paneId === live.paneId && t.epoch === live.epoch && t.panePid === live.panePid && t.kind === "codex" && t.threadId && !t.dead);
        if (tab) result.set(agent.pane_id, { threadId: tab.threadId, query: tab.lastUserQuery,
          turnId: tab.runTiming?.turnId, startedAt: tab.runTiming?.startedAt, completedAt: tab.runTiming?.completedAt,
          activityAt: tab.runTiming?.completedAt ?? tab.runTiming?.startedAt ?? tab.updatedAt });
      }
    } catch { /* A detached/replaced tmux client must not retain its old conversation. */ }
    return result;
  }
  async stop() {
    clearInterval(this.timer); this.timer = null;
    await this.pending;
    if (this.rpc) {
      try {
        const { snapshot } = await this.rpc.call("session.snapshot");
        for (const a of snapshot.panes) if (tokenNames.some((key) => a.tokens?.[key] != null))
          await this.rpc.call("pane.report_metadata", { pane_id: a.pane_id, source: HERDR_SOURCE,
            tokens: Object.fromEntries(tokenNames.map((key) => [key, null])) });
        await this.rpc.call("agent.view.clear", { source: HERDR_SOURCE });
      } catch { /* Metadata expires even when Herdr is unavailable. */ }
      this.rpc.close(); this.rpc = null;
    }
    this.observations.clear(); this.sent.clear(); this.reader.retain(new Set()); this.identity = null;
    this.statusValue = { enabled: false, connected: false, agents: 0, matched: 0 };
  }
}
