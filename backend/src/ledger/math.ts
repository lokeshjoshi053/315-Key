/** Pure money math. All amounts are integer paise; rates are basis points (1% = 100 bps). */

export interface Deductions {
  gross: number;
  admin: number;
  tds: number;
  net: number;
}

/** PDF §6: gross − 20% admin − 5% TDS, both on gross (assumption A-2). Floors, so net absorbs rounding. */
export function split(gross: number, adminBps: number, tdsBps: number): Deductions {
  const admin = Math.floor((gross * adminBps) / 10_000);
  const tds = Math.floor((gross * tdsBps) / 10_000);
  return { gross, admin, tds, net: gross - admin - tds };
}

export interface Upline {
  userId: string;
  approved: boolean;
}

export interface CommissionLine {
  level: 1 | 2 | 3;
  userId: string;
  amounts: Deductions;
}

/**
 * 3-level commission on a verified booking. upline[0] is the direct sponsor (L1).
 * Non-approved ancestors forfeit their level; it is NOT passed upward (assumption A-3).
 */
export function commissionFor(amountPaise: number, levelBps: [number, number, number], upline: Upline[], adminBps: number, tdsBps: number): CommissionLine[] {
  return upline.slice(0, 3).flatMap((u, i) =>
    u.approved && levelBps[i] > 0
      ? [{ level: (i + 1) as 1 | 2 | 3, userId: u.userId, amounts: split(Math.floor((amountPaise * levelBps[i]) / 10_000), adminBps, tdsBps) }]
      : [],
  );
}

export interface MatchResult {
  usedLeft: number;
  usedRight: number;
  matched: number;
  bonus: number;
}

/**
 * 70:30 matching. ponytail: placeholder for open question A-4.
 * Volume is consumed in a fixed power:weak ratio (70:30); bonus = bonusBps of matched volume.
 * Unconsumed volume carries forward. Replace this function only, once business confirms the rule.
 */
export function matchVolume(availLeft: number, availRight: number, powerPct: number, weakPct: number, bonusBps: number): MatchResult | null {
  if (availLeft <= 0 || availRight <= 0 || powerPct <= 0 || weakPct <= 0) return null;
  const leftIsPower = availLeft >= availRight;
  const power = leftIsPower ? availLeft : availRight;
  const weak = leftIsPower ? availRight : availLeft;
  const units = Math.min(Math.floor(power / powerPct), Math.floor(weak / weakPct));
  if (units <= 0) return null;
  const usedPower = units * powerPct;
  const usedWeak = units * weakPct;
  const matched = usedPower + usedWeak;
  return {
    usedLeft: leftIsPower ? usedPower : usedWeak,
    usedRight: leftIsPower ? usedWeak : usedPower,
    matched,
    bonus: Math.floor((matched * bonusBps) / 10_000),
  };
}
