import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  PipelineError,
  expectedFields,
  type Adapter,
  type Plan,
  type Product,
  type RemoteRecord,
  type RemoteSnapshot,
  type MediaReferences,
} from "../model.js";
import type { BrowserConfig } from "./runtime.js";

import { SourceIndex } from "../source-index.js";
const marker = "HEZI_RESULT:";
export class EgoBridge {
  constructor(
    readonly executable = "ego-browser",
    readonly timeout = 180000,
  ) {}
  async call(action: string, args: unknown): Promise<any> {
    const runtime = pathToFileURL(
      fileURLToPath(new URL("./runtime.js", import.meta.url)),
    ).href;
    const source = `import {run} from ${JSON.stringify(runtime)};\ntry {const result=await run({taskSpace,profiles,takeOverTaskSpace},${JSON.stringify(action)},${JSON.stringify(args)}); console.log(${JSON.stringify(marker)}+JSON.stringify({ok:true,result}));} catch(e){console.log(${JSON.stringify(marker)}+JSON.stringify({ok:false,error:{code:e.code||'UI_CHANGED',message:e.message,details:e.details}}));}\n`;
    return await new Promise((resolve, reject) => {
      const child = spawn(this.executable, ["nodejs"], {
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      });
      let out = "",
        err = "",
        ended = false;
      const timer = setTimeout(() => {
        ended = true;
        child.kill("SIGTERM");
        reject(
          new PipelineError(
            "UNKNOWN_OUTCOME",
            "Ego 调用超时；页面操作可能已经生效，请对账后恢复",
          ),
        );
      }, this.timeout);
      child.stdout.on("data", (chunk) => {
        out += chunk.toString();
        if (out.length > 2_000_000) {
          child.kill("SIGTERM");
        }
      });
      child.stderr.on("data", (chunk) => {
        err += chunk.toString();
        if (err.length > 2_000_000) child.kill("SIGTERM");
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        if (!ended) {
          ended = true;
          reject(e);
        }
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (ended) return;
        ended = true;
        const line = (out + "\n" + err)
          .split("\n")
          .findLast((l) => l.startsWith(marker));
        if (
          !line &&
          /user now controls|user has taken control|permission prompt|user control|space is inactive/i.test(
            out + " " + err,
          )
        )
          return reject(
            new PipelineError(
              "CONTROL_REQUIRED",
              "浏览器已交还用户；处理提示并确认后运行 take-over",
            ),
          );
        if (!line)
          return reject(
            new PipelineError(
              "UI_CHANGED",
              `Ego 没有返回结构化回执 (exit ${code})`,
            ),
          );
        try {
          const data = JSON.parse(line.slice(marker.length));
          if (!data.ok)
            return reject(
              new PipelineError(
                data.error.code,
                data.error.message,
                data.error.details,
              ),
            );
          resolve(data.result);
        } catch (e) {
          reject(e);
        }
      });
      child.stdin.end(source);
    });
  }
}
export class EgoAdapter implements Adapter {
  constructor(
    readonly bridge: EgoBridge,
    readonly config: BrowserConfig,
    readonly write = false,
    readonly inventoryReconciled = false,
    readonly sourceIndex?: SourceIndex,
  ) {}
  checkShop(shop: string) {
    return this.bridge.call("checkShop", { config: this.config, shop });
  }
  find(product: Product, plan: Plan) {
    if (this.sourceIndex)
      return Promise.resolve({
        complete: true,
        records: this.sourceIndex.lookup(this.config.shop, product.sku),
      });
    return this.bridge.call("find", {
      config: this.config,
      sku: product.sku,
      title: expectedFields(product, plan).title,
      inventoryReconciled: this.inventoryReconciled,
    });
  }
  save(
    product: Product,
    plan: Plan,
    itemId: string | null,
    mediaReferences?: MediaReferences | null,
  ): Promise<RemoteRecord> {
    return this.bridge.call("save", {
      config: this.config,
      product,
      plan,
      itemId,
      mediaReferences,
      write: this.write,
      expected: expectedFields(product, plan),
    });
  }
  read(itemId: string): Promise<RemoteSnapshot> {
    return this.bridge.call("read", { config: this.config, itemId });
  }
  submit(itemId: string): Promise<RemoteRecord> {
    return this.bridge.call("submit", {
      config: this.config,
      itemId,
      write: this.write,
    });
  }
  withdraw(itemId: string): Promise<RemoteRecord> {
    return this.bridge.call("withdraw", {
      config: this.config,
      itemId,
      write: this.write,
    });
  }
}
