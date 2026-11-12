/**
 * Host half of the task-time bundle.
 *
 * The browser half measures human engagement (typing / reading) and posts closed
 * segments here. This half persists them as an append-only JSONL log, keeps the
 * per-session tag map, and serves the aggregated statistics the panel renders.
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

export const inject = ['webServer']

const INPUT_IDLE_MS = 60_000
const READ_IDLE_MS = 120_000
/** Minimum engagement worth recording: a quick keystroke or a glance is noise. */
const MIN_INPUT_MS = 5_000
const MIN_READ_MS = 30_000
const MAX_TAGS = 12
const MAX_TAG_LENGTH = 32

/** Resolve the durable data directory: `$DSH_HOME/task-time`, else `~/.dsh/task-time`. */
function dataRoot() {
  const home = process.env.DSH_HOME
  return join(home && home.length > 0 ? home : join(homedir(), '.dsh'), 'task-time')
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 4 * 1024 * 1024) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
  })
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function sendText(res, status, body, type) {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** Normalize one interval record from the wire; `undefined` when unusable. */
function normalizeInterval(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const sid = raw.sid
  const channel = raw.ch
  const start = Number(raw.start)
  const end = Number(raw.end)
  if (typeof sid !== 'string' || sid.length === 0) return undefined
  if (channel !== 'input' && channel !== 'read') return undefined
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return undefined
  const span = end - start
  const floor = channel === 'input' ? MIN_INPUT_MS : MIN_READ_MS
  if (span < floor || span > 6 * 60 * 60 * 1000) return undefined
  return {
    s: sid,
    c: channel,
    a: Math.round(start),
    b: Math.round(end),
    w: typeof raw.w === 'string' ? raw.w.slice(0, 64) : '',
  }
}

function intervalKey(row) {
  return `${row.s}|${row.c}|${row.a}|${row.b}|${row.w}`
}

/** Whether a stored interval is long enough to count (also filters legacy short rows). */
function recordable(row) {
  const span = row.b - row.a
  return row.c === 'input' ? span >= MIN_INPUT_MS : span >= MIN_READ_MS
}

/** Merge overlapping `[start, end]` ranges (multi-window double counting). */function mergeRanges(ranges) {
  const sorted = ranges.filter((range) => range[1] > range[0]).sort((x, y) => x[0] - y[0])
  const merged = []
  for (const range of sorted) {
    const last = merged[merged.length - 1]
    if (last !== undefined && range[0] <= last[1]) {
      if (range[1] > last[1]) last[1] = range[1]
      continue
    }
    merged.push([range[0], range[1]])
  }
  return merged
}

function sumRanges(ranges) {
  let total = 0
  for (const range of mergeRanges(ranges)) total += range[1] - range[0]
  return total
}

/** Normalize a tag list: trimmed, de-duplicated, bounded. */
function normalizeTags(input) {
  if (!Array.isArray(input)) return []
  const seen = new Set()
  const tags = []
  for (const item of input) {
    if (typeof item !== 'string') continue
    const tag = item.trim().slice(0, MAX_TAG_LENGTH)
    if (tag.length === 0 || seen.has(tag)) continue
    seen.add(tag)
    tags.push(tag)
    if (tags.length >= MAX_TAGS) break
  }
  return tags
}

export function apply(ctx, config = {}) {
  const root = dataRoot()
  const intervalsFile = join(root, 'intervals.jsonl')
  const tagsFile = join(root, 'tags.json')
  const inputIdleMs = Number(config.inputIdleMs) > 0 ? Number(config.inputIdleMs) : INPUT_IDLE_MS
  const readIdleMs = Number(config.readIdleMs) > 0 ? Number(config.readIdleMs) : READ_IDLE_MS

  const memory = { rows: [], seen: new Set(), tags: {}, loaded: false }
  const metaCache = new Map()
  const META_TTL_MS = 10 * 60 * 1000
  let loading

  async function load() {
    if (memory.loaded) return memory
    if (loading !== undefined) return loading
    loading = (async () => {
      await mkdir(root, { recursive: true })
      try {
        const text = await readFile(intervalsFile, 'utf8')
        for (const line of text.split('\n')) {
          if (line.trim() === '') continue
          let row
          try {
            row = JSON.parse(line)
          } catch {
            continue
          }
          if (row === null || typeof row !== 'object') continue
          if (typeof row.s !== 'string' || typeof row.a !== 'number' || typeof row.b !== 'number') continue
          const key = intervalKey(row)
          if (memory.seen.has(key)) continue
          memory.seen.add(key)
          memory.rows.push(row)
        }
      } catch {
        /* no log yet */
      }
      try {
        const text = await readFile(tagsFile, 'utf8')
        const parsed = JSON.parse(text)
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) memory.tags = parsed
      } catch {
        /* no tags yet */
      }
      memory.loaded = true
      return memory
    })()
    return loading
  }

  async function persistTags() {
    await writeFile(tagsFile, `${JSON.stringify(memory.tags, null, 2)}\n`, 'utf8')
  }

  /** Titles and project directories for the sessions the panel is about to show. */
  async function resolveMetadata(ids) {
    const titles = new Map()
    const projects = new Map()
    if (ids.length === 0) return { titles, projects }
    const query = ctx.get('sessionQuery')
    if (query === undefined || query === null) return { titles, projects }

    const now = Date.now()
    const missing = []
    for (const id of ids) {
      const cached = metaCache.get(id)
      if (cached !== undefined && now - cached.at < META_TTL_MS) {
        if (cached.title !== '') titles.set(id, cached.title)
        if (cached.project !== '') projects.set(id, cached.project)
        continue
      }
      missing.push(id)
    }
    if (missing.length === 0) return { titles, projects }

    const lookupIds = missing.slice(0, 120)
    try {
      if (typeof query.readTitleSnapshots === 'function') {
        const raw = await query.readTitleSnapshots(lookupIds)
        const list = Array.isArray(raw)
          ? raw
          : raw instanceof Map
            ? [...raw.values()]
            : raw !== null && typeof raw === 'object'
              ? Object.values(raw)
              : []
        for (const item of list) {
          const entry =
            item !== null && typeof item === 'object' && 'status' in item && 'value' in item
              ? item.value
              : item
          if (entry === null || typeof entry !== 'object') continue
          const session = entry.session ?? {}
          const id = session.id ?? entry.sessionId ?? entry.id
          const rawTitle = entry.title
          const title =
            typeof rawTitle === 'string'
              ? rawTitle
              : rawTitle !== null && typeof rawTitle === 'object'
                ? rawTitle.title ?? rawTitle.text ?? rawTitle.value
                : undefined
          if (typeof id === 'string' && typeof title === 'string' && title.trim() !== '') {
            titles.set(id, title.trim())
          }
        }
      }
    } catch {
      /* titles are decorative */
    }
    try {
      if (typeof query.listSessions === 'function') {
        const records = await query.listSessions()
        for (const record of Array.isArray(records) ? records : []) {
          if (record === null || typeof record !== 'object') continue
          const header = record.header ?? record
          const id = header.id ?? record.id
          const cwd = header.cwd ?? record.cwd
          if (typeof id === 'string' && typeof cwd === 'string' && cwd.length > 0) {
            projects.set(id, basename(cwd) !== '' ? basename(cwd) : cwd)
          }
        }
      }
    } catch {
      /* project names are decorative */
    }
    for (const id of missing) {
      metaCache.set(id, { title: titles.get(id) ?? '', project: projects.get(id) ?? '', at: now })
    }
    return { titles, projects }
  }

  /** Today's (or any range's) totals for one session, without touching titles. */
  async function buildSessionTotals(sid, from, to) {
    await load()
    const input = []
    const read = []
    let last = 0
    for (const row of memory.rows) {
      if (row.s !== sid) continue
      if (!recordable(row)) continue
      const start = Math.max(row.a, from)
      const end = Math.min(row.b, to)
      if (end <= start) continue
      if (row.c === 'input') input.push([start, end])
      else read.push([start, end])
      if (row.b > last) last = row.b
    }
    const inputMs = sumRanges(input)
    const readMs = sumRanges(read)
    return { sid, inputMs, readMs, totalMs: inputMs + readMs, last }
  }

  /** Aggregate the interval log into per-session rows inside `[from, to]`. */
  async function buildState(from, to) {
    await load()
    const bySession = new Map()
    for (const row of memory.rows) {
      const start = Math.max(row.a, from)
      const end = Math.min(row.b, to)
      if (end <= start) continue
      if (!recordable(row)) continue
      let bucket = bySession.get(row.s)
      if (bucket === undefined) {
        bucket = { input: [], read: [], last: 0 }
        bySession.set(row.s, bucket)
      }
      if (row.c === 'input') bucket.input.push([start, end])
      else bucket.read.push([start, end])
      if (row.b > bucket.last) bucket.last = row.b
    }

    const ids = [...bySession.keys()]
    const { titles, projects } = await resolveMetadata(ids)
    const rows = []
    for (const [sid, bucket] of bySession) {
      const inputMs = sumRanges(bucket.input)
      const readMs = sumRanges(bucket.read)
      const tags = Array.isArray(memory.tags[sid]) ? memory.tags[sid] : []
      rows.push({
        sid,
        title: titles.get(sid) ?? '',
        project: projects.get(sid) ?? '',
        tags,
        inputMs,
        readMs,
        totalMs: inputMs + readMs,
        last: bucket.last,
      })
    }
    rows.sort((x, y) => y.totalMs - x.totalMs)

    const tagUsage = new Map()
    for (const row of rows) {
      for (const tag of row.tags) tagUsage.set(tag, (tagUsage.get(tag) ?? 0) + row.totalMs)
    }
    const allTags = [...tagUsage.entries()]
      .sort((x, y) => y[1] - x[1])
      .map(([tag]) => tag)

    // Persistent vocabulary, independent of the selected range: every tag ever
    // attached to any task stays selectable.
    const tagCount = new Map()
    for (const list of Object.values(memory.tags)) {
      if (!Array.isArray(list)) continue
      for (const tag of list) {
        if (typeof tag !== 'string' || tag === '') continue
        tagCount.set(tag, (tagCount.get(tag) ?? 0) + 1)
      }
    }
    const knownTags = [...tagCount.entries()]
      .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
      .map(([tag]) => tag)

    return { now: Date.now(), from, to, rows, allTags, knownTags, inputIdleMs, readIdleMs }
  }

  /**
   * Usage log: contiguous visits per session inside `[from, to]`. Segments of
   * one session are merged while the gap stays within `gapMs`, so each visit is
   * one "sat down and worked on this task" block with a start and an end.
   */
  async function buildLog(from, to, gapMs) {
    await load()
    const bySession = new Map()
    for (const row of memory.rows) {
      const start = Math.max(row.a, from)
      const end = Math.min(row.b, to)
      if (end <= start) continue
      if (!recordable(row)) continue
      let list = bySession.get(row.s)
      if (list === undefined) {
        list = []
        bySession.set(row.s, list)
      }
      list.push({ a: start, b: end, c: row.c })
    }

    const ids = [...bySession.keys()]
    const { titles, projects } = await resolveMetadata(ids)
    const visits = []
    for (const [sid, list] of bySession) {
      list.sort((x, y) => x.a - y.a)
      let current = null
      for (const seg of list) {
        if (current !== null && seg.a - current.end <= gapMs) {
          if (seg.b > current.end) current.end = seg.b
          if (seg.c === 'input') current.input.push([seg.a, seg.b])
          else current.read.push([seg.a, seg.b])
          continue
        }
        if (current !== null) visits.push(current)
        current = { sid, start: seg.a, end: seg.b, input: [], read: [] }
        if (seg.c === 'input') current.input.push([seg.a, seg.b])
        else current.read.push([seg.a, seg.b])
      }
      if (current !== null) visits.push(current)
    }

    const out = visits.map((visit) => {
      const inputMs = sumRanges(visit.input)
      const readMs = sumRanges(visit.read)
      return {
        sid: visit.sid,
        title: titles.get(visit.sid) ?? '',
        project: projects.get(visit.sid) ?? '',
        tags: Array.isArray(memory.tags[visit.sid]) ? memory.tags[visit.sid] : [],
        start: visit.start,
        end: visit.end,
        inputMs,
        readMs,
        totalMs: inputMs + readMs,
      }
    })
    out.sort((x, y) => y.start - x.start)
    return { now: Date.now(), from, to, gapMs, visits: out }
  }

  function handleGetState(req, res, url) {
    const from = Number(url.searchParams.get('from') ?? 0) || 0
    const toRaw = Number(url.searchParams.get('to') ?? 0) || 0
    const to = toRaw > 0 ? toRaw : Date.now()
    load()
      .then(() => buildState(from, to))
      .then((state) => sendJson(res, 200, state))
      .catch((error) => sendJson(res, 500, { error: String(error?.message ?? error) }))
  }

  async function handleIngest(req, res) {
    const body = await readJsonBody(req)
    const list = Array.isArray(body.intervals) ? body.intervals : []
    await load()
    const accepted = []
    for (const raw of list.slice(0, 2000)) {
      const row = normalizeInterval(raw)
      if (row === undefined) continue
      const key = intervalKey(row)
      if (memory.seen.has(key)) continue
      memory.seen.add(key)
      memory.rows.push(row)
      accepted.push(row)
    }
    if (accepted.length > 0) {
      await appendFile(intervalsFile, `${accepted.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')
    }
    sendJson(res, 200, { ok: true, accepted: accepted.length })
  }

  async function handleTag(req, res) {
    const body = await readJsonBody(req)
    const sid = body.sid
    if (typeof sid !== 'string' || sid.length === 0) {
      sendJson(res, 400, { error: 'sid is required' })
      return
    }
    const tags = normalizeTags(body.tags)
    await load()
    if (tags.length === 0) delete memory.tags[sid]
    else memory.tags[sid] = tags
    await persistTags()
    sendJson(res, 200, { ok: true, sid, tags })
  }

  function csvCell(value) {
    const text = String(value ?? '')
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
  }

  async function handleExport(req, res, url) {
    const from = Number(url.searchParams.get('from') ?? 0) || 0
    const toRaw = Number(url.searchParams.get('to') ?? 0) || 0
    const to = toRaw > 0 ? toRaw : Date.now()
    const state = await buildState(from, to)
    const header = ['session_id', 'title', 'project', 'tags', 'input_ms', 'read_ms', 'total_ms', 'last_active_iso']
    const lines = [header.join(',')]
    for (const row of state.rows) {
      lines.push(
        [
          csvCell(row.sid),
          csvCell(row.title),
          csvCell(row.project),
          csvCell(row.tags.join('|')),
          row.inputMs,
          row.readMs,
          row.totalMs,
          csvCell(new Date(row.last).toISOString()),
        ].join(','),
      )
    }
    sendText(res, 200, `\uFEFF${lines.join('\n')}\n`, 'text/csv; charset=utf-8')
  }

  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://task-time.local')
    const path = url.pathname
    try {
      if (req.method === 'POST' && path === '/task-time/ingest') {
        await handleIngest(req, res)
        return
      }
      if (req.method === 'POST' && path === '/task-time/tag') {
        await handleTag(req, res)
        return
      }
      if (req.method === 'GET' && path === '/task-time/state') {
        handleGetState(req, res, url)
        return
      }
      if (req.method === 'GET' && path === '/task-time/log') {
        const from = Number(url.searchParams.get('from') ?? 0) || 0
        const toRaw = Number(url.searchParams.get('to') ?? 0) || 0
        const to = toRaw > 0 ? toRaw : Date.now()
        const gapParam = Number(url.searchParams.get('gap') ?? 0)
        const gapMs = Number.isFinite(gapParam) && gapParam >= 60000 ? gapParam : 5 * 60 * 1000
        sendJson(res, 200, await buildLog(from, to, gapMs))
        return
      }
      if (req.method === 'GET' && path === '/task-time/session') {
        const sid = url.searchParams.get('sid') ?? ''
        const from = Number(url.searchParams.get('from') ?? 0) || 0
        const toRaw = Number(url.searchParams.get('to') ?? 0) || 0
        const to = toRaw > 0 ? toRaw : Date.now()
        if (sid === '') {
          sendJson(res, 400, { error: 'sid is required' })
          return
        }
        sendJson(res, 200, await buildSessionTotals(sid, from, to))
        return
      }
      if (req.method === 'GET' && path === '/task-time/export.csv') {
        await handleExport(req, res, url)
        return
      }
      sendJson(res, 404, { error: 'not found' })
    } catch (error) {
      sendJson(res, 500, { error: String(error?.message ?? error) })
    }
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: '/task-time',
        handler,
      }),
    'task-time: http routes',
  )
}
