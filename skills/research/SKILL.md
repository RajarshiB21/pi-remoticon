---
name: research
description: Run the live research flow for this turn. Invoke with /skill:research when a question needs current-world information and you want the agent to search and fetch evidence instead of answering from memory.
---

The owner invoked research for this turn. Run the research flow now, in this order:

1. One fetch call with a concurrent search batch: google.com/search, bing.com/search, and duckduckgo.com for the same query. A blocked engine costs one target slot, not the batch.
2. Read what came back, then fetch two to four result URLs plainly and follow trails from evidence.
3. Answer from the fetched evidence. Do not answer from memory.
4. Close with a direct answer and a `Stands on:` line naming the sources the answer stands on.
