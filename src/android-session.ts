import {
  readFile,
  writeFile,
  mkdir,
  rename,
  appendFile,
} from "node:fs/promises";
import { resolve, basename } from "node:path";
import { createHash } from "node:crypto";
import { adb, androidNodes, checkAndroid } from "./android.js";
import { bounds } from "./android-structure.js";
import { importOriginalAsset } from "./assets.js";
import { PipelineError, type Product } from "./model.js";
import { readFreshAndroidXml } from "./android-ui-dump.js";
export class AndroidSession {
  constructor(
    readonly serial: string,
    readonly dir: string,
    readonly guard: () => void = () => {},
  ) {}
  async run(args: string[]) {
    this.guard();
    const start = Date.now();
    try {
      return await adb(["-s", this.serial, ...args]);
    } finally {
      await appendFile(
        resolve(this.dir, "timings.jsonl"),
        JSON.stringify({
          at: new Date(start).toISOString(),
          command: args.slice(0, args[0] === "shell" ? 3 : 1).join(" "),
          durationMs: Date.now() - start,
        }) + "\n",
        { mode: 0o600 },
      );
    }
  }

  async dump(name: string) {
    const xml = await readFreshAndroidXml((args) => this.run(args));
    // Keep the exact fresh observation even when it reveals a risk/login gate.
    await writeFile(resolve(this.dir, name + ".xml"), xml, { mode: 0o600 });
    checkAndroid(xml);
    return xml;
  }
  async wait(
    name: string,
    predicate: (xml: string) => boolean,
    options: { timeoutMs?: number; maxObservations?: number } = {},
  ) {
    const timeoutMs = options.timeoutMs ?? 5000;
    const maxObservations = options.maxObservations ?? 10;
    const deadline = Date.now() + timeoutMs;
    for (let i = 0; i < maxObservations; i++) {
      const xml = await this.dump(name);
      if (predicate(xml)) return xml;
      if (Date.now() >= deadline) break;
    }
    throw new PipelineError("NEEDS_INPUT", "手机页面未就绪：" + name);
  }
  async tap(node: Record<string, unknown> | undefined) {
    const b = node && bounds(node);
    if (!b) throw new PipelineError("NEEDS_INPUT", "手机控件位置不可用");
    await this.run([
      "shell",
      "input",
      "tap",
      String(Math.round((b.x + b.right) / 2)),
      String(Math.round((b.y + b.bottom) / 2)),
    ]);
  }
  async screenshot(name: string) {
    await this.run(["shell", "screencap", "-p", "/sdcard/hezi-screen.png"]);
    const path = resolve(this.dir, name + ".png");
    await this.run(["pull", "/sdcard/hezi-screen.png", path]);
    return path;
  }
  async album() {
    // Only this app's export directory, not the user's camera or other photo albums.
    await this.run(["shell", "mkdir", "-p", "/sdcard/Pictures/JDImage"]);
    const raw = await this.run([
      "shell",
      'for f in /sdcard/Pictures/JDImage/*.jpg; do [ -f "$f" ] && stat -c \'%n|%Y|%s\' "$f"; done; true',
    ]);
    return parseAlbumEntries(raw);
  }
  async saveViewer(
    sku: string,
    role: "main" | "detail",
    order: number,
    root: string,
  ) {
    const before = await this.album();
    await this.run([
      "shell",
      "input",
      "swipe",
      "400",
      "1100",
      "400",
      "1100",
      "950",
    ]);
    const menu = await this.wait("save-menu", (xml) =>
      androidNodes(xml).some((n) => n.text === "图片保存到相册"),
    );
    await this.tap(androidNodes(menu).find((n) => n.text === "图片保存到相册"));
    let changed: string[] = [];
    for (let i = 0; i < 3; i++) {
      await this.dump("saved-viewer");
      changed = [...(await this.album())]
        .filter(([p, v]) => before.get(p) !== v)
        .map(([p]) => p);
      if (changed.length) break;
    }
    if (changed.length !== 1)
      throw new PipelineError(
        "NEEDS_INPUT",
        "本次图片保存未能唯一对应原文件；保留断点",
      );
    const path = resolve(this.dir, basename(changed[0]));
    await this.run(["pull", changed[0], path]);
    const bytes = await readFile(path),
      hash = createHash("sha256").update(bytes).digest("hex");
    return importOriginalAsset(
      sku,
      {
        role,
        order,
        origin: "android-album",
        url: `https://item.jd.com/${sku}.html#android-${role}-${order}-${hash}`,
      },
      bytes,
      resolve(root, "assets"),
    );
  }
}
export async function atomicReceipt(path: string, value: unknown) {
  await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
  await writeFile(path + ".tmp", JSON.stringify(value, null, 2), {
    mode: 0o600,
  });
  await rename(path + ".tmp", path);
}

export function parseAlbumEntries(raw: string) {
  return new Map(
    raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [path, time, size] = line.split("|");
        if (
          !/^\/sdcard\/Pictures\/JDImage\/[a-zA-Z0-9_-]+(?: \(\d+\))?\.jpg$/.test(
            path,
          ) ||
          !/^\d+$/.test(time) ||
          !/^\d+$/.test(size)
        )
          throw new PipelineError("NEEDS_INPUT", "手机相册文件记录格式异常");
        return [path, time + "|" + size];
      }),
  );
}
