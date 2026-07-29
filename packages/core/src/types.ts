/**
 * Shared types for the conversion pipeline and the notes sidecar format.
 *
 * The sidecar is the whole point of this tool: exporting a PDF is easy, but a
 * PDF throws the presenter notes away. `presentation-commander-client` (and any
 * other consumer) reads the sidecar back to restore per-slide notes.
 */

/** Source presentation formats we know how to handle. */
export type PresentationFormat =
  | 'keynote'
  | 'pptx'
  | 'ppt'
  | 'odp'
  | 'google-slides'
  | 'canva'

/**
 * Formats that live in the cloud rather than on disk.
 *
 * These are addressed by URL or id, so they never appear in a folder scan or a
 * watch folder, and their freshness cannot be judged from a local mtime.
 */
export const REMOTE_FORMATS: readonly PresentationFormat[] = ['google-slides', 'canva']

export function isRemoteFormat(format: PresentationFormat): boolean {
  return REMOTE_FORMATS.includes(format)
}

export const PRESENTATION_EXTENSIONS: Record<string, PresentationFormat> = {
  '.key': 'keynote',
  '.pptx': 'pptx',
  '.pptm': 'pptx',
  '.ppsx': 'pptx',
  '.ppt': 'ppt',
  '.pps': 'ppt',
  '.odp': 'odp',
  '.otp': 'odp',
  '.gslides': 'google-slides'
}

// ---------------------------------------------------------------------------
// Sidecar format
// ---------------------------------------------------------------------------

/** Current sidecar schema version. Bump only on a breaking shape change. */
export const SIDECAR_SCHEMA_VERSION = 1

export interface SidecarSource {
  /** Basename of the source presentation, e.g. `Q3 Review.key`. */
  file: string
  format: PresentationFormat
  /** Source mtime at conversion time, ISO 8601 — used to detect staleness. */
  modifiedAt?: string
  sizeBytes?: number
  /** For Google Slides, the Drive file id the PDF came from. */
  remoteId?: string
}

export interface SidecarSlide {
  /**
   * 1-indexed page in the produced PDF, or `null` when the slide exists in the
   * source but was not rendered (hidden/skipped slides are dropped by every
   * exporter we drive).
   */
  page: number | null
  /** 1-indexed position in the source deck, including hidden slides. */
  index: number
  title?: string
  notes: string
  hidden: boolean
}

/**
 * How confident we are that `notes` keys line up with real PDF pages.
 *
 * `exact`    — slide count and PDF page count agree.
 * `adjusted` — hidden slides were dropped, and after accounting for them the
 *              counts agree, so the mapping is still trustworthy.
 * `mismatch` — counts disagree and we could not reconcile them. Notes are
 *              still emitted 1:1 from slide order, but may be off by a page.
 */
export type NotesAlignment = 'exact' | 'adjusted' | 'mismatch'

export interface NotesSidecar {
  schemaVersion: typeof SIDECAR_SCHEMA_VERSION
  /** e.g. `presentation-converter 0.1.0` */
  generator: string
  convertedAt: string
  source: SidecarSource
  pdf: {
    file: string
    pageCount: number
  }
  /** Number of slides in the source deck, hidden ones included. */
  slideCount: number
  engines: {
    pdf: string
    notes: string
  }
  alignment: NotesAlignment
  /**
   * PDF page number (as a string key) to note text. Only pages with a non-empty
   * note appear. This is the map consumers actually read.
   */
  notes: Record<string, string>
  /** Full per-slide detail, including hidden slides and titles. */
  slides: SidecarSlide[]
  /** Non-fatal problems worth showing the user (e.g. alignment mismatch). */
  warnings: string[]
}

/**
 * The pre-schemaVersion sidecar written by presentation-commander-client: a
 * bare 1-indexed page/note map. Still read, never written.
 */
export type LegacyNotesSidecar = Record<string, string>

// ---------------------------------------------------------------------------
// Engine contracts
// ---------------------------------------------------------------------------

/** A slide's notes and metadata, as recovered from the source deck. */
export interface ExtractedSlide {
  index: number
  title?: string
  notes: string
  hidden: boolean
}

export interface ExtractedNotes {
  slides: ExtractedSlide[]
  /** Identifier of the engine that produced this, recorded in the sidecar. */
  engine: string
}

export interface PdfRenderResult {
  /** Absolute path to the produced PDF. */
  pdfPath: string
  engine: string
  /**
   * A better basename for the output, without extension.
   *
   * Cloud sources are addressed by id, so the output would otherwise be called
   * something like `DAFxyz123.pdf`. An engine that learns the deck's real title
   * while fetching it reports it here, and the conversion renames the output —
   * but only when the caller did not specify an explicit output path.
   */
  suggestedName?: string
}

export interface EngineAvailability {
  available: boolean
  /** Human-readable reason when unavailable, shown verbatim to the user. */
  reason?: string
  /** Version string when we can cheaply determine one. */
  version?: string
}

export interface RenderOptions {
  sourcePath: string
  /** Absolute path the engine should write the PDF to. */
  outputPath: string
  signal?: AbortSignal
  /** Per-file timeout in ms. */
  timeoutMs?: number
}

/** Renders a source presentation to PDF. */
export interface PdfEngine {
  id: string
  label: string
  formats: PresentationFormat[]
  /**
   * How many files this engine can process at once. App-automation engines
   * (Keynote, PowerPoint) drive a single foreground document and MUST stay at 1.
   */
  maxConcurrency: number
  probe(): Promise<EngineAvailability>
  render(options: RenderOptions): Promise<PdfRenderResult>
}

/** Recovers presenter notes from a source presentation. */
export interface NotesEngine {
  id: string
  label: string
  formats: PresentationFormat[]
  maxConcurrency: number
  probe(): Promise<EngineAvailability>
  extract(sourcePath: string, signal?: AbortSignal): Promise<ExtractedNotes>
}

// ---------------------------------------------------------------------------
// Conversion jobs
// ---------------------------------------------------------------------------

export type ConversionStatus = 'ok' | 'skipped' | 'failed'

export interface ConvertOptions {
  /** Absolute path to the source presentation. */
  sourcePath: string
  /**
   * Absolute path for the PDF. Defaults to the source path with a `.pdf`
   * extension, in `outputDir` when given.
   */
  outputPath?: string
  outputDir?: string
  /** Skip when an up-to-date PDF + sidecar already exist. Default true. */
  incremental?: boolean
  /** Write the PDF but not the sidecar. Default false. */
  skipSidecar?: boolean
  /** Force a specific PDF engine id instead of picking the best available. */
  pdfEngineId?: string
  /** Force a specific notes engine id. */
  notesEngineId?: string
  timeoutMs?: number
  signal?: AbortSignal
  onProgress?: (event: ProgressEvent) => void
}

export interface ConversionResult {
  status: ConversionStatus
  sourcePath: string
  pdfPath?: string
  sidecarPath?: string
  slideCount?: number
  pageCount?: number
  notedSlides?: number
  alignment?: NotesAlignment
  engines?: { pdf: string; notes: string }
  warnings: string[]
  /** Present when `status` is `failed`, or when `skipped` (the reason). */
  message?: string
  durationMs: number
}

export type ProgressPhase =
  | 'queued'
  | 'probing'
  | 'rendering'
  | 'extracting-notes'
  | 'writing-sidecar'
  | 'done'
  | 'failed'
  | 'skipped'

export interface ProgressEvent {
  sourcePath: string
  phase: ProgressPhase
  message?: string
  /** 0..1 across a whole batch, when the total is known. */
  fraction?: number
}

export interface BatchOptions extends Omit<ConvertOptions, 'sourcePath' | 'outputPath'> {
  /** Recurse into subdirectories. Default true. */
  recursive?: boolean
  /**
   * Mirror the input folder's subdirectory structure under `outputDir`.
   * Default true. When false, everything lands flat in `outputDir`.
   */
  preserveTree?: boolean
  /** Overall cap on files converted at once. Engines may lower this further. */
  concurrency?: number
  /** Glob-ish substring filters applied to the path; all must miss to include. */
  exclude?: string[]
  onFileComplete?: (result: ConversionResult) => void
}

export interface BatchResult {
  results: ConversionResult[]
  converted: number
  skipped: number
  failed: number
  durationMs: number
}
