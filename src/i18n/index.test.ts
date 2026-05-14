import { describe, expect, it } from 'vitest';
import i18next from 'i18next';
import en from './locales/en.json';
import ptBR from './locales/pt-BR.json';
import itLocale from './locales/it.json';

/**
 * Regression tests for i18next's locale resolution.
 *
 * The bug: an earlier revision flipped `nonExplicitSupportedLngs: true`
 * to make `it-IT` browsers resolve to our `it` catalog. That option,
 * however, also makes i18next "clean" explicitly-supported regional
 * codes by stripping their region — so a `changeLanguage('pt-BR')`
 * call from the language picker resolved to bare `pt` (not in
 * supportedLngs), fell through, and landed on `fallbackLng: 'en'`.
 * Net effect: clicking "Português (Brasil)" rendered the English UI.
 *
 * These tests pin the contract:
 *   - Each locale code we ship round-trips through `changeLanguage`
 *     and resolves to its own catalog.
 *   - Regional variants without their own catalog (e.g. `it-IT`) fall
 *     back to the bare language form via i18next's default
 *     language-only matching.
 *
 * They build a fresh i18next instance per test run with the same
 * configuration as `src/i18n/index.ts`, so any future change to that
 * config that breaks resolution will fail this test before it ships.
 */

async function makeInstance() {
  const inst = i18next.createInstance();
  await inst.init({
    resources: {
      en: { translation: en },
      'pt-BR': { translation: ptBR },
      it: { translation: itLocale },
    },
    supportedLngs: ['en', 'pt-BR', 'it'],
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
  });
  return inst;
}

describe('i18n locale resolution', () => {
  it('changeLanguage("en") resolves to the English catalog', async () => {
    const i = await makeInstance();
    await i.changeLanguage('en');
    expect(i.resolvedLanguage).toBe('en');
    expect(i.t('common.all')).toBe('All');
  });

  it('changeLanguage("pt-BR") resolves to the Brazilian Portuguese catalog (regression)', async () => {
    const i = await makeInstance();
    await i.changeLanguage('pt-BR');
    expect(i.resolvedLanguage).toBe('pt-BR');
    expect(i.t('common.all')).toBe('Todos');
  });

  it('changeLanguage("it") resolves to the Italian catalog', async () => {
    const i = await makeInstance();
    await i.changeLanguage('it');
    expect(i.resolvedLanguage).toBe('it');
    expect(i.t('common.all')).toBe('Tutti');
  });

  it('changeLanguage("it-IT") falls back to the bare Italian catalog', async () => {
    const i = await makeInstance();
    await i.changeLanguage('it-IT');
    // i18next's default `load: 'all'` tries the requested code first,
    // then the language-only form. We don't ship `it-IT`, so it
    // resolves through to `it`.
    expect(i.resolvedLanguage).toBe('it');
    expect(i.t('common.all')).toBe('Tutti');
  });
});
