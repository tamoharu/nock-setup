import { DatabaseSync } from "node:sqlite";
import { randomUUID, createHash } from "node:crypto";
import { now, json, check } from "./config.mjs";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    );
  return value;
}

export class Store {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS items(session TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(session,id));
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, session TEXT, kind TEXT NOT NULL, payload TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, session TEXT, kind TEXT NOT NULL, hash TEXT NOT NULL, status TEXT NOT NULL, result TEXT, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY, session TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY, token TEXT NOT NULL, environment TEXT NOT NULL, host TEXT NOT NULL, active INTEGER NOT NULL, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY, event TEXT NOT NULL, device TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next INTEGER NOT NULL, expires INTEGER NOT NULL, reason TEXT, UNIQUE(event,device));
      CREATE INDEX IF NOT EXISTS events_session ON events(session,seq);
      CREATE INDEX IF NOT EXISTS items_session_kind_position ON items(session,json_extract(data,'$.kind'),position);
      CREATE INDEX IF NOT EXISTS outbox_ready ON outbox(status,next);`);
    this.db
      .prepare("INSERT OR IGNORE INTO meta VALUES (?,?)")
      .run("serverId", randomUUID());
  }
  get serverId() {
    return this.db.prepare("SELECT value FROM meta WHERE key=?").get("serverId")
      .value;
  }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  sessions() {
    return this.db
      .prepare(`SELECT s.data, (SELECT i.data FROM items i WHERE i.session=s.id AND json_extract(i.data,'$.kind')='userMessage' ORDER BY i.position DESC LIMIT 1) AS last_user FROM sessions s`)
      .all()
      .map((r) => ({ ...JSON.parse(r.data), lastUserQuery: r.last_user ? JSON.parse(r.last_user).text?.trim().slice(0, 1000) || "添付のみのメッセージ" : "" }));
  }
  session(id) {
    const r = this.db.prepare("SELECT data FROM sessions WHERE id=?").get(id);
    check(r, "session_missing", "作業が見つかりません。", 404);
    return JSON.parse(r.data);
  }
  saveSession(s) {
    this.db
      .prepare(
        "INSERT INTO sessions VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(s.id, json(s));
  }
  items(session, before = Number.MAX_SAFE_INTEGER, limit = 200) {
    return this.db
      .prepare(
        "SELECT data FROM (SELECT data,position FROM items WHERE session=? AND position<? ORDER BY position DESC LIMIT ?) ORDER BY position",
      )
      .all(session, before, limit)
      .map((r) => JSON.parse(r.data));
  }
  item(session, id) {
    const r = this.db
      .prepare("SELECT data FROM items WHERE session=? AND id=?")
      .get(session, id);
    return r ? JSON.parse(r.data) : undefined;
  }
  saveItem(session, item) {
    const previous = this.item(session, item.id);
    const position =
      previous?.position ??
      this.db
        .prepare(
          "SELECT COALESCE(MAX(position),0)+1 AS n FROM items WHERE session=?",
        )
        .get(session).n;
    const data = { ...previous, ...item, position };
    this.db
      .prepare(
        "INSERT INTO items VALUES (?,?,?,?) ON CONFLICT(session,id) DO UPDATE SET data=excluded.data",
      )
      .run(session, item.id, position, json(data));
    return data;
  }
  event(session, kind, payload, dedupe = randomUUID()) {
    // INSERT OR IGNORE consumes an AUTOINCREMENT value on duplicates, which
    // would look like a missing event to clients. This synchronous, single-owner
    // store checks the unique key before allocating the next sequence value.
    if (this.db.prepare("SELECT 1 FROM events WHERE id=?").get(dedupe))
      return null;
    const result = this.db
      .prepare(
        "INSERT INTO events(id,session,kind,payload,created) VALUES (?,?,?,?,?)",
      )
      .run(dedupe, session, kind, json(payload), now());
    return result.changes
      ? { id: dedupe, seq: Number(result.lastInsertRowid) }
      : null;
  }
  cursor() {
    return this.db.prepare("SELECT COALESCE(MAX(seq),0) AS n FROM events").get()
      .n;
  }
  events(after, limit = 500) {
    return this.db
      .prepare("SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?")
      .all(after, limit)
      .map((e) => ({
        seq: e.seq,
        id: e.id,
        sessionId: e.session,
        kind: e.kind,
        payload: JSON.parse(e.payload),
        createdAt: e.created,
      }));
  }
  request(id) {
    const r = this.db.prepare("SELECT * FROM requests WHERE id=?").get(id);
    return r
      ? {
          id: r.id,
          sessionId: r.session,
          kind: r.kind,
          status: r.status,
          result: r.result ? JSON.parse(r.result) : null,
        }
      : null;
  }
  claim(id, session, kind, body) {
    const hash = createHash("sha256")
      .update(json(canonical(body)))
      .digest("hex");
    const old = this.db.prepare("SELECT * FROM requests WHERE id=?").get(id);
    if (old) {
      check(
        old.hash === hash && old.session === session && old.kind === kind,
        "id_conflict",
        "同じ要求IDが異なる内容に使われています。",
        409,
      );
      return false;
    }
    this.db
      .prepare("INSERT INTO requests VALUES (?,?,?,?,?,?,?)")
      .run(id, session, kind, hash, "dispatching", null, now());
    return true;
  }
  finishRequest(id, status, result) {
    this.db
      .prepare("UPDATE requests SET status=?,result=? WHERE id=?")
      .run(status, json(result), id);
    return this.request(id);
  }
  pending(session) {
    return this.db
      .prepare("SELECT data FROM approvals WHERE session=?")
      .all(session)
      .map((r) => JSON.parse(r.data))
      .filter((a) => a.status === "pending");
  }
  approval(id) {
    const r = this.db.prepare("SELECT data FROM approvals WHERE id=?").get(id);
    check(r, "approval_missing", "確認要求が見つかりません。", 404);
    return JSON.parse(r.data);
  }
  saveApproval(a) {
    this.db
      .prepare(
        "INSERT INTO approvals VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(a.id, a.sessionId, json(a));
  }
  expireApprovals(session) {
    for (const a of this.pending(session))
      this.saveApproval({ ...a, status: "expired" });
  }
  devices() {
    return this.db
      .prepare("SELECT id,environment,host,active,updated FROM devices")
      .all();
  }
  registerDevice({ id, token, environment, hostId }) {
    this.db
      .prepare(
        "INSERT INTO devices VALUES (?,?,?,?,1,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token,environment=excluded.environment,host=excluded.host,active=1,updated=excluded.updated",
      )
      .run(id, token, environment, hostId, now());
  }
  removeDevice(id) {
    this.transaction(() => {
      this.db.prepare("DELETE FROM devices WHERE id=?").run(id);
      this.db.prepare("DELETE FROM outbox WHERE device=?").run(id);
    });
  }
  enqueue(event, session, state, projectName, deviceId = null) {
    for (const d of this.db
      .prepare("SELECT * FROM devices WHERE active=1")
      .all()) {
      if (deviceId && d.id !== deviceId) continue;
      const status =
        {
          completed: "応答完了",
          waiting: "確認・承認が必要です",
          failed: "実行失敗",
          test: "通知テスト",
        }[state] ?? state;
      const payload = {
        aps: {
          alert: {
            title: "Nock",
            body: `${projectName} · ${session.name} · ${status}`.slice(0, 220),
          },
          sound: "default",
          "thread-id": session.id,
        },
        nock: {
          serverId: this.serverId,
          hostId: d.host,
          sessionId: session.id,
          eventId: event.id,
        },
      };
      this.db
        .prepare(
          "INSERT OR IGNORE INTO outbox(id,event,device,payload,status,next,expires) VALUES (?,?,?,?,?,?,?)",
        )
        .run(
          randomUUID(),
          event.id,
          d.id,
          json(payload),
          "queued",
          now(),
          now() + 3600000,
        );
    }
  }
  notificationStatus() {
    return this.db
      .prepare(
        "SELECT id,event,device,status,attempts,reason,next,expires FROM outbox ORDER BY rowid DESC LIMIT 30",
      )
      .all();
  }
  close() {
    this.db.close();
  }
}
