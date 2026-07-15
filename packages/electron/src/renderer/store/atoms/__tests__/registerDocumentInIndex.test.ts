import { afterEach, describe, expect, it } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import { activeWorkspacePathAtom } from '../openProjects';
import { registerDocumentInIndex, sharedDocumentsAtom } from '../collabDocuments';
import { pendingDocRegistrations } from '../pendingDocRegistrations';

const WS = '/workspace/register-test';

afterEach(() => {
  pendingDocRegistrations.clear(WS);
  store.set(activeWorkspacePathAtom, null);
});

describe('registerDocumentInIndex (NIM-1565)', () => {
  it('queues the registration when no team-sync provider is connected', async () => {
    store.set(activeWorkspacePathAtom, WS);

    await registerDocumentInIndex('doc-1', 'Folder/What is Next', 'markdown', 'folder-1');

    // Optimistic entry still shows in the atom this session...
    expect(store.get(sharedDocumentsAtom).some((d) => d.documentId === 'doc-1')).toBe(true);
    // ...and, crucially, the server registration is queued (not dropped) so a
    // later provider connect can persist it.
    expect(pendingDocRegistrations.list(WS)).toEqual([
      {
        documentId: 'doc-1',
        title: 'Folder/What is Next',
        documentType: 'markdown',
        parentFolderId: 'folder-1',
      },
    ]);
    expect(store.get(sharedDocumentsAtom).find((d) => d.documentId === 'doc-1')?.parentFolderId)
      .toBe('folder-1');
  });
});
