import { readFile } from "node:fs/promises";
import path from "node:path";

const resourcesPath = path.resolve(process.argv[2] ?? path.join("release-desktop", "win-unpacked", "resources"));
const sourcePath = path.resolve("runner", "schemas", "research-result.schema.json");
const packagedPath = path.join(resourcesPath, "schemas", "research-result.schema.json");

const [source, packaged] = await Promise.all([
  readFile(sourcePath),
  readFile(packagedPath),
]);

JSON.parse(packaged.toString("utf8"));
if (!source.equals(packaged)) {
  throw new Error(`Packaged research schema does not match ${sourcePath}`);
}

console.log(`Verified external-process-readable research schema at ${packagedPath}`);
