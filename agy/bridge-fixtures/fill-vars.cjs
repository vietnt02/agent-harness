'use strict';
/**
 * fill-vars.cjs - put fixture values ({ACP}, {GH}, {CID}, {WS}) into a payload template, string by
 * string on the parsed object: a value is never spliced into JSON text, where a Windows path's `\`
 * would be read as an escape and break the payload.
 */
function fillVars(x, vars) {
  if (typeof x === 'string') {
    let s = x;
    for (const [k, v] of Object.entries(vars)) s = s.split(k).join(v);
    return s;
  }
  if (Array.isArray(x)) return x.map((y) => fillVars(y, vars));
  if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [fillVars(k, vars), fillVars(v, vars)]));
  return x;
}

module.exports = { fillVars };
