import { cleanSaleLabel } from "./sale-text.js";
import { TextAgentTasks, type TextAgentInput } from "./text-agent.js";
import { type Product, PipelineError } from "./model.js";
import type { Job } from "./jobs.js";

export function titleAgentInput(
  job: Job,
  shop: string,
  product: Product,
): TextAgentInput {
  return {
    jobId: job.id,
    shop,
    sku: product.sku,
    title: product.title.value,
    selectedVariant:
      product.specs["京东销售规格"]?.sourceUrl === product.url
        ? product.specs["京东销售规格"].value
        : null,
    parameters: Object.fromEntries(
      Object.entries(product.specs)
        .filter(([, v]) => v.sourceUrl === product.url)
        .map(([k, v]) => [k, v.value]),
    ),
    packaging:
      product.specs["包装清单"]?.sourceUrl === product.url
        ? product.specs["包装清单"].value
        : null,
  };
}
export function requestTitle(
  tasks: TextAgentTasks,
  job: Job,
  shop: string,
  product: Product,
) {
  const task = tasks.enqueue(titleAgentInput(job, shop, product), {
    taskType: "normalize_title",
    version: "title-v1",
    model: "gpt-5.6-luna",
  });
  if (["failed", "stale"].includes(task.status))
    throw new PipelineError("NEEDS_INPUT", "Luna标题任务未完成：" + task.error);
  if (!task.result) return { task, title: null };
  const value = task.result.value.trim();
  if (value.length > 80)
    throw new PipelineError("NEEDS_INPUT", "Luna标题超过80字符");
  const compact = (s: string) =>
    s.replace(/[\s【】\[\]（）()、,，+＋×x*|｜:：-]/g, "");
  const selected = cleanSaleLabel(product.specs["京东销售规格"]?.value ?? "");
  if (selected && !compact(value).includes(compact(selected)))
    throw new PipelineError("NEEDS_INPUT", "Luna标题未完整保留所选销售规格");
  const supported = new Set(
    task.result.sources.flatMap((s) => [...compact(s.quote)]),
  );
  if ([...compact(value)].some((c) => !supported.has(c)))
    throw new PipelineError("NEEDS_INPUT", "Luna标题增加了无来源文字");
  return {
    task,
    title: {
      ...product.title,
      value,
      evidence:
        "Luna标题整理 " + task.id + "；" + JSON.stringify(task.result.sources),
    },
  };
}
