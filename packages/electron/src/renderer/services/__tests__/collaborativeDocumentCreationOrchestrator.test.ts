import { describe, expect, it, vi } from 'vitest';

vi.mock('@nimbalyst/runtime/store', () => ({
  store: { get: vi.fn(), set: vi.fn() },
}));
vi.mock('../../utils/collabDocumentOpener', () => ({
  removeCollabConfigsForDocument: vi.fn(),
  resolveCollabConfigForUri: vi.fn(),
}));
vi.mock('../../utils/documentSeedOrchestrator', () => ({ seedSharedDocument: vi.fn() }));
vi.mock('../../components/CollabMode/collabTree', () => ({
  getCollabNodeName: (value: string) => value.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? '',
  getSharedDocumentDisplayPath: (document: { title: string }) => document.title,
  joinCollabPath: (parent: string, name: string) => [parent, name].filter(Boolean).join('/'),
  normalizeCollabPath: (value: string) => value.replace(/\\/g, '/').split('/').filter(Boolean).join('/'),
}));
vi.mock('../../store/atoms/collabDocuments', () => ({
  pendingCollabDocumentAtom: Symbol('pendingCollabDocumentAtom'),
  registerDocumentInIndex: vi.fn(),
  sharedDocumentsAtom: Symbol('sharedDocumentsAtom'),
  sharedFoldersAtom: Symbol('sharedFoldersAtom'),
}));
vi.mock('../../store/atoms/openProjects', () => ({ activeWorkspacePathAtom: Symbol('activeWorkspacePathAtom') }));
vi.mock('../../store/atoms/windowMode', () => ({ setWindowModeAtom: Symbol('setWindowModeAtom') }));
vi.mock('../CollaborativeDocumentTypeCatalog', () => ({
  getCollaborativeDocumentTypeCatalog: vi.fn(),
  normalizeSuffix: (value: string) => {
    const trimmed = value.trim().toLowerCase();
    return trimmed ? (trimmed.startsWith('.') ? trimmed : `.${trimmed}`) : null;
  },
}));
vi.mock('../../utils/logger', () => ({
  logger: { ui: { warn: vi.fn() } },
}));

import type { CollaborativeDocumentTypeCatalog } from '../CollaborativeDocumentTypeCatalog';
import type { SharedDocument, SharedFolder } from '../../store/atoms/collabDocuments';
import {
  CollaborativeDocumentCreationOrchestrator,
  type CollaborativeDocumentCreationDependencies,
} from '../collaborativeDocumentCreationOrchestrator';

const markdownDescriptor = {
  documentType: 'markdown',
  displayName: 'Markdown',
  fileExtensions: ['.markdown', '.md'],
  defaultExtension: '.md',
  icon: 'description',
  editor: { kind: 'lexical' as const },
  content: { strategy: 'lexical' as const, codecId: 'markdown' },
  creation: { defaultContent: '', source: 'builtin' as const },
  capabilities: {
    localCreate: true,
    shareToTeam: true,
    sharedCreate: true,
    history: true,
    export: true,
    embed: false,
  },
};

const mockupDescriptor = {
  ...markdownDescriptor,
  documentType: 'mockup.html',
  displayName: 'Mockup',
  fileExtensions: ['.mockup.html'],
  defaultExtension: '.mockup.html',
  editor: { kind: 'extension' as const, extensionId: 'com.nimbalyst.mockup' },
  content: { strategy: 'text' as const, codecId: 'mockup.html' },
};

function makeHarness(options: {
  descriptor?: typeof markdownDescriptor | typeof mockupDescriptor;
  documents?: SharedDocument[];
  folders?: SharedFolder[];
  seedResults?: boolean[];
  extensionLoaded?: boolean;
} = {}) {
  const descriptor = options.descriptor ?? markdownDescriptor;
  const documents = options.documents ?? [];
  const folders = options.folders ?? [];
  const events: string[] = [];
  const seedResults = [...(options.seedResults ?? [true])];
  let extensionLoaded = options.extensionLoaded ?? true;
  let generated = 0;

  const resolveMetadata = vi.fn(() => extensionLoaded
    ? { state: 'ready' as const, descriptor }
    : { state: 'unsupported' as const, descriptor, reason: 'The owning extension was unloaded.' });
  const catalog = {
    editorIdForDescriptor: (item: typeof descriptor) => item.editor.kind === 'lexical'
      ? 'builtin.lexical'
      : item.editor.extensionId!,
    resolveMetadata,
  } as unknown as CollaborativeDocumentTypeCatalog;

  const deps: CollaborativeDocumentCreationDependencies = {
    getCatalog: () => catalog,
    getWorkspacePath: () => '/workspace',
    getDocuments: () => documents,
    getFolders: () => folders,
    resolveConfig: async () => {
      events.push('resolve-config');
      return { documentId: 'resolved' } as any;
    },
    seed: async () => {
      events.push('seed');
      return seedResults.shift() === false
        ? { ok: false, error: 'ack timed out' }
        : { ok: true };
    },
    register: async (documentId, title, documentType, parentFolderId, metadata) => {
      events.push('register');
      documents.push({
        documentId,
        title,
        documentType,
        ...metadata,
        parentFolderId,
        createdBy: '',
        createdAt: 100,
        updatedAt: 100,
      });
    },
    saveLocalOrigin: async () => {
      events.push('save-origin');
      return { success: true };
    },
    publishPending: () => events.push('publish'),
    cleanup: async () => { events.push('cleanup'); },
    generateId: () => `doc-${++generated}`,
    now: () => 100,
    hashContent: async content => `hash:${typeof content === 'string' ? content : content.byteLength}`,
  };
  return {
    orchestrator: new CollaborativeDocumentCreationOrchestrator(deps),
    deps,
    documents,
    events,
    resolveMetadata,
    setExtensionLoaded(value: boolean) { extensionLoaded = value; },
  };
}

describe('CollaborativeDocumentCreationOrchestrator', () => {
  it('seeds with acknowledgement before registering one V2 index row', async () => {
    const harness = makeHarness();
    const register = vi.spyOn(harness.deps, 'register');

    const document = await harness.orchestrator.create({
      descriptor: markdownDescriptor,
      requestedName: 'Architecture',
      parentFolderId: null,
      sourceContent: '# Architecture',
    });

    expect(harness.events).toEqual(['resolve-config', 'seed', 'register', 'cleanup', 'publish']);
    expect(document).toMatchObject({
      title: 'Architecture.md',
      documentType: 'markdown',
      metadataVersion: 2,
      fileExtension: '.md',
      editorId: 'builtin.lexical',
    });
    expect(register).toHaveBeenCalledWith(
      'doc-1',
      'Architecture.md',
      'markdown',
      null,
      { metadataVersion: 2, fileExtension: '.md', editorId: 'builtin.lexical' },
    );
  });

  it('registers an intentional empty markdown document without a content update', async () => {
    const harness = makeHarness();
    await harness.orchestrator.create({
      descriptor: markdownDescriptor,
      requestedName: 'Empty',
      parentFolderId: null,
      sourceContent: '',
    });
    expect(harness.events).toEqual(['resolve-config', 'register', 'cleanup', 'publish']);
  });

  it('cleans up a failed pre-announcement seed without registering a blank row', async () => {
    const harness = makeHarness({ seedResults: [false] });
    await expect(harness.orchestrator.create({
      descriptor: markdownDescriptor,
      requestedName: 'Unannounced',
      parentFolderId: null,
      sourceContent: 'must persist',
    })).rejects.toMatchObject({
      code: 'seed-failed',
      announced: false,
    });
    expect(harness.events).toEqual(['resolve-config', 'seed', 'cleanup']);
    expect(harness.documents).toEqual([]);
  });

  it('retries idempotently with the same operation and document id', async () => {
    const harness = makeHarness({ seedResults: [false, true] });
    const input = {
      descriptor: markdownDescriptor,
      requestedName: 'Retry',
      parentFolderId: null,
      sourceContent: 'content',
      operationId: 'share-op-1',
    };

    await expect(harness.orchestrator.create(input)).rejects.toMatchObject({ code: 'seed-failed' });
    const retried = await harness.orchestrator.create(input);
    const repeated = await harness.orchestrator.create(input);

    expect(retried.documentId).toBe('doc-1');
    expect(repeated).toBe(retried);
    expect(harness.events.filter(event => event === 'register')).toHaveLength(1);
    expect(harness.events.filter(event => event === 'publish')).toHaveLength(1);
    expect(harness.resolveMetadata).toHaveBeenCalledOnce();
  });

  it('preserves an exact compound suffix and normalizes its case', async () => {
    const harness = makeHarness({ descriptor: mockupDescriptor });
    const document = await harness.orchestrator.create({
      descriptor: mockupDescriptor,
      requestedName: 'Checkout.MOCKUP.HTML',
      parentFolderId: null,
      sourceContent: '<main />',
    });
    expect(document).toMatchObject({
      title: 'Checkout.mockup.html',
      fileExtension: '.mockup.html',
      editorId: 'com.nimbalyst.mockup',
    });
  });

  it('rejects a sibling folder collision after applying the exact suffix', async () => {
    const harness = makeHarness({
      folders: [{
        folderId: 'folder-existing',
        parentFolderId: null,
        name: 'Existing.md',
        sortOrder: 0,
        createdBy: '',
        createdAt: 1,
        updatedAt: 1,
      }],
    });
    await expect(harness.orchestrator.create({
      descriptor: markdownDescriptor,
      requestedName: 'Existing',
      parentFolderId: null,
      sourceContent: '',
    })).rejects.toMatchObject({ code: 'name-collision' });
    expect(harness.events).toEqual([]);
  });

  it('saves the local-origin binding after registration and before publish', async () => {
    const harness = makeHarness();
    const save = vi.spyOn(harness.deps, 'saveLocalOrigin' as any);
    await harness.orchestrator.create({
      descriptor: markdownDescriptor,
      requestedName: 'Promoted.md',
      parentFolderId: null,
      sourceContent: 'rewritten',
      localOrigin: { sourceFilePath: '/workspace/Promoted.md', sourceContent: 'original' },
    });
    expect(harness.events).toEqual([
      'resolve-config', 'seed', 'register', 'save-origin', 'cleanup', 'publish',
    ]);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      sourceFilePath: '/workspace/Promoted.md',
      lastLocalContentHash: 'hash:original',
      lastCollabContentHash: 'hash:rewritten',
    }));
  });

  it('fails an extension-unload race before resolving a room or publishing an index row', async () => {
    const harness = makeHarness({ descriptor: mockupDescriptor });
    harness.setExtensionLoaded(false);
    await expect(harness.orchestrator.create({
      descriptor: mockupDescriptor,
      requestedName: 'Unavailable.mockup.html',
      parentFolderId: null,
      sourceContent: '<main />',
    })).rejects.toMatchObject({ code: 'invalid-descriptor', announced: false });
    expect(harness.events).toEqual([]);
    expect(harness.documents).toEqual([]);
  });
});
