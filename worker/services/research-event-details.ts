export const stageMessages = {
  starting: "Preparing the research assignment.",
  researching: "Researching sources and gathering evidence.",
  validating: "Checking the research output.",
  publishing: "Publishing research results to the app.",
};

// Exclude arbitrary runner output and project only safe identifiers/counters.
export function safeResearchEventDetails(json: string): Record<string, unknown> {
  let value: Record<string, unknown>;
  try { value = JSON.parse(json) as Record<string, unknown>; } catch { return {}; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, unknown> = {};
  for (const key of ["resultId", "rankingSnapshotId", "sleeperReportId", "code"]) {
    if (typeof value[key] === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value[key])) result[key] = value[key];
  }
  if (typeof value.retryable === "boolean") result.retryable = value.retryable;
  if (typeof value.attempt === "number" && Number.isInteger(value.attempt) && value.attempt >= 0) result.attempt = value.attempt;
  if (typeof value.stage === "string" && Object.hasOwn(stageMessages, value.stage)) {
    result.stage = value.stage;
    result.message = stageMessages[value.stage as keyof typeof stageMessages];
  }
  if (Array.isArray(value.rankingSnapshotIds)) {
    result.rankingSnapshotIds = value.rankingSnapshotIds.filter((id): id is string =>
      typeof id === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(id)).slice(0, 5);
  }
  if (typeof value.leaseExpiresAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.leaseExpiresAt)) {
    result.leaseExpiresAt = value.leaseExpiresAt;
  }
  return result;
}
