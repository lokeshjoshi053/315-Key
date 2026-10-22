/** Display formatting for the mobile app (API v1). Pure functions, unit-tested. */

const IN = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

/** Paise → "₹3,00,000" (Indian grouping, whole rupees; negative → "-₹…"). */
export function inr(paise: number | null | undefined): string {
  const p = Number(paise ?? 0);
  return `${p < 0 ? '-' : ''}₹${IN.format(Math.round(Math.abs(p) / 100))}`;
}

/** Paise → short form: "₹1.2Cr", "₹3L", "₹45K", "₹900". */
export function inrShort(paise: number | null | undefined): string {
  const r = Math.abs(Number(paise ?? 0)) / 100;
  const sign = Number(paise ?? 0) < 0 ? '-' : '';
  const trim = (n: number) => String(Number(n.toFixed(1)));
  if (r >= 1e7) return `${sign}₹${trim(r / 1e7)}Cr`;
  if (r >= 1e5) return `${sign}₹${trim(r / 1e5)}L`;
  if (r >= 1e3) return `${sign}₹${trim(r / 1e3)}K`;
  return `${sign}₹${Math.round(r)}`;
}

/** Basis points → "20%" / "12.5%". */
export const pct = (bps: number) => `${Number((bps / 100).toFixed(2))}%`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "22 Oct 2026" in India time. */
export function day(d: Date | string | null | undefined): string {
  if (!d) return '';
  const t = new Date(new Date(d).getTime() + 330 * 60_000); // IST
  return `${t.getUTCDate()} ${MONTHS[t.getUTCMonth()]} ${t.getUTCFullYear()}`;
}

/** "just now", "5m ago", "2h ago", "3d ago", else the date. */
export function timeAgo(d: Date | string | null | undefined, now = Date.now()): string {
  if (!d) return '';
  const s = Math.max(0, Math.floor((now - new Date(d).getTime()) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return day(d);
}

/** "ON_HOLD" → "On hold". */
export const label = (s: string | null | undefined) => (s ? s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ') : '');

/** Map position (0..1) for a plot from its number: a 15-column grid, row by row. */
export function mapOffset(plotNo: string, total = 315, cols = 15) {
  const n = Math.max(1, Number(plotNo.replace(/\D/g, '')) || 1);
  const rows = Math.ceil(total / cols);
  return { x: Number(((((n - 1) % cols) + 0.5) / cols).toFixed(4)), y: Number(((Math.floor((n - 1) / cols) + 0.5) / rows).toFixed(4)) };
}
