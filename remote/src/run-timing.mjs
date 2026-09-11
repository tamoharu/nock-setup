// Codex turn timestamps are seconds; hati snapshots use milliseconds. Keep
// timing tied to a turn so a new response never inherits the previous duration.
const nonnegative = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
export function runTiming(turn, previous, { startedAt, completedAt } = {}) {
  if (!turn) return previous ?? null;
  const old = previous?.turnId === turn.id ? previous : {};
  const start = nonnegative(turn.startedAt);
  const end = nonnegative(turn.completedAt);
  const finished = ["completed", "failed", "interrupted"].includes(turn.status);
  const timing = {
    turnId: turn.id,
    startedAt: start !== null ? start * 1000 : old.startedAt ?? nonnegative(startedAt),
    completedAt: finished ? (end !== null ? end * 1000 : old.completedAt ?? nonnegative(completedAt)) : null,
    durationMs: finished ? nonnegative(turn.durationMs) ?? old.durationMs ?? null : null,
  };
  if (timing.durationMs === null && timing.startedAt !== null && timing.completedAt !== null)
    timing.durationMs = Math.max(0, timing.completedAt - timing.startedAt);
  return timing;
}
