'use client';

import { useCallback, useState } from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { useI18n } from '@/lib/i18n';

interface OnboardingProps {
  onSkip: () => void;
  /** Called after the last card's CTA — the caller opens the photo picker. */
  onFinish: () => void;
}

const CARD_COUNT = 3;

export function Onboarding({ onSkip, onFinish }: OnboardingProps) {
  const { t, lang } = useI18n();
  const [index, setIndex] = useState(0);

  const next = useCallback(() => {
    if (index >= CARD_COUNT - 1) onFinish();
    else setIndex((i) => i + 1);
  }, [index, onFinish]);

  const cards = [
    {
      title: t('onboard1Title'),
      body: t('onboard1Body'),
      steps: [
        [t('onboard1Step1'), t('onboard1Step1Body')],
        [t('onboard1Step2'), t('onboard1Step2Body')],
        [t('onboard1Step3'), t('onboard1Step3Body')],
      ] as const,
    },
    { title: t('onboard2Title'), body: t('onboard2Body'), steps: null },
    { title: t('onboard3Title'), body: t('onboard3Body'), steps: null },
  ];
  const card = cards[index];
  const isLast = index === CARD_COUNT - 1;

  return (
    <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex flex-col bg-ground text-ink">
      <div className="flex items-center justify-between px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <h1 className="text-[21px] font-extrabold tracking-[-0.02em]">PicBook</h1>
        <button onClick={onSkip} className="text-[11px] font-semibold uppercase tracking-wide text-muted">
          {t('onboardSkip')}
        </button>
      </div>
      <div className="border-t-2 border-ink" />

      <div className="flex flex-1 flex-col justify-center gap-4 p-4">
        <div className="h-[3px] w-11 bg-accent" />
        <p className="text-[32px] font-extrabold leading-[1.08]">{card.title}</p>
        <p className="text-sm text-muted">{card.body}</p>
        {card.steps && (
          <div className="mt-2 border-t-2 border-ink">
            {card.steps.map(([label, body], i) => (
              <div
                key={i}
                className={`flex gap-3 py-2.5 text-[13px] ${i < card.steps.length - 1 ? 'border-b border-track' : ''}`}
              >
                <span className="shrink-0 font-extrabold text-accent">{String(i + 1).padStart(2, '0')}</span>
                <span>
                  <span className="font-bold">{label}</span> <span className="text-muted">{body}</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-4 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="flex gap-1">
          {Array.from({ length: CARD_COUNT }).map((_, i) => (
            <div key={i} className={`h-1 w-5 ${i === index ? 'bg-accent' : 'bg-track'}`} />
          ))}
        </div>
        <button
          onClick={next}
          className="flex w-full items-center justify-between bg-accent px-3.5 py-3 text-[13px] font-semibold text-white"
        >
          {isLast ? t('addPhotos') : t('onboardContinue')}
          {lang === 'he' ? <ArrowLeft size={16} strokeWidth={2.5} /> : <ArrowRight size={16} strokeWidth={2.5} />}
        </button>
      </div>
    </div>
  );
}
