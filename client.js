/* eslint-disable */
/**
 * Client half of the task-time bundle.
 *
 * Two responsibilities:
 *  1. Instrument the page: turn typing in the composer and reading/scrolling in
 *     the conversation into engagement segments, cut by focus loss, session
 *     switch, or an idle timeout (2 min typing / 5 min reading).
 *  2. Render the statistics panel (tag / task / project rollups) and the sidebar
 *     entry that selects it.
 */
window.__ModuleLoader__.load({
  id: 'dsh-task-time',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const API = '/task-time'
    const NS = 'task-time'
    const PANEL_ID = 'task-time'
    const MIN_INPUT_MS = 5000
    const MIN_READ_MS = 30000
    const FLUSH_DELAY_MS = 500
    const INPUT_IDLE_FALLBACK = 60000
    const READ_IDLE_FALLBACK = 120000

    const zh = {
      'panel.title': '任务计时',
      'panel.subtitle': '按任务统计输入与阅读投入',
      'view.stats': '统计',
      'view.log': '使用记录',
      'col.time': '时间',
      'col.duration': '时长',
      'log.today': '今天',
      'log.yesterday': '昨天',
      'log.empty': '这段时间还没有使用记录',
      'log.gap': '同一任务相邻记录间隔不超过 5 分钟会合并成一条。',
      'range.today': '今天',
      'range.7d': '近 7 天',
      'range.30d': '近 30 天',
      'range.all': '全部',
      'group.tag': '按标签',
      'group.task': '按任务',
      'group.project': '按项目',
      'card.total': '总投入',
      'card.input': '输入',
      'card.read': '阅读',
      'card.tasks': '任务数',
      'col.name': '任务',
      'col.tags': '标签',
      'col.tasks': '任务数',
      'col.input': '输入',
      'col.read': '阅读',
      'col.total': '合计',
      'col.share': '占比',
      'col.last': '最后活动',
      'row.edit': '编辑',
      'tag.new': '新标签',
      'tag.add': '添加',
      'row.save': '保存',
      'row.cancel': '取消',
      'empty': '还没有记录。在对话里打字、滚动或翻看内容就会开始计时。',
      'untagged': '未分类',
      'unknownProject': '未知项目',
      'note.rule': '计时规则：输入以最后一次按键/输入法上屏后 {i} 分钟为界，阅读以最后一次滚动/点击/选择后 {r} 分钟为界；切走任务、切换窗口或页面不可见立即停止。',
      'note.data': '数据仅保存在本机 ~/.dsh/task-time，只记录时间区间与任务 id，不记录任何文本。',
      'note.tag': '标签用逗号分隔，第一个标签用于“按标签”分组。',
      'tagTable.title': '标签统计',
      'tagTable.note': '多标签任务会在每个标签下各计一次',
      'refresh': '刷新',
      'error': '读取失败',
      'hud.input': '输入',
      'hud.read': '阅读',
      'hud.title': '今日合计 {total}，点击查看统计',
    }

    const en = {
      'panel.title': 'Task time',
      'panel.subtitle': 'Typing and reading time per task',
      'view.stats': 'Statistics',
      'view.log': 'Log',
      'col.time': 'Time',
      'col.duration': 'Duration',
      'log.today': 'Today',
      'log.yesterday': 'Yesterday',
      'log.empty': 'No usage recorded in this range',
      'log.gap': 'Consecutive records of one task merge while the gap stays under 5 minutes.',
      'range.today': 'Today',
      'range.7d': '7 days',
      'range.30d': '30 days',
      'range.all': 'All',
      'group.tag': 'By tag',
      'group.task': 'By task',
      'group.project': 'By project',
      'card.total': 'Total',
      'card.input': 'Typing',
      'card.read': 'Reading',
      'card.tasks': 'Tasks',
      'col.name': 'Task',
      'col.tags': 'Tags',
      'col.tasks': 'Tasks',
      'col.input': 'Typing',
      'col.read': 'Reading',
      'col.total': 'Total',
      'col.share': 'Share',
      'col.last': 'Last active',
      'row.edit': 'Edit',
      'tag.new': 'New tag',
      'tag.add': 'Add',
      'row.save': 'Save',
      'row.cancel': 'Cancel',
      'empty': 'No records yet. Typing, scrolling, or reading in a conversation starts the clock.',
      'untagged': 'Untagged',
      'unknownProject': 'Unknown project',
      'note.rule': 'Rules: typing stops {i} min after the last keystroke or IME commit; reading stops {r} min after the last scroll, click, or selection. Switching task, window, or page visibility stops immediately.',
      'note.data': 'Stored only on this machine under ~/.dsh/task-time: time ranges and task ids, never text.',
      'note.tag': 'Separate tags with commas; the first tag is used by the “By tag” grouping.',
      'tagTable.title': 'Tag summary',
      'tagTable.note': 'A task with several tags is counted under each of them',
      'refresh': 'Refresh',
      'error': 'Failed to load',
      'hud.input': 'Typing',
      'hud.read': 'Reading',
      'hud.title': 'Today {total} — click for statistics',
    }

    /* ------------------------------------------------------------------ */
    /* Engagement tracker                                                  */
    /* ------------------------------------------------------------------ */

    function createTracker(options) {
      const inputIdle = options.inputIdleMs
      const readIdle = options.readIdleMs
      const windowId = (() => {
        try {
          const key = 'dsh-task-time-window'
          let id = window.sessionStorage.getItem(key)
          if (!id) {
            id = `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
            window.sessionStorage.setItem(key, id)
          }
          return id
        } catch {
          return Math.random().toString(36).slice(2)
        }
      })()

      let activeSession = null
      let segment = null
      let idleTimer = 0
      let flushTimer = 0
      let queue = []
      let pending = []
      const closedListeners = new Set()

      function notifyClosed() {
        for (const listener of closedListeners) {
          try {
            listener()
          } catch {
            /* a broken listener must not break tracking */
          }
        }
      }

      function pageVisible() {
        return document.visibilityState === 'visible' && document.hasFocus()
      }

      /** True when a node lives inside the message composer (either the slot or an editable). */
      function inComposer(target) {
        const element =
          target instanceof Element
            ? target
            : target instanceof Node
              ? target.parentElement
              : null
        if (element === null) return false
        if (element.closest('[data-slot="conversation.composer.bar"]')) return true
        return element.closest('textarea, [contenteditable="true"], [contenteditable=""]') !== null
      }

      function scheduleIdle() {
        if (idleTimer !== 0) window.clearTimeout(idleTimer)
        idleTimer = 0
        if (segment === null) return
        const limit = segment.channel === 'input' ? inputIdle : readIdle
        idleTimer = window.setTimeout(() => {
          idleTimer = 0
          if (segment !== null) closeSegment(segment.end)
        }, limit + 200)
      }

      function scheduleFlush() {
        if (flushTimer !== 0) return
        flushTimer = window.setTimeout(() => {
          flushTimer = 0
          flush(false)
        }, FLUSH_DELAY_MS)
      }

      function closeSegment(endAt) {
        if (idleTimer !== 0) {
          window.clearTimeout(idleTimer)
          idleTimer = 0
        }
        const current = segment
        segment = null
        if (current === null) return
        const end = Math.min(Math.max(endAt ?? current.end, current.start), current.end)
        // Too short to be real engagement: a quick keystroke or a glance at the page.
        const floor = current.channel === 'input' ? MIN_INPUT_MS : MIN_READ_MS
        if (end - current.start < floor) return
        const entry = { sid: current.sid, ch: current.channel, start: current.start, end, w: windowId }
        if (current.sid === null) {
          // Typing before the Session existed: hold it for adoption, never send
          // an interval without a session id.
          if (pending.length < 40) pending.push(entry)
          return
        }
        queue.push(entry)
        scheduleFlush()
        notifyClosed()
      }

      function flush(beacon) {
        if (flushTimer !== 0) {
          window.clearTimeout(flushTimer)
          flushTimer = 0
        }
        if (queue.length === 0) return
        const batch = queue
        queue = []
        const body = JSON.stringify({ intervals: batch })
        if (beacon && typeof navigator.sendBeacon === 'function') {
          try {
            const sent = navigator.sendBeacon(`${API}/ingest`, new Blob([body], { type: 'application/json' }))
            if (sent) return
          } catch {
            /* fall through to fetch */
          }
        }
        try {
          void fetch(`${API}/ingest`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
            keepalive: true,
          }).catch(() => {})
        } catch {
          /* offline: the batch is dropped */
        }
      }

      function stamp(channel) {
        if (!pageVisible()) return
        // Before a Session exists (the new-task hero) only typing is measured;
        // those segments are adopted by the Session once it is created.
        if (activeSession === null && channel !== 'input') return
        const now = Date.now()
        if (segment !== null && segment.channel !== channel) closeSegment(segment.end)
        if (segment === null) segment = { sid: activeSession, channel, start: now, end: now }
        else segment.end = now
        scheduleIdle()
      }

      /**
       * Ambient movement keeps a reading segment alive without switching the
       * channel. It never extends a typing segment: only real keystrokes may
       * grow typing time, and mouse drift must not end a typing burst either.
       */
      function stampAmbient() {
        if (activeSession === null || !pageVisible()) return
        // Ambient signals never start a segment: auto-scrolling output or mouse
        // drift must not create reading time on its own.
        if (segment === null) return
        if (segment.channel !== 'read') return
        segment.end = Date.now()
        scheduleIdle()
      }

      let lastMoveAt = 0
      /*
       * Channel policy (deliberately narrow, matching the requested rules):
       *  - typing events inside the composer keep ONE typing segment running;
       *  - only a wheel, a click, or a touch interrupts it (anything clicked
       *    inside the composer continues typing);
       *  - scroll, caret movement, selection, and pointer movement are ambient:
       *    they extend an open reading segment but never switch channels, so
       *    auto-scrolling output and caret moves cannot chop a typing burst.
       */
      const onKey = (event) => {
        if (event.isComposing) return
        if (inComposer(event.target)) stamp('input')
        else stampAmbient()
      }
      const onInputEvent = (event) => {
        if (inComposer(event.target)) stamp('input')
        else stampAmbient()
      }
      const onPointerDown = (event) => {
        if (inComposer(event.target)) {
          // Clicking into the composer ends reading, but the typing clock starts
          // on the first keystroke, not on the click that precedes it.
          if (segment !== null && segment.channel === 'read') closeSegment(segment.end)
          return
        }
        stamp('read')
      }
      const onWheel = () => {
        stamp('read')
      }
      const onTouchStart = (event) => {
        if (inComposer(event.target)) {
          if (segment !== null && segment.channel === 'read') closeSegment(segment.end)
          return
        }
        stamp('read')
      }
      const onPointerMove = () => {
        const now = Date.now()
        if (now - lastMoveAt < 400) return
        lastMoveAt = now
        stampAmbient()
      }
      const onScroll = () => {
        stampAmbient()
      }
      const onSelection = () => {
        const selection = document.getSelection()
        const anchor = selection === null ? null : selection.anchorNode
        if (anchor !== null && inComposer(anchor)) return
        stampAmbient()
      }
      const onVisibility = () => {
        if (document.visibilityState !== 'visible') {
          closeSegment(segment === null ? undefined : segment.end)
          flush(true)
        }
      }
      const onBlur = () => {
        closeSegment(segment === null ? undefined : segment.end)
        flush(true)
      }
      const onPageHide = () => {
        closeSegment(segment === null ? undefined : segment.end)
        flush(true)
      }

      const disposers = []
      function listen() {
        const add = (target, type, listener, opts) => {
          target.addEventListener(type, listener, opts)
          disposers.push(() => target.removeEventListener(type, listener, opts))
        }
        add(document, 'keydown', onKey, { capture: true, passive: true })
        add(document, 'beforeinput', onInputEvent, { capture: true, passive: true })
        add(document, 'input', onInputEvent, { capture: true, passive: true })
        add(document, 'compositionupdate', onInputEvent, { capture: true, passive: true })
        add(document, 'paste', onInputEvent, { capture: true, passive: true })
        add(document, 'pointerdown', onPointerDown, { capture: true, passive: true })
        add(document, 'pointermove', onPointerMove, { capture: true, passive: true })
        add(document, 'wheel', onWheel, { capture: true, passive: true })
        add(document, 'scroll', onScroll, { capture: true, passive: true })
        add(document, 'touchstart', onTouchStart, { capture: true, passive: true })
        add(document, 'selectionchange', onSelection, { passive: true })
        add(document, 'visibilitychange', onVisibility, { passive: true })
        add(window, 'blur', onBlur, { passive: true })
        add(window, 'pagehide', onPageHide, { passive: true })
      }

      function enter(sessionId) {
        if (typeof sessionId !== 'string' || sessionId.length === 0) return
        if (activeSession !== null && activeSession !== sessionId) {
          closeSegment(segment === null ? undefined : segment.end)
          flush(true)
        }
        activeSession = sessionId
        // A draft typed on the hero belongs to the Session that now appeared.
        if (segment !== null && segment.sid === null) segment.sid = sessionId
        if (pending.length > 0) {
          const cutoff = Date.now() - 10 * 60 * 1000
          const adopted = pending.filter((entry) => entry.end >= cutoff)
          pending = []
          if (adopted.length > 0) {
            for (const entry of adopted) {
              entry.sid = sessionId
              queue.push(entry)
            }
            scheduleFlush()
          }
        }
      }

      function leave(sessionId) {
        if (activeSession !== sessionId) return
        closeSegment(segment === null ? undefined : segment.end)
        flush(true)
        activeSession = null
      }

      listen()

      return {
        enter,
        leave,
        /** The still-open segment of one session, so a live chip can include it. */
        live(sessionId) {
          if (segment === null || segment.sid !== sessionId) return null
          // Tick continuously while the segment is open; the idle timer decides
          // where it really ends, so the chip never has to jump on the next event.
          return { channel: segment.channel, ms: Math.max(0, Date.now() - segment.start) }
        },
        /** Subscribe to "a segment just closed", so a chip can refetch right away. */
        subscribeClosed(listener) {
          closedListeners.add(listener)
          return () => closedListeners.delete(listener)
        },
        dispose() {
          for (const dispose of disposers) dispose()
          if (idleTimer !== 0) window.clearTimeout(idleTimer)
          closeSegment(segment === null ? undefined : segment.end)
          flush(true)
        },
      }
    }

    /* ------------------------------------------------------------------ */
    /* Panel                                                               */
    /* ------------------------------------------------------------------ */

    function fmtDuration(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 1000) return '—'
      const total = Math.floor(ms / 1000)
      const hours = Math.floor(total / 3600)
      const minutes = Math.floor((total % 3600) / 60)
      const seconds = total % 60
      if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`
      if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`
      return `${seconds}s`
    }

    function fmtTime(ms) {
      if (typeof ms !== 'number' || ms <= 0) return '—'
      const date = new Date(ms)
      const pad = (value) => String(value).padStart(2, '0')
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function rangeStart(mode) {
      if (mode === 'today') {
        const now = new Date()
        now.setHours(0, 0, 0, 0)
        return now.getTime()
      }
      if (mode === '7d') return Date.now() - 7 * 86400000
      if (mode === '30d') return Date.now() - 30 * 86400000
      return 0
    }

    function useUsageState(t) {
      const [range, setRange] = React.useState('today')
      const [group, setGroup] = React.useState('tag')
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState('')

      const reload = React.useCallback(
        async (nextRange) => {
          try {
            const response = await fetch(`${API}/state?from=${rangeStart(nextRange)}&to=${Date.now()}`, {
              cache: 'no-store',
            })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const data = await response.json()
            setState(data)
            setError('')
          } catch (cause) {
            setError(`${t('error')}: ${String(cause && cause.message ? cause.message : cause)}`)
          }
        },
        [t],
      )

      React.useEffect(() => {
        void reload(range)
        const timer = window.setInterval(() => {
          if (document.visibilityState === 'visible') void reload(range)
        }, 15000)
        return () => window.clearInterval(timer)
      }, [range, reload])

      return { range, setRange, group, setGroup, state, error, reload }
    }

    function StatCard(props) {
      return h(
        'div',
        { className: 'tt-card' },
        h('div', { className: 'k' }, props.label),
        h('div', { className: 'v' }, props.value),
      )
    }

    function TagEditor(props) {
      const t = props.t
      const [selected, setSelected] = React.useState(props.tags)
      const [draft, setDraft] = React.useState('')

      const options = React.useMemo(() => {
        const set = new Set()
        for (const tag of props.knownTags || []) set.add(tag)
        for (const tag of props.tags) set.add(tag)
        for (const tag of selected) set.add(tag)
        return [...set]
      }, [props.knownTags, props.tags, selected])

      const toggle = (tag) => {
        setSelected((current) =>
          current.includes(tag) ? current.filter((item) => item !== tag) : [...current, tag],
        )
      }
      const commitDraft = () => {
        const value = draft.trim()
        if (value === '') return
        setSelected((current) => (current.includes(value) ? current : [...current, value]))
        setDraft('')
      }
      const save = () => {
        props.onSave(selected.map((item) => item.trim()).filter((item) => item.length > 0))
      }

      return h(
        'div',
        { className: 'tt-editor' },
        h(
          'div',
          { className: 'tt-editor-card' },
          options.length === 0
            ? null
            : h(
                'div',
                { className: 'tt-pool' },
                options.map((tag) =>
                  h(
                    'button',
                    {
                      key: tag,
                      type: 'button',
                      className: selected.includes(tag) ? 'tt-chip on' : 'tt-chip',
                      onClick: () => toggle(tag),
                    },
                    tag,
                  ),
                ),
              ),
          h(
            'div',
            { className: 'tt-editor-row' },
            h('input', {
              className: 'tt-input',
              value: draft,
              placeholder: t('tag.new'),
              onChange: (event) => setDraft(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  if (draft.trim() !== '') commitDraft()
                  else save()
                }
                if (event.key === 'Escape') props.onCancel()
              },
            }),
            h('button', { type: 'button', className: 'tt-mini', onClick: commitDraft }, t('tag.add')),
            h('button', { type: 'button', className: 'tt-mini', onClick: save }, t('row.save')),
            h('button', { type: 'button', className: 'tt-mini', onClick: props.onCancel }, t('row.cancel')),
          ),
        ),
      )
    }

    function TaskTable(props) {
      const { t, rows, editing, onEdit, onCancel, onSave, knownTags } = props
      const sum = rows.reduce((total, row) => total + row.totalMs, 0)
      return h(
        'table',
        { className: 'tt' },
        h(
          'colgroup',
          null,
          h('col', { key: 'name' }),
          h('col', { key: 'tags', style: { width: '196px' } }),
          h('col', { key: 'input', style: { width: '88px' } }),
          h('col', { key: 'read', style: { width: '88px' } }),
          h('col', { key: 'total', style: { width: '96px' } }),
          h('col', { key: 'share', style: { width: '132px' } }),
          h('col', { key: 'last', style: { width: '96px' } }),
        ),
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            h('th', null, t('col.name')),
            h('th', null, t('col.tags')),
            h('th', { className: 'num' }, t('col.input')),
            h('th', { className: 'num' }, t('col.read')),
            h('th', { className: 'num' }, t('col.total')),
            h('th', null, t('col.share')),
            h('th', { className: 'num' }, t('col.last')),
          ),
        ),
        h(
          'tbody',
          null,
          rows.map((row) => {
            const share = sum > 0 ? row.totalMs / sum : 0
            const width = Math.max(2, Math.round(share * 100))
            return h(
              'tr',
              { key: row.sid },
              h(
                'td',
                { className: 'cell-name' },
                h('div', { className: 'tt-name', title: `${row.title || row.sid}\n${row.sid}` }, row.title || row.sid.slice(0, 12)),
                row.project ? h('div', { className: 'tt-sub' }, row.project) : null,
              ),
              h(
                'td',
                { className: 'cell-tags' },
                editing === row.sid
                  ? h(TagEditor, {
                      t,
                      tags: row.tags,
                      knownTags,
                      onSave: (tags) => onSave(row.sid, tags),
                      onCancel,
                    })
                  : h(
                      'div',
                      { className: 'tt-tags' },
                      row.tags.length === 0
                        ? h('span', { className: 'tt-chip muted' }, t('untagged'))
                        : row.tags.map((tag) => h('span', { key: tag, className: 'tt-chip' }, tag)),
                      h(
                        'button',
                        { type: 'button', className: 'tt-mini', onClick: () => onEdit(row.sid) },
                        t('row.edit'),
                      ),
                    ),
              ),
              h('td', { className: 'num' }, fmtDuration(row.inputMs)),
              h('td', { className: 'num' }, fmtDuration(row.readMs)),
              h('td', { className: 'num strong' }, fmtDuration(row.totalMs)),
              h(
                'td',
                { className: 'cell-share' },
                h(
                  'div',
                  { className: 'tt-share' },
                  h('div', { className: 'tt-bar' }, h('i', { style: { width: `${width}%` } })),
                  h('span', { className: 'tt-pct' }, `${Math.round(share * 100)}%`),
                ),
              ),
              h('td', { className: 'num dim' }, fmtTime(row.last)),
            )
          }),
        ),
      )
    }

    /** Rollup of every tag: how much time each one owns, and across how many tasks. */
    function TagSummary(props) {
      const { t, rows } = props
      const untagged = t('untagged')
      const buckets = new Map()
      for (const row of rows) {
        const keys = row.tags.length > 0 ? row.tags : [untagged]
        for (const key of keys) {
          let bucket = buckets.get(key)
          if (bucket === undefined) {
            bucket = { key, tasks: 0, inputMs: 0, readMs: 0, totalMs: 0 }
            buckets.set(key, bucket)
          }
          bucket.tasks += 1
          bucket.inputMs += row.inputMs
          bucket.readMs += row.readMs
          bucket.totalMs += row.totalMs
        }
      }
      const list = [...buckets.values()].sort((x, y) => y.totalMs - x.totalMs)
      if (list.length === 0) return null
      const sum = list.reduce((total, bucket) => total + bucket.totalMs, 0)
      return h(
        'div',
        { className: 'tt-section' },
        h('div', { className: 'tt-group' }, t('tagTable.title'), h('span', { className: 'n' }, t('tagTable.note'))),
        h(
          'table',
          { className: 'tt' },
          h(
            'colgroup',
            null,
            h('col', { key: 'tag' }),
            h('col', { key: 'tasks', style: { width: '84px' } }),
            h('col', { key: 'input', style: { width: '88px' } }),
            h('col', { key: 'read', style: { width: '88px' } }),
            h('col', { key: 'total', style: { width: '96px' } }),
            h('col', { key: 'share', style: { width: '168px' } }),
          ),
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              h('th', null, t('col.tags')),
              h('th', { className: 'num' }, t('col.tasks')),
              h('th', { className: 'num' }, t('col.input')),
              h('th', { className: 'num' }, t('col.read')),
              h('th', { className: 'num' }, t('col.total')),
              h('th', null, t('col.share')),
            ),
          ),
          h(
            'tbody',
            null,
            list.map((bucket) => {
              const share = sum > 0 ? bucket.totalMs / sum : 0
              return h(
                'tr',
                { key: bucket.key },
                h('td', null, h('span', { className: 'tt-chip' }, bucket.key)),
                h('td', { className: 'num' }, String(bucket.tasks)),
                h('td', { className: 'num' }, fmtDuration(bucket.inputMs)),
                h('td', { className: 'num' }, fmtDuration(bucket.readMs)),
                h('td', { className: 'num strong' }, fmtDuration(bucket.totalMs)),
                h(
                  'td',
                  null,
                  h(
                    'div',
                    { className: 'tt-share' },
                    h(
                      'div',
                      { className: 'tt-bar' },
                      h('i', { style: { width: `${Math.max(2, Math.round(share * 100))}%` } }),
                    ),
                    h('span', { className: 'tt-pct' }, `${Math.round(share * 100)}%`),
                  ),
                ),
              )
            }),
          ),
        ),
      )
    }

    function fmtClock(ms) {
      const date = new Date(ms)
      const pad = (value) => String(value).padStart(2, '0')
      return `${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function dayKey(ms) {
      const date = new Date(ms)
      const pad = (value) => String(value).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    }

    function dayLabel(ms, t) {
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      const yesterday = today.getTime() - 86400000
      const key = dayKey(ms)
      if (key === dayKey(today.getTime())) return t('log.today')
      if (key === dayKey(yesterday)) return t('log.yesterday')
      const date = new Date(ms)
      const pad = (value) => String(value).padStart(2, '0')
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    }

    function useUsageLog(t, range, enabled) {
      const [log, setLog] = React.useState(null)
      const reload = React.useCallback(
        async (nextRange) => {
          try {
            const response = await fetch(`${API}/log?from=${rangeStart(nextRange)}&to=${Date.now()}`, {
              cache: 'no-store',
            })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            setLog(await response.json())
          } catch {
            /* keep the previous table, the next refresh retries */
          }
        },
        [],
      )

      React.useEffect(() => {
        if (!enabled) return undefined
        void reload(range)
        const timer = window.setInterval(() => {
          if (document.visibilityState === 'visible') void reload(range)
        }, 15000)
        return () => window.clearInterval(timer)
      }, [enabled, range, reload])

      return log
    }

    /** Usage log: one row per "sat down with this task" block. */
    function UsageLog(props) {
      const { t, log } = props
      const visits = log === null ? [] : log.visits
      if (visits.length === 0) return h('div', { className: 'tt-empty' }, t('log.empty'))

      const groups = new Map()
      for (const visit of visits) {
        const key = dayKey(visit.start)
        let bucket = groups.get(key)
        if (bucket === undefined) {
          bucket = { key, start: visit.start, visits: [], totalMs: 0 }
          groups.set(key, bucket)
        }
        bucket.visits.push(visit)
        bucket.totalMs += visit.totalMs
      }
      const days = [...groups.values()].sort((x, y) => y.start - x.start)

      return days.map((day) =>
        h(
          'div',
          { key: day.key },
          h(
            'div',
            { className: 'tt-group' },
            dayLabel(day.start, t),
            h('span', { className: 'n' }, fmtDuration(day.totalMs)),
          ),
          h(
            'table',
            { className: 'tt' },
            h(
              'colgroup',
              null,
              h('col', { key: 'time', style: { width: '132px' } }),
              h('col', { key: 'duration', style: { width: '88px' } }),
              h('col', { key: 'task' }),
              h('col', { key: 'tags', style: { width: '188px' } }),
              h('col', { key: 'input', style: { width: '84px' } }),
              h('col', { key: 'read', style: { width: '84px' } }),
            ),
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                h('th', null, t('col.time')),
                h('th', { className: 'num' }, t('col.duration')),
                h('th', null, t('col.name')),
                h('th', null, t('col.tags')),
                h('th', { className: 'num' }, t('col.input')),
                h('th', { className: 'num' }, t('col.read')),
              ),
            ),
            h(
              'tbody',
              null,
              day.visits.map((visit) =>
                h(
                  'tr',
                  { key: `${visit.sid}-${visit.start}` },
                  h('td', { className: 'tt-time' }, `${fmtClock(visit.start)} – ${fmtClock(visit.end)}`),
                  h('td', { className: 'num strong' }, fmtDuration(visit.totalMs)),
                  h(
                    'td',
                    { className: 'cell-name' },
                    h(
                      'div',
                      { className: 'tt-name', title: `${visit.title || visit.sid}\n${visit.sid}` },
                      visit.title || visit.sid.slice(0, 12),
                    ),
                    visit.project ? h('div', { className: 'tt-sub' }, visit.project) : null,
                  ),
                  h(
                    'td',
                    { className: 'cell-tags' },
                    h(
                      'div',
                      { className: 'tt-tags' },
                      visit.tags.length === 0
                        ? h('span', { className: 'tt-chip muted' }, t('untagged'))
                        : visit.tags.map((tag) => h('span', { key: tag, className: 'tt-chip' }, tag)),
                    ),
                  ),
                  h('td', { className: 'num' }, fmtDuration(visit.inputMs)),
                  h('td', { className: 'num' }, fmtDuration(visit.readMs)),
                ),
              ),
            ),
          ),
        ),
      )
    }

    function UsagePanel(props) {
      const t = props.t
      const { range, setRange, group, setGroup, state, error, reload } = useUsageState(t)
      const [editing, setEditing] = React.useState(null)
      const [view, setView] = React.useState('stats')
      const log = useUsageLog(t, range, view === 'log')

      const saveTags = async (sid, tags) => {
        try {
          await fetch(`${API}/tag`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sid, tags }),
          })
        } catch {
          /* keep the panel alive; the next refresh shows the persisted value */
        }
        setEditing(null)
        void reload(range)
      }

      const ranges = [
        ['today', 'range.today'],
        ['7d', 'range.7d'],
        ['30d', 'range.30d'],
        ['all', 'range.all'],
      ]
      const groups = [
        ['tag', 'group.tag'],
        ['task', 'group.task'],
        ['project', 'group.project'],
      ]

      const rows = state === null ? [] : state.rows.filter((row) => row.totalMs >= 1000)
      const knownTags = state === null ? [] : state.knownTags || []
      const totalMs = rows.reduce((sum, row) => sum + row.totalMs, 0)
      const inputMs = rows.reduce((sum, row) => sum + row.inputMs, 0)
      const readMs = rows.reduce((sum, row) => sum + row.readMs, 0)
      const maxTotal = rows.reduce((max, row) => Math.max(max, row.totalMs), 0)

      let sections = []
      if (rows.length > 0) {
        if (group === 'task') {
          sections = [{ key: 'all', label: '', rows, totalMs }]
        } else {
          const map = new Map()
          for (const row of rows) {
            const key =
              group === 'tag'
                ? row.tags[0] || t('untagged')
                : row.project || t('unknownProject')
            let bucket = map.get(key)
            if (bucket === undefined) {
              bucket = { key, label: key, rows: [], totalMs: 0 }
              map.set(key, bucket)
            }
            bucket.rows.push(row)
            bucket.totalMs += row.totalMs
          }
          sections = [...map.values()].sort((x, y) => y.totalMs - x.totalMs)
        }
      }

      const inputIdle = state === null ? INPUT_IDLE_FALLBACK : state.inputIdleMs || INPUT_IDLE_FALLBACK
      const readIdle = state === null ? READ_IDLE_FALLBACK : state.readIdleMs || READ_IDLE_FALLBACK

      return h(
        'div',
        { className: 'tt-root' },
        h('style', { key: 'tt-css' }, props.css),
        h(
          'div',
          { className: 'tt-head' },
          h(
            'div',
            { className: 'tt-heading' },
            h('div', { className: 'tt-title' }, t('panel.title')),
            h('div', { className: 'tt-sub' }, t('panel.subtitle')),
          ),
          h(
            'div',
            { className: 'tt-seg' },
            [
              ['stats', 'view.stats'],
              ['log', 'view.log'],
            ].map(([value, key]) =>
              h(
                'button',
                {
                  key: value,
                  type: 'button',
                  className: view === value ? 'on' : '',
                  onClick: () => setView(value),
                },
                t(key),
              ),
            ),
          ),
          h(
            'div',
            { className: 'tt-seg' },
            ranges.map(([value, key]) =>
              h(
                'button',
                {
                  key: value,
                  type: 'button',
                  className: range === value ? 'on' : '',
                  onClick: () => setRange(value),
                },
                t(key),
              ),
            ),
          ),
          view === 'stats' ? h(
            'div',
            { className: 'tt-seg' },
            groups.map(([value, key]) =>
              h(
                'button',
                {
                  key: value,
                  type: 'button',
                  className: group === value ? 'on' : '',
                  onClick: () => setGroup(value),
                },
                t(key),
              ),
            ),
          ) : null,
          h(
            'button',
            { type: 'button', className: 'tt-mini', onClick: () => void reload(range) },
            t('refresh'),
          ),
        ),
        view === 'stats' && error !== '' ? h('div', { className: 'tt-err' }, error) : null,
        view === 'stats'
          ? h(
              'div',
              { className: 'tt-cards' },
              h(StatCard, { label: t('card.total'), value: fmtDuration(totalMs) }),
              h(StatCard, { label: t('card.input'), value: fmtDuration(inputMs) }),
              h(StatCard, { label: t('card.read'), value: fmtDuration(readMs) }),
              h(StatCard, { label: t('card.tasks'), value: String(rows.length) }),
            )
          : null,
        view === 'log'
          ? h(UsageLog, { t, log })
          : rows.length === 0
            ? h('div', { className: 'tt-empty' }, t('empty'))
          : [
              h(TagSummary, { key: 'tag-summary', t, rows }),
              ...sections.map((section) =>
                h(
                  'div',
                  { key: section.key },
                  section.label === ''
                    ? null
                    : h(
                        'div',
                        { className: 'tt-group' },
                        section.label,
                        h('span', { className: 'n' }, fmtDuration(section.totalMs)),
                      ),
                  h(TaskTable, {
                    t,
                    rows: section.rows,
                    knownTags,
                    editing,
                    onEdit: setEditing,
                    onCancel: () => setEditing(null),
                    onSave: saveTags,
                  }),
                ),
              ),
            ],
        h(
          'div',
          { className: 'tt-note' },
          h(
            'div',
            null,
            t('note.rule', { i: Math.round(inputIdle / 60000), r: Math.round(readIdle / 60000) }),
          ),
          h('div', null, t('note.tag')),
          h('div', null, t('note.data')),
          view === 'log' ? h('div', null, t('log.gap')) : null,
        ),
      )
    }

    function todayStart() {
      const start = new Date()
      start.setHours(0, 0, 0, 0)
      return start.getTime()
    }

    /** Always-visible chip in the conversation header: today's time for this task. */
    function SessionHud(props) {
      const sessionId = props.sessionId
      const t = props.t
      const tracker = props.tracker
      const [totals, setTotals] = React.useState(null)
      const [, setBeat] = React.useState(0)

      React.useEffect(() => {
        if (typeof sessionId !== 'string') return undefined
        let alive = true
        const poll = async () => {
          if (document.visibilityState !== 'visible') return
          try {
            const response = await fetch(
              `${API}/session?sid=${encodeURIComponent(sessionId)}&from=${todayStart()}&to=${Date.now()}`,
              { cache: 'no-store' },
            )
            if (!response.ok) return
            const data = await response.json()
            if (alive) setTotals(data)
          } catch {
            /* transient */
          }
        }
        void poll()
        const pollTimer = window.setInterval(poll, 5000)
        const beatTimer = window.setInterval(() => {
          if (alive) setBeat((value) => (value + 1) % 1000000)
        }, 1000)
        let refreshTimer = 0
        const unsubscribe =
          typeof tracker?.subscribeClosed === 'function'
            ? tracker.subscribeClosed(() => {
                if (refreshTimer !== 0) window.clearTimeout(refreshTimer)
                refreshTimer = window.setTimeout(() => {
                  refreshTimer = 0
                  void poll()
                }, 700)
              })
            : () => {}
        const onVisibility = () => {
          if (document.visibilityState === 'visible') void poll()
        }
        document.addEventListener('visibilitychange', onVisibility)
        return () => {
          alive = false
          window.clearInterval(pollTimer)
          window.clearInterval(beatTimer)
          if (refreshTimer !== 0) window.clearTimeout(refreshTimer)
          unsubscribe()
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [sessionId, tracker])

      const live = typeof tracker?.live === 'function' ? tracker.live(sessionId) : null
      const inputMs = (totals === null ? 0 : totals.inputMs) + (live !== null && live.channel === 'input' ? live.ms : 0)
      const readMs = (totals === null ? 0 : totals.readMs) + (live !== null && live.channel === 'read' ? live.ms : 0)
      const totalMs = inputMs + readMs

      if (totalMs < 30000) return null
      return h(
        'button',
        {
          type: 'button',
          title: t('hud.title', { total: fmtDuration(totalMs) }),
          onClick: props.onOpen,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            height: '24px',
            padding: '0 8px',
            border: '1px solid var(--dsw-alias-border-l1)',
            borderRadius: '999px',
            background: 'var(--dsw-alias-bg-layer-1)',
            color: 'var(--dsw-alias-label-secondary)',
            font: 'inherit',
            fontSize: '11px',
            fontVariantNumeric: 'tabular-nums',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          },
        },
        h(ClockIcon, { size: 12 }),
        live === null
          ? null
          : h('span', {
              style: { color: 'var(--dsw-alias-brand-primary)', fontSize: '9px', lineHeight: '1' },
              'aria-hidden': true,
            }, '●'),
        h(
          'span',
          null,
          `${t('hud.input')} ${fmtDuration(inputMs)} · ${t('hud.read')} ${fmtDuration(readMs)}`,
        ),
      )
    }

    function ClockIcon(props) {
      const size = typeof props.size === 'number' ? props.size : 18
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('circle', { cx: 12, cy: 12, r: 8.4 }),
        h('path', { d: 'M12 7.6V12l3 1.9' }),
      )
    }

    function SessionTracker(props) {
      const sessionId = props.sessionId
      const tracker = props.tracker
      React.useEffect(() => {
        if (typeof sessionId !== 'string') return undefined
        tracker.enter(sessionId)
        return () => tracker.leave(sessionId)
      }, [sessionId, tracker])
      return null
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const locale = ctx.get('locale')
        if (locale !== undefined && locale !== null) {
          ctx.effect(() => locale.register(NS, { zh, en }), 'task-time: dictionaries')
        }
        const translate = (key, params) => {
          const dict = locale !== undefined && locale !== null ? locale.bind(NS) : null
          const raw = dict !== null ? dict(key, params) : (zh[key] ?? key)
          if (params === undefined) return raw
          return String(raw).replace(/\{(\w+)\}/g, (match, name) =>
            Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
          )
        }

        const tracker = createTracker({
          inputIdleMs: INPUT_IDLE_FALLBACK,
          readIdleMs: READ_IDLE_FALLBACK,
        })
        ctx.effect(() => () => tracker.dispose(), 'task-time: tracker')

        const css = `
          .tt-root { box-sizing:border-box; height:100%; overflow:auto; padding:20px 24px 48px; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font-size:13px; }
          .tt-head { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:16px; }
          .tt-heading { margin-right:auto; }
          .tt-title { font-size:16px; font-weight:600; }
          .tt-sub { color:var(--dsw-alias-label-secondary); font-size:12px; margin-top:2px; }
          .tt-seg { display:inline-flex; border:1px solid var(--dsw-alias-border-l1); border-radius:8px; overflow:hidden; background:var(--dsw-alias-bg-layer-1); }
          .tt-seg button { background:transparent; color:var(--dsw-alias-label-secondary); border:0; padding:5px 10px; cursor:pointer; font:inherit; }
          .tt-seg button.on { background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); }
          .tt-cards { display:grid; grid-template-columns:repeat(4,minmax(120px,1fr)); gap:10px; margin-bottom:16px; }
          .tt-card { border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); border-radius:10px; padding:10px 12px; }
          .tt-card .k { color:var(--dsw-alias-label-secondary); font-size:12px; }
          .tt-card .v { font-size:20px; font-weight:600; margin-top:4px; font-variant-numeric:tabular-nums; }
          .tt-group { margin:22px 0 8px; font-weight:600; display:flex; gap:8px; align-items:baseline; }
          .tt-section { margin-bottom:8px; }
          .tt-group .n { color:var(--dsw-alias-label-secondary); font-weight:400; font-size:12px; }
          table.tt { width:100%; border-collapse:collapse; table-layout:fixed; }
          table.tt th { position:sticky; top:0; z-index:1; background:var(--dsw-alias-bg-base); text-align:left; font-weight:500; color:var(--dsw-alias-label-secondary); font-size:12px; padding:8px 10px; border-bottom:1px solid var(--dsw-alias-border-l2); }
          table.tt td { padding:9px 10px; border-bottom:1px solid var(--dsw-alias-border-l1); vertical-align:middle; }
          table.tt th.num, table.tt td.num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
          table.tt tbody tr:hover td { background:var(--dsw-alias-bg-layer-1); }
          table.tt td.strong { font-weight:600; }
          table.tt td.dim { color:var(--dsw-alias-label-secondary); font-size:12px; }
          .tt-name { font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
          .tt-sub { color:var(--dsw-alias-label-secondary); font-size:11px; margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
          .tt-share { display:flex; align-items:center; gap:8px; }
          .tt-bar { flex:1 1 auto; height:6px; border-radius:3px; background:var(--dsw-alias-bg-layer-2); overflow:hidden; min-width:52px; }
          .tt-bar i { display:block; height:100%; background:var(--dsw-alias-brand-primary); }
          .tt-pct { flex:0 0 36px; text-align:right; font-size:11px; color:var(--dsw-alias-label-secondary); font-variant-numeric:tabular-nums; }
          .tt-time { font-variant-numeric:tabular-nums; white-space:nowrap; color:var(--dsw-alias-label-secondary); }
          .tt-tags { display:flex; flex-wrap:wrap; align-items:center; gap:4px; }
          .tt-chip { display:inline-block; padding:1px 7px; border-radius:999px; background:var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l1); color:var(--dsw-alias-label-secondary); font-size:11px; white-space:nowrap; font:inherit; font-size:11px; cursor:default; }
          .tt-chip.on { color:var(--dsw-alias-label-primary); border-color:var(--dsw-alias-brand-primary); background:var(--dsw-alias-bg-layer-1); }
          button.tt-chip { cursor:pointer; }
          .tt-chip.muted { opacity:.55; }
          .tt-mini { background:transparent; border:0; color:var(--dsw-alias-brand-primary); cursor:pointer; font:inherit; padding:0 2px; }
          .tt-editor { position:relative; }
          .tt-editor-card { position:absolute; z-index:6; top:calc(100% + 4px); left:0; width:290px; padding:10px; border:1px solid var(--dsw-alias-border-l2); border-radius:10px; background:var(--dsw-alias-bg-overlay); box-shadow:0 10px 28px rgba(0,0,0,.18); display:flex; flex-direction:column; gap:8px; }
          .tt-pool { display:flex; flex-wrap:wrap; gap:4px; max-height:140px; overflow:auto; }
          .tt-editor-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
          .tt-input { background:var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l2); border-radius:6px; color:var(--dsw-alias-label-primary); padding:4px 6px; font:inherit; width:130px; }
          .tt-empty { color:var(--dsw-alias-label-secondary); padding:48px 8px; text-align:center; }
          .tt-note { margin-top:22px; color:var(--dsw-alias-label-secondary); font-size:12px; line-height:1.8; }
          .tt-err { color:var(--dsw-alias-state-error-primary); margin:8px 0; }
        `

        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 60,
              label: () => translate('panel.title'),
            },
            ClockIcon,
          ),
        )

        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: PANEL_ID,
            },
            function TaskTimePanel() {
              return h(UsagePanel, { t: translate, css })
            },
          ),
        )

        const openPanel = () => {
          try {
            const layout = ctx.get('layout')
            if (layout !== undefined && layout !== null && typeof layout.selectPanel === 'function') {
              layout.selectPanel(PANEL_ID)
            }
          } catch {
            /* the panel may be unavailable in another composition */
          }
        }

        ctx.slots.inject('conversation.session.header.utilities', () =>
          ctx.slots.register(
            {
              name: 'conversation.session.header.utilities',
              id: 'task-time-hud',
              order: 80,
              inject: (sessionId) => ({ sessionId }),
            },
            function TaskTimeHud(props) {
              return h(SessionHud, {
                sessionId: props.sessionId,
                t: translate,
                tracker,
                onOpen: openPanel,
              })
            },
          ),
        )

        ctx.slots.inject('conversation.session.header.utilities', () =>
          ctx.slots.register(
            {
              name: 'conversation.session.header.utilities',
              id: 'task-time-tracker',
              order: 90,
              inject: (sessionId) => ({ sessionId }),
            },
            function TaskTimeTracker(props) {
              return h(SessionTracker, { sessionId: props.sessionId, tracker })
            },
          ),
        )
      },
    }
  },
})
