import { defineConfig } from "vitest/config";

// The lane-1..3 gate. Integration tests spawn pi in a PTY, so give them room,
// but keep the WHOLE suite under the spec's 2-minute hard ceiling — enforced in
// CI by a per-step timeout, not by a hand-rolled timer.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // A default boot's ceiling is 15s+15s=30s < testTimeout, so a hang fails
    // with termless's own message. hookTimeout covers the cold warm-up boot
    // (60s+30s=90s). The two-boot determinism test sets its own timeout inline.
    testTimeout: 45000,
    hookTimeout: 100000,
    // PTY spawns don't parallelize cleanly; keep the Integration lane serial.
    fileParallelism: false,
  },
});
