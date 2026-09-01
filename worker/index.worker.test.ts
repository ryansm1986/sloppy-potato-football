import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import app from "./index";

describe("import route authorization", () => {
  it("allows localhost development but requires a secret on shared hosts", async () => {
    const local = await app.request(
      "http://localhost/api/imports/sleeper",
      { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } },
      { DB: env.DB },
    );
    expect(local.status).toBe(400);

    const unconfigured = await app.request(
      "https://potato.example/api/imports/sleeper",
      { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } },
      { DB: env.DB },
    );
    expect(unconfigured.status).toBe(503);

    const unauthorized = await app.request(
      "https://potato.example/api/imports/sleeper",
      {
        method: "POST",
        body: "{}",
        headers: { "Content-Type": "application/json", Authorization: "Bearer wrong" },
      },
      { DB: env.DB, IMPORT_ADMIN_TOKEN: "secret-potato" },
    );
    expect(unauthorized.status).toBe(401);
  });
});
