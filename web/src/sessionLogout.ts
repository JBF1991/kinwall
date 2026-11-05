// Local logout is not provider-wide logout: don't end unrelated applications' SSO sessions.
export const KEY_STORAGE = 'kinwall.apiKey'
export const ADMIN_KEY_STORAGE = 'kinwall.adminKey'
export const MEDIA_STORAGE = 'kinwall.mediaToken'

export function clearSessionCredentials(local: Pick<Storage, 'removeItem'>, session: Pick<Storage, 'removeItem'>) {
  local.removeItem(KEY_STORAGE)
  local.removeItem(MEDIA_STORAGE)
  session.removeItem(ADMIN_KEY_STORAGE)
}

export function sessionKeyChanged(event: Pick<StorageEvent, 'key' | 'oldValue' | 'newValue'>): boolean {
  return event.key === null || (event.key === KEY_STORAGE && event.oldValue !== event.newValue)
}

export async function endBrowserSession(effects: {
  revoke: () => Promise<unknown>
  clear: () => Promise<void>
  navigate: () => void
}): Promise<void> {
  try { await effects.revoke() }
  catch (error) {
    // Expired/revoked keys are already unusable. Network/server errors are not a successful logout.
    if (!error || typeof error !== 'object' || !('status' in error) || error.status !== 401) throw error
  }
  await effects.clear()
  effects.navigate()
}
