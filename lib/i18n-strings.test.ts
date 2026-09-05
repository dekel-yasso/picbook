import { describe, expect, it } from 'vitest';
import { STRINGS, THEME_LABELS, themeLabel, translate } from './i18n-strings';

// Full Hebrew support depends entirely on this map staying in sync — a
// missing 'he' key silently falls back to English (see translate()) rather
// than failing loudly, so drift here is invisible until a Hebrew-reading
// user hits it.
describe('STRINGS completeness (en/he parity)', () => {
  const enKeys = Object.keys(STRINGS.en);
  const heKeys = Object.keys(STRINGS.he);

  it('has no keys present in en but missing from he', () => {
    const missing = enKeys.filter((k) => !heKeys.includes(k));
    expect(missing).toEqual([]);
  });

  it('has no keys present in he but missing from en (dead/renamed keys)', () => {
    const extra = heKeys.filter((k) => !enKeys.includes(k));
    expect(extra).toEqual([]);
  });

  it('has a non-empty string for every en/he key', () => {
    for (const k of enKeys) {
      expect(STRINGS.en[k as keyof typeof STRINGS.en].length).toBeGreaterThan(0);
      expect(STRINGS.he[k as keyof typeof STRINGS.he].length).toBeGreaterThan(0);
    }
  });

  it('carries the same {placeholder} params in en and he for every key', () => {
    const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    const mismatched: string[] = [];
    for (const k of enKeys) {
      const enPh = placeholders(STRINGS.en[k as keyof typeof STRINGS.en]);
      const hePh = placeholders(STRINGS.he[k as keyof typeof STRINGS.he]);
      if (JSON.stringify(enPh) !== JSON.stringify(hePh)) mismatched.push(k);
    }
    expect(mismatched).toEqual([]);
  });
});

describe('translate', () => {
  it('returns the string for the requested language', () => {
    expect(translate('en', 'renderPdf')).toBe(STRINGS.en.renderPdf);
    expect(translate('he', 'renderPdf')).toBe(STRINGS.he.renderPdf);
  });

  it('substitutes params by name', () => {
    const out = translate('en', 'savePdf', { size: '12.3' });
    expect(out).not.toContain('{size}');
    expect(out).toContain('12.3');
  });

  it('substitutes the same param in Hebrew too', () => {
    const out = translate('he', 'savePdf', { size: '12.3' });
    expect(out).not.toContain('{size}');
    expect(out).toContain('12.3');
  });
});

describe('themeLabel', () => {
  it('translates a known theme to Hebrew', () => {
    expect(themeLabel('he', 'Water')).toBe(THEME_LABELS.he.Water);
  });

  it('falls back to the raw theme name for an unknown theme', () => {
    expect(themeLabel('he', 'Unknown Theme')).toBe('Unknown Theme');
  });

  it('leaves English untranslated (no theme labels defined for en)', () => {
    expect(themeLabel('en', 'Water')).toBe('Water');
  });
});
