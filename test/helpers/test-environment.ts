import { join } from "node:path";

const OS_KEYS = new Set(["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "LANG", "LC_ALL", "LC_CTYPE"]);

/** Termless overlays its env onto process.env, so omitted keys would leak. */
export function testEnvironment(home: string, inherited = process.env, windows = process.platform === "win32"): Record<string, string> {
  const keyId = (key: string) => windows ? key.toUpperCase() : key;
  const env: Record<string, string> = {};
  const names = new Map<string, string>();
  for (const key of Object.keys(inherited)) {
    const id = keyId(key);
    // Windows environment names are case-insensitive. Keep the inherited spelling.
    if (names.has(id)) throw new Error("Ambiguous case aliases in inherited Windows environment");
    names.set(id, key);
    env[key] = OS_KEYS.has(id) ? inherited[key] ?? "" : "";
  }
  const controlled = {
    HOME: home, USERPROFILE: home, APPDATA: join(home, "appdata"),
    PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
    PI_CODING_AGENT_SESSION_DIR: join(home, "sessions"),
    NODE_OPTIONS: "", TERM: "xterm-256color", COLORTERM: "truecolor", PI_TRUE_COLOR: "1",
  };
  for (const [key, value] of Object.entries(controlled)) env[names.get(keyId(key)) ?? key] = value;
  return env;
}
