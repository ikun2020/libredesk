# Unsigned XBoard visitor profiles

The `LibredeskSyncLite` XBoard plugin reads the signed-in browser's
existing `/api/v1/user/info` and `/api/v1/user/getSubscribe` responses. It sends
only email and five display attributes to a cross-origin chat iframe. It does
not send an XBoard bearer token, subscription token/URL, account ID, or a JWT.

This is the maintained XBoard integration. The former custom signed integration
has been removed; LibreDesk's original JWT integration remains available.
The profiles are **unverified browser statements**, not authorization, billing
evidence, or a verified contact identity. The plugin needs no signing key and
adds no XBoard tables. XBoard's own plugin manager still saves plugin settings.

## Protocol

- The iframe uses `integration=lite` and an explicit `parent_origin`.
- `VUE_APP_READY` advertises `visitorProfileProtocol: 1`.
- The exact parent window and origin may send
  `{type: 'SET_VISITOR_PROFILE', profile: {email, contact_custom_attributes}}`.
- The only custom attribute keys are `xboard_balance`, `xboard_used_traffic`,
  `xboard_total_traffic`, `xboard_expires_at`, and `xboard_plan`.
- Before any chat starts, the profile stays in iframe memory. The first real
  message or attachment includes `visitor_profile` in normal chat initialization.
- An existing visitor updates via `POST /api/v1/widget/chat/visitor/profile`,
  with the existing random visitor bearer and inbox header. Success is
  `{data: true}`. No visitor, conversation, message or login session is created
  by this endpoint. Campaign replies keep their normal initialization payload
  and synchronize after saving their resulting visitor session.

The API accepts at most 4096 profile bytes, a valid email of up to 254 bytes,
and at most the five allowed string attributes of up to 256 UTF-8 bytes each.
Unknown selectors and attributes, non-string values, and control characters
are rejected. The session visitor flag and the current database visitor type
are both checked. The update itself also requires an enabled, non-deleted
visitor without an external identity. It never resolves or merges by email.
Existing unrelated custom attributes are preserved.

The plugin's locally bundled widget maintains random visitor tokens in
sessionStorage scoped to the tab, inbox, and a local digest of the XBoard login
token. Logout or a changed login destroys the old iframe and clears its tokens;
the digest is never sent to LibreDesk. Same-session profile updates preserve
drafts. This does not provide cross-device identity continuity or server-side
session revocation.

Configure the livechat inbox to allow visitors. Existing Contact/Text attribute
definitions can be reused. An older LibreDesk iframe
without the capability flag continues ordinary visitor chat but receives no
profile; the plugin reports that the companion server update is required.

## Verification

Frontend tests cover capability/origin isolation, waiting for a real message,
attachment initialization, existing visitor updates, serialized refresh,
logout cancellation, draft preservation, and signed-mode exclusion. Go tests
cover strict decoding, missing/wrong/verified session rejection, same-email
identity separation, SQL type guards, and unchanged conversation/message counts.
The PostgreSQL tests use `LIBREDESK_TEST_DB_DSN` in CI.

## Retiring the former signed plugin

Existing Lite 1.0.0 installations and footer snippets are unchanged. Disable or
uninstall the former `libredesk_sync` plugin in XBoard; keep `libredesk_sync_lite`.
No application data or conversations need deleting, and the cleanup release
does not add a database migration.

The removed custom security, lease refresh and revoke endpoints are not used by
Lite. A small compatibility check rejects the retired signed claims and stored
secure sessions and continues honoring pre-existing legacy revocation epochs.
It cannot issue or renew a retired session. This prevents rollback to ordinary
JWT handling from reviving expired/revoked credentials. Ordinary JWT users and
Lite's visitor sessions continue using their respective normal paths.
