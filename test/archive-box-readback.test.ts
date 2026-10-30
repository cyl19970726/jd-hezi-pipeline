import test from "node:test";
import assert from "node:assert/strict";
import { MemoryAdapter, example } from "../src/demo.js";
import { verify } from "../src/model.js";

test("archive-box readback accepts only observed MM and PP casing", async () => {
  const { product, plan } = example();
  plan.catalogBinding = { brandId: "fixture-brand", categoryId: "10048009" };
  plan.specs["尺寸规格"] = { ...plan.specs["规格"], value: "35mm" };
  plan.specs["材质"] = { ...plan.specs["规格"], value: "pp" };
  const adapter = new MemoryAdapter();
  const record = await adapter.save(product, plan, null);
  const snapshot = await adapter.read(record.itemId);
  const errors = () => verify(snapshot, product, plan, record.mediaReferences);

  snapshot.specs["尺寸规格"] = "35MM";
  snapshot.specs["材质"] = "PP";
  assert.deepEqual(
    errors().filter((error) => /规格 (尺寸规格|材质)/.test(error)),
    [],
  );

  for (const [field, value] of [
    ["尺寸规格", "36MM"],
    ["尺寸规格", "35cm"],
    ["材质", "PPS"],
    ["材质", "PE"],
  ]) {
    snapshot.specs["尺寸规格"] = "35MM";
    snapshot.specs["材质"] = "PP";
    snapshot.specs[field] = value;
    assert.equal(
      errors().filter((error) => error.includes(`规格 ${field}`)).length,
      1,
      `${field}=${value}`,
    );
  }

  snapshot.specs["尺寸规格"] = "35MM";
  snapshot.specs["材质"] = "PP";
  plan.catalogBinding.categoryId = "other-category";
  assert.equal(
    errors().filter((error) => /规格 (尺寸规格|材质)/.test(error)).length,
    2,
  );
});
