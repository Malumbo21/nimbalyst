/**
 * Compose the text that gets typed into the genuine `claude` CLI's PTY for a
 * `claude-code-cli` submission (NIM-806 — input integration).
 *
 * The CLI is driven by keystrokes, not the Agent SDK, so attachments can't be
 * sent as structured image/document content blocks. Instead we reference each
 * attached file by its absolute on-disk path inline in the prompt line; the
 * CLI's own Read tool reads them (it handles images too). We keep the whole
 * submission on a SINGLE logical line (paths appended after the prompt) so we
 * don't depend on multi-line bracketed-paste handling.
 *
 * Pure + dependency-free so it unit-tests without a PTY or DB. The CLEAN typed
 * prompt (without the path refs) is logged separately as the transcript user
 * row — see `claudeCliUserPromptLog.ts`; this output is ONLY for the PTY.
 */

export interface ComposeClaudeCliInput {
  /** The user's typed prompt (already trimmed by the caller, but we re-trim defensively). */
  prompt?: string | null;
  /** Draft attachments; only the `filepath` is used to build a path reference. */
  attachments?: ReadonlyArray<{ filepath?: string | null }> | null;
}

/**
 * Build the single-line PTY submission: `<prompt> <path1> <path2> …`.
 *
 * - No attachments → just the trimmed prompt.
 * - Attachments + prompt → prompt followed by space-separated absolute paths.
 * - Attachments only (empty prompt) → just the space-separated paths.
 * - Attachments without a usable `filepath` are skipped.
 * - Returns `''` when there is nothing to send (caller should no-op).
 */
export function composeClaudeCliPtySubmission(input: ComposeClaudeCliInput): string {
  const trimmed = (input.prompt ?? '').trim();

  const paths = (input.attachments ?? [])
    .map((a) => (a && typeof a.filepath === 'string' ? a.filepath.trim() : ''))
    .filter((p) => p.length > 0);

  if (paths.length === 0) {
    return trimmed;
  }

  const refs = paths.join(' ');
  return trimmed ? `${trimmed} ${refs}` : refs;
}
