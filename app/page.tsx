'use client'

import React, { useEffect, useMemo, useState } from 'react'
import dynamic from 'next/dynamic'
import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from 'lz-string'

const ReactJson = dynamic(() => import('@microlink/react-json-view'), { ssr: false })

const HASH_PREFIX = 'j='
const LS_JSON_KEY = 'mercor_json_viewer_last'
const LS_THEME_KEY = 'mercor_json_viewer_theme'

function safeJsonParse(text: string): { ok: true; value: any } | { ok: false; error: string } {
  try {
    if (!text.trim()) return { ok: true, value: null }
    return { ok: true, value: JSON.parse(text) }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Invalid JSON' }
  }
}

function formatJson(text: string) {
  const parsed = safeJsonParse(text)
  if (!parsed.ok) return parsed
  return { ok: true as const, value: JSON.stringify(parsed.value, null, 2) }
}

function minifyJson(text: string) {
  const parsed = safeJsonParse(text)
  if (!parsed.ok) return parsed
  return { ok: true as const, value: JSON.stringify(parsed.value) }
}

type Match = { path: string; kind: 'key' | 'value'; preview: string }

function pathJoin(parent: string, key: string | number) {
  if (typeof key === 'number') return `${parent}[${key}]`
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(String(key))
    ? parent
      ? `${parent}.${key}`
      : String(key)
    : `${parent}["${String(key).replace(/"/g, '\\"')}"]`
}

function findMatches(root: any, queryRaw: string, maxMatches = 200): Match[] {
  const q = queryRaw.trim().toLowerCase()
  if (!q) return []
  const out: Match[] = []
  const push = (m: Match) => {
    if (out.length < maxMatches) out.push(m)
  }
  const summarize = (v: any) => {
    if (v === null) return 'null'
    const t = typeof v
    if (t === 'string') return v.length > 160 ? `${v.slice(0, 160)}…` : v
    if (t === 'number' || t === 'boolean') return String(v)
    if (Array.isArray(v)) return `Array(${v.length})`
    if (t === 'object') return `Object(${Object.keys(v).length})`
    return String(v)
  }

  const visit = (node: any, path: string) => {
    if (out.length >= maxMatches) return
    if (node === null || node === undefined) return

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) visit(node[i], pathJoin(path, i))
      return
    }

    if (typeof node === 'object') {
      for (const k of Object.keys(node)) {
        if (k.toLowerCase().includes(q)) push({ path: pathJoin(path, k), kind: 'key', preview: k })
        visit((node as any)[k], pathJoin(path, k))
        if (out.length >= maxMatches) break
      }
      return
    }

    const val = String(node).toLowerCase()
    if (val.includes(q)) push({ path, kind: 'value', preview: summarize(node) })
  }

  visit(root, '')
  return out
}

/* ----------------------------- Form (click-to-expand) ----------------------------- */

type Seg = string | number

function segToPointer(seg: Seg) {
  // Encode to keep pointer stable even with weird keys
  return encodeURIComponent(String(seg))
}

function pointerFromSegments(segs: Seg[]) {
  if (segs.length === 0) return '/'
  return '/' + segs.map(segToPointer).join('/')
}

function isExpandable(v: any) {
  return v !== null && typeof v === 'object'
}

function countLabel(v: any) {
  if (!isExpandable(v)) return ''
  if (Array.isArray(v)) return `[${v.length}]`
  return `{${Object.keys(v).length}}`
}

function summarizeValue(v: any) {
  if (v === null) return 'null'
  const t = typeof v
  if (t === 'string') return v.length > 160 ? `${v.slice(0, 160)}…` : v
  if (t === 'number' || t === 'boolean') return String(v)
  if (Array.isArray(v)) return `Array ${countLabel(v)}`
  if (t === 'object') return `Object ${countLabel(v)}`
  return String(v)
}

function collectExpandablePointers(root: any, limit = 6000): Set<string> {
  const out = new Set<string>()
  const walk = (node: any, segs: Seg[]) => {
    if (out.size >= limit) return
    if (!isExpandable(node)) return
    out.add(pointerFromSegments(segs))
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        walk(node[i], [...segs, i])
        if (out.size >= limit) break
      }
    } else {
      for (const k of Object.keys(node)) {
        walk((node as any)[k], [...segs, k])
        if (out.size >= limit) break
      }
    }
  }
  walk(root, [])
  return out
}

function FormViewer({
  value,
  toast,
}: {
  value: any
  toast: (msg: string) => void
}) {
  // default like jsonformatter: root expanded, children collapsed
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set<string>(['/']))
  const [selected, setSelected] = useState<Seg[]>([]) // breadcrumb

  const rootPointer = '/'
  const selectedPointer = pointerFromSegments(selected)

  const toggle = (segs: Seg[]) => {
    const p = pointerFromSegments(segs)
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(p)) next.delete(p)
      else next.add(p)
      next.add(rootPointer) // keep root open
      return next
    })
  }

  const ensureOpen = (segs: Seg[]) => {
    // opens all ancestors so selecting a deep node shows it
    const pointers: string[] = [rootPointer]
    for (let i = 0; i < segs.length; i++) {
      pointers.push(pointerFromSegments(segs.slice(0, i + 1)))
    }
    setExpanded((prev) => {
      const next = new Set(prev)
      pointers.forEach((p) => next.add(p))
      return next
    })
  }

  const onSelect = (segs: Seg[]) => {
    setSelected(segs)
    ensureOpen(segs)
  }

  const expandAll = () => {
    const set = collectExpandablePointers(value, 6000)
    if (set.size >= 6000) toast('Large JSON: expanded many nodes (capped).')
    set.add(rootPointer)
    setExpanded(set)
  }

  const collapseAll = () => {
    setExpanded(new Set([rootPointer]))
  }

  const renderNode = (node: any, segs: Seg[], depth: number) => {
    if (!isExpandable(node)) return null

    const isArr = Array.isArray(node)
    const keys: Seg[] = isArr ? node.map((_: any, i: number) => i) : Object.keys(node)

    return (
      <div>
        {keys.map((k) => {
          const child = isArr ? node[k as number] : (node as any)[k as string]
          const childSegs = [...segs, k]
          const p = pointerFromSegments(childSegs)
          const expandable = isExpandable(child)
          const open = expanded.has(p)
          const label = typeof k === 'number' ? `[${k}]` : String(k)

          return (
            <div key={p} style={{ marginLeft: depth === 0 ? 0 : 16 }}>
              <div style={styles.formRow}>
                {expandable ? (
                  <button
                    style={styles.caretBtn}
                    onClick={() => toggle(childSegs)}
                    aria-label={open ? 'Collapse' : 'Expand'}
                  >
                    {open ? '▾' : '▸'}
                  </button>
                ) : (
                  <div style={{ width: 28 }} />
                )}

                <button
                  style={{
                    ...styles.formKeyBtn,
                    background: selectedPointer === p ? 'rgba(107,99,255,0.18)' : 'transparent',
                  }}
                  onClick={() => onSelect(childSegs)}
                  title={p}
                >
                  <span style={styles.formKey}>{label}</span>
                  {expandable ? <span style={styles.formCount}>{countLabel(child)}</span> : null}
                </button>

                <div style={styles.formValue}>
                  {expandable ? (
                    <button style={styles.formValueBtn} onClick={() => toggle(childSegs)}>
                      {summarizeValue(child)}
                    </button>
                  ) : (
                    <span style={styles.formPrimitive}>{summarizeValue(child)}</span>
                  )}
                </div>
              </div>

              {expandable && open ? (
                <div style={{ marginLeft: 18, marginTop: 6, marginBottom: 8 }}>
                  {isArr || typeof child === 'object' ? renderNode(child, childSegs, depth + 1) : null}
                  {!Array.isArray(child) && typeof child === 'object' ? (
                    // show primitive fields (object rows already show primitives inline),
                    // so nothing extra needed
                    null
                  ) : null}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
    )
  }

  const breadcrumbParts: { label: string; segs: Seg[] }[] = [
    { label: 'object', segs: [] },
    ...selected.map((seg, idx) => ({
      label: typeof seg === 'number' ? `[${seg}]` : String(seg),
      segs: selected.slice(0, idx + 1),
    })),
  ]

  const rootTypeLabel = value === null ? 'null' : Array.isArray(value) ? `array ${countLabel(value)}` : `object ${countLabel(value)}`

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 10, alignItems: 'center' }}>
        <button style={styles.btn} onClick={expandAll}>Expand all (Form)</button>
        <button style={styles.btn} onClick={collapseAll}>Collapse all (Form)</button>

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ color: 'var(--m-muted)', fontSize: 12 }}>Breadcrumb:</div>
          <div style={styles.breadcrumb}>
            {breadcrumbParts.map((b, i) => (
              <span key={i} style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                <button
                  style={styles.crumbBtn}
                  onClick={() => onSelect(b.segs)}
                  title={pointerFromSegments(b.segs)}
                >
                  {b.label}
                </button>
                {i < breadcrumbParts.length - 1 ? <span style={{ color: 'var(--m-muted)' }}>{'>'}</span> : null}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div style={{ ...styles.codeBlock, padding: 0 }}>
        {/* Root header row, like jsonformatter "object {n}" */}
        <div style={{ ...styles.formRow, borderBottom: '1px solid var(--m-border)' }}>
          <button style={styles.caretBtn} onClick={() => toggle([])} aria-label="Toggle root">
            {expanded.has(rootPointer) ? '▾' : '▸'}
          </button>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ ...styles.formKey, fontWeight: 800 }}>{rootTypeLabel}</span>
          </div>
          <div style={styles.formValue} />
        </div>

        <div style={{ padding: 10 }}>
          {expanded.has(rootPointer) ? renderNode(value, [], 0) : null}
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------ Page ------------------------------------ */

export default function Page() {
  const [raw, setRaw] = useState('{\n  "hello": "paste JSON here"\n}')
  const [autoFormat, setAutoFormat] = useState(true)

  // Tree default: root expanded, children collapsed (matches your screenshot)
  const [collapsed, setCollapsed] = useState<boolean | number>(1)

  const [viewerKey, setViewerKey] = useState(0) // forces remount for expand/collapse
  const [search, setSearch] = useState('')
  const [urlToLoad, setUrlToLoad] = useState('')
  const [toast, setToast] = useState('')
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const [viewMode, setViewMode] = useState<'tree' | 'code' | 'text' | 'form'>('tree')

  // Load theme
  useEffect(() => {
    const saved = window.localStorage.getItem(LS_THEME_KEY)
    const t = saved === 'light' ? 'light' : 'dark'
    setTheme(t)
    document.documentElement.dataset.theme = t
  }, [])

  // Persist theme
  useEffect(() => {
    window.localStorage.setItem(LS_THEME_KEY, theme)
    document.documentElement.dataset.theme = theme
  }, [theme])

  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))

  // Load JSON from URL hash first; else localStorage
  useEffect(() => {
    const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash
    if (hash.startsWith(HASH_PREFIX)) {
      const payload = hash.slice(HASH_PREFIX.length)
      const decompressed = decompressFromEncodedURIComponent(payload)
      if (decompressed) {
        setRaw(decompressed)
        return
      }
    }
    const saved = window.localStorage.getItem(LS_JSON_KEY)
    if (saved) setRaw(saved)
  }, [])

  // Persist JSON
  useEffect(() => {
    window.localStorage.setItem(LS_JSON_KEY, raw)
  }, [raw])

  const parsed = useMemo(() => safeJsonParse(raw), [raw])

  const matches = useMemo(() => {
    if (!parsed.ok) return []
    if (search.trim().length < 2) return []
    return findMatches(parsed.value ?? {}, search, 200)
  }, [parsed, search])

  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(''), 1400)
  }

  const copyShareLink = async () => {
    const payload = compressToEncodedURIComponent(raw)
    const url = new URL(window.location.href)
    url.hash = `${HASH_PREFIX}${payload}`
    await navigator.clipboard.writeText(url.toString())
    showToast('Share link copied')
  }

  const downloadJson = () => {
    const blob = new Blob([raw], { type: 'application/json;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'data.json'
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const onUpload = async (file?: File | null) => {
    if (!file) return
    setRaw(await file.text())
    setViewerKey((k) => k + 1)
    showToast('Loaded file')
  }

  const doFormat = () => {
    const res = formatJson(raw)
    if (!res.ok) return showToast(`Invalid JSON: ${res.error}`)
    setRaw(res.value)
    setViewerKey((k) => k + 1)
    showToast('Formatted')
  }

  const doMinify = () => {
    const res = minifyJson(raw)
    if (!res.ok) return showToast(`Invalid JSON: ${res.error}`)
    setRaw(res.value)
    setViewerKey((k) => k + 1)
    showToast('Minified')
  }

  const expandAllTree = () => {
    setCollapsed(false)
    setViewerKey((k) => k + 1)
  }

  const collapseAllTree = () => {
    setCollapsed(true)
    setViewerKey((k) => k + 1)
  }

  const resetTreeDefault = () => {
    // root expanded, children collapsed
    setCollapsed(1)
    setViewerKey((k) => k + 1)
  }

  const loadFromUrl = async () => {
    if (!urlToLoad.trim()) return
    showToast('Loading…')
    try {
      const r = await fetch(`/api/fetch?url=${encodeURIComponent(urlToLoad.trim())}`)
      const j = await r.json()
      if (!r.ok) return showToast(j?.error ?? 'Failed')
      setRaw(j.text)
      setViewerKey((k) => k + 1)
      showToast('Loaded URL')
    } catch (e: any) {
      showToast(e?.message ?? 'Failed')
    }
  }

  // Gentle auto-format
  useEffect(() => {
    if (!autoFormat) return
    const res = safeJsonParse(raw)
    if (!res.ok) return
    if (raw.includes('\n') && raw.includes('  ')) return
    const pretty = JSON.stringify(res.value, null, 2)
    if (pretty !== raw) setRaw(pretty)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFormat])

  const pageBg =
    theme === 'dark'
      ? 'radial-gradient(900px 500px at 20% 0%, rgba(107,99,255,0.35), transparent 60%), var(--m-bg)'
      : 'radial-gradient(900px 500px at 20% 0%, rgba(107,99,255,0.18), transparent 60%), var(--m-bg)'

  const rjvTheme = theme === 'dark' ? ('monokai' as any) : ('rjv-default' as any)

  return (
    <div style={{ ...styles.page, background: pageBg }}>
      <style>{`
        :root[data-theme="dark"]{
          --m-bg: #0b0b12;
          --m-panel: rgba(255,255,255,0.06);
          --m-border: rgba(255,255,255,0.10);
          --m-text: rgba(255,255,255,0.92);
          --m-muted: rgba(255,255,255,0.65);
          --m-accent: #6B63FF;
          --m-accent2: #8E86FF;
          --m-input: rgba(0,0,0,0.25);
          --m-btn: rgba(255,255,255,0.06);
        }
        :root[data-theme="light"]{
          --m-bg: #f6f7fb;
          --m-panel: rgba(0,0,0,0.04);
          --m-border: rgba(0,0,0,0.10);
          --m-text: rgba(0,0,0,0.88);
          --m-muted: rgba(0,0,0,0.55);
          --m-accent: #6B63FF;
          --m-accent2: #8E86FF;
          --m-input: rgba(255,255,255,0.92);
          --m-btn: rgba(255,255,255,0.75);
        }
        * { box-sizing: border-box; }
        button, select { font: inherit; }
      `}</style>

      {/* Header */}
      <div style={styles.header}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <img
            src={theme === 'dark' ? '/mercor-logo-dark.png' : '/mercor-logo-light.png'}
            alt="Mercor"
            style={{ width: 28, height: 28 }}
          />
          <div style={{ fontWeight: 800, letterSpacing: 0.2 }}>Mercor JSON Viewer</div>
        </div>
        <div style={{ color: 'var(--m-muted)', fontSize: 12 }}>Share a link — no installs needed</div>
      </div>

      {/* Toolbar */}
      <div style={styles.toolbar}>
        <button style={styles.btn} onClick={doFormat}>Format</button>
        <button style={styles.btn} onClick={doMinify}>Minify</button>

        {/* Tree controls (still useful even if you’re in other views) */}
        <button style={styles.btn} onClick={expandAllTree}>Expand all (Tree)</button>
        <button style={styles.btn} onClick={collapseAllTree}>Collapse all (Tree)</button>
        <button style={styles.btn} onClick={resetTreeDefault}>Default (Tree)</button>

        <button style={styles.btn} onClick={downloadJson}>Download</button>
        <button style={styles.btnPrimary} onClick={copyShareLink}>Copy share link</button>

        <label style={{ ...styles.btn, cursor: 'pointer' }}>
          Upload
          <input
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={(e) => onUpload(e.target.files?.[0])}
          />
        </label>

        <label style={styles.toggle}>
          <input
            type="checkbox"
            checked={autoFormat}
            onChange={(e) => setAutoFormat(e.target.checked)}
          />
          <span style={{ color: 'var(--m-muted)' }}>Auto format</span>
        </label>

        <button style={styles.btn} onClick={toggleTheme}>
          {theme === 'dark' ? 'Light mode' : 'Dark mode'}
        </button>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={styles.label}>View</div>
          <select value={viewMode} onChange={(e) => setViewMode(e.target.value as any)} style={styles.select}>
            <option value="tree">Tree</option>
            <option value="form">Form</option>
            <option value="code">Code</option>
            <option value="text">Text</option>
          </select>
          {toast ? <div style={{ color: 'var(--m-muted)', fontSize: 12 }}>{toast}</div> : null}
        </div>
      </div>

      {/* URL Load + Search */}
      <div style={styles.topRow}>
        <div style={styles.panel}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={styles.label}>Load from URL</div>
            <input
              value={urlToLoad}
              onChange={(e) => setUrlToLoad(e.target.value)}
              placeholder="https://…/data.json"
              style={styles.input}
            />
            <button style={styles.btn} onClick={loadFromUrl}>Load</button>
            <div style={{ color: 'var(--m-muted)', fontSize: 12 }}>(Uses serverless proxy)</div>
          </div>
        </div>

        <div style={styles.panel}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={styles.label}>Search</div>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Type 2+ characters (keys + values)"
              style={styles.input}
            />
            <button style={styles.btn} onClick={() => setSearch('')}>Clear</button>
            <div style={{ color: 'var(--m-muted)', fontSize: 12 }}>
              {search.trim().length < 2 ? 'Tip: 2+ chars' : `${matches.length} match(es)`}
            </div>
          </div>
        </div>
      </div>

      {/* Main */}
      <div style={styles.grid}>
        <div style={styles.panel}>
          <div style={styles.sectionTitle}>Input</div>
          <textarea
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            spellCheck={false}
            style={styles.textarea}
          />

          {!parsed.ok ? (
            <div style={{ marginTop: 10, color: '#ff4d4f', fontSize: 13 }}>
              <b>Invalid JSON:</b> {parsed.error}
            </div>
          ) : null}

          {search.trim().length >= 2 && parsed.ok ? (
            <div style={{ marginTop: 10, borderTop: '1px solid var(--m-border)', paddingTop: 10 }}>
              <div style={{ color: 'var(--m-muted)', fontSize: 12, marginBottom: 8 }}>Matches (copy path)</div>
              <div style={{ display: 'grid', gap: 8, maxHeight: 180, overflow: 'auto' }}>
                {matches.map((m, idx) => (
                  <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={styles.mono}>
                        {m.path || '(root)'} <span style={{ color: 'var(--m-muted)' }}>· {m.kind}</span>
                      </div>
                      <div
                        style={{
                          color: 'var(--m-muted)',
                          fontSize: 12,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {m.preview}
                      </div>
                    </div>
                    <button
                      style={styles.btn}
                      onClick={async () => {
                        await navigator.clipboard.writeText(m.path || '')
                        showToast('Path copied')
                      }}
                    >
                      Copy path
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        <div style={styles.panel}>
          <div style={styles.sectionTitle}>Output</div>

          <div style={{ marginTop: 10 }}>
            {!parsed.ok ? (
              <div style={{ color: 'var(--m-muted)' }}>Fix JSON to see outputs.</div>
            ) : viewMode === 'tree' ? (
              <ReactJson
                key={viewerKey}
                src={parsed.value ?? {}}
                name={null}
                collapsed={collapsed}
                enableClipboard={true}
                displayDataTypes={false}
                displayObjectSize={true}
                theme={rjvTheme}
                // read-only
                onEdit={false as any}
                onAdd={false as any}
                onDelete={false as any}
              />
            ) : viewMode === 'form' ? (
              <FormViewer value={parsed.value ?? {}} toast={showToast} />
            ) : viewMode === 'code' ? (
              <pre style={styles.codeBlock}>{JSON.stringify(parsed.value ?? {}, null, 2)}</pre>
            ) : (
              <pre style={styles.codeBlock}>{raw}</pre>
            )}
          </div>

          <div style={{ marginTop: 12, color: 'var(--m-muted)', fontSize: 12 }}>
            Tip: Share links encode JSON in the URL hash. Avoid sensitive data; very large JSON may exceed URL limits.
          </div>
        </div>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    padding: 18,
    color: 'var(--m-text)',
    fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 14px',
    border: '1px solid var(--m-border)',
    background: 'rgba(255,255,255,0.04)',
    borderRadius: 14,
    marginBottom: 12,
  },
  toolbar: {
    display: 'flex',
    gap: 10,
    flexWrap: 'wrap',
    alignItems: 'center',
    padding: '10px 12px',
    border: '1px solid var(--m-border)',
    background: 'rgba(255,255,255,0.04)',
    borderRadius: 14,
    marginBottom: 12,
  },
  topRow: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 12,
    marginBottom: 12,
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 12,
  },
  panel: {
    border: '1px solid var(--m-border)',
    background: 'var(--m-panel)',
    borderRadius: 14,
    padding: 12,
  },
  sectionTitle: { fontWeight: 800, fontSize: 13, color: 'var(--m-muted)' },
  btn: {
    border: '1px solid var(--m-border)',
    background: 'var(--m-btn)',
    color: 'var(--m-text)',
    padding: '8px 10px',
    borderRadius: 12,
    cursor: 'pointer',
  },
  btnPrimary: {
    border: '1px solid rgba(107,99,255,0.8)',
    background: 'linear-gradient(180deg, var(--m-accent), var(--m-accent2))',
    color: '#0b0b12',
    padding: '8px 10px',
    borderRadius: 12,
    cursor: 'pointer',
    fontWeight: 800,
  },
  toggle: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px' },
  label: { fontWeight: 800, fontSize: 12, color: 'var(--m-muted)' },
  select: {
    padding: '8px 10px',
    borderRadius: 12,
    border: '1px solid var(--m-border)',
    background: 'var(--m-input)',
    color: 'var(--m-text)',
    outline: 'none',
  },
  input: {
    flex: 1,
    minWidth: 240,
    padding: '8px 10px',
    borderRadius: 12,
    border: '1px solid var(--m-border)',
    background: 'var(--m-input)',
    color: 'var(--m-text)',
    outline: 'none',
  },
  textarea: {
    width: '100%',
    minHeight: 480,
    marginTop: 10,
    borderRadius: 12,
    border: '1px solid var(--m-border)',
    background: 'var(--m-input)',
    color: 'var(--m-text)',
    padding: 12,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    fontSize: 13,
    lineHeight: 1.35,
    resize: 'vertical',
    outline: 'none',
  },
  codeBlock: {
    margin: 0,
    padding: 12,
    borderRadius: 12,
    border: '1px solid var(--m-border)',
    background: 'var(--m-input)',
    overflow: 'auto',
    maxHeight: 650,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    fontSize: 13,
    lineHeight: 1.35,
  },
  mono: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    fontSize: 12,
  },

  // Form styles
  formRow: {
    display: 'grid',
    gridTemplateColumns: '28px 260px 1fr',
    gap: 10,
    alignItems: 'center',
    padding: '6px 8px',
    borderRadius: 10,
  },
  caretBtn: {
    width: 28,
    height: 28,
    borderRadius: 10,
    border: '1px solid var(--m-border)',
    background: 'var(--m-btn)',
    color: 'var(--m-text)',
    cursor: 'pointer',
    display: 'grid',
    placeItems: 'center',
    lineHeight: 1,
  },
  formKeyBtn: {
    textAlign: 'left',
    border: '1px solid var(--m-border)',
    background: 'transparent',
    color: 'var(--m-text)',
    padding: '6px 8px',
    borderRadius: 10,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    overflow: 'hidden',
  },
  formKey: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    fontSize: 13,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  formCount: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    fontSize: 13,
    color: 'var(--m-muted)',
    flex: 'none',
  },
  formValue: {
    minWidth: 0,
  },
  formValueBtn: {
    width: '100%',
    textAlign: 'left',
    border: '1px solid var(--m-border)',
    background: 'rgba(255,255,255,0.02)',
    color: 'var(--m-muted)',
    padding: '6px 8px',
    borderRadius: 10,
    cursor: 'pointer',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    fontSize: 13,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  formPrimitive: {
    display: 'inline-block',
    width: '100%',
    border: '1px solid var(--m-border)',
    background: 'rgba(255,255,255,0.02)',
    color: 'var(--m-muted)',
    padding: '6px 8px',
    borderRadius: 10,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    fontSize: 13,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  breadcrumb: {
    display: 'flex',
    gap: 8,
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  crumbBtn: {
    border: '1px solid var(--m-border)',
    background: 'var(--m-btn)',
    color: 'var(--m-text)',
    padding: '4px 8px',
    borderRadius: 999,
    cursor: 'pointer',
    fontSize: 12,
  },
}
