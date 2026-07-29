import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, stat, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsStore, redactedSettings } from '../dist/index.js'

async function tempStore(): Promise<SettingsStore> {
  const dir = await mkdtemp(join(tmpdir(), 'presentation-converter-settings-'))
  return new SettingsStore(join(dir, 'config.json'))
}

test('reads an absent config as empty rather than failing', async () => {
  const store = await tempStore()
  assert.deepEqual(await store.read(), {})
})

test('writes the config readable only by its owner', async () => {
  // The file holds OAuth refresh tokens and client secrets — long-lived bearer
  // credentials for the user's Drive account.
  const store = await tempStore()
  await store.update('google', { clientId: 'abc', clientSecret: 'shhh' })

  const info = await stat(store.path)
  assert.equal(info.mode & 0o777, 0o600)
})

test('merges one provider without disturbing the others', async () => {
  const store = await tempStore()
  await store.update('google', { clientId: 'abc', clientSecret: 'shhh' })
  await store.update('canva', { clientId: 'canva-id' })
  await store.update('google', { refreshToken: 'refresh-me' })

  const settings = await store.read()
  assert.equal(settings.google?.clientId, 'abc', 'earlier google field survives')
  assert.equal(settings.google?.clientSecret, 'shhh')
  assert.equal(settings.google?.refreshToken, 'refresh-me')
  assert.equal(settings.canva?.clientId, 'canva-id', 'other provider untouched')
})

test('clearing one provider leaves the others intact', async () => {
  const store = await tempStore()
  await store.update('google', { refreshToken: 'refresh-me' })
  await store.update('canva', { clientId: 'canva-id' })

  await store.clear('google')

  const settings = await store.read()
  assert.equal(settings.google, undefined)
  assert.equal(settings.canva?.clientId, 'canva-id')
})

test('redaction reports what is set without revealing any of it', async () => {
  const store = await tempStore()
  await store.update('google', {
    clientId: 'abc.apps.googleusercontent.com',
    clientSecret: 'GOCSPX-secret',
    refreshToken: 'refresh-token-value',
    account: 'someone@example.com'
  })

  const redacted = await redactedSettings(store)
  const serialised = JSON.stringify(redacted)

  assert.equal(redacted.google.clientIdSet, true)
  assert.equal(redacted.google.clientSecretSet, true)
  assert.equal(redacted.google.connected, true)
  assert.equal(redacted.google.account, 'someone@example.com')

  // The account email is deliberately shown; the credentials never are.
  assert.equal(serialised.includes('GOCSPX-secret'), false, 'client secret must not leak')
  assert.equal(serialised.includes('refresh-token-value'), false, 'refresh token must not leak')
  assert.equal(
    serialised.includes('abc.apps.googleusercontent.com'),
    false,
    'client id must not leak'
  )
})

test('survives a corrupt config file instead of throwing', async () => {
  const store = await tempStore()
  await store.update('google', { clientId: 'abc' })
  const { writeFile } = await import('node:fs/promises')
  await writeFile(store.path, '{ this is not json', 'utf-8')
  store.invalidate()

  assert.deepEqual(await store.read(), {}, 'unreadable config reads as "nothing connected"')
})

test('stores the service-account key verbatim', async () => {
  const store = await tempStore()
  const key = JSON.stringify({ type: 'service_account', client_email: 'a@b.iam', private_key: 'PEM' })
  await store.update('google', { serviceAccountJson: key })

  const onDisk = JSON.parse(await readFile(store.path, 'utf-8')) as {
    google: { serviceAccountJson: string }
  }
  assert.equal(onDisk.google.serviceAccountJson, key)

  const redacted = await redactedSettings(store)
  assert.equal(redacted.google.serviceAccountSet, true)
  assert.equal(JSON.stringify(redacted).includes('PEM'), false)
})
