const $ = (selector) => document.querySelector(selector);
const state = {
  token: "",
  cohorts: [],
  rows: [],
  summary: {},
  browser: {},
  page: 0,
  pageSize: 50,
};

function node(tag, className = "", text = "") {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = String(text);
  return element;
}

function showNotice(message, error = false) {
  const notice = $("#notice");
  notice.textContent = message || "";
  notice.className = `notice${error ? " error" : ""}`;
  notice.hidden = !message;
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (state.token && options.method && options.method !== "GET")
    headers["X-Hezi-Token"] = state.token;
  const response = await fetch(path, {
    ...options,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    /* service may return an empty body */
  }
  if (!response.ok)
    throw new Error(payload.error || `请求失败（${response.status}）`);
  return payload;
}

function num(value) {
  return Number.isFinite(Number(value))
    ? Number(value).toLocaleString("zh-CN")
    : "—";
}

function renderSummary() {
  const labels = [
    ["已选机会", "total"],
    ["已找到来源链接", "matched"],
    ["可加入准备", "ready"],
    ["待审核", "submitted"],
    ["已有商品", "existing"],
    ["受阻", "blocked"],
    ["已在售", "onSale"],
  ];
  const root = $("#summary");
  root.replaceChildren();
  $("#scope-count").textContent = `${num(state.summary.total)} 条已选机会`;
  for (const [label, key] of labels) {
    const card = node("article", "metric");
    card.append(
      node("div", "metric-label", label),
      node("div", "metric-value", num(state.summary[key])),
    );
    root.append(card);
  }
}

function renderCohorts() {
  const select = $("#cohort-filter");
  const selected = select.value;
  select.replaceChildren(new Option("全部机会组", ""));
  for (const cohort of state.cohorts)
    select.add(
      new Option(`${cohort.label}（${num(cohort.total)}）`, cohort.id),
    );
  select.value = state.cohorts.some((item) => item.id === selected)
    ? selected
    : state.cohorts.length === 1
      ? state.cohorts[0].id
      : "";
  updateHydrateButton();
}

function statusText(status) {
  const known = {
    IMPORTED: "待采集",
    PROPOSED: "来源待核对",
    READY: "可准备",
    READY_FOR_PREPARATION: "可准备",
    QUEUED: "准备 / 执行中",
    SUBMITTED: "待审核",
    APPROVED: "已审核",
    ON_SALE: "已在售",
    EXISTING: "已有商品",
    BLOCKED: "受阻",
    REJECTED: "已驳回",
    UNKNOWN_OUTCOME: "待对账",
  };
  return known[status] || status || "状态未提供";
}

function statusClass(status) {
  if (status === "READY") return "ready";
  if (status === "BLOCKED") return "blocked";
  if (["SUBMITTED", "QUEUED", "UNKNOWN_OUTCOME"].includes(status))
    return "submitted";
  if (status === "ON_SALE") return "onsale";
  return "";
}

function sourceReuseText(mode) {
  return {
    full: "完整采集",
    price: "仅补价格",
    cache: "本地复用",
    "candidate-full": "来源候选核验",
  }[mode];
}

function friendlyBlocker(value) {
  const text = String(value || "").trim();
  const known = {
    SOURCE_MATCH: "尚未确认精确京东来源",
    STALE_EVIDENCE: "证据已过期，需要刷新",
    AUTHORIZATION: "授权尚未核验",
    PRICING: "价格尚未核验",
    DUPLICATE: "发现可能重复商品",
    COLLECT_REQUIRED: "需要读取京东资料",
  };
  return known[text] || text;
}

function filteredRows() {
  const query = $("#search").value.trim().toLocaleLowerCase();
  const status = $("#status-filter").value;
  const cohortId = $("#cohort-filter").value;
  return state.rows.filter((row) => {
    if (cohortId && row.cohortId !== cohortId) return false;
    if (status && row.status !== status) return false;
    if (!query) return true;
    return [
      row.title,
      row.brand,
      row.targetSku,
      row.status,
      row.marketItemId,
      row.marketSkuId,
      ...(row.blockers || []),
    ]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase()
      .includes(query);
  });
}

function appendLink(cell, href, label, external = false) {
  if (!href) return;
  const link = node("a", "", label);
  link.href = href;
  if (external) {
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }
  cell.append(link);
}

function renderRows() {
  const body = $("#rows");
  body.replaceChildren();
  const all = filteredRows();
  const pageCount = Math.max(1, Math.ceil(all.length / state.pageSize));
  state.page = Math.min(state.page, pageCount - 1);
  const pageRows = all.slice(
    state.page * state.pageSize,
    (state.page + 1) * state.pageSize,
  );
  $("#result-count").textContent =
    `显示 ${num(all.length)} 条 / 当前已加载 ${num(state.rows.length)} 条`;
  $("#page-label").textContent = `第 ${state.page + 1} / ${pageCount} 页`;
  $("#previous").disabled = state.page <= 0;
  $("#next").disabled = state.page >= pageCount - 1;
  if (!pageRows.length) {
    const tr = node("tr");
    const td = node(
      "td",
      "empty-row",
      state.rows.length
        ? "没有符合筛选条件的机会。"
        : "当前没有可显示的机会记录。",
    );
    td.colSpan = 6;
    tr.append(td);
    body.append(tr);
    updatePrepareButton();
    return;
  }
  for (const row of pageRows) {
    const tr = node("tr");
    const opportunity = node("td");
    opportunity.append(
      node("strong", "", row.title || "未提供标题"),
      node(
        "small",
        "",
        `排名 ${row.rank ?? "—"} · ${row.opportunityId || row.id}`,
      ),
    );
    tr.append(opportunity);
    const brand = node("td");
    brand.append(node("strong", "", row.brand || "品牌未提供"));
    if (row.marketItemId)
      brand.append(node("small", "", `市场商品 ${row.marketItemId}`));
    if (row.marketSkuId)
      brand.append(node("small", "", `市场 SKU ${row.marketSkuId}`));
    appendLink(brand, row.marketUrl, "查看市场来源 ↗", true);
    tr.append(brand);
    const sku = node("td");
    sku.textContent = row.targetSku || "未匹配";
    const reuseLabel = sourceReuseText(row.sourceReuseMode);
    if (reuseLabel) sku.append(node("small", "", `资料读取：${reuseLabel}`));
    tr.append(sku);
    const detail = node("td");
    detail.append(
      node(
        "span",
        `status-chip ${statusClass(row.status)}`,
        statusText(row.status),
      ),
    );
    if (Array.isArray(row.blockers) && row.blockers.length)
      detail.append(
        node("div", "blockers", row.blockers.map(friendlyBlocker).join("；")),
      );
    tr.append(detail);
    const workbench = node("td");
    if (row.jobId)
      appendLink(
        workbench,
        `/?job=${encodeURIComponent(row.jobId)}`,
        `任务 ${row.jobId}`,
      );
    else workbench.textContent = "尚未创建上架任务";
    if (row.remoteId)
      workbench.append(node("small", "", `远端 ID ${row.remoteId}`));
    if (row.updatedAt)
      workbench.append(node("small", "", `更新 ${row.updatedAt}`));
    if (!row.jobId && row.detailReceiptId) {
      const refreshEvidence = node(
        "button",
        "row-action secondary-button",
        "刷新商城证据",
      );
      refreshEvidence.type = "button";
      refreshEvidence.disabled = state.browser.status !== "ready";
      refreshEvidence.title = refreshEvidence.disabled
        ? "浏览器状态不是 ready，暂不能刷新证据"
        : "只刷新这一款的商城证据";
      refreshEvidence.addEventListener("click", () =>
        refreshRowEvidence(row, refreshEvidence),
      );
      workbench.append(refreshEvidence);
    }
    if (!row.jobId && row.targetSku) {
      const rereadSource = node(
        "button",
        "row-action secondary-button",
        "重读京东规格",
      );
      rereadSource.type = "button";
      rereadSource.disabled = state.browser.status !== "ready";
      rereadSource.title = rereadSource.disabled
        ? "浏览器状态不是 ready，暂不能读取规格"
        : "只重读这一款京东规格并重新核对";
      rereadSource.addEventListener("click", () =>
        collectSource(row, true, rereadSource),
      );
      workbench.append(rereadSource);
      const authorization = node(
        "button",
        "row-action secondary-button",
        "核验本款授权",
      );
      authorization.type = "button";
      authorization.disabled = state.browser.status !== "ready";
      authorization.addEventListener("click", async () => {
        authorization.disabled = true;
        showNotice("正在核验本款的品牌授权与类目…");
        try {
          const result = await api("/api/opportunity-execution/authorization", {
            method: "POST",
            body: { rowId: row.id },
          });
          await loadData();
          showNotice(
            result.status === "approved"
              ? "授权记录已核验；请查看该商品的剩余检查项。"
              : "当前授权未通过，请查看具体缺项。",
          );
        } catch (error) {
          showNotice(error.message, true);
        } finally {
          if (authorization.isConnected)
            authorization.disabled = state.browser.status !== "ready";
        }
      });
      workbench.append(authorization);
    }
    if (!row.jobId && !row.targetSku && row.detailReceiptId) {
      const search = node(
        "button",
        "row-action secondary-button",
        "查找京东候选",
      );
      search.type = "button";
      search.disabled = state.browser.status !== "ready";
      search.addEventListener("click", () => searchCandidates(row, search));
      workbench.append(search);
      const receipt = row.sourceCandidates;
      if (receipt?.candidates?.length) {
        const choices = node("select", "candidate-select");
        choices.setAttribute("aria-label", `选择 ${row.title} 的待核候选`);
        choices.append(new Option("请选择待核候选", ""));
        for (const candidate of receipt.candidates)
          choices.append(
            new Option(`${candidate.title}（${candidate.sku}）`, candidate.sku),
          );
        const verify = node(
          "button",
          "row-action secondary-button",
          "读取并核对候选",
        );
        verify.type = "button";
        verify.disabled = true;
        choices.addEventListener("change", () => {
          verify.disabled = !choices.value || state.browser.status !== "ready";
        });
        verify.addEventListener("click", () =>
          verifyCandidate(row, receipt.receiptId, choices.value, verify),
        );
        workbench.append(
          node(
            "small",
            "",
            "来源候选仍需核验品牌、型号和包装，通过后才能准备上架。",
          ),
          choices,
          verify,
        );
      }
    }
    tr.append(workbench);
    const selectCell = node("td");
    const checkbox = node("input", "row-select");
    checkbox.type = "checkbox";
    checkbox.dataset.rowId = row.id;
    checkbox.disabled = row.status !== "READY";
    checkbox.setAttribute(
      "aria-label",
      `选择 ${row.title || row.id} 加入上架准备`,
    );
    checkbox.addEventListener("change", updatePrepareButton);
    selectCell.append(checkbox);
    tr.append(selectCell);
    body.append(tr);
  }
  updatePrepareButton();
  updateCollectSourceButton();
}

function updatePrepareButton() {
  const selected = [...document.querySelectorAll(".row-select:checked")];
  $("#prepare").disabled = selected.length === 0;
  $("#prepare").textContent = selected.length
    ? `加入上架准备（${selected.length}）`
    : "加入上架准备";
}

function updateHydrateButton() {
  const button = $("#hydrate");
  if (!button) return;
  button.disabled =
    state.browser.status !== "ready" || !$("#cohort-filter").value;
  button.title =
    state.browser.status !== "ready"
      ? "浏览器状态不是 ready，暂不能读取详情"
      : !$("#cohort-filter").value
        ? "请先选择机会组"
        : "";
}

function pendingSourceRows(cohortId = $("#cohort-filter").value) {
  return state.rows.filter(
    (row) =>
      (!cohortId || row.cohortId === cohortId) &&
      row.targetSku &&
      !row.jobId &&
      !row.sourceObservationId,
  );
}

function updateCollectSourceButton() {
  const button = $("#collect-source");
  if (!button) return;
  const ready = state.browser.status === "ready";
  const cohortId = $("#cohort-filter").value;
  const pending = cohortId ? pendingSourceRows(cohortId) : [];
  button.disabled = !ready || pending.length === 0;
  button.title = !ready
    ? "浏览器状态不是 ready，暂不能读取京东规格"
    : !cohortId
      ? "请先选择机会组"
      : pending.length === 0
        ? "当前机会组没有符合条件的待读取 SKU"
        : `将读取 1 款；当前有 ${pending.length} 款待处理`;
}

function renderBrowser() {
  const status = String(state.browser.status || "").toLowerCase();
  const paused =
    status.includes("paused") ||
    status.includes("pause") ||
    status.includes("暂停");
  const login =
    status.includes("login") ||
    status.includes("auth") ||
    status.includes("登录");
  const userControl = status === "user_control";
  const available = status === "ready";
  const dot = $("#browser-dot");
  dot.className = `signal${available ? " good" : paused || login || userControl ? " bad" : ""}`;
  $("#browser-status").textContent = userControl
    ? "浏览器由用户控制"
    : login
      ? "浏览器需要登录"
      : paused
        ? "浏览器任务已暂停"
        : state.browser.message ||
          (available ? "浏览器已连接" : "浏览器状态待确认");
  const note = $("#browser-message");
  if (login || paused || !available) {
    note.hidden = false;
    note.className = `browser-message${login || userControl ? " error" : ""}`;
    note.textContent = userControl
      ? state.browser.message ||
        "浏览器正由用户控制；请在交回控制权后重试详情读取。"
      : login
        ? state.browser.message ||
          "请先在现有浏览器会话中登录店铺，再重试受控操作。"
        : paused
          ? state.browser.message ||
            "浏览器任务已暂停；请在上架工作台检查并恢复。"
          : state.browser.message ||
            "浏览器当前不可用；详情读取和准备操作可能无法执行。请先检查上架工作台状态。";
  } else note.hidden = true;
  updateHydrateButton();
  updateCollectSourceButton();
}

async function loadData() {
  showNotice("");
  const cohortId = $("#cohort-filter").value;
  const path = cohortId
    ? `/api/opportunity-execution?cohortId=${encodeURIComponent(cohortId)}`
    : "/api/opportunity-execution";
  setTableMessage("正在读取机会数据…", "loading");
  try {
    const data = await api(path);
    state.cohorts = Array.isArray(data.cohorts) ? data.cohorts : [];
    state.rows = Array.isArray(data.rows) ? data.rows : [];
    state.summary = data.summary || {};
    state.browser = data.browser || {};
    renderCohorts();
    renderSummary();
    renderBrowser();
    state.page = 0;
    renderRows();
  } catch (error) {
    showNotice(error.message, true);
    setTableMessage("暂时无法读取机会数据。", "empty-row");
  }
}

function setTableMessage(message, className) {
  const body = $("#rows");
  body.replaceChildren();
  const tr = node("tr");
  const td = node("td", className, message);
  td.colSpan = 6;
  tr.append(td);
  body.append(tr);
}

async function hydrate() {
  const cohortId = $("#cohort-filter").value;
  if (!cohortId) {
    showNotice("请先选择机会组，再读取该组下一批商品详情。", true);
    return;
  }
  if (state.browser.status !== "ready") {
    showNotice("浏览器状态不是 ready，暂不能读取商品详情。", true);
    return;
  }
  const button = $("#hydrate");
  button.disabled = true;
  showNotice("正在读取下一批商品详情（最多 3 条）…");
  try {
    const result = await api("/api/opportunity-execution/hydrate", {
      method: "POST",
      body: { cohortId, limit: 3 },
    });
    showNotice(
      result.message || "详情读取请求已完成。请以返回的执行台数据核对结果。",
    );
    await loadData();
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    updateHydrateButton();
  }
}

function describeSourceResult(result) {
  if (result.received !== 1) return result.message || "没有读取到待读取商品。";
  const match =
    result.matched === true
      ? "已匹配"
      : result.matched === false
        ? "未匹配"
        : "匹配结论未返回";
  const blockers = Array.isArray(result.blockers)
    ? result.blockers.map(friendlyBlocker)
    : [];
  const detail = blockers.length ? ` 阻塞项：${blockers.join("；")}` : "";
  const reuseLabel = sourceReuseText(result.collectionMode);
  const readMode = reuseLabel ? `资料读取：${reuseLabel}。` : "";
  return `${readMode}已读取 1 款京东规格；核对结果：${match}。${detail}`;
}

async function searchCandidates(row, button) {
  button.disabled = true;
  showNotice("正在按商品证据查找京东候选…");
  try {
    const result = await api("/api/opportunity-execution/candidates", {
      method: "POST",
      body: { cohortId: row.cohortId, rowId: row.id },
    });
    await loadData();
    showNotice(
      `找到 ${result.candidates.length} 个待核候选。候选尚未通过同款核验。`,
    );
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    if (button.isConnected) button.disabled = state.browser.status !== "ready";
  }
}

async function verifyCandidate(row, receiptId, sku, button) {
  if (!sku) return;
  button.disabled = true;
  showNotice("正在读取所选候选的完整规格并核对…");
  try {
    const result = await api("/api/opportunity-execution/candidate-source", {
      method: "POST",
      body: { cohortId: row.cohortId, rowId: row.id, receiptId, sku },
    });
    await loadData();
    showNotice(
      result.matched
        ? "同款核验通过；仍需授权、查重和定价检查。"
        : `候选未通过：${result.blockers.join("；")}`,
      !result.matched,
    );
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    if (button.isConnected) button.disabled = state.browser.status !== "ready";
  }
}

async function collectSource(row = null, retry = false, button = null) {
  const cohortId = row?.cohortId || $("#cohort-filter").value;
  if (!cohortId) {
    showNotice("请先选择机会组。", true);
    return;
  }
  if (state.browser.status !== "ready") {
    showNotice("浏览器状态不是 ready，暂不能读取京东规格。", true);
    return;
  }
  const candidate = row || pendingSourceRows(cohortId)[0];
  if (!candidate) {
    showNotice("当前机会组没有尚待读取且已有京东来源链接的商品。", true);
    return;
  }
  const actionButton = button || $("#collect-source");
  actionButton.disabled = true;
  showNotice(
    retry ? "正在重新读取这一款京东规格…" : "正在读取并核对 1 款京东规格…",
  );
  try {
    const result = await api("/api/opportunity-execution/source", {
      method: "POST",
      body: { cohortId, rowId: candidate.id },
    });
    const message = describeSourceResult(result);
    await loadData();
    showNotice(message, result.received === 0);
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    if (actionButton.isConnected)
      actionButton.disabled = state.browser.status !== "ready";
    updateCollectSourceButton();
  }
}

async function refreshRowEvidence(row, button) {
  if (state.browser.status !== "ready") {
    showNotice("浏览器状态不是 ready，暂不能刷新商城证据。", true);
    return;
  }
  button.disabled = true;
  showNotice("正在刷新这一款的商城证据…");
  try {
    const result = await api("/api/opportunity-execution/hydrate", {
      method: "POST",
      body: { cohortId: row.cohortId, rowIds: [row.id] },
    });
    const message =
      result.message || "该款商城证据刷新请求已完成。请核对更新后的回执。";
    await loadData();
    showNotice(message);
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    if (button.isConnected) button.disabled = state.browser.status !== "ready";
  }
}

async function prepare() {
  const rowIds = [...document.querySelectorAll(".row-select:checked")]
    .map((input) => input.dataset.rowId)
    .filter(Boolean);
  if (!rowIds.length) return;
  const button = $("#prepare");
  button.disabled = true;
  try {
    const result = await api("/api/opportunity-execution/prepare", {
      method: "POST",
      body: { rowIds },
    });
    showNotice(
      result.message || "准备请求已提交。请在工作台核对实际任务状态。",
    );
    await loadData();
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    updatePrepareButton();
  }
}

function bind() {
  $("#recheck").addEventListener("click", async () => {
    const cohortId = $("#cohort-filter").value;
    if (!cohortId) return showNotice("请先选择机会组。", true);
    const button = $("#recheck");
    button.disabled = true;
    try {
      const result = await api("/api/opportunity-execution/recheck", {
        method: "POST",
        body: { cohortId },
      });
      showNotice(
        `已重新核验 ${result.checked} 条已有详情；仍缺少或已过期的证据会继续显示。`,
      );
      await loadData();
    } catch (error) {
      showNotice(error.message, true);
    } finally {
      button.disabled = false;
    }
  });
  $("#refresh").addEventListener("click", loadData);
  $("#cohort-filter").addEventListener("change", () => {
    updateHydrateButton();
    updateCollectSourceButton();
    loadData();
  });
  $("#status-filter").addEventListener("change", () => {
    state.page = 0;
    renderRows();
  });
  $("#search").addEventListener("input", () => {
    state.page = 0;
    renderRows();
  });
  $("#previous").addEventListener("click", () => {
    state.page--;
    renderRows();
  });
  $("#next").addEventListener("click", () => {
    state.page++;
    renderRows();
  });
  $("#hydrate").addEventListener("click", hydrate);
  $("#collect-source").addEventListener("click", () => collectSource());
  $("#prepare").addEventListener("click", prepare);
}

async function init() {
  bind();
  try {
    const session = await api("/api/analytics/session");
    state.token = session.token || "";
    await loadData();
  } catch (error) {
    showNotice(error.message, true);
    $("#browser-status").textContent = "服务未就绪";
    $("#browser-dot").className = "signal bad";
  }
}

init();
