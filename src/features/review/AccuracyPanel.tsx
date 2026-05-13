import { useTranslation } from 'react-i18next';
import type { Game } from '@/db/schema';

export function AccuracyPanel({ game }: { game: Game }) {
  const { t } = useTranslation();
  const acc = game.accuracy;
  return (
    <div className="card p-3 text-xs">
      <div className="grid grid-cols-[1fr_auto] gap-x-3 items-baseline">
        <span className="text-text-muted">{t('review.accuracy.title')}</span>
        <span className="text-text-muted text-[10px] uppercase tracking-wide">{t('review.accuracy.engine')}</span>
        <span className="text-text-muted">{t('review.accuracy.white')}</span>
        <span className="text-text font-mono text-right">
          {acc ? `${acc.white.toFixed(1)}%` : '—'}
        </span>
        <span className="text-text-muted">{t('review.accuracy.black')}</span>
        <span className="text-text font-mono text-right">
          {acc ? `${acc.black.toFixed(1)}%` : '—'}
        </span>
      </div>
    </div>
  );
}
