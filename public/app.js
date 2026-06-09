// ── state ──────────────────────────────────────────────────────
const S = {
  accounts: [],
  selectedId: null,
  selectedName: null,
  vms: [],
  regions: [],
  activeTab: 'vms',
  pendingAction: null,
  pendingAccountMode: null,
  trackingTasks: new Set(),
};

// ── api ─────────────────────────────────────────────────────────
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

// ── toast ────────────────────────────────────────────────────────
function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast${type === 'success' ? ' toast-success' : type === 'error' ? ' toast-error' : ''}`;
  el.textContent = msg;
  $('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ── modal ────────────────────────────────────────────────────────
const openModal  = id => $(id).classList.remove('hidden');
const closeModal = id => $(id).classList.add('hidden');

document.addEventListener('click', e => {
  const btn = e.target.closest('[data-close]');
  if (btn) closeModal(btn.dataset.close);
  if (e.target.classList.contains('modal-overlay')) closeModal(e.target.id);
});

// ── helpers ──────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

function badge(status) {
  const map = {
    success: 'badge-success', failure: 'badge-error',
    running: 'badge-running', queued: 'badge-info',
  };
  return `<span class="badge ${map[status] || 'badge-info'}">${esc(status)}</span>`;
}

// ── render ───────────────────────────────────────────────────────
function renderAccounts() {
  const list = $('account-list');
  if (!S.accounts.length) {
    list.innerHTML = '<div style="padding:6px 10px;font-size:13px;color:var(--text-tertiary)">暂无账户</div>';
    return;
  }
  list.innerHTML = S.accounts.map(a => `
    <button class="nav-item ${a.id === S.selectedId ? 'active' : ''}" data-id="${a.id}" style="margin-bottom:2px">
      <span class="nav-icon">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">
          <rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/>
        </svg>
      </span>
      <span class="nav-item-text">${esc(a.name)}</span>
    </button>`).join('');
  list.querySelectorAll('.nav-item[data-id]').forEach(el =>
    el.addEventListener('click', () => selectAccount(el.dataset.id)));
}

function renderVms() {
  const tbody = $('vm-tbody');
  if (!S.vms.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:40px;color:var(--text-secondary);font-size:13px">暂无虚拟机</td></tr>`;
    return;
  }
  tbody.innerHTML = S.vms.map(vm => {
    const ps  = vm.powerState || '-';
    const bc  = ps.includes('running') ? 'badge-success' : ps.includes('stopped') ? 'badge-error' : 'badge-info';
    const ip  = vm.publicIpAddress || '-';
    const rg  = esc(vm.resourceGroup);
    const vmn = esc(vm.name);
    return `<tr>
      <td><strong>${vmn}</strong></td>
      <td class="text-muted" style="font-size:12px">${rg}</td>
      <td class="text-muted" style="font-size:12px">${esc(vm.location)}</td>
      <td class="text-muted" style="font-size:12px">${esc(vm.vmSize||'-')}</td>
      <td><span class="badge ${bc}">${esc(ps)}</span></td>
      <td class="mono">${esc(ip)}</td>
      <td>
        <div class="btn-group">
          <button class="btn btn-secondary btn-sm" onclick="confirmVmAction('start','${rg}','${vmn}')">启动</button>
          <button class="btn btn-secondary btn-sm" onclick="confirmVmAction('stop','${rg}','${vmn}')">停止</button>
          <button class="btn btn-secondary btn-sm" onclick="confirmVmAction('restart','${rg}','${vmn}')">重启</button>
          <button class="btn btn-secondary btn-sm" onclick="confirmChangeIp('${rg}','${vmn}')">换 IP</button>
          <button class="btn btn-danger-ghost btn-sm" onclick="confirmVmAction('delete','${rg}','${vmn}')">删除</button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

function renderTaskList(tasks) {
  const list = $('task-list');
  if (!tasks.length) {
    list.innerHTML = `<div style="text-align:center;padding:40px;color:var(--text-secondary);font-size:13px">暂无任务记录</div>`;
    return;
  }
  list.innerHTML = tasks.map(t => `
    <div class="task-card" onclick="showTaskDetail('${t.id}')">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:4px">
        <span style="font-size:13px;font-weight:600">${esc(t.message || t.type)}</span>
        ${badge(t.status)}
      </div>
      <div style="font-size:12px;color:var(--text-secondary)">${esc(t.createdAt || '')}</div>
    </div>`).join('');
}

// ── select account ───────────────────────────────────────────────
async function selectAccount(id) {
  try {
    await api('POST', '/api/session', { accountId: id });
    S.selectedId   = id;
    S.selectedName = S.accounts.find(a => a.id === id)?.name || '';
    renderAccounts();
    $('account-title').textContent    = S.selectedName;
    $('account-subtitle').textContent = `Azure 订阅`;
    $('view-no-account').classList.add('hidden');
    $('view-account').classList.remove('hidden');
    await Promise.all([loadVms(), loadRegions(), loadStartupScript()]);
  } catch (e) { toast(e.message, 'error'); }
}

async function loadAccounts() {
  S.accounts = await api('GET', '/api/accounts');
  renderAccounts();
}

async function loadVms() {
  try {
    S.vms = await api('GET', '/api/vms');
    renderVms();
  } catch (e) { toast(`加载虚拟机失败: ${e.message}`, 'error'); }
}

async function loadRegions() {
  try {
    S.regions = await api('GET', '/api/regions');
    const sel = $('create-region');
    sel.innerHTML = S.regions.map(r => `<option value="${esc(r.name)}">${esc(r.displayName)}</option>`).join('');
  } catch { /* non-critical */ }
}

async function loadStartupScript() {
  try {
    const d = await api('GET', '/api/settings/startup-script');
    $('startup-script').value = d.userData || '';
  } catch { /* non-critical */ }
}

// ── vm actions ───────────────────────────────────────────────────
function confirmVmAction(action, rg, vm) {
  const labels = { start:'启动', stop:'停止', restart:'重启', delete:'删除资源组' };
  S.pendingAction = { kind: 'vm-action', action, resourceGroup: rg, vmName: vm };
  $('confirm-title').textContent = `${labels[action]} — ${vm}`;
  $('confirm-desc').textContent  = action === 'delete'
    ? `确认删除资源组 ${rg}？此操作不可撤销，将删除该资源组内的所有资源。`
    : `确认对虚拟机 ${vm} 执行「${labels[action]}」操作？`;
  const btn = $('btn-confirm');
  btn.className = action === 'delete' ? 'btn btn-danger' : 'btn btn-primary';
  openModal('modal-confirm');
}

function confirmChangeIp(rg, vm) {
  S.pendingAction = { kind: 'change-ip', resourceGroup: rg, vmName: vm };
  $('confirm-title').textContent = `更换公网 IP — ${vm}`;
  $('confirm-desc').textContent  = `确认为虚拟机 ${vm} 更换公网 IP？操作期间 IP 将短暂不可用。`;
  $('btn-confirm').className = 'btn btn-primary';
  openModal('modal-confirm');
}

$('btn-confirm').addEventListener('click', async () => {
  const p = S.pendingAction;
  if (!p) return;
  closeModal('modal-confirm');
  S.pendingAction = null;
  try {
    let task;
    if (p.kind === 'change-ip') {
      task = await api('POST', '/api/vm-change-ip', { resourceGroup: p.resourceGroup, vmName: p.vmName });
    } else {
      task = await api('POST', '/api/vm-action', { action: p.action, resourceGroup: p.resourceGroup, vmName: p.vmName });
    }
    toast('操作已提交', 'success');
    trackTask(task.taskId);
  } catch (e) { toast(e.message, 'error'); }
});

// ── task tracking ────────────────────────────────────────────────
function trackTask(taskId) {
  if (S.trackingTasks.has(taskId)) return;
  S.trackingTasks.add(taskId);
  pollTask(taskId);
}

async function pollTask(taskId) {
  for (let i = 0; i < 180; i++) {
    await new Promise(r => setTimeout(r, 5000));
    try {
      const t = await api('GET', `/api/task_status/${taskId}`);
      if (t.status === 'success') {
        toast('任务完成', 'success');
        S.trackingTasks.delete(taskId);
        if (S.selectedId) loadVms();
        return;
      }
      if (t.status === 'failure') {
        toast(`任务失败: ${t.errorMessage || t.message}`, 'error');
        S.trackingTasks.delete(taskId);
        return;
      }
    } catch { /* continue */ }
  }
  S.trackingTasks.delete(taskId);
}

async function showTaskDetail(taskId) {
  try {
    const t = await api('GET', `/api/task_status/${taskId}`);
    $('task-detail-info').innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
        ${badge(t.status)}
        <span style="font-size:14px;font-weight:600">${esc(t.message || '')}</span>
      </div>
      ${t.result ? `<pre class="result-pre">${esc(JSON.stringify(t.result, null, 2))}</pre>` : ''}`;
    $('task-detail-logs').innerHTML = (t.logs || []).map(l => `
      <div class="log-item ${l.level === 'error' ? 'error' : ''}">
        <span class="log-time">${esc(l.createdAt?.slice(11,19) || '')}</span>
        <span class="log-step">[${esc(l.step)}]</span>
        <span>${esc(l.message)}</span>
      </div>`).join('');
    openModal('modal-task');
  } catch (e) { toast(e.message, 'error'); }
}

// ── account modal ─────────────────────────────────────────────────
function openAddAccount() {
  S.pendingAccountMode = 'add';
  $('modal-account-title').textContent     = '添加 Azure 账户';
  $('account-edit-id').value               = '';
  $('account-name').value                  = '';
  $('account-client-id').value             = '';
  $('account-client-secret').value         = '';
  $('account-tenant-id').value             = '';
  $('account-subscription-id').value       = '';
  $('account-expiration').value            = '';
  $('account-creds-section').style.display = '';
  $('btn-check-creds').style.display       = '';
  $('account-check-result').className      = 'check-result hidden';
  openModal('modal-account');
}

$('btn-add-account').addEventListener('click', openAddAccount);
$('btn-add-account-empty').addEventListener('click', openAddAccount);

$('btn-edit-account').addEventListener('click', () => {
  const acc = S.accounts.find(a => a.id === S.selectedId);
  if (!acc) return;
  S.pendingAccountMode = 'edit';
  $('modal-account-title').textContent     = '编辑账户';
  $('account-edit-id').value               = acc.id;
  $('account-name').value                  = acc.name;
  $('account-expiration').value            = acc.expirationDate || '';
  $('account-creds-section').style.display = 'none';
  $('btn-check-creds').style.display       = 'none';
  $('account-check-result').className      = 'check-result hidden';
  openModal('modal-account');
});

$('btn-check-creds').addEventListener('click', async () => {
  const btn = $('btn-check-creds');
  const res = $('account-check-result');
  btn.disabled = true; btn.textContent = '检查中...';
  try {
    const d = await api('POST', '/api/accounts/check', {
      clientId:       $('account-client-id').value.trim(),
      clientSecret:   $('account-client-secret').value.trim(),
      tenantId:       $('account-tenant-id').value.trim(),
      subscriptionId: $('account-subscription-id').value.trim(),
    });
    res.className   = 'check-result ok';
    res.textContent = `✓ ${d.subscriptionDisplayName} · ${d.state} · ${d.availableRegionCount} 个可用区域`;
  } catch (e) {
    res.className   = 'check-result fail';
    res.textContent = `✗ ${e.message}`;
  } finally {
    res.classList.remove('hidden');
    btn.disabled = false; btn.textContent = '检查账户';
  }
});

$('btn-save-account').addEventListener('click', async () => {
  const btn = $('btn-save-account');
  btn.disabled = true;
  try {
    if (S.pendingAccountMode === 'add') {
      await api('POST', '/api/accounts', {
        name:           $('account-name').value.trim(),
        clientId:       $('account-client-id').value.trim(),
        clientSecret:   $('account-client-secret').value.trim(),
        tenantId:       $('account-tenant-id').value.trim(),
        subscriptionId: $('account-subscription-id').value.trim(),
        expirationDate: $('account-expiration').value || null,
      });
      closeModal('modal-account');
      await loadAccounts();
      toast('账户已添加', 'success');
    } else {
      await api('POST', '/api/accounts/edit', {
        accountId:      $('account-edit-id').value,
        newName:        $('account-name').value.trim(),
        expirationDate: $('account-expiration').value || null,
      });
      S.selectedName = $('account-name').value.trim();
      $('account-title').textContent = S.selectedName;
      closeModal('modal-account');
      await loadAccounts();
      toast('账户已更新', 'success');
    }
  } catch (e) { toast(e.message, 'error'); }
  finally { btn.disabled = false; }
});

// ── delete account ────────────────────────────────────────────────
$('btn-delete-account').addEventListener('click', async () => {
  if (!S.selectedId) return;
  const acc = S.accounts.find(a => a.id === S.selectedId);
  if (!confirm(`确认删除账户「${acc?.name}」？`)) return;
  try {
    await api('DELETE', `/api/accounts/${S.selectedId}`);
    S.selectedId = null; S.selectedName = null;
    $('view-account').classList.add('hidden');
    $('view-no-account').classList.remove('hidden');
    await loadAccounts();
    toast('账户已删除', 'success');
  } catch (e) { toast(e.message, 'error'); }
});

// ── tabs ──────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(t => {
  t.addEventListener('click', () => {
    S.activeTab = t.dataset.tab;
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    ['vms','tasks','settings'].forEach(name =>
      $(`tab-${name}`).classList.toggle('hidden', name !== S.activeTab));
    if (S.activeTab === 'tasks') renderTaskList([]);
  });
});

// ── create VM ─────────────────────────────────────────────────────
$('btn-create-vm').addEventListener('click', () => openModal('modal-create-vm'));

$('btn-submit-create-vm').addEventListener('click', async () => {
  const btn = $('btn-submit-create-vm');
  btn.disabled = true;
  try {
    const userData = $('create-userdata').value.trim();
    const task = await api('POST', '/api/create-vm', {
      region:   $('create-region').value,
      vmSize:   $('create-vm-size').value,
      osImage:  $('create-os').value,
      diskSize: parseInt($('create-disk').value),
      ipType:   $('create-ip-type').value,
      userData: userData || null,
    });
    closeModal('modal-create-vm');
    toast('创建任务已提交', 'success');
    trackTask(task.taskId);
  } catch (e) { toast(e.message, 'error'); }
  finally { btn.disabled = false; }
});

// ── settings ──────────────────────────────────────────────────────
$('btn-save-script').addEventListener('click', async () => {
  const btn = $('btn-save-script');
  btn.disabled = true;
  try {
    await api('POST', '/api/settings/startup-script', { userData: $('startup-script').value });
    toast('脚本已保存', 'success');
  } catch (e) { toast(e.message, 'error'); }
  finally { btn.disabled = false; }
});

// ── refresh ───────────────────────────────────────────────────────
$('btn-refresh').addEventListener('click', async () => {
  if (!S.selectedId) return;
  await loadVms();
  toast('已刷新');
});

// ── login / logout ────────────────────────────────────────────────
$('login-btn').addEventListener('click', async () => {
  const err = $('login-error');
  err.classList.add('hidden');
  try {
    await api('POST', '/auth/login', { password: $('login-password').value });
    await loadAccounts();
    $('login-screen').style.display = 'none';
    $('app').style.display = 'block';
  } catch (e) {
    err.textContent = e.status === 401 ? '密码错误，请重试' : e.message;
    err.classList.remove('hidden');
  }
});

$('login-password').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('login-btn').click();
});

$('btn-logout').addEventListener('click', async () => {
  await api('POST', '/auth/logout').catch(() => {});
  location.reload();
});

// ── init ──────────────────────────────────────────────────────────
async function init() {
  try {
    const session = await api('GET', '/api/session');
    if (!session.loggedIn) return;
    await loadAccounts();
    $('login-screen').style.display = 'none';
    $('app').style.display = 'block';
    if (session.selectedAccountId) {
      S.selectedId   = session.selectedAccountId;
      S.selectedName = session.selectedAccountName || '';
      const acc = S.accounts.find(a => a.id === S.selectedId);
      if (acc) {
        $('account-title').textContent = acc.name;
        $('view-no-account').classList.add('hidden');
        $('view-account').classList.remove('hidden');
        renderAccounts();
        await Promise.all([loadVms(), loadRegions(), loadStartupScript()]);
      }
    }
  } catch { /* stay on login */ }
}

init();
