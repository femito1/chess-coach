import { describe, expect, it } from 'vitest';
import en from './locales/en.json';
import itLocale from './locales/it.json';
import ptBR from './locales/pt-BR.json';

/**
 * Key-parity guard across all shipped locales.
 *
 * i18next is configured with `fallbackLng: 'en'`, so a key missing from
 * `it` / `pt-BR` silently renders the English string — which means a
 * forgotten translation is invisible at runtime and `tsc` never catches
 * it (the keys aren't typed). This test makes the omission loud: every
 * catalog must carry exactly the same set of keys as English.
 *
 * If this fails, the reported paths tell you which keys to add (or which
 * stray key to remove) in which locale.
 */
function flatten(obj: unknown, prefix = ''): Set<string> {
  const out = new Set<string>();
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object') {
        for (const nested of flatten(v, key)) out.add(nested);
      } else {
        out.add(key);
      }
    }
  }
  return out;
}

const enKeys = flatten(en);

describe('i18n locale key parity', () => {
  for (const [name, catalog] of [
    ['it', itLocale],
    ['pt-BR', ptBR],
  ] as const) {
    it(`${name} has exactly the same keys as en`, () => {
      const keys = flatten(catalog);
      const missing = [...enKeys].filter((k) => !keys.has(k)).sort();
      const extra = [...keys].filter((k) => !enKeys.has(k)).sort();
      expect(missing, `${name} is missing keys present in en`).toEqual([]);
      expect(extra, `${name} has keys not present in en`).toEqual([]);
    });
  }
});
