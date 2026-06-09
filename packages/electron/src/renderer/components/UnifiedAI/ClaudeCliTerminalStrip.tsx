import React, { useEffect, useRef, useState } from 'react';
import { TerminalPanel } from '../Terminal/TerminalPanel';

export interface ClaudeCliTerminalStripProps {
  sessionId: string;
  workspacePath: string;
  /** Combined (`claude-code-cli:opus-1m`) or bare model id; resolved to the CLI alias in main. */
  model?: string;
  /** Bumped by the reveal listener (NIM-810) to focus the xterm for a native picker. */
  focusNonce?: number;
  /**
   * Element to observe for on-screen visibility instead of this strip's own
   * container (NIM-812). Callers pass the always-rendered drawer root so the CLI
   * still spawns while the drawer is collapsed ("spawn hidden, stay collapsed").
   * The strip body itself is `display:none` when collapsed, which would never
   * intersect; the drawer header is always laid out, so observing it is correct.
   */
  observeRef?: React.RefObject<HTMLElement | null>;
}

/**
 * Hosts the genuine `claude` CLI terminal for a `claude-code-cli` session
 * (NIM-806, Phase 1).
 *
 * The CLI is launched ONLY once this strip is actually on-screen. Nimbalyst keeps
 * all mode components mounted and toggles them with CSS `display`, so a
 * `claude-code-cli` session that is merely the *active* agent session while the
 * agent panel is hidden (after restart, or while the user is in editor mode) must
 * NOT auto-launch the CLI in the background — that would silently spin up a real
 * `claude` process on the user's subscription with no window showing it.
 *
 * An IntersectionObserver drives `isActive`/`panelVisible`. `TerminalPanel`
 * latches its own init the first time both are true and stays alive thereafter,
 * so once visible we never need to flip back to hidden.
 */
export const ClaudeCliTerminalStrip: React.FC<ClaudeCliTerminalStripProps> = ({
  sessionId,
  workspacePath,
  model,
  focusNonce,
  observeRef,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isOnScreen, setIsOnScreen] = useState(false);

  useEffect(() => {
    // Observe the caller-provided element (drawer root) when given, so the CLI
    // spawns even while the body is collapsed; otherwise fall back to our own
    // container.
    const el = observeRef?.current ?? containerRef.current;
    if (!el) return;
    // Fallback for environments without IntersectionObserver (older runtimes /
    // jsdom): treat as visible so the strip still works.
    if (typeof IntersectionObserver === 'undefined') {
      setIsOnScreen(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        // Latch: once on-screen, stay launched (matches TerminalPanel's own latch).
        if (entry.isIntersecting) {
          setIsOnScreen(true);
        }
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={containerRef} style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}>
      <TerminalPanel
        terminalId={sessionId}
        workspacePath={workspacePath}
        isActive={isOnScreen}
        panelVisible={isOnScreen}
        launchMode="claude-cli"
        claudeCliModel={model}
        focusNonce={focusNonce}
      />
    </div>
  );
};

export default ClaudeCliTerminalStrip;
