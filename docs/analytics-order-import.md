# Analytics order import v1

This service accepts an explicit, typed JSON export. An adapter must first map a verified export into this contract. Missing data is omitted or `null`; it must not be supplied as zero.

## Order file template

```json
{
  "schemaVersion": 1,
  "source": "verified-export-name",
  "sourceShopId": "synthetic-shop",
  "sourceFileId": "orders-2026-09",
  "fileSha256": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "exportedAt": "2026-09-19T12:00:00+08:00",
  "timezone": "Asia/Shanghai",
  "currency": "CNY",
  "orders": [
    {
      "orderId": "synthetic-order-1",
      "version": 1,
      "placedAt": "2026-09-01T09:30:00+08:00",
      "paidAt": "2026-09-01T09:31:00+08:00",
      "completedAt": null,
      "cancelledAt": null,
      "status": "paid",
      "buyerAnonymousId": "synthetic-buyer",
      "merchandiseCents": 10000,
      "discountCents": 1000,
      "shippingCents": 0,
      "taxCents": 0,
      "unallocatedCents": 0,
      "paidCents": 9000,
      "lines": [
        {
          "lineId": "synthetic-line-1",
          "platform": "hezi",
          "shopId": "synthetic-shop",
          "itemId": "synthetic-item",
          "skuId": "synthetic-sku",
          "title": "Synthetic source title",
          "quantity": 1,
          "grossCents": 10000,
          "discountCents": 1000,
          "paidCents": 9000
        }
      ]
    }
  ],
  "refunds": [
    {
      "refundId": "synthetic-refund-1",
      "version": 1,
      "orderId": "synthetic-order-1",
      "lineId": "synthetic-line-1",
      "occurredAt": "2026-10-02T10:00:00+08:00",
      "status": "completed",
      "amountCents": 1000
    }
  ]
}
```

The pair `(source, sourceFileId)` identifies an import. Replaying the same payload and SHA-256 is a no-op. Reusing the identity with different content is a conflict. A higher order or refund version replaces the current projection while retaining audit history; a lower version is ignored.

All monetary values use integer minor units and must remain JavaScript safe integers. The header must satisfy:

```text
merchandise - discount + shipping + tax + unallocated = paid
```

Each line must belong to the same `sourceShopId`. Cancellations and refunds revise state; they do not delete the original records.

## Listing identity projection

Listing identities may arrive separately through `projectListings`. They require a real platform, shop, item, and SKU identity plus the first time the listing was observed on sale. A submitted or pending timestamp cannot be substituted for on-sale time.

```json
{
  "schemaVersion": 1,
  "source": "business-read-model",
  "projectionId": "synthetic-listings-1",
  "observedAt": "2026-09-19T12:00:00+08:00",
  "listings": [
    {
      "listingIdentityId": "synthetic-listing-1",
      "platform": "hezi",
      "shopId": "synthetic-shop",
      "itemId": "synthetic-item",
      "skuId": "synthetic-sku",
      "validFrom": "2026-08-01T00:00:00+08:00",
      "validTo": null,
      "firstObservedOnSaleAt": "2026-08-03T14:00:00+08:00",
      "batchId": "synthetic-batch",
      "membership": "new"
    }
  ]
}
```

`membership` is `new`, `maintenance`, or `rejection_repair`. Only one eligible new batch valid at the order time can own an order line. Maintenance and repair never become new-listing results. More than one match is `ambiguous`; no match is `unmatched`.

## Reconciliation

A reconciliation records the closed-open evaluation window, timestamp field, refund treatment, expected count and amounts, explicit tolerances, and observed differences. Only an accepted reconciliation contributes an accepted net amount to a turnover metric.

If no verified data exists, the API returns `availability: "unavailable"` with null values rather than zeros. Forecasts, search indices, and order revenue are separate concepts.
