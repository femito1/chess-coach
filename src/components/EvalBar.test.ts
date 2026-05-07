import { describe, expect, it } from 'vitest';
import { formatEvalLabel } from './EvalBar';

describe('formatEvalLabel', () => {
  it('renders null when cp is unknown and no mate', () => {
    expect(formatEvalLabel(null)).toBeNull();
  });

  it('renders mate as M<n> with sign', () => {
    expect(formatEvalLabel(null, 5)).toBe('M5');
    expect(formatEvalLabel(null, -3)).toBe('-M3');
  });

  it('treats mate=0 as no mate (just-mated already, fall through to cp)', () => {
    expect(formatEvalLabel(150, 0)).toBe('+1.5');
  });

  it('renders cp as +N.N with sign', () => {
    expect(formatEvalLabel(120)).toBe('+1.2');
    expect(formatEvalLabel(-340)).toBe('-3.4');
  });

  it('rounds towards zero for trivial evals', () => {
    expect(formatEvalLabel(2)).toBe('0.0');
    expect(formatEvalLabel(-4)).toBe('0.0');
  });

  it('mate takes priority over cp', () => {
    expect(formatEvalLabel(800, 7)).toBe('M7');
    expect(formatEvalLabel(-800, -7)).toBe('-M7');
  });
});
