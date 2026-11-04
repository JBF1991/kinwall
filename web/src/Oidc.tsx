import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api, ApiError, MOCK, setKey } from './api.ts'
import { useApp } from './AppContext.tsx'
import { useDialog } from './dialog.tsx'
import { intlLocale } from './i18n.ts'
import { Brand } from './Brand.tsx'
import { t } from './i18n.ts'
import { inNativeApp } from './native.ts'
import { takeOidcReturn } from './oidcReturn.ts'

/** Additional browser login, never a replacement for wall/kid code pairing or passkeys. */
export function OidcButton() {
  const [label, setLabel] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (MOCK || inNativeApp()) return
    let canceled = false
    api.oidcConfig().then(config => { if (!canceled && config.enabled) setLabel(config.label ?? null) }).catch(() => {})
    return () => { canceled = true }
  }, [])
  if (!label) return null
  const start = async () => {
    setBusy(true); setFailed(false)
    try {
      const { url } = await api.oidcStart()
      location.assign(url)
    } catch {
      setFailed(true); setBusy(false)
    }
  }
  return <div>
    <button className="btn btn-secondary btn-block" onClick={start} disabled={busy}>{busy ? t('Checking…') : t('Sign in with {provider}', { provider: label })}</button>
    {failed && <p role="alert" className="gate-note">{t('Single sign-on is unavailable. Try again or use a passkey.')}</p>}
  </div>
}

/** Parent-only session revocation, separate from paired walls and registered passkeys. */
export function OidcSessions({ onChanged }: { onChanged: () => void }) {
  const { members, toast } = useApp()
  const dialog = useDialog()
  const [sessions, setSessions] = useState<Awaited<ReturnType<typeof api.oidcSessions>>>([])
  const load = () => { if (!MOCK) api.oidcSessions().then(setSessions).catch(() => {}) }
  useEffect(load, [])
  if (!sessions.length) return null
  const revoke = async (id: string) => {
    if (!await dialog.confirm({ title: t('End this single sign-on session?'), body: t('That browser will need to sign in again. Paired wall screens are not affected.'), confirmLabel: t('Sign out'), danger: true })) return
    try { await api.deleteKey(id); load(); onChanged() }
    catch (e) { toast(e instanceof ApiError ? e.message : t('Could not sign out this browser'), true) }
  }
  return <div>
    <h3>{t('Single sign-on sessions')}</h3>
    {sessions.map(session => <div key={session.id} className="key-item">
      <div style={{ flex: 1 }}>
        <div className="settings-row-label">{members.find(m => m.id === session.owner)?.name ?? session.name}</div>
        <div className="settings-row-sub">{t('Expires {date}', { date: new Date(session.expiresAt).toLocaleString(intlLocale()) })}</div>
      </div>
      <button className="link-btn" onClick={() => revoke(session.id)}>{t('Sign out')}</button>
    </div>)}
  </div>
}

const returned = MOCK ? null : takeOidcReturn(location.href)
if (returned) history.replaceState(null, '', returned.url)
// Shared promise survives React StrictMode's effect retry. The server handoff is single-use.
let finishing: Promise<void> | undefined
export function OidcReturnGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<'waiting' | 'error' | 'done'>(returned?.status === 'complete' ? 'waiting' : returned ? 'error' : 'done')
  const started = useRef(false)
  useEffect(() => {
    if (status !== 'waiting' || started.current) return
    started.current = true
    finishing ??= api.oidcFinish().then(session => { setKey(session.key) })
    finishing.then(() => setStatus('done')).catch(() => setStatus('error'))
  }, [status])
  if (status === 'done') return children
  return <div className="gate-screen" role="main"><div className="gate-card">
    <Brand />
    {status === 'waiting' ? <p role="status">{t('Checking…')}</p> : <>
      <h1>{t('Could not sign in')}</h1>
      <p role="alert">{t('Single sign-on was not completed. Try again or use another way to sign in.')}</p>
      <button className="btn btn-primary btn-block" onClick={() => setStatus('done')}>{t('Back to sign in')}</button>
    </>}
  </div></div>
}
