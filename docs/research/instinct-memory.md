# Lessons from the Instinct memory teardown

Reviewed 2026-09-24. [Dhravya Shah's article](https://supermemory.ai/blog/reverse-engineering-instinct-memory/) is linked from the [requested post](https://x.com/DhravyaShah/status/2101745550752428340). It is a reconstruction from observed behavior, not confirmed Instinct source code. It does not benchmark computer-use speed.

The article describes structured notes, compact profile/task context, recaps, retrieval, and background consolidation.

For Sidekick:

- Keep PostgreSQL. A memory service can remain an optional adapter.
- Build a small context budget for profile, active goals and relevant task recaps. Search older facts only when needed.
- Preserve sources, corrections, expiry and existing consent checks.
- Measure context size, retrieval time and consolidation cost before adding another provider.

These are follow-up recommendations, not an implemented memory pipeline.
