// Short-lived, QR-pinned TLS enrollment. The daemon API stays on loopback.
import { createServer } from "node:tls";
import { randomBytes, randomUUID, createHash, timingSafeEqual, X509Certificate } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, fstatSync, fsyncSync, constants, lstatSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir, homedir, hostname, userInfo } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { isIP } from "node:net";
import QRCode from "qrcode";
import { check } from "./config.mjs";

export const PAIR_TTL = 300_000;
export const digest = (data) => createHash("sha256").update(data).digest("base64").replace(/=+$/, "");
export function isTailnetIPv4(address) {
  const p = address.split(".").map(Number);
  return isIP(address) === 4 && p[0] === 100 && p[1] >= 64 && p[1] <= 127;
}
export function tailnetAddress() {
  const r = spawnSync("tailscale", ["status", "--json"], { encoding: "utf8", timeout: 5000 });
  let s;
  try { s = JSON.parse(r.stdout); } catch {}
  const address = s?.Self?.TailscaleIPs?.find(isTailnetIPv4);
  check(s?.BackendState === "Running" && address, "tailscale", "Tailscaleを接続してから xroam pair を実行してください。");
  return address;
}
export function hostFingerprints() {
  const values = [];
  for (const type of ["ed25519", "rsa", "ecdsa"]) {
    try {
      const key = readFileSync(`/etc/ssh/ssh_host_${type}_key.pub`, "utf8").trim().split(/\s+/)[1];
      values.push("SHA256:" + digest(Buffer.from(key, "base64")));
    } catch {}
  }
  check(values.length, "host_keys", "SSHホスト公開鍵を読めません。OpenSSH / リモートログインを有効にしてください。");
  return values;
}
function uuid(s) { return typeof s === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(s); }
export function validatePublicKey(key) {
  check(typeof key === "string" && /^ssh-ed25519 [A-Za-z0-9+/]{68}$/.test(key), "public_key", "Ed25519公開鍵が不正です。");
  const blob = Buffer.from(key.split(" ")[1], "base64");
  check(blob.length === 51 && blob.readUInt32BE(0) === 11 && blob.subarray(4, 15).toString() === "ssh-ed25519" && blob.readUInt32BE(15) === 32,
    "public_key", "公開鍵の形式が一致しません。");
  return key;
}
// Append only. Never rewrite, relax permissions, follow symlinks or remove the
// user's existing SSH keys/options. A lock coordinates simultaneous xroam pairers.
export function installPublicKey(sshDirectory, key, requestId) {
  validatePublicKey(key);
  check(uuid(requestId), "request", "要求IDが不正です。");
  mkdirSync(sshDirectory, { recursive: true, mode: 0o700 });
  const ds = lstatSync(sshDirectory);
  check(ds.isDirectory() && !ds.isSymbolicLink() && ds.uid === process.getuid() && !(ds.mode & 0o022), "ssh_directory", ".sshの所有者と書き込み権限を確認してください。");
  const lock = join(sshDirectory, ".xroam-pair.lock");
  let lockFD;
  try { lockFD = openSync(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
  catch { throw new Error("別の登録処理が実行中です。.ssh/.xroam-pair.lockが残っている場合は、登録処理終了後に確認してください。"); }
  try {
    const file = join(sshDirectory, "authorized_keys");
    const fd = openSync(file, constants.O_CREAT | constants.O_APPEND | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    try {
      const stat = fstatSync(fd);
      check(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid() && !(stat.mode & 0o022) && stat.size < 1024 * 1024,
        "authorized_keys", "authorized_keysの種類・所有者・権限を確認してください。");
      const before = readFileSync(fd, "utf8");
      const line = `${key} xroam:${requestId.toLowerCase()}`;
      const existing = before.split("\n").filter((s) => s.endsWith(` xroam:${requestId.toLowerCase()}`));
      check(!existing.length || (existing.length === 1 && existing[0] === line), "conflict", "同じ要求IDに異なる鍵が登録されています。");
      if (!existing.length) {
        writeFileSync(fd, (before && !before.endsWith("\n") ? "\n" : "") + line + "\n");
        fsyncSync(fd);
      }
    } finally { closeSync(fd); }
  } finally { closeSync(lockFD); unlinkSync(lock); }
}
export function ephemeralCertificate() {
  const dir = mkdtempSync(join(tmpdir(), "xroam-pair-tls-"));
  const keyFile = join(dir, "key.pem"), certFile = join(dir, "cert.pem");
  try {
    const r = spawnSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "1", "-subj", "/CN=xroam-Pairing", "-keyout", keyFile, "-out", certFile], { stdio: "ignore", timeout: 15000 });
    check(r.status === 0, "tls", "登録用TLS証明書を作れません。OpenSSLを確認してください。");
    const cert = readFileSync(certFile), key = readFileSync(keyFile);
    return { cert, key, fingerprint: digest(new X509Certificate(cert).raw) };
  } finally {
    for (const f of [keyFile, certFile]) { try { unlinkSync(f); } catch {} }
    rmdirSync(dir);
  }
}
export async function createPairing({ address, fingerprints, port = 0, sshPort = 22, name = hostname(), username = userInfo().username,
  sshDirectory = join(homedir(), ".ssh"), ttl = PAIR_TTL, clock = Date.now, loopbackTest = false, certificate = ephemeralCertificate() } = {}) {
  check(isTailnetIPv4(address) || (loopbackTest && address === "127.0.0.1"), "address", "登録窓口はTailscale IPv4だけに公開できます。");
  check(Number.isInteger(sshPort) && sshPort > 0 && sshPort <= 65535, "port", "SSHポートが不正です。");
  check(fingerprints?.length && fingerprints.every((s) => /^SHA256:[A-Za-z0-9+/]{43}$/.test(s)), "host_keys", "ホスト鍵を確認できません。");
  const token = randomBytes(32).toString("base64url"), id = randomUUID();
  const expires = clock() + ttl;
  let claim, closed = false, resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  const sockets = new Set();
  let timer;
  const close = (reason = "cancelled") => {
    if (closed) return;
    closed = true; clearTimeout(timer); server.close();
    for (const socket of sockets) socket.destroy();
    resolveDone(reason);
  };
  const handle = (request) => {
    check(clock() < expires && !closed, "expired", "QRの有効期限が切れました。PCで xroam pair をやり直してください。");
    const incoming = typeof request.token === "string" ? Buffer.from(request.token) : Buffer.alloc(0);
    check(request.v === 1 && request.id === id && incoming.length === token.length && timingSafeEqual(incoming, Buffer.from(token)), "unauthorized", "登録券を確認できません。");
    check(uuid(request.requestId), "request", "要求IDが不正です。");
    const key = validatePublicKey(request.publicKey);
    check(!claim || (claim.requestId === request.requestId && claim.key === key), "claimed", "このQRは別の端末に使用済みです。");
    if (request.action === "register") {
      if (!claim) {
        installPublicKey(sshDirectory, key, request.requestId);
        claim = { requestId: request.requestId, key };
      }
      return { v: 1, status: "accepted", requestId: request.requestId };
    }
    check(request.action === "finish" && claim, "action", "登録状態が一致しません。");
    return { v: 1, status: "finished", requestId: request.requestId };
  };
  const server = createServer({ key: certificate.key, cert: certificate.cert, minVersion: "TLSv1.2", handshakeTimeout: 5000 }, (socket) => {
    let bytes = Buffer.alloc(0), responded = false;
    socket.setTimeout(7000, () => socket.destroy());
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      if (responded) return;
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > 4096) { responded = true; socket.destroy(); return; }
      const end = bytes.indexOf(10);
      if (end < 0) return;
      responded = true;
      let response;
      try { response = handle(JSON.parse(bytes.subarray(0, end).toString("utf8"))); }
      catch (e) { response = { v: 1, status: "rejected", code: e.code ?? "registration", message: e.code ? e.message : "SSH鍵を登録できません。PC側の権限と登録処理を確認してください。" }; }
      socket.end(JSON.stringify(response) + "\n", () => { if (response.status === "finished") close("paired"); });
    });
  });
  server.maxConnections = 8;
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); s.on("error", () => {}); });
  server.on("tlsClientError", () => {});
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, address, resolve); });
  server.on("error", () => close("error"));
  timer = setTimeout(() => close(claim ? "registered" : "expired"), Math.max(1, expires - clock()));
  // Compact payload keeps the QR readable. It is a credential: never log its URI.
  const invitation = { v: 1, id, h: address, p: server.address().port, s: sshPort, u: username, n: name.slice(0, 64), k: fingerprints, c: certificate.fingerprint, t: token, e: expires };
  const qr = "xroam://pair/" + Buffer.from(JSON.stringify(invitation)).toString("base64url");
  return { invitation, qr, done, close, address: server.address() };
}
export async function pairCommand({ sshPort = 22, noOpen = false } = {}) {
  const pairing = await createPairing({ address: tailnetAddress(), fingerprints: hostFingerprints(), sshPort });
  const dir = mkdtempSync(join(tmpdir(), "xroam-pair-qr-"));
  const file = join(dir, "pair.html");
  const stop = () => pairing.close();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    const svg = await QRCode.toString(pairing.qr, { type: "svg", errorCorrectionLevel: "M", margin: 4 });
    writeFileSync(file, `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><title>xroam · iPhoneを接続</title><style>body{margin:32px;background:#191a24;color:#eee;font:18px system-ui;text-align:center}svg{width:min(72vh,90vw);height:auto;max-width:680px;background:white}p{color:#b8bed0}</style><h1>xroam · iPhoneを接続</h1><p>iPhoneのxroamで「QRで接続」を開いて読み取ってください。</p><main>${svg}</main><p>5分間・1台限り。QRは共有しないでください。<br>このPCのターミナルを閉じると登録を終了します。</p><script>setTimeout(()=>{document.querySelector('main').textContent='有効期限が切れました。PCで xroam pair を実行してください。'},${Math.max(1, pairing.invitation.e - Date.now())})</script></html>`, { mode: 0o600 });
    console.log("iPhoneのxroamで「QRで接続」を開いてください。5分間・1台限り。Ctrl+Cで中止します。");
    // Screen output can use less damage recovery to reduce the module count.
    console.log(await QRCode.toString(pairing.qr, { type: "terminal", small: true, errorCorrectionLevel: "L", margin: 2 }));
    if (process.platform === "darwin" && !noOpen) spawnSync("open", [file], { stdio: "ignore" });
    const result = await pairing.done;
    console.log(result === "paired" ? "✓ iPhoneの登録とSSH接続が完了しました。" : result === "registered" ? "SSH鍵は登録済みです。iPhoneで接続を再試行してください。" : "登録窓口を閉じました。再試行: xroam pair");
  } finally {
    pairing.close(); process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
    try { unlinkSync(file); } catch {} rmdirSync(dir);
  }
}
