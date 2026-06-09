import { describe, it, expect } from 'vitest';
import {
  CLAUDE_CLI_INTERRUPT_INPUT,
  CLAUDE_CLI_PROVIDER_ID,
  formatClaudeCliInterruptInput,
  isClaudeCliTerminalSession,
} from '../claudeCliInputRouting';

// NIM-806 Phase 1: for the genuine `claude` CLI session, the chat input box must
// route to the terminal PTY instead of ai:sendMessage (which throws for this
// provider). These helpers encode that routing decision.
describe('claudeCliInputRouting', () => {
  describe('isClaudeCliTerminalSession', () => {
    it('is true only for the claude-code-cli provider', () => {
      expect(isClaudeCliTerminalSession(CLAUDE_CLI_PROVIDER_ID)).toBe(true);
    });

    it('is false for SDK-backed and other providers', () => {
      expect(isClaudeCliTerminalSession('claude')).toBe(false);
      expect(isClaudeCliTerminalSession('claude-code')).toBe(false);
      expect(isClaudeCliTerminalSession('openai-codex')).toBe(false);
      expect(isClaudeCliTerminalSession('openai')).toBe(false);
    });

    it('is false for null/undefined provider', () => {
      expect(isClaudeCliTerminalSession(null)).toBe(false);
      expect(isClaudeCliTerminalSession(undefined)).toBe(false);
    });
  });

  describe('formatClaudeCliInterruptInput', () => {
    it('returns Ctrl-C for interrupting the terminal-backed CLI', () => {
      expect(formatClaudeCliInterruptInput()).toBe(CLAUDE_CLI_INTERRUPT_INPUT);
      expect(formatClaudeCliInterruptInput()).toBe('\x03');
    });
  });
});
