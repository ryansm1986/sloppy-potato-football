import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

const destination = path.resolve("dist-desktop", "main", "schemas");
await mkdir(destination, { recursive: true });
await copyFile(
  path.resolve("runner", "schemas", "research-result.schema.json"),
  path.join(destination, "research-result.schema.json"),
);
await copyFile(
  path.resolve("desktop", "assets", "sloppy-potato-icon.png"),
  path.resolve("dist-desktop", "sloppy-potato-icon.png"),
);
