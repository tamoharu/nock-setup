import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { JsonStore } from "./client-storage.mjs";
import { Connections, Mutations } from "./client-transport.mjs";
import { fleetView, contextKey, clean, cleanBody } from "./tui-model.mjs";

const sameTarget = (a, b) => a && b && contextKey(a) === contextKey(b) && a.source === b.source;
export class TuiBackend {
  constructor(store, connections = new Connections(store), emit = () => {}) {
    this.store = store; this.connections = connections; this.emit = emit;
    this.mutations = new Mutations(store, connections); this.samples = new Map(); this.polling = new Map(); this.locks = new Set(); this.draftRevisions = new Map();
    for (const [id, sample] of Object.entries(store.value.cache || {})) this.samples.set(id, { ...sample, connected: false });
  }
  hosts() { return this.store.value.hosts || []; }
  snapshot() {
    return { type: "snapshot", ...fleetView(this.hosts(), this.samples, Date.now(), { ...this.store.value.preferences, readPositions: this.store.value.readPositions }),
      preferences: this.store.value.preferences || {}, pending: this.mutations.pending().map(p => ({
        id: p.body.requestId, hostId: p.hostId, serverId: p.serverId, status: p.status, path: p.path,
      })), selected: this.selected ?? null, detail: this.detail ?? null,
      draft: this.selected ? this.store.value.drafts?.[contextKey(this.selected)] ?? "" : "",
      draftRevision: this.selected ? this.draftRevisions.get(contextKey(this.selected)) ?? 0 : 0 };
  }
  publish() { if (!this.closed) this.emit(this.snapshot()); }
  async poll(host) {
    if (this.polling.has(host.id)) return this.polling.get(host.id);
    const task = (async () => {
      try {
        const overview = await this.connections.api(host.id, "/v1/overview");
        if (this.closed) return;
        if (!overview.serverId || !overview.workspace?.spaces) throw new Error("接続先のworkspace応答が不正です。");
        const old = this.samples.get(host.id);
        if (old?.overview?.serverId && old.overview.serverId !== overview.serverId) {
          this.connections.close(host.id);
          if (this.selected?.hostId === host.id) { this.selected = null; this.detail = null; }
        }
        this.samples.set(host.id, { overview, receivedAt: Date.now(), connected: true });
      } catch (error) {
        if (this.closed) return;
        this.samples.set(host.id, { ...this.samples.get(host.id), connected: false, error: error.message });
      }
      // Retain only registered hosts and never store API credentials.
      this.store.set("cache", Object.fromEntries(this.hosts().flatMap(h => {
        const s = this.samples.get(h.id);
        return s?.overview ? [[h.id, { overview: s.overview, receivedAt: s.receivedAt }]] : [];
      })));
      this.publish();
    })().finally(() => this.polling.delete(host.id));
    this.polling.set(host.id, task); return task;
  }
  async refresh() {
    await Promise.allSettled(this.hosts().map(h => this.poll(h)));
    await this.refreshDetail();
  }
  start() {
    this.publish(); void this.refresh();
    this.pollTimer = setInterval(() => { void this.refresh(); }, 2000);
    this.clockTimer = setInterval(() => this.publish(), 1000);
  }
  async verify(target, allowOffline = false) {
    if (!target || !this.hosts().some(h => h.id === target.hostId)) throw new Error("マシンを選択してください。");
    const sample = this.samples.get(target.hostId);
    if (!sample?.overview || sample.overview.serverId !== target.serverId) throw new Error("接続先が変更されました。再同期してください。");
    if (!allowOffline) {
      const health = await this.connections.api(target.hostId, "/v1/health");
      if (health.serverId !== target.serverId) throw new Error("接続先のIDが変更されました。再同期してください。");
    }
    if (!target.tabId) return sample;
    const w = sample.overview.workspace;
    const tab = target.source === "session" ? sample.overview.sessions?.find(t => t.id === target.tabId)
      : [...w.spaces.flatMap(s => s.tabs), ...(w.agents || [])].find(t => t.id === target.tabId);
    if (!tab || (tab.threadId ?? null) !== (target.threadId ?? null)) throw new Error("会話が切り替わりました。タブを選び直してください。");
    return tab;
  }
  async refreshDetail() {
    if (!this.selected || this.detailLoading) return;
    const selected = { ...this.selected };
    if (!selected.threadId) return;
    this.detailLoading = true;
    try {
      await this.verify(selected);
      const path = selected.source === "session" ? `/v1/sessions/${encodeURIComponent(selected.tabId)}`
        : `/v1/workspace/tabs/${encodeURIComponent(selected.tabId)}/chat`;
      const detail = await this.connections.api(selected.hostId, path);
      if (!sameTarget(this.selected, selected)) return;
      if (detail.session?.threadId !== selected.threadId) { this.detail = { error: "会話が切り替わりました。再選択してください。" }; return; }
      if (selected.source === "session" && Number.isFinite(detail.session.lastEventSeq))
        this.store.set("readPositions", { ...this.store.value.readPositions, [contextKey(selected)]: detail.session.lastEventSeq });
      this.detail = { ...detail, items: (detail.items || []).map(i => ({ kind: clean(i.kind), text: cleanBody(i.text),
        detail: i.detail, position: i.position })), error: null };
    } catch (error) { if (sameTarget(this.selected, selected)) this.detail = { ...this.detail, error: clean(error.message) }; }
    finally { this.detailLoading = false; this.publish(); }
  }
  saveDraft(target, text) {
    if (typeof text !== "string" || text.length > 100000) throw new Error("下書きが長すぎます。");
    this.store.set("drafts", { ...this.store.value.drafts, [contextKey(target)]: text });
  }
  clearAcceptedDraft(entry) {
    if (!/\/chat\/(turns|queue)$/.test(entry.path)) return;
    const tabId = decodeURIComponent(entry.path.split("/")[4]);
    const target = { hostId: entry.hostId, serverId: entry.serverId, tabId, threadId: entry.body.expectedThreadId };
    if (this.store.value.drafts?.[contextKey(target)] === entry.body.text) this.saveDraft(target, "");
  }
  async mutate(target, path, fields) {
    await this.verify(target);
    // An uncertain operation holds the host until reconciled. A new UUID must
    // never silently re-submit an earlier intent, including after a restart.
    if (this.mutations.pending().some(p => p.hostId === target.hostId)) throw new Error("未確認の操作があります。Ctrl+B r で送信結果を確認してください。");
    const body = { requestId: randomUUID(), ...fields };
    const result = await this.mutations.send(target.hostId, target.serverId, path, body);
    if (result.status === "accepted") this.clearAcceptedDraft({ hostId: target.hostId, serverId: target.serverId, path, body });
    else throw new Error(result.result?.message || "操作の受理を確認できません。再同期して結果を確認してください。");
    await this.refresh(); return result;
  }
  async handle(message) {
    const { action, target } = message;
    if (action === "draft") {
      // Local typing may arrive just after the phone switched this tab's thread.
      // Preserve it under its original identity; only network mutations require
      // the target to remain current.
      if (!target || !this.hosts().some(h => h.id === target.hostId) ||
        ![target.serverId, target.tabId].every(v => typeof v === "string" && v.length > 0 && v.length <= 200) ||
        !(target.threadId == null || typeof target.threadId === "string" && target.threadId.length <= 200))
        throw new Error("下書きの保存先を確認できません。");
      this.saveDraft(target, message.text);
      this.draftRevisions.set(contextKey(target), message.id ?? 0); return {}; }
    if (action === "preferences") {
      const p = message.preferences;
      if (!["all", "running", "waiting", "completed"].includes(p?.filter)) throw new Error("表示条件が不正です。");
      this.store.set("preferences", { filter: p.filter, byPriority: !!p.byPriority, includeArchived: !!p.includeArchived }); this.publish(); return {};
    }
    if (action === "select") {
      const tab = await this.verify(target, true);
      this.selected = { ...target }; this.detail = { items: [], session: { threadId: tab.threadId }, preview: cleanBody(tab.latest) };
      this.publish(); await this.refreshDetail(); return {};
    }
    if (action === "refresh") {
      await this.refresh();
      for (const entry of this.mutations.pending()) {
        try {
          const receipt = await this.mutations.reconcile(entry.body.requestId);
          if (receipt?.status === "accepted") this.clearAcceptedDraft(entry);
        } catch { /* Keep the exact request and original server identity. */ }
      }
      this.publish(); return {};
    }
    const lock = target?.hostId;
    if (!lock || this.locks.has(lock)) throw new Error("このマシンの操作が進行中です。");
    this.locks.add(lock);
    try {
      const tab = await this.verify(target);
      const encoded = encodeURIComponent(target.tabId ?? "");
      if (action === "terminal") {
        if (target.source === "session" || tab.dead || !tab.paneId) throw new Error("接続できる端末がありません。会話を表示するか、Ctrl+B o で再開してください。");
        return { terminal: await this.connections.terminalCommand(target.hostId, tab), target };
      }
      if (action === "create") {
        if (typeof message.directory !== "string" || !message.directory.startsWith("/") || /[\x00-\x1f\x7f]/.test(message.directory)) throw new Error("接続先の絶対パスを入力してください。");
        const result = await this.mutate({ ...target, tabId: null }, "/v1/workspace/tabs", {
          name: "codex", kind: message.kind === "shell" ? "shell" : "codex", directory: message.directory,
          ...(message.spaceId ? { spaceId: message.spaceId } : {}),
        });
        return { tabId: result.result.tabId, hostId: target.hostId };
      }
      if (action === "hide" || action === "show") {
        return await this.mutate(target, "/v1/workspace/presentation", { tabId: target.tabId, hidden: action === "hide" });
      }
      if (action === "resume") {
        if (!target.threadId || target.source === "session") throw new Error("この会話の端末は再開できません。");
        const result = await this.mutate(target, "/v1/workspace/path-tabs", { threadId: target.threadId, directory: tab.directory });
        await this.mutate(target, "/v1/workspace/presentation", { tabId: result.result.tabId, hidden: false });
        return { tabId: result.result.tabId, hostId: target.hostId };
      }
      if (target.source === "session") throw new Error("従来の管理対象会話はこの画面では閲覧のみです。モバイルで操作できます。");
      if (action === "send") {
        if (typeof message.text !== "string" || !message.text.trim()) throw new Error("指示を入力してください。");
        // Draft edits are persisted as they arrive; a slow dispatch must not
        // overwrite newer text typed while this turn was being submitted.
        if (this.store.value.drafts?.[contextKey(target)] == null) this.saveDraft(target, message.text);
        return await this.mutate(target, `/v1/workspace/tabs/${encoded}/chat/turns`, { expectedThreadId: target.threadId, text: message.text });
      }
      if (action === "answer") {
        const approval = this.detail?.approvals?.find(a => a.id === message.approvalId);
        if (!sameTarget(this.selected, target) || !approval) throw new Error("確認内容が変わりました。再同期してください。");
        const fields = approval.method === "item/tool/requestUserInput" ? { answers: message.answers } : { decision: message.decision };
        return await this.mutate(target, `/v1/workspace/tabs/${encoded}/chat/approvals/${encodeURIComponent(approval.id)}`, { expectedThreadId: target.threadId, ...fields });
      }
      throw new Error("操作が見つかりません。");
    } finally { this.locks.delete(lock); }
  }
  close() {
    this.closed = true; clearInterval(this.pollTimer); clearInterval(this.clockTimer); this.connections.closeAll();
  }
}

export async function runBackend(statePath) {
  process.umask(0o077);
  const emit = value => process.stdout.write(JSON.stringify(value) + "\n");
  const backend = new TuiBackend(new JsonStore(statePath), undefined, emit);
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", line => {
    if (line.length > 1024 * 1024) return;
    let message;
    try { message = JSON.parse(line); } catch { return; }
    void backend.handle(message).then(result => emit({ type: "result", id: message.id, action: message.action, result }),
      error => emit({ type: "result", id: message.id, action: message.action, error: clean(error.message) }));
  });
  input.on("close", () => { backend.close(); process.exit(0); });
  process.on("SIGTERM", () => { backend.close(); process.exit(0); });
  backend.start();
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  runBackend(process.argv[2]).catch(error => { console.error(clean(error.message)); process.exitCode = 1; });
