import { describe, expect, it } from 'vitest';
import { shouldResetOnboardingOnBind } from './useProfileSync';

/**
 * Pure-logic regression guard for Pass 4.6: when a *different* Clerk
 * user binds to a device that's already bound to someone else, we wipe
 * `onboardingCompletedAt` so the new user is walked through the
 * wizard. Fresh devices (no prior bind) and same-user re-binds must NOT
 * trigger the reset — see the comment on `shouldResetOnboardingOnBind`
 * for the loop hazard if we got this wrong.
 */
describe('shouldResetOnboardingOnBind', () => {
  it('does NOT reset on a fresh device (prior is undefined)', () => {
    // First sign-in ever: no prior bound user. Must keep onboarding
    // state so a "skip — do this later" exit isn't immediately
    // undone by the bind that follows.
    expect(shouldResetOnboardingOnBind(undefined, 'user_123')).toBe(false);
  });

  it('does NOT reset when the same user rebinds (idempotent re-handshake)', () => {
    // Same Clerk user, same device — re-running the handshake (e.g.
    // on a new tab) must not flip the user back into onboarding.
    expect(shouldResetOnboardingOnBind('user_123', 'user_123')).toBe(false);
  });

  it('DOES reset when a different Clerk user binds the same device', () => {
    // The cross-user case: laptop was bound to alice; bob signs in.
    // Onboarding should re-run for bob.
    expect(shouldResetOnboardingOnBind('user_alice', 'user_bob')).toBe(true);
  });

  it('treats empty-string and undefined as distinct prior states', () => {
    // Defensive: if `priorBoundUserId` somehow surfaces as '' (which
    // it shouldn't given the schema, but Dexie data isn't infallible),
    // we still reset because '' !== 'user_123'. Fresh-device protection
    // only kicks in for the literal `undefined` case.
    expect(shouldResetOnboardingOnBind('', 'user_123')).toBe(true);
  });
});
