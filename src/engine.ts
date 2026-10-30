import { listingPrice } from "./listing-price.js";
import { assertHzRunning } from "./platform-availability.js";
import { PricingStore } from "./pricing-store.js";
import { Store } from "./store.js";
import { observePlatformWarning } from "./platform-warning.js";
import { rejectionDetail, remoteProductState } from "./remote-status.js";
import {
  classify,
  PipelineError,
  validate,
  verify,
  type Adapter,
  type Row,
  type RemoteSnapshot,
} from "./model.js";

export class Engine {
  constructor(
    readonly store: Store,
    readonly adapter: Adapter,
  ) {}
  async withdraw(id: string): Promise<Row> {
    const unlock = this.store.lock("publisher");
    try {
      const row = this.store.get(id);
      assertHzRunning(this.store, row.shop);
      if (
        this.store.pending(id) ||
        this.store.replacement(id)?.status === "pending"
      )
        throw new PipelineError("UNKNOWN_OUTCOME", "先对账原操作，再撤回");
      if (!row.remoteId || !row.product || !row.plan || !this.adapter.withdraw)
        throw new PipelineError(
          "NEEDS_INPUT",
          "缺少原商品、修正计划或撤回适配器",
        );
      if (
        this.store.meta("listing-price:" + row.shop) === "jd-regular-preferred"
      )
        listingPrice(this.store, row.shop, row.product);
      const errors = validate(row.product, row.plan);
      if (errors.length)
        throw new PipelineError("VALIDATION_MISSING", "修正计划未通过", errors);
      new PricingStore(this.store).verify(row.shop, row.product, row.plan);
      await this.adapter.checkShop(row.shop);
      const current = await this.adapter.read(row.remoteId);
      this.assertIdentity(row, current);
      if (["草稿", "待提交"].includes(current.status)) {
        this.store.state(id, "DRAFT_SAVED");
        return this.store.get(id);
      }
      if (!["待审核", "审核中"].includes(current.status))
        throw new PipelineError("BUSINESS_BLOCKED", "当前状态不能撤回审核", {
          status: current.status,
        });
      assertHzRunning(this.store, row.shop);
      new PricingStore(this.store).verify(row.shop, row.product, row.plan);
      const op = this.store.intent(id, "withdraw");
      try {
        const receipt = await this.adapter.withdraw(row.remoteId);
        this.assertIdentity(row, receipt);
        if (!["草稿", "待提交"].includes(receipt.status))
          throw new PipelineError(
            "UNKNOWN_OUTCOME",
            "撤回后未观察到可编辑状态",
            receipt,
          );
        this.store.receipt(op, receipt);
        this.store.state(id, "DRAFT_SAVED");
      } catch (e) {
        this.store.state(id, "UNKNOWN_OUTCOME", this.describe(e));
        throw e;
      }
      return this.store.get(id);
    } finally {
      unlock();
    }
  }
  async run(id: string, through: "draft" | "submit" = "draft"): Promise<Row> {
    const unlock = this.store.lock("publisher");
    try {
      let row = this.store.get(id);
      assertHzRunning(this.store, row.shop);
      if (this.store.replacement(id)?.status === "pending")
        throw new PipelineError(
          "UNKNOWN_OUTCOME",
          "旧记录已隔离，先核对替代操作，禁止提交旧记录",
        );
      if (this.store.pending(id) || row.state === "UNKNOWN_OUTCOME")
        throw new PipelineError(
          "UNKNOWN_OUTCOME",
          "上次写入结果不明，请先 reconcile",
        );
      if (!row.product || !row.plan)
        throw new PipelineError("NEEDS_INPUT", "缺少商品来源或上架规则");
      if (
        row.remoteId &&
        ["SUBMITTED", "APPROVED", "ON_SALE"].includes(row.state) &&
        row.verifiedHash === row.dataHash
      ) {
        await this.adapter.checkShop(row.shop);
        const current = await this.adapter.read(row.remoteId);
        this.assertIdentity(row, current);
        const issues = verify(
          current,
          row.product,
          row.plan,
          row.mediaReferences,
        );
        if (issues.length)
          throw new PipelineError(
            "VALIDATION_MISSING",
            "已提交商品读回发生变化",
            issues,
          );
        const state = remoteProductState(current.status);
        if (state === "REJECTED") {
          observePlatformWarning(this.store, row, current);
          this.store.state(id, state, rejectionDetail(current));
          return this.store.get(id);
        }
        if (!state)
          throw new PipelineError(
            "BUSINESS_BLOCKED",
            "已提交商品远端状态无法识别，需对账处理",
            { status: current.status },
          );
        this.store.state(id, state);
        return this.store.get(id);
      }
      if (
        this.store.meta("listing-price:" + row.shop) === "jd-regular-preferred"
      )
        listingPrice(this.store, row.shop, row.product);
      const errors = validate(row.product, row.plan);
      if (errors.length)
        throw new PipelineError(
          "VALIDATION_MISSING",
          "发布前数据校验未通过",
          errors,
        );
      new PricingStore(this.store).verify(row.shop, row.product!, row.plan!);
      await this.adapter.checkShop(row.shop);
      this.store.state(id, "VALIDATED");
      if (!row.remoteId) {
        const found = await this.adapter.find(row.product, row.plan);
        if (!found.complete || found.records.length > 1)
          throw new PipelineError(
            "NEEDS_INPUT",
            "远端查重未完成或存在多份商品，拒绝新建",
            found,
          );
        if (found.records.length === 1) {
          const r = found.records[0];
          this.assertIdentity(row, r);
          this.store.bind(id, r.itemId, r.code);
          row = this.store.get(id);
        }
      }
      if (row.remoteId) {
        const current = await this.adapter.read(row.remoteId);
        this.assertIdentity(row, current);
        if (remoteProductState(current.status) === "REJECTED") {
          observePlatformWarning(this.store, row, current);
          this.store.state(id, "REJECTED", rejectionDetail(current));
          return this.store.get(id);
        }
        if (
          !["草稿", "待提交", "审核不通过", "已驳回"].includes(current.status)
        ) {
          const issues = verify(
            current,
            row.product!,
            row.plan!,
            row.mediaReferences,
          );
          const state = remoteProductState(current.status);
          if (state && state !== "REJECTED" && issues.length === 0) {
            this.store.verified(id, row.dataHash);
            this.store.state(id, state);
            return this.store.get(id);
          }
          throw new PipelineError(
            "BUSINESS_BLOCKED",
            "远端当前状态不可直接编辑；需处理原商品状态后恢复",
            { status: current.status, issues },
          );
        }
        if (
          verify(current, row.product!, row.plan!, row.mediaReferences)
            .length === 0
        ) {
          this.store.verified(id, row.dataHash);
        } else
          await this.save(
            row,
            row.plan!.replaceMedia
              ? {
                  main: current.mainImages.map((x) => x.url),
                  detail: current.detailImages.map((x) => x.url),
                }
              : undefined,
          );
      } else await this.save(row);
      row = this.store.get(id);
      if (through === "draft") return row;
      assertHzRunning(this.store, row.shop);
      new PricingStore(this.store).verify(row.shop, row.product!, row.plan!);
      await this.adapter.checkShop(row.shop);
      if (row.verifiedHash !== row.dataHash)
        throw new PipelineError(
          "VALIDATION_MISSING",
          "未通过当前版本的草稿读回校验",
        );
      const op = this.store.intent(id, "submit");
      this.store.state(id, "SUBMIT_REQUESTED");
      try {
        const receipt = await this.adapter.submit(row.remoteId!);
        this.assertIdentity(row, receipt);
        const state = remoteProductState(receipt.status);
        if (!state || state === "REJECTED")
          throw new PipelineError(
            "UNKNOWN_OUTCOME",
            "提交后未观测到审核或在售状态",
            receipt,
          );
        this.store.receipt(op, receipt);
        this.store.state(id, state);
      } catch (e) {
        this.store.state(id, "UNKNOWN_OUTCOME", this.describe(e));
        throw e;
      }
      return this.store.get(id);
    } catch (e) {
      const row = this.store.get(id);
      const err = this.describe(e);
      if (
        [
          "CONTROL_REQUIRED",
          "AUTH_REQUIRED",
          "ACCOUNT_CHANGED",
          "RATE_LIMITED",
        ].includes(err.code)
      )
        this.store.pause(
          err.code === "CONTROL_REQUIRED" ? row.shop : "hz:" + row.shop,
          err,
          `platform:${err.code}`,
        );
      if (this.store.pending(id)) this.store.state(id, "UNKNOWN_OUTCOME", err);
      else if (!["PAUSED", "LOCKED", "UNKNOWN_OUTCOME"].includes(err.code))
        this.store.state(
          id,
          err.code === "BUSINESS_BLOCKED"
            ? "BUSINESS_BLOCKED"
            : err.code === "AUTH_REQUIRED"
              ? "AUTH_REQUIRED"
              : err.code === "RATE_LIMITED"
                ? "RATE_LIMITED"
                : "NEEDS_INPUT",
          err,
        );
      throw e;
    } finally {
      unlock();
    }
  }
  private describe(e: unknown) {
    return e instanceof PipelineError
      ? { code: e.code, message: e.message, details: e.details }
      : { code: classify(String(e)), message: String(e) };
  }
  private assertIdentity(
    row: Row,
    r: { shop: string; sku: string; itemId: string },
  ) {
    if (
      r.shop !== row.shop ||
      r.sku !== row.sku ||
      (row.remoteId && row.remoteId !== r.itemId)
    )
      throw new PipelineError("UNKNOWN_OUTCOME", "远端记录不属于当前商品", r);
  }
  private async save(
    row: Row,
    replacementGuard?: { main: string[]; detail: string[] },
  ) {
    new PricingStore(this.store).verify(row.shop, row.product!, row.plan!);
    const op = this.store.intent(row.id, "save");
    const receipt = await this.adapter
      .save(
        row.product!,
        row.plan!,
        row.remoteId,
        replacementGuard ?? row.mediaReferences,
      )
      .catch((error: unknown) => {
        // Only explicit adapter failures from proven pre-dispatch phases can
        // resolve this intent. Timeouts and post-dispatch errors stay unknown.
        const detail =
          error instanceof PipelineError ? (error.details as any) : null;
        if (
          error instanceof PipelineError &&
          ((error.code === "UI_CHANGED" &&
            [
              "平台上传返回无效图片，已在保存前停止",
              "平台图片上传等待超时，已在保存前停止",
            ].includes(error.message) &&
            detail?.phase === "media-upload") ||
            (error.code === "VALIDATION_MISSING" &&
              [
                "平台标题命名方式与已核验计划不一致",
                "平台自动生成标题与已核验计划不一致",
              ].includes(error.message) &&
              detail?.phase === "title-validation")) &&
          detail.saveDispatched === false &&
          detail.sku === row.sku &&
          detail.shop === row.shop
        ) {
          this.store.tx(() => {
            const proof = {
              outcome: "not-applied",
              reason: "save-not-dispatched",
              failure: this.describe(error),
            };
            const changed = this.store.db
              .prepare(
                "UPDATE operations SET status='not_applied',receipt=? WHERE id=? AND product_id=? AND kind='save' AND status='pending' AND data_hash=?",
              )
              .run(JSON.stringify(proof), op, row.id, row.dataHash).changes;
            if (changed !== 1)
              throw new PipelineError(
                "UNKNOWN_OUTCOME",
                "保存意图发生变化，保留待核实",
              );
            this.store.event(row.id, "SAVE_NOT_DISPATCHED", { op, ...proof });
          });
        }
        throw error;
      });
    this.assertIdentity(row, receipt);
    if (receipt.mediaReferences)
      this.store.media(row.id, receipt.mediaReferences);
    this.store.bind(row.id, receipt.itemId, receipt.code);
    this.store.receipt(op, receipt);
    this.store.state(row.id, "DRAFT_SAVED");
    const snapshot = await this.adapter.read(receipt.itemId);
    this.assertIdentity(row, snapshot);
    const errors = verify(
      snapshot,
      row.product!,
      row.plan!,
      this.store.get(row.id).mediaReferences,
    );
    if (errors.length)
      throw new PipelineError("VALIDATION_MISSING", "保存后读回未通过", errors);
    this.store.verified(row.id, row.dataHash);
  }
  async reconcile(id: string): Promise<Row> {
    const unlock = this.store.lock("publisher");
    try {
      const row = this.store.get(id);
      assertHzRunning(this.store, row.shop);
      if (this.store.replacement(id)?.status === "pending")
        throw new PipelineError(
          "UNKNOWN_OUTCOME",
          "替代新建结果待核对，不能用旧记录解除写入意图",
        );
      if (!row.product || !row.plan)
        throw new PipelineError("NEEDS_INPUT", "缺少来源或规则");
      // Read-back compares the saved plan. Quote freshness gates writes, not audits.
      await this.adapter.checkShop(row.shop);
      const found = row.remoteId
        ? { complete: true, records: [await this.adapter.read(row.remoteId)] }
        : await this.adapter.find(row.product, row.plan);
      if (!found.complete || found.records.length !== 1)
        throw new PipelineError(
          "UNKNOWN_OUTCOME",
          "无法唯一确认写入结果；保留待对账，不自动重建",
          found,
        );
      const record = found.records[0];
      this.assertIdentity(row, record);
      const snap = row.remoteId
        ? (record as RemoteSnapshot)
        : await this.adapter.read(record.itemId);
      this.assertIdentity(row, snap);
      this.store.bind(id, record.itemId, record.code);
      observePlatformWarning(this.store, this.store.get(id), snap);
      const op = this.store.pending(id);
      if (op?.kind === "withdraw" && !["草稿", "待提交"].includes(snap.status))
        throw new PipelineError(
          "UNKNOWN_OUTCOME",
          "尚未观察到撤回后的草稿或待提交状态，保留原操作，禁止自动重试",
          { itemId: snap.itemId, status: snap.status },
        );
      if (op) this.store.receipt(String(op.id), snap);
      const issues = verify(snap, row.product, row.plan, row.mediaReferences);
      const remoteState = remoteProductState(snap.status);
      if (remoteState === "REJECTED")
        this.store.state(id, "REJECTED", rejectionDetail(snap));
      else if (issues.length) this.store.state(id, "NEEDS_INPUT", issues);
      else {
        this.store.verified(id, row.dataHash);
        if (remoteState) this.store.state(id, remoteState);
      }
      return this.store.get(id);
    } finally {
      unlock();
    }
  }
}
