import { randomUUID } from "node:crypto";
import { Tmux } from "./tmux.mjs";

// Bounded operational history, separate from prompts and conversation events.
export class ConnectionDiagnostics {
  constructor(store, config, power, tmux = new Tmux(config.tmux)) {
    this.store = store; this.power = power; this.tmux = tmux;
    this.instanceId = randomUUID(); this.startedAt = Date.now();
    store.db.exec("CREATE TABLE IF NOT EXISTS connection_events(id INTEGER PRIMARY KEY,at INTEGER NOT NULL,kind TEXT NOT NULL,instance TEXT NOT NULL)");
  }
  record(kind) {
    this.store.db.prepare("INSERT INTO connection_events(at,kind,instance) VALUES(?,?,?)").run(Date.now(), kind, this.instanceId);
    this.store.db.exec("DELETE FROM connection_events WHERE id NOT IN (SELECT id FROM connection_events ORDER BY id DESC LIMIT 80)");
  }
  start() {
    this.record("daemon_started");
    let previous = Date.now();
    this.timer = setInterval(() => {
      const now = Date.now();
      // A scheduling gap alone is not proof of sleep; the helper's OS events
      // distinguish sleep from overload after connectivity returns.
      if (now - previous > 15000) this.record("daemon_delayed");
      previous = now;
    }, 5000).unref();
    const observe = async () => {
      if (this.observing) return; this.observing = true;
      try { await this.status(); } catch {} finally { this.observing = false; }
    };
    this.scanTimer = setInterval(() => void observe(), 15000).unref();
    void observe();
  }
  close() { if (this.timer) this.record("daemon_stopped"); this.closed = true; clearInterval(this.timer); clearInterval(this.scanTimer); }
  status() {
    if (!this.reading) this.reading = this.readStatus().finally(() => { this.reading = null; });
    return this.reading;
  }
  async readStatus() {
    let tmux;
    try {
      const panes = await this.tmux.panes({ strict: true });
      tmux = { state: panes.length ? "running" : "absent", panes: panes.length,
        deadPanes: panes.filter(p => p.dead).length, epochs: [...new Set(panes.map(p => p.epoch))] };
      const active = new Set(panes.filter(p => !p.dead).map(p => `${p.epoch}:${p.paneId}`));
      if (!this.closed && this.lastActive && [...this.lastActive].some(id => !active.has(id))) this.record("tmux_pane_exited");
      this.lastActive = active;
    } catch { tmux = { state: "unavailable" }; }
    if (this.closed) return;
    if (this.lastTmux && this.lastTmux !== tmux.state) this.record(`tmux_${tmux.state}`);
    if (this.lastEpochs?.length && tmux.epochs?.length && this.lastEpochs.every(e => !tmux.epochs.includes(e))) this.record("tmux_restarted");
    this.lastEpochs = tmux.epochs;
    this.lastTmux = tmux.state;
    const helper = this.power?.lease.status();
    return { serverId: this.store.serverId, instanceId: this.instanceId, startedAt: this.startedAt,
      observedAt: Date.now(), tmux, power: this.power?.status(),
      events: [...this.store.db.prepare("SELECT at,kind,instance FROM connection_events ORDER BY id DESC LIMIT 40").all(),
        ...(helper?.events ?? []).filter(e => Number.isFinite(e.at) && /^(system_sleep|system_wake|power_[a-z_]+)$/.test(e.kind))]
        .sort((a, b) => b.at - a.at).slice(0, 60) };
  }
}
