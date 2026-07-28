import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createSign } from 'node:crypto'
import type {
  EngineAvailability,
  ExtractedNotes,
  ExtractedSlide,
  NotesEngine,
  PdfEngine,
  PdfRenderResult,
  RenderOptions
} from '../types.js'

const DRIVE_EXPORT = 'https://www.googleapis.com/drive/v3/files'
const SLIDES_API = 'https://slides.googleapis.com/v1/presentations'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'

/** Read-only access is all this tool ever needs. */
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/presentations.readonly'
]

export interface GoogleCredentials {
  /** Path to a service-account JSON key. Best for headless/Nextcloud use. */
  serviceAccountPath?: string
  /** A pre-obtained OAuth access token, used verbatim. */
  accessToken?: string
  /** Installed-app OAuth refresh token plus its client, exchanged on demand. */
  refreshToken?: string
  clientId?: string
  clientSecret?: string
}

/** Reads credentials from the environment, matching the CLI's documented vars. */
export function credentialsFromEnv(): GoogleCredentials {
  return {
    ...(process.env.GOOGLE_APPLICATION_CREDENTIALS
      ? { serviceAccountPath: process.env.GOOGLE_APPLICATION_CREDENTIALS }
      : {}),
    ...(process.env.PRESENTATION_CONVERTER_GOOGLE_TOKEN
      ? { accessToken: process.env.PRESENTATION_CONVERTER_GOOGLE_TOKEN }
      : {}),
    ...(process.env.PRESENTATION_CONVERTER_GOOGLE_REFRESH_TOKEN
      ? { refreshToken: process.env.PRESENTATION_CONVERTER_GOOGLE_REFRESH_TOKEN }
      : {}),
    ...(process.env.PRESENTATION_CONVERTER_GOOGLE_CLIENT_ID
      ? { clientId: process.env.PRESENTATION_CONVERTER_GOOGLE_CLIENT_ID }
      : {}),
    ...(process.env.PRESENTATION_CONVERTER_GOOGLE_CLIENT_SECRET
      ? { clientSecret: process.env.PRESENTATION_CONVERTER_GOOGLE_CLIENT_SECRET }
      : {})
  }
}

function base64Url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

interface CachedToken {
  token: string
  expiresAt: number
}
let cachedToken: CachedToken | undefined

/**
 * Mints an access token from whichever credential is configured.
 *
 * Implemented directly against the token endpoint rather than through the
 * `googleapis` SDK: the only calls needed are one export and one metadata read,
 * and this keeps the dependency footprint small enough to install comfortably
 * alongside a Nextcloud host.
 */
export async function getAccessToken(
  credentials: GoogleCredentials = credentialsFromEnv()
): Promise<string> {
  if (credentials.accessToken) return credentials.accessToken

  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token

  if (credentials.refreshToken && credentials.clientId && credentials.clientSecret) {
    const body = new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      refresh_token: credentials.refreshToken,
      grant_type: 'refresh_token'
    })
    const token = await requestToken(body)
    cachedToken = token
    return token.token
  }

  if (credentials.serviceAccountPath) {
    const key = JSON.parse(await readFile(credentials.serviceAccountPath, 'utf-8')) as {
      client_email: string
      private_key: string
    }
    if (!key.client_email || !key.private_key) {
      throw new Error(`${credentials.serviceAccountPath} is not a valid service-account key file`)
    }

    const now = Math.floor(Date.now() / 1000)
    const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
    const claims = base64Url(
      JSON.stringify({
        iss: key.client_email,
        scope: GOOGLE_SCOPES.join(' '),
        aud: TOKEN_URL,
        iat: now,
        exp: now + 3600
      })
    )
    const signer = createSign('RSA-SHA256')
    signer.update(`${header}.${claims}`)
    const signature = base64Url(signer.sign(key.private_key))

    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claims}.${signature}`
    })
    const token = await requestToken(body)
    cachedToken = token
    return token.token
  }

  throw new Error(
    'No Google credentials configured. Set GOOGLE_APPLICATION_CREDENTIALS to a service-account key, ' +
      'or PRESENTATION_CONVERTER_GOOGLE_REFRESH_TOKEN with its client id/secret.'
  )
}

async function requestToken(body: URLSearchParams): Promise<CachedToken> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body
  })
  if (!response.ok) {
    throw new Error(`Google token request failed (${response.status}): ${await response.text()}`)
  }
  const json = (await response.json()) as { access_token: string; expires_in: number }
  return {
    token: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000
  }
}

/**
 * Extracts a Slides file id from anything a user is likely to supply: a bare
 * id, a share URL, or a `.gslides` Drive shortcut file on disk.
 */
export async function resolvePresentationId(source: string): Promise<string> {
  const fromUrl = source.match(/\/presentation\/d\/([A-Za-z0-9_-]{20,})/)?.[1]
  if (fromUrl) return fromUrl

  const fromOpen = source.match(/[?&]id=([A-Za-z0-9_-]{20,})/)?.[1]
  if (fromOpen) return fromOpen

  if (source.endsWith('.gslides')) {
    // A .gslides file is a small JSON shortcut written by Drive's desktop client.
    const raw = JSON.parse(await readFile(source, 'utf-8')) as { url?: string; doc_id?: string }
    if (raw.doc_id) return raw.doc_id
    if (raw.url) return resolvePresentationId(raw.url)
    throw new Error(`${source} does not contain a Google Slides reference`)
  }

  if (/^[A-Za-z0-9_-]{20,}$/.test(source)) return source

  throw new Error(`Could not work out a Google Slides file id from "${source}"`)
}

async function authorisedFetch(
  url: string,
  credentials: GoogleCredentials,
  signal?: AbortSignal
): Promise<Response> {
  const token = await getAccessToken(credentials)
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    ...(signal ? { signal } : {})
  })
  if (!response.ok) {
    const detail = await response.text()
    if (response.status === 403 && detail.includes('exportSizeLimitExceeded')) {
      throw new Error(
        'Google refused the export because the presentation exceeds the Drive export size limit (10 MB). ' +
          'Export it manually, or reduce the embedded media.'
      )
    }
    throw new Error(`Google API request failed (${response.status}): ${detail}`)
  }
  return response
}

/** Pulls the text out of one Slides API page element tree. */
function textOfElements(elements: unknown[]): string {
  const parts: string[] = []
  for (const element of elements) {
    const shape = (element as { shape?: { text?: { textElements?: unknown[] } } }).shape
    for (const run of shape?.text?.textElements ?? []) {
      const content = (run as { textRun?: { content?: string } }).textRun?.content
      if (content) parts.push(content)
    }
  }
  return parts.join('').replace(/\r\n?/g, '\n').trim()
}

interface SlidesResponse {
  title?: string
  slides?: Array<{
    slideProperties?: {
      isSkipped?: boolean
      notesPage?: {
        pageElements?: unknown[]
        notesProperties?: { speakerNotesObjectId?: string }
      }
    }
    pageElements?: unknown[]
  }>
}

/** Notes plus per-slide metadata for a Google Slides presentation. */
export async function fetchGoogleSlidesNotes(
  presentationId: string,
  credentials: GoogleCredentials = credentialsFromEnv(),
  signal?: AbortSignal
): Promise<ExtractedNotes> {
  // Request only the fields needed; a full presentation payload is large.
  const fields =
    'slides(slideProperties(isSkipped,notesPage(pageElements(objectId,shape(text(textElements(textRun(content))))),' +
    'notesProperties(speakerNotesObjectId))),pageElements(shape(placeholder(type),text(textElements(textRun(content))))))'
  const response = await authorisedFetch(
    `${SLIDES_API}/${presentationId}?fields=${encodeURIComponent(fields)}`,
    credentials,
    signal
  )
  const data = (await response.json()) as SlidesResponse

  const slides: ExtractedSlide[] = (data.slides ?? []).map((slide, i) => {
    const notesPage = slide.slideProperties?.notesPage
    const speakerNotesId = notesPage?.notesProperties?.speakerNotesObjectId

    // The notes page also carries a thumbnail of the slide; the speaker-notes
    // shape is identified by id, so match on it when Google supplies one.
    const elements = notesPage?.pageElements ?? []
    const notesElements = speakerNotesId
      ? elements.filter((el) => (el as { objectId?: string }).objectId === speakerNotesId)
      : elements

    const title = titleOfSlide(slide.pageElements ?? [])

    return {
      index: i + 1,
      ...(title ? { title } : {}),
      notes: textOfElements(notesElements.length > 0 ? notesElements : elements),
      hidden: Boolean(slide.slideProperties?.isSkipped)
    }
  })

  return { slides, engine: 'google-slides' }
}

function titleOfSlide(elements: unknown[]): string | undefined {
  for (const element of elements) {
    const placeholder = (element as { shape?: { placeholder?: { type?: string } } }).shape?.placeholder
    if (placeholder?.type === 'TITLE' || placeholder?.type === 'CENTERED_TITLE') {
      const text = textOfElements([element])
      if (text) return text.split('\n')[0]
    }
  }
  return undefined
}

async function probeGoogle(): Promise<EngineAvailability> {
  const credentials = credentialsFromEnv()
  const configured =
    credentials.accessToken ?? credentials.serviceAccountPath ?? credentials.refreshToken
  if (!configured) {
    return {
      available: false,
      reason:
        'No Google credentials configured. Set GOOGLE_APPLICATION_CREDENTIALS to a service-account key file, ' +
        'or supply an OAuth refresh token.'
    }
  }
  return { available: true }
}

export const googleSlidesEngine: PdfEngine = {
  id: 'google-slides',
  label: 'Google Slides (Drive export)',
  formats: ['google-slides'],
  // Network-bound; Google rate-limits well before this becomes the bottleneck.
  maxConcurrency: 4,
  probe: probeGoogle,

  async render(options: RenderOptions): Promise<PdfRenderResult> {
    const credentials = credentialsFromEnv()
    const id = await resolvePresentationId(options.sourcePath)
    const response = await authorisedFetch(
      `${DRIVE_EXPORT}/${id}/export?mimeType=application%2Fpdf`,
      credentials,
      options.signal
    )
    const bytes = Buffer.from(await response.arrayBuffer())
    await mkdir(dirname(options.outputPath), { recursive: true })
    await writeFile(options.outputPath, bytes)
    return { pdfPath: options.outputPath, engine: googleSlidesEngine.id }
  }
}

export const googleSlidesNotesEngine: NotesEngine = {
  id: 'google-slides',
  label: 'Google Slides speaker notes',
  formats: ['google-slides'],
  maxConcurrency: 4,
  probe: probeGoogle,

  async extract(sourcePath: string, signal?: AbortSignal): Promise<ExtractedNotes> {
    const id = await resolvePresentationId(sourcePath)
    return fetchGoogleSlidesNotes(id, credentialsFromEnv(), signal)
  }
}
