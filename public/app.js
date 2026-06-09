// ── state ──────────────────────────────────────────────────────────────────
const S = {
  accounts: [],
  selectedId: null,
  selectedName: null,
  vms: [],
  regions: [],
  activeTab: 'vms',
  pendingAction: null,        // { kind, action?, resourceGroup, vmName }
  pendingAccountMode: null,   // 'add' | 'edit'
  trackingTasks: new Set(),
};

// ── api ────────────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { status: res.status, data });
  return data;
}

// ── toast ──────────────────────────────────────────────────────────────────
function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  $('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ── modal ──────────────────────────────────────────────────────────────────
const openModal = id => $(id).classList.remove('hidden');
const closeModal = id => $(id).classList.add('hidden');

document.addEventListener('click', e => {
  const btn = e.target.closest('[data-close]');
  if (btn) closeModal(btn.dataset.close);
  if (e.target.classList.contains('modal-overlay')) closeModal(e.target.id);
});

// ── helpers ────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

function setBadge(status) {
  const map = { success: 'badge-success', failure: 'badge-error', running: 'badge-running', queued: 'badge-info' };
  return `<span class="badge ${map[status] || 'badge-info'}">${esc(status)}</span>`;
}

// ── render ─────────────────────────────────────────────────────────────────
function renderAccounts() {
  $('sidebar-subtitle').textContent = `${S.accounts.length} 个账户`;
  $('account-list').innerHTML = S.accounts.length
    ? S.accounts.map(a => `
        <div class="account-item ${a.id === S.selectedId ? 'active' : ''}" data-id="${a.id}">
          <span class="account-dot ok"></span>
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px">${esc(a.name)}</span>
        </div>`).join('')
    : '<div style="padding:8px 8px;font-size:13px;color:var(--text2)">暂无账户</div>';

  $('account-list').querySelectorAll('.account-item').forEach(el =>
    el.addEventListener('click', () => selectAccount(el.dataset.id)));
}

function renderVms() {
  const tbody = $('vm-tbody');
  if (!S.vms.length) {
    tbody.innerHTML = '<tr><td colspan="7"><div class="empty">暂无虚拟机</div></td></tr>';
    return;
  }
  tbody.innerHTML = S.vms.map(vm => {
    const ps = vm.powerState || '-';
    const bc = ps.includes('running') ? 'badge-success' : ps.includes('stopped') ? 'badge-error' : 'badge-info';
    return `<tr>
      <td><strong>${esc(vm.name)}</strong></td>
      <td style="color:var(--text2);font-size:12px">${esc(vm.resourceGroup)}</td>
      <td style="color:var(--text2);font-size:12px">${esc(vm.location)}</td>
      <td style="color:var(--text2);font-size:12px">${esc(vm.vmSize||'-')}</td>
      <td><span class="badge ${bc}">${esc(ps)}</span></td>
      <td style="font-family:monospace;font-size:12px">${esc(vm.publicIpAddress||'-')}</td>
      <td><div class="btn-group">
        <button class="btn btn-sm" onclick="confirmVmAction('start','${esc(vm.resourceGroup)}','${esc(vm.name)}')">启动</button>
        <button class="btn btn-sm" onclick="confirmVmAction('stop','${esc(vm.resourceGroup)}','${esc(vm.name)}')">停止</button>
        <button class="btn btn-sm" onclick="confirmVmAction('restart','${esc(vm.resourceGroup)}','${esc(vm.name)}')">重启</button>
        <button class="btn btn-sm" onclick="confirmChangeIp('${esc(vm.resourceGroup)}','${esc(vm.name)}')">换IP</button>
        <button class="btn btn-sm btn-danger" onclick="confirmVmAction('delete','${esc(vm.resourceGroup)}','${esc(vm.name)}')">删除</button>
      </div></td>
    </tr>`;
  }).join('');
}

function renderTaskList(tasks) {
  $('task-list').innerHTML = tasks.length
    ? tasks.map(t => `
        <div style="background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius);padding:12px 16px;margin-bottom:8px;cursor:pointer"
             onclick="showTaskDetail('${t.id}')">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
            <span style="font-size:13px;font-weight:500">${esc(t.message||t.type)}</span>
            ${setBadge(t.status)}
          </div>
          <div style="font-size:12px;color:var(--text2)">${esc(t.createdAt||'')}</div>
        </div>`).join('')
    : '<div class="empty">暂无任务记录</div>';
}

// ── actions ────────────────────────────────────────────────────────────────
async function selectAccount(id) {
  try {
    await api('POST', '/api/session', { accountId: id });
    S.selectedId = id;
    S.selectedName = S.accounts.find(a => a.id === id)?.name || '';
    renderAccounts();
    $('account-title').textContent = S.selectedName;
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

// ── vm action confirm ──────────────────────────────────────────────────────
function confirmVmAction(action, rg, vm) {
  const labels = { start: '启动', stop: '停止', restart: '重启', delete: '删除资源组' };
  S.pendingAction = { kind: 'vm-action', action, resourceGroup: rg, vmName: vm };
  $('confirm-title').textContent = `${labels[action]} — ${vm}`;
  $('confirm-desc').textContent = action === 'delete'
    ? `确认删除资源组 ${rg}？此操作不可撤销，将删除该资源组内的所有资源。`
    : `确认对虚拟机 ${vm} 执行「${labels[action]}」操作？`;
  openModal('modal-confirm');
}

function confirmChangeIp(rg, vm) {
  S.pendingAction = { kind: 'change-ip', resourceGroup: rg, vmName: vm };
  $('confirm-title').textContent = `更换公网 IP — ${vm}`;
  $('confirm-desc').textContent = `确认为虚拟机 ${vm} 更换公网 IP？操作期间 IP 将短暂不可用。`;
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
    toast(`操作已提交`, 'success');
    trackTask(task.taskId);
  } catch (e) { toast(e.message, 'error'); }
});

// ── task tracking ──────────────────────────────────────────────────────────
function trackTask(taskId) {
  if (S.trackingTasks.has(taskId)) return;
  S.trackingTasks.add(taskId);
  pollTask(taskId);
}

async function pollTask(taskId) {
  for (let i = 0; i < 180; i++) {
    await sleep(5000);
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

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function showTaskDetail(taskId) {
  try {
    const t = await api('GET', `/api/task_status/${taskId}`);
    $('task-info').innerHTML = `
      <div style="display:flex;gap:10px;align-items:center;margin-bottom:12px">
        ${setBadge(t.status)}
        <span style="font-size:13px">${esc(t.message||'')}</span>
      </div>
      ${t.result ? `<pre style="font-size:12px;background:var(--bg2);padding:12px;border-radius:6px;overflow:auto;margin-bottom:12px;max-height:160px">${esc(JSON.stringify(t.result,null,2))}</pre>` : ''}`;
    $('task-logs').innerHTML = (t.logs||[]).map(l => `
      <div class="log-item ${l.level==='error'?'error':''}">
        <span class="log-time">${esc(l.createdAt?.slice(11,19)||'')}</span>
        <span class="log-step">[${esc(l.step)}]</span>
        <span>${esc(l.message)}</span>
      </div>`).join('');
    openModal('modal-task');
  } catch (e) { toast(e.message, 'error'); }
}

// ── account modal ──────────────────────────────────────────────────────────
$('btn-add-account').addEventListener('click', () => {
  S.pendingAccountMode = 'add';
  $('modal-account-title').textContent = '添加 Azure 账户';
  $('account-edit-id').value = '';
  $('account-name').value = '';
  $('account-client-id').value = '';
  $('account-client-secret').value = '';
  $('account-tenant-id').value = '';
  $('account-subscription-id').value = '';
  $('account-expiration').value = '';
  $('account-creds').style.display = '';
  $('btn-check-creds').style.display = '';
  $('account-check-result').className = 'hidden check-result';
  openModal('modal-account');
});

$('btn-edit-account').addEventListener('click', () => {
  const acc = S.accounts.find(a => a.id === S.selectedId);
  if (!acc) return;
  S.pendingAccountMode = 'edit';
  $('modal-account-title').textContent = '编辑账户';
  $('account-edit-id').value = acc.id;
  $('account-name').value = acc.name;
  $('account-expiration').value = acc.expirationDate || '';
  $('account-creds').style.display = 'none';
  $('btn-check-creds').style.display = 'none';
  $('account-check-result').className = 'hidden check-result';
  openModal('modal-account');
});

$('btn-check-creds').addEventListener('click', async () => {
  const btn = $('btn-check-creds');
  const res = $('account-check-result');
  btn.disabled = true; btn.textContent = '检查中...';
  try {
    const d = await api('POST', '/api/accounts/check', {
      clientId: $('account-client-id').value.trim(),
      clientSecret: $('account-client-secret').value.trim(),
      tenantId: $('account-tenant-id').value.trim(),
      subscriptionId: $('account-subscription-id').value.trim(),
    });
    res.className = 'check-result ok';
    res.textContent = `✓ ${d.subscriptionDisplayName} | ${d.state} | ${d.availableRegionCount} 个区域`;
  } catch (e) {
    res.className = 'check-result fail';
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
      const exp = $('account-expiration').value;
      await api('POST', '/api/accounts', {
        name: $('account-name').value.trim(),
        clientId: $('account-client-id').value.trim(),
        clientSecret: $('account-client-secret').value.trim(),
        tenantId: $('account-tenant-id').value.trim(),
        subscriptionId: $('account-subscription-id').value.trim(),
        expirationDate: exp || null,
      });
      closeModal('modal-account');
      await loadAccounts();
      toast('账户已添加', 'success');
    } else {
      const exp = $('account-expiration').value;
      await api('POST', '/api/accounts/edit', {
        accountId: $('account-edit-id').value,
        newName: $('account-name').value.trim(),
        expirationDate: exp || null,
      });
      closeModal('modal-account');
      S.selectedName = $('account-name').value.trim();
      $('account-title').textContent = S.selectedName;
      await loadAccounts();
      toast('账户已更新', 'success');
    }
  } catch (e) { toast(e.message, 'error'); }
  finally { btn.disabled = false; }
});

// ── delete account ─────────────────────────────────────────────────────────
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

// ── tabs ───────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(t => {
  t.addEventListener('click', () => {
    S.activeTab = t.dataset.tab;
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    ['vms','tasks','settings'].forEach(name =>
      $(`tab-${name}`).classList.toggle('hidden', name !== S.activeTab));
    if (S.activeTab === 'tasks') loadTaskHistory();
  });
});

async function loadTaskHistory() {
  // 任务历史需要后端 /api/tasks 接口，当前只展示空状态
  renderTaskList([]);
}

// ── create VM ──────────────────────────────────────────────────────────────
$('btn-create-vm').addEventListener('click', () => openModal('modal-create-vm'));

$('btn-submit-create-vm').addEventListener('click', async () => {
  const btn = $('btn-submit-create-vm');
  btn.disabled = true;
  try {
    const userData = $('create-userdata').value.trim();
    const task = await api('POST', '/api/create-vm', {
      region: $('create-region').value,
      vmSize: $('create-vm-size').value,
      osImage: $('create-os').value,
      diskSize: parseInt($('create-disk').value),
      ipType: $('create-ip-type').value,
      userData: userData || null,
    });
    closeModal('modal-create-vm');
    toast(`创建任务已提交`, 'success');
    trackTask(task.taskId);
  } catch (e) { toast(e.message, 'error'); }
  finally { btn.disabled = false; }
});

// ── settings ───────────────────────────────────────────────────────────────
$('btn-save-script').addEventListener('click', async () => {
  const btn = $('btn-save-script');
  btn.disabled = true;
  try {
    await api('POST', '/api/settings/startup-script', { userData: $('startup-script').value });
    toast('脚本已保存', 'success');
  } catch (e) { toast(e.message, 'error'); }
  finally { btn.disabled = false; }
});

// ── refresh ────────────────────────────────────────────────────────────────
$('btn-refresh').addEventListener('click', async () => {
  if (!S.selectedId) return;
  await loadVms();
  toast('已刷新');
});

// ── login / logout ─────────────────────────────────────────────────────────
$('login-btn').addEventListener('click', async () => {
  const pw = $('login-password').value;
  const err = $('login-error');
  err.classList.add('hidden');
  try {
    await api('POST', '/auth/login', { password: pw });
    await loadAccounts();
    $('login-screen').style.display = 'none';
    $('app').style.display = 'block';
  } catch (e) {
    err.textContent = e.status === 401 ? '密码错误' : e.message;
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

// ── init ───────────────────────────────────────────────────────────────────
async function init() {
  try {
    const session = await api('GET', '/api/session');
    if (!session.loggedIn) { return; }
    await loadAccounts();
    $('login-screen').style.display = 'none';
    $('app').style.display = 'block';
    if (session.selectedAccountId) {
      S.selectedId = session.selectedAccountId;
      S.selectedName = session.selectedAccountName;
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
