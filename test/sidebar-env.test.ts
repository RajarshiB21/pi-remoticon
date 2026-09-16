import { describe, it, expect } from "vitest";
import { testEnvironment } from "./helpers/test-environment.js";

describe("test environment passthrough", () => {
  it("adds only the explicitly provided variables", () => {
    const env = testEnvironment("/tmp/home", { PATH: "x", MY_SECRET: "leak", NO_COLOR: "1" }, false, { NO_COLOR: "1", PI_REMOTICON_MOTION: "off" });
    expect(env.NO_COLOR).toBe("1");
    expect(env.PI_REMOTICON_MOTION).toBe("off");
    expect(env.MY_SECRET).toBe("");
  });
  it("normalizes an extra key that differs only in case from an inherited one", () => {
    // Windows environment names are case-insensitive, so writing the extra verbatim created a
    // second entry beside the inherited spelling and the explicit override became ambiguous.
    const env = testEnvironment("/tmp/home", { Path: "inherited" }, true, { PATH: "/custom" });
    expect(Object.keys(env).filter(k => k.toUpperCase() === "PATH" && env[k] !== "")).toEqual(["Path"]);
    expect(env.Path).toBe("/custom");
  });
});
