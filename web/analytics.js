const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  token: "",
  shop: "",
  view: "overview",
  marketMode: "recent",
  opportunityMode: "recent",
  marketPage: 1,
  opportunityPage: 1,
  currentOpportunity: null,
  marketRequest: 0,
  opportunityRequest: 0,
  selectedOpportunities: new Map(),
};

const viewCopy = {
  overview: [
    "经营总览",
    "今天先做什么？",
    "只显示有来源的信号；动作仍由现有工作台受控执行。",
  ],
  market: [
    "市场与热销",
    "最近什么在增长？",
    "近期可比信号与历史累计价值分开查看。",
  ],
  opportunities: [
    "商品机会池",
    "下一批上哪些？",
    "需求排名与执行准备分开，逐条保留来源和下一动作。",
  ],
  brands: [
    "品牌 BD",
    "哪些品牌值得去谈？",
    "按可解锁机会与授权新鲜度安排跟进。",
  ],
  orders: [
    "成交与复盘",
    "上架后有没有成交？",
    "只有完成对账的订单口径才进入经营目标。",
  ],
  batches: [
    "上架批次",
    "商品卡在哪一步？",
    "分析页只呈现进度，实际执行仍回到上架工作台。",
  ],
  health: [
    "数据健康",
    "这些数字可信吗？",
    "缺口和异常直接说明影响范围，不用 0 掩盖未知。",
  ],
};

function text(value, fallback = "暂不可用") {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
}

function first(object, keys, fallback = undefined) {
  for (const key of keys)
    if (object?.[key] !== undefined && object?.[key] !== null)
      return object[key];
  return fallback;
}

function rows(payload) {
  if (Array.isArray(payload)) return payload;
  return first(payload, ["items", "rows", "data", "results", "records"], []);
}

function pageInfo(payload, page) {
  const list = rows(payload);
  return {
    items: list,
    page: Number(first(payload, ["page", "currentPage"], page)) || page,
    pageSize: Number(first(payload, ["pageSize", "limit"], 50)) || 50,
    total:
      Number(first(payload, ["total", "totalItems", "count"], list.length)) ||
      0,
  };
}

function money(value, currency = "CNY") {
  if (value === null || value === undefined || value === "") return "暂不可用";
  const amount = Number(value);
  if (!Number.isFinite(amount)) return text(value);
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(amount);
}

function cents(value, currency = "CNY") {
  if (value === null || value === undefined || value === "") return "暂不可用";
  const amount = Number(value);
  return Number.isFinite(amount) ? money(amount / 100, currency) : text(value);
}

function number(value, suffix = "") {
  if (value === null || value === undefined || value === "") return "暂不可用";
  const n = Number(value);
  return Number.isFinite(n)
    ? new Intl.NumberFormat("zh-CN").format(n) + suffix
    : text(value);
}

function date(value) {
  if (!value) return "暂不可用";
  const d = new Date(value);
  return Number.isNaN(d.valueOf())
    ? text(value)
    : d.toLocaleString("zh-CN", { hour12: false });
}

function el(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function clear(node) {
  node.replaceChildren();
  return node;
}

function showNotice(message, kind = "") {
  const node = $("#notice");
  node.textContent = message;
  node.className = `notice ${kind}`.trim();
  node.hidden = !message;
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
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (!response.ok)
    throw new Error(payload.error || `请求失败（${response.status}）`);
  return payload;
}

function empty(
  container,
  title = "目前没有可显示的数据",
  detail = "数据形成后会出现在这里。",
) {
  clear(container);
  const box = el("div", "empty");
  box.append(el("strong", "", title), el("span", "", detail));
  container.append(box);
}

function metricCard(label, value, meta = "", unavailable = false) {
  const card = el("article", "metric");
  card.append(
    el("div", "metric-label", label),
    el("div", `metric-value${unavailable ? " unavailable" : ""}`, value),
    el("div", "metric-meta", meta),
  );
  return card;
}

function summaryRows(container, items) {
  clear(container);
  const list = el("div", "summary-list");
  items.forEach(([label, value]) => {
    const row = el("div", "summary-row");
    row.append(el("span", "", label), el("strong", "", text(value)));
    list.append(row);
  });
  container.append(list);
}

function tag(label, tone = "") {
  return el("span", `tag ${tone}`.trim(), text(label));
}

const statusLabels = {
  pending: "待联系",
  contacting: "沟通中",
  materials: "材料待补",
  verification: "授权待核",
  usable: "可用",
  expired: "已到期",
  open: "待处理",
  selected: "已选中",
  paused: "暂缓",
  completed: "已完成",
  comparable: "可比",
  incomparable: "不可比",
  anomalous: "异常",
  ready: "可准备",
  "needs-identity-review": "身份待核",
  "needs-authorization": "授权待补",
  none: "无精确匹配",
  exact: "精确匹配",
  candidate: "存在候选",
  "needs-review": "待核验",
  verified: "已核验",
  historical: "历史记录",
  missing: "缺少授权",
  CONFLICT: "待对账",
  ON_SALE: "在售",
  EXISTING: "已有商品",
  REJECTED: "已驳回",
  UNKNOWN_OUTCOME: "结果未知",
  SUBMITTED: "已提交",
  APPROVED: "已通过",
  CANCELLED: "已取消",
  BLOCKED: "受阻",
  QUEUED: "排队中",
  READY: "待准备",
  READY_FOR_PREPARATION: "可准备",
  IMPORTED: "已转交",
};
const statusLabel = (value) => statusLabels[value] || text(value);

function sourceMeta(payload) {
  return {
    window: first(payload, [
      "windowLabel",
      "window",
      "availableWindow",
      "sourceWindow",
    ]),
    sample: first(payload, ["sampleSize", "denominator", "samples", "count"]),
    updated: first(payload, ["updatedAt", "computedAt", "observedAt", "asOf"]),
    status: first(payload, ["status", "evidenceStatus", "conclusionStatus"]),
  };
}

function renderSourceStrip(selector, payload) {
  const container = clear($(selector));
  const meta = sourceMeta(payload);
  [
    ["观察窗口", meta.window],
    ["样本", meta.sample],
    ["更新时间", meta.updated ? date(meta.updated) : null],
    ["结论状态", meta.status],
  ].forEach(([label, value]) => {
    const span = el("span");
    span.append(
      el("strong", "", `${label}：`),
      document.createTextNode(text(value)),
    );
    container.append(span);
  });
}

function actionCount(action) {
  return first(action, ["count", "total", "value"], null);
}
function actionReason(action) {
  return first(
    action,
    ["reason", "description", "summary", "nextAction"],
    "当前没有形成可执行清单",
  );
}

async function loadOverview() {
  const data = await api("/api/analytics/overview");
  const metrics = clear($("#overview-metrics"));
  const goal = data.goal || {};
  const orders = data.orders || {};
  const market = data.market || {};
  const confirmed = goal.confirmed === true;
  const revenue = first(orders, [
    "revenue",
    "confirmedRevenue",
    "amount",
    "orderAmount",
  ]);
  const target = first(goal, ["amount", "targetAmount", "target"]);
  const gap = confirmed ? first(goal, ["remaining", "remainingAmount"]) : null;
  metrics.append(
    metricCard(
      "已确认经营金额",
      confirmed ? money(revenue) : "口径待确认",
      confirmed
        ? `截至 ${text(first(orders, ["asOf", "through", "to"]))}`
        : "完成订单对账后启用",
      !confirmed,
    ),
    metricCard(
      "经营目标",
      target == null ? "尚未设置" : money(target),
      target == null
        ? "可在成交与复盘中设置"
        : first(goal, ["asOf", "date"])
          ? `截至 ${date(first(goal, ["asOf", "date"]))}`
          : "年度目标；进度待更新",
      target == null,
    ),
    metricCard(
      "目标缺口",
      gap == null ? "暂不计算" : money(Math.max(0, gap)),
      gap == null ? "仅用已确认目标和订单计算" : "当前值减目标；不含预测",
      gap == null,
    ),
    metricCard(
      "有效市场机会",
      number(first(market, ["opportunityCount", "count", "comparableCount"])),
      `窗口：${text(first(market, ["windowLabel", "window", "availableWindow"]))}`,
      first(market, ["opportunityCount", "count", "comparableCount"]) == null,
    ),
  );

  const actionGrid = clear($("#action-grid"));
  const actions = data.actions || {};
  const actionDefs = [
    [
      "补商品",
      first(actions, ["products", "listing", "prepare"], {}),
      "opportunities",
      "查看机会",
    ],
    [
      "推进 BD",
      first(actions, ["brands", "bd", "authorization"], {}),
      "brands",
      "查看品牌任务",
    ],
    [
      "复盘结果",
      first(actions, ["results", "review", "orders"], {}),
      "orders",
      "查看订单",
    ],
  ];
  actionDefs.forEach(([label, action, targetView, buttonText]) => {
    const card = el("article", "action-card");
    card.append(
      el("p", "kicker", label),
      el(
        "div",
        "action-count",
        actionCount(action) == null ? "暂不可用" : number(actionCount(action)),
      ),
      el("p", "", actionReason(action)),
    );
    const button = el("button", "text-button", `${buttonText} →`);
    button.dataset.go = targetView;
    card.append(button);
    actionGrid.append(card);
  });
  $("#overview-updated").textContent = first(data, ["updatedAt", "projectedAt"])
    ? `更新于 ${date(first(data, ["updatedAt", "projectedAt"]))}`
    : "";
  summaryRows($("#overview-orders"), [
    [
      "数据状态",
      first(orders, ["status", "label"], confirmed ? "已对账" : "待对账"),
    ],
    [
      "最近可用窗口",
      first(orders, ["windowLabel", "window", "availableWindow"]),
    ],
    ["订单行", first(orders, ["lineCount", "lines", "count"])],
    ["退款 / 取消", first(orders, ["refundAmount", "refunds", "cancelled"])],
  ]);
  const health = data.health || data.capabilities || {};
  summaryRows($("#overview-health"), [
    ["市场观察", first(health, ["market", "observations", "marketStatus"])],
    ["订单对账", first(health, ["orders", "orderStatus", "reconciliation"])],
    [
      "来源身份",
      first(health, ["identity", "sourceIdentity", "identityStatus"]),
    ],
    [
      "授权新鲜度",
      first(health, ["authorization", "grants", "authorizationStatus"]),
    ],
  ]);
}

function marketQuery(kind) {
  const form =
    kind === "market" ? $("#market-filters") : $("#opportunity-filters");
  const params = new URLSearchParams(new FormData(form));
  if (kind === "market") params.set("mode", state.marketMode);
  if (kind === "market" && state.marketMode === "historical")
    params.delete("source");
  params.set(
    "page",
    kind === "market" ? state.marketPage : state.opportunityPage,
  );
  params.set("pageSize", "50");
  return params;
}

function table(container, columns, list, rowClick) {
  if (!list.length) return empty(container);
  clear(container);
  const scroll = el("div", "table-scroll"),
    t = el("table"),
    head = el("thead"),
    body = el("tbody"),
    trh = el("tr");
  columns.forEach(([label]) => trh.append(el("th", "", label)));
  head.append(trh);
  list.forEach((item) => {
    const tr = el("tr", rowClick ? "clickable" : "");
    columns.forEach(([, render]) => {
      const td = el("td");
      const result = render(item);
      td.append(
        result instanceof Node ? result : document.createTextNode(text(result)),
      );
      tr.append(td);
    });
    if (rowClick) {
      tr.tabIndex = 0;
      tr.addEventListener("click", () => rowClick(item));
      tr.addEventListener("keydown", (event) => {
        if (event.key === "Enter") rowClick(item);
      });
    }
    body.append(tr);
  });
  t.append(head, body);
  scroll.append(t);
  container.append(scroll);
}

function titleCell(item) {
  const wrap = el("div");
  wrap.append(
    el(
      "div",
      "cell-title",
      first(item, ["title", "name", "productName", "canonicalName"]),
    ),
    el(
      "div",
      "cell-meta",
      [
        first(item, ["brand", "brandName"]),
        first(item, ["model", "sku", "skuId"]),
        first(item, ["package", "specification", "unit"]),
      ]
        .filter(Boolean)
        .join(" · "),
    ),
  );
  return wrap;
}

function renderPagination(selector, info, kind) {
  const node = clear($(selector));
  const maxPage = Math.max(1, Math.ceil(info.total / info.pageSize));
  const previous = el("button", "", "上一页"),
    next = el("button", "", "下一页");
  previous.disabled = info.page <= 1;
  next.disabled = info.page >= maxPage;
  previous.addEventListener("click", () => changePage(kind, info.page - 1));
  next.addEventListener("click", () => changePage(kind, info.page + 1));
  node.append(
    previous,
    el(
      "span",
      "meta",
      `第 ${info.page} / ${maxPage} 页 · 共 ${number(info.total)} 条`,
    ),
    next,
  );
}

function changePage(kind, page) {
  if (kind === "market") {
    state.marketPage = page;
    loadMarket();
  } else {
    state.opportunityPage = page;
    loadOpportunities();
  }
}

async function loadMarket() {
  const request = ++state.marketRequest;
  const data = await api(`/api/analytics/market?${marketQuery("market")}`),
    info = pageInfo(data, state.marketPage);
  if (request !== state.marketRequest) return;
  renderSourceStrip("#market-summary", data);
  $("#market-explainer").textContent =
    state.marketMode === "recent"
      ? `${$("#market-filters [name=source]").value === "tracked" ? "持续跟踪数据" : "研究匹配样本"}：只比较入口、字段、销售单位和两端快照都可比的记录；窗口不可用时会说明缺少哪一端。`
      : "累计展示价值不知道发生周期，仅用于历史候选整理，不会与近期热销混排。";
  table(
    $("#market-table"),
    [
      ["商品", titleCell],
      [
        state.marketMode === "recent" ? "近期价值信号" : "历史价值指数",
        (x) =>
          first(x, ["valueIndexMinor"]) != null
            ? `${cents(
                first(x, ["valueIndexMinor"]),
                first(x, ["currency"], "CNY"),
              )} · ${x.scope === "recent" ? "近期" : "累计"}`
            : number(
                first(
                  x,
                  state.marketMode === "recent"
                    ? ["incrementValue", "deltaValue", "growthValue", "score"]
                    : ["historicalValue", "valueIndex", "score"],
                ),
              ),
      ],
      [
        "展示销量变化",
        (x) => number(first(x, ["delta", "salesDelta", "growth"])),
      ],
      ["店铺", (x) => first(x, ["shop", "shopName", "seller"])],
      [
        "证据",
        (x) =>
          tag(
            { comparable: "可比", incomparable: "不可比", anomalous: "异常" }[
              first(x, ["status"])
            ] ||
              first(x, ["comparability", "evidenceStatus", "status"], "待核"),
            first(x, ["status"]) === "comparable" ? "" : "warn",
          ),
      ],
    ],
    info.items,
    openMarketCandidate,
  );
  renderPagination("#market-pagination", info, "market");
}

async function loadOpportunities() {
  const request = ++state.opportunityRequest;
  const data = await api(
      `/api/analytics/opportunities?${marketQuery("opportunities")}`,
    ),
    info = pageInfo(data, state.opportunityPage);
  if (request !== state.opportunityRequest) return;
  const source = clear($("#opportunity-summary"));
  [
    ["候选总量", first(data, ["marketTotal"], 13217)],
    ["机会池", info.total],
    ["范围", "历史候选池；不等于均可发布"],
    ["执行准备", "逐条核验身份、授权和来源"],
  ].forEach(([label, value]) => {
    const span = el("span");
    span.append(
      el("strong", "", `${label}：`),
      document.createTextNode(text(value)),
    );
    source.append(span);
  });
  table(
    $("#opportunity-table"),
    [
      [
        "选择",
        (x) => {
          const input = el("input", "opportunity-select");
          input.type = "checkbox";
          input.checked = state.selectedOpportunities.has(x.id);
          input.disabled = !x.evidenceSnapshot;
          input.setAttribute("aria-label", `选择${text(x.title, "机会")}`);
          input.addEventListener("click", (event) => event.stopPropagation());
          input.addEventListener("change", () => {
            if (input.checked) {
              if (state.selectedOpportunities.size >= 50) {
                input.checked = false;
                return showNotice("一次最多转交 50 条机会。", "error");
              }
              state.selectedOpportunities.set(x.id, x);
            } else state.selectedOpportunities.delete(x.id);
            updateOpportunitySelection();
          });
          return input;
        },
      ],
      ["机会", titleCell],
      ["需求排名", (x) => number(first(x, ["demandRank", "rank"]))],
      [
        "本店匹配",
        (x) =>
          tag(
            first(x, ["ownMatchStatus", "shopMatch", "matchStatus"], "待核"),
            "neutral",
          ),
      ],
      [
        "授权",
        (x) =>
          tag(
            first(
              x,
              ["authorizationStatus", "grantStatus", "authorization"],
              "待核",
            ),
            /过期|缺|待/.test(
              text(
                first(x, [
                  "authorizationStatus",
                  "grantStatus",
                  "authorization",
                ]),
                "",
              ),
            )
              ? "warn"
              : "",
          ),
      ],
      ["下一动作", (x) => first(x, ["nextAction", "action", "recommendation"])],
      ["负责人", (x) => first(x, ["owner", "queue"])],
      [
        "执行状态",
        (x) => {
          if (!x.operational) return "尚未转交";
          const link = el(
            "a",
            "",
            x.operational.status === "CONFLICT"
              ? statusLabel(x.operational.status)
              : x.operational.pending
                ? `处理中 · ${statusLabel(x.operational.status)}`
                : statusLabel(x.operational.status),
          );
          link.href = `/opportunity-execution?cohortId=${encodeURIComponent(x.operational.cohortId)}`;
          link.addEventListener("click", (event) => event.stopPropagation());
          return link;
        },
      ],
    ],
    info.items,
    openOpportunity,
  );
  renderPagination("#opportunity-pagination", info, "opportunities");
  updateOpportunitySelection();
}

function updateOpportunitySelection() {
  const count = state.selectedOpportunities.size;
  $("#opportunity-selection").textContent = `已选 ${count} / 50`;
  $("#transfer-opportunities").disabled = count === 0;
  $("#clear-opportunity-selection").disabled = count === 0;
}

function clearOpportunitySelection() {
  state.selectedOpportunities.clear();
  $$(".opportunity-select").forEach((input) => (input.checked = false));
  updateOpportunitySelection();
}

async function transferOpportunities() {
  const button = $("#transfer-opportunities");
  button.disabled = true;
  try {
    const result = await api("/api/analytics/opportunities/transfer", {
      method: "POST",
      body: {
        selections: [...state.selectedOpportunities.values()].map((item) => ({
          id: item.id,
          revision: item.revision,
          evidence: item.evidenceSnapshot,
        })),
      },
    });
    state.selectedOpportunities.clear();
    showNotice(
      result.reused
        ? "该批机会已在执行台中。"
        : "机会已转到执行台；尚未自动准备或发布。",
    );
    await loadOpportunities();
  } catch (error) {
    showNotice(error.message, "error");
  } finally {
    updateOpportunitySelection();
  }
}

async function openOpportunity(item) {
  state.currentOpportunity = item;
  $("#detail-title").textContent = first(
    item,
    ["title", "name", "productName"],
    "商品机会",
  );
  renderOpportunityDetail(item, []);
  $("#detail-panel").showModal();
  const evidenceIds = first(
    item,
    ["evidenceIds", "evidenceId", "candidateId", "evidence", "evidences"],
    [],
  );
  const ids = (Array.isArray(evidenceIds) ? evidenceIds : [evidenceIds])
    .map((x) => (typeof x === "object" ? first(x, ["id", "evidenceId"]) : x))
    .filter(Boolean);
  if (!ids.length) return;
  const evidence = await Promise.all(
    ids.map((id) =>
      api(`/api/analytics/evidence/${encodeURIComponent(id)}`).catch(
        () => null,
      ),
    ),
  );
  renderOpportunityDetail(
    item,
    evidence.flatMap(expandEvidence).filter(Boolean),
  );
}

function expandEvidence(result) {
  if (!result) return [];
  return [
    ...(result.candidate ? [{ ...result.candidate, title: "候选商品" }] : []),
    ...(Array.isArray(result.observations)
      ? result.observations.map((x) => ({ ...x, title: x.title || "观测端点" }))
      : []),
  ];
}

async function openMarketCandidate(item) {
  state.currentOpportunity = null;
  $("#detail-title").textContent = first(item, ["title", "name"], "市场候选");
  const body = clear($("#detail-body")),
    content = el("div", "drawer-content"),
    section = el("section", "detail-section"),
    grid = el("div", "detail-grid");
  grid.append(
    detailDatum("范围", item.scope === "recent" ? "近期可比" : "历史累计"),
    detailDatum("证据状态", statusLabel(item.status)),
    detailDatum("销量变化", item.delta),
    detailDatum(
      "价值指数",
      item.valueIndexMinor == null
        ? null
        : cents(item.valueIndexMinor, item.currency || "CNY"),
    ),
  );
  section.append(grid);
  content.append(section);
  const evidenceSection = el("section", "detail-section");
  evidenceSection.append(
    el("h3", "", "证据端点"),
    el("p", "meta", "正在读取观测值、价格、时间与来源…"),
  );
  content.append(evidenceSection);
  const add = el("button", "", "加入机会池");
  add.type = "button";
  add.addEventListener("click", async () => {
    add.disabled = true;
    try {
      await api("/api/analytics/opportunities", {
        method: "POST",
        body: { candidateId: item.id },
      });
      showNotice("已加入机会池；重复操作会复用原机会。");
      $("#detail-panel").close();
    } catch (error) {
      showNotice(error.message, "error");
    } finally {
      add.disabled = false;
    }
  });
  content.append(add);
  body.append(content);
  $("#detail-panel").showModal();
  try {
    const result = await api(
      `/api/analytics/evidence/${encodeURIComponent(item.evidenceId || item.id)}`,
    );
    clear(evidenceSection);
    evidenceSection.append(el("h3", "", "证据端点"));
    expandEvidence(result).forEach((ev) => {
      const card = el("article", "evidence-card"),
        value = first(ev, ["value", "sales", "displaySales"]),
        price = first(ev, ["priceMinor", "priceCents"]);
      card.append(
        el("strong", "", first(ev, ["title"], "来源记录")),
        el(
          "p",
          "",
          [
            value == null ? null : `观测值 ${value}`,
            price == null ? null : `价格 ${cents(price, ev.currency || "CNY")}`,
          ]
            .filter(Boolean)
            .join(" · ") || first(ev, ["reason", "summary"], "原始观测记录"),
        ),
        el(
          "div",
          "meta",
          [
            first(ev, ["sourceEntry", "source", "field"]),
            first(ev, ["observedAt", "capturedAt", "at"])
              ? date(first(ev, ["observedAt", "capturedAt", "at"]))
              : null,
          ]
            .filter(Boolean)
            .join(" · "),
        ),
      );
      evidenceSection.append(card);
    });
  } catch {
    clear(evidenceSection);
    evidenceSection.append(
      el("h3", "", "证据端点"),
      el("p", "meta", "证据暂时无法读取。"),
    );
  }
}

function detailDatum(label, value) {
  const node = el("div", "datum");
  node.append(el("span", "", label), el("strong", "", text(value)));
  return node;
}

function renderOpportunityDetail(item, evidence) {
  const body = clear($("#detail-body")),
    content = el("div", "drawer-content");
  const summary = el("section", "detail-section"),
    grid = el("div", "detail-grid");
  grid.append(
    detailDatum("需求排名", first(item, ["demandRank", "rank", "position"])),
    detailDatum(
      "本店匹配",
      first(item, ["ownMatchStatus", "shopMatch", "matchStatus"]),
    ),
    detailDatum(
      "授权状态",
      first(item, ["authorizationStatus", "grantStatus", "authorization"]),
    ),
    detailDatum(
      "观察窗口",
      first(item, ["windowLabel", "sourceWindow", "window"]),
    ),
    detailDatum(
      "下一动作",
      first(item, ["nextAction", "action", "recommendation"]),
    ),
  );
  summary.append(grid);
  content.append(summary);
  const evidenceSection = el("section", "detail-section");
  evidenceSection.append(el("h3", "", "证据"));
  if (!evidence.length)
    evidenceSection.append(
      el("p", "meta", "当前记录没有可展开的证据，或证据仍在整理。"),
    );
  evidence.forEach((ev) => {
    const card = el("article", "evidence-card"),
      observedValue = first(ev, ["value", "sales", "displaySales"]),
      observedPrice = first(ev, ["priceMinor", "priceCents"]),
      evidenceText = [
        observedValue == null ? null : `观测值 ${observedValue}`,
        observedPrice == null
          ? null
          : `价格 ${cents(observedPrice, ev.currency || "CNY")}`,
      ]
        .filter(Boolean)
        .join(" · ");
    card.append(
      el("strong", "", first(ev, ["title", "label", "type"], "来源记录")),
      el(
        "p",
        "",
        evidenceText ||
          first(ev, ["summary", "description", "reason", "value"]),
      ),
      el(
        "div",
        "meta",
        [
          first(ev, ["sourceEntry", "source", "sourceLabel", "entry", "field"]),
          first(ev, ["observedAt", "updatedAt", "at"])
            ? date(first(ev, ["observedAt", "updatedAt", "at"]))
            : null,
        ]
          .filter(Boolean)
          .join(" · "),
      ),
    );
    evidenceSection.append(card);
  });
  content.append(evidenceSection);
  const formSection = el("section", "detail-section");
  formSection.append(el("h3", "", "更新处理信息"));
  const form = el("form", "detail-form");
  form.id = "opportunity-update";
  [
    [
      "status",
      "状态",
      first(item, ["status"]),
      [
        ["open", "待处理"],
        ["selected", "已选中"],
        ["paused", "暂缓"],
        ["completed", "已完成"],
      ],
    ],
    ["owner", "负责人", first(item, ["owner"]), null],
  ].forEach(([name, label, value, options]) => {
    const l = el("label", "", label);
    let input;
    if (options) {
      input = el("select");
      options.forEach(([option, optionLabel]) => {
        const o = el("option", "", optionLabel);
        o.value = option;
        if (option === value) o.selected = true;
        input.append(o);
      });
    } else {
      input = el("input");
      input.value = value || "";
    }
    input.name = name;
    l.append(input);
    form.append(l);
  });
  const notesLabel = el("label", "", "备注"),
    notes = el("textarea");
  notes.name = "reason";
  notes.value = first(item, ["reason"], "");
  notesLabel.append(notes);
  form.append(notesLabel);
  const save = el("button", "", "保存处理信息");
  save.type = "submit";
  form.append(save);
  form.addEventListener("submit", saveOpportunity);
  formSection.append(form);
  content.append(formSection);
  body.append(content);
}

async function saveOpportunity(event) {
  event.preventDefault();
  const id = first(state.currentOpportunity, ["id", "opportunityId"]);
  if (!id) return showNotice("这条机会缺少稳定编号，暂时不能保存。", "error");
  const button = $("button[type=submit]", event.currentTarget);
  button.disabled = true;
  try {
    await api(`/api/analytics/opportunities/${encodeURIComponent(id)}`, {
      method: "POST",
      body: {
        ...Object.fromEntries(new FormData(event.currentTarget)),
        expectedRevision: state.currentOpportunity.revision,
      },
    });
    showNotice("机会处理信息已保存。");
    $("#detail-panel").close();
    await loadOpportunities();
  } catch (error) {
    showNotice(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function loadBrands() {
  const data = await api("/api/analytics/brands"),
    list = rows(data),
    container = $("#brand-list");
  if (!list.length)
    return empty(
      container,
      "目前没有品牌任务",
      "品牌机会形成后可在这里合并跟进。",
    );
  clear(container);
  list.forEach((brand) => {
    const card = el("article", "record-card"),
      head = el("div", "record-head"),
      title = el("div");
    title.append(
      el("h3", "", first(brand, ["name", "brand", "brandName"])),
      el(
        "p",
        "meta",
        first(brand, ["summary", "reason"], "按授权范围合并的品牌任务"),
      ),
    );
    head.append(
      title,
      tag(
        statusLabel(
          first(brand, ["readiness", "authorizationStatus", "status"], "待核"),
        ),
        /过期|待|缺/.test(
          text(first(brand, ["authorizationStatus", "status"]), ""),
        )
          ? "warn"
          : "",
      ),
    );
    card.append(head);
    const grid = el("div", "record-grid");
    grid.append(
      detailDatum(
        "可解锁机会",
        number(first(brand, ["opportunityCount", "unlockCount", "count"])),
      ),
      detailDatum(
        "多店信号",
        number(first(brand, ["shopCount", "resonance"]), " 家"),
      ),
      detailDatum(
        "授权有效期",
        first(brand, ["authorizationExpiresAt", "expiresAt"])
          ? date(first(brand, ["authorizationExpiresAt", "expiresAt"]))
          : null,
      ),
      detailDatum(
        "下次跟进",
        first(brand, ["nextFollowUpAt", "followUpAt"])
          ? date(first(brand, ["nextFollowUpAt", "followUpAt"]))
          : null,
      ),
    );
    card.append(grid);
    const form = el("form", "edit-grid");
    form.dataset.brandId = first(brand, ["id", "brandId", "name", "brand"]);
    const fields = [
      [
        "status",
        "任务状态",
        first(brand, ["taskStatus", "status"]),
        [
          ["pending", "待联系"],
          ["contacting", "沟通中"],
          ["materials", "材料待补"],
          ["verification", "授权待核"],
          ["usable", "可用"],
          ["expired", "到期"],
        ],
      ],
      ["owner", "负责人", first(brand, ["owner"]), null],
      [
        "nextFollowUpAt",
        "下次跟进",
        first(brand, ["nextFollowUpAt", "followUpAt"], ""),
        "iso",
      ],
      [
        "notes",
        "结果与备注",
        first(brand, ["resultReason", "notes", "result"], ""),
        null,
      ],
    ];
    fields.forEach(([name, label, value, type]) => {
      const l = el("label", "", label);
      let input;
      if (Array.isArray(type)) {
        input = el("select");
        type.forEach(([option, optionLabel]) => {
          const opt = el("option", "", optionLabel);
          opt.value = option;
          if (option === value) opt.selected = true;
          input.append(opt);
        });
      } else {
        input = el("input");
        input.type = type === "iso" ? "text" : type || "text";
        if (type === "iso") input.placeholder = "2026-09-19T10:00:00+08:00";
        input.value = value || "";
      }
      input.name = name;
      l.append(input);
      form.append(l);
    });
    const save = el("button", "", "保存任务");
    save.type = "submit";
    form.append(save);
    form.addEventListener("submit", saveBrandTask);
    card.append(form);
    container.append(card);
  });
}

async function saveBrandTask(event) {
  event.preventDefault();
  const form = event.currentTarget,
    button = $("button", form);
  button.disabled = true;
  try {
    await api("/api/analytics/brands/task", {
      method: "POST",
      body: {
        brand: form.dataset.brandId,
        ...Object.fromEntries(new FormData(form)),
      },
    });
    showNotice("品牌任务已保存。");
    await loadBrands();
  } catch (error) {
    showNotice(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function loadOrders() {
  const data = await api("/api/analytics/orders"),
    summary = data.summary || data,
    metrics = clear($("#order-metrics"));
  const confirmed =
    first(
      summary,
      ["acceptedForTarget", "confirmed", "reconciled", "usableForGoal"],
      false,
    ) === true;
  const currency = first(summary, ["currency"], "CNY");
  metrics.append(
    metricCard(
      "订单数据状态",
      first(
        summary,
        ["state", "status", "label"],
        confirmed ? "已接受计入指标" : "待对账",
      ),
      `可用性：${first(summary, ["availability"], "待核")}`,
      false,
    ),
    metricCard(
      "有效下单金额",
      first(summary, ["grossCents"]) != null
        ? cents(first(summary, ["grossCents"]), currency)
        : money(first(summary, ["orderAmount", "amount", "revenue"])),
      confirmed ? "已完成口径确认" : "按来源原标签展示",
      first(summary, ["grossCents", "orderAmount", "amount", "revenue"]) ==
        null,
    ),
    metricCard(
      "退款金额",
      first(summary, ["refundCents"]) != null
        ? cents(first(summary, ["refundCents"]), currency)
        : money(first(summary, ["refundAmount", "refunds"])),
      "退款发生期与原订单期分别保留",
      first(summary, ["refundCents", "refundAmount", "refunds"]) == null,
    ),
    metricCard(
      "未匹配订单行",
      number(first(summary, ["unmatchedLines", "unmatchedLineCount"])),
      `歧义：${number(first(summary, ["ambiguousLines"]))}`,
      first(summary, ["unmatchedLines", "unmatchedLineCount"]) == null,
    ),
  );
  const list = rows(data);
  table(
    $("#orders-table"),
    [
      ["订单", (x) => first(x, ["orderId"])],
      ["下单时间", (x) => date(first(x, ["placedAt"]))],
      ["状态", (x) => tag(first(x, ["status"], "待核"))],
      ["实付", (x) => cents(first(x, ["paidCents"]), currency)],
      ["订单行", (x) => number(Array.isArray(x.lines) ? x.lines.length : null)],
    ],
    list,
  );
}

async function importOrders(event) {
  event.preventDefault();
  const file = $("#order-file").files[0];
  if (!file) return;
  const button = $("button", event.currentTarget);
  button.disabled = true;
  try {
    const parsed = JSON.parse(await file.text());
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object")
      throw new Error("订单文件必须是包含字段说明和订单记录的 JSON 对象。");
    await api("/api/analytics/orders/import", { method: "POST", body: parsed });
    showNotice("订单文件已导入，等待对账确认。");
    event.currentTarget.reset();
    $("#order-file-name").textContent = "尚未选择文件";
    await loadOrders();
  } catch (error) {
    showNotice(
      error instanceof SyntaxError
        ? "无法读取 JSON，请检查文件格式。"
        : error.message,
      "error",
    );
  } finally {
    button.disabled = false;
  }
}

async function importReconciliation(event) {
  event.preventDefault();
  const file = $("#reconcile-file").files[0];
  if (!file) return;
  const button = $("button", event.currentTarget);
  button.disabled = true;
  try {
    const parsed = JSON.parse(await file.text());
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object")
      throw new Error("对账文件必须是一个完整的 JSON 对象。");
    const required = [
      "reconciliationId",
      "source",
      "from",
      "to",
      "timezone",
      "currency",
      "dateField",
      "refundView",
      "expected",
      "tolerance",
    ];
    const missing = required.filter((key) => parsed[key] === undefined);
    if (missing.length)
      throw new Error(`对账文件缺少字段：${missing.join("、")}`);
    await api("/api/analytics/orders/reconcile", {
      method: "POST",
      body: parsed,
    });
    showNotice("订单对账已运行；是否可计入目标以返回的对账状态为准。");
    event.currentTarget.reset();
    $("#reconcile-file-name").textContent = "尚未选择文件";
    await loadOrders();
  } catch (error) {
    showNotice(
      error instanceof SyntaxError
        ? "无法读取 JSON，请检查文件格式。"
        : error.message,
      "error",
    );
  } finally {
    button.disabled = false;
  }
}

function yuanToCents(value, label, optional = false) {
  if (optional && String(value).trim() === "") return null;
  if (!/^\d+(?:\.\d{1,2})?$/.test(String(value).trim()))
    throw new Error(`${label}应为最多两位小数的非负金额。`);
  const result = Math.round(Number(value) * 100);
  if (!Number.isSafeInteger(result)) throw new Error(`${label}超出可用范围。`);
  return result;
}

async function saveGoal(event) {
  event.preventDefault();
  const button = $("button[type=submit]", event.currentTarget);
  button.disabled = true;
  try {
    const input = Object.fromEntries(new FormData(event.currentTarget));
    const historicalContextCents = yuanToCents(
      input.historicalContextAmount,
      "历史背景金额",
      true,
    );
    const payload = {
      year: Number(input.year),
      targetCents: yuanToCents(input.targetAmount, "年度目标"),
      currentCents: yuanToCents(input.currentAmount, "当前确认金额"),
      asOf: input.asOf,
      source: input.source,
      confirmation: {
        confirmedBy: input.confirmedBy,
        confirmedAt: input.confirmedAt,
        basis: input.basis,
      },
      ...(historicalContextCents === null ? {} : { historicalContextCents }),
    };
    await api("/api/analytics/goal", { method: "POST", body: payload });
    showNotice("经营目标和当前确认金额已保存。");
    await loadOrders();
  } catch (error) {
    showNotice(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function loadBatches() {
  const data = await api("/api/analytics/batches"),
    list = rows(data),
    container = $("#batch-list");
  if (!list.length)
    return empty(
      container,
      "目前没有可复盘的批次",
      "从上架工作台建立批次后，真实阶段会回流到这里。",
    );
  clear(container);
  list.forEach((batch) => {
    const card = el("article", "record-card"),
      head = el("div", "record-head"),
      title = el("div");
    title.append(
      el("h3", "", first(batch, ["name", "title", "batchId", "id"])),
      el(
        "p",
        "meta",
        first(
          batch,
          ["summary", "description"],
          `创建于 ${date(first(batch, ["createdAt", "startedAt"]))}`,
        ),
      ),
    );
    const jobs = Array.isArray(batch.jobs) ? batch.jobs : [];
    const jobId = first(batch, ["jobId", "job", "latestJobId"], jobs[0]?.id);
    const link = el("a", "button-link", "在工作台查看 ↗");
    link.href = jobId ? `/?job=${encodeURIComponent(jobId)}` : "/";
    head.append(title, link);
    card.append(head);
    const derivedCounts = jobs.reduce((acc, job) => {
      const key =
        job.remoteState === "ON_SALE"
          ? "onSale"
          : job.remoteState === "SUBMITTED"
            ? "submitted"
            : /UNKNOWN|NEEDS|BLOCKED/.test(job.status || "")
              ? "attention"
              : "prepared";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    const counts = first(batch, ["counts", "stages"], derivedCounts),
      grid = el("div", "record-grid");
    [
      [
        "准备",
        first(counts, ["prepared", "ready"], first(batch, ["prepared"])),
      ],
      [
        "待审",
        first(
          counts,
          ["submitted", "pendingReview"],
          first(batch, ["submitted"]),
        ),
      ],
      ["在售", first(counts, ["onSale", "live"], first(batch, ["onSale"]))],
      [
        "异常",
        first(
          counts,
          ["attention", "failed", "errors"],
          first(batch, ["attention"]),
        ),
      ],
    ].forEach(([label, value]) =>
      grid.append(detailDatum(label, number(value))),
    );
    card.append(grid);
    const total = Number(first(batch, ["total", "count"], jobs.length)),
      done = Number(first(counts, ["onSale", "live", "approved"], 0));
    if (total > 0) {
      const progress = el("div", "progress"),
        bar = el("i");
      bar.style.width = `${Math.min(100, Math.max(0, (done / total) * 100))}%`;
      progress.append(bar);
      card.append(progress);
    }
    container.append(card);
  });
}

async function loadHealth() {
  const data = await api("/api/analytics/health"),
    summary = data.summary || data,
    metrics = clear($("#health-summary"));
  [
    ["采集运行", first(summary, ["runs", "ready", "available", "usableCount"])],
    ["完整采集", first(summary, ["completeRuns", "attention", "warningCount"])],
    ["部分采集", first(summary, ["partialRuns", "blocked", "errorCount"])],
    [
      "最近完整采集",
      first(summary, ["lastCompleteAt", "lastHealthyAt"])
        ? date(first(summary, ["lastCompleteAt", "lastHealthyAt"]))
        : null,
    ],
  ].forEach(([label, value]) =>
    metrics.append(metricCard(label, number(value), "", value == null)),
  );
  const list = rows(data),
    container = $("#health-list");
  if (!list.length) {
    clear(container);
    const card = el("article", "record-card"),
      head = el("div", "record-head"),
      title = el("div");
    title.append(
      el("h3", "", "市场观测与导入"),
      el("p", "meta", `最近观测：${date(data.latestObservedAt)}`),
    );
    head.append(
      title,
      tag(
        data.status === "ok"
          ? "正常"
          : data.status === "needs-review"
            ? "需要复核"
            : "暂无数据",
        data.status === "needs-review" ? "warn" : "",
      ),
    );
    card.append(head);
    const grid = el("div", "record-grid");
    grid.append(
      detailDatum("完整采集", number(data.completeRuns)),
      detailDatum("部分采集", number(data.partialRuns)),
      detailDatum("观测记录", number(data.observations)),
      detailDatum("冲突", number(data.conflicts)),
    );
    card.append(grid);
    container.append(card);
    await loadCollections();
    return;
  }
  clear(container);
  list.forEach((item) => {
    const card = el("article", "record-card"),
      head = el("div", "record-head"),
      title = el("div");
    title.append(
      el("h3", "", first(item, ["name", "title", "check"])),
      el("p", "meta", first(item, ["summary", "message", "description"])),
    );
    const status = first(item, ["status", "level"], "待核");
    head.append(
      title,
      tag(
        status,
        /错误|受阻|失败/.test(status)
          ? "bad"
          : /警告|待|不足/.test(status)
            ? "warn"
            : "",
      ),
    );
    card.append(head);
    const grid = el("div", "record-grid");
    grid.append(
      detailDatum("影响范围", first(item, ["impact", "affected"])),
      detailDatum("覆盖 / 分母", first(item, ["coverage", "denominator"])),
      detailDatum(
        "最近检查",
        date(first(item, ["checkedAt", "updatedAt", "at"])),
      ),
      detailDatum("下一步", first(item, ["nextAction", "action"])),
    );
    card.append(grid);
    container.append(card);
  });
  await loadCollections();
}

async function loadCollections() {
  const container = clear($("#collection-list"));
  try {
    const data = await api("/api/analytics/collections"),
      list = rows(data);
    if (!list.length)
      return empty(
        container,
        "尚未配置持续采集",
        "可按赫兹商城店铺 ID 建立观察任务；保存后不会自动启动。",
      );
    list.forEach((item) => {
      const card = el("article", "record-card"),
        head = el("div", "record-head"),
        title = el("div");
      title.append(
        el("h3", "", `店铺 ${item.shopId}`),
        el(
          "p",
          "meta",
          `${item.source} · ${number(Number(item.intervalMs) / 3600000, " 小时一次")}`,
        ),
      );
      head.append(
        title,
        tag(
          item.status === "running"
            ? "采集中"
            : item.status === "paused"
              ? "已暂停"
              : statusLabel(item.status),
          item.status === "paused" ? "warn" : "",
        ),
      );
      card.append(head);
      const grid = el("div", "record-grid");
      grid.append(
        detailDatum("下次计划", item.nextDueAt ? date(item.nextDueAt) : null),
        detailDatum("暂停原因", item.pauseReason),
        detailDatum("当前运行", item.activeRunId),
        detailDatum("任务编号", item.id),
      );
      card.append(grid);
      const action =
          item.status === "running"
            ? "pause"
            : item.status === "paused"
              ? "resume"
              : "start",
        button = el(
          "button",
          "",
          action === "pause" ? "暂停" : action === "resume" ? "恢复" : "启动",
        );
      button.type = "button";
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          await api(
            `/api/analytics/collections/${encodeURIComponent(item.id)}/${action}`,
            { method: "POST", body: {} },
          );
          showNotice(
            action === "pause"
              ? "采集任务已暂停。"
              : "采集任务状态已更新；未连接采集浏览器时会明确保持暂停。",
          );
          await loadCollections();
        } catch (error) {
          showNotice(error.message, "error");
        } finally {
          button.disabled = false;
        }
      });
      card.append(button);
      container.append(card);
    });
  } catch {
    empty(
      container,
      "持续采集服务尚未启用",
      "服务更新后将在这里显示已配置任务；当前不影响已有分析数据。",
    );
  }
}

async function configureCollection(event) {
  event.preventDefault();
  const button = $("button[type=submit]", event.currentTarget);
  button.disabled = true;
  try {
    const input = Object.fromEntries(new FormData(event.currentTarget));
    await api("/api/analytics/collections/configure", {
      method: "POST",
      body: {
        ...input,
        intervalMs: Number(input.intervalMs),
        pageSize: Number(input.pageSize),
      },
    });
    showNotice("商城店铺观察配置已保存，尚未启动。");
    event.currentTarget.reset();
    await loadCollections();
  } catch (error) {
    showNotice(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

const loaders = {
  overview: loadOverview,
  market: loadMarket,
  opportunities: loadOpportunities,
  brands: loadBrands,
  orders: loadOrders,
  batches: loadBatches,
  health: loadHealth,
};

async function navigate(view, replace = false) {
  if (!viewCopy[view]) view = "overview";
  state.view = view;
  $$(".view").forEach((node) =>
    node.classList.toggle("active", node.id === `view-${view}`),
  );
  $$(".nav-item").forEach((node) =>
    node.classList.toggle("active", node.dataset.view === view),
  );
  const [crumb, title, subtitle] = viewCopy[view];
  $("#breadcrumb").textContent = crumb;
  $("#page-title").textContent = title;
  $("#page-subtitle").textContent = subtitle;
  document.title = `${crumb} · JD Pipeline`;
  if ((location.hash || "#overview") !== `#${view}`)
    history[replace ? "replaceState" : "pushState"](null, "", `#${view}`);
  showNotice("");
  try {
    await loaders[view]();
    $("#source-dot").className = "signal good";
    $("#source-status").textContent = "数据服务已连接";
  } catch (error) {
    showNotice(error.message, "error");
    $("#source-dot").className = "signal bad";
    $("#source-status").textContent = "部分数据暂不可用";
  }
}

function bind() {
  $$(".nav-item").forEach((button) =>
    button.addEventListener("click", () => navigate(button.dataset.view)),
  );
  document.addEventListener("click", (event) => {
    const target = event.target.closest("[data-go]");
    if (target) navigate(target.dataset.go);
  });
  $("#refresh").addEventListener("click", () => navigate(state.view, true));
  $("#detail-close").addEventListener("click", () =>
    $("#detail-panel").close(),
  );
  $$("[data-market-mode]").forEach((button) =>
    button.addEventListener("click", () => {
      state.marketMode = button.dataset.marketMode;
      state.marketPage = 1;
      $("#market-source-field").hidden = state.marketMode === "historical";
      $$("[data-market-mode]").forEach((x) =>
        x.classList.toggle("active", x === button),
      );
      loadMarket().catch((e) => showNotice(e.message, "error"));
    }),
  );
  $$("[data-opportunity-mode]").forEach((button) =>
    button.addEventListener("click", () => {
      state.opportunityMode = button.dataset.opportunityMode;
      state.opportunityPage = 1;
      $$("[data-opportunity-mode]").forEach((x) =>
        x.classList.toggle("active", x === button),
      );
      loadOpportunities().catch((e) => showNotice(e.message, "error"));
    }),
  );
  $("#market-filters").addEventListener("submit", (event) => {
    event.preventDefault();
    state.marketPage = 1;
    loadMarket().catch((e) => showNotice(e.message, "error"));
  });
  $("#opportunity-filters").addEventListener("submit", (event) => {
    event.preventDefault();
    state.opportunityPage = 1;
    loadOpportunities().catch((e) => showNotice(e.message, "error"));
  });
  $("#transfer-opportunities").addEventListener("click", transferOpportunities);
  $("#clear-opportunity-selection").addEventListener(
    "click",
    clearOpportunitySelection,
  );
  $("#order-file").addEventListener("change", (event) => {
    $("#order-file-name").textContent =
      event.target.files[0]?.name || "尚未选择文件";
  });
  $("#order-import").addEventListener("submit", importOrders);
  $("#reconcile-file").addEventListener("change", (event) => {
    $("#reconcile-file-name").textContent =
      event.target.files[0]?.name || "尚未选择文件";
  });
  $("#reconcile-form").addEventListener("submit", importReconciliation);
  $("#goal-form").addEventListener("submit", saveGoal);
  $("#collection-form").addEventListener("submit", configureCollection);
  window.addEventListener("hashchange", () =>
    navigate(location.hash.slice(1), true),
  );
}

async function init() {
  bind();
  try {
    const session = await api("/api/analytics/session");
    state.token = session.token || "";
    state.shop = session.shop || "";
    $("#shop-name").textContent = state.shop || "店铺待确认";
    await navigate(location.hash.slice(1) || "overview", true);
  } catch (error) {
    $("#shop-name").textContent = "连接失败";
    $("#source-dot").className = "signal bad";
    $("#source-status").textContent = "数据服务未就绪";
    showNotice(error.message, "error");
  }
}

init();
