import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("Chinese product fingerprints match across service and Ego process locales", () => {
  const source = `import { digest } from ${JSON.stringify(new URL("../src/model.ts", import.meta.url).href)};console.log(digest({"京东质保":"无","包装名称":"10g盒装","品牌":"示例甲品牌","规格":"1盒"}));`;
  const hashes = ["en_US.UTF-8", "zh_CN.UTF-8"].map((locale) => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", source],
      {
        env: { ...process.env, LANG: locale, LC_ALL: locale },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  });
  assert.equal(hashes[0], hashes[1]);
});
