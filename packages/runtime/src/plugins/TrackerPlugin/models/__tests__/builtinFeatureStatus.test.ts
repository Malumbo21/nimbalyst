import { describe, it, expect } from 'vitest';
import { loadBuiltinTrackers } from '../ModelLoader';
import { globalRegistry } from '../TrackerDataModel';

describe('builtin Feature tracker status', () => {
  it('exposes a terminal "Won\'t Do" status', () => {
    loadBuiltinTrackers();
    const feature = globalRegistry.get('feature');
    expect(feature).toBeDefined();

    const status = feature!.fields.find((f) => f.name === 'status');
    expect(status?.type).toBe('select');

    const wontDo = status?.options?.find((o) => o.value === 'wont-do');
    expect(wontDo).toBeDefined();
    expect(wontDo!.label).toBe("Won't Do");
  });
});
