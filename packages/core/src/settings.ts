import { readFile, writeFile, mkdir, chmod, rm } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Persistent settings, chiefly cloud credentials.
 *
 * Kept deliberately separate from conversion: everything here is optional, and
 * a machine that only converts local files never needs any of it. Credentials
 * are stored on disk because the alternative — environment variables only —
 * means no GUI can ever help a user connect an account.
 *
 * The file is written 0600. It holds OAuth refresh tokens and client secrets,
 * which are long-lived bearer credentials for the user's Drive account.
 */

export interface GoogleSettings {
  /** OAuth client id from a Google Cloud "Desktop app" credential. */
  clientId?: string
  clientSecret?: string
  /** Obtained by completing the OAuth flow; long-lived. */
  refreshToken?: string
  /** Email of the connected account, for display only. */
  account?: string
  /** Contents of a service-account key file, for headless use. */
  serviceAccountJson?: string
}

/**
 * Reserved for Canva. Canva's Connect API uses OAuth 2.0 with PKCE and offers
 * no service-account equivalent, so a stored refresh token is the only way to
 * run it unattended.
 */
export interface CanvaSettings {
  clientId?: string
  clientSecret?: string
  refreshToken?: string
  account?: string
}

export interface Settings {
  google?: GoogleSettings
  canva?: CanvaSettings
}

/** Follows each platform's convention for per-user application data. */
export function defaultConfigPath(): string {
  const override = process.env.PRESENTATION_CONVERTER_CONFIG
  if (override) return override

  const home = homedir()
  if (platform() === 'darwin') {
    return join(home, 'Library', 'Application Support', 'presentation-converter', 'config.json')
  }
  if (platform() === 'win32') {
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming')
    return join(appData, 'presentation-converter', 'config.json')
  }
  const configHome = process.env.XDG_CONFIG_HOME ?? join(home, '.config')
  return join(configHome, 'presentation-converter', 'config.json')
}

export class SettingsStore {
  private cache: Settings | undefined

  constructor(readonly path: string = defaultConfigPath()) {}

  async read(): Promise<Settings> {
    if (this.cache) return this.cache
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf-8')) as Settings
      this.cache = parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      // Absent or unreadable config is not an error; it just means nothing is
      // connected yet.
      this.cache = {}
    }
    return this.cache
  }

  async write(settings: Settings): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    await writeFile(this.path, `${JSON.stringify(settings, null, 2)}\n`, {
      encoding: 'utf-8',
      mode: 0o600
    })
    // writeFile's mode only applies when creating the file, so an existing one
    // keeps its old permissions unless tightened explicitly.
    await chmod(this.path, 0o600).catch(() => undefined)
    this.cache = settings
  }

  /** Shallow-merges one provider's settings, leaving the others untouched. */
  async update<K extends keyof Settings>(provider: K, patch: Settings[K]): Promise<Settings> {
    const current = await this.read()
    const next: Settings = {
      ...current,
      [provider]: { ...(current[provider] ?? {}), ...(patch ?? {}) }
    }
    await this.write(next)
    return next
  }

  /** Removes a provider's stored credentials entirely. */
  async clear(provider: keyof Settings): Promise<Settings> {
    const current = await this.read()
    const next = { ...current }
    delete next[provider]
    await this.write(next)
    return next
  }

  async delete(): Promise<void> {
    await rm(this.path, { force: true })
    this.cache = {}
  }

  /** Drops the in-memory copy, so an externally edited file is picked up. */
  invalidate(): void {
    this.cache = undefined
  }
}

/** Shared instance; the CLI, server and engines all read the same file. */
export const settingsStore = new SettingsStore()

/**
 * What a client may see. Secrets are reported as booleans only — the GUI needs
 * to know whether something is configured, never what it is.
 */
export interface RedactedSettings {
  configPath: string
  google: {
    clientIdSet: boolean
    clientSecretSet: boolean
    connected: boolean
    account?: string
    serviceAccountSet: boolean
  }
  canva: {
    clientIdSet: boolean
    clientSecretSet: boolean
    connected: boolean
    account?: string
  }
}

export async function redactedSettings(
  store: SettingsStore = settingsStore
): Promise<RedactedSettings> {
  const settings = await store.read()
  const google = settings.google ?? {}
  const canva = settings.canva ?? {}

  return {
    configPath: store.path,
    google: {
      clientIdSet: Boolean(google.clientId),
      clientSecretSet: Boolean(google.clientSecret),
      connected: Boolean(google.refreshToken),
      ...(google.account ? { account: google.account } : {}),
      serviceAccountSet: Boolean(google.serviceAccountJson)
    },
    canva: {
      clientIdSet: Boolean(canva.clientId),
      clientSecretSet: Boolean(canva.clientSecret),
      connected: Boolean(canva.refreshToken),
      ...(canva.account ? { account: canva.account } : {})
    }
  }
}
