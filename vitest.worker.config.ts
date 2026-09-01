import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

declare const __dirname: string;

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(`${__dirname}/migrations`),
        },
      },
      wrangler: { configPath: "./wrangler.jsonc" },
    })),
  ],
  test: {
    include: ["worker/**/*.worker.test.ts"],
    setupFiles: ["./worker/test/apply-migrations.ts"],
  },
});
