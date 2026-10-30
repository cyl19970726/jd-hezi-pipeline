import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { applyLogistics } from "../src/browser/logistics.js";
function fixture(templateId = 1407) {
  const { document } = parseHTML('<div id="app"></div>');
  Object.assign(globalThis, { document });
  const data = { areaList: [], templateId, addressIdList: [253] };
  (document.querySelector("#app") as any).__vue_app__ = {
    _container: {
      _vnode: {
        component: {
          type: { __name: "Logistics" },
          subTree: { component: { props: { data } } },
        },
      },
    },
  };
  return data;
}
test("logistics uses existing template/address identities and updates reactive area model", async () => {
  const data = fixture();
  const r = await applyLogistics({
    templateId: "1407",
    addressIds: ["253"],
    areas: [{ areaId: "4400", areaName: "示例城市" }],
  });
  assert.equal(r.areas, 1);
  assert.deepEqual(data.areaList, [{ value: "4400", label: "示例城市" }]);
});
test("mismatched freight template or address blocks before area mutation", async () => {
  const data = fixture(9);
  await assert.rejects(
    applyLogistics({
      templateId: "1407",
      addressIds: ["253"],
      areas: [{ areaId: "4400", areaName: "示例城市" }],
    }),
  );
  assert.equal(data.areaList.length, 0);
});
