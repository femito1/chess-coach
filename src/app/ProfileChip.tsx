import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';

/**
 * Header profile chip. Today this is purely local — it shows the
 * Chess.com username from `Settings` and links to the Backup &
 * restore page (which is also where users manage their data when there
 * isn't a cloud account yet).
 *
 * Phase 2 swaps this for Clerk's `<UserButton />` while keeping the same
 * visual slot and the same "your-data lives here" link.
 */
export function ProfileChip() {
  const settings = useLiveQuery(() => db.settings.get('main'), []);
  const username = settings?.username?.trim() ?? '';
  const initial = username ? username[0]!.toUpperCase() : '?';

  if (!username) {
    return (
      <Link
        to="/import"
        className="flex items-center gap-2 text-xs px-2 py-1 rounded-md border border-border bg-bg-soft hover:text-text text-text-muted transition-colors"
        title="Set a Chess.com username on the Import page"
      >
        <span className="w-5 h-5 rounded-full bg-bg-raised flex items-center justify-center text-[10px]">
          ?
        </span>
        Sign in
      </Link>
    );
  }

  return (
    <Link
      to="/backup"
      className="flex items-center gap-2 text-xs px-2 py-1 rounded-md border border-border bg-bg-soft hover:border-accent/60 transition-colors"
      title={`${username} — manage your data`}
    >
      <span className="w-5 h-5 rounded-full bg-accent/30 text-accent flex items-center justify-center text-[10px] font-semibold">
        {initial}
      </span>
      <span className="font-medium max-w-[120px] truncate">{username}</span>
    </Link>
  );
}
