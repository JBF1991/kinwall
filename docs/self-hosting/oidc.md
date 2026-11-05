# Optional single sign-on (OIDC)

Self-hosted Kinwall can offer **Sign in with …** alongside passkeys, recovery codes and
**Set up a wall screen or kid's device**. It uses OpenID Connect authorization code login,
S256 PKCE and a confidential client with `client_secret_basic`. ID tokens must be signed with
RS256. This is household login, not Google/Microsoft calendar consent or Kinwall's OAuth
server for connected apps.

**Wall screens still pair with a code.** They do not need a directory account, an OIDC cookie
or an Authelia session. A parent signed in with OIDC or a passkey can approve the code in
**Settings → Access**. Turning OIDC off does not revoke independently paired walls.

This feature is off by default. Finish ordinary first-run setup first and keep a working
passkey and recovery codes as an independent way back in. Native apps continue to use their
existing pairing/sign-in flows; the new button is for a standalone browser.

## Configure Kinwall

OIDC requires an HTTPS `PUBLIC_URL` at the origin root (no ingress subpath), and HTTPS issuer
and provider endpoints. There is deliberately no insecure-development or TLS-verification bypass.
The issuer is trusted operator configuration, not a family-entered feed URL. Its discovery,
token and signing-key endpoints must be reachable from the server. This does not relax the
private-address restrictions on calendar feeds or other person-supplied URLs.

| Variable | Purpose |
|---|---|
| `OIDC_ISSUER` | Exact issuer URL, e.g. `https://auth.example.test`. Discovery must report the same issuer. |
| `OIDC_CLIENT_ID` | The confidential client registered at your provider, e.g. `kinwall`. |
| `OIDC_CLIENT_SECRET` | Client secret; use a runtime secret, never bake it into an image or source. |
| `OIDC_CLIENT_SECRET_FILE` | Node/Docker only: read the secret from this file instead of the environment value. |
| `OIDC_IDENTITY_MAP` | JSON allowlist mapping exact provider `sub` values to existing members and scopes. Required; `{}` denies everyone. |
| `OIDC_IDENTITY_MAP_FILE` | Node/Docker only: read the allowlist from a private mounted file instead of the environment value. |
| `OIDC_BUTTON_LABEL` | Provider name on the button, e.g. `Authelia`. Defaults to “Single sign-on”. |
| `OIDC_SESSION_SECONDS` | Local session lifetime, 3600 seconds by default; integer from 60 to 86400. |

A partial or invalid configuration disables OIDC; it never falls back to allowing everyone.
Files are read at Node startup; restart after changing a file or its mounted contents.
On Workers/embedding hosts, supply the equivalent string bindings through `Env`.

Register this **exact** redirect URI at the provider:

```text
https://family.example.test/api/oidc/callback
```

Use real existing member IDs from your instance's authenticated members API. Example allowlist
(fictional subjects and member IDs):

```json
{
  "provider-subject-for-alex": { "scope": "admin", "memberId": "alex-member-id" },
  "provider-subject-for-sam": { "scope": "admin", "memberId": "sam-member-id" },
  "provider-subject-for-maya": { "scope": "display", "memberId": "maya-member-id" }
}
```

Obtain each immutable `sub` through your provider's trusted administrative tools for **this
client**, not from an unverified JWT or an online token decoder. Subjects can be client/sector
specific. Do not map usernames, display names or email addresses: renamed/reassigned names
must not silently claim an existing member's identity. Kinwall never creates members on login.

- `admin` must map to an existing member marked as a grown-up. It grants **all parent
  permissions**, including managing passkeys, pairing walls and creating API keys. It opens
  that grown-up's private journal, just like their own passkey. Review this trust carefully.
- `display` must map to an existing kid. It has existing everyday-access permissions, with
  that kid's locked family filter; it cannot become a parent or approve pairings.
- There is no default role and no implicit promotion from a provider group. Configure your
  provider's own client policy to require the desired groups and MFA as a second restriction.
- An OIDC session cannot reassign its member through **Whose device is this?**; the server's
  explicit mapping controls it.

## Authelia example

Merge a client and policy into your existing Authelia OIDC provider configuration. Keep its
existing signing keys and other clients. Replace the hostname, group name and secret hash.
Generate a new client secret privately with Authelia's supported tooling: Authelia gets its
hash and Kinwall gets the matching original secret through its runtime secret file.

```yaml
identity_providers:
  oidc:
    authorization_policies:
      kinwall_access:
        default_policy: deny
        rules:
          - policy: two_factor
            subject: ['group:KinwallParents']
    clients:
      - client_id: kinwall
        client_name: Kinwall
        client_secret: '<Authelia-supported hash of the client secret>'
        public: false
        authorization_policy: kinwall_access
        consent_mode: auto
        require_pkce: true
        pkce_challenge_method: S256
        redirect_uris: ['https://family.example.test/api/oidc/callback']
        scopes: ['openid', 'profile']
        response_types: ['code']
        grant_types: ['authorization_code']
        token_endpoint_auth_method: client_secret_basic
```

A policy allowing only parents will intentionally not admit a kid's OIDC subject; use a
separately reviewed client policy if you also want kid browser sign-in. A provider account
still needs an exact Kinwall subject mapping after it passes that policy.

Do **not** add blanket Authelia forward authentication in front of Kinwall. OIDC runs inside
Kinwall and the callback, anonymous wall pairing and calendar callbacks must still reach it.

## Sessions, revocation and security

The provider sends its code to Kinwall. Kinwall checks a short-lived browser-bound ceremony,
state, nonce, S256 PKCE, issuer, audience, expiry and the RS256 signature with `openid-client`.
The ceremony and final browser handoff are atomically single-use. Cookies are host-only,
`Secure`, `HttpOnly`, `SameSite=Lax`; starting and finishing login require the exact same-origin
`Origin` header. There are no user-selected return URLs. OIDC responses use `Cache-Control:
no-store` and fixed generic error messages; provider response bodies are not logged.

Provider access, refresh and ID tokens are **not retained** and never sent to the browser.
After a one-minute HttpOnly handoff, the browser receives an ordinary revocable Kinwall bearer
session through a same-origin POST, not a URL. Kinwall stores only its hash. The existing
frontend stores that bearer key in browser storage, just like a passkey session: this is not
an HttpOnly-cookie replacement for Kinwall's general API authentication.

Local sessions expire after the configured lifetime. **Settings → This sign-in → Sign out**
revokes the current session on the server before clearing browser credentials and offline
copies. Other tabs reload to sign-in; temporary parent access is cleared too. Server/network
errors are reported and can be retried, rather than silently leaving a live key behind. An
already-expired/revoked session can be cleared. Logout also cancels this browser's pending
OIDC ceremony/handoff and expires its HttpOnly ceremony cookie. It does not sign you out of
Authelia or other applications. A new sign-in may reuse an existing
provider login. Parent devices can view and end OIDC sessions under **Settings → Access →
Parent devices**, or use `GET /api/oidc/sessions` and `DELETE /api/keys/{id}`.

Removing/changing a subject mapping, disabling OIDC, changing the issuer/client, deleting a
member or changing their grown-up status causes old OIDC bearer keys, media tokens and derived
widgets/Watch keys to be refused on subsequent requests. Re-adding an identical mapping can
make an otherwise unexpired session valid again; delete its key to revoke it permanently.
Derived widget/Watch keys also stop working when their source OIDC session expires.
Paired wall keys and unrelated passkeys remain independent.

**Disabling a directory account or logging out at the provider is not immediate Kinwall
revocation.** This implementation does not retain refresh tokens or implement OIDC back-channel
logout/introspection. Its local key lasts until expiry or local revocation. For urgent removal,
remove the mapping/restart Kinwall or revoke its sessions too. As with any parent account,
review keys, devices and other credentials that parent previously authorized: those independent
credentials are not automatically revoked by removing their OIDC identity.

Rotation: update the provider's secret hash and the matching Kinwall runtime secret together,
then restart and test a fresh sign-in. Existing local sessions do not depend on the secret and
remain valid until their usual expiry/revocation. Never rotate the household encryption key as
part of OIDC setup.

## Upgrade and acceptance

Migration `0135_oidc.sql` adds short-lived ceremony tables and three nullable API-key columns.
It follows the fork's existing announcements, medicine Live Activities and event-follow
migrations without renumbering or changing those upstream migrations.
It does not convert or replace existing passkeys, recovery codes, pairings or member IDs.
Take a complete, consistent database/encryption-key backup before upgrading. A binary rollback
is not a database rollback; test recovery on a disposable copy before touching real state.
Build the web client and server from this same source revision. If your deployment overlays a
custom web build, rebase its existing fixes onto this source rather than mounting the old
frontend: the old overlay will hide the OIDC UI.

Before production use:

1. Run `scripts/check.sh`; inspect any pre-existing failures separately.
2. Test with a disposable household and fake provider; never use a production database for tests.
3. In a separate browser, verify the configured provider login, MFA, exact member binding,
   parent/kid permissions, session expiry, local logout and parent-driven revocation.
4. Keep the existing passkey browser open while testing failure and recovery paths.
5. Pair a fresh wall with its six-digit code, approve it from an OIDC parent, confirm it cannot
   open parent settings, and confirm it still works after OIDC is disabled.
6. Verify calendar provider callbacks and native clients still work without a proxy login gate.

## REST endpoints

All routes also declare schemas in `/openapi.json` and `/docs`.

| Route | Authentication | Result |
|---|---|---|
| `GET /api/oidc/config` | Public | Enabled flag and button label only; no identity mappings or secrets. |
| `POST /api/oidc/start` | Same-origin `Origin` | Browser ceremony cookie and provider authorization URL. |
| `GET /api/oidc/callback` | Browser ceremony cookie + provider response | Fixed success/error redirect, no keys in URL. |
| `POST /api/oidc/finish` | Same-origin `Origin` + one-time handoff cookie | Bounded local bearer session. |
| `GET /api/oidc/sessions` | Parent bearer key | Session IDs, labels, owners, scope and timestamps; no provider subjects/tokens. |
| `POST /api/sessions/logout` | Current bearer key | Deletes that session, cancels this browser's pending OIDC flow/handoff and expires the ceremony cookie; available to everyday-access sessions. |

Existing anonymous `POST /api/pair` and `POST /api/pair/poll`, and parent-only
`POST /api/pair/approve`, are unchanged.

## Fork-base development validation

The port is based on fork `main` at `db97d96468e36c6271598ad6e7ecd807f4ffb0f3`, on a
separate feature branch. It is not a completed production/Authelia deployment.

- `scripts/check.sh` passes: 1391 server tests, 636 web tests, both typechecks, translation
  checks, web lint, and production and demo builds. The newer base resolves the two test
  failures seen on the original `da3e246` prototype base; no unrelated tests are disabled.
- OIDC, migration, pairing, passkey, media-token and security-event focused tests pass
  (61 tests). Node and Worker migration tests upgrade disposable databases from both the
  original deployed schema (through `0131`) and the newer fork schema (through `0134`).
  Existing wall keys, passkeys, recovery codes and parent sessions are preserved; repeat
  startup is idempotent. No production state is read or migrated during these checks.
- Chromium checks use a disposable in-memory household and a fake RS256-signing provider:
  real HTTPS browser redirects, cookie/Origin handoff, member binding, and wall pairing pass.
  Phone (390×844), tablet (1024×768) and wall (1920×1080) layouts pass in light and dark modes.
- The Workers dry-run bundle passes. It does not upload or deploy the application.
- Both server and web dependency audits report zero vulnerabilities with the fork's newer
  dependency locks. The port preserves those upstream dependency updates.
- The earlier prototype uses migration `0132_oidc.sql`; that prototype is not deployed.
  This branch uses `0135_oidc.sql` to avoid the fork's upstream migration-number collision.
  Use disposable prototype databases only for development, not as production upgrade inputs.
- Real-provider MFA/group enforcement, real-account browser acceptance, native/calendar
  acceptance and production backup/recovery are still pending. Identity-provider, directory
  and running-service configuration are unchanged by the development work.
