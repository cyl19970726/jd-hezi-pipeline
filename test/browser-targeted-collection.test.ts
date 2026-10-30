import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHTML } from "linkedom";
import { readJdRegions } from "../src/browser/extractors.js";
import { collectJdRegions } from "../src/browser/runtime.js";

test("targeted JD reader separates fact regions and never returns media", () => {
  const { document } = parseHTML(`<html><body>
    <div class="attrs"><div class="item"><b class="label">品牌：</b><span class="value">测试牌</span></div></div>
    <div class="Ptable"><table><tr><td>型号</td><td>A1</td></tr></table></div>
    <div class="package-list">包装清单：主机1台、线缆1根</div>
    <div id="detail-main"><img src="https://img.example/media.jpg"></div>
  </body></html>`);
  Object.assign(globalThis, {
    document,
    location: {
      href: "https://item.jd.com/123.html",
      pathname: "/123.html",
    },
  });
  const summary = readJdRegions(["summarySpecs"]);
  assert.deepEqual(Object.keys(summary.specs), ["品牌"]);
  assert.deepEqual(summary.observedRegions, ["summarySpecs"]);
  assert.equal("assets" in summary, false);

  const detail = readJdRegions(["detailSpecs", "packaging"]);
  assert.equal(detail.specs["型号"].value, "A1");
  assert.equal(detail.specs["包装清单"].value, "主机1台、线缆1根");
  assert.deepEqual(detail.observedRegions, ["detailSpecs", "packaging"]);
  assert.equal(JSON.stringify(detail).includes("media.jpg"), false);
});

function pageMock(responseColor = "红色 1件", responseSku = "123") {
  const evaluated: string[] = [];
  let eventReads = 0;
  return {
    evaluated,
    async evaluate(fn: Function) {
      evaluated.push(fn.name || fn.toString());
      if (fn.name === "readPage")
        return {
          accountChanged: false,
          login: false,
          risk: false,
          shop: "",
        };
      if (fn.name === "readJdRegions")
        return {
          sku: "123",
          url: "https://item.jd.com/123.html",
          selectedVariant: "红色 1件",
          specs: {
            包装清单: {
              value: "主机1台",
              sourceUrl: "https://item.jd.com/123.html",
              capturedAt: "2026-09-16T00:00:00.000Z",
              evidence: "包装区域",
            },
            未请求字段: {
              value: "不得泄漏",
              sourceUrl: "https://item.jd.com/123.html",
              capturedAt: "2026-09-16T00:00:00.000Z",
              evidence: "测试",
            },
          },
          capturedAt: "2026-09-16T00:00:00.000Z",
          observedRegions: ["packaging"],
        };
    },
    async cdp(method: string) {
      if (method === "Network.getResponseBody")
        return {
          body: JSON.stringify({
            wareInfoReadMap: {
              product_id: responseSku,
              color: responseColor,
              weight: "0.5",
              warranty: "一年",
            },
            productAttributeVO: {
              attributes: [{ labelName: "品牌", labelValue: "测试牌" }],
            },
          }),
        };
      return {};
    },
    async events() {
      eventReads++;
      return eventReads === 1
        ? []
        : [
            {
              method: "Network.responseReceived",
              params: {
                type: "XHR",
                requestId: "business-1",
                response: { url: "https://x/pc_detailpage_wareBusiness" },
              },
            },
          ];
    },
    async url() {
      return "https://www.jd.com/";
    },
    async goto() {},
    async reload() {},
    async waitForFunction() {},
    async waitForTimeout() {},
  };
}

test("collect-regions uses one navigation, filters fields, and marks only observed regions complete", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hezi-targeted-"));
  try {
    const page = pageMock();
    let navigations = 0;
    page.goto = async () => {
      navigations++;
    };
    const result = await collectJdRegions(
      page,
      {
        shop: "测试店",
        sourceDatabasePath: join(directory, "source.db"),
      } as any,
      {
        url: "https://item.jd.com/123.html",
        regions: ["summarySpecs", "detailSpecs", "packaging"],
        fields: ["品牌"],
      },
    );
    assert.equal(navigations, 1);
    assert.deepEqual(result.completeRegions, ["summarySpecs", "packaging"]);
    assert.deepEqual(Object.keys(result.specs).sort(), [
      "京东销售规格",
      "包装清单",
      "品牌",
      "毛重",
    ]);
    assert.equal(result.variant, "");
    assert.equal(result.selectedVariant, "红色 1件");
    assert.equal(result.specs["京东销售规格"].value, result.selectedVariant);
    const fullExisting = {
      variant: "",
      specs: { 京东销售规格: { value: "红色 1件" } },
    };
    assert.equal(result.variant, fullExisting.variant);
    assert.equal(
      result.specs["京东销售规格"].value,
      fullExisting.specs["京东销售规格"].value,
    );
    assert.equal(page.evaluated.includes("readJd"), false);
    assert.equal(page.evaluated.includes("openJdPriceDetails"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("region aliases do not leak facts belonging to an unrequested region", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hezi-targeted-"));
  try {
    const result = await collectJdRegions(
      pageMock(),
      {
        shop: "测试店",
        sourceDatabasePath: join(directory, "source.db"),
      } as any,
      {
        url: "https://item.jd.com/123.html",
        regions: ["summarySpecs"],
        fields: [],
      },
    );
    assert.equal(result.variant, "");
    assert.equal(result.specs["包装清单"], undefined);
    assert.equal(result.specs["毛重"].value, "0.5kg");
    assert.equal(result.specs["京东销售规格"].value, "红色 1件");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("collect-regions rejects a business response for another selected variant", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hezi-targeted-"));
  try {
    await assert.rejects(
      collectJdRegions(
        pageMock("蓝色 1件"),
        {
          shop: "测试店",
          sourceDatabasePath: join(directory, "source.db"),
        } as any,
        {
          url: "https://item.jd.com/123.html",
          regions: ["summarySpecs"],
          fields: [],
        },
      ),
      /所选规格与业务响应不符/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("collect-regions rejects a business response for another SKU", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hezi-targeted-"));
  try {
    const page = pageMock();
    let reads = 0;
    page.events = async () => {
      reads++;
      if (reads === 1) return [];
      const requestId = reads === 2 ? "wrong-456" : "wrong-789";
      return [
        {
          method: "Network.responseReceived",
          params: {
            type: "XHR",
            requestId,
            response: { url: "https://x/pc_detailpage_wareBusiness" },
          },
        },
      ];
    };
    page.cdp = async (method: string, args?: any) =>
      method === "Network.getResponseBody"
        ? {
            body: JSON.stringify({
              wareInfoReadMap: {
                product_id: args.requestId === "wrong-456" ? "456" : "789",
              },
            }),
          }
        : {};
    await assert.rejects(
      collectJdRegions(
        page,
        {
          shop: "测试店",
          sourceDatabasePath: join(directory, "source.db"),
        } as any,
        {
          url: "https://item.jd.com/123.html",
          regions: ["summarySpecs"],
          fields: [],
        },
      ),
      (error: any) => {
        assert.match(error.message, /业务响应SKU与请求不符/);
        assert.equal(error.details.expectedSku, "123");
        assert.deepEqual(error.details.observedSkus, ["456", "789"]);
        assert.equal(
          JSON.stringify(error.details).includes("wareInfoReadMap"),
          false,
        );
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("collect-regions selects the newest exact-SKU business response among unrelated responses", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hezi-targeted-"));
  try {
    const page = pageMock();
    let reads = 0;
    page.events = async () => {
      reads++;
      return reads === 1
        ? []
        : reads === 2
          ? [
              {
                method: "Network.responseReceived",
                params: {
                  type: "XHR",
                  requestId: "unrelated",
                  response: { url: "https://x/pc_detailpage_wareBusiness" },
                },
              },
            ]
          : [
              {
                method: "Network.responseReceived",
                params: {
                  type: "XHR",
                  requestId: "expected",
                  response: { url: "https://x/pc_detailpage_wareBusiness" },
                },
              },
            ];
    };
    page.cdp = async (method: string, args?: any) => {
      if (method === "Network.getResponseBody")
        return {
          body: JSON.stringify({
            wareInfoReadMap: {
              product_id: args.requestId === "expected" ? "123" : "456",
              color: "红色 1件",
              weight: "0.5",
            },
          }),
        };
      return {};
    };
    const result = await collectJdRegions(
      page,
      {
        shop: "测试店",
        sourceDatabasePath: join(directory, "source.db"),
      } as any,
      {
        url: "https://item.jd.com/123.html",
        regions: ["summarySpecs"],
        fields: [],
      },
    );
    assert.equal(result.specs["毛重"].value, "0.5kg");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
