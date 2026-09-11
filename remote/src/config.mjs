import { readFileSync, statSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, resolve, relative, join, sep } from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";

export const CODEX_VERSION = "0.153.4";
export class Fault extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export function check(ok, code, message, status = 400) {
  if (!ok) throw new Fault(status, code, message);
}
export function secretFile(path) {
  const stat = statSync(path);
  check(
    stat.isFile() &&
      (stat.mode & 0o077) === 0 &&
      stat.uid === process.getuid?.(),
    "secret_permissions",
    "秘密ファイルは実行ユーザー所有の600で保存してください。",
  );
  return readFileSync(path, "utf8").trim();
}
export function loadConfig(path) {
  const c = JSON.parse(readFileSync(path, "utf8"));
  c.configFile = resolve(path);
  for (const key of ["dataDir", "tokenFile", "codexBin"])
    check(isAbsolute(c[key] ?? ""), "config", `${key} は絶対パスが必要です。`);
  check(
    Number.isInteger(c.port) && c.port > 1024 && c.port < 65536,
    "config",
    "ポートが不正です。",
  );
  mkdirSync(c.dataDir, { recursive: true, mode: 0o700 });
  check(
    (statSync(c.dataDir).mode & 0o077) === 0,
    "data_permissions",
    "データディレクトリは700にしてください。",
  );
  c.token = secretFile(c.tokenFile);
  check(
    c.token.length >= 43,
    "config",
    "APIトークンには32バイト以上の乱数が必要です。",
  );
  check(
    Array.isArray(c.projects) && c.projects.length > 0,
    "config",
    "プロジェクトを1つ以上指定してください。",
  );
  const ids = new Set();
  for (const p of c.projects) {
    check(
      /^[a-zA-Z0-9_-]{1,64}$/.test(p.id) && !ids.has(p.id),
      "config",
      "プロジェクトIDが不正または重複しています。",
    );
    ids.add(p.id);
    check(
      isAbsolute(p.path),
      "config",
      "プロジェクトは絶対パスで指定してください。",
    );
    p.path = realpathSync(p.path);
    check(
      statSync(p.path).isDirectory() && typeof p.name === "string",
      "config",
      "プロジェクトの設定が不正です。",
    );
  }
  c.database = resolve(c.dataDir, "hati.sqlite");
  check(c.directoryMigrations === undefined || Array.isArray(c.directoryMigrations), "config", "directoryMigrations は配列で指定してください。");
  c.directoryMigrations = (c.directoryMigrations ?? []).map((entry) => {
    check(entry && typeof entry.from === "string" && typeof entry.to === "string" && isAbsolute(entry.from) && isAbsolute(entry.to), "config", "移行元・移行先には絶対パスが必要です。");
    const from = resolve(entry.from), to = realpathSync(entry.to);
    check(from !== to && statSync(to).isDirectory(), "config", "移行先のディレクトリを確認してください。");
    return { from, to };
  });
  check(new Set(c.directoryMigrations.map((m) => m.from)).size === c.directoryMigrations.length &&
    !c.directoryMigrations.some((m) => c.directoryMigrations.some((n) => within(n.from, m.to) !== null)),
    "config", "ディレクトリ移行の重複・連鎖は指定できません。");
  return c;
}

function within(root, path) {
  const suffix = relative(root, path);
  return suffix === ".." || suffix.startsWith(".." + sep) || isAbsolute(suffix) ? null : suffix;
}
// A moved project's existing rollouts keep their original cwd. Resolve only
// explicitly configured moves, without rewriting messages or Codex's indexes.
export function migratedDirectory(config, directory) {
  if (typeof directory !== "string") return directory;
  for (const move of [...(config.directoryMigrations ?? [])].sort((a, b) => b.from.length - a.from.length)) {
    const suffix = within(move.from, directory);
    if (suffix !== null) return join(move.to, suffix);
  }
  return directory;
}
export function historyDirectories(config, directory) {
  const current = migratedDirectory(config, directory), paths = [current];
  for (const move of config.directoryMigrations ?? []) {
    const suffix = within(move.to, current);
    if (suffix !== null) {
      const previous = join(move.from, suffix);
      if (migratedDirectory(config, previous) === current) paths.push(previous);
    }
  }
  const unique = [...new Set(paths)];
  return unique.length === 1 ? unique[0] : unique;
}
export function migrationCwd(config, directory) {
  return Array.isArray(historyDirectories(config, directory)) ? { cwd: migratedDirectory(config, directory) } : {};
}
export function authenticate(header, token) {
  const hash = (s) => createHash("sha256").update(s).digest();
  return (
    typeof header === "string" &&
    timingSafeEqual(hash(header), hash(`Bearer ${token}`))
  );
}
export function requestID(id) {
  check(
    typeof id === "string" && /^[a-zA-Z0-9-]{16,80}$/.test(id),
    "request_id",
    "要求IDが不正です。",
  );
  return id;
}
export function textInput(s, max = 100000) {
  check(
    typeof s === "string" && s.trim().length > 0 && s.length <= max,
    "text",
    "入力が空、または長すぎます。",
  );
  return s;
}
export const now = () => Date.now();
export const json = (value) => JSON.stringify(value);
