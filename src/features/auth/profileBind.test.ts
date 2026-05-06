import { describe, expect, it } from 'vitest';
import { decideBindAction, type CloudProfile } from './profileBind';

const clerk = (userId = 'user_abc', displayName?: string) => ({ userId, displayName });
const cloud = (overrides: Partial<CloudProfile> = {}): CloudProfile => ({
  id: 'user_abc',
  display_name: null,
  chesscom_username: null,
  lichess_username: null,
  ...overrides,
});

describe('decideBindAction', () => {
  it('refuses if a different Clerk user is bound to this device', () => {
    const action = decideBindAction(
      clerk('user_NEW'),
      cloud({ id: 'user_NEW' }),
      { username: 'magnus', boundClerkUserId: 'user_OLD' },
    );
    expect(action.kind).toBe('refuseMismatch');
    if (action.kind === 'refuseMismatch') {
      expect(action.boundClerkUserId).toBe('user_OLD');
      expect(action.attemptedClerkUserId).toBe('user_NEW');
    }
  });

  it('first sign-in with a local username pushes it into a fresh profile', () => {
    const action = decideBindAction(
      clerk('user_abc', 'Alice'),
      null,
      { username: 'magnus' },
    );
    expect(action.kind).toBe('insertProfile');
    if (action.kind === 'insertProfile') {
      expect(action.profile.id).toBe('user_abc');
      expect(action.profile.display_name).toBe('Alice');
      expect(action.profile.chesscom_username).toBe('magnus');
      expect(action.bindClerkUserId).toBe('user_abc');
    }
  });

  it('first sign-in with no local username inserts an empty profile', () => {
    const action = decideBindAction(
      clerk('user_abc'),
      null,
      { username: '' },
    );
    expect(action.kind).toBe('insertProfile');
    if (action.kind === 'insertProfile') {
      expect(action.profile.chesscom_username).toBeNull();
    }
  });

  it('returning user with matching local + cloud username is a no-op bind', () => {
    const action = decideBindAction(
      clerk('user_abc'),
      cloud({ chesscom_username: 'magnus' }),
      { username: 'magnus' },
    );
    expect(action.kind).toBe('bindOnly');
  });

  it('cloud-only profile pulls into local on fresh device', () => {
    const action = decideBindAction(
      clerk('user_abc'),
      cloud({ chesscom_username: 'magnus' }),
      { username: '' },
    );
    expect(action.kind).toBe('pullUsernameFromCloud');
    if (action.kind === 'pullUsernameFromCloud') {
      expect(action.chesscomUsername).toBe('magnus');
    }
  });

  it('local-only username pushes to an existing empty cloud profile', () => {
    const action = decideBindAction(
      clerk('user_abc'),
      cloud({ chesscom_username: null }),
      { username: 'magnus' },
    );
    expect(action.kind).toBe('pushUsernameToCloud');
    if (action.kind === 'pushUsernameToCloud') {
      expect(action.chesscomUsername).toBe('magnus');
    }
  });

  it('cloud and local disagree: cloud wins', () => {
    // The bound user already matches Clerk, both sides are non-empty,
    // they disagree → cloud wins (cross-device source of truth).
    const action = decideBindAction(
      clerk('user_abc'),
      cloud({ chesscom_username: 'hikaru' }),
      { username: 'magnus', boundClerkUserId: 'user_abc' },
    );
    expect(action.kind).toBe('pullUsernameFromCloud');
    if (action.kind === 'pullUsernameFromCloud') {
      expect(action.chesscomUsername).toBe('hikaru');
    }
  });

  it('whitespace-only fields are treated as empty', () => {
    const action = decideBindAction(
      clerk('user_abc'),
      cloud({ chesscom_username: '  ' }),
      { username: '   ' },
    );
    expect(action.kind).toBe('bindOnly');
  });

  it('returning device with same user already bound is steady-state when names match', () => {
    const action = decideBindAction(
      clerk('user_abc'),
      cloud({ chesscom_username: 'magnus' }),
      { username: 'magnus', boundClerkUserId: 'user_abc' },
    );
    expect(action.kind).toBe('bindOnly');
  });

  it('mismatch refusal trumps everything else', () => {
    // Even when local and cloud are perfectly aligned, a mismatched
    // boundClerkUserId still produces refusal — we never silently
    // re-bind to a different user.
    const action = decideBindAction(
      clerk('user_NEW'),
      cloud({ id: 'user_NEW', chesscom_username: 'magnus' }),
      { username: 'magnus', boundClerkUserId: 'user_OLD' },
    );
    expect(action.kind).toBe('refuseMismatch');
  });
});
