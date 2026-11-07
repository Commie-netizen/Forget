// Safe CSV cells: RFC 4180 quoting and formula neutralization (CSV injection / OWASP).
// Text starting with = + - @, a tab, or a carriage return is prefixed with an apostrophe; otherwise a spreadsheet
// could execute it as a formula (for example, a Discord server name chosen by a third party and then exported).
const FORMULA = /^[=+\-@\t\r]/;

export function csvCell(v, separators = /[",\r\n;]/) {
  if (v === null || v === undefined) return '';
  let s = Array.isArray(v) || typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (typeof v === 'string' && FORMULA.test(s)) s = "'" + s;
  return separators.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
