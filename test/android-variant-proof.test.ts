import test from "node:test";
import assert from "node:assert/strict";
import { androidVariantProof } from "../src/android-variant-proof.js";

const panel = (
  sku = "5773954",
  caption = "500mL 1瓶 水基无香杀虫剂",
) => `<hierarchy>
  <node text="编号: ${sku}" selected="false" class="android.widget.TextView" resource-id="com.jingdong.app.mall:id/esy"/>
  <node text="杀虫剂喷雾" selected="true" class="android.widget.TextView" resource-id="com.jingdong.app.mall:id/dz6"/>
  <node text="规格(7)" selected="false" class="android.widget.TextView" resource-id="com.jingdong.app.mall:id/ap7"/>
  <node text="${caption}" selected="true" class="android.widget.TextView" resource-id="com.jingdong.app.mall:id/a3s"/>
  <node text="¥19.9" selected="true" class="android.widget.TextView" resource-id="com.jingdong.app.mall:id/y9"/>
</hierarchy>`;

test("native panel binds the complete unique selected caption to the exact numeric SKU", () => {
  assert.deepEqual(androidVariantProof(panel(), "5773954"), {
    sku: "5773954",
    caption: "500mL 1瓶 水基无香杀虫剂",
  });
});

test("native panel rejects a different SKU even when its caption looks right", () => {
  assert.throws(
    () => androidVariantProof(panel("900000000005"), "5773954"),
    /SKU不符/,
  );
});

test("native panel rejects absent or ambiguous selected option evidence", () => {
  assert.throws(
    () =>
      androidVariantProof(
        panel().replace(
          ' selected="true" class="android.widget.TextView" resource-id="com.jingdong.app.mall:id/a3s"',
          ' selected="false" class="android.widget.TextView" resource-id="com.jingdong.app.mall:id/a3s"',
        ),
        "5773954",
      ),
    /不唯一/,
  );
  assert.throws(
    () =>
      androidVariantProof(
        panel().replace(
          "</hierarchy>",
          '<node text="500mL 1瓶 水基无香杀虫剂" selected="true" class="android.widget.TextView" resource-id="com.jingdong.app.mall:id/a3s"/></hierarchy>',
        ),
        "5773954",
      ),
    /不唯一/,
  );
});

test("native panel rejects multiple numeric SKU observations", () => {
  assert.throws(
    () =>
      androidVariantProof(
        panel().replace(
          "</hierarchy>",
          '<node text="编号: 5773954"/></hierarchy>',
        ),
        "5773954",
      ),
    /不唯一/,
  );
});
