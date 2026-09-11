// Passive, display-only estimates. No prompts, model calls, polling or timers.
import { createHash } from "node:crypto";

const methods = new Set(["turn/started", "turn/completed", "turn/plan/updated", "item/started", "item/completed"]);
const terminal = new Set(["completed", "failed", "interrupted"]);
const activeTurn = (record) => record.turnId || record.runTiming?.turnId;
const verification = /(?:^|&&|;|\n)\s*(?:npm\s+(?:test\b|run\s+(?:test\S*|build|typecheck|lint)\b)|pnpm\s+(?:test|build|typecheck|lint)\b|(?:npx\s+)?(?:vitest|jest|tsc|pytest)\b|node\s+--test\b|(?:swift|cargo|go)\s+(?:test|build|check)\b|xcodebuild\b|git\s+diff\b)/;
const investigation = (item) => item.type === "webSearch" || item.type === "imageView"
  || item.type === "commandExecution" && item.commandActions?.some((a) => ["read", "search", "listFiles"].includes(a.type));
const initial = (turnId) => ({ turnId, status: "inProgress", phase: "starting", value: 0.05,
  plan: null, reads: 0, edits: 0, checks: 0, seen: {} });
const editingValue = (s) => 0.25 + 0.4 * (1 - Math.exp(-s.edits / 5));
const singleActiveStep = (s) => s.plan?.filter((status) => status === "inProgress").length === 1;
const activeStepValue = (s) => 0.3 + 0.55 * (1 - Math.exp(-(s.planWork ?? 0) / 6));

function planEvent(s, plan) {
  // Hash the revision so renamed/reordered steps reset the estimate without
  // retaining plan text. Identical updates (including after reconnect) do not.
  const key = createHash("sha256").update(JSON.stringify(plan.map(({ step, status }) => [step ?? null, status]))).digest("hex");
  if (key !== s.planKey) {
    s.planKey = key;
    s.planRevision = (s.planRevision ?? 0) + 1;
    s.planWork = 0;
  }
  s.plan = plan.length ? plan.map((step) => step.status) : null;
}

function itemEvent(s, method, item) {
  if (!item?.id || !["commandExecution", "fileChange", "webSearch", "imageView", "agentMessage"].includes(item.type)) return;
  const completed = method === "item/completed";
  const key = JSON.stringify([item.type, item.id]);
  const old = s.seen[key];
  const oldStatus = typeof old === "string" ? old : old?.status;
  if (oldStatus === "completed" || oldStatus === "started" && !completed) return;
  // Bound persistent bookkeeping on very long turns. Plan and turn events
  // still work after saturation; additional activity never invents progress.
  if (!old && Object.keys(s.seen).length >= 1024) return;
  s.seen[key] = completed ? "completed" : singleActiveStep(s) && s.planRevision
    ? { status: "started", planRevision: s.planRevision } : "started";
  if (item.type === "agentMessage") {
    if (item.phase === "final_answer") { s.phase = "answering"; s.value = 0.95; }
    return;
  }
  // Only successful tools that started within this exact revision contribute.
  // Late completions, ambiguous parallel steps and legacy started records do
  // not transfer credit to another step. Normal completion alone finishes it.
  const succeeded = item.type === "commandExecution" ? item.status === "completed" && item.exitCode === 0
    : item.type === "fileChange" ? item.status === "completed" : !["failed", "interrupted", "declined"].includes(item.status);
  if (completed && succeeded && singleActiveStep(s) && old?.planRevision === s.planRevision && s.planRevision)
    s.planWork = Math.min(64, (s.planWork ?? 0) + 1);
  if (item.type === "fileChange") {
    if (completed && item.status !== "completed") return;
    if (completed) s.edits++;
    s.checks = 0; s.phase = "editing"; s.value = editingValue(s);
  } else if (item.type === "commandExecution" && s.edits > 0 && verification.test(item.command ?? "")) {
    if (completed && (item.status === "failed" || typeof item.exitCode === "number" && item.exitCode !== 0)) {
      s.checks = 0; s.phase = "editing"; s.value = editingValue(s);
    } else {
      if (completed && item.exitCode === 0) s.checks++;
      s.phase = "verifying"; s.value = 0.65 + 0.2 * (1 - Math.exp(-s.checks / 3));
    }
  } else if (investigation(item) && ["starting", "investigating"].includes(s.phase)) {
    if (completed && item.status !== "failed" && !(item.exitCode > 0)) s.reads++;
    s.phase = "investigating"; s.value = 0.05 + 0.2 * (1 - Math.exp(-s.reads / 8));
  }
}

export class RunProgress {
  constructor(db) {
    this.db = db;
    db.exec("CREATE TABLE IF NOT EXISTS run_progress(session TEXT NOT NULL, thread TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(session,thread))");
    this.read = db.prepare("SELECT data FROM run_progress WHERE session=? AND thread=?");
    this.write = db.prepare("INSERT INTO run_progress VALUES (?,?,?) ON CONFLICT(session,thread) DO UPDATE SET data=excluded.data");
  }
  load(record) {
    if (!record?.id || !record.threadId) return null;
    const row = this.read.get(record.id, record.threadId);
    return row ? JSON.parse(row.data) : null;
  }
  observe(record, message) {
    if (!methods.has(message.method) || message.id != null || !record?.threadId) return;
    const p = message.params ?? {}, turnId = p.turn?.id ?? p.turnId;
    if (p.threadId !== record.threadId || !turnId) return;
    const start = message.method === "turn/started";
    if (!start && activeTurn(record) && activeTurn(record) !== turnId) return;
    let s = this.load(record);
    if (s?.retired?.includes(turnId)) return;
    if (s && s.turnId !== turnId && !start) return;
    const previous = JSON.stringify(s);
    if (!s || s.turnId !== turnId) s = { ...initial(turnId), retired: [...(s?.retired ?? []), ...(s ? [s.turnId] : [])].slice(-32) };
    if (terminal.has(s.status)) return;
    if (message.method === "turn/completed") {
      if (!terminal.has(p.turn?.status)) return;
      s.status = p.turn.status;
    } else if (message.method === "turn/plan/updated") {
      if (!Array.isArray(p.plan) || p.plan.length > 256 || p.plan.some((step) => !["pending", "inProgress", "completed"].includes(step?.status))) return;
      planEvent(s, p.plan);
    } else if (message.method.startsWith("item/")) itemEvent(s, message.method, p.item);
    const next = JSON.stringify(s);
    if (next !== previous) this.write.run(record.id, record.threadId, next);
  }
  reconcile(record, turn) {
    if (!record?.threadId || !turn?.id || activeTurn(record) && activeTurn(record) !== turn.id) return;
    const existing = this.load(record);
    // Callers provide the current record after awaiting thread/read. The
    // identity check above prevents a lagging read from replacing a live turn.
    if (existing?.retired?.includes(turn.id)) return;
    let s = existing;
    if (!existing || existing.turnId !== turn.id) {
      s = { ...initial(turn.id), retired: [...(existing?.retired ?? []), ...(existing ? [existing.turnId] : [])].slice(-32) };
      // Seed only the latest turn, with one bounded in-memory pass and one DB
      // write. Completed historical turns need no activity reconstruction.
      if (turn.status !== "completed") for (const item of (turn.items ?? []).slice(0, 2048))
        itemEvent(s, item.status === "inProgress" ? "item/started" : "item/completed", item);
    }
    if (!terminal.has(s.status) && terminal.has(turn.status)) s = { ...s, status: turn.status };
    const next = JSON.stringify(s);
    if (next !== JSON.stringify(existing)) this.write.run(record.id, record.threadId, next);
  }
  summary(record) {
    const s = this.load(record);
    if (!s || !activeTurn(record) || s.turnId !== activeTurn(record)) return null;
    const source = s.plan ? "plan" : "estimated";
    const inProgress = singleActiveStep(s) ? activeStepValue(s) : 0.3;
    const fraction = s.plan ? s.plan.reduce((sum, status) => sum + ({ completed: 1, inProgress, pending: 0 }[status]), 0) / s.plan.length : s.value;
    const value = s.status === "completed" && record.state === "completed" ? 1 : Math.min(0.95, Math.max(0.05, fraction));
    return { threadId: record.threadId, turnId: s.turnId, value: Math.round((value + Number.EPSILON) * 100) / 100, source,
      phase: s.plan ? "plan" : s.phase };
  }
  attach(record) { return { ...record, runProgress: this.summary(record) }; }
}
