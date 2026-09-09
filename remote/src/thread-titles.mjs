// Naming is required to materialize an empty rollout for `codex resume --remote`.
// Replace this bootstrap name once Codex has a real user-message preview.
export const EMPTY_THREAD_NAME = "新しい会話";
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function rememberedThreads(records) {
  const threads = new Map();
  for (const record of records) {
    for (const entry of [record, ...(record.contexts ?? []), ...(record.history ?? [])]) {
      if (entry.threadId && !threads.has(entry.threadId)) threads.set(entry.threadId, entry);
    }
  }
  return threads;
}

export function isBootstrapName(name) {
  return name === EMPTY_THREAD_NAME;
}

export function suggestedThreadName(thread, record) {
  if (!record || !isBootstrapName(thread.name)) return null;
  // The preview is Codex's first user message, including for unloaded or
  // compacted threads. Never use a tab label or the most recent follow-up.
  const preview = (thread.preview ?? "").replace(/<image\b[^>]*>[\s\S]*?<\/image>/gi, "")
    .replace(/\[Image #\d+\]/g, "").replace(/[\x00-\x1f\x7f\s]+/g, " ").trim();
  if (!preview || isBootstrapName(preview)) return null;
  const parts = Array.from(graphemes.segment(preview), (part) => part.segment);
  const name = parts.length > 80 ? parts.slice(0, 79).join("").trimEnd() + "…" : preview;
  return name === thread.name ? null : name;
}

export class ThreadTitles {
  constructor(workspace) { this.workspace = workspace; this.pending = new Map(); }
  async update(client, thread) {
    const record = rememberedThreads(this.workspace.records()).get(thread.id);
    const name = suggestedThreadName(thread, record);
    if (!name || this.workspace.closed) return thread;
    let pending = this.pending.get(thread.id);
    if (!pending) {
      pending = client.call("thread/name/set", { threadId: thread.id, name }, 8000).then(() => name);
      this.pending.set(thread.id, pending);
    }
    try { return { ...thread, name: await pending }; }
    finally { if (this.pending.get(thread.id) === pending) this.pending.delete(thread.id); }
  }
}
