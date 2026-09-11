import { mergeActivityItem, publicConversationItem } from "./conversation-activity.mjs";

const terminalTurns = new Set(["completed", "failed", "interrupted"]);

function string(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function referenceItem(item) {
  const detail = item?.detail && typeof item.detail === "object" ? item.detail : item;
  const type = detail?.type ?? item?.kind;
  return type && typeof detail === "object" ? { ...detail, type } : null;
}

// Only parent-owned activity may name a child.  In particular, do not infer a
// relationship from a requested id or from data nested in arbitrary tool input.
export function subagentReferences(parentThreadId, thread, overlays = []) {
  const refs = new Map();
  const add = (id, agentPath = null) => {
    if (!id || id === parentThreadId) return;
    const old = refs.get(id);
    refs.set(id, { agentThreadId: id, agentPath: old?.agentPath ?? agentPath ?? null });
  };
  const items = [
    ...(thread?.turns ?? []).flatMap((turn) => turn.items ?? []),
    ...overlays,
  ];
  for (const source of items) {
    const item = referenceItem(source);
    if (!item) continue;
    if (item.type === "subAgentActivity")
      add(string(item.agentThreadId), string(item.agentPath));
    else if (["collabAgentToolCall", "collabToolCall"].includes(item.type)) {
      for (const id of Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []) add(string(id));
      add(string(item.receiverThreadId));
      add(string(item.newThreadId));
    }
  }
  return refs;
}

export function subagentState(thread) {
  if (thread?.status?.type === "active") return thread.status.activeFlags?.length ? "waiting" : "running";
  if (thread?.status?.type === "systemError") return "failed";
  const turn = thread?.turns?.at(-1);
  if (turn?.status === "completed") return "completed";
  if (turn?.status === "failed") return "failed";
  if (turn?.status === "interrupted") return "stopped";
  return ["idle", "notLoaded"].includes(thread?.status?.type) ? "unknown" : "unknown";
}

// Snapshot-only child reads deliberately seed no observed lifecycle timestamps.
// Official item durations remain available through mergeActivityItem.
export function subagentPage({ parentThreadId, reference, thread, before = Number.MAX_SAFE_INTEGER }) {
  const items = (thread?.turns ?? []).flatMap((turn) => (turn.items ?? []).map((item) =>
    publicConversationItem(mergeActivityItem(null, item, turn.id, {
      terminal: terminalTurns.has(turn.status), source: "snapshot",
    })),
  )).map((item, index) => ({ ...item, position: index + 1 }));
  const eligible = items.filter((item) => item.position < before);
  const page = eligible.slice(-200);
  const hasMore = eligible.length > page.length;
  return {
    parentThreadId,
    agentThreadId: reference.agentThreadId,
    agentPath: reference.agentPath,
    state: subagentState(thread),
    turnId: thread?.turns?.at(-1)?.id ?? null,
    items: page,
    hasMore,
    nextBefore: hasMore ? page[0].position : null,
    historyLimited: !!thread?._hatiHistoryLimited || !!thread?._hatiRolloutFallback,
  };
}
