// Same grouping rules as ios/HatiCore/Workspace.swift. The backend's IDs are
// retained, even when several tmux sessions share a directory/Space.
export const directoryKey = (value) => {
  if (!value?.startsWith("/")) return value || "";
  const parts = [];
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return "/" + parts.join("/");
};
/** @param {import('./types').Workspace} snapshot @param {string[]} localHidden */
export function groupWorkspace(
  snapshot = { spaces: [], agents: [] },
  localHidden = [],
) {
  const hidden = new Set(snapshot.presentation?.hiddenTabIds ?? localHidden);
  const allIds = snapshot.spaces.flatMap((s) => s.tabs.map((t) => t.id));
  const order = [
    ...new Set([...(snapshot.presentation?.tabOrder || []), ...allIds]),
  ].filter((id) => allIds.includes(id));
  const positions = new Map(order.map((id, i) => [id, i]));
  const rank = (space) =>
    Math.min(...space.tabs.map((t) => positions.get(t.id) ?? Infinity));
  const sources = [...snapshot.spaces].sort((a, b) => rank(a) - rank(b));
  const grouped = new Map();
  for (const source of sources) {
    const directory = directoryKey(
      snapshot.presentation?.spaceDirectories?.[source.id] ||
        source.baseDirectory ||
        source.directory,
    );
    const key = directory || "space:" + source.id;
    let space = grouped.get(key);
    if (!space) {
      space = {
        ...source,
        name:
          source.customName ||
          directory.split("/").filter(Boolean).at(-1) ||
          source.name,
        directory,
        tabs: [],
        sourceIds: [],
      };
      grouped.set(key, space);
    } else {
      if (!space.customName && source.customName) {
        space.customName = source.customName;
        space.name = source.customName;
      }
      space.archived = !!space.archived && !!source.archived;
    }
    space.sourceIds.push(source.id);
    space.tabs.push(
      ...source.tabs.map((t) => ({
        ...t,
        archived: !!t.archived || !!source.archived,
      })),
    );
  }
  const tabs = new Map();
  for (const space of grouped.values()) {
    space.tabs.sort((a, b) => positions.get(a.id) - positions.get(b.id));
    let n = 0;
    space.tabs = space.tabs.map((t) => {
      if (!t.archived && !hidden.has(t.id)) {
        n++;
        if (!t.customName && t.name === t.tabNumber)
          t = { ...t, name: String(n), tabNumber: String(n) };
      }
      t = { ...t, spaceId: space.id, spaceName: space.name };
      tabs.set(t.id, t);
      return t;
    });
  }
  return {
    ...snapshot,
    spaces: [...grouped.values()],
    agents: (snapshot.agents || []).map((a) => ({
      ...a,
      ...(tabs.has(a.id)
        ? {
            name: tabs.get(a.id).name,
            spaceId: tabs.get(a.id).spaceId,
            spaceName: tabs.get(a.id).spaceName,
            customName: tabs.get(a.id).customName,
          }
        : {}),
    })),
  };
}
export const draftKey = (host, server, tab, thread) =>
  [host, server || "", tab, thread || ""].join("\u001f");
export const labels = {
  starting: "開始中",
  running: "実行中",
  waiting: "入力待ち",
  completed: "応答完了",
  failed: "失敗",
  stopped: "停止",
  idle: "指示待ち",
  shell: "シェル",
  untracked: "CLI・状態未連携",
  unknown: "状態未確認",
};
export const isBusy = (state) =>
  ["starting", "running", "waiting"].includes(state);
export const hasConversation = (tab) =>
  !!(
    tab.lastUserQuery?.trim() ||
    tab.latest?.trim() ||
    tab.runTiming?.startedAt
  );
export function mergeDetail(previous, next, older = false) {
  if (!previous || previous.session.threadId !== next.session.threadId)
    return next;
  if (!older && !next.items.length) return next;
  const byPosition = new Map();
  const oldPositions = new Map(
    previous.items
      .filter((item) => item.id)
      .map((item) => [item.id, item.position]),
  );
  const reindexed = next.items.some(
    (item) =>
      item.id &&
      oldPositions.has(item.id) &&
      oldPositions.get(item.id) !== item.position,
  );
  // A live page replaces its entire tail: retired/compacted events must vanish.
  // Older pagination must never overwrite a more recent streaming event.
  const source = reindexed
    ? next.items
    : older
      ? [...next.items, ...previous.items]
      : [
          ...previous.items.filter(
            (item) => item.position < next.items[0].position,
          ),
          ...next.items,
        ];
  for (const item of source) byPosition.set(item.position, item);
  const items = [...byPosition.values()]
    .sort((a, b) => a.position - b.position)
    .slice(-2000);
  return { ...(older ? previous : next), items };
}
export function runTime(timing, connected = true, now = Date.now()) {
  if (!timing) return "—";
  let ms = timing.durationMs;
  if (ms == null && timing.startedAt)
    ms = timing.completedAt
      ? timing.completedAt - timing.startedAt
      : connected
        ? now - timing.startedAt
        : timing.elapsedMs;
  if (!Number.isFinite(ms)) return "—";
  const s = Math.max(0, Math.floor(ms / 1000));
  return s >= 3600
    ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`
    : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
