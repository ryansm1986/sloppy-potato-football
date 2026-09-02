import { readFile } from "node:fs/promises";
import path from "node:path";

const entryPath = path.resolve("dist-desktop", "main", "entry.js");
const source = await readFile(entryPath, "utf8");

if (/import\s*\{[^}]*\bautoUpdater\b[^}]*\}\s*from\s*["']electron-updater["']/.test(source)) {
  throw new Error(
    "The packaged ESM entry uses an unsupported named import from the CommonJS electron-updater package.",
  );
}

if (!/import\s+\w+\s+from\s+["']electron-updater["']/.test(source)) {
  throw new Error("The packaged ESM entry does not contain the expected CommonJS-compatible updater import.");
}

console.log("Verified CommonJS-compatible electron-updater import in the desktop main bundle.");
