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

process.umask(0o077);
const args = process.argv.slice(2),
  command = args[0] || "help";
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
try {
  if (["--version", "version"].includes(command))
    console.log(
      "Nock " + JSON.parse(readFileSync(join(appRoot, "package.json"))).version,
    );
  else if (["help", "--help", "-h"].includes(command))
    console.log(
      `Nock — iPhoneから自分のCodexを操作\n\n  nock setup [プロジェクトのパス]  初期設定・常駐起動\n  nock project add PATH [名前]    プロジェクトを追加\n  nock codex                     tmuxで共有Codexを開始\n  nock doctor                    接続・ログイン状態を確認\n  nock start / stop / restart     常駐を操作（stopは実行中の作業も中断）\n  nock login                     通常のCodexへログイン\n  nock run                       常駐を前景で起動\n\nHomebrew版はインストール後の nock setup で初期設定と常駐起動が完了します。`,
    );
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
        ? "Nockの設定を作成しました。"
        : "既存の設定・認証情報・履歴を保持しています。",
    );
    console.log("設定: " + paths.configFile);
    if (!args.includes("--quiet")) {
      const report = await diagnostics(paths, config);
      console.log(
        `iPhoneの接続先: ${report.address}\nSSHユーザー名: ${report.username}\nAPIトークン: SSH認証後にアプリが自動取得します。`,
      );
      if (!report.loggedIn)
        console.log("初回だけ nock login を実行してください。");
      if (!report.ssh)
        console.log(
          process.platform === "darwin"
            ? "システム設定 → 一般 → 共有 → リモートログインを有効にしてください。"
            : "OpenSSHサーバーを有効にしてください。",
        );
      if (!report.tailscale) console.log("Tailscaleを接続してください。");
      console.log(
        "通知は別途APNs鍵の設定が必要です。nock doctor で確認できます。",
      );
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
      check(r.ok, "api", value.error?.message ?? "Nock常駐へ接続できません。");
      return value;
    };
    if (command === "terminal" && args[1] === "attach") {
      const p = await api("/v1/workspace/attach", { paneId: option("--pane"), epoch: option("--epoch"), panePid: Number(option("--pid")) });
      const tmuxArgs = [...(config.tmux?.socket ? ["-S", config.tmux.socket] : []), "attach-session", "-t", p.paneId];
      process.exitCode = spawnSync(config.tmux?.bin ?? "tmux", tmuxArgs, { stdio: "inherit", env: { ...process.env, TMUX: "" } }).status ?? 1;
    } else if (command === "codex") {
      const tmux = new Tmux(config.tmux);
      if (process.env.TMUX_PANE) {
        const p = (await tmux.panes()).find((p) => p.paneId === process.env.TMUX_PANE);
        check(p, "pane", "現在のtmux端末を確認できません。");
        const r = await api("/v1/workspace/register", { requestId: randomUUID(), paneId: p.paneId, epoch: p.epoch, panePid: p.panePid });
        check(r.status === "accepted", "receipt", r.result?.message ?? "受理を確認できません。自動再実行しません。");
        process.exitCode = spawnSync(config.codexBin, ["resume", "--remote", `unix://${r.result.socket}`, r.result.threadId], { stdio: "inherit" }).status ?? 1;
      } else {
        const requestId = randomUUID();
        const project = config.projects.find((p) => p.path === process.cwd()) ?? config.projects[0];
        const r = await api("/v1/workspace/tabs", { requestId, name: `codex-${requestId.slice(0, 8)}`, projectId: project.id, kind: "codex" });
        check(r.status === "accepted", "receipt", r.result?.message ?? "受理を確認できません。");
        const w = await api("/v1/workspace");
        const t = w.spaces.flatMap((s) => s.tabs).find((t) => t.id === r.result.tabId);
        check(t, "pane", "作成済みの端末を再同期してください。");
        process.exitCode = spawnSync(tmux.bin, [...(tmux.socket ? ["-S", tmux.socket] : []), "attach-session", "-t", t.paneId], { stdio: "inherit" }).status ?? 1;
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
          : "プロジェクトを登録しました。nock startで反映されます。",
      );
    } else throw new Error("操作を確認してください: nock --help");
  }
} catch (error) {
  console.error(
    "Nock: " +
      (error.code === "ENOENT"
        ? "初回は nock setup を実行してください。"
        : error.message),
  );
  process.exitCode = 1;
}
