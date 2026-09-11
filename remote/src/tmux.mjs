import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomBytes } from "node:crypto";
import { basename } from "node:path";
import { check, Fault } from "./config.mjs";
import { processIdentity } from "./codex.mjs";

const exec = promisify(execFile);
// Service control sessions remain protected across product renames.
export const isControlSession = (name) => /^[a-z][a-z0-9]*-control-/.test(name);
export const shellQuote = (s) => "'" + String(s).replaceAll("'", "'\\''") + "'";
const fields = ["session_id", "session_name", "window_id", "window_index", "window_name",
  "pane_id", "pane_index", "pane_pid", "pane_current_command", "pane_current_path", "pane_dead", "pid"];
export class Tmux {
  constructor({ bin = "tmux", socket } = {}) { this.bin = bin; this.socket = socket; }
  async run(args) {
    try {
      const argv = ["-u", ...(this.socket ? ["-S", this.socket] : []), ...args];
      // A default tmux server may later host unrelated PC terminals. Keep a new
      // server outside hati's systemd service cgroup, so restarting hati cannot
      // terminate those terminals. A transient user scope inherits no API token.
      const scope = process.platform === "linux" && process.env.INVOCATION_ID && args[0] === "new-session";
      return (await exec(scope ? "systemd-run" : this.bin, scope
        ? ["--user", "--scope", "--quiet", "--collect", this.bin, ...argv] : argv,
        { encoding: "utf8", timeout: 8000, maxBuffer: 4 * 1024 * 1024 })).stdout.trimEnd();
    } catch (e) {
      // Never expose stderr: tmux commands can contain project paths or a prompt.
      const absent = /no server running|error connecting to .*No such file or directory/.test(e.stderr ?? "");
      throw new Fault(503, e.code === "ENOENT" ? "tmux_missing" : absent ? "tmux_absent" : "tmux_unavailable",
        e.code === "ENOENT" ? "tmuxをPCにインストールしてください。" : "tmuxの対象を確認できません。再同期してください。");
    }
  }
  async panes({ strict = false } = {}) {
    let raw;
    const separator = "|hati-" + randomBytes(16).toString("hex") + "|";
    try { raw = await this.run(["list-panes", "-a", "-F", fields.map((f) => `#{${f}}`).join(separator)]); }
    catch (e) { if (e.code === "tmux_absent" || (!strict && e.code === "tmux_unavailable")) return []; throw e; }
    const rows = raw.split("\n").map((s) => s.split(separator)).filter((a) => a.length === fields.length);
    const epochs = new Map();
    return rows.flatMap((a) => {
      const p = Object.fromEntries(fields.map((f, i) => [f, a[i]]));
      if (!/^\$\d+$/.test(p.session_id) || !/^@\d+$/.test(p.window_id) || !/^%\d+$/.test(p.pane_id)) return [];
      if (!epochs.has(p.pid)) epochs.set(p.pid, createHash("sha256")
        .update(`${this.socket ?? "default"}:${p.pid}:${processIdentity(Number(p.pid))}`).digest("hex").slice(0, 24));
      return [{ sessionId: p.session_id, sessionName: p.session_name, windowId: p.window_id,
        windowIndex: Number(p.window_index), windowName: p.window_name, paneId: p.pane_id,
        paneIndex: Number(p.pane_index), panePid: Number(p.pane_pid), command: p.pane_current_command,
        directory: p.pane_current_path, dead: p.pane_dead === "1", epoch: epochs.get(p.pid), serverPid: Number(p.pid) }];
    });
  }
  async verified({ paneId, epoch, panePid }) {
    check(/^%\d+$/.test(paneId ?? "") && /^[a-f0-9]{24}$/.test(epoch ?? "") && Number.isSafeInteger(panePid),
      "terminal_target", "端末の指定が不正です。");
    const pane = (await this.panes()).find((p) => p.paneId === paneId && p.epoch === epoch && p.panePid === panePid);
    check(pane && !pane.dead, "terminal_stale", "端末は終了または入れ替わっています。再同期してください。", 409);
    return pane;
  }
  async enableScrollback(target) {
    const pane = await this.verified(target);
    // Only this shared session opts into tmux scrollback. Do not replace the
    // user's global mouse bindings or window-size policy.
    await this.run(["set-option", "-t", pane.sessionId, "mouse", "on"]);
    return pane;
  }
  async terminate(target) {
    check(/^%\d+$/.test(target.paneId ?? "") && /^[a-f0-9]{24}$/.test(target.epoch ?? "") && Number.isSafeInteger(target.panePid),
      "terminal_target", "端末の指定が不正です。");
    const panes = await this.panes({ strict: true });
    const pane = panes.find((p) => p.paneId === target.paneId && p.panePid === target.panePid && p.epoch === target.epoch);
    if (!pane) return; // Already gone; never touch a replacement pane.
    check(!isControlSession(pane.sessionName),
      "terminal_control", "共有Codexサーバーはタブの終了対象にできません。", 409);
    const guard = `#{&&:#{==:#{pane_pid},${pane.panePid}},#{==:#{pid},${pane.serverPid}}}`;
    await this.run(["if-shell", "-F", "-t", pane.paneId, guard, `kill-pane -t ${pane.paneId}`]);
  }
  async desktopAttachArgs(target) {
    const pane = await this.enableScrollback(target);
    return ["-u", ...(this.socket ? ["-S", this.socket] : []),
      "attach-session", "-t", pane.paneId];
  }
  async mobileAttachArgs(target) {
    const pane = await this.enableScrollback(target);
    // A shared PTY has one size. Phone resize events must not shrink the PC.
    // This flag preserves input (unlike -r) and leaves PC clients attached.
    return ["-u", ...(this.socket ? ["-S", this.socket] : []),
      "attach-session", "-f", "ignore-size", "-t", pane.paneId];
  }
  async create({ space, name, directory, command }) {
    const args = space
      ? ["new-window", "-d", "-t", space, "-n", name, "-c", directory]
      : ["new-session", "-d", "-s", name, "-c", directory];
    args.push("-P", "-F", "#{pane_id}");
    if (command) args.push(command.map(shellQuote).join(" "));
    return this.run(args);
  }
  async processes() {
    try {
      const { stdout } = await exec("ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
      // comm contains only executable names, never command-line prompts or secrets.
      return stdout.split("\n").flatMap((s) => {
        const m = s.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
        return m ? [{ pid: Number(m[1]), parent: Number(m[2]), name: basename(m[3]).replace(/^-/, "") }] : [];
      });
    } catch { return []; }
  }
}
export function hasCodexProcess(pane, processes) {
  const ids = processes instanceof Set ? processes : codexProcessAncestors(processes);
  return ids.has(pane.panePid) || /^codex(?:-.*)?$/.test(pane.command);
}
export function codexProcessAncestors(processes) {
  const parents = new Map(processes.map((p) => [p.pid, p.parent])), ids = new Set();
  for (const p of processes.filter((p) => /^codex(?:-.*)?$/.test(p.name))) {
    let id = p.pid;
    while (id && !ids.has(id)) { ids.add(id); id = parents.get(id); }
  }
  return ids;
}
