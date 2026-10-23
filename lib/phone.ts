// Indian mobile numbers for phone-OTP login: +91 followed by 10 digits starting 6–9.
export const OTP_LEN = 6;
/** "98765 43210", "+91 98765-43210", "09876543210", "919876543210" → "+919876543210"; anything else → null */
export function normalizeIndianMobile(input: string): string | null {
  const d = input.replace(/[\s\-().]/g, '');
  const m = /^(?:\+?91|0)?([6-9]\d{9})$/.exec(d);
  return m ? `+91${m[1]}` : null;
}
export const isOtp = (t: string): boolean => /^\d{6}$/.test(t);
/** "+919876543210" → "+91 98765 43210" (display only) */
export const formatIndianMobile = (e164: string): string => (/^\+91\d{10}$/.test(e164) ? `+91 ${e164.slice(3, 8)} ${e164.slice(8)}` : e164);
