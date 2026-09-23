import { validateGraph } from '../engine/validate.js';
import type { GraphInput } from '../../shared/schema.js';
import { ExtractedPairSchema, type Extraction } from '../../shared/extraction.js';
import { validateExtraction } from '../extraction/pipeline.js';
import { InputError } from '../engine/validate.js';
import { validateSupplementary } from '../extraction/supplementary.js';

export function extractionSnapshot(input: Extraction) {
  const extraction = validateExtraction(input);
  const errors = extraction.issues.filter((i) => i.severity === 'error');
  if (errors.length)
    throw new InputError(
      'The extracted graph needs structural/evidence corrections before comparison.',
      errors.map((i) => i.message),
    );
  return {
    ...extraction.revision,
    hierarchyKind: 'containment' as const,
    documents: extraction.documents.map(({ id, title, text }) => ({ id, title, text })),
    departments: extraction.graph.nodes.map((n) => ({
      id: n.id,
      name: n.name,
      kind: n.kind,
      previousIds: [],
      evidence: n.evidence,
      parentId:
        extraction.graph.edges.find((e) => ['part_of', 'member_of'].includes(e.type) && e.source === n.id)
          ?.target ?? null,
    })),
    relationships: extraction.graph.edges.map((e) => ({
      id: e.id,
      type: e.type,
      fromId: e.source,
      toId: e.target,
      evidence: e.evidence,
    })),
    functions: extraction.functions.flatMap((f) =>
      f.ownerIds.map((ownerId) => ({
        id: f.ownerIds.length === 1 ? f.id : `${f.id}:${ownerId}`,
        sourceFunctionId: f.id,
        departmentId: ownerId,
        description: f.description,
        canonical: f.canonical,
        normalizationNotes: f.uncertainties,
        evidence: f.evidence,
      })),
    ),
  };
}

/** Integration boundary: map the eventual graph builder's output here. */
export function adaptGraph(payload: unknown): GraphInput {
  if (
    payload &&
    typeof payload === 'object' &&
    'schemaVersion' in payload &&
    payload.schemaVersion === '2.0'
  ) {
    const pair = ExtractedPairSchema.parse(payload);
    if (pair.supplementary) validateSupplementary(pair, pair.supplementary);
    return validateGraph({
      schemaVersion: '1.0',
      title: pair.title,
      before: extractionSnapshot(pair.before),
      after: extractionSnapshot(pair.after),
    });
  }
  return validateGraph(payload);
}
