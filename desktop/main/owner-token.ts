const INVALID_OWNER_TOKEN_MESSAGE = "Enter a valid owner token.";

function invalidOwnerToken(): never {
  throw new Error(INVALID_OWNER_TOKEN_MESSAGE);
}

/**
 * Accepts the secret itself or the exact assignment commonly copied from
 * `.env.runner`. Keeping this parser in the privileged process prevents the
 * renderer from having to retain or transform the owner credential.
 */
export function normalizeResearchOwnerTokenInput(value: unknown): string {
  if (typeof value !== "string") invalidOwnerToken();

  const input = value.trim();
  if (!input || /[\r\n]/.test(input)) invalidOwnerToken();

  let token = input;
  if (input.startsWith("RESEARCH_OWNER_TOKEN")) {
    const assignment = /^RESEARCH_OWNER_TOKEN\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+))$/.exec(input);
    if (!assignment) invalidOwnerToken();
    token = (assignment[1] ?? assignment[2] ?? assignment[3] ?? "").trim();
  } else if (/^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(input)) {
    // Do not silently treat a different environment assignment as a token.
    invalidOwnerToken();
  }

  if (token.length < 32 || token.length > 4_096) invalidOwnerToken();
  return token;
}
