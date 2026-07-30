// ── state ─────────────────────────────────────────────────────
const S = {
  accounts: [],
  accountStats: {}, // id -> { vmCount, subscriptionDisplayName, state, loading, error }
  activePage: 'overview',
  selectedAccId: null,
  vms: [],
  regions: [],
  activeVTab: 'vms',
  pendingAction: null,
  trackingTasks: new Set(),
  addVerifiedKey: null, // fingerprint of last successfully verified credentials
  pendingNewAccountId: null,
};

// ── api ───────────────────────────────────────────────────────
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { status: res.status });
  return data;
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
    if (page === 'settings') loadStartupScript();
  } catch (err) {
    console.error('[ui] switchPage side effects failed', page, err);
  }
}
window.switchPage = switchPage;

function openAzureGuide() {
  openModal('mo-azure-guide');
}
window.openAzureGuide = openAzureGuide;

// ── overview ──────────────────────────────────────────────────
function refreshOverview() {
  $('hero-greeting').textContent = greeting();
  $('stat-accounts').textContent = S.accounts.length;
  const acc = S.accounts.find(a => a.id === S.selectedAccId);
  $('stat-workspace').textContent = acc ? acc.name : '未选择';
}

// ── accounts ──────────────────────────────────────────────────
function showAccountListView() {
  $('view-acc-list').classList.remove('hidden');
  $('view-vms').classList.add('hidden');
  renderAccGrid();
}

function showAccList() {
  // If an account workspace is active, keep showing it when returning to this page.
  if (S.selectedAccId && S.accounts.some(a => a.id === S.selectedAccId)) {
    $('view-acc-list').classList.add('hidden');
    $('view-vms').classList.remove('hidden');
    // Refresh current workspace data every time user navigates back.
    loadVms();
    if (S.activeVTab === 'tasks') loadTasks();
    return;
  }
  S.selectedAccId = null;
  showAccountListView();
}

function formatExpiry(dateStr) {
  if (!dateStr) return '未设置';
  return dateStr;
}

function accountCardHtml(a) {
  const st = S.accountStats[a.id] || {};
  const vmText = st.loading ? '加载中…'
    : (typeof st.vmCount === 'number' ? `${st.vmCount} 台` : (st.error ? '获取失败' : '-'));
  const subName = st.subscriptionDisplayName || a.name;
  const state = st.state || '-';
  return `
    <div class="acc-card" onclick='openVmView(${jsq(a.id)})'>
      <div class="acc-top">
        <div class="acc-name">${esc(a.name)}</div>
        ${a.expirationDate ? `<span class="badge bg-err">订阅到期 ${esc(a.expirationDate)}</span>` : `<span class="badge bg-inf">就绪</span>`}
      </div>
      <div class="acc-meta">
        <div class="meta-row"><span class="meta-k">邮箱</span><span class="meta-v">${esc(a.email || '未设置')}</span></div>
        <div class="meta-row"><span class="meta-k">到期日</span><span class="meta-v">${esc(formatExpiry(a.expirationDate))}</span></div>
        <div class="meta-row"><span class="meta-k">机器数</span><span class="meta-v">${esc(vmText)}</span></div>
        <div class="meta-row"><span class="meta-k">订阅</span><span class="meta-v">${esc(subName)}${state && state !== '-' ? ` · ${esc(state)}` : ''}</span></div>
      </div>
      <div class="acc-foot">
        <button class="btn btn-s btn-sm" onclick='openEditAccount(${jsq(a.id)}, event)'>编辑</button>
        <button class="btn btn-p btn-sm" onclick='openVmView(${jsq(a.id)}, event)'>打开 →</button>
      </div>
    </div>`;
}

function paintAccGrid() {
  const g = $('acc-grid');
  if (!g) return;
  if (!S.accounts.length) {
    g.innerHTML = `
      <div class="empty" style="grid-column:1/-1">
        <h3>还没有 Azure 账户</h3>
        <p>添加应用注册凭据后，即可管理该订阅下的虚拟机。</p>
        <div class="bgrp" style="margin-top:8px;justify-content:center">
          <button class="btn btn-s" onclick="openAzureGuide()">如何获取凭据？</button>
          <button class="btn btn-p" onclick="openAddAccount()">添加账户</button>
        </div>
      </div>`;
    return;
  }
  g.innerHTML = S.accounts.map(accountCardHtml).join('');
}

function renderAccGrid() {
  paintAccGrid();
  S.accounts.forEach(a => loadAccountStats(a.id));
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
      error: null,
      vmCount: d.vmCount ?? 0,
      subscriptionDisplayName: d.subscriptionDisplayName || '',
      state: d.state || '',
    };
  } catch (e) {
    S.accountStats[accountId] = {
      loading: false,
      error: e.message || 'failed',
      vmCount: prev?.vmCount,
      subscriptionDisplayName: prev?.subscriptionDisplayName,
      state: prev?.state,
    };
  }
  if (S.activePage === 'accounts' && !$('view-acc-list')?.classList.contains('hidden')) {
    paintAccGrid();
  }
}

async function openVmView(accId, e) {
  if (e) e.stopPropagation();
  S.selectedAccId = accId;
  S.activeVTab = 'vms';
  document.querySelectorAll('.tab[data-vtab]').forEach(x => {
    x.classList.toggle('active', x.dataset.vtab === 'vms');
  });
  $('vtab-vms').classList.remove('hidden');
  $('vtab-tasks').classList.add('hidden');

  const acc = S.accounts.find(a => a.id === accId);
  $('vm-acc-title').textContent = acc?.name || '-';
  const bits = [acc?.email, acc?.expirationDate ? `到期 ${acc.expirationDate}` : null].filter(Boolean);
  $('vm-acc-sub').textContent = bits.join(' · ') || 'Azure 订阅';
  $('view-acc-list').classList.add('hidden');
  $('view-vms').classList.remove('hidden');

  // Ensure accounts page is visible.
  PAGES.forEach(p => {
    $(`pg-${p}`).classList.toggle('hidden', p !== 'accounts');
    const ni = $(`ni-${p}`);
    if (ni) ni.classList.toggle('active', p === 'accounts');
  });
  S.activePage = 'accounts';

  await api('POST', '/api/session', { accountId: accId }).catch(() => {});
  refreshOverview();
  await Promise.all([loadVms(), loadRegions()]);
}
window.openVmView = openVmView;

function backToAccountList() {
  S.selectedAccId = null;
  api('DELETE', '/api/session').catch(() => {});
  refreshOverview();
  $('view-acc-list')?.classList.remove('hidden');
  $('view-vms')?.classList.add('hidden');
  renderAccGrid();
}

// ── VMs ───────────────────────────────────────────────────────
async function loadVms() {
  try {
    S.vms = await api('GET', '/api/vms');
    renderVms();
  } catch (e) {
    toast(`加载虚拟机失败: ${e.message}`, 'error');
  }
}

function renderVms() {
  const tb = $('vm-tbody');
  if (!S.vms.length) {
    tb.innerHTML = `<tr><td colspan="5" style="padding:36px">
      <div class="empty" style="border:none;background:transparent;padding:12px">
        <h3>此订阅下暂无虚拟机</h3>
        <p>点击右上角「创建虚拟机」开始。</p>
      </div>
    </td></tr>`;
    return;
  }

  tb.innerHTML = S.vms.map(vm => {
    const ps = vm.status || '-';
    const psLower = String(ps).toLowerCase();
    const bc = psLower.includes('running')
      ? 'bg-ok'
      : (psLower.includes('deallocat') || psLower.includes('stopped'))
        ? 'bg-err'
        : 'bg-inf';
    const rgArg = jsq(vm.resourceGroup);
    const vmArg = jsq(vm.name);
    return `<tr>
      <td>
        <div class="vm-name">${esc(vm.name)}</div>
        <div class="vm-sub">${esc(vm.resourceGroup)}</div>
      </td>
      <td>
        <div>${esc(vm.location || '-')}</div>
        <div class="vm-sub">${esc(vm.vmSize || '-')}</div>
      </td>
      <td><span class="badge ${bc}">${esc(ps)}</span></td>
      <td class="mono">${esc(vm.publicIp || '-')}</td>
      <td>
        <div class="ops">
          <button class="btn btn-s btn-sm" onclick='vmAction("start", ${rgArg}, ${vmArg})'>启动</button>
          <button class="btn btn-s btn-sm" onclick='vmAction("stop", ${rgArg}, ${vmArg})'>停止</button>
          <button class="btn btn-s btn-sm" onclick='vmAction("restart", ${rgArg}, ${vmArg})'>重启</button>
          <button class="btn btn-s btn-sm" onclick='changeIp(${rgArg}, ${vmArg})'>换 IP</button>
          <button class="btn btn-dg btn-sm" onclick='vmAction("delete", ${rgArg}, ${vmArg})'>删除</button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

async function loadRegions() {
  try {
    S.regions = await api('GET', '/api/regions');
    const sel = $('create-region');
    sel.innerHTML = S.regions.map(r =>
      `<option value="${esc(r.name)}">${esc(r.displayName)}</option>`
    ).join('');
  } catch { /* non-critical */ }
}

// ── VM actions ────────────────────────────────────────────────
function vmAction(action, rg, vm) {
  const labels = { start: '启动', stop: '停止', restart: '重启', delete: '删除资源组' };
  S.pendingAction = { kind: 'vm', action, resourceGroup: rg, vmName: vm };
  $('cf-title').textContent = `${labels[action]} — ${vm}`;
  $('cf-desc').textContent = action === 'delete'
    ? `确认删除资源组 ${rg}？此操作不可撤销，将删除该资源组内全部资源。`
    : `确认对虚拟机 ${vm} 执行「${labels[action]}」？`;
  $('btn-cf').className = action === 'delete' ? 'btn btn-d' : 'btn btn-p';
  openModal('mo-confirm');
}
window.vmAction = vmAction;

function changeIp(rg, vm) {
  S.pendingAction = { kind: 'ip', resourceGroup: rg, vmName: vm };
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
  try {
    const task = p.kind === 'ip'
      ? await api('POST', '/api/vm-change-ip', { resourceGroup: p.resourceGroup, vmName: p.vmName })
      : await api('POST', '/api/vm-action', {
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
  if (!S.selectedAccId) {
    renderTaskList([]);
    return;
  }
  try {
    const tasks = await api('GET', '/api/tasks');
    renderTaskList(Array.isArray(tasks) ? tasks : []);
  } catch (e) {
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
        if (S.selectedAccId) loadVms();
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
async function submitCreateVm() {
  const btn = $('btn-submit-vm');
  if (btn) btn.disabled = true;
  try {
    const ud = $('create-ud').value.trim();
    const task = await api('POST', '/api/create-vm', {
      region: $('create-region').value,
      vmSize: $('create-size').value,
      osImage: $('create-os').value,
      diskSize: parseInt($('create-disk').value, 10),
      ipType: $('create-ip').value,
      userData: ud || null,
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
  const isJson = mode === 'json';
  $('add-tab-manual').classList.toggle('active', !isJson);
  $('add-tab-json').classList.toggle('active', isJson);
  $('add-mode-manual').classList.toggle('hidden', isJson);
  $('add-mode-json').classList.toggle('hidden', !isJson);
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
      ? '凭据已验证，可以保存账户。保存后可设置订阅到期日。'
      : '请先验证凭据，通过后才能保存账户。订阅到期日将在保存后设置。';
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
  if (parsed.name && !$('add-name').value.trim()) $('add-name').value = parsed.name;
  else if (parsed.name) $('add-name').value = parsed.name;
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
  openModal('mo-add-acc');
  setTimeout(() => $('add-name').focus(), 50);
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
      res.className = 'ok-box';
      res.textContent = `验证通过：${d.subscriptionDisplayName} · ${d.state} · ${d.availableRegionCount} 个可用区域`;
    }
    // Prefer Azure subscription display name when user left name empty.
    if (!$('add-name').value.trim() && d.subscriptionDisplayName) {
      $('add-name').value = d.subscriptionDisplayName;
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
  if ($('post-add-name')) $('post-add-name').textContent = account.name || '-';
  if ($('post-add-exp')) $('post-add-exp').value = '';
  openModal('mo-add-expiry');
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

async function savePostAddExpiry() {
  const accountId = $('post-add-id')?.value || S.pendingNewAccountId;
  if (!accountId) return finishPostAddFlow();
  const acc = S.accounts.find(a => a.id === accountId);
  const exp = $('post-add-exp')?.value || null;
  try {
    await api('POST', '/api/accounts/edit', {
      accountId,
      newName: acc?.name || $('post-add-name')?.textContent || 'Azure Account',
      email: acc?.email || null,
      expirationDate: exp,
    });
    toast(exp ? '订阅到期日已保存' : '已跳过到期日', 'success');
  } catch (e) {
    toast(e.message, 'error');
  }
  await finishPostAddFlow();
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
    const name = $('add-name').value.trim() || $('add-cid').value.trim().slice(0, 8) || 'Azure Account';
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
  $('edit-acc-name').value = acc.name || '';
  if ($('edit-acc-email')) $('edit-acc-email').value = acc.email || '';
  $('edit-acc-exp').value = acc.expirationDate || '';
  openModal('mo-edit-acc');
}
window.openEditAccount = openEditAccount;

async function saveEditAccount() {
  const btn = $('btn-save-edit-acc');
  if (btn) btn.disabled = true;
  try {
    const accountId = $('edit-acc-id').value;
    await api('POST', '/api/accounts/edit', {
      accountId,
      newName: $('edit-acc-name').value.trim(),
      email: $('edit-acc-email')?.value.trim() || null,
      expirationDate: $('edit-acc-exp').value || null,
    });
    closeModal('mo-edit-acc');
    S.accounts = await api('GET', '/api/accounts');
    const acc = S.accounts.find(a => a.id === S.selectedAccId) || S.accounts.find(a => a.id === accountId);
    if (acc && S.selectedAccId === acc.id) {
      $('vm-acc-title').textContent = acc.name;
      const bits = [acc.email, acc.expirationDate ? `到期 ${acc.expirationDate}` : null].filter(Boolean);
      if ($('vm-acc-sub')) $('vm-acc-sub').textContent = bits.join(' · ') || 'Azure 订阅';
    }
    refreshOverview();
    if (!$('view-acc-list')?.classList.contains('hidden')) renderAccGrid();
    toast('账户已更新', 'success');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function deleteSelectedAccount() {
  const acc = S.accounts.find(a => a.id === S.selectedAccId);
  if (!confirm(`确认删除账户「${acc?.name}」？`)) return;
  try {
    await api('DELETE', `/api/accounts/${S.selectedAccId}`);
    S.selectedAccId = null;
    S.accounts = await api('GET', '/api/accounts');
    refreshOverview();
    $('view-acc-list')?.classList.remove('hidden');
    $('view-vms')?.classList.add('hidden');
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
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;

    const closer = t.closest('[data-close]');
    if (closer) {
      const modalId = closer.getAttribute('data-close');
      closeModal(modalId);
      if (modalId === 'mo-add-expiry' && S.pendingNewAccountId) finishPostAddFlow();
      return;
    }
    if (t.classList.contains('mo')) {
      closeModal(t.id);
      if (t.id === 'mo-add-expiry' && S.pendingNewAccountId) finishPostAddFlow();
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
    if (t.closest('#btn-guide-to-add')) {
      closeModal('mo-azure-guide');
      openAddAccount();
      return;
    }
    if (t.closest('#btn-back-accounts')) return void backToAccountList();
    if (t.closest('#btn-create-vm')) return void openModal('mo-create-vm');
    if (t.closest('#btn-submit-vm')) return void submitCreateVm();
    if (t.closest('#btn-refresh-vms')) return void loadVms().then(() => toast('已刷新'));
    if (t.closest('#btn-parse-json')) return void parseJsonFromForm();
    if (t.closest('#btn-check-add')) return void checkAddAccount();
    if (t.closest('#btn-save-add')) return void saveAddAccount();
    if (t.closest('#btn-edit-acc')) return void openEditAccount(S.selectedAccId, e);
    if (t.closest('#btn-save-edit-acc')) return void saveEditAccount();
    if (t.closest('#btn-del-acc')) return void deleteSelectedAccount();
    if (t.closest('#btn-save-script')) return void saveStartupScript();
    if (t.closest('#btn-cf')) return void confirmPendingAction();
    if (t.closest('#btn-skip-expiry')) return void finishPostAddFlow();
    if (t.closest('#btn-save-expiry')) return void savePostAddExpiry();
  });

  on('login-pw', 'keydown', (e) => {
    if (e.key === 'Enter') doLogin();
  });

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
