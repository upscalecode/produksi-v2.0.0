/* =========================================================
   Laporan Produksi — script.js
   Frontend Google Sheets + Google Apps Script Web App
   - login.html terpisah dari index.html
   - request tanpa custom header / JSON preflight
   - form input di atas tabel
   - pagination 20 baris per halaman
   ========================================================= */

// let currentPage = 1;
// const rowPerPage = 4;

// const passwordInput = document.getElementById("loginPassword");
// const togglePassword = document.getElementById("togglePassword");

// togglePassword.addEventListener("click", function () {
//     if (passwordInput.type === "password") {
//         passwordInput.type = "text";
//         togglePassword.textContent = "🙈";
//     } else {
//         passwordInput.type = "password";
//         togglePassword.textContent = "👁";
//     }
// })

(function () {
  "use strict";

  let suppressNavigationLoading =
    sessionStorage.getItem("lapInternalNavigation") === "1";
  sessionStorage.removeItem("lapInternalNavigation");
  let allAppViewsLoaded = false;

  const CONFIG = {
    URL_KEY: "ppr_apps_script_url_v4",
    URL_OVERRIDE_KEY: "ppr_apps_script_url_override_v1",
    TOKEN_KEY: "ppr_session_token_v3",
    USER_KEY: "ppr_session_user_v3",
    MASTER_KEY: "ppr_master_cache_v3",
    PREVIEW_KEY: "ppr_preview_cache_v4",
    FORM_DRAFT_KEY: "ppr_form_draft_v4",
    REQUEST_TIMEOUT: 60000, // Apps Script dapat melambat saat sinkronisasi Sheet
    PAGE_SIZE: 20,
    APD_PREVIEW_PAGE_SIZE: 5,
    FILLING_SPK_PAGE_SIZE: 10,
    PRESS_BALANCE_PAGE_SIZE: 10,
    DASHBOARD_PRIORITY_PAGE_SIZE: 6,
    DASHBOARD_PRESS_KPI_PAGE_SIZE: 7,
    AUTOSAVE_INTERVAL_MS: 15 * 60 * 1000,

    // Ganti dengan URL deployment Web App terbaru yang berakhir /exec.
    WEB_APP_URL:
      "https://script.google.com/macros/s/AKfycbwZDfqSw5aa7fGuXjzllSR7CXUvE44JxiHOpYLEE_gReu2ibGOqq-q0sMRDTpb43WBpCw/exec",
  };

  const SCHEMA_VERSION = "2026-09-19-v15-all-line-hide-fourth-summary";
  const LINE_LABEL = { filling: "Filling", press: "Press" };
  const pageType = document.body.dataset.page || "app";

  const state = {
    token: localStorage.getItem(CONFIG.TOKEN_KEY) || "",
    currentUser: null,
    master: { operator: [], produk: [], botol: [], botolpecah: [] },
    entries: [],
    reportEntries: [],
    adjustments: [],
    remainders: [],
    spkEntries: [],
    apdEntries: [],
    downtimeEntries: [],
    preview: { filling: [], press: [], apd: [], spk: [] },
    previewDeletedEntryAudits: [],
    users: [],
    settings: {
      kpiPressOutputTargetMonthly: 70000,
      kpiFillingOutputTargetMonthly: 150000,
    },
    search: {
      filling: { query: "" },
      press: { query: "" },
    },
    pages: {
      filling: 1,
      press: 1,
      apd: 1,
      apdSaved: 1,
      laporan: 1,
      kpiLaporan: 1,
    },
    savedPages: { filling: 1, press: 1 },
    spk: {
      page: 1,
      fillingPage: 1,
      reportPage: 1,
      date: "",
      fillingDate: "",
      query: "",
    },
    pressBalance: { search: "", page: 1 },
    dashboard: {
      chartMode: "7days",
      chartMonth: "",
      chartYear: "",
      chartStart: "",
      chartEnd: "",
      priorityPage: 1,
      pressKpiMode: "month",
      pressKpiOperator: "",
      pressKpiMonth: "",
      pressKpiYear: "",
      pressKpiStart: "",
      pressKpiEnd: "",
      pressKpiPage: 1,
    },
    lastLaporan: null,
    lastKpiLaporan: null,
  };
  const selectedSpkRows = new Set();
  const selectedFillingSpkRows = new Set();
  const selectedPressBalanceRows = new Set();
  let openFillingDowntimeModal = null;
  let fillingDowntimeAutoOpened = false;
  let fillingDowntimeDataReady = false;
  let fillingDowntimeDismissed = false;

  function applyExcelDataFilter(table, rows, columns, rerender) {
    if (!table) return rows;
    const state = table.__excelFilterState;
    table.__excelData = { rows, columns, rerender };
    if (!state) return rows;
    let result = rows.filter((row) =>
      Array.from(state.filters.entries()).every(([index, selected]) =>
        selected.has(String(columns[index]?.(row) ?? "").trim()),
      ),
    );
    if (state.sort) {
      const { index, direction } = state.sort;
      const value = columns[index] || (() => "");
      result = result.slice().sort((a, b) => {
        const left = String(value(a) ?? "").trim();
        const right = String(value(b) ?? "").trim();
        const compared = left.localeCompare(right, "id", {
          numeric: true,
          sensitivity: "base",
        });
        return direction === "desc" ? -compared : compared;
      });
    }
    return result;
  }

  function maybeOpenFillingDowntimeModal() {
    if (
      fillingDowntimeAutoOpened ||
      !fillingDowntimeDataReady ||
      todayDowntimeEntry() ||
      !canLevel("filling", "write") ||
      el("view-filling")?.hidden ||
      typeof openFillingDowntimeModal !== "function"
    )
      return;
    fillingDowntimeAutoOpened = true;
    openFillingDowntimeModal();
  }

  // Antrean tulis: UI tetap instan, request Spreadsheet dikirim satu per satu
  // agar input cepat berulang tidak saling berebut LockService di Apps Script.
  let writeQueue = Promise.resolve();

  function isWriteLockBusyError(error) {
    return /server sedang menerima input lain/i.test(
      String(error?.message || error || ""),
    );
  }

  async function runWriteWithRetry(task) {
    const maximumAttempts = 3;
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      try {
        return await task();
      } catch (error) {
        if (!isWriteLockBusyError(error) || attempt === maximumAttempts) {
          throw error;
        }
        // Setiap request sudah menunggu lock di server. Jeda singkat dengan
        // variasi kecil mencegah beberapa browser mencoba ulang bersamaan.
        const retryDelay = attempt * 500 + Math.floor(Math.random() * 400);
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      }
    }
  }

  function enqueueWrite(task) {
    const run = writeQueue.then(
      () => runWriteWithRetry(task),
      () => runWriteWithRetry(task),
    );
    writeQueue = run.catch(() => {});
    return run;
  }

  function makeClientRequestId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return `client-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  }

  function el(id) {
    return document.getElementById(id);
  }
  function qs(selector, root = document) {
    return root.querySelector(selector);
  }
  function qsa(selector, root = document) {
    return Array.from(root.querySelectorAll(selector));
  }

  const DEFAULT_USER_PERMISSIONS = Object.freeze({
    accessDashboard: false,
    accessFilling: true,
    accessSpk: true,
    accessPress: true,
    accessExportFillingCsv: false,
    accessExportPressCsv: false,
    accessApd: true,
    accessReports: false,
    accessWorkReport: false,
    accessSpkReport: false,
    accessKpiReport: false,
    accessKpiFillingReport: false,
    accessKpiPressReport: false,
    accessKpiSpvReport: false,
    deleteUnpressed: false,
    viewAllData: false,
    editOwn: true,
    editOthers: false,
    deleteOwn: false,
    deleteOthers: false,
    accessMaster: false,
    accessKpiSettings: false,
  });

  function permissionsOf(user = state.currentUser) {
    if (!user) return { ...DEFAULT_USER_PERMISSIONS };
    if (user.role === "superuser") {
      return Object.fromEntries(
        Object.keys(DEFAULT_USER_PERMISSIONS).map((key) => [key, true]),
      );
    }
    const saved = user.permissions || {};
    return {
      ...DEFAULT_USER_PERMISSIONS,
      accessWorkReport: saved.accessWorkReport ?? saved.accessReports ?? false,
      accessSpk: saved.accessSpk ?? saved.accessFilling ?? false,
      accessSpkReport: saved.accessSpkReport ?? saved.accessReports ?? false,
      accessKpiReport: saved.accessKpiReport ?? saved.accessReports ?? false,
      accessKpiFillingReport:
        saved.accessKpiFillingReport ?? saved.accessReports ?? false,
      accessKpiPressReport:
        saved.accessKpiPressReport ?? saved.accessReports ?? false,
      accessKpiSpvReport:
        saved.accessKpiSpvReport ??
        saved.accessKpiReport ??
        saved.accessReports ??
        false,
      accessKpiSettings: saved.accessKpiSettings ?? saved.accessMaster ?? false,
      ...saved,
    };
  }

  function can(permission, user = state.currentUser) {
    return Boolean(
      user &&
      (user.role === "superuser" || permissionsOf(user)[permission] === true),
    );
  }

  function canLevel(scope, minimum = "read", user = state.currentUser) {
    if (!user) return false;
    if (user.role === "superuser") return true;
    const rank = { none: 0, read: 1, write: 2, admin: 3 };
    const perms = permissionsOf(user);
    const flags = {
      dashboard: "accessDashboard",
      spk: "accessSpk",
      filling: "accessFilling",
      press: "accessPress",
      apd: "accessApd",
      reports: "accessReports",
      workReport: "accessWorkReport",
      spkReport: "accessSpkReport",
      kpiFilling: "accessKpiFillingReport",
      kpiPress: "accessKpiPressReport",
      kpiSpv: "accessKpiSpvReport",
      master: "accessMaster",
      kpiSettings: "accessKpiSettings",
    };
    const fallback = !perms[flags[scope]]
      ? "none"
      : ["spk", "filling", "press", "apd", "master", "kpiSettings"].includes(
            scope,
          )
        ? "write"
        : "read";
    if (
      ["workReport", "spkReport", "kpiFilling", "kpiPress", "kpiSpv"].includes(
        scope,
      )
    ) {
      const parent =
        perms.levels?.reports || (perms.accessReports ? "admin" : "read");
      if (parent === "admin") return true;
      if (parent === "none") return false;
    }
    return (rank[perms.levels?.[scope] || fallback] || 0) >= rank[minimum];
  }

  function canManage(scope, owner, user = state.currentUser) {
    if (!canLevel(scope, "write", user)) return false;
    if (user.role === "superuser" || canLevel(scope, "admin", user))
      return true;
    const selected = permissionsOf(user).management?.[scope];
    return selected ? selected[owner] === true : owner === "own";
  }

  function canKpiType(type) {
    if (!canLevel("reports")) return false;
    if (can("accessKpiReport")) return true;
    if (type === "press") return canLevel("kpiPress");
    if (type === "filling") return canLevel("kpiFilling");
    if (type === "spv") return canLevel("kpiSpv");
    return false;
  }

  function canOpenReports() {
    return (
      canLevel("reports") &&
      (canLevel("workReport") ||
        canLevel("spkReport") ||
        canKpiType("filling") ||
        canKpiType("press") ||
        canKpiType("spv"))
    );
  }

  function selectAvailableKpiMonth() {
    const input = el("lap-kpi-month");
    if (!input || input.dataset.userSelected === "1") return;
    const type = el("lap-kpi-type")?.value || "filling";
    const months = (state.reportEntries || [])
      .filter(
        (entry) => type === "shift" || type === "spv" || entry.tab === type,
      )
      .map((entry) => String(entry.tanggal || "").slice(0, 7))
      .filter((value) => /^\d{4}-\d{2}$/.test(value))
      .sort();
    if (months.length && !months.includes(input.value))
      input.value = months[months.length - 1];
  }

  function canEditEntry(entry) {
    if (!state.currentUser || !entry) return false;
    return canManage(
      entry.tab,
      entry.createdBy === state.currentUser.username ? "own" : "others",
    );
  }

  function canDeleteEntry(entry) {
    if (!state.currentUser || !entry) return false;
    return canManage(
      entry.tab,
      entry.createdBy === state.currentUser.username ? "own" : "others",
    );
  }

  function canManageSpk(spk) {
    if (!state.currentUser || !spk) return false;
    return canManage(
      "spk",
      spk.createdBy === state.currentUser.username ? "own" : "others",
    );
  }

  function canDeletePressRemainder() {
    return (
      canLevel("press", "admin") ||
      (canLevel("press", "read") && can("deleteUnpressed"))
    );
  }

  function firstAllowedView() {
    if (can("accessDashboard")) return "dashboard";
    if (can("accessSpk")) return "spk";
    if (can("accessFilling")) return "filling";
    if (can("accessPress")) return "press";
    if (can("accessApd")) return "apd";
    if (canOpenReports()) return "laporan";
    if (can("accessMaster") || can("accessKpiSettings")) return "master";
    return "";
  }

  function viewPage(view) {
    return (
      {
        dashboard: "index.html",
        spk: "spk.html",
        filling: "filling.html",
        press: "press.html",
        apd: "apd.html",
        laporan: "laporan.html",
        master: "setting.html",
      }[view] || "index.html"
    );
  }

  function applyAccessControl() {
    const accessMap = {
      dashboard: can("accessDashboard"),
      spk: can("accessSpk"),
      filling: can("accessFilling"),
      press: can("accessPress"),
      apd: can("accessApd"),
      laporan: canOpenReports(),
      master: can("accessMaster") || can("accessKpiSettings"),
    };
    Object.entries(accessMap).forEach(([view, allowed]) => {
      const btn = qs(`.tab-btn[data-view="${view}"]`);
      if (btn) btn.hidden = !allowed;
    });
    ["filling", "press", "apd"].forEach((scope) => {
      el("view-" + scope)?.classList.toggle(
        "read-only",
        !canLevel(scope, "write"),
      );
    });
    el("view-spk")?.classList.toggle(
      "spk-read-only",
      !canLevel("spk", "write"),
    );
    [
      "spkOpenButton",
      "spkImportButton",
      "spkMassDeleteButton",
      "spkSaveButton",
    ].forEach((id) => {
      const button = el(id);
      if (button)
        button.hidden =
          !canLevel("spk", "write") ||
          (id === "spkMassDeleteButton" && selectedSpkRows.size === 0);
    });
    qsa("#view-filling .f-export-btn").forEach((button) => {
      button.hidden = !can("accessExportFillingCsv");
    });
    qsa("#view-press .f-export-btn").forEach((button) => {
      button.hidden = !can("accessExportPressCsv");
    });
    el("view-master")?.classList.toggle(
      "master-read-only",
      !canLevel("master", "write"),
    );
    el("kpiSettingPanel")?.classList.toggle(
      "read-only",
      !canLevel("kpiSettings", "write"),
    );
    qsa(
      "#view-master .master-layout > section:not(#userManagementPanel):not(#kpiSettingPanel)",
    ).forEach((node) => {
      node.hidden = !can("accessMaster");
    });
    if (el("kpiSettingPanel"))
      el("kpiSettingPanel").hidden = !can("accessKpiSettings");
    if (el("inputDataCleanupPanel"))
      el("inputDataCleanupPanel").hidden =
        state.currentUser?.role !== "superuser";
    qsa(".laporan-subnav-btn").forEach((btn) => {
      btn.hidden =
        btn.dataset.laporanView === "hasil"
          ? !can("accessWorkReport")
          : btn.dataset.laporanView === "spk"
            ? !canLevel("spkReport")
            : !(
                canKpiType("filling") ||
                canKpiType("press") ||
                canKpiType("spv")
              );
    });
    const activeReport = qs(".laporan-subnav-btn.active");
    if (activeReport?.hidden) {
      const fallback = canLevel("spkReport")
        ? "spk"
        : can("accessWorkReport")
          ? "hasil"
          : "kpi";
      qsa(".laporan-subnav-btn").forEach((btn) => {
        const selected = btn.dataset.laporanView === fallback;
        btn.classList.toggle("active", selected);
        btn.setAttribute("aria-selected", String(selected));
      });
      qsa(".laporan-subview").forEach((node) => {
        node.hidden = node.id !== "laporan-subview-" + fallback;
      });
    }
    const kpiType = el("lap-kpi-type");
    if (kpiType) {
      qsa("option", kpiType).forEach((option) => {
        option.hidden = !canKpiType(option.value);
        option.disabled = option.hidden;
      });
      if (kpiType.selectedOptions[0]?.disabled) {
        kpiType.value = qsa("option:not(:disabled)", kpiType)[0]?.value || "";
        kpiType.dispatchEvent(new Event("change"));
      }
    }
    const userPanel = el("userManagementPanel");
    if (userPanel)
      userPanel.hidden =
        !state.currentUser || state.currentUser.role !== "superuser";

    const active = qs(".tab-btn.active");
    if (active && !accessMap[active.dataset.view]) {
      const fallback = firstAllowedView();
      const activePage = document.body.dataset.activeView;
      if (activePage && fallback && activePage !== fallback) {
        window.location.replace(viewPage(fallback));
        return;
      }
      qsa(".tab-btn").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.view === fallback);
      });
      qsa(".content > .view").forEach((node) => {
        node.hidden = !fallback || node.id !== "view-" + fallback;
      });
    }
  }

  /* ------------------------- LOCAL DRAFT / PREVIEW CACHE ------------------------- */
  function storageOwner() {
    const user = state.currentUser;
    if (user && user.username)
      return String(user.username).trim().toLowerCase();
    try {
      const cached = JSON.parse(
        localStorage.getItem(CONFIG.USER_KEY) || "null",
      );
      if (cached && cached.username)
        return String(cached.username).trim().toLowerCase();
    } catch (_) {}
    return "anonymous";
  }

  function userStorageKey(baseKey) {
    return `${baseKey}:${storageOwner()}`;
  }

  function persistPreview() {
    try {
      localStorage.setItem(
        userStorageKey(CONFIG.PREVIEW_KEY),
        JSON.stringify({
          ...state.preview,
          deletedEntryAudits: state.previewDeletedEntryAudits,
        }),
      );
    } catch (err) {
      console.warn("Gagal menyimpan preview lokal:", err);
    }
  }

  function loadPersistedPreview() {
    try {
      const raw = localStorage.getItem(userStorageKey(CONFIG.PREVIEW_KEY));
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (!saved || typeof saved !== "object") return;
      state.preview = {
        filling: Array.isArray(saved.filling) ? saved.filling : [],
        press: Array.isArray(saved.press) ? saved.press : [],
        apd: Array.isArray(saved.apd) ? saved.apd : [],
        spk: Array.isArray(saved.spk) ? saved.spk : [],
      };
      state.previewDeletedEntryAudits = Array.isArray(saved.deletedEntryAudits)
        ? saved.deletedEntryAudits
        : [];
    } catch (err) {
      console.warn("Preview lokal tidak dapat dibaca:", err);
    }
  }

  function previewDeletedEntryKey(entry) {
    const line = String(entry?.tab || entry?.line || "")
      .trim()
      .toLowerCase();
    const tanggal = String(entry?.tanggal || "").trim();
    const batchNo = String(entry?.batchNo || entryBatchNo(entry) || "")
      .trim()
      .toLowerCase();
    const workIdentity = batchNo
      ? `batch:${batchNo}`
      : `produk:${String(entry?.produk || "")
          .trim()
          .toLowerCase()}|botol:${String(entry?.botol || "")
          .trim()
          .toLowerCase()}`;
    return `${line}|${tanggal}|${workIdentity}`;
  }

  function recordPreviewEntryDeletion(entry) {
    if (!entry || (entry.tab !== "filling" && entry.tab !== "press")) return;
    state.previewDeletedEntryAudits.push({
      key: previewDeletedEntryKey(entry),
      nextUpdateCount:
        Math.max(0, Math.floor(Number(entry.updateCount) || 0)) + 1,
      deletedAt: nowIso(),
    });
  }

  function consumePreviewEntryDeletion(entry) {
    const key = previewDeletedEntryKey(entry);
    for (
      let index = state.previewDeletedEntryAudits.length - 1;
      index >= 0;
      index -= 1
    ) {
      const audit = state.previewDeletedEntryAudits[index];
      if (audit?.key !== key) continue;
      state.previewDeletedEntryAudits.splice(index, 1);
      return Math.max(1, Math.floor(Number(audit.nextUpdateCount) || 1));
    }
    return 0;
  }

  function getFormDrafts() {
    try {
      const raw = localStorage.getItem(userStorageKey(CONFIG.FORM_DRAFT_KEY));
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function saveFormDraft(line, form) {
    if (!form) return;
    try {
      const drafts = getFormDrafts();
      drafts[line] = {
        operator: qs(".f-operator", form)?.value || "",
        produk: qs(".f-produk", form)?.value || "",
        botol: qs(".f-botol", form)?.value || "",
        qtyKardus: qs(".f-qty-kardus", form)?.value || "",
        qtyBotolPerKardus: qs(".f-qty-botol", form)?.value || "",
        qtyBotolPecah: qs(".f-qty-pecah", form)?.value || "0",
        qtyKardusBasah: qs(".f-qty-kardus-basah", form)?.value || "0",
        batchNo: qs(".f-batch-no", form)?.value || "",
        editingId: qs(".f-editing-id", form)?.value || "",
        savedAt: nowIso(),
      };
      localStorage.setItem(
        userStorageKey(CONFIG.FORM_DRAFT_KEY),
        JSON.stringify(drafts),
      );
    } catch (err) {
      console.warn("Gagal menyimpan draft form:", err);
    }
  }

  function clearFormDraft(line) {
    try {
      const drafts = getFormDrafts();
      delete drafts[line];
      localStorage.setItem(
        userStorageKey(CONFIG.FORM_DRAFT_KEY),
        JSON.stringify(drafts),
      );
    } catch (_) {}
  }

  function restoreFormDraft(line) {
    const section = el("view-" + line);
    const form = section ? qs(".form-panel", section) : null;
    if (!form) return;
    const draft = getFormDrafts()[line];
    if (!draft) return;

    const operator = qs(".f-operator", form);
    const produk = qs(".f-produk", form);
    const botol = qs(".f-botol", form);
    const qtyKardus = qs(".f-qty-kardus", form);
    const qtyBotol = qs(".f-qty-botol", form);
    const qtyPecah = qs(".f-qty-pecah", form);
    const qtyKardusBasah = qs(".f-qty-kardus-basah", form);
    const botolPecah = qs(".f-botol-pecah", form);
    const total = qs(".f-total", form);
    const editing = qs(".f-editing-id", form);
    const batchNo = qs(".f-batch-no", form);
    const batchDisplay = qs(".f-batch-display", form);
    const submitBtn = qs(".f-submit-btn", form);
    const cancelBtn = qs(".f-cancel-btn", form);
    const stamp = qs(".stamp", form);

    if (operator && isMasterValue("operator", draft.operator))
      operator.value = canonicalMasterValue("operator", draft.operator);
    if (produk && isMasterValue("produk", draft.produk))
      produk.value = canonicalMasterValue("produk", draft.produk);
    if (botol && isMasterValue("botol", draft.botol))
      botol.value = canonicalMasterValue("botol", draft.botol);
    if (qtyKardus) qtyKardus.value = draft.qtyKardus ?? "";
    if (qtyBotol) qtyBotol.value = draft.qtyBotolPerKardus ?? "";
    if (qtyPecah) qtyPecah.value = draft.qtyBotolPecah ?? "0";
    if (qtyKardusBasah) qtyKardusBasah.value = draft.qtyKardusBasah ?? "0";
    if (batchNo)
      batchNo.value =
        draft.batchNo ||
        (line === "filling"
          ? findSpkBatch(todayStr(), produk?.value, botol?.value)
          : "");
    if (batchDisplay) batchDisplay.value = batchNo?.value || "";
    if (botolPecah) botolPecah.value = (botol && botol.value) || "-";
    if (total)
      total.value = (
        (Number(qtyKardus?.value) || 0) * (Number(qtyBotol?.value) || 0)
      ).toLocaleString("id-ID");

    // Jika sebelumnya sedang edit preview, pulihkan mode edit hanya bila item masih ada.
    const editId = draft.editingId || "";
    const editExists =
      editId && (state.preview[line] || []).some((item) => item.id === editId);
    if (editing) editing.value = editExists ? editId : "";
    if (editExists) {
      if (submitBtn) submitBtn.textContent = "Simpan Perubahan";
      if (cancelBtn) cancelBtn.hidden = false;
      if (stamp) stamp.textContent = "EDIT PREVIEW";
    }
  }

  function normalizeWebAppUrl(value) {
    return String(value || "")
      .trim()
      .replace(/\/$/, "");
  }

  function isValidWebAppUrl(url) {
    return /^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec(?:\?.*)?$/i.test(
      url,
    );
  }

  function getWebhookUrl() {
    return normalizeWebAppUrl(
      localStorage.getItem(CONFIG.URL_OVERRIDE_KEY) ||
        CONFIG.WEB_APP_URL ||
        localStorage.getItem(CONFIG.URL_KEY) ||
        "",
    );
  }

  function setWebhookUrl(url) {
    const clean = normalizeWebAppUrl(url);
    if (!isValidWebAppUrl(clean)) {
      throw new Error(
        "URL tidak valid. Gunakan URL Web App Apps Script yang berakhir /exec.",
      );
    }
    localStorage.setItem(CONFIG.URL_OVERRIDE_KEY, clean);
    setConnection("idle", "URL Apps Script tersimpan");
    return clean;
  }

  function clearWebhookUrl() {
    localStorage.removeItem(CONFIG.URL_OVERRIDE_KEY);
    localStorage.removeItem(CONFIG.URL_KEY);
  }

  function requireWebhookUrl() {
    const url = getWebhookUrl();
    if (!url || !isValidWebAppUrl(url)) {
      throw new Error(
        "URL Apps Script belum benar. Tempel URL deployment Web App /exec pada CONFIG.WEB_APP_URL.",
      );
    }
    return url;
  }

  async function fetchWithTimeout(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function parseApiResponse(response) {
    const text = await response.text();
    const trimmed = text.trim();

    if (!response.ok) {
      throw new Error(`Server mengembalikan HTTP ${response.status}.`);
    }
    if (!trimmed) {
      throw new Error("Apps Script tidak mengembalikan data.");
    }
    if (
      /^<!doctype html/i.test(trimmed) ||
      /^<html/i.test(trimmed) ||
      /accounts\.google\.com/i.test(trimmed)
    ) {
      throw new Error(
        "Apps Script mengembalikan halaman Google, bukan JSON. Deploy sebagai Web App: Execute as = Me dan akses = Anyone.",
      );
    }

    let data;
    try {
      data = JSON.parse(trimmed);
    } catch (_) {
      throw new Error(
        "Respons Apps Script bukan JSON valid. Pastikan Code.gs dan deployment sudah diperbarui.",
      );
    }

    if (!data || data.ok !== true) {
      const error = new Error(
        (data && data.message) || "Permintaan ke Apps Script gagal.",
      );
      error.isApiError = true;
      throw error;
    }
    return data;
  }

  function normalizeApiError(err) {
    if (err && err.name === "AbortError") {
      return new Error(
        "Koneksi ke Apps Script terlalu lama. Periksa internet dan deployment Web App.",
      );
    }
    const msg =
      err && err.message ? err.message : String(err || "Terjadi kesalahan.");
    if (/Failed to fetch|NetworkError|Load failed|CORS/i.test(msg)) {
      return new Error(
        "Tidak dapat menghubungi Apps Script. Gunakan URL /exec terbaru, deploy dengan akses Anyone, dan jangan memakai request JSON/custom header.",
      );
    }
    return err instanceof Error ? err : new Error(msg);
  }

  function setConnection(mode, text) {
    const status = el("connectionStatus");
    const label = el("connectionText");
    const loginLabel = el("loginConnectionText");
    if (status) status.dataset.state = mode;
    if (label) label.textContent = text;
    if (loginLabel) loginLabel.textContent = text;
  }

  async function apiGet(action, params = {}, withToken = true) {
    const base = requireWebhookUrl();
    const query = new URLSearchParams();
    query.set("action", action);
    query.set("_ts", String(Date.now()));
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) query.set(key, String(value));
    });
    if (withToken && state.token) query.set("token", state.token);

    if (!suppressNavigationLoading) setConnection("loading", "Loading…");
    try {
      const response = await fetchWithTimeout(`${base}?${query.toString()}`, {
        method: "GET",
        mode: "cors",
        cache: "no-store",
        redirect: "follow",
        credentials: "omit",
      });
      const data = await parseApiResponse(response);
      setConnection("online", "Aktif");
      return data;
    } catch (err) {
      setConnection(
        err?.isApiError ? "online" : "error",
        err?.isApiError ? "Aktif" : "Koneksi gagal",
      );
      throw normalizeApiError(err);
    }
  }

  async function apiPost(action, payload = {}, withToken = true) {
    const base = requireWebhookUrl();

    // URLSearchParams menghasilkan application/x-www-form-urlencoded,
    // termasuk CORS-safelisted request sehingga tidak memicu preflight JSON.
    const body = new URLSearchParams();
    body.set("action", action);
    if (withToken && state.token) body.set("token", state.token);
    Object.entries(payload).forEach(([key, value]) => {
      if (value === undefined || value === null) return;
      body.set(
        key,
        typeof value === "object" ? JSON.stringify(value) : String(value),
      );
    });

    setConnection(
      "loading",
      action === "login" ? "Memeriksa login…" : "Loading...",
    );
    try {
      const response = await fetchWithTimeout(base, {
        method: "POST",
        mode: "cors",
        body,
        cache: "no-store",
        redirect: "follow",
        credentials: "omit",
      });
      const data = await parseApiResponse(response);
      setConnection("online", "Aktif");
      return data;
    } catch (err) {
      setConnection(
        err?.isApiError ? "online" : "error",
        err?.isApiError ? "Aktif" : "Koneksi gagal",
      );
      throw normalizeApiError(err);
    }
  }

  window.SheetsIntegration = {
    setWebhookUrl,
    getWebhookUrl,
    clearWebhookUrl,
    testConnection: () => apiGet("ping", {}, false),
  };

  function todayStr() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function findSpkBatch(tanggal, produk, botol, preferredBatchNo = "") {
    const productKey = String(produk || "")
      .trim()
      .toLowerCase();
    const bottleKey = String(botol || "")
      .trim()
      .toLowerCase();
    if (!tanggal || !productKey || !bottleKey) return "";
    const matches = (state.spkEntries || []).filter(
      (item) =>
        String(item.produk || "")
          .trim()
          .toLowerCase() === productKey &&
        String(item.botol || "")
          .trim()
          .toLowerCase() === bottleKey &&
        spkRemainingQty(item) > 0,
    );
    const preferred = String(preferredBatchNo || "").trim();
    const preferredMatch = matches.find(
      (item) => String(item.batchNo || "").trim() === preferred,
    );
    return preferredMatch
      ? String(preferredMatch.batchNo || "")
      : matches.length
        ? String(matches[matches.length - 1].batchNo || "")
        : "";
  }

  function spkFillingUsedQty(batchNo, excludeEntryId = "") {
    const target = String(batchNo || "").trim();
    if (!target) return 0;
    return [
      ...(state.entries || []).filter((item) => item.tab === "filling"),
      ...(state.preview.filling || []),
    ]
      .filter(
        (entry) =>
          entryBatchNo(entry) === target &&
          String(entry.id || "") !== String(excludeEntryId || ""),
      )
      .reduce((total, entry) => total + (Number(entry.totalQty) || 0), 0);
  }

  function spkRemainingQty(spk, excludeEntryId = "") {
    const qty = Math.max(0, Number(spk?.qty) || 0);
    const used = spkFillingUsedQty(spk?.batchNo, excludeEntryId);
    // Data SPK lama tanpa Qty tetap tampil sampai pernah digunakan.
    return qty > 0 ? Math.max(0, qty - used) : used > 0 ? 0 : 1;
  }

  function nextSpkBatchNo() {
    const today = todayStr();
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    const datePart = `${p(d.getDate())}${p(d.getMonth() + 1)}${d.getFullYear()}`;
    const max = [...(state.spkEntries || []), ...(state.preview.spk || [])]
      .filter((item) => item.tanggal === today)
      .reduce((value, item) => {
        const match = /^(\d{2})-\d{8}$/.exec(String(item.batchNo || ""));
        return Math.max(value, match ? Number(match[1]) : 0);
      }, 0);
    return `${p(max + 1)}-${datePart}`;
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function fmtDateTime(iso) {
    return new Date(iso).toLocaleString("id-ID", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function esc(value) {
    return String(value == null ? "" : value).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  }

  function highlightSearchMatch(value, query) {
    const text = String(value == null ? "" : value);
    const keyword = String(query || "").trim();
    if (!keyword) return esc(text);

    const lowerText = text.toLowerCase();
    const lowerKeyword = keyword.toLowerCase();
    let cursor = 0;
    let html = "";
    let index = lowerText.indexOf(lowerKeyword, cursor);

    while (index >= 0) {
      html += esc(text.slice(cursor, index));
      html += `<mark class="dashboard-search-highlight">${esc(text.slice(index, index + keyword.length))}</mark>`;
      cursor = index + keyword.length;
      index = lowerText.indexOf(lowerKeyword, cursor);
    }

    html += esc(text.slice(cursor));
    return html;
  }

  function toCSV(headers, rows) {
    const quote = (value) => {
      const text = String(value == null ? "" : value);
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    return [
      headers.map(quote).join(","),
      ...rows.map((row) => row.map(quote).join(",")),
    ].join("\n");
  }

  function downloadText(filename, text) {
    const blob = new Blob(["\uFEFF", text], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function genLaporanId() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `LAP-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  let toastEl = null;
  let toastTimer = null;
  function toast(message, isError = false) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.id = "toast";
      (el("mainTabbar")?.parentElement || document.body).appendChild(toastEl);
    }
    toastEl.textContent = message;
    toastEl.className = isError ? "err show" : "show";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.className = "";
    }, 3500);
  }

  function confirmDelete({ title = "Hapus data?", message, item = "" } = {}) {
    return new Promise((resolve) => {
      const previousFocus = document.activeElement;
      const overlay = document.createElement("div");
      overlay.className = "delete-confirm-modal";
      overlay.innerHTML = `
        <div class="delete-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="deleteConfirmTitle" aria-describedby="deleteConfirmMessage">
          <div class="delete-confirm-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" focusable="false"><path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-2 6h10l-.7 11H7.7L7 9Zm3 2v7h2v-7h-2Zm4 0v7h2v-7h-2Z"/></svg>
          </div>
          <div class="delete-confirm-content">
            <p class="delete-confirm-eyebrow">Konfirmasi hapus</p>
            <h3 id="deleteConfirmTitle"></h3>
            <p id="deleteConfirmMessage" class="delete-confirm-message"></p>
            <p class="delete-confirm-item" hidden></p>
          </div>
          <div class="delete-confirm-actions">
            <button type="button" class="btn delete-confirm-cancel">Batal</button>
            <button type="button" class="btn delete-confirm-submit">Ya, hapus</button>
          </div>
        </div>`;

      qs("#deleteConfirmTitle", overlay).textContent = title;
      qs("#deleteConfirmMessage", overlay).textContent =
        message || "Data yang sudah dihapus tidak dapat dikembalikan.";
      const itemEl = qs(".delete-confirm-item", overlay);
      if (item) {
        itemEl.textContent = item;
        itemEl.hidden = false;
      }

      let finished = false;
      const finish = (confirmed) => {
        if (finished) return;
        finished = true;
        document.removeEventListener("keydown", onKeydown);
        overlay.classList.add("is-closing");
        setTimeout(() => overlay.remove(), 140);
        if (previousFocus instanceof HTMLElement) previousFocus.focus();
        resolve(confirmed);
      };
      const onKeydown = (event) => {
        if (event.key === "Escape") finish(false);
        if (event.key !== "Tab") return;
        const buttons = qsa("button", overlay);
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      };

      qs(".delete-confirm-cancel", overlay).addEventListener("click", () =>
        finish(false),
      );
      qs(".delete-confirm-submit", overlay).addEventListener("click", () =>
        finish(true),
      );
      overlay.addEventListener("click", (event) => {
        if (event.target === overlay) finish(false);
      });
      document.addEventListener("keydown", onKeydown);
      document.body.appendChild(overlay);
      requestAnimationFrame(() => overlay.classList.add("is-visible"));
      qs(".delete-confirm-cancel", overlay).focus();
    });
  }

  function pageNumbers(current, total) {
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
    const values = [1];
    const start = Math.max(2, current - 1);
    const end = Math.min(total - 1, current + 1);
    if (start > 2) values.push("…");
    for (let i = start; i <= end; i++) values.push(i);
    if (end < total - 1) values.push("…");
    values.push(total);
    return values;
  }

  function renderPagination(container, current, total, onChange) {
    if (!container) return;
    if (total <= 1) {
      container.innerHTML = "";
      return;
    }

    const prev = `<button type="button" class="page-btn" data-page="${current - 1}" ${current <= 1 ? "disabled" : ""}>‹</button>`;
    const numbers = pageNumbers(current, total)
      .map((item) => {
        if (item === "…") return '<span class="page-ellipsis">…</span>';
        return `<button type="button" class="page-btn ${item === current ? "active" : ""}" data-page="${item}">${item}</button>`;
      })
      .join("");
    const next = `<button type="button" class="page-btn" data-page="${current + 1}" ${current >= total ? "disabled" : ""}>›</button>`;
    container.innerHTML = prev + numbers + next;

    container.onclick = (event) => {
      const btn = event.target.closest("button[data-page]");
      if (!btn || btn.disabled) return;
      const target = Number(btn.dataset.page);
      if (target >= 1 && target <= total && target !== current)
        onChange(target);
    };
  }

  /* ------------------------- LOGIN PAGE ------------------------- */
  function initPasswordToggle(id) {
    const input = el(id);
    if (!input || input.closest(".password-wrapper")) return;
    const wrapper = document.createElement("span");
    wrapper.className = "password-wrapper";
    input.before(wrapper);
    wrapper.append(input);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "toggle-password";
    button.setAttribute("aria-controls", id);
    function setVisible(visible) {
      input.type = visible ? "text" : "password";
      button.innerHTML = visible
        ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>'
        : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 9c2 4 5 6 9 6s7-2 9-6M5 12l-2 3m6-1-1 4m7-4 1 4m3-6 2 3"/></svg>';
      const label = visible ? "Sembunyikan password" : "Tampilkan password";
      button.setAttribute("aria-label", label);
      button.title = label;
      button.setAttribute("aria-pressed", String(visible));
    }
    setVisible(false);
    button.addEventListener("click", () =>
      setVisible(input.type === "password"),
    );
    input.form?.addEventListener("reset", () => setVisible(false));
    wrapper.append(button);
  }

  async function initLoginPage() {
    initPasswordToggle("loginPassword");
    const form = el("loginForm");
    if (!form) return;

    // Jangan menunggu ping/bootstrap di halaman login.
    // Jika token ada, aplikasi utama yang memvalidasi sesi.
    if (state.token) {
      window.location.replace("index.html");
      return;
    }

    setConnection("idle", "Siap untuk login");

    // Event login dipasang langsung saat DOM/script siap.
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const errorEl = el("loginError");
      const submit = el("loginSubmit");
      errorEl.hidden = true;
      submit.disabled = true;
      submit.innerHTML =
        'Login... <span class="spinner" aria-hidden="true"></span>';

      try {
        const data = await apiPost(
          "login",
          {
            username: el("loginUsername").value.trim(),
            password: el("loginPassword").value,
          },
          false,
        );

        state.token = data.token;
        state.currentUser = data.user || null;
        localStorage.setItem(CONFIG.TOKEN_KEY, state.token);
        if (data.user) {
          localStorage.setItem(CONFIG.USER_KEY, JSON.stringify(data.user));
        }

        // Begitu kredensial terkonfirmasi, langsung pindah.
        window.location.replace("index.html");
      } catch (err) {
        state.token = "";
        state.currentUser = null;
        localStorage.removeItem(CONFIG.TOKEN_KEY);
        localStorage.removeItem(CONFIG.USER_KEY);
        errorEl.textContent = err.message;
        errorEl.hidden = false;
        submit.disabled = false;
        submit.textContent = "Masuk";
      }
    });
  }

  /* ------------------------- APP COMMON ------------------------- */
  let pressFormTrigger = null;
  let fillingFormTrigger = null;

  function openFillingFormPopup(trigger) {
    const popup = el("fillingFormPopup");
    if (!popup) return;
    closeMasterSuggestions();
    fillingFormTrigger = trigger || document.activeElement;
    popup.hidden = false;
    document.body.classList.add("filling-popup-open");
    qs(".filling-popup-close", popup)?.focus();
  }

  function closeFillingFormPopup() {
    const popup = el("fillingFormPopup");
    if (!popup || popup.hidden) return;
    document.activeElement?.blur();
    popup.hidden = true;
    document.body.classList.remove("filling-popup-open");
    if (fillingFormTrigger?.isConnected) fillingFormTrigger.focus();
    fillingFormTrigger = null;
  }

  function buildFillingPopup() {
    const form = el("form-filling");
    if (!form || el("fillingFormPopup")) return;
    qsa(".f-produk, .f-botol, .f-qty-botol", form).forEach((input) => {
      input.readOnly = true;
    });
    const popup = document.createElement("div");
    popup.id = "fillingFormPopup";
    popup.className = "press-form-popup filling-form-popup";
    popup.hidden = true;
    popup.setAttribute("role", "dialog");
    popup.setAttribute("aria-modal", "true");
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "btn btn-ghost filling-popup-close";
    closeButton.textContent = "Tutup";
    qs(".panel-head", form)?.appendChild(closeButton);
    form.before(popup);
    popup.appendChild(form);
    closeButton.addEventListener("click", closeFillingFormPopup);
    popup.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeFillingFormPopup();
    });
  }

  function openPressFormPopup(trigger) {
    const popup = el("pressFormPopup");
    if (!popup) return;
    closeMasterSuggestions();
    pressFormTrigger = trigger || document.activeElement;
    popup.hidden = false;
    document.body.classList.add("press-popup-open");
    updatePressAvailabilityHint(qs(".form-panel", popup));
    qs(".press-popup-close", popup)?.focus();
  }

  function closePressFormPopup() {
    const popup = el("pressFormPopup");
    if (!popup || popup.hidden) return;
    document.activeElement?.blur();
    popup.hidden = true;
    document.body.classList.remove("press-popup-open");
    if (pressFormTrigger?.isConnected) pressFormTrigger.focus();
    pressFormTrigger = null;
  }

  function buildPressView() {
    const filling = el("view-filling");
    const oldPress = el("view-press");
    if (!filling || !oldPress) return;

    const clone = filling.cloneNode(true);
    // Validasi kedatangan racikan hanya diperlukan sebelum proses Filling.
    // View Press dibuat dari clone Filling, jadi pastikan gate ini tidak ikut.
    qs(".filling-validation-gate", clone)?.remove();
    qs(".filling-validation-reopen", clone)?.remove();
    clone.classList.remove("filling-awaiting-validation");
    qsa("[id]", clone).forEach((node) => node.removeAttribute("id"));
    clone.id = "view-press";
    clone.dataset.line = "press";
    clone.hidden = oldPress.hidden;
    qs(".filling-spk-panel", clone)?.remove();
    qsa("[data-line]", clone).forEach((node) => {
      node.dataset.line = "press";
    });
    qsa("h2", clone).forEach((h) => {
      h.textContent = h.textContent.replace(/Filling/g, "Press");
    });

    // Qty Kardus Basah hanya berlaku untuk Filling. Karena view Press dibuat
    // dari clone Filling, hapus field dan kolom khusus Filling dari clone Press.
    qsa(".filling-only-field, .filling-only-col", clone).forEach((node) =>
      node.remove(),
    );
    const pressEmptyPreview = qs(".f-tbody .empty-row", clone);
    if (pressEmptyPreview) pressEmptyPreview.colSpan = 12;

    const stack = qs(".line-stack", clone);
    const form = qs(".form-panel", clone);
    if (stack && form) {
      // Produk dan botol mengikuti baris Filling yang dipilih. Qty botol per
      // kardus mengambil nilai awal Filling, tetapi boleh disesuaikan di Press.
      qsa(".f-produk, .f-botol", form).forEach((input) => {
        input.readOnly = true;
      });
      const pressQtyBotolPerKardus = qs(".f-qty-botol", form);
      if (pressQtyBotolPerKardus) {
        pressQtyBotolPerKardus.readOnly = false;
        pressQtyBotolPerKardus.removeAttribute("readonly");
      }
      const balancePanel = document.createElement("section");
      balancePanel.className = "panel table-panel press-balance-panel";
      balancePanel.innerHTML = `
        <div class="panel-head">
          <div>
            <p class="eyebrow">Filling → Press</p>
            <h2>Pengerjaan belum di Press</h2>
          </div>
        </div>
        <div class="search-bar press-balance-toolbar">
          <label class="field field-inline press-balance-search-field">
            <span>Cari Nama Produk</span>
            <input type="search" class="press-balance-search" placeholder="Cari nama produk…" autocomplete="off">
          </label>
          <button type="button" class="btn btn-ghost press-balance-search-reset">Reset</button>
        </div>
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th class="select-col">
                  <input type="checkbox" class="press-balance-select-all" aria-label="Pilih semua sisa Press yang dapat dihapus pada halaman ini">
                </th>
                <th>No Batch</th>
                <th>Produk</th>
                <th>Botol</th>
                <th>Qty/Dus</th>
                <th>Qty Filling</th>
                <th>Sudah Press</th>
                <th>Sisa Kardus</th>
                <th>Sisa Qty</th>
                <th>Sumber</th>
                <th>Aksi</th>
              </tr>
            </thead>
            <tbody class="press-balance-tbody">
              <tr><td colspan="11" class="empty-row">Memuat sisa pengerjaan Press…</td></tr>
            </tbody>
          </table>
        </div>
        <div class="table-footer">
          <p class="table-summary press-balance-summary"></p>
          <div class="pagination press-balance-pagination" aria-label="Navigasi halaman sisa Press"></div>
          <button type="button" class="btn btn-danger press-balance-mass-delete" hidden disabled>
            <i class="fa-solid fa-trash"></i> Hapus Massal
          </button>
        </div>`;
      stack.insertBefore(balancePanel, form);

      const hint = document.createElement("p");
      hint.className = "press-available-hint";
      hint.dataset.state = "empty";
      hint.textContent =
        "Pilih Nama Produk untuk melihat Qty Filling yang tersedia untuk Press.";
      const error = qs(".f-error", form);
      if (error) error.insertAdjacentElement("beforebegin", hint);
      else form.appendChild(hint);

      const popup = document.createElement("div");
      popup.id = "pressFormPopup";
      popup.className = "press-form-popup";
      popup.hidden = true;
      popup.setAttribute("role", "dialog");
      popup.setAttribute("aria-modal", "true");
      popup.setAttribute("aria-labelledby", "pressFormPopupTitle");
      const title = qs("h2", form);
      if (title) title.id = "pressFormPopupTitle";
      const closeButton = document.createElement("button");
      closeButton.type = "button";
      closeButton.className = "btn btn-ghost press-popup-close";
      closeButton.textContent = "Tutup";
      closeButton.setAttribute("aria-label", "Tutup Form Pengerjaan Press");
      qs(".panel-head", form)?.appendChild(closeButton);
      form.before(popup);
      popup.appendChild(form);
      closeButton.addEventListener("click", closePressFormPopup);
      popup.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          closePressFormPopup();
        }
        if (event.key !== "Tab") return;
        const controls = qsa(
          "button, input, select, textarea, [tabindex]",
          popup,
        ).filter(
          (node) =>
            !node.disabled &&
            node.tabIndex >= 0 &&
            node.getClientRects().length,
        );
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      });
    }

    clone.addEventListener("click", async (event) => {
      const deleteBtn = event.target.closest(".press-balance-delete");
      if (deleteBtn) {
        if (!canDeletePressRemainder()) {
          return toast("Tidak ada akses", true);
        }
        const produkValue = deleteBtn.dataset.produk || "";
        const botolValue = deleteBtn.dataset.botol || "";
        const row = getPressBalanceRows().find(
          (item) =>
            balanceKey(item.produk, item.botol) ===
              balanceKey(produkValue, botolValue) &&
            String(item.batchNo || "") ===
              String(deleteBtn.dataset.batchNo || "") &&
            String(item.tanggalAsal || "") ===
              String(deleteBtn.dataset.tanggalAsal || "") &&
            Number(item.qtyBotolPerKardus[0]) ===
              Number(deleteBtn.dataset.perKardus),
        );
        if (!row) return toast("Data sisa Press tidak ditemukan.", true);
        if (row.hasPreview) {
          return toast(
            "Simpan data Preview Filling terlebih dahulu sebelum menghapus sisa Press.",
            true,
          );
        }
        if (!row.hasSpreadsheet) {
          return toast(
            "Data sisa Press ini belum tersimpan di Spreadsheet.",
            true,
          );
        }

        const alasan = await askClosePressReason(row);
        if (!alasan) return;

        deleteBtn.disabled = true;
        const oldText = deleteBtn.textContent;
        deleteBtn.textContent = "Menghapus…";
        try {
          const response = await enqueueWrite(() =>
            apiPost("press.adjustment.close", {
              data: {
                produk: row.produk,
                botol: row.botol,
                qtyBotolPerKardus: row.qtyBotolPerKardus[0],
                targetBatchNo: row.batchNo || "",
                targetTanggalAsal: row.tanggalAsal || "",
                alasan,
              },
            }),
          );
          if (response.adjustment) upsertAdjustment(response.adjustment);
          if (Array.isArray(response.remainders))
            state.remainders = response.remainders;
          state.pressBalance.page = 1;
          renderPressBalance();
          toast(
            `Sisa ${row.produk} / ${row.botol} berhasil dihapus dengan alasan tercatat.`,
          );
        } catch (err) {
          deleteBtn.disabled = false;
          deleteBtn.textContent = oldText;
          toast(`Gagal menghapus sisa Press: ${err.message}`, true);
        }
        return;
      }

      const useBtn = event.target.closest(".press-balance-use");
      if (!useBtn) return;

      const pressForm = qs(".form-panel", clone);
      if (!pressForm) return;
      // Gunakan selalu membuat Preview baru, bukan mengubah entry yang sedang diedit.
      if (qs(".f-editing-id", pressForm)?.value)
        qs(".f-cancel-btn", pressForm)?.click();
      const produk = qs(".f-produk", pressForm);
      const botol = qs(".f-botol", pressForm);
      const perKardusInput = qs(".f-qty-botol", pressForm);
      const batchInput = qs(".f-batch-no", pressForm);
      const batchDisplay = qs(".f-batch-display", pressForm);
      if (batchInput) batchInput.value = useBtn.dataset.batchNo || "";
      if (batchDisplay) batchDisplay.value = useBtn.dataset.batchNo || "";
      if (perKardusInput && Number(useBtn.dataset.perKardus) > 0) {
        perKardusInput.value = useBtn.dataset.perKardus;
        perKardusInput.dispatchEvent(new Event("input", { bubbles: true }));
      }

      if (produk) {
        produk.value = useBtn.dataset.produk || "";
        produk.dispatchEvent(new Event("change", { bubbles: true }));
      }
      if (
        botol &&
        useBtn.dataset.botol &&
        isMasterValue("botol", useBtn.dataset.botol)
      ) {
        botol.value = useBtn.dataset.botol;
        botol.dispatchEvent(new Event("change", { bubbles: true }));
      }

      updatePressAvailabilityHint(pressForm);
      saveFormDraft("press", pressForm);
      openPressFormPopup(useBtn);
    });

    const balanceBody = qs(".press-balance-tbody", clone);
    balanceBody?.addEventListener("change", (event) => {
      const checkbox = event.target.closest(".press-balance-row-select");
      if (!checkbox) return;
      const rowId = checkbox.dataset.rowId || "";
      if (checkbox.checked) selectedPressBalanceRows.add(rowId);
      else selectedPressBalanceRows.delete(rowId);
      renderPressBalance();
    });
    const selectAllBalance = qs(".press-balance-select-all", clone);
    selectAllBalance?.addEventListener("change", () => {
      let rowIds = [];
      try {
        rowIds = JSON.parse(selectAllBalance.dataset.rowIds || "[]");
      } catch (_) {}
      rowIds.forEach((rowId) => {
        if (selectAllBalance.checked) selectedPressBalanceRows.add(rowId);
        else selectedPressBalanceRows.delete(rowId);
      });
      renderPressBalance();
    });
    qs(".press-balance-mass-delete", clone)?.addEventListener(
      "click",
      async (event) => {
        // Simpan referensi sebelum await. Event.currentTarget hanya valid selama
        // dispatch event dan menjadi null setelah dialog alasan ditutup.
        const button = event.currentTarget;
        if (!canDeletePressRemainder()) return toast("Tidak ada akses", true);
        const selectedRows = getPressBalanceRows().filter(
          (row) =>
            selectedPressBalanceRows.has(String(row.id)) &&
            row.hasSpreadsheet &&
            !row.hasPreview &&
            row.tanggalAsal,
        );
        if (!selectedRows.length)
          return toast("Tidak ada sisa Press tersimpan yang dipilih.", true);
        if (selectedRows.length > 100)
          return toast("Maksimal 100 sisa Press per sekali penghapusan.", true);
        const alasan = await askClosePressReason(selectedRows);
        if (!alasan) return;

        button.disabled = true;
        button.textContent = "Menghapus…";
        try {
          const response = await enqueueWrite(() =>
            apiPost("press.adjustment.closeBatch", {
              data: {
                rows: selectedRows.map((row) => ({
                  produk: row.produk,
                  botol: row.botol,
                  qtyBotolPerKardus: row.qtyBotolPerKardus[0],
                  targetBatchNo: row.batchNo,
                  targetTanggalAsal: row.tanggalAsal,
                })),
                alasan,
              },
            }),
          );
          (response.adjustments || []).forEach(upsertAdjustment);
          if (Array.isArray(response.remainders))
            state.remainders = response.remainders;
          selectedPressBalanceRows.clear();
          state.pressBalance.page = 1;
          renderPressBalance();
          toast(
            `${selectedRows.length} sisa Press berhasil dihapus dengan alasan tercatat.`,
          );
        } catch (err) {
          button.disabled = false;
          toast(`Gagal menghapus sisa Press terpilih: ${err.message}`, true);
          renderPressBalance();
        }
      },
    );

    const balanceSearch = qs(".press-balance-search", clone);
    const balanceSearchReset = qs(".press-balance-search-reset", clone);
    if (balanceSearch) {
      balanceSearch.value = state.pressBalance.search || "";
      balanceSearch.addEventListener("input", () => {
        state.pressBalance.search = balanceSearch.value.trim();
        state.pressBalance.page = 1;
        renderPressBalance();
      });
    }
    if (balanceSearchReset) {
      balanceSearchReset.addEventListener("click", () => {
        state.pressBalance.search = "";
        state.pressBalance.page = 1;
        if (balanceSearch) balanceSearch.value = "";
        renderPressBalance();
      });
    }

    oldPress.replaceWith(clone);
    initMasterSearches(clone);
  }

  function applyBootstrap(data) {
    if (data.user) state.currentUser = data.user;
    if (data.master) {
      state.master = data.master;
      try {
        localStorage.setItem(CONFIG.MASTER_KEY, JSON.stringify(data.master));
      } catch (_) {}
    }
    if (Array.isArray(data.entries)) state.entries = data.entries;
    if (data.reportEntriesSameAsEntries && Array.isArray(data.entries))
      state.reportEntries = data.entries;
    else if (Array.isArray(data.reportEntries))
      state.reportEntries = data.reportEntries;
    else if (Array.isArray(data.entries) && !state.reportEntries.length)
      state.reportEntries = data.entries;
    if (Array.isArray(data.adjustments)) state.adjustments = data.adjustments;
    if (Array.isArray(data.remainders)) state.remainders = data.remainders;
    if (Array.isArray(data.spkEntries)) state.spkEntries = data.spkEntries;
    if (Array.isArray(data.apdEntries)) state.apdEntries = data.apdEntries;
    if (Array.isArray(data.downtimeEntries)) {
      state.downtimeEntries = data.downtimeEntries;
      fillingDowntimeDataReady = true;
    }
    if (Array.isArray(data.users)) state.users = data.users;
    if (data.settings && typeof data.settings === "object") {
      const pressTarget = Math.round(
        Number(data.settings.kpiPressOutputTargetMonthly) || 0,
      );
      const fillingTarget = Math.round(
        Number(data.settings.kpiFillingOutputTargetMonthly) || 0,
      );
      if (pressTarget > 0)
        state.settings.kpiPressOutputTargetMonthly = pressTarget;
      if (fillingTarget > 0)
        state.settings.kpiFillingOutputTargetMonthly = fillingTarget;
    }

    refreshAllDropdowns();
    loadPersistedPreview();
    restoreFormDraft("filling");
    restoreFormDraft("press");
    renderPreview("filling");
    renderPreview("press");
    renderApdPreview();
    renderApdSavedToday();
    renderEntries("filling");
    renderEntries("press");
    renderPressBalance();
    renderSpkToday();
    renderFillingSpkQueue();
    renderFillingDowntimeValidation();
    renderSpkReport();
    renderMasterChips();
    renderUsers();
    renderKpiPressSetting();
    renderKpiFillingSetting();
    renderUserHeader();
    applyAccessControl();
    maybeOpenFillingDowntimeModal();
    if (el("spkOpenButton"))
      el("spkOpenButton").hidden = !canLevel("spk", "write");
    if (Array.isArray(data.reportEntries) || data.reportEntriesSameAsEntries)
      selectAvailableKpiMonth();
    renderDashboard();
    if (typeof window.refreshLaporanAutoPreview === "function") {
      window.refreshLaporanAutoPreview();
    }
    if (typeof window.refreshKpiLaporanAutoPreview === "function") {
      window.refreshKpiLaporanAutoPreview();
    }
  }

  function refreshKpiAfterApdChange() {
    renderDashboard();
    if (typeof window.refreshLaporanAutoPreview === "function") {
      window.refreshLaporanAutoPreview();
    }
    if (typeof window.refreshKpiLaporanAutoPreview === "function") {
      window.refreshKpiLaporanAutoPreview();
    }
  }

  async function loadBootstrap() {
    const data = await apiGet("bootstrap");
    applyBootstrap(data);
    return data;
  }

  async function loadAppData(includeBootstrap = false) {
    const data = await apiGet("appdata", {
      includeBootstrap: includeBootstrap ? "1" : "0",
    });
    // Kompatibilitas deployment lama: jalur baru cukup satu request.
    if (includeBootstrap && (!data.user || !data.master)) {
      const bootstrap = await apiGet("bootstrap");
      data.user = bootstrap.user;
      data.master = bootstrap.master;
      if (!data.settings) data.settings = bootstrap.settings;
    }
    applyBootstrap(data);
    if (
      !Array.isArray(data.reportEntries) &&
      !data.reportEntriesSameAsEntries &&
      canOpenReports()
    ) {
      setConnection("error", "Backend laporan perlu diperbarui");
      toast(
        "Backend laporan belum diperbarui. Deploy ulang Code.gs agar data semua user tersedia.",
        true,
      );
    }
    return data;
  }

  function fillSelect(select, list, placeholder) {
    if (!select) return;
    const current = select.value;
    const unique = [
      ...new Set((list || []).map((v) => String(v).trim()).filter(Boolean)),
    ];
    select.innerHTML =
      `<option value="">${esc(placeholder)}</option>` +
      unique
        .map((value) => `<option value="${esc(value)}">${esc(value)}</option>`)
        .join("");
    if (unique.includes(current)) select.value = current;
  }

  function masterValues(category) {
    return [
      ...new Set(
        (state.master[category] || [])
          .map((value) => String(value || "").trim())
          .filter(Boolean),
      ),
    ];
  }

  function canonicalMasterValue(category, value) {
    const target = String(value || "")
      .trim()
      .toLowerCase();
    if (!target) return "";
    return (
      masterValues(category).find((item) => item.toLowerCase() === target) || ""
    );
  }

  function normalizedFuzzyText(value) {
    return String(value || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "")
      .trim();
  }

  function levenshteinDistance(left, right) {
    if (left === right) return 0;
    if (!left.length) return right.length;
    if (!right.length) return left.length;
    let previous = Array.from({ length: right.length + 1 }, (_, i) => i);
    for (let i = 1; i <= left.length; i += 1) {
      const current = [i];
      for (let j = 1; j <= right.length; j += 1) {
        current[j] = Math.min(
          current[j - 1] + 1,
          previous[j] + 1,
          previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
        );
      }
      previous = current;
    }
    return previous[right.length];
  }

  function approximateMasterValue(category, value) {
    const target = normalizedFuzzyText(value);
    if (target.length < 5) return "";
    const targetNumbers = target.match(/\d+/g) || [];
    const candidates = masterValues(category)
      .map((masterValue) => {
        const normalized = normalizedFuzzyText(masterValue);
        const candidateNumbers = normalized.match(/\d+/g) || [];
        // Angka merupakan identitas penting, khususnya ukuran botol.
        if (targetNumbers.join("|") !== candidateNumbers.join("|")) return null;
        const distance = levenshteinDistance(target, normalized);
        return {
          value: masterValue,
          distance,
          similarity: 1 - distance / Math.max(target.length, normalized.length),
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.distance - b.distance);
    const best = candidates[0];
    if (!best || best.distance > 2) return "";
    if (target.length < 8 && (best.distance > 1 || best.similarity < 0.85))
      return "";
    if (best.distance === 2 && (target.length < 15 || best.similarity < 0.9))
      return "";
    const equallyClose = candidates.filter(
      (candidate) => candidate.distance === best.distance,
    );
    if (equallyClose.length !== 1) return "";
    const second = candidates[1];
    if (best.distance === 2 && second && second.distance - best.distance < 2)
      return "";
    return best.value;
  }

  function firstSpkImportValue(value) {
    return String(value || "")
      .split("/", 1)[0]
      .trim()
      .replace(/\s+/g, " ");
  }

  function matchSpkBottleBySize(value) {
    const target = normalizedFuzzyText(value);
    const targetNumbers = target.match(/\d+/g) || [];
    if (!targetNumbers.length) return "";
    const unitAliases = [
      [/millilit(?:er|re)s?/, "ml"],
      [/cc/, "ml"],
      [/ml/, "ml"],
      [/lit(?:er|re)s?/, "l"],
      [/ltr/, "l"],
      [/l/, "l"],
      [/pieces?/, "pcs"],
      [/pcs?/, "pcs"],
    ];
    let targetText = target
      .replace(/\d+/g, "")
      .replace(/^(?:botol|btl|bottle)/, "");
    let targetUnit = "";
    unitAliases.forEach(([pattern, unit]) => {
      if (pattern.test(targetText)) {
        targetUnit = unit;
        targetText = targetText.replace(pattern, "");
      }
    });
    if (targetText) return "";
    const matches = masterValues("botol").filter((masterValue) => {
      const candidate = normalizedFuzzyText(masterValue);
      const candidateNumbers = candidate.match(/\d+/g) || [];
      if (targetNumbers.join("|") !== candidateNumbers.join("|")) return false;
      if (!targetUnit) return true;
      let candidateText = candidate
        .replace(/\d+/g, "")
        .replace(/^(?:botol|btl|bottle)/, "");
      let candidateUnit = "";
      unitAliases.forEach(([pattern, unit]) => {
        if (pattern.test(candidateText)) {
          candidateUnit = unit;
          candidateText = candidateText.replace(pattern, "");
        }
      });
      return candidateUnit === targetUnit;
    });
    return matches.length === 1 ? matches[0] : "";
  }

  function normalizeSpkProductName(value) {
    const productAliases = {
      joliblisswildberry: "Jolibliss Wild Strawberry",
    };
    const cleanValue = String(value || "")
      .trim()
      .replace(/\s+/g, " ");
    return productAliases[normalizedFuzzyText(cleanValue)] || cleanValue;
  }

  function isMasterValue(category, value) {
    return Boolean(canonicalMasterValue(category, value));
  }

  function validateMasterInput(input, allowPartial = false) {
    if (!input || !input.dataset.master) return true;
    const value = String(input.value || "").trim();

    // Filter operator boleh kosong/partial karena fungsinya memang mencari.
    if (allowPartial || input.classList.contains("filter-master-search")) {
      input.setCustomValidity("");
      input.classList.remove("is-invalid");
      return true;
    }

    if (!value) {
      input.setCustomValidity("Field ini wajib dipilih dari data master.");
      input.classList.add("is-invalid");
      return false;
    }

    const canonical = canonicalMasterValue(input.dataset.master, value);
    if (!canonical) {
      input.setCustomValidity("Pilih nilai yang tersedia pada data master.");
      input.classList.add("is-invalid");
      return false;
    }

    input.value = canonical;
    input.setCustomValidity("");
    input.classList.remove("is-invalid");
    return true;
  }

  function closeMasterSuggestions(exceptInput = null) {
    qsa(".master-suggest").forEach((list) => {
      if (!exceptInput || list._ownerInput !== exceptInput) list.hidden = true;
    });
  }

  function attachMasterSearch(input) {
    if (!input || input.readOnly || input.dataset.masterSearchReady === "1")
      return;
    input.dataset.masterSearchReady = "1";

    const field = input.closest(".field") || input.parentElement;
    if (!field) return;

    // APD berada di dalam container horizontal-scroll. Untuk field APD, suggestion
    // ditempel ke <body> dengan position:fixed agar tidak terpotong oleh overflow.
    // Form Filling/Press tetap memakai perilaku lama sehingga fitur lain tidak berubah.
    const floating = input.classList.contains("master-search-floating");
    const list = document.createElement("div");
    list.className = floating
      ? "master-suggest master-suggest-floating"
      : "master-suggest";
    list.hidden = true;
    list._ownerInput = input;
    (floating ? document.body : field).appendChild(list);

    function positionFloatingList() {
      if (!floating || list.hidden) return;
      const rect = input.getBoundingClientRect();
      const gap = 4;
      const viewportGap = 8;
      const preferredHeight = Math.min(
        220,
        Math.max(96, window.innerHeight * 0.32),
      );
      const spaceBelow = window.innerHeight - rect.bottom - viewportGap;
      const spaceAbove = rect.top - viewportGap;
      const openUp = spaceBelow < 120 && spaceAbove > spaceBelow;

      list.style.left = `${Math.round(rect.left)}px`;
      list.style.width = `${Math.round(rect.width)}px`;
      list.style.right = "auto";
      list.style.maxHeight = `${Math.max(72, Math.min(preferredHeight, openUp ? spaceAbove - gap : spaceBelow - gap))}px`;

      if (openUp) {
        list.style.top = "auto";
        list.style.bottom = `${Math.round(window.innerHeight - rect.top + gap)}px`;
      } else {
        list.style.top = `${Math.round(rect.bottom + gap)}px`;
        list.style.bottom = "auto";
      }
    }

    function renderList() {
      const query = String(input.value || "")
        .trim()
        .toLowerCase();

      let sourceValues = masterValues(input.dataset.master);
      // Khusus filter Laporan KPI, suggestion hanya menampilkan karyawan
      // yang benar-benar memiliki pengerjaan pada line dan bulan KPI terpilih.
      if (input.id === "lap-kpi-operator") {
        const period = kpiPressMonthPeriod(
          el("lap-kpi-month")?.value || todayStr().slice(0, 7),
        );
        if (period) {
          sourceValues = kpiOperatorsForPeriod(
            period,
            el("lap-kpi-type")?.value || "filling",
          );
        }
      }

      const values = sourceValues
        .filter((value) => !query || value.toLowerCase().includes(query))
        .slice(0, 50);

      if (!values.length) {
        list.innerHTML =
          '<div class="master-suggest-empty">Tidak ada data master yang cocok.</div>';
      } else {
        list.innerHTML = values
          .map((value) => {
            const label = [
              "dashboardPressKpiOperator",
              "lap-operator",
              "lap-kpi-operator",
            ].includes(input.id)
              ? highlightSearchMatch(value, query)
              : esc(value);
            return `<button type="button" data-value="${esc(value)}">${label}</button>`;
          })
          .join("");
      }
      list.hidden = false;
      positionFloatingList();
    }

    function selectMasterValue(button) {
      if (!button) return;
      input.value = button.dataset.value;
      input.dataset.masterTouched = "1";
      input.setCustomValidity("");
      input.classList.remove("is-invalid");
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.focus();
      list.hidden = true;
    }

    input.addEventListener("focus", renderList);
    input.addEventListener("input", () => {
      input.dataset.masterTouched = "1";
      if (!input.classList.contains("filter-master-search")) {
        input.setCustomValidity("");
        input.classList.remove("is-invalid");
      }
      renderList();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        list.hidden = true;
        input.blur();
      } else if (event.key === "Enter" && !list.hidden) {
        const first = list.querySelector("button");
        if (first) {
          event.preventDefault();
          selectMasterValue(first);
        }
      } else if (event.key === "ArrowDown" && !list.hidden) {
        event.preventDefault();
        const first = list.querySelector("button");
        if (first) first.focus();
      }
    });
    input.addEventListener("blur", () => {
      setTimeout(() => {
        if (
          document.activeElement === input ||
          list.contains(document.activeElement)
        )
          return;
        list.hidden = true;
        // Fokus saja, perpindahan tab, atau reset form tidak boleh langsung
        // menandai field kosong sebagai error sebelum pengguna mengetik/memilih.
        if (
          input.dataset.masterTouched !== "1" &&
          !String(input.value || "").trim()
        ) {
          input.setCustomValidity("");
          input.classList.remove("is-invalid");
          return;
        }
        validateMasterInput(input);
      }, 120);
    });

    input.form?.addEventListener("reset", () => {
      window.setTimeout(() => {
        delete input.dataset.masterTouched;
        input.setCustomValidity("");
        input.classList.remove("is-invalid");
      }, 0);
    });

    list.addEventListener("keydown", (event) => {
      const buttons = qsa("button", list);
      const index = buttons.indexOf(document.activeElement);
      if (event.key === "ArrowDown") {
        event.preventDefault();
        (buttons[index + 1] || buttons[0])?.focus();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        if (index <= 0) input.focus();
        else buttons[index - 1]?.focus();
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectMasterValue(buttons[index]);
      } else if (event.key === "Escape") {
        list.hidden = true;
        input.focus();
      }
    });

    list.addEventListener("mousedown", (event) => {
      const btn = event.target.closest("button[data-value]");
      if (!btn) return;
      event.preventDefault();
      selectMasterValue(btn);
    });

    // Jangan biarkan awal tap pada suggestion dianggap sebagai tap backdrop
    // oleh modal induk ketika daftar ditutup setelah nilai dipilih.
    list.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
    });

    list.addEventListener("click", (event) => {
      event.stopPropagation();
      selectMasterValue(event.target.closest("button[data-value]"));
    });

    if (floating) {
      window.addEventListener("resize", positionFloatingList);
      window.addEventListener("scroll", positionFloatingList, true);
    }
  }

  function initMasterSearches(root = document) {
    qsa(".master-search-input", root).forEach(attachMasterSearch);
  }

  function refreshAllDropdowns() {
    // Form Filling/Press memakai autocomplete custom. Data suggestion dibaca
    // langsung dari state.master sehingga tidak perlu membuat <option>.
    initMasterSearches();

    // Filter Nama Karyawan pada Laporan Produksi memakai autocomplete/search
    // dari master operator yang sama. Suggestion dibaca langsung dari state.master.

    // APD memakai autocomplete/search yang sama dengan field master lainnya.
    // Suggestion dibaca langsung dari state.master.operator.

    // Filter operator Laporan KPI memakai input search master tanpa mengubah filter lain.
    if (el("dashboardPressKpiOperator")) {
      el("dashboardPressKpiOperator").value =
        state.dashboard.pressKpiOperator || "";
    }

    // Setelah master diperbarui, validasi ulang input form yang sudah terisi.
    qsa(".master-search-input:not(.filter-master-search)").forEach((input) => {
      if (input.value) validateMasterInput(input);
    });
  }

  function renderUserHeader() {
    const user = state.currentUser;
    if (!user) return;
    const avatar = el("userAvatar");
    if (avatar)
      avatar.textContent = (user.name || user.username || "U")
        .trim()
        .charAt(0)
        .toUpperCase();
    if (el("userName")) el("userName").textContent = user.name || user.username;
    if (el("userRole"))
      el("userRole").textContent =
        user.role === "superuser" ? "Super User" : "User Biasa";
    if (el("masterTabBtn"))
      el("masterTabBtn").hidden = !(
        can("accessMaster", user) || can("accessKpiSettings", user)
      );
    if (el("deviceDateDisplay")) {
      el("deviceDateDisplay").textContent = new Date().toLocaleDateString(
        "id-ID",
        {
          weekday: "long",
          day: "2-digit",
          month: "long",
          year: "numeric",
        },
      );
    }
  }

  function matchesPreviewSearch(entry, query) {
    const keyword = String(query || "")
      .trim()
      .toLowerCase();
    if (!keyword) return true;
    return [entry.operator, entry.produk].some((value) =>
      String(value || "")
        .toLowerCase()
        .includes(keyword),
    );
  }

  function filteredEntries(line) {
    const filter = state.search[line] || { query: "" };
    const today = todayStr();

    // Tabel data tersimpan pada menu Filling / Press hanya menampilkan
    // pengerjaan dengan tanggal hari ini. Data tanggal lain tetap berada di
    // state.entries sehingga fitur Laporan, Dashboard, dan balance Press tetap
    // menggunakan histori sesuai logic yang sudah ada.
    return state.entries
      .filter((e) => e.tab === line && e.tanggal === today)
      .filter((e) => matchesPreviewSearch(e, filter.query))
      .sort((a, b) =>
        String(b.createdAt || "").localeCompare(String(a.createdAt || "")),
      );
  }

  function filteredPreviewEntries(line) {
    const filter = state.search[line] || { query: "" };
    const rows =
      state.preview && state.preview[line] ? state.preview[line] : [];
    return rows
      .filter((e) => matchesPreviewSearch(e, filter.query))
      .sort((a, b) =>
        String(b.createdAt || "").localeCompare(String(a.createdAt || "")),
      );
  }

  // Press hanya boleh disimpan setelah seluruh Preview Filling sudah
  // benar-benar disimpan ke Spreadsheet. Preview Press tetap boleh dibuat/edit.
  function hasUnsavedFillingPreview() {
    return (
      Array.isArray(state.preview.filling) && state.preview.filling.length > 0
    );
  }

  function pressQtyUnitMatchesLot(pressPerKardus, lotPerKardus) {
    const pressUnit = Number(pressPerKardus) || 0;
    // Botol/Kardus = 1 berarti Qty Pengerjaan berupa PCS, sehingga saldo
    // mengikuti Produk + Botol tanpa wajib sama dengan ukuran kardus Filling.
    return pressUnit === 1 || pressUnit === Number(lotPerKardus);
  }

  function validatePressBatchAgainstSavedFilling(previewRows) {
    const pressRows = (previewRows || []).filter(
      (item) => item.tab === "press",
    );
    if (!pressRows.length) return "";

    // Hanya saldo resmi dari Spreadsheet yang boleh menjadi dasar Simpan Press.
    // Preview Filling sengaja tidak dimasukkan karena belum tersedia di backend.
    const savedFilling = (state.remainders || [])
      .map((item) => ({
        ...item,
        tanggal: item.tanggalAsal || item.tanggal || "",
        qtyBotolPerKardus: getQtyBotolPerKardusFromRemainder(item),
        remaining: Math.max(0, Number(item.sisaQty ?? item.remaining) || 0),
      }))
      .sort(
        (a, b) =>
          String(a.tanggal || "").localeCompare(String(b.tanggal || "")) ||
          String(a.createdAt || "").localeCompare(String(b.createdAt || "")),
      );
    const allPress = [...pressRows].sort(
      (a, b) =>
        String(a.tanggal || "").localeCompare(String(b.tanggal || "")) ||
        String(a.createdAt || "").localeCompare(String(b.createdAt || "")),
    );

    for (const press of allPress) {
      const pressBatchNo = entryBatchNo(press);
      let needed = Math.max(
        0,
        Number(press.totalQty) ||
          (Number(press.qtyKardus) || 0) *
            (Number(press.qtyBotolPerKardus) || 0),
      );
      for (const filling of savedFilling) {
        if (needed <= 0) break;
        if (filling.remaining <= 0) continue;
        if (String(filling.tanggal || "") > String(press.tanggal || ""))
          continue;
        if (
          balanceKey(filling.produk, filling.botol) !==
          balanceKey(press.produk, press.botol)
        )
          continue;
        const fillingBatchNo = String(filling.batchNo || "").trim();
        if (pressBatchNo && fillingBatchNo) {
          // Backend memakai No Batch sebagai target utama dan tidak memaksa
          // ukuran kardus sama apabila kedua sisi mempunyai batch yang jelas.
          if (pressBatchNo !== fillingBatchNo) continue;
        } else if (
          !pressQtyUnitMatchesLot(
            press.qtyBotolPerKardus,
            filling.qtyBotolPerKardus,
          )
        ) {
          continue;
        }
        const used = Math.min(needed, filling.remaining);
        filling.remaining -= used;
        needed -= used;
      }
      if (needed > 0) {
        return `Preview Press melebihi saldo Filling tersimpan untuk ${press.produk} / ${press.botol}${pressBatchNo ? ` / Batch ${pressBatchNo}` : ""}. Kekurangan ${needed.toLocaleString("id-ID")} botol. Pastikan saldo Sisa Press sudah diperbarui atau kurangi Qty Press.`;
      }
    }
    return "";
  }

  function updateSaveButtonState(line) {
    const section = el("view-" + line);
    const saveBtn = section ? qs(".f-save-btn", section) : null;
    if (!saveBtn) return;

    // Pertahankan perilaku lama: tombol mengikuti jumlah baris preview yang
    // sedang tampil setelah filter. Khusus Press ditambah syarat Filling harus tersimpan dulu.
    const rows = filteredPreviewEntries(line);
    const waitingForFilling = line === "press" && hasUnsavedFillingPreview();

    saveBtn.disabled = rows.length === 0 || waitingForFilling;
    saveBtn.textContent = rows.length ? `Simpan (${rows.length})` : "Simpan";

    if (waitingForFilling) {
      saveBtn.title =
        "Simpan data Filling terlebih dahulu sebelum menyimpan Press.";
      saveBtn.dataset.waitingFilling = "1";
    } else {
      saveBtn.removeAttribute("title");
      delete saveBtn.dataset.waitingFilling;
    }
  }

  function upsertEntry(entry) {
    if (!entry || !entry.id) return;
    const index = state.entries.findIndex((x) => x.id === entry.id);
    if (index >= 0) state.entries[index] = entry;
    else state.entries.push(entry);
    if (canOpenReports()) {
      const reportIndex = state.reportEntries.findIndex(
        (x) => x.id === entry.id,
      );
      if (reportIndex >= 0) state.reportEntries[reportIndex] = entry;
      else state.reportEntries.push(entry);
    }
  }

  function balanceKey(produk, botol) {
    return `${String(produk || "")
      .trim()
      .toLowerCase()}||${String(botol || "")
      .trim()
      .toLowerCase()}`;
  }

  function upsertAdjustment(adjustment) {
    if (!adjustment || !adjustment.id) return;
    const index = state.adjustments.findIndex(
      (item) => item.id === adjustment.id,
    );
    if (index >= 0) state.adjustments[index] = adjustment;
    else state.adjustments.push(adjustment);
  }

  function ensureClosePressModalStyle() {
    if (el("pressCloseReasonStyle")) return;
    const style = document.createElement("style");
    style.id = "pressCloseReasonStyle";
    style.textContent = `
      .press-close-overlay{position:fixed;inset:0;background:rgba(15,23,42,.45);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px}
      .press-close-dialog{width:min(520px,100%);background:#fff;border-radius:16px;padding:20px;box-shadow:0 24px 70px rgba(15,23,42,.28)}
      .press-close-dialog h3{margin:0 0 6px;font-size:18px}.press-close-dialog p{margin:0 0 14px;color:#64748b;font-size:13px;line-height:1.5}
      .press-close-meta{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px}.press-close-meta div{padding:10px;background:#f8fafc;border-radius:10px;font-size:12px}
      .press-close-dialog textarea{width:100%;min-height:110px;resize:vertical;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:10px;padding:10px;font:inherit}
      .press-close-error{color:#b91c1c!important;margin:7px 0 0!important;min-height:18px}.press-close-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
      .press-balance-actions{
        display:flex;
        gap:4px;
        flex-wrap:nowrap;
        align-items:center;
        white-space:nowrap
      }
      .press-balance-actions .btn{
        flex:0 0 auto;
        min-height:0;
        padding:4px 7px;
        border-radius:6px;
        font-size:10px;
        line-height:1.15
      }
      .press-balance-panel .data-table th:last-child,
      .press-balance-panel .data-table td:last-child{
        min-width:132px;
        width:132px;
        white-space:nowrap
      }
      .press-product-name{
        display:block;
        max-width:280px;
        white-space:nowrap;
        overflow:hidden;
        text-overflow:ellipsis
      }
    `;
    document.head.appendChild(style);
  }

  function askClosePressReason(rowOrRows) {
    ensureClosePressModalStyle();
    const rows = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
    const row = rows[0] || {};
    const totalRemaining = rows.reduce(
      (sum, item) => sum + (Number(item.remaining) || 0),
      0,
    );
    const totalRemainingCartons = rows.reduce(
      (sum, item) => sum + (Number(item.sisaKardus) || 0),
      0,
    );
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "press-close-overlay";
      overlay.innerHTML = `
        <div class="press-close-dialog" role="dialog" aria-modal="true" aria-labelledby="pressCloseTitle">
          <h3 id="pressCloseTitle">Hapus Sisa Pengerjaan Press</h3>
          <p>Qty sisa akan dikeluarkan dari saldo Press aktif, tetapi riwayat Filling/Press tidak dihapus. Alasan wajib dicatat untuk audit.</p>
          <div class="press-close-meta">
            <div><strong>Produk</strong><br>${rows.length === 1 ? esc(row.produk) : `${new Set(rows.map((item) => item.produk)).size} produk dipilih`}</div>
            <div><strong>Botol</strong><br>${rows.length === 1 ? esc(row.botol) : `${new Set(rows.map((item) => item.botol)).size} jenis botol`}</div>
            <div><strong>Baris Dipilih</strong><br>${rows.length.toLocaleString("id-ID")}</div>
            <div><strong>Total Sisa Qty</strong><br>${totalRemaining.toLocaleString("id-ID")} botol</div>
            <div><strong>Total Sisa Kardus</strong><br>${totalRemainingCartons.toLocaleString("id-ID", { maximumFractionDigits: 2 })} kardus</div>
            <div><strong>Tanggal</strong><br>${esc(todayStr())}</div>
          </div>
          <label class="field"><span>Alasan Hapus <b>*</b></span>
            <textarea class="press-close-reason" maxlength="500" placeholder="Contoh: sisa botol rusak dan tidak dapat diproses press" required></textarea>
          </label>
          <p class="press-close-error"></p>
          <div class="press-close-actions">
            <button type="button" class="btn btn-ghost press-close-cancel">Batal</button>
            <button type="button" class="btn btn-danger press-close-confirm">Hapus Sisa</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const textarea = qs(".press-close-reason", overlay);
      const error = qs(".press-close-error", overlay);
      const finish = (value) => {
        overlay.remove();
        resolve(value);
      };
      qs(".press-close-cancel", overlay).addEventListener("click", () =>
        finish(""),
      );
      overlay.addEventListener("click", (event) => {
        if (event.target === overlay) finish("");
      });
      overlay.addEventListener("keydown", (event) => {
        if (event.key === "Escape") finish("");
      });
      qs(".press-close-confirm", overlay).addEventListener("click", () => {
        const reason = String(textarea.value || "").trim();
        if (reason.length < 5) {
          error.textContent = "Alasan wajib diisi minimal 5 karakter.";
          textarea.focus();
          return;
        }
        finish(reason);
      });
      setTimeout(() => textarea.focus(), 0);
    });
  }

  function getQtyBotolPerKardusFromRemainder(item) {
    const direct = Number(item && item.qtyBotolPerKardus) || 0;
    if (direct > 0) return direct;

    // ID pada Sisa Press mengikuti ID entry Filling asal, jadi nilai Botol/Kardus
    // bisa diambil dari data Pengerjaan tanpa menambah kolom/sheet baru.
    const sourceEntry = (state.entries || []).find(
      (entry) =>
        String(entry.id || "") === String((item && item.id) || "") &&
        entry.tab === "filling",
    );
    return Number(sourceEntry && sourceEntry.qtyBotolPerKardus) || 0;
  }

  function entryBatchNo(entry) {
    if (entry && entry.batchNo) return String(entry.batchNo);
    const match = /^(?:FILL|PRESS)\s*-\s*(.+)$/i.exec(
      String((entry && entry.reportId) || ""),
    );
    return match ? String(match[1] || "").trim() : "";
  }

  function compareSpkBatchNo(a, b) {
    const left = String(a || "").trim();
    const right = String(b || "").trim();
    const leftMatch = /^(\d+)-(\d{2})(\d{2})(\d{4})$/.exec(left);
    const rightMatch = /^(\d+)-(\d{2})(\d{2})(\d{4})$/.exec(right);

    if (leftMatch && rightMatch) {
      const leftDate = `${leftMatch[4]}${leftMatch[3]}${leftMatch[2]}`;
      const rightDate = `${rightMatch[4]}${rightMatch[3]}${rightMatch[2]}`;
      return (
        leftDate.localeCompare(rightDate) ||
        Number(leftMatch[1]) - Number(rightMatch[1])
      );
    }

    return left.localeCompare(right, "id", {
      numeric: true,
      sensitivity: "base",
    });
  }

  function getPressBalanceRows(options = {}) {
    const excludePreviewId = options.excludePreviewId || "";
    const lots = [];

    // 1) Sisa yang sudah resmi tersimpan di Sheet "Sisa Press".
    (state.remainders || []).forEach((item) => {
      const remaining = Number(item.sisaQty ?? item.remaining) || 0;
      if (remaining <= 0) return;
      const sourceEntry = (state.entries || []).find(
        (entry) =>
          entry.tab === "filling" && String(entry.id) === String(item.id),
      );
      lots.push({
        id: String(item.id || ""),
        tanggalAsal: String(item.tanggalAsal || item.tanggal || ""),
        produk: String(item.produk || "").trim(),
        botol: String(item.botol || "").trim(),
        batchNo: entryBatchNo(sourceEntry),
        qtyBotolPerKardus: getQtyBotolPerKardusFromRemainder(item),
        qtyBotolPerKardusValues: [],
        qtyFilling: Number(item.qtyFilling) || remaining,
        qtyPressTerpakai: Number(item.qtyPressTerpakai) || 0,
        previewPressTerpakai: 0,
        remaining,
        source: "spreadsheet",
      });
    });

    // 2) Filling yang BARU MASUK PREVIEW ikut dibaca Press walaupun belum disimpan.
    (state.preview.filling || []).forEach((item) => {
      const qty = Number(item.totalQty) || 0;
      if (qty <= 0) return;
      lots.push({
        id: `preview-filling-${item.id}`,
        tanggalAsal: String(item.tanggal || todayStr()),
        produk: String(item.produk || "").trim(),
        botol: String(item.botol || "").trim(),
        batchNo: entryBatchNo(item),
        qtyBotolPerKardus: Number(item.qtyBotolPerKardus) || 0,
        qtyFilling: qty,
        qtyPressTerpakai: 0,
        previewPressTerpakai: 0,
        remaining: qty,
        source: "preview",
      });
    });

    // Preview Press memakai kombinasi Produk + Botol + Botol/Kardus yang sama.
    const previewPress = (state.preview.press || [])
      .filter((item) => item.id !== excludePreviewId)
      .slice()
      .sort(
        (a, b) =>
          String(a.tanggal || "").localeCompare(String(b.tanggal || "")) ||
          String(a.createdAt || "").localeCompare(String(b.createdAt || "")),
      );

    previewPress.forEach((press) => {
      let needed = Number(press.totalQty) || 0;
      if (needed <= 0) return;
      const key = String(press.produk || "")
        .trim()
        .toLowerCase();
      const botolKey = balanceKey(press.produk, press.botol);
      const perKardus = Number(press.qtyBotolPerKardus) || 0;
      const pressDate = String(press.tanggal || todayStr());
      const pressBatchNo = entryBatchNo(press);

      lots
        .filter(
          (lot) =>
            lot.remaining > 0 &&
            String(lot.produk || "")
              .trim()
              .toLowerCase() === key &&
            balanceKey(lot.produk, lot.botol) === botolKey &&
            (pressBatchNo
              ? lot.batchNo === pressBatchNo
              : pressQtyUnitMatchesLot(perKardus, lot.qtyBotolPerKardus)) &&
            (!lot.tanggalAsal || lot.tanggalAsal <= pressDate),
        )
        .sort(
          (a, b) =>
            String(a.tanggalAsal || "").localeCompare(
              String(b.tanggalAsal || ""),
            ) || String(a.id).localeCompare(String(b.id)),
        )
        .forEach((lot) => {
          if (needed <= 0) return;
          const used = Math.min(needed, lot.remaining);
          lot.remaining -= used;
          lot.qtyPressTerpakai += used;
          lot.previewPressTerpakai =
            (Number(lot.previewPressTerpakai) || 0) + used;
          needed -= used;
        });
    });

    // Gabungkan berdasarkan Tanggal Asal + Produk + Botol + Qty Botol per Kardus.
    // Pemisahan tanggal mencegah nilai "Sudah Press" dari tanggal lain ikut masuk.
    // Semua lot ikut
    // dihitung, termasuk lot yang menjadi 0 karena Preview Press. Baris baru
    // disembunyikan setelah total Sisa kombinasi benar-benar 0.
    //
    const grouped = new Map();
    lots.forEach((lot) => {
      // Filter per lot agar Filling masa depan tidak ikut saldo tanggal Press.
      if (options.pressDate && lot.tanggalAsal > options.pressDate) return;
      const tanggal = String(lot.tanggalAsal || "");
      const key =
        tanggal +
        "|" +
        String(lot.batchNo || "") +
        "|" +
        balanceKey(lot.produk, lot.botol) +
        "|" +
        (Number(lot.qtyBotolPerKardus) || 0);
      if (!grouped.has(key)) {
        grouped.set(key, {
          id: `balance-${key}`,
          tanggalAsal: tanggal,
          batchNo: String(lot.batchNo || ""),
          produk: String(lot.produk || "").trim(),
          botol: String(lot.botol || "").trim(),
          qtyFilling: 0,
          qtyPressTerpakai: 0,
          remaining: 0,
          qtyBotolPerKardusValues: new Set(),
          sources: new Set(),
        });
      }
      const group = grouped.get(key);
      // Untuk data tersimpan, kedua angka ini hanya berasal dari baris pada
      // Sheet Sisa Press dengan tanggal asal yang sama. Preview Press ditambahkan
      // sebagai delta lokal setelah lolos validasi tanggal di atas.
      group.qtyFilling += Number(lot.qtyFilling) || 0;
      group.qtyPressTerpakai += Number(lot.qtyPressTerpakai) || 0;

      group.remaining += Number(lot.remaining) || 0;

      // Satu baris hanya memakai ukuran lot asal, bukan daftar gabungan API lama.
      const qtyPerKardus = Number(lot.qtyBotolPerKardus) || 0;
      if (qtyPerKardus > 0) group.qtyBotolPerKardusValues.add(qtyPerKardus);
      group.sources.add(lot.source || "spreadsheet");
    });

    return Array.from(grouped.values())
      .filter((group) => group.remaining > 0)
      .map((group) => {
        const qtyBotolPerKardus = Array.from(
          group.qtyBotolPerKardusValues,
        ).sort((a, b) => a - b);
        const perKardus = Number(qtyBotolPerKardus[0]) || 0;
        return {
          ...group,
          qtyBotolPerKardus,
          sisaKardus: perKardus > 0 ? group.remaining / perKardus : 0,
          source:
            group.sources.size > 1 ? "mixed" : Array.from(group.sources)[0],
          hasPreview: group.sources.has("preview"),
          hasSpreadsheet: group.sources.has("spreadsheet"),
        };
      })
      .sort(
        (a, b) =>
          String(a.tanggalAsal || "").localeCompare(
            String(b.tanggalAsal || ""),
          ) ||
          compareSpkBatchNo(a.batchNo, b.batchNo) ||
          a.produk.localeCompare(b.produk, "id") ||
          a.botol.localeCompare(b.botol, "id"),
      );
  }

  function getPressAvailable(
    produk,
    excludePreviewId = "",
    pressDate = todayStr(),
    botol = "",
    perKardus = 0,
    batchNo = "",
  ) {
    const key = String(produk || "")
      .trim()
      .toLowerCase();
    if (!key) return 0;
    return getPressBalanceRows({ excludePreviewId, pressDate })
      .filter(
        (row) =>
          String(row.produk || "")
            .trim()
            .toLowerCase() === key &&
          balanceKey(row.produk, row.botol) === balanceKey(produk, botol) &&
          (batchNo
            ? String(row.batchNo || "") === String(batchNo)
            : pressQtyUnitMatchesLot(perKardus, row.qtyBotolPerKardus[0])) &&
          (!row.tanggalAsal || row.tanggalAsal <= pressDate),
      )
      .reduce((sum, row) => sum + (Number(row.remaining) || 0), 0);
  }

  function renderPressBalance() {
    const section = el("view-press");
    if (!section) return;
    const tbody = qs(".press-balance-tbody", section);
    const summary = qs(".press-balance-summary", section);
    const pagination = qs(".press-balance-pagination", section);
    const searchInput = qs(".press-balance-search", section);
    if (!tbody) return;

    const allRows = getPressBalanceRows();
    const query = String(state.pressBalance.search || "")
      .trim()
      .toLowerCase();
    const rowsBeforeExcelFilter = query
      ? allRows.filter((row) =>
          String(row.produk || "")
            .toLowerCase()
            .includes(query),
        )
      : allRows;
    const rows = applyExcelDataFilter(
      tbody.closest("table"),
      rowsBeforeExcelFilter,
      [
        () => "",
        (r) => r.batchNo,
        (r) => r.produk,
        (r) => r.botol,
        (r) => r.qtyBotolPerKardus.join(" / "),
        (r) => r.qtyFilling,
        (r) => r.qtyPressTerpakai,
        (r) => r.sisaKardus,
        (r) => r.remaining,
        (r) => r.source,
      ],
      renderPressBalance,
    );

    const totalPages = Math.max(
      1,
      Math.ceil(rows.length / CONFIG.PRESS_BALANCE_PAGE_SIZE),
    );
    state.pressBalance.page = Math.min(
      Math.max(1, state.pressBalance.page || 1),
      totalPages,
    );
    const page = state.pressBalance.page;
    const start = (page - 1) * CONFIG.PRESS_BALANCE_PAGE_SIZE;
    const visibleRows = rows.slice(
      start,
      start + CONFIG.PRESS_BALANCE_PAGE_SIZE,
    );
    const selectableRowIds = new Set(
      allRows
        .filter(
          (row) =>
            canDeletePressRemainder() &&
            row.hasSpreadsheet &&
            !row.hasPreview &&
            row.tanggalAsal &&
            Number(row.qtyBotolPerKardus[0]) > 0,
        )
        .map((row) => String(row.id)),
    );
    selectedPressBalanceRows.forEach((rowId) => {
      if (!selectableRowIds.has(rowId)) selectedPressBalanceRows.delete(rowId);
    });

    if (searchInput && searchInput.value !== state.pressBalance.search) {
      searchInput.value = state.pressBalance.search || "";
    }

    tbody.innerHTML = visibleRows.length
      ? visibleRows
          .map((row) => {
            const produkAktif = isMasterValue("produk", row.produk);
            const botolAktif = isMasterValue("botol", row.botol);
            const sourceLabel =
              row.source === "preview"
                ? '<span class="sync-badge pending">Preview Filling</span>'
                : row.source === "mixed"
                  ? '<span class="sync-badge pending">Spreadsheet + Preview</span>'
                  : '<span class="sync-badge saved">Spreadsheet</span>';
            const deleteAllowed = canDeletePressRemainder();
            const selectable = selectableRowIds.has(String(row.id));
            const selectionTitle = !deleteAllowed
              ? 'Perlu izin "Hapus Sisa Press"'
              : row.hasPreview
                ? "Simpan Preview Filling terlebih dahulu"
                : !row.hasSpreadsheet
                  ? "Data ini belum tersimpan"
                  : !row.tanggalAsal
                    ? "Data belum memiliki Tanggal Asal"
                    : "Pilih sisa Press untuk penghapusan massal";
            // !deleteAllowed || row.hasPreview || !row.hasSpreadsheet;
            const deleteTitle = row.hasPreview
              ? // !deleteAllowed
                // ? 'Anda tidak memiliki akses menghapus pengerjaan yang belum di-Press.'
                "Simpan Preview Filling terlebih dahulu sebelum menghapus"
              : !row.hasSpreadsheet
                ? "Data ini belum disimpan."
                : "Hapus sisa dengan alasan";
            // : (!row.hasSpreadsheet ? 'Data ini belum tersimpan di Spreadsheet.' : 'Hapus sisa dengan alasan.');

            return `
      <tr>
        <td class="select-col"><input type="checkbox" class="press-balance-row-select" data-row-id="${esc(row.id)}" aria-label="Pilih sisa Press ${row.batchNo ? `No Batch ${esc(row.batchNo)}` : `tanpa No Batch, tanggal ${esc(row.tanggalAsal)}`}" title="${selectionTitle}" ${selectable ? "" : "disabled"} ${selectedPressBalanceRows.has(String(row.id)) ? "checked" : ""}></td>
        <td><strong>${esc(row.batchNo || "—")}</strong></td>
        <td>
          <div class="press-product-name" title="${esc(row.produk)}">${esc(row.produk)}</div>
          ${!produkAktif ? '<div class="press-master-history">Produk historis</div>' : ""}
        </td>
        <td>${esc(row.botol || "—")}${!botolAktif ? '<div class="press-master-history">Botol historis</div>' : ""}</td>
        <td>${row.qtyBotolPerKardus.length ? row.qtyBotolPerKardus.map((value) => Number(value).toLocaleString("id-ID")).join(" / ") : "—"}</td>
        <td>${Number(row.qtyFilling).toLocaleString("id-ID")}</td>
        <td>${Number(row.qtyPressTerpakai).toLocaleString("id-ID")}</td>
        <td><strong>${Number(row.sisaKardus).toLocaleString("id-ID", { maximumFractionDigits: 2 })}</strong></td>
        <td><strong>${Number(row.remaining).toLocaleString("id-ID")}</strong></td>
        <td>${sourceLabel}</td>
        <td>
          <div class="press-balance-actions">
            <button type="button" class="btn btn-ghost press-balance-use"
              data-produk="${esc(row.produk)}" data-botol="${esc(row.botol)}"
              data-batch-no="${esc(row.batchNo || "")}" data-tanggal-asal="${esc(row.tanggalAsal || "")}"
              data-per-kardus="${Number(row.qtyBotolPerKardus[0]) || 0}"
              ${!produkAktif ? 'disabled title="Produk sudah tidak ada di Master."' : ""}>Gunakan</button>
            ${
              deleteAllowed
                ? `
            <button type="button" class="btn btn-danger press-balance-delete"
            data-produk="${esc(row.produk)}"
            data-batch-no="${esc(row.batchNo || "")}" data-tanggal-asal="${esc(row.tanggalAsal)}"
            data-per-kardus="${Number(row.qtyBotolPerKardus[0]) || 0}"
            data-botol="${esc(row.botol)}"
            title="${esc(deleteTitle)}"> Hapus </button>
              `
                : ""
            }
          </div>
        </td>
      </tr>`;
          })
          .join("")
      : `<tr><td colspan="11" class="empty-row">${query ? "Nama produk tidak ditemukan." : "Tidak ada sisa Filling yang menunggu Press."}</td></tr>`;

    const remainingTotal = rows.reduce(
      (sum, row) => sum + (Number(row.remaining) || 0),
      0,
    );
    const remainingCartonTotal = rows.reduce(
      (sum, row) => sum + (Number(row.sisaKardus) || 0),
      0,
    );
    const from = rows.length ? start + 1 : 0;
    const to = Math.min(start + CONFIG.PRESS_BALANCE_PAGE_SIZE, rows.length);
    if (summary) {
      const previewCount = rows.filter((row) => row.hasPreview).length;
      summary.textContent =
        `${from}–${to} dari ${rows.length} kombinasi Produk + Botol + Qty/Dus · Sisa ${remainingTotal.toLocaleString("id-ID")} botol (${remainingCartonTotal.toLocaleString("id-ID", { maximumFractionDigits: 2 })} kardus)` +
        (query ? ` · Pencarian: ${state.pressBalance.search}` : "") +
        (previewCount
          ? ` · ${previewCount} kombinasi memuat Preview Filling`
          : "");
    }

    renderPagination(pagination, page, totalPages, (nextPage) => {
      state.pressBalance.page = nextPage;
      renderPressBalance();
      qs(".press-balance-panel", section)?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });

    const visibleRowIds = visibleRows
      .filter((row) => selectableRowIds.has(String(row.id)))
      .map((row) => String(row.id));
    const selectAll = qs(".press-balance-select-all", section);
    if (selectAll) {
      const selectedCount = visibleRowIds.filter((rowId) =>
        selectedPressBalanceRows.has(rowId),
      ).length;
      selectAll.disabled = !visibleRowIds.length;
      selectAll.checked =
        Boolean(visibleRowIds.length) && selectedCount === visibleRowIds.length;
      selectAll.indeterminate =
        selectedCount > 0 && selectedCount < visibleRowIds.length;
      selectAll.dataset.rowIds = JSON.stringify(visibleRowIds);
    }
    const massDeleteButton = qs(".press-balance-mass-delete", section);
    if (massDeleteButton) {
      massDeleteButton.hidden = !selectedPressBalanceRows.size;
      massDeleteButton.disabled =
        !selectedPressBalanceRows.size || !canDeletePressRemainder();
      massDeleteButton.innerHTML = `<i class="fa-solid fa-trash"></i> Hapus Massal${selectedPressBalanceRows.size ? ` (${selectedPressBalanceRows.size})` : ""}`;
    }

    const form = qs(".form-panel", section);
    updatePressAvailabilityHint(form);
    renderDashboard();
  }

  function updatePressAvailabilityHint(form) {
    if (!form || form.dataset.line !== "press") return;
    const produk = qs(".f-produk", form)?.value || "";
    const botol = qs(".f-botol", form)?.value || "";
    const perKardus = Number(qs(".f-qty-botol", form)?.value) || 0;
    const batchNo = qs(".f-batch-no", form)?.value || "";
    const editingNode = qs(".f-editing-id", form);
    const editingId = editingNode?.value || "";
    const editingSource = editingNode?.dataset.source || "";
    const hint = qs(".press-available-hint", form);
    const submitBtn = qs(".f-submit-btn", form);
    const pressDate = qs(".f-tanggal", form)?.value || todayStr();
    const savedEdit = editingId && editingSource === "saved";
    const available = getPressAvailable(
      produk,
      editingId,
      pressDate,
      botol,
      perKardus,
      batchNo,
    );
    const blocked =
      !savedEdit &&
      (!isMasterValue("produk", produk) ||
        !isMasterValue("botol", botol) ||
        perKardus <= 0 ||
        available <= 0);
    if (submitBtn) {
      submitBtn.disabled = blocked;
      submitBtn.title = blocked
        ? "Press tidak dapat ditambahkan: pilih kombinasi Produk, Botol, dan Botol/Kardus yang memiliki sisa Filling."
        : "";
    }
    if (!hint) return;

    if (
      !isMasterValue("produk", produk) ||
      !isMasterValue("botol", botol) ||
      perKardus <= 0
    ) {
      hint.dataset.state = "empty";
      hint.textContent =
        "Pilih Nama Produk, Botol, dan Qty Botol per Kardus untuk melihat sisa Qty Filling.";
      return;
    }

    // Saat mengedit Press yang SUDAH TERSIMPAN, nilai entry lama sudah ikut
    // mengurangi Sheet Sisa Press. Karena itu saldo dari state.remainders tidak
    // boleh dipakai untuk menolak update: backend akan membuat proyeksi yang benar
    // dengan mengeluarkan entry lama terlebih dahulu, lalu memasukkan hasil edit.
    if (editingId && editingSource === "saved") {
      const existing = (state.entries || []).find(
        (item) =>
          String(item.id || "") === String(editingId) && item.tab === "press",
      );
      const oldQty = Number(existing?.totalQty) || 0;
      hint.dataset.state = "ok";
      hint.textContent = existing
        ? `Mode edit data tersimpan · Qty Press saat ini ${oldQty.toLocaleString("id-ID")} botol. Saldo Filling akan dihitung ulang saat Simpan Perubahan dengan mengeluarkan data lama dari perhitungan.`
        : "Mode edit data tersimpan · Saldo Filling akan dihitung ulang saat Simpan Perubahan.";
      return;
    }

    const lots = getPressBalanceRows({
      excludePreviewId: editingId,
      pressDate,
    }).filter(
      (row) =>
        String(row.produk || "")
          .trim()
          .toLowerCase() === String(produk).trim().toLowerCase() &&
        balanceKey(row.produk, row.botol) === balanceKey(produk, botol) &&
        (batchNo
          ? String(row.batchNo || "") === String(batchNo)
          : pressQtyUnitMatchesLot(perKardus, row.qtyBotolPerKardus[0])) &&
        (!row.tanggalAsal || row.tanggalAsal <= pressDate),
    );
    const oldest = lots.length ? lots[0].tanggalAsal : "";
    const availableCartons = perKardus > 0 ? available / perKardus : 0;
    const availabilityDetail =
      perKardus === 1
        ? `${available.toLocaleString("id-ID")} pcs`
        : `${available.toLocaleString("id-ID")} botol (${availableCartons.toLocaleString("id-ID", { maximumFractionDigits: 2 })} kardus × ${perKardus.toLocaleString("id-ID")} botol)`;

    hint.dataset.state = available > 0 ? "ok" : "empty";
    hint.textContent =
      available > 0
        ? `Sisa Filling untuk ${produk} / ${botol}: ${availabilityDetail}` +
          (oldest && oldest < todayStr()
            ? ` · termasuk tinggalan sejak ${oldest}`
            : "") +
          "."
        : `Press tidak dapat ditambahkan. Tidak ada sisa Filling untuk ${produk} / ${botol}${perKardus === 1 ? " dalam satuan PCS" : ` (${perKardus.toLocaleString("id-ID")} botol/kardus)`} pada tanggal ${pressDate}.`;
  }

  function validatePressPayload(payload, editingId = "", editingSource = "") {
    if (payload.line !== "press") return "";
    const requested =
      (Number(payload.qtyKardus) || 0) *
      (Number(payload.qtyBotolPerKardus) || 0);
    if (requested <= 0) return "Total Qty Press harus lebih dari 0 botol.";

    // Update saved Press harus divalidasi terhadap kondisi PROYEKSI, bukan saldo
    // Sisa Press saat ini karena entry yang sedang diedit masih termasuk konsumsi.
    // Backend entry.update/assertProjectedBalance_ sudah melakukan simulasi tersebut.
    if (editingId && editingSource === "saved") return "";

    // Create / edit Preview tetap memakai validasi cepat di browser seperti semula.
    const available = getPressAvailable(
      payload.produk,
      editingId,
      payload.tanggal || todayStr(),
      payload.botol,
      payload.qtyBotolPerKardus,
      payload.batchNo,
    );
    if (available <= 0) {
      return `Press tidak dapat ditambahkan karena tidak ada sisa Filling untuk ${payload.produk} / ${payload.botol} (${payload.qtyBotolPerKardus} botol/kardus) pada tanggal pengerjaan.`;
    }
    if (requested > available) {
      return `Qty Press ${requested.toLocaleString("id-ID")} botol melebihi sisa Filling ${Math.max(0, available).toLocaleString("id-ID")} botol untuk ${payload.produk} / ${payload.botol} (${payload.qtyBotolPerKardus} botol/kardus).`;
    }
    return "";
  }

  function renderEntryRow(entry) {
    const syncState = entry._syncState || "";
    const isPending = syncState === "pending";
    const isError = syncState === "error";
    const canEdit = !syncState && canEditEntry(entry);
    const canDelete = !syncState && canDeleteEntry(entry);

    // Prefix FILL/PRESS tetap tersimpan pada reportId untuk kebutuhan backend,
    // tetapi daftar data tersimpan cukup menampilkan No Batch-nya.
    let idCell = `<span class="id-badge">${esc(entryBatchNo(entry) || entry.reportId)}</span>`;
    if (isPending) {
      idCell =
        '<span class="sync-badge pending"><span class="sync-spinner"></span>Menyimpan…</span>';
    } else if (isError) {
      idCell = '<span class="sync-badge error">Gagal disimpan</span>';
    }

    return `
      <tr class="${isPending ? "pending-row" : isError ? "sync-error-row" : ""}">
        <td>${idCell}</td>
        <td>${esc(entry.tanggal)}</td>
        <td>${esc(entry.operator)}</td>
        <td>${esc(entry.produk)}</td>
        <td>${esc(entry.botol)}</td>
        <td>${Number(entry.qtyKardus) || 0}</td>
        <td>${Number(entry.qtyBotolPerKardus) || 0}</td>
        <td><strong>${Number(entry.totalQty) || 0}</strong></td>
        <td>${esc(entry.botolPecahJenis || "—")}</td>
        <td class="${Number(entry.qtyBotolPecah) > 0 ? "pecah-tag" : ""}">${Number(entry.qtyBotolPecah) || 0}</td>
        ${entry.tab === "filling" ? `<td>${Number(entry.qtyKardusBasah) || 0}</td>` : ""}
        <td class="update-count-col">${Math.max(0, Math.floor(Number(entry.updateCount) || 0))}</td>
        <td class="row-actions">
          ${isPending ? '<span class="sync-note">Diproses</span>' : ""}
          ${isError ? `<button type="button" class="btn btn-secondary btn-retry" data-id="${esc(entry.id)}">Coba Lagi</button>` : ""}
          ${canEdit ? `<button type="button" class="btn btn-ghost btn-edit" data-id="${esc(entry.id)}">Update</button>` : ""}
          ${canDelete ? `<button type="button" class="btn btn-danger btn-delete" data-id="${esc(entry.id)}">Hapus</button>` : ""}
        </td>
      </tr>`;
  }

  function combinedWorkEntries(line) {
    const saved = filteredEntries(line).map((entry) => ({
      ...entry,
      _displaySource: "saved",
    }));
    const preview = filteredPreviewEntries(line).map((entry) => ({
      ...entry,
      _displaySource: "preview",
    }));

    // Preview dan data tersimpan hari ini ditampilkan pada satu tabel.
    // Pembeda visual sengaja hanya melalui kolom ID:
    // - preview  => PREVIEW
    // - tersimpan => reportId dari Spreadsheet
    return [...saved, ...preview].sort((a, b) =>
      String(b.createdAt || "").localeCompare(String(a.createdAt || "")),
    );
  }

  function renderPreviewRow(entry) {
    const previewBatch = entryBatchNo(entry);
    return `
      <tr>
        <td><span class="id-badge">PREVIEW${previewBatch ? ` - ${esc(previewBatch)}` : ""}</span></td>
        <td>${esc(entry.tanggal)}</td>
        <td>${esc(entry.operator)}</td>
        <td>${esc(entry.produk)}</td>
        <td>${esc(entry.botol)}</td>
        <td>${Number(entry.qtyKardus) || 0}</td>
        <td>${Number(entry.qtyBotolPerKardus) || 0}</td>
        <td><strong>${Number(entry.totalQty) || 0}</strong></td>
        <td>${esc(entry.botolPecahJenis || "—")}</td>
        <td class="${Number(entry.qtyBotolPecah) > 0 ? "pecah-tag" : ""}">${Number(entry.qtyBotolPecah) || 0}</td>
        ${entry.tab === "filling" ? `<td>${Number(entry.qtyKardusBasah) || 0}</td>` : ""}
        <td class="update-count-col">${Math.max(0, Math.floor(Number(entry.updateCount) || 0))}</td>
        <td class="row-actions">
          <button type="button" class="btn btn-ghost btn-preview-edit" data-id="${esc(entry.id)}">Edit</button>
          <button type="button" class="btn btn-danger btn-preview-delete" data-id="${esc(entry.id)}">Hapus</button>
        </td>
      </tr>`;
  }

  // Dipertahankan sebagai compatibility wrapper karena beberapa alur lama
  // masih memanggil renderEntries(). Sekarang seluruh data dirender di tabel
  // yang sama melalui renderPreview().
  function renderEntries(line) {
    renderPreview(line);
  }

  function renderPreview(line) {
    const section = el("view-" + line);
    if (!section) return;

    const tbody = qs(".f-tbody", section);
    const summary = qs(".f-summary", section);
    const pagination = qs(".f-pagination", section);
    const saveBtn = qs(".f-save-btn", section);
    if (!tbody) return;

    const table = tbody.closest("table");
    const rows = applyExcelDataFilter(
      table,
      combinedWorkEntries(line),
      [
        (e) => entryBatchNo(e) || e.reportId,
        (e) => e.tanggal,
        (e) => e.operator,
        (e) => e.produk,
        (e) => e.botol,
        (e) => e.qtyKardus,
        (e) => e.qtyBotolPerKardus,
        (e) => e.totalQty,
        (e) => e.botolPecahJenis,
        (e) => e.qtyBotolPecah,
        (e) => e.qtyKardusBasah,
        (e) => e.updateCount,
      ],
      () => renderPreview(line),
    );
    const totalPages = Math.max(1, Math.ceil(rows.length / CONFIG.PAGE_SIZE));
    state.pages[line] = Math.min(Math.max(1, state.pages[line]), totalPages);
    const page = state.pages[line];
    const start = (page - 1) * CONFIG.PAGE_SIZE;
    const visibleRows = rows.slice(start, start + CONFIG.PAGE_SIZE);

    tbody.innerHTML = visibleRows.length
      ? visibleRows
          .map((entry) =>
            entry._displaySource === "preview"
              ? renderPreviewRow(entry)
              : renderEntryRow(entry),
          )
          .join("")
      : `<tr><td colspan="12" class="empty-row">Belum ada pengerjaan hari ini.</td></tr>`;

    const totalQty = rows.reduce(
      (sum, e) => sum + (Number(e.totalQty) || 0),
      0,
    );
    const totalPecah = rows.reduce(
      (sum, e) => sum + (Number(e.qtyBotolPecah) || 0),
      0,
    );
    const totalKardusBasah = rows.reduce(
      (sum, e) => sum + (Number(e.qtyKardusBasah) || 0),
      0,
    );
    const from = rows.length ? start + 1 : 0;
    const to = Math.min(start + CONFIG.PAGE_SIZE, rows.length);
    if (summary) {
      summary.textContent =
        `${from}–${to} dari ${rows.length} data hari ini · Total Qty Botol: ${totalQty.toLocaleString("id-ID")} · Total Botol Pecah: ${totalPecah.toLocaleString("id-ID")}` +
        (line === "filling"
          ? ` · Total Kardus Basah: ${totalKardusBasah.toLocaleString("id-ID")}`
          : "");
    }

    if (saveBtn) {
      updateSaveButtonState(line);

      // Perubahan Preview Filling harus langsung memperbarui status tombol
      // Simpan pada Press tanpa mengubah alur preview yang sudah ada.
      if (line === "filling") updateSaveButtonState("press");
    }

    renderPagination(pagination, page, totalPages, (nextPage) => {
      state.pages[line] = nextPage;
      renderPreview(line);
    });
    if (line === "filling") renderFillingSpkQueue();
  }

  function wireLineView(line) {
    const section = el("view-" + line);
    if (!section) return;
    const form = qs(".form-panel", section);
    if (!form) return;

    const operator = qs(".f-operator", form);
    const produk = qs(".f-produk", form);
    const botol = qs(".f-botol", form);
    const botolPecah = qs(".f-botol-pecah", form);
    const editing = qs(".f-editing-id", form);
    const batchNo = qs(".f-batch-no", form);
    const batchDisplay = qs(".f-batch-display", form);
    const tanggal = qs(".f-tanggal", form);
    const qtyKardus = qs(".f-qty-kardus", form);
    const qtyBotol = qs(".f-qty-botol", form);
    const total = qs(".f-total", form);
    const qtyPecah = qs(".f-qty-pecah", form);
    const qtyKardusBasah = qs(".f-qty-kardus-basah", form);
    const submitBtn = qs(".f-submit-btn", form);
    const cancelBtn = qs(".f-cancel-btn", form);
    const errorEl = qs(".f-error", form);
    const stamp = qs(".stamp", form);
    tanggal.value = todayStr();

    function recalc() {
      total.value = (
        (Number(qtyKardus.value) || 0) * (Number(qtyBotol.value) || 0)
      ).toLocaleString("id-ID");
      if (line === "press") updatePressAvailabilityHint(form);
    }

    function syncBotolPecah() {
      if (botolPecah) botolPecah.value = botol.value || "-";
    }

    function syncFillingBatch() {
      if (line !== "filling" || !batchNo) return;
      batchNo.value = findSpkBatch(
        tanggal.value || todayStr(),
        produk?.value,
        botol?.value,
        batchNo.value,
      );
      if (batchDisplay) batchDisplay.value = batchNo.value;
      stamp.textContent = batchNo.value
        ? `No Batch ${batchNo.value}`
        : "SPK belum dipilih";
    }

    function resetForm() {
      if (botolPecah) botolPecah.value = "-";
      form.reset();
      editing.value = "";
      editing.dataset.source = "";
      if (batchNo) batchNo.value = "";
      if (batchDisplay) batchDisplay.value = "";
      tanggal.value = todayStr();
      total.value = "0";
      qtyPecah.value = "0";
      if (qtyKardusBasah) {
        qtyKardusBasah.value = "0";
        qtyKardusBasah.setCustomValidity("");
      }
      submitBtn.textContent = "+ Tambah List";
      submitBtn.disabled = false;
      cancelBtn.hidden = true;
      stamp.textContent = "ID otomatis";
      errorEl.hidden = true;
      qsa(".master-search-input", form).forEach((input) => {
        input.setCustomValidity("");
        input.classList.remove("is-invalid");
      });
      clearFormDraft(line);
      if (line === "press") updatePressAvailabilityHint(form);
      if (line === "press") closePressFormPopup();
      if (line === "filling") closeFillingFormPopup();
    }

    botol.addEventListener("change", () => {
      syncBotolPecah();
      syncFillingBatch();
      if (line === "press") updatePressAvailabilityHint(form);
    });
    produk?.addEventListener("change", () => {
      syncFillingBatch();
      if (line === "press") updatePressAvailabilityHint(form);
    });
    produk?.addEventListener("input", () => {
      syncFillingBatch();
      if (line === "press") updatePressAvailabilityHint(form);
    });
    botol.addEventListener("input", () => {
      syncFillingBatch();
      if (line === "press") updatePressAvailabilityHint(form);
    });
    qtyKardus.addEventListener("input", () => {
      recalc();
      if (qtyKardusBasah) qtyKardusBasah.setCustomValidity("");
    });
    qtyBotol.addEventListener("input", recalc);
    tanggal.addEventListener("change", () => {
      if (line === "press") updatePressAvailabilityHint(form);
    });
    if (qtyKardusBasah) {
      qtyKardusBasah.addEventListener("input", () =>
        qtyKardusBasah.setCustomValidity(""),
      );
    }
    cancelBtn.addEventListener("click", resetForm);

    // Simpan draft form setiap ada perubahan agar refresh tidak menghapus input.
    form.addEventListener("input", () => saveFormDraft(line, form));
    form.addEventListener("change", () => saveFormDraft(line, form));

    function buildOptimisticEntry(payload, clientRequestId) {
      const createdAt = nowIso();
      return {
        id: clientRequestId,
        reportId: "Menyimpan…",
        tab: line,
        tanggal: payload.tanggal,
        operator: payload.operator,
        produk: payload.produk,
        botol: payload.botol,
        batchNo: payload.batchNo,
        qtyKardus: payload.qtyKardus,
        qtyBotolPerKardus: payload.qtyBotolPerKardus,
        totalQty: payload.qtyKardus * payload.qtyBotolPerKardus,
        botolPecahJenis: payload.botolPecahJenis || "",
        qtyBotolPecah: payload.qtyBotolPecah || 0,
        qtyKardusBasah: line === "filling" ? payload.qtyKardusBasah || 0 : 0,
        createdBy: state.currentUser ? state.currentUser.username : "",
        createdAt,
        updatedAt: "",
        updateCount: 0,
        _syncState: "pending",
        _syncPayload: { ...payload, clientRequestId },
      };
    }

    function queueOptimisticSave(entry) {
      entry._syncState = "pending";
      entry.reportId = "Menyimpan…";
      renderEntries(line);

      enqueueWrite(() => apiPost("entry.create", { data: entry._syncPayload }))
        .then((response) => {
          // Backend memakai clientRequestId yang sama sebagai ID, sehingga retry aman
          // dan baris sementara langsung diganti oleh data resmi Spreadsheet.
          upsertEntry(response.entry);
          if (Array.isArray(response.remainders))
            state.remainders = response.remainders;
          renderEntries(line);
          renderPressBalance();
          toast(`Tersimpan — ${response.entry.reportId}`);
        })
        .catch((err) => {
          const current = state.entries.find((x) => x.id === entry.id);
          if (current) {
            current._syncState = "error";
            current._syncError = err.message;
            current.reportId = "Gagal disimpan";
          }
          renderEntries(line);
          toast(`Gagal menyimpan: ${err.message}`, true);
        });
    }

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      errorEl.hidden = true;
      if (!canLevel(line, "write")) {
        errorEl.textContent = `Anda tidak memiliki akses ${LINE_LABEL[line]}.`;
        errorEl.hidden = false;
        return;
      }
      const payload = {
        line,
        batchNo: batchNo?.value || "",
        tanggal: tanggal.value || todayStr(),
        operator: qs(".f-operator", form).value,
        produk: qs(".f-produk", form).value,
        botol: qs(".f-botol", form).value,
        qtyKardus: Number(qtyKardus.value),
        qtyBotolPerKardus: Number(qtyBotol.value),
        botolPecahJenis:
          botolPecah && botolPecah.value !== "-" ? botolPecah.value : "",
        // botolPecahJenis: qs(".f-botol-pecah", form).value,
        qtyBotolPecah: Number(qtyPecah.value) || 0,
        qtyKardusBasah:
          line === "filling" ? Number(qtyKardusBasah?.value) || 0 : 0,
      };

      const masterInputs = [operator, produk, botol];
      const masterValid = masterInputs.every((input) =>
        validateMasterInput(input),
      );
      if (!masterValid) {
        errorEl.textContent =
          "Operator, Produk, dan Botol harus dipilih dari data master yang tersedia.";
        errorEl.hidden = false;
        masterInputs.find((input) => !input.checkValidity())?.reportValidity();
        return;
      }

      // Gunakan penulisan canonical dari master, bukan teks bebas hasil ketikan.
      payload.operator = canonicalMasterValue("operator", operator.value);
      payload.produk = canonicalMasterValue("produk", produk.value);
      payload.botol = canonicalMasterValue("botol", botol.value);
      payload.botolPecahJenis = payload.botol;

      if (!payload.batchNo) {
        errorEl.textContent =
          line === "filling"
            ? "SPK untuk tanggal, produk, dan botol ini belum tersedia. Input SPK dari Dashboard terlebih dahulu."
            : "No Batch SPK tidak ditemukan pada lot Filling yang dipilih.";
        errorEl.hidden = false;
        return;
      }

      if (
        !Number.isFinite(payload.qtyKardus) ||
        payload.qtyKardus < 0 ||
        !Number.isFinite(payload.qtyBotolPerKardus) ||
        payload.qtyBotolPerKardus < 0 ||
        payload.qtyBotolPecah < 0 ||
        !Number.isFinite(payload.qtyKardusBasah) ||
        payload.qtyKardusBasah < 0
      ) {
        errorEl.textContent = "Lengkapi Qty dengan benar.";
        errorEl.hidden = false;
        return;
      }

      // Khusus Filling, Qty Kardus Basah tidak boleh melebihi Qty Pengerjaan (Kardus).
      if (line === "filling" && payload.qtyKardusBasah > payload.qtyKardus) {
        errorEl.textContent =
          "Qty Kardus Basah tidak boleh lebih besar dari Qty Pengerjaan (Kardus).";
        errorEl.hidden = false;
        if (qtyKardusBasah) {
          qtyKardusBasah.setCustomValidity(
            "Qty Kardus Basah tidak boleh lebih besar dari Qty Pengerjaan (Kardus).",
          );
          qtyKardusBasah.reportValidity();
          qtyKardusBasah.focus();
        }
        return;
      }
      if (qtyKardusBasah) qtyKardusBasah.setCustomValidity("");

      const id = editing.value;
      const editingSource = editing.dataset.source || "";
      if (line === "filling") {
        const spk = (state.spkEntries || []).find(
          (item) => String(item.batchNo) === String(payload.batchNo),
        );
        const requestedQty = payload.qtyKardus * payload.qtyBotolPerKardus;
        const spkCapacity = Math.max(0, Number(spk?.qty) || 0);
        const alreadyUsedQty = spkFillingUsedQty(payload.batchNo, id);
        if (spkCapacity > 0 && alreadyUsedQty + requestedQty > spkCapacity) {
          const availableQty = Math.max(0, spkCapacity - alreadyUsedQty);
          errorEl.textContent = `Qty Filling ${requestedQty.toLocaleString("id-ID")} pcs melebihi sisa SPK pada baris ini, yaitu ${availableQty.toLocaleString("id-ID")} pcs.`;
          errorEl.hidden = false;
          return;
        }
      }
      const pressError = validatePressPayload(payload, id, editingSource);
      if (pressError) {
        errorEl.textContent = pressError;
        errorEl.hidden = false;
        return;
      }

      // UPDATE data yang sudah tersimpan langsung ke Spreadsheet.
      if (id && editing.dataset.source === "saved") {
        submitBtn.disabled = true;
        try {
          const response = await enqueueWrite(() =>
            apiPost("entry.update", { id, data: payload }),
          );
          if (response.entry) upsertEntry(response.entry);
          if (Array.isArray(response.remainders))
            state.remainders = response.remainders;
          resetForm();
          renderEntries(line);
          renderPressBalance();
          toast("Data Spreadsheet berhasil diperbarui.");
        } catch (err) {
          errorEl.textContent = err.message;
          errorEl.hidden = false;
          submitBtn.disabled = false;
        }
        return;
      }

      // UPDATE data preview saja. Belum menyentuh Spreadsheet.
      if (id) {
        const index = state.preview[line].findIndex((item) => item.id === id);
        if (index >= 0) {
          state.preview[line][index] = {
            ...state.preview[line][index],
            tanggal: payload.tanggal,
            operator: payload.operator,
            produk: payload.produk,
            botol: payload.botol,
            batchNo: payload.batchNo,
            qtyKardus: payload.qtyKardus,
            qtyBotolPerKardus: payload.qtyBotolPerKardus,
            totalQty: payload.qtyKardus * payload.qtyBotolPerKardus,
            botolPecahJenis: payload.botolPecahJenis || "",
            qtyBotolPecah: payload.qtyBotolPecah || 0,
            qtyKardusBasah:
              line === "filling" ? payload.qtyKardusBasah || 0 : 0,
            // Update pertama pada Preview tetap 0; mulai update kedua dihitung 1.
            // updatedAt menandai update pertama dan ikut tersimpan di draft lokal.
            // Counter ini ikut dibawa saat preview akhirnya disimpan ke Spreadsheet.
            updatedAt: nowIso(),
            updateCount:
              Math.max(
                0,
                Math.floor(Number(state.preview[line][index].updateCount) || 0),
              ) + (state.preview[line][index].updatedAt ? 1 : 0),
          };
          state.pages[line] = 1;
          persistPreview();
          resetForm();
          renderPreview(line);
          renderPressBalance();
          toast("Data preview berhasil diperbarui.");
          return;
        }
      }

      // CREATE hanya masuk ke preview lokal. Belum dikirim ke Spreadsheet.
      const previewId = makeClientRequestId();
      const previewEntry = {
        id: previewId,
        tab: line,
        tanggal: payload.tanggal,
        operator: payload.operator,
        produk: payload.produk,
        botol: payload.botol,
        batchNo: payload.batchNo,
        qtyKardus: payload.qtyKardus,
        qtyBotolPerKardus: payload.qtyBotolPerKardus,
        totalQty: payload.qtyKardus * payload.qtyBotolPerKardus,
        botolPecahJenis: payload.botolPecahJenis || "",
        qtyBotolPecah: payload.qtyBotolPecah || 0,
        qtyKardusBasah: line === "filling" ? payload.qtyKardusBasah || 0 : 0,
        createdAt: nowIso(),
        updatedAt: "",
        updateCount: 0,
      };
      const deletedPreviewUpdateCount =
        consumePreviewEntryDeletion(previewEntry);
      if (deletedPreviewUpdateCount > 0) {
        previewEntry.updateCount = deletedPreviewUpdateCount;
        previewEntry.updatedAt = nowIso();
      }
      state.preview[line].push(previewEntry);
      state.pages[line] = 1;
      persistPreview();
      resetForm();
      renderPreview(line);
      renderPressBalance();
      toast("Data ditambahkan ke preview. Belum disimpan ke Spreadsheet.");
    });

    const searchKeyword = qs(".f-search-keyword", section);
    const resetSearch = qs(".f-search-reset", section);

    searchKeyword.addEventListener("input", () => {
      state.search[line].query = searchKeyword.value.trim();
      state.pages[line] = 1;
      renderPreview(line);
      state.savedPages[line] = 1;
      renderEntries(line);
    });
    searchKeyword.addEventListener("change", () => {
      state.search[line].query = searchKeyword.value.trim();
      state.pages[line] = 1;
      state.savedPages[line] = 1;
      renderPreview(line);
      renderEntries(line);
    });
    resetSearch.addEventListener("click", () => {
      state.search[line] = { query: "" };
      state.pages[line] = 1;
      searchKeyword.value = "";
      state.savedPages[line] = 1;
      renderPreview(line);
      renderEntries(line);
    });

    const saveBtn = qs(".f-save-btn", section);
    if (saveBtn) {
      saveBtn.addEventListener("click", async () => {
        const previewRows = [...(state.preview[line] || [])];
        if (!previewRows.length) {
          toast("Belum ada data preview.", true);
          return;
        }

        // Pengaman kedua: walaupun event dipicu secara programatik, Press tidak
        // boleh dikirim sebelum Preview Filling selesai disimpan ke Spreadsheet.
        if (line === "press" && hasUnsavedFillingPreview()) {
          updateSaveButtonState("press");
          toast(
            "Simpan data Filling terlebih dahulu sebelum menyimpan Press.",
            true,
          );
          return;
        }

        // Jangan memblokir Simpan berdasarkan snapshot saldo di browser.
        // Snapshot dapat tertinggal sesaat setelah Filling tersimpan atau ketika
        // hak akses user tidak memuat seluruh entry Filling. Backend membaca
        // Spreadsheet terbaru dan menjadi satu-satunya validator saldo Press.

        saveBtn.disabled = true;
        saveBtn.textContent = `Menyimpan ${previewRows.length} data...`;

        // FAST SAVE: seluruh preview dikirim dalam SATU request.
        // Backend membaca Pengerjaan sekali, menulis setValues sekali,
        // lalu menghitung Sisa Press sekali untuk seluruh batch.
        const batchPayload = previewRows.map((item) => ({
          line: item.tab,
          batchNo: entryBatchNo(item),
          tanggal: item.tanggal,
          operator: item.operator,
          produk: item.produk,
          botol: item.botol,
          qtyKardus: Number(item.qtyKardus) || 0,
          qtyBotolPerKardus: Number(item.qtyBotolPerKardus) || 0,
          botolPecahJenis: item.botolPecahJenis || "",
          qtyBotolPecah: Number(item.qtyBotolPecah) || 0,
          qtyKardusBasah:
            item.tab === "filling" ? Number(item.qtyKardusBasah) || 0 : 0,
          // Pertahankan histori edit yang terjadi ketika baris masih Preview.
          updatedAt: item.updatedAt || "",
          updateCount: Math.max(0, Math.floor(Number(item.updateCount) || 0)),
          clientRequestId: item.id,
        }));

        try {
          const response = await enqueueWrite(() =>
            apiPost("entry.batchCreate", {
              data: batchPayload,
            }),
          );

          const savedIds = new Set(
            Array.isArray(response.savedIds) ? response.savedIds : [],
          );
          (response.entries || []).forEach(upsertEntry);
          if (Array.isArray(response.remainders))
            state.remainders = response.remainders;

          // Hapus dari preview hanya ID yang sudah dikonfirmasi server.
          state.preview[line] = (state.preview[line] || []).filter(
            (item) => !savedIds.has(item.id),
          );
          state.pages[line] = 1;
          persistPreview();
          renderPreview(line);
          renderEntries(line);
          renderPressBalance();

          const successCount = savedIds.size;
          const retryCount = state.preview[line].length;
          if (successCount) {
            toast(`${successCount} data berhasil disimpan ke Spreadsheet.`);
          }
          if (retryCount) {
            toast(
              `${retryCount} data belum tersimpan. Silakan klik Simpan lagi.`,
              true,
            );
          }
        } catch (err) {
          // Batch bersifat aman: jika server menolak sebelum write, seluruh preview tetap ada.
          // Jika koneksi putus sesudah server menulis, clientRequestId membuat retry tidak duplikat.
          state.pages[line] = 1;
          persistPreview();
          renderPreview(line);
          renderPressBalance();
          toast(`Gagal menyimpan: ${err.message}`, true);
        }
      });
    }

    const exportButton = qs(".f-export-btn", section);
    if (exportButton) {
      exportButton.hidden = !can(
        line === "filling" ? "accessExportFillingCsv" : "accessExportPressCsv",
      );
    }
    exportButton?.addEventListener("click", () => {
      const exportPermission =
        line === "filling" ? "accessExportFillingCsv" : "accessExportPressCsv";
      if (!can(exportPermission))
        return toast("Anda tidak memiliki akses Export CSV.", true);
      const rows = filteredPreviewEntries(line);
      if (!rows.length)
        return toast("Belum ada data preview untuk diexport.", true);
      const headers = [
        "ID Pengerjaan",
        "Line",
        "Tanggal",
        "Operator",
        "Produk",
        "Botol",
        "Qty Kardus",
        "Botol/Kardus",
        "Total Qty",
        "Botol Pecah",
        "Qty Pecah",
      ];
      if (line === "filling") headers.push("Qty Kardus Basah");
      headers.push("Dibuat Oleh");
      const csv = toCSV(
        headers,
        rows.map((e) => {
          const row = [
            e.reportId,
            LINE_LABEL[e.tab],
            e.tanggal,
            e.operator,
            e.produk,
            e.botol,
            e.qtyKardus,
            e.qtyBotolPerKardus,
            e.totalQty,
            e.botolPecahJenis || "",
            e.qtyBotolPecah,
          ];
          if (line === "filling") row.push(Number(e.qtyKardusBasah) || 0);
          row.push(e.createdBy || "PREVIEW");
          return row;
        }),
      );
      downloadText(`laporan-${line}-${todayStr()}.csv`, csv);
    });

    const hasRelatedPress = (fillingEntry) => {
      const fillingBatch = entryBatchNo(fillingEntry);
      return [
        ...(state.entries || []).filter((item) => item.tab === "press"),
        ...(state.preview.press || []),
      ].some((press) => {
        const pressBatch = entryBatchNo(press);
        if (fillingBatch && pressBatch) return pressBatch === fillingBatch;
        return (
          String(press.produk || "")
            .trim()
            .toLowerCase() ===
            String(fillingEntry.produk || "")
              .trim()
              .toLowerCase() &&
          String(press.botol || "")
            .trim()
            .toLowerCase() ===
            String(fillingEntry.botol || "")
              .trim()
              .toLowerCase() &&
          Number(press.qtyBotolPerKardus) ===
            Number(fillingEntry.qtyBotolPerKardus) &&
          String(press.tanggal || "") >= String(fillingEntry.tanggal || "")
        );
      });
    };

    const showFillingDeleteBlocked = () =>
      toast(
        "Data Filling tidak dapat dihapus karena sudah dilakukan Press, baik sebagian maupun seluruh qty. Hapus data Press terkait terlebih dahulu.",
        true,
      );

    qs(".f-tbody", section).addEventListener("click", async (event) => {
      // Data tersimpan memakai tombol Update/Hapus seperti sebelumnya.
      const savedEditBtn = event.target.closest(".btn-edit");
      const savedDeleteBtn = event.target.closest(".btn-delete");

      if (savedEditBtn) {
        const entry = state.entries.find(
          (x) => x.id === savedEditBtn.dataset.id,
        );
        if (!entry || !canEditEntry(entry))
          return toast("Anda tidak memiliki akses mengedit data ini.", true);
        editing.value = entry.id;
        editing.dataset.source = "saved";
        if (batchNo) batchNo.value = entryBatchNo(entry);
        if (batchDisplay) batchDisplay.value = entryBatchNo(entry);
        tanggal.value = entry.tanggal;
        operator.value = entry.operator;
        produk.value = entry.produk;
        botol.value = entry.botol;
        qtyKardus.value = entry.qtyKardus;
        const editSpk =
          line === "filling"
            ? [...(state.spkEntries || []), ...(state.preview.spk || [])].find(
                (item) => String(item.batchNo) === entryBatchNo(entry),
              )
            : null;
        qtyBotol.value =
          editSpk && Number(editSpk.qtyPerDus) > 0
            ? editSpk.qtyPerDus
            : entry.qtyBotolPerKardus;
        if (botolPecah)
          botolPecah.value = entry.botolPecahJenis || entry.botol || "-";
        qtyPecah.value = entry.qtyBotolPecah || 0;
        if (qtyKardusBasah) qtyKardusBasah.value = entry.qtyKardusBasah || 0;
        recalc();
        submitBtn.textContent = "Simpan Perubahan";
        cancelBtn.hidden = false;
        stamp.textContent = "EDIT DATA";
        if (line === "press") openPressFormPopup(savedEditBtn);
        else if (line === "filling") openFillingFormPopup(savedEditBtn);
        else form.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }

      if (savedDeleteBtn) {
        const entry = state.entries.find(
          (x) => x.id === savedDeleteBtn.dataset.id,
        );
        if (!entry || !canDeleteEntry(entry))
          return toast("Anda tidak memiliki akses menghapus data ini.", true);
        if (entry.tab === "filling" && hasRelatedPress(entry))
          return showFillingDeleteBlocked();
        if (
          !(await confirmDelete({
            title: "Hapus data produksi?",
            message: "Data produksi dan riwayat terkait akan dihapus permanen.",
            item: entry.reportId,
          }))
        )
          return;
        savedDeleteBtn.disabled = true;
        try {
          const response = await enqueueWrite(() =>
            apiPost("entry.delete", { id: entry.id }),
          );
          const deletedIds = new Set(
            (response.deletedIds || [entry.id]).map(String),
          );
          state.entries = state.entries.filter(
            (x) => !deletedIds.has(String(x.id)),
          );
          state.reportEntries = state.reportEntries.filter(
            (x) => !deletedIds.has(String(x.id)),
          );
          if (Array.isArray(response.remainders))
            state.remainders = response.remainders;
          renderPreview(line);
          renderPressBalance();
          renderDashboard();
          if (typeof window.refreshLaporanAutoPreview === "function")
            window.refreshLaporanAutoPreview();
          if (typeof window.refreshKpiLaporanAutoPreview === "function")
            window.refreshKpiLaporanAutoPreview();
          toast(
            entry.tab === "press"
              ? "Data Press berhasil dihapus dan qty dikembalikan ke pengerjaan belum di-press."
              : "Data berhasil dihapus.",
          );
        } catch (err) {
          savedDeleteBtn.disabled = false;
          toast(err.message, true);
        }
        return;
      }

      // Data yang belum disimpan tetap memakai aksi Edit/Hapus preview.
      const previewEditBtn = event.target.closest(".btn-preview-edit");
      const previewDeleteBtn = event.target.closest(".btn-preview-delete");

      if (previewEditBtn) {
        const entry = state.preview[line].find(
          (x) => x.id === previewEditBtn.dataset.id,
        );
        if (!entry) return;
        editing.value = entry.id;
        editing.dataset.source = "preview";
        if (batchNo) batchNo.value = entryBatchNo(entry);
        if (batchDisplay) batchDisplay.value = entryBatchNo(entry);
        tanggal.value = entry.tanggal;
        qs(".f-operator", form).value = entry.operator;
        qs(".f-produk", form).value = entry.produk;
        qs(".f-botol", form).value = entry.botol;
        qtyKardus.value = entry.qtyKardus;
        const editSpk =
          line === "filling"
            ? [...(state.spkEntries || []), ...(state.preview.spk || [])].find(
                (item) => String(item.batchNo) === entryBatchNo(entry),
              )
            : null;
        qtyBotol.value =
          editSpk && Number(editSpk.qtyPerDus) > 0
            ? editSpk.qtyPerDus
            : entry.qtyBotolPerKardus;
        if (botolPecah)
          botolPecah.value = entry.botolPecahJenis || entry.botol || "-";
        qtyPecah.value = entry.qtyBotolPecah || 0;
        if (qtyKardusBasah) qtyKardusBasah.value = entry.qtyKardusBasah || 0;
        recalc();
        submitBtn.textContent = "Simpan Perubahan";
        cancelBtn.hidden = false;
        stamp.textContent = "EDIT PREVIEW";
        saveFormDraft(line, form);
        if (line === "press") updatePressAvailabilityHint(form);
        if (line === "press") openPressFormPopup(previewEditBtn);
        else if (line === "filling") openFillingFormPopup(previewEditBtn);
        else form.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }

      if (previewDeleteBtn) {
        const previewEntry = state.preview[line].find(
          (item) => item.id === previewDeleteBtn.dataset.id,
        );
        if (line === "filling" && previewEntry && hasRelatedPress(previewEntry))
          return showFillingDeleteBlocked();
        recordPreviewEntryDeletion(previewEntry);
        state.preview[line] = state.preview[line].filter(
          (x) => x.id !== previewDeleteBtn.dataset.id,
        );
        state.pages[line] = 1;
        persistPreview();
        renderPreview(line);
        renderPressBalance();
        toast("Data dihapus dari preview.");
      }
    });
  }

  /* ------------------------- APD ------------------------- */
  const APD_VARIABLES = Object.freeze([
    { key: "maskerTidakSesuai", label: "Masker tidak sesuai", weight: 25 },
    { key: "lenganDitarik", label: "Lengan ditarik ke atas", weight: 20 },
    { key: "sepatuDiinjak", label: "Sepatu diinjak", weight: 10 },
    { key: "rambutKelihatan", label: "Rambut kelihatan", weight: 15 },
    {
      key: "resletingTidakPenuh",
      label: "Tidak diresleting secara penuh",
      weight: 10,
    },
    { key: "memakaiAksesoris", label: "Memakai aksesoris", weight: 20 },
    { key: "kebersihanSepatu", label: "Kebersihan sepatu", weight: 10 },
  ]);
  const APD_POINT_CRITERIA = Object.freeze({
    maskerTidakSesuai: [
      "DILEPAS",
      "DI DAGU",
      "DI BAWAH HIDUNG",
      "SESUAI STANDARD",
    ],
    lenganDitarik: [
      "DITARIK SAMPAI SIKU",
      "DITARIK SEBAGIAN (DI ATAS PERGELANGAN)",
      "DITARIK SEDIKIT",
      "SESUAI STANDARD",
    ],
    sepatuDiinjak: [
      "DI INJAK SEMUA",
      "BAGIAN BELAKANG SEPATU TERINJAK",
      "SEDIKIT TERINJAK/TIDAK RAPI",
      "SESUAI STANDARD",
    ],
    rambutKelihatan: [
      "PENUTUP KEPALA TIDAK DIPAKAI",
      "RAMBUT TERLIHAT BANYAK",
      "RAMBUT TERLIHAT SEDIKIT",
      "SESUAI STANDARD",
    ],
    resletingTidakPenuh: [
      "TIDAK DIRESLETING SAMA SEKALI",
      "RESLETING NAIK TURUN BERULANG",
      "RESLETING SAMPAI DADA",
      "SESUAI STANDARD",
    ],
    memakaiAksesoris: [
      "MEMAKAI AKSESORIS YANG DILARANG",
      null,
      null,
      "TIDAK PAKAI SAMA SEKALI",
    ],
    kebersihanSepatu: ["KOTOR PARAH", null, "SETENGAH KOTOR", "BERSIH"],
  });
  const APD_REASON_DETAIL_MARKER = "[Detail Poin APD]";
  const APD_REASON_DETAIL_END_MARKER = "[/Detail Poin APD]";
  const APD_MAX_POINT = 3;
  const APD_MAX_POINTS = APD_VARIABLES.length * APD_MAX_POINT;
  const APD_TOTAL_WEIGHT = APD_VARIABLES.reduce(
    (total, item) => total + item.weight,
    0,
  );

  const APD_REASON_MAX_WORDS = 300;

  function countApdWords(value) {
    const text = String(value || "").trim();
    return text ? text.split(/\s+/).filter(Boolean).length : 0;
  }

  function calculateApd(scores) {
    let totalPoints = 0;
    let percentage = 0;
    APD_VARIABLES.forEach((variable) => {
      const point = Number(scores[variable.key]) || 0;
      totalPoints += point;
      percentage += point * (variable.weight / APD_MAX_POINT);
    });
    return {
      totalPoints,
      percentage: Math.round((percentage / APD_TOTAL_WEIGHT) * 10000) / 100,
    };
  }

  async function compressApdPhoto(file) {
    if (!file?.type?.startsWith("image/"))
      throw new Error("Pilih file gambar untuk bukti APD.");
    if (file.size > 15000000)
      throw new Error("Foto asli terlalu besar. Pilih gambar di bawah 15 MB.");
    const url = URL.createObjectURL(file);
    try {
      const photo = new Image();
      await new Promise((resolve, reject) => {
        photo.onload = resolve;
        photo.onerror = () => reject(new Error("Foto tidak dapat dibuka."));
        photo.src = url;
      });
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Browser tidak dapat memproses foto.");
      for (const maxSide of [1600, 1400, 1200, 1000, 800]) {
        const scale = Math.min(
          1,
          maxSide / Math.max(photo.naturalWidth, photo.naturalHeight),
        );
        canvas.width = Math.max(1, Math.round(photo.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(photo.naturalHeight * scale));
        context.drawImage(photo, 0, 0, canvas.width, canvas.height);
        for (const quality of [0.78, 0.7, 0.62]) {
          const dataUrl = canvas.toDataURL("image/jpeg", quality);
          const bytes = Math.ceil(
            (dataUrl.length - dataUrl.indexOf(",") - 1) * 0.75,
          );
          if (bytes <= 300000)
            return {
              dataUrl,
              bytes,
              width: canvas.width,
              height: canvas.height,
            };
        }
      }
      throw new Error(
        "Foto masih terlalu besar setelah dikompres. Pilih foto lain.",
      );
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function showApdPhotoPopup(dataUrls) {
    const photos = Array.isArray(dataUrls) ? dataUrls : [dataUrls];
    const overlay = document.createElement("div");
    overlay.className = "apd-photo-overlay";
    overlay.innerHTML = `<div class="apd-photo-dialog" role="dialog" aria-modal="true" aria-label="Foto bukti APD"><button type="button" class="btn btn-ghost apd-photo-close">x</button><div class="apd-photo-gallery">${photos.map((url, index) => `<img src="${url}" alt="Foto bukti APD ${index + 1}" />`).join("")}</div></div>`;
    const close = () => overlay.remove();
    qs(".apd-photo-close", overlay).addEventListener("click", close);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close();
    });
    overlay.addEventListener("keydown", (event) => {
      if (event.key === "Escape") close();
    });
    document.body.appendChild(overlay);
    qs(".apd-photo-close", overlay).focus();
  }

  async function viewApdPhoto(item, source) {
    if (source === "preview") {
      const ids =
        item.photoFileIds || (item.photoFileId ? [item.photoFileId] : []);
      const responses = await Promise.all(
        ids.map((photoFileId) => apiGet("apd.photo.preview", { photoFileId })),
      );
      showApdPhotoPopup(responses.map((response) => response.dataUrl));
      return;
    }
    const response = await apiGet("apd.photo.get", { id: item.id });
    showApdPhotoPopup(response.dataUrls || response.dataUrl);
  }

  function apdRecordHtml(item, source, activeEditingId, activeEditingSource) {
    const isSaved = source === "saved";
    const canChange =
      canLevel("apd", "write") &&
      (!isSaved ||
        canManage(
          "apd",
          item.createdBy === state.currentUser?.username ? "own" : "others",
        ));
    const isActive =
      item.id === activeEditingId && activeEditingSource === source;
    return `
      <div class="apd-unified-grid apd-preview-record ${isActive ? (isSaved ? "is-saved-editing" : "is-editing") : ""}" data-id="${esc(item.id)}">
        <div class="apd-record-cell apd-record-operator">
          <strong>${esc(item.operator)}</strong>
          <small class="apd-record-date">${esc(item.tanggal)}</small>
        </div>
        <div class="apd-record-cell apd-record-score">${Number(item.scores?.maskerTidakSesuai) || 0}</div>
        <div class="apd-record-cell apd-record-score">${Number(item.scores?.lenganDitarik) || 0}</div>
        <div class="apd-record-cell apd-record-score">${Number(item.scores?.sepatuDiinjak) || 0}</div>
        <div class="apd-record-cell apd-record-score">${Number(item.scores?.rambutKelihatan) || 0}</div>
        <div class="apd-record-cell apd-record-score">${Number(item.scores?.resletingTidakPenuh) || 0}</div>
        <div class="apd-record-cell apd-record-score">${Number(item.scores?.memakaiAksesoris) || 0}</div>
        <div class="apd-record-cell apd-record-score">${Number(item.scores?.kebersihanSepatu) || 0}</div>
        <div class="apd-record-cell apd-record-result"><strong>${Number(item.totalPoints) || 0} / ${APD_MAX_POINTS}</strong></div>
        <div class="apd-record-cell"><span class="apd-percent-badge">${dashboardPercent(item.percentage)}</span></div>
        <div class="apd-record-cell apd-record-reason">
          <span class="apd-reason-text">${esc(item.alasan || "—")}</span>
          ${item.alasan ? '<button type="button" class="apd-reason-toggle" aria-expanded="false">Tampilkan selengkapnya</button>' : ""}
          ${item.photoFileIds?.length || item.photoFileId ? `<button type="button" class="btn btn-ghost apd-photo-view" data-id="${esc(item.id)}">Lihat Bukti (${item.photoFileIds?.length || 1})</button>` : ""}
        </div>
        <div class="apd-record-cell apd-record-actions" ${canChange ? "" : "hidden"}>
          <button type="button" class="btn btn-ghost ${isSaved ? "apd-saved-edit" : "apd-edit"}" data-id="${esc(item.id)}">Edit</button>
          <button type="button" class="btn btn-danger ${isSaved ? "apd-saved-delete" : "apd-delete"}" data-id="${esc(item.id)}">Hapus</button>
        </div>
      </div>`;
  }

  function syncApdReasonToggles(container) {
    qsa(".apd-record-reason", container).forEach((cell) => {
      const text = qs(".apd-reason-text", cell);
      const toggle = qs(".apd-reason-toggle", cell);
      if (!text || !toggle) return;
      toggle.hidden = text.scrollHeight <= text.clientHeight + 1;
    });
  }

  function renderApdPreview() {
    const container = el("apdPreviewBody");
    const summary = el("apdPreviewSummary");
    const pagination = el("apdPagination");
    const saveBtn = el("apdSaveBtn");
    const editingNode = el("apdEditingId");
    const activeEditingId = editingNode?.value || "";
    const activeEditingSource = editingNode?.dataset.source || "";
    if (!container) return;

    const allRows = (state.preview.apd || [])
      .slice()
      .sort((a, b) =>
        String(a.createdAt || "").localeCompare(String(b.createdAt || "")),
      );
    const totalPages = Math.max(
      1,
      Math.ceil(allRows.length / CONFIG.APD_PREVIEW_PAGE_SIZE),
    );
    state.pages.apd = Math.min(Math.max(1, state.pages.apd || 1), totalPages);
    const page = state.pages.apd;
    const start = (page - 1) * CONFIG.APD_PREVIEW_PAGE_SIZE;
    const rows = allRows.slice(start, start + CONFIG.APD_PREVIEW_PAGE_SIZE);

    container.innerHTML = rows
      .map((item) =>
        apdRecordHtml(item, "preview", activeEditingId, activeEditingSource),
      )
      .join("");
    syncApdReasonToggles(container);

    const from = allRows.length ? start + 1 : 0;
    const to = Math.min(start + CONFIG.APD_PREVIEW_PAGE_SIZE, allRows.length);
    const avg = allRows.length
      ? allRows.reduce((sum, item) => sum + (Number(item.percentage) || 0), 0) /
        allRows.length
      : 0;
    if (summary) {
      summary.textContent = allRows.length
        ? `${from}–${to} dari ${allRows.length} operator · Rata-rata APD ${dashboardPercent(avg)} · Baris kosong siap untuk operator berikutnya`
        : "Belum ada operator ditambahkan · Isi baris kosong di atas lalu klik Tambah.";
    }
    if (saveBtn) {
      saveBtn.disabled = allRows.length === 0;
      saveBtn.innerHTML = `<i class="fa-solid fa-cloud-arrow-up"></i> ${allRows.length ? `Simpan (${allRows.length})` : "Simpan"}`;
    }

    renderPagination(pagination, page, totalPages, (nextPage) => {
      state.pages.apd = nextPage;
      renderApdPreview();
    });
  }

  function renderApdSavedToday() {
    const container = el("apdSavedBody");
    const summary = el("apdSavedSummary");
    const pagination = el("apdSavedPagination");
    const editingNode = el("apdEditingId");
    const activeEditingId = editingNode?.value || "";
    const activeEditingSource = editingNode?.dataset.source || "";
    if (!container) return;

    const date = el("apdHistoryDate")?.value ?? todayStr();
    const name = (el("apdHistoryName")?.value || "")
      .trim()
      .toLocaleLowerCase("id-ID");
    const period = !date
      ? "Semua Tanggal"
      : date === todayStr()
        ? "Hari Ini"
        : date;
    const title = el("apdSavedTitle");
    if (title) title.textContent = `Riwayat Penilaian APD — ${period}`;
    const allRows = (state.apdEntries || [])
      .filter(
        (item) =>
          item &&
          (!date || item.tanggal === date) &&
          (!name ||
            String(item.operator || "")
              .toLocaleLowerCase("id-ID")
              .includes(name)),
      )
      .slice()
      .sort(
        (a, b) =>
          String(b.tanggal || "").localeCompare(String(a.tanggal || "")) ||
          String(b.updatedAt || b.createdAt || "").localeCompare(
            String(a.updatedAt || a.createdAt || ""),
          ) ||
          (Number(b.rowNumber) || 0) - (Number(a.rowNumber) || 0),
      );

    const totalPages = Math.max(
      1,
      Math.ceil(allRows.length / CONFIG.PAGE_SIZE),
    );
    state.pages.apdSaved = Math.min(
      Math.max(1, state.pages.apdSaved || 1),
      totalPages,
    );
    const page = state.pages.apdSaved;
    const start = (page - 1) * CONFIG.PAGE_SIZE;
    const rows = allRows.slice(start, start + CONFIG.PAGE_SIZE);

    container.innerHTML = rows.length
      ? rows
          .map((item) =>
            apdRecordHtml(item, "saved", activeEditingId, activeEditingSource),
          )
          .join("")
      : '<div class="apd-saved-empty">Tidak ada riwayat APD yang sesuai dengan filter.</div>';
    syncApdReasonToggles(container);

    const from = allRows.length ? start + 1 : 0;
    const to = Math.min(start + CONFIG.PAGE_SIZE, allRows.length);
    const avg = allRows.length
      ? allRows.reduce((sum, item) => sum + (Number(item.percentage) || 0), 0) /
        allRows.length
      : 0;
    if (summary) {
      summary.textContent = allRows.length
        ? `${from}–${to} dari ${allRows.length} data sesuai filter · Rata-rata APD ${dashboardPercent(avg)}`
        : "Tidak ada data sesuai filter nama dan tanggal.";
    }

    renderPagination(pagination, page, totalPages, (nextPage) => {
      state.pages.apdSaved = nextPage;
      renderApdSavedToday();
    });
  }

  function initApd() {
    const section = el("view-apd");
    const form = el("apdForm");
    if (!section || !form) return;

    const tanggal = el("apdTanggal");
    const operator = el("apdOperator");
    const totalPoints = el("apdTotalPoints");
    const percentage = el("apdPercentage");
    const reason = el("apdReason");
    const reasonWordCount = el("apdReasonWordCount");
    const editingId = el("apdEditingId");
    const errorEl = el("apdError");
    const addBtn = el("apdAddBtn");
    const cancelBtn = el("apdCancelEdit");
    const stamp = el("apdStamp");
    const saveBtn = el("apdSaveBtn");
    const previewBody = el("apdPreviewBody");
    const savedBody = el("apdSavedBody");
    const historyName = el("apdHistoryName");
    const historyDate = el("apdHistoryDate");
    if (historyDate) historyDate.value = todayStr();
    const refreshHistory = () => {
      state.pages.apdSaved = 1;
      renderApdSavedToday();
    };
    historyName?.addEventListener("input", refreshHistory);
    historyDate?.addEventListener("change", refreshHistory);
    el("apdHistoryReset")?.addEventListener("click", () => {
      if (historyName) historyName.value = "";
      if (historyDate) historyDate.value = todayStr();
      refreshHistory();
    });
    const scoreInputs = qsa(".apd-score", form);
    scoreInputs.forEach((input) => {
      const criteria = APD_POINT_CRITERIA[input.dataset.apdKey] || [];
      input.innerHTML = [
        '<option value="" disabled selected>0–3</option>',
        ...criteria.map(
          (description, point) =>
            `<option value="${point}"${description ? "" : " disabled"}>${point}</option>`,
        ),
      ].join("");
    });
    const photoField = el("apdPhotoField");
    const photoInput = el("apdPhotoInput");
    const photoCameraInput = el("apdPhotoCameraInput");
    const photoChooseBtn = el("apdPhotoChooseBtn");
    const photoOptions = el("apdPhotoOptions");
    const photoPreviewBox = el("apdPhotoPreviewBox");
    const photoInfo = el("apdPhotoInfo");
    let pendingPhotoDataUrls = [];
    let currentPhotoFileIds = [];
    let photoChangeToken = 0;

    function renderPhotoPreviews() {
      const photos = [
        ...currentPhotoFileIds.map((id) => ({ id, saved: true })),
        ...pendingPhotoDataUrls.map((url) => ({ url, saved: false })),
      ];
      if (photoPreviewBox) {
        photoPreviewBox.hidden = photos.length === 0;
        photoPreviewBox.innerHTML = photos
          .map(
            (photo, index) =>
              `<div class="apd-photo-thumb"><button type="button" class="apd-photo-thumb-view" data-index="${index}" aria-label="Buka foto ${index + 1}">${photo.url ? `<img src="${photo.url}" alt="Foto bukti ${index + 1}" />` : `<span>Foto ${index + 1}<small>Tersimpan</small></span>`}</button><button type="button" class="apd-photo-remove" data-index="${index}" aria-label="Hapus foto ${index + 1}" title="Hapus foto"><i class="fa-solid fa-trash" aria-hidden="true"></i></button></div>`,
          )
          .join("");
      }
      if (photoInfo)
        photoInfo.textContent = `${photos.length} dari maksimal 3 foto.`;
      if (photoChooseBtn) photoChooseBtn.disabled = photos.length >= 3;
    }

    if (tanggal) tanggal.value = todayStr();

    function scoresFromForm() {
      const scores = {};
      scoreInputs.forEach((input) => {
        scores[input.dataset.apdKey] = Number(input.value);
      });
      return scores;
    }

    function stripApdPointDetails(value) {
      const text = String(value || "").trim();
      const start = text.indexOf(APD_REASON_DETAIL_MARKER);
      if (start < 0) return text;
      const end = text.indexOf(APD_REASON_DETAIL_END_MARKER, start);
      if (end < 0) return text.slice(0, start).trim();
      return `${text.slice(0, start)}${text.slice(
        end + APD_REASON_DETAIL_END_MARKER.length,
      )}`.trim();
    }

    function reasonWithApdPointDetails(value, scores) {
      const manualReason = stripApdPointDetails(value);
      const details = APD_VARIABLES.map((variable) => {
        const point = Number(scores[variable.key]);
        const description = APD_POINT_CRITERIA[variable.key]?.[point];
        return `${variable.label} (${point}): ${description}`;
      });
      return [
        manualReason,
        APD_REASON_DETAIL_MARKER,
        ...details,
        APD_REASON_DETAIL_END_MARKER,
      ]
        .filter(Boolean)
        .join("\n");
    }

    function refreshCalculation() {
      const scores = scoresFromForm();
      const result = calculateApd(scores);
      if (totalPoints)
        totalPoints.value = `${result.totalPoints} / ${APD_MAX_POINTS}`;
      if (percentage) percentage.value = dashboardPercent(result.percentage);
      if (photoField) photoField.hidden = false;
      return result;
    }

    function refreshReasonCounter() {
      if (!reason) return 0;
      const words = countApdWords(reason.value);
      if (reasonWordCount) {
        reasonWordCount.textContent = `${words} / ${APD_REASON_MAX_WORDS} kata`;
        reasonWordCount.classList.toggle("limit", words > APD_REASON_MAX_WORDS);
      }
      reason.setCustomValidity(
        words > APD_REASON_MAX_WORDS
          ? `Alasan maksimal ${APD_REASON_MAX_WORDS} kata.`
          : "",
      );
      return words;
    }

    function resetForm() {
      form.reset();
      photoChangeToken += 1;
      pendingPhotoDataUrls = [];
      currentPhotoFileIds = [];
      renderPhotoPreviews();
      if (tanggal) tanggal.value = todayStr();
      if (editingId) {
        editingId.value = "";
        delete editingId.dataset.source;
      }
      if (totalPoints) totalPoints.value = `0 / ${APD_MAX_POINTS}`;
      if (percentage) percentage.value = "0%";
      if (addBtn) {
        addBtn.innerHTML =
          '<i class="fa-solid fa-file-circle-plus" aria-hidden="true"></i> Tambah';
        addBtn.disabled = false;
      }
      if (cancelBtn) cancelBtn.hidden = false;
      if (stamp) stamp.textContent = "Preview APD";
      if (errorEl) errorEl.hidden = true;
      if (operator) {
        operator.setCustomValidity("");
        operator.classList.remove("is-invalid");
        delete operator.dataset.masterTouched;
      }
      refreshCalculation();
      refreshReasonCounter();
    }

    function loadItemIntoForm(item, source) {
      if (!item) return;
      if (editingId) {
        editingId.value = item.id || "";
        editingId.dataset.source = source;
      }
      if (tanggal) tanggal.value = item.tanggal || todayStr();
      if (operator) operator.value = item.operator || "";
      scoreInputs.forEach((input) => {
        input.value = item.scores?.[input.dataset.apdKey] ?? "";
      });
      if (reason) reason.value = item.alasan || "";
      pendingPhotoDataUrls = [];
      photoChangeToken += 1;
      currentPhotoFileIds = item.photoFileIds?.length
        ? [...item.photoFileIds]
        : item.photoFileId
          ? [item.photoFileId]
          : [];
      if (photoInput) photoInput.value = "";
      if (photoCameraInput) photoCameraInput.value = "";
      renderPhotoPreviews();
      refreshCalculation();
      refreshReasonCounter();
      if (addBtn) addBtn.textContent = "Simpan Perubahan";
      if (cancelBtn) cancelBtn.hidden = false;
      if (stamp)
        stamp.textContent =
          source === "saved" ? "EDIT DATA TERSIMPAN" : "EDIT PREVIEW";
      renderApdPreview();
      renderApdSavedToday();
      form.scrollIntoView({ behavior: "smooth", block: "center" });
    }

    scoreInputs.forEach((input) =>
      input.addEventListener("input", refreshCalculation),
    );
    reason?.addEventListener("input", refreshReasonCounter);
    async function handleApdPhotoChange(input) {
      const file = input.files?.[0];
      if (!file) return;
      if (currentPhotoFileIds.length + pendingPhotoDataUrls.length >= 3) {
        input.value = "";
        return toast("Maksimal 3 foto bukti APD.", true);
      }
      const changeToken = ++photoChangeToken;
      if (photoInfo) photoInfo.textContent = "Mengompres foto...";
      try {
        const compressed = await compressApdPhoto(file);
        if (changeToken !== photoChangeToken) return;
        pendingPhotoDataUrls.push(compressed.dataUrl);
        input.value = "";
        renderPhotoPreviews();
        refreshCalculation();
      } catch (err) {
        if (changeToken !== photoChangeToken) return;
        input.value = "";
        if (photoInfo) photoInfo.textContent = err.message;
      }
    }
    photoPreviewBox?.addEventListener("click", async (event) => {
      const remove = event.target.closest(".apd-photo-remove");
      const view = event.target.closest(".apd-photo-thumb-view");
      const index = Number((remove || view)?.dataset.index);
      if (!Number.isInteger(index)) return;
      if (remove) {
        if (index < currentPhotoFileIds.length)
          currentPhotoFileIds.splice(index, 1);
        else pendingPhotoDataUrls.splice(index - currentPhotoFileIds.length, 1);
        renderPhotoPreviews();
        return;
      }
      if (index < currentPhotoFileIds.length) {
        try {
          const response = await apiGet("apd.photo.preview", {
            photoFileId: currentPhotoFileIds[index],
          });
          showApdPhotoPopup(response.dataUrl);
        } catch (err) {
          toast(err.message, true);
        }
      } else
        showApdPhotoPopup(
          pendingPhotoDataUrls[index - currentPhotoFileIds.length],
        );
    });
    photoInput?.addEventListener("change", () =>
      handleApdPhotoChange(photoInput),
    );
    photoCameraInput?.addEventListener("change", () =>
      handleApdPhotoChange(photoCameraInput),
    );
    function closePhotoOptions() {
      if (photoOptions) photoOptions.hidden = true;
      photoChooseBtn?.setAttribute("aria-expanded", "false");
    }
    photoChooseBtn?.addEventListener("click", () => {
      if (!photoOptions) return;
      photoOptions.hidden = !photoOptions.hidden;
      photoChooseBtn.setAttribute(
        "aria-expanded",
        String(!photoOptions.hidden),
      );
    });
    el("apdPhotoCameraBtn")?.addEventListener("click", () => {
      closePhotoOptions();
      if (currentPhotoFileIds.length + pendingPhotoDataUrls.length >= 3)
        return toast("Maksimal 3 foto bukti APD.", true);
      if (photoCameraInput) photoCameraInput.value = "";
      photoCameraInput?.click();
    });
    el("apdPhotoStorageBtn")?.addEventListener("click", () => {
      closePhotoOptions();
      if (currentPhotoFileIds.length + pendingPhotoDataUrls.length >= 3)
        return toast("Maksimal 3 foto bukti APD.", true);
      if (photoInput) photoInput.value = "";
      photoInput?.click();
    });
    document.addEventListener("click", (event) => {
      if (!event.target.closest(".apd-photo-picker")) closePhotoOptions();
    });
    cancelBtn?.addEventListener("click", () => {
      resetForm();
      renderApdPreview();
      renderApdSavedToday();
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (addBtn?.disabled) return;
      if (errorEl) errorEl.hidden = true;

      if (!canLevel("apd", "write")) {
        if (errorEl) {
          errorEl.textContent = "Anda tidak memiliki akses APD.";
          errorEl.hidden = false;
        }
        return;
      }

      if (!validateMasterInput(operator)) {
        if (errorEl) {
          errorEl.textContent = "Nama operator harus dipilih dari data master.";
          errorEl.hidden = false;
        }
        operator?.reportValidity();
        return;
      }

      const invalidScore = scoreInputs.find((input) => {
        const text = String(input.value || "").trim();
        const value = Number(text);
        const criteria = APD_POINT_CRITERIA[input.dataset.apdKey] || [];
        return (
          text === "" ||
          !Number.isInteger(value) ||
          value < 0 ||
          value > APD_MAX_POINT ||
          !criteria[value]
        );
      });
      if (invalidScore) {
        if (errorEl) {
          errorEl.textContent =
            "Semua variable APD wajib diisi dengan poin 0 sampai 3 yang tersedia.";
          errorEl.hidden = false;
        }
        invalidScore.focus();
        return;
      }

      const scores = scoresFromForm();
      const completedReason = reasonWithApdPointDetails(reason?.value, scores);
      if (reason) reason.value = completedReason;
      const reasonWords = refreshReasonCounter();
      if (reasonWords > APD_REASON_MAX_WORDS) {
        if (errorEl) {
          errorEl.textContent = `Alasan / keterangan maksimal ${APD_REASON_MAX_WORDS} kata. Saat ini ${reasonWords} kata.`;
          errorEl.hidden = false;
        }
        reason?.focus();
        return;
      }

      const canonicalOperator = canonicalMasterValue(
        "operator",
        operator.value,
      );
      const result = calculateApd(scores);
      const id = editingId?.value || "";
      const source = editingId?.dataset.source || "";
      const previousPreviewPhotoIds =
        source === "preview"
          ? (state.preview.apd || []).find((row) => row.id === id)
              ?.photoFileIds || []
          : [];
      const formDate = tanggal?.value || todayStr();

      const duplicatePreview = (state.preview.apd || []).find(
        (item) =>
          !(source === "preview" && item.id === id) &&
          item.tanggal === formDate &&
          String(item.operator || "").toLowerCase() ===
            canonicalOperator.toLowerCase(),
      );
      if (duplicatePreview) {
        toast(
          "Operator ini sudah ada di preview APD pada tanggal yang sama. Gunakan tombol Edit pada baris preview tersebut.",
          true,
        );
        return;
      }

      const duplicateSaved = (state.apdEntries || []).find(
        (item) =>
          !(source === "saved" && item.id === id) &&
          item.tanggal === formDate &&
          String(item.operator || "").toLowerCase() ===
            canonicalOperator.toLowerCase(),
      );
      if (duplicateSaved) {
        toast(
          "Operator ini sudah memiliki data APD tersimpan pada tanggal yang sama. Gunakan tombol Edit pada data tersimpan.",
          true,
        );
        return;
      }

      const payload = {
        tanggal: formDate,
        operator: canonicalOperator,
        scores: { ...scores },
        alasan: completedReason,
      };

      if (pendingPhotoDataUrls.length) {
        if (addBtn) addBtn.disabled = true;
        try {
          while (pendingPhotoDataUrls.length) {
            const uploaded = await apiPost("apd.photo.upload", {
              dataUrl: pendingPhotoDataUrls[0],
            });
            currentPhotoFileIds.push(uploaded.photoFileId);
            pendingPhotoDataUrls.shift();
          }
          if (photoInfo)
            photoInfo.textContent = `${currentPhotoFileIds.length} foto bukti berhasil diunggah.`;
        } catch (err) {
          if (errorEl) {
            const missingDriveAccess =
              /DriveApp|googleapis\.com\/auth\/drive|izin.*Drive/i.test(
                String(err.message || ""),
              );
            errorEl.textContent = missingDriveAccess
              ? "Gagal mengunggah foto: izin Google Drive pada Apps Script belum diberikan. Minta pemilik deployment menjalankan authorizeApdPhotoStorage() dari editor Apps Script, lalu menerapkan versi baru."
              : `Gagal mengunggah foto: ${err.message}`;
            errorEl.hidden = false;
          }
          if (addBtn) addBtn.disabled = false;
          return;
        }
      }
      payload.photoFileIds = [...currentPhotoFileIds];

      // Edit data yang SUDAH tersimpan selalu menggunakan endpoint update.
      // Baris lama dioverwrite berdasarkan ID yang sama sehingga tidak append/duplikat.
      if (id && source === "saved") {
        if (addBtn) addBtn.disabled = true;
        try {
          const response = await enqueueWrite(() =>
            apiPost("apd.update", { id, data: payload }),
          );
          if (response.entry) {
            const updatedId = String(response.entry.id);
            state.apdEntries = state.apdEntries.map((row) =>
              String(row.id) === updatedId ? response.entry : row,
            );
          }
          state.pages.apdSaved = 1;
          resetForm();
          renderApdPreview();
          renderApdSavedToday();
          refreshKpiAfterApdChange();
          toast(
            "Data APD tersimpan berhasil diperbarui tanpa membuat duplikat.",
          );
        } catch (err) {
          if (errorEl) {
            errorEl.textContent = err.message;
            errorEl.hidden = false;
          }
          if (addBtn) addBtn.disabled = false;
        }
        return;
      }

      const item = {
        id: id || makeClientRequestId(),
        tanggal: payload.tanggal,
        operator: payload.operator,
        scores: payload.scores,
        totalPoints: result.totalPoints,
        percentage: result.percentage,
        alasan: payload.alasan,
        photoFileIds: payload.photoFileIds,
        photoFileId: payload.photoFileIds[0] || "",
        createdAt: id
          ? (state.preview.apd || []).find((row) => row.id === id)?.createdAt ||
            nowIso()
          : nowIso(),
      };

      if (id && source === "preview") {
        const index = state.preview.apd.findIndex((row) => row.id === id);
        if (index >= 0) state.preview.apd[index] = item;
        previousPreviewPhotoIds
          .filter((photoId) => !item.photoFileIds.includes(photoId))
          .forEach((photoFileId) =>
            apiPost("apd.photo.discard", { photoFileId }).catch(() => {}),
          );
        toast("Data APD di preview berhasil diperbarui.");
      } else {
        state.preview.apd.push(item);
        toast(
          "Data APD ditambahkan ke preview. Belum disimpan ke Spreadsheet.",
        );
      }

      state.pages.apd = 1;
      persistPreview();
      resetForm();
      renderApdPreview();
      renderApdSavedToday();
    });

    previewBody?.addEventListener("click", (event) => {
      const reasonToggle = event.target.closest(".apd-reason-toggle");
      const viewBtn = event.target.closest(".apd-photo-view");
      const editBtn = event.target.closest(".apd-edit");
      const deleteBtn = event.target.closest(".apd-delete");

      if (reasonToggle) {
        const reasonCell = reasonToggle.closest(".apd-record-reason");
        const expanded = reasonCell?.classList.toggle("is-expanded") || false;
        reasonToggle.setAttribute("aria-expanded", String(expanded));
        reasonToggle.textContent = expanded
          ? "Lebih sedikit"
          : "Tampilkan selengkapnya";
        return;
      }

      if (viewBtn) {
        const item = (state.preview.apd || []).find(
          (row) => row.id === viewBtn.dataset.id,
        );
        if (item)
          viewApdPhoto(item, "preview").catch((err) =>
            toast(err.message, true),
          );
        return;
      }

      if (editBtn) {
        const item = (state.preview.apd || []).find(
          (row) => row.id === editBtn.dataset.id,
        );
        if (!item) return;
        loadItemIntoForm(item, "preview");
        return;
      }

      if (deleteBtn) {
        const removed = (state.preview.apd || []).find(
          (row) => row.id === deleteBtn.dataset.id,
        );
        state.preview.apd = (state.preview.apd || []).filter(
          (row) => row.id !== deleteBtn.dataset.id,
        );
        state.pages.apd = 1;
        persistPreview();
        if (
          editingId?.value === deleteBtn.dataset.id &&
          editingId.dataset.source === "preview"
        )
          resetForm();
        renderApdPreview();
        renderApdSavedToday();
        (
          removed?.photoFileIds ||
          (removed?.photoFileId ? [removed.photoFileId] : [])
        ).forEach((photoFileId) =>
          apiPost("apd.photo.discard", { photoFileId }).catch(() => {}),
        );
        toast("Data APD dihapus dari preview.");
      }
    });

    savedBody?.addEventListener("click", async (event) => {
      const reasonToggle = event.target.closest(".apd-reason-toggle");
      const viewBtn = event.target.closest(".apd-photo-view");
      const editBtn = event.target.closest(".apd-saved-edit");
      const deleteBtn = event.target.closest(".apd-saved-delete");

      if (reasonToggle) {
        const reasonCell = reasonToggle.closest(".apd-record-reason");
        const expanded = reasonCell?.classList.toggle("is-expanded") || false;
        reasonToggle.setAttribute("aria-expanded", String(expanded));
        reasonToggle.textContent = expanded
          ? "Lebih sedikit"
          : "Tampilkan selengkapnya";
        return;
      }

      if (viewBtn) {
        const item = (state.apdEntries || []).find(
          (row) => row.id === viewBtn.dataset.id,
        );
        if (item)
          viewApdPhoto(item, "saved").catch((err) => toast(err.message, true));
        return;
      }

      if (editBtn) {
        const item = (state.apdEntries || []).find(
          (row) => row.id === editBtn.dataset.id,
        );
        if (!item)
          return toast(
            "Data APD tersimpan tidak ditemukan. Muat ulang halaman.",
            true,
          );
        loadItemIntoForm(item, "saved");
        return;
      }

      if (deleteBtn) {
        if (!canLevel("apd", "write"))
          return toast("Anda tidak memiliki akses APD.", true);
        const item = (state.apdEntries || []).find(
          (row) => row.id === deleteBtn.dataset.id,
        );
        if (!item)
          return toast(
            "Data APD tersimpan tidak ditemukan. Muat ulang halaman.",
            true,
          );
        if (
          !(await confirmDelete({
            title: "Hapus data APD?",
            message: "Data pemeriksaan APD ini akan dihapus permanen.",
            item: `${item.operator} • ${item.tanggal}`,
          }))
        )
          return;

        deleteBtn.disabled = true;
        try {
          const response = await enqueueWrite(() =>
            apiPost("apd.delete", { id: item.id }),
          );
          if (Array.isArray(response.apdEntries))
            state.apdEntries = response.apdEntries;
          else
            state.apdEntries = (state.apdEntries || []).filter(
              (row) => row.id !== item.id,
            );
          state.pages.apdSaved = 1;
          if (
            editingId?.value === item.id &&
            editingId.dataset.source === "saved"
          )
            resetForm();
          renderApdPreview();
          renderApdSavedToday();
          refreshKpiAfterApdChange();
          toast("Data APD tersimpan berhasil dihapus.");
        } catch (err) {
          deleteBtn.disabled = false;
          toast(`Gagal menghapus data APD: ${err.message}`, true);
        }
      }
    });

    saveBtn?.addEventListener("click", async () => {
      const rows = [...(state.preview.apd || [])];
      if (!rows.length) return toast("Belum ada data APD di preview.", true);
      if (!canLevel("apd", "write"))
        return toast("Anda tidak memiliki akses APD.", true);

      saveBtn.disabled = true;
      saveBtn.textContent = `Menyimpan ${rows.length} data...`;
      try {
        const payload = rows.map((item) => ({
          tanggal: item.tanggal,
          operator: item.operator,
          scores: { kebersihanSepatu: 0, ...item.scores },
          alasan: item.alasan || "",
          photoFileIds:
            item.photoFileIds || (item.photoFileId ? [item.photoFileId] : []),
          clientRequestId: item.id,
        }));
        const response = await enqueueWrite(() =>
          apiPost("apd.batchCreate", { data: payload }),
        );
        const savedIds = new Set(
          Array.isArray(response.savedIds)
            ? response.savedIds
            : rows.map((item) => item.id),
        );
        state.preview.apd = (state.preview.apd || []).filter(
          (item) => !savedIds.has(item.id),
        );
        if (Array.isArray(response.entries)) {
          const newIds = new Set(
            response.entries.map((item) => String(item.id)),
          );
          state.apdEntries = state.apdEntries
            .filter((item) => !newIds.has(String(item.id)))
            .concat(response.entries);
        }
        state.pages.apd = 1;
        state.pages.apdSaved = 1;
        persistPreview();
        renderApdPreview();
        renderApdSavedToday();
        refreshKpiAfterApdChange();
        toast(
          `${Number(response.savedCount) || rows.length} data APD berhasil disimpan ke sheet APD.`,
        );
      } catch (err) {
        renderApdPreview();
        renderApdSavedToday();
        toast(`Gagal menyimpan APD: ${err.message}`, true);
      }
    });

    refreshCalculation();
    refreshReasonCounter();
    renderApdPreview();
    renderApdSavedToday();
  }

  /* ------------------------- DASHBOARD ------------------------- */
  function dashboardEntries() {
    const saved = (state.entries || []).filter(
      (entry) => entry && entry._syncState !== "error",
    );
    const preview = [
      ...((state.preview && state.preview.filling) || []),
      ...((state.preview && state.preview.press) || []),
    ];
    return [...saved, ...preview];
  }

  function dashboardQty(value) {
    return (Number(value) || 0).toLocaleString("id-ID");
  }

  function dashboardDateParts(dateStr) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ""));
    if (!match) return null;
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  }

  function dashboardDateKey(date) {
    const p = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
  }

  function dashboardShortDate(dateStr) {
    const date = dashboardDateParts(dateStr);
    if (!date) return String(dateStr || "—");
    return date.toLocaleDateString("id-ID", { day: "2-digit", month: "short" });
  }

  function dashboardAgeDays(dateStr) {
    const date = dashboardDateParts(dateStr);
    const today = dashboardDateParts(todayStr());
    if (!date || !today) return 0;
    return Math.max(
      0,
      Math.floor((today.getTime() - date.getTime()) / 86400000),
    );
  }

  function dashboardSetText(id, value) {
    const node = el(id);
    if (node) node.textContent = value;
  }

  function dashboardPriorityLevel(row) {
    const age = dashboardAgeDays(row.tanggalAsal);
    if (age >= 2) return { key: "critical", label: "Kritis" };
    if (age >= 1) return { key: "warning", label: "Peringatan" };
    return { key: "normal", label: "Hari ini" };
  }

  /* =========================================================
   DASHBOARD CHART FILTER
   ========================================================= */

  function dashboardAddDays(date, amount) {
    return new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate() + amount,
    );
  }

  function dashboardMonthKey(date) {
    const month = String(date.getMonth() + 1).padStart(2, "0");

    return `${date.getFullYear()}-${month}`;
  }

  function dashboardDaysBetween(start, end) {
    const diff = end.getTime() - start.getTime();

    return Math.floor(diff / 86400000) + 1;
  }

  function dashboardChartConfig() {
    const today = dashboardDateParts(todayStr()) || new Date();

    const mode = state.dashboard?.chartMode || "7days";

    /* =============================
      7 HARI TERAKHIR
      ============================= */
    if (mode === "7days") {
      return {
        mode,
        groupBy: "day",

        start: dashboardAddDays(today, -6),
        end: today,

        label: "7 Hari Terakhir",
      };
    }

    /* =============================
      30 HARI TERAKHIR
      ============================= */
    if (mode === "30days") {
      return {
        mode,
        groupBy: "day",

        start: dashboardAddDays(today, -29),
        end: today,

        label: "30 Hari Terakhir",
      };
    }

    /* =============================
      BERDASARKAN BULAN
      ============================= */
    if (mode === "month") {
      let monthValue = state.dashboard.chartMonth;

      if (!monthValue) {
        monthValue = dashboardMonthKey(today);
      }

      const parts = monthValue.split("-");

      const year = Number(parts[0]);
      const month = Number(parts[1]) - 1;

      const start = new Date(year, month, 1);

      const end = new Date(year, month + 1, 0);

      const label = start.toLocaleDateString("id-ID", {
        month: "long",
        year: "numeric",
      });

      return {
        mode,
        groupBy: "day",
        start,
        end,
        label,
      };
    }

    /* =============================
      BERDASARKAN TAHUN
      ============================= */
    if (mode === "year") {
      const year = Number(state.dashboard.chartYear) || today.getFullYear();

      return {
        mode,
        groupBy: "month",

        start: new Date(year, 0, 1),
        end: new Date(year, 11, 31),

        label: `Tahun ${year}`,
      };
    }

    /* =============================
      RENTANG TANGGAL
      ============================= */
    if (mode === "range") {
      let start = dashboardDateParts(state.dashboard.chartStart);

      let end = dashboardDateParts(state.dashboard.chartEnd);

      if (!start) {
        start = dashboardAddDays(today, -6);
      }

      if (!end) {
        end = today;
      }

      /*
        Jika user secara tidak sengaja
        memilih tanggal akhir lebih kecil
        dari tanggal awal, otomatis dibalik.
      */
      if (start > end) {
        const temp = start;
        start = end;
        end = temp;
      }

      const totalDays = dashboardDaysBetween(start, end);

      /*
        Jika rentang <= 62 hari
        tampilkan per hari.

        Jika > 62 hari
        otomatis agregasi per bulan
        supaya chart tidak berisi
        ratusan batang.
      */
      const groupBy = totalDays <= 62 ? "day" : "month";

      const startLabel = start.toLocaleDateString("id-ID", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      });

      const endLabel = end.toLocaleDateString("id-ID", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      });

      return {
        mode,
        groupBy,
        start,
        end,
        label: `${startLabel} – ${endLabel}`,
      };
    }

    return {
      mode: "7days",
      groupBy: "day",
      start: dashboardAddDays(today, -6),
      end: today,
      label: "7 Hari Terakhir",
    };
  }

  /* =========================================================
    BUAT DATA CHART PER HARI
    ========================================================= */

  function dashboardDailyBuckets(entries, start, end) {
    const buckets = [];

    for (
      let date = new Date(start);
      date <= end;
      date = dashboardAddDays(date, 1)
    ) {
      const key = dashboardDateKey(date);

      const filling = entries
        .filter((entry) => entry.tab === "filling" && entry.tanggal === key)
        .reduce((sum, entry) => sum + (Number(entry.totalQty) || 0), 0);

      const press = entries
        .filter((entry) => entry.tab === "press" && entry.tanggal === key)
        .reduce((sum, entry) => sum + (Number(entry.totalQty) || 0), 0);

      buckets.push({
        key,

        date: new Date(date),

        label: date.toLocaleDateString("id-ID", {
          day: "2-digit",
          month: "short",
        }),

        filling,
        press,
      });
    }

    return buckets;
  }

  /* =========================================================
    BUAT DATA CHART PER BULAN
    ========================================================= */

  function dashboardMonthlyBuckets(entries, start, end) {
    const buckets = [];

    let current = new Date(start.getFullYear(), start.getMonth(), 1);

    const last = new Date(end.getFullYear(), end.getMonth(), 1);

    while (current <= last) {
      const key = dashboardMonthKey(current);

      /*
        Tetap filter berdasarkan start-end asli.

        Jadi misalnya:
        15 Januari sampai 20 Maret,

        data tanggal 1-14 Januari
        tidak ikut dihitung.
      */
      const periodEntries = entries.filter((entry) => {
        const date = dashboardDateParts(entry.tanggal);

        if (!date) return false;

        return date >= start && date <= end && dashboardMonthKey(date) === key;
      });

      const filling = periodEntries
        .filter((entry) => entry.tab === "filling")
        .reduce((sum, entry) => sum + (Number(entry.totalQty) || 0), 0);

      const press = periodEntries
        .filter((entry) => entry.tab === "press")
        .reduce((sum, entry) => sum + (Number(entry.totalQty) || 0), 0);

      buckets.push({
        key,

        date: new Date(current),

        label: current.toLocaleDateString("id-ID", {
          month: "short",
          year:
            start.getFullYear() !== end.getFullYear() ? "2-digit" : undefined,
        }),

        filling,
        press,
      });

      current = new Date(current.getFullYear(), current.getMonth() + 1, 1);
    }

    return buckets;
  }

  /* =========================================================
    RENDER CHART
    ========================================================= */

  function renderDashboardWeekly(entries) {
    const chart = el("dashboardWeeklyChart");

    if (!chart) return;

    const config = dashboardChartConfig();

    /*
      Ubah tulisan eyebrow secara otomatis
      mengikuti filter.
    */
    dashboardSetText("dashboardChartPeriodLabel", config.label);

    const buckets =
      config.groupBy === "month"
        ? dashboardMonthlyBuckets(entries, config.start, config.end)
        : dashboardDailyBuckets(entries, config.start, config.end);

    const maxValue = Math.max(
      1,
      ...buckets.flatMap((item) => [item.filling, item.press]),
    );

    chart.innerHTML = buckets
      .map((item) => {
        const fillingHeight =
          item.filling > 0 ? Math.max(5, (item.filling / maxValue) * 100) : 0;

        const pressHeight =
          item.press > 0 ? Math.max(5, (item.press / maxValue) * 100) : 0;

        return `
          <div class="dashboard-day-group">

            <div class="dashboard-bar-area">

              <div
                class="dashboard-vbar filling"
                style="height:${fillingHeight}%"
                title="Filling ${dashboardQty(item.filling)} pcs"
              >
                <span>
                  ${item.filling ? dashboardQty(item.filling) : "0"}
                </span>
              </div>


              <div
                class="dashboard-vbar press"
                style="height:${pressHeight}%"
                title="Press ${dashboardQty(item.press)} pcs"
              >
                <span>
                  ${item.press ? dashboardQty(item.press) : "0"}
                </span>
              </div>

            </div>

            <strong>
              ${esc(item.label)}
            </strong>

          </div>
        `;
      })
      .join("");
  }
  // function renderDashboardWeekly(entries) {
  //   const chart = el("dashboardWeeklyChart");
  //   if (!chart) return;

  //   const today = dashboardDateParts(todayStr()) || new Date();
  //   const days = [];
  //   for (let offset = 6; offset >= 0; offset--) {
  //     const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset);
  //     const key = dashboardDateKey(date);
  //     const filling = entries
  //       .filter(entry => entry.tab === "filling" && entry.tanggal === key)
  //       .reduce((sum, entry) => sum + (Number(entry.totalQty) || 0), 0);
  //     const press = entries
  //       .filter(entry => entry.tab === "press" && entry.tanggal === key)
  //       .reduce((sum, entry) => sum + (Number(entry.totalQty) || 0), 0);
  //     days.push({ key, date, filling, press });
  //   }

  //   const maxValue = Math.max(1, ...days.flatMap(day => [day.filling, day.press]));
  //   chart.innerHTML = days.map(day => {
  //     const fillingHeight = day.filling > 0 ? Math.max(5, (day.filling / maxValue) * 100) : 0;
  //     const pressHeight = day.press > 0 ? Math.max(5, (day.press / maxValue) * 100) : 0;
  //     const label = day.date.toLocaleDateString("id-ID", { day: "2-digit", month: "short" });
  //     return `
  //       <div class="dashboard-day-group">
  //         <div class="dashboard-bar-area">
  //           <div class="dashboard-vbar filling" style="height:${fillingHeight}%" title="Filling ${dashboardQty(day.filling)} pcs">
  //             <span>${day.filling ? dashboardQty(day.filling) : "0"}</span>
  //           </div>
  //           <div class="dashboard-vbar press" style="height:${pressHeight}%" title="Press ${dashboardQty(day.press)} pcs">
  //             <span>${day.press ? dashboardQty(day.press) : "0"}</span>
  //           </div>
  //         </div>
  //         <strong>${esc(label)}</strong>
  //       </div>`;
  //   }).join("");
  // }
  function updateDashboardChartFilterUI() {
    const mode = state.dashboard.chartMode || "7days";
    const monthWrap = el("dashboardChartMonthWrap");
    const yearWrap = el("dashboardChartYearWrap");
    const startWrap = el("dashboardChartStartWrap");
    const endWrap = el("dashboardChartEndWrap");

    if (monthWrap) {
      monthWrap.hidden = mode !== "month";
    }
    if (yearWrap) {
      yearWrap.hidden = mode !== "year";
    }
    const showRange = mode === "range";
    if (startWrap) {
      startWrap.hidden = !showRange;
    }
    if (endWrap) {
      endWrap.hidden = !showRange;
    }
  }

  function renderDashboardAlerts(balanceRows, brokenToday) {
    const wrap = el("dashboardAlerts");
    if (!wrap) return;

    const alerts = [];
    const sorted = balanceRows
      .slice()
      .sort(
        (a, b) =>
          dashboardAgeDays(b.tanggalAsal) - dashboardAgeDays(a.tanggalAsal) ||
          (Number(b.remaining) || 0) - (Number(a.remaining) || 0),
      );

    sorted
      .filter((row) => dashboardAgeDays(row.tanggalAsal) >= 2)
      .slice(0, 2)
      .forEach((row) => {
        alerts.push({
          type: "critical",
          label: "KRITIS",
          text: `${row.produk} — sisa Press ${dashboardQty(row.remaining)} pcs sejak ${dashboardShortDate(row.tanggalAsal)}`,
        });
      });

    if (alerts.length < 3) {
      sorted
        .filter((row) => dashboardAgeDays(row.tanggalAsal) === 1)
        .slice(0, 3 - alerts.length)
        .forEach((row) => {
          alerts.push({
            type: "warning",
            label: "PERINGATAN",
            text: `${row.produk} — sisa Press ${dashboardQty(row.remaining)} pcs sejak kemarin`,
          });
        });
    }

    if (brokenToday > 0 && alerts.length < 4) {
      alerts.push({
        type: "attention",
        label: "PERHATIAN",
        text: `Botol pecah Press hari ini: ${dashboardQty(brokenToday)} pcs`,
      });
    }

    if (balanceRows.length > 0 && alerts.length < 4) {
      alerts.push({
        type: "attention",
        label: "PERHATIAN",
        text: `${balanceRows.length} kombinasi Produk + Botol masih menunggu Press`,
      });
    }

    const activeAlerts = alerts.slice(0, 4);
    dashboardSetText("dashboardAlertCount", `${activeAlerts.length} alert`);

    if (!activeAlerts.length) {
      wrap.innerHTML = `
        <div class="dashboard-alert ok">
          <span class="dashboard-alert-icon">✓</span>
          <span class="dashboard-alert-text">Tidak ada alert produksi yang perlu ditindaklanjuti.</span>
          <span class="dashboard-alert-tag">AMAN</span>
        </div>`;
      return;
    }

    wrap.innerHTML = activeAlerts
      .map(
        (item) => `
      <div class="dashboard-alert ${item.type}">
        <span class="dashboard-alert-icon">${item.type === "critical" ? "!" : item.type === "warning" ? "!" : "•"}</span>
        <span class="dashboard-alert-text">${esc(item.text)}</span>
        <span class="dashboard-alert-tag">${item.label}</span>
      </div>`,
      )
      .join("");
  }

  function renderDashboardPriority(balanceRows) {
    const tbody = el("dashboardPriorityBody");
    const pagination = el("dashboardPriorityPagination");
    const summary = el("dashboardPrioritySummary");

    if (!tbody) return;
    /* =====================================
      URUTKAN FIFO / UMUR
      Logic lama tetap dipertahankan
      ===================================== */
    const allRows = balanceRows
      .slice()
      .sort(
        (a, b) =>
          dashboardAgeDays(b.tanggalAsal) - dashboardAgeDays(a.tanggalAsal) ||
          String(a.tanggalAsal || "").localeCompare(
            String(b.tanggalAsal || ""),
          ) ||
          (Number(b.remaining) || 0) - (Number(a.remaining) || 0),
      );
    /* =====================================
      PAGINATION
      ===================================== */
    const pageSize = CONFIG.DASHBOARD_PRIORITY_PAGE_SIZE;
    const totalPages = Math.max(1, Math.ceil(allRows.length / pageSize));
    state.dashboard.priorityPage = Math.min(
      Math.max(1, state.dashboard.priorityPage || 1),
      totalPages,
    );
    const page = state.dashboard.priorityPage;
    const start = (page - 1) * pageSize;
    const rows = allRows.slice(start, start + pageSize);
    /* =====================================
      DATA KOSONG
      ===================================== */
    if (!allRows.length) {
      tbody.innerHTML = `
        <tr>
          <td colspan="9" class="empty-row">
            Tidak ada sisa Filling yang menunggu Press.
          </td>
        </tr>
      `;
      if (summary) {
        summary.textContent = "0 data prioritas";
      }
      if (pagination) {
        pagination.innerHTML = "";
      }
      return;
    }
    /* =====================================
      RENDER ROW
      ===================================== */
    tbody.innerHTML = rows
      .map((row) => {
        const level = dashboardPriorityLevel(row);
        const age = dashboardAgeDays(row.tanggalAsal);
        const canUse =
          canLevel("press", "write") &&
          isMasterValue("produk", row.produk) &&
          isMasterValue("botol", row.botol);
        const actionTitle = !canLevel("press", "write")
          ? "Anda tidak memiliki akses Press."
          : !isMasterValue("produk", row.produk) ||
              !isMasterValue("botol", row.botol)
            ? "Produk/Botol historis tidak tersedia di Master."
            : "Buka form Press dengan produk ini.";
        return `
          <tr>
            <td>
              <span class="dashboard-priority-dot ${level.key}"title="${esc(level.label)}"></span>
            </td>
            <td>
              <strong>${esc(dashboardShortDate(row.tanggalAsal))}</strong>
            </td>
            <td>${esc(row.produk)}</td>
            <td>${esc(row.botol || "—")}</td>
            <td>${dashboardQty(row.qtyFilling)}</td>
            <td>${dashboardQty(row.qtyPressTerpakai)}</td>
            <td>
              <strong class="dashboard-sisa-value">${dashboardQty(row.remaining)}</strong>
            </td>
            <td>
              <span class="dashboard-age ${level.key}">
                ${age === 0 ? "Hari ini" : `${age} hari`}
              </span>
            </td>
            <td>
              <button type="button" class="btn btn-primary 
                dashboard-work-btn" data-produk="${esc(row.produk)}"
                data-botol="${esc(row.botol)}" ${canUse ? "" : "disabled"}
                title="${esc(actionTitle)}">
                Kerjakan ›
              </button>
            </td>
          </tr>
        `;
      })
      .join("");
    /* =====================================
      SUMMARY
      ===================================== */
    const from = start + 1;
    const to = Math.min(start + pageSize, allRows.length);
    if (summary) {
      summary.textContent = `${from}–${to} dari ${allRows.length} prioritas pengerjaan`;
    }
    /* =====================================
      TOMBOL PAGINATION
      ===================================== */
    renderPagination(pagination, page, totalPages, (nextPage) => {
      state.dashboard.priorityPage = nextPage;
      renderDashboardPriority(balanceRows);
      document
        .querySelector(".dashboard-priority-panel")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }
  // function renderDashboardPriority(balanceRows) {
  //   const tbody = el("dashboardPriorityBody");
  //   if (!tbody) return;

  //   const rows = balanceRows.slice().sort((a, b) =>
  //     dashboardAgeDays(b.tanggalAsal) - dashboardAgeDays(a.tanggalAsal) ||
  //     String(a.tanggalAsal || "").localeCompare(String(b.tanggalAsal || "")) ||
  //     (Number(b.remaining) || 0) - (Number(a.remaining) || 0)
  //   ).slice(0, 6);

  //   if (!rows.length) {
  //     tbody.innerHTML = '<tr><td colspan="9" class="empty-row">Tidak ada sisa Filling yang menunggu Press.</td></tr>';
  //     return;
  //   }

  //   tbody.innerHTML = rows.map(row => {
  //     const level = dashboardPriorityLevel(row);
  //     const age = dashboardAgeDays(row.tanggalAsal);
  //     const canUse = can("accessPress") && isMasterValue("produk", row.produk) && isMasterValue("botol", row.botol);
  //     const actionTitle = !can("accessPress")
  //       ? "Anda tidak memiliki akses Press."
  //       : !isMasterValue("produk", row.produk) || !isMasterValue("botol", row.botol)
  //         ? "Produk/Botol historis tidak tersedia di Master."
  //         : "Buka form Press dengan produk ini.";
  //     return `
  //       <tr>
  //         <td><span class="dashboard-priority-dot ${level.key}" title="${esc(level.label)}"></span></td>
  //         <td><strong>${esc(dashboardShortDate(row.tanggalAsal))}</strong></td>
  //         <td>${esc(row.produk)}</td>
  //         <td>${esc(row.botol || "—")}</td>
  //         <td>${dashboardQty(row.qtyFilling)}</td>
  //         <td>${dashboardQty(row.qtyPressTerpakai)}</td>
  //         <td><strong class="dashboard-sisa-value">${dashboardQty(row.remaining)}</strong></td>
  //         <td><span class="dashboard-age ${level.key}">${age === 0 ? "Hari ini" : `${age} hari`}</span></td>
  //         <td><button type="button" class="btn btn-primary dashboard-work-btn" data-produk="${esc(row.produk)}" data-botol="${esc(row.botol)}" ${canUse ? "" : "disabled"} title="${esc(actionTitle)}">Kerjakan ›</button></td>
  //       </tr>`;
  //   }).join("");
  // }

  function renderDashboardRemaining(balanceRows) {
    const wrap = el("dashboardRemainingBars");
    if (!wrap) return;

    const grouped = new Map();
    balanceRows.forEach((row) => {
      const key = String(row.produk || "").trim() || "Tanpa Produk";
      grouped.set(key, (grouped.get(key) || 0) + (Number(row.remaining) || 0));
    });

    const rows = Array.from(grouped.entries())
      .map(([produk, remaining]) => ({ produk, remaining }))
      .sort((a, b) => b.remaining - a.remaining)
      .slice(0, 10);

    if (!rows.length) {
      wrap.innerHTML =
        '<div class="dashboard-empty-state">Tidak ada sisa Press.</div>';
      return;
    }

    const max = Math.max(1, ...rows.map((row) => row.remaining));
    wrap.innerHTML = rows
      .map(
        (row) => `
      <div class="dashboard-hbar-row">
        <span class="dashboard-hbar-label" title="${esc(row.produk)}">${esc(row.produk)}</span>
        <span class="dashboard-hbar-track"><i style="width:${Math.max(3, (row.remaining / max) * 100)}%"></i></span>
        <strong>${dashboardQty(row.remaining)}</strong>
      </div>`,
      )
      .join("");
  }

  function dashboardPercent(value, maxFractionDigits = 2) {
    const number = Number(value) || 0;
    return `${number.toLocaleString("id-ID", {
      minimumFractionDigits: 0,
      maximumFractionDigits: maxFractionDigits,
    })}%`;
  }

  function dashboardPressKpiPeriod() {
    const today = dashboardDateParts(todayStr()) || new Date();
    const selectedMode = state.dashboard.pressKpiMode || "month";
    const mode = ["month", "year", "range"].includes(selectedMode)
      ? selectedMode
      : "month";

    if (mode === "month") {
      const value = state.dashboard.pressKpiMonth || dashboardMonthKey(today);
      const [year, month] = value.split("-").map(Number);
      const start = new Date(year, month - 1, 1);
      const end = new Date(year, month, 0);
      return {
        mode,
        start,
        end,
        label: start.toLocaleDateString("id-ID", {
          month: "long",
          year: "numeric",
        }),
      };
    }

    if (mode === "year") {
      const year = Number(state.dashboard.pressKpiYear) || today.getFullYear();
      return {
        mode,
        start: new Date(year, 0, 1),
        end: new Date(year, 11, 31),
        label: `Tahun ${year}`,
      };
    }

    if (mode === "range") {
      let start =
        dashboardDateParts(state.dashboard.pressKpiStart) ||
        dashboardAddDays(today, -6);
      let end = dashboardDateParts(state.dashboard.pressKpiEnd) || today;
      if (start > end) [start, end] = [end, start];
      return {
        mode,
        start,
        end,
        label: `${start.toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" })} – ${end.toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" })}`,
      };
    }

    const start = new Date(today.getFullYear(), today.getMonth(), 1);
    return {
      mode: "month",
      start,
      end: new Date(today.getFullYear(), today.getMonth() + 1, 0),
      label: start.toLocaleDateString("id-ID", {
        month: "long",
        year: "numeric",
      }),
    };
  }

  function dashboardOperatorTargetForPeriod(line, period) {
    const monthlyTarget =
      line === "press"
        ? getKpiPressOutputTarget()
        : getKpiFillingOutputTarget();
    if (period.mode === "year") return monthlyTarget * 12;
    if (period.mode === "month") return monthlyTarget;

    let workingDays = 0;
    for (
      let cursor = new Date(period.start);
      cursor <= period.end;
      cursor = dashboardAddDays(cursor, 1)
    ) {
      const day = cursor.getDay();
      if (day !== 0 && day !== 6) workingDays += 1;
    }
    return (monthlyTarget / KPI_WORKING_DAYS_PER_MONTH) * workingDays;
  }

  function dashboardDateInPeriod(dateText, period) {
    const date = dashboardDateParts(dateText);
    return Boolean(date && date >= period.start && date <= period.end);
  }

  function renderDashboardPressKpiLegacy(entries) {
    const tbody = el("dashboardPressKpiBody");
    const summary = el("dashboardPressKpiSummary");
    const pagination = el("dashboardPressKpiPagination");
    if (!tbody) return;

    const targetPerDay = 3500;
    const workHours = 7;
    const period = dashboardPressKpiPeriod();
    const operatorFilter = String(state.dashboard.pressKpiOperator || "")
      .trim()
      .toLowerCase();
    const grouped = new Map();

    entries
      .filter(
        (entry) =>
          entry.tab === "press" && dashboardDateInPeriod(entry.tanggal, period),
      )
      .filter(
        (entry) =>
          !operatorFilter ||
          String(entry.operator || "")
            .trim()
            .toLowerCase()
            .includes(operatorFilter),
      )
      .forEach((entry) => {
        const operator = String(entry.operator || "").trim() || "—";
        if (!grouped.has(operator)) {
          grouped.set(operator, {
            operator,
            totalPress: 0,
            broken: 0,
            activeDates: new Set(),
          });
        }
        const row = grouped.get(operator);
        row.totalPress += Number(entry.totalQty) || 0;
        row.broken += Number(entry.qtyBotolPecah) || 0;
        if (entry.tanggal) row.activeDates.add(entry.tanggal);
      });

    const apdByOperator = new Map();
    (state.apdEntries || [])
      .filter((item) => item && dashboardDateInPeriod(item.tanggal, period))
      .filter(
        (item) =>
          !operatorFilter ||
          String(item.operator || "")
            .trim()
            .toLowerCase()
            .includes(operatorFilter),
      )
      .forEach((item) => {
        const key = String(item.operator || "")
          .trim()
          .toLowerCase();
        if (!key) return;
        if (!apdByOperator.has(key)) apdByOperator.set(key, []);
        apdByOperator.get(key).push(Number(item.percentage) || 0);
      });

    const allRows = Array.from(grouped.values())
      .map((row) => {
        const activeDays = Math.max(1, row.activeDates.size);
        const apdValues = apdByOperator.get(row.operator.toLowerCase()) || [];
        const kpiApd = apdValues.length
          ? apdValues.reduce((sum, value) => sum + value, 0) / apdValues.length
          : null;
        return {
          ...row,
          activeDays,
          perHour: row.totalPress / (workHours * activeDays),
          kpiResult: (row.totalPress / (targetPerDay * activeDays)) * 100,
          kpiReject:
            row.totalPress > 0 ? (row.broken / row.totalPress) * 100 : 0,
          kpiApd,
          apdCount: apdValues.length,
        };
      })
      .sort(
        (a, b) =>
          b.totalPress - a.totalPress ||
          a.operator.localeCompare(b.operator, "id"),
      );

    const pageSize = CONFIG.DASHBOARD_PRESS_KPI_PAGE_SIZE;
    const totalPages = Math.max(1, Math.ceil(allRows.length / pageSize));
    state.dashboard.pressKpiPage = Math.min(
      Math.max(1, state.dashboard.pressKpiPage || 1),
      totalPages,
    );
    const page = state.dashboard.pressKpiPage;
    const start = (page - 1) * pageSize;
    const visibleRows = allRows.slice(start, start + pageSize);

    tbody.innerHTML = visibleRows.length
      ? visibleRows
          .map(
            (row) => `
      <tr>
        <td><strong>${highlightSearchMatch(row.operator, state.dashboard.pressKpiOperator)}</strong></td>
        <td><strong>${dashboardQty(row.totalPress)}</strong></td>
        <td>${row.perHour.toLocaleString("id-ID", { maximumFractionDigits: 1 })}</td>
        <td><span class="dashboard-kpi-percent result">${dashboardPercent(row.kpiResult)}</span></td>
        <td class="${row.broken > 0 ? "pecah-tag" : ""}">${dashboardQty(row.broken)}</td>
        <td><span class="dashboard-kpi-percent reject">${dashboardPercent(row.kpiReject)}</span></td>
        <td><span class="dashboard-kpi-percent apd">${row.kpiApd === null ? "—" : dashboardPercent(row.kpiApd)}</span></td>
      </tr>`,
          )
          .join("")
      : `<tr><td colspan="7" class="empty-row">Belum ada data Press pada periode/filter ini.</td></tr>`;

    const totalPress = allRows.reduce((sum, row) => sum + row.totalPress, 0);
    const totalBroken = allRows.reduce((sum, row) => sum + row.broken, 0);
    const rejectTotal = totalPress > 0 ? (totalBroken / totalPress) * 100 : 0;

    dashboardSetText(
      "dashboardPressKpiOperators",
      dashboardQty(allRows.length),
    );
    dashboardSetText("dashboardPressKpiTotal", dashboardQty(totalPress));
    dashboardSetText("dashboardPressKpiBroken", dashboardQty(totalBroken));
    dashboardSetText(
      "dashboardPressKpiRejectTotal",
      dashboardPercent(rejectTotal),
    );

    if (summary) {
      if (allRows.length) {
        const from = start + 1;
        const to = Math.min(start + pageSize, allRows.length);
        summary.textContent = `${from}–${to} dari ${allRows.length} operator · ${period.label} · Total Press ${dashboardQty(totalPress)} pcs · Total rusak ${dashboardQty(totalBroken)} pcs`;
      } else {
        summary.textContent = `Tidak ada pengerjaan Press pada ${period.label}${state.dashboard.pressKpiOperator ? ` untuk ${state.dashboard.pressKpiOperator}` : ""}.`;
      }
    }

    if (pagination) {
      pagination.hidden = totalPages <= 1;
      renderPagination(pagination, page, totalPages, (nextPage) => {
        state.dashboard.pressKpiPage = nextPage;
        renderDashboardPressKpi(entries);
      });
    }
  }

  function renderDashboardPressKpi(entries) {
    const chart = el("dashboardDamageChart");
    const summary = el("dashboardDamageSummary");
    if (!chart) return;

    const period = dashboardPressKpiPeriod();
    const operatorFilter = String(state.dashboard.pressKpiOperator || "")
      .trim()
      .toLowerCase();
    const filtered = entries.filter((entry) => {
      if (!dashboardDateInPeriod(entry.tanggal, period)) return false;
      return (
        !operatorFilter ||
        String(entry.operator || "")
          .trim()
          .toLowerCase()
          .includes(operatorFilter)
      );
    });

    const dayCount = Math.round((period.end - period.start) / 86400000) + 1;
    const groupByMonth = period.mode === "year" || dayCount > 62;
    const buckets = [];
    if (groupByMonth) {
      let cursor = new Date(
        period.start.getFullYear(),
        period.start.getMonth(),
        1,
      );
      const last = new Date(period.end.getFullYear(), period.end.getMonth(), 1);
      while (cursor <= last) {
        buckets.push({
          key: dashboardMonthKey(cursor),
          label: cursor.toLocaleDateString("id-ID", {
            month: "short",
            year:
              period.start.getFullYear() !== period.end.getFullYear()
                ? "2-digit"
                : undefined,
          }),
          broken: 0,
          wet: 0,
        });
        cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
      }
    } else {
      for (
        let cursor = new Date(period.start);
        cursor <= period.end;
        cursor = dashboardAddDays(cursor, 1)
      ) {
        buckets.push({
          key: dashboardDateKey(cursor),
          label: cursor.toLocaleDateString("id-ID", {
            day: "2-digit",
            month: "short",
          }),
          broken: 0,
          wet: 0,
        });
      }
    }

    const byKey = new Map(buckets.map((bucket) => [bucket.key, bucket]));
    const pressOperators = new Set();
    const fillingOperators = new Set();
    filtered.forEach((entry) => {
      const key = groupByMonth
        ? String(entry.tanggal || "").slice(0, 7)
        : entry.tanggal;
      const bucket = byKey.get(key);
      if (!bucket) return;
      const operator = String(entry.operator || "")
        .trim()
        .toLowerCase();
      if (entry.tab === "press") {
        const value = Math.max(0, Number(entry.qtyBotolPecah) || 0);
        bucket.broken += value;
        if (value > 0 && operator) pressOperators.add(operator);
      } else if (entry.tab === "filling") {
        const value = Math.max(0, Number(entry.qtyKardusBasah) || 0);
        bucket.wet += value;
        if (value > 0 && operator) fillingOperators.add(operator);
      }
    });

    const totalBroken = buckets.reduce((sum, item) => sum + item.broken, 0);
    const totalWet = buckets.reduce((sum, item) => sum + item.wet, 0);
    const brokenPeak = buckets.reduce(
      (best, item) => (item.broken > best.broken ? item : best),
      buckets[0] || { broken: 0, label: "—" },
    );
    const wetPeak = buckets.reduce(
      (best, item) => (item.wet > best.wet ? item : best),
      buckets[0] || { wet: 0, label: "—" },
    );

    dashboardSetText("dashboardDamageBroken", dashboardQty(totalBroken));
    dashboardSetText("dashboardDamageWet", dashboardQty(totalWet));
    dashboardSetText(
      "dashboardDamagePressOperators",
      dashboardQty(pressOperators.size),
    );
    dashboardSetText(
      "dashboardDamageFillingOperators",
      dashboardQty(fillingOperators.size),
    );
    dashboardSetText(
      "dashboardDamageBrokenPeak",
      dashboardQty(brokenPeak.broken),
    );
    dashboardSetText(
      "dashboardDamageBrokenPeakDate",
      brokenPeak.broken ? brokenPeak.label : "—",
    );
    dashboardSetText("dashboardDamageWetPeak", dashboardQty(wetPeak.wet));
    dashboardSetText(
      "dashboardDamageWetPeakDate",
      wetPeak.wet ? wetPeak.label : "—",
    );

    const selectedOperator = String(
      state.dashboard.pressKpiOperator || "",
    ).trim();
    const hasSelectedOperator =
      Boolean(selectedOperator) && isMasterValue("operator", selectedOperator);
    const selectedOperatorKey = hasSelectedOperator
      ? kpiOperatorKey(canonicalMasterValue("operator", selectedOperator))
      : "";
    const operatorEntries = hasSelectedOperator
      ? entries.filter(
          (entry) =>
            dashboardDateInPeriod(entry.tanggal, period) &&
            kpiOperatorKey(entry.operator) === selectedOperatorKey,
        )
      : [];
    const operatorLines = ["press", "filling"].map((line) => {
      const lineEntries = operatorEntries.filter((entry) => entry.tab === line);
      return {
        line,
        entries: lineEntries,
        result: lineEntries.reduce(
          (sum, entry) => sum + Math.max(0, Number(entry.totalQty) || 0),
          0,
        ),
      };
    });
    // Ringkasan hanya menampilkan satu bagian. Jika pernah mengerjakan kedua
    // bagian pada periode yang sama, bagian dengan entri terbanyak digunakan;
    // total hasil menjadi penentu berikutnya jika jumlah entrinya sama.
    const activeOperatorLine = operatorLines
      .filter((item) => item.entries.length > 0)
      .sort(
        (a, b) => b.entries.length - a.entries.length || b.result - a.result,
      )[0];
    ["press", "filling"].forEach((line) => {
      const lineName = line === "press" ? "Press" : "Filling";
      const lineResult = operatorLines.find((item) => item.line === line);
      const hasLineResult = activeOperatorLine?.line === line;
      const result = lineResult?.result || 0;
      const target = dashboardOperatorTargetForPeriod(line, period);
      const achievement = target > 0 ? (result / target) * 100 : 0;
      const resultCard = el(`dashboardOperator${lineName}ResultCard`);
      const achievementCard = el(`dashboardOperator${lineName}AchievementCard`);
      if (resultCard) resultCard.hidden = !hasLineResult;
      if (achievementCard) achievementCard.hidden = !hasLineResult;
      dashboardSetText(
        `dashboardOperator${lineName}Result`,
        dashboardQty(result),
      );
      dashboardSetText(
        `dashboardOperator${lineName}Achievement`,
        dashboardPercent(achievement),
      );
      dashboardSetText(
        `dashboardOperator${lineName}Target`,
        `Target ${dashboardQty(Math.round(target))} pcs`,
      );
    });

    // Panel chart mengikuti tinggi Ringkasan Periode. Pembacaan ukuran setelah
    // kartu operator diubah memaksa layout terbaru digunakan untuk SVG.
    const chartRect = chart.getBoundingClientRect();
    const chartWrap = chart.parentElement;
    const width = Math.max(620, Math.round(chartRect.width || 900));
    const height = Math.max(
      340,
      Math.round(chartWrap?.getBoundingClientRect().height || 340),
    );
    const plot = {
      left: 54,
      right: 22,
      top: Math.max(24, Math.round(height * 0.07)),
      bottom: Math.max(42, Math.round(height * 0.1)),
    };
    const plotWidth = width - plot.left - plot.right;
    const plotHeight = height - plot.top - plot.bottom;
    const maxValue = Math.max(
      1,
      ...buckets.flatMap((item) => [item.broken, item.wet]),
    );
    const yMax = Math.max(5, Math.ceil(maxValue / 5) * 5);
    const x = (index) =>
      plot.left +
      (buckets.length <= 1
        ? plotWidth / 2
        : (index / (buckets.length - 1)) * plotWidth);
    const y = (value) => plot.top + plotHeight - (value / yMax) * plotHeight;
    const pathFor = (key) => {
      const coordinates = buckets.map((item, index) => ({
        x: x(index),
        y: y(item[key]),
      }));
      if (!coordinates.length) return "";
      if (coordinates.length === 1)
        return `M${coordinates[0].x.toFixed(1)},${coordinates[0].y.toFixed(1)}`;

      const clampY = (value) =>
        Math.max(plot.top, Math.min(plot.top + plotHeight, value));
      const tension = 0.72;
      let path = `M${coordinates[0].x.toFixed(1)},${coordinates[0].y.toFixed(1)}`;
      for (let index = 0; index < coordinates.length - 1; index += 1) {
        const previous = coordinates[index - 1] || coordinates[index];
        const current = coordinates[index];
        const next = coordinates[index + 1];
        const following = coordinates[index + 2] || next;
        const control1X = current.x + ((next.x - previous.x) / 6) * tension;
        const control1Y = clampY(
          current.y + ((next.y - previous.y) / 6) * tension,
        );
        const control2X = next.x - ((following.x - current.x) / 6) * tension;
        const control2Y = clampY(
          next.y - ((following.y - current.y) / 6) * tension,
        );
        path += ` C${control1X.toFixed(1)},${control1Y.toFixed(1)} ${control2X.toFixed(1)},${control2Y.toFixed(1)} ${next.x.toFixed(1)},${next.y.toFixed(1)}`;
      }
      return path;
    };
    const labelStep = Math.max(1, Math.ceil(buckets.length / 10));
    const yTickCount = Math.max(
      5,
      Math.min(8, Math.round(plotHeight / 65) + 1),
    );
    const grid = Array.from({ length: yTickCount }, (_, index) => {
      const value = (yMax / (yTickCount - 1)) * index;
      const py = y(value);
      return `<line x1="${plot.left}" y1="${py}" x2="${width - plot.right}" y2="${py}" class="damage-grid-line"/><text x="${plot.left - 10}" y="${py + 4}" class="damage-axis-label" text-anchor="end">${dashboardQty(value)}</text>`;
    }).join("");
    const labels = buckets
      .map((item, index) =>
        index % labelStep === 0 || index === buckets.length - 1
          ? `<text x="${x(index)}" y="${plot.top + plotHeight + Math.min(25, Math.round(plot.bottom * 0.55))}" class="damage-axis-label" text-anchor="middle">${esc(item.label)}</text>`
          : "",
      )
      .join("");
    const points = (key, cssClass, name) =>
      buckets
        .map(
          (item, index) =>
            `<circle cx="${x(index)}" cy="${y(item[key])}" r="${buckets.length > 45 ? 3 : 4.5}" class="${cssClass}" tabindex="0" data-tooltip="${esc(item.label)} — ${name}: ${dashboardQty(item[key])}"></circle>`,
        )
        .join("");

    chart.innerHTML = `<svg viewBox="0 0 ${width} ${height}" aria-hidden="true" preserveAspectRatio="xMidYMid meet">
      ${grid}
      <line x1="${plot.left}" y1="${plot.top}" x2="${plot.left}" y2="${plot.top + plotHeight}" class="damage-axis-line"/>
      <line x1="${plot.left}" y1="${plot.top + plotHeight}" x2="${width - plot.right}" y2="${plot.top + plotHeight}" class="damage-axis-line"/>
      ${labels}
      <path d="${pathFor("broken")}" class="damage-line damage-bottle-line"/>
      <path d="${pathFor("wet")}" class="damage-line damage-carton-line"/>
      ${points("broken", "damage-point damage-bottle-point", "Botol pecah")}
      ${points("wet", "damage-point damage-carton-point", "Kardus basah")}
    </svg>`;

    const tooltip = el("dashboardDamageTooltip");
    const showTooltip = (point, clientX, clientY) => {
      if (!tooltip || !point) return;
      window.clearTimeout(chart._damageTooltipTimer);
      const wrap = chart.parentElement;
      const wrapRect = wrap.getBoundingClientRect();
      const pointRect = point.getBoundingClientRect();
      tooltip.textContent = point.dataset.tooltip || "";
      tooltip.hidden = false;
      const anchorX = Number.isFinite(clientX)
        ? clientX
        : pointRect.left + pointRect.width / 2;
      const anchorY = Number.isFinite(clientY) ? clientY : pointRect.top;
      const relativeX = anchorX - wrapRect.left + wrap.scrollLeft;
      const relativeY = anchorY - wrapRect.top + wrap.scrollTop;
      tooltip.style.left = `${Math.max(wrap.scrollLeft + 8, Math.min(wrap.scrollLeft + wrap.clientWidth - 8, relativeX))}px`;
      tooltip.style.top = `${Math.max(wrap.scrollTop + 8, relativeY - 12)}px`;
    };
    const hideTooltip = () => {
      if (tooltip) tooltip.hidden = true;
    };
    chart.onpointermove = (event) => {
      const point = event.target.closest?.(".damage-point");
      if (point) showTooltip(point, event.clientX, event.clientY);
    };
    chart.onpointerout = (event) => {
      const point = event.target.closest?.(".damage-point");
      if (point && event.pointerType !== "touch") hideTooltip();
    };
    chart.onpointerleave = (event) => {
      if (event.pointerType !== "touch") hideTooltip();
    };
    chart.onclick = (event) => {
      const point = event.target.closest?.(".damage-point");
      if (!point) return;
      showTooltip(point, event.clientX, event.clientY);
      window.clearTimeout(chart._damageTooltipTimer);
      chart._damageTooltipTimer = window.setTimeout(hideTooltip, 2500);
    };
    chart.onfocusin = (event) => {
      const point = event.target.closest?.(".damage-point");
      if (point) showTooltip(point);
    };
    chart.onfocusout = hideTooltip;

    if (summary) {
      const operatorText = state.dashboard.pressKpiOperator
        ? ` · Operator: ${state.dashboard.pressKpiOperator}`
        : " · Semua operator";
      summary.textContent = `${period.label}${operatorText} · Botol pecah ${dashboardQty(totalBroken)} · Kardus basah ${dashboardQty(totalWet)}`;
    }
  }

  function renderDashboardOperators(entries) {
    const tbody = el("dashboardOperatorBody");
    if (!tbody) return;
    const today = todayStr();
    const grouped = new Map();

    entries
      .filter((entry) => entry.tanggal === today)
      .forEach((entry) => {
        const operator = String(entry.operator || "").trim() || "—";
        if (!grouped.has(operator))
          grouped.set(operator, { operator, filling: 0, press: 0 });
        const item = grouped.get(operator);
        const qty = Number(entry.totalQty) || 0;
        if (entry.tab === "filling") item.filling += qty;
        if (entry.tab === "press") item.press += qty;
      });

    const rows = Array.from(grouped.values())
      .map((row) => ({ ...row, total: row.filling + row.press }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 6);

    tbody.innerHTML = rows.length
      ? rows
          .map(
            (row) => `
      <tr>
        <td><strong>${esc(row.operator)}</strong></td>
        <td>${dashboardQty(row.filling)}</td>
        <td>${dashboardQty(row.press)}</td>
        <td><strong class="dashboard-total-value">${dashboardQty(row.total)}</strong></td>
      </tr>`,
          )
          .join("")
      : '<tr><td colspan="4" class="empty-row">Belum ada data produksi hari ini.</td></tr>';
  }

  function renderDashboard() {
    if (!el("view-dashboard")) return;

    const entries = dashboardEntries();
    const today = todayStr();
    const spkVariantsToday = [
      ...(state.spkEntries || []),
      ...(state.preview.spk || []),
    ].filter((item) => item.tanggal === today).length;
    const balanceRows = getPressBalanceRows();
    const fillingToday = entries
      .filter((entry) => entry.tab === "filling" && entry.tanggal === today)
      .reduce((sum, entry) => sum + (Number(entry.totalQty) || 0), 0);
    const pressToday = entries
      .filter((entry) => entry.tab === "press" && entry.tanggal === today)
      .reduce((sum, entry) => sum + (Number(entry.totalQty) || 0), 0);
    // Botol rusak Filling hanya dicatat sebagai data Spreadsheet.
    // KPI/alert kerusakan hanya memakai Botol Rusak dari proses Press.
    const brokenToday = entries
      .filter((entry) => entry.tab === "press" && entry.tanggal === today)
      .reduce((sum, entry) => sum + (Number(entry.qtyBotolPecah) || 0), 0);
    const wetCartonsToday = entries
      .filter((entry) => entry.tab === "filling" && entry.tanggal === today)
      .reduce((sum, entry) => sum + (Number(entry.qtyKardusBasah) || 0), 0);
    const waiting = balanceRows.reduce(
      (sum, row) => sum + (Number(row.remaining) || 0),
      0,
    );
    // Seluruh angka pada alur produksi ini merupakan angka hari ini. Persentase
    // selesai harus memakai periode yang sama agar riwayat hari sebelumnya tidak
    // menghasilkan persentase ketika proses Filling dan Press hari ini masih 0.
    const donePercent =
      fillingToday > 0
        ? Math.min(100, Math.max(0, (pressToday / fillingToday) * 100))
        : 0;

    dashboardSetText(
      "dashboardDate",
      new Date().toLocaleDateString("id-ID", {
        weekday: "long",
        day: "2-digit",
        month: "long",
        year: "numeric",
      }),
    );
    dashboardSetText("dashFillingToday", dashboardQty(fillingToday));
    dashboardSetText("dashPressToday", dashboardQty(pressToday));
    dashboardSetText("dashPressRemaining", dashboardQty(waiting));
    dashboardSetText("dashTodaySpkVariants", dashboardQty(spkVariantsToday));
    dashboardSetText("dashBrokenToday", dashboardQty(brokenToday));
    dashboardSetText("dashWetCartonsToday", dashboardQty(wetCartonsToday));
    dashboardSetText("dashFlowFilling", `${dashboardQty(fillingToday)} pcs`);
    dashboardSetText(
      "dashFlowWaiting",
      `${dashboardQty(waiting)} pcs tertunda`,
    );
    dashboardSetText("dashFlowPress", `${dashboardQty(pressToday)} pcs`);
    dashboardSetText(
      "dashFlowDone",
      `${donePercent.toLocaleString("id-ID", { maximumFractionDigits: 1 })}% selesai`,
    );

    renderDashboardWeekly(entries);
    renderDashboardAlerts(balanceRows, brokenToday);
    renderDashboardPriority(balanceRows);
    renderDashboardRemaining(balanceRows);
    renderDashboardOperators(entries);
    renderDashboardPressKpi(entries);
  }

  function todayDowntimeEntry() {
    const today = todayStr();
    return (state.downtimeEntries || []).find(
      (entry) => String(entry.tanggal || "") === today,
    );
  }

  function renderFillingDowntimeValidation() {
    const view = el("view-filling");
    if (!view) return;
    const entry = todayDowntimeEntry();
    const validated = Boolean(entry);
    view.classList.toggle("filling-awaiting-validation", !validated);
    const gate = el("fillingValidationGate");
    const status = el("fillingValidationStatus");
    const validateButton = el("fillingDowntimeValidateButton");
    const historyButton = el("fillingDowntimeHistoryButton");
    const reopen = el("fillingValidationReopen");
    if (reopen) reopen.hidden = validated || !fillingDowntimeDismissed;
    if (gate) gate.hidden = validated;
    if (status) {
      status.textContent = validated
        ? `Tervalidasi hari ini: ${dashboardQty(entry.downTime)} menit · ${entry.alasan}`
        : "Down Time hari ini wajib diisi untuk membuka proses Filling.";
    }
    if (validateButton) {
      validateButton.innerHTML = validated
        ? '<i class="fa-solid fa-pen-to-square"></i> Ubah Validasi'
        : '<i class="fa-solid fa-clock"></i> Validasi Down Time';
      validateButton.hidden = !canLevel("filling", "write");
    }
    if (historyButton) {
      historyButton.disabled =
        !validated || state.currentUser?.role !== "superuser";
      historyButton.textContent = validated
        ? `${dashboardQty(entry.downTime)} menit · ${entry.alasan}`
        : "Belum ada data hari ini";
      historyButton.title = validated
        ? `${fmtDateTime(entry.timestamp)}${entry.keterangan ? ` · ${entry.keterangan}` : ""}${state.currentUser?.role === "superuser" ? " · Klik untuk mengubah" : " · Hanya Super User yang dapat mengubah"}`
        : "Validasi Down Time belum diisi";
    }
  }

  function initFillingDowntime() {
    const modal = el("fillingDowntimeModal");
    const form = el("fillingDowntimeForm");
    const arrival = el("fillingDowntimeArrival");
    const productionStart = el("fillingProductionStartTime");
    const minutes = el("fillingDowntimeMinutes");
    const reason = el("fillingDowntimeReason");
    const note = el("fillingDowntimeNote");
    const noteWrap = el("fillingDowntimeNoteWrap");
    const error = el("fillingDowntimeError");
    if (
      !modal ||
      !form ||
      !arrival ||
      !productionStart ||
      !minutes ||
      !reason ||
      !note ||
      !noteWrap
    )
      return;

    const productionStartTime = "08:30";
    const timeValue = (date) =>
      `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    const minutesOfDay = (value) => {
      const match = /^(\d{2}):(\d{2})$/.exec(String(value || ""));
      return match ? Number(match[1]) * 60 + Number(match[2]) : null;
    };
    const syncDowntime = () => {
      const arrivalMinutes = minutesOfDay(arrival.value);
      productionStart.value = productionStartTime;
      const startMinutes = minutesOfDay(productionStartTime);
      const result =
        arrivalMinutes === null || startMinutes === null
          ? ""
          : arrivalMinutes - startMinutes;
      minutes.value = result === "" ? "" : String(result);
      const isOnTime = result !== "" && result <= 0;
      if (isOnTime) {
        reason.value = "Tepat Waktu";
        note.value = "";
      } else if (reason.value === "Tepat Waktu") {
        reason.value = "";
      }
      const onTimeOption = reason.querySelector('option[value="Tepat Waktu"]');
      if (onTimeOption) onTimeOption.disabled = !isOnTime;
      reason.disabled = isOnTime;
      syncNote();
      return result;
    };

    const syncNote = () => {
      const other = reason.value === "Lainnya";
      noteWrap.hidden = !other;
      note.required = other;
      if (!other) note.value = "";
    };
    const close = () => {
      modal.hidden = true;
      if (error) error.hidden = true;
      fillingDowntimeDismissed = !todayDowntimeEntry();
      renderFillingDowntimeValidation();
    };
    const open = () => {
      if (!canLevel("filling", "write")) {
        toast("Anda tidak memiliki akses menulis data Filling.", true);
        return;
      }
      const entry = todayDowntimeEntry();
      if (entry && state.currentUser?.role !== "superuser") {
        toast("Validasi Down Time hanya dapat diubah oleh Super User.", true);
        return;
      }
      fillingDowntimeDismissed = false;
      renderFillingDowntimeValidation();
      form.reset();
      const arrivalDate = entry?.timestamp
        ? new Date(entry.timestamp)
        : new Date();
      arrival.value = timeValue(arrivalDate);
      productionStart.value = productionStartTime;
      reason.value = entry?.alasan || "";
      note.value = entry?.keterangan || "";
      syncNote();
      syncDowntime();
      if (error) error.hidden = true;
      modal.hidden = false;
      arrival.focus();
    };
    openFillingDowntimeModal = open;

    reason.addEventListener("change", syncNote);
    arrival.addEventListener("input", syncDowntime);
    arrival.addEventListener("change", syncDowntime);
    el("fillingDowntimeValidateButton")?.addEventListener("click", open);
    el("fillingDowntimeReopenButton")?.addEventListener("click", open);
    el("fillingDowntimeHistoryButton")?.addEventListener("click", open);
    el("fillingDowntimeClose")?.addEventListener("click", close);
    el("fillingDowntimeCancel")?.addEventListener("click", close);
    modal.addEventListener("click", (event) => {
      if (event.target === modal) close();
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const downtimeValue = syncDowntime();
      const downTime = Number(downtimeValue);
      const alasan = reason.value;
      const keterangan = note.value.trim();
      if (downtimeValue === "" || !Number.isFinite(downTime)) {
        if (error) {
          error.textContent = "Hasil Down Time tidak valid.";
          error.hidden = false;
        }
        arrival.focus();
        return;
      }
      if (!alasan || (alasan === "Lainnya" && !keterangan)) {
        if (error) {
          error.textContent =
            alasan === "Lainnya"
              ? "Keterangan wajib diisi untuk alasan Lainnya."
              : "Alasan wajib dipilih.";
          error.hidden = false;
        }
        return;
      }
      const arrivalDate = new Date();
      const [hours, arrivalMinute] = arrival.value.split(":").map(Number);
      arrivalDate.setHours(hours, arrivalMinute, 0, 0);
      const arrivalTimestamp = arrivalDate.toISOString();
      const button = el("fillingDowntimeSave");
      if (button) button.disabled = true;
      try {
        const response = await enqueueWrite(() =>
          apiPost("downtime.upsert", {
            data: JSON.stringify({
              arrivalTimestamp,
              productionStartTime,
              downTime,
              alasan,
              keterangan,
            }),
          }),
        );
        state.downtimeEntries = response.downtimeEntries || [];
        renderFillingDowntimeValidation();
        if (typeof window.refreshKpiLaporanAutoPreview === "function")
          window.refreshKpiLaporanAutoPreview();
        close();
        toast("Validasi Down Time Filling berhasil disimpan.");
      } catch (err) {
        if (error) {
          error.textContent = err.message;
          error.hidden = false;
        }
      } finally {
        if (button) button.disabled = false;
      }
    });
    renderFillingDowntimeValidation();
  }

  function renderFillingSpkQueue() {
    const tbody = el("fillingSpkBody");
    if (!tbody) return;
    const sourceRows = (state.spkEntries || [])
      .map((item) => ({
        ...item,
        usedQty: spkFillingUsedQty(item.batchNo),
        remainingQty: spkRemainingQty(item),
      }))
      .filter((item) => item.remainingQty > 0)
      .sort(
        (a, b) =>
          String(a.tanggal).localeCompare(String(b.tanggal)) ||
          compareSpkBatchNo(a.batchNo, b.batchNo),
      );
    const rows = applyExcelDataFilter(
      tbody.closest("table"),
      sourceRows,
      [
        () => "",
        (r) => r.batchNo,
        (r) => r.produk,
        (r) => r.botol,
        (r) => {
          const perDus = Number(r.qtyPerDus) || 0;
          return perDus > 0 ? r.remainingQty / perDus : r.produksiDus;
        },
        (r) => r.qtyPerDus,
        (r) => r.qty,
        (r) => r.remainingQty,
      ],
      renderFillingSpkQueue,
    );
    const pageSize = CONFIG.FILLING_SPK_PAGE_SIZE;
    const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
    state.spk.fillingPage = Math.min(
      Math.max(1, state.spk.fillingPage),
      totalPages,
    );
    const start = (state.spk.fillingPage - 1) * pageSize;
    const visibleRows = rows.slice(start, start + pageSize);
    const selectableBatchNos = new Set(
      rows
        .filter(
          (item) =>
            Number(item.usedQty) <= 0 &&
            canManageSpk(item) &&
            canLevel("spk", "write"),
        )
        .map((item) => String(item.batchNo)),
    );
    selectedFillingSpkRows.forEach((batchNo) => {
      if (!selectableBatchNos.has(batchNo))
        selectedFillingSpkRows.delete(batchNo);
    });
    const fillingRows = [
      ...(state.entries || []).filter((item) => item.tab === "filling"),
      ...(state.preview.filling || []),
    ];
    tbody.innerHTML = visibleRows.length
      ? visibleRows
          .map((item) => {
            const batchNo = String(item.batchNo || "");
            const selectable = selectableBatchNos.has(batchNo);
            const selectionTitle = selectable
              ? "Pilih SPK untuk penghapusan massal"
              : Number(item.usedQty) > 0
                ? "SPK sudah digunakan dan tidak dapat dihapus"
                : "Anda tidak memiliki izin mengelola SPK ini";
            const fillingCount = fillingRows.filter(
              (entry) => entryBatchNo(entry) === batchNo,
            ).length;
            const qty = Math.max(0, Number(item.qty) || 0);
            const qtyPerDus = Math.max(0, Number(item.qtyPerDus) || 0);
            const remainingProductionDus =
              qtyPerDus > 0
                ? Math.max(0, Number(item.remainingQty) || 0) / qtyPerDus
                : Math.max(0, Number(item.produksiDus) || 0);
            const remainingLabel = qty
              ? Number(item.remainingQty).toLocaleString("id-ID")
              : "Belum ada Qty";
            return `<tr>
            <td class="select-col"><input type="checkbox" class="filling-spk-row-select" data-batch-no="${esc(batchNo)}" aria-label="Pilih SPK ${esc(batchNo)}" title="${selectionTitle}" ${selectable ? "" : "disabled"} ${selectedFillingSpkRows.has(batchNo) ? "checked" : ""}></td>
            <td><span class="id-badge">${esc(item.batchNo)}</span></td>
            <td>${esc(item.produk)}</td><td>${esc(item.botol)}</td>
            <td><strong>${remainingProductionDus.toLocaleString("id-ID", { maximumFractionDigits: 2 })}</strong></td>
            <td>${qtyPerDus.toLocaleString("id-ID")}</td>
            <td>${qty ? qty.toLocaleString("id-ID") : "—"}</td>
            <td><strong>${remainingLabel}</strong></td>
            <td><span class="sync-badge ${fillingCount ? "saved" : "pending"}">${fillingCount ? `${fillingCount} Input Filling` : "Belum ada Filling"}</span></td>
            <td><button type="button" class="btn btn-primary filling-spk-use"
              data-batch-no="${esc(item.batchNo)}" data-produk="${esc(item.produk)}" data-botol="${esc(item.botol)}"
              data-qty-per-dus="${qtyPerDus}"
              >Gunakan</button></td>
          </tr>`;
          })
          .join("")
      : '<tr><td colspan="10" class="empty-row">Tidak ada SPK dengan sisa Qty.</td></tr>';
    dashboardSetText(
      "fillingSpkSummary",
      `${rows.length ? start + 1 : 0}–${Math.min(start + pageSize, rows.length)} dari ${rows.length} SPK belum selesai · ${fillingRows.length} total input Filling`,
    );
    renderPagination(
      el("fillingSpkPagination"),
      state.spk.fillingPage,
      totalPages,
      (page) => {
        state.spk.fillingPage = page;
        renderFillingSpkQueue();
      },
    );
    const visibleBatchNos = visibleRows
      .filter((item) => selectableBatchNos.has(String(item.batchNo)))
      .map((item) => String(item.batchNo));
    const selectAll = el("fillingSpkSelectAll");
    if (selectAll) {
      const selectedCount = visibleBatchNos.filter((batchNo) =>
        selectedFillingSpkRows.has(batchNo),
      ).length;
      selectAll.disabled = !visibleBatchNos.length;
      selectAll.checked =
        Boolean(visibleBatchNos.length) &&
        selectedCount === visibleBatchNos.length;
      selectAll.indeterminate =
        selectedCount > 0 && selectedCount < visibleBatchNos.length;
      selectAll.dataset.batchNos = JSON.stringify(visibleBatchNos);
    }
    const massDeleteButton = el("fillingSpkMassDeleteButton");
    if (massDeleteButton) {
      massDeleteButton.hidden = !selectedFillingSpkRows.size;
      massDeleteButton.disabled =
        !selectedFillingSpkRows.size || !canLevel("spk", "write");
      massDeleteButton.innerHTML = `<i class="fa-solid fa-trash"></i> Hapus Massal${selectedFillingSpkRows.size ? ` (${selectedFillingSpkRows.size})` : ""}`;
    }
  }

  function initFillingSpkQueue() {
    el("fillingSpkBody")?.addEventListener("change", (event) => {
      const checkbox = event.target.closest(".filling-spk-row-select");
      if (!checkbox) return;
      const batchNo = String(checkbox.dataset.batchNo || "");
      if (checkbox.checked) selectedFillingSpkRows.add(batchNo);
      else selectedFillingSpkRows.delete(batchNo);
      renderFillingSpkQueue();
    });
    el("fillingSpkSelectAll")?.addEventListener("change", (event) => {
      let batchNos = [];
      try {
        batchNos = JSON.parse(event.target.dataset.batchNos || "[]");
      } catch (_) {}
      batchNos.forEach((batchNo) => {
        if (event.target.checked) selectedFillingSpkRows.add(batchNo);
        else selectedFillingSpkRows.delete(batchNo);
      });
      renderFillingSpkQueue();
    });
    el("fillingSpkMassDeleteButton")?.addEventListener("click", async () => {
      const batchNos = Array.from(selectedFillingSpkRows);
      if (!batchNos.length) return;
      if (batchNos.length > 100)
        return toast("Maksimal 100 SPK per sekali penghapusan.", true);
      if (
        !(await confirmDelete({
          title: `Hapus ${batchNos.length} SPK terpilih?`,
          message:
            "SPK terpilih akan dihapus dari Spreadsheet. SPK yang sudah digunakan tidak dapat dihapus.",
          item: `${batchNos.length} SPK belum digunakan`,
        }))
      )
        return;

      const button = el("fillingSpkMassDeleteButton");
      button.disabled = true;
      button.textContent = "Menghapus…";
      try {
        await enqueueWrite(() => apiPost("spk.batchDelete", { batchNos }));
        const deleted = new Set(batchNos);
        state.spkEntries = state.spkEntries.filter(
          (item) => !deleted.has(String(item.batchNo)),
        );
        selectedFillingSpkRows.clear();
        renderFillingSpkQueue();
        renderSpkToday();
        renderSpkReport();
        toast(`${batchNos.length} SPK berhasil dihapus.`);
      } catch (err) {
        toast(`Gagal menghapus SPK terpilih: ${err.message}`, true);
        renderFillingSpkQueue();
      }
    });
    el("fillingSpkBody")?.addEventListener("click", (event) => {
      const button = event.target.closest(".filling-spk-use");
      if (!button || button.disabled) return;
      const form = el("form-filling");
      if (!form) return;
      if (qs(".f-editing-id", form)?.value) qs(".f-cancel-btn", form)?.click();
      qs(".f-batch-no", form).value = button.dataset.batchNo || "";
      qs(".f-batch-display", form).value = button.dataset.batchNo || "";
      qs(".f-produk", form).value = button.dataset.produk || "";
      qs(".f-botol", form).value = button.dataset.botol || "";
      const qtyBotolPerKardus = qs(".f-qty-botol", form);
      if (qtyBotolPerKardus) {
        qtyBotolPerKardus.value = String(
          Math.max(0, Number(button.dataset.qtyPerDus) || 0),
        );
        qtyBotolPerKardus.dispatchEvent(new Event("input", { bubbles: true }));
      }
      qs(".f-produk", form).dispatchEvent(
        new Event("change", { bubbles: true }),
      );
      qs(".f-botol", form).dispatchEvent(
        new Event("change", { bubbles: true }),
      );
      saveFormDraft("filling", form);
      openFillingFormPopup(button);
    });
    renderFillingSpkQueue();
  }

  function spkStatusBadge(status, isPreview) {
    const value = String(status || "normal").toLowerCase();
    const label =
      value === "urgent" ? "URGENT" : value === "stock" ? "STOCK" : "NORMAL";
    return `<span class="spk-status-cell"><span class="spk-status-badge ${esc(value)}">${label}</span></span>`;
  }

  function renderSpkToday() {
    const tbody = el("spkTableBody");
    if (!tbody) return;
    const filterInput = el("spkDateFilter");
    const selectedDate = state.spk.date || todayStr();
    if (filterInput && filterInput.value !== selectedDate)
      filterInput.value = selectedDate;
    const saved = (state.spkEntries || [])
      .filter((item) => item.tanggal === selectedDate)
      .map((item) => ({ ...item, preview: false }));
    const preview = (state.preview.spk || [])
      .filter((item) => item.tanggal === selectedDate)
      .map((item) => ({ ...item, preview: true }));
    const query = String(state.spk.query || "")
      .trim()
      .toLowerCase();
    const rowsBeforeExcelFilter = [...saved, ...preview].filter(
      (item) =>
        !query ||
        String(item.batchNo || "")
          .toLowerCase()
          .includes(query) ||
        String(item.produk || "")
          .toLowerCase()
          .includes(query),
    );
    const rows = applyExcelDataFilter(
      tbody.closest("table"),
      rowsBeforeExcelFilter,
      [
        () => "",
        (r) => r.batchNo,
        (r) => r.tanggal,
        (r) => r.produk,
        (r) => r.botol,
        (r) => {
          const perDus = Number(r.qtyPerDus) || 0;
          return perDus > 0 ? spkRemainingQty(r) / perDus : r.produksiDus;
        },
        (r) => r.qtyPerDus,
        (r) => r.qty,
        (r) => (r.preview ? "Preview" : "Tersimpan"),
      ],
      renderSpkToday,
    );
    const today = todayStr();
    const todayRowCount = [
      ...(state.spkEntries || []),
      ...(state.preview.spk || []),
    ].filter((item) => item.tanggal === today).length;
    dashboardSetText("dashTodaySpkVariants", dashboardQty(todayRowCount));
    const totalPages = Math.max(1, Math.ceil(rows.length / 20));
    state.spk.page = Math.min(Math.max(1, state.spk.page), totalPages);
    const start = (state.spk.page - 1) * 20;
    const visibleRows = rows.slice(start, start + 20);
    const visibleQtyTotal = visibleRows.reduce(
      (sum, item) => sum + Math.max(0, Number(item.qty) || 0),
      0,
    );
    tbody.innerHTML = visibleRows.length
      ? visibleRows
          .map((item) => {
            const source = item.preview ? "preview" : "saved";
            const key = item.preview ? item.id : item.batchNo;
            const selectionKey = `${source}:${key}`;
            const selectable = item.preview || canManageSpk(item);
            const qtyPerDus = Math.max(0, Number(item.qtyPerDus) || 0);
            const remainingQty = spkRemainingQty(item);
            const remainingProductionDus =
              qtyPerDus > 0
                ? remainingQty / qtyPerDus
                : Math.max(0, Number(item.produksiDus) || 0);
            return `<tr>
      <td class="select-col">${selectable ? `<input type="checkbox" class="spk-row-select" data-source="${source}" data-key="${esc(key)}" aria-label="Pilih SPK ${esc(item.batchNo)}" ${selectedSpkRows.has(selectionKey) ? "checked" : ""}>` : ""}</td>
      <td><span class="id-badge">${esc(item.batchNo)}</span></td><td>${esc(item.tanggal)}</td>
      <td>${esc(item.produk)}</td><td>${esc(item.botol)}</td>
      <td><strong>${remainingProductionDus.toLocaleString("id-ID", { maximumFractionDigits: 2 })}</strong></td>
      <td>${qtyPerDus.toLocaleString("id-ID")}</td>
      <td>${Math.max(0, Number(item.qty) || 0).toLocaleString("id-ID")}</td>
      <td>${spkStatusBadge(item.status, item.preview)}</td>
      <td class="row-actions">
        ${item.preview || canManageSpk(item) ? `<button type="button" class="btn btn-ghost spk-edit" data-source="${item.preview ? "preview" : "saved"}" data-key="${esc(item.preview ? item.id : item.batchNo)}">Update</button>` : ""}
        ${item.preview || canManageSpk(item) ? `<button type="button" class="btn btn-danger spk-delete" data-source="${item.preview ? "preview" : "saved"}" data-key="${esc(item.preview ? item.id : item.batchNo)}">Hapus</button>` : ""}
      </td>
    </tr>`;
          })
          .join("")
      : `<tr><td colspan="10" class="empty-row">${query ? "No Batch atau Nama Produk tidak ditemukan." : "Belum ada SPK pada tanggal ini."}</td></tr>`;
    dashboardSetText(
      "spkSummary",
      `${rows.length ? start + 1 : 0}–${Math.min(start + 20, rows.length)} dari ${rows.length} SPK tanggal ${selectedDate} · Total Qty tampil: ${visibleQtyTotal.toLocaleString("id-ID")} pcs${query ? ` · Pencarian: ${state.spk.query}` : ""} · ${preview.length} preview belum disimpan`,
    );
    renderPagination(
      el("spkPagination"),
      state.spk.page,
      totalPages,
      (page) => {
        state.spk.page = page;
        renderSpkToday();
      },
    );
    const saveButton = el("spkSaveButton");
    if (saveButton) {
      saveButton.hidden = !canLevel("spk", "write");
      saveButton.disabled = !preview.length;
    }
    const selectableKeys = visibleRows
      .filter((item) => item.preview || canManageSpk(item))
      .map(
        (item) =>
          `${item.preview ? "preview" : "saved"}:${item.preview ? item.id : item.batchNo}`,
      );
    const selectAll = el("spkSelectAll");
    if (selectAll) {
      const selectedCount = selectableKeys.filter((key) =>
        selectedSpkRows.has(key),
      ).length;
      selectAll.disabled = !selectableKeys.length;
      selectAll.checked =
        Boolean(selectableKeys.length) &&
        selectedCount === selectableKeys.length;
      selectAll.indeterminate =
        selectedCount > 0 && selectedCount < selectableKeys.length;
      selectAll.dataset.keys = JSON.stringify(selectableKeys);
    }
    const massDeleteButton = el("spkMassDeleteButton");
    if (massDeleteButton) {
      massDeleteButton.hidden =
        selectedSpkRows.size === 0 || !canLevel("spk", "write");
      massDeleteButton.disabled = selectedSpkRows.size === 0;
      massDeleteButton.innerHTML = `<i class="fa-solid fa-trash"></i> Hapus Massal${selectedSpkRows.size ? ` (${selectedSpkRows.size})` : ""}`;
    }
  }

  function initSpkModal() {
    const modal = el("spkModal");
    const form = el("spkForm");
    const openButton = el("spkOpenButton");
    const batchInput = el("spkBatchNo");
    const produkInput = el("spkProduk");
    const botolInput = el("spkBotol");
    const produksiDusInput = el("spkProduksiDus");
    const qtyPerDusInput = el("spkQtyPerDus");
    const qtyInput = el("spkQty");
    const errorEl = el("spkError");
    const cancelButton = el("spkCancel");
    const submitButton = el("spkAdd");
    const importButton = el("spkImportButton");
    const importFile = el("spkImportFile");
    let editingSpk = null;
    let spkFormInitialized = false;
    if (!modal || !form || !openButton) return;
    state.spk.date = state.spk.date || todayStr();
    const dateFilter = el("spkDateFilter");
    const searchFilter = el("spkSearchFilter");
    if (dateFilter) {
      dateFilter.value = state.spk.date;
      dateFilter.addEventListener("change", () => {
        state.spk.date = dateFilter.value || todayStr();
        state.spk.page = 1;
        selectedSpkRows.clear();
        renderSpkToday();
      });
    }
    if (searchFilter) {
      searchFilter.value = state.spk.query || "";
      searchFilter.addEventListener("input", () => {
        state.spk.query = searchFilter.value.trim();
        state.spk.page = 1;
        selectedSpkRows.clear();
        renderSpkToday();
      });
    }

    importButton?.addEventListener("click", () => {
      if (!canLevel("spk", "write"))
        return toast("Anda tidak memiliki akses import SPK.", true);
      importFile?.click();
    });
    importFile?.addEventListener("change", async () => {
      const file = importFile.files?.[0];
      importFile.value = "";
      if (!file) return;
      if (!window.XLSX) {
        return toast("Library pembaca Excel belum berhasil dimuat.", true);
      }
      try {
        const workbook = window.XLSX.read(await file.arrayBuffer(), {
          type: "array",
        });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const data = window.XLSX.utils.sheet_to_json(sheet, {
          header: 1,
          raw: false,
          defval: "",
        });
        // Format sumber SPK menempatkan header pada baris ke-6.
        // Baris 1–5 berisi judul/keterangan dan sengaja diabaikan.
        const headerRowIndex = 5;
        if (
          data.length <= headerRowIndex ||
          !(data[headerRowIndex] || []).some((value) =>
            String(value || "").trim(),
          )
        ) {
          throw new Error("Header pada baris ke-6 tidak ditemukan.");
        }
        const normalizeHeader = (value) =>
          String(value || "")
            .replace(/^\uFEFF/, "")
            .trim()
            .replace(/\s+/g, " ")
            .toUpperCase();
        const headers = data[headerRowIndex].map(normalizeHeader);
        const required = [
          "NO BATCH",
          "MERK",
          "VARIAN",
          "BOTOL (MILL)",
          "PRODUKSI (DUS)",
          "QTY/DUS (PCS/DUS)",
        ];
        const indexes = Object.fromEntries(
          required.map((header) => [header, headers.indexOf(header)]),
        );
        const missing = required.filter((header) => indexes[header] < 0);
        if (missing.length) {
          throw new Error(`Header tidak ditemukan: ${missing.join(", ")}.`);
        }

        const existingBatchNos = new Set(
          [...(state.spkEntries || []), ...(state.preview.spk || [])].map(
            (item) =>
              String(item.batchNo || "")
                .trim()
                .toLowerCase(),
          ),
        );
        const imported = [];
        const sourceRows = data.slice(headerRowIndex + 1);
        const firstIncompleteRowIndex = sourceRows.findIndex((row) =>
          required.some((header) => !String(row[indexes[header]] || "").trim()),
        );
        const importRows =
          firstIncompleteRowIndex >= 0
            ? sourceRows.slice(0, firstIncompleteRowIndex)
            : sourceRows;
        importRows.forEach((row, rowIndex) => {
          const batchNo = String(row[indexes["NO BATCH"]] || "").trim();
          const merkText = firstSpkImportValue(row[indexes.MERK]);
          const varianText = firstSpkImportValue(row[indexes.VARIAN]);
          const produkText = normalizeSpkProductName(
            firstSpkImportValue(`${merkText} ${varianText}`),
          );
          // Pada merged header, SheetJS menyimpan nilai di sel pertama.
          // indexOf mengambil kolom pertama/paling kiri tersebut.
          const botolText = firstSpkImportValue(row[indexes["BOTOL (MILL)"]]);
          const produksiDusText = String(
            row[indexes["PRODUKSI (DUS)"]] || "",
          ).trim();
          const qtyPerDusText = String(
            row[indexes["QTY/DUS (PCS/DUS)"]] || "",
          ).trim();
          const lineNo = headerRowIndex + rowIndex + 2;
          const importStatus = (row || []).some((cell) =>
            /URGENT/i.test(String(cell || "")),
          )
            ? "urgent"
            : (row || []).some((cell) => /STOCK/i.test(String(cell || "")))
              ? "stock"
              : "normal";
          const batchKey = batchNo.toLowerCase();
          if (existingBatchNos.has(batchKey)) {
            throw new Error(`Baris ${lineNo}: NO BATCH ${batchNo} sudah ada.`);
          }
          if (!merkText) throw new Error(`Baris ${lineNo}: MERK kosong.`);
          if (!varianText) throw new Error(`Baris ${lineNo}: VARIAN kosong.`);
          let produk =
            canonicalMasterValue("produk", produkText) ||
            approximateMasterValue("produk", produkText);
          let botol =
            canonicalMasterValue("botol", botolText) ||
            matchSpkBottleBySize(botolText) ||
            approximateMasterValue("botol", botolText);
          if (!produk) {
            produk = produkText;
          }
          if (!botolText)
            throw new Error(`Baris ${lineNo}: BOTOL (MILL) kosong.`);
          if (!botol) {
            botol = botolText;
          }
          const produksiDus = Math.floor(
            Number(produksiDusText.replace(/[.,\s]/g, "")) || 0,
          );
          const qtyPerDus = Math.floor(
            Number(qtyPerDusText.replace(/[.,\s]/g, "")) || 0,
          );
          if (produksiDus <= 0)
            throw new Error(
              `Baris ${lineNo}: PRODUKSI (DUS) harus lebih dari 0.`,
            );
          if (qtyPerDus <= 0)
            throw new Error(
              `Baris ${lineNo}: QTY/DUS (PCS/DUS) harus lebih dari 0.`,
            );
          const qty = produksiDus * qtyPerDus;
          existingBatchNos.add(batchKey);
          imported.push({
            id: makeClientRequestId(),
            batchNo,
            tanggal: todayStr(),
            produk,
            botol,
            produksiDus,
            qtyPerDus,
            qty,
            imported: true,
            createdAt: nowIso(),
            updatedAt: "",
            updateCount: 0,
            status: importStatus,
          });
        });
        if (!imported.length)
          throw new Error("Tidak ada baris SPK untuk diimport.");
        state.preview.spk.push(...imported);
        state.spk.date = todayStr();
        state.spk.page = 1;
        if (dateFilter) dateFilter.value = state.spk.date;
        persistPreview();
        renderSpkToday();
        toast(`${imported.length} SPK berhasil masuk ke preview.`);
      } catch (err) {
        toast(`Import SPK gagal: ${err.message}`, true);
      }
    });

    const syncCancelState = () => {
      if (!cancelButton) return;
      cancelButton.disabled = !(
        String(batchInput.value || "").trim() &&
        String(produkInput.value || "").trim() &&
        String(botolInput.value || "").trim() &&
        Number(produksiDusInput?.value) > 0 &&
        Number(qtyPerDusInput?.value) > 0
      );
    };
    const syncSpkTotalQty = () => {
      const produksiDus = Math.max(
        0,
        Math.floor(Number(produksiDusInput?.value) || 0),
      );
      const qtyPerDus = Math.max(
        0,
        Math.floor(Number(qtyPerDusInput?.value) || 0),
      );
      if (qtyInput) qtyInput.value = String(produksiDus * qtyPerDus);
      syncCancelState();
    };

    const close = () => {
      modal.hidden = true;
      document.body.classList.remove("spk-popup-open");
      openButton.focus();
    };
    const reset = () => {
      editingSpk = null;
      form.reset();
      batchInput.value = nextSpkBatchNo();
      submitButton.innerHTML = '<i class="fa-solid fa-circle-plus"></i> Tambah';
      submitButton.disabled = false;
      errorEl.hidden = true;
      qsa(".master-search-input", form).forEach((input) => {
        input.setCustomValidity("");
        input.classList.remove("is-invalid");
      });
      syncCancelState();
    };

    openButton.hidden = !canLevel("spk", "write");
    if (importButton) importButton.hidden = !canLevel("spk", "write");
    openButton.addEventListener("click", () => {
      if (!canLevel("spk", "write"))
        return toast("Anda tidak memiliki akses input SPK.", true);
      state.spk.date = todayStr();
      state.spk.page = 1;
      if (dateFilter) dateFilter.value = state.spk.date;
      renderSpkToday();
      closeMasterSuggestions();
      if (!spkFormInitialized) {
        reset();
        spkFormInitialized = true;
      }
      modal.hidden = false;
      document.body.classList.add("spk-popup-open");
      el("spkModalClose")?.focus();
    });
    el("spkModalClose")?.addEventListener("click", close);
    cancelButton?.addEventListener("click", () => {
      reset();
      el("spkModalClose")?.focus();
    });
    produkInput.addEventListener("input", syncCancelState);
    produkInput.addEventListener("change", syncCancelState);
    botolInput.addEventListener("input", syncCancelState);
    botolInput.addEventListener("change", syncCancelState);
    produksiDusInput?.addEventListener("input", syncSpkTotalQty);
    qtyPerDusInput?.addEventListener("input", syncSpkTotalQty);
    modal.addEventListener("keydown", (event) => {
      if (event.key === "Escape") close();
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      errorEl.hidden = true;
      if (
        !validateMasterInput(produkInput) ||
        !validateMasterInput(botolInput)
      ) {
        errorEl.textContent =
          "Nama Produk dan Botol harus dipilih dari data Master.";
        errorEl.hidden = false;
        return;
      }
      const produksiDus = Math.floor(Number(produksiDusInput?.value) || 0);
      const qtyPerDus = Math.floor(Number(qtyPerDusInput?.value) || 0);
      const qty = produksiDus * qtyPerDus;
      if (produksiDus <= 0 || qtyPerDus <= 0) {
        errorEl.textContent = "Produksi (Dus) dan Qty/Dus harus lebih dari 0.";
        errorEl.hidden = false;
        (produksiDus <= 0 ? produksiDusInput : qtyPerDusInput)?.focus();
        return;
      }
      const edit = editingSpk;
      const values = {
        id: edit?.source === "preview" ? edit.key : makeClientRequestId(),
        batchNo: batchInput.value,
        tanggal: todayStr(),
        produk: canonicalMasterValue("produk", produkInput.value),
        botol: canonicalMasterValue("botol", botolInput.value),
        produksiDus,
        qtyPerDus,
        qty,
        imported:
          edit?.source === "preview" &&
          state.preview.spk.find((item) => item.id === edit.key)?.imported ===
            true,
        createdAt:
          edit?.source === "preview"
            ? state.preview.spk.find((item) => item.id === edit.key)
                ?.createdAt || nowIso()
            : nowIso(),
        updatedAt: edit?.source === "preview" ? nowIso() : "",
        updateCount:
          edit?.source === "preview"
            ? Math.max(
                0,
                Math.floor(
                  Number(
                    state.preview.spk.find((item) => item.id === edit.key)
                      ?.updateCount,
                  ) || 0,
                ),
              ) + 1
            : 0,
      };
      if (edit?.source === "saved") {
        submitButton.disabled = true;
        try {
          const response = await enqueueWrite(() =>
            apiPost("spk.update", {
              batchNo: edit.key,
              data: {
                produk: values.produk,
                botol: values.botol,
                produksiDus: values.produksiDus,
                qtyPerDus: values.qtyPerDus,
              },
            }),
          );
          if (response.spk) {
            state.spkEntries = state.spkEntries.map((row) =>
              row.batchNo === edit.key ? response.spk : row,
            );
          }
          renderFillingSpkQueue();
          try {
            await loadAppData();
            toast(
              `SPK ${edit.key} dan data Filling/Press terkait berhasil di-update.`,
            );
          } catch (refreshError) {
            toast(
              `SPK tersimpan, tetapi data terbaru gagal dimuat: ${refreshError.message}. Muat ulang halaman.`,
              true,
            );
          }
        } catch (err) {
          submitButton.disabled = false;
          return toast(`Gagal meng-update SPK: ${err.message}`, true);
        }
      } else if (edit?.source === "preview") {
        state.preview.spk = state.preview.spk.map((item) =>
          item.id === edit.key ? values : item,
        );
        toast(`Preview SPK ${values.batchNo} berhasil di-update.`);
      } else {
        state.preview.spk.push(values);
        toast("SPK ditambahkan ke preview. Belum disimpan ke Spreadsheet.");
      }
      persistPreview();
      renderSpkToday();
      reset();
      if (edit) close();
      else el("spkModalClose")?.focus();
    });

    el("spkTableBody")?.addEventListener("change", (event) => {
      const checkbox = event.target.closest(".spk-row-select");
      if (!checkbox) return;
      const selectionKey = `${checkbox.dataset.source}:${checkbox.dataset.key}`;
      if (checkbox.checked) selectedSpkRows.add(selectionKey);
      else selectedSpkRows.delete(selectionKey);
      renderSpkToday();
    });
    el("spkSelectAll")?.addEventListener("change", (event) => {
      let keys = [];
      try {
        keys = JSON.parse(event.target.dataset.keys || "[]");
      } catch (_) {}
      keys.forEach((key) => {
        if (event.target.checked) selectedSpkRows.add(key);
        else selectedSpkRows.delete(key);
      });
      renderSpkToday();
    });
    el("spkMassDeleteButton")?.addEventListener("click", async () => {
      const selections = Array.from(selectedSpkRows).map((value) => {
        const separator = value.indexOf(":");
        return {
          source: value.slice(0, separator),
          key: value.slice(separator + 1),
        };
      });
      if (!selections.length) return;
      if (
        !(await confirmDelete({
          title: `Hapus ${selections.length} SPK terpilih?`,
          message:
            "Preview akan dihapus dari perangkat dan SPK tersimpan akan dihapus dari Spreadsheet. SPK yang sudah digunakan tidak dapat dihapus.",
          item: `${selections.length} baris SPK`,
        }))
      )
        return;

      const previewIds = selections
        .filter((item) => item.source === "preview")
        .map((item) => item.key);
      const savedBatchNos = selections
        .filter((item) => item.source === "saved")
        .map((item) => item.key);
      const button = el("spkMassDeleteButton");
      button.disabled = true;
      button.textContent = "Menghapus…";
      try {
        if (savedBatchNos.length) {
          await enqueueWrite(() =>
            apiPost("spk.batchDelete", { batchNos: savedBatchNos }),
          );
          const deleted = new Set(savedBatchNos);
          state.spkEntries = state.spkEntries.filter(
            (item) => !deleted.has(String(item.batchNo)),
          );
        }
        if (previewIds.length) {
          const deletedPreview = new Set(previewIds);
          state.preview.spk = state.preview.spk.filter(
            (item) => !deletedPreview.has(String(item.id)),
          );
          persistPreview();
        }
        selectedSpkRows.clear();
        renderSpkToday();
        renderFillingSpkQueue();
        renderSpkReport();
        toast(`${selections.length} SPK berhasil dihapus.`);
      } catch (err) {
        toast(`Gagal menghapus SPK terpilih: ${err.message}`, true);
        renderSpkToday();
      }
    });

    el("spkTableBody")?.addEventListener("click", async (event) => {
      const editButton = event.target.closest(".spk-edit");
      const deleteButton = event.target.closest(".spk-delete");
      const button = editButton || deleteButton;
      if (!button) return;
      const source = button.dataset.source;
      const key = button.dataset.key;
      const item =
        source === "preview"
          ? state.preview.spk.find((row) => row.id === key)
          : state.spkEntries.find((row) => row.batchNo === key);
      if (!item || (source === "saved" && !canManageSpk(item)))
        return toast("Anda tidak memiliki akses mengelola SPK ini.", true);

      if (editButton) {
        spkFormInitialized = true;
        editingSpk = { source, key };
        batchInput.value = item.batchNo;
        produkInput.value = item.produk;
        botolInput.value = item.botol;
        if (produksiDusInput)
          produksiDusInput.value = String(
            Math.max(0, Number(item.produksiDus) || 0),
          );
        if (qtyPerDusInput)
          qtyPerDusInput.value = String(
            Math.max(0, Number(item.qtyPerDus) || 0),
          );
        if (qtyInput)
          qtyInput.value = String(Math.max(0, Number(item.qty) || 0));
        submitButton.innerHTML =
          '<i class="fa-solid fa-cloud-arrow-up"></i> Simpan Update';
        syncCancelState();
        modal.hidden = false;
        document.body.classList.add("spk-popup-open");
        el("spkModalClose")?.focus();
        return;
      }

      if (
        !(await confirmDelete({
          title: "Hapus SPK?",
          message:
            source === "saved"
              ? "SPK tersimpan akan dihapus permanen dari Spreadsheet."
              : "SPK akan dihapus dari daftar preview.",
          item: item.batchNo,
        }))
      )
        return;
      if (source === "preview") {
        state.preview.spk = state.preview.spk.filter((row) => row.id !== key);
        selectedSpkRows.delete(`preview:${key}`);
        persistPreview();
        renderSpkToday();
        return;
      }
      deleteButton.disabled = true;
      try {
        const response = await enqueueWrite(() =>
          apiPost("spk.delete", { batchNo: key }),
        );
        state.spkEntries =
          response.spkEntries ||
          state.spkEntries.filter((row) => row.batchNo !== key);
        selectedSpkRows.delete(`saved:${key}`);
        renderSpkToday();
        renderFillingSpkQueue();
        renderSpkReport();
        toast(`SPK ${key} berhasil dihapus.`);
      } catch (err) {
        deleteButton.disabled = false;
        toast(`Gagal menghapus SPK: ${err.message}`, true);
      }
    });

    el("spkSaveButton")?.addEventListener("click", async () => {
      const rows = [...(state.preview.spk || [])];
      if (!rows.length) return;
      const saveButton = el("spkSaveButton");
      const oldText = saveButton.innerHTML;
      saveButton.disabled = true;
      saveButton.textContent = `Menyimpan ${rows.length} SPK…`;
      try {
        const response = await enqueueWrite(() =>
          apiPost("spk.batchCreate", {
            data: rows.map((item) => ({
              batchNo: item.batchNo,
              produk: item.produk,
              botol: item.botol,
              produksiDus: Math.max(0, Number(item.produksiDus) || 0),
              qtyPerDus: Math.max(0, Number(item.qtyPerDus) || 0),
              imported: item.imported === true,
              updatedAt: item.updatedAt || "",
              updateCount: Math.max(
                0,
                Math.floor(Number(item.updateCount) || 0),
              ),
              status: item.status || "normal",
            })),
          }),
        );
        if (Array.isArray(response.saved)) {
          const savedBatchNos = new Set(
            response.saved.map((item) => String(item.batchNo)),
          );
          state.spkEntries = state.spkEntries
            .filter((item) => !savedBatchNos.has(String(item.batchNo)))
            .concat(response.saved);
          state.master.produk = [
            ...new Set(
              [
                ...(state.master.produk || []),
                ...response.saved.map((item) =>
                  String(item.produk || "").trim(),
                ),
              ].filter(Boolean),
            ),
          ];
          state.master.botol = [
            ...new Set(
              [
                ...(state.master.botol || []),
                ...response.saved.map((item) =>
                  String(item.botol || "").trim(),
                ),
              ].filter(Boolean),
            ),
          ];
          state.master.botolpecah = [
            ...new Set(
              [
                ...(state.master.botolpecah || []),
                ...response.saved.map((item) =>
                  String(item.botol || "").trim(),
                ),
              ].filter(Boolean),
            ),
          ];
          try {
            localStorage.setItem(
              CONFIG.MASTER_KEY,
              JSON.stringify(state.master),
            );
          } catch (_) {}
        }
        state.preview.spk = [];
        selectedSpkRows.clear();
        persistPreview();
        renderFillingSpkQueue();
        toast(`${rows.length} SPK berhasil disimpan ke Spreadsheet.`);
      } catch (err) {
        toast(`Gagal menyimpan SPK: ${err.message}`, true);
      } finally {
        saveButton.innerHTML = oldText;
        renderSpkToday();
      }
    });
    renderSpkToday();
  }

  function initDashboard() {
    if (!el("view-dashboard")) return;
    /* =====================================================
     FILTER CHART DASHBOARD
     ===================================================== */
    const today = dashboardDateParts(todayStr()) || new Date();
    const currentMonth = dashboardMonthKey(today);
    const currentYear = String(today.getFullYear());

    if (!state.dashboard.chartMonth) {
      state.dashboard.chartMonth = currentMonth;
    }
    if (!state.dashboard.chartYear) {
      state.dashboard.chartYear = currentYear;
    }
    const modeInput = el("dashboardChartMode");
    const monthInput = el("dashboardChartMonth");
    const yearInput = el("dashboardChartYear");
    const startInput = el("dashboardChartStart");
    const endInput = el("dashboardChartEnd");
    const pressKpiModeInput = el("dashboardPressKpiMode");
    const pressKpiOperatorInput = el("dashboardPressKpiOperator");
    const pressKpiOperatorClear = el("dashboardPressKpiOperatorClear");
    const pressKpiMonthInput = el("dashboardPressKpiMonth");
    const pressKpiYearInput = el("dashboardPressKpiYear");
    const pressKpiStartInput = el("dashboardPressKpiStart");
    const pressKpiEndInput = el("dashboardPressKpiEnd");

    if (!state.dashboard.pressKpiMonth)
      state.dashboard.pressKpiMonth = currentMonth;
    if (!state.dashboard.pressKpiYear)
      state.dashboard.pressKpiYear = currentYear;

    function updatePressKpiFilterUI() {
      const mode = state.dashboard.pressKpiMode || "month";
      if (el("dashboardPressKpiMonthWrap"))
        el("dashboardPressKpiMonthWrap").hidden = mode !== "month";
      if (el("dashboardPressKpiYearWrap"))
        el("dashboardPressKpiYearWrap").hidden = mode !== "year";
      if (el("dashboardPressKpiStartWrap"))
        el("dashboardPressKpiStartWrap").hidden = mode !== "range";
      if (el("dashboardPressKpiEndWrap"))
        el("dashboardPressKpiEndWrap").hidden = mode !== "range";
    }

    if (pressKpiModeInput)
      pressKpiModeInput.value = state.dashboard.pressKpiMode || "month";
    if (pressKpiOperatorInput)
      pressKpiOperatorInput.value = state.dashboard.pressKpiOperator || "";
    if (pressKpiMonthInput)
      pressKpiMonthInput.value = state.dashboard.pressKpiMonth;
    if (pressKpiYearInput)
      pressKpiYearInput.value = state.dashboard.pressKpiYear;
    if (pressKpiStartInput)
      pressKpiStartInput.value = state.dashboard.pressKpiStart || "";
    if (pressKpiEndInput)
      pressKpiEndInput.value = state.dashboard.pressKpiEnd || "";
    updatePressKpiFilterUI();

    const rerenderPressKpi = () => {
      state.dashboard.pressKpiPage = 1;
      renderDashboardPressKpi(dashboardEntries());
    };
    const updatePressKpiOperatorClear = () => {
      if (pressKpiOperatorClear) {
        pressKpiOperatorClear.hidden = !String(
          pressKpiOperatorInput?.value || "",
        ).trim();
      }
    };
    pressKpiModeInput?.addEventListener("change", () => {
      state.dashboard.pressKpiMode = pressKpiModeInput.value;
      updatePressKpiFilterUI();
      rerenderPressKpi();
    });
    const syncPressKpiOperatorFilter = () => {
      state.dashboard.pressKpiOperator = String(
        pressKpiOperatorInput?.value || "",
      ).trim();
      updatePressKpiOperatorClear();
      rerenderPressKpi();
    };
    pressKpiOperatorInput?.addEventListener(
      "input",
      syncPressKpiOperatorFilter,
    );
    pressKpiOperatorInput?.addEventListener(
      "change",
      syncPressKpiOperatorFilter,
    );
    pressKpiOperatorClear?.addEventListener("click", () => {
      if (pressKpiOperatorInput) pressKpiOperatorInput.value = "";
      state.dashboard.pressKpiOperator = "";
      updatePressKpiOperatorClear();
      rerenderPressKpi();
      pressKpiOperatorInput?.focus();
    });
    updatePressKpiOperatorClear();
    pressKpiMonthInput?.addEventListener("change", () => {
      state.dashboard.pressKpiMonth = pressKpiMonthInput.value || currentMonth;
      rerenderPressKpi();
    });
    pressKpiYearInput?.addEventListener("change", () => {
      state.dashboard.pressKpiYear = pressKpiYearInput.value || currentYear;
      rerenderPressKpi();
    });
    pressKpiStartInput?.addEventListener("change", () => {
      state.dashboard.pressKpiStart = pressKpiStartInput.value;
      rerenderPressKpi();
    });
    pressKpiEndInput?.addEventListener("change", () => {
      state.dashboard.pressKpiEnd = pressKpiEndInput.value;
      rerenderPressKpi();
    });
    let dashboardDamageResizeTimer = 0;
    window.addEventListener("resize", () => {
      window.clearTimeout(dashboardDamageResizeTimer);
      dashboardDamageResizeTimer = window.setTimeout(() => {
        if (!el("view-dashboard")?.hidden) rerenderPressKpi();
      }, 120);
    });

    if (modeInput) {
      modeInput.value = state.dashboard.chartMode;
    }
    if (monthInput) {
      monthInput.value = state.dashboard.chartMonth;
    }
    if (yearInput) {
      yearInput.value = state.dashboard.chartYear;
    }
    updateDashboardChartFilterUI();
    modeInput?.addEventListener("change", () => {
      state.dashboard.chartMode = modeInput.value;
      updateDashboardChartFilterUI();
      renderDashboardWeekly(dashboardEntries());
    });

    monthInput?.addEventListener("change", () => {
      state.dashboard.chartMonth = monthInput.value;
      renderDashboardWeekly(dashboardEntries());
    });

    yearInput?.addEventListener("change", () => {
      state.dashboard.chartYear = yearInput.value;
      renderDashboardWeekly(dashboardEntries());
    });

    startInput?.addEventListener("change", () => {
      state.dashboard.chartStart = startInput.value;
      if (state.dashboard.chartMode === "range") {
        renderDashboardWeekly(dashboardEntries());
      }
    });

    endInput?.addEventListener("change", () => {
      state.dashboard.chartEnd = endInput.value;
      if (state.dashboard.chartMode === "range") {
        renderDashboardWeekly(dashboardEntries());
      }
    });
    const refreshBtn = el("dashboardRefresh");
    refreshBtn?.addEventListener("click", async () => {
      refreshBtn.disabled = true;
      const oldText = refreshBtn.textContent;
      refreshBtn.textContent = "Menyegarkan…";
      try {
        await loadAppData();
        renderDashboard();
        toast("Dashboard berhasil diperbarui.");
      } catch (err) {
        toast(`Gagal memperbarui dashboard: ${err.message}`, true);
      } finally {
        refreshBtn.disabled = false;
        refreshBtn.textContent = oldText;
      }
    });

    el("dashboardPriorityBody")?.addEventListener("click", (event) => {
      const btn = event.target.closest(".dashboard-work-btn");
      if (!btn || btn.disabled) return;
      if (!canLevel("press", "write"))
        return toast("Anda tidak memiliki akses Press.", true);

      const pressTab = qs('.tab-btn[data-view="press"]');
      if (!pressTab || pressTab.hidden)
        return toast("Tab Press tidak tersedia untuk user ini.", true);
      pressTab.click();

      const section = el("view-press");
      const form = section ? qs(".form-panel", section) : null;
      if (!form) return;
      const produk = qs(".f-produk", form);
      const botol = qs(".f-botol", form);
      if (produk) {
        produk.value = btn.dataset.produk || "";
        produk.dispatchEvent(new Event("change", { bubbles: true }));
      }
      if (botol) {
        botol.value = btn.dataset.botol || "";
        botol.dispatchEvent(new Event("change", { bubbles: true }));
      }
      updatePressAvailabilityHint(form);
      saveFormDraft("press", form);
      form.scrollIntoView({ behavior: "smooth", block: "start" });
    });

    renderDashboard();
    renderFillingSpkQueue();
  }

  function initTabs() {
    const tabbar = el("mainTabbar");
    if (!tabbar) return;
    let handlingTabHistory = false;
    tabbar.addEventListener("click", (event) => {
      const btn = event.target.closest(".tab-btn");
      if (!btn || !state.currentUser) return;
      if (btn.classList.contains("active")) {
        event.preventDefault();
        return;
      }
      const view = btn.dataset.view;
      const permissionMap = {
        dashboard: "accessDashboard",
        spk: "accessSpk",
        filling: "accessFilling",
        press: "accessPress",
        apd: "accessApd",
        laporan: "accessReports",
        master: "accessMaster",
      };

      const permisson = permissionMap[view];
      if (
        !permisson ||
        !(view === "laporan"
          ? canOpenReports()
          : view === "master"
            ? can("accessMaster") || can("accessKpiSettings")
            : can(permisson))
      ) {
        event.preventDefault();
        return;
      }

      if (btn.matches("a[href]")) {
        event.preventDefault();
        if (btn.classList.contains("active")) return;
        if (!allAppViewsLoaded) {
          sessionStorage.setItem("lapInternalNavigation", "1");
          window.location.href = btn.href;
          return;
        }
      }
      // const allowed = view === "dashboard" ? can("accessDashboard")
      //   : view === "filling" ? can("accessFilling")
      //     : view === "press" ? can("accessPress")
      //       : view === "laporan" ? can("accessReports")
      //         : view === "master" ? can("accessMaster") : false;
      // if (!allowed) return;

      qsa(".tab-btn", tabbar).forEach((node) => {
        node.classList.toggle("active", node === btn);
      });
      if (view !== "press") closePressFormPopup();
      if (view !== "filling") closeFillingFormPopup();
      qsa(".content > .view").forEach((node) => {
        node.hidden = node.id !== "view-" + view;
      });
      if (view === "filling") maybeOpenFillingDowntimeModal();
      if (view === "laporan") {
        window.refreshLaporanAutoPreview?.();
        window.refreshKpiLaporanAutoPreview?.();
      }
      if (!handlingTabHistory) {
        try {
          history.pushState({ appTab: true, view }, "", `#${view}`);
        } catch (error) {
          console.debug("Riwayat tab tidak dapat diperbarui:", error);
        }
      }
    });

    const initialView = qs(".tab-btn.active", tabbar)?.dataset.view;
    if (initialView) {
      try {
        history.replaceState(
          { appTab: true, view: initialView },
          "",
          `#${initialView}`,
        );
      } catch (_) {}
    }

    window.addEventListener("popstate", (event) => {
      const view =
        event.state?.appTab && event.state?.view
          ? event.state.view
          : window.location.hash.replace(/^#/, "");
      const target = qs(`.tab-btn[data-view="${view}"]`, tabbar);
      if (!target || target.classList.contains("active")) return;
      handlingTabHistory = true;
      target.click();
      handlingTabHistory = false;
    });

    // Tombol samping mouse harus mengikuti urutan tab aplikasi, bukan membuka
    // dokumen lama dari browser history. Button 3 = Previous, button 4 = Next.
    let pendingMouseTabDirection = 0;
    const mouseTabDirection = (event) =>
      event.button === 3 ? -1 : event.button === 4 ? 1 : 0;
    const preventMouseHistory = (event) => {
      const direction = mouseTabDirection(event);
      if (!direction) return;
      event.preventDefault();
      event.stopPropagation();
      pendingMouseTabDirection = direction;
    };
    window.addEventListener("mousedown", preventMouseHistory, {
      capture: true,
      passive: false,
    });
    window.addEventListener(
      "mouseup",
      (event) => {
        const direction = mouseTabDirection(event) || pendingMouseTabDirection;
        if (!direction) return;
        event.preventDefault();
        event.stopPropagation();
        pendingMouseTabDirection = 0;

        const tabs = qsa(".tab-btn", tabbar).filter((node) => !node.hidden);
        const currentIndex = tabs.findIndex((node) =>
          node.classList.contains("active"),
        );
        if (currentIndex < 0) return;
        const targetIndex = currentIndex + direction;
        if (targetIndex < 0 || targetIndex >= tabs.length) return;
        tabs[targetIndex].click();
      },
      { capture: true, passive: false },
    );
    window.addEventListener(
      "auxclick",
      (event) => {
        if (!mouseTabDirection(event)) return;
        event.preventDefault();
        event.stopPropagation();
      },
      { capture: true, passive: false },
    );
  }

  /* ------------------------- LAPORAN ------------------------- */
  function laporanMetricColumns(
    lineValue = state.lastLaporan?.line || el("lap-line")?.value || "all",
  ) {
    const line = String(lineValue || "all").toLowerCase();
    const columns = [{ key: "_kpiResult", label: "KPI Hasil", tone: "result" }];

    // KPI Kardus Basah hanya relevan untuk Filling, sedangkan KPI Botol Rusak
    // hanya relevan untuk Press. Pada Semua Line keduanya ditampilkan.
    if (line === "all" || line === "filling") {
      columns.push({
        key: "_kpiWetCarton",
        label: "KPI Kardus Basah",
        tone: "wet",
      });
    }
    if (line === "all" || line === "press") {
      columns.push({
        key: "_kpiBroken",
        label: "KPI Botol Pecah",
        tone: "reject",
      });
    }

    columns.push({ key: "_kpiApd", label: "KPI APD", tone: "apd" });
    return columns;
  }

  function laporanMetricCellHtml(entry, column) {
    return `<td><span class="dashboard-kpi-percent ${esc(column.tone)}">${kpiReportDisplay(entry[column.key])}</span></td>`;
  }

  function laporanLineLabel(line) {
    return line === "combined" ? "Filling + Press" : LINE_LABEL[line] || line;
  }

  function updateUniqueLaporanFilter(id, rows, field, placeholder) {
    const select = el(id);
    if (!select) return;
    const current = select.value;
    const uniqueValues = new Map();
    rows.forEach((entry) => {
      const value = String(entry?.[field] || "").trim();
      const key = value.toLocaleLowerCase("id");
      if (value && !uniqueValues.has(key)) uniqueValues.set(key, value);
    });
    const values = [...uniqueValues.values()].sort((a, b) =>
      a.localeCompare(b, "id", { sensitivity: "base" }),
    );
    select.innerHTML =
      `<option value="">${esc(placeholder)}</option>` +
      values
        .map((value) => `<option value="${esc(value)}">${esc(value)}</option>`)
        .join("");
    select.value = values.includes(current) ? current : "";
    if (id === "lap-operator-filter") updateLaporanEmployeeFilterLabel();
  }

  function updateLaporanEmployeeFilterLabel() {
    const select = el("lap-operator-filter");
    const summary = el("lap-employee-filter-summary");
    if (!select || !summary) return;
    const label = select.value
      ? `Filter Advance: ${select.value}`
      : "Filter Advance";
    summary.setAttribute("aria-label", label);
    summary.dataset.tooltip = label;
  }

  function syncLaporanKeywordVisibility() {
    const toggle = el("lap-employee-filter-summary");
    const employeeWrap = el("lap-employee-filter-field");
    const keywordWrap = el("lap-keyword-filter");
    const keywordInput = el("lap-search");
    const advancedActive = toggle?.getAttribute("aria-pressed") === "true";
    toggle?.classList.toggle("active", advancedActive);
    if (employeeWrap) employeeWrap.hidden = !advancedActive;
    if (keywordWrap) keywordWrap.hidden = advancedActive;
    if (advancedActive && keywordInput) keywordInput.value = "";
  }

  function aggregateLaporanRows(rows) {
    const groups = new Map();
    rows.forEach((entry) => {
      const key = [
        entry.operator,
        entry.produk,
        entry.botol,
        Number(entry.qtyBotolPerKardus) || 0,
      ]
        .map((value) =>
          String(value || "")
            .trim()
            .toLocaleLowerCase("id"),
        )
        .join("||");
      if (!groups.has(key)) {
        groups.set(key, {
          ...entry,
          qtyKardus: 0,
          totalQty: 0,
          qtyBotolPecah: 0,
          qtyKardusBasah: 0,
          _dates: new Set(),
          _batches: new Set(),
          _apdValues: [],
          _resultValues: [],
          _lines: new Set(),
          _fillingKardus: 0,
          _fillingWet: 0,
          _fillingBroken: 0,
          _pressQty: 0,
          _pressBroken: 0,
          _qtyPerCartonValues: new Set(),
          _allPcs: true,
        });
      }
      const group = groups.get(key);
      group.qtyKardus += Number(entry.qtyKardus) || 0;
      group.totalQty += Number(entry.totalQty) || 0;
      group.qtyBotolPecah += Number(entry.qtyBotolPecah) || 0;
      group.qtyKardusBasah += Number(entry.qtyKardusBasah) || 0;
      group._lines.add(entry.tab);
      if (entry.tab === "filling") {
        group._fillingKardus += Number(entry.qtyKardus) || 0;
        group._fillingWet += Number(entry.qtyKardusBasah) || 0;
        group._fillingBroken += Number(entry.qtyBotolPecah) || 0;
      } else if (entry.tab === "press") {
        group._pressQty += Number(entry.totalQty) || 0;
        group._pressBroken += Number(entry.qtyBotolPecah) || 0;
      }
      group._allPcs = group._allPcs && Number(entry.qtyBotolPerKardus) === 1;
      if (Number(entry.qtyBotolPerKardus) > 0) {
        group._qtyPerCartonValues.add(Number(entry.qtyBotolPerKardus));
      }
      if (entry.tanggal) group._dates.add(String(entry.tanggal));
      const batch = entryBatchNo(entry);
      if (batch) group._batches.add(String(batch));
      if (Number.isFinite(Number(entry._kpiApd))) {
        group._apdValues.push(Number(entry._kpiApd));
      }
      if (Number.isFinite(Number(entry._kpiResult))) {
        group._resultValues.push(Number(entry._kpiResult));
      }
    });

    return [...groups.values()].map((group) => {
      const dates = [...group._dates].sort();
      const batches = [...group._batches];
      const lines = [...group._lines];
      const isFilling = lines.length === 1 && lines[0] === "filling";
      const isPress = lines.length === 1 && lines[0] === "press";
      group.tab = lines.length === 1 ? lines[0] : "combined";
      group.tanggal =
        dates.length <= 1 ? dates[0] || "—" : `${dates[0]} – ${dates.at(-1)}`;
      group.batchNo =
        batches.length <= 1 ? batches[0] || "—" : `${batches.length} batch`;
      group.reportId = group.batchNo;
      group.batchNumbers = batches;
      const qtyPerCartonValues = [...group._qtyPerCartonValues];
      group.qtyBotolPerKardus =
        qtyPerCartonValues.length === 1 ? qtyPerCartonValues[0] : null;
      group._kpiResult = averageKpiValues(group._resultValues);
      group._kpiWetCarton = isPress
        ? null
        : kpiFillingSpillPercent(group._fillingWet, group._fillingKardus);
      group._kpiBroken = isFilling
        ? null
        : kpiVariantDefectPercent(group._pressBroken, group._pressQty);
      group._kpiApd = averageKpiValues(group._apdValues);
      group.qtyBotolPecahFilling = group._fillingBroken;
      group.qtyBotolPecahPress = group._pressBroken;
      delete group._dates;
      delete group._batches;
      delete group._apdValues;
      delete group._resultValues;
      delete group._lines;
      delete group._fillingKardus;
      delete group._fillingWet;
      delete group._fillingBroken;
      delete group._pressQty;
      delete group._pressBroken;
      delete group._qtyPerCartonValues;
      delete group._allPcs;
      return group;
    });
  }

  function renderLaporanRows() {
    if (!state.lastLaporan) return;
    const sourceRows = state.lastLaporan.rows;
    const tbody = el("lap-tbody");
    if (!tbody) return;

    const metricColumns = laporanMetricColumns(state.lastLaporan.line);
    const showFillingBroken = state.lastLaporan.line !== "press";
    const showPressBroken = state.lastLaporan.line !== "filling";
    const table = tbody.closest("table");
    const headerRow = table?.querySelector("thead tr");
    if (headerRow) {
      headerRow.innerHTML = `
        <th>No Batch</th><th>Line</th><th>Tanggal</th><th>Operator</th><th>Produk</th><th>Botol</th><th>Qty Botol (Kardus)</th><th>Pengerjaan</th><th>Total Qty</th>${showFillingBroken ? "<th>Botol Pecah Filling</th>" : ""}${showPressBroken ? "<th>Botol Pecah Press</th>" : ""}
        ${metricColumns.map((column) => `<th>${esc(column.label)}</th>`).join("")}
      `;
    }

    const rows = applyExcelDataFilter(
      table,
      sourceRows,
      [
        (e) => entryBatchNo(e) || e.reportId,
        (e) => laporanLineLabel(e.tab),
        (e) => e.tanggal,
        (e) => e.operator,
        (e) => e.produk,
        (e) => e.botol,
        (e) => laporanQtyPerCartonDisplay(e),
        (e) => e.qtyKardus,
        (e) => e.totalQty,
        (e) => laporanBrokenFilling(e),
        (e) => laporanBrokenPress(e),
      ],
      renderLaporanRows,
    );
    const totalPages = Math.max(1, Math.ceil(rows.length / CONFIG.PAGE_SIZE));
    state.pages.laporan = Math.min(
      Math.max(1, state.pages.laporan),
      totalPages,
    );
    const page = state.pages.laporan;
    const start = (page - 1) * CONFIG.PAGE_SIZE;
    const visible = rows.slice(start, start + CONFIG.PAGE_SIZE);

    tbody.innerHTML = visible
      .map(
        (e) => `
      <tr>
        <td><span class="id-badge"${e.batchNumbers?.length > 1 ? ` title="${esc("No batch: " + e.batchNumbers.join(", "))}" style="cursor: help"` : ""}>${esc(entryBatchNo(e) || e.reportId)}</span></td>
        <td>${esc(laporanLineLabel(e.tab))}</td>
        <td>${esc(e.tanggal)}</td>
        <td>${esc(e.operator)}</td>
        <td>${esc(e.produk)}</td>
        <td>${esc(e.botol)}</td>
        <td>${esc(laporanQtyPerCartonDisplay(e))}</td>
        <td>${(Number(e.qtyKardus) || 0).toLocaleString("id-ID")} ${laporanQtyUnit(e)}</td>
        <td><strong>${Number(e.totalQty) || 0}</strong></td>
        ${showFillingBroken ? `<td>${laporanBrokenFilling(e).toLocaleString("id-ID")}</td>` : ""}
        ${showPressBroken ? `<td>${laporanBrokenPress(e).toLocaleString("id-ID")}</td>` : ""}
        ${metricColumns.map((column) => laporanMetricCellHtml(e, column)).join("")}
      </tr>`,
      )
      .join("");

    const from = rows.length ? start + 1 : 0;
    const to = Math.min(start + CONFIG.PAGE_SIZE, rows.length);
    el("lap-page-summary").textContent =
      `${from}–${to} dari ${rows.length} entri · Halaman ${page} dari ${totalPages}`;
    renderPagination(el("lap-pagination"), page, totalPages, (nextPage) => {
      state.pages.laporan = nextPage;
      renderLaporanRows();
    });
  }

  function laporanQtyUnit(entry) {
    return Number(entry.qtyBotolPerKardus) === 1 ? "Pcs" : "Kardus";
  }

  function laporanQtyPerCartonDisplay(entry) {
    const value = Number(entry.qtyBotolPerKardus);
    return value > 0 ? value.toLocaleString("id-ID") : "Beragam";
  }

  function laporanBrokenFilling(entry) {
    return entry.tab === "filling"
      ? Number(entry.qtyBotolPecah) || 0
      : Number(entry.qtyBotolPecahFilling) || 0;
  }

  function laporanBrokenPress(entry) {
    return entry.tab === "press"
      ? Number(entry.qtyBotolPecah) || 0
      : Number(entry.qtyBotolPecahPress) || 0;
  }

  function laporanQtyTotals(rows) {
    return rows.reduce(
      (totals, entry) => {
        const key = laporanQtyUnit(entry) === "Pcs" ? "pcs" : "kardus";
        totals[key] += Number(entry.qtyKardus) || 0;
        return totals;
      },
      { kardus: 0, pcs: 0 },
    );
  }

  function buildLaporanPrintHtml(options = {}) {
    if (
      !state.lastLaporan ||
      !Array.isArray(state.lastLaporan.rows) ||
      !state.lastLaporan.rows.length
    ) {
      return "";
    }

    const rows = state.lastLaporan.rows;
    const reportId = state.lastLaporan.id || genLaporanId();
    const title = options.title || "Laporan Hasil Pengerjaan";
    const created = el("lap-created")?.textContent || fmtDateTime(nowIso());
    const by = el("lap-by")?.textContent || "—";
    const period = el("lap-period")?.textContent || "Semua tanggal";
    const metricColumns = laporanMetricColumns(state.lastLaporan.line);

    const { kardus: totalKardus, pcs: totalPcs } = laporanQtyTotals(rows);
    const totalQty = rows.reduce(
      (sum, e) => sum + (Number(e.totalQty) || 0),
      0,
    );
    const totalPecah = rows.reduce(
      (sum, e) => sum + (Number(e.qtyBotolPecah) || 0),
      0,
    );
    const totalKardusBasah = rows.reduce(
      (sum, e) => sum + (Number(e.qtyKardusBasah) || 0),
      0,
    );
    const reportLine = String(state.lastLaporan.line || "all").toLowerCase();
    const showFillingBroken = reportLine !== "press";
    const showPressBroken = reportLine !== "filling";
    const fourthStatTotal =
      reportLine === "filling" ? totalKardusBasah : totalPecah;
    const fourthStatLabel =
      reportLine === "filling" ? "Total Kardus Basah" : "Total Botol Pecah";
    const showFourthStat = reportLine !== "all";
    const printStatColumns = showFourthStat ? 5 : 4;
    const fourthStatHtml = showFourthStat
      ? `<div class="stat"><strong>${fourthStatTotal.toLocaleString("id-ID")}</strong><span>${esc(fourthStatLabel)}</span></div>`
      : "";

    const bodyRows = rows
      .map(
        (e) => `
      <tr>
        <td class="mono">${esc(entryBatchNo(e) || e.reportId)}</td>
        <td>${esc(laporanLineLabel(e.tab))}</td>
        <td>${esc(e.tanggal)}</td>
        <td>${esc(e.operator)}</td>
        <td class="wrap">${esc(e.produk)}</td>
        <td class="wrap">${esc(e.botol)}</td>
        <td class="num">${esc(laporanQtyPerCartonDisplay(e))}</td>
        <td class="num">${(Number(e.qtyKardus) || 0).toLocaleString("id-ID")} ${laporanQtyUnit(e)}</td>
        <td class="num">${(Number(e.totalQty) || 0).toLocaleString("id-ID")}</td>
        ${showFillingBroken ? `<td class="num">${laporanBrokenFilling(e).toLocaleString("id-ID")}</td>` : ""}
        ${showPressBroken ? `<td class="num">${laporanBrokenPress(e).toLocaleString("id-ID")}</td>` : ""}
        ${metricColumns.map((column) => `<td class="num">${esc(kpiReportDisplay(e[column.key]))}</td>`).join("")}
      </tr>`,
      )
      .join("");

    return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(reportId)}</title>
  <style>
    @page { size: A4 landscape; margin: 8mm; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #fff; color: #111827; }
    body { font-family: Arial, Helvetica, sans-serif; font-size: 9px; line-height: 1.35; }
    .report { width: 100%; }
    .header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; margin-bottom: 8px; }
    .company { font-size: 8px; font-weight: 700; letter-spacing: .08em; color: #8a4a0c; text-transform: uppercase; margin-bottom: 2px; }
    h1 { margin: 0; font-size: 16px; line-height: 1.2; }
    .report-id { margin-top: 4px; font-family: Consolas, monospace; font-weight: 700; font-size: 10px; }
    .meta { min-width: 260px; text-align: right; font-size: 8px; line-height: 1.55; }
    .meta div { white-space: nowrap; }
    .stats { display: grid; grid-template-columns: repeat(${printStatColumns}, 1fr); gap: 6px; margin: 0 0 8px; }
    .stat { border: 1px solid #d1d5db; padding: 5px 7px; text-align: center; border-radius: 4px; }
    .stat strong { display: block; font-size: 12px; }
    .stat span { display: block; margin-top: 1px; font-size: 7px; color: #4b5563; text-transform: uppercase; }
    table { width: 100%; border-collapse: collapse; table-layout: auto; }
    thead { display: table-header-group; }
    tfoot { display: table-footer-group; }
    tr { break-inside: avoid; page-break-inside: avoid; }
    th, td { border: 1px solid #cfd6dd; padding: 3px 4px; vertical-align: top; }
    th { background: #eef2f5; font-size: 7.4px; text-transform: uppercase; letter-spacing: .02em; text-align: left; }
    td { font-size: 7.8px; }
    .mono { font-family: Consolas, "Courier New", monospace; font-size: 7.2px; }
    .num { text-align: right; white-space: nowrap; }
    .wrap { overflow-wrap: anywhere; word-break: break-word; }
    th, td { word-break: break-word; }
    .footer-note { margin-top: 6px; color: #6b7280; font-size: 7px; text-align: right; }
    @media print {
      html, body { width: 100%; }
      .report { break-after: auto; }
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
  </style>
</head>
<body>
  <main class="report">
    <section class="header">
      <div>
        <div class="company">PT. ABSH FRAGRANCE CREATIONS</div>
        <h1>${esc(title)}</h1>
        <div class="report-id">${esc(reportId)}</div>
      </div>
      <div class="meta">
        <div><strong>Dibuat:</strong> ${esc(created)}</div>
        <div><strong>Oleh:</strong> ${esc(by)}</div>
        <div><strong>Periode:</strong> ${esc(period)}</div>
      </div>
    </section>

    <section class="stats">
      <div class="stat"><strong>${rows.length.toLocaleString("id-ID")}</strong><span>Total Entri</span></div>
      <div class="stat"><strong>${totalKardus.toLocaleString("id-ID")}</strong><span>Total Kardus</span></div>
      <div class="stat"><strong>${totalPcs.toLocaleString("id-ID")}</strong><span>Total Pcs</span></div>
      <div class="stat"><strong>${totalQty.toLocaleString("id-ID")}</strong><span>Total Qty Botol</span></div>
      ${fourthStatHtml}
    </section>

    <table>
      <thead>
        <tr>
          <th>No Batch</th><th>Line</th><th>Tanggal</th><th>Operator</th><th>Produk</th><th>Botol</th><th>Qty Botol (Kardus)</th><th>Pengerjaan</th><th>Total Qty</th>${showFillingBroken ? "<th>Botol Pecah Filling</th>" : ""}${showPressBroken ? "<th>Botol Pecah Press</th>" : ""}${metricColumns.map((column) => `<th>${esc(column.label)}</th>`).join("")}
        </tr>
      </thead>
      <tbody>${bodyRows}</tbody>
    </table>
    <div class="footer-note">Total ${rows.length.toLocaleString("id-ID")} entri — seluruh data laporan dicetak tanpa pagination.</div>
  </main>
</body>
</html>`;
  }

  function openLaporanPrintDialog(mode = "pdf") {
    if (!state.lastLaporan || !state.lastLaporan.rows?.length) {
      toast("Buat laporan terlebih dahulu sebelum export/cetak.", true);
      return;
    }

    const html = buildLaporanPrintHtml({
      title:
        mode === "pdf"
          ? "Laporan Hasil Pengerjaan"
          : "Laporan Hasil Pengerjaan",
    });
    if (!html) {
      toast("Data laporan tidak tersedia.", true);
      return;
    }

    // Dibuka langsung dari event klik agar tidak dianggap popup oleh browser.
    const printWindow = window.open("", "_blank", "width=1280,height=860");
    if (!printWindow) {
      toast(
        "Popup diblokir browser. Izinkan popup untuk melakukan Export PDF/Cetak.",
        true,
      );
      return;
    }

    printWindow.document.open();
    printWindow.document.write(html);
    printWindow.document.close();

    const doPrint = () => {
      try {
        printWindow.focus();
        printWindow.print();
      } catch (err) {
        toast(`Gagal membuka dialog cetak: ${err.message}`, true);
      }
    };

    if (printWindow.document.readyState === "complete") {
      setTimeout(doPrint, 250);
    } else {
      printWindow.addEventListener("load", () => setTimeout(doPrint, 250), {
        once: true,
      });
    }

    if (mode === "pdf") {
      toast("Dialog PDF dibuka. Pilih 'Save as PDF' / 'Simpan sebagai PDF'.");
    }
  }

  // Target harian KPI Hasil untuk setiap varian/baris pengerjaan produksi.
  const KPI_VARIANT_DAILY_TARGETS = Object.freeze({
    filling: 7500,
    press: 3500,
  });

  function kpiVariantDefectPercent(defectQty, productionQty) {
    const defect = Math.max(0, Number(defectQty) || 0);
    const production = Math.max(0, Number(productionQty) || 0);
    return production > 0 ? (defect / production) * 100 : null;
  }

  // Perhitungan laporan KPI operator bulanan tetap menggunakan target yang
  // dapat diatur dari menu Setting.
  const KPI_WORKING_DAYS_PER_MONTH = 20;

  function kpiDailyOutputTarget(line) {
    const monthlyTarget =
      String(line || "").toLowerCase() === "press"
        ? getKpiPressOutputTarget()
        : getKpiFillingOutputTarget();
    return Math.max(1, Number(monthlyTarget) || 0) / KPI_WORKING_DAYS_PER_MONTH;
  }

  function kpiFillingOutputAchievement(totalQty) {
    const actual = Math.max(0, Number(totalQty) || 0);
    const monthlyTarget = Math.max(
      1,
      Number(getKpiFillingOutputTarget()) ||
        KPI_FILLING_DEFAULTS.outputTargetMonthly,
    );
    return actual > 0
      ? (actual / monthlyTarget) * KPI_FILLING_DEFAULTS.weights.output
      : null;
  }

  function kpiOperatorKey(value) {
    return String(value || "")
      .normalize("NFKC")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function kpiOperatorIdentityKey(value) {
    return kpiOperatorKey(value)
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]/g, "");
  }

  function kpiDateKey(value) {
    const raw = String(value || "").trim();
    const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(raw);
    if (iso) {
      return `${iso[1]}-${String(Number(iso[2])).padStart(2, "0")}-${String(Number(iso[3])).padStart(2, "0")}`;
    }
    const localized = /^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/.exec(raw);
    if (localized) {
      return `${localized[3]}-${String(Number(localized[2])).padStart(2, "0")}-${String(Number(localized[1])).padStart(2, "0")}`;
    }
    return raw;
  }

  function kpiPercentageNumber(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    const normalized = String(value ?? "")
      .trim()
      .replace(/\s/g, "")
      .replace(/%$/, "")
      .replace(",", ".");
    if (!normalized) return null;
    const number = Number(normalized);
    return Number.isFinite(number) ? number : null;
  }

  function kpiNameSimilarity(left, right) {
    const a = kpiOperatorIdentityKey(left);
    const b = kpiOperatorIdentityKey(right);
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.includes(b) || b.includes(a)) {
      return Math.min(a.length, b.length) / Math.max(a.length, b.length);
    }

    const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i += 1) {
      const current = [i];
      for (let j = 1; j <= b.length; j += 1) {
        current[j] = Math.min(
          current[j - 1] + 1,
          previous[j] + 1,
          previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
        );
      }
      previous.splice(0, previous.length, ...current);
    }
    return 1 - previous[b.length] / Math.max(a.length, b.length);
  }

  function averageKpiValues(values) {
    const valid = (values || [])
      .filter(
        (value) =>
          value !== null &&
          value !== undefined &&
          Number.isFinite(Number(value)),
      )
      .map(Number);
    return valid.length
      ? valid.reduce((sum, value) => sum + value, 0) / valid.length
      : null;
  }

  function kpiReportDisplay(value) {
    return value === null ||
      value === undefined ||
      !Number.isFinite(Number(value))
      ? "—"
      : dashboardPercent(Number(value));
  }

  function kpiReportPeriodFromInputs() {
    const mode = el("lap-period-mode")?.value || "";
    const ALL_START = new Date(1900, 0, 1);
    const ALL_END = new Date(2999, 11, 31);

    // Seluruh filter periode bersifat opsional. Jika periode atau nilainya
    // belum dipilih, laporan tidak dibatasi oleh tanggal.
    const allPeriod = () => ({
      mode: "all",
      start: ALL_START,
      end: ALL_END,
      label: "Semua tanggal",
      averagingLabel: "Rata-rata KPI harian seluruh data",
    });

    if (!mode) return allPeriod();

    if (mode === "month") {
      const value = String(el("lap-month")?.value || "").trim();
      if (!/^\d{4}-\d{2}$/.test(value)) return allPeriod();
      const [year, month] = value.split("-").map(Number);
      const start = new Date(year, month - 1, 1);
      const end = new Date(year, month, 0);
      return {
        mode,
        start,
        end,
        label: start.toLocaleDateString("id-ID", {
          month: "long",
          year: "numeric",
        }),
        averagingLabel: "Rata-rata KPI harian",
      };
    }

    if (mode === "year") {
      const rawYear = String(el("lap-year")?.value || "").trim();
      const year = Number(rawYear);
      if (!rawYear || !Number.isInteger(year) || year < 1900 || year > 2999)
        return allPeriod();
      return {
        mode,
        start: new Date(year, 0, 1),
        end: new Date(year, 11, 31),
        label: `Tahun ${year}`,
        averagingLabel: "Rata-rata KPI bulanan",
      };
    }

    if (mode === "range") {
      const rawStart = String(el("lap-start")?.value || "").trim();
      const rawEnd = String(el("lap-end")?.value || "").trim();
      if (!rawStart && !rawEnd) return allPeriod();

      let start = dashboardDateParts(rawStart) || ALL_START;
      let end = dashboardDateParts(rawEnd) || ALL_END;
      if (start > end) [start, end] = [end, start];

      let label = "Semua tanggal";
      if (rawStart && rawEnd)
        label = `${dashboardDateKey(start)} s/d ${dashboardDateKey(end)}`;
      else if (rawStart) label = `Mulai ${dashboardDateKey(start)}`;
      else if (rawEnd) label = `Sampai ${dashboardDateKey(end)}`;

      return {
        mode,
        start,
        end,
        label,
        averagingLabel: "Rata-rata KPI harian",
      };
    }

    if (mode === "date") {
      const dateText = String(el("lap-date")?.value || "").trim();
      const date = dashboardDateParts(dateText);
      if (!date) return allPeriod();
      return {
        mode: "date",
        start: date,
        end: date,
        label: dashboardDateKey(date),
        averagingLabel: "KPI tanggal terpilih",
      };
    }

    return allPeriod();
  }

  function buildEmployeeKpiRows(period, operatorName = "") {
    const selectedOperator = kpiOperatorKey(operatorName);
    const operators = new Map();

    function ensureOperator(name) {
      const clean = String(name || "").trim();
      if (!clean) return null;
      const key = kpiOperatorKey(clean);
      if (selectedOperator && key !== selectedOperator) return null;
      if (!operators.has(key)) {
        operators.set(key, {
          operator: clean,
          pressByDate: new Map(),
          fillingByDate: new Map(),
          apdByDate: new Map(),
        });
      }
      return operators.get(key);
    }

    (state.reportEntries || [])
      .filter(
        (entry) =>
          !entry._syncState &&
          entry.tab === "press" &&
          dashboardDateInPeriod(entry.tanggal, period),
      )
      .forEach((entry) => {
        const row = ensureOperator(entry.operator);
        if (!row) return;
        const dateKey = String(entry.tanggal || "");
        if (!row.pressByDate.has(dateKey))
          row.pressByDate.set(dateKey, { total: 0, broken: 0 });
        const day = row.pressByDate.get(dateKey);
        day.total += Number(entry.totalQty) || 0;
        // KPI Botol Rusak hanya mengambil kerusakan dari tab Press.
        day.broken += Number(entry.qtyBotolPecah) || 0;
      });

    (state.reportEntries || [])
      .filter(
        (entry) =>
          !entry._syncState &&
          entry.tab === "filling" &&
          dashboardDateInPeriod(entry.tanggal, period),
      )
      .forEach((entry) => {
        const row = ensureOperator(entry.operator);
        if (!row) return;
        const dateKey = String(entry.tanggal || "");
        if (!row.fillingByDate.has(dateKey)) {
          row.fillingByDate.set(dateKey, {
            total: 0,
            workedCartons: 0,
            wetCartons: 0,
          });
        }
        const day = row.fillingByDate.get(dateKey);
        day.total += Number(entry.totalQty) || 0;
        day.workedCartons += Number(entry.qtyKardus) || 0;
        day.wetCartons += Number(entry.qtyKardusBasah) || 0;
      });

    // APD berlaku untuk operator pada tanggal/periode yang sama, baik operator tersebut
    // sedang mengerjakan Filling maupun Press. Key operator dinormalisasi agar data lama
    // yang berbeda spasi/non-breaking-space tetap dapat dipasangkan.
    (state.apdEntries || [])
      .filter((item) => item && dashboardDateInPeriod(item.tanggal, period))
      .forEach((item) => {
        const row = ensureOperator(item.operator);
        if (!row) return;
        const dateKey = String(item.tanggal || "");
        if (!row.apdByDate.has(dateKey)) row.apdByDate.set(dateKey, []);
        row.apdByDate.get(dateKey).push(Number(item.percentage) || 0);
      });

    const pressDailyTarget = kpiDailyOutputTarget("press");

    return Array.from(operators.values())
      .map((row) => {
        const dailyPress = Array.from(row.pressByDate.entries()).map(
          ([date, value]) => ({
            date,
            month: date.slice(0, 7),
            kpiResult:
              value.total > 0 ? (value.total / pressDailyTarget) * 100 : null,
            kpiBroken:
              value.total > 0 ? (value.broken / value.total) * 100 : null,
          }),
        );

        const dailyFilling = Array.from(row.fillingByDate.entries()).map(
          ([date, value]) => ({
            date,
            month: date.slice(0, 7),
            total: Number(value.total) || 0,
            kpiWetCarton: kpiFillingSpillPercent(
              value.wetCartons,
              value.workedCartons,
            ),
          }),
        );

        // KPI Filling OUTPUT harus identik dengan baris OUTPUT pada Laporan KPI Filling.
        // Karena targetnya bulanan, jumlahkan aktual per bulan terlebih dahulu, lalu terapkan bobot 40.
        const fillingOutputByMonth = new Map();
        dailyFilling.forEach((item) => {
          fillingOutputByMonth.set(
            item.month,
            (fillingOutputByMonth.get(item.month) || 0) + item.total,
          );
        });
        const monthlyFillingResult = Array.from(
          fillingOutputByMonth.entries(),
        ).map(([month, total]) => ({
          month,
          kpiResult: kpiFillingOutputAchievement(total),
        }));

        const dailyApd = Array.from(row.apdByDate.entries()).map(
          ([date, values]) => ({
            date,
            month: date.slice(0, 7),
            value: averageKpiValues(values),
          }),
        );

        let kpiResultPress = null;
        let kpiResultFilling = null;
        let kpiWetCarton = null;
        let kpiBroken = null;
        let kpiApd = null;

        if (period.mode === "date") {
          const dateKey = dashboardDateKey(period.start);
          const pressDay = dailyPress.find((item) => item.date === dateKey);
          const fillingDay = dailyFilling.find((item) => item.date === dateKey);
          const apdDay = dailyApd.find((item) => item.date === dateKey);
          kpiResultPress = pressDay ? pressDay.kpiResult : null;
          // Untuk satu tanggal, aktual tanggal tersebut tetap dibandingkan ke target bulanan
          // dan dikalikan bobot OUTPUT 40, sama seperti kartu KPI Filling.
          kpiResultFilling = fillingDay
            ? kpiFillingOutputAchievement(fillingDay.total)
            : null;
          kpiWetCarton = fillingDay ? fillingDay.kpiWetCarton : null;
          kpiBroken = pressDay ? pressDay.kpiBroken : null;
          kpiApd = apdDay ? apdDay.value : null;
        } else if (period.mode === "year") {
          const monthlyKeys = new Set([
            ...dailyPress.map((item) => item.month),
            ...dailyFilling.map((item) => item.month),
            ...dailyApd.map((item) => item.month),
          ]);
          const monthlyPressResult = [];
          const monthlyWetCarton = [];
          const monthlyBroken = [];
          const monthlyApd = [];
          monthlyKeys.forEach((monthKey) => {
            monthlyPressResult.push(
              averageKpiValues(
                dailyPress
                  .filter((item) => item.month === monthKey)
                  .map((item) => item.kpiResult),
              ),
            );
            monthlyWetCarton.push(
              averageKpiValues(
                dailyFilling
                  .filter((item) => item.month === monthKey)
                  .map((item) => item.kpiWetCarton),
              ),
            );
            monthlyBroken.push(
              averageKpiValues(
                dailyPress
                  .filter((item) => item.month === monthKey)
                  .map((item) => item.kpiBroken),
              ),
            );
            monthlyApd.push(
              averageKpiValues(
                dailyApd
                  .filter((item) => item.month === monthKey)
                  .map((item) => item.value),
              ),
            );
          });
          kpiResultPress = averageKpiValues(monthlyPressResult);
          kpiResultFilling = averageKpiValues(
            monthlyFillingResult.map((item) => item.kpiResult),
          );
          kpiWetCarton = averageKpiValues(monthlyWetCarton);
          kpiBroken = averageKpiValues(monthlyBroken);
          kpiApd = averageKpiValues(monthlyApd);
        } else {
          // Bulan / rentang / semua periode:
          // Press mempertahankan rata-rata KPI harian. Filling menggunakan capaian OUTPUT
          // bulanan yang sama dengan Laporan KPI Filling; jika mencakup >1 bulan, dirata-ratakan per bulan.
          kpiResultPress = averageKpiValues(
            dailyPress.map((item) => item.kpiResult),
          );
          kpiResultFilling = averageKpiValues(
            monthlyFillingResult.map((item) => item.kpiResult),
          );
          kpiWetCarton = averageKpiValues(
            dailyFilling.map((item) => item.kpiWetCarton),
          );
          kpiBroken = averageKpiValues(
            dailyPress.map((item) => item.kpiBroken),
          );
          kpiApd = averageKpiValues(dailyApd.map((item) => item.value));
        }

        return {
          operator: row.operator,
          kpiResultPress,
          kpiResultFilling,
          kpiWetCarton,
          kpiBroken,
          kpiApd,
        };
      })
      .filter(
        (row) =>
          row.kpiResultPress !== null ||
          row.kpiResultFilling !== null ||
          row.kpiWetCarton !== null ||
          row.kpiBroken !== null ||
          row.kpiApd !== null,
      )
      .sort((a, b) => a.operator.localeCompare(b.operator, "id"));
  }

  const KPI_PRESS_DEFAULTS = Object.freeze({
    outputTargetMonthly: 70000,
    rejectTargetPercent: 1,
    apdTargetPercent: 95,
    attendanceTargetPercent: 100,
    weights: Object.freeze({
      output: 40,
      quality: 30,
      apd: 15,
      attendance: 15,
    }),
  });
  const SHIFT_LEADER_MASTER_NAME = "ARUNG GILANG SAMPURNA";

  function getShiftLeaderName() {
    const target = SHIFT_LEADER_MASTER_NAME.toLowerCase();
    return (
      (state.master.operator || []).find(
        (name) =>
          String(name || "")
            .trim()
            .toLowerCase() === target,
      ) || SHIFT_LEADER_MASTER_NAME
    );
  }

  const KPI_FILLING_DEFAULTS = Object.freeze({
    outputTargetMonthly: 150000,
    spillTargetPercent: 1,
    wetCartonDailyLimit: 5,
    apdTargetPercent: 95,
    attendanceTargetPercent: 100,
    weights: Object.freeze({
      output: 40,
      quality: 30,
      apd: 15,
      attendance: 15,
    }),
  });

  function normalizeKpiType(value) {
    const type = String(value || "").toLowerCase();
    return ["press", "shift", "spv"].includes(type) ? type : "filling";
  }

  function kpiTypeLabel(type) {
    const normalized = normalizeKpiType(type);
    return normalized === "spv"
      ? "SPV Produksi"
      : normalized === "shift"
        ? "Ka. Shift"
        : normalized === "press"
          ? "Press"
          : "Filling";
  }

  function getKpiPressOutputTarget() {
    const saved = Math.round(
      Number(state.settings?.kpiPressOutputTargetMonthly) || 0,
    );
    return saved > 0 ? saved : KPI_PRESS_DEFAULTS.outputTargetMonthly;
  }

  function getKpiFillingOutputTarget() {
    const saved = Math.round(
      Number(state.settings?.kpiFillingOutputTargetMonthly) || 0,
    );
    return saved > 0 ? saved : KPI_FILLING_DEFAULTS.outputTargetMonthly;
  }

  function getKpiOutputTarget(type) {
    return normalizeKpiType(type) === "press"
      ? getKpiPressOutputTarget()
      : getKpiFillingOutputTarget();
  }

  function applyKpiPressSettings(settings) {
    if (!settings || typeof settings !== "object")
      return getKpiPressOutputTarget();
    const target = Math.round(
      Number(settings.kpiPressOutputTargetMonthly) || 0,
    );
    if (target > 0) state.settings.kpiPressOutputTargetMonthly = target;
    return getKpiPressOutputTarget();
  }

  function applyKpiFillingSettings(settings) {
    if (!settings || typeof settings !== "object")
      return getKpiFillingOutputTarget();
    const target = Math.round(
      Number(settings.kpiFillingOutputTargetMonthly) || 0,
    );
    if (target > 0) state.settings.kpiFillingOutputTargetMonthly = target;
    return getKpiFillingOutputTarget();
  }

  async function saveKpiOutputTargets(fillingValue, pressValue) {
    const fillingTarget = Math.round(Number(fillingValue) || 0);
    const pressTarget = Math.round(Number(pressValue) || 0);

    if (fillingTarget <= 0) {
      throw new Error("Target Output KPI Filling / Bulan harus lebih dari 0.");
    }
    if (pressTarget <= 0) {
      throw new Error("Target Output KPI Press / Bulan harus lebih dari 0.");
    }

    const response = await apiPost("settings.kpiTargets.set", {
      fillingValue: fillingTarget,
      pressValue: pressTarget,
    });
    applyKpiFillingSettings(response.settings);
    applyKpiPressSettings(response.settings);
    return {
      filling: getKpiFillingOutputTarget(),
      press: getKpiPressOutputTarget(),
    };
  }

  function renderKpiPressSetting() {
    const target = getKpiPressOutputTarget();
    const input = el("setting-kpi-press-output-target");
    const current = el("setting-kpi-press-current");
    if (input && document.activeElement !== input) input.value = String(target);
    if (current)
      current.textContent = `${kpiPressQtyText(target)} botol / bulan`;
  }

  function renderKpiFillingSetting() {
    const target = getKpiFillingOutputTarget();
    const input = el("setting-kpi-filling-output-target");
    const current = el("setting-kpi-filling-current");
    if (input && document.activeElement !== input) input.value = String(target);
    if (current)
      current.textContent = `${kpiPressQtyText(target)} botol / bulan`;
  }

  function initKpiSettings() {
    renderKpiFillingSetting();
    renderKpiPressSetting();

    const saveBtn = el("setting-kpi-save-all");
    const fillingInput = el("setting-kpi-filling-output-target");
    const pressInput = el("setting-kpi-press-output-target");
    if (!saveBtn || !fillingInput || !pressInput) return;

    saveBtn.addEventListener("click", async () => {
      if (!canLevel("kpiSettings", "write")) {
        return toast("Anda tidak memiliki akses Setting.", true);
      }

      const fillingValue = Math.round(Number(fillingInput.value) || 0);
      const pressValue = Math.round(Number(pressInput.value) || 0);
      if (fillingValue <= 0) {
        toast("Target Output KPI Filling / Bulan harus lebih dari 0.", true);
        fillingInput.focus();
        return;
      }
      if (pressValue <= 0) {
        toast("Target Output KPI Press / Bulan harus lebih dari 0.", true);
        pressInput.focus();
        return;
      }

      const oldText = saveBtn.innerHTML;
      saveBtn.disabled = true;
      fillingInput.disabled = true;
      pressInput.disabled = true;
      saveBtn.innerHTML =
        '<i class="fa-solid fa-spinner fa-spin"></i> Menyimpan Semua...';

      try {
        const targets = await saveKpiOutputTargets(fillingValue, pressValue);
        fillingInput.value = String(targets.filling);
        pressInput.value = String(targets.press);
        renderKpiFillingSetting();
        renderKpiPressSetting();

        if (typeof window.refreshKpiLaporanAutoPreview === "function") {
          window.refreshKpiLaporanAutoPreview();
        }

        toast(
          `Semua target KPI tersimpan. Filling: ${kpiPressQtyText(targets.filling)} botol/bulan · Press: ${kpiPressQtyText(targets.press)} botol/bulan.`,
        );
      } catch (err) {
        const message =
          /settings\.kpiTargets\.set|action|tidak dikenal|unknown/i.test(
            String(err?.message || ""),
          )
            ? "Backend Apps Script belum mendukung penyimpanan semua target KPI sekaligus. Deploy Code.gs terbaru lalu coba kembali."
            : err.message;
        toast(message, true);
      } finally {
        saveBtn.disabled = false;
        fillingInput.disabled = false;
        pressInput.disabled = false;
        saveBtn.innerHTML = oldText;
      }
    });
  }

  function initInputDataCleanup() {
    const button = el("clearAllInputDataButton");
    if (!button) return;
    button.addEventListener("click", async () => {
      if (state.currentUser?.role !== "superuser") {
        return toast("Aksi ini hanya dapat dilakukan Super User.", true);
      }
      const confirmed = await confirmDelete({
        title: "Hapus seluruh data input?",
        message:
          "Semua data operasional di Spreadsheet akan dihapus permanen. Master, Users, dan Settings tetap dipertahankan.",
        item: "Pengerjaan, SPK, APD, Press, arsip, sisa, dan data operasional lainnya",
      });
      if (!confirmed) return;

      const phrase = window.prompt(
        'Ketik "HAPUS SEMUA DATA" untuk melanjutkan:',
        "",
      );
      if (phrase !== "HAPUS SEMUA DATA") {
        return toast(
          "Penghapusan dibatalkan karena teks konfirmasi tidak sesuai.",
          true,
        );
      }

      const oldHtml = button.innerHTML;
      button.disabled = true;
      button.innerHTML =
        '<i class="fa-solid fa-spinner fa-spin"></i> Menghapus Data...';
      try {
        await enqueueWrite(() =>
          apiPost("maintenance.inputData.clear", { confirmation: phrase }),
        );
        state.preview = { spk: [], filling: [], press: [], apd: [] };
        state.previewDeletedEntryAudits = [];
        localStorage.removeItem(userStorageKey(CONFIG.PREVIEW_KEY));
        localStorage.removeItem(userStorageKey(CONFIG.FORM_DRAFT_KEY));
        toast("Semua data input berhasil dihapus.");
        setTimeout(() => window.location.reload(), 900);
      } catch (err) {
        toast(`Gagal menghapus data input: ${err.message}`, true);
        button.disabled = false;
        button.innerHTML = oldHtml;
      }
    });
  }

  function initSettingCards() {
    qsa("#view-master .master-layout > section.panel").forEach(
      (card, index) => {
        const header = qs(":scope > .panel-head", card);
        if (!header || header.dataset.collapseReady === "1") return;

        const title =
          qs("h2", header)?.textContent?.trim() || `Pengaturan ${index + 1}`;
        const contentId = card.id
          ? `${card.id}-content`
          : `setting-card-content-${index + 1}`;
        card.classList.add("settings-card", "is-collapsed");
        header.dataset.collapseReady = "1";
        header.setAttribute("role", "button");
        header.setAttribute("tabindex", "0");
        header.setAttribute("aria-expanded", "false");
        header.setAttribute("aria-controls", contentId);
        header.setAttribute("aria-label", `Buka ${title}`);

        Array.from(card.children).forEach((child) => {
          if (child !== header) child.classList.add("settings-card-content");
        });
        const firstContent = qs(":scope > .settings-card-content", card);
        if (firstContent) firstContent.id = contentId;

        const indicator = document.createElement("span");
        indicator.className = "settings-card-toggle";
        indicator.setAttribute("aria-hidden", "true");
        indicator.innerHTML = '<i class="fa-solid fa-chevron-down"></i>';
        header.appendChild(indicator);

        const toggle = () => {
          const collapsed = card.classList.toggle("is-collapsed");
          header.setAttribute("aria-expanded", String(!collapsed));
          header.setAttribute(
            "aria-label",
            `${collapsed ? "Buka" : "Tutup"} ${title}`,
          );
        };
        header.addEventListener("click", (event) => {
          if (event.target.closest("button, input, select, textarea, a"))
            return;
          toggle();
        });
        header.addEventListener("keydown", (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          toggle();
        });
      },
    );
  }

  function kpiPressMonthPeriod(monthValue) {
    const value = String(monthValue || "").trim();
    if (!/^\d{4}-\d{2}$/.test(value)) return null;
    const [year, month] = value.split("-").map(Number);
    if (
      !Number.isInteger(year) ||
      !Number.isInteger(month) ||
      month < 1 ||
      month > 12
    )
      return null;
    const start = new Date(year, month - 1, 1);
    const end = new Date(year, month, 0);
    return {
      mode: "month",
      value,
      start,
      end,
      label: start.toLocaleDateString("id-ID", {
        month: "long",
        year: "numeric",
      }),
    };
  }

  function kpiPressPercentText(value, digits = 2) {
    if (
      value === null ||
      value === undefined ||
      !Number.isFinite(Number(value))
    )
      return "—";
    return `${Number(value).toLocaleString("id-ID", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    })}%`;
  }

  function kpiPressScoreText(value) {
    const number = Number(value) || 0;
    return number.toLocaleString("id-ID", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  function kpiAchievementColorClass(achievement, weight) {
    const actual = Number(achievement) || 0;
    const target = Number(weight) || 0;
    // Toleransi mengikuti tampilan capaian yang menggunakan dua desimal.
    if (Math.abs(actual - target) < 0.005) return "kpi-score-equal";
    return actual < target ? "kpi-score-below" : "kpi-score-above";
  }

  function kpiPressQtyText(value) {
    return (Number(value) || 0).toLocaleString("id-ID");
  }

  function buildKpiApdActual(operatorKey, period) {
    const normalizedOperatorKey = kpiOperatorIdentityKey(operatorKey);
    const periodEntries = (state.apdEntries || []).filter(
      (item) => item && dashboardDateInPeriod(kpiDateKey(item.tanggal), period),
    );
    const exactEntries = periodEntries.filter(
      (item) => kpiOperatorIdentityKey(item.operator) === normalizedOperatorKey,
    );

    let matchedEntries = exactEntries;
    if (!matchedEntries.length) {
      const candidates = new Map();
      periodEntries.forEach((item) => {
        const name = String(item.operator || "").trim();
        const key = kpiOperatorIdentityKey(name);
        if (!key || candidates.has(key)) return;
        candidates.set(key, {
          key,
          similarity: kpiNameSimilarity(operatorKey, name),
        });
      });
      const ranked = Array.from(candidates.values()).sort(
        (a, b) => b.similarity - a.similarity,
      );
      const best = ranked[0];
      const second = ranked[1];
      if (
        best &&
        best.similarity >= 0.85 &&
        (!second || best.similarity - second.similarity >= 0.05)
      ) {
        matchedEntries = periodEntries.filter(
          (item) => kpiOperatorIdentityKey(item.operator) === best.key,
        );
      }
    }

    const apdByDate = new Map();
    matchedEntries.forEach((item) => {
      const dateKey = kpiDateKey(item.tanggal);
      const percentage = kpiPercentageNumber(item.percentage);
      if (percentage === null) return;
      if (!apdByDate.has(dateKey)) apdByDate.set(dateKey, []);
      apdByDate.get(dateKey).push(percentage);
    });

    const apdDailyValues = Array.from(apdByDate.values()).map((values) =>
      averageKpiValues(values),
    );
    return averageKpiValues(apdDailyValues);
  }

  function buildKpiAttendance(operatorProduction, savedProduction) {
    // Acuan kehadiran satu periode adalah jumlah hari kerja unik terbanyak
    // yang dicatat oleh seorang karyawan pada periode tersebut. Beberapa entri
    // pada tanggal yang sama tetap dihitung sebagai satu hari hadir.
    const attendanceByOperator = new Map();
    (savedProduction || []).forEach((entry) => {
      const employeeKey = kpiOperatorIdentityKey(entry?.operator);
      const dateKey = kpiDateKey(entry?.tanggal);
      if (!employeeKey || !dateKey) return;
      if (!attendanceByOperator.has(employeeKey)) {
        attendanceByOperator.set(employeeKey, new Set());
      }
      attendanceByOperator.get(employeeKey).add(dateKey);
    });

    let productionDates = new Set();
    attendanceByOperator.forEach((dates) => {
      if (dates.size > productionDates.size) productionDates = dates;
    });
    const presentDates = new Set(
      operatorProduction
        .map((entry) => kpiDateKey(entry.tanggal))
        .filter(Boolean),
    );
    const attendanceActual = productionDates.size
      ? Math.min(100, (presentDates.size / productionDates.size) * 100)
      : 0;

    return {
      productionDates,
      presentDates,
      attendanceActual,
    };
  }

  function buildPressKpiReport(
    operatorName,
    monthValue,
    outputTargetMonthly = getKpiPressOutputTarget(),
  ) {
    const operator = String(operatorName || "").trim();
    const operatorKey = kpiOperatorKey(operator);
    const period = kpiPressMonthPeriod(monthValue);
    if (!operator || !period) return null;

    const savedProduction = (state.reportEntries || []).filter(
      (entry) =>
        entry &&
        !entry._syncState &&
        (entry.tab === "filling" || entry.tab === "press") &&
        dashboardDateInPeriod(entry.tanggal, period),
    );

    const operatorProduction = savedProduction.filter(
      (entry) => kpiOperatorKey(entry.operator) === operatorKey,
    );

    const pressEntries = operatorProduction.filter(
      (entry) => entry.tab === "press",
    );
    if (!pressEntries.length) return null;

    const pressByDate = new Map();
    pressEntries.forEach((entry) => {
      const dateKey = String(entry.tanggal || "");
      if (!pressByDate.has(dateKey))
        pressByDate.set(dateKey, { total: 0, broken: 0 });
      const day = pressByDate.get(dateKey);
      day.total += Number(entry.totalQty) || 0;
      day.broken += Number(entry.qtyBotolPecah) || 0;
    });

    const outputActual = pressEntries.reduce(
      (sum, entry) => sum + (Number(entry.totalQty) || 0),
      0,
    );
    const rejectDailyValues = Array.from(pressByDate.values())
      .filter((day) => day.total > 0)
      .map((day) => (day.broken / day.total) * 100);
    const rejectActual = averageKpiValues(rejectDailyValues);

    const apdActual = buildKpiApdActual(operatorKey, period);
    const { productionDates, presentDates, attendanceActual } =
      buildKpiAttendance(operatorProduction, savedProduction);

    const outputTarget = Math.max(
      1,
      Number(outputTargetMonthly) || getKpiPressOutputTarget(),
    );
    const outputScore =
      (outputActual / outputTarget) * KPI_PRESS_DEFAULTS.weights.output;

    let qualityScore = 0;
    if (outputActual > 0 && rejectActual !== null) {
      qualityScore =
        rejectActual <= KPI_PRESS_DEFAULTS.rejectTargetPercent
          ? KPI_PRESS_DEFAULTS.weights.quality
          : (KPI_PRESS_DEFAULTS.rejectTargetPercent / rejectActual) *
            KPI_PRESS_DEFAULTS.weights.quality;
    }

    const apdScore =
      apdActual === null
        ? 0
        : (apdActual / 100) * KPI_PRESS_DEFAULTS.weights.apd;

    const attendanceScore =
      (attendanceActual / KPI_PRESS_DEFAULTS.attendanceTargetPercent) *
      KPI_PRESS_DEFAULTS.weights.attendance;

    const rows = [
      {
        no: 1,
        field: "OUTPUT",
        indicator: "PENCAPAIAN TARGET",
        weight: KPI_PRESS_DEFAULTS.weights.output,
        targetText: `>${kpiPressQtyText(outputTarget)} / BULAN`,
        targetPercent: 100,
        actualValue: outputActual,
        actualText: kpiPressQtyText(outputActual),
        achievement: outputScore,
        tone: "output",
      },
      {
        no: 2,
        field: "KUALITAS",
        indicator: "TINGKAT KERUSAKAN BOTOL",
        weight: KPI_PRESS_DEFAULTS.weights.quality,
        targetText: "PRESENTASE RATA-RATA < 1%",
        targetPercent: 100,
        actualValue: rejectActual,
        actualText:
          outputActual > 0 ? kpiPressPercentText(rejectActual || 0, 2) : "—",
        achievement: qualityScore,
        tone: "quality",
      },
      {
        no: 3,
        field: "KEPATUHAN",
        indicator: "PEMAKAIAN APD",
        weight: KPI_PRESS_DEFAULTS.weights.apd,
        targetText: "RATA-RATA ≥ 95%",
        targetPercent: 100,
        actualValue: apdActual,
        actualText: kpiPressPercentText(apdActual, 2),
        achievement: apdScore,
        tone: "apd",
      },
      {
        no: 4,
        field: "ABSENSI",
        indicator: "KEHADIRAN",
        weight: KPI_PRESS_DEFAULTS.weights.attendance,
        targetText: "FULL 100%",
        targetPercent: 100,
        actualValue: attendanceActual,
        actualText: kpiPressPercentText(attendanceActual, 2),
        achievement: attendanceScore,
        tone: "attendance",
      },
    ];

    const totalAchievement = rows.reduce(
      (sum, row) => sum + (Number(row.achievement) || 0),
      0,
    );

    return {
      kpiType: "press",
      lineLabel: "Press",
      operator,
      period,
      outputTarget,
      outputActual,
      rejectActual,
      apdActual,
      attendanceActual,
      productionDays: productionDates.size,
      presentDays: presentDates.size,
      lineDays: pressByDate.size,
      pressDays: pressByDate.size,
      rows,
      totalAchievement,
    };
  }

  function kpiFillingSpillPercent(
    qtyWetCartons,
    qtyWorkedCartons,
    wetCartonLimit = KPI_FILLING_DEFAULTS.wetCartonDailyLimit,
  ) {
    const wet = Math.max(0, Number(qtyWetCartons) || 0);
    const worked = Math.max(0, Number(qtyWorkedCartons) || 0);
    const limit = Math.max(0, Number(wetCartonLimit) || 0);

    if (wet <= 0) return 0;
    if (wet <= limit) return 1;

    // Batas 5 kardus basah diterapkan pada total pengerjaan satu hari.
    // Denominator minimum 1 hanya sebagai pengaman bila ada data lama yang Qty Pengerjaan-nya 0.
    return 1 + ((wet - limit) / Math.max(1, worked)) * 30;
  }

  function buildFillingKpiReport(
    operatorName,
    monthValue,
    outputTargetMonthly = getKpiFillingOutputTarget(),
  ) {
    const operator = String(operatorName || "").trim();
    const operatorKey = kpiOperatorKey(operator);
    const period = kpiPressMonthPeriod(monthValue);
    if (!operator || !period) return null;

    const savedProduction = (state.reportEntries || []).filter(
      (entry) =>
        entry &&
        !entry._syncState &&
        (entry.tab === "filling" || entry.tab === "press") &&
        dashboardDateInPeriod(entry.tanggal, period),
    );

    const operatorProduction = savedProduction.filter(
      (entry) => kpiOperatorKey(entry.operator) === operatorKey,
    );

    const fillingEntries = operatorProduction.filter(
      (entry) => entry.tab === "filling",
    );
    if (!fillingEntries.length) return null;

    const outputActual = fillingEntries.reduce(
      (sum, entry) => sum + (Number(entry.totalQty) || 0),
      0,
    );
    const wetCartonsActual = fillingEntries.reduce(
      (sum, entry) => sum + (Number(entry.qtyKardusBasah) || 0),
      0,
    );
    const workedCartonsActual = fillingEntries.reduce(
      (sum, entry) => sum + (Number(entry.qtyKardus) || 0),
      0,
    );

    const fillingByDate = new Map();
    fillingEntries.forEach((entry) => {
      const dateKey = kpiDateKey(entry.tanggal);
      if (!fillingByDate.has(dateKey)) {
        fillingByDate.set(dateKey, { workedCartons: 0, wetCartons: 0 });
      }
      const day = fillingByDate.get(dateKey);
      day.workedCartons += Number(entry.qtyKardus) || 0;
      day.wetCartons += Number(entry.qtyKardusBasah) || 0;
    });

    // Seluruh pengerjaan pada tanggal yang sama digabung lebih dahulu. Hari aktif
    // ditentukan dari Qty Pengerjaan Kardus, bukan dari nilai KPI. Karena itu,
    // hari dengan pengerjaan dan 0 kardus basah tetap masuk sebagai nilai 0%,
    // sedangkan tanggal tanpa Qty Pengerjaan tidak ikut dihitung.
    const spillDailyValues = Array.from(fillingByDate.values())
      .filter((day) => day.workedCartons > 0)
      .map((day) => kpiFillingSpillPercent(day.wetCartons, day.workedCartons));
    const spillActual = averageKpiValues(spillDailyValues);

    const apdActual = buildKpiApdActual(operatorKey, period);
    const { productionDates, presentDates, attendanceActual } =
      buildKpiAttendance(operatorProduction, savedProduction);

    const outputTarget = Math.max(
      1,
      Number(outputTargetMonthly) || getKpiFillingOutputTarget(),
    );
    const outputScore =
      (outputActual / outputTarget) * KPI_FILLING_DEFAULTS.weights.output;

    let qualityScore = 0;
    if (spillActual !== null) {
      qualityScore =
        spillActual <= KPI_FILLING_DEFAULTS.spillTargetPercent
          ? KPI_FILLING_DEFAULTS.weights.quality
          : (KPI_FILLING_DEFAULTS.spillTargetPercent / spillActual) *
            KPI_FILLING_DEFAULTS.weights.quality;
    }

    const apdScore =
      apdActual === null
        ? 0
        : (apdActual / 100) * KPI_FILLING_DEFAULTS.weights.apd;

    const attendanceScore =
      (attendanceActual / KPI_FILLING_DEFAULTS.attendanceTargetPercent) *
      KPI_FILLING_DEFAULTS.weights.attendance;

    const rows = [
      {
        no: 1,
        field: "OUTPUT",
        indicator: "PENCAPAIAN TARGET",
        weight: KPI_FILLING_DEFAULTS.weights.output,
        targetText: `>${kpiPressQtyText(outputTarget)} / BULAN`,
        targetPercent: 100,
        actualValue: outputActual,
        actualText: kpiPressQtyText(outputActual),
        achievement: outputScore,
        tone: "output",
      },
      {
        no: 2,
        field: "KUALITAS",
        indicator: "MEMINIMALISIR TUMPAHAN",
        weight: KPI_FILLING_DEFAULTS.weights.quality,
        targetText: `MAX ${KPI_FILLING_DEFAULTS.wetCartonDailyLimit} DUS BASAH PER HARI`,
        targetPercent: 100,
        actualValue: spillActual,
        actualText: kpiPressPercentText(spillActual, 2),
        achievement: qualityScore,
        tone: "quality",
      },
      {
        no: 3,
        field: "KEPATUHAN",
        indicator: "PEMAKAIAN APD",
        weight: KPI_FILLING_DEFAULTS.weights.apd,
        targetText: "RATA-RATA > 95%",
        targetPercent: 100,
        actualValue: apdActual,
        actualText: kpiPressPercentText(apdActual, 2),
        achievement: apdScore,
        tone: "apd",
      },
      {
        no: 4,
        field: "ABSENSI",
        indicator: "KEHADIRAN",
        weight: KPI_FILLING_DEFAULTS.weights.attendance,
        targetText: "FULL 100%",
        targetPercent: 100,
        actualValue: attendanceActual,
        actualText: kpiPressPercentText(attendanceActual, 2),
        achievement: attendanceScore,
        tone: "attendance",
      },
    ];

    const totalAchievement = rows.reduce(
      (sum, row) => sum + (Number(row.achievement) || 0),
      0,
    );

    return {
      kpiType: "filling",
      lineLabel: "Filling",
      operator,
      period,
      outputTarget,
      outputActual,
      wetCartonsActual,
      workedCartonsActual,
      spillActual,
      apdActual,
      attendanceActual,
      productionDays: productionDates.size,
      presentDays: presentDates.size,
      lineDays: new Set(
        fillingEntries.map((entry) => kpiDateKey(entry.tanggal)),
      ).size,
      fillingDays: new Set(
        fillingEntries.map((entry) => kpiDateKey(entry.tanggal)),
      ).size,
      rows,
      totalAchievement,
    };
  }

  function kpiOperatorsForPeriod(period, type) {
    const line = normalizeKpiType(type);
    const names = new Map();

    (state.reportEntries || [])
      .filter(
        (item) =>
          item &&
          !item._syncState &&
          (line === "shift" || line === "spv"
            ? item.tab === "filling" || item.tab === "press"
            : item.tab === line) &&
          dashboardDateInPeriod(item.tanggal, period),
      )
      .forEach((item) => {
        const name = String(item.operator || "").trim();
        if (!name) return;
        const key = name.toLowerCase();
        if (!names.has(key)) names.set(key, name);
      });

    return Array.from(names.values()).sort((a, b) => a.localeCompare(b, "id"));
  }

  function shiftKpiCountedUpdates(entry) {
    const updateCount = Math.max(
      0,
      Math.floor(Number(entry?.updateCount) || 0),
    );
    const allowance =
      entry?.tab === "filling" ? 2 : entry?.tab === "press" ? 1 : 0;
    return Math.max(0, updateCount - allowance);
  }

  function buildShiftKpiReport(monthValue, reportType = "shift") {
    const period = kpiPressMonthPeriod(monthValue);
    if (!period) return null;
    const entries = (state.reportEntries || []).filter(
      (entry) =>
        entry &&
        !entry._syncState &&
        (entry.tab === "filling" || entry.tab === "press") &&
        dashboardDateInPeriod(entry.tanggal, period),
    );
    if (!entries.length) return null;

    const workersByLine = { filling: new Set(), press: new Set() };
    let totalQty = 0;
    let broken = 0;
    let wet = 0;
    let updateTotal = 0;
    entries.forEach((entry) => {
      const worker = String(entry.operator || "")
        .trim()
        .toLowerCase();
      if (worker) workersByLine[entry.tab].add(worker);
      totalQty += Math.max(0, Number(entry.totalQty) || 0);
      if (entry.tab === "press")
        broken += Math.max(0, Number(entry.qtyBotolPecah) || 0);
      if (entry.tab === "filling")
        wet += Math.max(0, Number(entry.qtyKardusBasah) || 0);
      updateTotal += shiftKpiCountedUpdates(entry);
    });
    const outputTarget =
      workersByLine.filling.size * getKpiFillingOutputTarget() +
      workersByLine.press.size * getKpiPressOutputTarget();
    const outputPercent =
      outputTarget > 0 ? (totalQty / outputTarget) * 100 : 0;
    const rejectPercent =
      totalQty > 0 ? ((broken + wet) / totalQty) * 100 : null;
    const workerKeys = new Set([
      ...workersByLine.filling,
      ...workersByLine.press,
    ]);
    // KPI Ka. Shift hanya menghitung update yang melewati toleransi per baris:
    // Filling dua kali update dan Press satu kali update belum menjadi kesalahan.
    // Setiap baris tetap mempunyai bobot yang sama, termasuk hasil hitung 0.
    const updateAverage = entries.length ? updateTotal / entries.length : 0;
    // Nilai Ka. Shift harus sama dengan AVERAGE kolom persentase APD pada
    // periode laporan. Seluruh baris APD bulan terpilih ikut dihitung sekali,
    // termasuk operator yang tidak mempunyai entri Pengerjaan pada bulan itu.
    const combinedApdValues = (state.apdEntries || [])
      .filter(
        (item) =>
          item && dashboardDateInPeriod(kpiDateKey(item.tanggal), period),
      )
      .map((item) => kpiPercentageNumber(item.percentage))
      .filter((value) => value !== null);
    const apdActual = averageKpiValues(combinedApdValues);
    const rows = [
      {
        no: 1,
        field: "TARGET",
        indicator: "PRESENTASE CAPAI TARGET HARIAN",
        weight: 40,
        targetText: "> 90% DARI SPK",
        targetPercent: 100,
        actualText: kpiPressPercentText(outputPercent),
        achievement: Math.min(40, (outputPercent / 90) * 40),
        tone: "output",
      },
      {
        no: 2,
        field: "QC",
        indicator: "KERUSAKAN HASIL FILLING & PRESS",
        weight: 30,
        targetText: "RATA-RATA 0,5%",
        targetPercent: 100,
        actualText: kpiPressPercentText(rejectPercent),
        achievement:
          rejectPercent === null
            ? 0
            : rejectPercent <= 0.5
              ? 30
              : (0.5 / rejectPercent) * 30,
        tone: "quality",
      },
      {
        no: 3,
        field: "AKURASI DATA",
        indicator: "KESALAHAN UPDATE DATA OPERATOR",
        weight: 20,
        targetText: "AVERAGE ≤ 3 KESALAHAN UPDATE",
        targetPercent: 100,
        actualText: updateAverage.toLocaleString("id-ID", {
          maximumFractionDigits: 2,
        }),
        achievement: updateAverage <= 3 ? 20 : (3 / updateAverage) * 20,
        tone: "attendance",
      },
      {
        no: 4,
        field: "KEPATUHAN",
        indicator: "KEDISIPLINAN PEMAKAIAN APD",
        weight: 10,
        targetText: "RATA-RATA ≥ 95%",
        targetPercent: 100,
        actualText: kpiPressPercentText(apdActual),
        achievement:
          apdActual === null ? 0 : Math.min(10, (apdActual / 95) * 10),
        tone: "apd",
      },
    ];
    return {
      kpiType: normalizeKpiType(reportType),
      lineLabel: kpiTypeLabel(reportType),
      operator:
        normalizeKpiType(reportType) === "spv"
          ? "SPV Produksi"
          : getShiftLeaderName(),
      period,
      outputTarget,
      outputActual: totalQty,
      rejectActual: rejectPercent,
      apdActual,
      apdEntryCount: combinedApdValues.length,
      updateAverage,
      updateTotal,
      updateEntryCount: entries.length,
      broken,
      wet,
      productionDays: new Set(entries.map((entry) => entry.tanggal)).size,
      presentDays: workerKeys.size,
      lineDays: entries.length,
      rows,
      totalAchievement: rows.reduce((sum, row) => sum + row.achievement, 0),
    };
  }

  function buildSpvKpiReport(monthValue) {
    const report = buildShiftKpiReport(monthValue, "spv");
    if (!report) return null;

    const period = report.period;
    const entries = (state.reportEntries || []).filter(
      (entry) =>
        entry &&
        !entry._syncState &&
        (entry.tab === "filling" || entry.tab === "press") &&
        dashboardDateInPeriod(entry.tanggal, period),
    );
    const fillingEntries = entries.filter((entry) => entry.tab === "filling");
    const workedCartons = fillingEntries.reduce(
      (sum, entry) => sum + Math.max(0, Number(entry.qtyKardus) || 0),
      0,
    );
    const wetCartons = fillingEntries.reduce(
      (sum, entry) => sum + Math.max(0, Number(entry.qtyKardusBasah) || 0),
      0,
    );
    const spillPercent =
      workedCartons > 0 ? (wetCartons / workedCartons) * 100 : null;
    const downtimeValues = (state.downtimeEntries || [])
      .filter((entry) => entry && dashboardDateInPeriod(entry.tanggal, period))
      .map((entry) => Number(entry.downTime))
      .filter((value) => Number.isFinite(value))
      // Nilai minus berarti racikan sudah siap sebelum jam masuk. Untuk KPI
      // SPV Produksi kondisi tersebut dihitung sebagai 0 menit downtime.
      .map((value) => Math.max(0, value));
    const downtimeTotalMinutes = downtimeValues.reduce(
      (sum, value) => sum + value,
      0,
    );
    const downtimeEntryCount = downtimeValues.length;
    const downtimeAverage = downtimeEntryCount
      ? downtimeTotalMinutes / downtimeEntryCount
      : null;
    const outputPercent =
      report.outputTarget > 0
        ? (report.outputActual / report.outputTarget) * 100
        : 0;

    report.spillActual = spillPercent;
    report.downtimeAverage = downtimeAverage;
    report.downtimeEntryCount = downtimeEntryCount;
    report.downtimeTotalMinutes = downtimeTotalMinutes;
    report.rows = [
      {
        no: 1,
        field: "TARGET",
        indicator: "PENCAPAIAN TEAM",
        weight: 40,
        targetText: "> 95% DARI SPK",
        targetPercent: 100,
        actualText: kpiPressPercentText(outputPercent),
        achievement: Math.min(40, (outputPercent / 95) * 40),
        tone: "output",
      },
      {
        no: 2,
        field: "QC",
        indicator: "MEMINIMALISIR REJECT PADA PRODUKSI",
        weight: 20,
        targetText: "RATA-RATA 0,5%",
        targetPercent: 100,
        actualText: kpiPressPercentText(report.rejectActual),
        achievement:
          report.rejectActual === null
            ? 0
            : report.rejectActual <= 0.5
              ? 20
              : (0.5 / report.rejectActual) * 20,
        tone: "quality",
      },
      {
        no: 3,
        field: "EFISIENSI",
        indicator: "EFISIENSI BAHAN BAKU",
        weight: 15,
        targetText: "MAKSIMAL 1% TUMPAHAN",
        targetPercent: 100,
        actualText: kpiPressPercentText(spillPercent),
        achievement:
          spillPercent === null
            ? 0
            : spillPercent <= 1
              ? 15
              : (1 / spillPercent) * 15,
        tone: "quality",
      },
      {
        no: 4,
        field: "DOWN TIME",
        indicator: "EFISIENSI DOWN TIME RACIKAN",
        weight: 15,
        targetText: "RATA-RATA < 10 MENIT",
        targetPercent: 100,
        actualText:
          downtimeAverage === null
            ? "Belum ada data"
            : `${downtimeAverage.toLocaleString("id-ID", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} menit`,
        achievement:
          downtimeAverage === null
            ? 0
            : downtimeAverage < 10
              ? 15
              : (10 / downtimeAverage) * 15,
        tone: "attendance",
      },
      {
        no: 5,
        field: "KEPATUHAN",
        indicator: "KEDISIPLINAN PEMAKAIAN APD",
        weight: 10,
        targetText: "RATA-RATA ≥ 95%",
        targetPercent: 100,
        actualText: kpiPressPercentText(report.apdActual),
        achievement:
          report.apdActual === null
            ? 0
            : Math.min(10, (report.apdActual / 95) * 10),
        tone: "apd",
      },
    ];
    report.totalAchievement = report.rows.reduce(
      (sum, row) => sum + row.achievement,
      0,
    );
    return report;
  }

  function kpiResolveExactOperator(rawOperator, allowedOperators = []) {
    const raw = String(rawOperator || "").trim();
    if (!raw) return "";
    const key = raw.toLowerCase();
    return (
      (allowedOperators || []).find(
        (name) =>
          String(name || "")
            .trim()
            .toLowerCase() === key,
      ) || ""
    );
  }

  function updateKpiLaporanTypeUi(type) {
    const normalized = normalizeKpiType(type);
    const label = kpiTypeLabel(normalized);
    const isPress = normalized === "press";
    const isShift = normalized === "shift";
    const isSpv = normalized === "spv";
    const isProductionManagement = isShift || isSpv;
    const operatorFilter = qs(".kpi-press-employee-filter");
    if (operatorFilter) operatorFilter.hidden = isProductionManagement;

    const panel = el("lap-kpi-panel");
    const result = el("lap-kpi-result");
    const badge = el("lap-kpi-badge");
    if (panel) panel.dataset.kpiType = normalized;
    if (result) result.dataset.kpiType = normalized;

    dashboardSetText("lap-kpi-title", `KPI ${label}`);
    dashboardSetText("lap-kpi-result-eyebrow", `KPI ${label}`);

    const intro = el("lap-kpi-intro");
    if (intro) {
      intro.textContent = isProductionManagement
        ? `KPI ${label} merangkum seluruh pengerjaan Filling dan Press serta penilaian APD karyawan pada bulan terpilih.`
        : isPress
          ? "Preview KPI Press akan tampil otomatis. Karyawan yang ditampilkan hanya karyawan yang mempunyai pengerjaan Press pada bulan terpilih. Target output KPI Press tetap mengikuti menu Setting."
          : `Preview KPI Filling akan tampil otomatis. Karyawan yang ditampilkan hanya karyawan yang mempunyai pengerjaan Filling pada bulan terpilih. Target output KPI Filling mengikuti menu Setting (${kpiPressQtyText(getKpiFillingOutputTarget())} botol/bulan).`;
    }

    if (badge) {
      badge.dataset.kpiType = normalized;
      badge.innerHTML = isSpv
        ? '<i class="fa-solid fa-user-tie"></i> KPI SPV PRODUKSI'
        : isShift
          ? '<i class="fa-solid fa-users"></i> KPI KA. SHIFT'
          : isPress
            ? '<i class="fa-solid fa-circle-down"></i> KPI PRESS'
            : '<i class="fa-solid fa-droplet"></i> KPI FILLING';
    }
  }

  function kpiPressRowHtml(row) {
    const scoreClass = kpiAchievementColorClass(row.achievement, row.weight);
    return `
      <tr class="kpi-press-row kpi-press-row-${esc(row.tone)}">
        <td class="kpi-center">${row.no}</td>
        <td><strong>${esc(row.field)}</strong></td>
        <td>${esc(row.indicator)}</td>
        <td class="kpi-center"><strong>${kpiPressScoreText(row.weight).replace(/,00$/, "")}</strong></td>
        <td>${esc(row.targetText)}</td>
        <td class="kpi-center">${row.targetPercent}</td>
        <td class="kpi-center"><strong>${esc(row.actualText)}</strong></td>
        <td class="kpi-center"><span class="kpi-press-score ${scoreClass}">${kpiPressScoreText(row.achievement)}</span></td>
      </tr>`;
  }

  function setKpiToggleVisual(button, expanded, toggleAll = false) {
    if (!button) return;
    const iconName = toggleAll
      ? expanded
        ? "fa-angles-up"
        : "fa-angles-down"
      : expanded
        ? "fa-chevron-up"
        : "fa-chevron-down";
    const currentIcon = qs("i, svg", button);
    const replacement = document.createElement("i");
    replacement.className = `fa-solid ${iconName}`;
    replacement.setAttribute("aria-hidden", "true");
    if (currentIcon) currentIcon.replaceWith(replacement);
    else button.prepend(replacement);

    const label = qs("span", button);
    if (label) label.textContent = expanded ? "Collapse" : "Expand";
    button.setAttribute("aria-expanded", expanded ? "true" : "false");
  }

  function kpiPressEmployeeCardHtml(report, index, expanded = false) {
    const detailId = `kpi-employee-detail-${index}`;
    const totalAchievementTarget = 100;
    const totalScoreClass = kpiAchievementColorClass(
      report.totalAchievement,
      totalAchievementTarget,
    );
    return `
      <article class="kpi-employee-card ${expanded ? "is-expanded" : ""}" data-kpi-card="${index}">
        <div class="kpi-employee-card-head">
          <div class="kpi-employee-card-actions">
            <div class="kpi-employee-name-tile">
              <h3>${esc(report.operator)}</h3>
            </div>
            <div class="kpi-achievement-card ${totalScoreClass}" title="Target total capaian ${totalAchievementTarget}%">
              <span>Capaian</span>
              <strong>${kpiPressScoreText(report.totalAchievement)}%</strong>
            </div>
            <button type="button" class="btn btn-ghost kpi-card-toggle" data-kpi-index="${index}" aria-expanded="${expanded ? "true" : "false"}" aria-controls="${detailId}">
              <i class="fa-solid ${expanded ? "fa-chevron-up" : "fa-chevron-down"}"></i>
              <span>${expanded ? "Collapse" : "Expand"}</span>
            </button>
          </div>
        </div>

        <div class="kpi-employee-detail" id="${detailId}" ${expanded ? "" : "hidden"}>
          <div class="kpi-employee-detail-meta">
            <span>${esc(report.period.label)}</span>
            <span>Target Output ${esc(kpiPressQtyText(report.outputTarget))} botol/bulan</span>
          </div>
          <div class="table-wrap kpi-press-table-wrap">
            <table class="data-table kpi-press-table">
              <thead>
                <tr>
                  <th>No.</th>
                  <th>Bidang</th>
                  <th>Indikator</th>
                  <th>Bobot</th>
                  <th>Target</th>
                  <th>Target (%)</th>
                  <th>Aktual</th>
                  <th>Capaian (%)</th>
                </tr>
              </thead>
              <tbody>${report.rows.map(kpiPressRowHtml).join("")}</tbody>
              <tfoot>
                <tr class="kpi-press-total-row">
                  <td colspan="3" class="kpi-total-label"><strong>TOTAL BOBOT</strong></td>
                  <td class="kpi-center"><strong>100</strong></td>
                  <td colspan="3" class="kpi-total-label"><strong>TOTAL CAPAIAN</strong></td>
                  <td class="kpi-center"><strong>${kpiPressScoreText(report.totalAchievement)}</strong></td>
                </tr>
              </tfoot>
            </table>
          </div>

          <div class="kpi-employee-detail-summary">
            ${
              report.kpiType === "shift" || report.kpiType === "spv"
                ? `<span>Hari Produksi <strong>${report.productionDays}</strong></span><span>Karyawan Aktif <strong>${report.presentDays}</strong></span><span>Entri Produksi <strong>${report.lineDays}</strong></span>`
                : `<span>Acuan Kehadiran <strong>${report.productionDays} hari</strong></span><span>Hari Hadir <strong>${report.presentDays}</strong></span><span>Hari ${esc(report.lineLabel || "Produksi")} <strong>${report.lineDays || 0}</strong></span>`
            }
          </div>
        </div>
      </article>`;
  }

  function renderKpiLaporanCards() {
    const reportSet = state.lastKpiLaporan;
    const container = el("lap-kpi-cards");
    if (!reportSet || !container) return;

    const reports = reportSet.reports || [];
    const expandSingle = reports.length === 1;
    container.innerHTML = reports.length
      ? reports
          .map((report, index) =>
            kpiPressEmployeeCardHtml(report, index, expandSingle),
          )
          .join("")
      : '<div class="dashboard-empty-state">Belum ada karyawan untuk ditampilkan.</div>';

    const toggleAllButton = el("lap-kpi-toggle-all");
    if (toggleAllButton) {
      const details = qsa(".kpi-employee-detail", container);
      const hasCards = details.length > 0;
      const allExpanded = hasCards && details.every((detail) => !detail.hidden);
      toggleAllButton.disabled = !hasCards;
      setKpiToggleVisual(toggleAllButton, allExpanded, true);
    }

    const summary = el("lap-kpi-page-summary");
    if (summary) {
      const selectedLabel = reportSet.selectedOperator
        ? "1 karyawan"
        : `${reports.length} karyawan`;
      summary.textContent =
        reportSet.kpiType === "shift" || reportSet.kpiType === "spv"
          ? `KPI ${reportSet.lineLabel} · Periode ${reportSet.period.label} · Target gabungan ${kpiPressQtyText(reportSet.outputTarget)} botol/bulan`
          : `${selectedLabel} KPI ${reportSet.lineLabel} · Periode ${reportSet.period.label} · Target output ${kpiPressQtyText(reportSet.outputTarget)} botol/bulan`;
    }
  }

  function setKpiReportExportState(enabled) {
    ["lap-kpi-export", "lap-kpi-pdf"].forEach((id) => {
      const btn = el(id);
      if (btn) btn.disabled = !enabled;
    });
  }

  function showKpiLaporan(
    reports,
    period,
    selectedOperator,
    finalize = false,
    type = "filling",
  ) {
    const result = el("lap-kpi-result");
    if (!result) return false;

    const kpiType = normalizeKpiType(type);
    const lineLabel = kpiTypeLabel(kpiType);
    updateKpiLaporanTypeUi(kpiType);

    if (!Array.isArray(reports) || !reports.length) {
      state.lastKpiLaporan = null;
      result.hidden = true;
      setKpiReportExportState(false);
      return false;
    }

    const id = finalize
      ? genLaporanId().replace(/^LAP-/, `KPI-${lineLabel.toUpperCase()}-`)
      : "PREVIEW";
    const outputTarget =
      kpiType === "shift" || kpiType === "spv"
        ? reports[0].outputTarget
        : getKpiOutputTarget(kpiType);
    state.lastKpiLaporan = {
      id,
      reports,
      period,
      kpiType,
      lineLabel,
      outputTarget,
      selectedOperator: selectedOperator || "",
      isPreview: !finalize,
    };

    dashboardSetText("lap-kpi-id", finalize ? id : "PREVIEW OTOMATIS");
    dashboardSetText(
      "lap-kpi-created",
      finalize ? fmtDateTime(nowIso()) : "Belum dibuat",
    );
    dashboardSetText(
      "lap-kpi-by",
      `${state.currentUser?.name || state.currentUser?.username || "—"} (${state.currentUser?.role === "superuser" ? "Super User" : "User"})`,
    );
    dashboardSetText("lap-kpi-period", period.label);
    dashboardSetText(
      "lap-kpi-employee",
      selectedOperator || `Semua Karyawan ${lineLabel} (${reports.length})`,
    );

    renderKpiLaporanCards();
    result.hidden = false;
    result.dataset.preview = finalize ? "false" : "true";
    setKpiReportExportState(finalize);
    return true;
  }

  function collectKpiLaporanData(options = {}) {
    const finalize = Boolean(options.finalize);
    const type = normalizeKpiType(el("lap-kpi-type")?.value || "filling");
    const lineLabel = kpiTypeLabel(type);
    const monthValue = el("lap-kpi-month")?.value || "";
    const period = kpiPressMonthPeriod(monthValue);

    if (!period) {
      return {
        reports: [],
        period: null,
        selectedOperator: "",
        type,
        error: `Pilih bulan KPI ${lineLabel} yang valid.`,
      };
    }

    if (type === "shift" || type === "spv") {
      const report =
        type === "spv"
          ? buildSpvKpiReport(monthValue)
          : buildShiftKpiReport(monthValue);
      return {
        reports: report ? [report] : [],
        period,
        selectedOperator:
          type === "spv" ? "SPV Produksi" : getShiftLeaderName(),
        type,
        error: "",
      };
    }

    // Hanya operator yang benar-benar memiliki pengerjaan pada line KPI terpilih.
    // Master operator, data APD, atau line lain tidak lagi membuat card KPI ikut tampil.
    const allOperators = kpiOperatorsForPeriod(period, type);
    const rawOperator = String(el("lap-kpi-operator")?.value || "").trim();
    let selectedOperator = "";
    let operators = allOperators;

    if (rawOperator) {
      const exact = kpiResolveExactOperator(rawOperator, allOperators);
      if (exact) {
        selectedOperator = exact;
        operators = [exact];
      } else if (!finalize) {
        const keyword = rawOperator.toLowerCase();
        operators = allOperators.filter((name) =>
          name.toLowerCase().includes(keyword),
        );
      } else {
        return {
          reports: [],
          period,
          selectedOperator: "",
          type,
          error: `Nama karyawan tersebut tidak mempunyai pengerjaan ${lineLabel} pada bulan terpilih.`,
        };
      }
    }

    const outputTarget = getKpiOutputTarget(type);
    const reports = operators
      .map((operator) =>
        type === "press"
          ? buildPressKpiReport(operator, monthValue, outputTarget)
          : buildFillingKpiReport(operator, monthValue, outputTarget),
      )
      .filter(Boolean);

    return { reports, period, selectedOperator, type, error: "" };
  }

  function buildKpiLaporanPrintHtml() {
    const reportSet = state.lastKpiLaporan;
    if (!reportSet || reportSet.isPreview || !reportSet.reports?.length)
      return "";

    const created = el("lap-kpi-created")?.textContent || fmtDateTime(nowIso());
    const by = el("lap-kpi-by")?.textContent || "—";
    const isPress = reportSet.kpiType === "press";
    const isShift = reportSet.kpiType === "shift";
    const isSpv = reportSet.kpiType === "spv";
    const isProductionManagement = isShift || isSpv;

    const sections = reportSet.reports
      .map((report, index) => {
        const bodyRows = report.rows
          .map(
            (row) => `
        <tr>
          <td class="center">${row.no}</td>
          <td><strong>${esc(row.field)}</strong></td>
          <td>${esc(row.indicator)}</td>
          <td class="center">${esc(String(row.weight))}</td>
          <td>${esc(row.targetText)}</td>
          <td class="center">${row.targetPercent}</td>
          <td class="center"><strong>${esc(row.actualText)}</strong></td>
          <td class="center ${kpiAchievementColorClass(row.achievement, row.weight)}"><strong>${esc(kpiPressScoreText(row.achievement))}</strong></td>
        </tr>`,
          )
          .join("");

        const qualitySummary = isSpv
          ? `Reject ${esc(kpiPressPercentText(report.rejectActual, 2))} · Tumpahan ${esc(kpiPressPercentText(report.spillActual, 2))} · Down time ${report.downtimeAverage === null ? "belum ada data" : `${esc(report.downtimeAverage.toLocaleString("id-ID", { minimumFractionDigits: 2, maximumFractionDigits: 2 }))} menit`}`
          : isShift
            ? `Reject ${esc(kpiPressPercentText(report.rejectActual, 2))} · Rata-rata kesalahan update ${esc(String(report.updateAverage.toLocaleString("id-ID", { maximumFractionDigits: 2 })))}`
            : isPress
              ? `Kerusakan ${esc(report.outputActual > 0 ? kpiPressPercentText(report.rejectActual || 0, 2) : "—")}`
              : `Kardus Basah ${esc(kpiPressQtyText(report.wetCartonsActual || 0))} dus · Tumpahan ${esc(kpiPressPercentText(report.spillActual, 2))}`;

        return `
        <section class="employee-section">
          <div class="employee-head">
            <div>
              <div class="employee-no">Karyawan ${index + 1}</div>
              <h2>${esc(report.operator)}</h2>
            </div>
            <div class="achievement"><span>Capaian</span><strong>${esc(kpiPressScoreText(report.totalAchievement))}%</strong></div>
          </div>
          <table>
            <thead><tr><th>No.</th><th>Bidang</th><th>Indikator</th><th>Bobot</th><th>Target</th><th>Target (%)</th><th>Aktual</th><th>Capaian (%)</th></tr></thead>
            <tbody>${bodyRows}</tbody>
            <tfoot><tr><td colspan="3" class="total-label">TOTAL BOBOT</td><td class="center">100</td><td colspan="3" class="total-label">TOTAL CAPAIAN</td><td class="center">${esc(kpiPressScoreText(report.totalAchievement))}</td></tr></tfoot>
          </table>
          <div class="compact">
            Output ${esc(kpiPressQtyText(report.outputActual))} · ${qualitySummary} ·
            APD ${esc(kpiPressPercentText(report.apdActual, 2))} ${isProductionManagement ? "" : `· Kehadiran ${esc(kpiPressPercentText(report.attendanceActual, 2))}`} ·
            ${isProductionManagement ? "Hari produksi" : "Acuan kehadiran"} ${report.productionDays} · ${
              isProductionManagement
                ? `Karyawan aktif ${report.presentDays} · Entri produksi ${report.lineDays}`
                : `Hari hadir ${report.presentDays} · Hari ${esc(report.lineLabel)} ${report.lineDays || 0}`
            }
          </div>
        </section>`;
      })
      .join("");

    const notes = isSpv
      ? `<p><strong>Keterangan:</strong> Pencapaian Team mencapai bobot penuh saat hasil produksi mencapai lebih dari 95% target gabungan SPK Filling dan Press.</p>
         <p>Reject memakai gabungan botol pecah Press dan kardus basah Filling. Efisiensi bahan baku memakai persentase kardus basah terhadap total kardus Filling sebagai data tumpahan.</p>
         <p>Down Time Racikan = total seluruh menit downtime periode dibagi jumlah entri Down Time pada periode. Racikan yang siap sebelum atau tepat pada jam masuk dihitung 0 menit untuk KPI. Rata-rata di bawah 10 menit mendapat bobot penuh 15; rata-rata 10 menit atau lebih dihitung dengan rumus 10 dibagi rata-rata menit dikali 15. Jika tidak ada catatan downtime, capaian indikator bernilai 0.</p>
         <p>Aktual APD SPV Produksi memakai rata-rata seluruh nilai APD pada periode laporan.</p>`
      : isShift
        ? `<p><strong>Keterangan:</strong> Target gabungan memakai target bulanan Filling dan Press di Setting, dikalikan jumlah karyawan aktif pada masing-masing bagian. Capaian target penuh saat hasil mencapai 90% target gabungan.</p>
         <p>Reject = (botol rusak Press + kardus basah Filling) ÷ total pengerjaan pcs. Kesalahan update per baris Filling = maks(0, updateCount − 2), sedangkan Press = maks(0, updateCount − 1). Aktual KPI adalah total kesalahan update ÷ jumlah seluruh baris Pengerjaan dalam periode; nilai 0 tetap dihitung.</p>
         <p>Aktual APD ${esc(reportSet.lineLabel)} = total persentase seluruh baris APD pada periode laporan ÷ jumlah baris APD, sama dengan AVERAGE kolom Nilai Prosentase APD di Spreadsheet.</p>`
        : isPress
          ? `
        <p><strong>Keterangan:</strong> Target output KPI Press diatur melalui menu Setting.</p>
        <p>Kerusakan botol dihitung dari rata-rata persentase kerusakan harian pada data Press. Target &lt; 1%.</p>`
          : `
        <p><strong>Keterangan:</strong> Target output KPI Filling diatur melalui menu Setting (${esc(kpiPressQtyText(reportSet.outputTarget))} botol/bulan).</p>
        <p>Seluruh pengerjaan Filling karyawan pada tanggal yang sama digabung: 0 kardus basah = 0%; total 1–5 = 1%; di atas 5 = 1% + ((Total Kardus Basah Harian − 5) ÷ Total Qty Pengerjaan Dus Harian × 30%). Nilai aktual periode adalah rata-rata persentase harian.</p>`;

    return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(reportSet.id)}</title>
  <style>
    @page { size: A4 landscape; margin: 10mm; }
    * { box-sizing: border-box; }
    body { margin:0; color:#111827; font-family:Arial,Helvetica,sans-serif; font-size:9px; }
    .report-head { display:flex; justify-content:space-between; gap:20px; margin-bottom:12px; border-bottom:1px solid #d1d5db; padding-bottom:9px; }
    .company { font-size:8px; font-weight:700; text-transform:uppercase; letter-spacing:.08em; color:#8a4a0c; }
    h1 { margin:3px 0 4px; font-size:18px; }
    h2 { margin:0; font-size:14px; }
    .id { font-family:Consolas,monospace; font-weight:700; }
    .meta { text-align:right; line-height:1.55; }
    .employee-section { margin:0 0 14px; break-inside:avoid; page-break-inside:avoid; }
    .employee-head { display:flex; justify-content:space-between; align-items:center; gap:14px; margin-bottom:6px; }
    .employee-no { font-size:7.5px; color:#6b7280; text-transform:uppercase; letter-spacing:.06em; }
    .achievement { min-width:120px; border:1px solid #cbd5e1; border-radius:6px; padding:6px 10px; text-align:center; }
    .achievement span { display:block; color:#6b7280; font-size:7px; text-transform:uppercase; }
    .achievement strong { display:block; margin-top:2px; font-size:15px; }
    .kpi-score-equal { background:#dcf0e3 !important; color:#2c7a4b !important; }
    .kpi-score-below { background:#f8deda !important; color:#c1402c !important; }
    .kpi-score-above { background:#fba834 !important; color:#fff !important; }
    table { width:100%; border-collapse:collapse; }
    th,td { border:1px solid #cfd6dd; padding:5px 6px; }
    th { background:#ddeaf2; color:#2a5f82; text-transform:uppercase; font-size:7.5px; text-align:left; }
    .center { text-align:center; white-space:nowrap; }
    tfoot td { background:#ddeaf2; color:#2a5f82; font-weight:700; }
    tfoot .total-label { text-align:right; padding-right:10px; }
    .compact { margin-top:5px; color:#4b5563; font-size:8px; line-height:1.4; }
    .notes { margin-top:12px; border-top:1px solid #d1d5db; padding-top:7px; font-size:8px; line-height:1.45; color:#374151; }
    .notes p { margin:2px 0; }
  </style>
</head>
<body>
  <section class="report-head">
    <div>
      <div class="company">PT. ABSH FRAGRANCE CREATIONS</div>
      <h1>Laporan KPI ${esc(reportSet.lineLabel)}</h1>
      <div class="id">${esc(reportSet.id)}</div>
      <div>${esc(reportSet.selectedOperator || `Semua Karyawan ${reportSet.lineLabel} (${reportSet.reports.length})`)}</div>
    </div>
    <div class="meta">
      <div><strong>Dibuat:</strong> ${esc(created)}</div>
      <div><strong>Oleh:</strong> ${esc(by)}</div>
      <div><strong>Periode:</strong> ${esc(reportSet.period.label)}</div>
      <div><strong>Target output:</strong> ${esc(kpiPressQtyText(reportSet.outputTarget))} botol/bulan</div>
    </div>
  </section>
  ${sections}
  <div class="notes">
    ${notes}
    <p>${isProductionManagement ? "APD menggunakan rata-rata nilai tiap karyawan aktif pada bulan yang sama. Target > 95%." : "APD menggunakan rata-rata nilai APD operator pada bulan yang sama. Target ≥ 95%."}</p>
    ${isProductionManagement ? "" : "<p>Kehadiran dihitung dari jumlah tanggal kerja unik karyawan dibandingkan jumlah tanggal kerja terbanyak milik satu karyawan pada periode yang sama. Bobot Kehadiran tetap 15.</p>"}
  </div>
</body>
</html>`;
  }

  function openKpiLaporanPrintDialog() {
    const html = buildKpiLaporanPrintHtml();
    if (!html)
      return toast(
        "Klik Buat Laporan KPI terlebih dahulu sebelum Export PDF.",
        true,
      );
    const printWindow = window.open("", "_blank", "width=1200,height=820");
    if (!printWindow)
      return toast(
        "Popup diblokir browser. Izinkan popup untuk Export PDF KPI.",
        true,
      );
    printWindow.document.open();
    printWindow.document.write(html);
    printWindow.document.close();
    const doPrint = () => {
      try {
        printWindow.focus();
        printWindow.print();
      } catch (err) {
        toast(`Gagal membuka dialog cetak KPI: ${err.message}`, true);
      }
    };
    if (printWindow.document.readyState === "complete")
      setTimeout(doPrint, 250);
    else
      printWindow.addEventListener("load", () => setTimeout(doPrint, 250), {
        once: true,
      });
    toast("Dialog PDF KPI dibuka. Pilih 'Save as PDF' / 'Simpan sebagai PDF'.");
  }

  function initLaporanSubmenu() {
    const nav = el("laporanSubnav");
    if (!nav) return;
    const buttons = qsa(".laporan-subnav-btn", nav);
    const views = {
      hasil: el("laporan-subview-hasil"),
      spk: el("laporan-subview-spk"),
      kpi: el("laporan-subview-kpi"),
    };

    function showLaporanSubview(name) {
      const target =
        name === "hasil" && can("accessWorkReport")
          ? "hasil"
          : name === "spk" && canLevel("spkReport")
            ? "spk"
            : name === "kpi" &&
                (canKpiType("filling") ||
                  canKpiType("press") ||
                  canKpiType("spv"))
              ? "kpi"
              : canLevel("spkReport")
                ? "spk"
                : can("accessWorkReport")
                  ? "hasil"
                  : "kpi";
      buttons.forEach((btn) => {
        const active = btn.dataset.laporanView === target;
        btn.classList.toggle("active", active);
        btn.setAttribute("aria-selected", active ? "true" : "false");
      });
      Object.entries(views).forEach(([key, node]) => {
        if (node) node.hidden = key !== target;
      });

      if (
        target === "kpi" &&
        typeof window.refreshKpiLaporanAutoPreview === "function"
      ) {
        window.refreshKpiLaporanAutoPreview();
      }
      if (target === "spk") renderSpkReport();
    }

    nav.addEventListener("click", (event) => {
      const btn = event.target.closest(".laporan-subnav-btn");
      if (!btn) return;
      showLaporanSubview(btn.dataset.laporanView || "hasil");
    });

    // initAppPage memasang event sebelum profil/cache pengguna selesai dimuat.
    // Jangan memilih fallback KPI ketika currentUser masih null; pertahankan
    // markup default "Data SPK", lalu applyAccessControl akan memilih submenu
    // pertama yang tersedia jika user tidak memiliki akses laporan SPK.
    if (state.currentUser) {
      showLaporanSubview(
        canLevel("spkReport")
          ? "spk"
          : can("accessWorkReport")
            ? "hasil"
            : "kpi",
      );
    }
  }

  function spkReportRows() {
    const mode = el("lap-spk-mode")?.value || "week";
    const endDefault = todayStr();
    const startDefaultDate = new Date();
    startDefaultDate.setDate(startDefaultDate.getDate() - 6);
    const p = (n) => String(n).padStart(2, "0");
    const startDefault = `${startDefaultDate.getFullYear()}-${p(startDefaultDate.getMonth() + 1)}-${p(startDefaultDate.getDate())}`;
    let start = startDefault;
    let end = endDefault;
    if (mode === "date") start = end = el("lap-spk-date")?.value || endDefault;
    if (mode === "range") {
      start = el("lap-spk-start")?.value || startDefault;
      end = el("lap-spk-end")?.value || endDefault;
    }
    if (start > end) [start, end] = [end, start];
    return (state.spkEntries || [])
      .filter((item) => item.tanggal >= start && item.tanggal <= end)
      .sort(
        (a, b) =>
          String(b.tanggal).localeCompare(String(a.tanggal)) ||
          String(b.batchNo).localeCompare(String(a.batchNo)),
      );
  }

  function renderSpkReport() {
    const tbody = el("lap-spk-tbody");
    if (!tbody) return;
    const rows = applyExcelDataFilter(
      tbody.closest("table"),
      spkReportRows(),
      [
        (r) => r.batchNo,
        (r) => r.tanggal,
        (r) => r.produk,
        (r) => r.botol,
        (r) => r.produksiDus,
        (r) => r.qtyPerDus,
        (r) => r.qty,
        (r) => r.createdBy,
        (r) => r.createdAt,
        (r) => r.updateCount,
      ],
      renderSpkReport,
    );
    const totalPages = Math.max(1, Math.ceil(rows.length / 20));
    state.spk.reportPage = Math.min(
      Math.max(1, state.spk.reportPage || 1),
      totalPages,
    );
    const start = (state.spk.reportPage - 1) * 20;
    const visibleRows = rows.slice(start, start + 20);
    tbody.innerHTML = visibleRows.length
      ? visibleRows
          .map(
            (item) =>
              `<tr><td><span class="id-badge">${esc(item.batchNo)}</span></td><td>${esc(item.tanggal)}</td><td>${esc(item.produk)}</td><td>${esc(item.botol)}</td><td>${Math.max(0, Number(item.produksiDus) || 0).toLocaleString("id-ID")}</td><td>${Math.max(0, Number(item.qtyPerDus) || 0).toLocaleString("id-ID")}</td><td>${Math.max(0, Number(item.qty) || 0).toLocaleString("id-ID")}</td><td>${esc(item.createdBy || "—")}</td><td>${item.createdAt ? esc(fmtDateTime(item.createdAt)) : "—"}</td><td>${Math.max(0, Number(item.updateCount) || 0)}</td></tr>`,
          )
          .join("")
      : '<tr><td colspan="10" class="empty-row">Tidak ada data SPK pada periode ini.</td></tr>';
    dashboardSetText(
      "lap-spk-summary",
      `${rows.length ? start + 1 : 0}–${Math.min(start + 20, rows.length)} dari ${rows.length} SPK ditampilkan`,
    );
    renderPagination(
      el("lap-spk-pagination"),
      state.spk.reportPage,
      totalPages,
      (page) => {
        state.spk.reportPage = page;
        renderSpkReport();
      },
    );
  }

  function initSpkReport() {
    const mode = el("lap-spk-mode");
    if (!mode) return;
    const today = todayStr();
    el("lap-spk-date").value = today;
    el("lap-spk-end").value = today;
    const start = new Date();
    start.setDate(start.getDate() - 6);
    const p = (n) => String(n).padStart(2, "0");
    el("lap-spk-start").value =
      `${start.getFullYear()}-${p(start.getMonth() + 1)}-${p(start.getDate())}`;
    const syncFilters = () => {
      el("lap-spk-date-wrap").hidden = mode.value !== "date";
      el("lap-spk-start-wrap").hidden = mode.value !== "range";
      el("lap-spk-end-wrap").hidden = mode.value !== "range";
    };
    mode.addEventListener("change", () => {
      state.spk.reportPage = 1;
      syncFilters();
      renderSpkReport();
    });
    ["lap-spk-date", "lap-spk-start", "lap-spk-end"].forEach((id) => {
      el(id)?.addEventListener("change", () => {
        state.spk.reportPage = 1;
        renderSpkReport();
      });
    });
    el("lap-spk-reset")?.addEventListener("click", () => {
      mode.value = "week";
      state.spk.reportPage = 1;
      syncFilters();
      renderSpkReport();
    });
    el("lap-spk-pdf")?.addEventListener("click", () => {
      const rows = spkReportRows();
      if (!rows.length)
        return toast("Tidak ada data SPK untuk disimpan sebagai PDF.", true);
      const popup = window.open("", "_blank", "width=1100,height=800");
      if (!popup) return toast("Popup PDF diblokir browser.", true);
      popup.document.write(
        `<!doctype html><html><head><title>Data SPK</title><style>@page{size:A4 landscape;margin:12mm}body{font-family:Arial,sans-serif;color:#17202a}h1{font-size:20px}p{color:#59636e}table{width:100%;border-collapse:collapse}th,td{border:1px solid #bcc5ce;padding:6px;font-size:11px}th{background:#eaf0f5;text-align:left}</style></head><body><h1>Data SPK</h1><p>PT. ABSH FRAGRANCE CREATIONS · Dicetak ${esc(fmtDateTime(nowIso()))}</p><table><thead><tr><th>No Batch</th><th>Tanggal</th><th>Produk</th><th>Botol</th><th>Produksi (Dus)</th><th>Qty/Dus</th><th>Total Qty (PCS)</th><th>Dibuat Oleh</th><th>Dibuat Pada</th><th>Update</th></tr></thead><tbody>${rows.map((item) => `<tr><td>${esc(item.batchNo)}</td><td>${esc(item.tanggal)}</td><td>${esc(item.produk)}</td><td>${esc(item.botol)}</td><td>${Math.max(0, Number(item.produksiDus) || 0).toLocaleString("id-ID")}</td><td>${Math.max(0, Number(item.qtyPerDus) || 0).toLocaleString("id-ID")}</td><td>${Math.max(0, Number(item.qty) || 0).toLocaleString("id-ID")}</td><td>${esc(item.createdBy || "—")}</td><td>${item.createdAt ? esc(fmtDateTime(item.createdAt)) : "—"}</td><td>${Math.max(0, Number(item.updateCount) || 0)}</td></tr>`).join("")}</tbody></table></body></html>`,
      );
      popup.document.close();
      window.setTimeout(() => {
        popup.focus();
        popup.print();
      }, 250);
    });
    syncFilters();
    renderSpkReport();
  }

  function initKpiLaporan() {
    const generate = el("lap-kpi-generate");
    if (!generate) return;

    let previewTimer = null;
    const currentMonth = todayStr().slice(0, 7);
    if (el("lap-kpi-month") && !el("lap-kpi-month").value) {
      el("lap-kpi-month").value = currentMonth;
    }

    updateKpiLaporanTypeUi(el("lap-kpi-type")?.value || "filling");

    function showError(message = "") {
      const errorEl = el("lap-kpi-error");
      if (!errorEl) return;
      errorEl.textContent = message;
      errorEl.hidden = !message;
    }

    function refreshAutoPreview() {
      if (el("view-laporan")?.hidden) return;
      if (!canKpiType(el("lap-kpi-type")?.value || "filling")) return;
      const { reports, period, selectedOperator, type, error } =
        collectKpiLaporanData({ finalize: false });
      updateKpiLaporanTypeUi(type);
      if (error || !period) {
        showError(error);
        showKpiLaporan([], period || { label: "—" }, "", false, type);
        return;
      }
      showError(
        reports.length
          ? ""
          : `Tidak ada pengerjaan ${kpiTypeLabel(type)} yang cocok dengan filter karyawan pada ${period.label}.`,
      );
      showKpiLaporan(reports, period, selectedOperator, false, type);
    }

    function scheduleAutoPreview(delay = 120) {
      clearTimeout(previewTimer);
      previewTimer = setTimeout(refreshAutoPreview, delay);
    }

    window.refreshKpiLaporanAutoPreview = () => scheduleAutoPreview(0);

    el("lap-kpi-type")?.addEventListener("change", () => {
      const input = el("lap-kpi-operator");
      if (input) input.value = "";
      setKpiReportExportState(false);
      updateKpiLaporanTypeUi(el("lap-kpi-type")?.value || "filling");
      selectAvailableKpiMonth();
      scheduleAutoPreview(0);
    });
    el("lap-kpi-operator")?.addEventListener("input", () =>
      scheduleAutoPreview(180),
    );
    el("lap-kpi-operator")?.addEventListener("change", () =>
      scheduleAutoPreview(0),
    );
    el("lap-kpi-month")?.addEventListener("input", (event) => {
      event.target.dataset.userSelected = "1";
      scheduleAutoPreview(120);
    });
    el("lap-kpi-month")?.addEventListener("change", (event) => {
      event.target.dataset.userSelected = "1";
      scheduleAutoPreview(0);
    });

    el("lap-kpi-cards")?.addEventListener("click", (event) => {
      const toggle = event.target.closest(".kpi-card-toggle");
      if (!toggle) return;
      const detail = el(`kpi-employee-detail-${toggle.dataset.kpiIndex}`);
      if (!detail) return;
      const willExpand = detail.hidden;
      detail.hidden = !willExpand;
      const card = toggle.closest(".kpi-employee-card");
      if (card) card.classList.toggle("is-expanded", willExpand);
      setKpiToggleVisual(toggle, willExpand);
      syncKpiToggleAllButton();
    });

    function syncKpiToggleAllButton() {
      const container = el("lap-kpi-cards");
      const button = el("lap-kpi-toggle-all");
      if (!container || !button) return;

      const details = qsa(".kpi-employee-detail", container);
      const hasCards = details.length > 0;
      const allExpanded = hasCards && details.every((detail) => !detail.hidden);
      button.disabled = !hasCards;
      setKpiToggleVisual(button, allExpanded, true);
    }

    function setAllKpiCardsExpanded(expanded) {
      const container = el("lap-kpi-cards");
      if (!container) return;

      qsa(".kpi-employee-card", container).forEach((card) =>
        card.classList.toggle("is-expanded", expanded),
      );
      qsa(".kpi-employee-detail", container).forEach((detail) => {
        detail.hidden = !expanded;
      });
      qsa(".kpi-card-toggle", container).forEach((toggle) => {
        setKpiToggleVisual(toggle, expanded);
      });
      syncKpiToggleAllButton();
    }

    const kpiToggleAllButton = el("lap-kpi-toggle-all");
    if (kpiToggleAllButton && kpiToggleAllButton.dataset.bound !== "1") {
      kpiToggleAllButton.dataset.bound = "1";
      kpiToggleAllButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();

        const container = el("lap-kpi-cards");
        if (!container) return;

        const cards = qsa(".kpi-employee-card", container);
        const details = qsa(".kpi-employee-detail", container);
        if (!cards.length || !details.length) return;

        const allExpanded = cards.every((card) =>
          card.classList.contains("is-expanded"),
        );
        setAllKpiCardsExpanded(!allExpanded);
      });
    }

    generate.addEventListener("click", () => {
      if (!canKpiType(el("lap-kpi-type")?.value || "filling"))
        return toast("Anda tidak memiliki akses Laporan.", true);

      const { reports, period, selectedOperator, type, error } =
        collectKpiLaporanData({ finalize: true });
      const lineLabel = kpiTypeLabel(type);
      if (error || !period) {
        showError(error || `Data KPI ${lineLabel} tidak dapat dihitung.`);
        return;
      }
      if (!reports.length) {
        showError("");
        showKpiLaporan([], period, selectedOperator, false, type);
        return toast(
          `Tidak ada karyawan ${lineLabel} yang cocok dengan filter KPI.`,
          true,
        );
      }

      showError("");
      showKpiLaporan(reports, period, selectedOperator, true, type);
      toast(`Laporan KPI ${lineLabel} berhasil dibuat dari preview saat ini.`);
    });

    el("lap-kpi-export")?.addEventListener("click", () => {
      const reportSet = state.lastKpiLaporan;
      if (!reportSet || reportSet.isPreview) {
        return toast(
          "Klik Buat Laporan KPI terlebih dahulu sebelum Export CSV.",
          true,
        );
      }

      const rows = [];
      reportSet.reports.forEach((report) => {
        report.rows.forEach((row) => {
          rows.push([
            reportSet.id,
            `KPI ${reportSet.lineLabel}`,
            report.operator,
            report.period.label,
            row.no,
            row.field,
            row.indicator,
            row.weight,
            row.targetText,
            row.targetPercent,
            row.actualText,
            Number(row.achievement || 0).toFixed(2),
            Number(report.totalAchievement || 0).toFixed(2),
          ]);
        });
      });

      const csv = toCSV(
        [
          "ID Laporan KPI",
          "Jenis KPI",
          "Karyawan",
          "Periode",
          "No",
          "Bidang",
          "Indikator",
          "Bobot",
          "Target",
          "Target (%)",
          "Aktual",
          "Capaian Indikator (%)",
          "Total Capaian Karyawan (%)",
        ],
        rows,
      );
      downloadText(`${reportSet.id}.csv`, csv);
    });

    el("lap-kpi-pdf")?.addEventListener("click", openKpiLaporanPrintDialog);

    scheduleAutoPreview(0);
  }

  function matchesLaporanSearch(entry, query) {
    const keyword = String(query || "")
      .trim()
      .toLowerCase();
    if (!keyword) return true;
    return (
      [entry.operator, entry.produk, entry.botol].some((value) =>
        String(value || "")
          .toLowerCase()
          .includes(keyword),
      ) || Number(entry.qtyBotolPerKardus) === Number(keyword)
    );
  }

  function initLaporan() {
    const generate = el("lap-generate");
    if (!generate) return;

    let previewTimer = null;
    // Browser dapat memulihkan nilai <select> setelah refresh. Laporan harus
    // selalu dimulai dalam mode per pengerjaan sampai pengguna memilih sendiri.
    if (el("lap-operator-filter")) el("lap-operator-filter").value = "";
    updateLaporanEmployeeFilterLabel();

    function updatePeriodInputs() {
      const mode = el("lap-period-mode")?.value || "";
      if (el("lap-date-wrap")) el("lap-date-wrap").hidden = mode !== "date";
      if (el("lap-month-wrap")) el("lap-month-wrap").hidden = mode !== "month";
      if (el("lap-year-wrap")) el("lap-year-wrap").hidden = mode !== "year";
      if (el("lap-start-wrap")) el("lap-start-wrap").hidden = mode !== "range";
      if (el("lap-end-wrap")) el("lap-end-wrap").hidden = mode !== "range";
    }

    function collectLaporanData() {
      const line = el("lap-line")?.value || "all";
      const searchQuery = el("lap-search")?.value || "";
      const period = kpiReportPeriodFromInputs();

      // "Semua Periode" memakai seluruh data; filter tanggal diterapkan hanya
      // setelah pengguna memilih periode tertentu.

      // Laporan hanya memakai data yang sudah benar-benar dikonfirmasi Spreadsheet.
      let rows = state.reportEntries.filter((e) => !e._syncState);
      if (line !== "all") rows = rows.filter((e) => e.tab === line);
      rows = rows.filter((e) => dashboardDateInPeriod(e.tanggal, period));
      updateUniqueLaporanFilter(
        "lap-operator-filter",
        rows,
        "operator",
        "Semua Karyawan",
      );
      const exactFilters = {
        operator: String(el("lap-operator-filter")?.value || "").trim(),
      };
      rows = rows.filter((entry) =>
        Object.entries(exactFilters).every(
          ([field, value]) =>
            !value ||
            String(entry[field] || "")
              .trim()
              .toLocaleLowerCase("id") === value.trim().toLocaleLowerCase("id"),
        ),
      );
      rows = rows.filter((entry) => matchesLaporanSearch(entry, searchQuery));
      rows.sort((a, b) => String(a.tanggal).localeCompare(String(b.tanggal)));

      if (!rows.length) return { rows: [], period, line };

      // KPI pada Laporan Hasil Pengerjaan dihitung PER BARIS INPUT, bukan lagi
      // mengulang KPI agregat operator/periode ke setiap baris. Dengan demikian
      // setiap pengerjaan menunjukkan kontribusinya sendiri terhadap indikator KPI.
      //
      // KPI Hasil per varian = Total Hasil baris / target harian line × 100%.
      // Filling memakai target 7.500 dan Press memakai target 3.500.
      //
      // KPI Kardus Basah pada tabel ini dihitung untuk setiap baris agar perbedaan
      // Qty Pengerjaan Dus tetap terlihat. KPI Filling periode tetap dihitung dari
      // total harian sehingga batas 5 tidak berulang untuk setiap pengerjaan.
      // KPI Botol Pecah = Qty Botol Pecah / Total Qty Botol × 100%.
      // KPI APD = rata-rata penilaian APD operator pada tanggal pengerjaan baris.
      const apdByOperatorDate = new Map();
      (state.apdEntries || []).forEach((item) => {
        if (!item) return;
        const operatorKey = kpiOperatorKey(item.operator);
        const dateKey = String(item.tanggal || "").trim();
        if (!operatorKey || !dateKey) return;
        const key = `${operatorKey}||${dateKey}`;
        if (!apdByOperatorDate.has(key)) apdByOperatorDate.set(key, []);
        const value = Number(item.percentage);
        if (Number.isFinite(value)) apdByOperatorDate.get(key).push(value);
      });

      rows = rows.map((entry) => {
        const isFilling = entry.tab === "filling";
        const totalQty = Math.max(0, Number(entry.totalQty) || 0);
        const qtyBroken = Math.max(0, Number(entry.qtyBotolPecah) || 0);

        const outputTarget = isFilling
          ? KPI_VARIANT_DAILY_TARGETS.filling
          : KPI_VARIANT_DAILY_TARGETS.press;

        const apdKey = `${kpiOperatorKey(entry.operator)}||${String(entry.tanggal || "").trim()}`;
        const apdValues = apdByOperatorDate.get(apdKey) || [];

        return {
          ...entry,
          _kpiResult: totalQty > 0 ? (totalQty / outputTarget) * 100 : null,
          _kpiWetCarton: isFilling
            ? kpiFillingSpillPercent(entry.qtyKardusBasah, entry.qtyKardus)
            : null,
          _kpiBroken: !isFilling
            ? kpiVariantDefectPercent(qtyBroken, totalQty)
            : null,
          _kpiApd: averageKpiValues(apdValues),
        };
      });

      // Tampilan awal tetap satu baris per pengerjaan. Agregasi baru digunakan
      // ketika pengguna secara khusus memilih Nama Karyawan.
      const hasEmployeeFilter = exactFilters.operator.length > 0;
      if (hasEmployeeFilter) rows = aggregateLaporanRows(rows);

      return { rows, period, line };
    }

    function setReportExportState(enabled) {
      ["lap-export", "lap-pdf", "lap-print"].forEach((id) => {
        const button = el(id);
        if (button) button.disabled = !enabled;
      });
    }

    function showLaporan(rows, period, line = "all", finalize = false) {
      const result = el("lap-result");
      if (!result) return false;

      if (!rows.length) {
        state.lastLaporan = null;
        result.hidden = true;
        setReportExportState(false);
        return false;
      }

      const id = finalize ? genLaporanId() : "PREVIEW";
      state.lastLaporan = { id, rows, period, line, isPreview: !finalize };
      state.pages.laporan = 1;

      el("lap-id").textContent = finalize ? id : "PREVIEW OTOMATIS";
      el("lap-created").textContent = finalize
        ? fmtDateTime(nowIso())
        : "Belum dibuat";
      el("lap-by").textContent =
        `${state.currentUser?.name || state.currentUser?.username || "—"} (${state.currentUser?.role === "superuser" ? "Super User" : "User"})`;
      el("lap-period").textContent = period.label;
      el("lap-total-entries").textContent = rows.length;
      const quantityTotals = laporanQtyTotals(rows);
      el("lap-total-kardus").textContent =
        quantityTotals.kardus.toLocaleString("id-ID");
      el("lap-total-pcs").textContent =
        quantityTotals.pcs.toLocaleString("id-ID");
      el("lap-total-qty").textContent = rows
        .reduce((sum, e) => sum + (Number(e.totalQty) || 0), 0)
        .toLocaleString("id-ID");

      const qualityTotals = rows.reduce(
        (totals, entry) => {
          totals.fillingBroken +=
            entry.tab === "filling"
              ? Number(entry.qtyBotolPecah) || 0
              : Number(entry.qtyBotolPecahFilling) || 0;
          totals.pressBroken +=
            entry.tab === "press"
              ? Number(entry.qtyBotolPecah) || 0
              : Number(entry.qtyBotolPecahPress) || 0;
          totals.wetCarton += Number(entry.qtyKardusBasah) || 0;
          return totals;
        },
        { fillingBroken: 0, pressBroken: 0, wetCarton: 0 },
      );
      el("lap-total-pecah-filling").textContent =
        qualityTotals.fillingBroken.toLocaleString("id-ID");
      el("lap-total-pecah-press").textContent =
        qualityTotals.pressBroken.toLocaleString("id-ID");
      el("lap-total-kardus-basah").textContent =
        qualityTotals.wetCarton.toLocaleString("id-ID");

      const fillingDamageCard = el("lap-stat-pecah-filling");
      const pressDamageCard = el("lap-stat-pecah-press");
      const wetCartonCard = el("lap-stat-kardus-basah");
      const buildDamageDetail = (label, valueForEntry) => {
        const byBottle = new Map();
        rows.forEach((entry) => {
          const qty = Math.max(0, Number(valueForEntry(entry)) || 0);
          if (!qty) return;
          const bottle = String(entry.botol || "Botol tidak diketahui").trim();
          byBottle.set(bottle, (byBottle.get(bottle) || 0) + qty);
        });
        const details = Array.from(byBottle.entries())
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "id"))
          .map(
            ([bottle, qty]) =>
              `${bottle}: ${qty.toLocaleString("id-ID")} botol`,
          );
        return `${label} (${period.label})\n${details.length ? details.join("\n") : "Tidak ada botol pecah."}`;
      };
      const setDamageTooltip = (card, detail) => {
        if (!card) return;
        card.classList.add("damage-detail-card");
        card.dataset.damageTooltip = detail;
        card.setAttribute("tabindex", "0");
        card.setAttribute("aria-label", detail.replace(/\n/g, ". "));
      };
      setDamageTooltip(
        fillingDamageCard,
        buildDamageDetail("Detail Botol Pecah Filling", laporanBrokenFilling),
      );
      setDamageTooltip(
        pressDamageCard,
        buildDamageDetail("Detail Botol Pecah Press", laporanBrokenPress),
      );
      const reportStats = fillingDamageCard?.closest(".report-stats");
      if (fillingDamageCard) fillingDamageCard.hidden = line === "press";
      if (pressDamageCard) pressDamageCard.hidden = line === "filling";
      if (wetCartonCard) wetCartonCard.hidden = line === "press";
      if (reportStats) {
        reportStats.dataset.statCount =
          line === "press" ? "5" : line === "filling" ? "6" : "7";
      }

      renderLaporanRows();
      result.hidden = false;
      result.dataset.preview = finalize ? "false" : "true";
      setReportExportState(finalize);
      return true;
    }

    function refreshAutoPreview() {
      if (el("view-laporan")?.hidden) return;
      if (!can("accessWorkReport")) return;
      const { rows, period, line } = collectLaporanData();
      showLaporan(rows, period, line, false);
    }

    function scheduleAutoPreview(delay = 120) {
      clearTimeout(previewTimer);
      previewTimer = setTimeout(refreshAutoPreview, delay);
    }

    // Dapat dipanggil kembali sesudah bootstrap / refresh data Spreadsheet selesai.
    window.refreshLaporanAutoPreview = () => scheduleAutoPreview(0);

    const periodMode = el("lap-period-mode");
    periodMode?.addEventListener("change", () => {
      updatePeriodInputs();
      scheduleAutoPreview(0);
    });
    updatePeriodInputs();

    // Semua perubahan filter langsung memperbarui preview.
    el("lap-line")?.addEventListener("change", () => scheduleAutoPreview(0));
    el("lap-search")?.addEventListener("input", () => scheduleAutoPreview(180));
    el("lap-search")?.addEventListener("change", () => scheduleAutoPreview(0));
    el("lap-operator-filter")?.addEventListener("change", () => {
      updateLaporanEmployeeFilterLabel();
      syncLaporanKeywordVisibility();
      scheduleAutoPreview(0);
    });
    el("lap-employee-filter-summary")?.addEventListener("click", () => {
      const toggle = el("lap-employee-filter-summary");
      const opening = toggle?.getAttribute("aria-pressed") !== "true";
      if (toggle) toggle.setAttribute("aria-pressed", String(opening));
      if (!opening && el("lap-operator-filter")) {
        el("lap-operator-filter").value = "";
        updateLaporanEmployeeFilterLabel();
      }
      syncLaporanKeywordVisibility();
      scheduleAutoPreview(0);
    });
    syncLaporanKeywordVisibility();
    ["lap-date", "lap-month", "lap-year", "lap-start", "lap-end"].forEach(
      (id) => {
        el(id)?.addEventListener("input", () => scheduleAutoPreview(120));
        el(id)?.addEventListener("change", () => scheduleAutoPreview(0));
      },
    );

    // Preview awal akan muncul otomatis jika cache/data sudah tersedia.
    scheduleAutoPreview(0);

    generate.addEventListener("click", () => {
      if (!can("accessWorkReport"))
        return toast("Anda tidak memiliki akses Laporan.", true);
      const { rows, period, line } = collectLaporanData();
      if (!rows.length) {
        showLaporan([], period, line, false);
        toast("Tidak ada data yang cocok dengan filter laporan.", true);
        return;
      }
      showLaporan(rows, period, line, true);
      toast("Laporan berhasil dibuat dari preview saat ini.");
    });

    el("lap-export")?.addEventListener("click", () => {
      if (!state.lastLaporan || state.lastLaporan.isPreview) {
        return toast(
          "Klik Buat Laporan terlebih dahulu sebelum Export CSV.",
          true,
        );
      }
      const metricColumns = laporanMetricColumns(state.lastLaporan.line);
      const showFillingBroken = state.lastLaporan.line !== "press";
      const showPressBroken = state.lastLaporan.line !== "filling";
      const csv = toCSV(
        [
          "ID Laporan",
          "ID Pengerjaan",
          "Line",
          "Tanggal",
          "Operator",
          "Produk",
          "Botol",
          "Qty Botol (Kardus)",
          "Qty Pengerjaan",
          "Satuan",
          "Total Qty",
          ...(showFillingBroken ? ["Botol Pecah Filling"] : []),
          ...(showPressBroken ? ["Botol Pecah Press"] : []),
          ...metricColumns.map((column) => column.label),
        ],
        state.lastLaporan.rows.map((e) => [
          state.lastLaporan.id,
          e.reportId,
          laporanLineLabel(e.tab),
          e.tanggal,
          e.operator,
          e.produk,
          e.botol,
          laporanQtyPerCartonDisplay(e),
          e.qtyKardus,
          laporanQtyUnit(e),
          e.totalQty,
          ...(showFillingBroken ? [laporanBrokenFilling(e)] : []),
          ...(showPressBroken ? [laporanBrokenPress(e)] : []),
          ...metricColumns.map((column) => kpiReportDisplay(e[column.key])),
        ]),
      );
      downloadText(`${state.lastLaporan.id}.csv`, csv);
    });

    el("lap-pdf")?.addEventListener("click", () => {
      if (!state.lastLaporan || state.lastLaporan.isPreview) {
        return toast(
          "Klik Buat Laporan terlebih dahulu sebelum Export PDF.",
          true,
        );
      }
      openLaporanPrintDialog("pdf");
    });
    el("lap-print")?.addEventListener("click", () => {
      if (!state.lastLaporan || state.lastLaporan.isPreview) {
        return toast(
          "Klik Buat Laporan terlebih dahulu sebelum mencetak.",
          true,
        );
      }
      openLaporanPrintDialog("print");
    });
  }

  /* ------------------------- MASTER ------------------------- */

  /* =========================================================
   SEE MORE MASTER DATA
   Untuk seluruh kategori data master
   ========================================================= */
  function updateMasterSeeMore(category, wrap) {
    const isLimited = ["operator", "produk", "botol", "botolpecah"].includes(
      category,
    );

    if (!isLimited) {
      wrap.classList.remove("limit-6", "show-all");
      return;
    }

    // Aktifkan CSS pembatas 6 item
    wrap.classList.add("limit-6");

    const parent = wrap.parentElement;
    if (!parent) return;

    // Cari tombol jika sebelumnya sudah pernah dibuat
    let button = parent.querySelector(
      `.see-more-btn[data-see-more="${category}"]`,
    );

    // Kalau belum ada, buat otomatis
    if (!button) {
      button = document.createElement("button");

      button.type = "button";
      button.className = "see-more-btn";
      button.dataset.seeMore = category;

      // Letakkan setelah daftar chip
      wrap.insertAdjacentElement("afterend", button);

      button.addEventListener("click", () => {
        const isOpen = wrap.classList.toggle("show-all");

        const total = wrap.querySelectorAll(".chip").length;
        const remaining = Math.max(0, total - 6);

        button.textContent = isOpen
          ? "Sembunyikan"
          : `Lihat lainnya (${remaining})`;
      });
    }

    // Hitung jumlah data
    const total = wrap.querySelectorAll(".chip").length;

    if (total > 6) {
      button.hidden = false;

      const remaining = total - 6;

      button.textContent = wrap.classList.contains("show-all")
        ? "Sembunyikan"
        : `Lihat lainnya (${remaining})`;
    } else {
      // Kalau data <= 6, tombol tidak perlu ditampilkan
      wrap.classList.remove("show-all");
      button.hidden = true;
    }
  }

  function renderMasterChips() {
    ["operator", "produk", "botol", "botolpecah"].forEach((category) => {
      const wrap = qs(`.chip-list[data-cat="${category}"]`);

      if (!wrap) return;

      const values = state.master[category] || [];

      wrap.innerHTML = values.length
        ? values
            .map((value) => {
              const readonly = category === "botolpecah";

              return `
            <span class="chip">
              ${esc(value)}
              ${
                readonly
                  ? ""
                  : `
                    <button
                      type="button"
                      data-cat="${category}"
                      data-value="${esc(value)}"
                      title="Hapus"
                    >
                      ✕
                    </button>
                  `
              }
            </span>
          `;
            })
            .join("")
        : `
        <span style="
          color:var(--ink-faint);
          font-size:12px;
        ">
          Belum ada data.
        </span>
      `;

      /* =========================================
       UPDATE SEE MORE
       ========================================= */
      updateMasterSeeMore(category, wrap);
    });

    renderDashboard();
  }

  function initMasterData() {
    qsa(".chip-list").forEach((wrap) => {
      wrap.addEventListener("click", async (event) => {
        const btn = event.target.closest("button[data-cat]");
        if (!btn) return;
        if (!canLevel("master", "write"))
          return toast(
            "Anda tidak memiliki akses Setting / Master Data.",
            true,
          );
        if (
          !(await confirmDelete({
            title: "Hapus master data?",
            message: "Item ini akan dihapus dari daftar master.",
            item: btn.dataset.value,
          }))
        )
          return;
        try {
          const data = await apiPost("master.remove", {
            category: btn.dataset.cat,
            value: btn.dataset.value,
          });
          state.master = data.master;
          renderMasterChips();
          refreshAllDropdowns();
          toast("Master data berhasil dihapus.");
        } catch (err) {
          toast(err.message, true);
        }
      });
    });

    qsa(".chip-add").forEach((wrap) => {
      const category = wrap.dataset.cat;
      if (category === "botolpecah") return;
      const input = qs("input", wrap);
      const btn = qs("button", wrap);
      if (!input || !btn) return;

      async function addMaster() {
        if (!canLevel("master", "write"))
          return toast(
            "Anda tidak memiliki akses Setting / Master Data.",
            true,
          );
        const value = input.value.trim();
        if (!value) return;
        btn.disabled = true;
        try {
          const data = await apiPost("master.add", { category, value });
          state.master = data.master;
          input.value = "";
          renderMasterChips();
          refreshAllDropdowns();
          toast("Master data berhasil ditambahkan.");
        } catch (err) {
          toast(err.message, true);
        } finally {
          btn.disabled = false;
        }
      }

      btn.addEventListener("click", addMaster);
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          addMaster();
        }
      });
    });

    el("masterReload")?.addEventListener("click", async (event) => {
      if (!canLevel("master", "write"))
        return toast("Anda tidak memiliki akses Setting / Master Data.", true);
      const btn = event.currentTarget;
      btn.disabled = true;
      try {
        await loadAppData(true);
        toast("Data terbaru sudah dimuat dari Spreadsheet.");
      } catch (err) {
        toast(err.message, true);
      } finally {
        btn.disabled = false;
      }
    });

    el("masterCsvExport")?.addEventListener("click", () => {
      if (!canLevel("master", "write"))
        return toast("Anda tidak memiliki akses Setting / Master Data.", true);
      const op = state.master.operator || [];
      const produk = state.master.produk || [];
      const botol = state.master.botol || [];
      const max = Math.max(op.length, produk.length, botol.length);
      const rows = Array.from({ length: max }, (_, i) => [
        op[i] || "",
        produk[i] || "",
        botol[i] || "",
      ]);
      downloadText(
        `master-data-${todayStr()}.csv`,
        toCSV(["Nama Operator", "Nama Produk", "Nama Botol"], rows),
      );
    });
  }

  /* ------------------------- USERS ------------------------- */
  function renderUsers() {
    const tbody = el("userTbody");
    if (!tbody) return;
    if (!state.currentUser || state.currentUser.role !== "superuser") {
      tbody.innerHTML = "";
      return;
    }
    tbody.innerHTML = state.users
      .map(
        (user) => `
      <tr>
        <td>${esc(user.name)}</td>
        <td class="mono">${esc(user.username)}</td>
        <td><span class="role-tag ${esc(user.role)}">${user.role === "superuser" ? "Super User" : "User"}</span></td>
        <td class="row-actions">
          ${user.role === "user" ? `<button type="button" class="btn btn-ghost btn-access-user" data-username="${esc(user.username)}">Atur Akses</button>` : '<span class="permission-full">Akses penuh</span>'}
          <button type="button" class="btn btn-ghost btn-reset-user" data-username="${esc(user.username)}">Reset Password</button>
          ${user.username === state.currentUser.username ? "" : `<button type="button" class="btn btn-danger btn-del-user" data-username="${esc(user.username)}">Hapus</button>`}
        </td>
      </tr>`,
      )
      .join("");
  }

  function initUserManagement() {
    initPasswordToggle("resetPasswordNew");
    initPasswordToggle("resetPasswordConfirm");
    const form = el("userAddForm");
    const tbody = el("userTbody");
    if (!form || !tbody) return;
    const modal = el("permissionModal");
    const permissionGrid = el("permissionGrid");
    const resetModal = el("resetPasswordModal");
    const resetForm = el("resetPasswordForm");
    let permissionUsername = "";
    let resetUsername = "";

    function closeResetPasswordModal() {
      resetUsername = "";
      resetForm?.reset();
      if (el("resetPasswordError")) el("resetPasswordError").hidden = true;
      if (resetModal) resetModal.hidden = true;
    }

    function openResetPasswordModal(user) {
      if (!resetModal || !user || state.currentUser?.role !== "superuser")
        return;
      resetForm?.reset();
      resetUsername = user.username;
      el("resetPasswordUserLabel").textContent =
        `${user.name} (@${user.username})`;
      el("resetPasswordError").hidden = true;
      resetModal.hidden = false;
      el("resetPasswordNew")?.focus();
    }

    el("resetPasswordClose")?.addEventListener(
      "click",
      closeResetPasswordModal,
    );
    el("resetPasswordCancel")?.addEventListener(
      "click",
      closeResetPasswordModal,
    );
    resetModal?.addEventListener("click", (event) => {
      if (event.target === resetModal) closeResetPasswordModal();
    });
    resetForm?.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!resetUsername || state.currentUser?.role !== "superuser") return;
      const password = el("resetPasswordNew").value;
      const confirmPassword = el("resetPasswordConfirm").value;
      const error = el("resetPasswordError");
      if (password !== confirmPassword) {
        error.textContent = "Konfirmasi password tidak sama.";
        error.hidden = false;
        return;
      }
      const button = el("resetPasswordSave");
      button.disabled = true;
      error.hidden = true;
      try {
        const target = resetUsername;
        await apiPost("user.password.reset", { username: target, password });
        closeResetPasswordModal();
        if (target === state.currentUser.username) {
          state.token = "";
          localStorage.removeItem(CONFIG.TOKEN_KEY);
          localStorage.removeItem(CONFIG.USER_KEY);
          window.location.replace("login.html");
          return;
        }
        toast(`Password ${target} berhasil direset. User perlu login kembali.`);
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
      } finally {
        button.disabled = false;
      }
    });
    const permissionScopes = [
      ["dashboard", "Dashboard"],
      ["spk", "SPK"],
      ["filling", "Filling"],
      ["press", "Press"],
      ["apd", "APD"],
      ["reports", "Laporan"],
      ["workReport", "Laporan Hasil Pengerjaan"],
      ["spkReport", "Data SPK"],
      ["kpiFilling", "Laporan KPI Filling"],
      ["kpiPress", "Laporan KPI Press"],
      ["kpiSpv", "Laporan KPI SPV Produksi"],
      ["master", "Data Master (Sumber Search)"],
      ["kpiSettings", "Pengaturan KPI"],
    ];
    if (permissionGrid) {
      permissionGrid.innerHTML = `<div class="permission-table-wrap"><table class="permission-table"><thead><tr><th>Bagian</th><th>Read</th><th>Write</th><th>Administrator</th><th>Kelola Sendiri</th><th>Kelola User Lain</th><th>Export CSV</th></tr></thead><tbody>${permissionScopes.map(([scope, title]) => `<tr data-scope="${scope}" ${["workReport", "spkReport", "kpiFilling", "kpiPress", "kpiSpv"].includes(scope) ? 'class="permission-child"' : ""}><th scope="row">${title}</th>${["read", "write", "admin"].map((level) => `<td><label><input type="checkbox" data-level="${level}" aria-label="${title}: ${level}" ${["dashboard", "reports", "workReport", "spkReport", "kpiFilling", "kpiPress", "kpiSpv"].includes(scope) && level === "write" ? 'disabled title="Bagian ini tidak memiliki aksi tulis"' : ""}></label></td>`).join("")}${["own", "others"].map((owner) => `<td><label><input type="checkbox" data-manage="${owner}" aria-label="${title}: kelola data ${owner === "own" ? "sendiri" : "user lain"}" ${["spk", "filling", "press", "apd"].includes(scope) ? "" : 'disabled title="Tidak berlaku pada bagian ini"'}></label></td>`).join("")}<td><label><input type="checkbox" data-export-csv aria-label="${title}: Export CSV" ${["filling", "press"].includes(scope) ? "" : 'disabled title="Export CSV khusus Filling dan Press"'}></label></td></tr>`).join("")}</tbody></table></div><p class="hint-text">Export CSV dapat diberikan secara terpisah untuk Filling dan Press. Kelola Sendiri dan Kelola User Lain berlaku pada SPK, Filling, Press, dan APD.</p>`;
      function syncManagement(row, reset) {
        if (!["spk", "filling", "press", "apd"].includes(row.dataset.scope))
          return;
        const admin = qs('[data-level="admin"]', row).checked;
        const write = qs('[data-level="write"]', row).checked;
        qsa("input[data-manage]", row).forEach((input) => {
          if (admin) input.checked = true;
          else if (!write) input.checked = false;
          else if (reset) input.checked = input.dataset.manage === "own";
          input.disabled = admin || !write;
        });
      }
      function syncReportChildren(reset) {
        const parent = qs('tr[data-scope="reports"]', permissionGrid);
        const admin = qs('[data-level="admin"]', parent).checked;
        const read = qs('[data-level="read"]', parent).checked;
        qsa("tr.permission-child", permissionGrid).forEach((row) => {
          qsa('input[data-level]:not([data-level="write"])', row).forEach(
            (child) => {
              if (admin) child.checked = true;
              else if (!read || reset) child.checked = false;
              child.disabled = admin || !read;
            },
          );
        });
      }
      permissionGrid.addEventListener("change", (event) => {
        const input = event.target.closest("input[data-level]");
        if (!input) return;
        const row = input.closest("tr");
        const check = (level, value) => {
          const node = qs(`[data-level="${level}"]`, row);
          if (node && !node.disabled) node.checked = value;
        };
        if (input.checked && input.dataset.level === "admin") {
          check("write", true);
          check("read", true);
        }
        if (input.checked && input.dataset.level === "write")
          check("read", true);
        if (!input.checked && input.dataset.level === "read") {
          check("write", false);
          check("admin", false);
        }
        if (!input.checked && input.dataset.level === "write")
          check("admin", false);
        if (row.dataset.scope === "reports") syncReportChildren(true);
        if (input.dataset.level) syncManagement(row, true);
      });
      permissionGrid.syncReportChildren = syncReportChildren;
      permissionGrid.syncManagement = syncManagement;
    }

    function closePermissionModal() {
      permissionUsername = "";
      if (modal) modal.hidden = true;
    }

    function openPermissionModal(user) {
      if (!modal || !permissionGrid) {
        toast("Komponen popup Hak Akses tidak ditemukan.", true);
        return;
      }
      if (!user) {
        toast("Data user untuk pengaturan Hak Akses tidak ditemukan.", true);
        return;
      }
      if (
        String(user.role || "")
          .trim()
          .toLowerCase() !== "user"
      ) {
        toast("Hak akses khusus hanya dapat diatur untuk User Biasa.", true);
        return;
      }
      permissionUsername = user.username;
      el("permissionUserLabel").textContent =
        `${user.name} (@${user.username})`;
      const perms = {
        ...DEFAULT_USER_PERMISSIONS,
        ...(user.permissions || {}),
      };
      qsa("tr[data-scope]", permissionGrid).forEach((row) => {
        const scope = row.dataset.scope;
        const level = perms.levels?.[scope] || "none";
        const rank = { none: 0, read: 1, write: 2, admin: 3 };
        qsa("input[data-level]", row).forEach((input) => {
          if (
            row.classList.contains("permission-child") &&
            input.dataset.level !== "write"
          )
            input.disabled = false;
          input.checked =
            !input.disabled && rank[level] >= rank[input.dataset.level];
        });
        qsa("input[data-manage]", row).forEach((input) => {
          const selected = perms.management?.[scope]?.[input.dataset.manage];
          input.checked =
            selected === true ||
            (selected === undefined &&
              (level === "admin" ||
                (level === "write" && input.dataset.manage === "own")));
        });
        const exportCsv = qs("input[data-export-csv]", row);
        if (exportCsv) {
          exportCsv.checked =
            scope === "filling"
              ? perms.accessExportFillingCsv === true
              : scope === "press"
                ? perms.accessExportPressCsv === true
                : false;
        }
        permissionGrid.syncManagement(row, false);
      });
      permissionGrid.syncReportChildren(false);
      modal.hidden = false;
    }

    el("permissionClose")?.addEventListener("click", closePermissionModal);
    modal?.addEventListener("click", (event) => {
      if (event.target === modal) closePermissionModal();
    });
    el("permissionSave")?.addEventListener("click", async () => {
      if (
        !permissionUsername ||
        !state.currentUser ||
        state.currentUser.role !== "superuser"
      )
        return;
      const btn = el("permissionSave");
      btn.disabled = true;
      try {
        const permissions = {
          levels: {},
          management: {},
          accessExportFillingCsv: false,
          accessExportPressCsv: false,
        };
        qsa("tr[data-scope]", permissionGrid).forEach((row) => {
          permissions.levels[row.dataset.scope] = qs(
            '[data-level="admin"]',
            row,
          ).checked
            ? "admin"
            : qs('[data-level="write"]', row).checked
              ? "write"
              : qs('[data-level="read"]', row).checked
                ? "read"
                : "none";
        });
        ["spk", "filling", "press", "apd"].forEach((scope) => {
          const row = qs(`tr[data-scope="${scope}"]`, permissionGrid);
          permissions.management[scope] = {
            own: qs('[data-manage="own"]', row).checked,
            others: qs('[data-manage="others"]', row).checked,
          };
        });
        permissions.accessExportFillingCsv = qs(
          'tr[data-scope="filling"] input[data-export-csv]',
          permissionGrid,
        ).checked;
        permissions.accessExportPressCsv = qs(
          'tr[data-scope="press"] input[data-export-csv]',
          permissionGrid,
        ).checked;
        if (permissions.levels.reports !== "read") {
          [
            "workReport",
            "spkReport",
            "kpiFilling",
            "kpiPress",
            "kpiSpv",
          ].forEach((scope) => {
            permissions.levels[scope] = "none";
          });
        }
        const data = await apiPost("user.permissions.set", {
          username: permissionUsername,
          permissions,
        });
        state.users = data.users || [];
        renderUsers();
        closePermissionModal();
        toast("Hak akses user berhasil disimpan.");
      } catch (err) {
        toast(err.message, true);
      } finally {
        btn.disabled = false;
      }
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const submit = qs('button[type="submit"]', form);
      submit.disabled = true;
      try {
        const data = await apiPost("user.add", {
          name: el("newUserName").value.trim(),
          username: el("newUserUsername").value.trim(),
          password: el("newUserPassword").value,
          role: el("newUserRole").value,
        });
        state.users = data.users || [];
        form.reset();
        renderUsers();
        toast("User berhasil ditambahkan.");
      } catch (err) {
        toast(err.message, true);
      } finally {
        submit.disabled = false;
      }
    });

    document.addEventListener(
      "click",
      async (event) => {
        const target =
          event.target instanceof Element
            ? event.target
            : event.target?.parentElement;
        const accessBtn = target?.closest(".btn-access-user");
        if (accessBtn) {
          if (!accessBtn.closest("#userTbody")) return;
          event.preventDefault();
          event.stopPropagation();
          const targetUsername = String(accessBtn.dataset.username || "")
            .trim()
            .toLowerCase();
          const user = state.users.find(
            (item) =>
              String(item.username || "")
                .trim()
                .toLowerCase() === targetUsername,
          );
          openPermissionModal(user);
          return;
        }
        const resetBtn = target?.closest(".btn-reset-user");
        if (resetBtn) {
          if (!resetBtn.closest("#userTbody")) return;
          const user = state.users.find(
            (item) => item.username === resetBtn.dataset.username,
          );
          openResetPasswordModal(user);
          return;
        }
        const btn = target?.closest(".btn-del-user");
        if (!btn) return;
        if (!btn.closest("#userTbody")) return;
        if (
          !(await confirmDelete({
            title: "Hapus pengguna?",
            message:
              "Akun pengguna ini tidak akan dapat mengakses sistem lagi.",
            item: btn.dataset.username,
          }))
        )
          return;
        try {
          const data = await apiPost("user.remove", {
            username: btn.dataset.username,
          });
          state.users = data.users || [];
          renderUsers();
          toast("User berhasil dihapus.");
        } catch (err) {
          toast(err.message, true);
        }
      },
      true,
    );
  }

  function initLogout() {
    el("logoutBtn")?.addEventListener("click", async () => {
      try {
        if (state.token) await apiPost("logout");
      } catch (_) {}
      state.token = "";
      localStorage.removeItem(CONFIG.TOKEN_KEY);
      localStorage.removeItem(CONFIG.USER_KEY);
      window.location.replace("login.html");
    });
  }

  let autosaveRunning = false;
  let lastAutosaveAt = Date.now();

  async function runAutosave() {
    if (autosaveRunning || !state.currentUser) return;
    autosaveRunning = true;

    try {
      // Cadangan lokal selalu diperbarui, termasuk ketika perangkat sedang
      // offline. Form yang belum masuk Preview juga tetap dapat dipulihkan.
      persistPreview();
      saveFormDraft("filling", qs("#fillingFormPopup .form-panel"));
      saveFormDraft("press", qs("#pressFormPopup .form-panel"));

      if (navigator.onLine === false) return;

      const spkButton = el("spkSaveButton");
      const fillingButton = qs("#view-filling .f-save-btn");
      const apdButton = el("apdSaveBtn");

      if (
        canLevel("spk", "write") &&
        state.preview.spk?.length &&
        !spkButton?.disabled
      ) {
        spkButton?.click();
      }
      if (
        canLevel("filling", "write") &&
        state.preview.filling?.length &&
        !fillingButton?.disabled
      ) {
        fillingButton?.click();
      }
      if (
        canLevel("apd", "write") &&
        state.preview.apd?.length &&
        !apdButton?.disabled
      ) {
        apdButton?.click();
      }

      // Tunggu SPK/Filling/APD selesai. Press bergantung pada saldo Filling
      // tersimpan sehingga tidak boleh dimulai dalam waktu yang bersamaan.
      await writeQueue;

      const pressButton = qs("#view-press .f-save-btn");
      if (
        state.preview.press?.length &&
        !state.preview.filling?.length &&
        canLevel("press", "write") &&
        !pressButton?.disabled
      ) {
        pressButton?.click();
        await writeQueue;
      }
    } catch (error) {
      console.warn(
        "Autosave gagal; data tetap tersimpan di preview lokal:",
        error,
      );
    } finally {
      persistPreview();
      lastAutosaveAt = Date.now();
      autosaveRunning = false;
    }
  }

  function initAutosave() {
    window.setInterval(runAutosave, CONFIG.AUTOSAVE_INTERVAL_MS);
    document.addEventListener("visibilitychange", () => {
      // Jika interval terlewat karena tab browser ditidurkan, jalankan saat
      // pengguna kembali tanpa menunggu 15 menit berikutnya.
      if (
        document.visibilityState === "visible" &&
        Date.now() - lastAutosaveAt >= CONFIG.AUTOSAVE_INTERVAL_MS
      ) {
        runAutosave();
      }
    });
  }

  async function preloadAppViews() {
    const content = qs(".content");
    if (!content) return false;

    const pages = {
      dashboard: "index.html",
      spk: "spk.html",
      filling: "filling.html",
      press: "press.html",
      apd: "apd.html",
      laporan: "laporan.html",
      master: "setting.html",
    };
    const missing = Object.entries(pages).filter(
      ([view]) => !el("view-" + view),
    );
    if (!missing.length) {
      allAppViewsLoaded = true;
      return true;
    }

    try {
      const loaded = await Promise.all(
        missing.map(async ([view, url]) => {
          const response = await fetch(url, { cache: "force-cache" });
          if (!response.ok) throw new Error(`Gagal memuat ${url}`);
          const documentPage = new DOMParser().parseFromString(
            await response.text(),
            "text/html",
          );
          const section = documentPage.getElementById("view-" + view);
          if (!section) throw new Error(`View ${view} tidak ditemukan`);
          section.hidden = true;
          return section;
        }),
      );
      loaded.forEach((section) => content.appendChild(section));
      allAppViewsLoaded = true;
      return true;
    } catch (error) {
      console.warn("Mode tab instan tidak tersedia:", error);
      return false;
    }
  }

  function initExcelTableFilters() {
    if (document.body.dataset.excelFiltersReady === "1") return;
    document.body.dataset.excelFiltersReady = "1";

    const tableStates = new WeakMap();
    let filtersVisible = true;
    let activePopup = null;
    let applying = false;

    // Tabel operasional ini memakai kontrol pencarian/seleksi sendiri dan
    // sengaja tidak menerima filter header Excel.
    document
      .querySelectorAll("#spkTableBody, #fillingSpkBody, .press-balance-tbody")
      .forEach((body) => {
        const table = body.closest("table");
        if (table) table.dataset.excelFilterDisabled = "true";
      });

    const cellText = (cell) =>
      String(cell?.textContent || "")
        .replace(/\s+/g, " ")
        .trim();

    function stateFor(table) {
      if (!tableStates.has(table)) {
        const state = { filters: new Map(), sort: null };
        tableStates.set(table, state);
        table.__excelFilterState = state;
      }
      return tableStates.get(table);
    }

    function closePopup() {
      activePopup?.remove();
      activePopup = null;
    }

    function refreshButtons(table) {
      const state = stateFor(table);
      table.querySelectorAll("thead .excel-filter-btn").forEach((button) => {
        const index = Number(button.dataset.columnIndex);
        button.classList.toggle("is-filtered", state.filters.has(index));
        button.classList.toggle(
          "is-sorted",
          Boolean(state.sort && state.sort.index === index),
        );
        button.hidden = !filtersVisible;
      });
    }

    function applyTable(table) {
      if (!table?.tBodies?.length) return;
      // Tabel yang sudah terhubung ke sumber data difilter sebelum pagination
      // melalui applyExcelDataFilter(). Jangan filter ulang dari teks DOM,
      // karena angka tampilan seperti "1.000" berbeda dari nilai sumber 1000.
      if (table.__excelData) {
        refreshButtons(table);
        return;
      }
      const state = stateFor(table);
      const tbody = table.tBodies[0];
      const rows = Array.from(tbody.rows);
      applying = true;
      try {
        rows.forEach((row) => {
          const visible = Array.from(state.filters.entries()).every(
            ([index, selected]) => selected.has(cellText(row.cells[index])),
          );
          row.hidden = !visible;
        });

        if (state.sort) {
          const { index, direction } = state.sort;
          const sortedRows = rows.slice().sort((a, b) => {
            const left = cellText(a.cells[index]);
            const right = cellText(b.cells[index]);
            const leftNumber = Number(
              left
                .replace(/[^0-9,.-]/g, "")
                .replace(/\./g, "")
                .replace(",", "."),
            );
            const rightNumber = Number(
              right
                .replace(/[^0-9,.-]/g, "")
                .replace(/\./g, "")
                .replace(",", "."),
            );
            const compared =
              left && right && isFinite(leftNumber) && isFinite(rightNumber)
                ? leftNumber - rightNumber
                : left.localeCompare(right, "id", {
                    numeric: true,
                    sensitivity: "base",
                  });
            return direction === "desc" ? -compared : compared;
          });
          if (sortedRows.some((row, rowIndex) => row !== rows[rowIndex])) {
            sortedRows.forEach((row) => tbody.appendChild(row));
          }
        }
      } finally {
        applying = false;
      }
      refreshButtons(table);
    }

    function openPopup(table, index, button) {
      closePopup();
      const state = stateFor(table);
      const source = table.__excelData;
      // Nilai pada dropdown mengikuti filter kolom lain yang sudah aktif.
      // Contoh: setelah Operator dipilih, Produk/Botol hanya menampilkan
      // kombinasi yang memang dikerjakan operator tersebut.
      const sourceRows = source
        ? source.rows.filter((row) =>
            Array.from(state.filters.entries()).every(
              ([filterIndex, selected]) =>
                filterIndex === index ||
                selected.has(
                  String(source.columns[filterIndex]?.(row) ?? "").trim(),
                ),
            ),
          )
        : Array.from(table.tBodies[0]?.rows || []).filter((row) =>
            Array.from(state.filters.entries()).every(
              ([filterIndex, selected]) =>
                filterIndex === index ||
                selected.has(cellText(row.cells[filterIndex])),
            ),
          );
      const values = (
        source
          ? sourceRows.map((row) =>
              String(source.columns[index]?.(row) ?? "").trim(),
            )
          : sourceRows.map((row) => cellText(row.cells[index]))
      )
        .filter((value, position, list) => list.indexOf(value) === position)
        .sort((a, b) =>
          a.localeCompare(b, "id", { numeric: true, sensitivity: "base" }),
        );
      const selected = state.filters.get(index) || new Set(values);
      const popup = document.createElement("div");
      popup.className = "excel-filter-popup";
      popup.innerHTML = `
        <div class="excel-filter-sort">
          <button type="button" data-sort="asc"><i class="fa-solid fa-arrow-down-a-z"></i> Urut Naik</button>
          <button type="button" data-sort="desc"><i class="fa-solid fa-arrow-up-z-a"></i> Urut Turun</button>
        </div>
        <input type="search" class="excel-filter-search" placeholder="Cari nilai..." aria-label="Cari nilai filter">
        <label class="excel-filter-all"><input type="checkbox" data-select-all> Pilih Semua</label>
        <div class="excel-filter-values"></div>
        <div class="excel-filter-footer">
          <button type="button" class="btn btn-ghost" data-clear>Hapus Filter</button>
          <button type="button" class="btn btn-primary" data-apply>Terapkan</button>
        </div>`;
      const valuesBox = popup.querySelector(".excel-filter-values");
      valuesBox.innerHTML = values
        .map(
          (value, valueIndex) =>
            `<label data-filter-value="${esc(value.toLowerCase())}"><input type="checkbox" value="${esc(value)}" ${selected.has(value) ? "checked" : ""}> <span>${esc(value || "(Kosong)")}</span></label>`,
        )
        .join("");
      const selectAll = popup.querySelector("[data-select-all]");
      const syncSelectAll = () => {
        const boxes = Array.from(valuesBox.querySelectorAll("input"));
        const checked = boxes.filter((item) => item.checked).length;
        selectAll.checked = Boolean(boxes.length) && checked === boxes.length;
        selectAll.indeterminate = checked > 0 && checked < boxes.length;
      };
      syncSelectAll();
      selectAll.addEventListener("change", () => {
        valuesBox
          .querySelectorAll("label:not([hidden]) input")
          .forEach((item) => {
            item.checked = selectAll.checked;
          });
        syncSelectAll();
      });
      valuesBox.addEventListener("change", syncSelectAll);
      popup
        .querySelector(".excel-filter-search")
        .addEventListener("input", (event) => {
          const query = event.target.value.trim().toLowerCase();
          valuesBox.querySelectorAll("label").forEach((label) => {
            label.hidden = !String(label.dataset.filterValue || "").includes(
              query,
            );
          });
        });
      popup.querySelectorAll("[data-sort]").forEach((sortButton) => {
        sortButton.addEventListener("click", () => {
          state.sort = { index, direction: sortButton.dataset.sort };
          if (table.__excelData?.rerender) table.__excelData.rerender();
          else applyTable(table);
          closePopup();
        });
      });
      popup.querySelector("[data-clear]").addEventListener("click", () => {
        state.filters.delete(index);
        if (table.__excelData?.rerender) table.__excelData.rerender();
        else applyTable(table);
        closePopup();
      });
      popup.querySelector("[data-apply]").addEventListener("click", () => {
        const checkedValues = new Set(
          Array.from(valuesBox.querySelectorAll("input:checked")).map(
            (item) => item.value,
          ),
        );
        if (checkedValues.size === values.length) state.filters.delete(index);
        else state.filters.set(index, checkedValues);
        if (table.__excelData?.rerender) table.__excelData.rerender();
        else applyTable(table);
        closePopup();
      });
      document.body.appendChild(popup);
      const rect = button.getBoundingClientRect();
      const left = Math.min(
        Math.max(8, rect.right - popup.offsetWidth),
        window.innerWidth - popup.offsetWidth - 8,
      );
      popup.style.left = `${left}px`;
      popup.style.top = `${Math.min(rect.bottom + 5, window.innerHeight - popup.offsetHeight - 8)}px`;
      activePopup = popup;
    }

    function enhanceTable(table) {
      if (!(table instanceof HTMLTableElement) || !table.tHead) return;
      if (table.dataset.excelFilterDisabled === "true") return;
      const headerRow = table.tHead.rows[table.tHead.rows.length - 1];
      if (!headerRow) return;
      Array.from(headerRow.cells).forEach((header, index) => {
        if (header.querySelector(".excel-filter-btn")) return;
        const title = cellText(header).toLowerCase();
        if (
          header.colSpan > 1 ||
          !title ||
          /^(aksi|foto|pilih|action)$/.test(title) ||
          header.querySelector('input[type="checkbox"]')
        )
          return;
        header.classList.add("excel-filter-header");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "excel-filter-btn";
        button.dataset.columnIndex = String(index);
        button.title = `Filter ${cellText(header)}`;
        button.setAttribute("aria-label", button.title);
        button.innerHTML = '<i class="fa-solid fa-filter"></i>';
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          openPopup(table, index, button);
        });
        header.appendChild(button);
      });
      applyTable(table);
    }

    const enhanceAll = (root = document) => {
      if (root instanceof HTMLTableElement) enhanceTable(root);
      root.querySelectorAll?.("table").forEach(enhanceTable);
    };
    enhanceAll();

    const observer = new MutationObserver((mutations) => {
      if (applying) return;
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (!(node instanceof Element)) return;
          enhanceAll(node);
          const table = node.closest("table");
          if (table) applyTable(table);
        });
      });
    });
    observer.observe(document.getElementById("appScreen") || document.body, {
      childList: true,
      subtree: true,
    });

    document.addEventListener("click", (event) => {
      if (
        activePopup &&
        !activePopup.contains(event.target) &&
        !event.target.closest?.(".excel-filter-btn")
      )
        closePopup();
    });
    document.addEventListener("keydown", (event) => {
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "l") {
        event.preventDefault();
        filtersVisible = !filtersVisible;
        closePopup();
        document.querySelectorAll("table").forEach(refreshButtons);
        toast(
          filtersVisible
            ? "Filter header tabel ditampilkan."
            : "Filter header tabel disembunyikan.",
        );
      }
      if (event.key === "Escape") closePopup();
    });
  }

  async function initAppPage() {
    if (!state.token) {
      window.location.replace("login.html");
      return;
    }

    // Pasang event pengelolaan user lebih dahulu agar tombol Atur Akses,
    // Reset Password, dan Hapus tetap aktif meski modul lain gagal inisialisasi.
    initUserManagement();
    initLogout();
    initAutosave();

    buildPressView();
    buildFillingPopup();
    wireLineView("filling");
    wireLineView("press");
    initApd();
    initTabs();
    initDashboard();
    initSpkModal();
    initFillingSpkQueue();
    initFillingDowntime();
    initLaporanSubmenu();
    initSpkReport();
    initLaporan();
    initKpiLaporan();
    initKpiSettings();
    initInputDataCleanup();
    initSettingCards();
    initMasterData();
    initExcelTableFilters();

    // Tampilkan aplikasi langsung memakai profil + master cache terakhir.
    // Validasi server tetap berjalan segera setelahnya.
    try {
      const cachedUser = JSON.parse(
        localStorage.getItem(CONFIG.USER_KEY) || "null",
      );
      const cachedMaster = JSON.parse(
        localStorage.getItem(CONFIG.MASTER_KEY) || "null",
      );
      if (cachedUser && cachedUser.username) {
        state.currentUser = cachedUser;
        if (cachedMaster) state.master = cachedMaster;
        refreshAllDropdowns();
        loadPersistedPreview();
        restoreFormDraft("filling");
        restoreFormDraft("press");
        renderPreview("filling");
        renderPreview("press");
        renderEntries("filling");
        renderEntries("press");
        renderApdPreview();
        renderApdSavedToday();
        renderPressBalance();
        renderSpkToday();
        renderFillingSpkQueue();
        renderUserHeader();
        applyAccessControl();
        if (el("spkOpenButton"))
          el("spkOpenButton").hidden = !canLevel("spk", "write");
        renderDashboard();
        el("appScreen").hidden = false;
        setConnection(
          suppressNavigationLoading ? "online" : "loading",
          suppressNavigationLoading ? "Aktif" : "Menyegarkan data…",
        );
      }
    } catch (_) {}

    function initDashboardSlider() {
      const slider = document.querySelector(".dashboard-slider");
      const viewport = slider?.querySelector(".dashboard-slider-viewport");
      const track = document.getElementById("dashboardSliderTrack");
      const prevBtn = document.getElementById("dashboardSliderPrev");
      const nextBtn = document.getElementById("dashboardSliderNext");

      if (!slider || !viewport || !track || !prevBtn || !nextBtn) return;

      // Desktop tetap memakai dua slide asli:
      // 1) Chart + Alert, 2) KPI Press + Acuan KPI.
      // Pada HP setiap panel dipisahkan menjadi satu slide. Slide mobile yang
      // tidak aktif benar-benar disembunyikan agar TIDAK ikut menentukan tinggi
      // container. Ini menghindari ruang kosong dari panel lain yang lebih tinggi.
      const desktopSlides = Array.from(track.children).filter(
        (node) => node.classList && node.classList.contains("dashboard-slide"),
      );
      const desktopGroups = desktopSlides.map((slide) =>
        slide.querySelector(".dashboard-grid-main"),
      );
      const panelRecords = [];
      desktopGroups.forEach((group, groupIndex) => {
        if (!group) return;
        Array.from(group.children).forEach((panel, panelIndex) => {
          panelRecords.push({ panel, group, groupIndex, panelIndex });
        });
      });

      const mobileQuery = window.matchMedia("(max-width: 650px)");
      let mobileSlides = [];
      let mobileMode = false;
      let currentSlide = 0;

      function activeSlides() {
        return mobileMode ? mobileSlides : desktopSlides;
      }

      function syncArrowState() {
        const slides = activeSlides();
        prevBtn.disabled = currentSlide <= 0;
        nextBtn.disabled = currentSlide >= slides.length - 1;
        slider.dataset.mobileSlides = mobileMode ? "true" : "false";
        slider.dataset.slideIndex = String(currentSlide);
        slider.dataset.slideCount = String(slides.length);
      }

      function showMobileSlide() {
        mobileSlides.forEach((slide, index) => {
          const active = index === currentSlide;
          slide.hidden = !active;
          slide.classList.toggle("is-active", active);
          slide.setAttribute("aria-hidden", active ? "false" : "true");
        });

        // Di mode HP hanya satu panel yang tampil. Slide lain benar-benar
        // disembunyikan sehingga tinggi slider selalu mengikuti panel aktif.
        track.style.transform = "none";
        track.style.transition = "none";
        viewport.style.height = "auto";
      }

      function syncDesktopViewportHeight() {
        if (mobileMode) return;
        const activeSlide = desktopSlides[currentSlide];
        if (!activeSlide) return;

        // Track horizontal mempunyai tinggi sebesar slide PALING TINGGI dari
        // semua halaman slider. Jika viewport dibiarkan auto, slide yang lebih
        // pendek akan menyisakan ruang kosong di bawahnya. Kunci viewport ke
        // tinggi slide yang sedang aktif supaya section berikutnya langsung
        // menempel setelah pasangan panel aktif.
        const height = Math.ceil(activeSlide.getBoundingClientRect().height);
        if (height > 0) viewport.style.height = `${height}px`;
      }

      function showDesktopSlide(options = {}) {
        desktopSlides.forEach((slide) => {
          slide.hidden = false;
          slide.removeAttribute("aria-hidden");
        });
        track.style.transition = options.instant ? "none" : "";
        track.style.transform = `translateX(-${currentSlide * 100}%)`;

        // Ukur setelah browser selesai menghitung grid. Dalam satu slide desktop
        // tetap ada 2 panel dan CSS menyamakan tinggi keduanya ke panel tertinggi.
        requestAnimationFrame(() => {
          syncDesktopViewportHeight();
          requestAnimationFrame(syncDesktopViewportHeight);
        });

        if (options.instant) {
          requestAnimationFrame(() => {
            track.style.transition = "";
          });
        }
      }

      function updateSlider(options = {}) {
        const slides = activeSlides();
        if (!slides.length) return;
        currentSlide = Math.max(0, Math.min(currentSlide, slides.length - 1));

        if (mobileMode) showMobileSlide();
        else showDesktopSlide(options);

        syncArrowState();
      }

      function buildMobileSlides() {
        if (mobileSlides.length) return;

        desktopSlides.forEach((slide) => {
          slide.hidden = true;
          slide.setAttribute("aria-hidden", "true");
        });

        panelRecords.forEach(({ panel }, index) => {
          const slide = document.createElement("div");
          slide.className = "dashboard-slide dashboard-mobile-slide";
          slide.dataset.mobileSlideIndex = String(index);

          const grid = document.createElement("div");
          grid.className =
            "dashboard-grid dashboard-grid-main dashboard-mobile-one-grid";
          grid.appendChild(panel);
          slide.appendChild(grid);
          slide.hidden = true;
          track.appendChild(slide);
          mobileSlides.push(slide);
        });
      }

      function restoreDesktopSlides() {
        panelRecords
          .slice()
          .sort(
            (a, b) =>
              a.groupIndex - b.groupIndex || a.panelIndex - b.panelIndex,
          )
          .forEach(({ panel, group }) => group?.appendChild(panel));

        mobileSlides.forEach((slide) => slide.remove());
        mobileSlides = [];
        desktopSlides.forEach((slide) => {
          slide.hidden = false;
          slide.removeAttribute("aria-hidden");
        });
      }

      function applyResponsiveMode() {
        const shouldUseMobileSlides = mobileQuery.matches;

        if (shouldUseMobileSlides && !mobileMode) {
          const previousDesktopSlide = currentSlide;
          buildMobileSlides();
          mobileMode = true;
          currentSlide = Math.min(
            previousDesktopSlide * 2,
            mobileSlides.length - 1,
          );
          updateSlider({ instant: true });
          return;
        }

        if (!shouldUseMobileSlides && mobileMode) {
          const previousMobileSlide = currentSlide;
          restoreDesktopSlides();
          mobileMode = false;
          currentSlide = Math.min(
            Math.floor(previousMobileSlide / 2),
            desktopSlides.length - 1,
          );
          updateSlider({ instant: true });
          return;
        }

        // Resize di mode yang sama cukup memastikan display/transform konsisten.
        updateSlider({ instant: true });
      }

      prevBtn.addEventListener("click", () => {
        if (currentSlide <= 0) return;
        currentSlide--;
        updateSlider();
      });

      nextBtn.addEventListener("click", () => {
        const slides = activeSlides();
        if (currentSlide >= slides.length - 1) return;
        currentSlide++;
        updateSlider();
      });

      // Jika isi chart, alert, tabel KPI, pagination, atau filter mengubah
      // tinggi slide aktif setelah render, viewport desktop ikut diperbarui.
      let sliderResizeObserver = null;
      if (typeof ResizeObserver === "function") {
        sliderResizeObserver = new ResizeObserver(() => {
          if (!mobileMode) requestAnimationFrame(syncDesktopViewportHeight);
        });
        desktopSlides.forEach((slide) => sliderResizeObserver.observe(slide));
      }

      window.addEventListener("resize", applyResponsiveMode);
      if (typeof mobileQuery.addEventListener === "function") {
        mobileQuery.addEventListener("change", applyResponsiveMode);
      } else if (typeof mobileQuery.addListener === "function") {
        mobileQuery.addListener(applyResponsiveMode);
      }

      applyResponsiveMode();
    }

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", initDashboardSlider, {
        once: true,
      });
    } else {
      initDashboardSlider();
    }
    try {
      // Profil, master, dan data awal dimuat bersama dalam satu request.
      await loadAppData(true);
      suppressNavigationLoading = false;
      if (state.currentUser) {
        localStorage.setItem(
          CONFIG.USER_KEY,
          JSON.stringify(state.currentUser),
        );
      }
      el("appScreen").hidden = false;
    } catch (err) {
      const invalidSession =
        err?.isApiError && /sesi|user.*tidak aktif/i.test(err.message || "");
      if (!invalidSession) {
        setConnection("error", "Data awal gagal dimuat");
        const notice = el("startupError");
        if (notice) notice.hidden = false;
        const message = el("startupErrorMessage");
        if (message) message.textContent = err.message;
        el("startupRetry")?.addEventListener(
          "click",
          () => window.location.reload(),
          { once: true },
        );
        return;
      }
      state.token = "";
      state.currentUser = null;
      localStorage.removeItem(CONFIG.TOKEN_KEY);
      localStorage.removeItem(CONFIG.USER_KEY);
      alert(`Sesi/koneksi tidak valid: ${err.message}`);
      window.location.replace("login.html");
    }
  }

  if (pageType === "login") initLoginPage();
  else
    preloadAppViews().finally(() => {
      initAppPage();
    });
})();
