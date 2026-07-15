import { describe, expect, it } from 'vitest';
import {
  reconcileSharedDocuments,
  reconcileSharedFolders,
  type SharedDocument,
  type SharedFolder,
} from '../collabDocuments';

function doc(
  documentId: string,
  title: string,
  overrides: Partial<SharedDocument> = {},
): SharedDocument {
  return {
    documentId,
    title,
    documentType: 'markdown',
    createdBy: 'u1',
    createdAt: 1,
    updatedAt: 1,
    parentFolderId: null,
    decryptFailed: false,
    ...overrides,
  };
}

function folder(folderId: string, name: string, overrides: Partial<SharedFolder> = {}): SharedFolder {
  return {
    folderId,
    parentFolderId: null,
    name,
    sortOrder: 0,
    createdBy: 'u1',
    createdAt: 1,
    updatedAt: 1,
    decryptFailed: false,
    ...overrides,
  };
}

describe('reconcileSharedDocuments (NIM-1638: shared docs must not disappear)', () => {
  it('keeps every existing doc when a full-sync response arrives EMPTY', () => {
    // Reproduces the bug: a transient/empty docIndexSync on reconnect used to
    // wholesale-replace the list with [], blanking the sidebar tree.
    const existing = [doc('d1', 'latest meeting'), doc('d2', 'What is Next')];
    const result = reconcileSharedDocuments(existing, []);
    expect(result.map(d => d.documentId).sort()).toEqual(['d1', 'd2']);
  });

  it('restores a doc that a PARTIAL full-sync response dropped', () => {
    // Incoming set is missing d2 (partial/transient). d2 must survive, and the
    // incoming copy of d1 must win (updated title).
    const existing = [doc('d1', 'latest meeting'), doc('d2', 'What is Next')];
    const incoming = [doc('d1', 'latest meeting (edited)')];
    const result = reconcileSharedDocuments(existing, incoming);
    const byId = new Map(result.map(d => [d.documentId, d]));
    expect(byId.get('d1')?.title).toBe('latest meeting (edited)');
    expect(byId.get('d2')?.title).toBe('What is Next');
  });

  it('adds new docs from the incoming set', () => {
    const existing = [doc('d1', 'latest meeting')];
    const incoming = [doc('d1', 'latest meeting'), doc('d3', 'brand new')];
    const result = reconcileSharedDocuments(existing, incoming);
    expect(result.map(d => d.documentId).sort()).toEqual(['d1', 'd3']);
  });

  it('lets incoming data win over the existing row for the same id', () => {
    const existing = [doc('d1', 'stale', { parentFolderId: 'f_old', updatedAt: 1 })];
    const incoming = [doc('d1', 'fresh', { parentFolderId: 'f_new', updatedAt: 2 })];
    const result = reconcileSharedDocuments(existing, incoming);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ title: 'fresh', parentFolderId: 'f_new', updatedAt: 2 });
  });

  it('is idempotent when incoming matches existing', () => {
    const existing = [doc('d1', 'a'), doc('d2', 'b')];
    const once = reconcileSharedDocuments(existing, existing);
    const twice = reconcileSharedDocuments(once, existing);
    expect(twice.map(d => d.documentId).sort()).toEqual(['d1', 'd2']);
  });
});

describe('reconcileSharedFolders (NIM-1638: shared folders must not disappear)', () => {
  it('keeps existing folders when a full-sync response arrives EMPTY', () => {
    const existing = [folder('f1', 'Specs'), folder('f2', 'RFCs')];
    const result = reconcileSharedFolders(existing, []);
    expect(result.map(f => f.folderId).sort()).toEqual(['f1', 'f2']);
  });

  it('restores a folder that a partial sync dropped and lets incoming win', () => {
    const existing = [folder('f1', 'Specs'), folder('f2', 'RFCs')];
    const incoming = [folder('f1', 'Specifications')];
    const result = reconcileSharedFolders(existing, incoming);
    const byId = new Map(result.map(f => [f.folderId, f]));
    expect(byId.get('f1')?.name).toBe('Specifications');
    expect(byId.get('f2')?.name).toBe('RFCs');
  });
});
