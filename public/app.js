// ── state ─────────────────────────────────────────────────────
const S = {
  accounts: [],
  activePage: 'overview',
  selectedAccId: null,
  vms: [],
  regions: [],
  activeVTab: 'vms',
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

// ── helpers ───────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
// Safe JS string literal for inline handlers (avoids HTML-escaping breaking API values).
const jsq = v => JSON.stringify(String(v ?? ''));

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast${type === 'success' ? ' t-ok' : type === 'error' ? ' t-err' : ''}`;
  el.textContent = msg;
  $('tc').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

const openModal  = id => $(id).classList.remove('hidden');
const closeModal = id => $(id).classList.add('hidden');

document.addEventListener('click', e => {
  const b = e.target.closest('[data-close]');
  if (b) closeModal(b.dataset.close);
  if (e.target.classList.contains('mo')) closeModal(e.target.id);
});

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
const PAGES = ['overview', 'accounts', 'settings', 'help'];

function switchPage(page) {
  S.activePage = page;
  PAGES.forEach(p => {
    $(`pg-${p}`).classList.toggle('hidden', p !== page);
    const ni = $(`ni-${p}`);
    if (ni) ni.classList.toggle('active', p === page);
  });
  if (page === 'overview') refreshOverview();
  if (page === 'accounts') showAccList();
  if (page === 'settings') loadStartupScript();
}
window.switchPage = switchPage;

document.querySelectorAll('.nav-btn[data-page]').forEach(el => {
  el.addEventListener('click', () => switchPage(el.dataset.page));
});

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

function renderAccGrid() {
  const g = $('acc-grid');
  if (!S.accounts.length) {
    g.innerHTML = `
      <div class="empty" style="grid-column:1/-1">
        <h3>还没有 Azure 账户</h3>
        <p>添加应用注册凭据后，即可管理该订阅下的虚拟机。</p>
        <button class="btn btn-p" style="margin-top:8px" onclick="openAddAccount()">添加账户</button>
      </div>`;
    return;
  }

  g.innerHTML = S.accounts.map(a => `
    <div class="acc-card" onclick='openVmView(${jsq(a.id)})'>
      <div class="acc-top">
        <div class="acc-name">${esc(a.name)}</div>
        ${a.expirationDate ? `<span class="badge bg-err">到期 ${esc(a.expirationDate)}</span>` : `<span class="badge bg-inf">就绪</span>`}
      </div>
      <div class="acc-meta">
        <div class="meta-row"><span class="meta-k">订阅 ID</span><span class="meta-v">${esc(a.subscriptionId)}</span></div>
        <div class="meta-row"><span class="meta-k">应用 ID</span><span class="meta-v">${esc(shortId(a.clientId))}</span></div>
        <div class="meta-row"><span class="meta-k">租户 ID</span><span class="meta-v">${esc(shortId(a.tenantId))}</span></div>
      </div>
      <div class="acc-foot">
        <span class="muted small">点击进入工作台</span>
        <button class="btn btn-p btn-sm" onclick='openVmView(${jsq(a.id)}, event)'>打开 →</button>
      </div>
    </div>
  `).join('');
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
  $('vm-acc-sub').textContent = acc?.subscriptionId || '';
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

$('btn-back-accounts').addEventListener('click', () => {
  S.selectedAccId = null;
  api('DELETE', '/api/session').catch(() => {});
  refreshOverview();
  $('view-acc-list').classList.remove('hidden');
  $('view-vms').classList.add('hidden');
  renderAccGrid();
});

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

$('btn-cf').addEventListener('click', async () => {
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
});

// ── tabs / tasks ──────────────────────────────────────────────
document.querySelectorAll('.tab[data-vtab]').forEach(t => {
  t.addEventListener('click', () => {
    S.activeVTab = t.dataset.vtab;
    document.querySelectorAll('.tab[data-vtab]').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    $('vtab-vms').classList.toggle('hidden', S.activeVTab !== 'vms');
    $('vtab-tasks').classList.toggle('hidden', S.activeVTab !== 'tasks');
    if (S.activeVTab === 'tasks') loadTasks();
  });
});

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
$('btn-create-vm').addEventListener('click', () => openModal('mo-create-vm'));

$('btn-submit-vm').addEventListener('click', async () => {
  const btn = $('btn-submit-vm');
  btn.disabled = true;
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
    btn.disabled = false;
  }
});

$('btn-refresh-vms').addEventListener('click', async () => {
  await loadVms();
  toast('已刷新');
});

// ── add account ───────────────────────────────────────────────
function resetAddForm() {
  ['add-name', 'add-cid', 'add-tid', 'add-sec', 'add-sid'].forEach(id => { $(id).value = ''; });
  $('add-exp').value = '';
  $('add-check-result').className = 'hidden';
  $('add-check-result').textContent = '';
}

function openAddAccount() {
  resetAddForm();
  openModal('mo-add-acc');
  setTimeout(() => $('add-name').focus(), 50);
}
window.openAddAccount = openAddAccount;

$('btn-check-add').addEventListener('click', async () => {
  const btn = $('btn-check-add');
  const res = $('add-check-result');
  btn.disabled = true;
  btn.textContent = '验证中...';
  try {
    const d = await api('POST', '/api/accounts/check', {
      clientId: $('add-cid').value.trim(),
      clientSecret: $('add-sec').value.trim(),
      tenantId: $('add-tid').value.trim(),
      subscriptionId: $('add-sid').value.trim(),
    });
    res.className = 'ok-box';
    res.textContent = `验证通过：${d.subscriptionDisplayName} · ${d.state} · ${d.availableRegionCount} 个可用区域`;
  } catch (e) {
    res.className = 'err-box';
    res.textContent = `验证失败：${e.message}`;
  } finally {
    res.classList.remove('hidden');
    btn.disabled = false;
    btn.textContent = '验证凭据';
  }
});

$('btn-save-add').addEventListener('click', async () => {
  const btn = $('btn-save-add');
  btn.disabled = true;
  try {
    await api('POST', '/api/accounts', {
      name: $('add-name').value.trim(),
      clientId: $('add-cid').value.trim(),
      clientSecret: $('add-sec').value.trim(),
      tenantId: $('add-tid').value.trim(),
      subscriptionId: $('add-sid').value.trim(),
      expirationDate: $('add-exp').value || null,
    });
    toast('账户已添加', 'success');
    closeModal('mo-add-acc');
    resetAddForm();
    S.accounts = await api('GET', '/api/accounts');
    // Always land on the account list after create, even if a workspace was open.
    S.selectedAccId = null;
    api('DELETE', '/api/session').catch(() => {});
    refreshOverview();
    switchPage('accounts');
    showAccountListView();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

// ── edit / delete account ─────────────────────────────────────
$('btn-edit-acc').addEventListener('click', () => {
  const acc = S.accounts.find(a => a.id === S.selectedAccId);
  if (!acc) return;
  $('edit-acc-id').value = acc.id;
  $('edit-acc-name').value = acc.name;
  $('edit-acc-exp').value = acc.expirationDate || '';
  openModal('mo-edit-acc');
});

$('btn-save-edit-acc').addEventListener('click', async () => {
  const btn = $('btn-save-edit-acc');
  btn.disabled = true;
  try {
    await api('POST', '/api/accounts/edit', {
      accountId: $('edit-acc-id').value,
      newName: $('edit-acc-name').value.trim(),
      expirationDate: $('edit-acc-exp').value || null,
    });
    closeModal('mo-edit-acc');
    S.accounts = await api('GET', '/api/accounts');
    const acc = S.accounts.find(a => a.id === S.selectedAccId);
    if (acc) $('vm-acc-title').textContent = acc.name;
    refreshOverview();
    toast('账户已更新', 'success');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

$('btn-del-acc').addEventListener('click', async () => {
  const acc = S.accounts.find(a => a.id === S.selectedAccId);
  if (!confirm(`确认删除账户「${acc?.name}」？`)) return;
  try {
    await api('DELETE', `/api/accounts/${S.selectedAccId}`);
    S.selectedAccId = null;
    S.accounts = await api('GET', '/api/accounts');
    refreshOverview();
    $('view-acc-list').classList.remove('hidden');
    $('view-vms').classList.add('hidden');
    renderAccGrid();
    toast('账户已删除', 'success');
  } catch (e) {
    toast(e.message, 'error');
  }
});

// ── settings ──────────────────────────────────────────────────
async function loadStartupScript() {
  try {
    const d = await api('GET', '/api/settings/startup-script');
    $('startup-script').value = d.userData || '';
  } catch { /* ignore */ }
}

$('btn-save-script').addEventListener('click', async () => {
  const btn = $('btn-save-script');
  btn.disabled = true;
  try {
    await api('POST', '/api/settings/startup-script', { userData: $('startup-script').value });
    toast('脚本已保存', 'success');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

// ── auth ──────────────────────────────────────────────────────
$('btn-logout').addEventListener('click', async () => {
  await api('POST', '/auth/logout').catch(() => {});
  location.reload();
});

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
    $('login-screen').style.display = 'none';
    $('app').style.display = 'block';

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

init();
