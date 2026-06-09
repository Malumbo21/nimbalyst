import { describe, it, expect, vi } from 'vitest';
import { flushNextClaudeCliQueuedPrompt, type FlushQueuedPrompt } from '../claudeCliQueueFlush';

function harness(pending: FlushQueuedPrompt[]) {
  const claim = vi.fn(async (id: string) => pending.find((p) => p.id === id) ?? null);
  const complete = vi.fn(async () => undefined);
  const fail = vi.fn(async () => undefined);
  const submit = vi.fn(async () => ({ submitted: true }));
  const deps = {
    listPending: vi.fn(async () => pending),
    claim,
    complete,
    fail,
    submit,
  };
  return { deps, claim, complete, fail, submit };
}

describe('flushNextClaudeCliQueuedPrompt', () => {
  it('claims + submits the oldest pending prompt and marks it completed', async () => {
    const h = harness([
      { id: 'q1', prompt: 'first', attachments: [{ filepath: '/tmp/a.png' }] },
      { id: 'q2', prompt: 'second' },
    ]);
    const result = await flushNextClaudeCliQueuedPrompt({ sessionId: 's1', workspacePath: '/w' }, h.deps);
    expect(result).toBe(true);
    expect(h.claim).toHaveBeenCalledWith('q1');
    expect(h.submit).toHaveBeenCalledWith({
      sessionId: 's1',
      workspacePath: '/w',
      prompt: 'first',
      attachments: [{ filepath: '/tmp/a.png' }],
    });
    expect(h.complete).toHaveBeenCalledWith('q1');
    expect(h.fail).not.toHaveBeenCalled();
  });

  it('returns false and does nothing when the queue is empty', async () => {
    const h = harness([]);
    const result = await flushNextClaudeCliQueuedPrompt({ sessionId: 's1', workspacePath: '/w' }, h.deps);
    expect(result).toBe(false);
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.submit).not.toHaveBeenCalled();
  });

  it('returns false when the prompt was already claimed by someone else', async () => {
    const h = harness([{ id: 'q1', prompt: 'first' }]);
    h.deps.claim = vi.fn(async () => null);
    const result = await flushNextClaudeCliQueuedPrompt({ sessionId: 's1', workspacePath: '/w' }, h.deps);
    expect(result).toBe(false);
    expect(h.submit).not.toHaveBeenCalled();
  });

  it('marks the prompt failed (not stuck executing) when submit throws', async () => {
    const h = harness([{ id: 'q1', prompt: 'first' }]);
    h.deps.submit = vi.fn(async () => { throw new Error('pty gone'); });
    const result = await flushNextClaudeCliQueuedPrompt({ sessionId: 's1', workspacePath: '/w' }, h.deps);
    expect(result).toBe(false);
    expect(h.fail).toHaveBeenCalledWith('q1', 'pty gone');
    expect(h.complete).not.toHaveBeenCalled();
  });
});
