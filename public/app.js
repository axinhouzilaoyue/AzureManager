// ── state ─────────────────────────────────────────────────────
const S = {
  accounts:      [],
  activePage:    'overview',
  selectedAccId: null,   // selected account for VM view
  vms:           [],
  regions:       [],
  activeVTab:    'vms',
  pendingAction: null,
  trackingTasks: new Set(),
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

// ── toast ─────────────────────────────────────────────────────
function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast${type === 'success' ? ' t-ok' : type === 'error' ? ' t-err' : ''}`;
  el.textContent = msg;
  $('tc').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ── modal ─────────────────────────────────────────────────────
const openModal  = id => $(id).classList.remove('hidden');
const closeModal = id => $(id).classList.add('hidden');
document.addEventListener('click', e => {
  const b = e.target.closest('[data-close]');
  if (b) closeModal(b.dataset.close);
  if (e.target.classList.contains('mo')) closeModal(e.target.id);
});

// ── utils ─────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

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

// ── page navigation ───────────────────────────────────────────
const PAGES = ['overview','accounts','add','settings','help'];

function switchPage(page) {
  S.activePage = page;
  PAGES.forEach(p => {
    $(`pg-${p}`).classList.toggle('hidden', p !== page);
    const ni = $(`ni-${p}`);
    if (ni) ni.classList.toggle('active', p === page);
  });
  if (page === 'overview')  refreshOverview();
  if (page === 'accounts')  showAccList();
  if (page === 'settings')  loadStartupScript();
  if (page === 'add')       resetAddForm();
}

document.querySelectorAll('.ni[data-page]').forEach(el => {
  el.addEventListener('click', () => switchPage(el.dataset.page));
});

// ── sidebar toggle ────────────────────────────────────────────
$('sbtoggle').addEventListener('click', () => $('sidebar').classList.toggle('col'));

// ── overview ─────────────────────────────────────────────────
function refreshOverview() {
  $('hero-greeting').textContent = greeting();
  $('stat-accounts').textContent = S.accounts.length;
}

// ── account list (pg-accounts) ────────────────────────────────
function showAccList() {
  $('view-acc-list').classList.remove('hidden');
  $('view-vms').classList.add('hidden');
  renderAccGrid();
}

function renderAccGrid() {
  const g = $('acc-grid');
  if (!S.accounts.length) {
    g.innerHTML = `
      <div class="empty" style="grid-column:1/-1">
        <div class="empty-ico">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="color:var(--tx3)"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/></svg>
        </div>
        <h3>暂无账户</h3>
        <p>点击「添加账户」绑定 Azure Service Principal 凭据</p>
        <button class="btn btn-p mt2" onclick="switchPage('add')">添加账户</button>
      </div>`;
    return;
  }
  g.innerHTML = S.accounts.map(a => `
    <div class="acc-card${a.id === S.selectedAccId ? ' selected' : ''}" data-id="${a.id}">
      <div class="acc-card-name">${esc(a.name)}</div>
      <div class="acc-card-meta">Sub: ${esc(a.subscriptionId)}</div>
      <div class="acc-card-meta" style="margin-top:2px">Client: ${esc(a.clientId)}</div>
      ${a.expirationDate ? `<div class="acc-card-meta" style="margin-top:2px;color:var(--err)">到期: ${esc(a.expirationDate)}</div>` : ''}
      <div class="acc-card-foot">
        <span class="badge bg-inf" style="font-size:10px">${esc(a.tenantId?.slice(0,8))}…</span>
        <button class="btn btn-p btn-sm" data-id="${a.id}" onclick="openVmView('${a.id}',event)">查看虚拟机 →</button>
      </div>
    </div>`).join('');
}

async function openVmView(accId, e) {
  if (e) e.stopPropagation();
  S.selectedAccId = accId;
  const acc = S.accounts.find(a => a.id === accId);
  $('vm-acc-title').textContent = acc?.name || '-';
  $('vm-acc-sub').textContent   = acc?.subscriptionId || '';
  $('view-acc-list').classList.add('hidden');
  $('view-vms').classList.remove('hidden');
  // store selected in session
  await api('POST', '/api/session', { accountId: accId }).catch(() => {});
  await Promise.all([loadVms(), loadRegions()]);
}

$('btn-back-accounts').addEventListener('click', () => {
  S.selectedAccId = null;
  api('DELETE', '/api/session').catch(() => {});
  showAccList();
});

// ── vms ───────────────────────────────────────────────────────
async function loadVms() {
  try {
    S.vms = await api('GET', '/api/vms');
    renderVms();
  } catch (e) { toast(`加载虚拟机失败: ${e.message}`, 'error'); }
}

function renderVms() {
  const tb = $('vm-tbody');
  if (!S.vms.length) {
    tb.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:36px;color:var(--tx2);font-size:13px">暂无虚拟机</td></tr>`;
    return;
  }
  tb.innerHTML = S.vms.map(vm => {
    const ps  = vm.powerState || '-';
    const bc  = ps.includes('running') ? 'bg-ok' : ps.includes('stopped') ? 'bg-err' : 'bg-inf';
    const rg  = esc(vm.resourceGroup);
    const vmn = esc(vm.name);
    return `<tr>
      <td><strong>${vmn}</strong></td>
      <td class="muted small">${rg}</td>
      <td class="muted small">${esc(vm.location)}</td>
      <td class="muted small">${esc(vm.vmSize||'-')}</td>
      <td><span class="badge ${bc}">${esc(ps)}</span></td>
      <td class="mono">${esc(vm.publicIpAddress||'-')}</td>
      <td><div class="bgrp">
        <button class="btn btn-s btn-sm" onclick="vmAction('start','${rg}','${vmn}')">启动</button>
        <button class="btn btn-s btn-sm" onclick="vmAction('stop','${rg}','${vmn}')">停止</button>
        <button class="btn btn-s btn-sm" onclick="vmAction('restart','${rg}','${vmn}')">重启</button>
        <button class="btn btn-s btn-sm" onclick="changeIp('${rg}','${vmn}')">换IP</button>
        <button class="btn btn-dg btn-sm" onclick="vmAction('delete','${rg}','${vmn}')">删除</button>
      </div></td>
    </tr>`;
  }).join('');
}

async function loadRegions() {
  try {
    S.regions = await api('GET', '/api/regions');
    const sel = $('create-region');
    sel.innerHTML = S.regions.map(r => `<option value="${esc(r.name)}">${esc(r.displayName)}</option>`).join('');
  } catch { /* non-critical */ }
}

// ── vm action confirm ─────────────────────────────────────────
function vmAction(action, rg, vm) {
  const labels = { start:'启动', stop:'停止', restart:'重启', delete:'删除资源组' };
  S.pendingAction = { kind:'vm', action, resourceGroup:rg, vmName:vm };
  $('cf-title').textContent = `${labels[action]} — ${vm}`;
  $('cf-desc').textContent  = action === 'delete'
    ? `确认删除资源组 ${rg}？此操作不可撤销，将删除该资源组内所有资源。`
    : `确认对虚拟机 ${vm} 执行「${labels[action]}」操作？`;
  $('btn-cf').className = action === 'delete' ? 'btn btn-d' : 'btn btn-p';
  openModal('mo-confirm');
}

function changeIp(rg, vm) {
  S.pendingAction = { kind:'ip', resourceGroup:rg, vmName:vm };
  $('cf-title').textContent = `更换公网 IP — ${vm}`;
  $('cf-desc').textContent  = `确认为虚拟机 ${vm} 更换公网 IP？操作期间 IP 将短暂不可用。`;
  $('btn-cf').className = 'btn btn-p';
  openModal('mo-confirm');
}

$('btn-cf').addEventListener('click', async () => {
  const p = S.pendingAction;
  if (!p) return;
  closeModal('mo-confirm');
  S.pendingAction = null;
  try {
    let task;
    if (p.kind === 'ip') {
      task = await api('POST', '/api/vm-change-ip', { resourceGroup: p.resourceGroup, vmName: p.vmName });
    } else {
      task = await api('POST', '/api/vm-action', { action: p.action, resourceGroup: p.resourceGroup, vmName: p.vmName });
    }
    toast('操作已提交', 'success');
    trackTask(task.taskId);
  } catch (e) { toast(e.message, 'error'); }
});

// ── vm tabs ───────────────────────────────────────────────────
document.querySelectorAll('.tab[data-vtab]').forEach(t => {
  t.addEventListener('click', () => {
    S.activeVTab = t.dataset.vtab;
    document.querySelectorAll('.tab[data-vtab]').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    $('vtab-vms').classList.toggle('hidden',   S.activeVTab !== 'vms');
    $('vtab-tasks').classList.toggle('hidden', S.activeVTab !== 'tasks');
    if (S.activeVTab === 'tasks') renderTaskList([]);
  });
});

function renderTaskList(tasks) {
  $('task-list').innerHTML = tasks.length
    ? tasks.map(t => `
        <div style="background:var(--bg2);border:1px solid var(--bd);border-radius:var(--r);padding:14px 18px;cursor:pointer;transition:border-color var(--t)" onclick="showTaskDetail('${t.id}')">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
            <span style="font-size:13px;font-weight:600">${esc(t.message||t.type)}</span>
            ${badge(t.status)}
          </div>
          <div class="muted small">${esc(t.createdAt||'')}</div>
        </div>`).join('')
    : `<div class="muted" style="padding:32px;text-align:center;font-size:13px">暂无任务记录</div>`;
}

// ── task tracking ─────────────────────────────────────────────
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
        if (S.selectedAccId) loadVms();
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
    $('task-info').innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
        ${badge(t.status)}
        <span style="font-size:14px;font-weight:600">${esc(t.message||'')}</span>
      </div>
      ${t.result ? `<pre class="rp">${esc(JSON.stringify(t.result,null,2))}</pre>` : ''}`;
    $('task-logs').innerHTML = (t.logs||[]).map(l => `
      <div class="log ${l.level==='error'?'err':''}">
        <span class="log-t">${esc(l.createdAt?.slice(11,19)||'')}</span>
        <span class="log-s">[${esc(l.step)}]</span>
        <span>${esc(l.message)}</span>
      </div>`).join('');
    openModal('mo-task');
  } catch (e) { toast(e.message, 'error'); }
}

// ── create VM ─────────────────────────────────────────────────
$('btn-create-vm').addEventListener('click', () => openModal('mo-create-vm'));

$('btn-submit-vm').addEventListener('click', async () => {
  const btn = $('btn-submit-vm');
  btn.disabled = true;
  try {
    const ud = $('create-ud').value.trim();
    const task = await api('POST', '/api/create-vm', {
      region:   $('create-region').value,
      vmSize:   $('create-size').value,
      osImage:  $('create-os').value,
      diskSize: parseInt($('create-disk').value),
      ipType:   $('create-ip').value,
      userData: ud || null,
    });
    closeModal('mo-create-vm');
    toast('创建任务已提交', 'success');
    trackTask(task.taskId);
  } catch (e) { toast(e.message, 'error'); }
  finally { btn.disabled = false; }
});

$('btn-refresh-vms').addEventListener('click', async () => {
  await loadVms(); toast('已刷新');
});

// ── add account (pg-add) ──────────────────────────────────────
function resetAddForm() {
  ['add-name','add-cid','add-tid','add-sec','add-sid'].forEach(id => $(id).value = '');
  $('add-exp').value = '';
  $('add-check-result').className = 'hidden';
}

$('btn-check-add').addEventListener('click', async () => {
  const btn = $('btn-check-add');
  const res = $('add-check-result');
  btn.disabled = true; btn.textContent = '检查中...';
  try {
    const d = await api('POST', '/api/accounts/check', {
      clientId: $('add-cid').value.trim(), clientSecret: $('add-sec').value.trim(),
      tenantId: $('add-tid').value.trim(), subscriptionId: $('add-sid').value.trim(),
    });
    res.className   = 'ok-box';
    res.textContent = `✓ ${d.subscriptionDisplayName} · ${d.state} · ${d.availableRegionCount} 个可用区域`;
  } catch (e) {
    res.className   = 'err-box';
    res.textContent = `✗ ${e.message}`;
  } finally {
    res.classList.remove('hidden');
    btn.disabled = false; btn.textContent = '检查凭据';
  }
});

$('btn-save-add').addEventListener('click', async () => {
  const btn = $('btn-save-add');
  btn.disabled = true;
  try {
    await api('POST', '/api/accounts', {
      name:           $('add-name').value.trim(),
      clientId:       $('add-cid').value.trim(),
      clientSecret:   $('add-sec').value.trim(),
      tenantId:       $('add-tid').value.trim(),
      subscriptionId: $('add-sid').value.trim(),
      expirationDate: $('add-exp').value || null,
    });
    toast('账户已添加', 'success');
    resetAddForm();
    S.accounts = await api('GET', '/api/accounts');
    refreshOverview();
    switchPage('accounts');
  } catch (e) { toast(e.message, 'error'); }
  finally { btn.disabled = false; }
});

// ── edit / delete account ─────────────────────────────────────
$('btn-edit-acc').addEventListener('click', () => {
  const acc = S.accounts.find(a => a.id === S.selectedAccId);
  if (!acc) return;
  $('edit-acc-id').value   = acc.id;
  $('edit-acc-name').value = acc.name;
  $('edit-acc-exp').value  = acc.expirationDate || '';
  openModal('mo-edit-acc');
});

$('btn-save-edit-acc').addEventListener('click', async () => {
  const btn = $('btn-save-edit-acc');
  btn.disabled = true;
  try {
    await api('POST', '/api/accounts/edit', {
      accountId: $('edit-acc-id').value,
      newName:   $('edit-acc-name').value.trim(),
      expirationDate: $('edit-acc-exp').value || null,
    });
    closeModal('mo-edit-acc');
    S.accounts = await api('GET', '/api/accounts');
    const acc = S.accounts.find(a => a.id === S.selectedAccId);
    if (acc) $('vm-acc-title').textContent = acc.name;
    toast('账户已更新', 'success');
  } catch (e) { toast(e.message, 'error'); }
  finally { btn.disabled = false; }
});

$('btn-del-acc').addEventListener('click', async () => {
  const acc = S.accounts.find(a => a.id === S.selectedAccId);
  if (!confirm(`确认删除账户「${acc?.name}」？`)) return;
  try {
    await api('DELETE', `/api/accounts/${S.selectedAccId}`);
    S.selectedAccId = null;
    S.accounts = await api('GET', '/api/accounts');
    refreshOverview();
    showAccList();
    toast('账户已删除', 'success');
  } catch (e) { toast(e.message, 'error'); }
});

// ── settings ──────────────────────────────────────────────────
async function loadStartupScript() {
  try {
    const d = await api('GET', '/api/settings/startup-script');
    $('startup-script').value = d.userData || '';
  } catch { /* non-critical */ }
}

$('btn-save-script').addEventListener('click', async () => {
  const btn = $('btn-save-script');
  btn.disabled = true;
  try {
    await api('POST', '/api/settings/startup-script', { userData: $('startup-script').value });
    toast('脚本已保存', 'success');
  } catch (e) { toast(e.message, 'error'); }
  finally { btn.disabled = false; }
});

// ── logout ────────────────────────────────────────────────────
$('btn-logout').addEventListener('click', async () => {
  await api('POST', '/auth/logout').catch(() => {});
  location.reload();
});

// ── login / init ──────────────────────────────────────────────
$('login-btn').addEventListener('click', async () => {
  const err = $('login-err');
  err.classList.add('hidden');
  try {
    await api('POST', '/auth/login', { password: $('login-pw').value });
    S.accounts = await api('GET', '/api/accounts');
    showApp();
  } catch (e) {
    err.textContent = e.status === 401 ? '密码错误，请重试' : e.message;
    err.classList.remove('hidden');
  }
});

$('login-pw').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('login-btn').click();
});

function showApp() {
  $('login-screen').style.display = 'none';
  $('app').style.display = 'block';
  switchPage('overview');
}

async function init() {
  try {
    const session = await api('GET', '/api/session');
    if (!session.loggedIn) return;
    S.accounts = await api('GET', '/api/accounts');
    showApp();
    // restore selected account if any
    if (session.selectedAccountId) {
      S.selectedAccId = session.selectedAccountId;
    }
  } catch { /* stay on login */ }
}

init();
