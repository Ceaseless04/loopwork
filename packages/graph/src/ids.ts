import type { Edge } from './types.js';

export function edgeId(e: Edge): string {
  return `${e.from.node}.${e.from.port}->${e.to.node}.${e.to.port}`;
}

export function scopedId(...parts: string[]): string {
  return parts.join('.');
}
