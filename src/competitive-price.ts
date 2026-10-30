export interface CompetitivePriceInput {
  /** Fresh, explicit regular-preferred JD quote, in integer RMB cents. */
  sourceJdCents: number;
  /** Strictly matched competitor quote, in integer RMB cents. */
  competitorCents: number;
}

export interface CompetitivePriceDecision {
  sourceJdCents: number;
  competitorCents: number;
  minimumCents: number;
  targetCents: number;
  offerCents: number;
  sourceDeltaCents: number;
  competitorDeltaCents: number;
  advantageAchieved: boolean;
  floorLimited: boolean;
}

function positiveSafeCents(name: string, value: number) {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name}必须是大于零的安全整数人民币分`);
  return BigInt(value);
}

function safeNumber(name: string, value: bigint) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error(`${name}超出安全整数范围`);
  return Number(value);
}

/**
 * Quote one percent below an exact competitor, bounded by a 15% JD discount.
 * Every calculation uses integer cents: the safety floor rounds up and the
 * competitive target rounds down.
 */
export function calculateCompetitivePrice(
  input: CompetitivePriceInput,
): CompetitivePriceDecision {
  const jd = positiveSafeCents("京东价", input.sourceJdCents);
  const competitor = positiveSafeCents("竞品价", input.competitorCents);
  const minimum = (jd * 85n + 99n) / 100n;
  const target = (competitor * 99n) / 100n;
  if (target <= 0n) throw new Error("竞品99%目标价为零，不能生成有效报价");

  const unconstrained = jd < target ? jd : target;
  const offer = minimum > unconstrained ? minimum : unconstrained;
  if (offer <= 0n || offer > jd)
    throw new Error("竞品定价结果无效或高于京东基准价");

  return {
    sourceJdCents: input.sourceJdCents,
    competitorCents: input.competitorCents,
    minimumCents: safeNumber("京东85%底价", minimum),
    targetCents: safeNumber("竞品99%目标价", target),
    offerCents: safeNumber("最终报价", offer),
    sourceDeltaCents: safeNumber("京东价差", offer - jd),
    competitorDeltaCents: safeNumber("竞品价差", competitor - offer),
    advantageAchieved: offer <= target && offer < competitor,
    floorLimited: minimum > unconstrained,
  };
}
