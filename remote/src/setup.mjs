import { homedir, hostname, userInfo } from "node:os";
import { dirname, join, resolve, isAbsolute, basename } from "node:path";
import { fileURLToPath } from "node:url";
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  chmodSync,
  realpathSync,
  statSync,
} from "node:fs";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { check, loadConfig } from "./config.mjs";
import { verifyCodex } from "./codex.mjs";

export const appRoot =
  process.env.NOCK_APP_ROOT ||
  resolve(dirname(fileURLToPath(import.meta.url)), "..");
export function locations(root = process.env.NOCK_HOME) {
  if (root)
    check(
      isAbsolute(root),
      "setup_path",
      "NOCK_HOMEは絶対パスで指定してください。",
    );
  const configDir = root
    ? join(root, "config")
    : join(homedir(), ".config/nock");
  return {
    configDir,
    configFile: join(configDir, "config.json"),
    dataDir: root ? join(root, "data") : join(homedir(), ".local/share/nock"),
    workspace: root ? join(root, "projects") : join(homedir(), "NockProjects"),
  };
}
export function writeConfig(path, config) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  renameSync(temporary, path);
}
export function ensureSetup({
  root,
  project,
  port = 46211,
  codexBin = join(appRoot, "node_modules/.bin/codex"),
} = {}) {
  const paths = locations(root);
  for (const path of [paths.configDir, paths.dataDir]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
  }
  if (existsSync(paths.configFile)) {
    // Never replace credentials, APNs settings or existing project choices.
    const existing = loadConfig(paths.configFile);
    return { paths, config: existing, created: false };
  }
  check(
    Number.isInteger(port) && port > 1024 && port < 65536,
    "port",
    "ポートを確認してください。",
  );
  if (!project) mkdirSync(paths.workspace, { recursive: true, mode: 0o700 });
  const path = realpathSync(project ? resolve(project) : paths.workspace);
  check(
    statSync(path).isDirectory(),
    "project",
    "プロジェクトのディレクトリが必要です。",
  );
  const tokenFile = join(paths.configDir, "api-token");
  // Preserve a token left by an interrupted setup instead of rotating it.
  if (!existsSync(tokenFile))
    writeFileSync(tokenFile, randomBytes(32).toString("base64url") + "\n", {
      mode: 0o600,
      flag: "wx",
    });
  const config = {
    port,
    dataDir: paths.dataDir,
    tokenFile,
    codexBin,
    projects: [{ id: "main", name: basename(path), path }],
    apns: {
      enabled: false,
      teamId: "",
      keyId: "",
      bundleId: "com.deep.nock",
      keyFile: join(paths.configDir, "AuthKey.p8"),
    },
  };
  writeConfig(paths.configFile, config);
  return { paths, config: loadConfig(paths.configFile), created: true };
}
export function addProject(configFile, path, name) {
  const canonical = realpathSync(resolve(path));
  check(
    statSync(canonical).isDirectory(),
    "project",
    "ディレクトリを指定してください。",
  );
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  if (!config.projects.some((p) => p.path === canonical)) {
    config.projects.push({
      id:
        "p-" +
        createHash("sha256").update(canonical).digest("hex").slice(0, 12),
      name: name || basename(canonical),
      path: canonical,
    });
    writeConfig(configFile, config);
  }
  return config;
}
const xml = (s) =>
  String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
const systemdQuote = (s) =>
  '"' +
  String(s)
    .replaceAll("%", "%%")
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"') +
  '"';
export function serviceDefinition({
  platform = process.platform,
  node = process.env.NOCK_NODE_BIN || process.execPath,
  main = join(appRoot, "src/cli.mjs"),
  configFile,
  dataDir,
  path = process.env.PATH || "/usr/bin:/bin",
}) {
  const args = [node, main, "run", "--config", configFile];
  if (platform === "darwin")
    return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>com.deep.nock.daemon</string><key>ProgramArguments</key><array>${args.map((a) => `<string>${xml(a)}</string>`).join("")}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>5</integer><key>Umask</key><integer>63</integer><key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(path)}</string></dict><key>StandardOutPath</key><string>${xml(join(dataDir, "service.log"))}</string><key>StandardErrorPath</key><string>${xml(join(dataDir, "service.log"))}</string></dict></plist>\n`;
  check(platform === "linux", "platform", "macOS / Linuxに対応しています。");
  return `[Unit]\nDescription=Nock personal Codex controller\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart=${args.map(systemdQuote).join(" ")}\nEnvironment=${systemdQuote("PATH=" + path)}\nRestart=on-failure\nRestartSec=5\nKillMode=control-group\nTimeoutStopSec=15\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
}
function manager(command, args, required = true) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 20000 });
  if (required && result.status !== 0)
    throw new Error(
      `${command}による常駐設定に失敗しました。nock doctor で確認してください。`,
    );
  return result.status === 0;
}
export async function daemonHealth(config) {
  try {
    const response = await fetch(`http://127.0.0.1:${config.port}/v1/health`, {
      headers: { authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(1500),
    });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}
export async function reloadProjects(config) {
  if (!(await daemonHealth(config))) return false;
  const response = await fetch(
    `http://127.0.0.1:${config.port}/v1/projects/reload`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.token}`,
        "content-type": "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(5000),
    },
  );
  check(
    response.ok,
    "reload",
    "追加内容は保存しましたが反映できませんでした。作業終了後にnock restartを実行してください。",
  );
  return true;
}
export async function startService(paths, config) {
  check(
    !process.env.NOCK_HOME,
    "test_root",
    "NOCK_HOME指定時はOSの常駐登録を行いません。runを直接実行してください。",
  );
  if (await daemonHealth(config)) return { alreadyRunning: true };
  check(
    !(await tcpAvailable(config.port)),
    "port_in_use",
    "APIポートが別のプロセスに使用されています。既存プロセスは停止していません。nock doctorで設定を確認してください。",
  );
  verifyCodex(config.codexBin);
  const definition = serviceDefinition({
    configFile: paths.configFile,
    dataDir: paths.dataDir,
  });
  if (process.platform === "darwin") {
    const dir = join(homedir(), "Library/LaunchAgents"),
      file = join(dir, "com.deep.nock.daemon.plist");
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, definition, { mode: 0o600 });
    const target = `gui/${process.getuid()}`;
    manager("launchctl", ["bootout", `${target}/com.deep.nock.daemon`], false);
    manager("launchctl", ["bootstrap", target, file]);
  } else {
    const dir = join(homedir(), ".config/systemd/user");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "nock.service"), definition, { mode: 0o600 });
    manager("systemctl", ["--user", "daemon-reload"]);
    manager("systemctl", ["--user", "enable", "--now", "nock.service"]);
    if (
      !manager(
        "loginctl",
        ["--no-ask-password", "enable-linger", userInfo().username],
        false,
      )
    )
      console.log(
        "ログアウト後も継続するには一度だけ: loginctl enable-linger " +
          userInfo().username,
      );
  }
  for (let i = 0; i < 30; i++) {
    if (await daemonHealth(config)) return { alreadyRunning: false };
    await delay(300);
  }
  throw new Error(
    "常駐の起動を確認できません。nock doctor とサービスログを確認してください。",
  );
}
export function stopService() {
  check(
    !process.env.NOCK_HOME,
    "test_root",
    "NOCK_HOME指定時はOSの常駐登録を変更しません。",
  );
  if (process.platform === "darwin")
    manager(
      "launchctl",
      ["bootout", `gui/${process.getuid()}/com.deep.nock.daemon`],
      false,
    );
  else manager("systemctl", ["--user", "disable", "--now", "nock.service"]);
}
async function tcpAvailable(port = 22) {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(1000, () => done(false));
  });
}
export async function diagnostics(paths, config) {
  let codexVersion = false;
  try {
    verifyCodex(config.codexBin);
    codexVersion = true;
  } catch {}
  const login =
    spawnSync(config.codexBin, ["login", "status"], {
      encoding: "utf8",
      timeout: 10000,
    }).status === 0;
  let address = hostname(),
    tailscale = false;
  const result = spawnSync("tailscale", ["status", "--json"], {
    encoding: "utf8",
    timeout: 5000,
  });
  try {
    const value = JSON.parse(result.stdout);
    tailscale = value.BackendState === "Running";
    address =
      value.Self?.DNSName?.replace(/\.$/, "") ||
      value.Self?.TailscaleIPs?.[0] ||
      address;
  } catch {}
  const running = !!(await daemonHealth(config));
  let notifications = false;
  if (running) {
    try {
      const response = await fetch(
        `http://127.0.0.1:${config.port}/v1/notifications`,
        {
          headers: { authorization: `Bearer ${config.token}` },
          signal: AbortSignal.timeout(1500),
        },
      );
      notifications =
        response.ok && (await response.json()).configured === true;
    } catch {}
  }
  return {
    running,
    codexVersion,
    loggedIn: login,
    ssh: await tcpAvailable(),
    tailscale,
    address,
    username: userInfo().username,
    port: config.port,
    configFile: paths.configFile,
    projects: config.projects.map((p) => ({ name: p.name, path: p.path })),
    notifications,
  };
}
