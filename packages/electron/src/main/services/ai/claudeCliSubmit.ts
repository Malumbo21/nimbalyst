/**
 * Consolidated `claude-code-cli` prompt submission (NIM-806 — input integration).
 *
 * A single place that turns a {prompt, attachments} into a genuine-CLI turn:
 *   1. compose the PTY line (prompt + inline attachment paths) — `claudeCliPromptComposer`
 *   2. write it to the terminal PTY (text, then a separate Enter, mirroring the
 *      terminal key path — a single `text + \r` write can leave the Claude TUI
 *      showing the text without consuming Enter)
 *   3. persist the CLEAN typed prompt (+ attachment chips) as the transcript user row
 *   4. fire `ai_message_sent` analytics with real attachment flags
 *
 * Used by BOTH the immediate-send IPC (`claude-cli:submit-prompt`) and the
 * main-process queue flusher (`claudeCliQueueFlush`), so a queued prompt's
 * attachments flush identically to an immediate one. Pure core + injected deps
 * so it unit-tests without a PTY / DB / analytics; the production wrapper wires
 * the real terminal manager, prompt-log, and analytics.
 */

import type { ChatAttachment } from '@nimbalyst/runtime/ai/server/types';
import { composeClaudeCliPtySubmission } from './claudeCliPromptComposer';

/** Carriage return = Enter for the CLI's readline (PTYs expect `\r`, not `\n`). */
const SUBMIT_TERMINATOR = '\r';
/** Gap between the text write and the Enter write so the TUI consumes both. */
export const SUBMIT_WRITE_GAP_MS = 25;

export interface SubmitClaudeCliPromptInput {
  sessionId: string;
  workspacePath: string;
  prompt: string;
  attachments?: ChatAttachment[];
}

export interface SubmitClaudeCliPromptDeps {
  writeToTerminal: (sessionId: string, data: string) => void;
  logUserPrompt: (input: {
    sessionId: string;
    workspacePath: string;
    prompt: string;
    attachments?: ChatAttachment[];
  }) => Promise<void>;
  sendAnalytics: (payload: {
    messageLength: number;
    hasAttachments: boolean;
    attachmentCount: number;
  }) => void;
  delay: (ms: number) => Promise<void>;
}

/**
 * Compose + write + log + analytics for one CLI submission. Returns
 * `{ submitted: false }` (a no-op) when there's nothing to send.
 */
export async function submitClaudeCliPrompt(
  input: SubmitClaudeCliPromptInput,
  deps: SubmitClaudeCliPromptDeps,
): Promise<{ submitted: boolean }> {
  const prompt = (input.prompt ?? '').trim();
  const attachments = input.attachments ?? [];

  const ptyText = composeClaudeCliPtySubmission({ prompt, attachments });
  if (!ptyText) {
    return { submitted: false };
  }

  deps.writeToTerminal(input.sessionId, ptyText);
  await deps.delay(SUBMIT_WRITE_GAP_MS);
  deps.writeToTerminal(input.sessionId, SUBMIT_TERMINATOR);

  // Log the CLEAN typed prompt (+ attachment chips), NOT the path-augmented PTY
  // line. Best-effort: the CLI turn already started.
  await deps.logUserPrompt({
    sessionId: input.sessionId,
    workspacePath: input.workspacePath,
    prompt,
    attachments,
  });

  deps.sendAnalytics({
    messageLength: prompt.length,
    hasAttachments: attachments.length > 0,
    attachmentCount: attachments.length,
  });

  return { submitted: true };
}
