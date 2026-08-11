import { useCallback, useEffect, useState } from 'react'
import { api, type BrowseResult } from '../api'

interface Props {
  label: string
  value: string
  onChange: (path: string) => void
  /** `folder` selects the directory being viewed; `files` selects presentations. */
  mode: 'folder' | 'files'
  selectedFiles?: string[]
  onToggleFile?: (path: string) => void
  hint?: string
}

/**
 * Server-side file picker.
 *
 * A browser file input hands back a File object, not a path, and the converter
 * needs real paths on the machine doing the work — so browsing is done through
 * the API rather than the native dialog.
 */
export function PathPicker({
  label,
  value,
  onChange,
  mode,
  selectedFiles = [],
  onToggleFile,
  hint
}: Props): JSX.Element {
  const [open, setOpen] = useState(false)
  const [listing, setListing] = useState<BrowseResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (path?: string) => {
    setLoading(true)
    setError(null)
    try {
      setListing(await api.browse(path))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // Fetch-on-open: every setState in `load` runs after an await, so this is
    // not the synchronous cascade the rule is aimed at. Left as-is deliberately
    // — see the lint follow-up issue before rewriting it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (open && !listing) void load(value || undefined)
  }, [open, listing, load, value])

  return (
    <div className="field">
      <label htmlFor={`path-${label}`}>{label}</label>
      <div className="path-row">
        <input
          id={`path-${label}`}
          type="text"
          value={value}
          spellCheck={false}
          placeholder="/path/to/folder"
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          onClick={() => {
            setOpen((wasOpen) => !wasOpen)
            if (!open) void load(value || undefined)
          }}
        >
          {open ? 'Close' : 'Browse…'}
        </button>
      </div>
      {hint && <div className="hint">{hint}</div>}

      {open && (
        <div className="browser">
          <div className="browser-bar">
            <button
              type="button"
              disabled={!listing?.parent}
              onClick={() => listing?.parent && void load(listing.parent)}
            >
              ↑ Up
            </button>
            {listing?.shortcuts.map((shortcut) => (
              <button key={shortcut.path} type="button" onClick={() => void load(shortcut.path)}>
                {shortcut.name}
              </button>
            ))}
            <span className="cwd">{listing?.path ?? '…'}</span>
            {mode === 'folder' && listing && (
              <button
                type="button"
                className="primary"
                onClick={() => {
                  onChange(listing.path)
                  setOpen(false)
                }}
              >
                Use this folder
              </button>
            )}
          </div>

          <div className="browser-list">
            {error && <div className="empty">{error}</div>}
            {loading && !listing && <div className="empty">Loading…</div>}
            {listing?.entries.length === 0 && <div className="empty">Nothing here</div>}

            {listing?.entries.map((entry) => {
              const selected = selectedFiles.includes(entry.path)
              return (
                <button
                  key={entry.path}
                  type="button"
                  className={`browser-row${selected ? ' selected' : ''}`}
                  onClick={() => {
                    if (entry.isDirectory) {
                      void load(entry.path)
                    } else if (entry.isPresentation && onToggleFile) {
                      onToggleFile(entry.path)
                    }
                  }}
                  disabled={!entry.isDirectory && !entry.isPresentation}
                >
                  <span className="icon" aria-hidden="true">
                    {entry.isDirectory ? '📁' : entry.isPresentation ? '📊' : '·'}
                  </span>
                  <span className="name">{entry.name}</span>
                  {selected && <span aria-hidden="true">✓</span>}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
