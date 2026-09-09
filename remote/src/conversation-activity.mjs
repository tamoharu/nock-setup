// Normalization shared by the managed HTTP service and the shared app-server
// observer. Persisted `_activity` is intentionally stripped before API output.
const terminalStatuses = new Set(["completed", "failed", "declined", "interrupted"]);
const outputLimit = 100000;
const indexLimit = 128;

const ms = (value) => Number.isFinite(value) && value >= 0 ? Number(value) : null;
const statusOf = (item) => item?.detail?.status ?? item?.status ?? null;
const isTerminal = (item) => terminalStatuses.has(statusOf(item)) || !!item?._activity?.terminal;

export function activityStorageId(threadId, itemId) {
  return `${threadId}\u0000${itemId}`;
}

export function conversationText(item) {
  if (typeof item?.text === "string") return item.text;
  if (item?.type === "userMessage")
    return (item.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
  if (item?.type === "reasoning") return (item.summary?.length ? item.summary : item.content ?? []).join("\n");
  return "";
}

function streamFrom(item) {
  return {
    text: item?.text ?? "",
    output: item?.output ?? "",
    summary: [...(item?.detail?.summary ?? [])],
    content: [...(item?.detail?.content ?? [])],
  };
}

function streamFor(item) {
  const stream = item?._activity?.stream;
  return stream ? {
    text: stream.text ?? "",
    output: stream.output ?? "",
    summary: [...(stream.summary ?? [])],
    content: [...(stream.content ?? [])],
  } : streamFrom(item);
}

function internal(previous, { terminal, observedAt, stream, officialDurationMs = null }) {
  return {
    terminal: !!previous?._activity?.terminal || !!terminal,
    observedAt,
    stream: stream ?? previous?._activity?.stream ?? streamFrom(previous),
    officialDurationMs: officialDurationMs ?? previous?._activity?.officialDurationMs ?? null,
  };
}

function provisional(itemId, kind, turnId) {
  return { id: itemId, kind, turnId, text: "", phase: null, detail: { id: itemId, type: kind }, output: "" };
}

function indexed(parts, index, delta = "") {
  if (!Number.isSafeInteger(index) || index < 0 || index >= indexLimit) return null;
  const next = [...(parts ?? [])];
  while (next.length <= index) next.push("");
  next[index] += delta;
  return next;
}

function longerLiveValue(previous = "", snapshot = "") {
  if (!previous) return snapshot;
  if (!snapshot || previous.startsWith(snapshot)) return previous;
  if (snapshot.startsWith(previous)) return snapshot;
  // A live stream and a lagging read disagree: retaining the stream avoids
  // losing text that the next delta would otherwise append to incorrectly.
  return previous;
}

// Event streams and thread/read can advance independently. A delta changes
// only the stream; this chooses the next display without replaying that delta
// onto a snapshot that already contains its prefix.
function reconcileStreamValue(display = "", stream = "") {
  if (!stream) return display;
  if (!display || stream.startsWith(display)) return stream;
  if (display.startsWith(stream)) return display;
  return stream;
}

function reconcileStreamParts(display, stream) {
  const shown = display ?? [], buffered = stream ?? [];
  const result = [];
  for (let index = 0; index < Math.max(shown.length, buffered.length); index++)
    result.push(reconcileStreamValue(shown[index] ?? "", buffered[index] ?? ""));
  return result;
}

function mergeLiveParts(previous, snapshot) {
  const old = previous ?? [], next = snapshot ?? [];
  const result = [];
  for (let index = 0; index < Math.max(old.length, next.length); index++)
    result.push(longerLiveValue(old[index] ?? "", next[index] ?? ""));
  return result;
}

function liveSnapshotDetail(previous, item) {
  if (item.type !== "reasoning") return item;
  return {
    ...item,
    summary: mergeLiveParts(previous?.detail?.summary, item.summary),
    content: mergeLiveParts(previous?.detail?.content, item.content),
  };
}

function timing(previous, item, { startedAt, completedAt, observedAt, live, final, freeze, observedLifecycle = false }) {
  const old = previous?.activityTiming ?? {};
  // Lifecycle notifications are idempotent: the first observed endpoints win.
  let start = ms(old.startedAt) ?? ms(startedAt);
  let complete = ms(old.completedAt) ?? ms(completedAt);
  let estimated = !!old.estimated;
  if (complete === null && final && (live || freeze)) {
    complete = observedAt;
    estimated = true;
  }
  // A terminal item in a still-active turn was observed after it ended, so it
  // must never acquire a fictional start timestamp from that turn observation.
  if (start === null && live && !final && complete === null) {
    start = observedAt;
    estimated = true;
  }
  const officialDuration = ms(item?.durationMs);
  const retainedOfficial = ms(previous?._activity?.officialDurationMs);
  if (officialDuration !== null || retainedOfficial !== null) estimated = false;
  else if (observedLifecycle) estimated = true;
  const durationMs = officialDuration ?? retainedOfficial ?? (start !== null && complete !== null
    ? Math.max(0, complete - start) : ms(old.durationMs));
  if (start === null && complete === null && durationMs === null && !previous?.activityTiming) return null;
  return { startedAt: start, completedAt: complete, durationMs, observedAt, estimated };
}

// Event merges and snapshots deliberately have different precedence. A final
// item replaces provisional state; an in-progress read only extends it.
export function mergeActivityItem(previous, item, turnId, {
  startedAt = null,
  completedAt = null,
  observedAt = Date.now(),
  live = false,
  terminal = false,
  source = "snapshot",
} = {}) {
  const final = terminal || terminalStatuses.has(item?.status);
  if (isTerminal(previous) && !final) return previous;
  const old = previous ?? provisional(item.id, item.type, turnId);
  const preserveLive = !final;
  const detail = preserveLive ? liveSnapshotDetail(old, item) : item;
  const snapshotText = conversationText(detail);
  const text = detail.type === "reasoning" ? snapshotText
    : preserveLive ? longerLiveValue(old.text ?? "", snapshotText) : snapshotText;
  const output = item.aggregatedOutput != null
    ? preserveLive ? longerLiveValue(old.output ?? "", item.aggregatedOutput) : item.aggregatedOutput
    : old.output ?? "";
  const finalObservedAt = isTerminal(previous)
    ? previous.activityTiming?.observedAt ?? previous._activity?.observedAt ?? observedAt
    : observedAt;
  // An item/started event seeds a missing stream. Ordinary snapshots keep the
  // prior event base even when their displayed content is farther ahead.
  const seedEventStream = source === "event" && startedAt !== null && !old._activity?.stream;
  const stream = final ? streamFrom({ text, output, detail })
    : !previous || seedEventStream ? streamFrom({ text, output, detail }) : streamFor(previous);
  return {
    ...old,
    id: item.id,
    kind: item.type,
    turnId,
    text,
    phase: item.phase ?? null,
    detail,
    output,
    activityTiming: timing(old, item, { startedAt, completedAt, observedAt: finalObservedAt, live, final, freeze: false,
      observedLifecycle: source === "event" && (startedAt !== null || completedAt !== null) }),
    _activity: internal(old, { terminal: final, observedAt: finalObservedAt, stream,
      officialDurationMs: ms(item?.durationMs) }),
  };
}

export function applyActivityEvent(previous, method, params, observedAt = Date.now()) {
  const itemId = params?.itemId ?? params?.item?.id;
  if (!itemId) return null;
  const turnId = params.turnId ?? previous?.turnId ?? null;
  const completed = method === "item/completed";
  const started = method === "item/started";
  if (params.item) return mergeActivityItem(previous, params.item, turnId, {
    startedAt: started ? params.startedAtMs ?? observedAt : null,
    completedAt: completed ? params.completedAtMs ?? observedAt : null,
    observedAt,
    live: started,
    terminal: completed,
    source: "event",
  });
  if (!method.startsWith("item/") || isTerminal(previous)) return previous ?? null;
  const kind = method === "item/plan/delta" ? "plan"
    : method.startsWith("item/reasoning/") ? "reasoning"
    : method === "item/fileChange/outputDelta" ? "fileChange"
    : method === "item/agentMessage/delta" ? "agentMessage"
    : "commandExecution";
  const old = previous ?? provisional(itemId, kind, turnId);
  const stream = streamFor(old);
  let detail = { ...old.detail };
  let text = old.text ?? "", output = old.output ?? "";
  if (["item/agentMessage/delta", "item/plan/delta"].includes(method)) {
    stream.text += params.delta ?? "";
    text = reconcileStreamValue(text, stream.text);
  }
  else if (method === "item/reasoning/summaryPartAdded") {
    const summary = indexed(stream.summary, params.summaryIndex);
    if (!summary) return previous;
    stream.summary = summary;
    detail.summary = reconcileStreamParts(detail.summary, stream.summary);
    detail.content = reconcileStreamParts(detail.content, stream.content);
    text = conversationText(detail);
  } else if (method === "item/reasoning/summaryTextDelta") {
    const summary = indexed(stream.summary, params.summaryIndex, params.delta ?? "");
    if (!summary) return previous;
    stream.summary = summary;
    detail.summary = reconcileStreamParts(detail.summary, stream.summary);
    detail.content = reconcileStreamParts(detail.content, stream.content);
    text = conversationText(detail);
  } else if (method === "item/reasoning/textDelta") {
    const content = indexed(stream.content, params.contentIndex, params.delta ?? "");
    if (!content) return previous;
    stream.content = content;
    detail.summary = reconcileStreamParts(detail.summary, stream.summary);
    detail.content = reconcileStreamParts(detail.content, stream.content);
    text = conversationText(detail);
  } else if (["item/commandExecution/outputDelta", "item/fileChange/outputDelta"].includes(method)) {
    stream.output = (stream.output + (params.delta ?? "")).slice(-outputLimit);
    output = reconcileStreamValue(output, stream.output);
  } else return null;
  return {
    ...old, id: itemId, kind, turnId, text, detail, output,
    activityTiming: timing(old, null, { observedAt, live: true, final: false, freeze: false }),
    _activity: internal(old, { terminal: false, observedAt, stream }),
  };
}

// A terminal turn can omit an already-live item. Mark only the local lifecycle
// terminal; `detail.status` remains the last official item status.
export function freezeActivityItem(previous, observedAt = Date.now()) {
  if (!previous || isTerminal(previous)) return previous;
  return {
    ...previous,
    activityTiming: timing(previous, null, { observedAt, live: false, final: true, freeze: true }),
    _activity: internal(previous, { terminal: true, observedAt }),
  };
}

export function publicConversationItem(item) {
  if (!item) return item;
  const { _activity, activityStorageId: _storageId, activityItemId, activityThreadId, fallbackSynthetic, ...value } = item;
  return activityItemId ? { ...value, id: activityItemId } : value;
}

export function activityNeedsSave(previous, next) {
  if (!next) return false;
  return JSON.stringify(previous) !== JSON.stringify(next);
}
