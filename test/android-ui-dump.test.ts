import test from "node:test";
import assert from "node:assert/strict";
import {
  readFreshAndroidXml,
  type AndroidCommandRunner,
} from "../src/android-ui-dump.js";

test("fresh UI dump reads the unique file named by the successful command", async () => {
  const calls: string[][] = [];
  const xml =
    '<?xml version="1.0"?><hierarchy><node text="新页面" /></hierarchy>';
  const run: AndroidCommandRunner = async (args) => {
    calls.push(args);
    const remote = calls[0].at(-1)!;
    if (args[1] === "uiautomator") return `UI hierchary dumped to: ${remote}\n`;
    if (args[1] === "cat") {
      assert.equal(args[2], remote);
      return xml;
    }
    assert.deepEqual(args, ["shell", "rm", "-f", remote]);
    return "";
  };
  assert.equal(await readFreshAndroidXml(run, "standard"), xml);
  assert.equal(calls.length, 3);
  assert.match(calls[0].at(-1)!, /^\/sdcard\/hezi-window-\d+-\d+-\d+\.xml$/);
});

test("idle-state dump failure cannot fall back to a stale shared XML file", async () => {
  const calls: string[][] = [];
  const run: AndroidCommandRunner = async (args) => {
    calls.push(args);
    if (args[1] === "uiautomator") return "ERROR: could not get idle state.\n";
    if (args[1] === "cat")
      return '<hierarchy><node text="旧规格面板" /></hierarchy>';
    return "";
  };
  await assert.rejects(
    readFreshAndroidXml(run, "standard"),
    /未生成新的页面证据.*could not get idle state/,
  );
  assert.equal(
    calls.some((args) => args[1] === "cat"),
    false,
  );
  assert.equal(calls.at(-1)?.[1], "rm");
});

test("a success receipt with incomplete XML fails closed and cleans up", async () => {
  const calls: string[][] = [];
  const run: AndroidCommandRunner = async (args) => {
    calls.push(args);
    const remote = calls[0].at(-1)!;
    if (args[1] === "uiautomator") return `UI hierarchy dumped to: ${remote}`;
    if (args[1] === "cat") return "<hierarchy>";
    return "";
  };
  await assert.rejects(
    readFreshAndroidXml(run, "standard"),
    /新页面证据不完整/,
  );
  assert.equal(calls.at(-1)?.[1], "rm");
});

test("installed fast helper must return its unique output receipt; failure never uses standard dump", async () => {
  const calls: string[][] = [];
  let fail = false;
  const run: AndroidCommandRunner = async (args) => {
    calls.push(args);
    if (args[1].startsWith("if [")) return "HEZI_FAST_PRESENT";
    if (args[1] === "uiautomator") {
      assert.equal(args[2], "runtest");
      return fail
        ? "OK (1 test)\nINSTRUMENTATION_STATUS: shortMsg=error"
        : `HEZI_UI_DUMP:/data/local/tmp/local/tmp/${args.at(-1)}`;
    }
    if (args[1] === "cat")
      return '<hierarchy><node text="实时页面"/></hierarchy>';
    return "";
  };
  assert.match(await readFreshAndroidXml(run), /实时页面/);
  fail = true;
  calls.length = 0;
  await assert.rejects(readFreshAndroidXml(run), /未生成新的页面证据/);
  assert.equal(
    calls.some((x) => x[1] === "cat" || x[2] === "dump"),
    false,
  );
});

test("a device without the helper uses a new standard dump path", async () => {
  const calls: string[][] = [];
  const run: AndroidCommandRunner = async (args) => {
    calls.push(args);
    if (args[1].startsWith("if [")) return "";
    if (args[1] === "uiautomator") {
      assert.equal(args[2], "dump");
      return `UI hierarchy dumped to: ${args[3]}`;
    }
    if (args[1] === "cat")
      return '<hierarchy><node text="新页面"/></hierarchy>';
    return "";
  };
  assert.match(await readFreshAndroidXml(run), /新页面/);
  assert.equal(calls.filter((x) => x[1] === "uiautomator").length, 1);
});

test("fast failure preserves multiline diagnostics beyond a deprecated warning", async () => {
  let dumps = 0;
  const run: AndroidCommandRunner = async (args) => {
    if (args[1].startsWith("if [")) return "HEZI_FAST_PRESENT";
    if (args[1] === "uiautomator") {
      dumps++;
      return "WARNING: uiautomator is deprecated\nINSTRUMENTATION_STATUS: shortMsg=real failure\njava.lang.IllegalStateException: detail";
    }
    return "";
  };
  await assert.rejects(
    readFreshAndroidXml(run),
    (error: Error) =>
      error.message.includes("deprecated") &&
      error.message.includes("shortMsg=real failure") &&
      error.message.includes("IllegalStateException: detail"),
  );
  assert.equal(dumps, 1);
});

test("oversized diagnostics retain their beginning and root-cause tail within a bound", async () => {
  const run: AndroidCommandRunner = async (args) => {
    if (args[1].startsWith("if [")) return "HEZI_FAST_PRESENT";
    if (args[1] === "uiautomator")
      return "diagnostic-start\n" + "x".repeat(8000) + "\nroot-cause-tail";
    return "";
  };
  await assert.rejects(readFreshAndroidXml(run), (error: Error) => {
    assert.match(error.message, /diagnostic-start/);
    assert.match(error.message, /诊断文本已安全截断/);
    assert.match(error.message, /root-cause-tail/);
    assert.ok(error.message.length < 4300);
    return true;
  });
});

test("an explicit fast null-root failure rereads once with a fresh path", async () => {
  const names: string[] = [];
  let dumps = 0;
  const run: AndroidCommandRunner = async (args) => {
    if (args[1].startsWith("if [")) return "HEZI_FAST_PRESENT";
    if (args[1] === "uiautomator") {
      names.push(args.at(-1)!);
      dumps++;
      return dumps === 1
        ? "WARNING: deprecated\njava.lang.IllegalStateException: root node is null"
        : `HEZI_UI_DUMP:/data/local/tmp/local/tmp/${args.at(-1)}`;
    }
    if (args[1] === "cat")
      return '<hierarchy><node text="重读的新页面"/></hierarchy>';
    return "";
  };
  assert.match(await readFreshAndroidXml(run), /重读的新页面/);
  assert.equal(dumps, 2);
  assert.equal(new Set(names).size, 2);
});

test("a second null-root failure reports both attempts and never retries again", async () => {
  let dumps = 0;
  const run: AndroidCommandRunner = async (args) => {
    if (args[1].startsWith("if [")) return "HEZI_FAST_PRESENT";
    if (args[1] === "uiautomator") {
      dumps++;
      return `attempt-${dumps}: null root node`;
    }
    return "";
  };
  await assert.rejects(
    readFreshAndroidXml(run),
    (error: Error) =>
      error.message.includes("attempt-1") &&
      error.message.includes("attempt-2"),
  );
  assert.equal(dumps, 2);
});

test("standard dump does not retry even when its output mentions a null root", async () => {
  let dumps = 0;
  const run: AndroidCommandRunner = async (args) => {
    if (args[1] === "uiautomator") {
      dumps++;
      return "ERROR: root node is null";
    }
    return "";
  };
  await assert.rejects(
    readFreshAndroidXml(run, "standard"),
    /root node is null/,
  );
  assert.equal(dumps, 1);
});

test("contradictory success receipt and null-root failure cannot trigger reread", async () => {
  let dumps = 0;
  await assert.rejects(
    readFreshAndroidXml(async (args) => {
      if (args[1].startsWith("if [")) return "HEZI_FAST_PRESENT";
      if (args[1] === "uiautomator") {
        dumps++;
        return `HEZI_UI_DUMP:/data/local/tmp/local/tmp/${args.at(-1)}\nFAILURES!!! root node is null`;
      }
      if (args[1] === "cat") throw Error("must not read contradictory output");
      return "";
    }),
    /未生成新的页面证据/,
  );
  assert.equal(dumps, 1);
});
