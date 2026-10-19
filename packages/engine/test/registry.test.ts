import { describe, expect, it } from 'vitest';
import { createRegistry, type MapFn, type SinkFn, type SourceFn } from '../src/registry.js';

const map: MapFn = async (item) => item;
const sink: SinkFn = async () => {};
const source: SourceFn = async function* () {
  yield 1;
};

describe('registry', () => {
  it('registry: register/has/names/get round-trip per kind', () => {
    const r = createRegistry();
    r.source('s', source);
    r.map('m', map);
    r.sink('k', sink);
    r.predicate('p', async () => true);
    expect(r.has('map', 'm')).toBe(true);
    expect(r.has('map', 'nope')).toBe(false);
    expect(r.get('source', 's')).toBe(source);
    expect(r.get('map', 'm')).toBe(map);
    expect(r.get('sink', 'k')).toBe(sink);
    expect(r.get('predicate', 'p')).toBeTypeOf('function');
    expect(r.get('map', 'nope')).toBeUndefined();
    expect(r.names('map')).toEqual(['m']);
    expect(r.names('predicate')).toEqual(['p']);
  });

  it('registry: kinds are separate namespaces and a duplicate name for the same kind throws', () => {
    const r = createRegistry();
    r.map('x', map);
    r.sink('x', sink);
    expect(r.has('map', 'x') && r.has('sink', 'x')).toBe(true);
    expect(r.has('source', 'x')).toBe(false);
    expect(r.get('sink', 'x')).toBe(sink);
    expect(r.get('map', 'x')).toBe(map);
    expect(r.get('source', 'x')).toBeUndefined();
    expect(() => r.map('x', map)).toThrow();
  });
});
