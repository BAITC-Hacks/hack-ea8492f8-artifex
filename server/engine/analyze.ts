import { createHash } from 'node:crypto';
import { Graph, alg } from '@dagrejs/graphlib';
import type {
  AnalysisResult,
  Canonical,
  DepartmentChange,
  Evidence,
  EvidenceRef,
  Finding,
  Match,
  NormalizedFunction,
  NormalizedGraph,
  NormalizedSnapshot,
} from '../../shared/schema.js';
import { normalizeTerm, similarity, tokens } from './normalize.js';
import { InputError, verifyEvidence } from './validate.js';

export const ENGINE_VERSION = '1.0.0';
const stableId = (parts: unknown[]) =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function evidenceRefs(
  snapshot: NormalizedSnapshot,
  side: 'before' | 'after',
  refs: Evidence[],
): EvidenceRef[] {
  return refs.map((ref) => ({
    ...ref,
    snapshot: side,
    documentTitle: snapshot.documents.find((d) => d.id === ref.documentId)?.title ?? ref.documentId,
    verified: verifyEvidence(ref, snapshot),
  }));
}

function supported(fn: NormalizedFunction, snapshot: NormalizedSnapshot): boolean {
  return fn.normalizationWarnings.length === 0 && fn.evidence.every((ref) => verifyEvidence(ref, snapshot));
}

function identity(a: Canonical, b: Canonical): boolean {
  return a.object === b.object && a.process === b.process;
}

function compatible(a: Canonical, b: Canonical): boolean {
  return (
    identity(a, b) &&
    a.action === b.action &&
    a.authority === b.authority &&
    a.modality === b.modality &&
    a.action !== 'unknown' &&
    a.authority !== 'unknown' &&
    a.modality !== 'unknown' &&
    same(a.conditions, b.conditions) &&
    a.frequency === b.frequency &&
    (a.threshold?.currency ?? null) === (b.threshold?.currency ?? null)
  );
}

function range(c: Canonical): [number, number] {
  return [c.threshold?.min ?? -Infinity, c.threshold?.max ?? Infinity];
}

function scopeOverlap(a: Canonical, b: Canonical): boolean {
  return Boolean(
    a.scope.length &&
    b.scope.length &&
    (a.scope.includes('*') || b.scope.includes('*') || a.scope.some((s) => b.scope.includes(s))),
  );
}

function overlap(a: Canonical, b: Canonical): boolean {
  const [amin, amax] = range(a),
    [bmin, bmax] = range(b);
  return (
    scopeOverlap(a, b) &&
    Math.max(amin, bmin) <= Math.min(amax, bmax) &&
    (a.threshold?.currency ?? null) === (b.threshold?.currency ?? null)
  );
}

/** Coverage requires a complete union for EACH scope; independent unions would invent coverage. */
export function coverage(before: Canonical, after: Canonical[]): 'full' | 'partial' | 'none' | 'unknown' {
  if (!before.scope.length || !after.length) return after.length ? 'unknown' : 'none';
  const [wantedMin, wantedMax] = range(before);
  const full = before.scope.every((scope) => {
    const intervals = after
      .filter((c) => c.scope.includes('*') || (scope !== '*' && c.scope.includes(scope)))
      .map(range)
      .sort((a, b) => a[0] - b[0]);
    let end = wantedMin;
    let started = false;
    for (const [min, max] of intervals) {
      if (max < wantedMin) continue;
      if (min > end) break;
      started = true;
      end = Math.max(end, max);
      if (end >= wantedMax) return true;
    }
    return started && end >= wantedMax;
  });
  return full ? 'full' : after.some((c) => overlap(before, c)) ? 'partial' : 'none';
}

function differences(before: Canonical, after: Canonical): Match['differences'] {
  const render = (v: unknown): string =>
    v === null
      ? 'Not stated'
      : Array.isArray(v)
        ? v.length
          ? v.join(', ')
          : 'Unknown'
        : typeof v === 'object'
          ? JSON.stringify(v)
          : String(v);
  return (Object.keys(before) as (keyof Canonical)[])
    .filter((field) => !same(before[field], after[field]))
    .map((field) => ({ field, before: render(before[field]), after: render(after[field]) }));
}

class CandidateIndex {
  private exact = new Map<string, NormalizedFunction[]>();
  private terms = new Map<string, Set<NormalizedFunction>>();
  constructor(functions: NormalizedFunction[]) {
    for (const fn of functions) {
      const key = JSON.stringify([fn.canonical.object, fn.canonical.process]);
      if (!this.exact.has(key)) this.exact.set(key, []);
      this.exact.get(key)!.push(fn);
      for (const term of tokens(`${fn.canonical.object} ${fn.canonical.process}`)) {
        if (!this.terms.has(term)) this.terms.set(term, new Set());
        this.terms.get(term)!.add(fn);
      }
    }
  }
  find(fn: NormalizedFunction) {
    const exact = this.exact.get(JSON.stringify([fn.canonical.object, fn.canonical.process])) ?? [];
    const pool = new Set<NormalizedFunction>(exact);
    for (const term of tokens(`${fn.canonical.object} ${fn.canonical.process}`)) {
      for (const item of this.terms.get(term) ?? []) pool.add(item);
    }
    const rank = (candidate: NormalizedFunction) =>
      similarity(fn.canonical.object, candidate.canonical.object) * 0.65 +
      similarity(fn.canonical.process, candidate.canonical.process) * 0.2 +
      Number(fn.canonical.action === candidate.canonical.action) * 0.1 +
      Number(fn.canonical.authority === candidate.canonical.authority) * 0.05;
    const fuzzy = [...pool]
      .filter((item) => !exact.includes(item))
      .map((item) => ({ item, score: rank(item) }))
      .filter((item) => item.score >= 0.32)
      .sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id))
      .slice(0, 8);
    return [...exact.map((item) => ({ item, score: rank(item) })), ...fuzzy].sort(
      (a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id),
    );
  }
}

function departmentChanges(graph: NormalizedGraph): DepartmentChange[] {
  const out: DepartmentChange[] = [],
    linkedAfter = new Set<string>(),
    processed = new Set<string>();
  const roles = (side: 'before' | 'after', unitId: string) =>
    graph[side].departments.filter((d) => d.kind === 'position' && d.parentId === unitId).map((d) => d.name);
  const sources = (side: 'before' | 'after', unitId: string) => {
    const snapshot = graph[side];
    return evidenceRefs(
      snapshot,
      side,
      [
        ...(snapshot.departments.find((d) => d.id === unitId)?.evidence ?? []),
        ...snapshot.departments
          .filter((d) => d.kind === 'position' && d.parentId === unitId)
          .flatMap((d) => d.evidence),
      ].filter(
        (e, i, all) =>
          all.findIndex(
            (v) => v.documentId === e.documentId && v.locator === e.locator && v.quote === e.quote,
          ) === i,
      ),
    );
  };
  for (const old of graph.before.departments.filter((d) => !d.kind || d.kind === 'unit')) {
    const next = graph.after.departments
      .filter((d) => !d.kind || d.kind === 'unit')
      .filter((d) =>
        d.previousIds.length
          ? d.previousIds.includes(old.id)
          : d.id === old.id || normalizeTerm(d.name) === normalizeTerm(old.name),
      );
    next.forEach((d) => linkedAfter.add(d.id));
    const predecessors = [
      ...new Set(next.flatMap((d) => (d.previousIds.length ? d.previousIds : [old.id]))),
    ].sort();
    const key = JSON.stringify([predecessors, next.map((d) => d.id).sort()]);
    if (processed.has(key)) continue;
    processed.add(key);
    const beforeRoles = roles('before', old.id);
    const afterRoles = next.length === 1 ? roles('after', next[0].id) : [];
    const changedComposition =
      next.length === 1 &&
      beforeRoles.length > 0 &&
      afterRoles.length > 0 &&
      beforeRoles.length !== afterRoles.length;
    out.push({
      beforeIds: predecessors.length ? predecessors : [old.id],
      afterIds: next.map((d) => d.id),
      status: !next.length
        ? 'removed'
        : next.length > 1
          ? 'split'
          : predecessors.length > 1
            ? 'merged'
            : changedComposition
              ? 'transformed'
              : normalizeTerm(old.name) === normalizeTerm(next[0].name)
                ? 'preserved'
                : 'renamed',
      basis: !next.length
        ? 'unmapped'
        : next.some((d) => d.previousIds.includes(old.id))
          ? 'explicit'
          : next.some((d) => d.id === old.id)
            ? 'identity'
            : 'name',
      reason: changedComposition
        ? `Documented positions changed from ${beforeRoles.length} to ${afterRoles.length}; review the staffing change before confirming a reorganization.`
        : next.length
          ? 'Mapped by documented unit identity or name; functional continuity requires separate review.'
          : 'No corresponding unit was identified in the supplied after structure.',
      evidence: [...sources('before', old.id), ...next.flatMap((d) => sources('after', d.id))],
    });
  }
  for (const dept of graph.after.departments.filter((d) => !d.kind || d.kind === 'unit'))
    if (!linkedAfter.has(dept.id))
      out.push({
        beforeIds: [],
        afterIds: [dept.id],
        status: 'created',
        basis: 'unmapped',
        reason: 'No corresponding unit was identified in the supplied before structure.',
        evidence: sources('after', dept.id),
      });
  return out;
}

export function analyze(
  graph: NormalizedGraph,
  normalizationMetrics: Partial<AnalysisResult['metrics']> = {},
): AnalysisResult {
  const started = performance.now(),
    findings: Finding[] = [],
    matches: Match[] = [];
  const usedAfter = new Set<string>();
  const findingIds = new Set<string>();
  let compared = 0;
  const index = new CandidateIndex(graph.after.functions);
  const refs = (before: NormalizedFunction[] = [], after: NormalizedFunction[] = []) => [
    ...before.flatMap((f) => evidenceRefs(graph.before, 'before', f.evidence)),
    ...after.flatMap((f) => evidenceRefs(graph.after, 'after', f.evidence)),
  ];
  const add = (finding: Omit<Finding, 'id'>) => {
    const id = stableId([
      finding.kind,
      finding.rule,
      finding.beforeIds,
      finding.afterIds,
      finding.departmentIds,
      finding.title,
    ]);
    if (!findingIds.has(id)) {
      if (findings.length >= 10000)
        throw new InputError(
          'This graph produces more than 10,000 findings. Analyze smaller organizational scopes. No partial result was saved.',
        );
      findingIds.add(id);
      findings.push({ id, ...finding });
    }
  };

  for (const old of graph.before.functions) {
    const candidates = index.find(old);
    compared += candidates.length;
    if (compared > 100000)
      throw new InputError(
        'This graph exceeds 100,000 detailed candidate comparisons. Analyze smaller scopes. No partial result was saved.',
      );
    const known = candidates.filter(
      ({ item }) => compatible(old.canonical, item.canonical) && supported(item, graph.after),
    );
    let selected: NormalizedFunction[] = [],
      status: Match['status'],
      covered: Match['coverage'],
      reason: string;
    if (!supported(old, graph.before)) {
      status = 'uncertain';
      covered = 'unknown';
      selected = candidates.slice(0, 3).map((c) => c.item);
      reason = 'The original function has unverified evidence or incomplete normalization.';
    } else if (known.length) {
      const fullSingle = known.find(({ item }) => coverage(old.canonical, [item.canonical]) === 'full');
      selected = fullSingle
        ? [fullSingle.item]
        : known.filter(({ item }) => overlap(old.canonical, item.canonical)).map((c) => c.item);
      if (!selected.length) selected = known.map((c) => c.item);
      covered = coverage(
        old.canonical,
        selected.map((c) => c.canonical),
      );
      if (covered === 'full') {
        status =
          selected.length > 1
            ? 'split'
            : differences(old.canonical, selected[0].canonical).length
              ? 'changed'
              : selected[0].departmentId === old.departmentId
                ? 'preserved'
                : 'transferred';
        reason =
          selected.length > 1
            ? 'Multiple successor assignments jointly cover the original scope and limits.'
            : status === 'changed'
              ? 'The original scope is covered, with changed scope or limits in the successor.'
              : status === 'transferred'
                ? 'Equivalent responsibility is assigned to a different department.'
                : 'The documented responsibility is unchanged.';
      } else {
        status = covered === 'partial' ? 'partial' : 'changed';
        reason =
          covered === 'partial'
            ? 'Only part of the original scope or monetary range has a matching successor.'
            : 'Related responsibility exists, but its scope does not cover the original assignment.';
      }
    } else {
      const exact = candidates.filter(({ item }) => identity(old.canonical, item.canonical));
      const strong = exact.filter(({ item }) => supported(item, graph.after));
      selected = (strong.length ? strong : candidates).slice(0, 3).map((c) => c.item);
      if (strong.length) {
        status = 'changed';
        covered = 'none';
        reason =
          'The same subject remains, but action, authority, conditions, frequency, or modality changed.';
      } else if (candidates.length) {
        status = 'uncertain';
        covered = 'unknown';
        reason = 'Related descriptions were found, but equivalence is not established.';
      } else {
        status = 'unmatched';
        covered = 'none';
        reason =
          'No matching successor was found in the supplied after graph. This is a possible gap, not proof of removal.';
      }
    }
    if (status !== 'uncertain') selected.forEach((f) => usedAfter.add(f.id));
    if (supported(old, graph.before))
      known.filter((c) => overlap(old.canonical, c.item.canonical)).forEach((c) => usedAfter.add(c.item.id));
    const diff = selected.flatMap((fn) =>
      differences(old.canonical, fn.canonical).map((d) => ({
        ...d,
        field: selected.length > 1 ? `${fn.id}: ${d.field}` : d.field,
      })),
    );
    matches.push({
      beforeId: old.id,
      afterIds: selected.map((f) => f.id),
      status,
      coverage: covered,
      reason,
      differences: diff,
      candidates: candidates.map((c) => ({ afterId: c.item.id, score: Number(c.score.toFixed(3)) })),
    });
    if (['unmatched', 'partial', 'changed', 'uncertain'].includes(status)) {
      const kind: Finding['kind'] =
        status === 'unmatched' ? 'loss' : status === 'uncertain' ? 'uncertainty' : 'change';
      add({
        kind,
        severity: status === 'unmatched' || status === 'partial' ? 'high' : 'medium',
        title:
          status === 'unmatched'
            ? `No successor: ${old.canonical.object}`
            : status === 'partial'
              ? `Partial coverage: ${old.canonical.object}`
              : status === 'uncertain'
                ? `Match needs review: ${old.canonical.object}`
                : `Responsibility changed: ${old.canonical.object}`,
        explanation: reason,
        recommendation:
          status === 'unmatched'
            ? 'Check the completeness of the after graph, then confirm or assign an owner for this responsibility.'
            : status === 'uncertain'
              ? 'Verify the source passages and canonical fields before confirming a match.'
              : 'Confirm the changed responsibility and explicitly assign any uncovered scope.',
        beforeIds: [old.id],
        afterIds: selected.map((f) => f.id),
        departmentIds: [...new Set([old.departmentId, ...selected.map((f) => f.departmentId)])],
        evidence: refs([old], selected),
        rule: `LINEAGE_${status.toUpperCase()}`,
        basis: kind === 'loss' || kind === 'uncertainty' ? 'candidate' : 'deterministic',
      });
    }
  }

  // A many-to-one merge is distinct from consolidating previously duplicated work.
  const mergedGroups = new Map<string, Match[]>();
  for (const m of matches)
    if (m.coverage === 'full' && m.afterIds.length === 1) {
      const id = m.afterIds[0];
      mergedGroups.set(id, [...(mergedGroups.get(id) ?? []), m]);
    }
  for (const group of mergedGroups.values()) {
    if (group.length < 2) continue;
    const originals = group.map((m) => graph.before.functions.find((f) => f.id === m.beforeId)!);
    if (originals.some((a, i) => originals.slice(i + 1).some((b) => overlap(a.canonical, b.canonical))))
      continue;
    for (const m of group) {
      m.status = 'merged';
      m.reason =
        'Previously separate responsibilities now share a successor assignment that covers each original scope.';
      const index = findings.findIndex(
        (f) => f.rule === 'LINEAGE_CHANGED' && f.beforeIds.includes(m.beforeId),
      );
      if (index >= 0) findings.splice(index, 1);
    }
  }

  // Rules operate only on fully stated, source-backed responsibility fields.
  const seen = new Set<string>();
  const hierarchy = new Graph({ directed: true });
  graph.after.departments.forEach((d) => hierarchy.setNode(d.id));
  for (const dept of graph.after.departments)
    if (
      graph.after.hierarchyKind !== 'containment' &&
      dept.parentId &&
      dept.evidence.length &&
      dept.evidence.every((e) => verifyEvidence(e, graph.after))
    )
      hierarchy.setEdge(dept.id, dept.parentId, dept.evidence);
  for (const rel of graph.after.relationships)
    if (
      ['reports_to', 'reports_functionally'].includes(rel.type) &&
      rel.evidence.every((e) => verifyEvidence(e, graph.after))
    )
      hierarchy.setEdge(rel.fromId, rel.toId, rel.evidence);
  const paths = new Map<string, ReturnType<typeof alg.dijkstra>>();
  const subordinatePath = (from: string, to: string): Evidence[] | null => {
    if (!paths.has(from)) paths.set(from, alg.dijkstra(hierarchy, from));
    const path = paths.get(from)!;
    if (!path[to] || !Number.isFinite(path[to].distance)) return null;
    const evidence: Evidence[] = [];
    let current = to;
    while (current !== from) {
      const parent = path[current].predecessor;
      if (!parent) return null;
      evidence.push(...(hierarchy.edge(parent, current) as Evidence[]));
      current = parent;
    }
    return evidence;
  };

  for (const a of graph.after.functions) {
    for (const { item: b } of index.find(a)) {
      const pair = [a.id, b.id].sort().join('\0');
      if (a.id === b.id || seen.has(pair)) continue;
      seen.add(pair);
      compared++;
      if (compared > 100000)
        throw new InputError(
          'This graph exceeds 100,000 detailed candidate comparisons. Analyze smaller scopes. No partial result was saved.',
        );
      if (!supported(a, graph.after) || !supported(b, graph.after)) continue;
      const x = a.canonical,
        y = b.canonical;
      if (!identity(x, y) || !overlap(x, y) || !same(x.conditions, y.conditions)) continue;
      const common = {
        beforeIds: [],
        afterIds: [a.id, b.id],
        departmentIds: [...new Set([a.departmentId, b.departmentId])],
        evidence: refs([], [a, b]),
        basis: 'deterministic' as const,
      };
      if (
        a.departmentId !== b.departmentId &&
        !(a.sourceFunctionId && a.sourceFunctionId === b.sourceFunctionId) &&
        compatible(x, y) &&
        x.modality !== 'prohibited'
      ) {
        add({
          ...common,
          kind: 'duplication',
          severity: 'medium',
          title: `Overlapping ownership: ${x.object}`,
          explanation:
            'Two departments hold the same documented action and authority over overlapping scope and limits. Shared ownership may be intentional.',
          recommendation:
            'Confirm whether the work is shared intentionally; document a lead owner or split the scope.',
          rule: 'DUPLICATE_RESPONSIBILITY',
        });
      }
      if (
        a.departmentId === b.departmentId &&
        x.action === y.action &&
        x.authority === y.authority &&
        ((x.modality === 'prohibited' && y.modality === 'required') ||
          (y.modality === 'prohibited' && x.modality === 'required'))
      ) {
        add({
          ...common,
          kind: 'conflict',
          severity: 'high',
          title: `Contradictory mandate: ${x.object}`,
          explanation:
            'One passage requires this responsibility while another prohibits it for the same department and overlapping scope.',
          recommendation: 'Confirm document precedence and effective dates with the responsible employee.',
          rule: 'CONTRADICTORY_MANDATE',
        });
      }
      if (x.modality === 'prohibited' || y.modality === 'prohibited') continue;
      const audit =
        x.authority === 'independent_assurance' ? a : y.authority === 'independent_assurance' ? b : null;
      const operation = audit === a ? b : a;
      if (audit && ['execution', 'decision'].includes(operation.canonical.authority)) {
        const sameDepartment = audit.departmentId === operation.departmentId;
        const pathEvidence = sameDepartment
          ? []
          : subordinatePath(audit.departmentId, operation.departmentId);
        if (sameDepartment || pathEvidence)
          add({
            ...common,
            evidence: [...common.evidence, ...evidenceRefs(graph.after, 'after', pathEvidence ?? [])],
            kind: 'conflict',
            severity: 'high',
            title: `Audit independence risk: ${x.object} (${operation.canonical.action})`,
            explanation: sameDepartment
              ? 'The same department both performs or approves the work and independently audits it.'
              : 'The auditing department reports, directly or indirectly, to the department whose work it audits.',
            recommendation:
              'Review the reporting line and separate operational ownership from independent assurance where policy requires it.',
            rule: 'AUDIT_INDEPENDENCE',
          });
      }
      if (
        a.departmentId === b.departmentId &&
        [x.authority, y.authority].includes('execution') &&
        [x.authority, y.authority].includes('decision')
      ) {
        add({
          ...common,
          kind: 'conflict',
          severity: 'high',
          title: `Execution and approval overlap: ${x.object}`,
          explanation:
            'The same department both executes and approves this work over overlapping scope. This is a separation-of-duties review flag, not a finding of wrongdoing.',
          recommendation:
            'Check the applicable approval policy and confirm whether independent authorization is required.',
          rule: 'EXECUTE_APPROVE',
        });
      }
    }
  }

  for (const relation of graph.after.relationships) {
    if (relation.type !== 'audits' || !relation.evidence.every((e) => verifyEvidence(e, graph.after)))
      continue;
    const path = relation.fromId === relation.toId ? [] : subordinatePath(relation.fromId, relation.toId);
    if (path === null) continue;
    const auditor = graph.after.departments.find((d) => d.id === relation.fromId)!;
    const target = graph.after.departments.find((d) => d.id === relation.toId)!;
    add({
      kind: 'conflict',
      severity: 'high',
      title: `Audit reporting risk: ${auditor.name}`,
      explanation:
        relation.fromId === relation.toId
          ? `${auditor.name} is explicitly assigned to audit itself.`
          : `${auditor.name} audits ${target.name} while reporting to it, directly or indirectly.`,
      recommendation: 'Review the reporting relationship and any applicable independent-assurance policy.',
      beforeIds: [],
      afterIds: [],
      departmentIds: [relation.fromId, relation.toId],
      evidence: evidenceRefs(graph.after, 'after', [...relation.evidence, ...path]),
      rule: 'AUDIT_REPORTING_LINE',
      basis: 'deterministic',
    });
  }

  for (const side of ['before', 'after'] as const) {
    const snapshot = graph[side];
    for (const fn of snapshot.functions) {
      if (fn.normalizationWarnings.length && side === 'after')
        add({
          kind: 'uncertainty',
          severity: 'medium',
          title: `Normalization needs review: ${fn.canonical.object}`,
          explanation: fn.normalizationWarnings.join(' '),
          recommendation:
            'Review the original passage and supply complete canonical fields or use AI normalization.',
          beforeIds: [],
          afterIds: [fn.id],
          departmentIds: [fn.departmentId],
          evidence: refs([], [fn]),
          rule: 'NORMALIZATION_INCOMPLETE',
          basis: 'candidate',
        });
    }
    for (const entity of [...snapshot.functions, ...snapshot.departments, ...snapshot.relationships]) {
      const invalid = entity.evidence.filter((e) => !verifyEvidence(e, snapshot));
      if (invalid.length)
        add({
          kind: 'evidence',
          severity: 'high',
          title: `Source passage mismatch: ${entity.id}`,
          explanation:
            'A supplied quote could not be found in its source text after whitespace normalization. This is a quote-presence check, not verification that the source is authentic or entails the extracted fields.',
          recommendation: 'Correct the source text or quotation in the imported graph, then analyze again.',
          beforeIds: side === 'before' && 'departmentId' in entity ? [entity.id] : [],
          afterIds: side === 'after' && 'departmentId' in entity ? [entity.id] : [],
          departmentIds:
            'departmentId' in entity
              ? [entity.departmentId]
              : 'name' in entity
                ? [entity.id]
                : [entity.fromId, entity.toId],
          evidence: evidenceRefs(snapshot, side, invalid),
          rule: 'SOURCE_QUOTE_MISMATCH',
          basis: 'deterministic',
        });
    }
  }

  const allRefs = [
    ...graph.before.functions.flatMap((f) => refs([f])),
    ...graph.after.functions.flatMap((f) => refs([], [f])),
  ];
  const severityOrder = { high: 0, medium: 1, low: 2 };
  findings.sort(
    (a, b) =>
      severityOrder[a.severity] - severityOrder[b.severity] ||
      a.kind.localeCompare(b.kind) ||
      a.id.localeCompare(b.id),
  );
  const warnings = [
    'Findings are advisory and describe only the supplied snapshots. Unmatched functions may reflect incomplete input.',
    'Quote checks verify presence in supplied source text; they do not authenticate documents or prove semantic extraction accuracy.',
    'Local candidate retrieval uses normalized vocabulary and lexical similarity. Unrecognized synonyms and translations require AI normalization or human review.',
    'Conflict rules are generic review checks, not organization-specific legal or policy conclusions.',
  ];
  if (!graph.after.functions.length)
    warnings.push(
      'The after graph has no functions. Check input completeness before treating unmatched responsibilities as losses.',
    );
  return {
    id: stableId([ENGINE_VERSION, graph, new Date().toISOString()]),
    engineVersion: ENGINE_VERSION,
    createdAt: new Date().toISOString(),
    title: graph.title,
    graph,
    matches,
    newFunctionIds: graph.after.functions.filter((f) => !usedAfter.has(f.id)).map((f) => f.id),
    departmentChanges: departmentChanges(graph),
    findings,
    warnings,
    metrics: {
      durationMs: Math.round(performance.now() - started),
      possibleComparisons:
        graph.before.functions.length * graph.after.functions.length +
        (graph.after.functions.length * (graph.after.functions.length - 1)) / 2,
      candidateComparisons: compared,
      fullyCovered: matches.filter((m) => m.coverage === 'full').length,
      totalBefore: graph.before.functions.length,
      verifiedEvidence: allRefs.filter((r) => r.verified).length,
      totalEvidence: allRefs.length,
      normalizationCacheHits: 0,
      aiCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      ...normalizationMetrics,
    },
  };
}
