import { PipelineError } from "./model.js";
export type AndroidCommandRunner = (args: string[]) => Promise<string>;
let dumpSequence = 0;
const jar = "/data/local/tmp/hezi-fast-hierarchy-dump.jar";
const diagnosticLimit = 4096;

function safeDiagnostic(output: string) {
  const clean = output
    .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();
  if (clean.length <= diagnosticLimit) return clean;
  const half = Math.floor((diagnosticLimit - 32) / 2);
  return (
    clean.slice(0, half) + "\n…[诊断文本已安全截断]…\n" + clean.slice(-half)
  );
}

class DumpOutputFailure extends Error {
  constructor(
    readonly diagnostic: string,
    readonly transientNullRoot: boolean,
  ) {
    super(diagnostic);
  }
}

const isTransientNullRoot = (output: string) =>
  /\b(?:root(?:\s+node)?\s+(?:is\s+)?null|null\s+root(?:\s+node)?)\b/i.test(
    output,
  );

/** Each read owns a fresh path. A failed dump never falls back to old evidence. */
export async function readFreshAndroidXml(
  run: AndroidCommandRunner,
  mode: "auto" | "standard" = "auto",
): Promise<string> {
  const fast =
    mode === "auto" &&
    (
      await run(["shell", `if [ -f ${jar} ]; then echo HEZI_FAST_PRESENT; fi`])
    ).trim() === "HEZI_FAST_PRESENT";
  const attempt = async () => {
    const name = `hezi-window-${process.pid}-${Date.now()}-${++dumpSequence}.xml`;
    const remote = fast
      ? `/data/local/tmp/local/tmp/${name}`
      : `/sdcard/${name}`;
    try {
      const output = fast
        ? await run([
            "shell",
            "uiautomator",
            "runtest",
            jar,
            "/system/framework/android.test.base.jar",
            "/system/framework/android.test.runner.jar",
            "-c",
            "com.hezi.tools.FastHierarchyDump#testDump",
            "-e",
            "output",
            name,
          ])
        : await run(["shell", "uiautomator", "dump", remote]);
      const success = fast
        ? output.includes(`HEZI_UI_DUMP:${remote}`)
        : output.includes(`dumped to: ${remote}`);
      if (!success || /shortMsg=|FAILURES!!!|Test run aborted/.test(output))
        throw new DumpOutputFailure(
          safeDiagnostic(output),
          fast && !success && isTransientNullRoot(output),
        );
      const xml = await run(["shell", "cat", remote]);
      if (!/<hierarchy\b/.test(xml) || !/<\/hierarchy>\s*$/.test(xml))
        throw new PipelineError(
          "NEEDS_INPUT",
          "手机界面结构读取失败，新页面证据不完整",
        );
      return xml;
    } finally {
      await run(["shell", "rm", "-f", remote]).catch(() => {});
    }
  };
  try {
    return await attempt();
  } catch (first) {
    if (!(first instanceof DumpOutputFailure)) throw first;
    if (!first.transientNullRoot)
      throw new PipelineError(
        "NEEDS_INPUT",
        "手机界面结构读取失败，未生成新的页面证据" +
          (first.diagnostic ? "：" + first.diagnostic : ""),
      );
    try {
      return await attempt();
    } catch (second) {
      if (!(second instanceof DumpOutputFailure)) throw second;
      throw new PipelineError(
        "NEEDS_INPUT",
        "手机界面结构读取失败；明确空根节点后已重读一次，仍未生成新的页面证据" +
          "\n首次：\n" +
          (first.diagnostic || "（无输出）") +
          "\n重读：\n" +
          (second.diagnostic || "（无输出）"),
      );
    }
  }
}
