import { join } from "node:path";

const OS_KEYS = new Set(["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "LANG", "LC_ALL", "LC_CTYPE"]);

/** Termless overlays its env onto process.env, so omitted keys would leak.
 *  `extra` is the explicit allow-list for the few variables a test must set. */
export function testEnvironment(home: string, inherited = process.env, windows = process.platform === "win32", extra: Record<string, string> = {}): Record<string, string> {
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
  // Controlled names are registered so an `extra` key cannot arrive under a second casing
  // (Windows environment names are case-insensitive, so `Path` and `PATH` are the same entry
  // and the explicit override would be ambiguous).
  for (const [key, value] of Object.entries(controlled)) {
    const id = keyId(key);
    const name = names.get(id) ?? key;
    names.set(id, name);
    env[name] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    const id = keyId(key);
    const name = names.get(id) ?? key;
    names.set(id, name);
    env[name] = value;
  }
  return env;
}
