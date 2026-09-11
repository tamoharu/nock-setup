// Shared HTTP/SSH contract adapted from desktop/electron/transport.mjs for the
// packaged CLI. Keep host validation and durable receipt semantics aligned.
import { readFileSync, existsSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, isAbsolute } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";

const exec = promisify(execFile);
export const quote = (value) =>
  "'" + String(value).replaceAll("'", "'\\''") + "'";
export class APIError extends Error {
  constructor(message, code = "connection", status = 0) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
export function validateRoute(path, method = "GET") {
  if (
    typeof path !== "string" ||
    path.length > 8000 ||
    !/^\/v1\/(health|overview|workspace|sessions|requests|models|account|search|attachments)(\/|\?|$)/.test(
      path,
    ) ||
    /[\x00-\x20\x7f\\#]/.test(path) ||
    path
      .split("?")[0]
      .split("/")
      .some((p) => {
        try {
          return [".", ".."].includes(decodeURIComponent(p));
        } catch {
          return true;
        }
      }) ||
    !["GET", "POST", "PATCH", "DELETE"].includes(method)
  )
    throw new APIError("操作の指定が不正です。", "route");
  return path;
}
export function validateHost(value) {
  const name = Array.from(String(value.name ?? "").trim()).slice(0, 80).join("");
  if (value.kind === "local") {
    const configPath =
      value.configPath || join(homedir(), ".config/hati/config.json");
    if (!isAbsolute(configPath) || configPath.includes("\0"))
      throw new APIError("設定ファイルの絶対パスを指定してください。");
    return {
      id: value.id || randomUUID(),
      kind: "local",
      name: name || hostname().replace(/\.local$/, ""),
      configPath,
    };
  }
  const address = String(value.address ?? "").trim(),
    user = String(value.user ?? "").trim(),
    port = Number(value.port || 22);
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,252}$/.test(address) ||
    (user && !/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/.test(user)) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new APIError("SSHのホスト名・ユーザー名・ポートを確認してください。");
  return {
    id: value.id || randomUUID(),
    kind: "ssh",
    name: name || address,
    address,
    user,
    port,
  };
}
export function localConnection(host) {
  let c;
  try {
    c = JSON.parse(readFileSync(host.configPath, "utf8"));
  } catch {
    throw new APIError(
      "このマシンのhati設定が見つかりません。ターミナルで hati setup を実行するか、設定ファイルを選択してください。",
      "setup_required",
    );
  }
  const port = Number(c.port);
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !isAbsolute(c.tokenFile ?? "")
  )
    throw new APIError("hatiの接続設定が不正です。");
  let token;
  try {
    token = readFileSync(c.tokenFile, "utf8").trim();
  } catch {
    throw new APIError("hatiのAPI認証情報を読み取れません。");
  }
  if (!/^[a-zA-Z0-9_-]{20,512}$/.test(token))
    throw new APIError("hatiのAPI認証情報が不正です。");
  return { port, token, config: c };
}
export async function request(connection, path, method = "GET", body) {
  validateRoute(path, method);
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${connection.port}${path}`, {
      method,
      redirect: "error",
      headers: {
        authorization: `Bearer ${connection.token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.any([AbortSignal.timeout(method === "GET" ? 22000 : 60000), ...(connection.signal ? [connection.signal] : [])]),
    });
  } catch {
    throw new APIError(
      "接続が途切れました。再接続後に同期してください。送信中の操作は自動再送しません。",
    );
  }
  const text = await response.text();
  if (text.length > 32 * 1024 * 1024)
    throw new APIError("応答が大きすぎます。");
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new APIError("サーバーの応答を読み取れません。");
  }
  if (!response.ok)
    throw new APIError(
      data.error?.message || data.message || "操作を完了できません。",
      data.error?.code || data.code || "api",
      response.status,
    );
  return data;
}
export const sshArgs = (host) => [
  "-o",
  "BatchMode=yes",
  "-o",
  "StrictHostKeyChecking=yes",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=2",
  "-p",
  String(host.port),
  ...(host.user ? ["-l", host.user] : []),
];
export const remoteCLI =
  'if command -v hati >/dev/null 2>&1; then command -v hati; elif [ -x /opt/homebrew/bin/hati ]; then printf %s /opt/homebrew/bin/hati; elif [ -x /usr/local/bin/hati ]; then printf %s /usr/local/bin/hati; elif [ -x "$HOME/.local/bin/hati" ]; then printf %s "$HOME/.local/bin/hati"; else exit 127; fi';
export class Connections {
  constructor(store, { sshOptions = [], execute = exec, launch = spawn } = {}) {
    this.store = store;
    this.sshOptions = sshOptions; this.execute = execute; this.launch = launch;
    this.connections = new Map();
    this.connecting = new Map();
    this.aborters = new Map();
  }
  hosts() {
    if (!this.store.value.hosts)
      this.store.set("hosts", [validateHost({ id: "local", kind: "local" })]);
    return this.store.value.hosts;
  }
  host(id) {
    const host = this.hosts().find((h) => h.id === id);
    if (!host) throw new APIError("マシンが見つかりません。");
    return host;
  }
  saveHost(value) {
    const host = validateHost(value);
    this.close(host.id);
    this.store.set("hosts", [
      ...this.hosts().filter((h) => h.id !== host.id),
      host,
    ]);
    return host;
  }
  async get(id) {
    if (this.closed) throw new APIError("接続を終了しました。");
    if (this.connections.has(id)) return this.connections.get(id);
    if (this.connecting.has(id)) return this.connecting.get(id);
    const controller = new AbortController();
    this.aborters.set(id, controller);
    const work = this.connect(this.host(id), controller.signal).catch(error => {
      controller.abort(); throw error;
    }).finally(() => { if (this.connecting.get(id) === work) this.connecting.delete(id); });
    this.connecting.set(id, work);
    return work;
  }
  async connect(host, signal) {
    let connection;
    if (host.kind === "local") connection = localConnection(host);
    else {
      let result;
      try {
        result = await this.execute(
          "/usr/bin/ssh",
          [
            ...this.sshOptions, ...sshArgs(host),
            host.address,
            `cli=$(${remoteCLI}); "$cli" connection-info --json`,
          ],
          { timeout: 20000, maxBuffer: 100000, signal },
        );
      } catch {
        throw new APIError(
          "SSH接続を確認してください。ターミナルでこのホストへ一度 ssh 接続し、ホスト鍵と公開鍵認証を設定してください。",
          "ssh_connection",
        );
      }
      let bootstrap;
      try {
        bootstrap = JSON.parse(result.stdout.trim());
      } catch {
        throw new APIError(
          "接続先にhatiが見つかりません。接続先で hati setup を実行してください。",
        );
      }
      if (
        !Number.isInteger(bootstrap.port) ||
        bootstrap.port < 1 ||
        bootstrap.port > 65535 ||
        !/^[a-zA-Z0-9_-]{20,512}$/.test(bootstrap.token ?? "")
      )
        throw new APIError("SSH接続情報が不正です。");
      const reserve = createServer();
      await new Promise((resolve, reject) => {
        reserve.once("error", reject);
        reserve.listen(0, "127.0.0.1", resolve);
      });
      const port = reserve.address().port;
      await new Promise((resolve) => reserve.close(resolve));
      signal?.throwIfAborted();
      const tunnel = this.launch(
        "/usr/bin/ssh",
        [
          ...this.sshOptions, ...sshArgs(host),
          "-N",
          "-o",
          "ExitOnForwardFailure=yes",
          "-L",
          `127.0.0.1:${port}:127.0.0.1:${bootstrap.port}`,
          host.address,
        ],
        { stdio: ["ignore", "ignore", "pipe"], signal },
      );
      tunnel.stderr.resume();
      tunnel.on("error", () => {});
      connection = { port, token: bootstrap.token, tunnel, signal };
      tunnel.on("exit", () => {
        if (this.connections.get(host.id) === connection)
          this.connections.delete(host.id);
      });
      let ready = false;
      for (let i = 0; i < 40; i++) {
        if (tunnel.exitCode !== null || signal?.aborted) break;
        try {
          await request(connection, "/v1/health");
          ready = true;
          break;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      if (!ready) {
        tunnel.kill();
        throw new APIError(
          "SSHのポート転送が開始できません。接続先のhatiを確認してください。",
        );
      }
    }
    connection.signal = signal;
    const health = await request(connection, "/v1/health");
    signal?.throwIfAborted();
    connection.serverId = health.serverId;
    connection.capabilities = health.capabilities;
    this.connections.set(host.id, connection);
    return connection;
  }
  async api(id, path, method, body) {
    const connection = await this.get(id);
    try {
      return await request(connection, path, method, body);
    } catch (error) {
      if (!error.status || error.status === 401) this.close(id);
      throw error;
    }
  }
  close(id) {
    this.aborters.get(id)?.abort(); this.aborters.delete(id);
    this.connections.get(id)?.tunnel?.kill();
    this.connections.delete(id);
    this.connecting.delete(id);
  }
  closeAll() {
    this.closed = true;
    for (const id of this.aborters.keys()) this.close(id);
  }
  async terminalCommand(id, target) {
    if (
      !/^%\d+$/.test(target.paneId ?? "") ||
      !/^[a-f0-9]{24}$/.test(target.epoch ?? "") ||
      !Number.isSafeInteger(target.panePid)
    )
      throw new APIError("端末の指定が不正です。");
    await this.api(id, "/v1/workspace/attach", "POST", {
      paneId: target.paneId,
      panePid: target.panePid,
      epoch: target.epoch,
    });
    const host = this.host(id);
    if (host.kind === "ssh")
      return {
        file: "/usr/bin/ssh",
        args: [
          ...this.sshOptions, ...sshArgs(host),
          "-tt",
          host.address,
          `cli=$(${remoteCLI}); exec "$cli" terminal attach --pane ${quote(target.paneId)} --epoch ${quote(target.epoch)} --pid ${target.panePid}`,
        ],
      };
    const { config } = await this.get(id);
    // The same verified tmux pane, without detaching any phone or CLI client.
    return {
      file:
        config.tmux?.bin ||
        ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"].find(
          existsSync,
        ) ||
        "tmux",
      args: [
        "-u",
        ...(config.tmux?.socket ? ["-S", config.tmux.socket] : []),
        "attach-session",
        "-t",
        target.paneId,
      ],
    };
  }
}

export class Mutations {
  constructor(store, connections) {
    this.store = store;
    this.connections = connections;
    this.running = new Set();
  }
  pending() {
    return Object.values(this.store.value.pending || {});
  }
  save(entry) {
    this.store.set("pending", {
      ...this.store.value.pending,
      [entry.body.requestId]: entry,
    });
  }
  remove(id) {
    const entries = { ...this.store.value.pending };
    delete entries[id];
    this.store.set("pending", entries);
  }
  async send(hostId, serverId, path, body) {
    validateRoute(path, "POST");
    if (!/^[0-9a-f-]{36}$/i.test(body.requestId ?? ""))
      throw new APIError("要求IDが不正です。");
    const id = body.requestId;
    if (this.running.has(id)) throw new APIError("この操作は送信中です。");
    const old = this.store.value.pending?.[id];
    if (
      old &&
      (old.hostId !== hostId ||
        old.serverId !== serverId ||
        old.path !== path ||
        JSON.stringify(old.body) !== JSON.stringify(body))
    )
      throw new APIError("要求IDの内容が変わっています。");
    this.running.add(id);
    try {
      const health = await this.connections.api(hostId, "/v1/health");
      if (health.serverId !== serverId)
        throw new APIError(
          "接続先のデータが変更されました。再同期してから送信してください。",
          "server_changed",
          409,
        );
      const entry = {
        hostId,
        serverId,
        path,
        body,
        createdAt: old?.createdAt ?? Date.now(),
        status: "dispatching",
      };
      this.save(entry);
      try {
        const receipt = await this.connections.api(hostId, path, "POST", body);
        if (["accepted", "rejected", "abandoned"].includes(receipt.status))
          this.remove(id);
        else this.save({ ...entry, status: receipt.status || "unknown" });
        return receipt;
      } catch (error) {
        if (error.status >= 400 && error.status < 500) this.remove(id);
        else this.save({ ...entry, status: "unknown" });
        throw error;
      }
    } finally {
      this.running.delete(id);
    }
  }
  async reconcile(id) {
    const entry = this.store.value.pending?.[id];
    if (!entry) return null;
    const health = await this.connections.api(entry.hostId, "/v1/health");
    if (health.serverId !== entry.serverId)
      throw new APIError(
        "接続先のIDが変わっています。元の接続先で結果を確認してください。",
      );
    try {
      let receipt = await this.connections.api(
        entry.hostId,
        "/v1/requests/" + encodeURIComponent(id),
      );
      if (receipt.kind === "tab:close" && ["unknown", "dispatching"].includes(receipt.status))
        receipt = await this.connections.api(entry.hostId, "/v1/requests/" + encodeURIComponent(id) + "/reconcile", "POST", {});
      if (["accepted", "rejected", "abandoned"].includes(receipt.status))
        this.remove(id);
      else this.save({ ...entry, status: receipt.status });
      return receipt;
    } catch (error) {
      if (error.status !== 404) throw error;
      this.save({ ...entry, status: "not_received" });
      return { id, status: "not_received" };
    }
  }
}
