import { describe, expect, it } from "vitest";
import { SleeperClient } from "./client";

describe("SleeperClient", () => {
  it("normalizes malformed JSON into an invalid_response error", async () => {
    const invalidJsonFetch = (async () =>
      new Response("not-json", { status: 200 })) as typeof fetch;
    const client = new SleeperClient(
      "https://fixtures.test/v1",
      invalidJsonFetch,
    );

    await expect(client.getLeague("12345")).rejects.toMatchObject({
      name: "SleeperApiError",
      code: "invalid_response",
    });
  });
});
