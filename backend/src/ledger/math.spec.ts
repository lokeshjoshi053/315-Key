import { commissionFor, matchVolume, split } from './math';

const up = (n: number, approved = true) => Array.from({ length: n }, (_, i) => ({ userId: `u${i + 1}`, approved }));

describe('commission', () => {
  it('Gold booking with full upline matches SRS AC-4', () => {
    const lines = commissionFor(30_000_000, [2000, 1000, 1000], up(3), 2000, 500);
    expect(lines.map((l) => [l.level, l.amounts.gross, l.amounts.net])).toEqual([
      [1, 6_000_000, 4_500_000], // ₹60,000 gross → ₹45,000 net
      [2, 3_000_000, 2_250_000],
      [3, 3_000_000, 2_250_000],
    ]);
  });

  it('Express token, PDF percentages', () => {
    const lines = commissionFor(2_100_000, [1000, 500, 500], up(3), 2000, 500);
    expect(lines.map((l) => l.amounts.gross)).toEqual([210_000, 105_000, 105_000]);
  });

  it('non-approved ancestor forfeits its level, does not compress', () => {
    const upline = [{ userId: 'a', approved: true }, { userId: 'b', approved: false }, { userId: 'c', approved: true }];
    const lines = commissionFor(30_000_000, [2000, 1000, 1000], upline, 2000, 500);
    expect(lines.map((l) => [l.level, l.userId])).toEqual([[1, 'a'], [3, 'c']]);
  });

  it('short upline and >3 upline', () => {
    expect(commissionFor(1_000_000, [1000, 500, 500], up(1), 2000, 500)).toHaveLength(1);
    expect(commissionFor(1_000_000, [1000, 500, 500], up(7), 2000, 500)).toHaveLength(3);
  });

  it('deductions always reconcile to gross (DB check constraint)', () => {
    for (const g of [1, 3, 7, 99, 12_345, 6_510_001]) {
      const d = split(g, 2000, 500);
      expect(d.admin + d.tds + d.net).toBe(g);
    }
  });
});

describe('70:30 matching', () => {
  it('consumes volume in 70:30 ratio, power leg on the bigger side', () => {
    expect(matchVolume(700_000, 300_000, 70, 30, 5000)).toEqual({ usedLeft: 700_000, usedRight: 300_000, matched: 1_000_000, bonus: 500_000 });
  });

  it('carries forward the surplus', () => {
    const m = matchVolume(200_000, 1_000_000, 70, 30, 5000)!;
    expect(m.usedLeft).toBe(199_980);
    expect(m.usedRight).toBe(466_620);
  });

  it('no match with an empty leg', () => {
    expect(matchVolume(0, 1_000_000, 70, 30, 5000)).toBeNull();
  });
});
