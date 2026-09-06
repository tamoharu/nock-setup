import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, isAbsolute, relative } from "node:path";
import { check, requestID, now } from "./config.mjs";

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
          result.data.unshift({ id: thread.id, name: thread.name ?? entry.name, preview: thread.preview ?? "", cwd: entry.directory, updatedAt: thread.updatedAt });
        } catch { /* Deleted external history is not recreated. */ }
      }
    }
    return result;
  }
  async mutate(id, body) {
    requestID(body.requestId);
    const key = id ?? body.requestId;
    return this.w.chat.exclusive(key, async () => {
      const kind = id ? "pathTab:switch" : "pathTab:create";
      if (this.w.store.request(body.requestId)) {
        this.w.store.claim(body.requestId, key, kind, body);
        return this.w.store.request(body.requestId);
      }
      const old = id ? this.w.records().find((t) => t.id === id) ?? this.w.snapshot.spaces.flatMap((s) => s.tabs).find((t) => t.id === id) : null;
      check(!id || old, "tab_missing", "タブが見つかりません。", 404);
      check(!old || body.expectedThreadId === (old.threadId ?? null), "stale_thread", "会話が切り替わりました。再同期してください。", 409);
      check(!old || !this.w.chat.requests(id).length, "unknown_request", "送信結果を確認してから切り替えてください。", 409);
      const directory = await directoryPath(body.directory ?? old?.directory ?? await this.root());
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
        if (thread) thread = (await c.call("thread/resume", { threadId: thread.id })).thread;
        else {
          thread = (await c.call("thread/start", { historyMode: "legacy", cwd: directory,
            approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "workspace-write" })).thread;
          await c.call("thread/name/set", { threadId: thread.id, name: basename(directory) || directory });
        }
        // Each path keeps its own shell. Switching never injects cd into an active
        // program, kills a process, or discards the previous shell's scrollback.
        const contexts = old?.pathTab ? [...(old.contexts ?? []), old] : [];
        const panes = await this.w.tmux.panes();
        let pane = contexts.find((p) => p.directory === directory && panes.some((live) =>
          live.paneId === p.paneId && live.panePid === p.panePid && live.epoch === p.epoch && !live.dead));
        if (!pane) {
          const paneId = await this.w.tmux.create({ name: `nock-${body.requestId.slice(0, 8)}`, directory });
          pane = (await this.w.tmux.panes()).find((p) => p.paneId === paneId);
        }
        check(pane, "terminal_unknown", "端末の作成結果を確認できません。", 503);
        const compact = ({ contexts, history, ...value }) => value;
        const history = [...(old?.history ?? []), ...(old?.threadId ? [{ threadId: old.threadId, directory: old.directory, name: old.name }] : [])]
          .filter((v, i, all) => all.findIndex((p) => p.threadId === v.threadId) === i);
        const tab = { ...compact(pane), id: key, name: basename(directory) || directory, directory,
          pathTab: true, threadId: thread.id, model: thread.model, effort: thread.reasoningEffort, history,
          contexts: contexts.filter((p, i) => p.directory !== directory && contexts.findIndex((v) => v.directory === p.directory) === i).map(compact),
          state: "idle", latest: "", archived: false, updatedAt: now(), lastPathRequest: body.requestId };
        this.w.save(tab);
        const receipt = this.w.store.finishRequest(body.requestId, "accepted", { tabId: key, threadId: thread.id });
        await this.w.refresh();
        return receipt;
      } catch (e) {
        return this.w.store.finishRequest(body.requestId, e.code === "codex_rejected" ? "rejected" : "unknown", { message: e.message });
      }
    });
  }
}
