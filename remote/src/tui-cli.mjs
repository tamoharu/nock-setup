import { existsSync, mkdirSync, openSync, closeSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { JsonStore } from "./client-storage.mjs";
import { validateHost } from "./client-transport.mjs";
import { TuiBackend } from "./tui-backend.mjs";
import { locations } from "./setup.mjs";

export const cliStatePath = () => join(process.env.HATI_CLI_HOME || join(homedir(), ".local/share/hati-cli"), "state.json");
const option = (args, name) => { const i = args.indexOf(name); if (i < 0) return undefined;
  if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`${name} の値を指定してください。`); return args[i + 1]; };
export function machineCommand(args, store) {
  const action = args[0] ?? "list";
  if (action === "list") {
    const hosts = store.value.hosts || [];
    return args.includes("--json") ? JSON.stringify(hosts) : hosts.map(h => `${h.id}\t${h.name}\t${h.kind === "local" ? "local" : `${h.user ? h.user + "@" : ""}${h.address}:${h.port}`}`).join("\n") || "接続先がありません。hati machine add NAME USER@HOST";
  }
  if (action === "add") {
    const name = args[1];
    if (!name || name.startsWith("--")) throw new Error("hati machine add NAME USER@HOST [--port 22] または NAME --local [--config PATH]");
    if ((store.value.hosts || []).some(h => h.name === name)) throw new Error("同じ名前のマシンが登録済みです。");
    let value;
    if (args.includes("--local")) value = { kind: "local", name, configPath: resolve(option(args, "--config") || locations().configFile) };
    else {
      const address = args[2] || "", parts = address.split("@");
      if (parts.length > 2 || address.startsWith("--")) throw new Error("SSH接続先を USER@HOST またはSSH configのHost名で指定してください。");
      value = { kind: "ssh", name, address: parts.at(-1), user: parts.length === 2 ? parts[0] : "", port: Number(option(args, "--port") || 22) };
    }
    const host = validateHost(value);
    store.set("hosts", [...(store.value.hosts || []), host]); return `${host.name} を登録しました。hati tui で接続できます。`;
  }
  if (action === "remove") {
    const target = (store.value.hosts || []).find(h => h.id === args[1] || h.name === args[1]);
    if (!target) throw new Error("マシンが見つかりません。");
    if (Object.values(store.value.pending || {}).some(p => p.hostId === target.id)) throw new Error("未確認の操作があります。CLIで結果を確認してから登録を削除してください。");
    store.value.hosts = store.value.hosts.filter(h => h.id !== target.id);
    delete store.value.cache?.[target.id]; store.flush(); return `${target.name} のCLI接続登録を削除しました。`;
  }
  throw new Error("hati machine add / list / remove");
}
// One writer per device-local store. A stale lock is recoverable without
// touching any daemon or terminal. No silent state-file overwrite on contention.
export function lockState(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lock = path + ".lock";
  let fd;
  try { fd = openSync(lock, "wx", 0o600); }
  catch { throw new Error(`CLIの保存データは使用中です。開いているCLIを終了してください。異常終了後はプロセスが停止したことを確認して ${lock} を削除してください。`); }
  return () => { closeSync(fd); unlinkSync(lock); };
}
export async function tuiCommand(command, args) {
  const path = cliStatePath();
  if (command === "machine" && (args[0] === "list" || !args[0])) { console.log(machineCommand(args, new JsonStore(path))); return; }
  const unlock = lockState(path);
  try {
    const store = new JsonStore(path);
    if (command === "machine") { console.log(machineCommand(args, store)); return; }
    if (!store.value.hosts) {
      const configPath = option(args, "--config") || locations().configFile;
      store.set("hosts", existsSync(configPath) ? [validateHost({ id: "local", kind: "local", configPath: resolve(configPath) })] : []);
    }
    if (args.includes("--json")) {
      const backend = new TuiBackend(store);
      try { await backend.refresh(); console.log(JSON.stringify(backend.snapshot())); } finally { backend.close(); }
      return;
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("対話ターミナルで hati tui を実行してください。状態のJSON表示は --json です。");
    const here = dirname(fileURLToPath(import.meta.url));
    const binary = [process.env.HATI_TUI_BIN, join(here, "../bin/hati-tui"), join(here, "../../cli/target/release/hati-tui"), join(here, "../../cli/target/debug/hati-tui")].find(p => p && existsSync(p));
    if (!binary) throw new Error("TUIが未ビルドです。リポジトリの cli で cargo build --release を実行してください。");
    const child = spawn(binary, ["--backend", process.execPath, "--script", join(here, "tui-backend.mjs"), "--state", path], { stdio: "inherit" });
    process.exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", code => resolve(code ?? 1)); });
  } finally { unlock(); }
}
