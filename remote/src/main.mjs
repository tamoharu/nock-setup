import { loadConfig } from "./config.mjs";
import { Store } from "./store.mjs";
import { verifyCodex } from "./codex.mjs";
import { Service } from "./service.mjs";
import { NotificationWorker } from "./apns.mjs";
import { createAPI } from "./http.mjs";
import { Workspace } from "./workspace.mjs";
import { HerdrBridge } from "./herdr.mjs";
import { version } from "./version.mjs";
import { PowerSettings } from "./power.mjs";
import { ConnectionDiagnostics } from "./connection-diagnostics.mjs";

process.umask(0o077);
try {
  const path = process.argv[2] ?? process.env.HATI_CONFIG;
  if (!path)
    throw new Error("起動方法: node src/main.mjs /absolute/path/config.json");
  const config = loadConfig(path);
  verifyCodex(config.codexBin);
  const store = new Store(config.database),
    service = new Service(store, config);
  service.workspace = new Workspace(store, config);
  service.workspace.messageQueue = service.queue;
  service.herdr = new HerdrBridge(config, { workspace: service.workspace });
  // Isolated CLI fixtures must never publish into the machine's real power
  // directory, even when they use a distinct listener and empty database.
  service.power = new PowerSettings(store, process.env.HATI_HOME ? { platform: "fixture" } : {});
  service.diagnostics = new ConnectionDiagnostics(store, config, service.power);
  const worker = new NotificationWorker(
    store,
    config.apns ?? { enabled: false },
  );
  const server = createAPI(service, worker, config);
  // Claim the listener before recovering state: a second accidental launch must
  // not interrupt the first daemon's sessions before discovering EADDRINUSE.
  server.listen(config.port, "127.0.0.1", () => {
    service.power.start();
    service.diagnostics.start();
    service.recover();
    service.workspace.start();
    service.queue.start();
    worker.start();
    void service.herdr.start();
    console.log(`hati ${version}: 127.0.0.1:${config.port} (Codex 0.153.4)`);
  });
  server.on("error", () => {
    console.error("hati: localhostポートを開けません。");
    shutdown();
  });
  let closing = false;
  function shutdown() {
    if (closing) return;
    closing = true;
    service.power.close();
    service.diagnostics.close();
    worker.stop();
    service.queue.close();
    service.workspace.close();
    service.close();
    const bridgeStopped = service.herdr.stop();
    server.close(async () => {
      await bridgeStopped;
      store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  }
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
} catch (e) {
  console.error(`hati: ${e.code ?? "configuration"} — ${e.message}`);
  process.exitCode = 1;
}
