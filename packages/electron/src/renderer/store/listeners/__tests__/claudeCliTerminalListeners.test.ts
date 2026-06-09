import { describe, it, expect } from 'vitest';
import { computeRevealDrawerAction } from '../claudeCliTerminalListeners';

describe('computeRevealDrawerAction', () => {
  it('expands a collapsed drawer on an interactive picker and marks it auto-revealed + focus', () => {
    expect(computeRevealDrawerAction({ expanded: false, autoRevealed: false }, true)).toEqual({
      expanded: true,
      autoRevealed: true,
      focus: true,
    });
  });

  it('keeps an already-expanded drawer but still focuses it for the picker', () => {
    expect(computeRevealDrawerAction({ expanded: true, autoRevealed: false }, true)).toEqual({
      expanded: true,
      autoRevealed: false,
      focus: true,
    });
  });

  it('collapses on a normal prompt ONLY when it was auto-revealed', () => {
    expect(computeRevealDrawerAction({ expanded: true, autoRevealed: true }, false)).toEqual({
      expanded: false,
      autoRevealed: false,
      focus: false,
    });
  });

  it('leaves a user/default-expanded drawer untouched on a normal prompt', () => {
    expect(computeRevealDrawerAction({ expanded: true, autoRevealed: false }, false)).toEqual({
      expanded: true,
      autoRevealed: false,
      focus: false,
    });
  });

  it('does nothing meaningful when collapsed + normal prompt', () => {
    expect(computeRevealDrawerAction({ expanded: false, autoRevealed: false }, false)).toEqual({
      expanded: false,
      autoRevealed: false,
      focus: false,
    });
  });
});
