import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { CODEX_VERSION, Fault, check } from "./config.mjs";

export function verifyCodex(bin) {
  const version = execFileSync(bin, ["--version"], {
    encoding: "utf8",
    timeout: 10000,
  }).trim();
  check(
    version === `codex-cli ${CODEX_VERSION}`,
    "codex_version",
    `Codex ${CODEX_VERSION} が必要です（検出: ${version}）。`,
  );
}
export function processIdentity(pid) {
  if (process.platform === "darwin") {
    try {
      return (
        execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
          encoding: "utf8",
          timeout: 3000,
        }).trim() || null
      );
    } catch {
      return null;
    }
  }
  if (process.platform !== "linux") return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch {
    return null;
  }
}
// Stdio cannot be reattached after the owner crashes. Kill ONLY the recorded,
// verified process group before a user explicitly starts a new turn.
export function reconcileProcess(record) {
  if (
    !record?.pid ||
    !record?.birth ||
    processIdentity(record.pid) !== record.birth
  )
    return "absent";
  try {
    if (process.platform === "darwin") {
      if (!/^[a-f0-9-]{36}$/.test(record.owner)) return "identity_mismatch";
      // ps output can include private environment values. Inspect in memory only;
      // never return it, attach it to errors, or write it to a service log.
      const environment = execFileSync(
        "/bin/ps",
        ["eww", "-p", String(record.pid), "-o", "command="],
        { encoding: "utf8", timeout: 3000 },
      );
      if (
        !new RegExp(`(?:^| )NOCK_PROCESS_OWNER=${record.owner}(?: |$)`).test(
          environment.trim(),
        )
      )
        return "identity_mismatch";
    } else {
      const env = readFileSync(`/proc/${record.pid}/environ`, "utf8").split(
        "\0",
      );
      if (!env.includes(`NOCK_PROCESS_OWNER=${record.owner}`))
        return "identity_mismatch";
    }
    process.kill(-record.pid, "SIGTERM");
    return "orphan_stopped";
  } catch {
    return "absent";
  }
}
export class Codex extends EventEmitter {
  constructor(bin, cwd, { socket } = {}) {
    super();
    this.pending = new Map();
    this.counter = 0;
    this.alive = false;
    this.bin = bin;
    this.cwd = cwd;
    this.socket = socket;
  }
  async start() {
    if (this.socket) return this.startSocket();
    const owner = randomUUID();
    const args = ["app-server", "--listen", "stdio://"];
    this.child = spawn(this.bin, args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env: { ...process.env, NOCK_PROCESS_OWNER: owner },
    });
    this.alive = true;
    this.record = {
      pid: this.child.pid,
      birth: processIdentity(this.child.pid),
      owner,
    };
    this.child.stderr.on("data", () => {}); // Codex stderr can contain project data; never log it.
    this.child.stdin.on("error", (e) => this.fail(e));
    this.child.on("error", (e) => this.fail(e));
    this.child.on("exit", (code, signal) =>
      this.fail(
        new Fault(
          503,
          "codex_exit",
          `Codexプロセスが終了しました (${code ?? signal})。`,
        ),
      ),
    );
    this.reader = createInterface({
      input: this.child.stdout,
      crlfDelay: Infinity,
    });
    this.reader.on("line", (line) => {
      try {
        const m = JSON.parse(line);
        if (m.method) this.emit("message", m);
        else if (this.pending.has(m.id)) {
          const p = this.pending.get(m.id);
          this.pending.delete(m.id);
          clearTimeout(p.timer);
          if (m.error)
            p.reject(new Fault(422, "codex_rejected", m.error.message));
          else p.resolve(m.result);
        }
      } catch (e) {
        this.fail(
          new Fault(503, "codex_protocol", "Codexイベントを解釈できません。"),
        );
      }
    });
    await this.call("initialize", {
      clientInfo: { name: "nock", title: "Nock", version: "0.2.0" },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: "initialized", params: {} });
  }
  send(value) {
    if (this.ws) {
      check(this.alive && this.ws.readyState === WebSocket.OPEN, "codex_offline", "共有Codexに接続できません。", 503);
      this.ws.send(JSON.stringify(value));
      return;
    }
    check(
      this.alive && this.child.stdin.writable,
      "codex_offline",
      "Codexに接続できません。",
      503,
    );
    this.child.stdin.write(JSON.stringify(value) + "\n");
  }
  call(method, params, timeout = 45000) {
    return new Promise((resolve, reject) => {
      const id = `nock-${++this.counter}`;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Fault(
            504,
            "codex_unknown",
            "Codexから受理結果を確認できません。自動再実行はしません。",
          ),
        );
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  fail(error) {
    if (!this.alive) return;
    this.alive = false;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    this.emit("closed", error);
  }
  stop() {
    if (this.ws) {
      this.ws.close();
      this.fail(new Fault(503, "codex_stopped", "共有Codexの監視接続を閉じました。"));
      return; // The tmux app-server and its TUI clients are not owned by this connection.
    }
    this.reader?.close();
    if (this.child?.pid) {
      try {
        process.kill(-this.child.pid, "SIGTERM");
      } catch {
        this.child.kill();
      }
    }
    this.fail(new Fault(503, "codex_stopped", "Codexを停止しました。"));
  }
  async startSocket() {
    // Codex's unix listener is WebSocket over UDS, not newline-delimited stdio.
    const ws = new WebSocket(`ws+unix://${this.socket}:/`, { handshakeTimeout: 8000, maxPayload: 32 * 1024 * 1024,
      headers: { Host: "localhost" }, perMessageDeflate: false });
    this.ws = ws;
    ws.on("message", (data) => {
      try {
        const m = JSON.parse(data.toString());
        if (m.method) this.emit("message", m);
        else if (this.pending.has(m.id)) {
          const p = this.pending.get(m.id); this.pending.delete(m.id); clearTimeout(p.timer);
          if (m.error) p.reject(new Fault(422, "codex_rejected", m.error.message)); else p.resolve(m.result);
        }
      } catch { this.fail(new Fault(503, "codex_protocol", "Codexイベントを解釈できません。")); }
    });
    ws.on("error", () => this.fail(new Fault(503, "codex_socket", "共有Codexとの接続に失敗しました。")));
    ws.on("close", () => this.fail(new Fault(503, "codex_socket", "共有Codexとの接続が閉じました。")));
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", () => reject(new Fault(503, "codex_socket", "共有Codexへ接続できません。")));
    });
    this.alive = true;
    await this.call("initialize", { clientInfo: { name: "nock", title: "Nock", version: "0.2.0" }, capabilities: { experimentalApi: true } });
    this.send({ method: "initialized", params: {} });
  }
}
