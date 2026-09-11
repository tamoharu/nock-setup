import { check, requestID } from "./config.mjs";

// Shared presentation is separate from terminal/archive ownership. Closing a
// tab on one screen must not stop polling, notifications, a shell, or a turn.
export class WorkspacePresentation {
  constructor(workspace) {
    this.workspace = workspace;
    this.store = workspace.store;
    this.store.db.exec(
      "CREATE TABLE IF NOT EXISTS workspace_presentation(id INTEGER PRIMARY KEY, data TEXT NOT NULL)",
    );
  }
  read() {
    const row = this.store.db
      .prepare("SELECT data FROM workspace_presentation WHERE id=1")
      .get();
    return row
      ? JSON.parse(row.data)
      : {
          revision: 0,
          hiddenTabIds: [],
          tabOrder: [],
          spaceDirectories: {},
          tabDirectories: {},
        };
  }
  save(value) {
    this.store.db
      .prepare(
        "INSERT INTO workspace_presentation VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(JSON.stringify(value));
  }
  observe(spaces) {
    const state = this.read(),
      before = JSON.stringify(state);
    for (const space of spaces) {
      const directory =
        state.spaceDirectories[space.id] ??
        space.baseDirectory ??
        space.directory;
      if (directory) {
        state.spaceDirectories[space.id] = directory;
        space.baseDirectory = directory;
        for (const tab of space.tabs) state.tabDirectories[tab.id] = directory;
      }
    }
    const current = spaces.flatMap((s) => s.tabs.map((t) => t.id)),
      present = new Set(current);
    state.tabOrder = [...new Set([...state.tabOrder, ...current])].filter(
      (id) => present.has(id),
    );
    if (JSON.stringify(state) !== before) {
      state.revision++;
      this.save(state);
    }
    return state;
  }
  mutate(body) {
    requestID(body.requestId);
    if (this.store.request(body.requestId)) {
      this.store.claim(
        body.requestId,
        "workspace-presentation",
        "presentation:update",
        body,
      );
      return this.store.request(body.requestId);
    }
    const edits = body.edits ?? [{ tabId: body.tabId, hidden: body.hidden }];
    check(
      Array.isArray(edits) && edits.length > 0 && edits.length <= 1000,
      "presentation",
      "表示するタブを指定してください。",
    );
    const known = new Set([
      ...this.workspace.records().map((t) => t.id),
      ...this.workspace.snapshot.spaces.flatMap((s) => s.tabs.map((t) => t.id)),
    ]);
    for (const edit of edits) {
      check(
        typeof edit?.tabId === "string" &&
          edit.tabId.length <= 200 &&
          typeof edit.hidden === "boolean",
        "presentation",
        "タブの表示指定が不正です。",
      );
      check(
        known.has(edit.tabId),
        "tab_missing",
        "タブが見つかりません。再同期してください。",
        404,
      );
    }
    return this.store.transaction(() => {
      if (
        !this.store.claim(
          body.requestId,
          "workspace-presentation",
          "presentation:update",
          body,
        )
      )
        return this.store.request(body.requestId);
      const state = this.read(),
        hidden = new Set(state.hiddenTabIds);
      for (const edit of edits)
        edit.hidden ? hidden.add(edit.tabId) : hidden.delete(edit.tabId);
      state.hiddenTabIds = [...hidden];
      state.revision++;
      this.save(state);
      return this.store.finishRequest(body.requestId, "accepted", {
        revision: state.revision,
      });
    });
  }
}
