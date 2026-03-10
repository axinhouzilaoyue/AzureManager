document.addEventListener("DOMContentLoaded", () => {
  const VM_SIZE_MAP = {
    Standard_B1s: "B1s (1 vCPU, 1 GB RAM)",
    Standard_B1ms: "B1ms (1 vCPU, 2 GB RAM)",
    Standard_B2s: "B2s (2 vCPU, 4 GB RAM)",
    Standard_D2s_v3: "D2s v3 (2 vCPU, 8 GB RAM)",
    Standard_F2s_v2: "F2s v2 (2 vCPU, 4 GB RAM)",
  };

  const UI = {
    loginShell: document.getElementById("loginShell"),
    loginPanel: document.getElementById("loginPanel"),
    appShell: document.getElementById("appShell"),
    loginForm: document.getElementById("loginForm"),
    password: document.getElementById("password"),
    logoutBtn: document.getElementById("logoutBtn"),
    addAccountBtn: document.getElementById("addAccountBtn"),
    addAccountForm: document.getElementById("addAccountForm"),
    accountName: document.getElementById("accountName"),
    clientId: document.getElementById("clientId"),
    clientSecret: document.getElementById("clientSecret"),
    tenantId: document.getElementById("tenantId"),
    subscriptionId: document.getElementById("subscriptionId"),
    checkAccountBtn: document.getElementById("checkAccountBtn"),
    saveAccountBtn: document.getElementById("saveAccountBtn"),
    accountCheckResult: document.getElementById("accountCheckResult"),
    accountList: document.getElementById("accountList"),
    accountMobileList: document.getElementById("accountMobileList"),
    accountSelectionContext: document.getElementById("accountSelectionContext"),
    queryAllStatusBtn: document.getElementById("queryAllStatusBtn"),
    regionSearch: document.getElementById("regionSearch"),
    regionSelector: document.getElementById("regionSelector"),
    userData: document.getElementById("userData"),
    saveUserDataBtn: document.getElementById("saveUserDataBtn"),
    userDataSaveStatus: document.getElementById("userDataSaveStatus"),
    createVmBtn: document.getElementById("createVmBtn"),
    createVmModal: document.getElementById("createVmModal"),
    vmRegionDisplay: document.getElementById("vmRegionDisplay"),
    vmSize: document.getElementById("vmSize"),
    vmOs: document.getElementById("vmOs"),
    vmDiskSize: document.getElementById("vmDiskSize"),
    ipType: document.getElementById("ipType"),
    confirmCreateVmBtn: document.getElementById("confirmCreateVmBtn"),
    refreshVms: document.getElementById("refreshVms"),
    vmList: document.getElementById("vmList"),
    vmMobileList: document.getElementById("vmMobileList"),
    startBtn: document.getElementById("startBtn"),
    stopBtn: document.getElementById("stopBtn"),
    restartBtn: document.getElementById("restartBtn"),
    changeIpBtn: document.getElementById("changeIpBtn"),
    deleteBtn: document.getElementById("deleteBtn"),
    toggleLogBtn: document.getElementById("toggleLogBtn"),
    logPanelContent: document.getElementById("logPanelContent"),
    logCollapsedHint: document.getElementById("logCollapsedHint"),
    logOutput: document.getElementById("logOutput"),
    clearLogBtn: document.getElementById("clearLogBtn"),
    editAccountId: document.getElementById("editAccountId"),
    editAccountName: document.getElementById("editAccountName"),
    editExpirationDate: document.getElementById("editExpirationDate"),
    confirmEditAccountBtn: document.getElementById("confirmEditAccountBtn"),
    addAccountModal: document.getElementById("addAccountModal"),
    editAccountModal: document.getElementById("editAccountModal"),
    vmActionModal: document.getElementById("vmActionModal"),
    vmActionModalTitle: document.getElementById("vmActionModalTitle"),
    vmActionModalMessage: document.getElementById("vmActionModalMessage"),
    vmActionPrimaryLabel: document.getElementById("vmActionPrimaryLabel"),
    vmActionVmName: document.getElementById("vmActionVmName"),
    vmActionSecondaryRow: document.getElementById("vmActionSecondaryRow"),
    vmActionSecondaryLabel: document.getElementById("vmActionSecondaryLabel"),
    vmActionResourceGroup: document.getElementById("vmActionResourceGroup"),
    confirmVmActionBtn: document.getElementById("confirmVmActionBtn"),
  };

  let selectedVmRow = null;
  let selectedAccountId = null;
  let accountsCache = [];
  let addAccountModal = null;
  let createVmModal = null;
  let editAccountModal = null;
  let vmActionModal = null;
  let checkedAccountSignature = null;
  let regionOptions = [];
  let startupScriptLoaded = false;
  let lastSavedStartupScript = "";
  let pendingVmAction = null;
  const accountCheckCache = new Map();
  const VM_ACTION_MODAL_COPY = {
    start: {
      title: "确认启动虚拟机",
      message: (vmName) => `将要启动虚拟机 ${vmName}。确认后会立即提交启动任务。`,
      confirmText: "确认启动",
      buttonClass: "btn btn-primary",
    },
    stop: {
      title: "确认停止虚拟机",
      message: (vmName) => `将要停止虚拟机 ${vmName}。确认后会立即提交停止任务。`,
      confirmText: "确认停止",
      buttonClass: "btn btn-warning",
    },
    restart: {
      title: "确认重启虚拟机",
      message: (vmName) => `将要重启虚拟机 ${vmName}。确认后会立即提交重启任务。`,
      confirmText: "确认重启",
      buttonClass: "btn btn-primary",
    },
    changeIp: {
      title: "确认更换公网 IP",
      message: (vmName) => `将要为虚拟机 ${vmName} 更换公网 IP。确认后会立即提交更换任务。`,
      confirmText: "确认更换 IP",
      buttonClass: "btn btn-warning",
    },
    delete: {
      title: "确认删除资源组",
      message: (_primaryValue, secondaryValue) => `将要删除资源组 ${secondaryValue}。该操作不可逆，请再次确认。`,
      confirmText: "确认删除",
      buttonClass: "btn btn-danger",
    },
    deleteAccount: {
      title: "确认删除账户",
      message: (primaryValue) => `将要删除账户 ${primaryValue}。确认后会移除这组 Azure 凭据。`,
      confirmText: "确认删除账户",
      buttonClass: "btn btn-danger",
    },
  };

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function log(message, type = "info") {
    const now = new Date().toLocaleTimeString();
    const color =
      type === "error" ? "#fca5a5" : type === "success" ? "#86efac" : "#dbeafe";
    UI.logOutput.innerHTML += `<div style="color:${color}">[${now}] ${escapeHtml(message).replace(/\n/g, "<br>")}</div>`;
    UI.logOutput.scrollTop = UI.logOutput.scrollHeight;
    if (type === "error") {
      setLogExpanded(true);
    } else {
      syncLogHint();
    }
  }

  function hasLogContent() {
    return UI.logOutput.textContent.trim().length > 0;
  }

  function syncLogHint() {
    UI.logCollapsedHint.textContent = hasLogContent()
      ? "日志已折叠，点击“展开”查看。"
      : "暂无任务日志，执行写操作或发生错误时会自动展开。";
  }

  function setLogExpanded(expanded) {
    UI.logPanelContent.classList.toggle("app-hidden", !expanded);
    UI.logCollapsedHint.classList.toggle("app-hidden", expanded);
    UI.toggleLogBtn.textContent = expanded ? "折叠" : "展开";
    syncLogHint();
  }

  function setStartupScriptStatus(state, message) {
    UI.userDataSaveStatus.dataset.state = state;
    UI.userDataSaveStatus.textContent = message;
  }

  function syncStartupScriptSaveState() {
    const isDirty = startupScriptLoaded && UI.userData.value !== lastSavedStartupScript;
    UI.saveUserDataBtn.disabled = !startupScriptLoaded || !isDirty;

    if (!startupScriptLoaded) {
      setStartupScriptStatus("saved", "请先登录后加载脚本");
      return;
    }

    if (isDirty) {
      setStartupScriptStatus("dirty", "当前修改尚未保存");
      return;
    }

    setStartupScriptStatus("saved", "已保存");
  }

  function openVmActionModal(config) {
    const copy = VM_ACTION_MODAL_COPY[config.action];
    if (!copy) {
      return;
    }

    pendingVmAction = config;
    UI.vmActionModalTitle.textContent = copy.title;
    UI.vmActionModalMessage.textContent = copy.message(config.primaryValue, config.secondaryValue);
    UI.vmActionPrimaryLabel.textContent = config.primaryLabel || "虚拟机";
    UI.vmActionVmName.textContent = config.primaryValue;
    const hasSecondaryValue = Boolean(config.secondaryValue);
    UI.vmActionSecondaryRow.classList.toggle("app-hidden", !hasSecondaryValue);
    UI.vmActionSecondaryLabel.textContent = config.secondaryLabel || "资源组";
    UI.vmActionResourceGroup.textContent = config.secondaryValue || "";
    UI.confirmVmActionBtn.textContent = copy.confirmText;
    UI.confirmVmActionBtn.className = copy.buttonClass;
    UI.confirmVmActionBtn.disabled = false;

    if (!vmActionModal) {
      vmActionModal = new bootstrap.Modal(UI.vmActionModal);
    }
    vmActionModal.show();
  }

  async function loadStartupScript(force = false) {
    if (startupScriptLoaded && !force) {
      return;
    }

    UI.saveUserDataBtn.disabled = true;
    setStartupScriptStatus("saving", "正在加载全局默认脚本...");
    const response = await apiCall("/api/settings/startup-script", {
      method: "GET",
      headers: {},
    });
    const value = typeof response.userData === "string" ? response.userData : "";
    UI.userData.value = value;
    lastSavedStartupScript = value;
    startupScriptLoaded = true;
    syncStartupScriptSaveState();
  }

  async function saveStartupScriptNow() {
    if (!startupScriptLoaded) {
      return false;
    }

    const value = UI.userData.value;
    if (value === lastSavedStartupScript) {
      syncStartupScriptSaveState();
      return false;
    }

    UI.saveUserDataBtn.disabled = true;
    setStartupScriptStatus("saving", "正在保存...");
    await apiCall("/api/settings/startup-script", {
      method: "POST",
      body: JSON.stringify({ userData: value }),
    });
    lastSavedStartupScript = value;
    syncStartupScriptSaveState();
    return true;
  }

  async function apiCall(url, options = {}) {
    const response = await fetch(url, {
      credentials: "same-origin",
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });

    const text = await response.text();
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = {};
    }

    if (!response.ok) {
      const errorMessage = payload.error || text || `HTTP ${response.status}`;
      log(errorMessage, "error");
      throw new Error(errorMessage);
    }

    return payload;
  }

  function calculateUptime(isoString) {
    if (!isoString) {
      return "N/A";
    }

    const start = new Date(isoString);
    const diff = Date.now() - start.getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff / (1000 * 60 * 60)) % 24);
    const minutes = Math.floor((diff / (1000 * 60)) % 60);

    if (days > 0) return `${days}天${hours}小时`;
    if (hours > 0) return `${hours}小时${minutes}分钟`;
    return `${minutes}分钟`;
  }

  function getStateBadgeClass(state) {
    const normalized = String(state || "").toLowerCase();
    if (normalized.includes("enabled") || normalized.includes("active")) {
      return "bg-success";
    }
    if (normalized.includes("warn")) {
      return "bg-warning text-dark";
    }
    return "bg-danger";
  }

  function setAccountCheckMessage(html, tone = "secondary") {
    const classMap = {
      secondary: "small text-secondary rounded border px-3 py-2 mt-3 mb-3",
      success: "small text-success-emphasis bg-success-subtle border border-success-subtle rounded px-3 py-2 mt-3 mb-3",
      error: "small text-danger-emphasis bg-danger-subtle border border-danger-subtle rounded px-3 py-2 mt-3 mb-3",
      info: "small text-primary-emphasis bg-primary-subtle border border-primary-subtle rounded px-3 py-2 mt-3 mb-3",
    };
    UI.accountCheckResult.className = classMap[tone] || classMap.secondary;
    UI.accountCheckResult.innerHTML = html;
  }

  function getAccountDraftForCheck() {
    return {
      clientId: UI.clientId.value.trim(),
      clientSecret: UI.clientSecret.value.trim(),
      tenantId: UI.tenantId.value.trim(),
      subscriptionId: UI.subscriptionId.value.trim(),
    };
  }

  function getAccountDraftForSave() {
    return {
      name: UI.accountName.value.trim(),
      ...getAccountDraftForCheck(),
      expirationDate: null,
    };
  }

  function getAccountDraftSignature() {
    return JSON.stringify(getAccountDraftForCheck());
  }

  function invalidateDraftCheck() {
    checkedAccountSignature = null;
    UI.saveAccountBtn.disabled = true;
    setAccountCheckMessage("请先点击“检查账户”。通过检查后才允许保存。");
  }

  function openAddAccountModal() {
    UI.addAccountForm.reset();
    invalidateDraftCheck();
    if (!addAccountModal) {
      addAccountModal = new bootstrap.Modal(UI.addAccountModal);
    }
    addAccountModal.show();
  }

  function renderDraftCheckResult(result) {
    const warnings = Array.isArray(result.warnings) && result.warnings.length > 0
      ? `<div class="mt-2">${result.warnings.map((warning) => `<div>告警: ${escapeHtml(warning)}</div>`).join("")}</div>`
      : "";

    setAccountCheckMessage(
      `
        <div class="fw-semibold">检查通过: ${escapeHtml(result.subscriptionDisplayName)}</div>
        <div class="mt-1">订阅状态: ${escapeHtml(result.state)}</div>
        <div>可用区域: ${escapeHtml(result.availableRegionCount)}</div>
        ${warnings}
      `,
      "success",
    );
  }

  function buildAccountSummaryHtml(account, checkResult) {
    if (!checkResult) {
      const tooltip = "未检查";
      return `
        <div class="account-summary-line" title="${escapeHtml(tooltip)}">
          <span class="badge bg-secondary flex-shrink-0">未检查</span>
        </div>
      `;
    }

    const firstWarning = Array.isArray(checkResult.warnings) && checkResult.warnings.length > 0
      ? checkResult.warnings[0]
      : "";
    const tooltip = [
      checkResult.subscriptionDisplayName,
      `状态 ${checkResult.state}`,
      `区域 ${checkResult.availableRegionCount}`,
      firstWarning ? `告警 ${firstWarning}` : "",
    ]
      .filter(Boolean)
      .join(" | ");

    return `
      <div class="account-summary-line" title="${escapeHtml(tooltip)}">
        <span class="badge ${getStateBadgeClass(checkResult.state)} flex-shrink-0">${escapeHtml(checkResult.state)}</span>
        <span class="small text-secondary account-summary-text">${escapeHtml(checkResult.subscriptionDisplayName)}</span>
        <span class="small text-secondary flex-shrink-0">区域 ${escapeHtml(checkResult.availableRegionCount)}</span>
      </div>
    `;
  }

  function renderAccountCheckCell(row, account, checkResult) {
    const cell = row.querySelector(".status-cell");
    cell.innerHTML = buildAccountSummaryHtml(account, checkResult);
  }

  function setSelectedAccountContext(accountName) {
    const empty = accountName ? "false" : "true";
    UI.accountSelectionContext.textContent = accountName ? `当前账户：${accountName}` : "当前账户：未选择";
    UI.accountSelectionContext.dataset.empty = empty;
  }

  function renderRegionOptions(query = "") {
    const normalizedQuery = query.trim().toLowerCase();
    const filteredRegions = regionOptions.filter((region) => {
      if (!normalizedQuery) {
        return true;
      }

      return region.displayName.toLowerCase().includes(normalizedQuery)
        || region.name.toLowerCase().includes(normalizedQuery);
    });

    if (filteredRegions.length === 0) {
      UI.regionSelector.innerHTML = "<option>没有匹配区域</option>";
      UI.regionSelector.disabled = true;
      UI.createVmBtn.disabled = true;
      return;
    }

    UI.regionSelector.innerHTML = filteredRegions
      .map((region) => `<option value="${escapeHtml(region.name)}">${escapeHtml(region.displayName)}</option>`)
      .join("");
    UI.regionSelector.disabled = false;
    UI.createVmBtn.disabled = false;
  }

  function resetRegionSelection(placeholder) {
    regionOptions = [];
    UI.regionSearch.value = "";
    UI.regionSearch.disabled = true;
    UI.regionSelector.innerHTML = `<option>${escapeHtml(placeholder)}</option>`;
    UI.regionSelector.disabled = true;
    UI.createVmBtn.disabled = true;
  }

  function setVmElementSelected(element, isSelected) {
    if (!element) {
      return;
    }

    if (element.tagName === "TR") {
      element.classList.toggle("table-active", isSelected);
      return;
    }

    element.classList.toggle("active", isSelected);
  }

  function selectVmElement(element) {
    if (selectedVmRow) {
      setVmElementSelected(selectedVmRow, false);
    }
    selectedVmRow = element;
    setVmElementSelected(element, true);
    updateActionButtons();
  }

  function buildVmMobileCard(virtualMachine) {
    const isRunning = String(virtualMachine.status).toLowerCase().includes("running");
    return `
      <div class="d-flex justify-content-between align-items-start gap-2">
        <div class="fw-semibold">${escapeHtml(virtualMachine.name)}</div>
        <span class="badge bg-${isRunning ? "success" : "secondary"}">${escapeHtml(virtualMachine.status)}</span>
      </div>
      <div class="mobile-card-meta mt-2">
        <span>${escapeHtml(virtualMachine.resourceGroup)}</span>
        <span>${escapeHtml(virtualMachine.location)}</span>
        <span>${escapeHtml(VM_SIZE_MAP[virtualMachine.vmSize] || virtualMachine.vmSize)}</span>
        <span>${escapeHtml(calculateUptime(virtualMachine.timeCreated))}</span>
        <span>${escapeHtml(virtualMachine.publicIp || "无公网 IP")}</span>
      </div>
    `;
  }

  function setAuthenticatedState(session) {
    const loggedIn = Boolean(session.loggedIn);
    document.body.classList.toggle("authenticated", loggedIn);
    UI.loginShell.classList.toggle("app-hidden", loggedIn);
    UI.appShell.classList.toggle("app-hidden", !loggedIn);

    selectedAccountId = session.selectedAccountId || null;
    setSelectedAccountContext(session.selectedAccountName || null);
    UI.regionSelector.disabled = true;
    UI.createVmBtn.disabled = true;
    UI.refreshVms.disabled = !selectedAccountId;

    if (!loggedIn) {
      startupScriptLoaded = false;
      lastSavedStartupScript = "";
      UI.userData.value = "";
      syncStartupScriptSaveState();
    }
  }

  async function loadSession() {
    const session = await apiCall("/api/session", { method: "GET", headers: {} });
    setAuthenticatedState(session);
    return session;
  }

  async function loadAccounts() {
    const accounts = await apiCall("/api/accounts", { method: "GET", headers: {} });
    accountsCache = accounts;
    UI.accountList.innerHTML = "";
    UI.accountMobileList.innerHTML = "";

    if (accounts.length === 0) {
      UI.accountList.innerHTML =
        '<tr><td colspan="4" class="text-center text-secondary py-4">还没有已保存账户</td></tr>';
      UI.accountMobileList.innerHTML =
        '<div class="mobile-card text-center text-secondary">还没有已保存账户</div>';
      return;
    }

    accounts.forEach((account) => {
      const checkResult = accountCheckCache.get(account.id) || null;
      const row = document.createElement("tr");
      row.dataset.accountId = account.id;
      row.innerHTML = `
        <td class="account-name-cell fw-medium" title="${escapeHtml(account.name)}">
          <div class="d-flex align-items-center gap-2">
            <span class="text-truncate">${escapeHtml(account.name)}</span>
            ${selectedAccountId === account.id ? '<span class="badge bg-primary-subtle text-primary-emphasis flex-shrink-0">当前</span>' : ""}
          </div>
        </td>
        <td class="status-cell account-summary-cell">--</td>
        <td class="account-expiration-cell">${account.expirationDate ? escapeHtml(account.expirationDate) : "--"}</td>
        <td class="text-center account-actions">
          <div class="d-flex justify-content-center gap-1">
            <button class="btn btn-success btn-sm" data-action="select">选择</button>
            <button class="btn btn-warning btn-sm" data-action="edit">修改</button>
            <button class="btn btn-info btn-sm" data-action="check">检查</button>
            <button class="btn btn-danger btn-sm" data-action="delete">删除</button>
          </div>
        </td>`;
      UI.accountList.appendChild(row);

      if (selectedAccountId && selectedAccountId === account.id) {
        row.classList.add("table-active");
      }

      renderAccountCheckCell(row, account, checkResult);

      const mobileCard = document.createElement("div");
      mobileCard.className = `mobile-card${selectedAccountId === account.id ? " active" : ""}`;
      mobileCard.dataset.accountId = account.id;
      mobileCard.innerHTML = `
        <div class="d-flex justify-content-between align-items-start gap-2">
          <div class="fw-semibold">${escapeHtml(account.name)}</div>
          ${selectedAccountId === account.id ? '<span class="badge bg-primary-subtle text-primary-emphasis">当前</span>' : ""}
        </div>
        <div class="mt-2">${buildAccountSummaryHtml(account, checkResult)}</div>
        <div class="mobile-card-meta mt-2">
          <span>到期日期 ${escapeHtml(account.expirationDate || "--")}</span>
        </div>
        <div class="mobile-card-actions mt-3">
          <button class="btn btn-success btn-sm" data-action="select">选择</button>
          <button class="btn btn-warning btn-sm" data-action="edit">修改</button>
          <button class="btn btn-info btn-sm" data-action="check">检查</button>
          <button class="btn btn-danger btn-sm" data-action="delete">删除</button>
        </div>
      `;
      UI.accountMobileList.appendChild(mobileCard);
    });
  }

  async function loadRegions() {
    if (!selectedAccountId) {
      resetRegionSelection("请先选择账户");
      return;
    }

    UI.regionSearch.disabled = true;
    UI.regionSelector.disabled = true;
    UI.createVmBtn.disabled = true;
    const regions = await apiCall("/api/regions", { method: "GET", headers: {} });
    if (regions.length === 0) {
      resetRegionSelection("当前订阅没有可用区域");
      return;
    }

    regionOptions = [...regions].sort((left, right) => left.displayName.localeCompare(right.displayName));
    UI.regionSearch.value = "";
    UI.regionSearch.disabled = false;
    renderRegionOptions();
    log("区域列表已更新", "success");
  }

  async function loadVms() {
    if (!selectedAccountId) {
      UI.vmList.innerHTML =
        '<tr><td colspan="7" class="text-center text-secondary py-4">请先选择账户</td></tr>';
      UI.vmMobileList.innerHTML =
        '<div class="mobile-card text-center text-secondary">请先选择账户</div>';
      return;
    }

    selectedVmRow = null;
    updateActionButtons();
    UI.vmList.innerHTML =
      '<tr><td colspan="7" class="text-center py-4">正在加载虚拟机列表...</td></tr>';
    UI.vmMobileList.innerHTML =
      '<div class="mobile-card text-center text-secondary">正在加载虚拟机列表...</div>';

    const virtualMachines = await apiCall("/api/vms", { method: "GET", headers: {} });
    UI.vmList.innerHTML = "";
    UI.vmMobileList.innerHTML = "";

    if (virtualMachines.length === 0) {
      UI.vmList.innerHTML =
        '<tr><td colspan="7" class="text-center text-secondary py-4">当前账户下没有虚拟机</td></tr>';
      UI.vmMobileList.innerHTML =
        '<div class="mobile-card text-center text-secondary">当前账户下没有虚拟机</div>';
      return;
    }

    virtualMachines.forEach((virtualMachine) => {
      const isRunning = String(virtualMachine.status).toLowerCase().includes("running");
      const row = document.createElement("tr");
      row.dataset.vmName = virtualMachine.name;
      row.dataset.resourceGroup = virtualMachine.resourceGroup;
      row.dataset.status = virtualMachine.status;
      row.innerHTML = `
        <td>${escapeHtml(virtualMachine.name)}</td>
        <td>${escapeHtml(virtualMachine.resourceGroup)}</td>
        <td>${escapeHtml(virtualMachine.location)}</td>
        <td>${escapeHtml(VM_SIZE_MAP[virtualMachine.vmSize] || virtualMachine.vmSize)}</td>
        <td>${escapeHtml(calculateUptime(virtualMachine.timeCreated))}</td>
        <td>${escapeHtml(virtualMachine.publicIp)}</td>
        <td><span class="badge bg-${isRunning ? "success" : "secondary"}">${escapeHtml(virtualMachine.status)}</span></td>
      `;
      row.addEventListener("click", () => selectVmElement(row));
      UI.vmList.appendChild(row);

      const mobileCard = document.createElement("div");
      mobileCard.className = "mobile-card";
      mobileCard.dataset.vmName = virtualMachine.name;
      mobileCard.dataset.resourceGroup = virtualMachine.resourceGroup;
      mobileCard.dataset.status = virtualMachine.status;
      mobileCard.innerHTML = buildVmMobileCard(virtualMachine);
      mobileCard.addEventListener("click", () => selectVmElement(mobileCard));
      UI.vmMobileList.appendChild(mobileCard);
    });
  }

  function updateActionButtons() {
    const buttons = [UI.startBtn, UI.stopBtn, UI.restartBtn, UI.changeIpBtn, UI.deleteBtn];
    buttons.forEach((button) => {
      button.disabled = true;
      button.className = "btn btn-secondary";
    });

    if (!selectedVmRow) {
      return;
    }

    const status = String(selectedVmRow.dataset.status || "").toLowerCase();
    const isRunning = status.includes("running");
    const isStopped = status.includes("deallocated") || status.includes("stopped");

    UI.startBtn.disabled = !isStopped;
    UI.startBtn.className = UI.startBtn.disabled ? "btn btn-secondary" : "btn btn-success";

    UI.stopBtn.disabled = !isRunning;
    UI.stopBtn.className = UI.stopBtn.disabled ? "btn btn-secondary" : "btn btn-warning";

    UI.restartBtn.disabled = !isRunning;
    UI.restartBtn.className = UI.restartBtn.disabled ? "btn btn-secondary" : "btn btn-success";

    UI.changeIpBtn.disabled = false;
    UI.changeIpBtn.className = "btn btn-info";
    UI.deleteBtn.disabled = false;
    UI.deleteBtn.className = "btn btn-danger";
  }

  async function refreshAll() {
    const session = await loadSession();
    if (!session.loggedIn) {
      return;
    }

    try {
      await loadStartupScript();
    } catch (error) {
      log(error.message || String(error), "error");
    }

    await loadAccounts();
    if (selectedAccountId) {
      try {
        await loadRegions();
      } catch (error) {
        resetRegionSelection("获取区域失败");
      }

      try {
        await loadVms();
      } catch (error) {
        UI.vmList.innerHTML =
          '<tr><td colspan="7" class="text-center text-danger py-4">加载虚拟机失败，请检查账户权限</td></tr>';
        UI.vmMobileList.innerHTML =
          '<div class="mobile-card text-center text-danger">加载虚拟机失败，请检查账户权限</div>';
      }
    } else {
      resetRegionSelection("请先选择账户");
      UI.vmList.innerHTML =
        '<tr><td colspan="7" class="text-center text-secondary py-4">请先选择账户</td></tr>';
      UI.vmMobileList.innerHTML =
        '<div class="mobile-card text-center text-secondary">请先选择账户</div>';
    }
  }

  function openEditModal(account) {
    UI.editAccountId.value = account.id;
    UI.editAccountName.value = account.name;
    UI.editExpirationDate.value = account.expirationDate || "";
    if (!editAccountModal) {
      editAccountModal = new bootstrap.Modal(UI.editAccountModal);
    }
    editAccountModal.show();
  }

  async function pollTask(taskId) {
    let attempts = 0;
    while (attempts < 180) {
      attempts += 1;
      const task = await apiCall(`/api/task_status/${taskId}`, { method: "GET", headers: {} });
      if (task.status === "success" || task.status === "failure") {
        task.logs.forEach((entry) => {
          log(`${entry.step}: ${entry.message}`, entry.level === "error" ? "error" : "info");
        });
        if (task.result) {
          log(JSON.stringify(task.result, null, 2), task.status === "success" ? "success" : "error");
        }
        if (task.message) {
          log(task.message, task.status === "success" ? "success" : "error");
        }
        await loadVms().catch(() => {});
        return task;
      }
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    log(`任务 ${taskId} 轮询超时`, "error");
    return null;
  }

  async function submitTask(url, payload) {
    setLogExpanded(true);
    const response = await apiCall(url, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    log(response.message, "success");
    if (response.taskId) {
      await pollTask(response.taskId);
    }
  }

  async function runDraftAccountCheck() {
    const payload = getAccountDraftForCheck();
    const signature = JSON.stringify(payload);
    UI.checkAccountBtn.disabled = true;
    UI.saveAccountBtn.disabled = true;
    setAccountCheckMessage("正在检查 Azure 凭据、订阅状态和区域可用性...", "info");

    try {
      const result = await apiCall("/api/accounts/check", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      checkedAccountSignature = signature;
      UI.saveAccountBtn.disabled = false;
      renderDraftCheckResult(result);
      log(`账户检查通过: ${result.subscriptionDisplayName}`, "success");
    } catch {
      checkedAccountSignature = null;
      UI.saveAccountBtn.disabled = true;
      setAccountCheckMessage("检查失败。请修正客户端 ID、客户端密码、租户 ID、订阅 ID 或权限后重试。", "error");
    } finally {
      UI.checkAccountBtn.disabled = false;
    }
  }

  async function runSavedAccountCheck(account) {
    const row = UI.accountList.querySelector(`tr[data-account-id="${account.id}"]`);
    if (row) {
      const cell = row.querySelector(".status-cell");
      cell.innerHTML = '<span class="badge bg-info text-dark">检查中...</span>';
    }
    const result = await apiCall(`/api/accounts/${account.id}/check`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    accountCheckCache.set(account.id, result);
    await loadAccounts();
    log(`账户 ${account.name} 检查通过`, "success");
  }

  UI.loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await apiCall("/auth/login", {
        method: "POST",
        body: JSON.stringify({
          password: UI.password.value,
        }),
      });
      UI.password.value = "";
      await refreshAll();
      log("登录成功", "success");
    } catch {
      // handled in apiCall
    }
  });

  UI.logoutBtn.addEventListener("click", async () => {
    await apiCall("/auth/logout", {
      method: "POST",
      body: JSON.stringify({}),
    });
    selectedAccountId = null;
    await refreshAll();
    log("已登出", "success");
  });

  UI.addAccountBtn.addEventListener("click", openAddAccountModal);

  UI.regionSearch.addEventListener("input", () => {
    renderRegionOptions(UI.regionSearch.value);
  });

  UI.userData.addEventListener("input", () => {
    syncStartupScriptSaveState();
  });

  UI.saveUserDataBtn.addEventListener("click", async () => {
    try {
      const saved = await saveStartupScriptNow();
      if (saved) {
        log("开机脚本已保存", "success");
      }
    } catch (error) {
      setStartupScriptStatus("error", "保存失败，请重试");
      log(error.message || String(error), "error");
    }
  });

  [UI.accountName, UI.clientId, UI.clientSecret, UI.tenantId, UI.subscriptionId].forEach((element) => {
    element.addEventListener("input", invalidateDraftCheck);
  });

  UI.checkAccountBtn.addEventListener("click", async () => {
    const payload = getAccountDraftForCheck();
    if (!payload.clientId || !payload.clientSecret || !payload.tenantId || !payload.subscriptionId) {
      setAccountCheckMessage("请先完整填写客户端 ID、客户端密码、租户 ID 和订阅 ID。", "error");
      return;
    }
    await runDraftAccountCheck();
  });

  UI.addAccountForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (checkedAccountSignature !== getAccountDraftSignature()) {
      setAccountCheckMessage("账户信息已变更，请重新执行“检查账户”后再保存。", "error");
      UI.saveAccountBtn.disabled = true;
      return;
    }

    try {
      const created = await apiCall("/api/accounts", {
        method: "POST",
        body: JSON.stringify(getAccountDraftForSave()),
      });
      if (addAccountModal) {
        addAccountModal.hide();
      }
      await loadAccounts();
      log(`账户 ${created.name} 添加成功`, "success");
    } catch {
      // handled in apiCall
    }
  });

  async function handleAccountAction(event) {
    const button = event.target.closest("button[data-action]");
    if (!button) {
      return;
    }

    const row = button.closest("[data-account-id]");
    const accountId = row?.dataset.accountId;
    const account = accountsCache.find((item) => item.id === accountId);
    if (!account) {
      return;
    }

    const action = button.dataset.action;
    if (action === "select") {
      await apiCall("/api/session", {
        method: "POST",
        body: JSON.stringify({ accountId }),
      });
      selectedAccountId = accountId;
      await refreshAll();
      log(`已切换到账户 ${account.name}`, "success");
      return;
    }

    if (action === "edit") {
      openEditModal(account);
      return;
    }

    if (action === "check") {
      try {
        await runSavedAccountCheck(account);
      } catch {
        await loadAccounts();
      }
      return;
    }

    if (action === "delete") {
      openVmActionModal({
        action: "deleteAccount",
        primaryLabel: "账户",
        primaryValue: account.name,
        run: async () => {
          await apiCall(`/api/accounts/${accountId}`, { method: "DELETE", headers: {} });
          accountCheckCache.delete(accountId);
          if (selectedAccountId === accountId) {
            selectedAccountId = null;
          }
          await refreshAll();
          log(`账户 ${account.name} 已删除`, "success");
        },
      });
    }
  }

  UI.accountList.addEventListener("click", handleAccountAction);
  UI.accountMobileList.addEventListener("click", handleAccountAction);

  UI.confirmEditAccountBtn.addEventListener("click", async () => {
    await apiCall("/api/accounts/edit", {
      method: "POST",
      body: JSON.stringify({
        accountId: UI.editAccountId.value,
        newName: UI.editAccountName.value,
        expirationDate: UI.editExpirationDate.value || null,
      }),
    });
    accountCheckCache.delete(UI.editAccountId.value);
    if (editAccountModal) {
      editAccountModal.hide();
    }
    await refreshAll();
    log("账户信息已更新", "success");
  });

  UI.queryAllStatusBtn.addEventListener("click", async () => {
    if (accountsCache.length === 0) {
      return;
    }

    UI.queryAllStatusBtn.disabled = true;
    log("开始逐个检查所有已保存账户...", "info");
    try {
      for (const account of accountsCache) {
        try {
          await runSavedAccountCheck(account);
        } catch {
          log(`账户 ${account.name} 检查失败`, "error");
        }
      }
    } finally {
      UI.queryAllStatusBtn.disabled = false;
    }
  });

  UI.createVmBtn.addEventListener("click", () => {
    if (!selectedAccountId) {
      log("请先选择账户", "error");
      return;
    }

    if (UI.regionSelector.disabled || !UI.regionSelector.value) {
      log("请先选择一个可用区域", "error");
      return;
    }

    const selectedRegionLabel =
      UI.regionSelector.options[UI.regionSelector.selectedIndex]?.text || UI.regionSelector.value;
    UI.vmRegionDisplay.value = selectedRegionLabel;

    if (!createVmModal) {
      createVmModal = new bootstrap.Modal(UI.createVmModal);
    }
    createVmModal.show();
  });

  UI.confirmCreateVmBtn.addEventListener("click", async () => {
    if (!UI.regionSelector.value) {
      log("请先选择一个区域", "error");
      return;
    }

    if (createVmModal) {
      createVmModal.hide();
    }

    await submitTask("/api/create-vm", {
      region: UI.regionSelector.value,
      vmSize: UI.vmSize.value,
      osImage: UI.vmOs.value,
      diskSize: Number(UI.vmDiskSize.value),
      ipType: UI.ipType.value,
      userData: UI.userData.value.trim() || null,
    });
  });

  async function handleVmAction(action) {
    if (!selectedVmRow) {
      return;
    }

    const vmName = selectedVmRow.dataset.vmName;
    const resourceGroup = selectedVmRow.dataset.resourceGroup;
    openVmActionModal({
      action,
      primaryValue: vmName,
      secondaryValue: resourceGroup,
      run: () => submitTask("/api/vm-action", {
        action,
        vmName,
        resourceGroup,
      }),
    });
  }

  UI.startBtn.addEventListener("click", () => handleVmAction("start"));
  UI.stopBtn.addEventListener("click", () => handleVmAction("stop"));
  UI.restartBtn.addEventListener("click", () => handleVmAction("restart"));
  UI.deleteBtn.addEventListener("click", () => handleVmAction("delete"));

  UI.changeIpBtn.addEventListener("click", async () => {
    if (!selectedVmRow) {
      return;
    }
    const vmName = selectedVmRow.dataset.vmName;
    const resourceGroup = selectedVmRow.dataset.resourceGroup;
    openVmActionModal({
      action: "changeIp",
      primaryValue: vmName,
      secondaryValue: resourceGroup,
      run: () => submitTask("/api/vm-change-ip", {
        vmName,
        resourceGroup,
      }),
    });
  });

  UI.confirmVmActionBtn.addEventListener("click", async () => {
    if (!pendingVmAction) {
      return;
    }

    UI.confirmVmActionBtn.disabled = true;

    if (vmActionModal) {
      vmActionModal.hide();
    }

    const actionToRun = pendingVmAction;
    pendingVmAction = null;

    await actionToRun.run();
  });

  UI.vmActionModal.addEventListener("hidden.bs.modal", () => {
    UI.confirmVmActionBtn.disabled = false;
    UI.confirmVmActionBtn.className = "btn btn-primary";
    UI.confirmVmActionBtn.textContent = "确认执行";
    UI.vmActionPrimaryLabel.textContent = "虚拟机";
    UI.vmActionSecondaryLabel.textContent = "资源组";
    UI.vmActionSecondaryRow.classList.remove("app-hidden");
    pendingVmAction = null;
  });

  UI.refreshVms.addEventListener("click", () => loadVms().catch((error) => {
    log(error.message || String(error), "error");
  }));

  UI.toggleLogBtn.addEventListener("click", () => {
    const expanded = UI.logPanelContent.classList.contains("app-hidden");
    setLogExpanded(expanded);
  });

  UI.clearLogBtn.addEventListener("click", () => {
    UI.logOutput.innerHTML = "";
    syncLogHint();
  });

  invalidateDraftCheck();
  setLogExpanded(true);
  UI.userData.value = "";
  syncStartupScriptSaveState();
  refreshAll().catch((error) => {
    setStartupScriptStatus("error", "加载失败，请刷新重试");
    log(error.message || String(error), "error");
  });
});
