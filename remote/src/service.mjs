import { randomUUID } from "node:crypto";
import { Codex, reconcileProcess } from "./codex.mjs";
import { permissionOverrides, threadPermissionOverrides } from "./agent-settings.mjs";
import { join } from "node:path";
import { Attachments, messageInput } from "./attachments.mjs";
import { MessageQueue } from "./message-queue.mjs";
import { runTiming } from "./run-timing.mjs";
import {
  now,
  check,
  requestID,
  textInput,
  Fault,
  loadConfig,
} from "./config.mjs";

const busy = (s) => ["running", "waiting", "starting"].includes(s.state);
const supportedRequests = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/tool/requestUserInput",
  "item/permissions/requestApproval",
]);
const resultHint =
  "結果の報告では、分かる範囲で「変更内容」「検証結果」「未解決事項」を日本語で示してください。未実施の検証や成功を推測で補わないでください。既存のプロジェクト指示を優先してください。";

export class Service {
  constructor(
    store,
    config,
    factory = (cwd) => new Codex(config.codexBin, cwd),
  ) {
    this.store = store;
    this.config = config;
    this.factory = factory;
    this.clients = new Map();
    this.locks = new Map();
    this.catalog = [];
    this.shuttingDown = false;
    this.attachments = new Attachments(store, config.dataDir ? join(config.dataDir, "attachments") : null);
    this.queue = new MessageQueue(this);
  }
  async lock(id, fn) {
    const previous = this.locks.get(id) ?? Promise.resolve();
    let release;
    const held = new Promise((r) => (release = r));
    this.locks.set(id, held);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(id) === held) this.locks.delete(id);
    }
  }
  project(id) {
    const p = this.config.projects.find((p) => p.id === id);
    check(p, "project_missing", "許可されたプロジェクトではありません。");
    return p;
  }
  reloadProjects() {
    check(
      this.config.configFile,
      "config_file",
      "設定ファイルから起動した常駐プログラムが必要です。",
    );
    const next = loadConfig(this.config.configFile);
    check(
      this.config.projects.every((p) =>
        next.projects.some((n) => n.id === p.id && n.path === p.path),
      ),
      "project_removal",
      "動作中のプロジェクトの削除・パス変更はできません。追加のみ即時反映できます。",
      409,
    );
    this.config.projects = next.projects;
    this.store.event(null, "projects", {});
    return { reloaded: true, count: next.projects.length };
  }
  recover() {
    this.store.transaction(() => {
      this.store.db
        .prepare(
          "UPDATE requests SET status='unknown',result=? WHERE status='dispatching'",
        )
        .run(
          JSON.stringify({
            message: "受理確認前にサービスが終了しました。自動再送しません。",
          }),
        );
      for (const s of this.store.sessions()) {
        const reconciliation = reconcileProcess(s.process);
        this.store.expireApprovals(s.id);
        if (busy(s))
          this.change(s, {
            state: "stopped",
            error:
              "サービス再起動により中断しました。履歴を確認し、追加指示で再開してください。",
            reconciliation,
            process: null,
            turnId: null,
          });
        else this.store.saveSession({ ...s, process: null, reconciliation });
      }
    });
  }
  change(s, patch) {
    const next = { ...s, ...patch, updatedAt: now() };
    const event = this.store.event(s.id, "session", {});
    next.lastEventSeq = event.seq;
    this.store.saveSession(next);
    return next;
  }
  async client(s) {
    let c = this.clients.get(s.id);
    if (c?.alive) return c;
    c = this.factory(this.project(s.projectId).path);
    this.clients.set(s.id, c);
    c.on("message", (m) => {
      try {
        this.handle(s.id, c, m);
      } catch {
        this.closeSession(
          s.id,
          "イベントの保存に失敗しました。Codexを停止しました。",
        );
        c.stop();
      }
    });
    c.on("closed", () => {
      if (this.clients.get(s.id) === c) {
        this.clients.delete(s.id);
        this.closeSession(s.id, "Codexプロセスとの接続が終了しました。");
      }
    });
    await c.start();
    this.store.saveSession({ ...this.store.session(s.id), process: c.record });
    if (s.threadId) {
      const r = await c.call("thread/resume", {
        threadId: s.threadId,
        cwd: this.project(s.projectId).path,
        ...threadPermissionOverrides(s.permissionLevel),
      });
      this.importTurns(s.id, r.thread?.turns ?? []);
    }
    return c;
  }
  async control() {
    if (this.controlClient?.alive) return this.controlClient;
    if (!this.controlStarting)
      this.controlStarting = (async () => {
        const c = this.factory(this.config.projects[0].path);
        c.on("message", (m) => {
          if (m.method && m.id != null)
            c.send({
              id: m.id,
              error: { code: -32601, message: "Unsupported control request" },
            });
        });
        await c.start();
        this.controlClient = c;
        return c;
      })().finally(() => {
        this.controlStarting = null;
      });
    return this.controlStarting;
  }
  async models() {
    const c = await this.control();
    let cursor = null;
    const all = [];
    do {
      const r = await c.call("model/list", { limit: 100, cursor });
      all.push(...r.data);
      cursor = r.nextCursor;
    } while (cursor);
    this.catalog = all.filter((m) => !m.hidden);
    return this.catalog;
  }
  async validateModel(model, effort) {
    if (!model && !effort) return;
    if (!this.catalog.length) await this.models();
    const m = this.catalog.find((x) => x.model === model);
    check(m, "model", "利用可能なモデルから選んでください。");
    check(
      !effort ||
        m.supportedReasoningEfforts.some((x) => x.reasoningEffort === effort),
      "effort",
      "このモデルで使える推論強度から選んでください。",
    );
  }
  async create(body) {
    requestID(body.requestId);
    const project = this.project(body.projectId);
    textInput(body.name, 100);
    return this.lock(body.requestId, async () => {
      const id = body.requestId;
      if (!this.store.claim(id, id, "create", body))
        return this.store.request(id);
      const s = {
        id,
        name: body.name,
        projectId: project.id,
        threadId: null,
        permissionLevel: body.permissionLevel || null,
        state: "stopped",
        turnId: null,
        archived: false,
        latest: "",
        createdAt: now(),
        updatedAt: now(),
        lastEventSeq: 0,
        error: null,
      };
      this.store.saveSession(s);
      try {
        const c = await this.client(s);
        const r = await c.call("thread/start", {
          cwd: project.path,
          ...threadPermissionOverrides(body.permissionLevel),
        });
        this.change(this.store.session(id), {
          threadId: r.thread.id,
          state: "stopped",
          model: r.model ?? null,
          effort: r.reasoningEffort ?? null,
          mode: "default",
        });
        return this.store.finishRequest(id, "accepted", { sessionId: id });
      } catch (e) {
        this.change(this.store.session(id), {
          state: "failed",
          error: e.message,
        });
        return this.store.finishRequest(
          id,
          e.code === "codex_rejected" ? "rejected" : "unknown",
          { message: e.message },
        );
      }
    });
  }
  async steer(id, body) {
    requestID(body.requestId);
    return this.lock(id, async () => {
      const old = this.store.request(body.requestId);
      if (old) { this.store.claim(body.requestId, id, "steer", body); return old; }
      const s = this.store.session(id);
      check(body.expectedThreadId === s.threadId, "stale_thread", "会話が変更されました。", 409);
      check(body.expectedTurnId && body.expectedTurnId === s.turnId && busy(s), "stale_turn", "対象の応答は終了しています。", 409);
      const c = this.clients.get(id);
      check(c?.alive, "codex_offline", "実行中のCodexとの接続を確認してください。", 409);
      check(!this.store.db.prepare("SELECT id FROM requests WHERE session=? AND kind IN ('turn','steer') AND status IN ('unknown','dispatching')").get(id),
        "unknown_request", "以前の送信結果を確認してください。", 409);
      const input = messageInput(this.attachments, body, id, s.threadId);
      this.store.claim(body.requestId, id, "steer", body);
      try {
        const result = await c.call("turn/steer", { threadId: s.threadId, expectedTurnId: body.expectedTurnId, clientUserMessageId: body.requestId, input });
        return this.store.finishRequest(body.requestId, "accepted", { sessionId: id, turnId: result.turnId });
      } catch (e) {
        return this.store.finishRequest(body.requestId, e.code === "codex_rejected" ? "rejected" : "unknown", { message: e.message });
      }
    });
  }
  async send(id, body) {
    requestID(body.requestId);
    return this.lock(id, async () => {
      const old = this.store.request(body.requestId);
      if (old) {
        this.store.claim(body.requestId, id, "turn", body);
        return old;
      }
      let s = this.store.session(id);
      check(!body.expectedThreadId || body.expectedThreadId === s.threadId, "stale_thread", "会話が変わりました。再同期してください。", 409);
      const input = messageInput(this.attachments, body, id, s.threadId);
      check(
        s.threadId,
        "unmanaged",
        "この作業は再開できません。新規作業を作成してください。",
        409,
      );
      check(
        !busy(s),
        "busy",
        "実行中の入力は下書きとして保持してください。",
        409,
      );
      check(
        !this.store.db
          .prepare(
            "SELECT id FROM requests WHERE session=? AND status='unknown' AND kind IN ('turn','steer')",
          )
          .get(id),
        "unknown_request",
        "受理不明の指示があります。履歴を確認し、受理確認を解決してください。",
        409,
      );
      await this.validateModel(body.model, body.effort);
      const permissions = permissionOverrides(body.permissionLevel || s.permissionLevel);
      check(
        !body.mode || ["default", "plan"].includes(body.mode),
        "mode",
        "実装または相談モードを選んでください。",
      );
      let collaborationMode;
      if (
        body.mode === "plan" ||
        (s.mode === "plan" && body.mode === "default")
      ) {
        if (!this.catalog.length) await this.models();
        const model =
          body.model ||
          s.model ||
          this.catalog.find((x) => x.isDefault)?.model ||
          this.catalog[0]?.model;
        check(model, "model", "モードの切替にはモデル一覧が必要です。");
        collaborationMode = {
          mode: body.mode,
          settings: {
            model,
            reasoning_effort: body.effort || s.effort || null,
            developer_instructions: null,
          },
        };
      }
      const c = await this.client(s);
      // Resume has completed before claiming. A failed resume never dispatches input.
      this.store.transaction(() => {
        this.store.claim(body.requestId, id, "turn", body);
        s = this.change(this.store.session(id), {
          state: "starting",
          runTiming: null,
          error: null,
          pendingRequestId: body.requestId,
        });
      });
      try {
        const first = this.store.items(id).length === 0;
        if (first) input[0].text += `\n\n${resultHint}`;
        const r = await c.call("turn/start", {
          ...permissions,
          threadId: s.threadId,
          clientUserMessageId: body.requestId,
          input,
          ...(body.model ? { model: body.model } : {}),
          ...(body.effort ? { effort: body.effort } : {}),
          ...(collaborationMode ? { collaborationMode } : {}),
        });
        const current = this.store.session(id);
        this.change(current, {
          pendingRequestId: null,
          ...(current.state === "starting"
            ? { state: "running", turnId: r.turn.id, runTiming: runTiming(r.turn, current.runTiming, { startedAt: now() }) }
            : {}),
          model: body.model || current.model,
          effort: body.effort || current.effort,
          mode: body.mode || current.mode || "default",
          permissionLevel: body.permissionLevel || current.permissionLevel,
        });
        return this.store.finishRequest(body.requestId, "accepted", {
          sessionId: id,
          turnId: r.turn.id,
        });
      } catch (e) {
        // A turn/started event can reach us before a lost/timed-out RPC reply.
        // Its durable receipt is authoritative and must never be downgraded.
        const receipt = this.store.request(body.requestId);
        if (receipt?.status === "accepted") return receipt;
        const known = e.code === "codex_rejected";
        this.change(this.store.session(id), {
          state: known ? "failed" : "stopped",
          error: e.message,
        });
        return this.store.finishRequest(
          body.requestId,
          known ? "rejected" : "unknown",
          { message: e.message },
        );
      }
    });
  }
  async interrupt(id, body) {
    requestID(body.requestId);
    return this.lock(id, async () => {
      if (this.store.request(body.requestId)) {
        this.store.claim(body.requestId, id, "interrupt", body);
        return this.store.request(body.requestId);
      }
      const s = this.store.session(id),
        c = this.clients.get(id);
      check(
        c?.alive && s.turnId && s.turnId === body.turnId && busy(s),
        "stale_turn",
        "対象ターンは既に終了しています。",
        409,
      );
      this.store.claim(body.requestId, id, "interrupt", body);
      try {
        await c.call("turn/interrupt", {
          threadId: s.threadId,
          turnId: s.turnId,
        });
        return this.store.finishRequest(body.requestId, "accepted", {});
      } catch (e) {
        return this.store.finishRequest(body.requestId, "unknown", {
          message: e.message,
        });
      }
    });
  }
  async answer(id, approvalId, body) {
    requestID(body.requestId);
    return this.lock(id, async () => {
      const identity = { approvalId, body };
      if (this.store.request(body.requestId)) {
        this.store.claim(body.requestId, id, "answer", identity);
        return this.store.request(body.requestId);
      }
      const a = this.store.approval(approvalId),
        s = this.store.session(id),
        c = this.clients.get(id);
      check(
        a.sessionId === id &&
          a.status === "pending" &&
          a.turnId === s.turnId &&
          a.generation === c?.record.owner &&
          c?.alive &&
          busy(s),
        "stale_approval",
        "この確認要求は期限切れです。現在の状態を同期してください。",
        409,
      );
      let result;
      if (a.method === "item/tool/requestUserInput") {
        check(
          body.answers && typeof body.answers === "object",
          "answers",
          "回答が必要です。",
        );
        result = { answers: {} };
        for (const q of a.params.questions) {
          textInput(body.answers[q.id], 10000);
          result.answers[q.id] = { answers: [body.answers[q.id]] };
        }
      } else if (a.method === "item/permissions/requestApproval") {
        check(
          ["accept", "decline"].includes(body.decision),
          "decision",
          "回答が不正です。",
        );
        result = {
          permissions: body.decision === "accept" ? a.params.permissions : {},
          scope: "turn",
        };
      } else {
        check(
          ["accept", "decline", "cancel"].includes(body.decision),
          "decision",
          "回答が不正です。",
        );
        result = { decision: body.decision };
      }
      this.store.transaction(() => {
        this.store.claim(body.requestId, id, "answer", identity);
        this.store.saveApproval({ ...a, status: "dispatching" });
      });
      try {
        c.send({ id: a.rpcId, result });
        // JSON-RPC responses have no response of their own. Persist "answered";
        // serverRequest/resolved or a later terminal event invalidates the prompt.
        this.store.saveApproval({ ...a, status: "answered" });
        this.change(this.store.session(id), {
          state: this.store.pending(id).some((x) => x.blocking)
            ? "waiting"
            : "running",
        });
        return this.store.finishRequest(body.requestId, "accepted", {
          written: true,
          resolved: false,
        });
      } catch (e) {
        return this.store.finishRequest(body.requestId, "unknown", {
          message: e.message,
        });
      }
    });
  }
  handle(id, c, m) {
    if (this.clients.get(id) !== c) return;
    const p = m.params ?? {};
    let s = this.store.session(id);
    if (p.threadId && s.threadId && p.threadId !== s.threadId) return;
    if (m.method === "thread/started" && !s.threadId) {
      this.change(s, { threadId: p.thread.id });
      return;
    }
    if (m.id != null && m.method) {
      if (!supportedRequests.has(m.method)) {
        c.send({
          id: m.id,
          error: {
            code: -32601,
            message:
              "Nock does not support this request. No approval was granted.",
          },
        });
        this.store.event(id, "unsupported_request", { method: m.method });
        return;
      }
      if (s.turnId && p.turnId !== s.turnId) {
        c.send({ id: m.id, error: { code: -32600, message: "Stale turn" } });
        return;
      }
      const approvalId = `${c.record.owner}:${m.id}`;
      if (
        this.store.db
          .prepare("SELECT id FROM approvals WHERE id=?")
          .get(approvalId)
      )
        return;
      this.store.transaction(() => {
        const a = {
          id: approvalId,
          sessionId: id,
          generation: c.record.owner,
          rpcId: m.id,
          turnId: p.turnId,
          method: m.method,
          params: p,
          status: "pending",
          blocking: p.isBlocking !== false,
          createdAt: now(),
        };
        this.store.saveApproval(a);
        s = this.change(s, {
          state: a.blocking ? "waiting" : "running",
          turnId: p.turnId,
        });
        const event = this.store.event(
          id,
          "approval",
          { approvalId },
          `approval:${approvalId}`,
        );
        if (event)
          this.store.enqueue(
            event,
            s,
            "waiting",
            this.project(s.projectId).name,
          );
      });
      return;
    }
    if (p.turnId && s.turnId && p.turnId !== s.turnId) return;
    this.store.transaction(() => {
      if (m.method === "turn/started") {
        // Only Nock owns this app-server, and send() serializes one dispatch
        // per session. Bind the start event to that journal entry, not to a
        // guessed equality between public item IDs and clientUserMessageId.
        const receipt =
          s.pendingRequestId && this.store.request(s.pendingRequestId);
        if (receipt && ["dispatching", "unknown"].includes(receipt.status)) {
          this.store.finishRequest(receipt.id, "accepted", {
            sessionId: id,
            turnId: p.turn.id,
            evidence: "turn/started",
          });
        }
        this.change(s, {
          state: "running",
          turnId: p.turn.id,
          runTiming: runTiming(p.turn, s.runTiming, { startedAt: now() }),
          error: null,
          pendingRequestId: null,
        });
      } else if (m.method === "turn/completed") {
        if (s.turnId && s.turnId !== p.turn.id) return;
        const event = this.store.event(
          id,
          "turn/completed",
          { turnId: p.turn.id, status: p.turn.status },
          `turn:${id}:${p.turn.id}`,
        );
        if (!event) return;
        this.importTurns(id, [p.turn]);
        this.store.expireApprovals(id);
        const state =
          { completed: "completed", failed: "failed", interrupted: "stopped" }[
            p.turn.status
          ] ?? "stopped";
        s = this.change(this.store.session(id), {
          state,
          turnId: null,
          runTiming: runTiming(p.turn, s.runTiming, { completedAt: now() }),
          error: p.turn.error?.message ?? null,
        });
        if (["completed", "failed"].includes(state))
          this.store.enqueue(event, s, state, this.project(s.projectId).name);
      } else if (["item/started", "item/completed"].includes(m.method)) {
        this.saveCodexItem(id, p.turnId, p.item);
      } else if (m.method === "item/agentMessage/delta") {
        const old = this.store.item(id, p.itemId) ?? {
          id: p.itemId,
          kind: "agentMessage",
          text: "",
          turnId: p.turnId,
        };
        const item = this.store.saveItem(id, {
          ...old,
          text: old.text + p.delta,
        });
        const ev = this.store.event(id, "item", { itemId: item.id });
        this.store.saveSession({
          ...s,
          latest: item.text.slice(-180),
          updatedAt: now(),
          lastEventSeq: ev.seq,
        });
      } else if (
        [
          "item/commandExecution/outputDelta",
          "item/fileChange/outputDelta",
        ].includes(m.method)
      ) {
        const old = this.store.item(id, p.itemId) ?? {
          id: p.itemId,
          kind: "commandExecution",
          text: "",
          turnId: p.turnId,
        };
        this.store.saveItem(id, {
          ...old,
          output: ((old.output ?? "") + p.delta).slice(-100000),
        });
        this.store.event(id, "item", { itemId: p.itemId });
      } else if (m.method === "serverRequest/resolved") {
        const key = `${c.record.owner}:${p.requestId}`;
        const row = this.store.db
          .prepare("SELECT data FROM approvals WHERE id=?")
          .get(key);
        if (row) {
          this.store.saveApproval({
            ...JSON.parse(row.data),
            status: "resolved",
          });
          this.change(s, {
            state: this.store.pending(id).some((a) => a.blocking)
              ? "waiting"
              : busy(s)
                ? "running"
                : s.state,
          });
        }
      } else if (m.method === "error") {
        this.store.event(id, "error", {
          message: p.error?.message ?? "Codexエラー",
          willRetry: !!p.willRetry,
        });
        if (!p.willRetry)
          this.change(s, { error: p.error?.message ?? "Codexエラー" });
      } else if (["turn/plan/updated", "warning"].includes(m.method))
        this.store.event(id, m.method, p);
    });
  }
  saveCodexItem(id, turnId, item) {
    if (!item?.id) return;
    const text =
      item.text ??
      (item.type === "userMessage"
        ? (item.content ?? [])
            .filter((x) => x.type === "text")
            .map((x) => x.text)
            .join("\n")
        : "");
    const previous = this.store.item(id, item.id);
    this.store.saveItem(id, {
      id: item.id,
      turnId,
      kind: item.type,
      text,
      phase: item.phase ?? null,
      detail: item,
      output: item.aggregatedOutput ?? previous?.output ?? "",
    });
    const ev = this.store.event(id, "item", { itemId: item.id });
    const s = this.store.session(id);
    this.store.saveSession({
      ...s,
      latest: text ? text.slice(-180) : s.latest,
      updatedAt: now(),
      lastEventSeq: ev.seq,
    });
  }
  importTurns(id, turns) {
    for (const t of turns)
      for (const item of t.items ?? []) this.saveCodexItem(id, t.id, item);
    if (turns.length) {
      const s = this.store.session(id);
      this.store.saveSession({ ...s, runTiming: runTiming(turns.at(-1), s.runTiming) });
    }
  }
  closeSession(id, message) {
    this.store.transaction(() => {
      const s = this.store.session(id);
      this.store.expireApprovals(id);
      if (busy(s)) {
        const next = this.change(s, {
          state: this.shuttingDown ? "stopped" : "failed",
          turnId: null,
          process: null,
          error: message,
        });
        const ev = this.store.event(id, "process/closed", {});
        if (!this.shuttingDown)
          this.store.enqueue(
            ev,
            next,
            "failed",
            this.project(s.projectId).name,
          );
      } else this.store.saveSession({ ...s, process: null });
    });
  }
  detail(id, before, limit) {
    const s = this.store.session(id);
    return {
      session: s,
      items: this.store.items(id, before, limit),
      approvals: this.store.pending(id),
      requests: this.store.db
        .prepare(
          "SELECT id FROM requests WHERE session=? AND status IN ('unknown','dispatching')",
        )
        .all(id)
        .map((r) => this.store.request(r.id)),
    };
  }
  archive(id, value) {
    return this.change(this.store.session(id), { archived: !!value });
  }
  stopProcess(id) {
    this.store.expireApprovals(id);
    const s = this.change(this.store.session(id), {
      state: "stopped",
      turnId: null,
      process: null,
    });
    this.clients.get(id)?.stop();
    return s;
  }
  async readHistory(threadId) {
    const c = await this.control();
    const result = await c.call("thread/read", {
      threadId,
      includeTurns: true,
    });
    check(
      this.config.projects.some((p) => p.path === result.thread.cwd),
      "history_scope",
      "登録プロジェクト外の履歴です。",
      403,
    );
    return result;
  }
  async history(projectId, cursor) {
    const p = this.project(projectId);
    const c = await this.control();
    return c.call("thread/list", {
      cwd: p.path,
      cursor: cursor ?? null,
      limit: 30,
      sortKey: "updated_at",
    });
  }
  async reconcileRequest(id) {
    const r = this.store.request(id);
    check(r, "request_missing", "要求が見つかりません。", 404);
    if (r.status !== "unknown" || r.kind !== "turn") return r;
    const s = this.store.session(r.sessionId);
    if (s.threadId) {
      const c = await this.control();
      const h = await c.call("thread/read", {
        threadId: s.threadId,
        includeTurns: true,
      });
      this.importTurns(s.id, h.thread.turns ?? []);
      // This pinned protocol does not promise that item.id equals the client
      // request ID. Import history for human review, but never infer acceptance
      // from text, timing, or an incidental matching item ID.
    }
    return r; // absence in a partial history is never permission to replay
  }
  close() {
    this.shuttingDown = true;
    this.queue.close();
    for (const c of this.clients.values()) c.stop();
    this.controlClient?.stop();
  }
}
