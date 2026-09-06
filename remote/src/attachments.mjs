import { mkdir, open, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { join, basename } from "node:path";
import { check, requestID, textInput } from "./config.mjs";

export const MAX_ATTACHMENT_SIZE = 100 * 1024 * 1024;
const CHUNK_SIZE = 256 * 1024;
export class Attachments {
  constructor(store, root) {
    this.store = store; this.root = root; this.locks = new Map();
    store.db.exec("CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY, data TEXT NOT NULL)");
  }
  get(id) {
    requestID(id);
    const row = this.store.db.prepare("SELECT data FROM attachments WHERE id=?").get(id);
    check(row, "attachment_missing", "添付ファイルが見つかりません。選び直してください。", 404);
    return JSON.parse(row.data);
  }
  save(value) {
    this.store.db.prepare("INSERT INTO attachments VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data")
      .run(value.id, JSON.stringify(value));
  }
  async exclusive(id, operation) {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(operation); this.locks.set(id, task);
    try { return await task; } finally { if (this.locks.get(id) === task) this.locks.delete(id); }
  }
  path(value) { return join(this.root, value.id, value.name); }
  async begin(body, sessionId, threadId) {
    requestID(body.id); textInput(body.name, 200);
    check(body.name === basename(body.name) && !/[\\/\x00-\x1f\x7f]/.test(body.name) && ![".", ".."].includes(body.name), "attachment", "ファイル名が不正です。");
    check(Number.isSafeInteger(body.size) && body.size > 0 && body.size <= MAX_ATTACHMENT_SIZE, "attachment_size", "添付は1ファイル100MBまでです。");
    check(typeof body.mimeType === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(body.mimeType), "attachment", "ファイル形式が不正です。");
    check(typeof body.sha256 === "string" && /^[a-f0-9]{64}$/.test(body.sha256), "attachment", "ファイルの確認値が不正です。");
    check(this.root, "attachment", "添付保存先が設定されていません。", 503);
    return this.exclusive(body.id, async () => {
      const existing = this.store.db.prepare("SELECT data FROM attachments WHERE id=?").get(body.id);
      if (existing) {
        const value = JSON.parse(existing.data);
        check(value.sessionId === sessionId && value.threadId === threadId &&
          ["name", "size", "mimeType", "sha256"].every((k) => value[k] === body[k]), "attachment", "添付IDの内容が一致しません。", 409);
        return { id: value.id, offset: (await stat(this.path(value))).size, ready: value.ready };
      }
      const value = { id: body.id, name: body.name, size: body.size, mimeType: body.mimeType,
        sha256: body.sha256, sessionId, threadId, ready: false };
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      await mkdir(join(this.root, value.id), { mode: 0o700 });
      const file = await open(this.path(value), "wx", 0o600); await file.close();
      this.save(value);
      return { id: value.id, offset: 0, ready: false };
    });
  }
  async chunk(id, body) {
    return this.exclusive(id, async () => {
      const value = this.get(id);
      check(!value.ready, "attachment", "この添付は転送済みです。", 409);
      check(Number.isSafeInteger(body.offset) && body.offset >= 0 && typeof body.data === "string" &&
        body.data.length <= Math.ceil(CHUNK_SIZE / 3) * 4, "attachment", "転送データが不正です。");
      const bytes = Buffer.from(body.data, "base64");
      check(bytes.length > 0 && bytes.length <= CHUNK_SIZE && bytes.toString("base64") === body.data &&
        body.offset + bytes.length <= value.size, "attachment_size", "転送データのサイズが一致しません。");
      const file = await open(this.path(value), "r+");
      try {
        const size = (await file.stat()).size;
        check(body.offset <= size, "attachment_offset", "転送位置が一致しません。再送してください。", 409);
        // A lost chunk response can be retried with the same offset and bytes.
        if (body.offset < size) {
          const overlap = Math.min(bytes.length, size - body.offset);
          const old = Buffer.alloc(overlap); await file.read(old, 0, overlap, body.offset);
          check(old.equals(bytes.subarray(0, overlap)), "attachment_offset", "転送済みデータと一致しません。", 409);
        }
        let written = 0;
        while (written < bytes.length) {
          const result = await file.write(bytes, written, bytes.length - written, body.offset + written);
          check(result.bytesWritten > 0, "attachment", "添付の保存が中断されました。", 503);
          written += result.bytesWritten;
        }
        await file.sync();
        return { offset: Math.max(size, body.offset + bytes.length) };
      } finally { await file.close(); }
    });
  }
  async complete(id) {
    return this.exclusive(id, async () => {
      const value = this.get(id);
      check((await stat(this.path(value))).size === value.size, "attachment_size", "ファイルの転送が完了していません。", 409);
      const hash = createHash("sha256");
      for await (const bytes of createReadStream(this.path(value))) hash.update(bytes);
      check(hash.digest("hex") === value.sha256, "attachment", "転送内容が一致しません。添付を選び直してください。", 409);
      this.save({ ...value, ready: true });
      return { id, ready: true };
    });
  }
  input(body, sessionId, threadId) {
    const ids = body.attachments ?? [];
    check(Array.isArray(ids) && ids.length <= 10 && new Set(ids).size === ids.length, "attachment", "添付は10個までです。");
    check(typeof body.text === "string" && body.text.length <= 100000 && (body.text.trim() || ids.length), "text", "メッセージか添付を入力してください。");
    const values = ids.map((id) => this.get(id));
    for (const value of values) check(value.ready && value.sessionId === sessionId && value.threadId === threadId,
      "attachment", "この会話で転送済みの添付を選んでください。", 409);
    const descriptions = values.map((v) => `添付 ${JSON.stringify(v.name)} (${v.mimeType}): ${JSON.stringify(this.path(v))}`);
    const text = [body.text, ...descriptions].filter(Boolean).join("\n");
    return [{ type: "text", text }, ...values.filter((v) => ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(v.mimeType))
      .map((v) => ({ type: "localImage", path: this.path(v) }))];
  }
}

export function messageInput(attachments, body, sessionId, threadId) {
  if (attachments) return attachments.input(body, sessionId, threadId);
  check(!body.attachments?.length, "attachment", "添付機能を利用できません。", 503);
  textInput(body.text, 100000);
  return [{ type: "text", text: body.text }];
}
