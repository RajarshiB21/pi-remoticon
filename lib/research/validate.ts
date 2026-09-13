/**
 * Public-target validation for the fetch tool (spec section 5.1).
 * Only public http/https URLs may be fetched. Credentials embedded in a
 * target, loopback, link-local, multicast, and private addresses are
 * rejected before any request leaves the box. HTTP redirects are handled
 * by Scrapling's default safe redirect mode, which rejects redirects that
 * target internal/private IPs.
 *
 * PI_RESEARCH_TEST_ALLOW_LOOPBACK=1 is a documented test-only gate that
 * mirrors helper.py's gate: deterministic offline fixture evidence (spec
 * section 11) runs against 127.0.0.1 servers through real pi. The fetch
 * tool never sets this variable; only test environments do.
 */

export function validateTargetUrl(url: string): Error | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return new Error(`target is not a valid URL: ${shortUrl(url)}`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return new Error(`target scheme ${JSON.stringify(parsed.protocol)} is not public http(s)`);
	}
	if (parsed.username || parsed.password) {
		return new Error("target URL embeds credentials");
	}
	const host = parsed.hostname.toLowerCase();
	const loopbackAllowed = process.env.PI_RESEARCH_TEST_ALLOW_LOOPBACK === "1";
	if (host === "" || host === "." || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
		if (!loopbackAllowed) return new Error(`target host ${JSON.stringify(host)} is not public`);
	}
	if (isPrivateAddress(host) && !loopbackAllowed) {
		return new Error(`target host ${JSON.stringify(host)} is private, loopback, or link-local`);
	}
	return null;
}

/**
 * blockedDomains: 0..32 bare domains for browser subrequest blocking. Entries
 * must be bare hostnames (no scheme, path, credentials, whitespace), and must
 * not equal or be a parent of any target's own host, because the browser
 * blocks requests to the entry AND its subdomains (spec 5.1: blockedDomains
 * affects browser subrequests, not the target's own host).
 */
export function validateBlockedDomains(entries: unknown, targets: Array<{ url: string }>): Error | null {
	if (entries === undefined || entries === null) return null;
	if (!Array.isArray(entries)) {
		return new Error("blockedDomains must be an array of 0..32 domain strings");
	}
	if (entries.length > 32) {
		return new Error(`blockedDomains has ${entries.length} entries; at most 32 are allowed`);
	}
	const seen = new Set<string>();
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		if (typeof entry !== "string" || entry.trim() === "") {
			return new Error(`blockedDomains[${index}] must be a non-empty string`);
		}
		if (entry.length > 253) {
			return new Error(`blockedDomains[${index}] is too long`);
		}
		// eslint-disable-next-line no-control-regex
		if (/[\s/\\:@]/.test(entry) || entry.includes("://") || /[\u0000-\u001f\u007f]/.test(entry)) {
			return new Error(`blockedDomains[${index}] must be a bare domain with no scheme, path, credentials, or whitespace`);
		}
		const lowered = entry.toLowerCase();
		if (seen.has(lowered)) {
			return new Error(`blockedDomains[${index}] duplicates ${JSON.stringify(entry)}`);
		}
		seen.add(lowered);
	}
	for (const target of targets) {
		let host: string;
		try {
			host = new URL(target.url).hostname.toLowerCase();
		} catch {
			continue; // target validation reports the URL problem separately
		}
		for (const entry of seen) {
			if (host === entry || host.endsWith(`.${entry}`)) {
				return new Error(`blockedDomains entry ${JSON.stringify(entry)} would block target host ${JSON.stringify(host)}`);
			}
		}
	}
	return null;
}

/**
 * captureXhr: a non-empty regex pattern matched against browser background
 * fetch/XHR response URLs (Scrapling uses Python re). No control characters;
 * the pattern must compile so a bad regex fails before any network work.
 */
export function validateCaptureXhr(pattern: unknown): Error | null {
	if (pattern === undefined || pattern === null) return null;
	if (typeof pattern !== "string" || pattern.trim() === "") {
		return new Error("captureXhr must be a non-empty string pattern");
	}
	if (pattern.length > 200) {
		return new Error("captureXhr pattern is too long (max 200 characters)");
	}
	// eslint-disable-next-line no-control-regex
	if (/[\u0000-\u001f\u007f]/.test(pattern)) {
		return new Error("captureXhr must not contain control characters");
	}
	try {
		new RegExp(pattern);
	} catch (error) {
		return new Error(`captureXhr is not a valid pattern: ${error instanceof Error ? error.message : String(error)}`);
	}
	return null;
}

export function isPrivateAddress(host: string): boolean {
	const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
	const v4 = bare.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (v4) {
		const a = Number(v4[1]);
		const b = Number(v4[2]);
		if (a === 0 || a === 10 || a === 127) return true;
		if (a === 169 && b === 254) return true;
		if (a === 172 && b >= 16 && b <= 31) return true;
		if (a === 192 && b === 168) return true;
		if (a >= 224) return true; // multicast and reserved ranges
		return false;
	}
	if (bare === "::1") return true;
	if (bare.startsWith("fe80:")) return true; // IPv6 link-local
	if (bare.startsWith("fc") || bare.startsWith("fd")) return true; // IPv6 unique-local
	return false;
}

function shortUrl(url: string): string {
	const visible = url.length <= 200 ? url : url.slice(0, 200) + "…";
	return JSON.stringify(visible);
}