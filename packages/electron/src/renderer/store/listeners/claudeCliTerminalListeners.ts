/**
 * Centralized IPC listener for the `claude-code-cli` raw-terminal drawer (NIM-810).
 *
 * Follows the centralized-listener architecture: components NEVER subscribe to IPC
 * directly; this listener updates Jotai atoms that SessionTranscript / TerminalPanel
 * read.
 *
 * Main fires `claude-cli:reveal-terminal` on every CLI submit (and from the PTY
 * picker sniffer). On an interactive signal we reveal + focus the drawer; on a
 * normal prompt we collapse a drawer that we auto-revealed, leaving user/default
 * expansions untouched.
 */

import { store } from '../index';
import {
  cliTerminalExpandedAtom,
  cliTerminalFocusNonceAtom,
  cliTerminalAutoRevealedAtom,
} from '../atoms/terminals';

interface RevealTerminalPayload {
  sessionId: string;
  interactive: boolean;
  source?: 'input' | 'output';
  command?: string;
}

export interface RevealDrawerState {
  expanded: boolean;
  autoRevealed: boolean;
}

export interface RevealDrawerDecision extends RevealDrawerState {
  /** Whether to pulse focus to the xterm (keyboard nav into the native picker). */
  focus: boolean;
}

/**
 * Pure decision for one reveal signal — kept separate so the branching is
 * unit-testable without the global store or `window`.
 *
 * - interactive + collapsed  → expand, mark auto-revealed, focus
 * - interactive + expanded   → keep, focus (drive the picker already on-screen)
 * - normal + auto-revealed   → collapse, clear flag (return to where the user was)
 * - normal + user/default    → no change
 */
export function computeRevealDrawerAction(
  current: RevealDrawerState,
  interactive: boolean,
): RevealDrawerDecision {
  if (interactive) {
    if (!current.expanded) {
      return { expanded: true, autoRevealed: true, focus: true };
    }
    return { ...current, focus: true };
  }
  if (current.autoRevealed) {
    return { expanded: false, autoRevealed: false, focus: false };
  }
  return { ...current, focus: false };
}

export function initClaudeCliTerminalListeners(): () => void {
  const handleReveal = (payload: RevealTerminalPayload) => {
    const { sessionId, interactive } = payload ?? {};
    if (!sessionId) return;

    const current: RevealDrawerState = {
      expanded: store.get(cliTerminalExpandedAtom(sessionId)),
      autoRevealed: store.get(cliTerminalAutoRevealedAtom(sessionId)),
    };
    const next = computeRevealDrawerAction(current, !!interactive);

    if (next.expanded !== current.expanded) {
      store.set(cliTerminalExpandedAtom(sessionId), next.expanded);
    }
    if (next.autoRevealed !== current.autoRevealed) {
      store.set(cliTerminalAutoRevealedAtom(sessionId), next.autoRevealed);
    }
    if (next.focus) {
      store.set(cliTerminalFocusNonceAtom(sessionId), (n) => n + 1);
    }
  };

  const unsubscribe = window.electronAPI.on('claude-cli:reveal-terminal', handleReveal);

  return () => {
    if (typeof unsubscribe === 'function') {
      unsubscribe();
    } else {
      window.electronAPI.off?.('claude-cli:reveal-terminal', handleReveal);
    }
  };
}
