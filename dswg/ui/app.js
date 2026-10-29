/**
 * DeepSeek Web Gateway — admin dashboard.
 *
 * Vanilla ES module, no dependencies: one `api()` helper, one store, a render
 * function per view, delegated events, and `init()` as the only entry point.
 * Every request is wrapped so failures surface as a toast or an in-place
 * retry state rather than an unhandled rejection.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOKEN_KEY = 'dswgAdminToken'
const THEME_KEY = 'dswgTheme'
const CAPTURE_POLL_MS = 1500
const DEFAULT_CAPTURE_TIMEOUT_MS = 900000
const ROUTES = ['overview', 'accounts', 'keys', 'logs', 'settings']
const ROUTE_TITLES = { overview: 'Overview', accounts: 'Accounts', keys: 'API keys', logs: 'Logs', settings: 'Settings' }

const STATUS_LABEL = { active: 'Active', muted: 'Muted', reauth: 'Needs reauth', disabled: 'Disabled' }
const STATUS_TONE = { active: 'ok', muted: 'warn', reauth: 'info', disabled: 'muted' }

const CAPTURE_STEPS = [
  ['opening', 'Opening browser'],
  ['waiting', 'Waiting for sign-in'],
  ['detected', 'Sign-in detected'],
  ['verifying', 'Verifying account'],
  ['done', 'Connected'],
]

const PHASE_TEXT = {
  idle: 'Starting…',
  opening: 'Opening browser…',
  waiting: 'Waiting for sign-in…',
  detected: 'Sign-in detected…',
  verifying: 'Verifying account…',
  done: 'Connected',
  failed: 'Capture failed',
}

const ICON_PATHS = {
  copy: '<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const numberFormat = new Intl.NumberFormat()
const compactFormat = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })

/** Clock time for a log row. */
function fmtTime(ts) {
  const date = new Date(Number(ts) || 0)
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/** Escape a value for HTML text and double-quoted attributes. */
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
}

/** Inline SVG icon from the shared path table. */
function icon(name, className = 'icon') {
  return `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] ?? ''}</svg>`
}

/** Coerce to a finite number, falling back to `fallback`. */
function toNumber(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function fmtNum(value) {
  return numberFormat.format(toNumber(value))
}

function fmtCompact(value) {
  return compactFormat.format(toNumber(value))
}

function fmtPercent(ratio) {
  const pct = ratio * 100
  if (pct === 0) return '0.0%'
  return pct < 1 ? `${pct.toFixed(2)}%` : `${pct.toFixed(1)}%`
}

function fmtMs(ms) {
  const value = toNumber(ms, -1)
  if (value < 0) return '—'
  if (value < 1000) return `${Math.round(value)} ms`
  if (value < 10000) return `${(value / 1000).toFixed(2)} s`
  if (value < 60000) return `${(value / 1000).toFixed(1)} s`
  return `${Math.floor(value / 60000)}m ${Math.round((value % 60000) / 1000)}s`
}

function fmtDuration(ms) {
  const total = Math.floor(toNumber(ms, -1) / 1000)
  if (total < 0) return '—'
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m`
  return `${total}s`
}

function fmtDateTime(ts) {
  const value = toNumber(ts, 0)
  if (!value) return ''
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function timeAgo(ts) {
  const value = toNumber(ts, 0)
  if (!value) return 'never'
  const seconds = Math.max(0, Math.round((Date.now() - value) / 1000))
  if (seconds < 10) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(value).toLocaleDateString(undefined, { dateStyle: 'medium' })
}

/** Short, stable id rendering for table cells. */
function shortId(id) {
  const text = String(id ?? '')
  if (!text) return '—'
  return text.length <= 13 ? text : `${text.slice(0, 8)}…${text.slice(-4)}`
}

/** "reauth" -> "Reauth", "upstream_timeout" -> "Upstream timeout". */
function humanize(value) {
  const text = String(value ?? '').replace(/[_-]+/g, ' ').trim()
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : 'Unknown'
}

/** `2026-10-24` -> `Oct 24`, parsed as a local date so the day never shifts. */
function fmtDay(day) {
  const parts = String(day ?? '').split('-').map(Number)
  if (parts.length === 3 && parts.every((part) => Number.isFinite(part))) {
    return new Date(parts[0], parts[1] - 1, parts[2]).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  }
  return String(day ?? '')
}

function readStorage(key) {
  try {
    return window.localStorage.getItem(key)
  } catch {
    // Storage can be blocked; the page still works without persistence.
    return null
  }
}

function writeStorage(key, value) {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Non-persistent is an acceptable degradation.
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const store = {
  token: '',
  theme: 'dark',
  route: '',
  authPrompt: false,
  busy: 0,
  data: { overview: null, accounts: null, keys: null },
}

const dom = {}

const captureRun = { accountId: null, timer: 0, active: false, failures: 0, idle: 0 }
const modalState = { onClose: null, cleanup: [] }

// ---------------------------------------------------------------------------
// API helper
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = details.status ?? 0
    this.code = details.code ?? null
    this.auth = Boolean(details.auth)
  }
}

/**
 * One JSON request against the gateway's admin API.
 * Adds the admin token, normalises the `{ error: { message, code } }` envelope,
 * and turns a 401 into the token prompt.
 */
async function api(path, options = {}) {
  const { method = 'GET', body, raw = false } = options
  const headers = { accept: raw ? 'image/png, application/octet-stream' : 'application/json' }
  if (store.token) headers['x-admin-token'] = store.token

  let payload
  if (body !== undefined) {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(body)
  }

  let response
  try {
    response = await fetch(path, { method, headers, body: payload, cache: 'no-store', credentials: 'same-origin' })
  } catch (error) {
    throw new ApiError(`Could not reach the gateway (${error?.message ?? 'network error'}).`)
  }

  if (response.status === 401) {
    showTokenBar()
    throw new ApiError('The gateway requires an admin token.', { status: 401, auth: true })
  }

  if (!response.ok) {
    const info = await readErrorBody(response)
    throw new ApiError(info.message, { status: response.status, code: info.code })
  }

  if (raw) return response.blob()
  if (response.status === 204) return null

  const text = await response.text()
  if (!text.trim()) return null
  try {
    return JSON.parse(text)
  } catch {
    throw new ApiError('The gateway sent a response that is not JSON.', { status: response.status })
  }
}

/** Read the documented error envelope, falling back to the raw body. */
async function readErrorBody(response) {
  const fallback = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`
  try {
    const text = await response.text()
    if (!text) return { message: fallback, code: null }
    try {
      const parsed = JSON.parse(text)
      const error = parsed?.error
      if (error && typeof error === 'object') return { message: String(error.message ?? fallback), code: error.code ?? null }
      if (typeof error === 'string') return { message: error, code: null }
      if (typeof parsed?.message === 'string') return { message: parsed.message, code: parsed.code ?? null }
    } catch {
      // Not JSON: report the body itself.
    }
    return { message: text.trim().slice(0, 300) || fallback, code: null }
  } catch {
    return { message: fallback, code: null }
  }
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

/**
 * Show a dismissible notice. `key` replaces an existing toast with the same key
 * so repeated 401s or copies do not stack.
 */
function toast(message, tone = 'info', options = {}) {
  if (!dom.toasts) return
  const key = options.key ?? null
  if (key) {
    const existing = dom.toasts.querySelector(`[data-key="${key}"]`)
    if (existing) existing.remove()
  }

  const node = document.createElement('div')
  node.className = `toast toast-${tone}`
  node.setAttribute('role', tone === 'error' ? 'alert' : 'status')
  if (key) node.dataset.key = key
  node.innerHTML = `
    <span class="toast-dot" aria-hidden="true"></span>
    <p class="toast-msg">${esc(message)}</p>
    <button type="button" class="toast-close" data-action="toast-close" aria-label="Dismiss notification">${icon('close')}</button>`

  dom.toasts.appendChild(node)
  while (dom.toasts.children.length > 4) dom.toasts.firstElementChild.remove()

  let timer = setTimeout(() => node.remove(), 6000)
  node.addEventListener('pointerenter', () => clearTimeout(timer))
  node.addEventListener('pointerleave', () => {
    timer = setTimeout(() => node.remove(), 2500)
  })
}

/** Surface a failed request: the token bar handles 401, everything else toasts. */
function reportError(error) {
  if (!error || error?.name === 'AbortError') return
  if (error?.auth) {
    toast('Admin token required — paste it in the bar above.', 'warn', { key: 'auth' })
    return
  }
  toast(error?.message || 'Something went wrong.', 'error')
  console.error(error)
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

function openModal(config) {
  const dialog = dom.modal
  if (!dialog) return
  modalState.onClose = typeof config.onClose === 'function' ? config.onClose : null
  modalState.cleanup = []
  dialog.className = `modal${config.size === 'lg' ? ' modal-lg' : ''}`
  dialog.innerHTML = `
    <div class="modal-head">
      <div class="modal-heading">
        <h2 class="modal-title" id="modal-title">${esc(config.title ?? '')}</h2>
        ${config.subtitle ? `<p class="modal-sub">${esc(config.subtitle)}</p>` : ''}
      </div>
      <button type="button" class="icon-btn" data-action="modal-close" aria-label="Close dialog" title="Close">${icon('close')}</button>
    </div>
    <div class="modal-body">${config.body ?? ''}</div>
    ${config.footer ? `<div class="modal-foot">${config.footer}</div>` : ''}`

  if (!dialog.open) dialog.showModal()
  if (typeof config.onMount === 'function') config.onMount(dialog)

  const focusTarget =
    dialog.querySelector('[data-autofocus]') || dialog.querySelector('.modal-body input, .modal-body select, .modal-body textarea') || dialog.querySelector('.modal-foot .btn')
  if (focusTarget) focusTarget.focus()
}

function closeModal() {
  if (dom.modal?.open) dom.modal.close()
}

function setModalFooter(html) {
  if (!dom.modal) return
  let foot = dom.modal.querySelector('.modal-foot')
  if (!foot) {
    foot = document.createElement('div')
    foot.className = 'modal-foot'
    dom.modal.appendChild(foot)
  }
  foot.innerHTML = html
}

/** Runs on the dialog's `close` event: stop polling and release modal resources. */
function onModalClose() {
  stopCapture()
  const cleanup = modalState.cleanup
  modalState.cleanup = []
  for (const fn of cleanup) {
    try {
      fn()
    } catch (error) {
      console.warn(error)
    }
  }
  const callback = modalState.onClose
  modalState.onClose = null
  if (callback) callback()
}

/** Yes/no dialog; resolves false on cancel, Escape or backdrop click. */
function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
      closeModal()
    }
    openModal({
      title,
      body: `<p class="capture-message">${esc(message)}</p>`,
      footer: `<button type="button" class="btn" data-inline="cancel">Cancel</button>
               <button type="button" class="btn ${danger ? 'btn-quiet-danger' : 'btn-primary'}" data-inline="ok">${esc(confirmLabel)}</button>`,
      onClose: () => finish(false),
      onMount: (dialog) => {
        dialog.querySelector('[data-inline="cancel"]').addEventListener('click', () => finish(false))
        dialog.querySelector('[data-inline="ok"]').addEventListener('click', () => finish(true))
      },
    })
  })
}

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

async function writeClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.top = '-1000px'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  const copied = document.execCommand('copy')
  area.remove()
  if (!copied) throw new Error('copy rejected')
}

function flashCopied(button) {
  if (button.classList.contains('copy-btn')) {
    const original = button.innerHTML
    const label = button.getAttribute('aria-label')
    button.innerHTML = icon('check')
    button.classList.add('is-copied')
    button.setAttribute('aria-label', 'Copied')
    setTimeout(() => {
      if (!button.isConnected) return
      button.innerHTML = original
      button.classList.remove('is-copied')
      if (label) button.setAttribute('aria-label', label)
    }, 1400)
    return
  }
  const original = button.textContent
  button.textContent = 'Copied'
  setTimeout(() => {
    if (button.isConnected) button.textContent = original
  }, 1400)
}

async function copyFromButton(button) {
  const explicit = button.dataset.copy
  const target = button.dataset.copyTarget ? document.getElementById(button.dataset.copyTarget) : null
  const text = explicit ?? target?.textContent ?? ''
  if (!text) return
  try {
    await writeClipboard(text)
    flashCopied(button)
  } catch {
    toast('Could not copy — select the text and press Ctrl+C.', 'error')
  }
}

// ---------------------------------------------------------------------------
// Loading helpers
// ---------------------------------------------------------------------------

function setButtonBusy(button, busy, label = 'Working…') {
  if (!button) return
  if (busy) {
    button.dataset.restore = button.innerHTML
    button.dataset.busy = 'true'
    button.disabled = true
    button.setAttribute('aria-busy', 'true')
    button.innerHTML = `<span class="spinner spinner-sm" aria-hidden="true"></span><span>${esc(label)}</span>`
    return
  }
  button.disabled = false
  button.removeAttribute('aria-busy')
  delete button.dataset.busy
  if (button.dataset.restore) {
    button.innerHTML = button.dataset.restore
    delete button.dataset.restore
  }
}

function setFormError(id, message) {
  const node = document.getElementById(id)
  if (!node) return
  node.textContent = message ?? ''
  node.hidden = !message
}

/** Enter inside a field submits even though the submit button lives in the footer. */
function enableEnterSubmit(form) {
  form.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.target instanceof HTMLTextAreaElement) return
    event.preventDefault()
    form.requestSubmit()
  })
}

function readTimeout(raw) {
  const value = Number(String(raw ?? '').trim())
  if (!Number.isFinite(value) || value < 1000) return DEFAULT_CAPTURE_TIMEOUT_MS
  return Math.round(value)
}

// ---------------------------------------------------------------------------
// Renders: shared pieces
// ---------------------------------------------------------------------------

function statusChip(status, extraTitle = '') {
  const label = STATUS_LABEL[status] ?? humanize(status)
  const tone = STATUS_TONE[status] ?? 'muted'
  const title = extraTitle ? ` title="${esc(extraTitle)}"` : ''
  return `<span class="chip chip-${tone}"${title}><span class="dot" aria-hidden="true"></span>${esc(label)}</span>`
}

function warmChip(warm) {
  return warm
    ? '<span class="warm warm-on"><span class="dot" aria-hidden="true"></span>Warm</span>'
    : '<span class="warm warm-off"><span class="dot" aria-hidden="true"></span>Cold</span>'
}

function idCell(value, label) {
  if (!value) return '<span class="cell-dim">—</span>'
  const id = String(value)
  return `<span class="id-cell"><code class="mono">${esc(shortId(id))}</code><button type="button" class="copy-btn" data-action="copy" data-copy="${esc(id)}" aria-label="Copy ${esc(label)}" title="Copy ${esc(label)}">${icon('copy')}</button></span>`
}

function emptyState({ title, body, action }) {
  return `<div class="empty">
    <p class="empty-title">${esc(title)}</p>
    ${body ? `<p class="empty-body">${esc(body)}</p>` : ''}
    ${action ? `<button type="button" class="btn btn-primary btn-sm" data-action="${esc(action.action)}">${esc(action.label)}</button>` : ''}
  </div>`
}

function skeletonTable(rows, columns) {
  const cells = (variant) =>
    Array.from({ length: columns }, (_, index) => `<span class="sk sk-line ${index === 0 ? variant : 'sk-sm'}"></span>`).join('')
  const body = Array.from({ length: rows }, () => `<div class="skeleton-row">${cells('sk-md')}</div>`).join('')
  return `<div class="skeleton-table" aria-hidden="true"><div class="skeleton-row skeleton-head">${cells('sk-sm')}</div>${body}</div>`
}

function statCard({ label, value, tone, sub, chips }) {
  return `<article class="card stat">
    <p class="stat-label">${esc(label)}</p>
    <p class="stat-value${tone ? ` tone-${tone}` : ''}">${value}</p>
    ${chips ? `<div class="stat-chips">${chips}</div>` : ''}
    ${sub ? `<p class="stat-sub">${sub}</p>` : ''}
  </article>`
}

// ---------------------------------------------------------------------------
// Renders: overview
// ---------------------------------------------------------------------------

function renderHeader(overview) {
  if (!overview) return
  setPill(dom.pillVersion, overview.version ? `v${overview.version}` : '')
  setPill(dom.pillUptime, Number.isFinite(overview.uptimeMs) ? `up ${fmtDuration(overview.uptimeMs)}` : '')
}

function setPill(node, text) {
  if (!node) return
  node.textContent = text
  node.hidden = !text
}

function renderOverview() {
  const data = store.data.overview
  if (!data) return
  renderHeader(data)
  if (dom.chartCard) dom.chartCard.hidden = false
  if (dom.recentCard) dom.recentCard.hidden = false

  const accounts = data.accounts ?? {}
  const keys = data.keys ?? {}
  const usage = data.usage ?? {}
  const requests = toNumber(usage.requests)
  const errors = toNumber(usage.errors)
  const rate = requests > 0 ? errors / requests : 0

  const chips = [
    ['Active', accounts.active, 'ok'],
    ['Muted', accounts.muted, 'warn'],
    ['Reauth', accounts.reauth, 'info'],
    ['Disabled', accounts.disabled, 'muted'],
  ]
    .map(([label, value, tone]) => `<span class="chip chip-${tone}"><span class="dot" aria-hidden="true"></span>${label} <strong>${fmtNum(value)}</strong></span>`)
    .join('')

  dom.overviewStats.innerHTML = [
    statCard({
      label: 'Accounts',
      value: fmtNum(accounts.total),
      chips,
      sub: `${fmtNum(accounts.warm)} warm browser${toNumber(accounts.warm) === 1 ? '' : 's'}`,
    }),
    statCard({
      label: 'Requests',
      value: fmtNum(requests),
      sub: `${fmtNum(errors)} error${errors === 1 ? '' : 's'} · ${fmtCompact(usage.promptChars)} prompt chars`,
    }),
    statCard({
      label: 'Error rate',
      value: requests > 0 ? fmtPercent(rate) : '—',
      tone: requests > 0 && rate >= 0.05 ? 'danger' : '',
      sub: requests > 0 ? `${fmtNum(errors)} of ${fmtNum(requests)}` : 'no traffic yet',
    }),
    statCard({ label: 'Avg latency', value: usage.avgLatencyMs ? fmtMs(usage.avgLatencyMs) : '—', sub: 'per upstream turn' }),
    statCard({ label: 'Tool calls', value: fmtNum(usage.toolCalls), sub: 'tool calls emitted' }),
    statCard({ label: 'API keys', value: fmtNum(keys.total), sub: `${fmtNum(keys.active)} active` }),
  ].join('')
  dom.overviewStats.setAttribute('aria-busy', 'false')

  renderChart(Array.isArray(usage.byDay) ? usage.byDay : [], requests)
  renderRecent(Array.isArray(data.recent) ? data.recent : [])
}

function renderChart(byDay, requestTotal) {
  if (!dom.chart) return
  const series = byDay
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({
      day: String(entry.day ?? ''),
      requests: Math.max(0, toNumber(entry.requests)),
      errors: Math.max(0, toNumber(entry.errors)),
    }))

  if (!series.length) {
    dom.chartMeta.textContent = ''
    dom.chart.innerHTML = `<div class="empty compact"><p class="empty-title">No traffic recorded yet</p><p class="empty-body">Daily request counts appear once a client calls the gateway.</p></div>`
    dom.chart.setAttribute('aria-busy', 'false')
    return
  }

  const peak = Math.max(1, ...series.map((entry) => entry.requests))
  const slot = 100 / series.length
  const barWidth = Math.min(6.5, Math.max(1.6, slot * 0.52))
  const first = series[0].day
  const last = series[series.length - 1].day

  const grid = [25, 50, 75]
    .map(
      (position) =>
        `<line x1="0" y1="${position}" x2="100" y2="${position}" stroke="currentColor" stroke-opacity="0.35" stroke-width="1" stroke-dasharray="2 5" vector-effect="non-scaling-stroke" />`,
    )
    .join('')

  const bars = series
    .map((entry, index) => {
      const left = index * slot
      const x = left + (slot - barWidth) / 2
      const height = (entry.requests / peak) * 100
      const y = 100 - height
      const errorHeight = entry.errors > 0 ? Math.min(height, (entry.errors / peak) * 100) : 0
      const label = `${entry.day || 'day'} — ${fmtNum(entry.requests)} request${entry.requests === 1 ? '' : 's'}${
        entry.errors ? `, ${fmtNum(entry.errors)} error${entry.errors === 1 ? '' : 's'}` : ''
      }`
      const hit = `<rect class="hit" x="${left}" y="0" width="${slot}" height="100" fill="transparent"><title>${esc(label)}</title></rect>`
      const bar =
        entry.requests > 0
          ? `<rect class="bar" x="${round(x)}" y="${round(y)}" width="${round(barWidth)}" height="${round(height)}" rx="${round(Math.min(1.1, barWidth / 2))}" />`
          : ''
      const cap =
        errorHeight > 0
          ? `<rect class="bar-error" x="${round(x)}" y="${round(y)}" width="${round(barWidth)}" height="${round(Math.max(errorHeight, 0.9))}" rx="0.4" />`
          : ''
      return hit + bar + cap
    })
    .join('')

  const chartLabel = `Requests per day from ${fmtDay(first)} to ${fmtDay(last)}; peak ${fmtNum(peak)} per day.`
  dom.chartMeta.textContent = `${series.length} day${series.length === 1 ? '' : 's'} · ${fmtNum(requestTotal)} requests`
  dom.chart.innerHTML = `
    <div class="chart-plot">
      <svg class="chart-svg" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="${esc(chartLabel)}">
        <line x1="0" y1="100" x2="100" y2="100" stroke="currentColor" stroke-opacity="0.5" stroke-width="1" vector-effect="non-scaling-stroke" />
        ${grid}
        ${bars}
      </svg>
    </div>
    <div class="chart-axis"><span>${esc(fmtDay(first))}</span><span>${esc(fmtDay(last))}</span></div>
    <div class="chart-legend">
      <span class="legend-item"><span class="legend-swatch" aria-hidden="true"></span>Requests</span>
      <span class="legend-item"><span class="legend-swatch swatch-error" aria-hidden="true"></span>Errors</span>
      <span class="legend-peak">peak ${fmtNum(peak)}/day</span>
    </div>`
  dom.chart.setAttribute('aria-busy', 'false')
}

/** Round SVG coordinates so the markup stays readable. */
function round(value) {
  return Math.round(value * 100) / 100
}

function renderRecent(recent) {
  if (!dom.recent) return
  const rows = Array.isArray(recent) ? recent : []
  dom.recentMeta.textContent = rows.length ? `last ${rows.length}` : ''

  if (!rows.length) {
    dom.recent.innerHTML = emptyState({
      title: 'No requests yet',
      body: 'Calls to /v1/chat/completions and /v1/messages appear here as they happen.',
    })
    dom.recent.setAttribute('aria-busy', 'false')
    return
  }

  dom.recent.innerHTML = `<div class="table-wrap table-wrap-scroll">
    <table class="data table-recent">
      <caption class="sr-only">Recent requests, newest first</caption>
      <thead>
        <tr>
          <th scope="col">Time</th>
          <th scope="col">Endpoint</th>
          <th scope="col">Model</th>
          <th scope="col">Status</th>
          <th scope="col" class="num">Latency</th>
          <th scope="col">Account</th>
          <th scope="col">Key</th>
          <th scope="col" class="num">Tools</th>
        </tr>
      </thead>
      <tbody>${rows.map(recentRow).join('')}</tbody>
    </table>
  </div>`
  dom.recent.setAttribute('aria-busy', 'false')
}

function recentRow(entry) {
  const ok = entry?.status ? entry.status === 'ok' : toNumber(entry?.httpStatus, 500) < 400
  const httpStatus = entry?.httpStatus != null ? String(entry.httpStatus) : ''
  const statusText = ok ? `OK${httpStatus ? ` ${httpStatus}` : ''}` : `${humanize(entry?.errorKind ?? 'error')}${httpStatus ? ` ${httpStatus}` : ''}`
  const tools = toNumber(entry?.toolCalls)
  const time = toNumber(entry?.ts)
  return `<tr>
    <td><span title="${esc(fmtDateTime(time))}">${esc(timeAgo(time))}</span></td>
    <td><code class="mono">${esc(entry?.endpoint ?? '—')}</code></td>
    <td><code class="mono">${esc(entry?.model ?? '—')}</code></td>
    <td><span class="chip chip-${ok ? 'ok' : 'danger'}"><span class="dot" aria-hidden="true"></span>${esc(statusText)}</span></td>
    <td class="num">${entry?.latencyMs != null ? esc(fmtMs(entry.latencyMs)) : '—'}</td>
    <td><code class="mono" title="${esc(entry?.accountId ?? '')}">${esc(shortId(entry?.accountId))}</code></td>
    <td><code class="mono" title="${esc(entry?.keyId ?? '')}">${esc(shortId(entry?.keyId))}</code></td>
    <td class="num">${tools > 0 ? fmtNum(tools) : '<span class="cell-dim">0</span>'}</td>
  </tr>`
}

// ---------------------------------------------------------------------------
// Renders: accounts
// ---------------------------------------------------------------------------

function renderAccounts() {
  const list = store.data.accounts
  if (!Array.isArray(list) || !dom.accountsTable) return

  dom.accountsMeta.textContent = list.length ? `${list.length} account${list.length === 1 ? '' : 's'}` : ''

  if (!list.length) {
    dom.accountsTable.innerHTML = emptyState({
      title: 'No accounts yet',
      body: 'Add one to get started — the gateway opens a browser window so you can sign in.',
      action: { label: 'Add account', action: 'account-add' },
    })
    dom.accountsTable.setAttribute('aria-busy', 'false')
    return
  }

  dom.accountsTable.innerHTML = `<div class="table-wrap">
    <table class="data table-accounts">
      <caption class="sr-only">Gateway accounts</caption>
      <thead>
        <tr>
          <th scope="col">Account</th>
          <th scope="col">Status</th>
          <th scope="col">Device ID</th>
          <th scope="col">DID</th>
          <th scope="col">Last used</th>
          <th scope="col">Warm</th>
          <th scope="col" class="cell-actions">Actions</th>
        </tr>
      </thead>
      <tbody>${list.map(accountRow).join('')}</tbody>
    </table>
  </div>`
  dom.accountsTable.setAttribute('aria-busy', 'false')
}

function accountRow(account) {
  const id = String(account?.id ?? '')
  const status = String(account?.status ?? 'active')
  const label = String(account?.label ?? 'account')
  const toggleLabel = status === 'disabled' ? 'Enable' : 'Disable'

  const statusNotes = [
    account?.lastError ? `Last error: ${account.lastError}` : '',
    account?.mutedUntil ? `Muted until ${fmtDateTime(account.mutedUntil)}` : '',
    account?.cooldownUntil ? `Cooling down until ${fmtDateTime(account.cooldownUntil)}` : '',
  ]
    .filter(Boolean)
    .join(' · ')

  return `<tr>
    <td><div class="cell-stack"><span class="cell-strong">${esc(label)}</span><span class="cell-dim">${esc(account?.email ?? '')}</span></div></td>
    <td>${statusChip(status, statusNotes)}</td>
    <td>${idCell(account?.deviceId, `device id for ${label}`)}</td>
    <td>${idCell(account?.did, `did for ${label}`)}</td>
    <td><span title="${esc(fmtDateTime(account?.lastUsedAt))}">${esc(account?.lastUsedAt ? timeAgo(account.lastUsedAt) : 'never')}</span></td>
    <td>${warmChip(Boolean(account?.warm))}</td>
    <td class="cell-actions">
      <div class="row-actions">
        <button type="button" class="btn btn-xs" data-action="account-check" data-id="${esc(id)}">Check</button>
        <button type="button" class="btn btn-xs" data-action="account-relogin" data-id="${esc(id)}">Relogin</button>
        <button type="button" class="btn btn-xs" data-action="account-native-signin" data-id="${esc(id)}" title="Open this profile in the installed browser, with no automation attached — use it when the site asks for a captcha">Sign in with Chrome</button>
        <button type="button" class="btn btn-xs" data-action="account-toggle" data-id="${esc(id)}">${toggleLabel}</button>
        <button type="button" class="btn btn-xs btn-quiet-danger" data-action="account-delete" data-id="${esc(id)}">Delete</button>
        <button type="button" class="btn btn-xs" data-action="account-shot" data-id="${esc(id)}">Screenshot</button>
      </div>
    </td>
  </tr>`
}

// ---------------------------------------------------------------------------
// Renders: API keys
// ---------------------------------------------------------------------------

function renderKeys() {
  const list = store.data.keys
  if (!Array.isArray(list) || !dom.keysTable) return

  dom.keysMeta.textContent = list.length ? `${list.length} key${list.length === 1 ? '' : 's'}` : ''

  if (!list.length) {
    dom.keysTable.innerHTML = emptyState({
      title: 'No API keys yet',
      body: 'Create one to call the gateway from an OpenAI or Anthropic client.',
      action: { label: 'Create key', action: 'key-create' },
    })
    dom.keysTable.setAttribute('aria-busy', 'false')
    return
  }

  dom.keysTable.innerHTML = `<div class="table-wrap">
    <table class="data table-keys">
      <caption class="sr-only">API keys</caption>
      <thead>
        <tr>
          <th scope="col">Name</th>
          <th scope="col">Prefix</th>
          <th scope="col">Accounts</th>
          <th scope="col">Created</th>
          <th scope="col">Last used</th>
          <th scope="col">Status</th>
          <th scope="col" class="cell-actions">Actions</th>
        </tr>
      </thead>
      <tbody>${list.map(keyRow).join('')}</tbody>
    </table>
  </div>`
  dom.keysTable.setAttribute('aria-busy', 'false')
}

function keyRow(key) {
  const id = String(key?.id ?? '')
  const revoked = key?.revokedAt != null
  const models = Array.isArray(key?.models) ? key.models : []
  const scope = `${models.length ? models.join(', ') : 'all models'}${key?.rpm != null ? ` · ${fmtNum(key.rpm)} rpm` : ''}`

  return `<tr>
    <td><div class="cell-stack"><span class="cell-strong">${esc(key?.name || 'unnamed')}</span><span class="cell-dim" title="${esc(scope)}">${esc(scope)}</span></div></td>
    <td><code class="mono">${esc(key?.prefix || '—')}</code></td>
    <td>${accountScope(key?.accountIds)}</td>
    <td><span title="${esc(fmtDateTime(key?.createdAt))}">${esc(key?.createdAt ? timeAgo(key.createdAt) : '—')}</span></td>
    <td><span title="${esc(key?.lastUsedAt ? fmtDateTime(key.lastUsedAt) : '')}">${esc(key?.lastUsedAt ? timeAgo(key.lastUsedAt) : 'never')}</span></td>
    <td>${
      revoked
        ? '<span class="chip chip-muted"><span class="dot" aria-hidden="true"></span>Revoked</span>'
        : '<span class="chip chip-ok"><span class="dot" aria-hidden="true"></span>Active</span>'
    }</td>
    <td class="cell-actions">
      <button type="button" class="btn btn-xs" data-action="key-revoke" data-id="${esc(id)}" ${revoked ? 'disabled' : ''}>Revoke</button>
      <button type="button" class="btn btn-xs btn-ghost" data-action="key-delete" data-id="${esc(id)}" data-name="${esc(key?.name ?? '')}">Delete</button>
    </td>
  </tr>`
}

/** Account labels a key may use; an empty list means every account. */
function accountScope(accountIds) {
  const ids = Array.isArray(accountIds) ? accountIds : []
  if (!ids.length) return '<span class="cell-dim">All accounts</span>'

  const known = Array.isArray(store.data.accounts) ? store.data.accounts : null
  const names = ids.map((id) => {
    const match = known?.find((account) => account.id === id)
    return match?.label ?? shortId(id)
  })
  const shown = names
    .slice(0, 3)
    .map((name) => `<span class="chip chip-plain">${esc(name)}</span>`)
    .join('')
  const more = names.length > 3 ? `<span class="chip chip-plain">+${names.length - 3}</span>` : ''
  return `<div class="chip-row" title="${esc(names.join(', '))}">${shown}${more}</div>`
}

// ---------------------------------------------------------------------------
// Renders: settings
// ---------------------------------------------------------------------------

function renderSettings() {
  const data = store.data.overview
  if (!data || !dom.settingsBody) return

  const config = data.config ?? {}
  const origin = location.origin
  const openaiBase = `${origin}/v1`
  const anthropicBase = origin

  const rows = [
    ['Host', config.host ?? '—'],
    ['Port', config.port ?? '—'],
    ['Headless browser', config.headless === true ? 'yes' : config.headless === false ? 'no' : '—'],
    ['Account RPM', config.accountRpm != null ? `${fmtNum(config.accountRpm)} / min` : '—'],
    ['Minimum gap', config.accountMinGapMs != null ? fmtMs(config.accountMinGapMs) : '—'],
    ['Session cleanup', config.sessionCleanup ? 'on' : 'off'],
    ['Home directory', config.home ?? '—'],
    ['Version', data.version ?? '—'],
    ['Uptime', Number.isFinite(data.uptimeMs) ? fmtDuration(data.uptimeMs) : '—'],
  ]

  const curlOpenAI = [
    `curl ${openaiBase}/chat/completions \\`,
    '  -H "Authorization: Bearer $DSWG_API_KEY" \\',
    '  -H "Content-Type: application/json" \\',
    `  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"hello"}]}'`,
  ].join('\n')

  const curlAnthropic = [
    `curl ${anthropicBase}/v1/messages \\`,
    '  -H "x-api-key: $DSWG_API_KEY" \\',
    '  -H "anthropic-version: 2023-06-01" \\',
    '  -H "Content-Type: application/json" \\',
    `  -d '{"model":"deepseek-chat","max_tokens":256,"messages":[{"role":"user","content":"hello"}]}'`,
  ].join('\n')

  dom.settingsBody.innerHTML = `<div class="settings-grid">
    <section class="card">
      <div class="card-head"><h3 class="card-title">Base URLs</h3><span class="card-meta">this gateway</span></div>
      <div class="kv">
        <div class="kv-row">
          <span class="kv-label">OpenAI-compatible</span>
          <span class="kv-value"><code class="mono">${esc(openaiBase)}</code><button type="button" class="copy-btn" data-action="copy" data-copy="${esc(openaiBase)}" aria-label="Copy the OpenAI base URL" title="Copy">${icon('copy')}</button></span>
        </div>
        <div class="kv-row">
          <span class="kv-label">Anthropic-compatible</span>
          <span class="kv-value"><code class="mono">${esc(anthropicBase)}</code><button type="button" class="copy-btn" data-action="copy" data-copy="${esc(anthropicBase)}" aria-label="Copy the Anthropic base URL" title="Copy">${icon('copy')}</button></span>
        </div>
      </div>
      <p class="hint">Use an API key from the <a href="#/keys">API Keys</a> tab. OpenAI clients append <code>/chat/completions</code>; Anthropic clients append <code>/v1/messages</code>.</p>
    </section>

    <section class="card">
      <div class="card-head"><h3 class="card-title">Configuration</h3><span class="card-meta">read-only</span></div>
      <dl class="kv-list">
        ${rows.map(([label, value]) => `<div class="kv-row"><dt>${esc(label)}</dt><dd>${esc(String(value))}</dd></div>`).join('')}
      </dl>
      <p class="hint">Values come from the running gateway process. Change the <code>DSWG_*</code> environment variables and restart it to edit them.</p>
    </section>

    <section class="card card-wide">
      <div class="card-head">
        <h3 class="card-title">OpenAI-compatible curl</h3>
        <button type="button" class="btn btn-xs" data-action="copy" data-copy-target="curl-openai">Copy</button>
      </div>
      <pre class="code"><code id="curl-openai">${esc(curlOpenAI)}</code></pre>
    </section>

    <section class="card card-wide">
      <div class="card-head">
        <h3 class="card-title">Anthropic-compatible curl</h3>
        <button type="button" class="btn btn-xs" data-action="copy" data-copy-target="curl-anthropic">Copy</button>
      </div>
      <pre class="code"><code id="curl-anthropic">${esc(curlAnthropic)}</code></pre>
    </section>
  </div>`
  dom.settingsBody.setAttribute('aria-busy', 'false')
}

// ---------------------------------------------------------------------------
// Skeletons and load failures
// ---------------------------------------------------------------------------

function showSkeleton(route) {
  if (route === 'overview') {
    if (dom.chartCard) dom.chartCard.hidden = false
    if (dom.recentCard) dom.recentCard.hidden = false
    if (dom.overviewStats) {
      dom.overviewStats.innerHTML = Array.from(
        { length: 6 },
        () => '<article class="card stat"><span class="sk sk-line sk-sm"></span><span class="sk sk-line sk-xl"></span><span class="sk sk-line sk-md"></span></article>',
      ).join('')
      dom.overviewStats.setAttribute('aria-busy', 'true')
    }
    if (dom.chart) {
      dom.chartMeta.textContent = ''
      dom.chart.innerHTML = '<div class="sk sk-chart" aria-hidden="true"></div>'
      dom.chart.setAttribute('aria-busy', 'true')
    }
    if (dom.recent) {
      dom.recentMeta.textContent = ''
      dom.recent.innerHTML = skeletonTable(4, 6)
      dom.recent.setAttribute('aria-busy', 'true')
    }
    return
  }
  if (route === 'accounts' && dom.accountsTable) {
    dom.accountsMeta.textContent = ''
    dom.accountsTable.innerHTML = skeletonTable(5, 6)
    dom.accountsTable.setAttribute('aria-busy', 'true')
    return
  }
  if (route === 'keys' && dom.keysTable) {
    dom.keysMeta.textContent = ''
    dom.keysTable.innerHTML = skeletonTable(3, 6)
    dom.keysTable.setAttribute('aria-busy', 'true')
    return
  }
  if (route === 'settings' && dom.settingsBody) {
    dom.settingsBody.innerHTML = `<div class="settings-grid">${Array.from(
      { length: 4 },
      () => '<section class="card"><span class="sk sk-line sk-md"></span><div class="sk sk-block"></div></section>',
    ).join('')}</div>`
    dom.settingsBody.setAttribute('aria-busy', 'true')
  }
}

function showLoadError(route, error) {
  const message = error?.auth ? 'Paste the admin token in the bar above to load this page.' : error?.message || 'The gateway did not answer.'
  const html = `<div class="empty">
    <p class="empty-title">Could not load this page</p>
    <p class="empty-body">${esc(message)}</p>
    <button type="button" class="btn btn-primary btn-sm" data-action="retry-load">Retry</button>
  </div>`

  // The chart and the request log have nothing to show without the overview.
  if (route === 'overview') {
    if (dom.chartCard) dom.chartCard.hidden = true
    if (dom.recentCard) dom.recentCard.hidden = true
  }

  const target =
    route === 'overview'
      ? dom.overviewStats
      : route === 'accounts'
        ? dom.accountsTable
        : route === 'keys'
          ? dom.keysTable
          : dom.settingsBody
  if (target) {
    target.innerHTML = html
    target.setAttribute('aria-busy', 'false')
  }
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

function hasRouteData(route) {
  if (route === 'overview' || route === 'settings') return Boolean(store.data.overview)
  if (route === 'accounts') return Array.isArray(store.data.accounts)
  if (route === 'keys') return Array.isArray(store.data.keys)
  return false
}

async function loadOverview() {
  store.data.overview = await api('/admin/api/overview')
  renderHeader(store.data.overview)
}

async function loadAccounts() {
  const list = await api('/admin/api/accounts')
  store.data.accounts = Array.isArray(list) ? list : []
}

async function ensureAccounts() {
  if (Array.isArray(store.data.accounts)) return store.data.accounts
  await loadAccounts()
  return store.data.accounts
}

async function loadKeys() {
  // Keys render without account labels, so an accounts failure must not hide them.
  const [keys, accounts] = await Promise.allSettled([api('/admin/api/keys'), ensureAccounts()])
  if (keys.status === 'rejected') throw keys.reason
  store.data.keys = Array.isArray(keys.value) ? keys.value : []
  if (accounts.status === 'rejected') reportError(accounts.reason)
}

const LOADERS = {
  overview: loadOverview,
  accounts: loadAccounts,
  keys: loadKeys,
  logs: loadLogs,
  settings: loadOverview,
}

function renderRoute(route) {
  if (route === 'overview') renderOverview()
  else if (route === 'accounts') renderAccounts()
  else if (route === 'keys') renderKeys()
  else if (route === 'logs') renderLogs()
  else if (route === 'settings') renderSettings()
}

function syncBusy() {
  const busy = store.busy > 0
  if (dom.refreshBtn) dom.refreshBtn.setAttribute('aria-busy', String(busy))
  if (dom.main) dom.main.setAttribute('aria-busy', String(busy))
}

/**
 * Fetch one route's data and repaint it. Cached data stays on screen while it
 * revalidates; a cold route shows skeletons first.
 */
async function loadRoute(route = store.route, options = {}) {
  const repaint = options.repaint !== false
  const loader = LOADERS[route]
  if (!loader) return

  if (!hasRouteData(route) && repaint) showSkeleton(route)
  store.busy += 1
  syncBusy()

  try {
    await loader()
    if (repaint) renderRoute(route)
  } catch (error) {
    reportError(error)
    if (repaint && !hasRouteData(route)) showLoadError(route, error)
  } finally {
    store.busy = Math.max(0, store.busy - 1)
    syncBusy()
  }
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

/** Human summary of one wire event, without dumping the whole payload. */
function summarizeLog(event) {
  const data = event.data ?? {}
  switch (event.kind) {
    case 'turn.start':
      return `${data.model ?? '?'} · ${data.thinking ? 'thinking' : 'instant'}${data.search ? '+search' : ''} · ${fmtNum(data.promptChars ?? 0)} chars · ${(data.tools ?? []).length} tools`
    case 'turn.http':
      return `${data.method ?? '?'} ${data.path ?? '?'} → ${data.status ?? '?'} · ${fmtMs(data.ms ?? 0)}${data.streaming ? ' · stream' : ''}${data.refused ? ' · REFUSED' : ''}`
    case 'turn.end':
      return data.ok
        ? `ok · ${data.finish ?? '?'} · ${fmtNum(data.textChars ?? 0)} chars${data.toolCalls?.length ? ` · ${data.toolCalls.length} tool calls` : ''}`
        : `failed · ${data.failure?.kind ?? '?'}${data.failure?.message ? ` · ${data.failure.message}` : ''}`
    case 'turn.verdict':
      return `${data.verdict?.kind ?? '?'} · ${data.verdict?.message ?? ''}`
    case 'turn.retry':
      return `retry · ${(data.diagnostics ?? []).join('; ').slice(0, 120)}`
    case 'turn.wait':
      return `waiting ${fmtMs(data.waitMs ?? 0)} for an account · ${String(data.reasons ?? '').slice(0, 120)}`
    case 'account.state':
      return `${data.from ?? '?'} → ${data.to ?? '?'} · ${data.reason ?? ''}`
    case 'account.identity':
      return `device ${String(data.deviceId ?? '—').slice(0, 8)}… · did ${String(data.did ?? '—').slice(0, 8)}… · ${data.origin ?? ''}`
    default:
      return JSON.stringify(data).slice(0, 160)
  }
}

/** Tone for a log kind chip. */
function logTone(event) {
  if (event.kind === 'turn.verdict') return 'warn'
  if (event.kind === 'turn.retry') return 'info'
  if (event.kind === 'turn.wait') return 'info'
  if (event.kind === 'account.state') return data_tone(event)
  if (event.kind === 'turn.end') return event.data?.ok === false ? 'error' : 'ok'
  if (event.kind === 'turn.http' && event.data?.refused) return 'error'
  return 'muted'
}

/** Tone for an account-state transition. */
function data_tone(event) {
  const to = event.data?.to
  if (to === 'muted') return 'warn'
  if (to === 'reauth') return 'info'
  if (to === 'deleted') return 'error'
  return 'ok'
}

async function loadLogs() {
  // The log rows name accounts by id; the labels come from the account list,
  // which a direct link to #/logs would otherwise never have fetched.
  if (!Array.isArray(store.data.accounts)) await loadAccounts()
  const [leaks, patterns] = await Promise.all([
    api('/admin/api/leaks?limit=50').catch(() => ({ leaks: [] })),
    api('/admin/api/patterns').catch(() => ({ patterns: [] })),
  ])
  store.data.leaks = leaks.leaks ?? []
  store.data.patterns = patterns.patterns ?? []
  const params = new URLSearchParams()
  const accountId = dom.logsAccount?.value ?? ''
  const kind = dom.logsKind?.value ?? ''
  const minutes = dom.logsWindow?.value ?? '1440'
  if (accountId) params.set('accountId', accountId)
  if (kind) params.set('kind', kind)
  params.set('minutes', minutes)
  params.set('limit', '300')
  store.data.logs = await api(`/admin/api/logs?${params.toString()}`)
  const exportLink = document.getElementById('logs-export')
  if (exportLink) exportLink.href = `/admin/api/logs/export?minutes=${encodeURIComponent(minutes)}&limit=5000`
}

function renderLogs() {
  const data = store.data.logs
  if (!data || !dom.logsBody) return
  renderLearning()

  const accounts = Array.isArray(store.data.accounts) ? store.data.accounts : []
  if (dom.logsAccount && dom.logsAccount.options.length <= 1 && accounts.length > 0) {
    for (const account of accounts) {
      const option = document.createElement('option')
      option.value = account.id
      option.textContent = account.label
      dom.logsAccount.appendChild(option)
    }
  }

  const events = Array.isArray(data.events) ? data.events : []
  const counts = Array.isArray(data.counts) ? data.counts : []

  if (events.length === 0) {
    dom.logsBody.innerHTML = emptyState({ title: 'No events in this window', body: 'The gateway records every upstream call here as it happens.' })
    return
  }

  const chips = counts
    .map((entry) => `<span class="chip chip-muted">${esc(entry.kind)} <strong>${fmtNum(entry.count)}</strong></span>`)
    .join(' ')

  const rows = events
    .map((event) => {
      const account = accounts.find((entry) => entry.id === event.accountId)
      return `<tr class="log-row" data-action="log-toggle" data-log="${esc(event.id)}" tabindex="0">
        <td class="mono nowrap">${esc(fmtTime(event.ts))}</td>
        <td><span class="chip chip-${logTone(event)}">${esc(event.kind)}</span></td>
        <td class="truncate">${esc(account?.label ?? event.accountId ?? '—')}</td>
        <td class="mono truncate">${esc(event.turnId ?? '—')}</td>
        <td class="truncate">${esc(summarizeLog(event))}</td>
      </tr>
      <tr class="log-detail" data-log-detail="${esc(event.id)}" hidden>
        <td colspan="5"><pre class="mono log-json">${esc(JSON.stringify(event.data, null, 2))}</pre></td>
      </tr>`
    })
    .join('')

  dom.logsBody.innerHTML = `
    <div class="logs-summary">${chips}</div>
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th scope="col">Time</th><th scope="col">Kind</th><th scope="col">Account</th><th scope="col">Turn</th><th scope="col">Summary</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`
}

/**
 * The learning panel: what the reader missed, and the delimiters it has learned.
 *
 * A leak here is a reply that clearly contained a call and registered none —
 * exactly the case the corpus exists to fix.
 */
function renderLearning() {
  const card = dom.learningCard
  if (!card) return
  const leaks = Array.isArray(store.data.leaks) ? store.data.leaks : []
  const patterns = Array.isArray(store.data.patterns) ? store.data.patterns : []
  card.hidden = false
  const leakRows = leaks.length === 0
    ? '<p class="card-meta">No leaks recorded — every call-shaped reply has been understood so far.</p>'
    : `<div class="table-wrap"><table class="table"><thead><tr><th scope="col">When</th><th scope="col">Kind</th><th scope="col">Evidence</th></tr></thead><tbody>${leaks
        .slice(0, 8)
        .map((leak) => `<tr><td class="mono nowrap">${esc(fmtTime(leak.ts))}</td><td><span class="chip chip-warn">${esc(leak.kind)}</span></td><td class="truncate">${esc(leak.evidence)}</td></tr>`)
        .join('')}</tbody></table></div>`
  const patternRows = patterns.length === 0
    ? '<p class="card-meta">No learned delimiters yet.</p>'
    : `<div class="table-wrap"><table class="table"><thead><tr><th scope="col">Opener</th><th scope="col">Closer</th><th scope="col">Score</th><th scope="col">Uses</th><th scope="col"></th></tr></thead><tbody>${patterns
        .map((pattern) => `<tr><td class="mono">${esc(pattern.opener)}</td><td class="mono">${esc(pattern.closer)}</td><td>${fmtNum(pattern.score)}</td><td>${fmtNum(pattern.uses)}</td><td><button type="button" class="btn btn-ghost" data-action="pattern-forget" data-id="${esc(pattern.id)}">Forget</button></td></tr>`)
        .join('')}</tbody></table></div>`

  card.innerHTML = `
    <div class="card-head">
      <h3 class="card-title">Parser learning</h3>
      <span class="card-meta">${fmtNum(leaks.length)} leak(s) · ${fmtNum(patterns.length)} learned pattern(s)</span>
      <button type="button" class="btn" data-action="mine">Mine corpus</button>
    </div>
    <h4 class="card-subtitle">Leaks — replies that looked like a call and registered none</h4>
    ${leakRows}
    <h4 class="card-subtitle">Learned delimiters</h4>
    ${patternRows}`
}

/** Ask the server to induce delimiters from the corpus. */
async function mineCorpus(button) {
  setButtonBusy(button, true, 'Mining…')
  try {
    const result = await api('/admin/api/mine', { method: 'POST', body: { minSamples: 2, apply: true } })
    const stored = Array.isArray(result?.stored) ? result.stored.length : 0
    const proposals = Array.isArray(result?.proposals) ? result.proposals.length : 0
    if (stored > 0) toast(`Learned ${stored} delimiter pair(s) from ${result.leaks} leak(s).`, 'ok')
    else if (proposals > 0) toast('Proposals found but none stored.', 'warn')
    else toast(`No new pattern found in ${result?.leaks ?? 0} leak(s).`, 'info')
  } catch (error) {
    reportError(error)
  } finally {
    if (button?.isConnected) setButtonBusy(button, false)
  }
  loadRoute('logs')
}

/** Forget one learned pattern. */
async function forgetPattern(id, button) {
  if (!id) return
  setButtonBusy(button, true, 'Forgetting…')
  try {
    await api(`/admin/api/patterns/${encodeURIComponent(id)}`, { method: 'DELETE' })
    toast('Pattern forgotten.', 'info')
  } catch (error) {
    reportError(error)
  } finally {
    if (button?.isConnected) setButtonBusy(button, false)
  }
  loadRoute('logs')
}

/** Expand or collapse one log row's payload. */
function toggleLogRow(logId) {
  const row = document.querySelector(`[data-log-detail="${CSS.escape(logId)}"]`)
  if (row) row.hidden = !row.hidden
}

// ---------------------------------------------------------------------------
// Account actions
// ---------------------------------------------------------------------------

function findAccount(accountId) {
  return Array.isArray(store.data.accounts) ? store.data.accounts.find((account) => account.id === accountId) : null
}

async function checkAccount(accountId, button) {
  if (!accountId) return
  setButtonBusy(button, true, 'Checking…')
  try {
    const result = await api(`/admin/api/accounts/${encodeURIComponent(accountId)}/check`, { method: 'POST' })
    if (result?.ok) toast(`Account is reachable (HTTP ${result.status ?? 200}).`, 'ok')
    else toast(result?.message || 'The account check failed.', 'error')
  } catch (error) {
    reportError(error)
  } finally {
    if (button?.isConnected) setButtonBusy(button, false)
  }
  loadRoute('accounts')
}

/** Delete one key row, after confirming: the secret can never be re-issued. */
async function deleteKey(accountId, name) {
  if (!accountId) return
  const label = name ? `"${name}"` : 'this key'
  if (!window.confirm(`Delete ${label}? This removes the row permanently; any client still using it stops working.`)) return
  try {
    await api(`/admin/api/keys/${encodeURIComponent(accountId)}`, { method: 'DELETE' })
    toast('Key deleted.', 'info')
  } catch (error) {
    reportError(error)
  }
  loadRoute('keys')
}

/** Delete every revoked key in one go. */
async function clearRevokedKeys(button) {
  if (!window.confirm('Delete every revoked key? Active keys are not touched.')) return
  setButtonBusy(button, true, 'Clearing…')
  try {
    const result = await api('/admin/api/keys/clear-revoked', { method: 'POST' })
    toast(`Deleted ${result?.deleted ?? 0} revoked key(s).`, 'info')
  } catch (error) {
    reportError(error)
  } finally {
    if (button?.isConnected) setButtonBusy(button, false)
  }
  loadRoute('keys')
}

async function toggleAccount(accountId) {
  const account = findAccount(accountId)
  if (!account) {
    toast('Account not found — refresh the list.', 'warn')
    return
  }
  const disabling = account.status !== 'disabled'
  try {
    const updated = await api(`/admin/api/accounts/${encodeURIComponent(accountId)}`, { method: 'PATCH', body: { disabled: disabling } })
    if (updated && typeof updated === 'object' && updated.id && Array.isArray(store.data.accounts)) {
      store.data.accounts = store.data.accounts.map((item) => (item.id === updated.id ? { ...item, ...updated } : item))
      renderAccounts()
    } else {
      loadRoute('accounts')
    }
    toast(disabling ? 'Account disabled.' : 'Account enabled.', 'ok')
  } catch (error) {
    reportError(error)
  }
}

async function deleteAccount(accountId) {
  const account = findAccount(accountId)
  const confirmed = await confirmDialog({
    title: `Delete ${account?.label ? `“${account.label}”` : 'this account'}?`,
    message: 'The browser profile is closed and the account is removed. Usage history keeps its rows.',
    confirmLabel: 'Delete account',
    danger: true,
  })
  if (!confirmed) return

  try {
    await api(`/admin/api/accounts/${encodeURIComponent(accountId)}`, { method: 'DELETE' })
    if (Array.isArray(store.data.accounts)) {
      store.data.accounts = store.data.accounts.filter((account) => account.id !== accountId)
      renderAccounts()
    }
    toast('Account deleted.', 'ok')
  } catch (error) {
    reportError(error)
  }
}

async function showScreenshot(accountId) {
  const account = findAccount(accountId)
  let objectUrl = ''

  openModal({
    title: `Screenshot${account?.label ? ` — ${account.label}` : ''}`,
    subtitle: 'Live page in the account’s browser profile.',
    size: 'lg',
    body: '<div class="shot" id="shot"><p class="shot-loading"><span class="spinner" aria-hidden="true"></span> Capturing the profile page…</p></div>',
    footer: '<button type="button" class="btn" data-action="modal-close">Close</button>',
    onClose: () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    },
  })

  try {
    const blob = await api(`/admin/api/accounts/${encodeURIComponent(accountId)}/screenshot`, { raw: true })
    objectUrl = URL.createObjectURL(blob)
    const host = dom.modal?.querySelector('#shot')
    if (!host) return
    host.innerHTML = `<img class="shot-img" src="${esc(objectUrl)}" alt="Screenshot of ${esc(account?.label ?? 'the account')} browser profile" />`
  } catch (error) {
    const host = dom.modal?.querySelector('#shot')
    if (host) {
      host.innerHTML =
        error?.status === 404
          ? '<div class="empty compact"><p class="empty-title">No live profile</p><p class="empty-body">This account has no warm browser yet. Press Check or Relogin, then try again.</p></div>'
          : `<div class="empty compact"><p class="empty-title">Screenshot failed</p><p class="empty-body">${esc(error?.message ?? 'Unknown error')}</p></div>`
    }
    if (error?.status === 404) toast('No live browser profile for this account yet.', 'warn')
    else reportError(error)
  }
}

// ---------------------------------------------------------------------------
// Capture flow (add account and relogin share it)
// ---------------------------------------------------------------------------

function captureBody() {
  return `<div class="capture">
    <p class="capture-status" id="capture-status"><span class="spinner" aria-hidden="true"></span><span id="capture-phase">Starting…</span></p>
    <ol class="steps">
      ${CAPTURE_STEPS.map(([id, text]) => `<li class="step" data-phase="${id}"><span class="step-dot" aria-hidden="true"></span><span class="step-text">${esc(text)}</span></li>`).join('')}
    </ol>
    <p class="capture-message" id="capture-message" aria-live="polite"></p>
    <p class="capture-error" id="capture-error" role="alert" hidden></p>
    <p class="hint">Closing this dialog only stops the progress view; the browser window keeps running.</p>
  </div>`
}

function captureFooter(state) {
  if (state === 'done') return '<button type="button" class="btn btn-primary" data-action="modal-close">Done</button>'
  if (state === 'failed') {
    return '<button type="button" class="btn" data-action="modal-close">Close</button><button type="button" class="btn btn-primary" data-action="capture-retry">Try again</button>'
  }
  return '<button type="button" class="btn btn-ghost" data-action="modal-close">Close</button><button type="button" class="btn btn-quiet-danger" data-action="capture-cancel">Cancel capture</button>'
}

function updateCaptureState(state) {
  const dialog = dom.modal
  if (!dialog) return
  const phase = String(state?.phase ?? 'opening')
  const currentIndex = CAPTURE_STEPS.findIndex(([id]) => id === phase)
  const failed = phase === 'failed'

  const status = dialog.querySelector('#capture-status')
  const phaseLabel = dialog.querySelector('#capture-phase')
  const message = dialog.querySelector('#capture-message')
  const error = dialog.querySelector('#capture-error')

  if (phaseLabel) phaseLabel.textContent = PHASE_TEXT[phase] ?? humanize(phase)
  if (status) status.classList.toggle('is-done', phase === 'done' || failed)
  if (message) message.textContent = state?.message ? String(state.message) : ''
  if (error) {
    const detail = failed ? String(state?.error ?? state?.message ?? 'The capture did not finish.') : ''
    error.textContent = detail
    error.hidden = !detail
  }

  dialog.querySelectorAll('.step').forEach((step, index) => {
    step.classList.toggle('is-done', currentIndex >= 0 && index < currentIndex)
    step.classList.toggle('is-current', currentIndex >= 0 && index === currentIndex && !failed)
    step.classList.toggle('is-failed', failed)
    step.removeAttribute('aria-current')
  })

  const current = dialog.querySelector('.step.is-current')
  if (current) current.setAttribute('aria-current', 'step')

  if (phase === 'done') {
    stopCapture()
    const accountId = captureRun.accountId
    if (status) status.classList.add('is-done')
    setModalFooter(captureFooter('done'))
    const button = dialog.querySelector('.modal-foot .btn')
    if (button) button.focus()
    toast('Account connected.', 'ok')
    store.data.accounts = null
    if (accountId) {
      loadRoute('accounts', { repaint: store.route === 'accounts' })
      if (store.route === 'overview') loadRoute('overview')
    }
    return
  }

  if (failed) {
    stopCapture()
    setModalFooter(captureFooter('failed'))
    const button = dialog.querySelector('.modal-foot .btn')
    if (button) button.focus()
    toast('The account capture failed.', 'error')
  }
}

function renderCaptureFailure(message) {
  const dialog = dom.modal
  if (!dialog) return
  const status = dialog.querySelector('#capture-status')
  const error = dialog.querySelector('#capture-error')
  const phaseLabel = dialog.querySelector('#capture-phase')
  if (status) status.classList.add('is-done')
  if (phaseLabel) phaseLabel.textContent = 'Capture stopped'
  if (error) {
    error.textContent = message
    error.hidden = false
  }
  setModalFooter(captureFooter('failed'))
  const button = dialog.querySelector('.modal-foot .btn')
  if (button) button.focus()
}

function stopCapture() {
  captureRun.active = false
  if (captureRun.timer) clearTimeout(captureRun.timer)
  captureRun.timer = 0
}

function startCapture(accountId) {
  stopCapture()
  captureRun.accountId = accountId
  captureRun.active = true
  captureRun.failures = 0
  captureRun.idle = 0
  pollCapture()
}

async function pollCapture() {
  if (!captureRun.active) return
  const accountId = captureRun.accountId
  let state = null

  try {
    state = await api(`/admin/api/accounts/${encodeURIComponent(accountId)}/capture`)
    captureRun.failures = 0
  } catch (error) {
    captureRun.failures += 1
    if (captureRun.failures >= 3) {
      stopCapture()
      renderCaptureFailure(error?.auth ? 'The admin token was rejected — save it above, then try again.' : error?.message || 'Lost contact with the gateway.')
      reportError(error)
      return
    }
  }

  if (!captureRun.active) return

  if (state) {
    // The contract reports `idle` when nothing is running; give it a few beats
    // after the POST before calling the capture gone.
    if (state.phase === 'idle') captureRun.idle += 1
    else captureRun.idle = 0

    if (state.phase === 'idle' && captureRun.idle > 4) {
      stopCapture()
      renderCaptureFailure('The capture is no longer running. Refresh the account list to see its state.')
      return
    }
    updateCaptureState(state)
  }

  if (captureRun.active) captureRun.timer = setTimeout(pollCapture, CAPTURE_POLL_MS)
}

async function cancelCapture() {
  const accountId = captureRun.accountId
  stopCapture()
  if (accountId) {
    try {
      await api(`/admin/api/accounts/${encodeURIComponent(accountId)}/cancel-capture`, { method: 'POST' })
    } catch (error) {
      if (!error?.auth) console.warn(error)
    }
  }
  closeModal()
  toast('Capture cancelled.', 'info')
  store.data.accounts = null
  loadRoute('accounts', { repaint: store.route === 'accounts' })
}

function openCaptureModal({ accountId, label, initial, mode }) {
  openModal({
    title: mode === 'relogin' ? `Relogin ${label}` : `Add ${label}`,
    subtitle: 'A browser window opened — sign in there. This dialog follows the capture.',
    body: captureBody(),
    footer: captureFooter('running'),
    onClose: () => stopCapture(),
    onMount: () => {
      if (initial) updateCaptureState(initial)
      startCapture(accountId)
    },
  })
}

// ---------------------------------------------------------------------------
// Add account / relogin forms
// ---------------------------------------------------------------------------

function openAddAccount() {
  openModal({
    title: 'Add account',
    subtitle: 'Sign in inside the account\u2019s own profile. Chrome opens for it; the session is read when you finish.',
    body: `<form class="form" id="add-account-form">
      <div class="field">
        <label for="acct-label">Label</label>
        <input id="acct-label" name="label" class="input" required maxlength="80" placeholder="main" autocomplete="off" data-autofocus />
        <p class="field-hint">Shown only in this dashboard.</p>
      </div>
      <div class="field">
        <label for="acct-email">Email <span class="field-optional">optional</span></label>
        <input id="acct-email" name="email" class="input" type="email" autocomplete="off" spellcheck="false" placeholder="you@example.com" />
      </div>
      <div class="field">
        <label for="acct-password">Password <span class="field-optional">optional</span></label>
        <input id="acct-password" name="password" class="input" type="password" autocomplete="new-password" />
        <p class="field-hint">Only needed when the sign-in page will not accept a manual sign-in.</p>
      </div>
      <div class="field">
        <label for="acct-mode">Sign-in window</label>
        <select id="acct-mode" name="mode" class="input">
          <option value="native" selected>Chrome, untouched (recommended)</option>
          <option value="controlled">Controlled window (headless servers)</option>
        </select>
        <p class="field-hint">The site's captcha refuses a browser that is being driven. The first option opens the same
        profile in your installed Chrome with nothing attached; use the second only when no browser is installed.</p>
      </div>
      <div class="field">
        <label for="acct-timeout">Capture timeout (ms)</label>
        <input id="acct-timeout" name="timeoutMs" class="input mono" type="number" inputmode="numeric" min="30000" step="30000" value="${DEFAULT_CAPTURE_TIMEOUT_MS}" />
        <p class="field-hint">The window gives up after this long. Default 15 minutes.</p>
      </div>
      <p class="form-error" id="add-account-error" role="alert" hidden></p>
    </form>`,
    footer: `<button type="button" class="btn" data-action="modal-close">Cancel</button>
             <button type="submit" form="add-account-form" class="btn btn-primary" id="add-account-submit">Open the sign-in window</button>`,
    onMount: (dialog) => {
      const form = dialog.querySelector('#add-account-form')
      form.addEventListener('submit', onAddAccountSubmit)
      enableEnterSubmit(form)
    },
  })
}

async function onAddAccountSubmit(event) {
  event.preventDefault()
  const form = event.currentTarget
  const submit = document.getElementById('add-account-submit')
  const fields = new FormData(form)
  const label = String(fields.get('label') ?? '').trim()
  const email = String(fields.get('email') ?? '').trim()
  const password = String(fields.get('password') ?? '')

  if (!label) {
    setFormError('add-account-error', 'A label is required.')
    return
  }

  // The email and password are only prefilled into the sign-in page. A capture
  // works without them: the operator signs in by hand in the window.
  const mode = String(fields.get('mode') ?? 'native')
  const payload = { label, timeoutMs: readTimeout(fields.get('timeoutMs')), mode }
  if (email) payload.email = email
  if (password) payload.password = password

  setFormError('add-account-error', '')
  setButtonBusy(submit, true, 'Starting…')
  try {
    const result = await api('/admin/api/accounts', { method: 'POST', body: payload })
    const account = result?.account
    if (!account?.id) throw new ApiError('The gateway did not return the new account.')
    store.data.accounts = null
    if (result?.native === true) {
      // A plain Chrome window is open. Nothing to watch: the gateway reads the
      // profile while the operator signs in and adopts the session the moment it
      // appears, so the list is simply polled until the row turns active.
      watchNativeSignIn(account.id, account.label ?? label)
      return
    }
    openCaptureModal({ accountId: account.id, label: account.label ?? label, initial: result.capture ?? null, mode: 'create' })
  } catch (error) {
    reportError(error)
    setFormError('add-account-error', error?.message || 'Could not start the capture.')
    if (submit?.isConnected) setButtonBusy(submit, false)
  }
}

function openRelogin(accountId) {
  const account = findAccount(accountId)
  if (!account) {
    toast('Account not found — refresh the list.', 'warn')
    return
  }

  openModal({
    title: `Relogin ${account.label}`,
    subtitle: 'A browser window opens for a fresh sign-in; the profile is re-captured when you finish.',
    body: `<form class="form" id="relogin-form">
      <div class="field">
        <label for="relogin-password">Password <span class="field-optional">optional</span></label>
        <input id="relogin-password" name="password" class="input" type="password" autocomplete="off" />
        <p class="field-hint">Leave empty to sign in by hand in the browser window.</p>
      </div>
      <div class="field">
        <label for="relogin-timeout">Capture timeout (ms)</label>
        <input id="relogin-timeout" name="timeoutMs" class="input mono" type="number" inputmode="numeric" min="30000" step="30000" value="${DEFAULT_CAPTURE_TIMEOUT_MS}" />
      </div>
      <p class="field-hint">If the site asks for a captcha and will not accept it, use <strong>Sign in with Chrome</strong>
      instead: it opens the same profile in the installed browser with nothing attached, so the check has nothing to detect.</p>
      <p class="form-error" id="relogin-error" role="alert" hidden></p>
    </form>`,
    footer: `<button type="button" class="btn" data-action="modal-close">Cancel</button>
             <button type="button" class="btn" data-action="native-signin" data-id="${esc(accountId)}">Sign in with Chrome</button>
             <button type="submit" form="relogin-form" class="btn btn-primary" id="relogin-submit">Start relogin</button>`,
    onMount: (dialog) => {
      const form = dialog.querySelector('#relogin-form')
      form.addEventListener('submit', (event) => onReloginSubmit(event, accountId))
      enableEnterSubmit(form)
    },
  })
}

/**
 * Follow a native sign-in until the account turns active.
 *
 * The gateway reads the profile on disk while the operator signs in, so the only
 * thing the dashboard has to do is notice. Polling here means the row changes by
 * itself, with no "close the window" step and no button to press afterwards.
 * @param {string} accountId - the account being signed in.
 * @param {string} label - its display name.
 */
function watchNativeSignIn(accountId, label) {
  toast(`Chrome opened for ${label} — sign in there. This page updates on its own when the session appears.`, 'info', 9000)
  let tries = 0
  const timer = setInterval(async () => {
    tries += 1
    await refreshAccounts().catch(() => undefined)
    const account = findAccount(accountId)
    if (account && (account.status === 'active' || account.status === 'muted')) {
      clearInterval(timer)
      const note = account.status === 'muted' ? ` — but the account is muted: ${account.lastError ?? 'see the account row'}` : ''
      toast(`${label} is signed in${note}`, account.status === 'muted' ? 'warn' : 'success', 12000)
      return
    }
    if (tries > 200) clearInterval(timer)
  }, 3000)
}

/**
 * Open the profile in the installed browser, with no automation attached.
 * @param {string} accountId - the account whose profile to open.
 */
async function startNativeSignIn(accountId) {
  const account = findAccount(accountId)
  try {
    await api(`/admin/api/accounts/${encodeURIComponent(accountId)}/sign-in-native`, { method: 'POST' })
    watchNativeSignIn(accountId, account?.label ?? 'the account')
  } catch (error) {
    reportError(error)
    toast(error?.message || 'Could not open the browser.', 'error')
  }
}

async function onReloginSubmit(event, accountId) {
  event.preventDefault()
  const form = event.currentTarget
  const submit = document.getElementById('relogin-submit')
  const fields = new FormData(form)
  const password = String(fields.get('password') ?? '')
  const payload = { timeoutMs: readTimeout(fields.get('timeoutMs')) }
  if (password) payload.password = password

  setFormError('relogin-error', '')
  setButtonBusy(submit, true, 'Starting…')
  try {
    const result = await api(`/admin/api/accounts/${encodeURIComponent(accountId)}/relogin`, { method: 'POST', body: payload })
    const account = findAccount(accountId)
    const label = result?.account?.label ?? account?.label ?? 'account'
    store.data.accounts = null
    openCaptureModal({ accountId: result?.account?.id ?? accountId, label, initial: result?.capture ?? result ?? null, mode: 'relogin' })
  } catch (error) {
    reportError(error)
    setFormError('relogin-error', error?.message || 'Could not start the relogin.')
    if (submit?.isConnected) setButtonBusy(submit, false)
  }
}

// ---------------------------------------------------------------------------
// API key actions
// ---------------------------------------------------------------------------

function openCreateKey() {
  openModal({
    title: 'Create API key',
    subtitle: 'Keys are scoped to the accounts and models you pick.',
    size: 'lg',
    body: `<form class="form" id="create-key-form">
      <div class="field">
        <label for="key-name">Name</label>
        <input id="key-name" name="name" class="input" required maxlength="80" placeholder="laptop" autocomplete="off" data-autofocus />
      </div>
      <fieldset class="field">
        <legend>Accounts <span class="field-optional">optional</span></legend>
        <div class="checklist" id="key-accounts"><p class="checklist-note"><span class="spinner" aria-hidden="true"></span> Loading accounts…</p></div>
        <p class="field-hint">Nothing selected allows every account.</p>
      </fieldset>
      <fieldset class="field">
        <legend>Models <span class="field-optional">optional</span></legend>
        <div class="checklist" id="key-models"><p class="checklist-note"><span class="spinner" aria-hidden="true"></span> Loading models…</p></div>
        <p class="field-hint">Nothing selected allows every model.</p>
      </fieldset>
      <div class="field">
        <label for="key-rpm">Requests per minute <span class="field-optional">optional</span></label>
        <input id="key-rpm" name="rpm" class="input mono" type="number" inputmode="numeric" min="1" step="1" placeholder="unlimited" />
        <p class="field-hint">Leave empty for no per-key limit.</p>
      </div>
      <p class="form-error" id="create-key-error" role="alert" hidden></p>
    </form>`,
    footer: `<button type="button" class="btn" data-action="modal-close">Cancel</button>
             <button type="submit" form="create-key-form" class="btn btn-primary" id="create-key-submit">Create key</button>`,
    onMount: (dialog) => {
      const form = dialog.querySelector('#create-key-form')
      form.addEventListener('submit', onCreateKeySubmit)
      enableEnterSubmit(form)
      fillKeyAccounts(dialog)
      fillKeyModels(dialog)
    },
  })
}

async function fillKeyAccounts(dialog) {
  const box = dialog.querySelector('#key-accounts')
  if (!box) return
  try {
    const accounts = await ensureAccounts()
    if (!box.isConnected) return
    if (!accounts.length) {
      box.innerHTML = '<p class="checklist-note">No accounts yet — add one in the Accounts tab.</p>'
      return
    }
    box.innerHTML = accounts
      .map(
        (account) => `<label class="check-row">
          <input type="checkbox" name="accountIds" value="${esc(account.id)}" />
          <span class="check-text"><span class="cell-strong">${esc(account.label || 'account')}</span><span class="cell-dim">${esc(account.email ?? '')}</span></span>
          ${statusChip(account.status)}
        </label>`,
      )
      .join('')
  } catch (error) {
    if (!box.isConnected) return
    box.innerHTML = '<p class="checklist-note checklist-error">Could not load accounts. The key will allow every account.</p>'
    reportError(error)
  }
}

async function fillKeyModels(dialog) {
  const box = dialog.querySelector('#key-models')
  if (!box) return
  try {
    const models = await api('/admin/api/models')
    if (!box.isConnected) return
    const list = Array.isArray(models) ? models : []
    if (!list.length) {
      box.innerHTML = '<p class="checklist-note">No models reported — the key will allow every model.</p>'
      return
    }
    box.innerHTML = list
      .map((model) => {
        const traits = [model.label, model.thinking ? 'thinking' : '', model.search ? 'search' : '', model.default ? 'default' : ''].filter(Boolean).join(' · ')
        return `<label class="check-row">
          <input type="checkbox" name="models" value="${esc(model.id)}" />
          <span class="check-text"><span class="cell-strong">${esc(model.id)}</span><span class="cell-dim">${esc(traits)}</span></span>
        </label>`
      })
      .join('')
  } catch (error) {
    if (!box.isConnected) return
    box.innerHTML = `<input class="input mono" id="key-models-fallback" name="modelsText" placeholder="deepseek-chat, deepseek-reasoner" aria-label="Allowed models, comma separated" />`
    reportError(error)
  }
}

async function onCreateKeySubmit(event) {
  event.preventDefault()
  const form = event.currentTarget
  const submit = document.getElementById('create-key-submit')
  const fields = new FormData(form)
  const name = String(fields.get('name') ?? '').trim()
  if (!name) {
    setFormError('create-key-error', 'Give the key a name.')
    return
  }

  const accountIds = [...form.querySelectorAll('input[name="accountIds"]:checked')].map((input) => input.value)
  let models = [...form.querySelectorAll('input[name="models"]:checked')].map((input) => input.value)
  const fallback = form.querySelector('[name="modelsText"]')
  if (fallback && String(fallback.value).trim()) {
    models = String(fallback.value)
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
  }

  const rpmRaw = String(fields.get('rpm') ?? '').trim()
  const rpmNumber = Number(rpmRaw)
  const rpm = rpmRaw === '' || !Number.isFinite(rpmNumber) ? null : Math.max(1, Math.round(rpmNumber))

  setFormError('create-key-error', '')
  setButtonBusy(submit, true, 'Creating…')
  try {
    const result = await api('/admin/api/keys', { method: 'POST', body: { name, accountIds, models, rpm } })
    if (!result?.secret) throw new ApiError('The gateway did not return the new secret.')
    store.data.keys = null
    showSecret(result.secret, result.key ?? null)
    loadRoute('keys', { repaint: store.route === 'keys' })
    toast('API key created.', 'ok')
  } catch (error) {
    reportError(error)
    setFormError('create-key-error', error?.message || 'Could not create the key.')
    if (submit?.isConnected) setButtonBusy(submit, false)
  }
}

function showSecret(secret, key) {
  openModal({
    title: 'API key created',
    subtitle: key?.name ? `“${key.name}” is ready to use.` : 'The key is ready to use.',
    body: `<div class="secret">
      <p class="secret-warn"><span class="warn-dot" aria-hidden="true"></span> This is the only time the secret is shown. Copy it now.</p>
      <div class="secret-box">
        <code class="mono" id="secret-value">${esc(secret)}</code>
        <button type="button" class="btn btn-sm" data-action="copy" data-copy="${esc(secret)}">Copy</button>
      </div>
      <p class="hint">Send it as <code>Authorization: Bearer …</code> for OpenAI clients or <code>x-api-key: …</code> for Anthropic clients.</p>
    </div>`,
    footer: '<button type="button" class="btn btn-primary" data-action="modal-close">I stored it</button>',
  })
}

async function revokeKey(keyId) {
  const key = Array.isArray(store.data.keys) ? store.data.keys.find((entry) => entry.id === keyId) : null
  const confirmed = await confirmDialog({
    title: `Revoke ${key?.name ? `“${key.name}”` : 'this key'}?`,
    message: 'Clients using this key start failing immediately. The key stays listed with its usage history.',
    confirmLabel: 'Revoke key',
    danger: true,
  })
  if (!confirmed) return

  try {
    await api(`/admin/api/keys/${encodeURIComponent(keyId)}/revoke`, { method: 'POST' })
    store.data.keys = null
    await loadRoute('keys', { repaint: store.route === 'keys' })
    toast('Key revoked.', 'ok')
  } catch (error) {
    reportError(error)
  }
}

// ---------------------------------------------------------------------------
// Admin token prompt
// ---------------------------------------------------------------------------

function showTokenBar() {
  if (!dom.tokenBar) return
  if (!dom.tokenBar.hidden) return
  dom.tokenBar.hidden = false
  store.authPrompt = true
  // Never steal focus from an open dialog; its focus trap owns it.
  if (!dom.modal?.open) dom.tokenInput?.focus()
}

function hideTokenBar() {
  if (!dom.tokenBar) return
  dom.tokenBar.hidden = true
  store.authPrompt = false
}

function onTokenSubmit(event) {
  event.preventDefault()
  const value = String(dom.tokenInput?.value ?? '').trim()
  if (!value) {
    dom.tokenInput?.focus()
    toast('Enter the admin token first.', 'warn')
    return
  }
  store.token = value
  writeStorage(TOKEN_KEY, value)
  if (dom.tokenInput) dom.tokenInput.value = ''
  hideTokenBar()
  dom.toasts?.querySelector('[data-key="auth"]')?.remove()
  toast('Admin token saved.', 'ok')
  loadRoute(store.route)
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

function applyTheme(theme) {
  const next = theme === 'light' ? 'light' : 'dark'
  store.theme = next
  document.documentElement.dataset.theme = next
  if (!dom.themeBtn) return
  const label = next === 'light' ? 'Switch to dark theme' : 'Switch to light theme'
  dom.themeBtn.setAttribute('aria-pressed', String(next === 'light'))
  dom.themeBtn.setAttribute('aria-label', label)
  dom.themeBtn.setAttribute('title', label)
}

function toggleTheme() {
  const next = store.theme === 'light' ? 'dark' : 'light'
  applyTheme(next)
  writeStorage(THEME_KEY, next)
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

function readRouteFromHash() {
  const raw = location.hash.replace(/^#\/?/, '').replace(/\/+$/, '')
  return ROUTES.includes(raw) ? raw : 'overview'
}

function syncChrome(route) {
  for (const tab of dom.tabs) {
    const active = tab.dataset.route === route
    tab.setAttribute('aria-selected', String(active))
    tab.tabIndex = active ? 0 : -1
  }
  for (const panel of dom.panels) panel.hidden = panel.dataset.route !== route
  document.title = `${ROUTE_TITLES[route] ?? 'Admin'} · DeepSeek Web Gateway`
}

function activateRoute(options = {}) {
  const route = readRouteFromHash()
  const changed = route !== store.route
  store.route = route
  syncChrome(route)
  if (hasRouteData(route)) renderRoute(route)
  loadRoute(route)
  if (!options.initial && changed) window.scrollTo({ top: 0, behavior: 'auto' })
}

function onTabKeydown(event) {
  const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End']
  if (!keys.includes(event.key)) return
  event.preventDefault()
  const current = ROUTES.indexOf(store.route)
  let next = current
  if (event.key === 'ArrowRight') next = (current + 1) % ROUTES.length
  else if (event.key === 'ArrowLeft') next = (current - 1 + ROUTES.length) % ROUTES.length
  else if (event.key === 'Home') next = 0
  else next = ROUTES.length - 1
  location.hash = `#/${ROUTES[next]}`
  dom.tabs[next]?.focus()
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

const ACTIONS = {
  refresh: () => loadRoute(store.route),
  'log-toggle': (node) => toggleLogRow(node.dataset.log ?? ''),
  'logs-refresh': () => loadRoute('logs'),
  mine: (node) => mineCorpus(node),
  'key-delete': (node) => deleteKey(node.dataset.id, node.dataset.name),
  'keys-clear-revoked': (node) => clearRevokedKeys(node),
  'pattern-forget': (node) => forgetPattern(node.dataset.id, node),
  'retry-load': () => loadRoute(store.route),
  'toggle-theme': () => toggleTheme(),
  'token-dismiss': () => hideTokenBar(),
  'modal-close': () => closeModal(),
  'toast-close': (button) => button.closest('.toast')?.remove(),
  copy: (button) => copyFromButton(button),
  'account-add': () => openAddAccount(),
  'account-check': (button) => checkAccount(button.dataset.id, button),
  'account-relogin': (button) => openRelogin(button.dataset.id),
  'account-native-signin': (button) => startNativeSignIn(button.dataset.id),
  'native-signin': (button) => startNativeSignIn(button.dataset.id),
  'account-toggle': (button) => toggleAccount(button.dataset.id),
  'account-delete': (button) => deleteAccount(button.dataset.id),
  'account-shot': (button) => showScreenshot(button.dataset.id),
  'capture-cancel': () => cancelCapture(),
  'capture-retry': () => openRelogin(captureRun.accountId),
  'key-create': () => openCreateKey(),
  'key-revoke': (button) => revokeKey(button.dataset.id),
}

function onDocumentClick(event) {
  const target = event.target instanceof Element ? event.target : null
  if (!target) return

  const actionNode = target.closest('[data-action]')
  if (actionNode) {
    const handler = ACTIONS[actionNode.dataset.action]
    if (!handler) return
    event.preventDefault()
    if (actionNode.dataset.busy === 'true') return
    handler(actionNode, event)
    return
  }

  // A click on the dialog's backdrop targets the dialog element itself.
  if (target === dom.modal && dom.modal.open) closeModal()
}

function cacheDom() {
  dom.tokenBar = document.getElementById('token-bar')
  dom.tokenInput = document.getElementById('admin-token')
  dom.tablist = document.getElementById('tablist')
  dom.tabs = [...document.querySelectorAll('[role="tab"]')]
  dom.panels = [...document.querySelectorAll('[role="tabpanel"]')]
  dom.pillVersion = document.getElementById('pill-version')
  dom.pillUptime = document.getElementById('pill-uptime')
  dom.refreshBtn = document.getElementById('refresh-btn')
  dom.themeBtn = document.getElementById('theme-btn')
  dom.main = document.getElementById('main')
  dom.overviewStats = document.getElementById('overview-stats')
  dom.chartCard = document.getElementById('chart-card')
  dom.recentCard = document.getElementById('recent-card')
  dom.chart = document.getElementById('chart')
  dom.chartMeta = document.getElementById('chart-meta')
  dom.recent = document.getElementById('recent')
  dom.recentMeta = document.getElementById('recent-meta')
  dom.accountsTable = document.getElementById('accounts-table')
  dom.accountsMeta = document.getElementById('accounts-meta')
  dom.keysTable = document.getElementById('keys-table')
  dom.keysMeta = document.getElementById('keys-meta')
  dom.settingsBody = document.getElementById('settings-body')
  dom.logsBody = document.getElementById('logs-body')
  dom.logsAccount = document.getElementById('logs-account')
  dom.logsKind = document.getElementById('logs-kind')
  dom.logsWindow = document.getElementById('logs-window')
  dom.learningCard = document.getElementById('learning-card')
  dom.toasts = document.getElementById('toasts')
  dom.modal = document.getElementById('modal')
}

function bindEvents() {
  document.addEventListener('click', onDocumentClick)
  document.addEventListener('change', (event) => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    if (target.dataset.action === 'logs-filter') loadRoute('logs')
  })
  document.addEventListener('keydown', (event) => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    if (target.dataset.action === 'log-toggle' && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault()
      toggleLogRow(target.dataset.log ?? '')
    }
  })
  dom.tokenBar?.addEventListener('submit', onTokenSubmit)
  dom.tablist?.addEventListener('keydown', onTabKeydown)
  dom.modal?.addEventListener('close', onModalClose)
  window.addEventListener('hashchange', () => activateRoute())
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function init() {
  cacheDom()
  store.token = readStorage(TOKEN_KEY) ?? ''
  applyTheme(readStorage(THEME_KEY) === 'light' ? 'light' : 'dark')
  bindEvents()

  const route = readRouteFromHash()
  if (!location.hash) history.replaceState(null, '', `#/${route}`)
  activateRoute({ initial: true })
}

init()
