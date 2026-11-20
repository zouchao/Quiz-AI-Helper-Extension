// Checks entrypoints/content/i18n.js: zh and en must have the same keys, no empty
// strings, and the same {0}/{1} placeholders per key. Run in CI via `npm run check:i18n`.
import { I18N } from '../entrypoints/content/i18n.js';

const LANGS = Object.keys(I18N);
const placeholders = (s) => [...new Set(s.match(/\{\d+\}/g) || [])].sort().join(',');
const errors = [];

const allKeys = new Set(LANGS.flatMap((l) => Object.keys(I18N[l])));
for (const key of allKeys) {
    const missing = LANGS.filter((l) => !(key in I18N[l]));
    if (missing.length) { errors.push(`"${key}" missing in: ${missing.join(', ')}`); continue; }
    for (const l of LANGS) {
        if (typeof I18N[l][key] !== 'string' || !I18N[l][key].trim()) errors.push(`"${key}" is empty in ${l}`);
    }
    const ph = LANGS.map((l) => placeholders(I18N[l][key] || ''));
    if (new Set(ph).size > 1) errors.push(`"${key}" placeholders differ: ` + LANGS.map((l, i) => `${l}=[${ph[i]}]`).join(' '));
}

if (errors.length) {
    console.error(`i18n check failed (${errors.length}):\n  ` + errors.join('\n  '));
    process.exit(1);
}
console.log(`i18n OK: ${allKeys.size} keys × ${LANGS.length} languages (${LANGS.join(', ')})`);
