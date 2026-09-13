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
	const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
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

/**
 * Expand an IPv6 literal to eight lowercase groups without leading zeros.
 * Returns null when the text is not an IPv6 literal. Compressed and full
 * spellings agree, so `::ffff:7f00:1` and `0:0:0:0:0:ffff:7f00:1` both match.
 */
function expandIpv6(text: string): string[] | null {
	const bare = text.split("%")[0]!.toLowerCase();
	if (!/^[0-9a-f:]+$/.test(bare) || !bare.includes(":")) return null;
	const compressed = bare.split("::");
	if (compressed.length > 2) return null;
	const headGroups = compressed[0] === "" ? [] : compressed[0]!.split(":");
	const tail = compressed[1];
	const tailGroups = tail === undefined || tail === "" ? [] : tail.split(":");
	const missing = 8 - headGroups.length - tailGroups.length;
	if (tail === undefined ? missing !== 0 : missing < 1) return null;
	return [...headGroups, ...Array<string>(Math.max(0, missing)).fill("0"), ...tailGroups]
		.map((group) => group.replace(/^0+(?=[0-9a-f])/, ""));
}

/** Loopback, unspecified, IPv4-mapped/compatible, unique-local, link-local, multicast. */
function isPrivateIpv6(bare: string): boolean {
	const groups = expandIpv6(bare);
	if (groups === null) return false;
	if (groups[0]!.match(/^f[cd]/)) return true; // fc00::/7 unique-local
	if (groups[0]!.match(/^fe[89ab]/)) return true; // fe80::/10 link-local
	if (groups[0]!.match(/^ff/)) return true; // ff00::/8 multicast
	// :: , ::1 and IPv4-compatible (::/96).
	if (groups.slice(0, 6).every((group) => group === "0")) return true;
	// IPv4-mapped (::ffff:0:0/96), however the address is spelled.
	return groups.slice(0, 5).every((group) => group === "0") && groups[5] === "ffff";
}

export function isPrivateAddress(host: string): boolean {
	const bare = host.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
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
	return isPrivateIpv6(bare);
}

function shortUrl(url: string): string {
	const visible = url.length <= 200 ? url : url.slice(0, 200) + "…";
	return JSON.stringify(visible);
}