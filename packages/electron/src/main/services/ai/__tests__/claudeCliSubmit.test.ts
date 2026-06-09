import { describe, it, expect, vi } from 'vitest';
import { submitClaudeCliPrompt } from '../claudeCliSubmit';
import type { ChatAttachment } from '@nimbalyst/runtime/ai/server/types';

function harness() {
  const writes: Array<[string, string]> = [];
  const logUserPrompt = vi.fn(async () => undefined);
  const sendAnalytics = vi.fn();
  const deps = {
    writeToTerminal: (sessionId: string, data: string) => { writes.push([sessionId, data]); },
    logUserPrompt,
    sendAnalytics,
    delay: async () => undefined,
  };
  return { writes, logUserPrompt, sendAnalytics, deps };
}

const img = (filepath: string): ChatAttachment => ({
  id: filepath, filename: 'x.png', filepath, mimeType: 'image/png', size: 1, type: 'image', addedAt: 0,
});

describe('submitClaudeCliPrompt', () => {
  it('writes the composed PTY line, then a separate Enter', async () => {
    const h = harness();
    await submitClaudeCliPrompt(
      { sessionId: 's1', workspacePath: '/w', prompt: 'do it', attachments: [img('/tmp/a.png')] },
      h.deps,
    );
    expect(h.writes).toEqual([
      ['s1', 'do it /tmp/a.png'],
      ['s1', '\r'],
    ]);
  });

  it('logs the CLEAN typed prompt + attachments, NOT the path-augmented PTY line', async () => {
    const h = harness();
    const attachments = [img('/tmp/a.png')];
    await submitClaudeCliPrompt(
      { sessionId: 's1', workspacePath: '/w', prompt: 'do it', attachments },
      h.deps,
    );
    expect(h.logUserPrompt).toHaveBeenCalledWith({
      sessionId: 's1',
      workspacePath: '/w',
      prompt: 'do it',
      attachments,
    });
  });

  it('reports real attachment flags to analytics', async () => {
    const h = harness();
    await submitClaudeCliPrompt(
      { sessionId: 's1', workspacePath: '/w', prompt: 'hi', attachments: [img('/a'), img('/b')] },
      h.deps,
    );
    expect(h.sendAnalytics).toHaveBeenCalledWith({ messageLength: 2, hasAttachments: true, attachmentCount: 2 });
  });

  it('no-ops (no write/log/analytics) when there is nothing to send', async () => {
    const h = harness();
    const res = await submitClaudeCliPrompt({ sessionId: 's1', workspacePath: '/w', prompt: '   ' }, h.deps);
    expect(res).toEqual({ submitted: false });
    expect(h.writes).toHaveLength(0);
    expect(h.logUserPrompt).not.toHaveBeenCalled();
    expect(h.sendAnalytics).not.toHaveBeenCalled();
  });
});
