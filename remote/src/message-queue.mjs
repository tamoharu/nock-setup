import { randomUUID } from "node:crypto";
import { check, requestID, now } from "./config.mjs";
import { permissionOverrides } from "./agent-settings.mjs";
import { messageInput } from "./attachments.mjs";

export class MessageQueue {
  constructor(service) {
    this.service = service; this.store = service.store;
    this.store.db.exec("CREATE TABLE IF NOT EXISTS message_queue(id TEXT PRIMARY KEY, session TEXT NOT NULL, data TEXT NOT NULL)");
    for (const row of this.rows()) if (row.status === "dispatching") this.save({ ...row, status: "unknown", error: "再起動前の送信結果を確認してください。" });
  }
  rows() { return this.store.db.prepare("SELECT data FROM message_queue ORDER BY rowid").all().map((r) => JSON.parse(r.data)); }
  save(row) { this.store.db.prepare("INSERT INTO message_queue VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(row.id, row.sessionId, JSON.stringify(row)); }
  list(id) { return this.rows().filter((r) => r.sessionId === id).map((r) => ({ id: r.id, text: r.body.text,
    attachmentCount: r.body.attachments?.length ?? 0, status: r.status, error: r.error ?? null })); }
  target(id, shared) { return shared ? this.service.workspace.chat.record(id) : this.store.session(id); }
  add(id, body, shared) {
    requestID(body.requestId);
    const old = this.store.request(body.requestId);
    if (old) { this.store.claim(body.requestId, id, "queue:add", body); return old; }
    const target = this.target(id, shared);
    check(!target.archived && target.threadId && body.expectedThreadId === target.threadId, "stale_thread", "会話を同期してからキューに追加してください。", 409);
    permissionOverrides(body.permissionLevel);
    messageInput(this.service.attachments, body, id, target.threadId);
    check(this.list(id).length < 20, "queue_full", "キューは20件までです。");
    return this.store.transaction(() => {
      this.store.claim(body.requestId, id, "queue:add", body);
      this.save({ id: body.requestId, sessionId: id, shared, body: { ...body, requestId: randomUUID() }, status: "queued", createdAt: now() });
      return this.store.finishRequest(body.requestId, "accepted", { queued: true, queueId: body.requestId });
    });
  }
  remove(id, queueId) {
    const row = this.rows().find((r) => r.id === queueId && r.sessionId === id);
    if (!row) return { removed: true };
    check(row.status !== "dispatching" && row.status !== "unknown", "queue_busy", "送信結果が不明な項目は履歴で受理結果を確認してください。", 409);
    this.store.db.prepare("DELETE FROM message_queue WHERE id=? AND session=?").run(queueId, id);
    return { removed: true };
  }
  update(id, queueId, body) {
    const row = this.rows().find((r) => r.id === queueId && r.sessionId === id);
    check(row, "queue_missing", "この項目は送信済み、または削除済みです。", 409);
    check(["queued", "failed"].includes(row.status), "queue_busy", "送信中、または送信結果が不明な項目は編集できません。", 409);
    check(typeof body.text === "string" && typeof body.expectedText === "string", "text", "編集する本文が不正です。");
    check(row.body.text === body.expectedText || row.body.text === body.text,
      "queue_changed", "本文が別の操作で変更されました。一覧を開き直してください。", 409);
    const target = this.target(id, row.shared);
    check(!target.archived && target.threadId === row.body.expectedThreadId, "stale_thread", "会話が変更されたため編集できません。", 409);
    const updated = { ...row.body, text: body.text };
    messageInput(this.service.attachments, updated, id, target.threadId);
    this.save({ ...row, body: updated });
    return { updated: true };
  }
  start() { this.timer = setInterval(() => { this.tick().catch(() => {}); }, 1000); this.timer.unref(); }
  close() { this.closed = true; clearInterval(this.timer); }
  async tick() {
    if (this.running || this.closed) return;
    this.running = true;
    try {
      const seen = new Set();
      for (let row of this.rows()) {
        if (this.closed || seen.has(row.sessionId)) continue;
        seen.add(row.sessionId);
        if (row.status !== "queued") {
          const receipt = this.store.request(row.body.requestId);
          if (receipt?.status === "accepted") this.store.db.prepare("DELETE FROM message_queue WHERE id=?").run(row.id);
          else if (["abandoned", "rejected"].includes(receipt?.status)) this.save({ ...row, status: "failed", error: "送信結果の確認が完了しました。項目を削除できます。" });
          continue;
        }
        try {
          const target = this.target(row.sessionId, row.shared);
          check(target.threadId === row.body.expectedThreadId && !target.archived, "stale_thread", "会話が変更されたためキューを停止しました。", 409);
          if (row.shared) {
            const c = await this.service.workspace.shared();
            if (!c?.alive) continue;
            const thread = await this.service.workspace.chat.readThread(c, target.threadId);
            if (thread.status?.type !== "idle") continue;
          } else if (["starting", "running", "waiting"].includes(target.state)) continue;
          // Shared-thread checks await RPCs; edits or deletion can happen meanwhile.
          const current = this.rows().find((r) => r.id === row.id);
          if (this.closed || !current || current.status !== "queued") continue;
          row = current;
          this.save({ ...row, status: "dispatching" });
          const receipt = row.shared ? await this.service.workspace.chat.mutate(row.sessionId, "turns", row.body)
            : await this.service.send(row.sessionId, row.body);
          if (receipt.status === "accepted") this.store.db.prepare("DELETE FROM message_queue WHERE id=?").run(row.id);
          else this.save({ ...row, status: receipt.status === "rejected" ? "failed" : "unknown", error: receipt.result?.message ?? "送信結果を確認してください。" });
        } catch (error) {
          const current = this.rows().find((r) => r.id === row.id);
          if (!current) continue;
          row = current;
          this.save({ ...row, status: ["busy", "codex_offline", "unknown_request"].includes(error.code) ? "queued" : "failed", error: error.message });
        }
      }
    } finally { this.running = false; }
  }
}
