import { describe, expect, it } from 'vitest';
import { PHONE_MAX_SHORT_EDGE, isPhoneShaped } from './device';

describe('isPhoneShaped', () => {
  it('recognises a phone: coarse primary pointer and a short screen edge', () => {
    // iPhone 15 Pro: 393 x 852 CSS px.
    expect(isPhoneShaped({ coarsePointer: true, shortEdge: 393 })).toBe(true);
    // Pro Max, the largest current iPhone.
    expect(isPhoneShaped({ coarsePointer: true, shortEdge: 430 })).toBe(true);
  });

  it('leaves desktop Safari and Firefox alone, which is the whole constraint', () => {
    // The objection this design had to satisfy: never penalise a desktop for a
    // missing `deviceMemory`. A fine primary pointer settles it regardless of
    // window size.
    expect(isPhoneShaped({ coarsePointer: false, shortEdge: 393 })).toBe(false);
    expect(isPhoneShaped({ coarsePointer: false, shortEdge: 1440 })).toBe(false);
  });

  it('does not treat a tablet as a phone', () => {
    // iPad mini is 744 on its short edge; it has more headroom and is not the
    // device that crashed. Left as-is deliberately rather than swept in.
    expect(isPhoneShaped({ coarsePointer: true, shortEdge: 744 })).toBe(false);
    expect(isPhoneShaped({ coarsePointer: true, shortEdge: 1024 })).toBe(false);
  });

  it('is orientation-independent, because it reads the SHORT edge', () => {
    // A landscape phone is still a phone. Reading a viewport width instead
    // would have missed this — a 932 px landscape iPhone looks tablet-sized.
    expect(isPhoneShaped({ coarsePointer: true, shortEdge: 430 })).toBe(true);
  });

  it('says no when it cannot tell, so behaviour is unchanged', () => {
    expect(isPhoneShaped({ coarsePointer: true, shortEdge: undefined })).toBe(false);
    expect(isPhoneShaped({ coarsePointer: true, shortEdge: 0 })).toBe(false);
    expect(isPhoneShaped({ coarsePointer: true, shortEdge: -1 })).toBe(false);
  });

  it('pins the phone/tablet boundary in both directions', () => {
    expect(isPhoneShaped({ coarsePointer: true, shortEdge: PHONE_MAX_SHORT_EDGE })).toBe(
      true,
    );
    expect(
      isPhoneShaped({ coarsePointer: true, shortEdge: PHONE_MAX_SHORT_EDGE + 1 }),
    ).toBe(false);
  });
});
