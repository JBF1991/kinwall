import { test } from 'node:test'
import assert from 'node:assert/strict'
import { endBrowserSession, clearSessionCredentials, sessionKeyChanged } from '../src/sessionLogout.ts'

test('logout revokes on the server before clearing this browser and navigating', async () => {
  const calls: string[] = []
  await endBrowserSession({
    revoke: async () => { calls.push('revoke') },
    clear: async () => { calls.push('clear') },
    navigate: () => { calls.push('navigate') },
  })
  assert.deepEqual(calls, ['revoke', 'clear', 'navigate'])
})

for (const status of [0, 403, 500]) {
  test(`logout does not claim success when revocation fails (${status})`, async () => {
    const calls: string[] = []
    await assert.rejects(endBrowserSession({
      revoke: async () => { throw Object.assign(new Error('revocation failed'), { status }) },
      clear: async () => { calls.push('clear') },
      navigate: () => { calls.push('navigate') },
    }), /revocation failed/)
    assert.deepEqual(calls, [])
  })
}

test('an already expired or revoked session can still be cleared', async () => {
  const calls: string[] = []
  await endBrowserSession({
    revoke: async () => { throw Object.assign(new Error('expired'), { status: 401 }) },
    clear: async () => { calls.push('clear') },
    navigate: () => { calls.push('navigate') },
  })
  assert.deepEqual(calls, ['clear', 'navigate'])
})

test('logout clears ordinary, media, and temporary parent credentials, not preferences', () => {
  const local = new Map([['kinwall.apiKey', 'fake-session'], ['kinwall.mediaToken', 'fake-media'], ['preference', 'keep']])
  const session = new Map([['kinwall.adminKey', 'fake-parent'], ['preference', 'keep']])
  clearSessionCredentials({ removeItem: key => { local.delete(key) } }, { removeItem: key => { session.delete(key) } })
  assert.deepEqual([...local], [['preference', 'keep']])
  assert.deepEqual([...session], [['preference', 'keep']])
})

test('only a changed sign-in credential or storage clear reloads another tab', () => {
  assert.equal(sessionKeyChanged({ key: 'kinwall.apiKey', oldValue: 'fake-session', newValue: null }), true)
  assert.equal(sessionKeyChanged({ key: 'kinwall.apiKey', oldValue: 'fake-old', newValue: 'fake-new' }), true)
  assert.equal(sessionKeyChanged({ key: null, oldValue: null, newValue: null }), true)
  assert.equal(sessionKeyChanged({ key: 'kinwall.apiKey', oldValue: 'same', newValue: 'same' }), false)
  assert.equal(sessionKeyChanged({ key: 'preference', oldValue: 'a', newValue: 'b' }), false)
})
