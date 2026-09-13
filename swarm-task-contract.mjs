export const TEST_EVIDENCE_SCHEMA = 'cli.tax.test-evidence/1.0';
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;
export const ORG_PERMISSIONS = { board: ["dispatch", "accept", "reject", "stop", "reclaim", "replace"], dispatcher: ["dispatch", "reassign", "prioritize"], ops: ["heartbeat", "reclaim", "replace"],
  "security-guard": ["block", "alert", "quarantine"], coordinator: ["conflict-scan", "lock", "queue", "baseline-handshake", "dependency-wait", "wake", "need-human"], worker: ["claim", "report", "request-help"], };
export function text(value) { return String(value ?? ""); }
export function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
export function validId(value) { return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value); }
export function finding(severity, ruleId, entityRef, message, evidence = {}) { return { severity, ruleId, entityRef, message, evidence }; }
