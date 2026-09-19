// @ts-nocheck
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

  list.innerHTML = items.map((vm) => {
    const st = vmStatusView(vm.status);
    const hasIp = Boolean(vm.publicIp) && vm.publicIp !== 'N/A' && vm.publicIp !== '-';
    return `
    <div class="fleet-row" onclick='openVmView(${jsq(vm.accountId)})'>
      <div class="fleet-cell">
        <div class="fleet-name">${esc(vm.name)}</div>
        <div class="fleet-sub">${esc(vm.accountLabel || '-')}</div>
      </div>
      <div class="fleet-cell">
        <div class="fleet-loc">${esc(vm.location || '-')}</div>
        <div class="fleet-sub">${esc(vm.vmSize || '-')}</div>
      </div>
      <div class="fleet-status ${st.dot}"><span class="dot ${st.dot}" aria-hidden="true"></span>${esc(st.label)}</div>
      <div class="fleet-uptime">${esc(fleetUptimeText(vm))}</div>
      <div class="fleet-ip"${hasIp ? ` data-copy="${esc(vm.publicIp)}" title="点击复制"` : ''}>${esc(hasIp ? vm.publicIp : '无')}</div>
    </div>`;
  }).join('');

  if (meta) meta.textContent = `${items.length} 台机器 · ${S.accounts.length} 个账户`;
}

async function refreshOverview({ force = false } = {}) {
  if ($('hero-greeting')) $('hero-greeting').textContent = `${greeting()}，总览`;
  if ($('stat-accounts')) $('stat-accounts').textContent = S.accounts.length;

  const list = $('fleet-list');
  const meta = $('fleet-meta');
  if (list && !list.dataset.loaded) {
    list.innerHTML = `<div class="muted" style="padding:28px 18px;font-size:13px">正在汇总全部账户的虚拟机…</div>`;
  }
  if (meta) meta.textContent = force ? '强制刷新中…' : '加载中…';

  if (!S.accounts.length) {
    if ($('stat-vms')) $('stat-vms').textContent = '0';
    if ($('stat-running')) $('stat-running').textContent = '0';
    if ($('stat-running-note')) $('stat-running-note').textContent = '停机 0';
    renderFleetList([]);
    return;
  }

  try {
    // Default reads the shared per-account VM cache; the overview refresh button forces Azure.
    const data = await api('GET', `/api/overview/vms${force ? '?refresh=1' : ''}`);
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

