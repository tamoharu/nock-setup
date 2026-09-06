import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, isAbsolute, relative } from "node:path";
import { threadPermissionOverrides } from "./agent-settings.mjs";
import { check, requestID, now } from "./config.mjs";
import { EMPTY_THREAD_NAME } from "./thread-titles.mjs";
import { conversationSummary } from "./workspace.mjs";

const skipped = new Set(["node_modules", "DerivedData", "vendor", "build", "dist", "Pods"]);
export async function directoryPath(path) {
  check(typeof path === "string" && isAbsolute(path) && !/[\x00-\x1f\x7f]/.test(path), "directory", "絶対パスを指定してください。");
  const value = await realpath(path).catch(() => null);
  check(value && (await stat(value)).isDirectory(), "directory", "ディレクトリが見つかりません。");
  return value;
}
export function fuzzyScore(value, query) {
  value = value.toLocaleLowerCase(); query = query.toLocaleLowerCase().replace(/\s+/g, "");
  let score = 0, previous = -1;
  for (const char of query) {
    const index = value.indexOf(char, previous + 1);
    if (index < 0) return null;
    score += index === previous + 1 ? 12 : 0;
    if (index === 0 || "/_- .".includes(value[index - 1])) score += 16;
    score -= index - previous - 1; previous = index;
  }
  return score - value.length / 100;
}

export class PathTabs {
  constructor(workspace) { this.w = workspace; }
  async root() {
    if (this.w.config.searchRoot) return directoryPath(this.w.config.searchRoot);
    // Prefer ~/dev, then a dev ancestor of a configured project (e.g. ~/Sites/dev).
    const candidates = [join(homedir(), "dev")];
    for (const project of this.w.config.projects) {
      for (let path = project.path; dirname(path) !== path; path = dirname(path))
        if (basename(path).toLowerCase() === "dev") { candidates.push(path); break; }
    }
    candidates.push(join(homedir(), "Sites", "dev"), this.w.config.projects[0]?.path, homedir());
    for (const path of candidates.filter(Boolean)) {
      try { return await directoryPath(path); } catch {}
    }
  }
  async directories(query = "", root) {
    check(query.length <= 200, "query", "検索語を短くしてください。");
    root = root ? await directoryPath(root) : await this.root();
    if (!query.trim()) {
      const entries = await readdir(root, { withFileTypes: true });
      const children = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") &&
        !skipped.has(entry.name) && !/[\x00-\x1f\x7f]/.test(entry.name))
        .sort((a, b) => a.name.localeCompare(b.name));
      return { root, depth: 1, data: children.slice(0, 1000).map((entry) => ({
        path: join(root, entry.name), name: entry.name, relative: entry.name,
      })), truncated: children.length > 1000 };
    }
    let index = this.index;
    if (!index || index.root !== root || now() - index.time > 30000) {
      const paths = [root], queue = [{ path: root, depth: 0 }];
      let truncated = false;
      for (let i = 0; i < queue.length; i++) {
        const { path, depth } = queue[i];
        if (depth === 3) continue;
        const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name.startsWith(".") || skipped.has(entry.name) || /[\x00-\x1f\x7f]/.test(entry.name)) continue;
          if (paths.length >= 10000) { truncated = true; break; }
          const child = join(path, entry.name);
          paths.push(child); queue.push({ path: child, depth: depth + 1 });
        }
        if (truncated) break;
      }
      index = { root, paths, time: now(), truncated };
      this.index = index;
    }
    const data = index.paths.map((path) => ({ path, name: basename(path), relative: relative(root, path) || ".",
      score: fuzzyScore(relative(root, path) || basename(root), query) })).filter((p) => p.score !== null)
      .sort((a, b) => b.score - a.score || a.relative.localeCompare(b.relative));
    return { root, depth: 3, data: data.slice(0, 100), truncated: index.truncated || data.length > 100 };
  }
  async history(id, cursor) {
    const t = this.w.snapshot.spaces.flatMap((s) => s.tabs).find((t) => t.id === id) ?? this.w.records().find((t) => t.id === id);
    check(t, "tab_missing", "タブが見つかりません。", 404);
    const c = await this.w.shared(true);
    const result = await c.call("thread/list", { cwd: t.directory, limit: 40, sortKey: "updated_at", cursor: cursor || null,
      sourceKinds: ["cli", "vscode", "appServer", "exec", "unknown"], modelProviders: [] });
    // Empty newly created threads may not yet appear in the persisted list.
    if (!cursor) {
      const current = this.w.records().find((r) => r.id === id);
      const remembered = [...(current?.history ?? []), ...(current?.contexts ?? []), ...(current ? [current] : [])];
      for (const entry of remembered.filter((v) => v.directory === t.directory && v.threadId)) {
        if (result.data.some((v) => v.id === entry.threadId)) continue;
        try {
          const thread = await this.w.chat.readThread(c, entry.threadId);
          result.data.unshift({ id: thread.id, name: thread.name ?? null, preview: thread.preview ?? "", cwd: entry.directory, updatedAt: thread.updatedAt });
        } catch { /* Deleted external history is not recreated. */ }
      }
    }
    // Also repair conversations that have been switched away from or archived
    // in Nock. Ordinary CLI history and custom names are left alone.
    for (let i = 0; i < result.data.length; i++) {
      try { result.data[i] = await this.w.titles.repair(c, result.data[i]); }
      catch { /* History remains usable if Codex cannot save a name yet. */ }
    }
    return result;
  }
  async mutate(id, body) {
    requestID(body.requestId);
    const key = id ?? body.requestId;
    // Serialize reopening with operations on the destination, including opens
    // from a different tab. Two taps must never create two replacement panes.
    const destination = () => body.threadId && this.w.records().find((t) =>
      t.threadId === body.threadId && (!t.archived || t.id === id));
    return this.w.chat.exclusive(destination()?.id ?? key, async () => {
      const kind = id ? "pathTab:switch" : "pathTab:create";
      if (this.w.store.request(body.requestId)) {
        this.w.store.claim(body.requestId, key, kind, body);
        return this.w.store.request(body.requestId);
      }
      const old = id ? this.w.records().find((t) => t.id === id) ?? this.w.snapshot.spaces.flatMap((s) => s.tabs).find((t) => t.id === id) : null;
      check(!id || old, "tab_missing", "タブが見つかりません。", 404);
      // Opening a shared conversation selects its existing tab, even during a turn.
      // Do not replace the current tab or create a second owner of the thread.
      if (body.threadId) {
        const target = destination();
        if (target) {
          if (body.directory) check(await directoryPath(body.directory) === await directoryPath(target.directory),
            "thread_directory", "このパスの履歴を選んでください。", 409);
          this.w.store.claim(body.requestId, key, kind, body);
          try {
            await this.openExisting(target, body.requestId);
            await this.w.refreshLayout();
            return this.w.store.finishRequest(body.requestId, "accepted", { tabId: target.id, threadId: target.threadId });
          } catch (e) {
            return this.w.store.finishRequest(body.requestId, e.status === 400 || e.status === 409 || e.code === "codex_rejected" ? "rejected" : "unknown", { message: e.message });
          }
        }
      }
      const permissionLevel = body.permissionLevel ?? old?.permissionLevel;
      const permissions = threadPermissionOverrides(permissionLevel);
      check(!old || !this.w.messageQueue?.list(id).length, "queue_busy", "キューの送信が終わるか、項目を削除してから会話を切り替えてください。", 409);
      let space;
      if (!old && body.spaceId) {
        await this.w.refreshLayout();
        space = this.w.snapshot.spaces.find((s) => s.id === body.spaceId);
        check(space, "space_stale", "Spaceが見つかりません。再同期してください。", 409);
      }
      check(!old || body.expectedThreadId === (old.threadId ?? null), "stale_thread", "会話が切り替わりました。再同期してください。", 409);
      check(!old || !this.w.chat.requests(id).length, "unknown_request", "送信結果を確認してから切り替えてください。", 409);
      const directory = await directoryPath(body.directory ?? old?.directory ?? space?.directory ?? await this.root());
      const c = await this.w.shared(true);
      if (old?.threadId) {
        const thread = await this.w.chat.readThread(c, old.threadId);
        check(thread.status?.type === "idle", "busy", "応答や確認が終わってから切り替えてください。", 409);
      }
      const remembered = old?.pathTab && old.directory !== directory ? old.contexts?.find((p) => p.directory === directory) : null;
      const selectedThread = body.threadId ?? remembered?.threadId;
      let thread;
      if (selectedThread) {
        check(typeof selectedThread === "string" && selectedThread.length < 200, "thread", "会話の指定が不正です。");
        thread = await this.w.chat.readThread(c, selectedThread);
        check(await directoryPath(thread.cwd) === directory, "thread_directory", "このパスの履歴を選んでください。", 409);
        check(thread.status?.type !== "active", "busy", "この会話は実行中です。", 409);
        check(!this.w.records().some((t) => t.id !== key && t.threadId === selectedThread && !t.archived),
          "thread_open", "この会話は別のタブで開いています。", 409);
      }
      this.w.store.claim(body.requestId, key, kind, body);
      try {
        if (thread) {
          const resumed = (await c.call("thread/resume", { threadId: thread.id, ...threadPermissionOverrides(body.permissionLevel) })).thread;
          thread = { ...resumed, turns: resumed.turns?.length ? resumed.turns : thread.turns };
        }
        else {
          thread = (await c.call("thread/start", { historyMode: "legacy", cwd: directory,
            ...permissions })).thread;
          // A desktop TUI can attach before the first message is sent.
          await c.call("thread/name/set", { threadId: thread.id, name: EMPTY_THREAD_NAME });
        }
        // Each path keeps its own shell. Switching never injects cd into an active
        // program, kills a process, or discards the previous shell's scrollback.
        const contexts = old?.pathTab ? [...(old.contexts ?? []), old] : [];
        const panes = await this.w.tmux.panes();
        let pane = contexts.find((p) => p.directory === directory && panes.some((live) =>
          live.paneId === p.paneId && live.panePid === p.panePid && live.epoch === p.epoch && !live.dead));
        if (!pane) {
          const sessionId = panes.find((p) => p.sessionId === old?.sessionId && p.epoch === old?.epoch)?.sessionId ?? space?.sessionId;
          const paneId = await this.w.tmux.create({ space: sessionId,
            name: `nock-${body.requestId.slice(0, 8)}`, directory });
          pane = (await this.w.tmux.panes()).find((p) => p.paneId === paneId);
        }
        check(pane, "terminal_unknown", "端末の作成結果を確認できません。", 503);
        const compact = ({ contexts, history, ...value }) => value;
        const history = [...(old?.history ?? []), ...(old?.threadId ? [{ threadId: old.threadId, directory: old.directory, name: old.name }] : [])]
          .filter((v, i, all) => all.findIndex((p) => p.threadId === v.threadId) === i);
        const siblings = this.w.records().filter((t) => t.sessionId === pane.sessionId && t.epoch === pane.epoch);
        const tabNumber = old?.tabNumber ?? String(Math.max(0, ...siblings.map((t) => Number(t.tabNumber) || 0)) + 1);
        const customName = old?.customName;
        const tab = { ...compact(pane), id: key, name: customName ?? tabNumber, tabNumber, customName, directory,
          pathTab: true, threadId: thread.id, permissionLevel: selectedThread ? body.permissionLevel ?? remembered?.permissionLevel ?? null : permissionLevel || null, model: thread.model, effort: thread.reasoningEffort, history,
          contexts: contexts.filter((p, i) => p.directory !== directory && contexts.findIndex((v) => v.directory === p.directory) === i).map(compact),
          ...conversationSummary(thread), archived: false, updatedAt: now(), lastPathRequest: body.requestId };
        this.w.save(tab);
        const receipt = this.w.store.finishRequest(body.requestId, "accepted", { tabId: key, threadId: thread.id });
        await this.w.refreshLayout();
        return receipt;
      } catch (e) {
        return this.w.store.finishRequest(body.requestId, e.code === "codex_rejected" ? "rejected" : "unknown", { message: e.message });
      }
    });
  }
  async openExisting(target, requestId) {
    const c = await this.w.shared(true);
    let thread = await this.w.chat.readThread(c, target.threadId);
    const panes = await this.w.tmux.panes();
    let pane = panes.find((p) => p.paneId === target.paneId && p.panePid === target.panePid && p.epoch === target.epoch && !p.dead);
    if (!pane) {
      const directory = await directoryPath(target.directory);
      const resumed = (await c.call("thread/resume", { threadId: target.threadId })).thread;
      thread = { ...resumed, turns: resumed.turns?.length ? resumed.turns : thread.turns };
      // A path tab uses native chat plus a shell. Legacy shared CLI tabs also
      // restore their Codex TUI. Never respawn into a reused tmux pane ID.
      const command = target.pathTab ? undefined
        : [this.w.config.codexBin, "resume", "--no-alt-screen", "--remote", `unix://${this.w.socket}`, target.threadId];
      const space = panes.find((p) => p.sessionId === target.sessionId && p.epoch === target.epoch)?.sessionId;
      const paneId = await this.w.tmux.create({ space, name: `nock-${requestId.slice(0, 8)}`, directory, command });
      pane = (await this.w.tmux.panes()).find((p) => p.paneId === paneId && !p.dead);
      check(pane, "terminal_unknown", "端末の作成結果を確認できません。", 503);
    }
    const current = this.w.records().find((t) => t.id === target.id);
    check(current?.threadId === target.threadId, "stale_thread", "会話が切り替わりました。再同期してください。", 409);
    this.w.save({ ...current, ...pane, directory: target.pathTab ? target.directory : pane.directory,
      ...conversationSummary(thread, current), archived: false, updatedAt: now() });
  }
}
