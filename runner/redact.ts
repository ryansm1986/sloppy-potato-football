const secretPatterns = [
  /bearer\s+[a-z0-9._~+/=-]+/gi,
  /(?:token|secret|password|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi,
];

export function redact(value: unknown): string {
  let text: string;
  if (value instanceof Error) text = value.message;
  else if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  return secretPatterns.reduce((current, pattern) => current.replace(pattern, "[REDACTED]"), text);
}

export function safeChildEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = new Set([
    "PATH", "Path", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SYSTEMROOT",
    "SystemRoot", "TEMP", "TMP", "COMSPEC", "ComSpec", "PATHEXT", "USERNAME",
    "LANG", "LC_ALL", "TERM", "CODEX_HOME",
  ]);
  return Object.fromEntries(Object.entries(environment).filter(([name]) => allowed.has(name)));
}
