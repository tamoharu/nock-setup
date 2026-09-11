import { check, now, requestID } from "./config.mjs";

const samePane = (a, b) => a.paneId === b.paneId && a.panePid === b.panePid && a.epoch === b.epoch;

// Closing a shared tab is a durable, explicitly requested operation. Never
// terminate the shared app-server, a sibling pane, or a replacement incarnation.
export class TabLifecycle {
  constructor(workspace) {
    this.w = workspace;
    this.store = workspace.store;
    this.store.db.exec("CREATE TABLE IF NOT EXISTS workspace_closes(id TEXT PRIMARY KEY, data TEXT NOT NULL)");
  }
  save(plan) {
    this.store.db.prepare("INSERT INTO workspace_closes VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data")
      .run(plan.body.requestId, JSON.stringify(plan));
  }
  plan(requestId) {
    const row = this.store.db.prepare("SELECT data FROM workspace_closes WHERE id=?").get(requestId);
    return row && JSON.parse(row.data);
  }
  async reconcile(requestId) {
    const plan = this.plan(requestId);
    return plan ? this.close(plan.tabId, plan.body) : this.store.request(requestId);
  }
  async close(id, body) {
    requestID(body.requestId);
    return this.w.chat.exclusive(id, async () => {
      const receipt = this.store.request(body.requestId);
      if (receipt) {
        this.store.claim(body.requestId, id, "tab:close", body);
        if (["accepted", "rejected", "abandoned"].includes(receipt.status)) return receipt;
      }
      let plan = this.plan(body.requestId);
      if (!plan) {
        const tab = this.w.record(id) ?? this.w.snapshot.spaces.flatMap((s) => s.tabs).find((t) => t.id === id);
        check(tab, "tab_missing", "タブが見つかりません。", 404);
        check(samePane(tab, body) && body.expectedThreadId === (tab.threadId ?? null),
          "stale_thread", "タブの端末または会話が変わりました。再同期してください。", 409);
        check(!tab.closeRequestId, "tab_closing", "タブを終了中です。終了結果を確認してください。", 409);
        check(!this.w.chat.requests(id).length, "unknown_request", "送信結果を確認してからタブを閉じてください。", 409);
        const other = this.w.records().filter((t) => t.id !== id && !t.closedAt);
        const contexts = [tab, ...(tab.contexts ?? [])];
        check(!other.some((t) => t.threadId && t.threadId !== tab.threadId && samePane(t, tab)),
          "terminal_shared", "この端末は別のタブでも使用中です。", 409);
        const targets = contexts.filter((t, i) => contexts.findIndex((p) => samePane(t, p)) === i &&
          (i === 0 || !other.some((o) => [o, ...(o.contexts ?? [])].some((p) => samePane(t, p)))));
        const threads = [...new Set(contexts.map((t) => t.threadId).filter(Boolean))]
          .filter((threadId) => !other.some((t) => t.threadId === threadId))
          .map((threadId) => ({ threadId }));
        plan = { tabId: id, body, targets: targets.map(({ paneId, panePid, epoch }) => ({ paneId, panePid, epoch })), threads };
        this.store.transaction(() => {
          this.store.claim(body.requestId, id, "tab:close", body);
          this.save(plan); // Exact body and identities precede every side effect.
          this.w.save({ ...tab, closeRequestId: body.requestId });
        });
      }
      try {
        const current = this.w.record(id);
        check(current?.closeRequestId === body.requestId && samePane(current, body) &&
          (current.threadId ?? null) === body.expectedThreadId, "stale_thread", "タブの会話が変わりました。", 409);
        let c;
        if (plan.threads.length) {
          c = await this.w.shared();
          check(c?.alive, "codex_offline", "共有Codexへ再接続して終了結果を確認してください。", 503);
        }
        for (const item of plan.threads) {
          let thread = await this.w.chat.readThread(c, item.threadId);
          check(thread.id === item.threadId, "stale_thread", "終了対象の会話を確認できません。", 409);
          if (!("turnId" in item)) {
            item.turnId = thread.status?.type === "active" ? thread.turns?.at(-1)?.id : null;
            check(thread.status?.type !== "active" || item.turnId, "turn_unknown", "実行中の応答を確認できません。", 409);
            this.save(plan);
          }
          if (thread.status?.type === "active") {
            check(thread.turns?.at(-1)?.id === item.turnId, "stale_turn", "別の応答が始まりました。終了対象を確認してください。", 409);
            await c.call("turn/interrupt", { threadId: item.threadId, turnId: item.turnId });
            // Acknowledgement only means the interrupt was requested.
            for (let n = 0; n < 40 && thread.status?.type === "active"; n++) {
              await new Promise((resolve) => setTimeout(resolve, 100));
              thread = await this.w.chat.readStatus(c, item.threadId);
            }
            check(thread.status?.type !== "active", "close_pending", "作業の停止を待っています。終了結果を確認してください。", 503);
          }
        }
        for (const target of plan.targets) await this.w.tmux.terminate(target);
        for (const item of plan.threads) await c.call("thread/unsubscribe", { threadId: item.threadId });
        const result = this.store.transaction(() => {
          const tab = this.w.record(id);
          this.w.save({ ...tab, closedAt: now(), closeRequestId: null, dead: true,
            state: ["completed", "failed"].includes(tab.state) ? tab.state : "stopped", observedAt: now() });
          this.w.messageQueue?.pauseTab(id);
          const state = this.w.presentation.read();
          state.hiddenTabIds = [...new Set([...state.hiddenTabIds, id])];
          state.revision++;
          this.w.presentation.save(state);
          return this.store.finishRequest(body.requestId, "accepted", { tabId: id, revision: state.revision, closed: true });
        });
        await this.w.refreshLayout();
        return result;
      } catch (error) {
        // Interruption or pane removal may already have happened. Keep the plan
        // and block new sends until the exact operation is reconciled.
        return this.store.finishRequest(body.requestId, "unknown", { message: error.message });
      }
    });
  }
}
