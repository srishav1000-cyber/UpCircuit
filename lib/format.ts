const inr = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const int = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

export const fmt = (n: number, dp = 2): string =>
  Number.isFinite(n) ? (dp === 2 ? inr.format(n) : n.toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp })) : '—';

export const fmtInt = (n: number): string => (Number.isFinite(n) ? int.format(n) : '—');

export const fmtSigned = (n: number, dp = 2): string => (n > 0 ? '+' : n < 0 ? '−' : '') + fmt(Math.abs(n), dp);

export const fmtSignedRupee = (n: number): string => (n > 0 ? '+' : n < 0 ? '−' : '') + '₹' + fmt(Math.abs(n));

export const fmtPct =(n: number, dp = 2): string =>
  (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(dp) + '%';

export const fmtRupee = (n: number): string => '₹' + fmt(n);

/** ₹ crore → human units (Cr / L Cr) */
export function fmtCr(cr: number): string {
  if (!Number.isFinite(cr)) return '—';
  const a = Math.abs(cr);
  if (a >= 1e5) return `₹${(cr / 1e5).toFixed(2)} L Cr`;
  return `₹${int.format(cr)} Cr`;
}

export function fmtCompact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e7) return (n / 1e7).toFixed(2) + ' Cr';
  if (a >= 1e5) return (n / 1e5).toFixed(2) + ' L';
  if (a >= 1e3) return (n / 1e3).toFixed(1) + ' K';
  return int.format(n);
}

export const tone = (n: number): string => (n > 0 ? 'text-up' : n < 0 ? 'text-down' : 'text-muted');
