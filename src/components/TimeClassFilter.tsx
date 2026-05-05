import type { TimeClass, TimeClassFilter } from '@/db/schema';
import { availableTimeClasses, labelFor } from '@/lib/timeClass';

export function TimeClassFilterSelect({
  value,
  onChange,
  available,
  allowAll = true,
}: {
  value: TimeClassFilter;
  onChange: (next: TimeClassFilter) => void;
  /** Games or puzzles the filter will run on. Used to hide empty options. */
  available: Array<{ timeClass?: string }>;
  allowAll?: boolean;
}) {
  const present = availableTimeClasses(available);
  // Always show the current value even if the visible list is empty
  // (e.g. user has zero rapid games but filter defaults to rapid).
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
      {allowAll && <option value="all">All time controls</option>}
      {options.map((tc) => (
        <option key={tc} value={tc}>
          {labelFor(tc)}
        </option>
      ))}
    </select>
  );
}
