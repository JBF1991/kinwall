import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.ts';
import { openDb, applyMigrations } from '../src/d1-sqlite.ts';
import type { Env } from '../src/env.ts';

const origin = 'https://family.example.test';
const issuer = 'https://auth.example.test';
const callback = `${origin}/api/oidc/callback`;
const admin = 'obvious-fake-admin-key';
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const signing = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...await crypto.subtle.exportKey('jwk', signing.publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' };

function fixture() {
  const DB = openDb(':memory:');
  applyMigrations(DB, fileURLToPath(new URL('../migrations/', import.meta.url)));
  DB.prepare("INSERT INTO members (id, name, color, created_at, grown_up) VALUES ('alex', 'Alex', '#123456', '2026-01-01', 1), ('maya', 'Maya', '#654321', '2026-01-01', 0)").run();
  const env: Env = {
    DB, PUBLIC_URL: origin, ADMIN_API_KEY: admin,
    ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    OIDC_ISSUER: issuer, OIDC_CLIENT_ID: 'kinwall', OIDC_CLIENT_SECRET: 'obvious-fake-client-secret',
    OIDC_IDENTITY_MAP: JSON.stringify({ 'subject-alex': { scope: 'admin', memberId: 'alex' }, 'subject-maya': { scope: 'display', memberId: 'maya' } }),
  };
  const app = createApp();
  const req = (path: string, init: RequestInit = {}) => app.request(`${origin}${path}`, init, env);
  const post = (path: string, cookie?: string, from = origin) => req(path, { method: 'POST', headers: { Origin: from, ...(cookie ? { Cookie: cookie } : {}) } });
  return { env, req, post };
}
type Fixture = ReturnType<typeof fixture>;
function cookieOf(res: Response) {
  return res.headers.getSetCookie().find(c => c.startsWith('__Host-kinwall-oidc='))?.split(';')[0] ?? '';
}
async function begin(f: Fixture) {
  const res = await f.post('/api/oidc/start');
  assert.equal(res.status, 200, await res.clone().text());
  assert.match(res.headers.get('set-cookie') ?? '', /HttpOnly/i);
  assert.match(res.headers.get('set-cookie') ?? '', /Secure/i);
  assert.match(res.headers.get('set-cookie') ?? '', /SameSite=Lax/i);
  const { url } = await res.json() as { url: string };
  const auth = new URL(url);
  assert.equal(auth.searchParams.get('redirect_uri'), callback);
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(auth.searchParams.get('response_type'), 'code');
  assert.ok(auth.searchParams.get('nonce'));
  return { auth, cookie: cookieOf(res), state: auth.searchParams.get('state')! };
}

// A complete fake provider: exercise discovery, PKCE, token claims AND the real signature verifier.
async function provider(t: TestContext, changes: Record<string, unknown> = {}, invalidSignature = false) {
  let nonce = '';
  let challenge = '';
  let exchanges = 0;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.href === `${issuer}/.well-known/openid-configuration`) return Response.json({
      issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
      response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic'], code_challenge_methods_supported: ['S256'],
    });
    if (url.href === `${issuer}/jwks`) return Response.json({ keys: [jwk] });
    if (url.href === `${issuer}/token`) {
      exchanges++;
      const body = new URLSearchParams(init?.body as URLSearchParams);
      assert.equal(body.get('redirect_uri'), callback);
      assert.equal(body.get('grant_type'), 'authorization_code');
      const verifier = body.get('code_verifier');
      assert.ok(verifier);
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
      assert.equal(Buffer.from(digest).toString('base64url'), challenge);
      assert.ok(new Headers(init?.headers).get('authorization')?.startsWith('Basic '));
      const now = Math.floor(Date.now() / 1000);
      const payload = { iss: issuer, sub: 'subject-alex', aud: 'kinwall', iat: now, exp: now + 300, nonce, ...changes };
      const unsigned = `${b64({ alg: 'RS256', kid: 'test-key' })}.${b64(payload)}`;
      const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signing.privateKey, new TextEncoder().encode(unsigned));
      const token = `${unsigned}.${invalidSignature ? Buffer.alloc(256).toString('base64url') : Buffer.from(signature).toString('base64url')}`;
      return Response.json({ access_token: 'fake-provider-token-never-sent-to-browser', token_type: 'Bearer', expires_in: 300, id_token: token });
    }
    throw new Error(`Unexpected test network request to ${url.origin}${url.pathname}`);
  });
  return {
    use(auth: URL) { nonce = auth.searchParams.get('nonce')!; challenge = auth.searchParams.get('code_challenge')!; },
    exchanges: () => exchanges,
  };
}
async function login(f: Fixture, p: Awaited<ReturnType<typeof provider>>) {
  const flow = await begin(f);
  p.use(flow.auth);
  const res = await f.req(`/api/oidc/callback?code=fake-code&state=${flow.state}`, { headers: { Cookie: flow.cookie } });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), `${origin}/?oidc=complete`);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.ok(!(await res.text()).includes('fake-provider-token'));
  const cookie = cookieOf(res);
  assert.ok(cookie);
  const finished = await f.post('/api/oidc/finish', cookie);
  assert.equal(finished.status, 200, await finished.clone().text());
  const session = await finished.json() as { key: string; expiresAt: string };
  assert.match(session.key, /^kw_/);
  assert.ok(new Date(session.expiresAt).getTime() <= Date.now() + 3600_000);
  return { ...session, flow, cookie };
}

test('OIDC disabled by default; ordinary auth and public route allowlist stay intact', async () => {
  const f = fixture();
  delete f.env.OIDC_ISSUER;
  assert.deepEqual(await (await f.req('/api/oidc/config')).json(), { enabled: false });
  assert.equal((await f.post('/api/oidc/start')).status, 404);
  assert.equal((await f.req('/api/members')).status, 401);
  assert.equal((await f.req('/api/oidc/not-a-route')).status, 401);
  assert.equal((await f.req('/api/oidc/start')).status, 401);
});

test('OIDC refuses insecure/malformed config, unclaimed households, and cross-origin starts', async t => {
  await provider(t);
  const f = fixture();
  assert.equal((await f.post('/api/oidc/start', undefined, 'https://attacker.example')).status, 403);
  assert.equal((await f.req('/api/oidc/start', { method: 'POST' })).status, 403);
  f.env.OIDC_ISSUER = 'http://auth.example.test';
  assert.equal((await f.post('/api/oidc/start')).status, 404);
  f.env.OIDC_ISSUER = issuer;
  f.env.OIDC_IDENTITY_MAP = '{bad';
  assert.equal((await f.post('/api/oidc/start')).status, 404);
  f.env.OIDC_IDENTITY_MAP = '{}';
  f.env.DB.prepare('DELETE FROM members').run();
  assert.equal((await f.post('/api/oidc/start')).status, 403);
});

test('OIDC parent login, one-time handoff, member binding, media revocation and local logout', async t => {
  const p = await provider(t);
  const f = fixture();
  const { key, cookie, flow } = await login(f, p);
  const headers = { Authorization: `Bearer ${key}` };
  const me = await (await f.req('/api/me', { headers })).json() as { scope: string; owner: string; kind: string };
  assert.equal(me.scope, 'admin'); assert.equal(me.owner, 'alex'); assert.equal(me.kind, 'session');
  assert.equal((await f.req('/api/settings', { headers })).status, 200);
  assert.equal((await f.req('/api/me/owner', { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ owner: 'shared' }) })).status, 400);
  assert.equal((await f.post('/api/oidc/finish', cookie)).status, 401);
  const replay = await f.req(`/api/oidc/callback?code=fake-code&state=${flow.state}`, { headers: { Cookie: flow.cookie } });
  assert.equal(replay.headers.get('location'), `${origin}/?oidc=error`);
  assert.equal(p.exchanges(), 1);
  const { token } = await (await f.req('/api/media-token', { headers })).json() as { token: string };
  f.env.OIDC_IDENTITY_MAP = '{}';
  assert.equal((await f.req('/api/me', { headers })).status, 401);
  assert.equal((await f.req(`/api/photos/not-real/image?key=${encodeURIComponent(token)}`)).status, 401);
  f.env.OIDC_IDENTITY_MAP = JSON.stringify({ 'subject-alex': { scope: 'admin', memberId: 'alex' } });
  assert.equal((await f.req('/api/sessions/logout', { method: 'POST', headers })).status, 200);
  assert.equal((await f.req('/api/me', { headers })).status, 401);
  const log = await f.env.DB.prepare("SELECT kind, summary FROM security_events WHERE kind = 'signin.oidc'").first<{ kind: string; summary: string }>();
  assert.equal(log?.kind, 'signin.oidc');
  assert.ok(!log?.summary.includes('subject-alex'));
});

for (const stage of ['flow', 'handoff'] as const) {
  test(`logout revokes only this session and cancels its pending OIDC ${stage}`, async t => {
    const p = await provider(t);
    const f = fixture();
    const first = await login(f, p);
    const other = await login(f, p);
    const headers = { Authorization: `Bearer ${first.key}` };
    const { token } = await (await f.req('/api/media-token', { headers })).json() as { token: string };
    const pending = await begin(f); p.use(pending.auth);
    let cookie = pending.cookie;
    if (stage === 'handoff') {
      const response = await f.req(`/api/oidc/callback?code=fake-code&state=${pending.state}`, { headers: { Cookie: cookie } });
      assert.equal(response.headers.get('location'), `${origin}/?oidc=complete`);
      cookie = cookieOf(response);
    }
    const response = await f.req('/api/sessions/logout', { method: 'POST', headers: { ...headers, Cookie: cookie } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('set-cookie') ?? '', /__Host-kinwall-oidc=;/);
    assert.equal((await f.req('/api/me', { headers })).status, 401);
    assert.equal((await f.req(`/api/photos/not-real/image?key=${encodeURIComponent(token)}`)).status, 401);
    assert.equal((await f.req('/api/me', { headers: { Authorization: `Bearer ${other.key}` } })).status, 200);
    assert.equal((await f.req('/api/sessions/logout', { method: 'POST' })).status, 401);
    if (stage === 'flow') {
      const callbackResponse = await f.req(`/api/oidc/callback?code=fake-code&state=${pending.state}`, { headers: { Cookie: cookie } });
      assert.equal(callbackResponse.headers.get('location'), `${origin}/?oidc=error`);
    }
    assert.equal((await f.post('/api/oidc/finish', cookie)).status, 401);
  });
}

test('OIDC everyday access is pinned to a kid, never gets parent permissions', async t => {
  const p = await provider(t, { sub: 'subject-maya' });
  const f = fixture();
  const { key } = await login(f, p);
  const headers = { Authorization: `Bearer ${key}` };
  const me = await (await f.req('/api/me', { headers })).json() as { scope: string; owner: string; locked: boolean };
  assert.equal(me.scope, 'display'); assert.equal(me.owner, 'maya'); assert.equal(me.locked, true);
  assert.equal((await f.req('/api/keys', { headers })).status, 403);
  assert.equal((await f.req('/api/sessions/logout', { method: 'POST', headers })).status, 200);
  assert.equal((await f.req('/api/me', { headers })).status, 401);
});

for (const [label, changes, badSig] of [
  ['unknown subject', { sub: 'not-allowed', email: 'alex@example.test', preferred_username: 'Alex' }, false],
  ['wrong issuer', { iss: 'https://attacker.example' }, false],
  ['wrong audience', { aud: 'another-client' }, false],
  ['wrong nonce', { nonce: 'attacker-nonce' }, false],
  ['expired token', { exp: 1 }, false],
  ['invalid signature', {}, true],
] as const) {
  test(`OIDC rejects ${label} without issuing a key`, async t => {
    const p = await provider(t, changes, badSig);
    const f = fixture();
    const flow = await begin(f); p.use(flow.auth);
    const res = await f.req(`/api/oidc/callback?code=fake-code&state=${flow.state}`, { headers: { Cookie: flow.cookie } });
    assert.equal(res.headers.get('location'), `${origin}/?oidc=error`);
    assert.equal((await f.post('/api/oidc/finish', cookieOf(res))).status, 401);
    assert.equal((await f.env.DB.prepare('SELECT count(*) AS n FROM api_keys').first<{ n: number }>())?.n, 0);
  });
}

test('OIDC browser binding, callback errors, expiry and concurrent replay fail closed', async t => {
  const p = await provider(t);
  const f = fixture();
  const flow = await begin(f); p.use(flow.auth);
  for (const cookie of ['', '__Host-kinwall-oidc=attacker']) {
    const res = await f.req(`/api/oidc/callback?code=fake&state=${flow.state}`, { headers: { Cookie: cookie } });
    assert.equal(res.headers.get('location'), `${origin}/?oidc=error`);
  }
  assert.equal(p.exchanges(), 0);
  const responses = await Promise.all([1, 2].map(() => f.req(`/api/oidc/callback?code=fake&state=${flow.state}`, { headers: { Cookie: flow.cookie } })));
  assert.equal(responses.filter(r => r.headers.get('location') === `${origin}/?oidc=complete`).length, 1);
  assert.equal(p.exchanges(), 1);
  const next = await begin(f); p.use(next.auth);
  f.env.DB.prepare("UPDATE oidc_flows SET expires_at = '2000-01-01T00:00:00Z'").run();
  assert.equal((await f.req(`/api/oidc/callback?code=fake&state=${next.state}`, { headers: { Cookie: next.cookie } })).headers.get('location'), `${origin}/?oidc=error`);
  const denied = await begin(f);
  assert.equal((await f.req(`/api/oidc/callback?error=access_denied&state=${denied.state}`, { headers: { Cookie: denied.cookie } })).headers.get('location'), `${origin}/?oidc=error`);
});

test('OIDC configuration and member role changes invalidate existing sessions', async t => {
  const p = await provider(t);
  const f = fixture();
  const { key, cookie } = await login(f, p);
  const headers = { Authorization: `Bearer ${key}` };
  assert.equal((await f.post('/api/oidc/finish', cookie, 'https://attacker.example')).status, 403);
  f.env.DB.prepare("UPDATE members SET grown_up = 0 WHERE id = 'alex'").run();
  assert.equal((await f.req('/api/me', { headers })).status, 401);
  f.env.DB.prepare("UPDATE members SET grown_up = 1 WHERE id = 'alex'").run();
  f.env.OIDC_ISSUER = 'https://different.example';
  assert.equal((await f.req('/api/me', { headers })).status, 401);
});

test('wall devices still pair by code without Authelia; an OIDC parent can approve them', async t => {
  const p = await provider(t);
  const f = fixture();
  const { key } = await login(f, p);
  const startRes = await f.req('/api/pair', { method: 'POST' }); // no bearer or OIDC cookie
  assert.equal(startRes.status, 201);
  const start = await startRes.json() as { code: string; pairingId: string; pollToken: string };
  assert.match(start.code, /^\d{6}$/);
  const poll = () => f.req('/api/pair/poll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pairingId: start.pairingId, pollToken: start.pollToken }) });
  assert.equal((await (await poll()).json() as { status: string }).status, 'pending');
  const approve = await f.req('/api/pair/approve', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: start.code, name: 'Kitchen wall', kind: 'wall', owner: 'shared' }),
  });
  assert.equal(approve.status, 200);
  const paired = await (await poll()).json() as { key: string; status: string };
  assert.equal(paired.status, 'approved');
  const headers = { Authorization: `Bearer ${paired.key}` };
  const me = await (await f.req('/api/me', { headers })).json() as { scope: string; owner: string; deviceKind: string };
  assert.equal(me.scope, 'display'); assert.equal(me.owner, 'shared'); assert.equal(me.deviceKind, 'wall');
  assert.equal((await f.req('/api/keys', { headers })).status, 403);
  // Disabling SSO must NOT strand the independently paired wall.
  delete f.env.OIDC_ISSUER;
  assert.equal((await f.req('/api/me', { headers })).status, 200);
  assert.equal((await f.req('/api/me', { headers: { Authorization: `Bearer ${key}` } })).status, 401);
  assert.equal((await poll()).status, 404);
});

test('OIDC session and shared widget revocation works without revoking independent wall keys', async t => {
  const p = await provider(t);
  const f = fixture();
  const { key } = await login(f, p);
  const headers = { Authorization: `Bearer ${key}` };
  const widget = await (await f.req('/api/device-keys', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Widgets' }) })).json() as { key: string };
  const widgetHeaders = { Authorization: `Bearer ${widget.key}` };
  assert.equal((await f.req('/api/me', { headers: widgetHeaders })).status, 200);
  f.env.DB.prepare("UPDATE api_keys SET expires_at = '2000-01-01' WHERE oidc_issuer IS NOT NULL").run();
  assert.equal((await f.req('/api/me', { headers: widgetHeaders })).status, 401, 'a widget cannot outlive its OIDC source session');
  f.env.DB.prepare("UPDATE api_keys SET expires_at = '2099-01-01' WHERE oidc_issuer IS NOT NULL").run();
  assert.equal((await f.req('/api/me', { headers: widgetHeaders })).status, 200);
  f.env.OIDC_IDENTITY_MAP = '{}';
  assert.equal((await f.req('/api/me', { headers: widgetHeaders })).status, 401);
  const sessions = await (await f.req('/api/oidc/sessions', { headers: { Authorization: `Bearer ${admin}` } })).json() as { id: string }[];
  assert.equal(sessions.length, 1);
  assert.ok(!JSON.stringify(sessions).includes('subject-alex'));
  assert.equal((await f.req(`/api/keys/${sessions[0].id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${admin}` } })).status, 200);
  assert.equal((await f.req('/api/me', { headers })).status, 401);
});

test('OIDC expired handoffs cannot mint sessions, and handoff consumption is atomic', async t => {
  const p = await provider(t);
  const f = fixture();
  const first = await begin(f); p.use(first.auth);
  const res = await f.req(`/api/oidc/callback?code=fake&state=${first.state}`, { headers: { Cookie: first.cookie } });
  const cookie = cookieOf(res);
  f.env.DB.prepare("UPDATE oidc_handoffs SET expires_at = '2000-01-01'").run();
  assert.equal((await f.post('/api/oidc/finish', cookie)).status, 401);
  const next = await begin(f); p.use(next.auth);
  const ok = await f.req(`/api/oidc/callback?code=fake&state=${next.state}`, { headers: { Cookie: next.cookie } });
  const finished = await Promise.all([f.post('/api/oidc/finish', cookieOf(ok)), f.post('/api/oidc/finish', cookieOf(ok))]);
  assert.deepEqual(finished.map(r => r.status).sort(), [200, 401]);
});

test('OIDC start rate limits work independently of wall pairing', async t => {
  await provider(t);
  const f = fixture();
  for (let i = 0; i < 20; i++) assert.equal((await f.post('/api/oidc/start')).status, 200);
  assert.equal((await f.post('/api/oidc/start')).status, 429);
  assert.equal((await f.req('/api/pair', { method: 'POST' })).status, 201);
});
