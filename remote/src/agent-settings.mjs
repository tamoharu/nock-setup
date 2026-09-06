import { check } from "./config.mjs";

export function permissionOverrides(level) {
  if (level == null || level === "") return {};
  check(["read-only", "workspace-write", "full-access"].includes(level), "permission", "権限を選び直してください。");
  return {
    approvalPolicy: level === "full-access" ? "never" : "on-request",
    approvalsReviewer: "user",
    sandboxPolicy: level === "full-access" ? { type: "dangerFullAccess" }
      : { type: level === "read-only" ? "readOnly" : "workspaceWrite", networkAccess: false },
  };
}

// thread/start uses SandboxMode; turn/start uses SandboxPolicy.
export function threadPermissionOverrides(level) {
  const { sandboxPolicy, ...policy } = permissionOverrides(level);
  return sandboxPolicy ? { ...policy, sandbox: level === "full-access" ? "danger-full-access" : level } : {};
}

export function weeklyUsage(response) {
  // Other buckets may describe a different model/product. Never substitute them
  // for the main Codex allowance, or assume that 'secondary' always means weekly.
  const bucket = response.rateLimitsByLimitId?.codex ??
    (!response.rateLimits?.limitId || response.rateLimits.limitId === "codex" ? response.rateLimits : null);
  const window = [bucket?.primary, bucket?.secondary].find((w) => w?.windowDurationMins === 7 * 24 * 60);
  if (!window || !Number.isFinite(window.usedPercent)) return null;
  return { remainingPercent: Math.max(0, Math.min(100, 100 - window.usedPercent)),
    resetsAt: Number.isFinite(window.resetsAt) ? window.resetsAt : null };
}
