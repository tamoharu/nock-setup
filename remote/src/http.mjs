import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { authenticate, check, Fault, now, requestID } from "./config.mjs";
import { weeklyUsage } from "./agent-settings.mjs";
import { version } from "./version.mjs";

async function readJSON(req) {
  check(
    req.headers["content-type"]?.startsWith("application/json"),
    "content_type",
    "JSONが必要です。",
    415,
  );
  let size = 0,
    chunks = [];
  for await (const b of req) {
    size += b.length;
    check(size <= 512000, "body_size", "要求が大きすぎます。", 413);
    chunks.push(b);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks));
    check(
      v && !Array.isArray(v) && typeof v === "object",
      "json",
      "JSONオブジェクトが必要です。",
    );
    return v;
  } catch (e) {
    if (e instanceof Fault) throw e;
    throw new Fault(400, "json", "JSONを読み取れません。");
  }
}
export function createAPI(service, worker, config) {
  const store = service.store;
  if (service.workspace) service.workspace.messageQueue = service.queue;
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    try {
      check(
        !req.headers.origin,
        "origin",
        "ブラウザーからの操作は許可されていません。",
        403,
      );
      check(
        authenticate(req.headers.authorization, config.token),
        "unauthorized",
        "APIトークンが一致しません。",
        401,
      );
      const u = new URL(req.url, "http://localhost"),
        path = u.pathname.split("/").filter(Boolean);
      const body = ["POST", "PUT", "PATCH"].includes(req.method)
        ? await readJSON(req)
        : {};
      let value;
      if (req.method === "GET" && u.pathname === "/v1/health")
        value = {
          ok: true,
          protocol: 1,
          version,
          serverId: store.serverId,
          codexVersion: "0.153.4",
          capabilities: { agentPermissions: true, messageQueue: true, steer: true, attachments: true, spaceManagement: true, codeBrowser: true, herdrAgents: !!service.herdr },
          time: now(),
        };
      else if (req.method === "GET" && u.pathname === "/v1/herdr")
        value = service.herdr?.status() ?? { enabled: false, connected: false };
      else if (req.method === "POST" && u.pathname === "/v1/herdr/reload")
        value = await service.herdr?.reload();
      else if (req.method === "GET" && u.pathname === "/v1/sync") {
        const after = Number(u.searchParams.get("after") ?? 0);
        check(
          Number.isSafeInteger(after) && after >= 0,
          "cursor",
          "取得位置が不正です。",
        );
        value = store.transaction(() => {
          const latest = store.cursor(),
            reset =
              after > latest ||
              !!(
                u.searchParams.get("serverId") &&
                u.searchParams.get("serverId") !== store.serverId
              );
          const events = store.events(reset ? 0 : after);
          const cursor = events.at(-1)?.seq ?? latest;
          return {
            serverId: store.serverId,
            reset,
            projects: config.projects,
            sessions: store.sessions(),
            events,
            cursor,
            hasMore: cursor < latest,
            syncedAt: now(),
            notifications: worker.status(),
          };
        });
      } else if (req.method === "GET" && u.pathname === "/v1/overview")
        value = { serverId: store.serverId, codexVersion: "0.153.4", projects: config.projects,
          sessions: store.sessions(), notifications: worker.status(), workspace: await service.workspace?.refreshLayout(), syncedAt: now() };
      else if (req.method === "GET" && u.pathname === "/v1/workspace")
        value = await service.workspace?.refreshLayout();
      else if (req.method === "POST" && u.pathname === "/v1/workspace/tabs")
        value = await service.workspace?.create(body);
      else if (req.method === "PATCH" && path.length === 4 && path[0] === "v1" && path[1] === "workspace" && path[2] === "spaces")
        value = await service.workspace.updateSpace(decodeURIComponent(path[3]), body);
      else if (req.method === "GET" && u.pathname === "/v1/workspace/directories")
        value = await service.workspace.paths.directories(u.searchParams.get("q") ?? "", u.searchParams.get("root"));
      else if (req.method === "POST" && u.pathname === "/v1/workspace/path-tabs")
        value = await service.workspace.paths.mutate(null, body);
      else if (req.method === "GET" && path.length === 5 && path[0] === "v1" && path[1] === "workspace" && path[2] === "tabs" && ["files", "file"].includes(path[4])) {
        const id = decodeURIComponent(path[3]), filePath = u.searchParams.get("path") ?? "", directory = u.searchParams.get("directory");
        value = path[4] === "files"
          ? await service.workspace.code.list(id, filePath, directory, u.searchParams.get("cursor") ?? "0")
          : await service.workspace.code.read(id, filePath, directory);
      }
      else if (path[0] === "v1" && path[1] === "workspace" && path[2] === "tabs" && path[3] && path[4] === "context" && req.method === "POST")
        value = await service.workspace.paths.mutate(decodeURIComponent(path[3]), body);
      else if (path[0] === "v1" && path[1] === "workspace" && path[2] === "tabs" && path[3] && path[4] === "history" && req.method === "GET")
        value = await service.workspace.paths.history(decodeURIComponent(path[3]), u.searchParams.get("cursor"));
      else if (req.method === "POST" && u.pathname === "/v1/workspace/register")
        value = await service.workspace?.register(body);
      else if (req.method === "POST" && u.pathname === "/v1/workspace/attach")
        value = await service.workspace?.tmux.verified(body);
      else if (path[0] === "v1" && path[1] === "workspace" && path[2] === "tabs" && path[3] && path[4] === "chat") {
        const id = decodeURIComponent(path[3]);
        if (req.method === "GET" && path.length === 5) {
          const before = Number(u.searchParams.get("before") ?? Number.MAX_SAFE_INTEGER);
          check(Number.isSafeInteger(before) && before > 0, "cursor", "取得位置が不正です。");
          value = await service.workspace.chat.detail(id, before);
          value.queuedMessages = service.queue?.list(id) ?? [];
        } else if (req.method === "POST" && path[5] === "queue") value = service.queue.add(id, body, true);
        else if (req.method === "DELETE" && path[5] === "queue" && path[6]) value = service.queue.remove(id, path[6]);
        else if (req.method === "POST" && path[5] === "attachments") {
          const target = service.workspace.chat.record(id);
          check(body.expectedThreadId === target.threadId, "stale_thread", "会話が変更されました。", 409);
          value = await service.attachments.begin(body, id, target.threadId);
        } else if (req.method === "POST") value = await service.workspace.chat.mutate(id, path[5], body, path[6]);
      }
      else if (req.method === "PATCH" && path[1] === "workspace" && path[2] === "tabs" && path[3])
        value = body.name !== undefined
          ? await service.workspace.rename(decodeURIComponent(path[3]), body.name)
          : service.workspace?.archive(decodeURIComponent(path[3]), body.archived);
      else if (req.method === "GET" && u.pathname === "/v1/models")
        value = { models: await service.models() };
      else if (req.method === "GET" && u.pathname === "/v1/account/weekly-usage") {
        const c = await service.workspace.shared(true);
        value = { weekly: weeklyUsage(await c.call("account/rateLimits/read", null, 8000)), fetchedAt: now() };
      }
      else if (req.method === "POST" && u.pathname === "/v1/projects/reload")
        value = service.reloadProjects();
      else if (req.method === "POST" && u.pathname === "/v1/sessions")
        value = await service.create(body);
      else if (req.method === "POST" && path[0] === "v1" && path[1] === "attachments" && path[2]) {
        if (path[3] === "chunks") value = await service.attachments.chunk(path[2], body);
        else if (path[3] === "complete") value = await service.attachments.complete(path[2]);
      }
      else if (path[0] === "v1" && path[1] === "sessions" && path[2]) {
        const id = path[2];
        store.session(id);
        if (req.method === "GET" && path.length === 3) {
          const before = Number(
            u.searchParams.get("before") ?? Number.MAX_SAFE_INTEGER,
          );
          check(
            Number.isSafeInteger(before) && before > 0,
            "cursor",
            "取得位置が不正です。",
          );
          value = service.detail(id, before, 200);
          value.queuedMessages = service.queue.list(id);
        } else if (req.method === "POST" && path[3] === "turns")
          value = await service.send(id, body);
        else if (req.method === "POST" && path[3] === "steer") value = await service.steer(id, body);
        else if (req.method === "POST" && path[3] === "queue") value = service.queue.add(id, body, false);
        else if (req.method === "DELETE" && path[3] === "queue" && path[4]) value = service.queue.remove(id, path[4]);
        else if (req.method === "POST" && path[3] === "attachments") {
          const target = store.session(id);
          check(body.expectedThreadId === target.threadId, "stale_thread", "会話が変更されました。", 409);
          value = await service.attachments.begin(body, id, target.threadId);
        }
        else if (req.method === "POST" && path[3] === "interrupt")
          value = await service.interrupt(id, body);
        else if (req.method === "POST" && path[3] === "approvals" && path[4])
          value = await service.answer(id, decodeURIComponent(path[4]), body);
        else if (req.method === "PATCH" && path.length === 3) {
          check(
            typeof body.archived === "boolean",
            "archive",
            "archivedを指定してください。",
          );
          value = service.archive(id, body.archived);
        } else if (req.method === "POST" && path[3] === "stop")
          value = service.stopProcess(id);
      } else if (req.method === "GET" && path[1] === "requests" && path[2]) {
        value = store.request(path[2]);
        check(value, "request_missing", "要求は未受理です。", 404);
      } else if (
        req.method === "POST" &&
        path[1] === "requests" &&
        path[3] === "reconcile"
      ) {
        const request = store.request(path[2]);
        if (request?.kind?.startsWith("pathTab:")) {
          const tab = service.workspace.records().find((t) => t.lastPathRequest === request.id);
          value = tab ? store.finishRequest(request.id, "accepted", { tabId: tab.id, threadId: tab.threadId }) : request;
        }
        else if (request?.kind?.startsWith("shared:")) value = request;
        else if (["terminal", "terminalRegister"].includes(request?.kind)) {
          const tab = service.workspace?.records().find((t) => t.id === request.sessionId);
          value = tab ? store.finishRequest(request.id, "accepted", { tabId: tab.id }) : request;
        } else value = await service.reconcileRequest(path[2]);
      }
      else if (
        req.method === "POST" &&
        path[1] === "requests" &&
        path[3] === "acknowledge-unknown"
      ) {
        const r = store.request(path[2]);
        check(
          r?.status === "unknown",
          "request_state",
          "受理不明の要求ではありません。",
          409,
        );
        check(
          body.confirmed === true,
          "confirmation",
          "履歴を確認したことの確認が必要です。",
        );
        check(
          r.kind.startsWith("shared:") || ["terminal", "terminalRegister"].includes(r.kind) || !["running", "waiting", "starting"].includes(
            store.session(r.sessionId).state,
          ),
          "busy",
          "実行中には解除できません。",
          409,
        );
        value = store.finishRequest(r.id, "abandoned", {
          message:
            "ユーザーが履歴を確認して受理不明を解除しました。再実行はしていません。",
        });
      } else if (req.method === "GET" && path[1] === "history" && path[2])
        value = await service.readHistory(decodeURIComponent(path[2]));
      else if (req.method === "GET" && u.pathname === "/v1/history")
        value = await service.history(
          u.searchParams.get("projectId"),
          u.searchParams.get("cursor"),
        );
      else if (req.method === "GET" && u.pathname === "/v1/notifications")
        value = worker.status();
      else if (req.method === "PUT" && path[1] === "devices" && path[2]) {
        requestID(path[2]);
        check(
          typeof body.token === "string" &&
            /^[a-fA-F0-9]{32,512}$/.test(body.token) &&
            body.token.length % 2 === 0,
          "token",
          "デバイストークンが不正です。",
        );
        check(
          ["development", "production"].includes(body.environment),
          "environment",
          "APNs環境が不正です。",
        );
        requestID(body.hostId);
        store.registerDevice({ ...body, id: path[2] });
        value = { registered: true };
      } else if (req.method === "DELETE" && path[1] === "devices" && path[2]) {
        store.removeDevice(path[2]);
        value = { removed: true };
      } else if (
        req.method === "POST" &&
        u.pathname === "/v1/notifications/test"
      ) {
        check(
          worker.status().configured,
          "apns_unconfigured",
          "通知未設定です。リモート側のAPNs設定が必要です。",
          409,
        );
        check(
          store.devices().some((d) => d.id === body.deviceId && d.active),
          "device_missing",
          "この端末の通知登録がありません。",
          409,
        );
        const terminal = service.workspace?.records().find((t) => t.id === body.sessionId);
        const s = terminal ?? store.session(body.sessionId);
        const event = store.event(s.id, "notification/test", {}, randomUUID());
        store.enqueue(
          event,
          s,
          "test",
          terminal?.spaceName ?? service.project(s.projectId).name,
          body.deviceId,
        );
        value = {
          queued: true,
          eventId: event.id,
          meaning: "送信待ちです。APNsの受理と端末表示は別です。",
        };
      }
      check(value !== undefined, "route", "操作が見つかりません。", 404);
      res.end(JSON.stringify(value));
    } catch (e) {
      res.statusCode = e.status ?? 500;
      res.end(
        JSON.stringify({
          error: {
            code: e.code ?? "internal",
            message:
              e instanceof Fault
                ? e.message
                : "サーバー処理に失敗しました。設定と状態を確認してください。",
          },
        }),
      );
    }
  });
  server.requestTimeout = 60000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  return server;
}
