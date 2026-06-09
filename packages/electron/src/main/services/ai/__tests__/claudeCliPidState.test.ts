import { describe, it, expect } from 'vitest';
import {
  parseClaudePidFile,
  mapPidStatusToTurnState,
  diffTurnState,
  isClaudePidFileStale,
} from '../claudeCliPidState';

/**
 * The `claude` CLI writes `~/.claude/sessions/{pid}.json`; we poll it for
 * busy/idle/waiting and map to Nimbalyst turn states. This is the stable
 * turn-level state source for the CLI path (the SDK-only MessageStreamingHandler
 * does not see CLI turns).
 */
describe('parseClaudePidFile', () => {
  it('parses a busy status', () => {
    const r = parseClaudePidFile(JSON.stringify({ status: 'busy', pid: 4321 }));
    expect(r?.status).toBe('busy');
    expect(r?.pid).toBe(4321);
  });

  it('parses idle and waiting', () => {
    expect(parseClaudePidFile('{"status":"idle"}')?.status).toBe('idle');
    expect(parseClaudePidFile('{"status":"waiting"}')?.status).toBe('waiting');
  });

  it('is case-insensitive and trims', () => {
    expect(parseClaudePidFile('{"status":" Busy "}')?.status).toBe('busy');
  });

  it('returns null for malformed JSON', () => {
    expect(parseClaudePidFile('not json')).toBeNull();
    expect(parseClaudePidFile('')).toBeNull();
  });

  it('returns null for an unrecognized status (forward-compat: caller holds last-known)', () => {
    expect(parseClaudePidFile('{"status":"reticulating"}')).toBeNull();
    expect(parseClaudePidFile('{"pid":1}')).toBeNull();
  });

  it('captures kind / waitingFor and normalizes updatedAt (ms passthrough, seconds upscaled)', () => {
    const ms = parseClaudePidFile(
      JSON.stringify({ status: 'waiting', kind: 'interactive', waitingFor: 'Bash', updatedAt: 1_700_000_000_000 }),
    );
    expect(ms).toMatchObject({ kind: 'interactive', waitingFor: 'Bash', updatedAt: 1_700_000_000_000 });
    // A seconds-epoch value (< 1e12) is upscaled to ms.
    expect(parseClaudePidFile('{"status":"busy","updatedAt":1700000000}')?.updatedAt).toBe(1_700_000_000_000);
    // Absent/zero updatedAt → undefined.
    expect(parseClaudePidFile('{"status":"idle"}')?.updatedAt).toBeUndefined();
  });
});

describe('isClaudePidFileStale', () => {
  const at = (status: 'busy' | 'idle' | 'waiting', updatedAt?: number) =>
    ({ status, updatedAt, raw: {} } as ReturnType<typeof parseClaudePidFile> & object);

  it('flags an active file whose updatedAt is older than the threshold', () => {
    expect(isClaudePidFileStale(at('busy', 1_000), 100_000, 60_000)).toBe(true);
    expect(isClaudePidFileStale(at('waiting', 1_000), 100_000, 60_000)).toBe(true);
  });

  it('is fresh when within the threshold', () => {
    expect(isClaudePidFileStale(at('busy', 90_000), 100_000, 60_000)).toBe(false);
  });

  it('never flags idle, and treats a missing updatedAt as fresh (cannot judge)', () => {
    expect(isClaudePidFileStale(at('idle', 1), 1e15, 60_000)).toBe(false);
    expect(isClaudePidFileStale(at('busy', undefined), 1e15, 60_000)).toBe(false);
  });
});

describe('mapPidStatusToTurnState', () => {
  it('maps PID statuses to Nimbalyst turn states', () => {
    expect(mapPidStatusToTurnState('busy')).toBe('running');
    expect(mapPidStatusToTurnState('idle')).toBe('idle');
    expect(mapPidStatusToTurnState('waiting')).toBe('waiting_for_input');
  });
});

describe('diffTurnState', () => {
  it('reports a transition only when the state actually changes', () => {
    expect(diffTurnState('idle', 'running')).toEqual({ changed: true, from: 'idle', to: 'running' });
    expect(diffTurnState('running', 'running')).toEqual({ changed: false, from: 'running', to: 'running' });
  });

  it('treats an undefined previous state as a change', () => {
    expect(diffTurnState(undefined, 'running').changed).toBe(true);
  });
});
