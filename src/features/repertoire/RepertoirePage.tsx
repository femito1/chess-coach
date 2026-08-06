import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type Repertoire } from '@/db/schema';
import { deleteRepertoire, dueCards, enumerateLines } from './store';

/**
 * Repertoire list page. After the family-first refactor, repertoires
 * are bound 1:1 to opening families ("Sicilian Defense", "Italian
 * Game"). New repertoires are not created from this page — the user
 * creates them implicitly by adding lines from the Openings library
 * (`/openings`), which auto-creates the family-bound repertoire on
 * first add. This page is a *list* + *drill / review launcher*.
 *
 * The legacy "New repertoire" button + free-form "Custom" repertoires
 * are intentionally not exposed here. v10 wiped the legacy data and
 * the new flow is family-driven. If a user genuinely wants a custom
 * tree they can still get one by importing PGN through the editor —
 * we don't surface a button for it because >95% of the use case is
 * the family flow.
 */
export function RepertoirePage() {
  const { t } = useTranslation();
  const reps = useLiveQuery(
    () => db.repertoires.orderBy('updatedAt').reverse().toArray(),
    [],
  );
  const [dueCounts, setDueCounts] = useState<Record<string, number>>({});
  const [lineCounts, setLineCounts] = useState<
    Record<string, { active: number; total: number }>
  >({});

  useLiveQuery(async () => {
    if (!reps) return;
    const counts: Record<string, number> = {};
    const lines: Record<string, { active: number; total: number }> = {};
    for (const r of reps) {
      const cards = await dueCards(r.id);
      counts[r.id] = cards.length;
      const enumerated = await enumerateLines(r.id);
      const recommended = r.learningMode !== 'all';
      lines[r.id] = {
        active: recommended
          ? Math.min(r.activeLineKeys?.length ?? 5, enumerated.length)
          : enumerated.length,
        total: enumerated.length,
      };
    }
    setDueCounts(counts);
    setLineCounts(lines);
  }, [reps]);

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('repertoire.title')}</h1>
          <p className="text-sm text-text-muted">
            {t('repertoire.subtitle1')}
            <Link to="/openings" className="text-accent hover:underline">
              {t('repertoire.subtitle2')}
            </Link>
            {t('repertoire.subtitle3')}
          </p>
        </div>
        <Link to="/openings" className="btn-primary text-xs">
          {t('repertoire.browseOpenings')}
        </Link>
      </div>

      {!reps ? (
        <div className="card p-8 text-center text-text-muted">{t('repertoire.loading')}</div>
      ) : reps.length === 0 ? (
        <div className="card p-8 text-center text-text-muted space-y-2">
          <div className="text-lg">{t('repertoire.noRepertoires')}</div>
          <p className="text-sm">
            {t('repertoire.noRepertoiresHelp1')}
            <Link to="/openings" className="text-accent hover:underline">
              {t('repertoire.noRepertoiresHelp2')}
            </Link>
            {t('repertoire.noRepertoiresHelp3')}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {reps.map((r) => (
            <RepertoireCard
              key={r.id}
              rep={r}
              dueCount={dueCounts[r.id] ?? 0}
              lineCount={lineCounts[r.id]}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RepertoireCard({
  rep,
  dueCount,
  lineCount,
}: {
  rep: Repertoire;
  dueCount: number;
  lineCount?: { active: number; total: number };
}) {
  const { t } = useTranslation();
  const isFamily = rep.kind === 'family' || (rep.kind == null && Boolean(rep.family));
  return (
    <div className="card p-4 flex flex-col gap-3">
      <div>
        <div className="flex items-start justify-between gap-3">
          <div className="font-medium truncate">{rep.name}</div>
          <span
            className={`text-xs px-2 py-0.5 rounded shrink-0 border ${
              rep.color === 'white'
                ? 'bg-white text-black border-white/70'
                : 'bg-black text-white border-black'
            }`}
          >
            {rep.color === 'white' ? t('common.white') : t('common.black')}
          </span>
        </div>
        {!isFamily && (
          <div className="text-[11px] text-text-muted italic mt-0.5">
            {t('repertoire.card.custom')}
          </div>
        )}
        {rep.description && (
          <div className="text-xs text-text-muted mt-1">{rep.description}</div>
        )}
        <div className="text-xs text-text-muted mt-1">
          {t('repertoire.card.updated', { date: new Date(rep.updatedAt).toLocaleDateString() })}
          {dueCount > 0 && (
            <>
              {' \u00b7 '}
              <span className="text-accent">{t('repertoire.card.due', { count: dueCount })}</span>
            </>
          )}
        </div>
        {lineCount && lineCount.total > 0 && (
          <div className="text-xs text-accent mt-1">
            {rep.learningMode === 'all'
              ? t('repertoire.card.allLinesActive', { count: lineCount.total })
              : t('repertoire.card.linesInRotation', {
                  active: lineCount.active,
                  total: lineCount.total,
                })}
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Link
          to={`/repertoire/${encodeURIComponent(rep.id)}/drill`}
          className="btn-primary text-xs"
          title={t('repertoire.card.drillLinesTitle')}
        >
          {t('repertoire.card.drillLines')}
        </Link>
        <Link
          to={`/repertoire/${rep.id}/train`}
          className={dueCount > 0 ? 'btn-primary text-xs' : 'btn text-xs'}
          title={t('repertoire.card.reviewTitle')}
        >
          {dueCount > 0 ? t('repertoire.card.reviewDue', { count: dueCount }) : t('repertoire.card.reviewNoDue')}
        </Link>
        <button
          type="button"
          className="btn text-xs ml-auto text-blunder hover:text-blunder"
          onClick={() => {
            if (confirm(t('repertoire.card.confirmDelete', { name: rep.name })))
              void deleteRepertoire(rep.id);
          }}
        >
          {t('repertoire.card.delete')}
        </button>
      </div>
    </div>
  );
}
