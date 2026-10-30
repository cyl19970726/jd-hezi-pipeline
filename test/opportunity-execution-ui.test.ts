import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("opportunity execution UI explains source reuse and blocker codes", async () => {
  const script = await readFile(
    new URL("../web/opportunity-execution.js", import.meta.url),
    "utf8",
  );
  assert.match(script, /full: "完整采集"/);
  assert.match(script, /price: "仅补价格"/);
  assert.match(script, /cache: "本地复用"/);
  assert.match(script, /`资料读取：\$\{reuseLabel\}`/);
  assert.match(script, /SOURCE_MATCH: "尚未确认精确京东来源"/);
  assert.match(script, /STALE_EVIDENCE: "证据已过期，需要刷新"/);
});
