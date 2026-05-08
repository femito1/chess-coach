import { Link } from 'react-router-dom';

/**
 * Public privacy policy page.
 *
 * Why this exists separately from the rest of the app:
 *   - The Chrome Web Store dev-console requires a publicly reachable
 *     URL in the "Privacy policy" field. The reviewer must be able to
 *     load it without signing in, so this route lives outside both
 *     `AuthGate` and `AppLayout` (see `src/app/routes.tsx`).
 *   - A short, accurate, narrowly-scoped page beats a long template
 *     for review purposes — Google specifically rejects extensions
 *     whose privacy policy doesn't match what the extension actually
 *     does. We therefore describe only the data the chrome extension
 *     and the Chess Coach web app touch, and explicitly call out
 *     what we *don't* collect.
 *
 * Update this page whenever:
 *   - The extension asks for a new permission.
 *   - The web app starts collecting telemetry / analytics / cookies
 *     beyond Clerk's auth session.
 *   - The chess.com integration starts pulling more than the public
 *     `published-data` archives.
 */
export function PrivacyPage() {
  return (
    <div className="min-h-screen bg-bg text-text px-6 py-12">
      <div className="max-w-2xl mx-auto">
        <Link
          to="/"
          className="text-sm text-text-muted hover:text-text inline-block mb-8"
        >
          ← Back to Chess Coach
        </Link>

        <h1 className="text-3xl font-semibold tracking-tight mb-2">
          Privacy Policy
        </h1>
        <p className="text-sm text-text-muted mb-8">
          Last updated: May 2026
        </p>

        <section className="space-y-6 text-sm leading-relaxed">
          <p>
            Chess Coach is a personal chess analysis tool you run in your
            browser. We've kept the privacy story short on purpose: there is
            no Chess Coach backend that stores your data, no analytics, no
            advertising tracking, and no third-party data sharing.
          </p>

          <h2 className="text-lg font-semibold mt-8">
            What the web app stores
          </h2>
          <ul className="list-disc pl-6 space-y-2">
            <li>
              <strong>Locally in your browser (IndexedDB):</strong> the games
              you import, the engine evaluations Chess Coach computes for
              them, your repertoire trees, and your puzzle progress. This
              data never leaves your device unless you explicitly export it
              from the Backup page.
            </li>
            <li>
              <strong>Authentication:</strong> we use Clerk to sign you in.
              Clerk holds your email address and any OAuth identifiers
              (Google, GitHub) you choose to link. See{' '}
              <a
                href="https://clerk.com/legal/privacy"
                className="text-accent hover:underline"
                target="_blank"
                rel="noreferrer noopener"
              >
                Clerk's privacy policy
              </a>{' '}
              for what they store about you.
            </li>
            <li>
              <strong>Profile sync (Supabase):</strong> we mirror a tiny
              "profile row" (your Clerk user id and your Chess.com username)
              to Supabase so different devices can recognise the same
              account. Game data and analyses are <em>not</em> synced —
              they live in IndexedDB on whichever device produced them.
            </li>
          </ul>

          <h2 className="text-lg font-semibold mt-8">
            What the Chrome extension stores
          </h2>
          <ul className="list-disc pl-6 space-y-2">
            <li>
              <strong>In <code>chrome.storage.sync</code>:</strong> your
              Chess.com username, the URL of your Chess Coach app, and a
              boolean toggle for whether to show the after-game prompt.
              Nothing else.
            </li>
            <li>
              <strong>What the extension sees:</strong> only the URL and
              DOM of <code>chess.com</code> tabs (it has no permission for
              any other site by default). When you click "Test connection"
              in the options page, it will request one-time permission to
              fetch your configured Chess Coach URL — granted per-host with
              your explicit consent.
            </li>
            <li>
              <strong>What the extension sends:</strong> nothing, anywhere,
              ever. The deep link it builds is a URL navigation in your
              own browser; no data leaves your machine via the extension.
            </li>
          </ul>

          <h2 className="text-lg font-semibold mt-8">
            What we don't do
          </h2>
          <ul className="list-disc pl-6 space-y-2">
            <li>No analytics, tracking pixels, or session-replay tools.</li>
            <li>No advertising. No data brokers.</li>
            <li>
              No selling, renting, or sharing your information with third
              parties.
            </li>
            <li>
              No reading of your <code>chess.com</code> account beyond the
              public game archive you opt into via username — Chess Coach
              uses Chess.com's public API and never asks for your password.
            </li>
          </ul>

          <h2 className="text-lg font-semibold mt-8">
            Deleting your data
          </h2>
          <p>
            Use <strong>Settings → Reset</strong> (or the browser's "Clear
            site data" devtool) to wipe IndexedDB. To remove the Supabase
            profile row, sign out of Clerk and email the address below.
            The extension's stored settings can be cleared by removing the
            extension from <code>chrome://extensions</code>.
          </p>

          <h2 className="text-lg font-semibold mt-8">Contact</h2>
          <p>
            Questions about this policy or about a deletion request: open
            an issue on the Chess Coach repository, or reach out via the
            email listed on the Chrome Web Store listing for this
            extension.
          </p>
        </section>
      </div>
    </div>
  );
}
