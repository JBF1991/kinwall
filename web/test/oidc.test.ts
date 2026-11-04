import { test } from 'node:test'
import assert from 'node:assert/strict'
import { takeOidcReturn } from '../src/oidcReturn.ts'

test('OIDC return only recognizes a fixed marker, strips it, and keeps normal routing', () => {
  assert.equal(takeOidcReturn('https://family.example.test/?start=pair#/board'), null)
  assert.deepEqual(takeOidcReturn('https://family.example.test/?start=pair&oidc=complete#/board'), {
    status: 'complete', url: 'https://family.example.test/?start=pair#/board',
  })
  assert.equal(takeOidcReturn('https://family.example.test/?oidc=error')?.status, 'error')
  assert.equal(takeOidcReturn('https://family.example.test/?oidc=https://attacker.example'), null)
})
