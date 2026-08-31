/**
 * Reads + validates the public env vars needed for Phase 2 auth (Clerk +
 * Supabase). Vite only exposes `VITE_*` vars to the browser, so these are
 * the *only* place the app reaches into `import.meta.env` for auth config.
 *
 * Fails fast at module load time with a clear, actionable error if any of
 * the three is missing. We deliberately throw rather than silently falling
 * back to local-only mode: sign-in is
 * required, so a misconfigured deploy must be a hard failure, not a soft
 * "everyone is anonymous" failure that's easy to miss in code review.
 *
 * See SETUP_AUTH.md for how to obtain these values.
 */

interface AuthEnv {
  clerkPublishableKey: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
}

function readVar(key: string): string | undefined {
  const v = (import.meta.env as Record<string, string | undefined>)[key];
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function buildAuthEnv(): AuthEnv {
  const clerkPublishableKey = readVar('VITE_CLERK_PUBLISHABLE_KEY');
  const supabaseUrl = readVar('VITE_SUPABASE_URL');
  const supabaseAnonKey = readVar('VITE_SUPABASE_ANON_KEY');

  const missing: string[] = [];
  if (!clerkPublishableKey) missing.push('VITE_CLERK_PUBLISHABLE_KEY');
  if (!supabaseUrl) missing.push('VITE_SUPABASE_URL');
  if (!supabaseAnonKey) missing.push('VITE_SUPABASE_ANON_KEY');

  if (missing.length > 0) {
    throw new Error(
      `[env] Missing required auth env vars: ${missing.join(', ')}. ` +
        `Copy .env.example to .env.local and fill in real values. ` +
        `See SETUP_AUTH.md for how to obtain them.`,
    );
  }

  if (!clerkPublishableKey!.startsWith('pk_')) {
    throw new Error(
      `[env] VITE_CLERK_PUBLISHABLE_KEY does not look like a Clerk publishable key ` +
        `(should start with "pk_test_" or "pk_live_"). Got: ${clerkPublishableKey!.slice(0, 8)}...`,
    );
  }

  try {
    const url = new URL(supabaseUrl!);
    if (url.protocol !== 'https:') {
      throw new Error(`expected https, got ${url.protocol}`);
    }
  } catch (err) {
    throw new Error(
      `[env] VITE_SUPABASE_URL is not a valid https URL: ${(err as Error).message}`,
    );
  }

  return {
    clerkPublishableKey: clerkPublishableKey!,
    supabaseUrl: supabaseUrl!,
    supabaseAnonKey: supabaseAnonKey!,
  };
}

export const authEnv: AuthEnv = buildAuthEnv();
