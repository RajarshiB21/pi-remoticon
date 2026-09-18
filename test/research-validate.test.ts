import { afterEach, describe, expect, it } from "vitest";
import { isPrivateAddress, isUnderReddit, validateBlockedDomains, validateCaptureXhr, validateTargetUrl } from "../lib/research/validate.js";

const loopback = process.env.PI_RESEARCH_TEST_ALLOW_LOOPBACK;
afterEach(() => {
  if (loopback === undefined) delete process.env.PI_RESEARCH_TEST_ALLOW_LOOPBACK;
  else process.env.PI_RESEARCH_TEST_ALLOW_LOOPBACK = loopback;
});

describe("validateTargetUrl", () => {
  it("accepts public http(s) and rejects everything else", () => {
    expect(validateTargetUrl("https://example.com/page")).toBeNull();
    expect(validateTargetUrl("http://example.com")).toBeNull();
    expect(validateTargetUrl("ftp://example.com/file")?.message).toMatch(/not public http\(s\)/);
    expect(validateTargetUrl("not a url")?.message).toMatch(/not a valid URL/);
    expect(validateTargetUrl("https://user:pw@example.com")?.message).toMatch(/credentials/);
    expect(validateTargetUrl("http://localhost/")?.message).toMatch(/not public/);
    expect(validateTargetUrl("http://127.0.0.1/")?.message).toMatch(/private|not public/);
    expect(validateTargetUrl("http://10.0.0.5/")?.message).toMatch(/private|not public/);
    expect(validateTargetUrl("http://[::1]/")?.message).toMatch(/private|not public/);
    expect(validateTargetUrl("http://localhost./")?.message).toMatch(/not public/);
    expect(validateTargetUrl("http://localhost../")?.message).toMatch(/not public/);
    expect(validateTargetUrl("http://[::ffff:127.0.0.1]/")?.message).toMatch(/private|not public/);
    expect(validateTargetUrl("http://[::]/")?.message).toMatch(/private|not public/);
    expect(validateTargetUrl("http://[ff02::1]/")?.message).toMatch(/private|not public/);
    expect(validateTargetUrl("http://172.example.com/")).toBeNull();
  });

  it("allows loopback only behind the documented test gate", () => {
    process.env.PI_RESEARCH_TEST_ALLOW_LOOPBACK = "1";
    expect(validateTargetUrl("http://127.0.0.1:8080/")).toBeNull();
    expect(validateTargetUrl("http://localhost/")).toBeNull();
    // The gate never widens to private or link-local addresses.
    expect(validateTargetUrl("http://10.0.0.5/")?.message).toMatch(/private/);
    expect(validateTargetUrl("http://169.254.1.1/")?.message).toMatch(/private/);
  });
});

describe("validateBlockedDomains", () => {
  it("accepts bare subdomains and rejects bad shapes or the target's own host", () => {
    const targets = [{ url: "https://en.wikipedia.org/wiki/Scrapling" }];
    expect(validateBlockedDomains(undefined, targets)).toBeNull();
    expect(validateBlockedDomains(["ads.example.com"], targets)).toBeNull();
    expect(validateBlockedDomains(["https://ads.example.com"], targets)?.message).toMatch(/bare domain/);
    expect(validateBlockedDomains(Array.from({ length: 33 }, (_, i) => `d${i}.example.com`), targets)?.message).toMatch(/at most 32/);
    expect(validateBlockedDomains(["ads.example.com", "ADS.example.com"], targets)?.message).toMatch(/duplicates/);
    expect(validateBlockedDomains(["wikipedia.org"], targets)?.message).toMatch(/would block target host/);
  });
});

describe("validateCaptureXhr", () => {
  it("accepts a compiling pattern and rejects junk before any work", () => {
    expect(validateCaptureXhr(undefined)).toBeNull();
    expect(validateCaptureXhr("/api/comments")).toBeNull();
    expect(validateCaptureXhr("")?.message).toMatch(/non-empty/);
    expect(validateCaptureXhr("a".repeat(201))?.message).toMatch(/too long/);
    expect(validateCaptureXhr("(")?.message).toMatch(/not a valid pattern/);
  });
});

describe("isUnderReddit", () => {
  it("matches reddit.com and its subdomains only", () => {
    expect(isUnderReddit("https://www.reddit.com/r/x/comments/1/")).toBe(true);
    expect(isUnderReddit("https://old.reddit.com/r/x/")).toBe(true);
    expect(isUnderReddit("https://reddit.com/search/?q=x")).toBe(true);
    expect(isUnderReddit("https://notreddit.com/r/x/")).toBe(false);
    expect(isUnderReddit("https://example.com/reddit.com")).toBe(false);
    expect(isUnderReddit("not a url")).toBe(false);
  });
});

describe("isPrivateAddress", () => {
  it("covers the rejected ranges", () => {
    for (const host of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.1.1", "0.0.0.0", "224.0.0.1", "::1", "::", "::ffff:7f00:1", "0:0:0:0:0:ffff:7f00:1", "ff02::1", "fe80::1", "fc00::1", "fd12::1"]) {
      expect(isPrivateAddress(host), host).toBe(true);
    }
    for (const host of ["8.8.8.8", "172.32.0.1", "172.example.com", "example.com", "2001:4860:4860::8888"]) {
      expect(isPrivateAddress(host), host).toBe(false);
    }
  });
});
