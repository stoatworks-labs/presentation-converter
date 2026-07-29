export interface EngineStatus {
  id: string
  label: string
  kind: 'pdf' | 'notes'
  formats: string[]
  availability: { available: boolean; reason?: string; version?: string }
}

export interface ConversionResult {
  status: 'ok' | 'skipped' | 'failed'
  sourcePath: string
  pdfPath?: string
  sidecarPath?: string
  slideCount?: number
  pageCount?: number
  notedSlides?: number
  alignment?: 'exact' | 'adjusted' | 'mismatch'
  engines?: { pdf: string; notes: string }
  warnings: string[]
  message?: string
  durationMs: number
}

export interface Job {
  id: string
  kind: 'convert' | 'batch' | 'watch'
  state: 'running' | 'done' | 'failed' | 'cancelled'
  target: string
  startedAt: string
  finishedAt?: string
  results: ConversionResult[]
  message?: string
  progress?: { sourcePath: string; phase: string; message?: string }
}

export interface BrowseEntry {
  name: string
  path: string
  isDirectory: boolean
  isPresentation: boolean
}

export interface BrowseResult {
  path: string
  parent: string | null
  entries: BrowseEntry[]
  shortcuts: Array<{ name: string; path: string }>
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) }
  })
  if (!response.ok) {
    const detail = await response.json().catch(() => ({ error: response.statusText }))
    throw new Error((detail as { error?: string }).error ?? `Request failed (${response.status})`)
  }
  return (await response.json()) as T
}

export const api = {
  status: () => request<{ version: string; engines: EngineStatus[]; jobs: Job[] }>('/api/status'),

  browse: (path?: string) =>
    request<BrowseResult>(`/api/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`),

  discover: (path: string, recursive: boolean) =>
    request<{ files: Array<{ path: string; sizeBytes: number }> }>(
      `/api/discover?path=${encodeURIComponent(path)}&recursive=${recursive}`
    ),

  convert: (sources: string[], options: Record<string, unknown>) =>
    request<Job>('/api/convert', {
      method: 'POST',
      body: JSON.stringify({ sources, ...options })
    }),

  batch: (inputDir: string, options: Record<string, unknown>) =>
    request<Job>('/api/batch', {
      method: 'POST',
      body: JSON.stringify({ inputDir, ...options })
    }),

  watch: (inputDir: string, options: Record<string, unknown>) =>
    request<Job>('/api/watch', {
      method: 'POST',
      body: JSON.stringify({ inputDir, ...options })
    }),

  stopJob: (id: string) => request<{ stopped: boolean }>(`/api/jobs/${id}/stop`, { method: 'POST' }),

  settings: () => request<RedactedSettings>('/api/settings'),

  saveGoogleSettings: (patch: {
    clientId?: string
    clientSecret?: string
    serviceAccountJson?: string
  }) =>
    request<RedactedSettings>('/api/settings/google', {
      method: 'PUT',
      body: JSON.stringify(patch)
    }),

  googleConnect: (origin: string) =>
    request<{ url: string; redirectUri: string }>('/api/google/connect', {
      method: 'POST',
      body: JSON.stringify({ origin })
    }),

  googleTest: () =>
    request<{ ok: boolean; account?: string; error?: string }>('/api/google/test', {
      method: 'POST'
    }),

  googleDisconnect: () =>
    request<RedactedSettings>('/api/google/disconnect', { method: 'POST' }),

  saveCanvaSettings: (patch: { clientId?: string; clientSecret?: string }) =>
    request<RedactedSettings>('/api/settings/canva', {
      method: 'PUT',
      body: JSON.stringify(patch)
    }),

  canvaConnect: (origin: string) =>
    request<{ url: string; redirectUri: string }>('/api/canva/connect', {
      method: 'POST',
      body: JSON.stringify({ origin })
    }),

  canvaTest: () =>
    request<{ ok: boolean; account?: string; error?: string }>('/api/canva/test', {
      method: 'POST'
    }),

  canvaDisconnect: () =>
    request<RedactedSettings>('/api/canva/disconnect', { method: 'POST' })
}

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

export type StreamEvent =
  | { type: 'snapshot'; jobs: Job[] }
  | { type: 'job'; job: Job }
  | { type: 'progress'; jobId: string; event: { sourcePath: string; phase: string; message?: string } }
  | { type: 'result'; jobId: string; result: ConversionResult }

/**
 * Subscribes to the server's progress stream.
 *
 * Server-sent events rather than a WebSocket: the traffic is one-way and SSE
 * reconnects on its own, which matters for a GUI left open across a long batch.
 */
export function subscribe(onEvent: (event: StreamEvent) => void): () => void {
  const source = new EventSource('/api/events')

  source.addEventListener('snapshot', (e) =>
    onEvent({ type: 'snapshot', ...JSON.parse((e as MessageEvent).data) })
  )
  source.addEventListener('job', (e) =>
    onEvent({ type: 'job', job: JSON.parse((e as MessageEvent).data) })
  )
  source.addEventListener('progress', (e) =>
    onEvent({ type: 'progress', ...JSON.parse((e as MessageEvent).data) })
  )
  source.addEventListener('result', (e) =>
    onEvent({ type: 'result', ...JSON.parse((e as MessageEvent).data) })
  )

  return () => source.close()
}
