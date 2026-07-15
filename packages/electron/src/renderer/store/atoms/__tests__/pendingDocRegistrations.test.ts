import { describe, expect, it } from 'vitest';
import {
  PendingDocRegistrationQueue,
  type DocRegistrationSink,
  type PendingDocRegistration,
} from '../pendingDocRegistrations';

const WS = '/workspace/a';
const WS2 = '/workspace/b';

function reg(documentId: string, title = documentId): PendingDocRegistration {
  return { documentId, title, documentType: 'markdown', parentFolderId: 'folder-1' };
}

/** A sink that records calls; optionally fails for specific documentIds. */
function makeSink(failIds: Set<string> = new Set()): DocRegistrationSink & {
  calls: Array<{ documentId: string; title: string; documentType: string; parentFolderId: string | null }>;
} {
  const calls: Array<{ documentId: string; title: string; documentType: string; parentFolderId: string | null }> = [];
  return {
    calls,
    async registerDocument(documentId, title, documentType, parentFolderId) {
      calls.push({ documentId, title, documentType, parentFolderId });
      if (failIds.has(documentId)) throw new Error(`register failed for ${documentId}`);
    },
  };
}

describe('PendingDocRegistrationQueue', () => {
  it('enqueues when no provider is available instead of dropping', () => {
    const q = new PendingDocRegistrationQueue();
    q.enqueue(WS, reg('d1'));
    expect(q.list(WS)).toEqual([reg('d1')]);
  });

  it('dedupes by documentId, keeping the latest title', () => {
    const q = new PendingDocRegistrationQueue();
    q.enqueue(WS, reg('d1', 'first'));
    q.enqueue(WS, reg('d1', 'second'));
    expect(q.list(WS)).toEqual([{
      documentId: 'd1',
      title: 'second',
      documentType: 'markdown',
      parentFolderId: 'folder-1',
    }]);
  });

  it('keeps queues isolated per workspace', () => {
    const q = new PendingDocRegistrationQueue();
    q.enqueue(WS, reg('d1'));
    q.enqueue(WS2, reg('d2'));
    expect(q.list(WS)).toEqual([reg('d1')]);
    expect(q.list(WS2)).toEqual([reg('d2')]);
  });

  it('flush registers every queued doc through the sink and clears the queue', async () => {
    const q = new PendingDocRegistrationQueue();
    q.enqueue(WS, reg('d1'));
    q.enqueue(WS, reg('d2'));
    const sink = makeSink();

    const result = await q.flush(WS, sink);

    expect(sink.calls.map((c) => c.documentId).sort()).toEqual(['d1', 'd2']);
    expect(result.flushed).toBe(2);
    expect(result.failed).toEqual([]);
    expect(q.list(WS)).toEqual([]);
  });

  it('re-enqueues docs whose registration fails so a later flush retries them', async () => {
    const q = new PendingDocRegistrationQueue();
    q.enqueue(WS, reg('ok'));
    q.enqueue(WS, reg('bad'));
    const sink = makeSink(new Set(['bad']));

    const result = await q.flush(WS, sink);

    expect(result.flushed).toBe(1);
    expect(result.failed).toEqual([reg('bad')]);
    // 'ok' cleared, 'bad' retained for retry.
    expect(q.list(WS)).toEqual([reg('bad')]);
  });

  it('flush on an empty queue is a no-op', async () => {
    const q = new PendingDocRegistrationQueue();
    const sink = makeSink();
    const result = await q.flush(WS, sink);
    expect(result).toEqual({ flushed: 0, failed: [] });
    expect(sink.calls).toEqual([]);
  });
});
