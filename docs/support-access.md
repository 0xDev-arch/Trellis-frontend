# Support access

`POST /api/support-access` provides an authenticated lifecycle for scoped
support sessions. It accepts `start`, `authorize`, `audit`, and `end` actions.
Every request must use a signed actor token, and every mutation requires
`confirm: true`. The permission matrix currently grants impersonation to admins
only; maintainers and other roles are denied. A session is tied to the actor who
created it, so another administrator cannot end it or read its audit events.

Sessions default to read-only, expire after at most 30 minutes, and have a
reason recorded at creation. The `authorize` action checks the requested action
against the session scope and appends both allowed and blocked attempts to the
session audit history. Callers must check this endpoint before exposing a
support-session action; it does not itself execute operations as the target
user. The start response includes a target-facing notice string for the UI to
surface while support access is active.

The manager returns detached snapshots instead of mutable internal objects,
rejects audit writes after a session ends, and retains expired sessions so their
events are not removed by cleanup. This manager is currently process-local
memory. A deployment that needs audit history to survive restarts or multiple
instances must replace the in-memory manager with an append-only durable store
before treating it as a compliance record.

If actor-token verification is unavailable, the route fails closed. If a
support action is denied or a session expires, end the session and start a new
one with the minimum scope and duration needed. Never retry a blocked action by
raising the session scope without a new explicit confirmation.
