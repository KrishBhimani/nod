# Runtime boundaries

The React web client, Fastify API, Pi agent runner and pg-boss workers start in one Node process. PostgreSQL stores messages, task revisions, events, memory, vault ciphertext and queue jobs. Local artifact and workspace bytes live under ignored `.local/` paths.

Messages create independent task jobs. Four workers keep one waiting task from blocking another. Each task uses its own Pi session, workspace and browser session. PostgreSQL is the source of truth; SSE only prompts the interface to refresh and carries temporary streamed text. Message and job creation share one database transaction.

A secure credential request ends the task segment. The credential form calls the trusted broker directly. Successful injection queues a new segment; the model receives a status, never the submitted secret. A revision rejects stale jobs. After a server crash, interrupted running tasks need review rather than blindly repeating an external action.

Composio owns Google OAuth and token refresh. We own connection intent, event deduplication, relevance decisions, user preferences and notifications. External event data is untrusted input. A cheap classifier may select ignore, digest or wake; it cannot execute tools. Main-agent execution starts only after our policy gate.

The agent shell runs in a Docker container without networking, host secrets or the Docker socket. Node, Python and ffmpeg are preinstalled. Browser operations execute in a separate trusted service with public-web egress checks. The browser developer screen is observable only outside secret entry. General native Mac control and arbitrary runtime package downloads are outside this first boundary.

See security.md for trust limits and production.md before moving beyond localhost.
