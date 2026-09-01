import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ColorBadge } from '@/features/openings/ColorBadge';
import { useThrottledLiveQuery } from '@/lib/useThrottledLiveQuery';
import { rankGapCandidates, resolvePrepGaps, type GameForGaps } from './prepGaps';

/** Below this the library is too thin for "you lose in X" to mean anything,
 *  whatever the per-opening sample says. */
const MIN_LIBRARY_GAMES = 10;

/** Rows rendered. Stage 1 ranks more candidates than this precisely so
 *  stage 2 has spares to discard as already-prepped. */
const MAX_ROWS = 5;

/**
 * "Openings you lose in and haven't prepped."
 *
 * The list answers the question the drill page can't: *which* line to
 * study. Rows link into the openings library rather than writing prep
 * themselves — adding lines stays where the add buttons already live.
 *
 * Rows disappear on their own once you prep them: `resolvePrepGaps` reads
 * `repertoires` / `repertoireNodes`, so Dexie's live query re-fires when
 * the tree changes. Throttled to 1.5 s to match the rest of the dashboard,
 * which is otherwise hammered by the analyser's per-game writes.
 */
export function PrepGapsCard({ games }: { games: readonly GameForGaps[] }) {
  const { t } = useTranslation();

  const candidates = useMemo(
    () => (games.length >= MIN_LIBRARY_GAMES ? rankGapCandidates(games) : []),
    [games],
  );

  // Keyed on the candidates' *content*, not the array's identity. While the
  // analyser is writing, the dashboard's games projection changes reference
  // every 1.5 s, which recreates `candidates` and would resubscribe this
  // query — re-reading two dozen PGNs each time — even though the ranking
  // is usually identical. The signature makes a resubscribe happen only
  // when a candidate actually enters, leaves, or changes record.
  const candidateSignature = candidates
    .map((c) => `${c.key}:${c.games}:${c.losses}`)
    .join('|');

  const gaps = useThrottledLiveQuery(
    () => resolvePrepGaps(candidates),
    [candidateSignature],
    // Slower than the dashboard's 1.5 s on purpose. Prep gaps move when you
    // finish a game or edit a repertoire, not within a second, and each pass
    // reads PGNs — so this card should not run at chart cadence.
    4000,
  );

  // Nothing worth saying: too few games, no losing openings, or every
  // candidate turned out to be prepped after all. Render nothing rather
  // than an empty card — this one is only ever additive information.
  if (!gaps || gaps.length === 0) return null;

  return (
    <div className="card p-3">
      <div className="text-xs uppercase tracking-wide text-text-muted">
        {t('charts.prepGaps.title')}
      </div>
      <p className="text-xs text-text-muted mt-1 mb-2">
        {t('charts.prepGaps.subtitle')}
      </p>
      <ul className="space-y-2">
        {gaps.slice(0, MAX_ROWS).map((gap) => {
          // Every row is below the win-rate ceiling by construction, so a
          // win-rate bar would be uniformly red and say nothing. The bar
          // shows the share of points dropped instead, which varies.
          const dropped = Math.round((1 - gap.winRate) * 100);
          const target = `/openings?family=${encodeURIComponent(gap.canonicalFamily)}`;
          return (
            <li
              key={gap.key}
              className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 items-center"
              // The label comes from the library; the count comes from the
              // games grouped under their own spelling. Naming both in the
              // tooltip keeps the row from implying more precision than it
              // has.
              title={t('charts.prepGaps.tooltip', {
                label: gap.label,
                groupName: gap.groupName,
                wins: gap.wins,
                draws: gap.draws,
                losses: gap.losses,
                games: gap.games,
              })}
            >
              <div className="min-w-0 flex items-center gap-2">
                <span className="text-sm truncate">{gap.label}</span>
                <ColorBadge color={gap.color} size="xs" />
                <Link
                  to={target}
                  className="shrink-0 inline-flex items-center gap-1 rounded-md border border-border/80 bg-bg-raised/60 px-1.5 py-0.5 text-[11px] text-accent hover:border-accent/50 hover:bg-accent/10 transition-colors"
                  title={t('charts.openInLibraryTitle', {
                    family: gap.canonicalFamily,
                  })}
                  aria-label={t('charts.openInLibraryTitle', {
                    family: gap.canonicalFamily,
                  })}
                >
                  {t('charts.openInLibrary')}
                  <span aria-hidden className="opacity-70">
                    →
                  </span>
                </Link>
              </div>
              <span className="text-xs text-text-muted font-mono whitespace-nowrap">
                {t('charts.prepGaps.row', {
                  losses: gap.losses,
                  games: gap.games,
                })}
              </span>
              <div className="col-span-2 flex items-center gap-2">
                <div className="flex-1 h-2 rounded-full bg-bg-raised overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{
                      width: `${Math.max(2, dropped)}%`,
                      background: '#e06c75',
                    }}
                  />
                </div>
                <span className="text-xs text-text-muted font-mono w-10 text-right">
                  {dropped}%
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
