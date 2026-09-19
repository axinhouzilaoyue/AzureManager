// @ts-nocheck
// ── VMs ───────────────────────────────────────────────────────
async function refreshWorkspace() {
  if (!S.selectedAccId) return;
  const accId = S.selectedAccId;
  abortVmsReads();
  S.vmsCache.delete(accId);
  S.vmsLoading = true;
  S.accountInsights[accId] = { loading: true };
  renderVms();
  renderAccountInsights(accId);
  renderOpLog([]);
  await Promise.allSettled([
    loadVmsFor(accId, { force: true }),
    refreshAccountInfo(accId),
    loadOpLogs(accId),
  ]);
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
        <button class="ops-trigger" type="button" data-vm-ops="${index}"
                aria-label="操作" aria-haspopup="menu" aria-expanded="false" aria-controls="vm-ops-menu">
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/>
          </svg>
        </button>
      </div>
      <div class="vm-line2">
        ${vm.location ? `<span class="vm-kv region"><b class="mono vm-region" title="${esc(vm.location)}">${esc(vm.location)}</b></span>` : ''}
        <span class="vm-kv size"><b class="mono" title="${esc(vm.vmSize || '')}">${esc(vm.vmSize || '—')}</b></span>
        ${vm.diskSizeGb ? `<span class="vm-kv disk"><b>${esc(String(vm.diskSizeGb))} GB</b></span>` : ''}
        <span class="vm-kv"><b>${esc(uptime)}</b></span>
        <span class="vm-kv ip">${
          hasIp
            ? `<span class="vm-val" data-copy="${esc(ipText)}" title="点击复制"><b class="mono">${esc(ipText)}</b>${alloc}</span>`
            : '<b class="vm-none">无</b>'
        }</span>
      </div>
    </article>`;
}

function renderVms() {
  const host = $('vm-list');
  if (!host) return;
  closeVmOpsMenu(true);

  const entry = currentVmsEntry();
  const known = !!entry;
  const items = entry?.vms || [];
  S.renderedVms = items;
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
    // create action lives here instead of pointing at a toolbar.
    stateBox(`<div class="empty" style="border:none;background:transparent">
      <h3>此订阅下暂无虚拟机</h3>
      <p>创建一台即可开始管理。</p>
      <button class="btn btn-p" style="margin-top:8px" type="button" onclick="openCreateVmDialog()">创建虚拟机</button>
    </div>`);
    return;
  }

  host.className = 'vm-list';
  host.setAttribute('role', 'list');
  host.setAttribute('aria-label', '虚拟机列表');
  host.innerHTML = items.map((vm, index) => vmRowHtml(vm, index)).join('');
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
  if (!sel) return;
  if (!location) {
    sel.innerHTML = `<option value="">选择区域后加载…</option>`;
    return;
  }
  const accId = S.createVmAccountId || S.selectedAccId;
  if (!accId) return;
  sel.innerHTML = `<option value="">加载规格中…</option>`;
  sel.disabled = true;
  try {
    const payload = await api('GET', `/api/accounts/${accId}/vm-sizes?location=${encodeURIComponent(location)}`);
    if (accId !== (S.createVmAccountId || S.selectedAccId)) return;
    const sizes = Array.isArray(payload?.items) ? payload.items : (Array.isArray(payload) ? payload : []);
    renderVmSizeOptions(sizes, preferred);
  } catch (e) {
    // Fallback static list so create flow still works.
    if (accId !== (S.createVmAccountId || S.selectedAccId)) return;
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
  } finally {
    if (accId === (S.createVmAccountId || S.selectedAccId)) sel.disabled = false;
  }
}

async function loadRegions() {
  const accId = S.createVmAccountId || S.selectedAccId;
  if (!accId) return;
  const sel = $('create-region');
  const previous = sel?.value || '';
  if (sel) {
    sel.disabled = true;
    sel.innerHTML = `<option value="">加载区域中…</option>`;
  }
  try {
    const payload = await api('GET', `/api/accounts/${accId}/regions`);
    if (accId !== (S.createVmAccountId || S.selectedAccId)) return;
    // The endpoint echoes the account it answered for; drop a stale reply.
    if (payload?.accountId && payload.accountId !== accId) return;
    const regions = Array.isArray(payload?.items) ? payload.items : [];
    S.regions = regions;
    S.regionsByAccount[accId] = regions;
    if (!sel) return;
    if (!regions.length) {
      sel.innerHTML = `<option value="">无可创建虚拟机的区域</option>`;
      sel.disabled = true;
      return;
    }
    sel.innerHTML = regions.map(r =>
      `<option value="${esc(r.name)}">${esc(r.displayName)}</option>`
    ).join('');
    sel.disabled = false;
    // Preserve the previous choice when it is still allowed, so a rerun of this
    // loader does not silently move the target region.
    if (previous && regions.some((r) => r.name === previous)) sel.value = previous;
  } catch (e) {
    if (accId !== (S.createVmAccountId || S.selectedAccId)) return;
    S.regions = [];
    if (sel) {
      sel.innerHTML = `<option value="">区域加载失败</option>`;
      sel.disabled = true;
    }
  }
}

async function loadIpPermission(location) {
  const sel = $('create-ip');
  if (!sel || !location) return;
  const accId = S.createVmAccountId || S.selectedAccId;
  if (!accId) return;
  sel.disabled = true;
  try {
    const data = await api('GET', `/api/accounts/${accId}/ip-permission?location=${encodeURIComponent(location)}`);
    if (accId !== (S.createVmAccountId || S.selectedAccId)) return;
    const nested = data?.items && typeof data.items === 'object' ? data.items : data;
    const permission = nested?.permission || data?.permission || 'Both';
    sel.innerHTML = '';
    if (permission === 'Dynamic') {
      sel.add(new Option('Dynamic', 'Dynamic'));
      sel.value = 'Dynamic';
      sel.disabled = true;
    } else if (permission === 'Static') {
      sel.add(new Option('Static', 'Static'));
      sel.value = 'Static';
      sel.disabled = true;
    } else {
      sel.add(new Option('Dynamic', 'Dynamic'));
      sel.add(new Option('Static', 'Static'));
      sel.value = 'Dynamic';
      sel.disabled = false;
    }
  } catch (e) {
    if (accId !== (S.createVmAccountId || S.selectedAccId)) return;
    sel.disabled = false;
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
    loadOpLogs(accountId);
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ── 执行日志 ──────────────────────────────────────────────────
function formatLogTime(iso) {
  if (!iso) return '--:--:--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    const m = String(iso).match(/T(\d{2}:\d{2}:\d{2})/);
    return m ? m[1] : String(iso).slice(11, 19) || '--:--:--';
  }
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function renderOpLog(lines) {
  const host = $('op-log');
  if (!host) return;
  if (!lines.length) {
    host.innerHTML = `<div class="log-empty">暂无执行日志</div>`;
    return;
  }
  host.innerHTML = lines.map((line) => {
    const cls = String(line.level || '').toLowerCase() === 'error' ? ' err' : '';
    return `<div class="op-log-line${cls}">[${esc(formatLogTime(line.createdAt))}] ${esc(line.message || '')}</div>`;
  }).join('');
  host.scrollTop = host.scrollHeight;
}

function renderRecentTasks(items) {
  const host = $('recent-tasks');
  if (!host) return;
  const rows = Array.isArray(items) ? items.slice(0, 8) : [];
  if (!rows.length) {
    host.innerHTML = `<div class="log-empty">暂无任务</div>`;
    return;
  }
  host.innerHTML = rows.map((task) => {
    const status = String(task.status || '');
    const cls = status === 'success' ? 'ok'
      : status === 'failure' ? 'fail'
      : (status === 'running' || status === 'queued') ? 'run'
      : '';
    const label = status === 'success' ? '成功'
      : status === 'failure' ? '失败'
      : status === 'running' ? '进行中'
      : status === 'queued' ? '排队'
      : status || '-';
    return `<div class="recent-task" ${task.id ? `onclick='showTaskDetail(${jsq(task.id)})' style="cursor:pointer"` : ''}>
      <span class="rt-type">${esc(task.type || 'task')}</span>
      <span class="rt-msg" title="${esc(task.message || '')}">${esc(task.message || task.id || '')}</span>
      <span class="rt-status ${cls}">${esc(label)}</span>
    </div>`;
  }).join('');
}

function renderTaskStrip() {
  const host = $('task-strip');
  if (!host) return;
  const active = S.trackingTasks.size;
  if (!active) {
    host.classList.add('hidden');
    host.innerHTML = '';
    return;
  }
  host.classList.remove('hidden');
  host.innerHTML = `
    <span class="task-dot" aria-hidden="true"></span>
    <span class="task-msg">后台任务执行中…完成后会自动刷新虚拟机列表</span>
    <span class="task-count">${active} 个</span>`;
}

async function loadRecentTasks(accountId) {
  const accId = accountId || S.selectedAccId;
  if (!accId) {
    S.recentTasks = [];
    renderRecentTasks([]);
    return;
  }
  try {
    const payload = await api('GET', `/api/accounts/${accId}/tasks`);
    if (accId !== S.selectedAccId) return;
    const items = Array.isArray(payload?.items) ? payload.items : [];
    S.recentTasks = items;
    renderRecentTasks(items);
  } catch (e) {
    if (accId !== S.selectedAccId) return;
    const host = $('recent-tasks');
    if (host) host.innerHTML = `<div class="log-empty">任务列表加载失败：${esc(e.message)}</div>`;
  }
}

async function loadOpLogs(accountId) {
  const accId = accountId || S.selectedAccId;
  if (!accId) {
    renderOpLog([]);
    renderRecentTasks([]);
    return;
  }
  try {
    const [logsPayload] = await Promise.all([
      api('GET', `/api/accounts/${accId}/logs`),
      loadRecentTasks(accId),
    ]);
    if (accId !== S.selectedAccId) return;
    renderOpLog(Array.isArray(logsPayload?.items) ? logsPayload.items : []);
  } catch (e) {
    if (accId !== S.selectedAccId) return;
    const host = $('op-log');
    if (host) host.innerHTML = `<div class="log-empty">执行日志加载失败：${esc(e.message)}</div>`;
  }
}

function trackTask(taskId) {
  if (S.trackingTasks.has(taskId)) return;
  S.trackingTasks.add(taskId);
  renderTaskStrip();
  if (S.selectedAccId) loadOpLogs(S.selectedAccId);
  pollTask(taskId);
}

async function pollTask(taskId) {
  for (let i = 0; i < 180; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 5000));
    try {
      const t = await api('GET', `/api/task_status/${taskId}`);
      if (S.selectedAccId) loadOpLogs(S.selectedAccId);
      if (t.status === 'success') {
        toast('任务完成', 'success');
        S.trackingTasks.delete(taskId);
        renderTaskStrip();
        if (S.selectedAccId) loadVmsFor(S.selectedAccId, { force: true });
        const result = t.result && typeof t.result === 'object' ? t.result : null;
        if (result && result.username && result.password) await showTaskDetail(taskId);
        return;
      }
      if (t.status === 'failure') {
        toast(`任务失败: ${t.errorMessage || t.message}`, 'error');
        S.trackingTasks.delete(taskId);
        renderTaskStrip();
        return;
      }
    } catch { /* keep polling */ }
  }
  S.trackingTasks.delete(taskId);
  renderTaskStrip();
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
const CREATE_VM_PREFS_KEY = 'azure-manager.createVmPrefs';

function readCreateVmPrefs() {
  try {
    const raw = localStorage.getItem(CREATE_VM_PREFS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writeCreateVmPrefs(prefs) {
  try {
    localStorage.setItem(CREATE_VM_PREFS_KEY, JSON.stringify(prefs));
  } catch { /* ignore quota / private mode */ }
}

/** Opens the create-VM dialog for the selected account with remembered defaults. */
async function openCreateVmDialog() {
  if (!S.selectedAccId) {
    toast('请先选择一个 Azure 账户', 'error');
    return;
  }
  S.createVmAccountId = S.selectedAccId;
  const prefs = readCreateVmPrefs() || {};
  // Restore safe defaults each time the dialog opens, then overlay last-used prefs.
  if ($('create-name')) $('create-name').value = '';
  if ($('create-username')) $('create-username').value = '';
  if ($('create-password')) $('create-password').value = '';
  if ($('create-disk')) $('create-disk').value = String(prefs.diskSize || '64');
  if ($('create-disk-type')) $('create-disk-type').value = prefs.diskType || 'Premium_LRS';
  if ($('create-os') && prefs.osImage) $('create-os').value = prefs.osImage;
  if ($('create-ip')) $('create-ip').value = prefs.ipType || 'Dynamic';
  if ($('create-use-global-ssh')) $('create-use-global-ssh').checked = Boolean(prefs.useGlobalSsh);
  if ($('create-enable-root')) $('create-enable-root').checked = Boolean(prefs.enableRoot);
  if ($('create-nsg-enabled')) $('create-nsg-enabled').checked = prefs.nsgEnabled !== false;
  if ($('create-nsg-ports')) $('create-nsg-ports').value = prefs.nsgPorts || '22';
  if ($('create-nsg-all-inbound')) $('create-nsg-all-inbound').checked = prefs.nsgOpenAllInbound !== false;
  if ($('create-nsg-all-outbound')) $('create-nsg-all-outbound').checked = prefs.nsgOpenAllOutbound !== false;
  openModal('mo-create-vm');
  const cachedRegions = S.regionsByAccount[S.createVmAccountId];
  if (Array.isArray(cachedRegions) && cachedRegions.length) {
    S.regions = cachedRegions;
    const sel = $('create-region');
    if (sel) {
      sel.innerHTML = cachedRegions.map(r =>
        `<option value="${esc(r.name)}">${esc(r.displayName)}</option>`
      ).join('');
      sel.disabled = false;
      if (prefs.region && cachedRegions.some((r) => r.name === prefs.region)) {
        sel.value = prefs.region;
      }
    }
  } else {
    await loadRegions();
    if (prefs.region && S.regions.some((r) => r.name === prefs.region) && $('create-region')) {
      $('create-region').value = prefs.region;
    }
  }
  const loc = $('create-region')?.value || S.regions[0]?.name || '';
  if (loc) {
    loadVmSizes(loc, prefs.vmSize || 'Standard_B1s');
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
    const payload = {
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
    };
    const task = await api('POST', `/api/accounts/${S.createVmAccountId}/create-vm`, payload);
    writeCreateVmPrefs({
      region: payload.region,
      vmSize: payload.vmSize,
      osImage: payload.osImage,
      diskSize: payload.diskSize,
      diskType: payload.diskType,
      ipType: payload.ipType,
      useGlobalSsh: payload.useGlobalSsh,
      enableRoot: payload.enableRoot,
      nsgEnabled: payload.nsgEnabled,
      nsgPorts: String($('create-nsg-ports')?.value || '22'),
      nsgOpenAllInbound: payload.nsgOpenAllInbound,
      nsgOpenAllOutbound: payload.nsgOpenAllOutbound,
    });
    closeModal('mo-create-vm');
    toast('创建任务已提交', 'success');
    trackTask(task.taskId);
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

