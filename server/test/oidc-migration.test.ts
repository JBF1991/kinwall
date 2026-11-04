import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb, applyMigrations } from '../src/d1-sqlite.ts';
import { runMigrations } from '../src/migrate.ts';
import { createApiKey, sha256Hex } from '../src/auth.ts';
import { createApp } from '../src/app.ts';

const dir = fileURLToPath(new URL('../migrations/', import.meta.url));
const migrations = readdirSync(dir).filter(name => name.endsWith('.sql')).sort()
  .map(name => ({ name, sql: readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8') }));

for (const cutoff of ['0131', '0134']) for (const runtime of ['node', 'worker']) {
  test(`OIDC upgrade from migration ${cutoff} on ${runtime} preserves paired walls, passkeys and recovery codes`, async () => {
    const db = openDb(':memory:');
    await runMigrations(db, migrations.filter(m => m.name.slice(0, 4) <= cutoff));
    db.prepare("INSERT INTO members (id, name, color, created_at, grown_up) VALUES ('alex', 'Alex', '#123456', '2026-01-01', 1)").run();
    db.prepare("INSERT INTO passkeys (id, credential_id, public_key, name, created_at, owner) VALUES ('passkey-alex', 'fake-credential', 'fake-public-key', 'Alex phone', '2026-01-01', 'alex')").run();
    db.prepare('INSERT INTO recovery_codes (hash, created_at) VALUES (?, ?)').bind(await sha256Hex('FAKE-CODE-ONLY'), '2026-01-01').run();
    const wall = await createApiKey(db, 'Kitchen wall', 'display', { owner: 'shared', deviceKind: 'wall' });
    const parent = await createApiKey(db, 'Passkey: Alex phone', 'admin', { kind: 'session', passkeyId: 'passkey-alex', owner: 'alex', expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    const savedPasskey = db.prepare('SELECT * FROM passkeys').all().results;
    const savedRecovery = db.prepare('SELECT * FROM recovery_codes').all().results;
    const savedKeys = db.prepare('SELECT id, hash, scope, owner, device_kind, passkey_id FROM api_keys ORDER BY id').all().results;
    const upgrade = () => runtime === 'node' ? applyMigrations(db, dir) : runMigrations(db, migrations);
    await upgrade();
    await upgrade(); // Repeat startup must not reapply ALTER TABLE or rotate any credential.
    assert.deepEqual(db.prepare('SELECT * FROM passkeys').all().results, savedPasskey);
    assert.deepEqual(db.prepare('SELECT * FROM recovery_codes').all().results, savedRecovery);
    assert.deepEqual(db.prepare('SELECT id, hash, scope, owner, device_kind, passkey_id FROM api_keys ORDER BY id').all().results, savedKeys);
    const applied = db.prepare("SELECT name FROM _migrations WHERE name LIKE '013%' ORDER BY name").all<{ name: string }>().results.map(m => m.name);
    assert.ok(applied.includes('0132_announcements.sql'));
    assert.ok(applied.includes('0133_medicine_live_activities.sql'));
    assert.ok(applied.includes('0134_event_follows.sql'));
    assert.ok(applied.includes('0135_oidc.sql'));
    assert.ok(!applied.includes('0132_oidc.sql'));
    const app = createApp();
    const env = { DB: db, PUBLIC_URL: 'https://family.example.test' };
    const me = async (key: string) => {
      const res = await app.request('/api/me', { headers: { Authorization: `Bearer ${key}` } }, env);
      assert.equal(res.status, 200);
      return await res.json() as { scope: string; owner: string; deviceKind: string };
    };
    const wallMe = await me(wall.key);
    assert.equal(wallMe.scope, 'display'); assert.equal(wallMe.owner, 'shared'); assert.equal(wallMe.deviceKind, 'wall');
    const parentMe = await me(parent.key);
    assert.equal(parentMe.scope, 'admin'); assert.equal(parentMe.owner, 'alex');
    assert.deepEqual(await (await app.request('/api/oidc/config', {}, env)).json(), { enabled: false });
  });
}
