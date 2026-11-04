/** Fixed, non-secret callback marker. Never accept a key or a return URL from OIDC query params. */
export function takeOidcReturn(href: string): { status: 'complete' | 'error'; url: string } | null {
  const url = new URL(href)
  const status = url.searchParams.get('oidc')
  if (status !== 'complete' && status !== 'error') return null
  url.searchParams.delete('oidc')
  return { status, url: url.href }
}
