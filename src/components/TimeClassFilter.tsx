import { useTranslation } from 'react-i18next';
import type {
  TimeClass,
  TimeClassFilter,
  TimeClassSelection,
} from '@/db/schema';
import { TIME_CLASS_ORDER } from '@/db/schema';
import {
  availableTimeClasses,
  isAllTimeClasses,
  toggleTimeClass,
} from '@/lib/timeClass';
import { tTimeClass } from '@/i18n/chess';

/**
 * Multi-select chip bar for picking one or more time controls.
 *
 * Visual contract (matches the dashboard's chart picker so the chip
 * bar feels the same everywhere):
 *
 *   - The "All" chip lights up when every available time class is in
 *     the selection (or when the legacy empty-selection sentinel is
 *     in play, see below).
 *   - When "All" is active, every individual chip *also* renders as
 *     lit so the user sees "yes, all of these are on right now".
 *   - Clicking an individual chip when "All" is active drops just
 *     that chip from the set (the others stay lit).
 *   - Clicking "All" while it's active deselects everything (no
 *     items match → empty result list). Clicking it while it's
 *     inactive fills the selection with every available class.
 *
 * Data shape compatibility: the underlying `TimeClassSelection` is
 * still a `TimeClass[]`. The legacy "empty array = match every game"
 * contract is preserved in `gameMatchesSelection`, but this UI now
 * normalizes the empty array to "explicitly every available class
 * lit" the moment the user touches a chip — so a user who clicks
 * "All" off and on doesn't accidentally re-enable a default they
 * were trying to clear. The "explicit empty (deselect all)" state is
 * represented by `selection = ['__none__']`-style sentinels — see
 * the `EXPLICIT_NONE` constant below — and renders as zero matches.
 */
const EXPLICIT_NONE_SENTINEL = '__none__' as TimeClass;

function isExplicitNone(selection: TimeClassSelection): boolean {
  return selection.length === 1 && selection[0] === EXPLICIT_NONE_SENTINEL;
}

export function TimeClassChips({
  selection,
  onChange,
  available,
}: {
  selection: TimeClassSelection;
  onChange: (next: TimeClassSelection) => void;
  /** Games or puzzles the filter will run on. Used to hide chips for
   *  time classes with zero items so the bar doesn't grow stale UI. */
  available: Array<{ timeClass?: string }>;
}) {
  const { t } = useTranslation();
  const present = availableTimeClasses(available);
  // Always render currently-selected chips even if their bucket is
  // momentarily empty (e.g. the user has zero rapid games right now
  // but rapid is still their saved preference). Drop the explicit-
  // none sentinel — it's a state marker, not a renderable chip.
  const chipsToRender: TimeClass[] = [
    ...present,
    ...selection.filter(
      (tc) => !present.includes(tc) && tc !== EXPLICIT_NONE_SENTINEL,
    ),
  ];
  chipsToRender.sort(
    (a, b) => TIME_CLASS_ORDER.indexOf(a) - TIME_CLASS_ORDER.indexOf(b),
  );

  const explicitNone = isExplicitNone(selection);
  // "All" lit when the legacy "[] = match all" sentinel is in play OR
  // when every available chip is explicitly in the selection.
  const allActive =
    !explicitNone &&
    (isAllTimeClasses(selection) ||
      (chipsToRender.length > 0 &&
        chipsToRender.every((c) => selection.includes(c))));

  function chipActive(tc: TimeClass): boolean {
    if (explicitNone) return false;
    if (allActive) return true;
    return selection.includes(tc);
  }

  function onChipClick(tc: TimeClass) {
    // From "all-lit" the user wants to drop just this chip; from any
    // other state, toggle the chip in/out as before.
    let next: TimeClassSelection;
    if (allActive) {
      next = chipsToRender.filter((c) => c !== tc);
    } else if (explicitNone) {
      next = [tc];
    } else {
      next = toggleTimeClass(selection, tc);
    }
    // CRITICAL: if the user has just deselected the last chip
    // manually, the array drains to []. Under the legacy contract
    // `[] = match every game`, which would flip the UI back to the
    // "all-lit" state — the exact opposite of what the user just
    // did. Swap it for the explicit-none sentinel so the page goes
    // to "no games match" instead, matching what clicking "All"
    // while it was lit does.
    if (next.length === 0) {
      next = [EXPLICIT_NONE_SENTINEL];
    }
    onChange(next);
  }

  function onAllClick() {
    if (allActive) {
      // Deselect everything so the page renders zero items. We use a
      // sentinel rather than `[]` because `[]` is the legacy "match
      // every game" state — flipping to it would be the opposite of
      // what the user just clicked.
      onChange([EXPLICIT_NONE_SENTINEL]);
    } else {
      onChange([...chipsToRender]);
    }
  }

  return (
    <div className="flex flex-wrap gap-1 items-center">
      <Chip label={t('timeClass.all')} active={allActive} onClick={onAllClick} />
      {chipsToRender.map((tc) => (
        <Chip
          key={tc}
          label={tTimeClass(t, tc)}
          active={chipActive(tc)}
          onClick={() => onChipClick(tc)}
        />
      ))}
    </div>
  );
}

function Chip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
        active
          ? 'bg-accent/20 border-accent/60 text-accent'
          : 'bg-bg-raised/40 border-border text-text-muted hover:text-text hover:border-text-muted/50'
      }`}
    >
      {label}
    </button>
  );
}

/**
 * Backwards-compat single-select dropdown. Some places (Settings's
 * default-filter row, progress charts that pick exactly one mode) still
 * want a single value, so the original `<select>` UI lives on under
 * this name. New call sites should prefer `<TimeClassChips>`.
 */
export function TimeClassFilterSelect({
  value,
  onChange,
  available,
  allowAll = true,
}: {
  value: TimeClassFilter;
  onChange: (next: TimeClassFilter) => void;
  available: Array<{ timeClass?: string }>;
  allowAll?: boolean;
}) {
  const { t } = useTranslation();
  const present = availableTimeClasses(available);
  const options: TimeClass[] =
    value !== 'all' && !present.includes(value as TimeClass)
      ? [value as TimeClass, ...present]
      : present;

  return (
    <select
      className="input w-auto"
      value={value}
      onChange={(e) => onChange(e.target.value as TimeClassFilter)}
    >
      {allowAll && <option value="all">{t('timeClass.allTimeControls')}</option>}
      {options.map((tc) => (
        <option key={tc} value={tc}>
          {tTimeClass(t, tc)}
        </option>
      ))}
    </select>
  );
}
