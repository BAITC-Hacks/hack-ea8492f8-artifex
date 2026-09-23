import { Graph, alg } from '@dagrejs/graphlib';
import { GraphInputSchema, type Evidence, type GraphInput, type Snapshot } from '../../shared/schema.js';

export class InputError extends Error {
  constructor(
    message: string,
    public details: string[] = [],
  ) {
    super(message);
  }
}

export function collapseWhitespace(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

export function verifyEvidence(evidence: Evidence, snapshot: Snapshot): boolean {
  const doc = snapshot.documents.find((d) => d.id === evidence.documentId);
  if (evidence.span) return Boolean(doc && doc.text.slice(...evidence.span) === evidence.quote);
  return Boolean(doc && collapseWhitespace(doc.text).includes(collapseWhitespace(evidence.quote)));
}

export function validateGraph(input: unknown): GraphInput {
  const parsed = GraphInputSchema.safeParse(input);
  if (!parsed.success)
    throw new InputError(
      'The graph does not match the analysis input contract.',
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    );
  const graph = parsed.data,
    errors: string[] = [];
  if (graph.before.date > graph.after.date) errors.push('before.date must not be later than after.date.');
  for (const [side, snapshot] of [
    ['before', graph.before],
    ['after', graph.after],
  ] as const) {
    for (const key of ['departments', 'functions', 'documents', 'relationships'] as const) {
      const ids = snapshot[key].map((item) => item.id);
      if (new Set(ids).size !== ids.length) errors.push(`${side}.${key}: IDs must be unique.`);
    }
    const departments = new Set(snapshot.departments.map((d) => d.id));
    const documents = new Set(snapshot.documents.map((d) => d.id));
    const hierarchy = new Graph({ directed: true });
    for (const dept of snapshot.departments) {
      hierarchy.setNode(dept.id);
      if (dept.parentId) {
        if (!departments.has(dept.parentId)) errors.push(`${side}.${dept.id}: parentId does not exist.`);
        hierarchy.setEdge(dept.id, dept.parentId);
      }
      if (side === 'after')
        for (const id of dept.previousIds) {
          if (!graph.before.departments.some((d) => d.id === id))
            errors.push(`after.${dept.id}: previousIds references unknown before department ${id}.`);
        }
    }
    for (const fn of snapshot.functions) {
      if (!departments.has(fn.departmentId)) errors.push(`${side}.${fn.id}: departmentId does not exist.`);
      const limit = fn.canonical?.threshold;
      if (limit && limit.min !== null && limit.max !== null && limit.min > limit.max)
        errors.push(`${side}.${fn.id}: threshold min exceeds max.`);
    }
    for (const rel of snapshot.relationships) {
      if (!departments.has(rel.fromId) || !departments.has(rel.toId))
        errors.push(`${side}.${rel.id}: relationship endpoint does not exist.`);
      if (rel.type === 'reports_to') hierarchy.setEdge(rel.fromId, rel.toId);
    }
    if (!alg.isAcyclic(hierarchy)) errors.push(`${side}: reporting hierarchy contains a cycle.`);
    for (const type of ['reports_functionally', 'reports_administratively'] as const) {
      const typed = new Graph({ directed: true });
      snapshot.relationships.filter((r) => r.type === type).forEach((r) => typed.setEdge(r.fromId, r.toId));
      if (!alg.isAcyclic(typed)) errors.push(`${side}: ${type} contains a cycle.`);
    }
    for (const entity of [...snapshot.functions, ...snapshot.departments, ...snapshot.relationships]) {
      for (const ref of entity.evidence)
        if (!documents.has(ref.documentId))
          errors.push(`${side}.${entity.id}: unknown evidence document ${ref.documentId}.`);
    }
  }
  if (errors.length) throw new InputError('The graph contains invalid references or hierarchy.', errors);
  return graph;
}
