/**
 * PID-file state signal for the subscription/CLI Claude path (NIM-806, Phase 1).
 *
 * The `claude` CLI maintains a per-process state
 * file at `~/.claude/sessions/{pid}.json` — the same file `claude ps` reads.
 * Polling it for `busy` / `idle` / `waiting` is a far more stable turn-level
 * signal than tailing the jsonl log or screen-scraping the TUI, and it needs no
 * configuration.
 *
 * The SDK-only `MessageStreamingHandler` never sees CLI turns, so this is how
 * the CLI path drives the session's running/idle/needs-action indicator.
 *
 * The file's exact schema is undocumented and floats with the CLI version, so
 * the parser is deliberately defensive: an unrecognized shape returns null and
 * the watcher holds the last-known state rather than thrashing.
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

/** Statuses the CLI writes into the PID file. */
export type ClaudePidStatus = 'busy' | 'idle' | 'waiting';

/** Nimbalyst-side turn states the CLI status maps to. */
export type ClaudeTurnState = 'running' | 'idle' | 'waiting_for_input';

export interface ParsedClaudePidFile {
  status: ClaudePidStatus;
  pid?: number;
  /** Session kind the CLI records (e.g. interactive). Version-specific; optional. */
  kind?: string;
  /** What a `waiting` status is blocked on (e.g. a permission/tool name). Optional. */
  waitingFor?: string;
  /** Last-write epoch (normalized to ms). Used for staleness detection. */
  updatedAt?: number;
  /** The raw parsed object, for callers that want extra (version-specific) fields. */
  raw: Record<string, unknown>;
}

const KNOWN_STATUSES: ReadonlySet<string> = new Set(['busy', 'idle', 'waiting']);

/**
 * Normalize an `updatedAt` value to epoch milliseconds. The CLI's unit is
 * undocumented and floats with the version, so accept either seconds or ms:
 * values below ~1e12 are treated as seconds (any ms timestamp this century is
 * far larger). Returns undefined for a non-finite/absent value.
 */
function normalizeUpdatedAt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return value < 1e12 ? value * 1000 : value;
}

/**
 * Parse the contents of a `~/.claude/sessions/{pid}.json` file. Returns null on
 * malformed JSON or an unrecognized status so the caller can hold last-known
 * state (forward-compatible with CLI changes).
 */
export function parseClaudePidFile(contents: string): ParsedClaudePidFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  const rawStatus = typeof obj.status === 'string' ? obj.status.trim().toLowerCase() : '';
  if (!KNOWN_STATUSES.has(rawStatus)) {
    return null;
  }
  const pid = typeof obj.pid === 'number' && Number.isFinite(obj.pid) ? obj.pid : undefined;
  return {
    status: rawStatus as ClaudePidStatus,
    pid,
    kind: typeof obj.kind === 'string' ? obj.kind : undefined,
    waitingFor: typeof obj.waitingFor === 'string' ? obj.waitingFor : undefined,
    updatedAt: normalizeUpdatedAt(obj.updatedAt),
    raw: obj,
  };
}

/**
 * Whether an ACTIVE (`busy`/`waiting`) PID file looks stale — its `updatedAt` is
 * older than `staleAfterMs`. A process that died mid-turn leaves its last
 * `busy`/`waiting` file behind without updating it, which would otherwise pin the
 * UI to "running" forever. clarp does no such check; this improves on it.
 *
 * `idle` is never stale (an idle CLI legitimately stops refreshing the file), and
 * a file with no `updatedAt` is treated as fresh (we can't judge it).
 */
export function isClaudePidFileStale(
  parsed: ParsedClaudePidFile,
  now: number,
  staleAfterMs: number
): boolean {
  if (parsed.status === 'idle') return false;
  if (parsed.updatedAt === undefined) return false;
  return now - parsed.updatedAt > staleAfterMs;
}

/** Map the CLI PID status to a Nimbalyst turn state. */
export function mapPidStatusToTurnState(status: ClaudePidStatus): ClaudeTurnState {
  switch (status) {
    case 'busy':
      return 'running';
    case 'waiting':
      return 'waiting_for_input';
    case 'idle':
    default:
      return 'idle';
  }
}

export interface TurnStateDiff {
  changed: boolean;
  from: ClaudeTurnState | undefined;
  to: ClaudeTurnState;
}

/** Determine whether a turn-state transition occurred. */
export function diffTurnState(
  previous: ClaudeTurnState | undefined,
  next: ClaudeTurnState
): TurnStateDiff {
  return { changed: previous !== next, from: previous, to: next };
}

/** Absolute path to the PID file for a given process id. */
export function claudePidFilePath(pid: number, homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.claude', 'sessions', `${pid}.json`);
}

export interface PidStateWatcherOptions {
  pid: number;
  /** Poll cadence in ms. Default 500ms — matches a responsive UI without thrashing fs. */
  intervalMs?: number;
  /** Override the home dir (tests). */
  homeDir?: string;
  /** Override the file reader (tests). */
  readFile?: (filePath: string) => Promise<string>;
  /**
   * Opt-in staleness guard. When set, an ACTIVE (`busy`/`waiting`) PID file whose
   * `updatedAt` is older than this many ms is treated as `idle` — so a CLI that
   * died mid-turn (leaving a stale `busy` file) doesn't pin the UI to "running".
   * Omit to disable (clarp's behavior — trust the file verbatim).
   */
  staleAfterMs?: number;
  /** Clock override (tests). Defaults to `Date.now`. */
  now?: () => number;
  /** Emitted only when the mapped turn state changes. */
  onTurnState: (state: ClaudeTurnState, parsed: ParsedClaudePidFile) => void;
}

/**
 * Polls a single CLI PID file and invokes `onTurnState` whenever the mapped
 * turn state changes. Holds last-known state across unreadable/malformed reads.
 * Returns a stop function.
 */
export function watchClaudePidState(options: PidStateWatcherOptions): () => void {
  const intervalMs = options.intervalMs ?? 500;
  const filePath = claudePidFilePath(options.pid, options.homeDir);
  const read = options.readFile ?? ((p: string) => fs.readFile(p, 'utf8'));
  const now = options.now ?? (() => Date.now());

  let lastState: ClaudeTurnState | undefined;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      const contents = await read(filePath);
      const parsed = parseClaudePidFile(contents);
      if (!parsed) return; // hold last-known
      const stale =
        options.staleAfterMs !== undefined &&
        isClaudePidFileStale(parsed, now(), options.staleAfterMs);
      const next = stale ? 'idle' : mapPidStatusToTurnState(parsed.status);
      const diff = diffTurnState(lastState, next);
      if (diff.changed) {
        lastState = next;
        options.onTurnState(next, parsed);
      }
    } catch {
      // File missing/unreadable (process not started yet, or already exited).
      // Hold last-known state.
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  // Kick an immediate read so callers don't wait a full interval for first state.
  void tick();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
