import type { State } from "./model.js";

const states = {
  rejected: new Set(["审核不通过", "已驳回"]),
  submitted: new Set(["待审核", "审核中"]),
  approved: new Set(["审核通过"]),
  onSale: new Set(["已上架", "上架", "在售"]),
};

/** Map only statuses whose meaning is explicit. Unknown text must remain unknown. */
export function remoteProductState(status: string): State | null {
  const value = status.trim();
  if (states.rejected.has(value)) return "REJECTED";
  if (states.submitted.has(value)) return "SUBMITTED";
  if (states.approved.has(value)) return "APPROVED";
  if (states.onSale.has(value)) return "ON_SALE";
  return null;
}

export function rejectionDetail(remote: {
  itemId: string;
  status: string;
  platformWarning?: string | null;
}) {
  return {
    code: "BUSINESS_BLOCKED",
    message: remote.platformWarning?.trim() || `远端商品${remote.status}`,
    details: {
      itemId: remote.itemId,
      status: remote.status,
      ...(remote.platformWarning?.trim()
        ? { platformWarning: remote.platformWarning.trim() }
        : {}),
    },
  };
}
