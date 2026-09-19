// @ts-nocheck
// ── state ─────────────────────────────────────────────────────
const S = {
  accounts: [],
  accountStats: {}, // id -> { vmCount, subscriptionDisplayName, state, loading, error }
  activePage: 'overview',
  selectedAccId: null,
  // accountId -> { vms, at, error, code }. Rendering reads only the slot of the
  // currently selected account, so it is structurally unable to draw another
  // account's machines.
  vmsCache: new Map(),
  vmsReads: new Map(), // accountId -> AbortController
  regions: [],
  pendingAction: null,
  trackingTasks: new Set(),
  addVerifiedKey: null, // fingerprint of last successfully verified credentials
  pendingNewAccountId: null,
  accountSearch: '',
  accountSort: 'manual',
  dragAccountId: null,
  accountInsights: {},
  accountDetails: {},
  revealedAccountSecret: false,
  detailsAccountId: null, // account the open details modal belongs to
  renderedVms: [],
  vmsLoading: false,
  createVmAccountId: null, // account the create-VM dialog was opened for
  // accountId -> region list last loaded for the create-VM dialog
  regionsByAccount: {},
  summaryRefreshing: false,
  refreshAllRunning: false,
  recentTasks: [],
  opLogLines: [],
  // 'tasks' | 'logs' — shared by the bottom panel and the expand modal
  activityTab: 'tasks',
  // accountId -> { tasks, logs }. Instant paint on switch, same idea as vmsCache.
  activityCache: new Map(),
  // accountId -> AbortController for in-flight tasks/logs fetches
  activityReads: new Map(),
};

// ── api ───────────────────────────────────────────────────────
// Account-scoped responses echo `accountId`, derived from the path. Comparing it
// against the path the client asked for is what makes "this payload belongs to
// the account I requested" a verifiable fact instead of an assumption.
const ACCOUNT_PATH_RE = /^\/api\/accounts\/([0-9a-fA-F-]{36})\//;

async function api(method, path, body, options = {}) {
  const res = await fetch(path, {
    method,
    cache: 'no-store',
    signal: options.signal,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = {};
  if (text) {
    try { data = JSON.parse(text); } catch { data = {}; }
  }
  if (!res.ok) {
    throw Object.assign(new Error(data?.error || `请求失败 (${res.status})`), {
      status: res.status,
      code: data?.code,
      retryable: data?.retryable === true,
    });
  }

  // Ownership tripwire: reject a payload that claims a different account.
  const expected = ACCOUNT_PATH_RE.exec(path)?.[1];
  if (expected && data && typeof data.accountId === 'string' && data.accountId !== expected) {
    console.warn('[api] discarding cross-account payload', { expected, received: data.accountId });
    throw Object.assign(new Error('响应账户与请求账户不一致，已丢弃'), {
      status: 0,
      code: 'account_mismatch',
      stale: true,
    });
  }
  return data;
}

function isAbortError(e) {
  return !!e && (e.name === 'AbortError' || e.code === 20);
}

// ── helpers ───────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
// Safe JS string literal for inline handlers (avoids HTML-escaping breaking API values).
const jsq = v => JSON.stringify(String(v ?? ''));

function on(id, event, handler) {
  const el = $(id);
  if (!el) {
    console.warn(`[ui] missing #${id}, skip ${event} binding`);
    return;
  }
  el.addEventListener(event, handler);
}

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast${type === 'success' ? ' t-ok' : type === 'error' ? ' t-err' : ''}`;
  el.textContent = msg;
  const host = $('tc');
  if (!host) return;
  host.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

const openModal  = id => $(id)?.classList.remove('hidden');
const closeModal = id => $(id)?.classList.add('hidden');

function badge(status) {
  const m = { success:'bg-ok', failure:'bg-err', running:'bg-run', queued:'bg-inf' };
  return `<span class="badge ${m[status]||'bg-inf'}">${esc(status)}</span>`;
}

function greeting() {
  const h = new Date().getHours();
  if (h < 6)  return '深夜好';
  if (h < 12) return '早上好';
  if (h < 18) return '下午好';
  return '晚上好';
}

function shortId(id) {
  if (!id) return '-';
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

/** Numeric costs always show 2 decimal places; status labels pass through. */
function formatCostAmount(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : String(value);
}

function formatCostUpdatedAt(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制', 'success');
  } catch {
    toast('复制失败', 'error');
  }
}
window.copyText = copyText;

