import { readFileSync, writeFileSync, renameSync, mkdirSync, realpathSync, existsSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { HerdrRPC, herdrSettingsPath } from "./herdr.mjs";

const begin = "# >>> xroam agents (xroam herdr disable で元に戻す)";
const end = "# <<< xroam agents";
export const HERDR_ROWS = `${begin}
[ui.sidebar.agents]
row_gap = 0
rows = [
  ["state_icon", "$xroam_state", "$xroam_elapsed"],
  ["agent", { token = "$xroam_host", dim = true }],
  [{ token = "workspace", bold = true }],
  ["$xroam_tab"],
  ["$xroam_query1"],
  ["$xroam_query2"],
]
${end}
`;

function sections(text) {
  const matches = [...text.matchAll(/^[ \t]*(\[\[?)([^\]\n]+)\]\]?[ \t]*(?:#[^\n]*)?\r?\n/gm)];
  return matches.map((m, i) => ({ name: (m[1] === "[[" ? "@" : "") + m[2].trim(), start: m.index, end: matches[i + 1]?.index ?? text.length }));
}
function setKey(text, section, key, line) {
  const table = sections(text).find((s) => s.name === section);
  if (!table) return { text: `${text.trimEnd()}\n\n[${section}]\n${line}\n`, old: null, created: true };
  const body = text.slice(table.start, table.end), pattern = new RegExp(`^[ \\t]*${key}[ \\t]*=[^\\n]*(?:\\n|$)`, "m");
  const match = body.match(pattern);
  if (match) return { text: text.slice(0, table.start) + body.replace(pattern, line ? line + "\n" : "") + text.slice(table.end), old: match[0].replace(/\n$/, ""), created: false };
  const at = text.indexOf("\n", table.start) + 1;
  return { text: text.slice(0, at) + (line ? line + "\n" : "") + text.slice(at), old: null, created: false };
}

export function installHerdrConfig(before) {
  if (before.includes(begin)) throw new Error("xroamの表示設定がすでにあります。xroam herdr disable で解除してください。");
  // Preserve complete agent tables, including per-agent row overrides, for uninstall.
  const removed = sections(before).filter((s) => s.name === "ui.sidebar.agents" || s.name.startsWith("ui.sidebar.agents."));
  let text = before;
  for (const s of removed.toReversed()) text = text.slice(0, s.start) + text.slice(s.end);
  const keys = [];
  for (const [section, key, value] of [["ui", "sidebar_max_width", "40"], ["theme.custom", "yellow", '"#FF9500"']]) {
    const line = `${key} = ${value} # xroam agents`;
    const change = setKey(text, section, key, line); text = change.text;
    keys.push({ section, key, line, old: change.old, created: change.created });
  }
  const installed = text.trimEnd() + "\n\n" + HERDR_ROWS;
  return { before, installed, keys, removed: removed.map((s) => before.slice(s.start, s.end)) };
}

export function restoreHerdrConfig(current, receipt) {
  if (current === receipt.installed) return receipt.before;
  const start = current.indexOf(begin), finish = current.indexOf(end, start);
  if (start < 0 || finish < 0 || current.slice(start, finish + end.length).trim() !== HERDR_ROWS.trim())
    throw new Error("xroamの表示設定が手動変更されています。herdr-install.json のバックアップと設定を確認してください。");
  let text = current.slice(0, start) + current.slice(finish + end.length).replace(/^\r?\n/, "");
  for (const change of receipt.keys) {
    const table = sections(text).find((s) => s.name === change.section);
    if (table && text.slice(table.start, table.end).split("\n").includes(change.line)) {
      text = setKey(text, change.section, change.key, change.old ?? "").text;
      if (change.created) {
        const empty = sections(text).find((s) => s.name === change.section);
        if (empty && text.slice(empty.start, empty.end).replace(/^\s*\[[^\n]+\]\s*/, "").trim() === "") text = text.slice(0, empty.start) + text.slice(empty.end);
      }
    }
  }
  return text.trimEnd() + "\n" + (receipt.removed.length ? "\n" + receipt.removed.join("\n") : "");
}

function atomicWrite(path, text) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Follow the existing config symlink, then atomically replace its target.
  const target = existsSync(path) ? realpathSync(path) : path;
  const temporary = `${target}.xroam-${randomUUID()}`;
  try { writeFileSync(temporary, text, { mode: 0o600, flag: "wx" }); renameSync(temporary, target); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
const writeJSON = (path, value) => atomicWrite(path, JSON.stringify(value, null, 2) + "\n");

async function reloadConfig(rpc) {
  const result = await rpc.call("server.reload_config");
  // The installed protocol calls this report; keep failed/partial reloads reviewable.
  const report = result.report ?? result;
  if (report.status !== "applied") throw new Error("Herdrが設定の一部を適用できませんでした。設定を復元しました。");
  return result;
}

export async function enableHerdr(config, options = {}) {
  const receiptPath = join(config.dataDir, "herdr-install.json");
  if (existsSync(receiptPath)) {
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    if (readFileSync(receipt.configPath, "utf8").includes(begin)) {
      writeJSON(herdrSettingsPath(config), { enabled: true, ...receipt.settings });
      return { configPath: receipt.configPath, alreadyInstalled: true };
    }
    throw new Error("前回のHerdr設定バックアップがあります。xroam herdr disable で状態を確認してください。");
  }
  const configPath = resolve(options.configPath || process.env.HERDR_CONFIG_PATH || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "herdr/config.toml"));
  const settings = { socketPath: resolve(options.socketPath || process.env.HERDR_SOCKET_PATH || join(dirname(configPath), "herdr.sock")), hostName: options.hostName || null };
  const rpc = new HerdrRPC(settings.socketPath);
  try {
    const { snapshot } = await rpc.call("session.snapshot");
    if (snapshot.protocol < 17) throw new Error("Herdr 0.7.5以降が必要です。");
    const before = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
    const receipt = { ...installHerdrConfig(before), configPath, settings };
    writeJSON(receiptPath, receipt);
    try {
      atomicWrite(configPath, receipt.installed);
      await reloadConfig(rpc);
      writeJSON(herdrSettingsPath(config), { enabled: true, ...settings });
    } catch (error) {
      atomicWrite(configPath, before); await reloadConfig(rpc).catch(() => {}); unlinkSync(receiptPath); throw error;
    }
    return { configPath, alreadyInstalled: false };
  } finally { rpc.close(); }
}

export async function disableHerdr(config) {
  const receiptPath = join(config.dataDir, "herdr-install.json");
  if (!existsSync(receiptPath)) { writeJSON(herdrSettingsPath(config), { enabled: false }); return; }
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  const current = readFileSync(receipt.configPath, "utf8"), restored = restoreHerdrConfig(current, receipt);
  writeJSON(herdrSettingsPath(config), { enabled: false, ...receipt.settings });
  atomicWrite(receipt.configPath, restored);
  const rpc = new HerdrRPC(receipt.settings.socketPath);
  try { await reloadConfig(rpc); }
  catch (error) { if (!["ENOENT", "ECONNREFUSED"].includes(error.code)) {
    atomicWrite(receipt.configPath, current); writeJSON(herdrSettingsPath(config), { enabled: true, ...receipt.settings }); throw error;
  } }
  finally { rpc.close(); }
  unlinkSync(receiptPath);
}
