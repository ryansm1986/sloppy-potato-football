import { describe, expect, it, vi } from "vitest";
import { enrollRunnerDevice } from "./runner-enrollment.js";

describe("runner device enrollment", () => {
  it("sends the owner token only to the configured endpoint and returns the one-time credential to main", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      credential: { id: "device-1", name: "Ryan laptop" },
      token: "r".repeat(48),
    }), { status: 201, headers: { "content-type": "application/json" } }));

    const result = await enrollRunnerDevice({
      apiBaseUrl: "https://example.test",
      deviceId: "d7636cd2-5df4-476d-9047-d6453c7feff9",
      ownerToken: "o".repeat(48),
      name: "Ryan laptop",
    }, fetchMock);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url.toString()).toBe("https://example.test/api/research/runner-credentials");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${"o".repeat(48)}`);
    expect(init).toMatchObject({ method: "POST", redirect: "error", cache: "no-store" });
    expect(JSON.parse(String(init?.body))).toEqual({
      deviceId: "d7636cd2-5df4-476d-9047-d6453c7feff9",
      name: "Ryan laptop",
    });
    expect(result).toEqual({
      device: { id: "device-1", name: "Ryan laptop" },
      token: "r".repeat(48),
    });
  });

  it("does not include secrets in an invalid response error", async () => {
    const secret = "o".repeat(48);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("not json", { status: 200 }));
    await expect(enrollRunnerDevice({
      apiBaseUrl: "https://example.test",
      deviceId: "install-1",
      ownerToken: secret,
      name: "Desktop",
    }, fetchMock)).rejects.not.toThrow(secret);
  });

  it("redacts the owner token if an API error unexpectedly echoes it", async () => {
    const secret = "o".repeat(48);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      message: `Rejected ${secret}`,
    }), { status: 401, headers: { "content-type": "application/json" } }));
    const promise = enrollRunnerDevice({
      apiBaseUrl: "https://example.test",
      deviceId: "install-1",
      ownerToken: secret,
      name: "Desktop",
    }, fetchMock);
    await expect(promise).rejects.toThrow("Rejected [REDACTED]");
    await expect(promise).rejects.not.toThrow(secret);
  });
});
