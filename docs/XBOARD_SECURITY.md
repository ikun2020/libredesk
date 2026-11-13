# XBoard support integration security protocol 1

The companion XBoard plugin 1.1.0 preserves the existing contact identifier and
profile attributes while using bounded, revocable chat sessions. Its final
loader path is `/api/v1/support-sync/loader.js?v=1.1.0` on the XBoard origin.
The reviewed widget loader ships with the plugin; the support origin provides
the isolated iframe, not executable top-level JavaScript on the panel.

## Contract

- `GET /api/v1/widget/chat/security` reports `data.protocol: 1`.
- Signed login claims add `purpose: "login"` and an opaque 64-hex `session_id`.
  The JWT expires within 300 seconds. A successful exchange reports protocol 1.
- The scope includes the inbox and external contact identifier. The plugin
  derives its login identifier from the authenticated Sanctum token using HMAC;
  callers cannot select another account or login scope.
- A session is usable until the signed `iat + 600 seconds`. Replaying the same
  JWT or using the chat API cannot extend that deadline. A new signed heartbeat
  renews it. The opaque record is retained 24 hours to let a fresh authenticated
  exchange restore the same token after suspension without losing drafts.
- `POST .../auth/revoke` accepts a separate `purpose: "logout"` capability,
  valid at most 24 hours. It cannot be exchanged for a login. Redis atomically
  removes the scope token and creates a ten-minute replay tombstone.
- Existing WebSocket readers and writers recheck session validity. A successful
  join does not authorize future message delivery after revocation.
- `POST .../auth/revoke-legacy` accepts a server-only, five-minute
  `purpose: "revoke_legacy"` signature. An idempotent per-inbox epoch invalidates
  pre-migration authenticated sessions without deleting messages or contacts.
  New legacy sessions, visitors and other inboxes remain usable.

## Frontend and migration

The integration parent requires an iframe protocol-1 handshake before supplying
a signed identity; the iframe also verifies the exchange protocol. Same-account
lease refresh preserves conversation state and drafts. CLEAR_SESSION invalidates
late refresh results. Other integrations keep their existing identity behavior.

The plugin sets `trackPageVisits: false`. General widget visit URLs are also
sanitized server-side on writes and reads, removing credentials, queries and
fragments. Credential-bearing Axios error objects are redacted before returning
to consumers; identity exchange errors log only a generic message.

Upgrade LibreDesk before the plugin, rotate the inbox signing key and supply the
new value to XBoard through its container environment. The companion plugin
includes a CLI preview/apply tool to remove only its old `inbox_secret` from
configuration and administrator audit data, preserving the surrounding records.
Old backups are not rewritten. Existing pages need refreshing after upgrade.

No browser mechanism guarantees delivery of logout during network loss or a
forced close; the bounded lease limits residual access when revocation cannot
arrive. Keep server clocks synchronized. This does not add a general ban-event
subscription or make a down XBoard service able to serve its loader.
