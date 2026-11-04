// Host-controlled, deny-by-default identity mapping. Never link by email or display name.
import { z } from '@hono/zod-openapi';
import type { Env } from './env.ts';
import { msg } from './i18n.ts';

const Identity = z.object({ scope: z.enum(['admin', 'display']), memberId: z.string().min(1).max(200) }).strict();
const Identities = z.record(z.string().min(1).max(255), Identity);
export type OidcIdentity = z.infer<typeof Identity>;
export type OidcSettings = {
  issuer: string; clientId: string; secret: string; origin: string;
  label: string; sessionSeconds: number; identities: Record<string, OidcIdentity>;
};
function httpsUrl(value: string | undefined): URL {
  if (!value) throw new Error('OIDC_CONFIG_MISSING');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('OIDC_CONFIG_URL');
  return url;
}
export function oidcSettings(env: Env): OidcSettings | null {
  try {
    httpsUrl(env.OIDC_ISSUER);
    const publicUrl = httpsUrl(env.PUBLIC_URL);
    if (publicUrl.pathname !== '/' || !env.OIDC_CLIENT_ID?.trim() || !env.OIDC_CLIENT_SECRET?.trim() || !env.OIDC_IDENTITY_MAP) return null;
    const identities = Identities.parse(JSON.parse(env.OIDC_IDENTITY_MAP));
    const sessionSeconds = Number(env.OIDC_SESSION_SECONDS ?? '3600');
    if (!Number.isSafeInteger(sessionSeconds) || sessionSeconds < 60 || sessionSeconds > 86400) return null;
    return {
      issuer: env.OIDC_ISSUER!, clientId: env.OIDC_CLIENT_ID, secret: env.OIDC_CLIENT_SECRET,
      origin: publicUrl.origin, identities, sessionSeconds,
      label: env.OIDC_BUTTON_LABEL?.trim().slice(0, 80) || msg('Single sign-on'),
    };
  } catch {
    return null; // Partial/malformed configuration never grants access.
  }
}
export async function mappedIdentity(env: Env, settings: OidcSettings, subject: string): Promise<OidcIdentity | null> {
  if (!Object.hasOwn(settings.identities, subject)) return null;
  const identity = settings.identities[subject];
  const member = await env.DB.prepare('SELECT grown_up FROM members WHERE id = ?').bind(identity.memberId).first<{ grown_up: number }>();
  if (!member || (identity.scope === 'admin') !== !!member.grown_up) return null;
  return identity;
}
export type OidcKeyFields = {
  oidc_issuer?: string | null; oidc_client_id?: string | null; oidc_subject?: string | null;
  scope: string | null; owner: string | null; expires_at?: string | null;
};
/** Also checked for media tokens, not only bearer keys. Mapping/role changes end old access. */
export async function oidcKeyIsCurrent(env: Env, key: OidcKeyFields): Promise<boolean> {
  if (!key.oidc_issuer) return true;
  if (key.expires_at && key.expires_at <= new Date().toISOString()) return false;
  const settings = oidcSettings(env);
  if (!settings || settings.issuer !== key.oidc_issuer || settings.clientId !== key.oidc_client_id || !key.oidc_subject) return false;
  const identity = await mappedIdentity(env, settings, key.oidc_subject);
  return !!identity && identity.scope === key.scope && identity.memberId === key.owner;
}
