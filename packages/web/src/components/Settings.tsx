import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type RedactedSettings } from '../api'
import type { JSX } from 'react'

type Mode = 'oauth' | 'service-account'

/**
 * Canva account setup.
 *
 * OAuth only — Canva has no service-account equivalent, so unattended use means
 * a stored user refresh token and nothing else.
 */
function CanvaPanel({
  settings,
  onChanged
}: {
  settings: RedactedSettings | null
  onChanged: (settings: RedactedSettings) => void
}): JSX.Element {
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const pollTimer = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (pollTimer.current !== null) window.clearInterval(pollTimer.current)
    },
    []
  )

  const canva = settings?.canva
  const act = async (run: () => Promise<RedactedSettings | void>, ok?: string): Promise<void> => {
    setBusy(true)
    setMessage(null)
    try {
      const updated = await run()
      if (updated) onChanged(updated)
      if (ok) setMessage({ text: ok, error: false })
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : String(error), error: true })
    } finally {
      setBusy(false)
    }
  }

  const connect = async (): Promise<void> => {
    setBusy(true)
    setMessage(null)
    try {
      const { url } = await api.canvaConnect(window.location.origin)
      window.open(url, '_blank', 'noopener')
      setMessage({
        text: 'Approve access in the tab that just opened, then come back — this page will update on its own.',
        error: false
      })

      if (pollTimer.current !== null) window.clearInterval(pollTimer.current)
      let elapsed = 0
      pollTimer.current = window.setInterval(() => {
        elapsed += 2
        void api
          .settings()
          .then((current) => {
            onChanged(current)
            if (current.canva.connected || elapsed > 300) {
              if (pollTimer.current !== null) window.clearInterval(pollTimer.current)
              pollTimer.current = null
              if (current.canva.connected) setMessage({ text: 'Connected.', error: false })
            }
          })
          .catch(() => undefined)
      }, 2000)
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : String(error), error: true })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="panel">
      <h2>Canva</h2>

      <div className={`conn-status ${canva?.connected ? 'ok' : ''}`}>
        <span className="dot" aria-hidden="true" />
        <div>
          <strong>{canva?.connected ? 'Connected' : 'Not connected'}</strong>
          <div className="reason">
            {canva?.connected
              ? canva.account
                ? `Signed in as ${canva.account}`
                : 'Canva account connected'
              : 'Connect an account to convert straight from a Canva link.'}
          </div>
        </div>
        {canva?.connected && (
          <div className="conn-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => void act(async () => {
                const result = await api.canvaTest()
                setMessage({
                  text: result.ok
                    ? `Working${result.account ? ` — signed in as ${result.account}` : ''}.`
                    : (result.error ?? 'Could not reach Canva.'),
                  error: !result.ok
                })
                return api.settings()
              })}
            >
              Test
            </button>
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => void act(() => api.canvaDisconnect(), 'Disconnected.')}
            >
              Disconnect
            </button>
          </div>
        )}
      </div>

      {message && <div className={message.error ? 'error-banner' : 'ok-banner'}>{message.text}</div>}

      <p className="hint" style={{ margin: '14px 0 12px' }}>
        Optional. <strong>Canva decks already convert without this</strong> — in Canva choose{' '}
        <em>Download → PPTX</em> and convert that file; the speaker notes are inside it. Connecting
        an account only saves you the manual download, letting you convert from a Canva link
        directly.
      </p>
      <p className="hint" style={{ marginBottom: 12 }}>
        Create an integration in the{' '}
        <a href="https://www.canva.com/developers/integrations" target="_blank" rel="noreferrer">
          Canva developer portal
        </a>{' '}
        with the <code>design:content:read</code> and <code>design:meta:read</code> scopes, and add
        this redirect URL to it:
      </p>
      <code className="code-block">{window.location.origin}/api/canva/callback</code>

      <div className="field" style={{ marginTop: 12 }}>
        <label htmlFor="c-client-id">Client ID</label>
        <input
          id="c-client-id"
          type="text"
          value={clientId}
          spellCheck={false}
          placeholder={canva?.clientIdSet ? '(saved — type to replace)' : 'OC-AZ…'}
          onChange={(e) => setClientId(e.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="c-client-secret">Client secret</label>
        <input
          id="c-client-secret"
          type="password"
          value={clientSecret}
          autoComplete="new-password"
          placeholder={canva?.clientSecretSet ? '(saved — leave blank to keep)' : 'cnvca…'}
          onChange={(e) => setClientSecret(e.target.value)}
        />
      </div>

      <div className="actions">
        <button
          type="button"
          disabled={busy || !clientId.trim()}
          onClick={() =>
            void act(async () => {
              const updated = await api.saveCanvaSettings({ clientId, clientSecret })
              setClientSecret('')
              return updated
            }, 'Client credentials saved.')
          }
        >
          Save client
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy || !canva?.clientIdSet || !canva?.clientSecretSet}
          onClick={() => void connect()}
        >
          {canva?.connected ? 'Reconnect' : 'Connect Canva account'}
        </button>
      </div>
      {(!canva?.clientIdSet || !canva?.clientSecretSet) && (
        <p className="hint">Save a client id and secret before connecting.</p>
      )}
    </div>
  )
}

/**
 * Google account setup.
 *
 * Two routes, because they suit different deployments: the OAuth flow signs in
 * as a person and is what a desktop user wants, while a service-account key
 * runs unattended and is what a server needs.
 */
export function Settings(): JSX.Element {
  const [settings, setSettings] = useState<RedactedSettings | null>(null)
  const [mode, setMode] = useState<Mode>('oauth')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [serviceAccount, setServiceAccount] = useState('')
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const pollTimer = useRef<number | null>(null)

  const refresh = useCallback(async () => {
    try {
      const current = await api.settings()
      setSettings(current)
      return current
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : String(error), error: true })
      return null
    }
  }, [])

  useEffect(() => {
    // Fetch-on-mount: every setState in `refresh` runs after an await, so this
    // is not the synchronous cascade the rule is aimed at. Left as-is
    // deliberately — see the lint follow-up issue before rewriting it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
    return () => {
      if (pollTimer.current !== null) window.clearInterval(pollTimer.current)
    }
  }, [refresh])

  const google = settings?.google

  const saveClient = async (): Promise<void> => {
    setBusy(true)
    setMessage(null)
    try {
      const updated = await api.saveGoogleSettings({ clientId, clientSecret })
      setSettings(updated)
      setClientSecret('')
      setMessage({ text: 'Client credentials saved.', error: false })
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : String(error), error: true })
    } finally {
      setBusy(false)
    }
  }

  const connect = async (): Promise<void> => {
    setBusy(true)
    setMessage(null)
    try {
      const { url } = await api.googleConnect(window.location.origin)
      window.open(url, '_blank', 'noopener')
      setMessage({
        text: 'Approve access in the tab that just opened, then come back — this page will update on its own.',
        error: false
      })

      // The callback lands in the other tab, so this one polls until the
      // connection appears rather than waiting for an event it can't receive.
      if (pollTimer.current !== null) window.clearInterval(pollTimer.current)
      let elapsed = 0
      pollTimer.current = window.setInterval(() => {
        elapsed += 2
        void refresh().then((current) => {
          if (current?.google.connected || elapsed > 300) {
            if (pollTimer.current !== null) window.clearInterval(pollTimer.current)
            pollTimer.current = null
            if (current?.google.connected) setMessage({ text: 'Connected.', error: false })
          }
        })
      }, 2000)
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : String(error), error: true })
    } finally {
      setBusy(false)
    }
  }

  const saveServiceAccount = async (): Promise<void> => {
    setBusy(true)
    setMessage(null)
    try {
      const updated = await api.saveGoogleSettings({ serviceAccountJson: serviceAccount })
      setSettings(updated)
      setServiceAccount('')
      setMessage({ text: 'Service-account key saved.', error: false })
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : String(error), error: true })
    } finally {
      setBusy(false)
    }
  }

  const test = async (): Promise<void> => {
    setBusy(true)
    setMessage(null)
    try {
      const result = await api.googleTest()
      setMessage({
        text: result.ok
          ? `Working${result.account ? ` — signed in as ${result.account}` : ''}.`
          : (result.error ?? 'Could not reach Google.'),
        error: !result.ok
      })
      await refresh()
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : String(error), error: true })
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async (): Promise<void> => {
    setBusy(true)
    try {
      setSettings(await api.googleDisconnect())
      setMessage({ text: 'Disconnected.', error: false })
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : String(error), error: true })
    } finally {
      setBusy(false)
    }
  }

  const configured = google?.connected || google?.serviceAccountSet

  return (
    <>
      <div className="panel">
        <h2>Google Slides</h2>

        <div className={`conn-status ${configured ? 'ok' : ''}`}>
          <span className="dot" aria-hidden="true" />
          <div>
            <strong>{configured ? 'Connected' : 'Not connected'}</strong>
            <div className="reason">
              {google?.connected
                ? google.account
                  ? `Signed in as ${google.account}`
                  : 'Signed in with an OAuth account'
                : google?.serviceAccountSet
                  ? 'Using a service-account key'
                  : 'Connect an account to convert Google Slides presentations.'}
            </div>
          </div>
          {configured && (
            <div className="conn-actions">
              <button type="button" onClick={() => void test()} disabled={busy}>
                Test
              </button>
              <button type="button" className="danger" onClick={() => void disconnect()} disabled={busy}>
                Disconnect
              </button>
            </div>
          )}
        </div>

        {message && (
          <div className={message.error ? 'error-banner' : 'ok-banner'}>{message.text}</div>
        )}

        <div className="tabs" role="tablist" style={{ marginTop: 16 }}>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'oauth'}
            onClick={() => setMode('oauth')}
          >
            Sign in with Google
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'service-account'}
            onClick={() => setMode('service-account')}
          >
            Service account
          </button>
        </div>

        {mode === 'oauth' ? (
          <>
            <p className="hint" style={{ marginBottom: 12 }}>
              Create an OAuth client of type <strong>Desktop app</strong> (or Web application) in the{' '}
              <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">
                Google Cloud console
              </a>
              , enable the <em>Google Drive API</em> and <em>Google Slides API</em>, then paste its id
              and secret here. Add this redirect URI to the client:
            </p>
            <code className="code-block">{window.location.origin}/api/google/callback</code>

            <div className="field" style={{ marginTop: 12 }}>
              <label htmlFor="g-client-id">Client ID</label>
              <input
                id="g-client-id"
                type="text"
                value={clientId}
                spellCheck={false}
                placeholder={google?.clientIdSet ? '(saved — type to replace)' : '…apps.googleusercontent.com'}
                onChange={(e) => setClientId(e.target.value)}
              />
            </div>

            <div className="field">
              <label htmlFor="g-client-secret">Client secret</label>
              <input
                id="g-client-secret"
                type="password"
                value={clientSecret}
                autoComplete="new-password"
                placeholder={google?.clientSecretSet ? '(saved — leave blank to keep)' : 'GOCSPX-…'}
                onChange={(e) => setClientSecret(e.target.value)}
              />
            </div>

            <div className="actions">
              <button type="button" onClick={() => void saveClient()} disabled={busy || !clientId.trim()}>
                Save client
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => void connect()}
                disabled={busy || !google?.clientIdSet || !google?.clientSecretSet}
              >
                {google?.connected ? 'Reconnect' : 'Connect Google account'}
              </button>
            </div>
            {(!google?.clientIdSet || !google?.clientSecretSet) && (
              <p className="hint">Save a client id and secret before connecting.</p>
            )}
          </>
        ) : (
          <>
            <p className="hint" style={{ marginBottom: 12 }}>
              Best for servers and unattended conversion. Create a service account, download its JSON
              key, and <strong>share the presentations with the service account&rsquo;s email address</strong> —
              it can only see what has been shared with it.
            </p>

            <div className="field">
              <label htmlFor="g-sa">Service-account key (JSON)</label>
              <textarea
                id="g-sa"
                rows={6}
                spellCheck={false}
                value={serviceAccount}
                placeholder={
                  google?.serviceAccountSet
                    ? '(a key is saved — paste a new one to replace it)'
                    : '{ "type": "service_account", "client_email": "…", "private_key": "…" }'
                }
                onChange={(e) => setServiceAccount(e.target.value)}
              />
            </div>

            <div className="actions">
              <button
                type="button"
                className="primary"
                onClick={() => void saveServiceAccount()}
                disabled={busy || !serviceAccount.trim()}
              >
                Save key
              </button>
            </div>
          </>
        )}
      </div>

      <CanvaPanel settings={settings} onChanged={setSettings} />

      {settings && (
        <div className="panel">
          <h2>Storage</h2>
          <p className="hint">
            Credentials are stored in <code>{settings.configPath}</code>, readable only by you (0600).
            Environment variables, when set, take precedence over anything saved here.
          </p>
        </div>
      )}
    </>
  )
}
