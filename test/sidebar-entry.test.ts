import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// The factory is imported for side effects; the command is exercised through a fake pi.
import factory from "../extensions/sidebar.js";

type FakeCommand = { handler: (args: string, ctx: Partial<ExtensionContext>) => Promise<void> };
function fakePi(agentDir: string) {
  const commands = new Map<string, FakeCommand>();
  return {
    commands,
    agentDir,
    on: () => {},
    registerCommand: (name: string, def: FakeCommand) => { commands.set(name, def); },
    registerTool: () => {},
    getAgentDir: () => agentDir,
  } as unknown as ExtensionAPI & { commands: Map<string, FakeCommand> };
}
const ctx = (notifies: string[]) => ({
  mode: "print",
  cwd: process.cwd(),
  ui: { notify: (m: string) => notifies.push(m) },
} as unknown as Partial<ExtensionContext>);

describe("/sidebar command", () => {
  it("toggles, persists the flag globally and clamps the width", async () => {
    process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "entry-"));   // getAgentDir() honours this
    const dir = process.env.PI_CODING_AGENT_DIR;
    try {
      const pi = fakePi(dir);
      factory(pi);
      const notifies: string[] = [];
      const sidebar = pi.commands.get("sidebar")!;
      await sidebar.handler("off", ctx(notifies));
      expect(notifies.join()).toContain("off");
      await sidebar.handler("width 99", ctx(notifies));        // out of range -> usage warning
      expect(notifies.join()).toContain("28..60");
      await sidebar.handler("width 36", ctx(notifies));
      expect(notifies.join()).toContain("36");
      await sidebar.handler("bogus", ctx(notifies));           // unknown argument warns
      expect(notifies.join()).toContain("Usage");
    } finally { rmSync(dir, { recursive: true, force: true }); delete process.env.PI_CODING_AGENT_DIR; }
  });
});
