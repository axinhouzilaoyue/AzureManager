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
  activeVTab: 'vms',
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
  vmSearch: '',
  vmStatusFilter: 'all',
  renderedVms: [],
  vmsLoading: false,
  createVmAccountId: null, // account the create-VM dialog was opened for
  summaryRefreshing: false,
  refreshAllRunning: false,
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

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制', 'success');
  } catch {
    toast('复制失败', 'error');
  }
}
window.copyText = copyText;

// ── page navigation ───────────────────────────────────────────
const PAGES = ['overview', 'accounts', 'settings'];

function switchPage(page) {
  if (!PAGES.includes(page)) return;
  S.activePage = page;
  PAGES.forEach(p => {
    $(`pg-${p}`)?.classList.toggle('hidden', p !== page);
    $(`ni-${p}`)?.classList.toggle('active', p === page);
  });
  try {
    if (page === 'overview') refreshOverview();
    if (page === 'accounts') showAccList();
    if (page === 'settings') {
      loadStartupScript();
      loadGlobalSshSettings();
    }
  } catch (err) {
    console.error('[ui] switchPage side effects failed', page, err);
  }
}
window.switchPage = switchPage;

// ── overview ──────────────────────────────────────────────────
function statusBadge(status) {
  const ps = String(status || '-');
  const lower = ps.toLowerCase();
  const bc = lower.includes('running')
    ? 'bg-ok'
    : (lower.includes('deallocat') || lower.includes('stopped'))
      ? 'bg-err'
      : 'bg-inf';
  return `<span class="badge ${bc}">${esc(ps)}</span>`;
}

function fleetUptimeText(vm) {
  const lower = String(vm.status || '').toLowerCase();
  if (!lower.includes('running')) return '未运行';
  if (typeof vm.uptimeDays === 'number') {
    return vm.uptimeDays <= 0 ? '不足 1 天' : `${vm.uptimeDays} 天`;
  }
  return '-';
}

function renderFleetList(items) {
  const list = $('fleet-list');
  const meta = $('fleet-meta');
  if (!list) return;

  if (!S.accounts.length) {
    list.innerHTML = `
      <div class="empty fleet-empty">
        <h3>还没有账户</h3>
        <p>绑定 Azure 账户后，这里会汇总展示全部虚拟机。</p>
        <button class="btn btn-p" style="margin-top:8px" onclick="switchPage('accounts')">前往账户 / VM</button>
      </div>`;
    if (meta) meta.textContent = '暂无数据';
    return;
  }

  if (!items.length) {
    list.innerHTML = `
      <div class="empty fleet-empty">
        <h3>暂无虚拟机</h3>
        <p>当前所有账户下都还没有机器，或暂时无法拉取。</p>
        <button class="btn btn-s" style="margin-top:8px" onclick="switchPage('accounts')">去账户页</button>
      </div>`;
    if (meta) meta.textContent = `0 台机器 · ${S.accounts.length} 个账户`;
    return;
  }

  list.innerHTML = items.map((vm) => `
    <div class="fleet-row" onclick='openVmView(${jsq(vm.accountId)})'>
      <div style="min-width:0">
        <div class="fleet-name">${esc(vm.name)}</div>
        <div class="fleet-sub">${esc(vm.accountLabel || '-')}</div>
      </div>
      <div style="min-width:0">
        <div style="font-size:13px;font-weight:600">${esc(vm.location || '-')}</div>
        <div class="fleet-sub">${esc(vm.vmSize || '-')}</div>
      </div>
      <div>${statusBadge(vm.status)}</div>
      <div style="font-size:13px;font-weight:650">${esc(fleetUptimeText(vm))}</div>
      <div class="fleet-ip">${esc(vm.publicIp || '-')}</div>
    </div>
  `).join('');

  if (meta) meta.textContent = `${items.length} 台机器 · ${S.accounts.length} 个账户`;
}

async function refreshOverview() {
  if ($('hero-greeting')) $('hero-greeting').textContent = `${greeting()}，总览`;
  if ($('stat-accounts')) $('stat-accounts').textContent = S.accounts.length;

  const list = $('fleet-list');
  const meta = $('fleet-meta');
  if (list && !list.dataset.loaded) {
    list.innerHTML = `<div class="muted" style="padding:28px 18px;font-size:13px">正在汇总全部账户的虚拟机…</div>`;
  }
  if (meta) meta.textContent = '加载中…';

  if (!S.accounts.length) {
    if ($('stat-vms')) $('stat-vms').textContent = '0';
    if ($('stat-running')) $('stat-running').textContent = '0';
    if ($('stat-running-note')) $('stat-running-note').textContent = '停机 0';
    renderFleetList([]);
    return;
  }

  try {
    const data = await api('GET', '/api/overview/vms');
    const items = Array.isArray(data.items) ? data.items : [];
    if ($('stat-accounts')) $('stat-accounts').textContent = data.accountCount ?? S.accounts.length;
    if ($('stat-vms')) $('stat-vms').textContent = data.vmCount ?? items.length;
    if ($('stat-running')) $('stat-running').textContent = data.runningCount ?? 0;
    if ($('stat-running-note')) $('stat-running-note').textContent = `停机 ${data.stoppedCount ?? 0}`;
    renderFleetList(items);
    if (list) list.dataset.loaded = '1';
  } catch (e) {
    if (meta) meta.textContent = '加载失败';
    if (list) {
      list.innerHTML = `<div class="err-box" style="margin:16px">汇总失败：${esc(e.message)}</div>`;
    }
  }
}

// ── accounts ──────────────────────────────────────────────────
function showAccountListView() {
  const acc = S.accounts.find((item) => item.id === S.selectedAccId);
  if (acc) {
    $('account-empty')?.classList.add('hidden');
    $('view-vms')?.classList.remove('hidden');
    showAccountDetailFromCache(acc);
    renderVms();
    // Re-validate in the background; the server-side cache makes this cheap.
    loadVmsFor(acc.id);
  } else {
    S.selectedAccId = null;
    $('view-vms')?.classList.add('hidden');
    $('account-empty')?.classList.remove('hidden');
  }
  renderAccGrid();
}

function showAccList() {
  showAccountListView();
}

/**
 * Single source of truth for a VM's status label + dot colour.
 *
 * Order matters: "VM deallocating" is a *transition*, but the old split helpers
 * matched the "deallocat" prefix before checking "stopping", so a deallocating
 * VM showed the stopped (red) dot while its label read 停止中. Transitional
 * states are matched first here.
 */
function vmStatusView(status) {
  const raw = String(status || '').trim();
  const s = raw.toLowerCase();
  if (!s) return { label: '未知', dot: 'inf', raw };
  if (s.includes('running')) return { label: '运行中', dot: 'ok', raw };
  if (s.includes('creating')) return { label: '创建中', dot: 'warn', raw };
  if (s.includes('starting')) return { label: '启动中', dot: 'warn', raw };
  if (s.includes('updating')) return { label: '更新中', dot: 'warn', raw };
  if (s.includes('stopping') || s.includes('deallocating')) return { label: '停止中', dot: 'warn', raw };
  if (s.includes('stopped') || s.includes('deallocated')) return { label: '已停止', dot: 'err', raw };
  return { label: raw, dot: 'inf', raw };
}

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const end = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(end.getTime())) return null;
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.round((end.getTime() - now.getTime()) / 86400000);
}

function expiryStatClass(dateStr) {
  const days = daysUntil(dateStr);
  if (days === null) return '';
  if (days <= 7) return 'danger';
  if (days <= 30) return 'warn';
  return 'ok';
}

function accountDisplayName(a) {
  return (a?.email || a?.name || '未命名账户').trim();
}

function visibleAccounts() {
  const q = S.accountSearch.trim().toLowerCase();
  let rows = S.accounts.filter((a) => {
    if (!q) return true;
    return [a.name, a.email, a.subscriptionId, a.subscriptionName]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(q));
  });

  if (S.accountSort === 'nameAsc' || S.accountSort === 'nameDesc') {
    rows = [...rows].sort((a, b) => accountDisplayName(a).localeCompare(accountDisplayName(b), 'zh-CN'));
    if (S.accountSort === 'nameDesc') rows.reverse();
  } else if (S.accountSort === 'expiryAsc' || S.accountSort === 'expiryDesc') {
    const ts = (a) => a.expirationDate ? new Date(`${a.expirationDate}T00:00:00`).getTime() : Number.NaN;
    const dated = rows.filter((item) => Number.isFinite(ts(item)));
    const undated = rows.filter((item) => !Number.isFinite(ts(item)));
    dated.sort((a, b) => ts(a) - ts(b) || accountDisplayName(a).localeCompare(accountDisplayName(b), 'zh-CN'));
    if (S.accountSort === 'expiryDesc') dated.reverse();
    rows = [...dated, ...undated];
  }
  return rows;
}

function paintAccountPaneHead() {
  const btn = $('btn-refresh-all-accounts');
  if (!btn) return;
  btn.disabled = S.refreshAllRunning;
  btn.classList.toggle('spinning', S.refreshAllRunning);
}

function accountCardHtml(a) {
  const st = S.accountStats[a.id] || {};
  const title = accountDisplayName(a);
  const subName = st.subscriptionDisplayName || a.subscriptionName || '';
  const state = st.loading ? '' : (st.state ? String(st.state) : (a.subscriptionState || ''));
  const days = daysUntil(a.expirationDate);
  const dayCls = expiryStatClass(a.expirationDate);
  const dayText = days === null ? '未设置到期日'
    : days < 0 ? `已过期 ${Math.abs(days)} 天`
    : days === 0 ? '今天到期'
    : `剩余 ${days} 天`;
  const tip = [title, subName, state, a.expirationDate ? `到期 ${a.expirationDate}` : ''].filter(Boolean).join(' · ');
  return `
    <div class="acc-card${S.selectedAccId === a.id ? ' selected' : ''}" data-account-id="${esc(a.id)}"
         title="${esc(tip)}" onclick='openVmView(${jsq(a.id)})'>
      <span class="acc-drag" draggable="true" title="拖动调整顺序">⠿</span>
      <div style="min-width:0">
        <div class="acc-name">${esc(title)}</div>
        <div class="acc-meta">
          <span class="acc-days ${dayCls}">${esc(dayText)}</span>
        </div>
      </div>
    </div>`;
}

function accountDetailValue(value) {
  return value === null || value === undefined || value === '' ? '-' : String(value);
}

function updateAccountHeader(account) {
  if (!account) return;
  // The VM workspace header is a single global slot: only the current account may write it.
  if (account.id !== S.selectedAccId) return;
  const detail = S.accountDetails[account.id] || account;
  const st = S.accountStats[account.id] || {};
  const title = accountDisplayName(detail);
  const subscriptionName = detail.subscriptionName || st.subscriptionDisplayName || '未获取';
  const subscriptionState = detail.subscriptionState || st.state || '未获取';
  $('vm-acc-title').textContent = title;
  $('vm-acc-sub').textContent = [
    subscriptionName,
    subscriptionState,
    detail.expirationDate || null,
  ].filter(Boolean).join(' · ') || 'Azure 订阅';
}

function mergedAccountDetail(account) {
  if (!account) return null;
  const saved = S.accountDetails[account.id] || {};
  const st = S.accountStats[account.id] || {};
  return {
    ...account,
    ...saved,
    subscriptionName: saved.subscriptionName || st.subscriptionDisplayName || account.subscriptionName || '未获取',
    subscriptionState: saved.subscriptionState || st.state || account.subscriptionState || '未获取',
    quotaTier: saved.quotaTier || st.quotaTier || account.quotaTier || '未获取',
    costWarning: saved.costWarning || account.costWarning || st.warning || '',
  };
}

function renderAccountDetailsModal(account) {
  if (!account) return;
  // Never let a late response repaint the modal for a different account.
  if (S.detailsAccountId && account.id !== S.detailsAccountId) return;
  const detail = mergedAccountDetail(account);
  const modal = $('mo-account-details');
  if (!modal) return;
  const secret = detail.clientSecret || '尚未读取';
  const secretText = S.revealedAccountSecret ? secret : '••••••••••••';
  const currency = detail.costCurrency ? ` ${detail.costCurrency}` : '';
  const mtd = detail.costMtd ?? '未获取';
  const acc = detail.costAcc ?? '未获取';
  const updatedAt = detail.costUpdatedAt ? new Date(detail.costUpdatedAt).toLocaleString() : '未查询';
  const rawWarning = detail.costWarning || '';
  const warning = rawWarning.length > 180 ? `${rawWarning.slice(0, 180)}…` : rawWarning;
  const detailItems = [
    ['账户名称', accountDisplayName(detail)],
    ['邮箱', detail.email || accountDisplayName(detail)],
    ['订阅名称', detail.subscriptionName || '未获取'],
    ['订阅状态', detail.subscriptionState || '未获取'],
    ['Client ID', detail.clientId || '-'],
    ['Tenant ID', detail.tenantId || '-'],
    ['Subscription ID', detail.subscriptionId || '-'],
    ['订阅到期', detail.expirationDate || '未设置'],
  ];
  $('detail-modal-title').textContent = accountDisplayName(detail);
  $('detail-modal-sub').textContent = [detail.subscriptionName, detail.subscriptionState].filter(Boolean).join(' · ') || 'Azure 账户';
  $('detail-modal-loading')?.classList.add('hidden');
  $('detail-modal-content').innerHTML = `
    <div class="account-detail-grid">
      ${detailItems.map(([key, value]) => `
        <div class="account-detail-item">
          <div class="account-detail-key">${esc(key)}</div>
          <div class="account-detail-value">${esc(value)}</div>
        </div>`).join('')}
      <div class="account-detail-item" style="grid-column:1/-1">
        <div class="account-detail-key">Client Secret</div>
        <div class="account-detail-value secret" id="detail-secret-value">${esc(secretText)}</div>
        <div class="account-detail-actions">
          <button class="btn btn-s btn-sm" type="button" id="btn-toggle-account-secret">${S.revealedAccountSecret ? '隐藏' : '显示'}</button>
          <button class="btn btn-s btn-sm" type="button" id="btn-copy-account-secret">复制密钥</button>
        </div>
      </div>
    </div>
    <div class="section-title-row" style="margin-top:16px">
      <span>成本与 AI 配额</span>
      <span class="muted small">更新于 ${esc(updatedAt)}</span>
    </div>
    <div class="account-detail-grid" style="margin-top:8px">
      <div class="account-detail-item"><div class="account-detail-key">本月消费</div><div class="account-detail-value">${esc(mtd)}${esc(currency)}</div></div>
      <div class="account-detail-item"><div class="account-detail-key">累计消费</div><div class="account-detail-value">${esc(acc)}${esc(currency)}</div></div>
      <div class="account-detail-item" style="grid-column:1/-1"><div class="account-detail-key">AI 配额层级</div><div class="account-detail-value">${esc(detail.quotaTier || '未获取')}</div></div>
    </div>
    ${warning ? `<div class="err-box" style="margin-top:10px">${esc(warning)}</div>` : ''}`;
}

function showAccountDetailFromCache(account) {
  updateAccountHeader(account);
}

async function loadAccountDetail(accountId) {
  if (!accountId) return null;
  try {
    const detail = await api('GET', `/api/accounts/${accountId}/detail`);
    S.accountDetails[accountId] = detail;
    const account = S.accounts.find((item) => item.id === accountId);
    if (account) {
      account.subscriptionName = detail.subscriptionName || account.subscriptionName;
      account.subscriptionState = detail.subscriptionState || account.subscriptionState;
      account.quotaTier = detail.quotaTier || account.quotaTier;
      account.costMtd = detail.costMtd;
      account.costAcc = detail.costAcc;
      account.costHistory = detail.costHistory;
      account.costCurrency = detail.costCurrency;
      account.costUpdatedAt = detail.costUpdatedAt;
      account.costWarning = detail.costWarning;
    }
    if (S.selectedAccId === accountId && !$('mo-account-details')?.classList.contains('hidden')) {
      renderAccountDetailsModal(account || detail);
    }
    return detail;
  } catch (e) {
    toast(`加载账户详情失败: ${e.message}`, 'error');
    return null;
  }
}

function closeAccountDetailsModal() {
  S.revealedAccountSecret = false;
  // Delete by the account the modal belongs to, not by whatever is selected now,
  // so a revealed plaintext secret does not linger in memory after a switch.
  if (S.detailsAccountId) delete S.accountDetails[S.detailsAccountId];
  S.detailsAccountId = null;
  if ($('detail-modal-content')) $('detail-modal-content').innerHTML = '';
  closeModal('mo-account-details');
}

async function openAccountDetails(accountId) {
  const account = S.accounts.find((item) => item.id === accountId);
  if (!account) return;
  S.revealedAccountSecret = false;
  S.detailsAccountId = accountId;
  if (S.accountDetails[accountId]) {
    $('detail-modal-loading')?.classList.add('hidden');
    $('detail-modal-content').innerHTML = '';
    renderAccountDetailsModal(account);
  } else {
    $('detail-modal-loading')?.classList.remove('hidden');
    $('detail-modal-content').innerHTML = '';
  }
  openModal('mo-account-details');
  const detail = await loadAccountDetail(accountId);
  if (detail) {
    renderAccountDetailsModal(account);
  } else {
    $('detail-modal-loading')?.classList.add('hidden');
    $('detail-modal-content').innerHTML = '<div class="err-box">账户详情加载失败，请关闭后重试。</div>';
  }
}

async function toggleAccountSecret() {
  const accountId = S.detailsAccountId;
  if (!accountId) return;
  if (!S.accountDetails[accountId]) await loadAccountDetail(accountId);
  S.revealedAccountSecret = !S.revealedAccountSecret;
  renderAccountDetailsModal(S.accounts.find((item) => item.id === accountId));
}
window.toggleAccountSecret = toggleAccountSecret;

async function copyAccountSecret() {
  const detail = S.accountDetails[S.detailsAccountId];
  if (!detail?.clientSecret) return toast('暂未读取到密钥', 'error');
  await copyText(detail.clientSecret);
}
window.copyAccountSecret = copyAccountSecret;

async function copyAccountDetails(accountId) {
  let detail = S.accountDetails[accountId] || S.accounts.find((item) => item.id === accountId);
  if (detail && detail.clientSecret === undefined) detail = await loadAccountDetail(accountId) || detail;
  if (!detail) return;
  const lines = [
    `账户名称: ${accountDisplayName(detail)}`,
    `邮箱: ${detail.email || ''}`,
    `订阅名称: ${detail.subscriptionName || ''}`,
    `订阅状态: ${detail.subscriptionState || ''}`,
    `Subscription ID: ${detail.subscriptionId || ''}`,
    `Client ID: ${detail.clientId || ''}`,
    `Client Secret: ${detail.clientSecret || ''}`,
    `Tenant ID: ${detail.tenantId || ''}`,
    `订阅到期: ${detail.expirationDate || ''}`,
  ];
  await copyText(lines.join('\n'));
}
window.copyAccountDetails = copyAccountDetails;

async function refreshAccountInfo(accountId) {
  if (!accountId) return;
  await Promise.all([
    loadAccountStats(accountId, { force: true }),
    loadAccountInsights(accountId, true),
  ]);
  if (accountId !== S.selectedAccId) return;
  const account = S.accounts.find((item) => item.id === accountId);
  updateAccountHeader(account);
  if (!$('mo-account-details')?.classList.contains('hidden')) {
    await loadAccountDetail(accountId);
    renderAccountDetailsModal(account);
  }
}

function paintAccGrid() {
  const g = $('acc-grid');
  if (!g) return;
  // Repainting mid-drag destroys the drag source node and strands the dragend handler.
  if (S.dragAccountId) return;
  paintAccountPaneHead();
  const count = $('account-list-count');
  if (count) count.textContent = String(visibleAccounts().length);
  if (!S.accounts.length) {
    g.innerHTML = `
      <div class="empty" style="grid-column:1/-1">
        <h3>还没有 Azure 账户</h3>
        <p>点击上方「+ 添加」绑定应用注册凭据，即可管理该订阅下的虚拟机。</p>
      </div>`;
    return;
  }
  const rows = visibleAccounts();
  if (!rows.length) {
    g.innerHTML = `<div class="empty" style="grid-column:1/-1"><h3>没有匹配的账户</h3><p>请调整搜索关键字。</p></div>`;
    return;
  }
  g.innerHTML = rows.map(accountCardHtml).join('');
}

function renderAccGrid() {
  paintAccGrid();
  visibleAccounts().forEach(a => queueAccountStats(a.id));
}

// Each account card costs three Azure calls. Fanning out one request per account
// at once saturates the server's egress and ARM quota, which is what made VM
// switches feel stalled. Keep the burst bounded.
const ACCOUNT_STATS_CONCURRENCY = 3;
let statsRunning = 0;
const statsQueue = [];

function queueAccountStats(accountId) {
  if (!accountId) return;
  if (!statsQueue.includes(accountId)) statsQueue.push(accountId);
  pumpAccountStats();
}

function pumpAccountStats() {
  while (statsRunning < ACCOUNT_STATS_CONCURRENCY && statsQueue.length) {
    const accountId = statsQueue.shift();
    statsRunning += 1;
    Promise.resolve(loadAccountStats(accountId)).finally(() => {
      statsRunning -= 1;
      pumpAccountStats();
    });
  }
}

async function loadAccountStats(accountId, { force = false } = {}) {
  if (!accountId) return;
  const prev = S.accountStats[accountId];
  if (prev?.loading) return;
  if (!force && prev && !prev.error && typeof prev.vmCount === 'number') return;
  S.accountStats[accountId] = { ...(prev || {}), loading: true, error: null };
  paintAccGrid();
  try {
    const d = await api('GET', `/api/accounts/${accountId}/overview`);
    S.accountStats[accountId] = {
      loading: false,
      error: d.vmError || d.subscriptionError || null,
      vmCount: d.vmCount ?? 0,
      subscriptionDisplayName: d.subscriptionDisplayName || '',
      state: d.state || '',
      quotaTier: d.quotaTier || '',
      warning: d.vmError || d.subscriptionError || '',
    };
    const account = S.accounts.find((item) => item.id === accountId);
    if (account) {
      account.subscriptionName = d.subscriptionDisplayName || account.subscriptionName;
      account.subscriptionState = d.state || account.subscriptionState;
      account.quotaTier = d.quotaTier || account.quotaTier;
    }
  } catch (e) {
    S.accountStats[accountId] = {
      loading: false,
      error: e.message || 'failed',
      vmCount: prev?.vmCount,
      subscriptionDisplayName: prev?.subscriptionDisplayName,
      state: prev?.state,
      quotaTier: prev?.quotaTier,
    };
  }
  const account = S.accounts.find((item) => item.id === accountId);
  if (S.selectedAccId === accountId) {
    updateAccountHeader(account);
    if (!$('mo-account-details')?.classList.contains('hidden')) renderAccountDetailsModal(account);
  }
  paintAccGrid();
}

function updateAccountSortLabels() {
  const nameBtn = $('btn-sort-account-name');
  const expiryBtn = $('btn-sort-account-expiry');
  if (nameBtn) nameBtn.textContent = S.accountSort === 'nameAsc' ? '名称 ↑' : S.accountSort === 'nameDesc' ? '名称 ↓' : '名称排序';
  if (expiryBtn) expiryBtn.textContent = S.accountSort === 'expiryAsc' ? '到期 ↑' : S.accountSort === 'expiryDesc' ? '到期 ↓' : '到期排序';
}

function cycleAccountSort(kind) {
  const nameStates = ['manual', 'nameAsc', 'nameDesc'];
  const expiryStates = ['manual', 'expiryAsc', 'expiryDesc'];
  const states = kind === 'name' ? nameStates : expiryStates;
  const currentIndex = states.indexOf(S.accountSort);
  S.accountSort = states[(currentIndex + 1 + states.length) % states.length];
  updateAccountSortLabels();
  renderAccGrid();
}

async function importAccountsFromFile(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const result = await api('POST', '/api/accounts/import', { data });
    S.accounts = await api('GET', '/api/accounts');
    renderAccGrid();
    refreshOverview();
    const skipped = Array.isArray(result.skipped) && result.skipped.length
      ? `，跳过 ${result.skipped.length} 个：${result.skipped.map((item) => `${item.name}(${item.reason})`).join('；')}`
      : '';
    toast(`已导入 ${result.imported?.length || 0} 个账户${skipped}`, result.skipped?.length ? 'info' : 'success');
  } catch (e) {
    toast(`账号导入失败: ${e.message}`, 'error');
  } finally {
    const input = $('account-import-file');
    if (input) input.value = '';
  }
}

async function exportAccounts(includeSecrets = false) {
  try {
    const response = await fetch(`/api/accounts/export?includeSecrets=${includeSecrets ? 'true' : 'false'}`);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || '导出失败');
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `azure-accounts-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    closeModal('mo-export-accounts');
    toast(includeSecrets ? '已导出完整账号配置' : '已导出脱敏账号配置', 'success');
  } catch (e) {
    toast(`账号导出失败: ${e.message}`, 'error');
  }
}

function handleAccountDrop(targetId) {
  const draggedId = S.dragAccountId;
  S.dragAccountId = null;
  if (!draggedId || !targetId || draggedId === targetId) return;
  const rows = [...S.accounts];
  const from = rows.findIndex((item) => item.id === draggedId);
  const to = rows.findIndex((item) => item.id === targetId);
  if (from < 0 || to < 0) return;
  const [moved] = rows.splice(from, 1);
  rows.splice(to, 0, moved);
  S.accounts = rows;
  S.accountSort = 'manual';
  updateAccountSortLabels();
  paintAccGrid();
  api('POST', '/api/accounts/reorder', { accountIds: rows.map((item) => item.id) })
    .then(() => toast('账户顺序已保存', 'success'))
    .catch((e) => toast(`账户排序保存失败: ${e.message}`, 'error'));
}

// ── insight bar notices ───────────────────────────────────────
// Warnings such as "累计消费刷新失败，已沿用上一次成功结果" are transient by design:
// they describe one failed refresh, not a permanent property of the account. They
// are kept in UI state (never re-derived from the persisted costWarning) and
// auto-dismiss, so reloading the page does not bring them back.
const INSIGHT_NOTICE_TTL_MS = 6000;
let insightNotice = null; // { accountId, message }
let insightNoticeTimer = null;

function showInsightNotice(accountId, message, ttlMs = INSIGHT_NOTICE_TTL_MS) {
  if (!message) {
    clearInsightNotice(accountId);
    return;
  }
  insightNotice = { accountId, message };
  renderAccountInsights(accountId);
  if (insightNoticeTimer) clearTimeout(insightNoticeTimer);
  insightNoticeTimer = setTimeout(() => {
    insightNoticeTimer = null;
    const current = insightNotice?.accountId;
    insightNotice = null;
    if (current && current === S.selectedAccId) renderAccountInsights(current);
  }, ttlMs);
}

function clearInsightNotice(accountId) {
  if (insightNoticeTimer) {
    clearTimeout(insightNoticeTimer);
    insightNoticeTimer = null;
  }
  if (!accountId || insightNotice?.accountId === accountId) insightNotice = null;
}

function renderAccountInsights(accountId) {
  const host = $('account-insights');
  if (!host) return;
  // The insight bar is a single global slot: only the current account may write it.
  if (accountId !== S.selectedAccId) return;
  const account = S.accounts.find((item) => item.id === accountId);
  const data = S.accountInsights[accountId] || {};
  const loading = data.loading ? '查询中…' : '';
  const currency = data.currency || account?.costCurrency || '';
  const unit = currency ? ` ${currency}` : '';
  const mtd = data.mtd ?? account?.costMtd;
  const acc = data.acc ?? account?.costAcc;
  const quota = data.quotaTier || account?.quotaTier || '未获取';
  const notice = insightNotice?.accountId === accountId ? insightNotice.message : '';
  const mtdText = mtd !== null && mtd !== undefined && mtd !== ''
    ? `${mtd}${unit}`
    : (loading || '未获取');
  const accText = acc !== null && acc !== undefined && acc !== ''
    ? `${acc}${unit}`
    : '未获取';
  const updateText = account?.costUpdatedAt
    ? new Date(account.costUpdatedAt).toLocaleString()
    : (loading ? '查询中…' : '尚未查询');
  host.innerHTML = `
    <div class="insight-bar">
      <span class="ib"><i>AI 配额</i><b>${esc(quota)}</b></span>
      <span class="ib"><i>本月</i><b>${esc(mtdText)}</b></span>
      <span class="ib"><i>累计</i><b>${esc(accText)}</b></span>
      <span class="ib ib-time"><i>消费更新</i><b>${esc(updateText)}</b></span>
      <button class="ib-refresh${S.summaryRefreshing ? ' spinning' : ''}" type="button" id="btn-refresh-summary"
              title="刷新 AI 配额与本月/累计消费" aria-label="刷新 AI 配额与消费"
              ${S.summaryRefreshing ? 'disabled' : ''}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M21 12a9 9 0 1 1-2.64-6.36" />
          <path d="M21 3v6h-6" />
        </svg>
      </button>
    </div>
    ${notice ? `<div class="insight-warning">${esc(notice)}</div>` : ''}`;
}
window.openAccountDetails = openAccountDetails;

// Account ids with an insight request genuinely in flight. The display flag
// (`loading`) is not usable as a lock: the account switch sets it optimistically
// before calling in, so guarding on it made every load bail out silently.
const insightLoads = new Set();

async function loadAccountInsights(accountId, force = false) {
  if (!accountId) return;
  if (insightLoads.has(accountId)) return;
  const previous = S.accountInsights[accountId] || {};
  if (!force && previous.loaded) return;
  const account = S.accounts.find((item) => item.id === accountId);
  const updatedAt = account?.costUpdatedAt ? new Date(account.costUpdatedAt).getTime() : 0;
  if (!force && updatedAt && Date.now() - updatedAt < 10 * 60 * 1000) {
    S.accountInsights[accountId] = {
      ...previous,
      mtd: account?.costMtd,
      acc: account?.costAcc,
      history: account?.costHistory,
      currency: account?.costCurrency,
      loaded: true,
      loading: false,
      warning: null,
    };
    renderAccountInsights(accountId);
    return;
  }
  S.accountInsights[accountId] = { ...previous, loading: true, warning: '' };
  insightLoads.add(accountId);
  renderAccountInsights(accountId);
  try {
    const data = await api('GET', `/api/accounts/${accountId}/cost`);
    S.accountInsights[accountId] = { ...data, loading: false, loaded: true };
    if (account) {
      account.costMtd = data.mtd;
      account.costAcc = data.acc;
      account.costHistory = data.history;
      account.costCurrency = data.currency;
      account.costUpdatedAt = data.queriedAt;
      account.costWarning = data.warning || null;
    }
    // Surface the fallback notice briefly; it is not a permanent condition.
    showInsightNotice(accountId, data.warning || null);
  } catch (e) {
    S.accountInsights[accountId] = { ...previous, loading: false, warning: e.message };
    toast(`消费查询失败: ${e.message}`, 'error');
  } finally {
    insightLoads.delete(accountId);
  }
  renderAccountInsights(accountId);
  updateAccountHeader(account);
  if (!$('mo-account-details')?.classList.contains('hidden')) renderAccountDetailsModal(account);
  paintAccGrid();
}

/** Quota tier only: one lightweight ARM call. Caller decides how to render. */
async function refreshQuotaTier(accountId) {
  const id = accountId || S.selectedAccId;
  if (!id) return null;
  const payload = await api('GET', `/api/accounts/${id}/quota`);
  const quotaTier = payload?.items?.quotaTier || '未获取';
  // Both sources feed the label, so update them together to avoid one winning.
  S.accountInsights[id] = { ...(S.accountInsights[id] || {}), quotaTier };
  const account = S.accounts.find((a) => a.id === id);
  if (account) account.quotaTier = quotaTier;
  // An open details modal reads quotaTier from S.accountDetails first, so it
  // would otherwise keep showing the pre-refresh value.
  if (S.accountDetails[id]) S.accountDetails[id] = { ...S.accountDetails[id], quotaTier };
  if (S.detailsAccountId === id && !$('mo-account-details')?.classList.contains('hidden')) {
    renderAccountDetailsModal(account || S.accountDetails[id]);
  }
  return quotaTier;
}

/**
 * Refresh everything the insight bar shows: AI quota plus month-to-date,
 * accumulated and historical spend. Deliberately does not touch the VM list.
 */
async function refreshAccountSummary(accountId) {
  const id = accountId || S.selectedAccId;
  if (!id || S.summaryRefreshing) return;
  S.summaryRefreshing = true;
  renderAccountInsights(id);
  try {
    const [costResult, quotaResult] = await Promise.allSettled([
      loadAccountInsights(id, true),
      refreshQuotaTier(id),
    ]);
    if (id !== S.selectedAccId) return;
    const failures = [];
    if (costResult.status === 'rejected') failures.push(`消费：${costResult.reason?.message || costResult.reason}`);
    if (quotaResult.status === 'rejected') failures.push(`配额：${quotaResult.reason?.message || quotaResult.reason}`);
    // A degraded (cached/unsupported) cost result already raises its own notice
    // inside loadAccountInsights; only request-level failures are reported here.
    if (failures.length) showInsightNotice(id, `刷新失败 — ${failures.join('；')}`);
    else toast('AI 配额与消费已更新', 'success');
  } finally {
    S.summaryRefreshing = false;
    if (id === S.selectedAccId) {
      renderAccountInsights(id);
      paintAccGrid();
    }
  }
}
window.refreshAccountSummary = refreshAccountSummary;

/** Refresh every account's VMs, subscription/quota and cost in one action. */
async function refreshAllAccounts() {
  if (S.refreshAllRunning) return;
  S.refreshAllRunning = true;
  paintAccGrid();
  paintAccountPaneHead();
  toast('正在刷新全部账户的订阅、配额、消费与虚拟机…', 'info');
  try {
    const result = await api('POST', '/api/accounts/refresh-all');
    // Re-read the list so every card shows the values the server just stored.
    S.accounts = await api('GET', '/api/accounts');
    for (const row of result?.results || []) {
      S.accountStats[row.accountId] = {
        loading: false,
        error: row.errors?.[0] || null,
        vmCount: typeof row.vmCount === 'number' ? row.vmCount : undefined,
        subscriptionDisplayName: row.subscriptionDisplayName || '',
        state: row.state || '',
        quotaTier: row.quotaTier || '',
        warning: '',
      };
      S.vmsCache.delete(row.accountId); // the server list changed; re-read it lazily
    }
    if (S.selectedAccId) {
      const acc = S.accounts.find((a) => a.id === S.selectedAccId);
      if (acc) {
        updateAccountHeader(acc);
        renderAccountInsights(acc.id);
        loadVmsFor(acc.id, { force: true });
      }
    }
    refreshOverview();
    const failedCount = result?.failed?.length || 0;
    if (failedCount) {
      const names = (result.failed || []).map((row) => row.name).filter(Boolean).slice(0, 3).join('、');
      toast(`已刷新 ${result?.refreshed ?? 0}/${result?.total ?? 0} 个账户；${failedCount} 个部分失败：${names}`, 'info');
    } else {
      toast(`已刷新全部 ${result?.total ?? 0} 个账户`, 'success');
    }
  } catch (e) {
    toast(`刷新全部账户失败：${e.message}`, 'error');
  } finally {
    S.refreshAllRunning = false;
    paintAccGrid();
    paintAccountPaneHead();
  }
}
window.refreshAllAccounts = refreshAllAccounts;

async function openVmView(accId, e) {
  if (e) e.stopPropagation();
  S.selectedAccId = accId;
  S.activeVTab = 'vms';
  S.vmSearch = '';
  S.vmStatusFilter = 'all';
  if ($('vm-search')) $('vm-search').value = '';
  if ($('vm-status-filter')) $('vm-status-filter').value = 'all';
  document.querySelectorAll('.tab[data-vtab]').forEach(x => {
    x.classList.toggle('active', x.dataset.vtab === 'vms');
  });
  $('vtab-vms')?.classList.remove('hidden');
  $('vtab-tasks')?.classList.add('hidden');

  const acc = S.accounts.find(a => a.id === accId);
  if (!acc) return;
  $('account-empty')?.classList.add('hidden');
  $('view-vms')?.classList.remove('hidden');

  // Anything scoped to the previous account must not survive the switch.
  abortVmsReads();
  clearInsightNotice();
  S.summaryRefreshing = false;
  S.vmsLoading = !S.vmsCache.has(accId);
  S.regions = [];
  S.pendingAction = null;
  S.createVmAccountId = accId;
  closeModal('mo-confirm');
  closeModal('mo-create-vm');
  closeAccountDetailsModal();

  renderVms();
  S.accountInsights[accId] = { ...(S.accountInsights[accId] || {}), loading: true };
  showAccountDetailFromCache(acc);
  renderAccountInsights(accId);
  paintAccGrid();

  // Ensure accounts page is visible.
  PAGES.forEach(p => {
    $(`pg-${p}`)?.classList.toggle('hidden', p !== 'accounts');
    const ni = $(`ni-${p}`);
    if (ni) ni.classList.toggle('active', p === 'accounts');
  });
  S.activePage = 'accounts';

  // The session cookie is UI memory only ("last account I viewed"): it no longer
  // decides whose VMs are fetched, so there is nothing to order against. The
  // write runs in parallel with the data reads instead of gating them.
  const rememberLastViewed = api('POST', '/api/session', { accountId: accId }).catch((err) => {
    console.warn('[ui] failed to persist last-viewed account', err);
  });

  await Promise.all([
    rememberLastViewed,
    loadVmsFor(accId),
    loadAccountStats(accId),
    loadAccountInsights(accId),
  ]);
}
window.openVmView = openVmView;

function backToAccountList() {
  S.selectedAccId = null;
  abortVmsReads();
  api('DELETE', '/api/session').catch(() => {});
  $('view-vms')?.classList.add('hidden');
  $('account-empty')?.classList.remove('hidden');
  paintAccGrid();
}

// ── VMs ───────────────────────────────────────────────────────
async function refreshWorkspace() {
  if (!S.selectedAccId) return;
  await Promise.allSettled([loadVmsFor(S.selectedAccId, { force: true }), refreshAccountInfo(S.selectedAccId)]);
  toast('已刷新');
}

/** The only place the VM table gets its data: the slot of the current account. */
function currentVmsEntry() {
  return S.selectedAccId ? S.vmsCache.get(S.selectedAccId) || null : null;
}

function abortVmsReads() {
  S.vmsReads.forEach((controller) => controller.abort());
  S.vmsReads.clear();
}

async function loadVmsFor(accId, { force = false } = {}) {
  if (!accId) return;
  S.vmsReads.get(accId)?.abort();
  const controller = new AbortController();
  S.vmsReads.set(accId, controller);

  if (!S.vmsCache.has(accId)) {
    S.vmsLoading = true;
    renderVms();
  }
  try {
    const query = force ? '?refresh=1' : '';
    const payload = await api('GET', `/api/accounts/${accId}/vms${query}`, undefined, {
      signal: controller.signal,
    });
    // This response is about `accId`; drop it if the user has moved on.
    if (accId !== S.selectedAccId) return;
    S.vmsCache.set(accId, {
      vms: Array.isArray(payload?.items) ? payload.items : [],
      at: Date.parse(payload?.fetchedAt || '') || Date.now(),
      error: null,
      code: null,
      stale: payload?.stale === true,
      warning: typeof payload?.warning === 'string' ? payload.warning : null,
      cacheAgeMs: Number.isFinite(payload?.cacheAgeMs) ? payload.cacheAgeMs : 0,
    });
  } catch (e) {
    if (isAbortError(e) || accId !== S.selectedAccId || e.stale) return;
    const previous = S.vmsCache.get(accId);
    S.vmsCache.set(accId, {
      vms: previous?.vms ?? [],
      at: previous?.at ?? 0,
      error: e.message,
      code: e.code || null,
      stale: previous?.stale ?? false,
      warning: previous?.warning ?? null,
      cacheAgeMs: previous?.cacheAgeMs ?? 0,
    });
  } finally {
    if (S.vmsReads.get(accId) === controller) S.vmsReads.delete(accId);
    if (accId === S.selectedAccId) {
      S.vmsLoading = false;
      renderVms();
    }
  }
}

/**
 * Uptime for a running VM, or a semantic "not started" — `-` would read as
 * "data missing", which is a different thing from "this machine is switched off".
 */
function formatUptime(vm) {
  const ps = String(vm.status || '').toLowerCase();
  if (!ps.includes('running')) return '未开机';

  let days = typeof vm.uptimeDays === 'number' ? vm.uptimeDays : null;
  if (days === null && vm.timeCreated) {
    const start = new Date(vm.timeCreated);
    if (!Number.isNaN(start.getTime())) {
      days = Math.max(0, Math.floor((Date.now() - start.getTime()) / 86400000));
    }
  }
  if (days === null) return '—';
  return days <= 0 ? '不足 1 天' : `${days} 天`;
}

function filteredVms() {
  const query = S.vmSearch.trim().toLowerCase();
  return (currentVmsEntry()?.vms || []).filter((vm) => {
    const status = String(vm.status || '').toLowerCase();
    const matchesStatus = S.vmStatusFilter === 'all'
      || (S.vmStatusFilter === 'running' && status.includes('running'))
      || (S.vmStatusFilter === 'stopped' && (status.includes('stopped') || status.includes('deallocat')));
    if (!matchesStatus) return false;
    if (!query) return true;
    return [vm.name, vm.resourceGroup, vm.publicIp, vm.location, vm.vmSize]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query));
  });
}

function renderVmsStaleNote(entry) {
  const host = $('vm-stale-note');
  if (!host) return;
  const text = entry?.warning
    || (entry?.stale ? `数据可能不是最新（${Math.round((entry.cacheAgeMs || 0) / 1000)} 秒前）` : '');
  if (!text) {
    host.classList.add('hidden');
    host.textContent = '';
    return;
  }
  host.classList.remove('hidden');
  host.innerHTML = `<div class="err-box" style="margin-bottom:10px">${esc(text)}</div>`;
}

/** One VM = one row: identity on top, parameters below, ⋯ on the identity line. */
function vmRowHtml(vm, index) {
  const st = vmStatusView(vm.status);
  const uptime = formatUptime(vm);
  const hasIp = Boolean(vm.publicIp) && vm.publicIp !== 'N/A';
  const ipText = hasIp ? vm.publicIp : '';
  const alloc = !hasIp ? ''
    : vm.ipAllocationMethod === 'Static' ? '<span class="vm-alloc static">静态</span>'
    : vm.ipAllocationMethod === 'Dynamic' ? '<span class="vm-alloc dynamic">动态</span>'
    : '<span class="vm-alloc unknown" title="Azure 未返回分配方式">未知</span>';
  const label = [
    vm.name, st.label, vm.location, vm.vmSize, `开机时间 ${uptime}`,
    hasIp ? `公网 IP ${ipText}` : '无公网 IP',
  ].filter(Boolean).join('，');
  return `
    <article class="vm-row" role="listitem" aria-label="${esc(label)}">
      <div class="vm-line1">
        <span class="vm-state ${st.dot}" title="${esc(st.raw || st.label)}">
          <span class="dot ${st.dot}" aria-hidden="true"></span>${esc(st.label)}
        </span>
        <h3 class="vm-name" title="${esc(vm.name)}">${esc(vm.name)}</h3>
        ${vm.location ? `<span class="vm-region" title="区域">${esc(vm.location)}</span>` : ''}
        <button class="ops-trigger" type="button" data-vm-ops="${index}"
                aria-label="操作" aria-haspopup="menu" aria-expanded="false" aria-controls="vm-ops-menu">
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/>
          </svg>
        </button>
      </div>
      <div class="vm-line2">
        <span class="vm-kv size"><i>规格</i><b class="mono" title="${esc(vm.vmSize || '')}">${esc(vm.vmSize || '—')}</b></span>
        ${vm.diskSizeGb ? `<span class="vm-sep" aria-hidden="true"></span>
        <span class="vm-kv disk"><i>系统盘</i><b>${esc(String(vm.diskSizeGb))} GB</b></span>` : ''}
        <span class="vm-sep" aria-hidden="true"></span>
        <span class="vm-kv"><i>开机时间</i><b>${esc(uptime)}</b></span>
        <span class="vm-kv ip"><i>公网 IP</i>${
          hasIp ? `<b class="mono" title="${esc(ipText)}">${esc(ipText)}</b>` : '<b class="vm-none">无</b>'
        }${alloc}</span>
      </div>
    </article>`;
}

function renderVms() {
  const host = $('vm-list');
  if (!host) return;
  const rows = filteredVms();
  S.renderedVms = rows;
  closeVmOpsMenu(true);

  const entry = currentVmsEntry();
  const known = !!entry;
  const items = entry?.vms || [];
  renderVmsStaleNote(entry);

  /** State boxes are not lists, so the list role has to travel with the content. */
  const stateBox = (html) => {
    host.className = 'vm-state-box';
    host.removeAttribute('role');
    host.innerHTML = html;
  };

  if (!known || (S.vmsLoading && !items.length)) {
    host.className = 'vm-list';
    host.removeAttribute('role');
    host.innerHTML = `<div class="vm-loading">
      <span class="vm-spinner" aria-hidden="true"></span>正在加载虚拟机…
    </div>`;
    return;
  }

  // A failed fetch must never be rendered as "this subscription has no VMs".
  if (entry.error && !items.length) {
    stateBox(`<div class="err-box" style="border:none;background:transparent;padding:20px">
      <strong>${entry.code === 'azure_timeout' ? 'Azure 查询超时' : '虚拟机列表加载失败'}</strong>
      <div class="muted small" style="margin-top:6px">${esc(entry.error)}</div>
      <div style="margin-top:10px"><button class="btn btn-p" type="button" onclick="refreshWorkspace()">重试</button></div>
    </div>`);
    return;
  }

  if (!items.length) {
    // "No VMs yet" is the highest-frequency state for a ≤2-VM account, so the
    // create action lives here instead of pointing at the toolbar.
    stateBox(`<div class="empty" style="border:none;background:transparent">
      <h3>此订阅下暂无虚拟机</h3>
      <p>创建一台即可开始管理。</p>
      <button class="btn btn-p" style="margin-top:8px" type="button" onclick="openCreateVmDialog()">创建虚拟机</button>
    </div>`);
    return;
  }

  if (!rows.length) {
    stateBox(`<div class="empty" style="border:none;background:transparent">
      <h3>没有匹配的虚拟机</h3><p>请调整搜索或状态筛选。</p>
    </div>`);
    return;
  }

  host.className = 'vm-list';
  host.setAttribute('role', 'list');
  host.setAttribute('aria-label', '虚拟机列表');
  host.innerHTML = rows.map((vm, index) => vmRowHtml(vm, index)).join('');
}

let vmOpsAnchor = null;
let vmOpsOpenedAt = 0;

// 刚刚打开时忽略滚动/点击关闭，避免 macOS 触控板惯性滚动把菜单立刻关掉。
function closeVmOpsMenu(force = false) {
  if (!force && vmOpsAnchor && Date.now() - vmOpsOpenedAt < 160) return;
  const menu = $('vm-ops-menu');
  if (menu) {
    menu.classList.add('hidden');
    menu.innerHTML = '';
  }
  vmOpsAnchor?.classList.remove('active');
  vmOpsAnchor?.setAttribute('aria-expanded', 'false');
  vmOpsAnchor = null;
}

function openVmOpsMenu(btn) {
  const menu = $('vm-ops-menu');
  if (!menu) return;
  const vm = S.renderedVms[Number(btn.getAttribute('data-vm-ops'))];
  if (!vm) return;

  const wasOpen = vmOpsAnchor === btn && !menu.classList.contains('hidden');
  closeVmOpsMenu(true);
  if (wasOpen) return;

  const items = [
    { key: 'start', label: '启动' },
    { key: 'stop', label: '停止' },
    { key: 'restart', label: '重启' },
    { key: 'ip', label: '更换公网 IP' },
    { key: 'delete', label: '删除资源组', danger: true, separator: true },
  ];
  for (const item of items) {
    if (item.separator) menu.appendChild(document.createElement('div')).className = 'ops-sep';
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `ops-item${item.danger ? ' danger' : ''}`;
    el.textContent = item.label;
    el.setAttribute('role', 'menuitem');
    el.addEventListener('click', () => {
      closeVmOpsMenu(true);
      if (item.key === 'ip') changeIp(vm.resourceGroup, vm.name);
      else vmAction(item.key, vm.resourceGroup, vm.name);
    });
    menu.appendChild(el);
  }

  vmOpsAnchor = btn;
  vmOpsOpenedAt = Date.now();
  btn.classList.add('active');
  btn.setAttribute('aria-expanded', 'true');
  menu.classList.remove('hidden');

  const rect = btn.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let left = rect.right - mw;
  let top = rect.bottom + 6;
  if (top + mh > window.innerHeight - 8) top = rect.top - mh - 6;
  left = Math.max(8, Math.min(left, window.innerWidth - mw - 8));
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(Math.max(8, top))}px`;
}
window.openVmOpsMenu = openVmOpsMenu;
window.closeVmOpsMenu = closeVmOpsMenu;

function formatMemoryGb(mb) {
  if (!mb || mb <= 0) return '-';
  const gb = mb / 1024;
  return gb >= 10 ? `${Math.round(gb)} GB` : `${gb.toFixed(1).replace(/\.0$/, '')} GB`;
}

function renderVmSizeOptions(sizes, preferred = 'Standard_B1s') {
  const sel = $('create-size');
  if (!sel) return;
  if (!sizes.length) {
    sel.innerHTML = `<option value="">该区域暂无可用规格</option>`;
    return;
  }

  // Keep a compact but useful list: free-tier first, then common small SKUs, cap length.
  const preferredOrder = [
    'Standard_B1s',
    'Standard_B2ats_v2',
    'Standard_B2pts_v2',
    'Standard_B1ms',
    'Standard_B2s',
    'Standard_B2ms',
    'Standard_D2s_v3',
    'Standard_D4s_v3',
  ];
  const byName = new Map(sizes.map(s => [s.name, s]));
  const picked = [];
  for (const name of preferredOrder) {
    if (byName.has(name)) picked.push(byName.get(name));
  }
  // Always include free-tier hits even if not in preferred list.
  for (const s of sizes) {
    if (s.freeTierHint && !picked.some(p => p.name === s.name)) picked.push(s);
  }
  // Fill remaining with smallest sizes until ~40 options.
  for (const s of sizes) {
    if (picked.length >= 40) break;
    if (!picked.some(p => p.name === s.name)) picked.push(s);
  }

  const preferredAvailable = picked.some(s => s.name === preferred)
    ? preferred
    : (picked.find(s => s.freeTierHint)?.name || picked[0].name);

  sel.innerHTML = picked.map(s => {
    const free = s.freeTierHint ? ' · 免费试用' : '';
    const label = `${s.name} — ${s.numberOfCores || '?'} vCPU / ${formatMemoryGb(s.memoryInMB)}${free}`;
    return `<option value="${esc(s.name)}">${esc(label)}</option>`;
  }).join('');
  sel.value = preferredAvailable;
}

async function loadVmSizes(location, preferred = 'Standard_B1s') {
  const sel = $('create-size');
  const hint = $('create-size-hint');
  if (!sel) return;
  if (!location) {
    sel.innerHTML = `<option value="">选择区域后加载…</option>`;
    return;
  }
  const accId = S.selectedAccId;
  sel.innerHTML = `<option value="">加载规格中…</option>`;
  sel.disabled = true;
  try {
    const sizes = await api('GET', `/api/vm-sizes?location=${encodeURIComponent(location)}`);
    if (accId !== S.selectedAccId) return;
    renderVmSizeOptions(Array.isArray(sizes) ? sizes : [], preferred);
    if (hint) {
      const freeCount = (Array.isArray(sizes) ? sizes : []).filter(s => s.freeTierHint).length;
      hint.textContent = freeCount
        ? `已从 Azure 加载 ${Array.isArray(sizes) ? sizes.length : 0} 个规格（当前区域含 ${freeCount} 个常见免费试用规格）。`
        : `已从 Azure 加载 ${Array.isArray(sizes) ? sizes.length : 0} 个规格。当前区域未返回常见免费试用规格。`;
    }
  } catch (e) {
    // Fallback static list so create flow still works.
    if (accId !== S.selectedAccId) return;
    renderVmSizeOptions([
      { name: 'Standard_B1s', numberOfCores: 1, memoryInMB: 1024, maxDataDiskCount: 2, freeTierHint: true },
      { name: 'Standard_B2ats_v2', numberOfCores: 2, memoryInMB: 1024, maxDataDiskCount: 4, freeTierHint: true },
      { name: 'Standard_B2pts_v2', numberOfCores: 2, memoryInMB: 1024, maxDataDiskCount: 4, freeTierHint: true },
      { name: 'Standard_B1ms', numberOfCores: 1, memoryInMB: 2048, maxDataDiskCount: 2, freeTierHint: false },
      { name: 'Standard_B2s', numberOfCores: 2, memoryInMB: 4096, maxDataDiskCount: 4, freeTierHint: false },
      { name: 'Standard_B2ms', numberOfCores: 2, memoryInMB: 8192, maxDataDiskCount: 4, freeTierHint: false },
      { name: 'Standard_D2s_v3', numberOfCores: 2, memoryInMB: 8192, maxDataDiskCount: 4, freeTierHint: false },
      { name: 'Standard_D4s_v3', numberOfCores: 4, memoryInMB: 16384, maxDataDiskCount: 8, freeTierHint: false },
    ], preferred);
    if (hint) hint.textContent = `实时查询失败，已使用备用列表：${e.message}`;
  } finally {
    if (accId === S.selectedAccId) sel.disabled = false;
  }
}

async function loadRegions() {
  const accId = S.selectedAccId;
  if (!accId) return;
  const sel = $('create-region');
  const hint = $('create-region-hint');
  const baseHint = '只列出当前订阅可实际创建虚拟机的区域（已排除地理组，并遵循订阅上的 Azure Policy 区域限制）。';
  const previous = sel?.value || '';
  if (sel) {
    sel.disabled = true;
    sel.innerHTML = `<option value="">加载区域中…</option>`;
  }
  if (hint) hint.textContent = '正在读取订阅可用的区域…';
  try {
    const payload = await api('GET', '/api/regions');
    if (accId !== S.selectedAccId) return;
    // The endpoint echoes the account it answered for; drop a stale reply.
    if (payload?.accountId && payload.accountId !== accId) return;
    const regions = Array.isArray(payload?.items) ? payload.items : [];
    S.regions = regions;
    if (!sel) return;
    if (!regions.length) {
      sel.innerHTML = `<option value="">无可创建虚拟机的区域</option>`;
      sel.disabled = true;
      if (hint) {
        hint.textContent = payload?.warning
          ? `未获取到可用区域：${payload.warning}`
          : '订阅下没有可用的区域，请检查订阅状态与 Azure Policy 区域限制。';
      }
      return;
    }
    sel.innerHTML = regions.map(r =>
      `<option value="${esc(r.name)}">${esc(r.displayName)}</option>`
    ).join('');
    sel.disabled = false;
    // Preserve the previous choice when it is still allowed, so a rerun of this
    // loader does not silently move the target region.
    if (previous && regions.some((r) => r.name === previous)) sel.value = previous;
    if (hint) hint.textContent = describeRegionFilter(payload, regions.length, baseHint);
  } catch (e) {
    if (accId !== S.selectedAccId) return;
    S.regions = [];
    if (sel) {
      sel.innerHTML = `<option value="">区域加载失败</option>`;
      sel.disabled = true;
    }
    if (hint) hint.textContent = `区域加载失败：${e.message}。请刷新后重试，避免在未知区域上创建虚拟机。`;
  }
}

/** Explains what the region list left out, so a filtered list is never a mystery. */
function describeRegionFilter(payload, count, fallback) {
  const parts = [];
  const policyExcluded = payload?.excludedByPolicy?.length ?? 0;
  const nonPhysical = payload?.excludedNonPhysical?.length ?? 0;
  const notDeployable = payload?.excludedNotDeployable?.length ?? 0;
  if (policyExcluded) parts.push(`Policy 禁止 ${policyExcluded} 个`);
  if (nonPhysical) parts.push(`非物理区域 ${nonPhysical} 个`);
  if (notDeployable) parts.push(`不支持 Compute ${notDeployable} 个`);
  const suffix = parts.length ? `已排除：${parts.join('、')}。` : '';
  const warn = payload?.warning ? `⚠ ${payload.warning}。` : '';
  return `${count} 个可用区域。${suffix}${warn}${fallback}`;
}

async function loadIpPermission(location) {
  const sel = $('create-ip');
  const hint = $('create-ip-hint');
  if (!sel || !location) return;
  const accId = S.selectedAccId;
  sel.disabled = true;
  try {
    const data = await api('GET', `/api/ip-permission?location=${encodeURIComponent(location)}`);
    if (accId !== S.selectedAccId) return;
    const permission = data.permission || 'Both';
    sel.innerHTML = '';
    if (permission === 'Dynamic') {
      sel.add(new Option('Dynamic', 'Dynamic'));
      sel.value = 'Dynamic';
      sel.disabled = true;
      if (hint) hint.textContent = '当前区域仅支持 Basic / Dynamic 公网 IP。';
    } else if (permission === 'Static') {
      sel.add(new Option('Static', 'Static'));
      sel.value = 'Static';
      sel.disabled = true;
      if (hint) hint.textContent = '当前区域仅支持 Standard / Static 公网 IP。';
    } else {
      sel.add(new Option('Dynamic', 'Dynamic'));
      sel.add(new Option('Static', 'Static'));
      sel.value = 'Dynamic';
      sel.disabled = false;
      if (hint) hint.textContent = '当前区域同时支持 Dynamic 和 Static。';
    }
  } catch (e) {
    if (accId !== S.selectedAccId) return;
    sel.disabled = false;
    if (hint) hint.textContent = `IP 类型检测失败，保留手动选择：${e.message}`;
  }
}

// ── VM actions ────────────────────────────────────────────────
function vmAction(action, rg, vm) {
  const labels = { start: '启动', stop: '停止', restart: '重启', delete: '删除资源组' };
  // Pin the account the action belongs to. `rg`/`vm` come from the rendered list,
  // so resolving the target account from the session cookie could apply the
  // action to a same-named resource group in a different subscription.
  S.pendingAction = { kind: 'vm', accountId: S.selectedAccId, action, resourceGroup: rg, vmName: vm };
  $('cf-title').textContent = `${labels[action]} — ${vm}`;
  $('cf-desc').textContent = action === 'delete'
    ? `确认删除资源组 ${rg}？此操作不可撤销，将删除该资源组内全部资源。`
    : `确认对虚拟机 ${vm} 执行「${labels[action]}」？`;
  $('btn-cf').className = action === 'delete' ? 'btn btn-d' : 'btn btn-p';
  openModal('mo-confirm');
}
window.vmAction = vmAction;

function changeIp(rg, vm) {
  S.pendingAction = { kind: 'ip', accountId: S.selectedAccId, resourceGroup: rg, vmName: vm };
  $('cf-title').textContent = `更换公网 IP — ${vm}`;
  $('cf-desc').textContent = `确认为虚拟机 ${vm} 更换公网 IP？切换期间连接会短暂中断。`;
  $('btn-cf').className = 'btn btn-p';
  openModal('mo-confirm');
}
window.changeIp = changeIp;

async function confirmPendingAction() {
  const p = S.pendingAction;
  if (!p) return;
  closeModal('mo-confirm');
  S.pendingAction = null;
  const accountId = p.accountId;
  if (!accountId) {
    toast('无法确定目标账户，请重新点击操作', 'error');
    return;
  }
  try {
    const task = p.kind === 'ip'
      ? await api('POST', `/api/accounts/${accountId}/vm-change-ip`, { resourceGroup: p.resourceGroup, vmName: p.vmName })
      : await api('POST', `/api/accounts/${accountId}/vm-action`, {
          action: p.action,
          resourceGroup: p.resourceGroup,
          vmName: p.vmName,
        });
    toast('操作已提交', 'success');
    trackTask(task.taskId);
    if (S.activeVTab === 'tasks') loadTasks();
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ── tabs / tasks ──────────────────────────────────────────────
function switchVmTab(tabName) {
  S.activeVTab = tabName;
  document.querySelectorAll('.tab[data-vtab]').forEach(x => {
    x.classList.toggle('active', x.dataset.vtab === tabName);
  });
  $('vtab-vms')?.classList.toggle('hidden', tabName !== 'vms');
  $('vtab-tasks')?.classList.toggle('hidden', tabName !== 'tasks');
  if (tabName === 'tasks') loadTasks();
}

function renderTaskList(tasks) {
  $('task-list').innerHTML = tasks.length
    ? tasks.map(t => `
        <div class="task-item" onclick='showTaskDetail(${jsq(t.id)})'>
          <div class="task-top">
            <div class="task-msg">${esc(t.message || t.type)}</div>
            ${badge(t.status)}
          </div>
          <div class="task-time">${esc(t.createdAt || '')}</div>
        </div>
      `).join('')
    : `<div class="empty"><h3>暂无任务</h3><p>创建或操作虚拟机后，进度会出现在这里。</p></div>`;
}

async function loadTasks() {
  const accId = S.selectedAccId;
  if (!accId) {
    renderTaskList([]);
    return;
  }
  try {
    const tasks = await api('GET', '/api/tasks');
    if (accId !== S.selectedAccId) return;
    renderTaskList(Array.isArray(tasks) ? tasks : []);
  } catch (e) {
    if (accId !== S.selectedAccId) return;
    toast(`加载任务失败: ${e.message}`, 'error');
    renderTaskList([]);
  }
}

function trackTask(taskId) {
  if (S.trackingTasks.has(taskId)) return;
  S.trackingTasks.add(taskId);
  pollTask(taskId);
}

async function pollTask(taskId) {
  for (let i = 0; i < 180; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 5000));
    try {
      const t = await api('GET', `/api/task_status/${taskId}`);
      if (t.status === 'success') {
        toast('任务完成', 'success');
        S.trackingTasks.delete(taskId);
        if (S.selectedAccId) loadVmsFor(S.selectedAccId, { force: true });
        if (S.activeVTab === 'tasks') loadTasks();
        await showTaskDetail(taskId);
        return;
      }
      if (t.status === 'failure') {
        toast(`任务失败: ${t.errorMessage || t.message}`, 'error');
        S.trackingTasks.delete(taskId);
        if (S.activeVTab === 'tasks') loadTasks();
        await showTaskDetail(taskId);
        return;
      }
    } catch { /* keep polling */ }
  }
  S.trackingTasks.delete(taskId);
}

async function showTaskDetail(taskId) {
  try {
    const t = await api('GET', `/api/task_status/${taskId}`);
    const result = t.result && typeof t.result === 'object' ? t.result : null;

    let credBox = '';
    if (result && result.username && result.password) {
      credBox = `
        <div class="cred-box">
          <div class="cred-title">SSH 登录信息</div>
          <div class="cred-row">
            <span class="cred-k">公网 IP</span>
            <span class="cred-v">${esc(result.publicIp || '-')}</span>
            <button class="copy-btn" onclick='copyText(${jsq(result.publicIp || "")})'>复制</button>
          </div>
          <div class="cred-row">
            <span class="cred-k">用户名</span>
            <span class="cred-v">${esc(result.username)}</span>
            <button class="copy-btn" onclick='copyText(${jsq(result.username)})'>复制</button>
          </div>
          <div class="cred-row">
            <span class="cred-k">密码</span>
            <span class="cred-v">${esc(result.password)}</span>
            <button class="copy-btn" onclick='copyText(${jsq(result.password)})'>复制</button>
          </div>
        </div>`;
    } else if (result && result.publicIp) {
      credBox = `
        <div class="cred-box">
          <div class="cred-row">
            <span class="cred-k">公网 IP</span>
            <span class="cred-v">${esc(result.publicIp)}</span>
            <button class="copy-btn" onclick='copyText(${jsq(result.publicIp)})'>复制</button>
          </div>
        </div>`;
    }

    $('task-info').innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px">
        ${badge(t.status)}
        <span style="font-size:14px;font-weight:700">${esc(t.message || '')}</span>
      </div>
      ${credBox}
      ${t.result ? `<pre class="rp">${esc(JSON.stringify(t.result, null, 2))}</pre>` : ''}`;

    $('task-logs').innerHTML = (t.logs || []).map(l => `
      <div class="log ${l.level === 'error' ? 'err' : ''}">
        <span class="log-t">${esc(l.createdAt?.slice(11, 19) || '')}</span>
        <span class="log-s">[${esc(l.step)}]</span>
        <span>${esc(l.message)}</span>
      </div>
    `).join('') || '<div class="muted small">暂无日志</div>';

    openModal('mo-task');
  } catch (e) {
    toast(e.message, 'error');
  }
}
window.showTaskDetail = showTaskDetail;

// ── create VM ─────────────────────────────────────────────────
/** Opens the create-VM dialog for the selected account with clean defaults. */
async function openCreateVmDialog() {
  if (!S.selectedAccId) {
    toast('请先选择一个 Azure 账户', 'error');
    return;
  }
  S.createVmAccountId = S.selectedAccId;
  // Restore safe defaults each time the dialog opens.
  if ($('create-name')) $('create-name').value = '';
  if ($('create-username')) $('create-username').value = '';
  if ($('create-password')) $('create-password').value = '';
  if ($('create-disk')) $('create-disk').value = '64';
  if ($('create-disk-type')) $('create-disk-type').value = 'Premium_LRS';
  if ($('create-ip')) $('create-ip').value = 'Dynamic';
  if ($('create-use-global-ssh')) $('create-use-global-ssh').checked = false;
  if ($('create-enable-root')) $('create-enable-root').checked = false;
  if ($('create-nsg-enabled')) $('create-nsg-enabled').checked = true;
  if ($('create-nsg-ports')) $('create-nsg-ports').value = '22';
  if ($('create-nsg-all-inbound')) $('create-nsg-all-inbound').checked = false;
  if ($('create-nsg-all-outbound')) $('create-nsg-all-outbound').checked = false;
  openModal('mo-create-vm');
  if (!S.regions.length) await loadRegions();
  const loc = $('create-region')?.value || S.regions[0]?.name || '';
  if (loc) {
    loadVmSizes(loc, 'Standard_B1s');
    loadIpPermission(loc);
  }
}
window.openCreateVmDialog = openCreateVmDialog;

async function submitCreateVm() {
  const btn = $('btn-submit-vm');
  if (!S.createVmAccountId) {
    toast('请先选择一个 Azure 账户', 'error');
    return;
  }
  if (btn) btn.disabled = true;
  try {
    const ud = $('create-ud').value.trim();
    const diskSize = parseInt($('create-disk').value, 10);
    const diskType = $('create-disk-type').value;
    if (diskSize === 30 && diskType === 'Premium_LRS') {
      throw new Error('30 GB 不支持 Premium SSD，请选择 32 GB 或更换磁盘类型');
    }
    const ports = String($('create-nsg-ports')?.value || '22')
      .split(/[,\s]+/)
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isInteger(value) && value >= 1 && value <= 65535);
    if (ports.length > 20) throw new Error('最多配置 20 个开放端口');
    const openAllInbound = $('create-nsg-all-inbound').checked;
    const openAllOutbound = $('create-nsg-all-outbound').checked;
    if ((openAllInbound || openAllOutbound) && !confirm('确认开放全部入站或出站流量？这会显著扩大实例的网络暴露面。')) {
      return;
    }
    const task = await api('POST', `/api/accounts/${S.createVmAccountId}/create-vm`, {
      region: $('create-region').value,
      vmSize: $('create-size').value,
      osImage: $('create-os').value,
      diskSize,
      diskType,
      ipType: $('create-ip').value,
      userData: ud || null,
      vmName: $('create-name').value.trim() || null,
      adminUsername: $('create-username').value.trim() || null,
      adminPassword: $('create-password').value || null,
      useGlobalSsh: $('create-use-global-ssh').checked,
      enableRoot: $('create-enable-root').checked,
      nsgEnabled: $('create-nsg-enabled').checked,
      nsgPorts: ports.length ? [...new Set(ports)] : [],
      nsgOpenAllInbound: openAllInbound,
      nsgOpenAllOutbound: openAllOutbound,
    });
    closeModal('mo-create-vm');
    toast('创建任务已提交', 'success');
    trackTask(task.taskId);
    if (S.activeVTab === 'tasks') loadTasks();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── add account ───────────────────────────────────────────────
function setAddMode(mode) {
  const current = ['manual', 'json', 'guide'].includes(mode) ? mode : 'manual';
  for (const key of ['manual', 'json', 'guide']) {
    $(`add-tab-${key}`)?.classList.toggle('active', key === current);
    $(`add-mode-${key}`)?.classList.toggle('hidden', key !== current);
  }
  // 凭据引导页不需要验证/保存按钮
  const isGuide = current === 'guide';
  for (const id of ['btn-check-add', 'btn-save-add', 'add-save-hint']) {
    const el = $(id);
    if (el) el.style.display = isGuide ? 'none' : '';
  }
  // 切换页签后回到弹窗顶部，避免内容长短不同导致停留在半截位置
  const body = $('mo-add-acc')?.querySelector('.md-b');
  if (body) body.scrollTop = 0;
}

function currentAddCredentialKey() {
  return [
    $('add-cid')?.value.trim() || '',
    $('add-sec')?.value.trim() || '',
    $('add-tid')?.value.trim() || '',
    $('add-sid')?.value.trim() || '',
  ].join('|');
}

function setAddSaveEnabled(enabled) {
  const btn = $('btn-save-add');
  if (btn) btn.disabled = !enabled;
  const hint = $('add-save-hint');
  if (hint) {
    hint.textContent = enabled
      ? '凭据已验证，可以保存。下一步需填写邮箱与订阅到期日。'
      : '请先验证凭据，通过后才能保存。下一步将填写邮箱与订阅到期日。';
  }
}

function invalidateAddVerification() {
  if (!S.addVerifiedKey) return;
  if (S.addVerifiedKey !== currentAddCredentialKey()) {
    S.addVerifiedKey = null;
    setAddSaveEnabled(false);
  }
}

function resetAddForm() {
  ['add-name', 'add-cid', 'add-tid', 'add-sec', 'add-sid', 'add-json'].forEach(id => {
    if ($(id)) $(id).value = '';
  });
  $('add-check-result').className = 'hidden';
  $('add-check-result').textContent = '';
  $('add-json-result').className = 'hidden';
  $('add-json-result').textContent = '';
  S.addVerifiedKey = null;
  setAddSaveEnabled(false);
  setAddMode('manual');
}

function pickCredentialField(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (value !== undefined && value !== null && String(value).trim()) {
      return String(value).trim();
    }
  }
  return '';
}

function extractSubscriptionId(text, obj) {
  // Prefer explicit keys only — never generic `id`, which can collide with other Azure objects.
  const fromObj = pickCredentialField(obj, [
    'subscriptionId', 'subscription_id', 'subscriptionID', 'subId', 'sub_id',
  ]);
  if (fromObj) return fromObj;

  // Also parse trailing lines like: subscriptionId=xxxx
  const patterns = [
    /subscriptionId\s*[:=]\s*["']?([0-9a-fA-F-]{36})/i,
    /subscription_id\s*[:=]\s*["']?([0-9a-fA-F-]{36})/i,
    /订阅\s*ID\s*[:=]\s*["']?([0-9a-fA-F-]{36})/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) return m[1];
  }
  return '';
}

function parseCredentialPayload(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('请先粘贴 JSON 或 Cloud Shell 输出');

  // Extract the first JSON object even if extra lines follow (e.g. subscriptionId=...).
  let obj = null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      obj = JSON.parse(text.slice(start, end + 1));
    } catch {
      // fall through
    }
  }
  if (!obj) {
    try {
      obj = JSON.parse(text);
    } catch {
      throw new Error('无法解析 JSON，请检查是否完整复制了 Cloud Shell 输出');
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('JSON 格式不正确，需要包含 appId / password / tenant 的对象');
  }

  const clientId = pickCredentialField(obj, ['appId', 'app_id', 'clientId', 'client_id', 'applicationId', 'application_id']);
  const clientSecret = pickCredentialField(obj, ['password', 'clientSecret', 'client_secret', 'secret', 'clientSecretValue']);
  const tenantId = pickCredentialField(obj, ['tenant', 'tenantId', 'tenant_id', 'directoryId', 'directory_id']);
  const subscriptionId = extractSubscriptionId(text, obj);
  const name = pickCredentialField(obj, ['displayName', 'display_name', 'name', 'accountName', 'account_name']);

  if (!clientId || !clientSecret || !tenantId) {
    throw new Error('JSON 中至少需要 appId、password、tenant（或 clientId/clientSecret/tenantId）');
  }

  return { name, clientId, clientSecret, tenantId, subscriptionId };
}

function applyParsedCredentials(parsed, { silent = false } = {}) {
  // Do not use azure-cli displayName as account title; email will be the display name.
  $('add-cid').value = parsed.clientId || '';
  $('add-sec').value = parsed.clientSecret || '';
  $('add-tid').value = parsed.tenantId || '';
  if (parsed.subscriptionId) $('add-sid').value = parsed.subscriptionId;

  const res = $('add-json-result');
  const missingSub = !parsed.subscriptionId;
  res.className = missingSub ? 'err-box' : 'ok-box';
  res.textContent = missingSub
    ? '已填充 appId / password / tenant。未检测到 subscriptionId，请手动补全订阅 ID。'
    : '已解析并填充表单字段，可直接验证或保存。';
  res.classList.remove('hidden');

  S.addVerifiedKey = null;
  setAddSaveEnabled(false);
  if (!silent) {
    setAddMode('manual');
    toast(missingSub ? '已填充，请补全订阅 ID' : 'JSON 已填充到表单，请先验证凭据', missingSub ? 'info' : 'success');
  }
  return !missingSub;
}

function ensureCredentialsFromJsonIfNeeded() {
  // If user stays on JSON tab, parse automatically before check/save.
  const onJson = !$('add-mode-json').classList.contains('hidden');
  if (!onJson) return;
  const raw = $('add-json').value.trim();
  if (!raw) return;
  const parsed = parseCredentialPayload(raw);
  applyParsedCredentials(parsed, { silent: true });
}

function openAddAccount() {
  resetAddForm();
  setAddMode('manual');
  openModal('mo-add-acc');
  setTimeout(() => $('add-cid')?.focus(), 50);
}
window.openAddAccount = openAddAccount;

function parseJsonFromForm() {
  try {
    const parsed = parseCredentialPayload($('add-json').value);
    applyParsedCredentials(parsed);
  } catch (e) {
    const res = $('add-json-result');
    if (res) {
      res.className = 'err-box';
      res.textContent = e.message;
      res.classList.remove('hidden');
    }
    toast(e.message, 'error');
  }
}

async function checkAddAccount() {
  const btn = $('btn-check-add');
  const res = $('add-check-result');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '验证中...';
  }
  S.addVerifiedKey = null;
  setAddSaveEnabled(false);
  try {
    ensureCredentialsFromJsonIfNeeded();
    const payload = {
      clientId: $('add-cid').value.trim(),
      clientSecret: $('add-sec').value.trim(),
      tenantId: $('add-tid').value.trim(),
      subscriptionId: $('add-sid').value.trim(),
    };
    const d = await api('POST', '/api/accounts/check', payload);
    S.addVerifiedKey = currentAddCredentialKey();
    setAddSaveEnabled(true);
    if (res) {
      const warningText = Array.isArray(d.warnings) && d.warnings.length
        ? `；Provider 注册警告：${d.warnings.join('；')}`
        : '';
      res.className = d.warnings?.length ? 'err-box' : 'ok-box';
      res.textContent = `验证通过：${d.subscriptionDisplayName} · ${d.state} · ${d.availableRegionCount} 个可用区域${warningText}`;
    }
  } catch (e) {
    S.addVerifiedKey = null;
    setAddSaveEnabled(false);
    if (res) {
      res.className = 'err-box';
      res.textContent = `验证失败：${e.message}`;
    }
  } finally {
    res?.classList.remove('hidden');
    if (btn) {
      btn.disabled = false;
      btn.textContent = '验证凭据';
    }
  }
}

function openPostAddExpiryModal(account) {
  S.pendingNewAccountId = account.id;
  if ($('post-add-id')) $('post-add-id').value = account.id;
  if ($('post-add-name')) $('post-add-name').value = account.name || '';
  if ($('post-add-email')) $('post-add-email').value = account.email || '';
  if ($('post-add-exp')) $('post-add-exp').value = account.expirationDate || '';
  const err = $('post-add-err');
  if (err) {
    err.className = 'err-box hidden';
    err.textContent = '';
  }
  openModal('mo-add-expiry');
  setTimeout(() => $('post-add-email')?.focus(), 50);
}

async function finishPostAddFlow() {
  closeModal('mo-add-expiry');
  S.pendingNewAccountId = null;
  S.accounts = await api('GET', '/api/accounts');
  S.selectedAccId = null;
  api('DELETE', '/api/session').catch(() => {});
  refreshOverview();
  switchPage('accounts');
  showAccountListView();
}

function isValidEmail(value) {
  const s = String(value || '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

async function savePostAddExpiry() {
  const accountId = $('post-add-id')?.value || S.pendingNewAccountId;
  const email = $('post-add-email')?.value.trim() || '';
  const exp = $('post-add-exp')?.value || '';
  const err = $('post-add-err');

  if (!email || !isValidEmail(email) || !exp) {
    const msg = !email ? '请填写邮箱'
      : (!isValidEmail(email) ? '邮箱格式无效' : '请选择订阅到期日');
    if (err) {
      err.className = 'err-box';
      err.textContent = msg;
      err.classList.remove('hidden');
    }
    toast(msg, 'error');
    return;
  }

  if (!accountId) return finishPostAddFlow();
  const acc = S.accounts.find(a => a.id === accountId);
  const btn = $('btn-save-expiry');
  if (btn) btn.disabled = true;
  try {
    await api('POST', '/api/accounts/edit', {
      accountId,
      newName: email, // display name = email
      email,
      expirationDate: exp,
    });
    toast('账户信息已完善', 'success');
    await finishPostAddFlow();
  } catch (e) {
    if (err) {
      err.className = 'err-box';
      err.textContent = e.message;
      err.classList.remove('hidden');
    }
    toast(e.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function saveAddAccount() {
  if (S.addVerifiedKey !== currentAddCredentialKey()) {
    toast('请先验证凭据并通过后再保存', 'error');
    setAddSaveEnabled(false);
    return;
  }
  const btn = $('btn-save-add');
  if (btn) btn.disabled = true;
  try {
    ensureCredentialsFromJsonIfNeeded();
    // Temporary name until email is set in the next step.
    const name = `pending-${Date.now().toString(36)}`;
    const created = await api('POST', '/api/accounts', {
      name,
      clientId: $('add-cid').value.trim(),
      clientSecret: $('add-sec').value.trim(),
      tenantId: $('add-tid').value.trim(),
      subscriptionId: $('add-sid').value.trim(),
      expirationDate: null,
    });
    toast('账户已添加', 'success');
    closeModal('mo-add-acc');
    const createdAccount = created?.id ? created : { id: created?.id, name };
    // Refresh list cache before expiry modal edit.
    S.accounts = await api('GET', '/api/accounts');
    resetAddForm();
    openPostAddExpiryModal(S.accounts.find(a => a.id === created.id) || { id: created.id, name });
  } catch (e) {
    toast(e.message, 'error');
    setAddSaveEnabled(true);
  } finally {
    if (btn && S.addVerifiedKey === currentAddCredentialKey()) btn.disabled = false;
  }
}

// ── edit / delete account ─────────────────────────────────────
function openEditAccount(accountId, e) {
  if (e) e.stopPropagation();
  const id = accountId || S.selectedAccId;
  const acc = S.accounts.find(a => a.id === id);
  if (!acc) {
    toast('未找到账户', 'error');
    return;
  }
  $('edit-acc-id').value = acc.id;
  if ($('edit-acc-name')) $('edit-acc-name').value = acc.name || '';
  if ($('edit-acc-email')) $('edit-acc-email').value = acc.email || accountDisplayName(acc) || '';
  $('edit-acc-exp').value = acc.expirationDate || '';
  if ($('edit-acc-cid')) $('edit-acc-cid').value = acc.clientId || '';
  if ($('edit-acc-tid')) $('edit-acc-tid').value = acc.tenantId || '';
  if ($('edit-acc-sid')) $('edit-acc-sid').value = acc.subscriptionId || '';
  // The stored secret is never sent back to the browser; blank means "keep it".
  if ($('edit-acc-sec')) $('edit-acc-sec').value = '';
  if (!$('mo-account-details')?.classList.contains('hidden')) closeAccountDetailsModal();
  openModal('mo-edit-acc');
}
window.openEditAccount = openEditAccount;

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

async function saveEditAccount() {
  const btn = $('btn-save-edit-acc');
  const email = $('edit-acc-email')?.value.trim() || '';
  const exp = $('edit-acc-exp').value || '';
  const clientId = $('edit-acc-cid')?.value.trim() || '';
  const tenantId = $('edit-acc-tid')?.value.trim() || '';
  const subscriptionId = $('edit-acc-sid')?.value.trim() || '';
  const clientSecret = $('edit-acc-sec')?.value || '';

  if (!email || !isValidEmail(email)) return toast(!email ? '请填写邮箱' : '邮箱格式无效', 'error');
  if (!exp) return toast('请选择订阅到期日', 'error');
  if (!UUID_RE.test(clientId)) return toast('应用 (客户端) ID 格式无效', 'error');
  if (!UUID_RE.test(tenantId)) return toast('目录 (租户) ID 格式无效', 'error');
  if (!UUID_RE.test(subscriptionId)) return toast('订阅 ID 格式无效', 'error');

  if (btn) btn.disabled = true;
  try {
    const accountId = $('edit-acc-id').value;
    const result = await api('POST', '/api/accounts/edit', {
      accountId,
      newName: email, // display name = email
      email,
      expirationDate: exp,
      clientId,
      tenantId,
      subscriptionId,
      // Omit entirely when untouched so the server keeps the stored ciphertext.
      ...(clientSecret ? { clientSecret } : {}),
    });
    closeModal('mo-edit-acc');

    // Credentials changed => every Azure-derived value for this account was cleared
    // server-side; drop the client-side copies too so nothing stale is redisplayed.
    if (result?.credentialsChanged) {
      delete S.accountInsights[accountId];
      delete S.accountDetails[accountId];
      S.accountStats[accountId] = {};
      S.vmsCache.delete(accountId);
    }

    S.accounts = await api('GET', '/api/accounts');
    const acc = S.accounts.find(a => a.id === accountId);
    if (acc && S.selectedAccId === acc.id) {
      updateAccountHeader(acc);
      renderAccountInsights(acc.id);
      paintAccGrid();
      loadVmsFor(acc.id, { force: true });
      loadAccountStats(acc.id, { force: true });
      loadAccountInsights(acc.id, true);
    } else {
      renderAccGrid();
    }
    refreshOverview();
    toast('账户已更新', 'success');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function deleteSelectedAccount() {
  const acc = S.accounts.find(a => a.id === S.selectedAccId);
  if (!confirm(`确认删除账户「${accountDisplayName(acc)}」？`)) return;
  try {
    await api('DELETE', `/api/accounts/${S.selectedAccId}`);
    if (!$('mo-account-details')?.classList.contains('hidden')) closeAccountDetailsModal();
    S.selectedAccId = null;
    S.accounts = await api('GET', '/api/accounts');
    refreshOverview();
    $('view-vms')?.classList.add('hidden');
    $('account-empty')?.classList.remove('hidden');
    renderAccGrid();
    toast('账户已删除', 'success');
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ── settings ──────────────────────────────────────────────────
async function loadStartupScript() {
  try {
    const d = await api('GET', '/api/settings/startup-script');
    if ($('startup-script')) $('startup-script').value = d.userData || '';
  } catch { /* ignore */ }
}

async function saveStartupScript() {
  const btn = $('btn-save-script');
  if (btn) btn.disabled = true;
  try {
    await api('POST', '/api/settings/startup-script', { userData: $('startup-script').value });
    toast('脚本已保存', 'success');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function loadGlobalSshSettings() {
  try {
    const d = await api('GET', '/api/settings/global-ssh');
    if ($('global-ssh-public-key')) $('global-ssh-public-key').value = d.publicKey || '';
    if ($('global-ssh-username')) $('global-ssh-username').value = d.username || '';
    if ($('global-ssh-password')) {
      $('global-ssh-password').value = '';
      $('global-ssh-password').placeholder = d.passwordSet ? '已保存密码；留空保持不变' : '未设置密码';
    }
  } catch { /* ignore */ }
}

async function saveGlobalSshSettings() {
  const btn = $('btn-save-global-ssh');
  if (btn) btn.disabled = true;
  try {
    await api('POST', '/api/settings/global-ssh', {
      publicKey: $('global-ssh-public-key').value.trim(),
      username: $('global-ssh-username').value.trim(),
      password: $('global-ssh-password').value,
    });
    toast('全局 SSH 配置已保存', 'success');
    await loadGlobalSshSettings();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── auth ──────────────────────────────────────────────────────
async function doLogout() {
  await api('POST', '/auth/logout').catch(() => {});
  location.reload();
}

async function doLogin() {
  const err = $('login-err');
  err?.classList.add('hidden');
  try {
    await api('POST', '/auth/login', { password: $('login-pw').value });
    S.accounts = await api('GET', '/api/accounts');
    showApp();
  } catch (e) {
    if (err) {
      err.textContent = e.status === 401 ? '密码错误，请重试' : e.message;
      err.classList.remove('hidden');
    }
  }
}

function revealApp() {
  const login = $('login-screen');
  const app = $('app');
  if (login) {
    login.style.display = 'none';
    login.classList.add('hidden');
  }
  if (app) {
    app.style.display = 'block';
    app.classList.add('is-on');
  }
}

function showApp() {
  revealApp();
  switchPage('overview');
}

function bindUI() {
  // Event delegation keeps nav/toggle working even if individual bindings fail.
  document.addEventListener('click', async (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;

    const opsTrigger = t.closest('.ops-trigger');
    if (!opsTrigger && !t.closest('#vm-ops-menu')) closeVmOpsMenu();
    if (opsTrigger) {
      e.preventDefault();
      return void openVmOpsMenu(opsTrigger);
    }

    const closer = t.closest('[data-close]');
    if (closer) {
      const modalId = closer.getAttribute('data-close');
      // Post-add profile step is required; do not allow dismiss without completing.
      if (modalId === 'mo-add-expiry' && S.pendingNewAccountId) {
        toast('请填写邮箱和订阅到期日以完成添加', 'error');
        return;
      }
      if (modalId === 'mo-account-details') {
        closeAccountDetailsModal();
        return;
      }
      closeModal(modalId);
      return;
    }
    if (t.classList.contains('mo')) {
      if (t.id === 'mo-add-expiry' && S.pendingNewAccountId) {
        toast('请填写邮箱和订阅到期日以完成添加', 'error');
        return;
      }
      if (t.id === 'mo-account-details') {
        closeAccountDetailsModal();
        return;
      }
      closeModal(t.id);
      return;
    }

    const nav = t.closest('.ni[data-page]');
    if (nav) {
      e.preventDefault();
      switchPage(nav.getAttribute('data-page'));
      return;
    }

    if (t.closest('#sbtoggle')) {
      e.preventDefault();
      $('sidebar')?.classList.toggle('col');
      return;
    }

    const vtab = t.closest('.tab[data-vtab]');
    if (vtab) {
      switchVmTab(vtab.getAttribute('data-vtab'));
      return;
    }

    const addMode = t.closest('[data-add-mode]');
    if (addMode) {
      setAddMode(addMode.getAttribute('data-add-mode'));
      return;
    }

    if (t.closest('#btn-logout')) return void doLogout();
    if (t.closest('#login-btn')) return void doLogin();
    if (t.closest('#btn-back-accounts')) return void backToAccountList();
    if (t.closest('#btn-create-vm')) return void openCreateVmDialog();
    if (t.closest('#btn-submit-vm')) return void submitCreateVm();
    if (t.closest('#btn-refresh-vms')) return void refreshWorkspace();
    if (t.closest('#btn-refresh-summary')) return void refreshAccountSummary(S.selectedAccId);
    if (t.closest('#btn-refresh-all-accounts')) return void refreshAllAccounts();
    if (t.closest('#btn-account-details')) return void openAccountDetails(S.selectedAccId);
    if (t.closest('#btn-toggle-account-secret')) return void toggleAccountSecret();
    if (t.closest('#btn-copy-account-secret')) return void copyAccountSecret();
    if (t.closest('#btn-copy-account-details')) return void copyAccountDetails(S.selectedAccId);
    if (t.closest('#btn-refresh-overview')) return void refreshOverview().then(() => toast('已刷新'));
    if (t.closest('#btn-parse-json')) return void parseJsonFromForm();
    if (t.closest('#btn-check-add')) return void checkAddAccount();
    if (t.closest('#btn-save-add')) return void saveAddAccount();
    if (t.closest('#btn-edit-acc')) return void openEditAccount(S.selectedAccId, e);
    if (t.closest('#btn-save-edit-acc')) return void saveEditAccount();
    if (t.closest('#btn-del-acc')) return void deleteSelectedAccount();
    if (t.closest('#btn-save-script')) return void saveStartupScript();
    if (t.closest('#btn-save-global-ssh')) return void saveGlobalSshSettings();
    if (t.closest('#btn-import-accounts')) return void $('account-import-file')?.click();
    if (t.closest('#btn-export-accounts')) return void openModal('mo-export-accounts');
    if (t.closest('#btn-export-accounts-safe')) return void exportAccounts(false);
    if (t.closest('#btn-export-accounts-full')) return void exportAccounts(true);
    if (t.closest('#btn-sort-account-name')) return void cycleAccountSort('name');
    if (t.closest('#btn-sort-account-expiry')) return void cycleAccountSort('expiry');
    if (t.closest('#btn-cf')) return void confirmPendingAction();
    if (t.closest('#btn-save-expiry')) return void savePostAddExpiry();
  });

  // Close the VM ops menu on escape, scroll or resize.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeVmOpsMenu(true);
  });
  window.addEventListener('scroll', () => closeVmOpsMenu(), true);
  window.addEventListener('resize', () => closeVmOpsMenu());

  on('login-pw', 'keydown', (e) => {
    if (e.key === 'Enter') doLogin();
  });

  // Reload SKUs when region changes in create-vm dialog.
  on('create-region', 'change', (e) => {
    const loc = e.target?.value || '';
    loadVmSizes(loc, 'Standard_B1s');
    loadIpPermission(loc);
  });

  on('account-search', 'input', (e) => {
    S.accountSearch = e.target?.value || '';
    renderAccGrid();
  });
  on('account-import-file', 'change', (e) => {
    importAccountsFromFile(e.target?.files?.[0]);
  });
  on('vm-search', 'input', (e) => {
    S.vmSearch = e.target?.value || '';
    renderVms();
  });
  on('vm-status-filter', 'change', (e) => {
    S.vmStatusFilter = e.target?.value || 'all';
    renderVms();
  });

  const accGrid = $('acc-grid');
  if (accGrid) {
    accGrid.addEventListener('dragstart', (e) => {
      const handle = e.target instanceof Element ? e.target.closest('.acc-drag') : null;
      const card = handle?.closest('.acc-card');
      if (!card) {
        e.preventDefault();
        return;
      }
      S.dragAccountId = card.getAttribute('data-account-id');
      card.classList.add('dragging');
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    });
    accGrid.addEventListener('dragover', (e) => {
      if (S.dragAccountId && e.target instanceof Element && e.target.closest('.acc-card')) e.preventDefault();
    });
    accGrid.addEventListener('drop', (e) => {
      const card = e.target instanceof Element ? e.target.closest('.acc-card') : null;
      if (!card) return;
      e.preventDefault();
      handleAccountDrop(card.getAttribute('data-account-id'));
    });
    accGrid.addEventListener('dragend', () => {
      S.dragAccountId = null;
      accGrid.querySelectorAll('.acc-card.dragging').forEach((card) => card.classList.remove('dragging'));
      paintAccGrid();
    });
  }

  // Invalidate verification when credentials change.
  ['add-cid', 'add-sec', 'add-tid', 'add-sid', 'add-json'].forEach((id) => {
    on(id, 'input', invalidateAddVerification);
  });
}

async function init() {
  bindUI();
  try {
    const session = await api('GET', '/api/session');
    if (!session.loggedIn) return;
    S.accounts = await api('GET', '/api/accounts');
    revealApp();

    const restoreId = session.selectedAccountId
      && S.accounts.some(a => a.id === session.selectedAccountId)
      ? session.selectedAccountId
      : null;

    if (restoreId) {
      await openVmView(restoreId);
    } else {
      switchPage('overview');
    }
  } catch {
    /* stay on login */
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
