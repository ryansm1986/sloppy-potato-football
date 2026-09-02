const MAX_ENVIRONMENT_FILE_BYTES = 64 * 1024;

function invalidOwnerTokenFile(): never {
  throw new Error("That file does not contain a valid RESEARCH_OWNER_TOKEN.");
}

export async function readOwnerTokenFromEnvironmentFile(file: File): Promise<string> {
  if (file.size > MAX_ENVIRONMENT_FILE_BYTES) invalidOwnerTokenFile();
  const text = await file.text();
  const assignments = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("RESEARCH_OWNER_TOKEN"));
  if (assignments.length !== 1) invalidOwnerTokenFile();

  const match = /^RESEARCH_OWNER_TOKEN\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+))$/.exec(assignments[0]!);
  const token = (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
  if (token.length < 32 || token.length > 4_096) invalidOwnerTokenFile();
  return token;
}
