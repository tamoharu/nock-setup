import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { check, requestID, textInput, now, migrationCwd } from "./config.mjs";
import { threadState } from "./workspace.mjs";
import { permissionOverrides } from "./agent-settings.mjs";
import { messageInput } from "./attachments.mjs";
import { runTiming } from "./run-timing.mjs";
import { activityNeedsSave, activityStorageId, applyActivityEvent, conversationText, freezeActivityItem, mergeActivityItem, publicConversationItem } from "./conversation-activity.mjs";
import { subagentPage, subagentReferences } from "./subagent-history.mjs";

function fallbackMessageMatches(kind, snapshot, observed, item) {
  if (snapshot === observed) return true;
  // Only a still-streaming agent message has prefix-compatible text. Final
  // messages that happen to share a prefix are distinct messages.
  const terminal = item?._activity?.terminal || ["completed", "failed", "declined", "interrupted"].includes(item?.detail?.status ?? item?.status);
  return kind === "agentMessage" && !terminal && snapshot.length > 0 && observed.length > 0 &&
    (snapshot.startsWith(observed) || observed.startsWith(snapshot));
}

// Legacy thread/read reconstructs message IDs as item-N, while live events
// carry UUID/msg_ identities. Both describe the same messages in the same turn.
const legacyMessageID = (id) => /^item-\d+$/.test(id ?? "");

// A second UI for the existing shared app-server thread; never forks a rollout.
export class SharedChat {
  constructor(workspace) {
    this.workspace = workspace;
    this.store = workspace.store;
    this.approvals = new Map();
    this.locks = new Map();
  }
  record(id) {
    const t = this.workspace.record(id);
    check(t?.threadId, "chat_unavailable", "この端末はチャット未連携です。ターミナルから操作してください。", 404);
    return t;
  }
  requests(id) {
    return this.store.db.prepare("SELECT id FROM requests WHERE session=? AND (kind LIKE 'shared%' OR kind LIKE 'pathTab:%') AND status IN ('unknown','dispatching')")
      .all(id).map((r) => this.store.request(r.id));
  }
  async exclusive(id, operation) {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(operation);
    this.locks.set(id, task);
    try { return await task; } finally { if (this.locks.get(id) === task) this.locks.delete(id); }
  }
  onMessage(m, client) {
    const threadId = m.params?.threadId;
    const t = this.workspace.recordForThread(threadId);
    if (!t || t.closedAt) return;
    this.store.progress.observe(t, m);
    if ([
      "item/started",
      "item/completed",
      "item/agentMessage/delta",
      "item/plan/delta",
      "item/reasoning/summaryTextDelta",
      "item/reasoning/summaryPartAdded",
      "item/reasoning/textDelta",
      "item/commandExecution/outputDelta",
      "item/fileChange/outputDelta",
    ].includes(m.method)) this.saveLiveItem(t, m.method, m.params ?? {});
    else if (m.method === "turn/completed") this.freezeLiveTurn(t, m.params?.turn, now());
    if (m.id !== undefined) {
      if ([...this.approvals.values()].some((a) => a.client === client && a.rpcId === m.id)) return;
      const id = randomUUID();
      this.approvals.set(id, { id, sessionId: t.id, turnId: m.params.turnId ?? "", method: m.method,
        params: m.params, status: "pending", blocking: m.params.isBlocking !== false, rpcId: m.id, client });
      this.store.transaction(() => {
        const event = this.store.event(t.id, "approval", { approvalId: id }, `shared-approval:${id}`);
        this.workspace.save({ ...t, state: m.params.isBlocking === false ? t.state : "waiting", waitingSource: "approval", updatedAt: now() });
        if (event && !(t.state === "waiting" && t.waitingSource === "status"))
          this.store.enqueue(event, t, "waiting", basename(t.directory ?? "") || t.spaceName || "作業");
      });
    } else if (m.method === "serverRequest/resolved") {
      for (const [id, a] of this.approvals)
        if (a.client === client && a.rpcId === m.params.requestId) this.approvals.delete(id);
    }
  }
  async readStatus(c, threadId) {
    return (await c.call("thread/read", { threadId, includeTurns: false }, 8000)).thread;
  }
  async readThread(c, threadId) {
    try { return (await c.call("thread/read", { threadId, includeTurns: true }, 8000)).thread; }
    catch (e) {
      if (e.code !== "codex_rejected") throw e;
      if (e.message.includes("not materialized yet")) {
        const { thread } = await c.call("thread/read", { threadId, includeTurns: false }, 8000);
        Object.defineProperty(thread, "_hatiHistoryLimited", { value: true });
        return thread;
      }
      if (!e.message.includes("list_turns is not supported yet")) throw e;
      const { thread } = await c.call("thread/read", { threadId, includeTurns: false }, 8000);
      // 0.153.4 can create paginated histories while its list API is unavailable.
      // Read only the registered thread's structured rollout; never parse terminal text.
      const fallback = { ...thread, turns: await readRolloutTurns(thread) };
      Object.defineProperty(fallback, "_hatiRolloutFallback", { value: true });
      return fallback;
    }
  }
  async detail(id, before = Number.MAX_SAFE_INTEGER) {
    const t = this.record(id), c = await this.workspace.shared();
    check(c?.alive, "codex_offline", "共有Codexに再接続してください。", 503);
    const thread = await this.readThread(c, t.threadId);
    // A path tab may have switched while thread/read was pending. Re-read its
    // current identity before touching the persistent event overlay.
    if (this.record(id).threadId !== t.threadId) return this.detail(id, before);
    const observedAt = now();
    // Query just this thread's overlays. Store.items() intentionally paginates
    // normal history, but a latest-N overlay would lose old item timing.
    const persisted = this.store.db.prepare("SELECT data FROM items WHERE session=? AND json_extract(data,'$.activityThreadId')=? ORDER BY position")
      .all(id, t.threadId).map((row) => JSON.parse(row.data))
      .map((item) => ({ ...item, id: item.activityItemId ?? item.id }));
    const byKey = new Map(persisted.map((item) => [item.activityStorageId, item]));
    const items = [];
    const remaining = new Map(persisted.map((item) => [item.activityStorageId, item]));
    for (const turn of thread.turns ?? []) {
      const turnItems = [];
      const anchors = [];
      const fallback = this.reconcileFallbackMessages(turn, persisted, !!thread._hatiRolloutFallback);
      // A reconstructed snapshot can have been persisted while its turn was live.
      // Once a real event supplies the canonical id, remove that private row
      // so it cannot be appended after the reconciled item below.
      for (const synthetic of fallback.retiredSynthetic) {
        this.store.db.prepare("DELETE FROM items WHERE session=? AND id=?").run(id, synthetic.activityStorageId);
        byKey.delete(synthetic.activityStorageId);
        remaining.delete(synthetic.activityStorageId);
      }
      const fallbackItems = fallback.items;
      for (const item of fallbackItems) {
        const key = activityStorageId(t.threadId, item.id);
        const previous = byKey.get(key);
        remaining.delete(key);
        const next = mergeActivityItem(previous, item, turn.id, {
          observedAt,
          live: turn.status === "inProgress",
          terminal: ["completed", "failed", "interrupted"].includes(turn.status),
          source: "snapshot",
        });
        // Store only live observations and replacements of an existing event;
        // a polling read never rewrites an entire historical thread.
        if ((previous || turn.status === "inProgress") && activityNeedsSave(previous, next)) {
          // Keep snapshot provenance so a later live event can retire this
          // synthetic observation. It is stripped before public API output.
          const saved = (thread._hatiRolloutFallback || legacyMessageID(item.id)) && !previous
            ? { ...next, fallbackSynthetic: true } : next;
          this.saveStoredItem(t, key, saved);
        }
        anchors.push({ item: publicConversationItem(next), position: previous?.position ?? null });
      }
      // A terminal turn can omit an outstanding live item. Freeze it without
      // changing the official item status or claiming a file edit succeeded.
      for (const [key, previous] of [...remaining]) if (previous.turnId === turn.id) {
        remaining.delete(key);
        const next = ["completed", "failed", "interrupted"].includes(turn.status)
          ? freezeActivityItem(previous, observedAt) : previous;
        if (activityNeedsSave(previous, next)) this.saveStoredItem(t, key, next);
        const entry = publicConversationItem(next);
        const index = anchors.findIndex((anchor) => anchor.position !== null && previous.position < anchor.position);
        if (index < 0) anchors.push({ item: entry, position: previous.position ?? null });
        else anchors.splice(index, 0, { item: entry, position: previous.position ?? null });
      }
      turnItems.push(...anchors.map((anchor) => anchor.item));
      items.push(...turnItems);
    }
    // thread/read is a full history here. A newly observed turn that is not in
    // its snapshot is newer than the known turns, so it belongs at the tail.
    items.push(...[...remaining.values()].map(publicConversationItem));
    const positioned = items.map((item, index) => ({ ...item, position: index + 1 }));
    const current = this.record(id);
    this.store.progress.reconcile(current, thread.turns?.at(-1));
    return {
      session: { id, name: t.name, projectId: "", threadId: t.threadId,
        turnId: thread.turns?.at(-1)?.id ?? null, state: threadState(thread, t.state),
        model: thread.model ?? t.model ?? null, effort: thread.reasoningEffort ?? t.effort ?? null, mode: "default", error: thread.turns?.at(-1)?.error?.message ?? null,
        permissionLevel: t.permissionLevel ?? null,
        runTiming: runTiming(thread.turns?.at(-1), t.runTiming),
        runProgress: this.store.progress.summary({ ...current, turnId: thread.turns?.at(-1)?.id ?? current.turnId }),
        archived: t.archived, latest: t.latest, updatedAt: t.updatedAt, createdAt: t.updatedAt, lastEventSeq: 0 },
      items: positioned.filter((i) => i.position < before).slice(-200),
      approvals: [...this.approvals.values()].filter((a) => a.sessionId === id && a.client === c && a.status === "pending")
        .map(({ client, rpcId, ...a }) => a),
      requests: this.requests(id),
    };
  }
  parentOverlays(id, threadId) {
    return this.store.db.prepare("SELECT data FROM items WHERE session=? AND json_extract(data,'$.activityThreadId')=? ORDER BY position")
      .all(id, threadId).map((row) => JSON.parse(row.data));
  }
  async subAgentDetail(id, agentThreadId, expectedThreadId, before = Number.MAX_SAFE_INTEGER) {
    check(typeof expectedThreadId === "string" && expectedThreadId.length > 0,
      "expected_thread", "親会話を指定してください。");
    const parent = this.record(id);
    check(parent.threadId === expectedThreadId, "stale_thread", "会話が変更されました。再同期してください。", 409);
    const c = await this.workspace.shared();
    check(c?.alive, "codex_offline", "共有Codexに再接続してください。", 503);
    check(this.record(id).threadId === expectedThreadId, "stale_thread", "会話が変更されました。再同期してください。", 409);
    const thread = await this.readThread(c, expectedThreadId);
    check(this.record(id).threadId === expectedThreadId, "stale_thread", "会話が変更されました。再同期してください。", 409);
    check(thread?.id === expectedThreadId, "stale_thread", "会話が変更されました。再同期してください。", 409);
    const reference = subagentReferences(expectedThreadId, thread, this.parentOverlays(id, expectedThreadId)).get(agentThreadId);
    check(reference, "subagent_reference", "この会話に属するサブエージェントではありません。", 404);
    const child = await this.readThread(c, agentThreadId);
    check(this.record(id).threadId === expectedThreadId, "stale_thread", "会話が変更されました。再同期してください。", 409);
    check(child?.id === agentThreadId, "subagent_reference", "この会話に属するサブエージェントではありません。", 404);
    return subagentPage({ parentThreadId: expectedThreadId, reference, thread: child, before });
  }
  saveStoredItem(tab, key, item) {
    const saved = {
      ...item,
      id: key,
      activityStorageId: key,
      activityItemId: item.id,
      activityThreadId: tab.threadId,
    };
    return this.store.saveItem(tab.id, saved);
  }
  reconcileFallbackMessages(turn, persisted, rollout = true) {
    const isMessage = (item) => ["userMessage", "agentMessage"].includes(item.kind);
    const isSynthetic = (item) => item.fallbackSynthetic || legacyMessageID(item.id);
    const reserved = new Set((turn.items ?? []).filter((item) => !rollout && !legacyMessageID(item.id)).map((item) => item.id));
    const candidates = persisted.filter((item) => item.turnId === turn.id && isMessage(item) && !isSynthetic(item) && !reserved.has(item.id));
    const synthetic = persisted.filter((item) => item.turnId === turn.id && isMessage(item) && isSynthetic(item));
    const cursors = new Map(), syntheticCursors = new Map(), retiredSynthetic = [];
    const nextMatch = (items, cursors, snapshot, snapshotText) => {
      const start = cursors.get(snapshot.type) ?? 0;
      for (let index = start; index < items.length; index++) {
        const observed = items[index];
        if (observed.kind !== snapshot.type || !fallbackMessageMatches(snapshot.type, snapshotText,
          observed.text ?? conversationText(observed.detail), observed)) continue;
        cursors.set(snapshot.type, index + 1);
        return observed;
      }
      return null;
    };
    const items = (turn.items ?? []).map((snapshot) => {
      if (!["userMessage", "agentMessage"].includes(snapshot.type)) return snapshot;
      if (!rollout && !legacyMessageID(snapshot.id)) return snapshot;
      const snapshotText = conversationText(snapshot);
      const observed = nextMatch(candidates, cursors, snapshot, snapshotText);
      if (!observed) return snapshot;
      const obsolete = nextMatch(synthetic, syntheticCursors, snapshot, snapshotText);
      if (obsolete) retiredSynthetic.push(obsolete);
      return {
        ...snapshot,
        ...observed.detail,
        id: observed.id,
        type: observed.kind,
        text: snapshotText,
        phase: snapshot.phase ?? observed.phase ?? null,
      };
    });
    return { items, retiredSynthetic };
  }
  saveLiveItem(tab, method, params) {
    if (params.threadId !== tab.threadId || !params.itemId && !params.item?.id) return;
    const itemId = params.itemId ?? params.item.id;
    const key = activityStorageId(tab.threadId, itemId);
    const stored = this.store.item(tab.id, key);
    const previous = stored && { ...stored, id: stored.activityItemId ?? stored.id };
    const next = applyActivityEvent(previous, method, params, now());
    if (!activityNeedsSave(previous, next)) return;
    this.saveStoredItem(tab, key, next);
  }
  freezeLiveTurn(tab, turn, observedAt) {
    if (!turn || !["completed", "failed", "interrupted"].includes(turn.status)) return;
    const present = new Set((turn.items ?? []).map((item) => item.id));
    const rows = this.store.db.prepare("SELECT data FROM items WHERE session=? AND json_extract(data,'$.activityThreadId')=? AND json_extract(data,'$.turnId')=?")
      .all(tab.id, tab.threadId, turn.id);
    for (const row of rows) {
      const stored = JSON.parse(row.data);
      if (present.has(stored.activityItemId ?? stored.id)) continue;
      const next = freezeActivityItem({ ...stored, id: stored.activityItemId ?? stored.id }, observedAt);
      if (!activityNeedsSave({ ...stored, id: stored.activityItemId ?? stored.id }, next)) continue;
      this.saveStoredItem(tab, stored.activityStorageId, next);
    }
  }
  async mutate(id, action, body, approvalId) {
    requestID(body.requestId);
    const kind = `shared:${action}${approvalId ? ':' + approvalId : ''}`;
    return this.exclusive(id, async () => {
      const t = this.record(id);
      if (this.store.request(body.requestId)) {
        this.store.claim(body.requestId, id, kind, body);
        return this.store.request(body.requestId);
      }
      check(!t.closedAt && !t.closeRequestId, "tab_closed", "タブは終了済み、または終了中です。履歴から再開してください。", 409);
      check((!t.pathTab && body.expectedThreadId === undefined) || body.expectedThreadId === t.threadId, "stale_thread", "会話が切り替わりました。再同期してください。", 409);
      const c = await this.workspace.shared();
      check(c?.alive, "codex_offline", "共有Codexに再接続してください。", 503);
      let method, params, approval;
      if (action === "turns") {
        const input = messageInput(this.workspace.attachments, body, id, t.threadId);
        check(!this.requests(id).length, "unknown_request", "以前の指示の受理結果を履歴で確認してください。", 409);
        const thread = await this.readThread(c, t.threadId);
        check(!["running", "waiting", "unknown"].includes(threadState(thread, t.state)), "busy", "実行中の応答が終わるまでお待ちください。", 409);
        if (body.model) {
          const { data } = await c.call("model/list", {});
          const model = data.find((m) => m.model === body.model);
          check(model, "model", "モデルを選び直してください。");
          check(!body.effort || model.supportedReasoningEfforts.some((e) => e.reasoningEffort === body.effort), "effort", "推論の強さを選び直してください。");
        } else check(!body.effort, "effort", "モデルを先に選んでください。");
        method = "turn/start";
        params = { threadId: t.threadId, clientUserMessageId: body.requestId, input,
          ...migrationCwd(this.workspace.config, thread.cwd),
          ...permissionOverrides(body.permissionLevel ?? t.permissionLevel),
          ...(body.model ? { model: body.model } : {}), ...(body.effort ? { effort: body.effort } : {}) };
      } else if (action === "steer") {
        check(!this.requests(id).length, "unknown_request", "以前の送信結果を確認してください。", 409);
        const input = messageInput(this.workspace.attachments, body, id, t.threadId);
        const thread = await this.readThread(c, t.threadId);
        check(body.expectedTurnId && thread.turns?.at(-1)?.id === body.expectedTurnId && thread.status?.type === "active",
          "stale_turn", "対象の応答は終了しています。通常送信またはキューを選んでください。", 409);
        method = "turn/steer";
        params = { threadId: t.threadId, expectedTurnId: body.expectedTurnId, clientUserMessageId: body.requestId, input };
      } else if (action === "interrupt") {
        const thread = await this.readThread(c, t.threadId);
        check(thread.turns?.at(-1)?.id === body.turnId && thread.status?.type === "active", "stale_turn", "この応答はすでに終了しています。", 409);
        method = "turn/interrupt"; params = { threadId: t.threadId, turnId: body.turnId };
      } else if (action === "approvals") {
        approval = this.approvals.get(approvalId);
        check(approval?.sessionId === id && approval.client === c && approval.status === "pending", "stale_approval", "この確認はすでに回答済み、または期限切れです。", 409);
        if (approval.method === "item/tool/requestUserInput") {
          const answers = {};
          for (const q of approval.params.questions) {
            textInput(body.answers?.[q.id], 100000);
            answers[q.id] = { answers: [body.answers[q.id]] };
          }
          params = { answers };
        } else {
          check(["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(approval.method), "decision", "この確認はターミナルで回答してください。");
          check(["accept", "decline"].includes(body.decision), "decision", "回答を選んでください。");
          params = { decision: body.decision };
        }
      } else check(false, "route", "操作が見つかりません。", 404);
      this.store.claim(body.requestId, id, kind, body);
      try {
        let result;
        if (approval) {
          approval.status = "dispatching";
          c.send({ id: approval.rpcId, result: params });
          result = { answered: true };
        } else result = await c.call(method, params);
        if (action === "turns") this.workspace.save({ ...this.record(id), model: body.model ?? t.model,
          permissionLevel: body.permissionLevel || t.permissionLevel,
          effort: body.effort ?? t.effort, updatedAt: now() });
        return this.store.finishRequest(body.requestId, "accepted", { tabId: id, turnId: result.turn?.id ?? result.turnId });
      } catch (e) {
        return this.store.finishRequest(body.requestId, e.code === "codex_rejected" ? "rejected" : "unknown", { message: e.message });
      }
    });
  }
}


export async function readRolloutTurns(thread) {
  if (!thread.path) return [];
  let info;
  try { info = await stat(thread.path); }
  catch (e) { if (e.code === "ENOENT" && !thread.preview) return []; throw e; }
  check(info.isFile() && info.uid === process.getuid(), "history_file", "会話の保存先を確認できません。", 409);
  const input = createReadStream(thread.path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  const turns = [];
  let current, lineNumber = 0, verified = false;
  try {
    for await (const line of lines) {
      lineNumber++;
      let value;
      try { value = JSON.parse(line); } catch { continue; } // A final line may still be being written.
      const p = value.payload;
      if (value.type === "session_meta") {
        check(p?.id === thread.id, "history_file", "会話の保存先が一致しません。", 409);
        verified = true;
      }
      if (!verified || value.type !== "event_msg") continue;
      const timestamp = Date.parse(value.timestamp);
      const seconds = Number.isFinite(timestamp) ? timestamp / 1000 : null;
      if (p.type === "task_started") {
        current = { id: p.turn_id ?? `rollout-turn-${lineNumber}`, status: "inProgress", items: [], startedAt: seconds };
        turns.push(current);
      }
      if (["user_message", "agent_message"].includes(p.type)) {
        if (!current) { current = { id: `rollout-turn-${lineNumber}`, status: "completed", items: [] }; turns.push(current); }
        current.items.push({ id: `rollout-${lineNumber}`, type: p.type === "user_message" ? "userMessage" : "agentMessage",
          text: p.message ?? "" });
      }
      if (current && ["task_complete", "turn_aborted"].includes(p.type) && (!p.turn_id || current.id === p.turn_id)) {
        current.status = p.type === "task_complete" ? "completed" : "interrupted";
        current.completedAt = seconds;
        if (current.startedAt !== null && current.startedAt !== undefined && seconds !== null)
          current.durationMs = Math.max(0, (seconds - current.startedAt) * 1000);
      }
    }
  } finally { lines.close(); input.destroy(); }
  return turns;
}
