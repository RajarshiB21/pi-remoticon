"""Pi research fetch helper.

Reads one versioned JSON request on stdin, performs the batch through a small
internal Scrapling Spider subclass, and emits newline-delimited JSON protocol
events on stdout. Logging goes to stderr only; stdout stays pure protocol.

Fixed settings (docs/spec/RESEARCH_SPEC.md section 6.2):
1..8 targets, global concurrency 4, per-domain concurrency 2, at most two
blocked retries per target, one transport attempt per session call, and
AutoThrottle enabled with 0.25s start delay, 30s cap, and block backoff.

R3 adds the fixed escalation ladder (section 6.3):
- ordinary targets: plain HTTP, throttled plain-HTTP retry, then the lazy
  Stealth browser session (solve_cloudflare available, reported only when
  observed), then an honest dead end.
- captureXhr batches: Dynamic browser first rung (XHR does not exist in plain
  HTTP), one Dynamic retry under the same throttle, then Stealth, then give up.
Browser sessions use block_ads=True and the validated blockedDomains set.
PI_RESEARCH_CDP_URL (read only in this process) points browser rungs at a
remote CDP endpoint; it is never printed, and errors are scrubbed of it.

R5 "Return to Vision" (2026-08-30, RV-1..RV-6) corrects the ladder:
- escalation triggers are NOT limited to blocked responses. A rung escalates
  when the response is blocked OR retrieved-but-unusable (2xx with empty
  extraction, the library author's own rule) OR failed at transport level.
- transport failures walk the ladder with a visible attempt record per
  attempt carrying the real error, then a truthful give-up naming it.
- the block set is extended with Cloudflare origin errors 520-526 and
  408/425 (Scrapling's default set is missing them).
- dead-end needles are context-aware: a 404 is a dead end by status; a page
  that merely mentions "page not found"/"banned"/"must log in to" is not;
  "empty content" is final only after the browser rung also finds nothing;
  tiny-but-real pages stay usable.
- browser rungs use network_idle, disable_resources, and wait_selector for
  the target's own selector (RV-5). http3 stays OFF: measured 2026-08-30 it
  fails with curl (7) on example.com-class hosts in this environment
  (google.com/cloudflare.com pass), so a blanket default would break the
  HTTP rung; the measured reason is recorded in the ledger.
"""

from __future__ import annotations

import asyncio
import ipaddress
import logging
import os
import re
import socket
import sys
import time
import traceback
from urllib.parse import urlparse

import orjson
from scrapling.engines.constants import EXTRA_RESOURCES
from scrapling.fetchers import AsyncDynamicSession, AsyncStealthySession, FetcherSession
from scrapling.spiders.request import Request
from scrapling.spiders.spider import BLOCKED_CODES, Spider
from scrapling.spiders.throttle import parse_retry_after

# RV-3 (2026-08-30): Scrapling's default block set misses Cloudflare origin
# errors 520-526 and 408/425; a real 522 died unretried. The helper's block
# check uses the extended set.
EXTENDED_BLOCKED_CODES = BLOCKED_CODES | {408, 425, 520, 521, 522, 523, 524, 525, 526}

# v3 (R5): attempt records gain unusableSignal (empty-extraction
# escalation, RV-1) and transport-failure attempts carry the real error text
# in reason (RV-2/RV-6).
PROTOCOL_VERSION = 3
GLOBAL_CONCURRENCY = 4
PER_DOMAIN_CONCURRENCY = 2
MAX_BLOCKED_RETRIES = 2
AUTO_START_DELAY = 0.25
AUTO_MAX_DELAY = 30.0
# Plain HTTP gets two rungs, so each one is deliberately short. Scrapling
# raises Stealth to 60s when Cloudflare solving is enabled; the wrapper below
# still gives every rung an end-to-end ceiling.
HTTP_TIMEOUT = 5.0
BROWSER_TIMEOUT_MS = 22_000
ATTEMPT_TIMEOUT_SECONDS = {"http": 7.0, "dynamic": 22.0, "stealth": 22.0}
PER_TARGET_CEILING = 16 * 1024
XHR_ENTRY_CEILING = 8 * 1024
XHR_MAX_ENTRIES = 16
SHORT_CHALLENGE_MAX_BYTES = 4096
# RV-4 (2026-08-30): "empty" means zero non-whitespace extracted bytes. The
# old 64-byte floor falsely flagged tiny real pages (a 23-char status page)
# and 404 bodies ("404: Not Found") as "empty content". Tiny-but-real pages
# stay usable; only truly empty extraction escalates (RV-1).
SHORT_PAGE_MAX_BYTES = 2048
NEEDLE_WINDOW_CHARS = 512

# Remote browser endpoint, read only inside this process. Never placed in a
# request, event, log line, or error message; redact() scrubs it from errors.
CDP_URL = os.environ.get("PI_RESEARCH_CDP_URL") or None
CDP_REDACTED = "<redacted-cdp-url>"

# Every textual form of the endpoint that must never leave the process:
# the full URL, the scheme://netloc form, and the bare netloc (host:port or
# host), longest first so longer forms are replaced before shorter ones.
_REDACT_FORMS: tuple[str, ...] = ()
if CDP_URL:
    _parsed = urlparse(CDP_URL)
    _forms = [CDP_URL]
    if _parsed.netloc:
        _forms.append(f"{_parsed.scheme}://{_parsed.netloc}")
        _forms.append(_parsed.netloc)
    _REDACT_FORMS = tuple(sorted(set(_forms), key=len, reverse=True))


def redact(text: str) -> str:
    """Scrub every form of the CDP endpoint from any text leaving this process."""
    if CDP_URL and text:
        for form in _REDACT_FORMS:
            text = text.replace(form, CDP_REDACTED)
    return text


_PRIVATE_V4_PREFIXES = (
    "10.", "127.", "169.254.", "172.16.", "172.17.", "172.18.", "172.19.", "172.20.",
    "172.21.", "172.22.", "172.23.", "172.24.", "172.25.", "172.26.", "172.27.",
    "172.28.", "172.29.", "172.30.", "172.31.", "192.168.", "0.", "224.", "240.",
)
_BLOCK_FINGERPRINTS = (
    ("cloudflare-just-a-moment", "just a moment"),
    ("cloudflare-attention-required", "attention required"),
    ("cloudflare-challenge-platform", "challenge-platform"),
    ("cloudflare-cf-chl", "cf-chl"),
    ("turnstile", "turnstile"),
    ("captcha-delivery", "captcha-delivery"),
    ("perimeterx", "perimeterx"),
    ("datadome", "datadome"),
    ("ddos-guard", "ddos-guard"),
    ("access-denied-shell", "access to this page has been denied"),
)
# Generic human-verification language that marks a challenge shell. These only
# count as a block when the whole body is short (GT-7 / spec 6.4): a normal
# short page is never classified as blocked by size alone.
_SHORT_CHALLENGE_NEEDLES = (
    "verify you are human",
    "verifying you are human",
    "checking your browser",
    "enable javascript and cookies",
    "enable js and cookies",
    "press and hold the button",
    "validate you are human",
)
# RV-4 (2026-08-30): dead-end needles are context-aware. A page that merely
# mentions "page not found", "banned", or "must log in to" is NOT a dead end
# (3 of 3 legit fixture pages were falsely flagged). Rules:
# - 404 status is a dead end by itself ("not found"); the "page not found"
#   needle is gone entirely.
# - A needle fires only when the page is short (the dead end IS the page) and
#   the needle appears in the opening of the extracted markdown.
# - Generic wordings were dropped; only specific dead-end statements remain.
# - Login-wall needles additionally require a real login form (a password
#   input) in the page, so an article about logging in never matches.
_UNUSABLE_NEEDLES = (
    # Live Reddit banned-community wording (observed 2026-08-29):
    # "This subreddit was banned due to being unmoderated."
    ("banned subreddit", "this subreddit was banned"),
    ("banned subreddit", "banned due to being unmoderated"),
    ("banned page", "has been banished"),
    ("login wall", "you must be logged in"),
    ("login wall", "must log in to"),
    ("deleted content", "content was deleted"),
)
_LOGIN_FORM_SELECTOR = "input[type=password]"
_DATA_URI = re.compile(r"!\[([^\]\n]*)\]\(data:[^)\s]{0,8192}?[^)]*\)")


def _peak_rss_bytes() -> int | None:
    """Peak working set of this helper process via Win32, no third-party deps."""
    try:
        import ctypes
        from ctypes import wintypes

        class PROCESS_MEMORY_COUNTERS(ctypes.Structure):
            _fields_ = [
                ("dwLength", wintypes.DWORD),
                ("PageFaultCount", wintypes.DWORD),
                ("PeakWorkingSetSize", ctypes.c_size_t),
                ("WorkingSetSize", ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                ("PagefileUsage", ctypes.c_size_t),
                ("PeakPagefileUsage", ctypes.c_size_t),
            ]

        counters = PROCESS_MEMORY_COUNTERS()
        counters.dwLength = ctypes.sizeof(PROCESS_MEMORY_COUNTERS)
        kernel32 = ctypes.windll.kernel32
        kernel32.GetCurrentProcess.restype = wintypes.HANDLE
        handle = kernel32.GetCurrentProcess()
        psapi = ctypes.windll.psapi
        psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESS_MEMORY_COUNTERS), wintypes.DWORD]
        psapi.GetProcessMemoryInfo.restype = wintypes.BOOL
        if psapi.GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.dwLength):
            return int(counters.PeakWorkingSetSize)
        return None
    except Exception:
        return None


class Emitter:
    """Emits NDJSON protocol events to stdout. stdout carries nothing else."""

    def __init__(self, batch_id: str) -> None:
        self.batch_id = batch_id

    def emit(self, payload: dict) -> None:
        payload = {"protocolVersion": PROTOCOL_VERSION, **payload}
        payload.setdefault("batchId", self.batch_id)
        sys.stdout.buffer.write(orjson.dumps(payload) + b"\n")
        sys.stdout.buffer.flush()


def fatal_error(emitter: Emitter | None, message: str) -> None:
    message = redact(message)[:2000]
    payload = {"protocolVersion": PROTOCOL_VERSION, "type": "fatal_error", "batchId": (emitter.batch_id if emitter else None), "error": message}
    try:
        sys.stdout.buffer.write(orjson.dumps(payload) + b"\n")
        sys.stdout.buffer.flush()
    except Exception:
        sys.stderr.write(f"pi-research helper fatal: {message[:2000]}\n")
    logging.shutdown()
    os._exit(1)


def _is_private_ip_literal(text: str) -> bool:
    """True for any IP literal that is not globally reachable.

    Handles full and compressed IPv6 spellings (including IPv4-mapped
    forms), and returns False for hostnames, so a name like 172.example.com
    is never parsed as arithmetic.
    """
    try:
        address = ipaddress.ip_address(text.strip("[]"))
    except ValueError:
        return False
    # is_global covers private, loopback, link-local, unspecified and reserved
    # ranges; multicast needs its own flag (it reports as globally reachable).
    return not address.is_global or address.is_multicast


def validate_target_url(url: str) -> str | None:
    """Return a rejection reason for a non-public http(s) target, else None.

    PI_RESEARCH_TEST_ALLOW_LOOPBACK=1 is a documented test-only gate so
    offline fixture servers on 127.0.0.1 are reachable in engineering tests.
    It is read inside the helper only; the fetch tool never sets it.
    """
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        return f"target scheme {parsed.scheme or '(empty)'} is not public http(s)"
    if parsed.username or parsed.password or "@" in parsed.netloc:
        return "target URL embeds credentials"
    hostname = (parsed.hostname or "").lower().rstrip(".")
    if hostname == "":
        return "target URL has no host"
    loopback_allowed = os.environ.get("PI_RESEARCH_TEST_ALLOW_LOOPBACK") == "1"
    if loopback_allowed and (hostname == "localhost" or hostname == "127.0.0.1" or hostname == "::1"):
        return None
    if hostname == "localhost" or hostname.endswith(".localhost") or hostname.endswith(".local"):
        return f"target host {hostname} is not public"
    if _is_private_ip_literal(hostname):
        return "target host is a private, loopback, or link-local address"
    return None


class ResearchSpider(Spider):
    """One batch of targets through the fixed escalation ladder (R3 scope)."""

    name = "pi-research"
    concurrent_requests = GLOBAL_CONCURRENCY
    concurrent_requests_per_domain = PER_DOMAIN_CONCURRENCY
    max_blocked_retries = MAX_BLOCKED_RETRIES
    download_delay = 0.0
    autothrottle_enabled = True
    autothrottle_start_delay = AUTO_START_DELAY
    autothrottle_max_delay = AUTO_MAX_DELAY
    autothrottle_block_backoff = True
    logging_level = logging.WARNING
    robots_txt_obey = False
    development_mode = False

    def __init__(self, request: dict, emitter: Emitter) -> None:
        self._request = request
        self._emitter = emitter
        self._targets = {t["id"]: t for t in request["targets"]}
        self.start_urls = [t["url"] for t in request["targets"]]
        self._finished_ids: set[str] = set()
        self._finished_pages: list[dict] = []
        # Targets whose fetch already produced a response: a later on_error
        # for them is a parse-callback failure, not a transport failure (RV-2).
        self._responded_ids: set[str] = set()
        # Tier actually used per target, collected from every executed attempt.
        self._used_tiers: dict[str, set] = {}
        self._blocked_domains: set[str] = set(request.get("blockedDomains") or [])
        # One DNS verdict per unique host per batch: the pre-flight target check
        # and the browser request guard share it (SSRF hardening).
        self._host_public: dict[str, bool] = {}
        super().__init__()

    async def _host_is_public(self, host: str) -> bool:
        """True only when every address the host resolves to is globally routable.

        Resolution failures count as non-public: a host this machine cannot
        resolve is not one to connect to. The documented test gate admits the
        loopback forms its offline fixtures use. Cached per batch.
        """
        host = host.lower().rstrip(".")
        if os.environ.get("PI_RESEARCH_TEST_ALLOW_LOOPBACK") == "1" and host in {"localhost", "127.0.0.1", "::1"}:
            return True
        cached = self._host_public.get(host)
        if cached is not None:
            return cached
        try:
            infos = await asyncio.get_running_loop().getaddrinfo(host, None, type=socket.SOCK_STREAM)
        except OSError:
            public = False
        else:
            public = bool(infos) and all(
                not _is_private_ip_literal(str(info[4][0]).split("%", 1)[0]) for info in infos
            )
        self._host_public[host] = public
        return public

    async def _guard_browser_request(self, route) -> None:
        """Refuse browser requests to hosts that do not resolve publicly.

        Installed with page_setup, so it runs before navigation and applies to
        every request the page itself makes. Server redirects are not routed by
        Playwright (verified live in 1.62), so the landed URL is checked in
        parse() instead. Everything this guard allows falls through to
        Scrapling's own resource/domain interceptor.
        """
        if route.request.resource_type in EXTRA_RESOURCES:
            await route.fallback()
            return
        host = (urlparse(route.request.url).hostname or "").lower().rstrip(".")
        if host and not await self._host_is_public(host):
            self.logger.info(f"blocked a browser request to non-public host {host}")
            await route.abort()
        else:
            await route.fallback()

    async def _install_public_route_guard(self, page) -> None:
        await page.route("**/*", self._guard_browser_request)

    def configure_sessions(self, manager) -> None:
        manager.add(
            "http",
            # retries=1 is one attempt (no hidden transport retry, RV-6);
            # retry_delay is set so any future retry would be honest. http3
            # stays OFF: measured 2026-08-30 it fails with curl (7) on
            # example.com-class hosts in this environment.
            FetcherSession(impersonate="chrome", follow_redirects="safe", retries=1, retry_delay=0.5, timeout=HTTP_TIMEOUT),
            default=True,
        )
        # Browser sessions are lazy: nothing launches until a target actually
        # escalates (or the batch starts on Dynamic for captureXhr). One pool
        # per tier, capped at the global concurrency; retries=1 means exactly
        # one transport attempt per Spider rung (spec 6.2).
        common = {
            "headless": True,
            "block_ads": True,
            "blocked_domains": self._blocked_domains or None,
            "retries": 1,
            "timeout": BROWSER_TIMEOUT_MS,
            "max_pages": GLOBAL_CONCURRENCY,
            "cdp_url": CDP_URL,
        }
        if self._request.get("captureXhr"):
            manager.add(
                "dynamic",
                # wait=800: a short settle beat so background fetch/XHR
                # responses land before the page closes (capture_xhr).
                AsyncDynamicSession(**common, capture_xhr=self._request["captureXhr"], wait=800, page_setup=self._install_public_route_guard),
                lazy=True,
            )
        manager.add("stealth", AsyncStealthySession(**common, solve_cloudflare=True, page_setup=self._install_public_route_guard), lazy=True)

    async def start_requests(self):
        # captureXhr opts the whole batch into a browser-capable first rung
        # because plain HTTP has no XHR (spec 6.3).
        first_tier = "dynamic" if self._request.get("captureXhr") else "http"
        for target in self._request["targets"]:
            host = (urlparse(target["url"]).hostname or "").lower().rstrip(".")
            if host and not await self._host_is_public(host):
                # No request is made, so there is no attempt to record; the
                # receipt says why the target was never fetched.
                self._finalize_page(
                    target["id"],
                    None,
                    selector=(target.get("selector") or None),
                    dead_end_reason=f"host {host} does not resolve to a public address",
                )
                continue
            tier = first_tier
            kwargs = self._browser_kwargs(target) if tier == "dynamic" else {}
            # RV-9 known-hard-domain fast path: some sites (reddit.com,
            # verified 2026-08-30) 403 the plain-HTTP rung at the bot wall
            # every time, so the first attempt is a wasted round-trip and an
            # extra block signal. Open those directly on the browser rung;
            # the receipt records the decision honestly.
            if tier == "http" and self._is_known_hard_domain(target["url"]):
                tier = "dynamic"
                kwargs = self._browser_kwargs(target)
            yield Request(
                target["url"],
                sid=tier,
                meta={"targetId": target["id"], "_pi_first_tier": tier},
                dont_filter=True,
                **kwargs,
            )

    # Domains whose first plain-HTTP rung is known to 403 at the bot wall
    # regardless of headers (verified live 2026-08-30: www.reddit.com HTML
    # recovers only from the browser rung onward). Matching is by registrable
    # domain suffix so every path and subdomain is covered.
    KNOWN_HARD_DOMAINS = ("reddit.com",)

    def _is_known_hard_domain(self, url: str) -> bool:
        try:
            host = urlparse(url).hostname or ""
        except ValueError:
            return False
        host = host.lower().rstrip(".")
        return any(host == d or host.endswith("." + d) for d in self.KNOWN_HARD_DOMAINS)

    def _browser_kwargs(self, target: dict | None) -> dict:
        """RV-5: the wider session surface on browser rungs. network_idle
        waits for the page to settle, disable_resources drops fonts/images/
        media for speed (XHR/fetch is NOT dropped, so captureXhr stays
        intact), and wait_selector waits for the target's own selector when
        one was given."""
        kwargs: dict = {"network_idle": True, "disable_resources": True}
        selector = ((target or {}).get("selector") or "").strip()
        if selector:
            kwargs["wait_selector"] = selector
        return kwargs

    async def retry_blocked_request(self, request: Request, response) -> Request:
        """Fixed ladder: rung 2 stays on the first tier (plain HTTP or the
        Dynamic browser), rung 3 escalates to the Stealth browser with the
        RV-5 browser surface."""
        if request._retry_count >= 2:
            request.sid = "stealth"
            request._session_kwargs.update(self._browser_kwargs(self._target_of(str(request.meta.get("targetId", "")))))
        return request

    async def on_start(self, resuming: bool = False) -> None:
        throttle = self._engine._autothrottle if self._engine else None
        if throttle is not None:
            orig_delay_for = throttle.delay_for
            # Snapshot the delay the engine just applied. We read the LATEST
            # value at fetch time instead of queueing every delay_for call:
            # AutoThrottle.record() calls delay_for internally, so a FIFO
            # queue would collect phantom entries and misattribute waits
            # across attempts. The value read when a request's fetch starts
            # is the delay that was applied to that request.
            latest_delays: dict[str, float] = {}

            def recording_delay_for(domain: str, floor: float = 0.0) -> float:
                delay = orig_delay_for(domain, floor)
                if delay and delay > 0:
                    latest_delays[domain] = delay
                return delay

            throttle.delay_for = recording_delay_for
            self._latest_delays = latest_delays

        manager = self._session_manager
        orig_fetch = manager.fetch
        overall_start = time.time()

        async def timed_fetch(req):
            started = time.time()
            tier = str(req.sid) or "http"
            ceiling = ATTEMPT_TIMEOUT_SECONDS.get(tier, 35.0)
            try:
                response = await asyncio.wait_for(orig_fetch(req), timeout=ceiling)
            except asyncio.TimeoutError as error:
                raise TimeoutError(f"{tier} attempt exceeded {ceiling:g} seconds") from error
            elapsed_ms = round((time.time() - started) * 1000, 1)
            latest = getattr(self, "_latest_delays", {})
            wait_ms = round(latest.get(req.domain, 0.0) * 1000, 1)
            response.meta["_pi_latency_ms"] = elapsed_ms
            response.meta["_pi_wait_ms"] = wait_ms
            response.meta["_pi_started_at"] = started
            return response

        manager.fetch = timed_fetch
        self._overall_start = overall_start
        # The engine clears self._engine when the crawl ends; snapshot what the
        # final receipt needs while the objects are alive.
        engine = self._engine
        self._stats_ref = engine.stats if engine is not None else None
        self._throttle_ref = throttle
        self._emit_batch_started()

    def _emit_batch_started(self) -> None:
        # Configured ladder capability, not actual usage: browser rungs will
        # run against the remote endpoint when PI_RESEARCH_CDP_URL is set.
        self._emitter.emit({
            "type": "batch_started",
            "startedAt": round(time.time() * 1000),
            "browserMode": "remote-cdp" if CDP_URL else "local",
            "globalConcurrency": self.concurrent_requests,
            "perDomainConcurrency": self.concurrent_requests_per_domain,
            "maxBlockedRetries": self.max_blocked_retries,
            "autoThrottle": {
                "enabled": self.autothrottle_enabled,
                "startDelayMs": round(self.autothrottle_start_delay * 1000, 1),
                "maxDelayMs": round(self.autothrottle_max_delay * 1000, 1),
                "blockBackoff": self.autothrottle_block_backoff,
            },
            "targetCount": len(self._targets),
        })

    def _target_of(self, target_id: str | None) -> dict | None:
        if isinstance(target_id, str):
            return self._targets.get(target_id)
        return None

    def _record_tier(self, target_id: str, tier: str) -> None:
        self._used_tiers.setdefault(target_id, set()).add(tier)

    def _tier_facts(self, target_id: str) -> tuple[bool, bool, int]:
        """(usedStealth, usedAdBlocking, blockedDomainsCount) from real attempts."""
        tiers = self._used_tiers.get(target_id, set())
        used_stealth = "stealth" in tiers
        used_browser = bool(tiers & {"stealth", "dynamic"})
        return used_stealth, used_browser, len(self._blocked_domains) if used_browser else 0

    def _block_check(self, response) -> tuple[bool, str | None]:
        if response.status in EXTENDED_BLOCKED_CODES:
            return True, f"status {response.status}"
        try:
            body = response.body or b""
            head = body[:65536].decode("utf-8", errors="ignore").lower()
        except Exception:
            return False, None
        for label, needle in _BLOCK_FINGERPRINTS:
            if needle in head:
                return True, label
        # A short body plus generic human-verification language is a challenge
        # shell. Size alone never decides: a short page without a needle is
        # never classified as blocked.
        if len(body) < SHORT_CHALLENGE_MAX_BYTES:
            for needle in _SHORT_CHALLENGE_NEEDLES:
                if needle in head:
                    return True, "short challenge body"
        return False, None

    async def is_blocked(self, response) -> bool:
        request = getattr(response, "request", None)
        target_id = str(request.meta.get("targetId", "")) if request is not None else ""
        attempt = (request._retry_count + 1) if request is not None else 1
        tier = str(request.sid) if request is not None else "http"
        if target_id:
            self._record_tier(target_id, tier)
            # The fetch succeeded: a later on_error for this target is a
            # parse-callback failure, not a transport failure (RV-2).
            self._responded_ids.add(target_id)
        blocked, signal = self._block_check(response)
        if blocked:
            # Blocked rungs emit their attempt record here; non-blocked rungs
            # emit in parse() so the record can carry the empty signal.
            self._emit_attempt(response, request, target_id, tier, blocked_signal=signal)
        if blocked and request is not None and request._retry_count >= self.max_blocked_retries:
            reason = f"blocked after {attempt} attempts"
            if tier == "stealth":
                reason += ", including stealth"
            self._finalize_page(target_id, response, usable=False, dead_end_reason=reason)
        return blocked

    def _emit_attempt(self, response, request, target_id: str, tier: str, *, blocked_signal: str | None = None, unusable_signal: str | None = None, error: Exception | None = None) -> None:
        """One visible attempt record per rung (RV-6). Transport failures
        carry the real error text, redacted and bounded."""
        if not target_id:
            return
        meta = getattr(response, "meta", {}) if response is not None else {}
        attempt = (request._retry_count + 1) if request is not None else 1
        retry_after = parse_retry_after(response.headers) if (response is not None and blocked_signal) else None
        if error is not None:
            reason = redact(str(error))[:200]
            started = round(time.time() * 1000)
        else:
            reason = response.reason if response is not None else None
            started = round((meta.get("_pi_started_at") or 0) * 1000)
        self._emitter.emit({
            "type": "attempt_finished",
            "attempt": {
                "targetId": target_id,
                "url": str(request.url) if request is not None else "",
                "attempt": attempt,
                "tier": tier,
                "status": response.status if response is not None else None,
                "reason": reason,
                "receivedBytes": len(response.body or b"") if response is not None else None,
                "latencyMs": meta.get("_pi_latency_ms"),
                "waitMs": meta.get("_pi_wait_ms"),
                "retryAfterSeconds": retry_after,
                "blockedSignal": blocked_signal,
                "unusableSignal": unusable_signal,
                "startedAt": started,
                "completedAt": round(time.time() * 1000),
            },
        })

    def _extract_markdown(self, response, selector: str | None) -> tuple[str, int, bool]:
        """Sanitized bounded Markdown for this rung. Raw HTML never leaves."""
        try:
            text = response.markdown(css_selector=selector, main_content_only=True)
        except Exception:
            text = ""
        text = _DATA_URI.sub(lambda m: f"`image {m.group(1)}`" if m.group(1) else "image", text)
        total_bytes = len(text.encode("utf-8"))
        selector_applied = bool(selector) and total_bytes > 0
        return text, total_bytes, selector_applied

    def _extract_captured_xhr(self, response) -> list[dict]:
        """Bounded, labeled captured XHR entries. JSON is preferred when valid;
        text is control-stripped otherwise. Never raw HTML."""
        captured: list[dict] = []
        for entry in (getattr(response, "captured_xhr", None) or ())[:XHR_MAX_ENTRIES]:
            body = entry.body or b""
            text = ""
            try:
                parsed = orjson.loads(body)
                text = orjson.dumps(parsed, option=orjson.OPT_INDENT_2).decode("utf-8", errors="ignore")
            except Exception:
                text = body.decode("utf-8", errors="ignore")
            text = "".join(ch for ch in text if ch >= " " or ch in "\n\t")
            raw = text.encode("utf-8")
            truncated = len(raw) > XHR_ENTRY_CEILING
            kept = raw[:XHR_ENTRY_CEILING].decode("utf-8", errors="ignore") if truncated else text
            captured.append({
                "url": entry.url or "",
                "status": entry.status,
                "bytes": len(body),
                "truncated": truncated,
                "content": kept,
            })
        return captured

    def _bounded_excerpt(self, target_id: str, text: str) -> tuple[str, int, int, str | None, bool]:
        raw = text.encode("utf-8")
        if len(raw) <= PER_TARGET_CEILING:
            return text, len(raw), len(raw), None, False
        kept = raw[:PER_TARGET_CEILING].decode("utf-8", errors="ignore")
        full_name = f"{target_id}.md"
        full_path = os.path.join(self._request["outputDir"], full_name)
        with open(full_path, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
        return kept, PER_TARGET_CEILING, len(raw), full_path, True

    def _dead_end_reason(self, response, markdown_text: str) -> str | None:
        """Status-based dead ends first, then context-aware needles (RV-4)."""
        status = response.status
        if status == 404:
            return "not found"
        if status == 410:
            return "gone"
        if status is not None and not (200 <= status < 300):
            return f"status {status}"
        if len(markdown_text.encode("utf-8")) >= SHORT_PAGE_MAX_BYTES:
            return None
        text = markdown_text[:NEEDLE_WINDOW_CHARS].lower()
        for label, needle in _UNUSABLE_NEEDLES:
            if needle in text:
                if label == "login wall" and not self._has_login_form(response):
                    continue
                return label
        return None

    def _has_login_form(self, response) -> bool:
        """A real login wall carries a password input; a mention article does not."""
        try:
            return bool(response.css(_LOGIN_FORM_SELECTOR))
        except Exception:
            return False

    async def parse(self, response):
        request = getattr(response, "request", None)
        target_id = str(request.meta.get("targetId", "")) if request is not None else ""
        target = self._target_of(target_id)
        if target is None or target_id in self._finished_ids:
            yield None
            return
        tier = str(request.sid) if request is not None else "http"
        self._record_tier(target_id, tier)
        selector = (target.get("selector") or "").strip() or None
        # A redirect hop is followed by the transport without reaching our
        # request guards: verified live, Playwright 1.62 does not invoke route
        # handlers for server redirects, and the HTTP tier's curl "safe" mode
        # only covers its own redirects. The landed URL is therefore checked
        # here, before any of its content is read.
        final_host = (urlparse(response.url).hostname or "").lower().rstrip(".")
        if final_host and not await self._host_is_public(final_host):
            self._emit_attempt(response, request, target_id, tier, blocked_signal="redirect to a non-public address")
            self._finalize_page(
                target_id,
                None,
                selector=selector,
                dead_end_reason=f"redirected to a non-public address ({final_host})",
            )
            yield None
            return
        text, total_bytes, selector_applied = self._extract_markdown(response, selector)
        if selector is not None and not selector_applied:
            text, total_bytes, _ = self._extract_markdown(response, None)
            selector_applied = False
        empty = len(text.strip()) == 0
        self._emit_attempt(response, request, target_id, tier, unusable_signal="empty content" if empty else None)
        reason = self._dead_end_reason(response, text)
        if reason is not None:
            # Status-based dead end (404/410/other non-2xx) or a context-aware
            # needle. No ladder: the page answered, the answer is a dead end.
            self._finalize_page(target_id, response, text=text, selector=selector, selector_applied=selector_applied, usable=False, dead_end_reason=reason)
            yield None
            return
        if empty:
            # RV-1: retrieved-but-unusable walks the ladder before any
            # dead-end verdict (the library author's rule: "if it fails or
            # returns empty content, escalate"). The browser rung is the last
            # word on emptiness.
            if request is not None and request._retry_count < self.max_blocked_retries:
                retry_request = request.copy()
                retry_request._retry_count += 1
                retry_request.priority -= 1
                retry_request.dont_filter = True
                if retry_request._retry_count >= 2:
                    retry_request.sid = "stealth"
                    retry_request._session_kwargs.update(self._browser_kwargs(target))
                yield retry_request
                return
            self._finalize_page(target_id, response, text=text, selector=selector, selector_applied=selector_applied, usable=False, dead_end_reason="empty content")
            yield None
            return
        usable = response.status is not None and 200 <= response.status < 300
        self._finalize_page(target_id, response, text=text, selector=selector, selector_applied=selector_applied, usable=usable)
        yield None

    def _finalize_page(self, target_id: str, response, *, text: str | None = None, selector: str | None = None, selector_applied: bool = False, usable: bool = False, dead_end_reason: str | None = None, error: str | None = None) -> None:
        """One final receipt per target, emitted exactly once (RV-6)."""
        if target_id in self._finished_ids:
            return
        self._finished_ids.add(target_id)
        target = self._target_of(target_id) or {}
        used_stealth, used_ad_blocking, blocked_count = self._tier_facts(target_id)
        content = None
        extracted = 0
        truncation = None
        full_path = None
        if text is not None:
            content, kept_bytes, total_report, full_path, truncated = self._bounded_excerpt(target_id, text)
            extracted = total_report
            if truncated:
                truncation = {"truncated": True, "keptBytes": kept_bytes, "totalBytes": total_report, "outputPath": full_path}
        page = {
            "targetId": target_id,
            "requestedUrl": target.get("url", ""),
            "finalUrl": response.url if response is not None else None,
            "selector": selector,
            "selectorApplied": selector_applied,
            "finalStatus": response.status if response is not None else None,
            "finalReason": response.reason if response is not None else None,
            "receivedBytes": len(response.body or b"") if response is not None else None,
            "extractedBytes": extracted,
            "usedStealth": used_stealth,
            "usedAdBlocking": used_ad_blocking,
            "blockedDomainsCount": blocked_count,
            "usable": usable,
            "deadEndReason": dead_end_reason,
            "error": error,
            "cancelled": False,
            "content": content,
            "capturedXhr": self._extract_captured_xhr(response) if (response is not None and text is not None) else None,
            "truncation": truncation,
            "fullOutputPath": full_path,
        }
        self._finished_pages.append(page)
        self._emitter.emit({"type": "target_finished", "page": page})

    async def on_error(self, request, error: Exception) -> None:
        target_id = str(getattr(request, "meta", {}).get("targetId", ""))
        if target_id not in self._targets:
            return
        tier = str(request.sid) or "http"
        self._record_tier(target_id, tier)
        real_error = redact(str(error))[:300]
        if target_id in self._responded_ids:
            # The fetch succeeded; this error came from the parse callback.
            # No ladder: the transport worked, the extraction crashed.
            self._finalize_page(target_id, None, selector=(self._target_of(target_id) or {}).get("selector"), error=real_error)
            return
        # RV-2/RV-6: transport failure. Every attempt is visible with the
        # real error, then the ladder (same tier, then stealth), then a
        # truthful give-up naming the real error.
        self._emit_attempt(None, request, target_id, tier, error=error)
        if getattr(request, "_retry_count", 0) < self.max_blocked_retries:
            retry_request = request.copy()
            retry_request._retry_count += 1
            retry_request.priority -= 1
            retry_request.dont_filter = True
            if retry_request._retry_count >= 2:
                retry_request.sid = "stealth"
                retry_request._session_kwargs.update(self._browser_kwargs(self._target_of(target_id)))
            await self._engine.scheduler.enqueue(retry_request)
            return
        self._finalize_page(target_id, None, selector=(self._target_of(target_id) or {}).get("selector"), error=real_error)

    def _emit_batch_finished(self) -> None:
        stats = getattr(self, "_stats_ref", None)
        throttle = getattr(self, "_throttle_ref", None)
        observed = {}
        if throttle is not None:
            observed = {domain: round(delay * 1000, 1) for domain, delay in throttle.delays.items()}
        rss = _peak_rss_bytes()
        r = getattr(self, "_overall_start", None)
        resources = {
            "peakRssBytes": rss,
            "elapsedMs": round((time.time() - r) * 1000) if r else None,
        }
        browser_used = any(tiers & {"stealth", "dynamic"} for tiers in self._used_tiers.values())
        mode = "none"
        if browser_used:
            mode = "remote-cdp" if CDP_URL else "local"
        missing = [tid for tid in self._targets if tid not in self._finished_ids]
        for target_id in missing:
            target = self._target_of(target_id) or {}
            used_stealth, used_ad_blocking, blocked_count = self._tier_facts(target_id)
            self._finished_pages.append({
                "targetId": target_id,
                "requestedUrl": target.get("url", ""),
                "finalUrl": None,
                "selector": target.get("selector"),
                "selectorApplied": False,
                "finalStatus": None,
                "finalReason": None,
                "receivedBytes": None,
                "extractedBytes": None,
                "usedStealth": used_stealth,
                "usedAdBlocking": used_ad_blocking,
                "blockedDomainsCount": blocked_count,
                "usable": False,
                "deadEndReason": None,
                "error": "target produced no final receipt",
                "cancelled": False,
                "content": None,
                "capturedXhr": None,
                "truncation": None,
                "fullOutputPath": None,
            })
        self._emitter.emit({
            "type": "batch_finished",
            "completedAt": round(time.time() * 1000),
            "browserMode": mode,
            "autoThrottle": {
                "enabled": self.autothrottle_enabled,
                "startDelayMs": round(self.autothrottle_start_delay * 1000, 1),
                "maxDelayMs": round(self.autothrottle_max_delay * 1000, 1),
                "blockBackoff": self.autothrottle_block_backoff,
                "observedDelays": observed,
            },
            "stats": {
                "blockedCount": getattr(stats, "blocked_requests_count", 0) if stats else 0,
                "failedCount": getattr(stats, "failed_requests_count", 0) if stats else 0,
                "requestCount": getattr(stats, "requests_count", 0) if stats else 0,
            },
            "pages": [self._safe_summary(page) for page in self._finished_pages],
            "resources": resources,
        })

    def _safe_summary(self, page: dict) -> dict:
        """pages[] in batch_finished carries the full receipt but never content."""
        summary = {k: v for k, v in page.items() if k != "content"}
        if isinstance(summary.get("capturedXhr"), list):
            summary["capturedXhr"] = [
                {k: v for k, v in entry.items() if k != "content"} for entry in summary["capturedXhr"]
            ]
        return summary


async def _run_batch(request: dict, emitter: Emitter) -> None:
    spider = ResearchSpider(request, emitter)
    async for page in spider.stream():
        emitter.emit(page)
    spider._emit_batch_finished()


def main() -> None:
    logging.getLogger("scrapling").setLevel(logging.WARNING)
    logging.getLogger().setLevel(logging.WARNING)
    try:
        raw = sys.stdin.buffer.read()
        payload = orjson.loads(raw)
        if not isinstance(payload, dict):
            fatal_error(None, "request is not a JSON object")
            return
        if payload.get("protocolVersion") != PROTOCOL_VERSION:
            fatal_error(None, f"request protocolVersion {payload.get('protocolVersion')!r} != {PROTOCOL_VERSION}")
            return
        batch_id = payload.get("batchId")
        if not isinstance(batch_id, str) or not batch_id:
            fatal_error(None, "request has no batchId")
            return
        # The emitter exists from here on, so every later fatal_error carries
        # the batchId and the tool can surface the real reason.
        emitter = Emitter(batch_id)
        output_dir = payload.get("outputDir")
        if not isinstance(output_dir, str) or not output_dir or not os.path.isdir(output_dir):
            fatal_error(emitter, "request outputDir is missing or not a directory")
            return
        targets = payload.get("targets")
        if not isinstance(targets, list) or not (1 <= len(targets) <= 8):
            fatal_error(emitter, f"targets must be an array of 1..8, got {type(targets).__name__}")
            return
        for index, target in enumerate(targets):
            if not isinstance(target, dict) or not isinstance(target.get("url"), str):
                fatal_error(emitter, f"target {index} has no url string")
                return
            url = target["url"]
            rejection = validate_target_url(url)
            if rejection is not None:
                fatal_error(emitter, f"target {index} rejected: {rejection}")
                return
            selector = target.get("selector")
            if selector is not None and not isinstance(selector, str):
                fatal_error(emitter, f"target {index} selector must be a string")
                return
            # The id becomes part of a saved filename in _bounded_excerpt, so
            # only identifier-shaped values are accepted (path traversal guard).
            supplied = target.get("id")
            if "id" in target and (not isinstance(supplied, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,32}", supplied)):
                fatal_error(emitter, f"target {index} id must match [A-Za-z0-9_-]{{1,32}}")
                return
            target.setdefault("id", f"t{index}")
        seen_ids = set()
        for target in targets:
            if target["id"] in seen_ids:
                fatal_error(emitter, f"duplicate target id {target['id']}")
                return
            seen_ids.add(target["id"])
        blocked_domains = payload.get("blockedDomains")
        if blocked_domains is not None:
            if not isinstance(blocked_domains, list) or not (0 <= len(blocked_domains) <= 32):
                fatal_error(emitter, "blockedDomains must be an array of 0..32 strings")
                return
            seen_entries: set[str] = set()
            for index, entry in enumerate(blocked_domains):
                if not isinstance(entry, str) or not entry.strip():
                    fatal_error(emitter, f"blockedDomains[{index}] is not a non-empty string")
                    return
                if "://" in entry or "/" in entry or "@" in entry or any(ch.isspace() for ch in entry):
                    fatal_error(emitter, f"blockedDomains[{index}] must be a bare domain with no scheme, path, credentials, or whitespace")
                    return
                lowered = entry.lower()
                if lowered in seen_entries:
                    fatal_error(emitter, f"blockedDomains[{index}] duplicates {entry!r}")
                    return
                seen_entries.add(lowered)
            for target in targets:
                host = (urlparse(target["url"]).hostname or "").lower()
                for entry in seen_entries:
                    if host == entry or host.endswith("." + entry):
                        fatal_error(emitter, f"blockedDomains entry {entry!r} would block target host {host}")
                        return
        capture_xhr = payload.get("captureXhr")
        if capture_xhr is not None:
            if not isinstance(capture_xhr, str) or not capture_xhr.strip():
                fatal_error(emitter, "captureXhr must be a non-empty string")
                return
            if any(ord(ch) < 32 for ch in capture_xhr):
                fatal_error(emitter, "captureXhr must not contain control characters")
                return
            try:
                re.compile(capture_xhr)
            except re.error as error:
                fatal_error(emitter, f"captureXhr is not a valid regex: {redact(str(error))}")
                return
        asyncio.run(_run_batch(payload, emitter))
    except SystemExit:
        raise
    except KeyboardInterrupt:
        logging.shutdown()
        os._exit(130)
    except BaseException as error:
        parts = [f"{type(error).__name__}: {error}"]
        for sub in getattr(error, "exceptions", ()) or ():
            trace = getattr(sub, "__traceback__", None)
            lines = traceback.format_exception_only(type(sub), sub)
            parts.append(" | ".join(line.strip() for line in lines)[-400:])
        fatal_error(locals().get("emitter"), redact(" ".join(parts)))


if __name__ == "__main__":
    main()
