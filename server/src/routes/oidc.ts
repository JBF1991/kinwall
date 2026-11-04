// Optional self-hosted household login. openid-client validates the protocol and signature;
// host-controlled (issuer, sub) mappings grant existing Kinwall scopes, never provider names.
import * as oidc from 'openid-client';
import { createRoute, z } from '@hono/zod-openapi';
import { getCookie, setCookie } from 'hono/cookie';
import { createRouter } from '../router.ts';
import { generateApiKey, sha256Hex } from '../auth.ts';
import { mappedIdentity, oidcSettings, type OidcSettings } from '../oidc-policy.ts';
import { ErrorSchema } from '../schemas.ts';
import { checkRate, clientIp } from '../ratelimit.ts';
import { isClaimed } from './setup.ts';
import { securityEventStmts } from './security-events.ts';
import { stored } from '../i18n.ts';

export const oidcRoutes = createRouter();
const COOKIE = '__Host-kinwall-oidc';
const FLOW_MS = 5 * 60_000;
const HANDOFF_MS = 60_000;
const cookieOptions = { httpOnly: true, secure: true, sameSite: 'Lax' as const, path: '/' };
const error = { description: 'Sign-in refused or unavailable', content: { 'application/json': { schema: ErrorSchema } } };
const errors = { 400: error, 401: error, 403: error, 404: error, 429: error, 503: error };
const caches = new WeakMap<object, { fingerprint: string; expires: number; promise: Promise<oidc.Configuration> }>();
async function configuration(db: object, settings: OidcSettings) {
  const fingerprint = await sha256Hex(JSON.stringify([settings.issuer, settings.clientId, settings.secret]));
  let cached = caches.get(db);
  if (!cached || cached.fingerprint !== fingerprint || cached.expires < Date.now()) {
    const promise = oidc.discovery(new URL(settings.issuer), settings.clientId,
      { id_token_signed_response_alg: 'RS256' }, oidc.ClientSecretBasic(settings.secret),
      { timeout: 10, execute: [oidc.enableNonRepudiationChecks] });
    cached = { fingerprint, expires: Date.now() + FLOW_MS, promise };
    caches.set(db, cached);
    promise.catch(() => { if (caches.get(db) === cached) caches.delete(db); });
  }
  return cached.promise;
}
const callbackUrl = (settings: OidcSettings) => `${settings.origin}/api/oidc/callback`;
const flowFingerprint = (s: OidcSettings) => sha256Hex(JSON.stringify([s.issuer, s.clientId, s.secret, s.origin]));

oidcRoutes.use('/api/oidc/*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  if (c.req.method === 'POST') {
    const settings = oidcSettings(c.env);
    // Explicitly same-origin only. No CORS, Origin/Host guessing, or user-supplied return URL.
    if (settings && c.req.header('Origin') !== settings.origin) return c.json({ error: 'Sign in from the Kinwall page.' }, 403);
  }
  return next();
});

oidcRoutes.openapi(createRoute({
  method: 'get', path: '/api/oidc/config', tags: ['OIDC'], summary: 'Whether optional household single sign-on is enabled (no credentials or identity mappings)',
  responses: { 200: { description: 'ok', content: { 'application/json': { schema: z.object({ enabled: z.boolean(), label: z.string().optional() }) } } } },
}), async c => {
  const settings = oidcSettings(c.env);
  const enabled = !!settings && await isClaimed(c.env.DB);
  return c.json(enabled ? { enabled: true, label: settings!.label } : { enabled: false }, 200);
});

oidcRoutes.openapi(createRoute({
  method: 'post', path: '/api/oidc/start', tags: ['OIDC'], summary: 'Begin browser-bound OIDC authorization code login with S256 PKCE and nonce; requires same-origin Origin',
  responses: { 200: { description: 'Navigate to the returned URL; keep the HttpOnly ceremony cookie', content: { 'application/json': { schema: z.object({ url: z.string() }) } } }, ...errors },
}), async c => {
  const settings = oidcSettings(c.env);
  if (!settings) return c.json({ error: 'Single sign-on is not configured.' }, 404);
  if (!(await isClaimed(c.env.DB))) return c.json({ error: 'Finish setting up Kinwall first.' }, 403);
  if (!(await checkRate(c.env.DB, `oidc-start:${clientIp(c) ?? 'unknown'}`, 20, 10 * 60_000))) return c.json({ error: 'Too many sign-in attempts. Try again in a few minutes.' }, 429);
  try {
    const config = await configuration(c.env.DB, settings);
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const verifier = oidc.randomPKCECodeVerifier();
    const browser = oidc.randomState();
    const url = oidc.buildAuthorizationUrl(config, {
      redirect_uri: callbackUrl(settings), response_type: 'code', scope: 'openid profile',
      state, nonce, code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256',
    });
    const now = new Date().toISOString();
    const browserHash = await sha256Hex(browser);
    const previous = getCookie(c, COOKIE);
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM oidc_flows WHERE expires_at < ? OR browser_hash = ?').bind(now, previous ? await sha256Hex(previous) : ''),
      c.env.DB.prepare('DELETE FROM oidc_handoffs WHERE expires_at < ? OR browser_hash = ?').bind(now, previous ? await sha256Hex(previous) : ''),
      c.env.DB.prepare('INSERT INTO oidc_flows (state_hash, browser_hash, data, expires_at) VALUES (?,?,?,?)')
        .bind(await sha256Hex(state), browserHash, JSON.stringify({ nonce, verifier, fingerprint: await flowFingerprint(settings) }), new Date(Date.now() + FLOW_MS).toISOString()),
    ]);
    setCookie(c, COOKIE, browser, { ...cookieOptions, maxAge: FLOW_MS / 1000 });
    return c.json({ url: url.href }, 200);
  } catch {
    // Never log a library error: it can contain a token, code, secret or provider response body.
    return c.json({ error: 'Single sign-on is unavailable. Try again or use a passkey.' }, 503);
  }
});

oidcRoutes.openapi(createRoute({
  method: 'get', path: '/api/oidc/callback', tags: ['OIDC'], summary: 'Provider callback: verifies state, browser cookie, PKCE, nonce, issuer, audience, expiry and RS256 signature',
  responses: { 303: { description: 'Fixed same-origin success/error redirect. No provider tokens or Kinwall keys in the URL.' }, ...errors },
}), async c => {
  const settings = oidcSettings(c.env);
  if (!settings) return c.json({ error: 'Single sign-on is not configured.' }, 404);
  const fail = () => c.redirect(new URL('/?oidc=error', settings.origin).href, 303);
  try {
    const state = c.req.query('state');
    const browser = getCookie(c, COOKIE);
    if (!state || state.length > 256 || !browser || browser.length > 256) return fail();
    const browserHash = await sha256Hex(browser);
    // Atomic consume: replaying or racing the callback cannot exchange the code twice.
    const row = await c.env.DB.prepare('DELETE FROM oidc_flows WHERE state_hash = ? AND browser_hash = ? AND expires_at > ? RETURNING data')
      .bind(await sha256Hex(state), browserHash, new Date().toISOString()).first<{ data: string }>();
    if (!row) return fail();
    const data = JSON.parse(row.data) as { nonce: string; verifier: string; fingerprint: string };
    if (data.fingerprint !== await flowFingerprint(settings) || !(await isClaimed(c.env.DB))) return fail();
    const config = await configuration(c.env.DB, settings);
    // Reconstruct from the pinned PUBLIC_URL, never a client-controlled Host/X-Forwarded-Host.
    const current = new URL(callbackUrl(settings));
    current.search = new URL(c.req.url).search;
    const tokens = await oidc.authorizationCodeGrant(config, current, {
      expectedState: state, expectedNonce: data.nonce, pkceCodeVerifier: data.verifier, idTokenExpected: true,
    });
    const claims = tokens.claims();
    if (!claims || !(await mappedIdentity(c.env, settings, claims.sub))) return fail();
    // Swap the ceremony cookie for a fresh single-use handoff: no key in URLs, HTML or JS.
    const handoff = oidc.randomState();
    await c.env.DB.prepare('INSERT INTO oidc_handoffs (browser_hash, issuer, client_id, subject, expires_at) VALUES (?,?,?,?,?)')
      .bind(await sha256Hex(handoff), settings.issuer, settings.clientId, claims.sub, new Date(Date.now() + HANDOFF_MS).toISOString()).run();
    setCookie(c, COOKIE, handoff, { ...cookieOptions, maxAge: HANDOFF_MS / 1000 });
    return c.redirect(new URL('/?oidc=complete', settings.origin).href, 303);
  } catch {
    return fail();
  }
});

oidcRoutes.openapi(createRoute({
  method: 'post', path: '/api/oidc/finish', tags: ['OIDC'], summary: 'Consume the browser-only one-time handoff; mint a bounded, revocable Kinwall session. Requires same-origin Origin.',
  responses: { 200: { description: 'Kinwall bearer key (provider tokens are never returned)', content: { 'application/json': { schema: z.object({ key: z.string(), expiresAt: z.string() }) } } }, ...errors },
}), async c => {
  const settings = oidcSettings(c.env);
  if (!settings) return c.json({ error: 'Single sign-on is not configured.' }, 404);
  const browser = getCookie(c, COOKIE);
  setCookie(c, COOKIE, '', { ...cookieOptions, maxAge: 0 });
  if (!browser || browser.length > 256) return c.json({ error: 'That sign-in expired. Please try again.' }, 401);
  const row = await c.env.DB.prepare('DELETE FROM oidc_handoffs WHERE browser_hash = ? AND expires_at > ? RETURNING issuer, client_id, subject')
    .bind(await sha256Hex(browser), new Date().toISOString()).first<{ issuer: string; client_id: string; subject: string }>();
  if (!row || row.issuer !== settings.issuer || row.client_id !== settings.clientId) return c.json({ error: 'That sign-in expired. Please try again.' }, 401);
  const identity = await mappedIdentity(c.env, settings, row.subject);
  if (!identity) return c.json({ error: 'This sign-in does not have access to this family.' }, 403);
  const id = crypto.randomUUID();
  const key = generateApiKey();
  const expiresAt = new Date(Date.now() + settings.sessionSeconds * 1000).toISOString();
  const name = `SSO: ${settings.label}`;
  const db = c.env.DB;
  await db.batch([
    db.prepare("INSERT INTO api_keys (id, name, hash, prefix, scope, created_at, kind, expires_at, owner, device_kind, oidc_issuer, oidc_client_id, oidc_subject) VALUES (?,?,?,?,?,?,'session',?,?,?,?,?,?)")
      .bind(id, name, await sha256Hex(key), key.slice(0, 8), identity.scope, new Date().toISOString(), expiresAt,
        identity.memberId, identity.scope === 'admin' ? 'grownup' : 'kid', settings.issuer, settings.clientId, row.subject),
    ...securityEventStmts(db, { kind: 'signin.oidc', summary: stored('security', 'Signed in with single sign-on'), by: { memberId: identity.memberId, label: null }, device: name }),
  ]);
  return c.json({ key, expiresAt }, 200);
});

oidcRoutes.openapi(createRoute({
  method: 'get', path: '/api/oidc/sessions', tags: ['OIDC'], summary: 'List OIDC browser sessions (parent only); revoke with DELETE /api/keys/{id}', security: [{ Bearer: [] }],
  responses: { 200: { description: 'No subjects or provider tokens', content: { 'application/json': { schema: z.array(z.object({ id: z.string(), name: z.string(), scope: z.string(), owner: z.string().nullable(), expiresAt: z.string(), lastUsedAt: z.string().nullable() })) } } } },
}), async c => {
  const { results } = await c.env.DB.prepare('SELECT id, name, scope, owner, expires_at AS expiresAt, last_used_at AS lastUsedAt FROM api_keys WHERE oidc_issuer IS NOT NULL ORDER BY created_at DESC').all<{ id: string; name: string; scope: string; owner: string | null; expiresAt: string; lastUsedAt: string | null }>();
  return c.json(results, 200);
});
