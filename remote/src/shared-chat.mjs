import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { check, requestID, textInput, now } from "./config.mjs";
import { threadState } from "./workspace.mjs";

// A second UI for the existing shared app-server thread; never forks a rollout.
export class SharedChat {
  constructor(workspace) {
    this.workspace = workspace;
    this.store = workspace.store;
    this.approvals = new Map();
    this.locks = new Map();
  }
  record(id) {
    const t = this.workspace.records().find((t) => t.id === id && t.threadId);
    check(t, "chat_unavailable", "この端末はチャット未連携です。ターミナルから操作してください。", 404);
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
    const t = this.workspace.records().find((t) => t.threadId === threadId);
    if (!t) return;
    if (m.id !== undefined) {
      const id = randomUUID();
      this.approvals.set(id, { id, sessionId: t.id, turnId: m.params.turnId ?? "", method: m.method,
        params: m.params, status: "pending", blocking: true, rpcId: m.id, client });
    } else if (m.method === "serverRequest/resolved") {
      for (const [id, a] of this.approvals)
        if (a.client === client && a.rpcId === m.params.requestId) this.approvals.delete(id);
    }
  }
  async readThread(c, threadId) {
    try { return (await c.call("thread/read", { threadId, includeTurns: true }, 8000)).thread; }
    catch (e) {
      if (e.code !== "codex_rejected") throw e;
      if (e.message.includes("not materialized yet"))
        return (await c.call("thread/read", { threadId, includeTurns: false }, 8000)).thread;
      if (!e.message.includes("list_turns is not supported yet")) throw e;
      const { thread } = await c.call("thread/read", { threadId, includeTurns: false }, 8000);
      // 0.153.4 can create paginated histories while its list API is unavailable.
      // Read only the registered thread's structured rollout; never parse terminal text.
      return { ...thread, turns: await readRolloutTurns(thread) };
    }
  }
  async detail(id, before = Number.MAX_SAFE_INTEGER) {
    const t = this.record(id), c = await this.workspace.shared();
    check(c?.alive, "codex_offline", "共有Codexに再接続してください。", 503);
    const thread = await this.readThread(c, t.threadId);
    const items = (thread.turns ?? []).flatMap((turn) => (turn.items ?? []).map((item) => ({
      id: item.id, turnId: turn.id, kind: item.type,
      text: item.text ?? (item.content ?? []).filter((v) => v.type === "text").map((v) => v.text).join("\n"),
      phase: item.phase ?? null, detail: item, output: item.aggregatedOutput ?? "",
    }))).map((item, i) => ({ ...item, position: i + 1 }));
    return {
      session: { id, name: t.name, projectId: "", threadId: t.threadId,
        turnId: thread.turns?.at(-1)?.id ?? null, state: threadState(thread, t.state),
        model: thread.model ?? t.model ?? null, effort: thread.reasoningEffort ?? t.effort ?? null, mode: "default", error: thread.turns?.at(-1)?.error?.message ?? null,
        archived: t.archived, latest: t.latest, updatedAt: t.updatedAt, createdAt: t.updatedAt, lastEventSeq: 0 },
      items: items.filter((i) => i.position < before).slice(-200),
      approvals: [...this.approvals.values()].filter((a) => a.sessionId === id && a.client === c && a.status === "pending")
        .map(({ client, rpcId, ...a }) => a),
      requests: this.requests(id),
    };
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
      check(!t.pathTab || body.expectedThreadId === t.threadId, "stale_thread", "会話が切り替わりました。再同期してください。", 409);
      const c = await this.workspace.shared();
      check(c?.alive, "codex_offline", "共有Codexに再接続してください。", 503);
      let method, params, approval;
      if (action === "turns") {
        textInput(body.text, 100000);
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
        params = { threadId: t.threadId, clientUserMessageId: body.requestId, input: [{ type: "text", text: body.text }],
          ...(body.model ? { model: body.model } : {}), ...(body.effort ? { effort: body.effort } : {}) };
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
          effort: body.effort ?? t.effort, updatedAt: now() });
        return this.store.finishRequest(body.requestId, "accepted", { tabId: id, turnId: result.turn?.id });
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
      if (p.type === "task_started") {
        current = { id: p.turn_id ?? `rollout-turn-${lineNumber}`, status: "inProgress", items: [] };
        turns.push(current);
      }
      if (["user_message", "agent_message"].includes(p.type)) {
        if (!current) { current = { id: `rollout-turn-${lineNumber}`, status: "completed", items: [] }; turns.push(current); }
        current.items.push({ id: `rollout-${lineNumber}`, type: p.type === "user_message" ? "userMessage" : "agentMessage",
          text: p.message ?? "" });
      }
      if (current && p.type === "task_complete") current.status = "completed";
      if (current && p.type === "turn_aborted") current.status = "interrupted";
    }
  } finally { lines.close(); input.destroy(); }
  return turns;
}
