import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { check, migratedDirectory } from "./config.mjs";

const CATEGORIES = new Set(["all", "chat", "tab", "space", "file", "code"]);
const SKIP_DIRECTORIES = new Set([".git", "node_modules", ".build", "build", "DerivedData", ".next", ".venv", "__pycache__"]);
const MAX_JOBS = 12, TTL = 120_000;
const excerpt = (text, query) => {
  text = String(text ?? "").replace(/\s+/g, " ");
  const start = Math.max(0, text.toLocaleLowerCase().indexOf(query) - 45);
  return (start ? "…" : "") + text.slice(start, start + 220);
};

// Search cursors own a bounded, expiring iterator. Work only advances while a
// client requests a page; large workspaces never need an in-memory file index.
export class GlobalSearch {
  constructor(service) { this.service = service; this.jobs = new Map(); }
  async page(query, category = "all", cursor, signal) {
    check(typeof query === "string" && query.trim().length > 0 && query.length <= 200,
      "search_query", "検索語は1〜200文字で入力してください。");
    check(CATEGORIES.has(category), "search_category", "検索の種類が不正です。");
    for (const [key, job] of this.jobs) if (!job.busy && job.expires < Date.now()) this.jobs.delete(key);
    let job = cursor && this.jobs.get(cursor);
    if (cursor) check(job && job.query === query && job.category === category, "search_expired", "検索を更新してください。", 410);
    else {
      if (this.jobs.size >= MAX_JOBS) {
        const idle = [...this.jobs].find(([, job]) => !job.busy);
        check(idle, "search_busy", "検索が混み合っています。少し待って再試行してください。", 429);
        this.jobs.delete(idle[0]);
      }
      job = { query, category, notices: new Set(), expires: Date.now() + TTL, busy: false };
      job.iterator = this.scan(job); cursor = randomUUID(); this.jobs.set(cursor, job);
    }
    check(!job.busy, "search_busy", "検索結果を取得中です。", 409);
    job.busy = true;
    const data = [], deadline = Date.now() + 1200;
    let done = false;
    try {
      for (let steps = 0; steps < 300 && data.length < 60 && Date.now() < deadline; steps++) {
        if (signal?.aborted) break;
        const next = await job.iterator.next();
        if (next.done) { done = true; break; }
        if (next.value) data.push(next.value);
      }
      if (done) this.jobs.delete(cursor);
      return { data, nextCursor: done ? null : cursor, notices: [...job.notices] };
    } catch (error) { this.jobs.delete(cursor); throw error; }
    finally { job.busy = false; job.expires = Date.now() + TTL; }
  }
  async *scan(job) {
    const { service } = this, w = service.workspace;
    const q = job.query.trim().toLocaleLowerCase(), wants = kind => job.category === "all" || job.category === kind;
    const matches = value => String(value ?? "").toLocaleLowerCase().includes(q);
    const snapshot = w?.refreshLayout ? await w.refreshLayout() : w?.snapshot;
    const spaces = snapshot?.spaces ?? [], tabs = new Map();
    for (const tab of w?.records?.() ?? []) tabs.set(tab.id, tab);
    for (const space of spaces) for (const tab of space.tabs) tabs.set(tab.id, { ...tabs.get(tab.id), ...tab, spaceId: space.id, spaceName: space.customName ?? space.name });
    const context = tab => ({ tabId: tab.id, directory: tab.directory, spaceId: tab.spaceId, spaceName: tab.spaceName ?? basename(tab.directory ?? ""), threadId: tab.threadId, updatedAt: tab.updatedAt ?? 0 });
    for (const space of spaces) {
      const title = space.customName ?? space.name;
      if (wants("space") && matches(title)) yield { id: `space:${space.id}`, kind: "space", title, snippet: space.directory,
        spaceId: space.id, spaceName: title, directory: space.directory, updatedAt: 0 };
    }
    for (const tab of tabs.values()) {
      if (wants("tab") && matches(tab.name)) yield { ...context(tab), id: `tab:${tab.id}`, kind: "tab", title: tab.name, snippet: tab.directory };
    }
    if (wants("chat")) {
      const seenThreads = new Set();
      for (const session of service.store.sessions()) {
        const project = service.config?.projects?.find(p => p.id === session.projectId);
        let text = [session.name, session.latest, session.lastUserQuery].find(matches);
        // Literal substring matching, including % and _, with no SQL interpolation.
        if (!text && service.store.db) {
          const row = service.store.db.prepare("SELECT json_extract(data,'$.text') AS text FROM items WHERE session=? AND json_extract(data,'$.kind') IN ('userMessage','agentMessage') AND instr(lower(json_extract(data,'$.text')), ?) > 0 ORDER BY position DESC LIMIT 1").get(session.id, q);
          text = row?.text;
        }
        if (text) {
          if (session.threadId) seenThreads.add(session.threadId);
          yield { id: `chat:${session.threadId ?? session.id}`, kind: "chat", title: session.name, snippet: excerpt(text, q),
            sessionId: session.id, threadId: session.threadId, directory: project?.path, spaceName: project?.name, updatedAt: session.updatedAt };
        }
        yield null;
      }
      for (const tab of tabs.values()) {
        const text = [tab.name, tab.latest, tab.lastUserQuery].find(matches);
        if (tab.threadId && text && !seenThreads.has(tab.threadId)) {
          seenThreads.add(tab.threadId);
          yield { ...context(tab), id: `chat:${tab.threadId}`, kind: "chat", title: tab.name, snippet: excerpt(text, q) };
        }
      }
      if (w?.shared) {
        try {
          const client = await w.shared(true);
          // Codex's full-text index covers historical conversations, including
          // threads no longer assigned to an open tab. Never resume to search.
          for (const archived of [false, true]) {
            let cursor = null;
            do {
              const page = await client.call("thread/search", { searchTerm: job.query.trim(), limit: 50, cursor, archived,
                sortKey: "updated_at", sourceKinds: ["cli", "vscode", "appServer", "exec", "unknown"] }, 8000);
              for (const { thread, snippet } of page.data) {
                if (seenThreads.has(thread.id)) continue;
                seenThreads.add(thread.id);
                const tab = [...tabs.values()].find(t => t.threadId === thread.id);
                const directory = migratedDirectory(this.service.config, thread.cwd);
                const space = spaces.find(s => s.directory === directory);
                yield { ...(tab ? context(tab) : {}), id: `chat:${thread.id}`, kind: "chat",
                  title: thread.name || thread.preview || "チャット", snippet: excerpt(snippet || thread.preview, q),
                  threadId: thread.id, directory, spaceId: space?.id, spaceName: space?.customName ?? space?.name ?? basename(directory ?? ""),
                  updatedAt: (thread.updatedAt ?? 0) * 1000 };
              }
              const next = page.nextCursor;
              check(!next || next !== cursor, "search_cursor", "会話検索の続きを取得できません。");
              cursor = next; yield null;
            } while (cursor);
          }
        } catch { job.notices.add("会話本文の検索を完了できませんでした。PC側の接続・更新を確認してください。"); }
      }
    }
    if (!(wants("file") || wants("code")) || !w?.code) return;
    job.notices.add("ファイル・コードは各スペースの作業フォルダが対象です。依存関係・ビルド出力は除き、本文は1 MB以下のテキストを検索します。");
    const roots = new Set();
    const locations = [...spaces.map(s => ({ directory: s.baseDirectory ?? s.directory, spaceId: s.id, spaceName: s.customName ?? s.name })), ...tabs.values()];
    for (const tab of locations) {
      if (!tab.directory || roots.has(tab.directory)) continue;
      roots.add(tab.directory);
      const pending = [{ path: "", cursor: "0" }];
      while (pending.length) {
        const directory = pending.pop();
        let page;
        try { page = await w.code.list(null, directory.path, tab.directory, directory.cursor); }
        catch { job.notices.add("読み取れないフォルダがあり、一部を検索できませんでした。"); yield null; continue; }
        if (page.nextCursor) pending.push({ path: directory.path, cursor: page.nextCursor });
        for (const entry of page.data) {
          // Never follow directory links: avoid cycles and leaving a space root.
          if (entry.symlink) { yield null; continue; }
          if (entry.kind === "directory") {
            if (!SKIP_DIRECTORIES.has(entry.name)) pending.push({ path: entry.path, cursor: "0" });
          } else if (entry.kind === "file") {
            const base = { ...context(tab), path: entry.path, title: entry.name };
            if (wants("file") && matches(entry.path)) yield { ...base, id: `file:${join(tab.directory, entry.path)}`, kind: "file", snippet: entry.path };
            if (wants("code")) {
              try {
                const document = await w.code.read(null, entry.path, tab.directory);
                const lines = document.text.split(/\r\n|\r|\n/), index = lines.findIndex(matches);
                if (index >= 0) yield { ...base, id: `code:${join(tab.directory, entry.path)}`, kind: "code",
                  snippet: excerpt(lines[index], q), line: index + 1, updatedAt: document.modifiedAt };
              } catch (error) {
                if (!["file_size", "file_binary", "file_encoding", "file_type", "file_missing"].includes(error.code))
                  job.notices.add("読み取れないファイルがあり、一部を検索できませんでした。");
              }
            }
          }
          yield null;
        }
      }
    }
  }
}
