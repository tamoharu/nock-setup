import { groupWorkspace, draftKey } from "./client-workspace.mjs";

// Match HatiCore/SidebarAgent.swift, including unstarted-thread filtering,
// fleet ordering, server-clock timing and stale snapshots.
export const stateLabels = { starting: "開始中", running: "実行中", waiting: "入力待ち", completed: "応答完了",
  failed: "失敗", stopped: "停止", idle: "指示待ち", shell: "シェル", untracked: "CLI稼働・状態未連携", unknown: "状態未確認" };
const sessionLabels = { starting: "送信を確認中", running: "実行中", waiting: "入力待ち", completed: "応答完了", failed: "失敗", stopped: "停止" };
export const clean = (value) => String(value ?? "").replace(/[\p{Cc}\u200B\u200E-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/gu, " ").trim();
export const cleanBody = (value) => String(value ?? "").replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202A-\u202E\u2066-\u2069]/g, "");
const limit = (value, count) => Array.from(value).slice(0, count).join("");
const tail = (value, count) => Array.from(value).slice(-count).join("");
export const started = (tab) => [tab.lastUserQuery, tab.latest, tab.turnId, tab.runTiming?.turnId].some(v => typeof v === "string" && v.trim());
export const contextKey = (target) => draftKey(target.hostId, target.serverId, target.tabId, target.threadId);
export function runtime(tab, sample, fresh, now) {
  const t = tab.runTiming;
  let ms = t?.durationMs;
  if (!(Number.isFinite(ms) && ms >= 0)) {
    if (!Number.isFinite(t?.startedAt)) return "実行時間 —";
    if (Number.isFinite(t.completedAt)) ms = t.completedAt - t.startedAt;
    else if (["running", "starting", "waiting"].includes(tab.state) && Number.isFinite(sample.observedAt))
      ms = sample.observedAt - t.startedAt + (fresh && !tab.archived ? Math.max(0, now - sample.receivedAt) : 0);
    else return "実行時間 —";
  }
  const s = Math.floor(Math.max(0, ms) / 1000);
  const value = s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`
    : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  return `実行時間 ${value}${fresh ? "" : "（最終確認）"}`;
}
export function fleetView(hosts, samples, now = Date.now(), preferences = {}) {
  const agents = [];
  const machines = hosts.map(host => {
    const sample = samples.get(host.id), overview = sample?.overview;
    const connected = !!sample?.connected && now - sample.receivedAt < 15000;
    const fresh = connected && !overview?.workspace?.error && Number.isFinite(overview?.workspace?.syncedAt)
      && overview.syncedAt - overview.workspace.syncedAt < 15000;
    const serverId = overview?.serverId ?? "";
    const workspace = groupWorkspace(overview?.workspace);
    const hidden = new Set(workspace.presentation?.hiddenTabIds || []);
    const unread = (tab, source) => source === "session" && tab.lastEventSeq > (preferences.readPositions?.[contextKey({ hostId: host.id, serverId, tabId: tab.id, threadId: tab.threadId })] ?? 0);
    const decorate = (tab, space, source = "terminal", isFresh = fresh) => ({
      hostId: host.id, serverId, tabId: tab.id, threadId: tab.threadId ?? null, source,
      name: clean(tab.name), hostName: clean(host.name), spaceId: space?.id ?? tab.spaceId ?? "",
      spaceName: clean(space?.name ?? tab.spaceName ?? tab.directory?.split("/").filter(Boolean).at(-1)),
      directory: tab.directory ?? "", state: tab.state ?? "unknown", fresh: !!isFresh,
      status: `${isFresh ? "" : "最終確認: "}${source === "session" ? sessionLabels[tab.state] ?? "状態不明" : stateLabels[tab.state] ?? stateLabels.unknown}${unread(tab, source) ? " · 未読" : ""}`,
      runtime: runtime(tab, { observedAt: source === "terminal" ? overview?.workspace?.syncedAt : overview?.syncedAt,
        receivedAt: sample?.receivedAt }, isFresh, now),
      query: limit(clean(tab.lastUserQuery == null ? "ユーザー指示未取得" : tab.lastUserQuery === "" ? "まだユーザー指示がありません" : tab.lastUserQuery), 2000),
      latest: tail(cleanBody(tab.latest), 16000), archived: !!tab.archived, hidden: hidden.has(tab.id),
      dead: !!tab.dead, kind: tab.kind ?? "codex", updatedAt: tab.updatedAt ?? 0,
      paneId: tab.paneId, panePid: tab.panePid, epoch: tab.epoch,
    });
    const spaces = workspace.spaces.filter(s => !s.archived).map(space => ({
      id: space.id, name: clean(space.name), directory: space.directory, sourceIds: space.sourceIds,
      tabs: space.tabs.filter(t => !t.archived && !hidden.has(t.id)).map(t => decorate(t, space)),
    }));
    const terminalAgents = workspace.agents.filter(started);
    const threadIds = new Set(terminalAgents.filter(t => preferences.includeArchived || !t.archived).map(t => t.threadId).filter(Boolean));
    for (const tab of terminalAgents) agents.push(decorate(tab, workspace.spaces.find(s => s.id === tab.spaceId)));
    for (const session of overview?.sessions || []) {
      if (!started(session) || threadIds.has(session.threadId)) continue;
      agents.push(decorate(session, { name: overview.projects?.find(p => p.id === session.projectId)?.name ?? session.name }, "session", connected));
    }
    return { id: host.id, name: clean(host.name), kind: host.kind, serverId, connected: !!connected,
      status: connected ? "接続中" : sample ? "最終確認" : "未接続", error: clean(sample?.error ?? overview?.workspace?.error),
      receivedAt: sample?.receivedAt ?? null, spaces,
      defaultDirectory: overview?.projects?.[0]?.path ?? "",
    };
  });
  const running = a => a.fresh && !a.archived && ["running", "starting"].includes(a.state);
  const priority = a => ({ running: 0, starting: 0, waiting: 1, failed: 2, untracked: 3, unknown: 3, idle: 4, completed: 5 })[a.state] ?? 6;
  const filter = preferences.filter ?? "all";
  return { machines, agents: agents.filter(a => (preferences.includeArchived || !a.archived) &&
    (filter === "all" || a.state === filter || filter === "running" && a.state === "starting")).sort((a, b) =>
    Number(running(b)) - Number(running(a)) || (preferences.byPriority && !running(a) ? Number(b.fresh) - Number(a.fresh) || priority(a) - priority(b) : 0) ||
    b.updatedAt - a.updatedAt || contextKey(a).localeCompare(contextKey(b))) };
}
