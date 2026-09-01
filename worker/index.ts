import { Hono } from "hono";

const app = new Hono();

app.get("/api/health", (context) =>
  context.json({
    app: "Sloppy Potato Fantasy Football",
    status: "ok",
    timestamp: new Date().toISOString(),
  }),
);

app.notFound((context) => context.json({ error: "Not found" }, 404));

export default app;
