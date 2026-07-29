import { writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { settingsStore, type SettingsStore } from '../settings.js'
import { extractPptxNotes } from '../notes/ooxml.js'
import type {
  EngineAvailability,
  ExtractedNotes,
  NotesEngine,
  PdfEngine,
  PdfRenderResult,
  RenderOptions
} from '../types.js'

const AUTH_URL = 'https://www.canva.com/api/oauth/authorize'
const TOKEN_URL = 'https://api.canva.com/rest/v1/oauth/token'
const API_BASE = 'https://api.canva.com/rest/v1'

/**
 * Scopes requested.
 *
 * `design:content:read` is what the export endpoint requires; `design:meta:read`
 * is for titles. `profile:read` only backs the "signed in as…" line on the
 * settings page.
 */
export const CANVA_SCOPES = ['design:content:read', 'design:meta:read', 'profile:read']

export interface CanvaCredentials {
  clientId?: string
  clientSecret?: string
  refreshToken?: string
}

export function isCanvaUsable(credentials: CanvaCredentials): boolean {
  return Boolean(credentials.clientId && credentials.clientSecret && credentials.refreshToken)
}

export function canvaCredentialsFromEnv(): CanvaCredentials {
  return {
    ...(process.env.PRESENTATION_CONVERTER_CANVA_CLIENT_ID
      ? { clientId: process.env.PRESENTATION_CONVERTER_CANVA_CLIENT_ID }
      : {}),
    ...(process.env.PRESENTATION_CONVERTER_CANVA_CLIENT_SECRET
      ? { clientSecret: process.env.PRESENTATION_CONVERTER_CANVA_CLIENT_SECRET }
      : {}),
    ...(process.env.PRESENTATION_CONVERTER_CANVA_REFRESH_TOKEN
      ? { refreshToken: process.env.PRESENTATION_CONVERTER_CANVA_REFRESH_TOKEN }
      : {})
  }
}

/** Environment first, then the settings file — same rule as Google. */
export async function resolveCanvaCredentials(
  store: SettingsStore = settingsStore
): Promise<CanvaCredentials> {
  const fromEnv = canvaCredentialsFromEnv()
  if (isCanvaUsable(fromEnv)) return fromEnv

  const stored = (await store.read()).canva ?? {}
  return {
    ...(stored.clientId ? { clientId: stored.clientId } : {}),
    ...(stored.clientSecret ? { clientSecret: stored.clientSecret } : {}),
    ...(stored.refreshToken ? { refreshToken: stored.refreshToken } : {})
  }
}

// ---------------------------------------------------------------------------
// OAuth (Authorization Code with PKCE — mandatory for Canva)
// ---------------------------------------------------------------------------

function base64Url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export interface CanvaPkce {
  verifier: string
  challenge: string
}

/** Canva requires PKCE with SHA-256; a plain challenge is rejected. */
export function createCanvaPkce(): CanvaPkce {
  const verifier = base64Url(randomBytes(64))
  const challenge = base64Url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

export function buildCanvaAuthUrl(options: {
  clientId: string
  redirectUri: string
  state: string
  codeChallenge: string
}): string {
  const params = new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    response_type: 'code',
    scope: CANVA_SCOPES.join(' '),
    code_challenge: options.codeChallenge,
    code_challenge_method: 'S256',
    state: options.state
  })
  return `${AUTH_URL}?${params.toString()}`
}

function basicAuth(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`
}

interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
}

async function postToken(
  clientId: string,
  clientSecret: string,
  body: URLSearchParams
): Promise<TokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      authorization: basicAuth(clientId, clientSecret),
      'content-type': 'application/x-www-form-urlencoded'
    },
    body
  })
  if (!response.ok) {
    throw new Error(`Canva token request failed (${response.status}): ${await response.text()}`)
  }
  return (await response.json()) as TokenResponse
}

export interface CanvaTokenExchange {
  accessToken: string
  refreshToken?: string
  expiresIn: number
}

export async function exchangeCanvaCode(options: {
  clientId: string
  clientSecret: string
  code: string
  codeVerifier: string
  redirectUri: string
}): Promise<CanvaTokenExchange> {
  const json = await postToken(
    options.clientId,
    options.clientSecret,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code: options.code,
      code_verifier: options.codeVerifier,
      redirect_uri: options.redirectUri
    })
  )
  return {
    accessToken: json.access_token,
    ...(json.refresh_token ? { refreshToken: json.refresh_token } : {}),
    expiresIn: json.expires_in
  }
}

interface CachedToken {
  token: string
  expiresAt: number
}
let cachedToken: CachedToken | undefined

export function resetCanvaTokenCache(): void {
  cachedToken = undefined
}

/**
 * Mints an access token from the stored refresh token.
 *
 * Canva **rotates refresh tokens**: each refresh returns a new one and
 * invalidates the old. The replacement is written straight back to the settings
 * store — without that, the integration works exactly once and then locks the
 * user out until they reconnect by hand.
 */
export async function getCanvaAccessToken(
  credentials?: CanvaCredentials,
  store: SettingsStore = settingsStore
): Promise<string> {
  const resolved = credentials ?? (await resolveCanvaCredentials(store))
  if (!isCanvaUsable(resolved)) {
    throw new Error(
      'No Canva account connected. Connect one on the Settings page, or set ' +
        'PRESENTATION_CONVERTER_CANVA_* environment variables.'
    )
  }

  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token

  const json = await postToken(
    resolved.clientId!,
    resolved.clientSecret!,
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: resolved.refreshToken!
    })
  )

  if (json.refresh_token && json.refresh_token !== resolved.refreshToken) {
    // Persist the rotated token immediately; losing it means losing the
    // connection.
    await store.update('canva', { refreshToken: json.refresh_token })
  }

  cachedToken = {
    token: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000
  }
  return cachedToken.token
}

/** The connected account's display name, for the settings page. */
export async function fetchCanvaAccount(accessToken: string): Promise<string | undefined> {
  try {
    const response = await fetch(`${API_BASE}/users/me/profile`, {
      headers: { authorization: `Bearer ${accessToken}` }
    })
    if (!response.ok) return undefined
    const json = (await response.json()) as { profile?: { display_name?: string } }
    return json.profile?.display_name
  } catch {
    return undefined
  }
}

export async function verifyCanvaCredentials(): Promise<{
  ok: boolean
  account?: string
  error?: string
}> {
  try {
    const token = await getCanvaAccessToken()
    const account = await fetchCanvaAccount(token)
    return { ok: true, ...(account ? { account } : {}) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

// ---------------------------------------------------------------------------
// Design export
// ---------------------------------------------------------------------------

/** Extracts a design id from a Canva URL, or accepts a bare id. */
export function resolveCanvaDesignId(source: string): string {
  const fromUrl = source.match(/canva\.com\/design\/([A-Za-z0-9_-]+)/i)?.[1]
  if (fromUrl) return fromUrl
  if (/^[A-Za-z0-9_-]{8,}$/.test(source)) return source
  throw new Error(`Could not work out a Canva design id from "${source}"`)
}

async function canvaFetch(path: string, token: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init?.headers ?? {})
    }
  })
  if (!response.ok) {
    const detail = await response.text()
    if (response.status === 429) {
      throw new Error(
        'Canva rate limit reached (roughly 75 exports per 5 minutes, 500 per day per user). Try again shortly.'
      )
    }
    throw new Error(`Canva API request failed (${response.status}): ${detail}`)
  }
  return response.json()
}

interface ExportJob {
  job: {
    id: string
    status: 'in_progress' | 'success' | 'failed'
    urls?: string[]
    error?: { code?: string; message?: string }
  }
}

const POLL_INTERVAL_MS = 1500
const DEFAULT_EXPORT_TIMEOUT_MS = 300_000

/**
 * Exports a design and returns its download URLs.
 *
 * Canva's export is asynchronous — create a job, then poll — unlike Drive's
 * synchronous export.
 */
export async function exportCanvaDesign(
  designId: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<string[]> {
  const token = await getCanvaAccessToken()

  const created = (await canvaFetch('/exports', token, {
    method: 'POST',
    body: JSON.stringify({ design_id: designId, format: { type: 'pptx' } }),
    ...(options.signal ? { signal: options.signal } : {})
  })) as ExportJob

  let job = created.job
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_EXPORT_TIMEOUT_MS)

  while (job.status === 'in_progress') {
    if (options.signal?.aborted) throw new Error('Canva export was cancelled')
    if (Date.now() > deadline) {
      throw new Error(`Canva export timed out for design ${designId}`)
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
    const polled = (await canvaFetch(`/exports/${job.id}`, token, {
      ...(options.signal ? { signal: options.signal } : {})
    })) as ExportJob
    job = polled.job
  }

  if (job.status === 'failed') {
    throw new Error(`Canva export failed: ${job.error?.message ?? job.error?.code ?? 'unknown error'}`)
  }
  if (!job.urls || job.urls.length === 0) {
    throw new Error('Canva reported a successful export but returned no download URL')
  }
  return job.urls
}

// ---------------------------------------------------------------------------
// Download cache
// ---------------------------------------------------------------------------

interface DownloadedDeck {
  pptxPath: string
  workDir: string
  fetchedAt: number
  /** The deck's title in Canva, when it has one. */
  title?: string
}

/** The design's title, used to name the output. Never fatal. */
async function fetchDesignTitle(designId: string, token: string): Promise<string | undefined> {
  try {
    const json = (await canvaFetch(`/designs/${designId}`, token)) as {
      design?: { title?: string }
    }
    const title = json.design?.title?.trim()
    return title || undefined
  } catch {
    // design:meta:read may not have been granted; naming falls back to the id.
    return undefined
  }
}

/**
 * The PPTX downloaded for each design, so one conversion exports once.
 *
 * A conversion renders the PDF and then extracts notes, and both come from the
 * same PPTX. Exporting twice would double the API calls against Canva's daily
 * export quota, and — worse — risk the pages and the notes coming from two
 * different snapshots if the design were edited in between.
 */
const downloads = new Map<string, DownloadedDeck>()

/** Long enough to span one conversion, short enough not to serve a stale deck. */
const DOWNLOAD_TTL_MS = 5 * 60 * 1000

async function downloadDeck(
  designId: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<DownloadedDeck> {
  const cached = downloads.get(designId)
  if (cached && Date.now() - cached.fetchedAt < DOWNLOAD_TTL_MS) return cached

  const urls = await exportCanvaDesign(designId, options)
  const url = urls[0]!

  const title = await fetchDesignTitle(designId, await getCanvaAccessToken())

  const response = await fetch(url, options.signal ? { signal: options.signal } : {})
  if (!response.ok) {
    throw new Error(`Could not download the exported Canva deck (${response.status})`)
  }

  const workDir = await mkdtemp(join(tmpdir(), 'presentation-converter-canva-'))
  const pptxPath = join(workDir, `${designId}.pptx`)
  await writeFile(pptxPath, Buffer.from(await response.arrayBuffer()))

  const deck: DownloadedDeck = {
    pptxPath,
    workDir,
    fetchedAt: Date.now(),
    ...(title ? { title } : {})
  }

  // Drop whatever this design had before, then record the new download.
  const previous = downloads.get(designId)
  if (previous) await rm(previous.workDir, { recursive: true, force: true }).catch(() => undefined)
  downloads.set(designId, deck)

  return deck
}

/** Removes every downloaded deck. Call on shutdown, or between test runs. */
export async function clearCanvaDownloads(): Promise<void> {
  await Promise.all(
    [...downloads.values()].map((deck) =>
      rm(deck.workDir, { recursive: true, force: true }).catch(() => undefined)
    )
  )
  downloads.clear()
}

// ---------------------------------------------------------------------------
// Engines
// ---------------------------------------------------------------------------

async function probeCanva(): Promise<EngineAvailability> {
  if (!isCanvaUsable(await resolveCanvaCredentials())) {
    return {
      available: false,
      reason: 'No Canva account connected. Connect one on the Settings page.'
    }
  }
  return { available: true }
}

export const canvaEngine: PdfEngine = {
  id: 'canva',
  label: 'Canva (Connect API)',
  formats: ['canva'],
  // Network-bound, but Canva's export quota is the real constraint.
  maxConcurrency: 2,
  probe: probeCanva,

  /**
   * Exports the design as PPTX and renders that locally.
   *
   * Canva can export PDF directly, but it is deliberately not used: the Connect
   * API exposes no presenter notes, so a PPTX has to be fetched anyway. Taking
   * both the pages and the notes from that one artefact halves the API cost and
   * guarantees they describe the same version of the deck.
   */
  async render(options: RenderOptions): Promise<PdfRenderResult> {
    const designId = resolveCanvaDesignId(options.sourcePath)
    const deck = await downloadDeck(designId, {
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.signal ? { signal: options.signal } : {})
    })

    // Imported lazily: the registry imports this module, so a static import
    // would be circular.
    const { pdfEngineFor } = await import('./registry.js')
    let renderer
    try {
      renderer = await pdfEngineFor('pptx')
    } catch {
      throw new Error(
        'Canva decks are exported as PowerPoint and then rendered locally, but no engine can render ' +
          '.pptx on this machine. Install LibreOffice, or run on a Mac with Keynote.'
      )
    }

    await renderer.render({ ...options, sourcePath: deck.pptxPath })
    return {
      pdfPath: options.outputPath,
      engine: `canva → ${renderer.id}`,
      ...(deck.title ? { suggestedName: deck.title } : {})
    }
  }
}

export const canvaNotesEngine: NotesEngine = {
  id: 'canva',
  label: 'Canva speaker notes (via PPTX export)',
  formats: ['canva'],
  maxConcurrency: 2,
  probe: probeCanva,

  /**
   * Reads notes from the same PPTX the PDF was rendered from.
   *
   * Canva embeds speaker notes in the standard OOXML notes parts — verified
   * against a real export — so the existing extractor handles them unchanged.
   */
  async extract(sourcePath: string, signal?: AbortSignal): Promise<ExtractedNotes> {
    const designId = resolveCanvaDesignId(sourcePath)
    const deck = await downloadDeck(designId, signal ? { signal } : {})
    const result = await extractPptxNotes(deck.pptxPath)
    return { ...result, engine: 'canva (pptx export)' }
  }
}
