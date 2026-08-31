import { Link } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';

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
  const { t } = useTranslation();
  return (
    <div className="min-h-screen bg-bg text-text px-6 py-12">
      <div className="max-w-2xl mx-auto">
        <Link
          to="/"
          className="text-sm text-text-muted hover:text-text inline-block mb-8"
        >
          {t('privacy.back')}
        </Link>

        <h1 className="text-3xl font-semibold tracking-tight mb-2">
          {t('privacy.title')}
        </h1>
        <p className="text-sm text-text-muted mb-8">
          {t('privacy.lastUpdated')}
        </p>

        <section className="space-y-6 text-sm leading-relaxed">
          <p>{t('privacy.intro')}</p>

          <h2 className="text-lg font-semibold mt-8">
            {t('privacy.webStores')}
          </h2>
          <ul className="list-disc pl-6 space-y-2">
            <li>
              <Trans
                i18nKey="privacy.localData"
                components={{ bold: <strong /> }}
              />
            </li>
            <li>
              <Trans
                i18nKey="privacy.auth"
                components={{
                  bold: <strong />,
                  link: (
                    <a
                      href="https://clerk.com/legal/privacy"
                      className="text-accent hover:underline"
                      target="_blank"
                      rel="noreferrer noopener"
                    />
                  ),
                }}
              />
            </li>
            <li>
              <Trans
                i18nKey="privacy.profileSync"
                components={{ bold: <strong />, em: <em /> }}
              />
            </li>
            <li>
              <Trans
                i18nKey="privacy.cloudSync"
                components={{ bold: <strong />, em: <em /> }}
              />
            </li>
          </ul>

          <h2 className="text-lg font-semibold mt-8">
            {t('privacy.extStores')}
          </h2>
          <ul className="list-disc pl-6 space-y-2">
            <li>
              <Trans
                i18nKey="privacy.extSyncStorage"
                components={{ bold: <strong />, code: <code /> }}
              />
            </li>
            <li>
              <Trans
                i18nKey="privacy.extSees"
                components={{ bold: <strong />, code: <code /> }}
              />
            </li>
            <li>
              <Trans
                i18nKey="privacy.extSends"
                components={{ bold: <strong /> }}
              />
            </li>
          </ul>

          <h2 className="text-lg font-semibold mt-8">
            {t('privacy.wontDo')}
          </h2>
          <ul className="list-disc pl-6 space-y-2">
            <li>{t('privacy.noAnalytics')}</li>
            <li>{t('privacy.noAds')}</li>
            <li>{t('privacy.noSelling')}</li>
            <li>
              <Trans
                i18nKey="privacy.noChessReading"
                components={{ code: <code /> }}
              />
            </li>
          </ul>

          <h2 className="text-lg font-semibold mt-8">
            {t('privacy.delete')}
          </h2>
          <p>
            <Trans
              i18nKey="privacy.deleteDesc"
              components={{ bold: <strong />, code: <code /> }}
            />
          </p>

          <h2 className="text-lg font-semibold mt-8">{t('privacy.contact')}</h2>
          <p>{t('privacy.contactDesc')}</p>
        </section>
      </div>
    </div>
  );
}
