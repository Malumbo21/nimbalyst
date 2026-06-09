import { describe, it, expect } from 'vitest';
import { composeClaudeCliPtySubmission } from '../claudeCliPromptComposer';

describe('composeClaudeCliPtySubmission', () => {
  it('returns just the trimmed prompt when there are no attachments', () => {
    expect(composeClaudeCliPtySubmission({ prompt: '  fix the bug  ' })).toBe('fix the bug');
  });

  it('appends absolute attachment paths after the prompt on one line', () => {
    const out = composeClaudeCliPtySubmission({
      prompt: 'look at this',
      attachments: [{ filepath: '/tmp/a.png' }, { filepath: '/tmp/b.png' }],
    });
    expect(out).toBe('look at this /tmp/a.png /tmp/b.png');
  });

  it('returns just the paths when the prompt is empty', () => {
    expect(
      composeClaudeCliPtySubmission({ prompt: '', attachments: [{ filepath: '/tmp/a.png' }] }),
    ).toBe('/tmp/a.png');
  });

  it('skips attachments without a usable filepath', () => {
    const out = composeClaudeCliPtySubmission({
      prompt: 'hi',
      attachments: [{ filepath: '' }, { filepath: null }, { filepath: '/tmp/c.png' }],
    });
    expect(out).toBe('hi /tmp/c.png');
  });

  it('returns empty string when nothing to send', () => {
    expect(composeClaudeCliPtySubmission({ prompt: '   ', attachments: [] })).toBe('');
  });
});
