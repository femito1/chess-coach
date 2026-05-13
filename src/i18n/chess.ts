import type { TFunction } from 'i18next';
import type { Classification, Motif } from '@/db/schema';
import type { TimeClass, TimeClassFilter, TimeClassSelection } from '@/db/schema';
import { TIME_CLASS_ORDER } from '@/db/schema';
import type { PracticeMode } from '@/features/repertoire/practiceMode';

/**
 * i18n helpers for chess terminology that's stored in DB rows as
 * English keys (e.g. `move.classification === 'blunder'`,
 * `motif === 'fork'`). Renderers call these to get a localized
 * display label without us having to translate the underlying enum
 * values — those stay in English forever so DB shape, exports, and
 * test fixtures are stable across locales.
 */

export function tClassification(t: TFunction, c: Classification): string {
  return t(`classification.${c}`);
}

export function tMotifLabel(t: TFunction, m: Motif): string {
  return t(`motif.label.${m}`);
}

export function tMotifExplain(t: TFunction, m: Motif): string {
  return t(`motif.explain.${m}`);
}

export function tTimeClass(t: TFunction, filter: TimeClassFilter): string {
  if (filter === 'all') return t('timeClass.all');
  return t(`timeClass.${filter}`);
}

/**
 * Localized rendering for the multi-select "rapid + blitz" summary
 * label that the weaknesses page uses in its subtitle. Mirrors the
 * canonical-order behaviour of `labelForSelection` in
 * `lib/timeClass.ts` but routes through the catalog.
 */
export function tTimeClassSelection(
  t: TFunction,
  selection: TimeClassSelection,
): string {
  if (selection.length === 0) return t('timeClass.all');
  const ordered = TIME_CLASS_ORDER.filter((tc) => selection.includes(tc));
  return ordered.map((tc: TimeClass) => t(`timeClass.${tc}`)).join(' + ');
}

export function tPracticeMode(t: TFunction, m: PracticeMode): string {
  return t(`practiceMode.label.${m}`);
}

export function tPracticeModeDescription(t: TFunction, m: PracticeMode): string {
  return t(`practiceMode.description.${m}`);
}
