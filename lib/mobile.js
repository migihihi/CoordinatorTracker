// Philippine mobile numbers. Stored as +639XXXXXXXXX; shown as 0917 123 4567.

// 09171234567 / 9171234567 / 639171234567 / +63 917 123 4567 -> +639171234567 (or null)
export function normalizeMobile(raw) {
  const digits = String(raw || "").replace(/[^\d]/g, "");
  let local = "";
  if (/^09\d{9}$/.test(digits)) local = digits.slice(1);
  else if (/^9\d{9}$/.test(digits)) local = digits;
  else if (/^639\d{9}$/.test(digits)) local = digits.slice(2);
  else return null;
  return `+63${local}`;
}

export function formatMobile(stored) {
  if (!stored || !/^\+639\d{9}$/.test(stored)) return stored || "";
  const d = "0" + stored.slice(3);
  return `${d.slice(0, 4)} ${d.slice(4, 7)} ${d.slice(7)}`;
}

export const MOBILE_HINT = "Philippine mobile, e.g. 0917 123 4567";

// Turns database errors about mobiles into plain words.
export function mobileErrorMessage(message) {
  if (/profiles_mobile_unique/.test(message || "")) return "That mobile number already belongs to another account.";
  if (/profiles_mobile_format/.test(message || "")) return `Enter a valid ${MOBILE_HINT}.`;
  return message;
}
