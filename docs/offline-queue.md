# Offline mutation queue

`PWAManager` persists queued requests in the browser's versioned local-storage queue. Entries survive refreshes and disconnects. The page replays them in FIFO order after reconnect or a background-sync wake-up. Endpoints that support optimistic concurrency should queue their version in an `If-Match` header; HTTP `409` and `412` responses are retained as conflicts instead of being silently discarded or replayed forever.

## Conflict handling

A conflict stays in the queue and blocks later entries, preserving FIFO semantics. The offline banner shows the request label and response status. After reviewing current server state, the user may explicitly retry the same request or discard it. A retry resets its failure counter; it does not rewrite the request body or version header, so it can conflict again until the caller supplies a request based on current state. Other client errors (`400`–`499`, except `409`/`412`) remain terminal and are dropped; server errors and network failures are retained for bounded retry.

## Operational edge cases and recovery

- Private browsing, disabled storage, or quota exhaustion can prevent persistence. In those modes the queue's storage adapter degrades to best-effort behavior; do not tell users the request is safely queued unless the queue count confirms it.
- Replays require the authenticated page context. Background Sync only wakes the page; it does not replay credentials inside the service worker.
- Requests are stored in local storage. Do not put secrets or credentials in queued bodies or custom headers; authentication should be attached by the normal application request flow.
- Multiple tabs can observe the same persisted queue. Endpoints should be idempotent and enforce concurrency with `If-Match`/version checks; the server remains authoritative. Queue entries are not a cross-tab transaction lock.
- To recover from an incorrect queued operation, use **Discard** on its conflict row. To retry after updating server state, use **Retry after reviewing current state**; if the request version is now obsolete, construct a fresh operation through the normal UI.
- Rollback requires no server migration: revert the client change and clear `trellis.offline-submissions.v1` from browser local storage only if the user consents to losing queued requests. Prefer resolving or discarding individual entries first.
