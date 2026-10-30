const $ = (s) => document.querySelector(s);
let state, selected, discoverySelection;
let detailRequest = 0;
const labels = {
  QUEUED: "排队中",
  RUNNING: "执行中",
  NEEDS_INPUT: "需要处理",
  UNKNOWN_OUTCOME: "等待对账",
  DONE: "已完成",
  CANCELLED: "已取消",
};
const attentionLabel = (j) =>
  j.status === "DONE" && j.remoteState === "REJECTED"
    ? "驳回需处理"
    : j.status === "DONE" && j.platformWarning
      ? "平台待核实"
      : j.status === "NEEDS_INPUT" && /补贴价/.test(j.error || "")
        ? "待核来源价格"
        : j.status === "NEEDS_INPUT" &&
            /缺少有来源的商品事实|缺少价格|来源品牌.*缺失/.test(j.error || "")
          ? "资料未采全"
          : labels[j.status];
const stages = {
  priceAudit: "核对售价依据",
  queued: "等待执行",
  collect: "采集京东资料",
  price: "只更新京东价格",
  assets: "下载原图",
  facts: "核对商品资料",
  normalize: "自动整理商品资料",
  "agent-title": "Luna 整理标题",
  "collect-targeted": "补采缺失参数",
  "media-review": "核对图片适用性",
  release: "执行版本核验",
  plan: "匹配上架规则",
  validate: "检查完整性与授权",
  preflight: "预检平台与类目字段",
  account: "核对店铺",
  deduplicate: "来源索引查重",
  syncSources: "同步历史商品来源",
  save: "填写并保存",
  verify: "读回核验",
  submit: "提交审核",
  reconcile: "核对远端结果",
  repairLegacy: "修复旧草稿继承字段",
  done: "流程完成",
};
const remote = {
  SUBMITTED: "待审核",
  APPROVED: "审核通过",
  REJECTED: "审核不通过",
  ON_SALE: "在售",
  DRAFT_VERIFIED: "已保存并核验",
  DRAFT_SAVED: "已保存",
};
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const safePriceUrl = (value) => {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
};
const priceAmount = (value) => {
  if (value === null || value === undefined || String(value).trim() === "")
    return null;
  const cleaned = String(value).replace(/[¥￥元,，\s]/g, "");
  if (!/^\d+(?:\.\d{1,2})?$/.test(cleaned)) return null;
  const amount = Number(cleaned);
  return Number.isFinite(amount) ? amount : null;
};
const money = (value) => {
  const amount = priceAmount(value);
  return amount === null ? null : `¥${amount.toFixed(2)}`;
};
const priceTime = (value) => {
  const time = value && new Date(value);
  return time && Number.isFinite(time.getTime())
    ? time.toLocaleString("zh-CN")
    : "";
};
function priceCard(label, item, tone, basis = "", unit = "") {
  const amount = money(item?.value);
  const url = safePriceUrl(item?.sourceUrl);
  const sub = [basis, priceTime(item?.capturedAt)].filter(Boolean).join(" · ");
  return `<section class="price-card ${tone}"><div class="price-label">${label}</div><strong>${amount || (tone === "listing" ? "未定价" : "待核价")}</strong>${unit ? `<span class="price-unit">/ ${esc(unit)}</span>` : ""}${sub ? `<div class="price-meta">${esc(sub)}</div>` : ""}${url ? `<a class="price-source" href="${esc(url)}" target="_blank" rel="noopener noreferrer">查看来源 ↗</a>` : ""}</section>`;
}
function priceDisplay(comparison, compact = false) {
  if (!comparison)
    return compact
      ? `<div class="price-strip"><span class="price-chip jd"><small>京东</small><strong>待核价</strong></span><span class="price-chip competitor"><small>竞品</small><strong>待核价</strong></span><span class="price-chip listing"><small>上架</small><strong>未定价</strong></span></div>`
      : `<section class="price-comparison"><h2>价格对照</h2><div class="price-cards">${priceCard("京东价", null, "jd")}${priceCard("竞品价", null, "competitor")}${priceCard("最终上架价", null, "listing")}</div></section>`;
  const { jd, competitor, listing } = comparison;
  const jdAmount = priceAmount(jd?.value);
  const competitorAmount = priceAmount(competitor?.value);
  const listingAmount = priceAmount(listing?.value);
  const delta = (base) =>
    listingAmount !== null && base !== null ? listingAmount - base : null;
  const deltaText = (base, label) => {
    const difference = delta(base);
    if (difference === null) return "";
    const pct =
      base > 0 ? Math.abs((difference / base) * 100).toFixed(1) : null;
    const direction =
      difference < 0 ? "低于" : difference > 0 ? "高于" : "持平";
    return `<span>${label}${direction} ¥${Math.abs(difference).toFixed(2)}${pct === null ? "" : `（${pct}%）`}</span>`;
  };
  const basis =
    jd?.basis === "subsidy"
      ? "补贴价（备用依据）"
      : jd?.basis === "jd-price"
        ? "日常价 / 京东价"
        : "";
  const listingBasis =
    {
      "competitor-bounded": "同款竞品参考价，受京东底线约束",
      "competitor-minus-cent": "同款竞品最低价减 0.01 元",
      "jd-price": "京东日常价 / 京东价",
      subsidy: "京东补贴价（备用依据）",
    }[listing?.basis] || "";
  const cards = `<div class="price-cards">${priceCard("京东价", jd, "jd", basis, comparison.unit)}${priceCard("竞品价", competitor, "competitor", "", comparison.unit)}${priceCard("最终上架价", listing, "listing", listingBasis, comparison.unit)}</div>`;
  if (compact)
    return `<div class="price-strip">${[
      ["京东", jd],
      ["竞品", competitor],
      ["上架", listing],
    ]
      .map(
        ([label, item], index) =>
          `<span class="price-chip ${["jd", "competitor", "listing"][index]}"><small>${label}</small><strong>${money(item?.value) || (index === 2 ? "未定价" : "待核价")}</strong>${comparison.unit ? `<em>/ ${esc(comparison.unit)}</em>` : ""}</span>`,
      )
      .join("")}</div>`;
  const reviewed = comparison.reviewed
    ? "已核对"
    : "竞品仅供参考，尚未最终核定";
  return `<section class="price-comparison"><h2>价格对照</h2>${cards}<div class="price-notes"><div class="price-deltas">${deltaText(jdAmount, "较京东价")}${deltaText(competitorAmount, "较竞品价")}</div>${comparison.minimum ? `<div>京东基准 85% 底线：${money(comparison.minimum) || "待核价"}</div>` : ""}<div>${esc(reviewed)}${comparison.stale ? " · 价格资料可能已过期" : ""}</div>${comparison.note ? `<p>${esc(comparison.note)}</p>` : ""}</div></section>`;
}
async function api(path, data) {
  const r = await fetch(
    path,
    data === undefined
      ? {}
      : {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Hezi-Token": state.token,
          },
          body: JSON.stringify(data),
        },
  );
  const v = await r.json();
  if (!r.ok) throw Error(v.error);
  return v;
}
function msg(s) {
  $("#message").textContent = s;
}
function options(id, rows, label) {
  const el = $(id),
    old = el.value;
  el.innerHTML = rows
    .map((x) => `<option value="${esc(x.id)}">${esc(x[label])}</option>`)
    .join("");
  if (rows.some((x) => x.id === old)) el.value = old;
}
async function refresh() {
  try {
    state = await api("/api/state");
    renderPreflight(state.preflight);
    renderControlledWave(state.controlledWave);
    $("#shop").textContent =
      state.shop +
      " · " +
      (state.busy
        ? "正在执行任务"
        : state.paused
          ? "浏览器或队列已暂停"
          : "服务就绪");
    if (state.traffic)
      $("#shop").textContent +=
        ` · 赫兹业务请求 ≤${state.traffic.requestsPerSecond} 次/秒 · 同时 ${state.traffic.maxConcurrent} 个` +
        (state.traffic.lastObservation
          ? ` · 最近核验 ${new Date(state.traffic.lastObservation.checkedAt).toLocaleTimeString()}`
          : " · 请求限流待现场核验");
    if (state.traffic?.jd)
      $("#shop").textContent +=
        ` · 京东主动翻页间隔 ≥${state.traffic.jd.intervalMs / 1000}秒（不含页面自动加载资源）`;
    renderBrandInventory();
    renderBrandSync();
    if (state.pricingTasks?.length)
      $("#pricing-progress").innerHTML = state.pricingTasks
        .map(
          (r) =>
            `<p><strong>${esc(r.title)}</strong><br>SKU ${esc(r.sku)} · ${r.status === "finalized" ? "本次审查完成" : "逐项核对中"} · 已核对 ${r.reviewed}/${r.total} · 待核对 ${r.pending}${r.identityChanged ? " · 商品资料变化，需重新审查" : ""}${r.evidenceExpired ? " · 报价已过期，需重新核验" : r.expiresAt ? ` · 报价有效至 ${new Date(r.expiresAt).toLocaleString()}` : ""}${r.error ? `<br><span class="error">${esc(r.error)}；已保留判断</span>` : ""}</p>`,
        )
        .join("");
    if (state.marketScans?.length)
      $("#market-progress").innerHTML = state.marketScans
        .map(
          (r) =>
            `<p><strong>${esc(r.query)}</strong> · ${r.status === "complete" ? "本次搜索条数已对齐" : r.status === "needs-review" ? "分页已读完，数量或重复SKU待复核" : "正在核对分页"}<br>已读 ${r.seen}/${r.total ?? "待确认"} 条结果 · 去重 ${r.uniqueItems} 个商品 / ${r.uniqueSkus} 个规格 · ${r.status === "running" ? `下次从第 ${r.next_page} 页继续` : "本次分页读取结束"}<br>有效期内详情 ${r.freshDetails ?? 0} 个 · 待核验详情 ${r.pendingDetails ?? r.uniqueItems} 个（详情核验不等于同款审查完成）</p>`,
        )
        .join("");
    if (state.discovery?.length)
      $("#discovery-progress").innerHTML = state.discovery
        .map((r) => {
          const counts = Object.fromEntries(r.skus.map((x) => [x.status, x.n]));
          const pages = r.pages
            .filter((x) => x.status === "done")
            .reduce((n, x) => n + x.n, 0);
          const labels = {
            pages: "核对店铺分页",
            variants: "核对独立规格",
            "complete-source": "已核对所选店铺与类目",
            "needs-review": "部分规格待复核",
          };
          return `<p><strong>${esc(r.shopName)}</strong> · ${esc(labels[r.status] ?? r.status)}${r.error ? `<br><span class="error">暂停原因：${esc(r.error)}；已保留断点</span>` : ""}<br>已读 ${pages} 页 · 规格已核对 ${counts.verified ?? 0} · 待核对 ${counts.pending ?? 0} · 身份不符 ${counts.excluded ?? 0} · 待复核 ${counts.blocked ?? 0}<br><button class="secondary" data-discovery-work="${esc(r.id)}">查看逐规格安排</button></p>`;
        })
        .join("");
    const sync = state.sourceIndex;
    if (sync?.partition && Date.now() - Date.parse(sync.at) < 120000) {
      $("#shop").textContent +=
        ` · 正在核对历史商品 ${sync.seen}/${sync.total}`;
    }
    $("#pause").textContent = state.paused ? "恢复队列" : "暂停队列";
    $("#android-status").textContent = state.android?.serial
      ? `已选择手机 ${state.android.serial} · ${state.android.paused?.message ?? (state.android.last?.status === "partial" ? "最近资料已保存，部分字段仍待补" : (state.android.last?.error ?? "等待手机采集任务"))}`
      : "尚未选择手机";
    if (state.android?.progress) {
      const p = state.android.progress;
      $("#android-status").textContent +=
        ` · SKU ${p.sku} 原图已保存：主图 ${p.main}/${p.mainCount ?? "待读取"}、详情 ${p.detail}/${p.detailCount ?? "待读取"}${p.complete ? "（原图采集完成）" : "（断点已保存）"}`;
    }
    const pauseReason = $("#pause-reason");
    pauseReason.hidden = !state.paused && !state.hzPaused;
    pauseReason.textContent = state.paused
      ? "暂停原因：" +
        (typeof state.paused === "string"
          ? state.paused
          : (state.paused.message ?? JSON.stringify(state.paused)))
      : "";
    if (state.hzPaused)
      pauseReason.textContent +=
        (state.paused ? "；" : "") +
        "赫兹操作暂停：" +
        (typeof state.hzPaused === "string"
          ? state.hzPaused
          : (state.hzPaused.message ?? JSON.stringify(state.hzPaused)));
    if (!$("#brand").options.length) {
      options("#brand", state.brands, "name");
      options("#category", state.categories, "path");
      options("#policy", state.policies, "id");
    }
    const js = state.jobs;
    $("#stats").innerHTML = [
      ["全部任务", js.length],
      [
        "执行与排队",
        js.filter((j) => ["QUEUED", "RUNNING"].includes(j.status)).length,
      ],
      [
        "需要处理",
        js.filter(
          (j) =>
            ["NEEDS_INPUT", "UNKNOWN_OUTCOME"].includes(j.status) ||
            (j.status === "DONE" && j.remoteState === "REJECTED"),
        ).length,
      ],
      ["已完成", js.filter((j) => j.status === "DONE").length],
    ]
      .map(
        ([l, n]) =>
          `<div class="stat"><span>${l}</span><strong>${n}</strong></div>`,
      )
      .join("");
    $("#count").textContent = js.length;
    render();
    if ($("#detail").open && selected?.job?.id && !$("#facts"))
      await detail(selected.job.id, true);
  } catch (e) {
    msg("服务连接失败：" + e.message);
  }
}
function renderControlledWave(wave) {
  const panel = $("#controlled-wave");
  panel.hidden = !wave;
  if (!wave) return;
  const status = {
    planned: "尚未开始本轮",
    "in-progress": "本轮正在推进",
    "needs-input": "部分商品需要处理",
    "needs-reconciliation": "先核对未确认的操作结果",
    complete: "本轮已核验提交",
  };
  $("#wave-status").textContent = status[wave.status] || "读取本轮进度";
  $("#wave-summary").textContent =
    `目标新增 ${wave.targetCount} 件 · 累计候选 ${wave.candidateCount ?? wave.plannedCount} 个 · 已开始 ${wave.startedCount} 个 · 已核验新增 ${wave.completedCount} 个 · 剩余 ${wave.remainingCount} 个`;
  $("#wave-progress").max = Math.max(1, wave.targetCount);
  $("#wave-progress").value = wave.completedCount;
  $("#wave-counts").innerHTML = [
    ["新增候选", wave.plannedCount],
    ["已存在", wave.existingCount ?? 0],
    ["重复记录", wave.duplicateCount ?? 0],
    ["已排除", wave.excludedCount ?? 0],
    ["尚需补充", wave.gapCount ?? 0],
    ["排队", wave.counts.queued],
    ["执行中", wave.counts.running],
    ["待处理", wave.counts.needsInput],
    ["待对账", wave.counts.unknown],
    ["待审核", wave.counts.submitted],
    ["审核通过", wave.counts.approved],
    ["在售", wave.counts.onSale],
  ]
    .map(
      ([label, count]) => `<span><strong>${esc(count)}</strong>${label}</span>`,
    )
    .join("");
  const group = wave.currentGroup;
  $("#wave-current").innerHTML = group
    ? `<strong>当前小组 · ${group.items.length}件</strong>` +
      group.items
        .map((item) => {
          const job = state.jobs.find((j) => j.id === item.id);
          const disposition = {
            existing: "历史商品，不计新增",
            duplicate: "存在多条历史记录",
            excluded: "不纳入本轮目标",
          }[item.disposition];
          const statusText = disposition
            ? disposition
            : item.complete
              ? remote[item.remoteState] || item.remoteState
              : labels[item.status] || item.status;
          return `<div class="wave-group-item"><div>${esc(job?.title || "京东商品 " + item.sku)}</div><div class="meta">SKU ${esc(item.sku)} · ${esc(statusText)} · ${esc(stages[item.stage] || item.stage)}</div>${item.reason ? `<div class="error">${esc(item.reason)}</div>` : ""}</div>`;
        })
        .join("")
    : '<p class="meta">候选范围已保存，开始处理后会显示当前小组。</p>';
}

function render() {
  const f = $("#filter").value;
  const list = state.jobs.filter(
    (j) =>
      f === "all" ||
      (f === "active" && ["QUEUED", "RUNNING"].includes(j.status)) ||
      (f === "attention" &&
        (["NEEDS_INPUT", "UNKNOWN_OUTCOME"].includes(j.status) ||
          (j.status === "DONE" && j.remoteState === "REJECTED"))) ||
      j.status === f,
  );
  $("#tasks").innerHTML = list.length
    ? list
        .map(
          (j) =>
            `<article class="job"><div><div class="title">${esc(j.title || "京东商品 " + j.sku)}</div>${j.specification ? `<div class="meta">规格：${esc(j.specification)}</div>` : ""}<div class="meta">SKU ${esc(j.sku)} · ${j.recipe.source === "android" ? "安卓手机" : "Ego浏览器"} · ${esc(new Date(j.createdAt).toLocaleString("zh-CN"))}</div>${priceDisplay(j.priceComparison, true)}${j.error ? `<div class="error">${esc(j.error)}</div>` : ""}${j.remoteStatus ? `<div class="error">远端状态：${esc(j.remoteStatus)}</div>` : ""}${j.remoteReason && j.remoteReason !== j.remoteStatus ? `<div class="error">远端提示：${esc(j.remoteReason)}</div>` : ""}${j.platformWarning ? `<div class="error">平台提示：${esc(j.platformWarning.message)}<br><span class="meta">观察时间 ${esc(new Date(j.platformWarning.checkedAt).toLocaleString("zh-CN"))} · 待核实处理</span></div>` : ""}</div><div><span class="status ${j.status === "DONE" && (j.platformWarning || j.remoteState === "REJECTED") ? "NEEDS_INPUT" : j.status}">${attentionLabel(j)}</span><div class="meta">${esc(j.status === "DONE" ? remote[j.remoteState] || j.remoteState : stages[j.stage] || j.stage)}</div></div><div class="actions"><button class="secondary" data-detail="${j.id}">查看详情</button>${!j.remoteId && ["QUEUED", "NEEDS_INPUT", "CANCELLED"].includes(j.status) && state.android?.serial ? `<button class="secondary" data-android-job="${j.id}">用手机采集</button>` : ""}${j.remoteId ? `<a target="_blank" rel="noopener" href="https://b.csgmall.com.cn/mall-view/product/detail?itemId=${encodeURIComponent(j.remoteId)}">查看赫兹商品 ↗</a>` : ""}</div></article>`,
        )
        .join("")
    : '<div class="empty"><strong>暂无任务</strong>从上方添加链接，采集、保存和提交进度会出现在这里。</div>';
}
$("#batch").onsubmit = async (e) => {
  e.preventDefault();
  const b = e.submitter;
  b.disabled = true;
  try {
    const r = await api("/api/batches", {
      links: $("#links").value.trim().split(/\s+/).filter(Boolean),
      recipe: {
        source: $("#source").value,
        brandId: $("#brand").value,
        categoryId: $("#category").value,
        policyId: $("#policy").value,
        unit: "件",
        through: $("#through").value,
      },
    });
    msg(
      `已接收 ${r.items.length} 件，其中 ${r.items.filter((x) => x.reused).length} 件复用已有任务`,
    );
    $("#links").value = "";
    await refresh();
  } catch (e) {
    msg(e.message);
  } finally {
    b.disabled = false;
  }
};
$("#pause").onclick = async () => {
  try {
    await api(state.paused ? "/api/resume" : "/api/pause", {});
    await refresh();
  } catch (e) {
    msg(e.message);
  }
};
$("#filter").onchange = render;
$("#close").onclick = () => $("#detail").close();
$("#tasks").onclick = async (e) => {
  const id = e.target.closest("[data-detail]")?.dataset.detail;
  if (id) await detail(id);
};
async function detail(id, silent = false) {
  const request = ++detailRequest;
  try {
    const response = await api("/api/jobs/" + id);
    if (
      request !== detailRequest ||
      (silent &&
        (!$("#detail").open || selected?.job?.id !== id || $("#facts")))
    )
      return;
    selected = response;
    const {
      job: j,
      events,
      row,
      requiredFacts,
      executionSpeed: speed,
      agentTasks = [],
      workflowTiming: timing,
    } = selected;
    const comparison = selected.priceComparison || j.priceComparison || null;
    $("#detail-content").innerHTML =
      `<p>${esc(row?.plan?.displayTitle?.value || row?.product?.title.value || j.sku)}</p><div class="summary">${attentionLabel(j)} · ${esc(stages[j.stage] || j.stage)}${j.error ? '<p class="error">' + esc(j.error) + "</p>" : ""}</div>${priceDisplay(comparison)}${row?.plan && !comparison ? `<p class="meta">售价依据：${esc(row.plan.price.basis === "subsidy" ? "京东补贴价（备用依据）" : row.plan.price.basis === "jd-price" ? "京东明确日常价 / 京东价" : row.plan.price.basis)}</p>` : ""}${row?.product && ["NEEDS_INPUT", "CANCELLED"].includes(j.status) ? `<form id="facts"><h2>补充商品资料</h2><p>已有来源会保留。缺失项填写真实资料后继续，不确定的内容请勿猜测。价格优先用明确日常价／京东价，取不到时才用明确补贴价。不填到手价或无标签划线价。</p><div class="options">${requiredFacts.map((name, i) => `<label>${esc(name)}<input data-fact="${esc(name)}" value="${esc(["补贴价", "京东价"].includes(name) ? (row.product.price?.basis === (name === "京东价" ? "jd-price" : "subsidy") ? row.product.price.value : "") : row.product.specs[name]?.value)}" required></label>`).join("")}</div><label>资料来源链接<input id="fact-source" type="url" value="${esc(row.product.url)}" required></label><p><a href="${esc(row.product.url)}" target="_blank" rel="noopener">打开京东原商品 ↗</a> · 主图 ${row.product.assets.filter((a) => a.role === "main").length} 张 / 详情图 ${row.product.assets.filter((a) => a.role === "detail").length} 张</p>${row.product.assets.length ? `<details><summary>查看本地原图（${row.product.assets.length}张）</summary><div class="asset-grid">${row.product.assets.map((a, i) => `<a href="/api/assets/${j.id}/${i}" target="_blank"><img loading="lazy" alt="${a.role === "main" ? "主图" : "详情图"} ${a.order + 1}" src="/api/assets/${j.id}/${i}"></a>`).join("")}</div></details>` : ""}<p>详情图按所选规格来源顺序保留，由程序检查下载和上传结果，无需看图确认。</p><button type="submit">保存资料并继续</button></form>` : ""}${timing ? `<h2>任务全程耗时</h2><p><strong>${(timing.elapsedMs / 60000).toFixed(1)} 分钟</strong> · ${timing.complete ? "已完成" : "尚未完成"}</p><p>从首次入队起，包含排队、采集、下载、处理、发布和等待；历史尝试保留。Luna 调用 ${timing.agentCalls} 次，共 ${(timing.agentMs / 1000).toFixed(1)} 秒，缓存复用 ${timing.cached} 次。</p>` : ""}${speed ? `<h2>最近一次发布耗时</h2><p><strong>${speed.totalMs === null ? "尚未完成" : (speed.totalMs / 1000).toFixed(1) + " 秒"}</strong> · ${esc(new Date(speed.startedAt).toLocaleString())}</p>${speed.stages.map((x) => `<div class="event"><span>${esc(x.name)}</span><span>${x.durationMs === null ? "未记录 / 未完成" : (x.durationMs / 1000).toFixed(1) + " 秒"}</span></div>`).join("")}<p>从本次资料校验通过到提交结果确认；不含此前采集、补价、原图下载、登录及人工等待。各阶段之间的调度间隔计入总耗时。</p>` : ""}${agentTasks.length ? `<h2>Luna 文本任务</h2>${agentTasks.map((t) => `<div class="event"><span>${esc(t.model)} · ${esc({ pending: "等待处理", running: "处理中", complete: "完成", cached: "复用结果", failed: "未完成", stale: "资料已更新" }[t.status] || t.status)}</span><span>${t.durationMs == null ? "—" : (t.durationMs / 1000).toFixed(1) + " 秒"}</span></div>${t.error ? `<p class="error">${esc(t.error)}</p>` : ""}`).join("")}<p>仅整理当前规格的文字，不操作浏览器；返回结果由程序校验。</p>` : ""}<h2>阶段记录</h2>${events.map((e) => `<div class="event"><span>${esc(stages[e.stage] || e.stage)} · ${e.kind === "started" ? "开始" : e.kind === "completed" ? "完成" : e.kind === "failed" ? "失败" : "已记录"}</span><span>${e.duration_ms === null ? "—" : (e.duration_ms / 1000).toFixed(1) + " 秒"}</span></div>`).join("") || "<p>等待执行</p>"}<div class="compose-footer">${["NEEDS_INPUT", "CANCELLED"].includes(j.status) ? '<button id="retry">继续此任务</button>' : ""}${j.productId && j.status !== "RUNNING" ? '<button id="reconcile" class="secondary">只读对账</button>' : ""}</div>`;
    const summary = $("#detail-content .summary");
    if (j.remoteStatus)
      summary.insertAdjacentHTML(
        "beforeend",
        `<p class="error">远端状态：${esc(j.remoteStatus)}</p>`,
      );
    if (j.remoteReason && j.remoteReason !== j.remoteStatus)
      summary.insertAdjacentHTML(
        "beforeend",
        `<p class="error">远端提示：${esc(j.remoteReason)}</p>`,
      );
    if (j.platformWarning)
      summary.insertAdjacentHTML(
        "beforeend",
        `<p class="error">平台提示：${esc(j.platformWarning.message)}</p>`,
      );
    if (!$("#detail").open) $("#detail").showModal();
    const form = $("#facts");
    if (form)
      form.onsubmit = async (e) => {
        e.preventDefault();
        try {
          await api("/api/jobs/" + id + "/facts", {
            values: Object.fromEntries(
              [...form.querySelectorAll("[data-fact]")].map((el) => [
                el.dataset.fact,
                el.value,
              ]),
            ),
            sourceUrl: $("#fact-source").value,
          });
          await act("retry");
        } catch (e) {
          msg(e.message);
        }
      };
    const retry = $("#retry");
    if (retry) retry.onclick = () => act("retry");
    const rec = $("#reconcile");
    if (rec) rec.onclick = () => act("reconcile");
  } catch (e) {
    msg(e.message);
  }
}
async function act(action) {
  try {
    await api("/api/jobs/" + selected.job.id + "/" + action, {});
    $("#detail").close();
    await refresh();
    msg(action === "retry" ? "任务已重新排队" : "已更新对账结果");
  } catch (e) {
    msg(e.message);
  }
}
await refresh();
setInterval(refresh, 2500);
// The same authenticated local actions are available to compatible agent browsers.
if (document.modelContext?.registerTool) {
  const lifecycle = new AbortController();
  window.addEventListener("pagehide", () => lifecycle.abort(), { once: true });
  for (const tool of [
    {
      name: "list_upload_tasks",
      title: "查看上架任务",
      description: "读取本机队列的真实任务状态与阻塞原因",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: async () => {
        await refresh();
        return state.jobs.map(({ id, sku, status, stage, error }) => ({
          id,
          sku,
          status,
          stage,
          error,
        }));
      },
    },
    {
      name: "enqueue_jd_links",
      title: "添加京东上架任务",
      description:
        "将京东链接添加到当前界面所选品牌、类目、规则与终点的队列；会执行真实保存或提交",
      inputSchema: {
        type: "object",
        properties: {
          links: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: 200,
          },
        },
        required: ["links"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: async (input) => {
        if (
          !Array.isArray(input?.links) ||
          input.links.some((x) => typeof x !== "string")
        )
          throw Error("需要商品链接数组");
        const r = await api("/api/batches", {
          links: input.links,
          recipe: {
            brandId: $("#brand").value,
            categoryId: $("#category").value,
            policyId: $("#policy").value,
            unit: "件",
            through: $("#through").value,
          },
        });
        await refresh();
        return r;
      },
    },
  ]) {
    try {
      Promise.resolve(
        document.modelContext.registerTool(tool, { signal: lifecycle.signal }),
      ).catch(() => {});
    } catch {}
  }
}

function renderBrandInventory() {
  const inventory = state?.brandInventory;
  if (!inventory) return;
  const p = inventory.progress;
  const status =
    {
      listing: "正在读取品牌列表",
      details: "正在核对授权类目",
      complete: "当前品牌库核对完成",
    }[p.status] ?? "核对待恢复";
  $("#brand-progress").textContent =
    `${status} · 品牌 ${p.listed}/${p.total ?? "待确认"} · 当前日期内通过审核 ${p.potentiallyActive} · 详情已核对 ${p.details}${inventory.activation ? ` · 有效类目品牌 ${inventory.activation.grants} · 类目需处理 ${inventory.activation.rejected.length}` : ""} · ${p.error ? "已保留进度：" + p.error : "已保存断点"}`;
  const search = $("#brand-search").value.trim().toLowerCase();
  const labels = {
    0: "待审核",
    1: "审核通过",
    2: "驳回",
    3: "已过期",
    4: "即将到期",
    5: "停用",
    6: "撤销审核",
  };
  $("#brand-inventory").innerHTML =
    `<p>这里只显示授权核对结果，商品发现、定价和上架进度会另行记录。</p><table><thead><tr><th>品牌</th><th>状态</th><th>有效期至</th><th>已核对类目</th></tr></thead><tbody>` +
    inventory.rows
      .filter((r) => r.name.toLowerCase().includes(search))
      .map(
        (r) =>
          `<tr><td>${esc(r.name)}</td><td>${esc(labels[r.platformStatus] ?? "待核验")}${r.potentiallyActive ? "" : " · 暂不纳入上架"}</td><td>${esc(r.validUntil ?? "待核验")}</td><td>${r.detailChecked ? esc(r.categories.join("；") || (r.inactiveCategories?.length ? "关联类目已失效：" + r.inactiveCategories.join("；") : "暂无有效类目")) : "待核对"}</td></tr>`,
      )
      .join("") +
    "</tbody></table>";
}
$("#brand-search").addEventListener("input", renderBrandInventory);

function renderBrandSync() {
  const progress = state?.brandSync;
  if (!progress) return;
  $("#brand-sync-summary").textContent =
    `有效授权品牌 ${progress.authorizedBrands} · 已开始发现 ${progress.started} · 尚未开始 ${progress.notStarted} · 发现遇阻 ${progress.blocked}`;
  const search = $("#sync-search").value.trim().toLowerCase(),
    filter = $("#sync-filter").value;
  const labels = {
    "not-started": "尚未核验京东店铺与入口",
    discovering: "发现进行中",
    blocked: "发现遇阻，断点已保存",
    "selected-sources-complete": "所选来源已读完",
  };
  const rows = progress.rows.filter(
    (r) =>
      r.name.toLowerCase().includes(search) &&
      (filter === "all" ||
        (filter === "started"
          ? r.sources.length > 0
          : r.sourceStatus === filter)),
  );
  $("#brand-sync-rows").innerHTML =
    `<table><thead><tr><th>品牌</th><th>发现范围及进度</th><th>工作台任务</th><th>已核验远端状态</th><th>需处理</th></tr></thead><tbody>` +
    rows
      .map(
        (r) =>
          `<tr><td>${esc(r.name)}</td><td>${esc(labels[r.sourceStatus] ?? r.sourceStatus)}<br>${r.sources.map((s) => esc(s.shopName)).join("；")}<br>已读 ${r.pagesRead} 页 · 规格核验 ${r.verifiedSkus} / 待核验 ${r.pendingSkus} / 待复核 ${r.blockedSkus}</td><td>${r.jobs} 件 · 执行或排队 ${r.queued} · 需处理 ${r.needsInput} · 平台待核实 ${r.platformNeedsReview}</td><td>待审核 ${r.submitted}<br>审核通过 ${r.approved}<br>在售 ${r.onSale}</td><td>${[...r.reasons, ...r.jobReasons].map(esc).join("；") || (r.sources.length ? "—" : "待建立可信来源映射")}</td></tr>`,
      )
      .join("") +
    "</tbody></table>";
}
$("#sync-search").addEventListener("input", renderBrandSync);
$("#sync-filter").addEventListener("change", renderBrandSync);

async function loadDiscoveryWork(runId) {
  const box = $("#discovery-work");
  box.textContent = "正在核对本地记录…";
  try {
    const response = await fetch(
        `/api/discovery/${encodeURIComponent(runId)}/work`,
      ),
      data = await response.json();
    if (!response.ok) throw Error(data.error || "读取失败");
    discoverySelection = data;
    const names = {
      task: "已有工作台任务",
      existing: "已有赫兹商品",
      duplicate: "多份商品待核对",
      unassigned: "待安排类目与任务",
      "index-required": "需更新来源索引",
      "source-pending": "京东规格待核验",
      "source-excluded": "已排除",
      "source-blocked": "来源待处理",
    };
    const assignment = `<form id="discovery-assign"><p>勾选同一授权类目的规格，再选择规则入队。不同类目请分别安排；商品资料和价格仍逐件核验。</p><label>目标类目 <select name="category" required><option value="">请选择类目</option>${state.categories.map((c) => `<option value="${esc(c.id)}">${esc(c.path)}</option>`).join("")}</select></label><label>店铺规则 <select name="policy" required>${state.policies.map((p) => `<option value="${esc(p.id)}">${esc(p.id)}</option>`).join("")}</select></label><label>销售单位 <input name="unit" value="件" required /></label><label>执行到 <select name="through"><option value="submit">提交审核</option><option value="draft">保存草稿</option></select></label><button type="submit">安排勾选规格</button><p id="discovery-assign-message" role="status"></p></form>`;
    box.innerHTML = `<h3>${esc(data.shopName)} · 逐规格安排</h3><p>按已保存来源、任务及商品索引核对，不会自动新建商品。${data.indexError ? esc(data.indexError) : ""}${data.sourceNeedsRecheck ? " · 店铺身份需要重新核验" : ""}</p><p>${Object.entries(
      data.counts,
    )
      .map(([k, v]) => `${esc(names[k] || k)} ${v}`)
      .join(
        " · ",
      )}</p>${assignment}<table><thead><tr><th>选择</th><th>京东SKU / 规格</th><th>当前安排</th><th>已有商品及记录状态</th><th>原因</th></tr></thead><tbody>${data.rows.map((r) => `<tr><td>${r.kind === "unassigned" && !data.sourceNeedsRecheck ? `<input type="checkbox" form="discovery-assign" name="sku" value="${esc(r.sku)}" aria-label="选择规格 ${esc(r.sku)}" />` : "—"}</td><td>${esc(r.sku)}<br>${esc(r.specification)}</td><td>${esc(names[r.kind] || r.kind)}${r.jobStatus ? " · " + esc(labels[r.jobStatus] || r.jobStatus) : ""}</td><td>${r.records.map((x) => `${esc(x.itemId)} · ${esc(remote[x.status] || x.status)}`).join("<br>") || "—"}</td><td>${esc(r.reason || "—")}</td></tr>`).join("")}</tbody></table>`;
  } catch (e) {
    box.textContent = "读取失败：" + e.message;
  }
}
$("#discovery-progress").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-discovery-work]");
  if (button) await loadDiscoveryWork(button.dataset.discoveryWork);
});

$("#discovery-work").addEventListener("submit", async (event) => {
  if (event.target.id !== "discovery-assign") return;
  event.preventDefault();
  const form = event.target,
    button = event.submitter,
    values = new FormData(form);
  const message = $("#discovery-assign-message");
  button.disabled = true;
  try {
    const result = await api(
      `/api/discovery/${encodeURIComponent(discoverySelection.runId)}/enqueue`,
      {
        skus: values.getAll("sku"),
        recipe: {
          brandId: discoverySelection.brandId,
          categoryId: values.get("category"),
          policyId: values.get("policy"),
          unit: values.get("unit"),
          through: values.get("through"),
        },
      },
    );
    const note = `已安排 ${result.items.length} 个规格，复用 ${result.items.filter((x) => x.reused).length} 个已有任务。`;
    message.textContent = note;
    msg(note);
    await refresh();
    await loadDiscoveryWork(discoverySelection.runId);
    const updatedMessage = $("#discovery-assign-message");
    if (updatedMessage) updatedMessage.textContent = note;
  } catch (e) {
    message.textContent = e.message;
  } finally {
    button.disabled = false;
  }
});

$("#android-detect").onclick = async () => {
  try {
    const r = await api("/api/android/devices", {});
    $("#android-device").innerHTML = r.devices
      .map(
        (d) =>
          `<option value="${esc(d.serial)}" ${d.status !== "device" ? "disabled" : ""}>${esc(d.model)} · ${esc(d.status)}</option>`,
      )
      .join("");
    $("#android-status").textContent = r.devices.length
      ? "请选择已授权设备"
      : "未检测到设备，请检查USB连接";
  } catch (e) {
    $("#android-status").textContent = e.message;
  }
};
$("#android-select").onclick = async () => {
  try {
    await api("/api/android/select", { serial: $("#android-device").value });
    await refresh();
  } catch (e) {
    $("#android-status").textContent = e.message;
  }
};
$("#tasks").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-android-job]");
  if (!b) return;
  b.disabled = true;
  try {
    await api(`/api/jobs/${b.dataset.androidJob}/source`, {
      source: "android",
    });
    await refresh();
  } catch (e) {
    msg(e.message);
    b.disabled = false;
  }
});
$("#android-resume").onclick = async () => {
  try {
    await api("/api/android/resume", {});
    await refresh();
    msg("手机页面核验通过；原有待补资料任务仍需补齐后继续");
  } catch (e) {
    msg(e.message);
  }
};

function renderPreflight(report) {
  if (!report) return;
  $("#preflight-result").innerHTML =
    `<p>${esc(new Date(report.checkedAt).toLocaleString("zh-CN"))} · 已检查 ${report.checked} 件 · ${report.checked ? (report.ready ? "检查通过" : "发现需处理项") : "当前没有待执行任务"}</p>` +
    report.items
      .map(
        (x) =>
          `<p>SKU ${esc(x.sku)}：${x.ready ? "本地资料检查通过" : x.issues.map((i) => esc(i.message)).join("；")}</p>`,
      )
      .join("") +
    (report.platform ?? [])
      .map(
        (x) =>
          `<p>类目 ${esc(x.categoryId)}：${x.ready ? "平台页面检查通过" : esc(x.message)}${x.details ? " · " + esc(JSON.stringify(x.details)) : ""}</p>`,
      )
      .join("");
}
$("#preflight").onclick = async () => {
  $("#preflight").disabled = true;
  $("#preflight-result").textContent = "正在检查资料和平台页面…";
  try {
    renderPreflight(await api("/api/preflight", {}));
  } catch (e) {
    $("#preflight-result").textContent = e.message;
  } finally {
    $("#preflight").disabled = false;
  }
};

const initialJob = new URLSearchParams(location.search).get("job");
if (initialJob) detail(initialJob);
