import { describe, expect, it } from 'vitest';

import {
  getDefaultSettingsCategory,
  getSettingsRoutesForScope,
  normalizeSettingsDestination,
  validateSettingsDestination,
} from '../settingsRoutes';

describe('settings route registry', () => {
  it('declares every route in exactly one scope', () => {
    const seen = new Map<string, string>();
    for (const scope of ['application', 'personal', 'organization', 'project'] as const) {
      for (const route of getSettingsRoutesForScope(scope, { developerMode: true })) {
        expect(seen.has(route.id)).toBe(false);
        seen.set(route.id, scope);
        expect(route.scope).toBe(scope);
      }
    }
  });

  it('uses deterministic defaults for all four scopes', () => {
    expect(getDefaultSettingsCategory('application')).toBe('notifications');
    expect(getDefaultSettingsCategory('personal')).toBe('personal-accounts');
    expect(getDefaultSettingsCategory('organization')).toBe('organization-members');
    expect(getDefaultSettingsCategory('project')).toBe('project-sharing');
  });

  it('keeps project-level MCP server configuration reachable', () => {
    const projectRoutes = getSettingsRoutesForScope('project', { developerMode: false });

    expect(projectRoutes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'project-mcp-servers',
        scope: 'project',
        label: 'MCP Servers',
      }),
    ]));
    expect(normalizeSettingsDestination({
      category: 'mcp-servers',
      scope: 'project',
      workspacePath: '/workspace',
    })).toEqual({
      scope: 'project',
      category: 'project-mcp-servers',
      target: { kind: 'workspace', workspacePath: '/workspace' },
    });
  });

  it('requires explicit organization and project context', () => {
    expect(validateSettingsDestination({
      scope: 'organization',
      category: 'organization-security',
      orgId: '',
    })).toBe(false);
    expect(validateSettingsDestination({
      scope: 'project',
      category: 'project-sharing',
      target: { kind: 'organizationProject', orgId: 'org-1', projectId: '' },
    })).toBe(false);
    expect(validateSettingsDestination({
      scope: 'project',
      category: 'project-sharing',
      target: { kind: 'organizationProject', orgId: 'org-1', projectId: 'project-1' },
    })).toBe(true);
  });

  it('translates legacy deep links without crossing identity lanes', () => {
    expect(normalizeSettingsDestination({ category: 'sync', scope: 'user' })).toEqual({
      scope: 'personal',
      category: 'personal-mobile',
    });
    expect(normalizeSettingsDestination({ category: 'org', scope: 'organization', orgId: 'org-1' })).toEqual({
      scope: 'organization',
      category: 'organization-members',
      orgId: 'org-1',
    });
    expect(normalizeSettingsDestination({
      category: 'team',
      scope: 'project',
      workspacePath: '/workspace',
    })).toEqual({
      scope: 'project',
      category: 'project-sharing',
      target: { kind: 'workspace', workspacePath: '/workspace' },
    });
    // The legacy 'github' project link must resolve to the GitHub page, not
    // fall through to Sharing (settings review finding).
    expect(normalizeSettingsDestination({
      category: 'github',
      scope: 'project',
      workspacePath: '/workspace',
    })).toEqual({
      scope: 'project',
      category: 'project-github',
      target: { kind: 'workspace', workspacePath: '/workspace' },
    });
  });
});
