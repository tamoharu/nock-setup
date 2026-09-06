import { loadConfig } from "./config.mjs";
import { Store } from "./store.mjs";
import { verifyCodex } from "./codex.mjs";
import { Service } from "./service.mjs";
import { NotificationWorker } from "./apns.mjs";
import { createAPI } from "./http.mjs";
import { Workspace } from "./workspace.mjs";

process.umask(0o077);
try {
  const path = process.argv[2] ?? process.env.NOCK_CONFIG;
  if (!path)
    throw new Error("起動方法: node src/main.mjs /absolute/path/config.json");
  const config = loadConfig(path);
  verifyCodex(config.codexBin);
  const store = new Store(config.database),
    service = new Service(store, config);
  service.workspace = new Workspace(store, config);
  service.workspace.messageQueue = service.queue;
  const worker = new NotificationWorker(
    store,
    config.apns ?? { enabled: false },
  );
  const server = createAPI(service, worker, config);
  // Claim the listener before recovering state: a second accidental launch must
  // not interrupt the first daemon's sessions before discovering EADDRINUSE.
  server.listen(config.port, "127.0.0.1", () => {
    service.recover();
    service.workspace.start();
    service.queue.start();
    worker.start();
    console.log(`Nock 0.2.0: 127.0.0.1:${config.port} (Codex 0.153.4)`);
  });
  server.on("error", () => {
    console.error("Nock: localhostポートを開けません。");
    shutdown();
  });
  let closing = false;
  function shutdown() {
    if (closing) return;
    closing = true;
    worker.stop();
    service.queue.close();
    service.workspace.close();
    service.close();
    server.close(() => {
      store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  }
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
} catch (e) {
  console.error(`Nock: ${e.code ?? "configuration"} — ${e.message}`);
  process.exitCode = 1;
}
