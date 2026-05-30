import { describe, expect, it } from 'vitest';

import { truncateContentForSync } from '../syncContentTruncator';

describe('truncateContentForSync', () => {
  it('caps oversized unknown-provider messages at a small opaque marker', () => {
    const raw = 'x'.repeat(40 * 1024);

    const result = truncateContentForSync(raw, 'custom-provider');

    expect(result.content.length).toBeLessThan(512);
    expect(result.content).toContain('elided from mobile sync');
    expect(result.stats.bytesAfter).toBeLessThan(512);
    expect(result.stats.elidedBytes).toBeGreaterThan(30 * 1024);
  });

  it('caps known-provider sync rows even after per-block truncation', () => {
    const raw = JSON.stringify({
      message: {
        content: [
          { type: 'tool_result', content: 'a'.repeat(12 * 1024) },
          { type: 'tool_result', content: 'b'.repeat(12 * 1024) },
          { type: 'tool_result', content: 'c'.repeat(12 * 1024) },
          { type: 'tool_use', name: 'read', input: { path: '/tmp/file.txt' } },
        ],
      },
    });

    const result = truncateContentForSync(raw, 'claude-code');

    expect(result.stats.bytesAfter).toBeLessThanOrEqual(16 * 1024);
    expect(result.stats.blocksTruncated).toBeGreaterThan(1);
  });
});
