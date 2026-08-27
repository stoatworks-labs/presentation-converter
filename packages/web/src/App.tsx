import { useCallback, useEffect, useState } from 'react'
import { api, subscribe, type EngineStatus, type Job } from './api'
import { PathPicker } from './components/PathPicker'
import { Results } from './components/Results'
import { Settings } from './components/Settings'
import type { JSX } from 'react'

type Mode = 'files' | 'folder' | 'watch' | 'settings'

const MODE_LABEL: Record<Mode, string> = {
  files: 'Individual files',
  folder: 'Whole folder',
  watch: 'Watch folder',
  settings: 'Settings'
}

function Engines({ engines }: { engines: EngineStatus[] }): JSX.Element {
  return (
    <div className="panel">
      <h2>Engines on this machine</h2>
      <div className="engine-grid">
        {engines.map((engine) => (
          <div
            key={`${engine.kind}-${engine.id}`}
            className={`engine${engine.availability.available ? ' available' : ''}`}
          >
            <span className="dot" aria-hidden="true" />
            <div>
              <div>
                {engine.label} <span style={{ color: 'var(--muted)' }}>({engine.kind})</span>
              </div>
              <div className="reason">
                {engine.availability.available
                  ? (engine.availability.version ?? engine.formats.join(', '))
                  : engine.availability.reason}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

const MODES = Object.keys(MODE_LABEL) as Mode[]

/**
 * The last-used folders and options.
 *
 * Persisted because the common case is converting the same folders repeatedly —
 * a show's incoming directory doesn't change between runs, and retyping a deep
 * path after every reload is needless friction.
 */
const UI_STATE_KEY = 'presentation-converter:ui'

interface StoredUiState {
  inputDir?: string
  outputDir?: string
  recursive?: boolean
  preserveTree?: boolean
  force?: boolean
  writeSidecar?: boolean
}

function loadUiState(): StoredUiState {
  try {
    const raw = window.localStorage.getItem(UI_STATE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? (parsed as StoredUiState) : {}
  } catch {
    // Private browsing, or a corrupt value — defaults are fine.
    return {}
  }
}

/** Reads the selected tab from the URL hash, so a view can be linked to. */
function modeFromHash(): Mode {
  const hash = window.location.hash.replace(/^#/, '')
  return MODES.includes(hash as Mode) ? (hash as Mode) : 'files'
}

export function App(): JSX.Element {
  const [version, setVersion] = useState('')
  const [engines, setEngines] = useState<EngineStatus[]>([])
  const [mode, setMode] = useState<Mode>(modeFromHash)

  const [stored] = useState(loadUiState)
  const [inputDir, setInputDir] = useState(stored.inputDir ?? '')
  const [outputDir, setOutputDir] = useState(stored.outputDir ?? '')
  const [files, setFiles] = useState<string[]>([])

  const [recursive, setRecursive] = useState(stored.recursive ?? true)
  const [preserveTree, setPreserveTree] = useState(stored.preserveTree ?? true)
  const [force, setForce] = useState(stored.force ?? false)
  const [writeSidecar, setWriteSidecar] = useState(stored.writeSidecar ?? true)

  const [job, setJob] = useState<Job | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    try {
      window.localStorage.setItem(
        UI_STATE_KEY,
        JSON.stringify({ inputDir, outputDir, recursive, preserveTree, force, writeSidecar })
      )
    } catch {
      // Storage unavailable; the app works fine without persistence.
    }
  }, [inputDir, outputDir, recursive, preserveTree, force, writeSidecar])

  // Keep the hash in step with the tab, and follow the browser's back button.
  useEffect(() => {
    const onHashChange = (): void => setMode(modeFromHash())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  useEffect(() => {
    const target = `#${mode}`
    if (window.location.hash !== target) {
      window.history.replaceState(null, '', target)
    }
  }, [mode])

  useEffect(() => {
    void api
      .status()
      .then((status) => {
        setVersion(status.version)
        setEngines(status.engines)
        // Reattach to whatever this server was last doing: a job still running,
        // or failing that the most recent one — so a reload doesn't wipe the
        // results of a conversion that finished a moment ago.
        const running = status.jobs.find((candidate) => candidate.state === 'running')
        setJob(running ?? status.jobs[0] ?? null)
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  useEffect(
    () =>
      subscribe((event) => {
        setJob((current) => {
          if (event.type === 'job') {
            // Only track the job this page started, or adopt one if idle.
            if (!current || current.id === event.job.id) return event.job
            return current
          }
          if (!current) return current
          if (event.type === 'result' && event.jobId === current.id) {
            return { ...current, results: [...current.results, event.result] }
          }
          if (event.type === 'progress' && event.jobId === current.id) {
            return { ...current, progress: event.event }
          }
          return current
        })
      }),
    []
  )

  const options = useCallback(
    () => ({
      ...(outputDir.trim() ? { outputDir: outputDir.trim() } : {}),
      ...(force ? { incremental: false } : {}),
      ...(writeSidecar ? {} : { skipSidecar: true }),
      ...(recursive ? {} : { recursive: false }),
      ...(preserveTree ? {} : { preserveTree: false })
    }),
    [outputDir, force, writeSidecar, recursive, preserveTree]
  )

  const start = async (): Promise<void> => {
    setError(null)
    setBusy(true)
    try {
      if (mode === 'files') {
        if (files.length === 0) throw new Error('Select at least one presentation.')
        setJob(await api.convert(files, options()))
      } else {
        if (!inputDir.trim()) throw new Error('Choose a folder.')
        const started =
          mode === 'folder'
            ? await api.batch(inputDir.trim(), options())
            : await api.watch(inputDir.trim(), options())
        setJob(started)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const stop = async (id: string): Promise<void> => {
    try {
      await api.stopJob(id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const watching = job?.kind === 'watch' && job.state === 'running'

  // Re-probe engines when leaving Settings, so a Google account connected a
  // moment ago shows as available without a reload.
  useEffect(() => {
    if (mode === 'settings') return
    void api
      .status()
      .then((status) => setEngines(status.engines))
      .catch(() => undefined)
  }, [mode])

  return (
    <div className="app">
      <header className="masthead">
        <h1>Presentation Converter</h1>
        <span className="version">
          {version ? `v${version}` : ''} · PDF + presenter-notes sidecar
        </span>
        {/* Opens the shared About dialog — see public/about.js, which delegates
            this attribute from the document, so nothing needs importing here. */}
        <button type="button" className="masthead-about" data-stoatworks-about>
          About
        </button>
      </header>

      {error && <div className="error-banner">{error}</div>}

      <div className="tabs" role="tablist">
        {MODES.map((candidate) => (
          <button
            key={candidate}
            role="tab"
            type="button"
            aria-selected={mode === candidate}
            onClick={() => setMode(candidate)}
          >
            {MODE_LABEL[candidate]}
          </button>
        ))}
      </div>

      {mode === 'settings' ? (
        <Settings />
      ) : (
      <>
      <div className="panel">
        <h2>{MODE_LABEL[mode]}</h2>

        {mode === 'files' ? (
          <>
            <PathPicker
              label="Presentations"
              value={inputDir}
              onChange={setInputDir}
              mode="files"
              selectedFiles={files}
              onToggleFile={(path) =>
                setFiles((current) =>
                  current.includes(path)
                    ? current.filter((item) => item !== path)
                    : [...current, path]
                )
              }
              hint="Browse to a folder, then click presentations to select them."
            />
            {files.length > 0 && (
              <div className="hint">
                {files.length} selected —{' '}
                <button
                  type="button"
                  style={{ padding: '2px 8px', fontSize: 12 }}
                  onClick={() => setFiles([])}
                >
                  clear
                </button>
              </div>
            )}
          </>
        ) : (
          <PathPicker
            label={mode === 'watch' ? 'Folder to watch' : 'Folder to convert'}
            value={inputDir}
            onChange={setInputDir}
            mode="folder"
            hint={
              mode === 'watch'
                ? 'New and changed presentations are converted automatically.'
                : undefined
            }
          />
        )}

        <PathPicker
          label="Output folder (optional)"
          value={outputDir}
          onChange={setOutputDir}
          mode="folder"
          hint="Leave empty to write each PDF next to its source."
        />

        <div className="options">
          {mode !== 'files' && (
            <>
              <label>
                <input
                  type="checkbox"
                  checked={recursive}
                  onChange={(e) => setRecursive(e.target.checked)}
                />
                Include subfolders
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={preserveTree}
                  onChange={(e) => setPreserveTree(e.target.checked)}
                />
                Mirror folder structure
              </label>
            </>
          )}
          <label>
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
            Reconvert even if up to date
          </label>
          <label>
            <input
              type="checkbox"
              checked={writeSidecar}
              onChange={(e) => setWriteSidecar(e.target.checked)}
            />
            Write notes sidecar
          </label>
        </div>

        <div className="actions">
          <button type="button" className="primary" onClick={() => void start()} disabled={busy || watching}>
            {mode === 'watch' ? 'Start watching' : 'Convert'}
          </button>
          {watching && <span className="hint">Watching — drop presentations into the folder.</span>}
        </div>
      </div>

      <Results job={job} onStop={(id) => void stop(id)} />
      </>
      )}
      <Engines engines={engines} />
    </div>
  )
}
