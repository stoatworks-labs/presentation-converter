import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type RedactedSettings } from '../api'

type Mode = 'oauth' | 'service-account'

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

      <div className="panel">
        <h2>Canva</h2>
        <p className="hint">
          Not supported yet. Canva&rsquo;s Connect API can export a design to PDF, but it exposes no
          speaker-notes field on designs, pages or exports — so notes would have to be recovered from a
          PPTX export, which is not guaranteed to carry them. See{' '}
          <code>docs/canva.md</code> for the full assessment.
        </p>
      </div>

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
