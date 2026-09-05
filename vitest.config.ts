import { defineConfig } from "vitest/config";

// The lane-1..3 gate. Integration tests spawn pi in a PTY, so give them room,
// but keep the WHOLE suite under the spec's 2-minute hard ceiling — enforced in
// CI by a per-step timeout, not by a hand-rolled timer.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    // PTY spawns don't parallelize cleanly; keep the Integration lane serial.
    fileParallelism: false,
  },
});
