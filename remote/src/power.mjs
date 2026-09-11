import { readFileSync, writeFileSync, renameSync, unlinkSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { check, requestID } from "./config.mjs";

export const POWER_ROOT = "/Library/Application Support/hati-power";
export const POWER_LABEL = "com.deep.hati.power";

export class MacPowerLease {
  constructor({ root = POWER_ROOT, uid = process.getuid?.(), clock = () => Date.now() / 1000 } = {}) {
    this.root = root;
    this.uid = uid;
    this.clock = clock;
    this.path = join(root, "requests", randomUUID() + ".json");
  }
  status() {
    try {
      const stat = lstatSync(join(this.root, "status.json"));
      const value = JSON.parse(readFileSync(join(this.root, "status.json"), "utf8"));
      const age = this.clock() - value.updatedAt;
      if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) || value.version !== 1 || value.owner !== this.uid ||
          !Number.isFinite(age) || age < 0 || age > 10 || typeof value.active !== "boolean" ||
          !(value.onAC === null || typeof value.onAC === "boolean")) return null;
      return value;
    } catch { return null; }
  }
  refresh(enabled) {
    if (!enabled) return this.release();
    const path = this.path + ".tmp";
    try {
      // Only this daemon incarnation owns this lease; another listener/process
      // cannot remove it. The root helper expires it after a crash or hang.
      writeFileSync(path, JSON.stringify({ expiresAt: this.clock() + 15 }), { mode: 0o600 });
      renameSync(path, this.path);
    } finally {
      try { unlinkSync(path); } catch (e) { if (e.code !== "ENOENT") throw e; }
    }
  }
  persist(preference, serverId) {
    try { lstatSync(join(this.root, "requests")); }
    catch (error) { if (error.code === "ENOENT" && !preference.keepAwakeOnAC) return; throw error; }
    const path = join(this.root, "requests", "preference.json");
    const body = JSON.stringify({ version: 2, serverId, revision: preference.revision, enabled: preference.keepAwakeOnAC });
    try {
      const saved = readFileSync(path, "utf8"), previous = JSON.parse(saved);
      check(previous.serverId === serverId, "power_controller", "別の常駐サービスが電源設定を管理しています。接続先を確認してください。");
      check(previous.revision <= preference.revision, "power_conflict", "新しい電源設定の同期を待っています。");
      if (saved === body) return;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const temporary = path + "." + randomUUID() + ".tmp";
    try {
      writeFileSync(temporary, body, { mode: 0o600, flag: "wx", flush: true });
      renameSync(temporary, path);
    } finally { try { unlinkSync(temporary); } catch {} }
  }
  release() {
    try { unlinkSync(this.path); } catch (e) { if (e.code !== "ENOENT") throw e; }
  }
}

// Host settings and receipts commit together. Hardware effects are reconciled
// from that durable desired state, rather than replayed as one-shot commands.
export class PowerSettings {
  constructor(store, { platform = process.platform, lease = new MacPowerLease() } = {}) {
    this.store = store;
    this.platform = platform;
    this.lease = lease;
    this.running = false;
    this.error = null;
    store.db.exec("CREATE TABLE IF NOT EXISTS machine_power(id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL, revision INTEGER NOT NULL)");
  }
  preference() {
    const row = this.store.db.prepare("SELECT enabled,revision FROM machine_power WHERE id=1").get();
    return { keepAwakeOnAC: !!row?.enabled, revision: row?.revision ?? 0 };
  }
  status() {
    const preference = this.preference(), supported = this.platform === "darwin";
    const helper = supported ? this.lease.status() : null;
    return {
      serverId: this.store.serverId, ...preference, supported, helperReady: !!helper,
      helperVersion: helper?.policyVersion ?? (helper ? 1 : 0),
      persistent: helper?.policyVersion === 2,
      onAC: helper?.onAC ?? null,
      active: this.running && preference.keepAwakeOnAC && helper?.onAC === true && helper?.active === true && !this.error && !helper?.error,
      error: this.error || helper?.error || null,
    };
  }
  mutate(body) {
    requestID(body.requestId);
    check(body.expectedServerId === this.store.serverId, "server_changed", "接続先が変更されました。再接続してください。", 409);
    if (this.store.request(body.requestId)) {
      this.store.claim(body.requestId, "machine-power", "power:update", body);
      return this.store.request(body.requestId);
    }
    check(typeof body.keepAwakeOnAC === "boolean" && Number.isSafeInteger(body.expectedRevision), "power_settings", "電源設定が不正です。");
    check(this.platform === "darwin", "power_unsupported", "この設定はMacで利用できます。", 409);
    check(!body.keepAwakeOnAC || this.lease.status(), "power_setup", "開発先MacのHatiで電源制御を準備してください。", 409);
    const receipt = this.store.transaction(() => {
      if (!this.store.claim(body.requestId, "machine-power", "power:update", body)) return this.store.request(body.requestId);
      const previous = this.preference();
      // A delayed/retried request cannot overwrite a newer choice on another device.
      if (body.expectedRevision !== previous.revision) return this.store.finishRequest(body.requestId, "rejected", {
        code: "power_conflict", message: "別の端末で設定が変更されました。最新の設定を確認してください。",
      });
      const revision = previous.revision + 1;
      this.store.db.prepare("INSERT INTO machine_power VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,revision=excluded.revision")
        .run(Number(body.keepAwakeOnAC), revision);
      return this.store.finishRequest(body.requestId, "accepted", { keepAwakeOnAC: body.keepAwakeOnAC, revision });
    });
    this.refresh();
    return receipt;
  }
  refresh() {
    if (!this.running || this.platform !== "darwin") return;
    try {
      // The durable choice survives daemon crashes, upgrades and app shutdown.
      // Keep the legacy lease only until the installed helper has been upgraded.
      this.lease.persist?.(this.preference(), this.store.serverId);
      this.lease.refresh(this.lease.status()?.policyVersion === 2 ? false : this.preference().keepAwakeOnAC);
      this.error = null;
    }
    catch (error) { this.error = ["power_controller", "power_conflict"].includes(error.code) ? error.message : "電源制御に接続できません。MacのHatiで電源制御を準備してください。"; }
  }
  start() {
    if (this.running) return;
    this.running = true;
    this.refresh();
    if (this.platform === "darwin") this.timer = setInterval(() => this.refresh(), 5000).unref();
  }
  close() {
    this.running = false;
    clearInterval(this.timer);
    if (this.platform === "darwin") {
      try { this.lease.release(); } catch { /* The lease expires independently. */ }
    }
  }
}
