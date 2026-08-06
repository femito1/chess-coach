import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { Board } from '@/components/Board';
import { BoardFrame } from '@/components/BoardFrame';
import { db, type Color } from '@/db/schema';
import { usePersistedState } from '@/lib/usePersistedState';
import {
  addFamilyToRepertoire,
  addGuidedLinesToRepertoire,
  colorHint,
  ensureFamilyRepertoire,
  familyColor,
  familyDescription,
  getFamilies,
  getVariations,
  isFamilySort,
  replayLine,
  resolveOpeningFamily,
  searchOpenings,
  sortFamilies,
  type FamilyGroup,
  type FamilySort,
  type OpeningLine,
} from './library';
import { ColorBadge } from './ColorBadge';
import {
  buildPersonalOpeningStats,
  openingLineKey,
  rankOpeningLines,
  type RankedOpeningLine,
} from './recommendations';

type ColorFilter = 'all' | Color;

/** Snapshot the alphabetical aggregate once at module load — sorting is
 *  applied per-render based on the user's persisted preference, not at
 *  the data layer. Cheap (~150-element sort) so we don't memoise it. */
const FAMILIES_ALPHA: readonly FamilyGroup[] = getFamilies('alpha');

/** Deep-link flash duration; matches the `deep-link-flash` keyframes in
 *  `styles/index.css`. */
const FLASH_MS = 2000;

export function LibraryPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  // Filters + sort are persisted UI preferences (not chess data), so
  // they survive reloads / tab swaps without going through Dexie /
  // cloud sync. Mirrors the dashboard chart-filter persistence pattern.
  const [query, setQuery] = useState('');
  const [colorFilter, setColorFilter] = usePersistedState<ColorFilter>(
    'openings:color-filter',
    'all',
    {
      isValid: (v): v is ColorFilter =>
        v === 'all' || v === 'white' || v === 'black',
    },
  );
  const [sort, setSort] = usePersistedState<FamilySort>(
    'openings:sort',
    'popular',
    { isValid: isFamilySort },
  );
  // Dashboard (and any other deep link) can land on `/openings?family=…`.
  // The param is a one-shot *instruction*, not the source of truth: we
  // apply it to state and then strip it. Keeping it in the URL and
  // mirroring it into state both ways meant a manual family pick had to
  // write the param, which turned every in-page click into a navigation
  // and made "clear selection" impossible to express.
  //
  // `resolveOpeningFamily` (not a bare equality check) because a link
  // may arrive with the game-derived spelling — "Caro Kann Defense" for
  // the library's "Caro-Kann Defense".
  const familyParam = searchParams.get('family')?.trim() ?? '';
  const [selectedFamily, setSelectedFamily] = useState<string | null>(() =>
    familyParam ? resolveOpeningFamily(familyParam) : null,
  );
  const [selectedLine, setSelectedLine] = useState<OpeningLine | null>(null);
  const [ply, setPly] = useState(0);
  const [variationSort, setVariationSort] = useState<
    'recommended' | 'global' | 'personal' | 'shortest' | 'alpha'
  >('recommended');
  const games = useLiveQuery(() => db.games.toArray(), []);
  // Flash + scroll the deep-linked family in the sidebar list. With 148
  // families the list scrolls, so selecting one off-screen was silent.
  const [flashFamily, setFlashFamily] = useState<string | null>(() =>
    familyParam ? resolveOpeningFamily(familyParam) : null,
  );

  useEffect(() => {
    if (!familyParam) return;
    const canonical = resolveOpeningFamily(familyParam);
    if (canonical) {
      setSelectedFamily(canonical);
      setSelectedLine(null);
      setPly(0);
      setQuery('');
      setFlashFamily(canonical);
    }
    // Consume the param either way — an unresolvable family shouldn't
    // stick around in the URL re-triggering this on every render. Note
    // this deliberately does NOT clear `selectedFamily` on an unknown
    // param: an earlier version did, which wiped the user's selection
    // the moment the param was stripped.
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('family');
        return next;
      },
      { replace: true },
    );
  }, [familyParam, setSearchParams]);

  // Drop the flash class once the pulse has played out.
  useEffect(() => {
    if (!flashFamily) return;
    const id = setTimeout(() => setFlashFamily(null), FLASH_MS);
    return () => clearTimeout(id);
  }, [flashFamily]);

  // Scroll the flashed row into view. Ref callback rather than an
  // effect + query: the row may not exist on the first commit (filters,
  // async data), and this fires exactly when it mounts.
  const scrolledForRef = useRef<string | null>(null);
  const attachFlash = useCallback(
    (node: HTMLLIElement | null) => {
      if (!node || !flashFamily) return;
      if (scrolledForRef.current === flashFamily) return;
      scrolledForRef.current = flashFamily;
      node.scrollIntoView({ block: 'center' });
    },
    [flashFamily],
  );
  const personalByColor = useMemo(
    () => ({
      white: buildPersonalOpeningStats(games ?? [], 'white'),
      black: buildPersonalOpeningStats(games ?? [], 'black'),
    }),
    [games],
  );

  const filteredFamilies = useMemo(() => {
    const q = query.trim().toLowerCase();
    const sorted = sortFamilies(FAMILIES_ALPHA, sort);
    return sorted.filter((f) => {
      // Keep a deep-linked / currently selected family visible even if
      // the active color/search filter would otherwise hide it.
      if (selectedFamily && f.family === selectedFamily) return true;
      if (colorFilter !== 'all' && f.color !== colorFilter) return false;
      if (q && !f.family.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [query, colorFilter, sort, selectedFamily]);

  const totalLines = useMemo(
    () => FAMILIES_ALPHA.reduce((n, f) => n + f.count, 0),
    [],
  );

  const searchResults = useMemo(() => {
    if (query.trim().length < 2) return [];
    const all = searchOpenings(query, 80);
    return colorFilter === 'all'
      ? all.slice(0, 40)
      : all.filter((r) => colorHint(r) === colorFilter).slice(0, 40);
  }, [query, colorFilter]);

  const recommendedVariations = useMemo(() => {
    if (!selectedFamily) return [];
    return rankOpeningLines(
      getVariations(selectedFamily),
      personalByColor[familyColor(selectedFamily)],
    );
  }, [selectedFamily, personalByColor]);

  const rankedVariations = useMemo(() => {
    if (variationSort === 'recommended') return recommendedVariations;
    return [...recommendedVariations].sort((a, b) => {
      if (variationSort === 'global') {
        return b.line.globalGames - a.line.globalGames || a.line.name.localeCompare(b.line.name);
      }
      if (variationSort === 'personal') {
        return b.personalCount - a.personalCount || b.line.globalGames - a.line.globalGames;
      }
      if (variationSort === 'shortest') {
        return a.line.uci.length - b.line.uci.length || a.line.name.localeCompare(b.line.name);
      }
      return a.line.name.localeCompare(b.line.name);
    });
  }, [recommendedVariations, variationSort]);

  function pickLine(line: OpeningLine) {
    setSelectedLine(line);
    setPly(line.uci.length);
  }

  const { fens, sans } = useMemo(
    () => (selectedLine ? replayLine(selectedLine) : { fens: [], sans: [] }),
    [selectedLine],
  );

  const currentFen = fens[ply] ?? fens[0] ?? '';
  const lastUci =
    selectedLine && ply > 0 ? selectedLine.uci[ply - 1] : undefined;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('openings.title')}</h1>
        <p className="text-sm text-text-muted">
          {t('openings.subtitle', { count: totalLines })}
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[340px_minmax(0,1fr)] gap-4 items-start">
        <aside className="card p-3 space-y-3">
          <input
            className="input"
            placeholder={t('openings.searchPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />

          <div className="flex gap-1 text-xs">
            <ColorFilterButton
              label={t('openings.bothSides')}
              active={colorFilter === 'all'}
              onClick={() => setColorFilter('all')}
            />
            <ColorFilterButton
              label={t('openings.asWhite')}
              active={colorFilter === 'white'}
              onClick={() => setColorFilter('white')}
              color="white"
            />
            <ColorFilterButton
              label={t('openings.asBlack')}
              active={colorFilter === 'black'}
              onClick={() => setColorFilter('black')}
              color="black"
            />
          </div>

          <label className="flex items-center gap-2 text-xs text-text-muted">
            <span className="shrink-0">{t('openings.sortBy')}</span>
            <select
              className="input text-xs py-1 flex-1"
              value={sort}
              onChange={(e) => setSort(e.target.value as FamilySort)}
            >
              <option value="popular">{t('openings.sort.popular')}</option>
              <option value="most-lines">{t('openings.sort.mostLines')}</option>
              <option value="fewest-lines">{t('openings.sort.fewestLines')}</option>
              <option value="alpha">{t('openings.sort.alpha')}</option>
            </select>
          </label>

          {searchResults.length > 0 && (
            <div className="space-y-1 border-b border-border pb-2">
              <div className="text-xs uppercase tracking-wide text-text-muted">
                {t('openings.searchResults')}
              </div>
              <ul className="max-h-48 overflow-auto divide-y divide-border scrollable pr-2">
                {searchResults.map((r) => (
                  <li key={r.name}>
                    <button
                      type="button"
                      onClick={() => pickLine(r)}
                      className="w-full text-left py-1 text-sm hover:text-accent flex items-center gap-2"
                    >
                      <ColorBadge color={colorHint(r)} size="xs" />
                      <span className="font-mono text-xs text-text-muted">
                        {r.eco}
                      </span>
                      <span className="truncate flex-1">{r.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <div className="text-xs uppercase tracking-wide text-text-muted mb-1">
              {t('openings.families', { count: filteredFamilies.length })}
            </div>
            <ul className="max-h-[60vh] overflow-auto divide-y divide-border scrollable pr-2">
              {filteredFamilies.map((f) => (
                <li
                  key={f.family}
                  ref={flashFamily === f.family ? attachFlash : undefined}
                  className={
                    flashFamily === f.family ? 'flash-highlight rounded-md' : undefined
                  }
                >
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedFamily(f.family);
                      setSelectedLine(null);
                      setPly(0);
                    }}
                    className={`w-full flex items-center gap-2 px-1 py-1 text-sm text-left hover:text-accent ${
                      selectedFamily === f.family ? 'text-accent' : ''
                    }`}
                  >
                    <ColorBadge color={f.color} size="xs" />
                    <span className="truncate flex-1">{f.family}</span>
                    <span className="text-xs text-text-muted font-mono shrink-0">
                      {f.count}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </aside>

        <section className="space-y-3 min-w-0">
          {selectedLine ? (
            <LinePreview
              line={selectedLine}
              fens={fens}
              sans={sans}
              currentFen={currentFen}
              lastUci={lastUci}
              ply={ply}
              onPly={setPly}
            />
          ) : selectedFamily ? (
            <VariationsList
              family={selectedFamily}
              ranked={rankedVariations}
              recommended={recommendedVariations}
              sort={variationSort}
              onSort={setVariationSort}
              onPick={pickLine}
            />
          ) : (
            <div className="card p-8 text-sm text-text-muted text-center">
              {t('openings.pickFamilyAbove')} <span className="lg:hidden">{t('openings.above')}</span>
              <span className="hidden lg:inline">{t('openings.toTheLeft')}</span>{t('openings.orSearch')}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function VariationsList({
  family,
  ranked,
  recommended,
  sort,
  onSort,
  onPick,
}: {
  family: string;
  ranked: RankedOpeningLine[];
  recommended: RankedOpeningLine[];
  sort: 'recommended' | 'global' | 'personal' | 'shortest' | 'alpha';
  onSort: (sort: 'recommended' | 'global' | 'personal' | 'shortest' | 'alpha') => void;
  onPick: (line: OpeningLine) => void;
}) {
  const { t } = useTranslation();
  const color = familyColor(family);
  const description = familyDescription(family);
  const starterKeys = new Set(
    recommended.slice(0, 5).map((entry) => openingLineKey(entry.line.uci)),
  );
  return (
    <div className="card p-3 space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <ColorBadge color={color} />
          <h2 className="text-lg font-medium truncate">{family}</h2>
        </div>
        <div className="text-xs text-text-muted shrink-0">
          {t('openings.linesCount', { count: ranked.length })}
        </div>
      </div>
      {description && (
        <FamilyDescriptionCard description={description} variant="inline" />
      )}
      <div className="text-sm text-text-muted">
        {color === 'white' ? t('openings.youPlayWhite') : t('openings.youPlayBlack')}
      </div>
      <div className="flex justify-between items-center gap-2 flex-wrap">
        <label className="flex items-center gap-2 text-xs text-text-muted">
          <span>{t('openings.sortBy')}</span>
          <select
            className="input text-xs py-1"
            value={sort}
            onChange={(event) => onSort(event.target.value as typeof sort)}
          >
            <option value="recommended">{t('openings.lineSort.recommended')}</option>
            <option value="global">{t('openings.lineSort.global')}</option>
            <option value="personal">{t('openings.lineSort.personal')}</option>
            <option value="shortest">{t('openings.lineSort.shortest')}</option>
            <option value="alpha">{t('openings.lineSort.alpha')}</option>
          </select>
        </label>
        <AddFamilyButton family={family} recommended={recommended} />
      </div>
      <ul className="divide-y divide-border max-h-[70vh] overflow-auto scrollable pr-2">
        {ranked.map((entry) => {
          const v = entry.line;
          const isStarter = starterKeys.has(openingLineKey(v.uci));
          return (
          <li key={openingLineKey(v.uci)}>
            <button
              type="button"
              onClick={() => onPick(v)}
              className="w-full py-2 flex items-baseline gap-3 text-left hover:text-accent"
            >
              <span className="font-mono text-xs text-text-muted w-10 shrink-0">
                {v.eco}
              </span>
              <span className="flex-1 truncate">
                {isStarter && (
                  <span className="mr-2 text-[10px] uppercase tracking-wide text-accent">
                    {t('openings.starterBadge')}
                  </span>
                )}
                {v.variation || <em className="text-text-muted">{t('openings.mainLine')}</em>}
              </span>
              <span className="text-right text-xs text-text-muted shrink-0">
                {entry.personalCount > 0 && (
                  <span className="block">
                    {t('openings.seenInYourGames', { count: entry.personalCount })}
                  </span>
                )}
                <span className="block">
                  {t('openings.plyCount', { count: v.uci.length })}
                </span>
              </span>
            </button>
          </li>
          );
        })}
      </ul>
    </div>
  );
}

function ColorFilterButton({
  label,
  active,
  onClick,
  color,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  color?: Color;
}) {
  const dot = color === 'white' ? 'bg-white' : color === 'black' ? 'bg-black border border-text/40' : '';
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1 px-2 py-1 rounded-md border ${
        active
          ? 'bg-accent/20 border-accent/50 text-accent'
          : 'border-border text-text-muted hover:text-text'
      }`}
    >
      {dot && <span className={`inline-block w-2 h-2 rounded-full ${dot}`} />}
      {label}
    </button>
  );
}

function LinePreview({
  line,
  fens,
  sans,
  currentFen,
  lastUci,
  ply,
  onPly,
}: {
  line: OpeningLine;
  fens: string[];
  sans: string[];
  currentFen: string;
  lastUci?: string;
  ply: number;
  onPly: (ply: number) => void;
}) {
  const { t } = useTranslation();
  const hint = colorHint(line);

  return (
    <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_320px] gap-4 items-start">
      <div className="space-y-2">
        <div
          className={`flex items-center gap-2 px-3 py-2 rounded-md border ${
            hint === 'white'
              ? 'bg-white/5 border-white/30'
              : 'bg-black/30 border-black/60'
          }`}
        >
          <ColorBadge color={hint} />
          <div className="text-sm">
            {hint === 'white' ? t('openings.youAreWhite') : t('openings.youAreBlack')}
          </div>
        </div>
        <BoardFrame
          board={
            <Board
              fen={currentFen}
              orientation={hint}
              lastMoveUci={lastUci}
              viewOnly
            />
          }
        />
        <div className="flex items-center gap-1 text-sm">
          <button className="btn" onClick={() => onPly(0)}>⏮</button>
          <button className="btn" onClick={() => onPly(Math.max(0, ply - 1))}>◀</button>
          <button
            className="btn"
            onClick={() => onPly(Math.min(fens.length - 1, ply + 1))}
          >
            ▶
          </button>
          <button className="btn" onClick={() => onPly(fens.length - 1)}>⏭</button>
          <div className="ml-auto text-text-muted text-xs">
            {t('openings.ply', { idx: ply, total: fens.length - 1 })}
          </div>
        </div>
      </div>

      <aside className="space-y-3">
        <div className="card p-3 space-y-1">
          <div className="text-xs uppercase tracking-wide text-text-muted flex justify-between items-center">
            <span className="truncate">{line.family}</span>
            <span className="font-mono">{line.eco}</span>
          </div>
          <div className="text-sm">
            {line.variation || <em className="text-text-muted">{t('openings.mainLine')}</em>}
          </div>
        </div>

        <FamilyDescriptionCard
          description={familyDescription(line.family)}
          variant="card"
        />

        <MoveListPreview sans={sans} currentPly={ply} onPly={onPly} />

        <AddToRepertoirePanel line={line} defaultColor={hint} />
      </aside>
    </div>
  );
}



/**
 * Plain-English blurb for a family. Two render modes:
 *   - `inline`: lives directly inside the variations-list card, no
 *               outer card chrome (just a subtle label + paragraph).
 *   - `card`:   stands alone as its own card in the right aside on the
 *               line preview pane. Used when the user has already
 *               clicked into a specific line and we want the
 *               description to be the second card after the title.
 *
 * Returns `null` when no description has been authored — never renders
 * an empty card. Truthy-only consumers (e.g. inside `VariationsList`)
 * already gate the call site with `description &&`, but we belt-and-
 * suspenders here too so any future caller that forgets the guard
 * still does the right thing.
 */
function FamilyDescriptionCard({
  description,
  variant,
}: {
  description: string;
  variant: 'inline' | 'card';
}) {
  const { t } = useTranslation();
  if (!description) return null;
  if (variant === 'card') {
    return (
      <div className="card p-3 space-y-1">
        <div className="text-xs uppercase tracking-wide text-text-muted">
          {t('openings.aboutThisOpening')}
        </div>
        <p className="text-sm leading-relaxed">{description}</p>
      </div>
    );
  }
  return (
    <div className="rounded-md border border-border/50 bg-bg-raised/40 px-3 py-2 space-y-1">
      <div className="text-[11px] uppercase tracking-wide text-text-muted">
        {t('openings.aboutThisOpening')}
      </div>
      <p className="text-sm leading-relaxed">{description}</p>
    </div>
  );
}

function MoveListPreview({
  sans,
  currentPly,
  onPly,
}: {
  sans: string[];
  currentPly: number;
  onPly: (ply: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="card p-3 space-y-1">
      <div className="text-xs uppercase tracking-wide text-text-muted">{t('openings.moves')}</div>
      <div className="flex flex-wrap gap-x-2 gap-y-0.5 font-mono text-sm">
        {sans.map((san, i) => {
          const moveNumber = Math.floor(i / 2) + 1;
          const isWhite = i % 2 === 0;
          return (
            <span key={i}>
              {isWhite && (
                <span className="text-text-muted mr-0.5">{moveNumber}.</span>
              )}
              <button
                type="button"
                onClick={() => onPly(i + 1)}
                className={`hover:text-accent ${
                  currentPly === i + 1 ? 'text-accent' : ''
                }`}
              >
                {san}
              </button>
            </span>
          );
        })}
      </div>
    </div>
  );
}

/**
 * "Add this line to its family repertoire" CTA. Family-first: we
 * auto-create (or reuse) the repertoire bound to this line's family
 * via `ensureFamilyRepertoire(family)`. There is intentionally NO
 * picker — a Sicilian Najdorf line always lands in the user's "Sicilian
 * Defense" repertoire, never in some unrelated bucket.
 *
 * Pre-refactor this component had a "Add to which repertoire?"
 * dropdown that let the user route a Najdorf line into "My Black
 * Repertoire" alongside an unrelated French line. That mixed-bucket
 * model is what the v10 wipe + family refactor explicitly removes.
 */
function AddToRepertoirePanel({
  line,
}: {
  line: OpeningLine;
  defaultColor: Color;
}) {
  const { t } = useTranslation();
  const family = line.family;
  const color = familyColor(family);
  const [status, setStatus] = useState<{ msg: string; repId?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleAdd() {
    if (busy) return;
    setBusy(true);
    setStatus(null);
    try {
      const rep = await ensureFamilyRepertoire(family);
      const { movesAdded: added } = await addGuidedLinesToRepertoire(rep.id, [line]);
      setStatus({
        msg:
          added > 0
            ? t('openings.addedNew', { count: added, family })
            : t('openings.alreadyIn', { family }),
        repId: rep.id,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-wide text-text-muted">
          {t('openings.addTo', { family })}
        </div>
        <ColorBadge color={color} size="xs" />
      </div>
      <p className="text-xs text-text-muted">
        {t('openings.addLineDesc')}
      </p>
      <button
        type="button"
        className="btn-primary w-full"
        onClick={handleAdd}
        disabled={busy}
      >
        {busy ? t('openings.adding') : t('openings.addLine')}
      </button>
      {status && (
        <div className="text-xs text-text-muted flex items-center justify-between gap-2 flex-wrap">
          <span>{status.msg}</span>
          {status.repId && (
            <Link
              to={`/repertoire/${encodeURIComponent(status.repId)}/drill`}
              className="text-accent hover:underline shrink-0"
            >
              {t('openings.practice')}
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

function AddFamilyButton({
  family,
  recommended,
}: {
  family: string;
  recommended: RankedOpeningLine[];
}) {
  const { t } = useTranslation();
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [msg, setMsg] = useState<{ text: string; repId?: string } | null>(null);
  const [guidedBusy, setGuidedBusy] = useState(false);
  // Always the hybrid recommender's top five — independent of list sort.
  const starter = recommended.slice(0, 5);

  // Live coverage check: a family-bound repertoire stamps itself with
  // `bulkLoadedAt` the moment "Add every line" finishes. We mirror that
  // flag in the button state so revisiting the openings page doesn't
  // re-offer a no-op click. The query reactively re-fires on any
  // `repertoires` write — including the implicit delete from
  // `RepertoirePage` — so blowing away the rep re-enables the button.
  //
  // We don't try to detect partial coverage by counting nodes vs.
  // expected FENs: chess.js's halfmove-clock semantics differ between
  // a continuous walk and `load(parentFen)+move(uci)`, which made an
  // earlier FEN-set comparison flag every fully-bulk-loaded family as
  // "1 fen short". `bulkLoadedAt` is the unambiguous signal.
  const familyRep = useLiveQuery(async () => {
    const candidates = await db.repertoires
      .where('color')
      .equals(familyColor(family))
      .toArray();
    return (
      candidates.find((r) => r.kind === 'family' && r.family === family) ?? null
    );
  }, [family]);

  const fullyCovered = familyRep?.bulkLoadedAt != null;
  const guidedCount = familyRep?.activeLineKeys?.length ?? 0;

  async function handleGuidedAdd() {
    if (guidedBusy) return;
    setGuidedBusy(true);
    setMsg(null);
    try {
      const rep = await ensureFamilyRepertoire(family);
      const { movesAdded, activeLineKeys } = await addGuidedLinesToRepertoire(
        rep.id,
        starter.map((entry) => entry.line),
      );
      setMsg({
        text: t('openings.guidedAdded', {
          count: activeLineKeys.length,
          moves: movesAdded,
          family,
        }),
        repId: rep.id,
      });
    } finally {
      setGuidedBusy(false);
    }
  }

  async function handleBulkAdd() {
    setMsg(null);
    const rep = await ensureFamilyRepertoire(family);
    const total = await addFamilyToRepertoire(rep.id, family, (done, total) => {
      setProgress({ done, total });
    });
    setProgress(null);
    setMsg({
      text: t('openings.addedAcrossFamily', { count: total, family }),
      repId: rep.id,
    });
  }

  const disabled = progress !== null || fullyCovered;
  const label = progress
    ? t('openings.addingProgress', { done: progress.done, total: progress.total })
    : fullyCovered
      ? t('openings.allLinesAdded')
      : t('openings.addEveryLine', { family });

  return (
    <div className="rounded-md border border-accent/30 bg-accent/5 p-3 space-y-3 w-full">
      <div>
        <div className="text-sm font-medium">{t('openings.guidedTitle')}</div>
        <p className="text-xs text-text-muted">{t('openings.guidedDescription')}</p>
      </div>
      <ol className="grid gap-1 text-xs">
        {starter.map((entry, index) => (
          <li key={openingLineKey(entry.line.uci)} className="flex items-center gap-2">
            <span className="font-mono text-text-muted w-4">{index + 1}.</span>
            <span className="truncate flex-1">
              {entry.line.variation || t('openings.mainLine')}
            </span>
            <span className="text-text-muted shrink-0">
              {entry.personalCount > 0
                ? t('openings.seenShort', { count: entry.personalCount })
                : t('openings.globalPick')}
            </span>
          </li>
        ))}
      </ol>
      <button
        type="button"
        className="btn-primary text-xs"
        onClick={handleGuidedAdd}
        disabled={starter.length === 0 || guidedCount > 0 || guidedBusy}
      >
        {guidedBusy
          ? t('openings.adding')
          : guidedCount > 0
          ? t('openings.guidedActive', { count: guidedCount })
          : t('openings.startGuided', { count: starter.length })}
      </button>
      <details className="text-xs text-text-muted">
        <summary className="cursor-pointer hover:text-text">
          {t('openings.advancedImport')}
        </summary>
        <div className="pt-2 space-y-2">
          <p>{t('openings.advancedImportWarning')}</p>
          <button
            type="button"
            className="btn text-xs w-full"
            onClick={handleBulkAdd}
            disabled={disabled}
          >
            {label}
          </button>
        </div>
      </details>
      {msg && (
        <div className="text-xs text-text-muted flex items-center justify-between gap-2">
          <span>{msg.text}</span>
          {msg.repId && (
            <Link
              to={`/repertoire/${encodeURIComponent(msg.repId)}/drill`}
              className="text-accent hover:underline shrink-0"
            >
              {t('openings.practice')}
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
