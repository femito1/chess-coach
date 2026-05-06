import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  _resetBypassSupabaseTables,
  _resetE2EBypassCache,
  getBypassedSupabaseClient,
  isE2EBypass,
  BYPASS_USER_ID,
} from './testAuth';

afterEach(() => {
  _resetE2EBypassCache();
  _resetBypassSupabaseTables();
  vi.unstubAllEnvs();
});

describe('isE2EBypass', () => {
  it('returns false when MODE !== development (production-mode env)', () => {
    vi.stubEnv('MODE', 'production');
    vi.stubEnv('VITE_E2E_AUTH_BYPASS', 'true');
    // Even with the env flag explicitly set, production mode must lock
    // it down. This is the safety contract for shipped builds.
    expect(isE2EBypass()).toBe(false);
  });

  it('returns true in development when VITE_E2E_AUTH_BYPASS=true', () => {
    vi.stubEnv('MODE', 'development');
    vi.stubEnv('VITE_E2E_AUTH_BYPASS', 'true');
    expect(isE2EBypass()).toBe(true);
  });

  it('returns false in development when neither flag nor query is set', () => {
    vi.stubEnv('MODE', 'development');
    vi.stubEnv('VITE_E2E_AUTH_BYPASS', '');
    // jsdom defaults `window.location.search` to '' which means the
    // query-string trigger is also off.
    expect(isE2EBypass()).toBe(false);
  });
});

describe('getBypassedSupabaseClient', () => {
  it('round-trips an insert + select on the profiles table', async () => {
    const supabase = getBypassedSupabaseClient();

    const insertRes = await supabase
      .from('profiles')
      .insert({
        id: BYPASS_USER_ID,
        display_name: 'E2E User',
        chesscom_username: 'e2e',
        lichess_username: null,
      });
    expect(insertRes.error).toBeNull();

    const { data, error } = await supabase
      .from('profiles')
      .select('id, display_name, chesscom_username, lichess_username')
      .eq('id', BYPASS_USER_ID)
      .maybeSingle();

    expect(error).toBeNull();
    expect(data).toEqual({
      id: BYPASS_USER_ID,
      display_name: 'E2E User',
      chesscom_username: 'e2e',
      lichess_username: null,
    });
  });

  it('returns null for a missing profile row', async () => {
    const supabase = getBypassedSupabaseClient();
    const { data, error } = await supabase
      .from('profiles')
      .select('id, display_name, chesscom_username, lichess_username')
      .eq('id', 'never_inserted')
      .maybeSingle();
    expect(error).toBeNull();
    expect(data).toBeNull();
  });

  it('rejects a duplicate insert with code 23505 (matches the real client)', async () => {
    const supabase = getBypassedSupabaseClient();
    await supabase.from('profiles').insert({
      id: BYPASS_USER_ID,
      display_name: null,
      chesscom_username: null,
      lichess_username: null,
    });
    const second = await supabase.from('profiles').insert({
      id: BYPASS_USER_ID,
      display_name: null,
      chesscom_username: null,
      lichess_username: null,
    });
    expect(second.error?.code).toBe('23505');
  });

  it('updates an existing profile via .update().eq("id", ...)', async () => {
    const supabase = getBypassedSupabaseClient();
    await supabase.from('profiles').insert({
      id: BYPASS_USER_ID,
      display_name: 'before',
      chesscom_username: null,
      lichess_username: null,
    });
    const updateRes = await supabase
      .from('profiles')
      .update({ chesscom_username: 'mynewhandle' })
      .eq('id', BYPASS_USER_ID);
    expect(updateRes.error).toBeNull();

    const { data } = await supabase
      .from('profiles')
      .select('id, display_name, chesscom_username, lichess_username')
      .eq('id', BYPASS_USER_ID)
      .maybeSingle();
    expect(data?.chesscom_username).toBe('mynewhandle');
    expect(data?.display_name).toBe('before');
  });

  it('upsert merges into an existing row', async () => {
    const supabase = getBypassedSupabaseClient();
    await supabase.from('profiles').insert({
      id: BYPASS_USER_ID,
      display_name: 'orig',
      chesscom_username: null,
      lichess_username: null,
    });
    const res = await supabase
      .from('profiles')
      .upsert(
        {
          id: BYPASS_USER_ID,
          display_name: 'new',
          chesscom_username: 'fromupsert',
          lichess_username: null,
        },
        { onConflict: 'id' },
      );
    expect(res.error).toBeNull();

    const { data } = await supabase
      .from('profiles')
      .select('id, display_name, chesscom_username, lichess_username')
      .eq('id', BYPASS_USER_ID)
      .maybeSingle();
    expect(data).toEqual({
      id: BYPASS_USER_ID,
      display_name: 'new',
      chesscom_username: 'fromupsert',
      lichess_username: null,
    });
  });
});
