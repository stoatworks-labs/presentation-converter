import { randomUUID } from 'node:crypto'
import type { Express, Request, Response } from 'express'
import {
  settingsStore,
  redactedSettings,
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  fetchGoogleAccount,
  verifyGoogleCredentials,
  resolveGoogleCredentials,
  resetGoogleTokenCache,
  resetEngineProbes
} from '@presentation-converter/core'

/**
 * Pending OAuth attempts, keyed by the `state` value sent to Google.
 *
 * Held in memory and single-use: `state` is what proves the browser hitting the
 * callback is the one that started the flow, so a replayed or forged callback
 * finds nothing and is rejected.
 */
interface PendingAuth {
  provider: 'google'
  redirectUri: string
  createdAt: number
}
const pending = new Map<string, PendingAuth>()

/** OAuth consent rarely takes more than a couple of minutes. */
const AUTH_TTL_MS = 10 * 60 * 1000

function prunePending(): void {
  const cutoff = Date.now() - AUTH_TTL_MS
  for (const [state, entry] of pending) {
    if (entry.createdAt < cutoff) pending.delete(state)
  }
}

/** A minimal page for the browser tab Google redirects back into. */
function resultPage(title: string, detail: string, ok: boolean): string {
  const colour = ok ? '#1a7f45' : '#c0392b'
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<meta name="color-scheme" content="light dark">
<style>
  body { font: 15px/1.6 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
         display: grid; place-items: center; min-height: 100vh; margin: 0; }
  .card { max-width: 26rem; padding: 2rem; text-align: center; }
  h1 { font-size: 1.15rem; color: ${colour}; margin: 0 0 .5rem; }
  p { color: #667; margin: 0; }
</style></head>
<body><div class="card"><h1>${title}</h1><p>${detail}</p>
<p style="margin-top:1rem">You can close this tab and return to Presentation Converter.</p>
</div></body></html>`
}

/**
 * Settings and OAuth endpoints.
 *
 * `publicPaths` lists routes the bearer-token middleware must skip: Google
 * redirects a browser to the callback, and that browser cannot attach an
 * Authorization header. The callback is protected by the single-use `state`
 * instead.
 */
export const PUBLIC_SETTINGS_PATHS = ['/api/google/callback']

export function registerSettingsRoutes(app: Express): void {
  // ---- read -------------------------------------------------------------
  app.get('/api/settings', async (_req, res) => {
    res.json(await redactedSettings())
  })

  // ---- Google client credentials ---------------------------------------
  app.put('/api/settings/google', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const patch: Record<string, string> = {}

    if (typeof body.clientId === 'string') patch.clientId = body.clientId.trim()
    if (typeof body.clientSecret === 'string' && body.clientSecret.trim()) {
      // A blank secret means "leave it alone" — the GUI never echoes it back,
      // so an empty field must not wipe a working credential.
      patch.clientSecret = body.clientSecret.trim()
    }

    if (typeof body.serviceAccountJson === 'string') {
      const raw = body.serviceAccountJson.trim()
      if (raw) {
        let parsed: { client_email?: string; private_key?: string }
        try {
          parsed = JSON.parse(raw) as typeof parsed
        } catch {
          res.status(400).json({ error: 'That does not look like valid JSON.' })
          return
        }
        if (!parsed.client_email || !parsed.private_key) {
          res.status(400).json({
            error: 'That JSON is missing client_email or private_key — is it a service-account key?'
          })
          return
        }
        patch.serviceAccountJson = raw
      }
    }

    await settingsStore.update('google', patch)
    resetGoogleTokenCache()
    resetEngineProbes()
    res.json(await redactedSettings())
  })

  // ---- start the OAuth flow --------------------------------------------
  app.post('/api/google/connect', async (req, res) => {
    const settings = (await settingsStore.read()).google ?? {}
    if (!settings.clientId || !settings.clientSecret) {
      res.status(400).json({
        error: 'Save a Google OAuth client id and secret first.'
      })
      return
    }

    prunePending()
    const state = randomUUID()

    // The redirect must match a URI registered on the OAuth client exactly.
    // It is derived from the request so it is right whichever port the server
    // was started on.
    const origin =
      typeof req.body?.origin === 'string' && req.body.origin
        ? String(req.body.origin).replace(/\/$/, '')
        : `${req.protocol}://${req.get('host')}`
    const redirectUri = `${origin}/api/google/callback`

    pending.set(state, { provider: 'google', redirectUri, createdAt: Date.now() })

    res.json({
      url: buildGoogleAuthUrl({ clientId: settings.clientId, redirectUri, state }),
      redirectUri
    })
  })

  // ---- OAuth callback (browser redirect; no bearer token) ---------------
  app.get('/api/google/callback', async (req: Request, res: Response) => {
    const state = typeof req.query.state === 'string' ? req.query.state : ''
    const code = typeof req.query.code === 'string' ? req.query.code : ''
    const error = typeof req.query.error === 'string' ? req.query.error : ''

    const entry = state ? pending.get(state) : undefined
    // Single-use: consume it whatever the outcome.
    if (state) pending.delete(state)

    if (error) {
      res.status(400).type('html').send(resultPage('Not connected', `Google reported: ${error}`, false))
      return
    }
    if (!entry) {
      res
        .status(400)
        .type('html')
        .send(
          resultPage(
            'Not connected',
            'This sign-in link has expired or was not started here. Try connecting again.',
            false
          )
        )
      return
    }
    if (!code) {
      res.status(400).type('html').send(resultPage('Not connected', 'Google returned no authorisation code.', false))
      return
    }

    try {
      const settings = (await settingsStore.read()).google ?? {}
      if (!settings.clientId || !settings.clientSecret) {
        throw new Error('The OAuth client id and secret are no longer configured.')
      }

      const tokens = await exchangeGoogleCode({
        clientId: settings.clientId,
        clientSecret: settings.clientSecret,
        code,
        redirectUri: entry.redirectUri
      })

      if (!tokens.refreshToken) {
        throw new Error(
          'Google did not return a refresh token. Revoke this app under your Google account permissions and connect again.'
        )
      }

      const account = await fetchGoogleAccount(tokens.accessToken)
      await settingsStore.update('google', {
        refreshToken: tokens.refreshToken,
        ...(account ? { account } : {})
      })
      resetGoogleTokenCache()
      resetEngineProbes()

      res
        .type('html')
        .send(resultPage('Connected', account ? `Signed in as ${account}.` : 'Google account connected.', true))
    } catch (err) {
      res
        .status(400)
        .type('html')
        .send(resultPage('Not connected', err instanceof Error ? err.message : String(err), false))
    }
  })

  // ---- verify / disconnect ---------------------------------------------
  app.post('/api/google/test', async (_req, res) => {
    const result = await verifyGoogleCredentials(await resolveGoogleCredentials())
    // Record the account name when a test reveals it, so the page can show it
    // even for credentials supplied by environment variables.
    if (result.ok && result.account) {
      await settingsStore.update('google', { account: result.account })
    }
    res.json(result)
  })

  app.post('/api/google/disconnect', async (_req, res) => {
    await settingsStore.clear('google')
    resetGoogleTokenCache()
    resetEngineProbes()
    res.json(await redactedSettings())
  })
}
