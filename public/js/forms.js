// @ts-nocheck
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

