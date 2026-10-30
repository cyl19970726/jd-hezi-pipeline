import test from "node:test";
import assert from "node:assert/strict";
import { calculateCompetitivePrice } from "../src/competitive-price.js";

test("quotes one percent below the competitor when above the JD floor", () => {
  assert.deepEqual(
    calculateCompetitivePrice({
      sourceJdCents: 10_000,
      competitorCents: 9_000,
    }),
    {
      sourceJdCents: 10_000,
      competitorCents: 9_000,
      minimumCents: 8_500,
      targetCents: 8_910,
      offerCents: 8_910,
      sourceDeltaCents: -1_090,
      competitorDeltaCents: 90,
      advantageAchieved: true,
      floorLimited: false,
    },
  );
});

test("the 15 percent JD floor wins and reports that one percent advantage is unavailable", () => {
  const result = calculateCompetitivePrice({
    sourceJdCents: 10_001,
    competitorCents: 8_500,
  });
  assert.equal(result.minimumCents, 8_501);
  assert.equal(result.targetCents, 8_415);
  assert.equal(result.offerCents, 8_501);
  assert.equal(result.floorLimited, true);
  assert.equal(result.advantageAchieved, false);
  assert.equal(result.competitorDeltaCents, -1);
});

test("an already lower JD price remains unchanged and is never raised", () => {
  const result = calculateCompetitivePrice({
    sourceJdCents: 5_000,
    competitorCents: 10_000,
  });
  assert.equal(result.offerCents, 5_000);
  assert.equal(result.sourceDeltaCents, 0);
  assert.equal(result.competitorDeltaCents, 5_000);
  assert.equal(result.advantageAchieved, true);
  assert.equal(result.floorLimited, false);
});

test("rounds the JD floor up and the competitor target down in integer cents", () => {
  const result = calculateCompetitivePrice({
    sourceJdCents: 101,
    competitorCents: 101,
  });
  assert.equal(result.minimumCents, 86);
  assert.equal(result.targetCents, 99);
  assert.equal(result.offerCents, 99);
  assert.equal(result.competitorDeltaCents, 2);
});

test("rejects an extremely low competitor quote whose target rounds to zero", () => {
  assert.throws(
    () => calculateCompetitivePrice({ sourceJdCents: 100, competitorCents: 1 }),
    /99%.*为零/u,
  );
});

test("rejects non-integer, non-positive, non-finite, and unsafe cent inputs", () => {
  for (const value of [
    0,
    -1,
    1.5,
    Number.NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.throws(
      () =>
        calculateCompetitivePrice({
          sourceJdCents: value,
          competitorCents: 100,
        }),
      /安全整数/u,
    );
    assert.throws(
      () =>
        calculateCompetitivePrice({
          sourceJdCents: 100,
          competitorCents: value,
        }),
      /安全整数/u,
    );
  }
});

test("uses exact integer arithmetic at the largest safe cent values", () => {
  const sourceJdCents = Number.MAX_SAFE_INTEGER;
  const competitorCents = Number.MAX_SAFE_INTEGER;
  const result = calculateCompetitivePrice({ sourceJdCents, competitorCents });
  assert.equal(
    result.minimumCents,
    Number((BigInt(sourceJdCents) * 85n + 99n) / 100n),
  );
  assert.equal(
    result.targetCents,
    Number((BigInt(competitorCents) * 99n) / 100n),
  );
  assert.equal(result.offerCents, result.targetCents);
  assert.ok(result.offerCents <= sourceJdCents);
});
