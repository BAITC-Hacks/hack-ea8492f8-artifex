import type { GraphInput, NormalizedGraph, NormalizedSnapshot, Snapshot } from './schema.js';

export function toInput(graph: NormalizedGraph): GraphInput {
  const snapshot = (value: NormalizedSnapshot): Snapshot => ({
    ...value,
    functions: value.functions.map(({ normalization: _normalization, normalizationWarnings, ...fn }) => ({
      ...fn,
      normalizationNotes: normalizationWarnings,
    })),
  });
  return { ...graph, before: snapshot(graph.before), after: snapshot(graph.after) };
}
