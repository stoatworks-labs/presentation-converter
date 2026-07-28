export * from './types.js'
export { VERSION, GENERATOR } from './version.js'

export { convertFile } from './convert.js'
export { convertFolder, discoverPresentations, type DiscoveredFile } from './batch.js'
export { WatchFolder, type WatchOptions } from './watch.js'

export {
  buildSidecar,
  writeSidecar,
  readSidecar,
  updateSidecarNotes,
  notesFromSidecar,
  isCurrentSidecar,
  type BuildSidecarInput
} from './sidecar.js'
export { pdfPageCount } from './pdf.js'

export {
  describeEngines,
  supportedFormats,
  pdfEngineFor,
  notesEngineFor,
  resetEngineProbes,
  NoEngineError,
  PDF_ENGINES,
  NOTES_ENGINES,
  type EngineStatus
} from './engines/registry.js'

export { findSoffice, resetSofficeCache } from './engines/libreoffice.js'
export { clearKeynoteCache } from './engines/keynote.js'
export {
  resolvePresentationId,
  fetchGoogleSlidesNotes,
  credentialsFromEnv,
  GOOGLE_SCOPES,
  type GoogleCredentials
} from './engines/google.js'

export { extractPptxNotes } from './notes/ooxml.js'
export { extractOdpNotes } from './notes/odf.js'

export {
  formatForPath,
  isPresentation,
  pdfPathFor,
  sidecarPathFor,
  batchOutputPath,
  resolveZipPath,
  outputsAreFresh,
  isInside,
  stemOf
} from './util/paths.js'
