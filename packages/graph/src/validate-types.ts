import { edgeId, scopedId } from './ids.js';
import { isAssignable } from './schema.js';
import type { Flow, FlowNode, PortSpec, Schema, ValidationError } from './types.js';
import { escapePointer, portsOf, walkScopes } from './walk.js';

// SPEC-engine-core: the retry frame's `error` port (onExhausted 'emit-error') carries { message, item }.
const ERROR_SCHEMA: Schema = { type: 'object', properties: { message: { type: 'string' }, item: {} }, required: ['message', 'item'] };

const resolved = (p: PortSpec | undefined): Schema | undefined => (typeof p === 'object' && p !== null && !('inferFrom' in p) ? p : undefined);
// Port schemas; undefined when the port does not exist (T13 reports that) or still has an unresolved `inferFrom` (reported here as E_SHAPE).
const outSchema = (n: FlowNode | undefined, port: string): Schema | undefined =>
  n === undefined ? undefined : port === 'out' && n.kind !== 'sink' ? resolved(n.out) : port === 'error' && portsOf(n).error ? ERROR_SCHEMA : undefined;
const inSchema = (n: FlowNode | undefined, port: string): Schema | undefined => (n !== undefined && port === 'in' && n.kind !== 'source' ? resolved(n.in) : undefined);

// ADR 0004: an untyped `{}` source is not a wildcard, so the author is told to type the producing port.
const mismatch = (from: string, fs: Schema, to: string, ts: Schema): string =>
  `${from} ${JSON.stringify(fs)} is not assignable to ${to} ${JSON.stringify(ts)}` + (Object.keys(fs).length === 0 ? '; type the producing port' : '');

// E_TYPE_MISMATCH (edges, frame boundary, while/until state loop), E_UNCONNECTED_PORT, and E_SHAPE for an unresolved `inferFrom`.
export function checkTypes(flow: Flow): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const scope of walkScopes(flow)) {
    const sc = (id: string): string => (scope.scopeId === '' ? id : scopedId(scope.scopeId, id));
    const get = (nodes: Record<string, FlowNode>, id: string): FlowNode | undefined => (Object.hasOwn(nodes, id) ? nodes[id] : undefined);
    const fed = new Set<string>(scope.body ? [scope.body.entry.node] : []); // the frame boundary feeds the entry node (a bad entry ref is E_UNKNOWN_*)
    scope.edges.forEach((e, i) => {
      if (e.to.port === 'in') fed.add(e.to.node);
      const from = get(scope.nodes, e.from.node);
      const to = get(scope.nodes, e.to.node);
      const fs = outSchema(from, e.from.port);
      const ts = inSchema(to, e.to.port);
      if (fs !== undefined && ts !== undefined && !isAssignable(fs, ts)) {
        const scoped = { from: { ...e.from, node: sc(e.from.node) }, to: { ...e.to, node: sc(e.to.node) } };
        errors.push({
          code: 'E_TYPE_MISMATCH',
          message: mismatch(`${scoped.from.node}.${e.from.port}`, fs, `${scoped.to.node}.${e.to.port}`, ts),
          edge: edgeId(scoped),
          path: `${scope.scopePath}/edges/${i}`,
        });
      }
    });
    for (const [id, node] of Object.entries(scope.nodes)) {
      const path = `${scope.scopePath}/nodes/${escapePointer(id)}`;
      for (const side of ['in', 'out'] as const) {
        const p = (node as Record<string, PortSpec | undefined>)[side];
        if (typeof p === 'object' && p !== null && 'inferFrom' in p) {
          errors.push({ code: 'E_SHAPE', message: 'unresolved inferFrom: run parseFlow', node: sc(id), path: `${path}/${side}` });
        }
      }
      if (portsOf(node).in && !fed.has(id)) {
        errors.push({ code: 'E_UNCONNECTED_PORT', message: `input port "in" of node "${sc(id)}" has no incoming edge`, node: sc(id), path });
      }
      if (node.kind !== 'frame') continue;
      const { body } = node;
      const entry = inSchema(get(body.nodes, body.entry.node), body.entry.port);
      const exit = outSchema(get(body.nodes, body.exit.node), body.exit.port);
      const fin = resolved(node.in);
      const fout = resolved(node.out);
      if (fin !== undefined && entry !== undefined && !isAssignable(fin, entry)) {
        errors.push({ code: 'E_TYPE_MISMATCH', message: mismatch(`frame "${id}" in`, fin, 'body entry', entry), node: sc(id), path: `${path}/body/entry` });
      }
      if (exit !== undefined && fout !== undefined && !isAssignable(exit, fout)) {
        errors.push({ code: 'E_TYPE_MISMATCH', message: mismatch('body exit', exit, `frame "${id}" out`, fout), node: sc(id), path: `${path}/body/exit` });
      }
      if ((node.frame === 'while' || node.frame === 'until') && entry !== undefined && exit !== undefined && !isAssignable(exit, entry)) {
        errors.push({ code: 'E_TYPE_MISMATCH', message: mismatch('body output', exit, 'body input (state loop)', entry), node: sc(id), path: `${path}/body` });
      }
    }
  }
  return errors;
}
