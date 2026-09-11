#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Tmux } from "./tmux.mjs";
import {
  ensureSetup,
  locations,
  addProject,
  startService,
  stopService,
  diagnostics,
  daemonHealth,
  reloadProjects,
  appRoot,
} from "./setup.mjs";
import { loadConfig, check } from "./config.mjs";
import { pairCommand } from "./pairing.mjs";
import { enableHerdr, disableHerdr } from "./herdr-setup.mjs";

process.umask(0o077);
const args = process.argv.slice(2),
  command = args[0] || (process.stdin.isTTY && process.stdout.isTTY ? "tui" : "help");
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
try {
  if (["--version", "version"].includes(command))
    console.log(
      "hati " + JSON.parse(readFileSync(join(appRoot, "package.json"))).version,
    );
  else if (["help", "--help", "-h"].includes(command))
    console.log(
      `hati — モバイルと共有するCodex workspace\n\n  hati / hati tui              HerdrベースのターミナルUI\n  hati tui --json                全マシンの同期状態\n  hati machine add NAME USER@HOST  リモート端末を登録\n  hati machine list / remove NAME  CLIの接続先を管理\n  hati setup [プロジェクトのパス]  初期設定・常駐起動・QRでiPhone登録\n  hati pair                      5分間の登録QRを表示\n  hati pair --copy               PC用の招待リンクをコピー\n  hati pair --link               PC用の招待リンクを表示（SSH先など）\n  hati project add PATH [名前]    プロジェクトを追加\n  hati codex                     tmuxで共有Codexを開始\n  hati herdr enable / disable    HerdrのAgents表示を連携・復元\n  hati herdr status [--json]      Herdr連携の状態を確認\n  hati power install / uninstall Macの蓋を閉じたまま開発するための準備・削除\n  hati doctor                    接続・ログイン状態を確認\n  hati start / stop / restart     常駐を操作（stopは実行中の作業も中断）\n  hati login                     通常のCodexへログイン\n  hati run                       常駐を前景で起動\n\n初回: brew install tamoharu/hati/hati && hati setup\nQR不要: hati setup --no-pair\n登録: hati pair [--copy | --link | --no-open] [--ssh-port 22]`,
    );
  else if (["tui", "machine"].includes(command)) {
    const { tuiCommand } = await import("./tui-cli.mjs");
    await tuiCommand(command, args.slice(1));
  }
  else if (command === "power") {
    const { powerSetup } = await import("./power-setup.mjs");
    await powerSetup(args[1]);
  }
  else if (command === "pair") {
    await pairCommand({ sshPort: Number(option("--ssh-port") || 22), noOpen: args.includes("--no-open"),
      copy: args.includes("--copy"), link: args.includes("--link") });
  }
  else if (command === "setup") {
    const project = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
    const { paths, config, created } = ensureSetup({ project });
    if (project && !created) {
      addProject(paths.configFile, project);
      await reloadProjects(config);
    }
    if (!args.includes("--no-start")) await startService(paths, config);
    console.log(
      created
        ? "hatiの設定を作成しました。"
        : "既存の設定・認証情報・履歴を保持しています。",
    );
    console.log("設定: " + paths.configFile);
    if (!args.includes("--quiet")) {
      const report = await diagnostics(paths, config);
      console.log(
        `iPhoneの接続先: ${report.address}\nSSHユーザー名: ${report.username}\nAPIトークン: SSH認証後にアプリが自動取得します。`,
      );
      if (!report.loggedIn)
        console.log("初回だけ hati login を実行してください。");
      if (!report.ssh)
        console.log(
          process.platform === "darwin"
            ? "システム設定 → 一般 → 共有 → リモートログインを有効にしてください。"
            : "OpenSSHサーバーを有効にしてください。",
        );
      if (!report.tailscale) console.log("Tailscaleを接続してください。");
      console.log(
        "通知は別途APNs鍵の設定が必要です。hati doctor で確認できます。",
      );
      if (!args.includes("--no-pair") && !args.includes("--no-start") && process.stdout.isTTY && report.ssh && report.tailscale) {
        await pairCommand({ sshPort: Number(option("--ssh-port") || 22), noOpen: args.includes("--no-open") });
      } else if (!args.includes("--no-pair")) console.log("iPhoneをQRで登録: hati pair");
    }
  } else if (command === "run") {
    const paths = locations();
    if (!option("--config")) ensureSetup();
    process.argv = [
      process.argv[0],
      process.argv[1],
      option("--config") || paths.configFile,
    ];
    await import("./main.mjs");
  } else {
    const paths = locations(),
      config = loadConfig(option("--config") || paths.configFile);
    const api = async (path, body) => {
      const r = await fetch(`http://127.0.0.1:${config.port}${path}`, {
        method: body ? "POST" : "GET", headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000),
      });
      const value = await r.json();
      check(r.ok, "api", value.error?.message ?? "hati常駐へ接続できません。");
      return value;
    };
    if (command === "herdr") {
      const action = args[1] ?? "status";
      check(["enable", "disable", "status"].includes(action), "command", "hati herdr enable / disable / status [--json]");
      let state = await api("/v1/herdr");
      if (action === "enable") {
        await enableHerdr(config, { configPath: option("--herdr-config"), socketPath: option("--socket"), hostName: option("--host-name") });
        state = await api("/v1/herdr/reload", {});
      } else if (action === "disable") {
        await disableHerdr(config); state = await api("/v1/herdr/reload", {});
      }
      if (args.includes("--json")) console.log(JSON.stringify(state));
      else if (!state.enabled) console.log("Herdr連携は無効です。hati herdr enable で有効化できます。");
      else console.log(`Herdr連携: ${state.connected ? "接続中" : "接続待ち"}\nAgents: ${state.agents ?? 0} / 会話取得: ${state.matched ?? 0}${state.error ? "\n" + state.error : ""}`);
    } else if (command === "terminal" && args[1] === "attach") {
      const p = await api("/v1/workspace/attach", { paneId: option("--pane"), epoch: option("--epoch"), panePid: Number(option("--pid")) });
      const tmuxArgs = await new Tmux(config.tmux).mobileAttachArgs(p);
      process.exitCode = spawnSync(config.tmux?.bin ?? "tmux", tmuxArgs, { stdio: "inherit", env: { ...process.env, TMUX: "" } }).status ?? 1;
    } else if (command === "codex") {
      const tmux = new Tmux(config.tmux);
      if (process.env.TMUX_PANE) {
        const p = (await tmux.panes()).find((p) => p.paneId === process.env.TMUX_PANE);
        check(p, "pane", "現在のtmux端末を確認できません。");
        const r = await api("/v1/workspace/register", { requestId: randomUUID(), paneId: p.paneId, epoch: p.epoch, panePid: p.panePid });
        check(r.status === "accepted", "receipt", r.result?.message ?? "受理を確認できません。自動再実行しません。");
        await tmux.enableScrollback(p);
        process.exitCode = spawnSync(config.codexBin, ["resume", "--no-alt-screen", "--remote", `unix://${r.result.socket}`, r.result.threadId], { stdio: "inherit" }).status ?? 1;
      } else {
        const requestId = randomUUID();
        const r = await api("/v1/workspace/tabs", { requestId, name: `codex-${requestId.slice(0, 8)}`, directory: process.cwd(), kind: "codex" });
        check(r.status === "accepted", "receipt", r.result?.message ?? "受理を確認できません。");
        const w = await api("/v1/workspace");
        const t = w.spaces.flatMap((s) => s.tabs).find((t) => t.id === r.result.tabId);
        check(t, "pane", "作成済みの端末を再同期してください。");
        const tmuxArgs = await tmux.desktopAttachArgs(t);
        process.exitCode = spawnSync(tmux.bin, tmuxArgs, { stdio: "inherit" }).status ?? 1;
      }
    } else if (command === "connection-info") {
      // Sensitive machine-readable output, requested only across authenticated SSH.
      check(
        args.includes("--json"),
        "explicit",
        "connection-info はアプリのSSH接続専用です（--json必須）。",
      );
      console.log(
        JSON.stringify({ protocol: 1, port: config.port, token: config.token }),
      );
    } else if (["doctor", "status"].includes(command)) {
      const r = await diagnostics(paths, config);
      if (args.includes("--json")) console.log(JSON.stringify(r));
      else {
        for (const [name, ok] of [
          ["常駐", r.running],
          ["コード閲覧", r.codeBrowser],
          ["Codex固定版", r.codexVersion],
          ["Codexログイン", r.loggedIn],
          ["SSH", r.ssh],
          ["Tailscale", r.tailscale],
          ["通知設定", r.notifications],
        ])
          console.log(
            `${ok ? "✓" : "!"} ${name}: ${ok ? "準備済み" : "確認が必要"}`,
          );
        console.log(
          `接続先: ${r.address}\nSSHユーザー名: ${r.username}\n設定: ${r.configFile}`,
        );
        console.log(`パッケージ: ${r.installedVersion} / 稼働中: ${r.daemonVersion ?? (r.running ? "旧版（バージョン情報なし）" : "停止中")}`);
        if (r.restartRequired) console.log("常駐の更新が未反映です。作業完了後に hati restart を実行し、アプリで接続し直してください。");
        for (const p of r.projects)
          console.log(`プロジェクト: ${p.name} (${p.path})`);
      }
    } else if (command === "start") await startService(paths, config);
    else if (command === "stop") {
      stopService();
      console.log("常駐を停止しました。設定と履歴は保持しています。");
    } else if (command === "restart") {
      stopService();
      await new Promise((r) => setTimeout(r, 500));
      await startService(paths, config);
    } else if (command === "login") {
      process.exitCode =
        spawnSync(config.codexBin, ["login"], { stdio: "inherit" }).status || 0;
    } else if (command === "project" && args[1] === "add" && args[2]) {
      addProject(paths.configFile, args[2], args[3]);
      const updated = await reloadProjects(config);
      console.log(
        updated
          ? "プロジェクトを追加して反映しました。実行中の作業は継続します。"
          : "プロジェクトを登録しました。hati startで反映されます。",
      );
    } else throw new Error("操作を確認してください: hati --help");
  }
} catch (error) {
  console.error(
    "hati: " +
      (error.code === "ENOENT"
        ? "初回は hati setup を実行してください。"
        : error.message),
  );
  process.exitCode = 1;
}
