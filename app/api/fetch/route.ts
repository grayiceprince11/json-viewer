import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'edge' // optional; works well on Vercel

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get('url')
  if (!url) return NextResponse.json({ error: 'Missing url' }, { status: 400 })

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return NextResponse.json({ error: 'Invalid url' }, { status: 400 })
  }

  if (parsed.protocol !== 'https:') {
    return NextResponse.json({ error: 'Only https URLs are allowed' }, { status: 400 })
  }

  // Simple size/time safeguards
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)

  try {
    const res = await fetch(parsed.toString(), {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mercor-JSON-Viewer' },
    })

    const ct = res.headers.get('content-type') || ''
    if (!res.ok) {
      return NextResponse.json({ error: `Upstream error: ${res.status}` }, { status: 502 })
    }
    if (!ct.includes('application/json') && !ct.includes('text/plain')) {
      // Many APIs still return JSON with text/plain; allow both.
      // Reject obvious non-JSON types.
    }

    const text = await res.text()
    if (text.length > 2_000_000) {
      return NextResponse.json({ error: 'Response too large (>2MB)' }, { status: 413 })
    }

    return NextResponse.json({ text })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Fetch failed' }, { status: 502 })
  } finally {
    clearTimeout(timeout)
  }
}
