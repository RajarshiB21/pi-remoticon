import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const helper = readFileSync(join(root, "lib", "research", "helper.py"), "utf8");

describe("helper source", () => {
  it("builds the emitter before validating outputDir (D8)", () => {
    const main = helper.slice(helper.indexOf("def main()"));
    const emitter = main.indexOf("emitter = Emitter(batch_id)");
    const outputDir = main.indexOf('output_dir = payload.get("outputDir")');
    expect(emitter).toBeGreaterThan(-1);
    expect(outputDir).toBeGreaterThan(emitter);
  });

  it("pins the version-sensitive Scrapling surface", () => {
    const requirements = readFileSync(join(root, "lib", "research", "requirements.txt"), "utf8");
    expect(requirements).toContain("scrapling==0.4.15");
    expect(helper).toContain("from scrapling.fetchers import AsyncDynamicSession, AsyncStealthySession, FetcherSession");
  });

  it("carries no machine-absolute path", () => {
    expect(/[A-Za-z]:\\|\/(?:home|Users|tmp|root|var|opt|mnt|media|private)\//.test(helper)).toBe(false);
  });

  it("parses IP literals with the stdlib parser, not hand-rolled arithmetic", () => {
    expect(helper).toContain("import ipaddress");
    expect(helper).toContain("return not address.is_global");
    expect(helper).not.toContain('int(text.split(".")[1]');
  });
});
