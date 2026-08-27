import type { ConversionResult, Job } from '../api'
import type { JSX } from 'react'

const MARK: Record<ConversionResult['status'], string> = {
  ok: '✓',
  skipped: '–',
  failed: '✗'
}

function basename(path: string): string {
  return path.split('/').pop() ?? path
}

function ResultRow({ result }: { result: ConversionResult }): JSX.Element {
  const meta: string[] = []
  if (result.pageCount !== undefined) meta.push(`${result.pageCount} pages`)
  if (result.notedSlides !== undefined) meta.push(`${result.notedSlides} notes`)
  if (result.slideCount !== undefined && result.slideCount !== result.pageCount) {
    meta.push(`${result.slideCount} slides`)
  }
  if (result.engines) meta.push(`${result.engines.pdf} → ${result.engines.notes}`)

  return (
    <div className="result-row">
      <span className={`result-mark ${result.status}`} aria-hidden="true">
        {MARK[result.status]}
      </span>
      <div className="result-body">
        <div className="result-name" title={result.sourcePath}>
          {basename(result.sourcePath)}
        </div>
        {result.status === 'ok' && <div className="result-meta">{meta.join(' · ')}</div>}
        {result.status === 'skipped' && <div className="result-meta">{result.message}</div>}
        {result.status === 'failed' && <div className="result-error">{result.message}</div>}
        {result.alignment === 'mismatch' && (
          <div className="result-warning">
            Notes may be misaligned — slide count and page count could not be reconciled.
          </div>
        )}
        {result.warnings.map((warning) => (
          <div className="result-warning" key={warning}>
            {warning}
          </div>
        ))}
      </div>
    </div>
  )
}

export function Results({ job, onStop }: { job: Job | null; onStop: (id: string) => void }): JSX.Element {
  if (!job) {
    return (
      <div className="panel">
        <h2>Results</h2>
        <div className="empty">Nothing converted yet.</div>
      </div>
    )
  }

  const ok = job.results.filter((r) => r.status === 'ok').length
  const skipped = job.results.filter((r) => r.status === 'skipped').length
  const failed = job.results.filter((r) => r.status === 'failed').length

  return (
    <div className="panel">
      <h2>Results</h2>
      <div className="summary">
        <span className={`badge ${job.state}`}>{job.state}</span>
        <span>{job.kind === 'watch' ? 'Watching' : 'Converting'}</span>
        <strong>{ok} converted</strong>
        {skipped > 0 && <span>{skipped} up to date</span>}
        {failed > 0 && <span style={{ color: 'var(--err)' }}>{failed} failed</span>}
        {job.state === 'running' && (
          <button type="button" className="danger" onClick={() => onStop(job.id)}>
            {job.kind === 'watch' ? 'Stop watching' : 'Cancel'}
          </button>
        )}
      </div>

      {job.message && <div className="result-error">{job.message}</div>}

      {job.state === 'running' && job.progress && (
        <div className="progress-line">
          {job.progress.phase}: {basename(job.progress.sourcePath)}
          {job.progress.message ? ` — ${job.progress.message}` : ''}
        </div>
      )}

      {job.results.length === 0 && job.state === 'running' && (
        <div className="empty">Working…</div>
      )}
      {job.results.length === 0 && job.state !== 'running' && (
        <div className="empty">No presentations found.</div>
      )}

      {[...job.results]
        .reverse()
        .map((result) => (
          <ResultRow key={`${result.sourcePath}-${result.durationMs}`} result={result} />
        ))}
    </div>
  )
}
