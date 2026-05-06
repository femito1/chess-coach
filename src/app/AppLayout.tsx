import { Link, NavLink, Outlet } from 'react-router-dom';
import { QueueIndicator } from '@/engine/QueueIndicator';
import { BootBanner } from '@/engine/BootBanner';
import { useEffect } from 'react';
import { startAnalysisQueue } from '@/engine/queue';
import { ProfileChip } from './ProfileChip';
import { ProfileSyncBanner } from '@/features/auth/ProfileSyncBanner';

export function AppLayout() {
  useEffect(() => {
    startAnalysisQueue();
  }, []);

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-border bg-bg-soft/60 backdrop-blur sticky top-0 z-10">
        <div className="max-w-7xl mx-auto flex items-center gap-4 px-6 h-14">
          <Link
            to="/dashboard"
            className="font-semibold tracking-tight hover:text-accent transition-colors whitespace-nowrap shrink-0"
          >
            <span className="text-accent">♞</span> Chess Coach
          </Link>
          <nav className="flex items-center gap-1 text-sm">
            <NavItem to="/dashboard">Dashboard</NavItem>
            <NavItem to="/import">Import</NavItem>
            <NavItem to="/games">Games</NavItem>
            <NavItem to="/weaknesses">Weaknesses</NavItem>
            <NavItem to="/puzzles">Puzzles</NavItem>
            <NavItem to="/repertoire">Repertoire</NavItem>
            <NavItem to="/openings">Openings</NavItem>
            <NavItem to="/settings">Settings</NavItem>
          </nav>
          <div className="ml-auto shrink-0">
            <ProfileChip />
          </div>
        </div>
      </header>
      {/* Renders nothing in the steady state; surfaces only when a
          different Clerk user signs in on this browser profile. */}
      <ProfileSyncBanner />
      <main className="flex-1">
        <div className="max-w-7xl mx-auto px-6 py-8">
          <Outlet />
        </div>
      </main>
      {/* Floating queue status — outside the header flex so its width
          changes can never reflow the nav or profile chip. */}
      <QueueIndicator />
      {/* Boot-time housekeeping spinner. Self-hides when the slow
          passes are done (or never appears at all on warm boots). */}
      <BootBanner />
    </div>
  );
}

function NavItem({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `px-3 py-1.5 rounded-md transition-colors ${
          isActive
            ? 'bg-accent/20 text-accent'
            : 'text-text-muted hover:text-text hover:bg-bg-raised'
        }`
      }
    >
      {children}
    </NavLink>
  );
}
