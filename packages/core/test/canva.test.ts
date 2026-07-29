import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  resolveCanvaDesignId,
  createCanvaPkce,
  buildCanvaAuthUrl,
  formatForSource,
  isCanvaUsable,
  CANVA_SCOPES
} from '../dist/index.js'

test('recognises cloud presentations by URL, not extension', () => {
  // A Google Slides or Canva link has no meaningful extension, so extension
  // matching alone rejected them as "not a presentation".
  assert.equal(
    formatForSource('https://www.canva.com/design/DAFxyz123/edit'),
    'canva'
  )
  assert.equal(formatForSource('https://canva.com/design/DAFxyz123/view'), 'canva')
  assert.equal(
    formatForSource('https://docs.google.com/presentation/d/1AbCdEfGhIjKlMnOpQrStUv/edit'),
    'google-slides'
  )
  // Local paths still resolve by extension.
  assert.equal(formatForSource('/decks/Talk.pptx'), 'pptx')
  assert.equal(formatForSource('/decks/Talk.key'), 'keynote')
  // An unrelated URL is not a presentation.
  assert.equal(formatForSource('https://example.com/notes.txt'), undefined)
})

test('extracts a Canva design id from its URL forms', () => {
  assert.equal(resolveCanvaDesignId('https://www.canva.com/design/DAFxyz123/edit'), 'DAFxyz123')
  assert.equal(
    resolveCanvaDesignId('https://www.canva.com/design/DAF_a-b9/view?utm_source=x'),
    'DAF_a-b9'
  )
  assert.equal(resolveCanvaDesignId('DAFxyz123456'), 'DAFxyz123456')
  assert.throws(() => resolveCanvaDesignId('not a design'), /Could not work out a Canva design id/)
})

test('generates a PKCE pair Canva will accept', () => {
  // Canva mandates S256; a plain challenge is rejected outright.
  const { verifier, challenge } = createCanvaPkce()

  const expected = createHash('sha256')
    .update(verifier)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

  assert.equal(challenge, expected, 'challenge is base64url(sha256(verifier))')
  assert.match(verifier, /^[A-Za-z0-9_-]+$/, 'verifier is base64url with no padding')
  // RFC 7636 requires 43-128 characters.
  assert.ok(verifier.length >= 43 && verifier.length <= 128, `verifier length ${verifier.length}`)

  assert.notEqual(createCanvaPkce().verifier, verifier, 'a fresh verifier each time')
})

test('builds an authorisation URL with the parameters Canva requires', () => {
  const { challenge } = createCanvaPkce()
  const url = new URL(
    buildCanvaAuthUrl({
      clientId: 'OC-AZ-test',
      redirectUri: 'http://127.0.0.1:4747/api/canva/callback',
      state: 'state-value',
      codeChallenge: challenge
    })
  )

  assert.equal(url.origin + url.pathname, 'https://www.canva.com/api/oauth/authorize')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(url.searchParams.get('code_challenge'), challenge)
  assert.equal(url.searchParams.get('response_type'), 'code')
  assert.equal(url.searchParams.get('state'), 'state-value')
  assert.equal(
    url.searchParams.get('redirect_uri'),
    'http://127.0.0.1:4747/api/canva/callback'
  )
  // design:content:read is what the export endpoint requires.
  assert.ok(CANVA_SCOPES.includes('design:content:read'))
  assert.equal(url.searchParams.get('scope'), CANVA_SCOPES.join(' '))
})

test('treats a credential set as usable only when it can mint a token', () => {
  assert.equal(isCanvaUsable({}), false)
  assert.equal(isCanvaUsable({ clientId: 'a', clientSecret: 'b' }), false, 'no refresh token')
  assert.equal(isCanvaUsable({ clientId: 'a', refreshToken: 'c' }), false, 'no secret')
  assert.equal(isCanvaUsable({ clientId: 'a', clientSecret: 'b', refreshToken: 'c' }), true)
})
