// @ts-nocheck
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
  // Second line: expiry date on the left, remaining days on the right.
  let expiryHtml;
  if (days === null) {
    expiryHtml = `<span class="acc-expiry-empty">未设置到期日</span>`;
  } else {
    const dayLabel = days < 0 ? `已过期 ${Math.abs(days)} 天`
      : days === 0 ? '今天到期'
      : `${days} 天`;
    expiryHtml = `
      <span class="acc-expiry-date">${esc(a.expirationDate)}</span>
      <span class="acc-expiry-days ${dayCls}">${esc(dayLabel)}</span>`;
  }
  const tip = [title, subName, state, a.expirationDate ? `到期 ${a.expirationDate}` : ''].filter(Boolean).join(' · ');
  return `
    <div class="acc-card${S.selectedAccId === a.id ? ' selected' : ''}" data-account-id="${esc(a.id)}"
         title="${esc(tip)}" onclick='openVmView(${jsq(a.id)})'>
      <span class="acc-drag" draggable="true" title="拖动调整顺序">⠿</span>
      <div style="min-width:0">
        <div class="acc-name">${esc(title)}</div>
        <div class="acc-meta acc-expiry">${expiryHtml}</div>
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
  const detailItems = [
    ['邮箱', detail.email || accountDisplayName(detail)],
    ['订阅名称', detail.subscriptionName || '未获取'],
    ['订阅状态', detail.subscriptionState || '未获取'],
    ['订阅到期', detail.expirationDate || '未设置'],
    ['Client ID', detail.clientId || '-'],
    ['Tenant ID', detail.tenantId || '-'],
    ['Subscription ID', detail.subscriptionId || '-'],
    ['Client Secret', secret],
  ];
  $('detail-modal-title').textContent = accountDisplayName(detail);
  if ($('detail-modal-sub')) $('detail-modal-sub').textContent = '';
  $('detail-modal-loading')?.classList.add('hidden');
  $('detail-modal-content').innerHTML = `
    <div class="account-detail-list">
      ${detailItems.map(([key, value]) => `
        <div class="account-detail-row">
          <div class="account-detail-key">${esc(key)}</div>
          <div class="account-detail-value">${esc(value)}</div>
        </div>`).join('')}
    </div>`;
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
  const payload = {
    appId: detail.clientId || '',
    password: detail.clientSecret || '',
    tenant: detail.tenantId || '',
    subscriptionId: detail.subscriptionId || '',
    displayName: detail.email || accountDisplayName(detail),
    email: detail.email || '',
    expirationDate: detail.expirationDate || '',
  };
  await copyText(JSON.stringify(payload, null, 2));
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
  if (nameBtn) nameBtn.textContent = S.accountSort === 'nameAsc' ? '名称 ↑' : S.accountSort === 'nameDesc' ? '名称 ↓' : '名称 ⇅';
  if (expiryBtn) expiryBtn.textContent = S.accountSort === 'expiryAsc' ? '到期 ↑' : S.accountSort === 'expiryDesc' ? '到期 ↓' : '到期 ⇅';
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
  const mtd = formatCostAmount(data.mtd ?? account?.costMtd);
  const acc = formatCostAmount(data.acc ?? account?.costAcc);
  const quota = data.quotaTier || account?.quotaTier || '未获取';
  const notice = insightNotice?.accountId === accountId ? insightNotice.message : '';
  const mtdText = mtd !== null ? `${mtd}${unit}` : (loading || '未获取');
  const accText = acc !== null ? `${acc}${unit}` : '未获取';
  const updateText = account?.costUpdatedAt
    ? formatCostUpdatedAt(account.costUpdatedAt)
    : (loading ? '查询中…' : '');
  host.innerHTML = `
    <div class="insight-bar">
      <span class="ib"><i>AI 配额</i><b>${esc(quota)}</b></span>
      <span class="ib"><i>本月</i><b>${esc(mtdText)}</b></span>
      <span class="ib"><i>累计</i><b>${esc(accText)}</b></span>
      ${updateText ? `<span class="ib ib-time" title="消费数据更新时间"><b>${esc(updateText)}</b></span>` : ''}
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
 * Uses the aggregated summary endpoint so the client only needs one round-trip.
 */
async function refreshAccountSummary(accountId) {
  const id = accountId || S.selectedAccId;
  if (!id || S.summaryRefreshing) return;
  S.summaryRefreshing = true;
  renderAccountInsights(id);
  try {
    const payload = await api('GET', `/api/accounts/${id}/summary?refresh=1`);
    if (id !== S.selectedAccId) return;
    const summary = payload?.items && typeof payload.items === 'object' ? payload.items : payload;
    const account = S.accounts.find((item) => item.id === id);
    const cost = summary?.cost || null;
    const quotaTier = summary?.quotaTier || account?.quotaTier || '未获取';

    if (account) {
      account.subscriptionName = summary?.subscriptionDisplayName || account.subscriptionName;
      account.subscriptionState = summary?.state || account.subscriptionState;
      account.quotaTier = quotaTier;
      if (cost) {
        account.costMtd = cost.mtd;
        account.costAcc = cost.acc;
        account.costHistory = cost.history;
        account.costCurrency = cost.currency;
        account.costUpdatedAt = cost.queriedAt;
        account.costWarning = cost.warning || null;
      }
    }

    S.accountStats[id] = {
      ...(S.accountStats[id] || {}),
      loading: false,
      error: summary?.vmError || summary?.subscriptionError || null,
      vmCount: summary?.vmCount ?? S.accountStats[id]?.vmCount ?? 0,
      subscriptionDisplayName: summary?.subscriptionDisplayName || '',
      state: summary?.state || '',
      quotaTier,
    };

    if (cost) {
      S.accountInsights[id] = {
        ...(S.accountInsights[id] || {}),
        mtd: cost.mtd,
        acc: cost.acc,
        history: cost.history,
        currency: cost.currency,
        queriedAt: cost.queriedAt,
        warning: cost.warning || null,
        status: cost.status || null,
        quotaTier,
        loading: false,
        loaded: true,
      };
      showInsightNotice(id, cost.warning || null);
    } else if (summary?.costError) {
      showInsightNotice(id, `消费：${summary.costError}`);
    }

    if (S.accountDetails[id]) {
      S.accountDetails[id] = {
        ...S.accountDetails[id],
        quotaTier,
        ...(cost ? {
          costMtd: cost.mtd,
          costAcc: cost.acc,
          costHistory: cost.history,
          costCurrency: cost.currency,
          costUpdatedAt: cost.queriedAt,
          costWarning: cost.warning || null,
        } : {}),
      };
    }

    renderAccountInsights(id);
    updateAccountHeader(account);
    if (!$('mo-account-details')?.classList.contains('hidden')) renderAccountDetailsModal(account);
    paintAccGrid();

    const failures = [];
    if (summary?.subscriptionError) failures.push(`订阅：${summary.subscriptionError}`);
    if (summary?.costError) failures.push(`消费：${summary.costError}`);
    if (failures.length) showInsightNotice(id, `刷新部分失败 — ${failures.join('；')}`);
    else if (!cost?.warning) toast('AI 配额与消费已更新', 'success');
  } catch (e) {
    showInsightNotice(id, `刷新失败 — ${e.message}`);
    toast(`摘要刷新失败: ${e.message}`, 'error');
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

  const acc = S.accounts.find(a => a.id === accId);
  if (!acc) return;
  $('account-empty')?.classList.add('hidden');
  $('view-vms')?.classList.remove('hidden');

  // Anything scoped to the previous account must not survive the switch.
  abortVmsReads();
  abortActivityReads();
  clearInsightNotice();
  S.summaryRefreshing = false;
  S.vmsLoading = !S.vmsCache.has(accId);
  S.regions = [];
  S.pendingAction = null;
  S.createVmAccountId = accId;
  closeModal('mo-confirm');
  closeModal('mo-create-vm');
  closeAccountDetailsModal();
  // Paint activity immediately from this account's cache (or a loading placeholder).
  // Do not leave the previous account's tasks/logs on screen for one frame/request.
  paintActivityFor(accId, { loading: !S.activityCache.has(accId) });

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
    loadOpLogs(accId),
  ]);
}
window.openVmView = openVmView;

function backToAccountList() {
  S.selectedAccId = null;
  abortVmsReads();
  abortActivityReads();
  paintActivityFor(null);
  api('DELETE', '/api/session').catch(() => {});
  $('view-vms')?.classList.add('hidden');
  $('account-empty')?.classList.remove('hidden');
  paintAccGrid();
}

