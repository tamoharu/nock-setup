import http2 from "node:http2";
import { createPrivateKey, sign } from "node:crypto";
import { secretFile, now, check } from "./config.mjs";

export class APNsTransport {
  constructor(config) {
    this.config = config;
    this.connections = new Map();
    this.jwt = null;
  }
  token() {
    if (this.jwt && now() - this.issued < 50 * 60000) return this.jwt;
    const c = this.config;
    check(
      /^[A-Z0-9]{10}$/.test(c.teamId) && /^[A-Z0-9]{10}$/.test(c.keyId),
      "apns_config",
      "APNs Team ID / Key IDを確認してください。",
    );
    const key = createPrivateKey(secretFile(c.keyFile));
    check(
      key.asymmetricKeyType === "ec" &&
        key.asymmetricKeyDetails.namedCurve === "prime256v1",
      "apns_key",
      "APNs P-256認証鍵が必要です。",
    );
    const b64 = (x) => Buffer.from(JSON.stringify(x)).toString("base64url");
    const content = `${b64({ alg: "ES256", kid: c.keyId })}.${b64({ iss: c.teamId, iat: Math.floor(now() / 1000) })}`;
    this.jwt = `${content}.${sign("sha256", Buffer.from(content), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
    this.issued = now();
    return this.jwt;
  }
  connection(environment) {
    let c = this.connections.get(environment);
    if (c && !c.closed && !c.destroyed) return c;
    const host =
      environment === "development"
        ? "api.sandbox.push.apple.com"
        : "api.push.apple.com";
    c = http2.connect(`https://${host}`);
    c.on("error", () => {
      c.destroy();
    });
    c.on("goaway", () => {
      c.close();
    });
    this.connections.set(environment, c);
    return c;
  }
  async send(job, device) {
    const jwt = this.token();
    return new Promise((resolve, reject) => {
      const c = this.connection(device.environment);
      const req = c.request({
        ":method": "POST",
        ":path": `/3/device/${device.token}`,
        authorization: `bearer ${jwt}`,
        "apns-topic": this.config.bundleId,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "apns-expiration": String(Math.floor(job.expires / 1000)),
        "apns-id": job.id,
        "apns-collapse-id": job.id,
      });
      let status = 0,
        body = "",
        headers = {};
      req.setTimeout(15000, () => req.destroy(new Error("APNs timeout")));
      req.on("response", (h) => {
        status = Number(h[":status"]);
        headers = h;
      });
      req.on("data", (b) => {
        if (body.length < 8192) body += b;
      });
      req.on("error", reject);
      req.on("end", () => {
        let reason = "";
        try {
          reason = JSON.parse(body).reason ?? "";
        } catch {
          /* 200 has no JSON body */
        }
        resolve({
          status,
          reason,
          retryAfter: Number(headers["retry-after"]) || 0,
        });
      });
      req.end(job.payload);
    });
  }
  close() {
    for (const c of this.connections.values()) c.destroy();
    this.connections.clear();
  }
}

export class NotificationWorker {
  constructor(store, config, transport = new APNsTransport(config)) {
    this.store = store;
    this.config = config;
    this.transport = transport;
    this.running = false;
    this.error = null;
    this.stopping = false;
    this.configurationError = null;
    if (config?.enabled && transport instanceof APNsTransport) {
      try {
        check(
          typeof config.bundleId === "string" && config.bundleId.includes("."),
          "apns_config",
          "APNs Bundle IDを設定してください。",
        );
        transport.token();
      } catch {
        this.configurationError =
          "APNs設定を読み取れません。Team ID / Key ID / Bundle IDと600の認証鍵を確認してください。";
      }
    }
  }
  status() {
    return {
      configured: !!this.config?.enabled && !this.configurationError,
      error: this.configurationError ?? this.error,
      deliveries: this.store.notificationStatus(),
      devices: this.store.devices(),
      meaning: "accepted はAPNsの受理です。端末での表示・既読を保証しません。",
    };
  }
  start() {
    this.timer = setInterval(() => void this.tick(), 3000);
    void this.tick();
  }
  async tick() {
    if (this.running || this.stopping) return;
    this.running = true;
    try {
      const db = this.store.db;
      db.prepare(
        "UPDATE outbox SET status='expired',reason='期限切れ' WHERE status='queued' AND expires<=?",
      ).run(now());
      if (!this.config?.enabled) return;
      for (const job of db
        .prepare(
          "SELECT * FROM outbox WHERE status='queued' AND next<=? ORDER BY next LIMIT 20",
        )
        .all(now())) {
        const device = db
          .prepare("SELECT * FROM devices WHERE id=? AND active=1")
          .get(job.device);
        if (!device) {
          db.prepare(
            "UPDATE outbox SET status='invalid',reason='端末登録なし' WHERE id=?",
          ).run(job.id);
          continue;
        }
        let response;
        try {
          response = await this.transport.send(job, device);
        } catch (e) {
          response = {
            status: 0,
            reason:
              e.code?.startsWith("apns_") || e.code === "secret_permissions"
                ? e.message
                : "APNs接続または認証設定エラー",
          };
        }
        if (this.stopping) return;
        const { status, reason, retryAfter = 0 } = response;
        const attempts = job.attempts + 1;
        let state;
        if (status === 200) {
          state = "accepted";
          this.error = null;
        } else if (
          status === 410 ||
          ["BadDeviceToken", "DeviceTokenNotForTopic"].includes(reason)
        ) {
          state = "invalid";
          db.prepare(
            "UPDATE devices SET active=0 WHERE id=? AND token=? AND updated=?",
          ).run(device.id, device.token, device.updated);
          this.error = reason;
        } else if (
          status === 0 ||
          status === 429 ||
          status >= 500 ||
          reason === "ExpiredProviderToken"
        ) {
          state = "queued";
          this.error = reason;
        } else {
          state = "failed";
          this.error = reason || `APNs HTTP ${status}`;
        }
        if (reason === "ExpiredProviderToken") this.transport.jwt = null;
        const delay = Math.max(
          retryAfter * 1000,
          Math.min(300000, 2000 * 2 ** Math.min(attempts, 8)) +
            Math.floor(Math.random() * 1000),
        );
        db.prepare(
          "UPDATE outbox SET status=?,attempts=?,reason=?,next=? WHERE id=?",
        ).run(state, attempts, reason || null, now() + delay, job.id);
      }
    } finally {
      this.running = false;
    }
  }
  stop() {
    this.stopping = true;
    clearInterval(this.timer);
    this.transport.close();
  }
}
