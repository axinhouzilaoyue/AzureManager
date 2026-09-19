// @ts-nocheck
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
  // Capture phase so copying an IP does not also trigger the fleet-row onclick.
  document.addEventListener('click', (e) => {
    const el = e.target instanceof Element ? e.target.closest('[data-copy]') : null;
    const value = el?.getAttribute('data-copy');
    if (!value) return;
    e.preventDefault();
    e.stopPropagation();
    copyText(value);
  }, true);

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
    if (t.closest('#btn-expand-activity')) return void openActivityModal();
    const logTab = t.closest('[data-log-tab]');
    if (logTab) {
      setActivityTab(logTab.getAttribute('data-log-tab'));
      return;
    }
    if (t.closest('#btn-refresh-vms')) return void refreshWorkspace();
    if (t.closest('#btn-refresh-summary')) return void refreshAccountSummary(S.selectedAccId);
    if (t.closest('#btn-refresh-all-accounts')) return void refreshAllAccounts();
    if (t.closest('#btn-account-details')) return void openAccountDetails(S.selectedAccId);
    if (t.closest('#btn-toggle-account-secret')) return void toggleAccountSecret();
    if (t.closest('#btn-copy-account-secret')) return void copyAccountSecret();
    if (t.closest('#btn-copy-account-details')) return void copyAccountDetails(S.selectedAccId);
    if (t.closest('#btn-refresh-overview')) return void refreshOverview({ force: true }).then(() => toast('已刷新'));
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
    const prefs = readCreateVmPrefs() || {};
    loadVmSizes(loc, prefs.vmSize || 'Standard_B1s');
    loadIpPermission(loc);
  });

  on('account-search', 'input', (e) => {
    S.accountSearch = e.target?.value || '';
    renderAccGrid();
  });
  on('account-import-file', 'change', (e) => {
    importAccountsFromFile(e.target?.files?.[0]);
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
  setActivityTab(S.activityTab || 'tasks');
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
