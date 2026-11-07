// Cellule CSV sûre : guillemets RFC 4180 + neutralisation des formules (injection CSV / OWASP).
// Un texte commençant par = + - @ tabulation ou retour chariot est préfixé d'une apostrophe, sinon un tableur
// pourrait l'exécuter comme formule (ex. nom de serveur Discord choisi par un tiers, puis exporté).
const FORMULA = /^[=+\-@\t\r]/;

export function csvCell(v, separators = /[",\r\n;]/) {
  if (v === null || v === undefined) return '';
  let s = Array.isArray(v) || typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (typeof v === 'string' && FORMULA.test(s)) s = "'" + s;
  return separators.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
