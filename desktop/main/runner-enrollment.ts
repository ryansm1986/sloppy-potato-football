import type { RunnerDeviceSummary } from "../shared/contracts.js";

export interface RunnerEnrollmentResponse {
  device: RunnerDeviceSummary;
  token: string;
}

type EnrollmentRequest = {
  apiBaseUrl: string;
  deviceId: string;
  ownerToken: string;
  name: string;
};

function validText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

function responseMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (validText(record.message, 300)) return record.message;
  if (validText(record.error, 300)) return record.error;
  if (record.error && typeof record.error === "object") {
    const nested = (record.error as Record<string, unknown>).message;
    if (validText(nested, 300)) return nested;
  }
  return undefined;
}

/** Calls the owner-authorized enrollment endpoint. The returned token stays in the main process. */
export async function enrollRunnerDevice(
  request: EnrollmentRequest,
  fetchImplementation: typeof fetch = fetch,
): Promise<RunnerEnrollmentResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  timeout.unref?.();
  try {
    const response = await fetchImplementation(new URL("/api/research/runner-credentials", request.apiBaseUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${request.ownerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ deviceId: request.deviceId, name: request.name }),
      signal: controller.signal,
      redirect: "error",
      cache: "no-store",
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message = responseMessage(body)?.split(request.ownerToken).join("[REDACTED]");
      throw new Error(message ?? `Runner enrollment failed (${response.status}).`);
    }
    if (!body || typeof body !== "object") throw new Error("Runner enrollment returned an invalid response.");
    const record = body as Record<string, unknown>;
    const device = record.credential;
    if (
      !device || typeof device !== "object" ||
      !validText((device as Record<string, unknown>).id, 200) ||
      !validText((device as Record<string, unknown>).name, 100) ||
      !validText(record.token, 4_096)
    ) {
      throw new Error("Runner enrollment returned an invalid credential.");
    }
    return {
      device: {
        id: (device as Record<string, string>).id,
        name: (device as Record<string, string>).name,
      },
      token: record.token,
    };
  } finally {
    clearTimeout(timeout);
  }
}
