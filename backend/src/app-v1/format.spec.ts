import { day, inr, inrShort, label, mapOffset, pct, timeAgo } from './format';

describe('app v1 formatting', () => {
  it('formats rupees with Indian grouping', () => {
    expect(inr(30000000)).toBe('₹3,00,000');
    expect(inr(500000000)).toBe('₹50,00,000');
    expect(inr(2100000)).toBe('₹21,000');
    expect(inr(-6000000)).toBe('-₹60,000');
    expect(inr(0)).toBe('₹0');
  });
  it('short amounts', () => {
    expect(inrShort(30000000)).toBe('₹3L');
    expect(inrShort(1250000000)).toBe('₹1.3Cr');
    expect(inrShort(4500000)).toBe('₹45K');
  });
  it('percent, labels, dates', () => {
    expect(pct(2000)).toBe('20%');
    expect(pct(1250)).toBe('12.5%');
    expect(label('ON_HOLD')).toBe('On hold');
    expect(day('2026-10-22T20:00:00Z')).toBe('23 Oct 2026'); // IST
    const now = Date.parse('2026-10-22T12:00:00Z');
    expect(timeAgo('2026-10-22T11:58:00Z', now)).toBe('2m ago');
    expect(timeAgo('2026-10-22T09:00:00Z', now)).toBe('3h ago');
    expect(timeAgo('2026-10-01T09:00:00Z', now)).toBe('1 Oct 2026');
  });
  it('places plots on a 15 x 21 grid', () => {
    expect(mapOffset('P-001')).toEqual({ x: 0.0333, y: 0.0238 });
    expect(mapOffset('P-315')).toEqual({ x: 0.9667, y: 0.9762 });
  });
});
