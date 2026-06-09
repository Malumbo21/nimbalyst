import { describe, it, expect } from 'vitest';
import path from 'path';
import { resolveClaudeExecutablePath } from '../claudeExecutableResolver';

const HOME = '/Users/tester';
const LOCAL_BIN = path.join(HOME, '.claude', 'local', 'node_modules', '.bin', 'claude');
const LOCAL_WRAPPER = path.join(HOME, '.claude', 'local', 'claude');
const HOMEBREW = '/opt/homebrew/bin/claude';
const REPO_LOCAL = '/Users/tester/sources/node_modules/.bin/claude';

const make = (existing: string[], enhancedPath?: string) =>
  resolveClaudeExecutablePath({
    homedir: HOME,
    pathExists: (p: string) => existing.includes(p),
    enhancedPath,
    pathDelimiter: ':',
  });

describe('resolveClaudeExecutablePath', () => {
  it('prefers the official ~/.claude/local install over a stale homebrew global', () => {
    // Regression for NIM-806: homebrew had v1.0.123, ~/.claude/local had 2.x.
    const enhancedPath = `${HOME}/.claude/local/node_modules/.bin:/opt/homebrew/bin`;
    expect(make([LOCAL_BIN, HOMEBREW], enhancedPath)).toBe(LOCAL_BIN);
  });

  it('falls back to the ~/.claude/local wrapper when the .bin symlink is absent', () => {
    expect(make([LOCAL_WRAPPER, HOMEBREW])).toBe(LOCAL_WRAPPER);
  });

  it('uses the first claude on the login-shell PATH when no local install exists', () => {
    const enhancedPath = `/opt/homebrew/bin:/usr/local/bin`;
    expect(make([HOMEBREW], enhancedPath)).toBe(HOMEBREW);
  });

  it('does not pick a repo-local node_modules/.bin claude ahead of the official install', () => {
    // The login PATH (home shell) lists ~/.claude/local before any repo bin.
    const enhancedPath = `${HOME}/.claude/local/node_modules/.bin:/Users/tester/sources/node_modules/.bin`;
    expect(make([LOCAL_BIN, REPO_LOCAL], enhancedPath)).toBe(LOCAL_BIN);
  });

  it('falls back to legacy hardcoded locations when PATH yields nothing', () => {
    expect(make([HOMEBREW])).toBe(HOMEBREW);
  });

  it('returns the bare command when nothing is found on disk', () => {
    expect(make([], '/nowhere:/also-nowhere')).toBe('claude');
  });
});
