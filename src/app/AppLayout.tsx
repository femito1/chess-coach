import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { QueueIndicator } from '@/engine/QueueIndicator';
import { BootBanner } from '@/engine/BootBanner';
import { useEffect, useState } from 'react';
import { startAnalysisQueue } from '@/engine/queue';
import { ProfileChip } from './ProfileChip';
import { ProfileSyncBanner } from '@/features/auth/ProfileSyncBanner';
import { NewGamesBanner } from '@/features/import/NewGamesBanner';

const NAV_ITEMS: { to: string; label: string }[] = [
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/import', label: 'Import' },
  { to: '/games', label: 'Games' },
  { to: '/weaknesses', label: 'Weaknesses' },
  { to: '/puzzles', label: 'Puzzles' },
  { to: '/repertoire', label: 'Repertoire' },
  { to: '/openings', label: 'Openings' },
  { to: '/settings', label: 'Settings' },
];

export function AppLayout() {
  useEffect(() => {
    startAnalysisQueue();
  }, []);

  // Mobile menu open/closed. Drawer sits below the header on `< md`
  // viewports — at `md` and up the inline nav is rendered and this
  // state is ignored. Auto-closes whenever the route changes (the
  // `useLocation`-keyed effect below) so a tap on a nav item dismisses
  // the drawer in the same gesture.
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  return (
    <div className="min-h-screen flex flex-col">
      {/* Tightened chrome: the page used to ship with `h-14` (56 px)
          header + `py-8` (64 px combined) main padding, which pushed
          the first row of every page ~120 px below the viewport top.
          On data-dense pages (Review, Weaknesses, Puzzles) that left
          the actual board / first card cramped against the bottom of
          the viewport. Slimming the header to `h-12` and the main
          padding to `pt-5 pb-12` reclaims ~24 px above the fold
          without eating into vertical rhythm between sections. The
          container also widens to `max-w-screen-2xl` (1536 px) so
          21" / ultrawide users don't get a narrow centered column
          with massive left/right gutters.

          On `< md` viewports (phones), the eight nav items would wrap
          past the right edge of the screen, so we render a hamburger
          button + slide-down drawer instead. The drawer is a sibling
          of the header bar (inside the same sticky <header>) so it
          covers the page chrome below it without pushing content. */}
      <header className="border-b border-border bg-bg-soft/60 backdrop-blur sticky top-0 z-20">
        <div className="max-w-screen-2xl mx-auto flex items-center gap-3 px-4 lg:px-8 h-12">
          <Link
            to="/dashboard"
            className="font-semibold tracking-tight hover:text-accent transition-colors whitespace-nowrap shrink-0"
          >
            <span className="text-accent">♞</span> Chess Coach
          </Link>
          {/* Desktop inline nav: visible at `lg` and up (1024 px). The
              eight items + logo + profile chip need ≥ ~880 px to fit on
              one row; at the previous `md:` (768 px) breakpoint the
              header overflowed by ~114 px and pushed every page off the
              right edge in tablet portrait. Audited via the
              `mobile-audit` test across 360 / 375 / 390 / 768 / Pixel-7
              viewports. */}
          <nav className="hidden lg:flex items-center gap-1 text-sm">
            {NAV_ITEMS.map((item) => (
              <NavItem key={item.to} to={item.to}>
                {item.label}
              </NavItem>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2 shrink-0">
            <ProfileChip />
            {/* Hamburger toggle: shown on phones AND tablet portrait
                (anything below `lg`). Hidden on desktop because the
                inline nav above already shows every link. */}
            <button
              type="button"
              className="lg:hidden inline-flex items-center justify-center w-9 h-9 rounded-md border border-border text-text hover:border-accent/60 hover:text-accent transition-colors"
              aria-expanded={menuOpen}
              aria-controls="mobile-nav"
              aria-label={menuOpen ? 'Close navigation' : 'Open navigation'}
              onClick={() => setMenuOpen((o) => !o)}
            >
              {menuOpen ? <CloseIcon /> : <MenuIcon />}
            </button>
          </div>
        </div>
        {/* Drawer: phones + tablet portrait. Inline-stacked NavLinks;
            the `useLocation` effect closes it whenever the route
            changes, so tapping a link both navigates and dismisses the
            drawer. Only mounted below `lg` — desktop ignores
            `menuOpen`. */}
        {menuOpen && (
          <nav
            id="mobile-nav"
            className="lg:hidden border-t border-border bg-bg-soft/95 backdrop-blur"
          >
            <div className="max-w-screen-2xl mx-auto px-2 py-2 flex flex-col gap-1">
              {NAV_ITEMS.map((item) => (
                <MobileNavItem key={item.to} to={item.to}>
                  {item.label}
                </MobileNavItem>
              ))}
            </div>
          </nav>
        )}
      </header>
      {/* Renders nothing in the steady state; surfaces only when a
          different Clerk user signs in on this browser profile. */}
      <ProfileSyncBanner />
      {/* Self-checks Chess.com once per browser session for games
          played since the last import; shows nothing on the steady
          ("all caught up") path. */}
      <NewGamesBanner />
      <main className="flex-1">
        <div className="max-w-screen-2xl mx-auto px-4 lg:px-8 pt-5 pb-12">
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

function MobileNavItem({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        // Bigger tap target than the desktop NavItem (44 px-ish vs
        // ~32 px) — Apple HIG / Material both call this out as the
        // minimum comfortable touch size.
        `px-3 py-2.5 rounded-md text-sm transition-colors ${
          isActive
            ? 'bg-accent/20 text-accent'
            : 'text-text hover:bg-bg-raised'
        }`
      }
    >
      {children}
    </NavLink>
  );
}

function MenuIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <line x1="4" y1="7" x2="20" y2="7" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="17" x2="20" y2="17" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </svg>
  );
}
