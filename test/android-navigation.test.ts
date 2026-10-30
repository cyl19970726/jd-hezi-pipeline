import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { example } from "../src/demo.js";
import {
  navigateKnownVariant,
  stableVariantOption,
} from "../src/android-navigation.js";
test("observed SKU panel closes with its unique labelled control rather than ineffective back", async () => {
  const s = new Store(":memory:");
  try {
    const { product } = example();
    product.specs["京东销售规格"] = { ...product.title, value: "500mL 1瓶" };
    s.put("ours", product);
    const xml = `<node text="编号: ${product.sku}"/><node content-desc="关闭按钮" clickable="true" bounds="[936,428][1032,524]"/>`;
    let clicks = 0;
    const session = {
      tap: async (n: any) => {
        assert.equal(n["content-desc"], "关闭按钮");
        clicks++;
      },
      run: async () => {
        throw Error("must not send back");
      },
      wait: async (_name: string, predicate: (x: string) => boolean) => {
        const closed = '<node content-desc="已选中款式 500mL 1瓶"/>';
        assert.ok(predicate(closed));
        return closed;
      },
    };
    assert.equal(
      await navigateKnownVariant(s, "ours", product.sku, session as any, xml),
      true,
    );
    assert.equal(clicks, 1);
    await assert.rejects(
      navigateKnownVariant(
        s,
        "ours",
        product.sku,
        session as any,
        xml + '<node content-desc="关闭按钮" clickable="true"/>',
      ),
      /不唯一/,
    );
  } finally {
    s.close();
  }
});

const optionPanel = (
  sku: string,
  selected: string,
  targetBounds = "[168,1307][683,1404]",
) => `<hierarchy>
  <node text="编号: ${sku}" />
  <node text="规格(2)" />
  <node text="${selected}" selected="true" class="android.widget.TextView" resource-id="com.jingdong.app.mall:id/a3s" bounds="[168,1433][683,1530]" />
  <node text="500mL 2瓶 薄荷杀虫剂" selected="false" class="android.widget.TextView" resource-id="com.jingdong.app.mall:id/a3s" bounds="${targetBounds}" />
</hierarchy>`;

test("variant option must keep SKU, selected caption and target bounds across two dumps", () => {
  const first = optionPanel("5773954", "500mL 1瓶 水基无香杀虫剂");
  assert.equal(
    stableVariantOption(first, first, "500mL 2瓶 薄荷杀虫剂").bounds,
    "[168,1307][683,1404]",
  );
  assert.throws(
    () =>
      stableVariantOption(
        first,
        optionPanel("900000000006", "36mL 1瓶 【便携装】定量灭蚊"),
        "500mL 2瓶 薄荷杀虫剂",
      ),
    /仍在变化/,
  );
  assert.throws(
    () =>
      stableVariantOption(
        first,
        optionPanel(
          "5773954",
          "500mL 1瓶 水基无香杀虫剂",
          "[168,1500][683,1597]",
        ),
        "500mL 2瓶 薄荷杀虫剂",
      ),
    /仍在变化/,
  );
  const otherFamily = optionPanel(
    "900000000007",
    "36mL 1瓶 【便携装】定量灭蚊",
  ).replace("500mL 2瓶 薄荷杀虫剂", "36mL 2瓶 无香型");
  assert.equal(
    stableVariantOption(otherFamily, otherFamily, "户外露营盘香 40单盘"),
    null,
  );
  assert.throws(
    () =>
      stableVariantOption(
        otherFamily,
        otherFamily.replace("36mL 2瓶 无香型", "户外露营盘香 40单盘"),
        "户外露营盘香 40单盘",
      ),
    /仍在变化/,
  );
});

test("a stable panel without the target variant closes and allows URL fallback", async () => {
  const store = new Store(":memory:");
  const { product } = example();
  product.specs["京东销售规格"] = {
    ...product.title,
    value: "户外露营盘香 40单盘",
  };
  store.put("ours", product);
  const current = optionPanel(
    "900000000007",
    "36mL 1瓶 【便携装】定量灭蚊",
  ).replace("500mL 2瓶 薄荷杀虫剂", "36mL 2瓶 无香型");
  let backs = 0;
  let dumps = 0;
  const session = {
    dump: async (name: string) => {
      dumps++;
      assert.ok(["variant-options-stable", "variant-cancelled"].includes(name));
      return current;
    },
    run: async (args: string[]) => {
      assert.deepEqual(args, ["shell", "input", "keyevent", "4"]);
      backs++;
    },
  };
  try {
    assert.equal(
      await navigateKnownVariant(
        store,
        "ours",
        product.sku,
        session as any,
        current,
      ),
      false,
    );
    assert.equal(backs, 1);
    assert.equal(dumps, 2);
  } finally {
    store.close();
  }
});

test("an already proven target panel does not require a stored product to avoid navigation", async () => {
  const store = new Store(":memory:");
  let proof: unknown;
  const xml =
    optionPanel("5773954", "500mL 1瓶 水基无香杀虫剂") +
    '<node content-desc="关闭按钮" clickable="true" bounds="[936,428][1032,524]"/>';
  const session = {
    tap: async () => {},
    run: async () => {
      throw Error("must not navigate or send back");
    },
    wait: async (_name: string, predicate: (value: string) => boolean) => {
      const closed = '<node content-desc="已选中款式 500mL 1瓶 水基无香杀虫"/>';
      assert.ok(predicate(closed));
      return closed;
    },
  };
  try {
    assert.equal(
      await navigateKnownVariant(
        store,
        "ours",
        "5773954",
        session as any,
        xml,
        (value) => {
          proof = value;
        },
      ),
      true,
    );
    assert.deepEqual(proof, {
      sku: "5773954",
      caption: "500mL 1瓶 水基无香杀虫剂",
    });
  } finally {
    store.close();
  }
});
