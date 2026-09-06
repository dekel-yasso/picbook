'use client';

import { useI18n } from '@/lib/i18n';

/** Single-button language switch: shows the language you'd switch TO, so a
 *  tap always toggles en ⇄ he. Compact enough to drop into any header
 *  without disturbing its layout. */
export function LangToggle({ className = '' }: { className?: string }) {
  const { lang, setLang } = useI18n();
  const next = lang === 'en' ? 'he' : 'en';
  return (
    <button
      onClick={() => setLang(next)}
      aria-label={next === 'he' ? 'עברית' : 'English'}
      className={`shrink-0 border-2 border-ink px-2 py-1 text-[11px] font-bold text-ink ${className}`}
    >
      {next === 'he' ? 'עב' : 'EN'}
    </button>
  );
}
