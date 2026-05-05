import type { Color } from '@/db/schema';

/**
 * Compact "You play White / You play Black" pill, used everywhere a line
 * is listed so the user knows which side gets to study it. The pill is
 * deliberately high-contrast — at sub-1000 ratings, the difference between
 * "preparing for" and "preparing against" an opening is the most common
 * source of confusion.
 */
export function ColorBadge({
  color,
  size = 'sm',
}: {
  color: Color;
  size?: 'sm' | 'xs';
}) {
  const isWhite = color === 'white';
  const sizeClass = size === 'xs' ? 'text-[10px] px-1.5 py-0' : 'text-xs px-1.5 py-0.5';
  const tone = isWhite
    ? 'bg-white/90 text-black border-white/60'
    : 'bg-black/85 text-white border-black/40';
  const dot = isWhite ? 'bg-black/70' : 'bg-white';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border font-medium tracking-tight whitespace-nowrap ${sizeClass} ${tone}`}
      title={isWhite ? 'You play this opening as White' : 'You play this opening as Black'}
    >
      <span className={`inline-block w-1.5 h-1.5 rounded-full ${dot}`} />
      {isWhite ? 'White' : 'Black'}
    </span>
  );
}
