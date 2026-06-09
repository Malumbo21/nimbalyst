/**
 * NIM-806 Phase 1 — input routing for the genuine Claude CLI session type.
 *
 * A `claude-code-cli` session renders the real interactive `claude` CLI in the
 * ghostty-web terminal strip (see SessionTranscript.tsx). That CLI is driven by
 * the PTY, NOT by the Agent SDK loop, so the chat input box must write straight
 * to the terminal instead of calling `ai:sendMessage` (which throws
 * "Phase 1 not implemented" for this provider and silently queues the prompt).
 *
 * These helpers encode the routing decision so it can be unit-tested without
 * the full SessionTranscript component.
 */

/** Provider id whose input box routes to the terminal PTY. */
export const CLAUDE_CLI_PROVIDER_ID = 'claude-code-cli';

/**
 * Ctrl-C as terminal input. For the genuine Claude CLI, cancel/stop should go
 * through the PTY so the running CLI, proxy observer, and transcript remain on
 * the same session.
 */
export const CLAUDE_CLI_INTERRUPT_INPUT = '\x03';

/** True when the session's provider is the genuine terminal-backed Claude CLI. */
export function isClaudeCliTerminalSession(provider: string | null | undefined): boolean {
  return provider === CLAUDE_CLI_PROVIDER_ID;
}

/** Format an interrupt for writing to the CLI's PTY. */
export function formatClaudeCliInterruptInput(): string {
  return CLAUDE_CLI_INTERRUPT_INPUT;
}
