"""Deterministic selfcheck for the v4 route hardcodes and detection
needles in helper.py (locked decisions a-g). Run with the same
interpreter the fetch tool resolves, from the repo root:

    python lib/research/selfcheck_routes.py

Exits 0 when every case passes, 1 on the first failure, printing one
line per case. No network, no browser, no Scrapling spider is started.
"""

import sys

import helper
from helper import RETIRED_SURFACES, ROUTE_TABLE, ResearchSpider, refusal_for, route_tier_for

failures: list[str] = []


def check(name: str, actual, expected) -> None:
    ok = actual == expected
    if not ok:
        failures.append(name)
    detail = "" if ok else f" (expected {expected!r})"
    print(f"{'PASS' if ok else 'FAIL'} {name}: {actual!r}{detail}")


class FakeResponse:
    """_block_check reads response.status and response.body only."""

    def __init__(self, status, body: bytes):
        self.status = status
        self.body = body
        self.headers = {}


def main() -> None:
    print(f"ROUTE_TABLE = {ROUTE_TABLE!r}")
    print(f"RETIRED_SURFACES = {RETIRED_SURFACES!r}")

    # Route table: the locked routes, one request per query.
    check("google.com/search routes stealth", route_tier_for("https://www.google.com/search?q=x"), "stealth")
    check("google.com/search routes stealth", route_tier_for("https://google.com/search?q=x"), "stealth")
    check("google.com non-search stays on the ladder", route_tier_for("https://www.google.com/about"), None)
    check("google.com near-miss path stays on the ladder", route_tier_for("https://www.google.com/searchx"), None)
    check("bing.com/search routes dynamic", route_tier_for("https://www.bing.com/search?q=x"), "dynamic")
    check("duckduckgo.com main routes dynamic", route_tier_for("https://duckduckgo.com/?q=x"), "dynamic")
    check("lite.duckduckgo.com routes dynamic (suffix match)", route_tier_for("https://lite.duckduckgo.com/lite/?q=x"), "dynamic")
    check("reddit.com is not routed (already the fast path)", route_tier_for("https://www.reddit.com/r/x/"), None)
    check("example.com stays on the ladder", route_tier_for("https://example.com/page"), None)

    # Retired surfaces, refused before any transport attempt.
    check("old.reddit.com is refused", refusal_for("https://old.reddit.com/r/SillyTavernAI/"), "old.reddit.com requires a login; fetch www.reddit.com instead")
    check("www.old.reddit.com is refused", refusal_for("https://www.old.reddit.com/r/x/"), "old.reddit.com requires a login; fetch www.reddit.com instead")
    check("html.duckduckgo.com is refused", refusal_for("https://html.duckduckgo.com/html/?q=x"), "html.duckduckgo.com serves a challenge shell this tool cannot use; fetch duckduckgo.com or lite.duckduckgo.com")
    check("www.reddit.com is not refused", refusal_for("https://www.reddit.com/r/x/"), None)
    check("duckduckgo.com is not refused", refusal_for("https://duckduckgo.com/?q=x"), None)
    check("example.com is not refused", refusal_for("https://example.com/"), None)

    # Detection needles: DuckDuckGo-style challenge shells read as blocked,
    # not usable (measured 2026-09-14: status 202, ~13.9KB, the wording in
    # the head). A 202 with a short body is the same anomaly without the
    # branding. A real 202 Accepted with a long body is not a block, and
    # neither is a 200 that merely mentions the wording.
    ddg_wording = b"Please complete the following challenge to confirm this search was made by a human"
    padded = b"x" * 10_000 + ddg_wording
    check("202 plus the DDG wording is blocked", ResearchSpider._block_check(None, FakeResponse(202, ddg_wording + b" more shell")), (True, "search challenge shell"))
    check("202 plus the DDG wording past the short cap is blocked", ResearchSpider._block_check(None, FakeResponse(202, padded)), (True, "search challenge shell"))
    check("202 with a short body is blocked", ResearchSpider._block_check(None, FakeResponse(202, b"queued for processing")), (True, "202 challenge shell"))
    check("202 with a long body without the wording stays usable", ResearchSpider._block_check(None, FakeResponse(202, b"x" * 10_000)), (False, None))
    check("200 mentioning the wording stays usable", ResearchSpider._block_check(None, FakeResponse(200, ddg_wording)), (False, None))
    check("a 429 still reports its status", ResearchSpider._block_check(None, FakeResponse(429, b"sorry")), (True, "status 429"))

    if failures:
        print(f"SELFCHECK FAILED: {len(failures)} case(s): {', '.join(failures)}")
        sys.exit(1)
    print("SELFCHECK PASSED")


if __name__ == "__main__":
    main()