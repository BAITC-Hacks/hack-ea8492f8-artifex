import { Graph, alg } from '@dagrejs/graphlib';
import OpenAI from 'openai';
import {
  ExtractionRequestSchema,
  ExtractionSchema,
  type Extraction,
  type ExtractionRequest,
  type ExtractedNode,
  type SourceEvidence,
  type ExtractedFunction,
} from '../../shared/extraction.js';
import { InputError } from '../engine/validate.js';
import { normalizeLocal } from '../engine/normalize.js';
import type { Store } from '../store.js';
import { createAgentSession, type AgentSession } from './agent.js';
import {
  indexDocuments,
  evidenceFor,
  identity,
  key,
  digest,
  batchContext,
  type DocumentIndex,
  type Clause,
} from './document.js';
import { localStructure, nominative } from './local.js';
import { StructureProposal, FunctionProposal, ReviewProposal, type StructureDraft } from './proposals.js';

const STRUCTURE_INSTRUCTIONS = `Extract organizational entities and explicitly supported relationships. Your output contains mentions, not IDs. Include units, positions, external governance bodies, and explicitly described groups. Never invent a unit from a position title (a Data Center Director does not prove a structural Data Center exists). Repeated role names in different units are distinct. A role may have unknown membership: scopeName=null and an uncertainty, not a guessed container. Use the full declared unit name for a position's scopeName. Keep functional, administrative, disciplinary reporting and containment separate. Administrative reporting alone does not prove impaired audit independence. A functional supervisor need not head the employee's unit. Preserve group ownership as a group node when individual expansion is not explicitly supported. An 'informs/reports results to' duty does not itself prove hierarchical reporting. Use aliases only when their identity is evidenced. Extract all actors needed for responsibility ownership, including unnumbered headings and parents of clauses. Cite exact source text for each node and edge. Sources take precedence over the baseline candidates. Return uncertainties for unclear identities, abbreviations or missing context.`;
const FUNCTION_INSTRUCTIONS = `Extract atomic responsibilities using ONLY the supplied registry owner IDs. Return exactly one record per requested clauseId, even if context_only or uncertain. Read headingPath, ancestor clauses and references: a shared 'must not'/'may'/'shall' heading applies to its descendants. Independent actions get separate functions. Distinguish departmental mandate, a director's accountability, execution, consultation, approval, monitoring and independent audit. Do not assign a parent's mandate to every child. A group can own a responsibility without guessing all members. An unresolved owner is ownerIds=[] plus uncertainty. Preserve frequency, scope, conditions, prohibitions, exceptions and conditional delegation. Include contextEvidence for every relied-upon heading/ancestor/referenced clause. supportingQuote must be an exact substring of the requested clause. conditions retain original-language qualifications, not just keywords. Exceptions must also remain in canonical.conditions. 'No right to not disclose' is an obligation to disclose, not a prohibition on disclosure: flag ambiguities. A removed phrase is not proof of a removed duty if another reference still requires it. Canonical fields use stable English action/object/process vocabulary, singular object names, and source-grounded scope. scope=[] means unknown; ['*'] only when universally explicit. Null threshold means no documented numeric restriction. Unclear fields stay unknown. Do not treat a permitted action as proof of an obligation's execution. Pure headings/definitions/structure are context_only. Empty clauses are uncertain. General qualifications and resources are not invented operational functions.`;

function batches<T>(items: T[], size: (item: T) => number, max: number): T[][] {
  const result: T[][] = [];
  let batch: T[] = [],
    used = 0;
  for (const item of items) {
    const length = size(item);
    if (batch.length && used + length > max) {
      result.push(batch);
      batch = [];
      used = 0;
    }
    batch.push(item);
    used += length;
  }
  if (batch.length) result.push(batch);
  return result;
}

export class ExtractionBuilder {
  readonly output: Extraction;
  constructor(
    readonly request: ExtractionRequest,
    readonly index: DocumentIndex,
  ) {
    this.output = {
      schemaVersion: '2.0',
      revision: request.revision,
      documents: request.documents.map((d) => ({ ...d, sha256: digest(d.text) })),
      graph: { nodes: [], edges: [] },
      functions: [],
      issues: [],
      coverage: {
        totalClauses: index.clauses.length,
        reviewedClauses: 0,
        unreviewedClauseIds: index.clauses.map((c) => c.id),
        status: 'needs_review',
      },
      trace: [],
      metrics: { model: null, calls: 0, cacheHits: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 },
    };
    for (const message of index.issues) this.issue('source_reference', message);
    for (const doc of request.documents)
      for (const message of doc.ingestionNotes ?? [])
        this.issue('ingestion_warning', `${doc.id}: ${message}`);
  }
  issue(
    code: string,
    message: string,
    evidence: SourceEvidence[] = [],
    entityIds: string[] = [],
    severity: 'info' | 'warning' | 'error' = 'warning',
  ) {
    const id = identity('issue', JSON.stringify([code, message, entityIds]));
    if (!this.output.issues.some((i) => i.id === id))
      this.output.issues.push({ id, code, message, evidence, entityIds, severity });
  }
  citations(refs: { clauseId: string; quote: string }[]) {
    if (!refs.length) throw new Error('At least one source passage is required');
    return refs.map((e) => evidenceFor(this.index, e.clauseId, e.quote));
  }
  resolve(mention: {
    kind: ExtractedNode['kind'];
    name: string;
    scopeName: string | null;
  }): ExtractedNode | undefined {
    const scope = mention.scopeName
      ? this.resolve({ kind: 'unit', name: mention.scopeName, scopeName: null })
      : undefined;
    const normalized = key(nominative(mention.name));
    const hits = this.output.graph.nodes.filter(
      (n) =>
        n.kind === mention.kind &&
        (!mention.scopeName || (scope && n.scopeId === scope.id)) &&
        [n.name, ...n.aliases].some((a) => key(nominative(a)) === normalized),
    );
    return hits.length === 1 ? hits[0] : undefined;
  }
  structure(draft: StructureDraft, origin: 'rule' | 'agent') {
    for (const mention of [...draft.nodes].sort(
      (a, b) => Number(b.kind === 'unit') - Number(a.kind === 'unit'),
    )) {
      try {
        const refs = this.citations(mention.evidence);
        const scope = mention.scopeName
          ? this.resolve({ kind: 'unit', name: mention.scopeName, scopeName: null })
          : undefined;
        let normalizedName = nominative(mention.name);
        if (mention.kind === 'position' && scope)
          for (const suffix of [scope.name, ...scope.aliases].sort((a, b) => b.length - a.length)) {
            if (key(normalizedName).endsWith(` ${key(suffix)}`))
              normalizedName = normalizedName.slice(0, normalizedName.length - suffix.length).trim();
          }
        const id = identity(mention.kind, normalizedName, scope?.id ?? mention.scopeName ?? '');
        const existing = this.resolve(mention) ?? this.output.graph.nodes.find((n) => n.id === id);
        if (existing) {
          existing.aliases = [...new Set([...existing.aliases, mention.name, ...mention.aliases])];
          existing.evidence = uniqueEvidence([...existing.evidence, ...refs]);
          continue;
        }
        const node: ExtractedNode = {
          id,
          kind: mention.kind,
          name: nominative(mention.name),
          aliases: [...new Set(mention.aliases)],
          scopeId: scope?.id ?? null,
          origin,
          evidence: refs,
          functionIds: [],
        };
        this.output.graph.nodes.push(node);
        if (mention.scopeName && !scope)
          this.issue(
            'unresolved_membership',
            `Membership of ${mention.name} in ${mention.scopeName} could not be resolved.`,
            refs,
            [id],
          );
        if (mention.kind === 'position' && !scope)
          this.issue('unknown_membership', `No unambiguous containing unit for ${mention.name}.`, refs, [id]);
      } catch (error) {
        this.issue('rejected_node', String(error), [], [], 'error');
      }
    }
    for (const relation of draft.edges) {
      try {
        const refs = this.citations(relation.evidence);
        const source = this.resolve(relation.source),
          target = this.resolve(relation.target);
        if (!source || !target) {
          this.issue(
            'unresolved_endpoint',
            `Cannot resolve ${relation.source.name} -> ${relation.target.name} (${relation.type}).`,
            refs,
          );
          continue;
        }
        const id = identity('edge', `${relation.type}:${source.id}:${target.id}`);
        const existing = this.output.graph.edges.find((e) => e.id === id);
        if (existing) existing.evidence = uniqueEvidence([...existing.evidence, ...refs]);
        else
          this.output.graph.edges.push({
            id,
            type: relation.type,
            source: source.id,
            target: target.id,
            origin,
            evidence: refs,
          });
      } catch (error) {
        this.issue('rejected_edge', String(error), [], [], 'error');
      }
    }
    for (const uncertain of draft.uncertainties) {
      try {
        this.issue(
          'structure_uncertainty',
          uncertain.message,
          uncertain.evidence.length ? this.citations(uncertain.evidence) : [],
        );
      } catch (error) {
        this.issue('rejected_citation', String(error), [], [], 'error');
      }
    }
  }
  addFunction(
    clause: Clause,
    atom: {
      ownerIds: string[];
      supportingQuote: string;
      canonical: ExtractedFunction['canonical'];
      contextEvidence: { clauseId: string; quote: string }[];
      exceptions: string[];
      uncertainties: string[];
    },
    origin: 'rule' | 'agent',
  ) {
    const source = evidenceFor(this.index, clause.id, atom.supportingQuote);
    const owners = [...new Set(atom.ownerIds)];
    if (owners.some((id) => !this.output.graph.nodes.some((n) => n.id === id)))
      throw new Error(`Function ${clause.id} references a non-registry owner`);
    const canonical = {
      ...atom.canonical,
      conditions: [...new Set([...atom.canonical.conditions, ...atom.exceptions])],
    };
    if (
      canonical.threshold?.min != null &&
      canonical.threshold.max != null &&
      canonical.threshold.min > canonical.threshold.max
    )
      throw new Error('Invalid threshold interval');
    const context = uniqueEvidence([
      ...clause.contextIds.map((id) => evidenceFor(this.index, id)),
      ...atom.contextEvidence.map((e) => evidenceFor(this.index, e.clauseId, e.quote)),
    ]);
    const evidence = uniqueEvidence([source, ...context]);
    const id = identity(
      'function',
      JSON.stringify([owners.slice().sort(), source.clauseId, source.span, canonical]),
    );
    if (this.output.functions.some((f) => f.id === id)) return;
    const departments = owners.flatMap((id) => {
      const node = this.output.graph.nodes.find((n) => n.id === id)!;
      return node.kind === 'unit' ? [id] : node.scopeId ? [node.scopeId] : [];
    });
    const fn: ExtractedFunction = {
      id,
      ownerIds: owners,
      departmentIds: [...new Set(departments)],
      description: atom.supportingQuote,
      canonical,
      context: {
        headingPath: clause.headingPath,
        references: clause.references,
        resolvedReferences: clause.resolvedReferences,
        exceptions: atom.exceptions,
      },
      evidence,
      origin,
      uncertainties: [...atom.uncertainties],
    };
    if (!owners.length) {
      fn.uncertainties.push('No supported owner identified.');
      this.issue('unresolved_owner', 'Responsibility has no supported owner.', evidence, [id]);
    }
    if (clause.references.length > clause.resolvedReferences.length)
      fn.uncertainties.push('At least one cross-reference is unresolved or ambiguous.');
    if (
      canonical.action === 'unknown' ||
      canonical.authority === 'unknown' ||
      canonical.modality === 'unknown' ||
      !canonical.scope.length
    )
      fn.uncertainties.push('Canonical fields remain uncertain.');
    this.output.functions.push(fn);
    for (const owner of owners) this.output.graph.nodes.find((n) => n.id === owner)!.functionIds.push(id);
  }
}

function uniqueEvidence(refs: SourceEvidence[]) {
  return [...new Map(refs.map((e) => [`${e.documentId}:${e.span.join(':')}`, e])).values()];
}

export function validateExtraction(output: Extraction): Extraction {
  const value = ExtractionSchema.parse(output),
    { nodes, edges } = value.graph;
  const sourceIndex = indexDocuments(value.documents);
  const issue = (code: string, message: string, ids: string[] = []) => {
    const id = identity('issue', `${code}:${message}`);
    if (!value.issues.some((i) => i.id === id))
      value.issues.push({ id, code, message, entityIds: ids, evidence: [], severity: 'error' });
  };
  const all = [...nodes, ...edges, ...value.functions];
  if (new Set(all.map((n) => n.id)).size !== all.length) issue('id_collision', 'Entity IDs are not unique.');
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const item of [...all, ...value.issues])
    for (const ref of item.evidence) {
      const doc = value.documents.find((d) => d.id === ref.documentId);
      const clause = sourceIndex.byId.get(ref.clauseId);
      if (
        !doc ||
        !clause ||
        clause.documentId !== ref.documentId ||
        clause.number !== ref.locator ||
        ref.span[0] < clause.start ||
        ref.span[1] > clause.end ||
        ref.span[1] > doc.text.length ||
        doc.text.slice(...ref.span) !== ref.quote ||
        ref.span[0] >= ref.span[1]
      )
        issue('invalid_evidence', `Invalid source span or clause anchor on ${item.id}.`, [item.id]);
    }
  for (const doc of value.documents)
    if (digest(doc.text) !== doc.sha256)
      issue('document_hash_mismatch', `Source text changed for ${doc.id}.`);
  if (new Set(value.documents.map((d) => d.id)).size !== value.documents.length)
    issue('duplicate_document', 'Document IDs must be unique.');
  const unreviewed = value.coverage.unreviewedClauseIds;
  if (
    value.coverage.totalClauses !== sourceIndex.clauses.length ||
    value.coverage.reviewedClauses + unreviewed.length !== sourceIndex.clauses.length ||
    new Set(unreviewed).size !== unreviewed.length ||
    unreviewed.some((id) => !sourceIndex.byId.has(id))
  )
    issue('invalid_coverage', 'Coverage does not match the source clause inventory.');
  for (const edge of edges) {
    const from = byId.get(edge.source),
      to = byId.get(edge.target);
    if (!from || !to) {
      issue('unknown_endpoint', `Unknown endpoint on ${edge.id}.`, [edge.id]);
      continue;
    }
    if (edge.source === edge.target) issue('self_edge', `Self relationship ${edge.id}.`, [edge.id]);
    if (
      (edge.type === 'part_of' && (from.kind !== 'unit' || to.kind !== 'unit')) ||
      (edge.type === 'member_of' && (from.kind !== 'position' || to.kind !== 'unit')) ||
      (edge.type === 'heads' && (from.kind !== 'position' || to.kind !== 'unit'))
    )
      issue('bad_endpoint_kind', `Invalid actor kinds for ${edge.type}.`, [edge.id]);
  }
  for (const node of nodes) {
    const containers = edges.filter((e) => e.source === node.id && ['part_of', 'member_of'].includes(e.type));
    if (new Set(containers.map((e) => e.target)).size > 1)
      issue('multiple_containers', `Multiple explicit containers require review for ${node.name}.`, [
        node.id,
      ]);
    if (node.scopeId && byId.get(node.scopeId)?.kind !== 'unit')
      issue('invalid_scope', `Unknown unit scope for ${node.name}.`, [node.id]);
    if (node.scopeId && containers.some((e) => e.target !== node.scopeId))
      issue('membership_mismatch', `Scope and containment disagree for ${node.name}.`, [node.id]);
    const heads = edges.filter((e) => e.type === 'heads' && e.target === node.id);
    if (heads.length > 1)
      issue('multiple_heads', `Multiple heads for ${node.name}; verify joint or delegated leadership.`, [
        node.id,
      ]);
    const expected = value.functions
      .filter((f) => f.ownerIds.includes(node.id))
      .map((f) => f.id)
      .sort();
    if (JSON.stringify([...node.functionIds].sort()) !== JSON.stringify(expected))
      issue('function_index_mismatch', `Function index does not match ownership for ${node.name}.`, [
        node.id,
      ]);
  }
  for (const types of [
    ['part_of', 'member_of'],
    ['reports_functionally'],
    ['reports_administratively'],
  ] as const) {
    const graph = new Graph({ directed: true });
    nodes.forEach((n) => graph.setNode(n.id));
    edges
      .filter((e) => (types as readonly string[]).includes(e.type))
      .forEach((e) => graph.setEdge(e.source, e.target));
    if (!alg.isAcyclic(graph))
      issue(
        'cycle',
        `Cycle in ${types.join('/')} graph. Independent relationship types were checked separately.`,
      );
  }
  for (const fn of value.functions) {
    if (fn.ownerIds.some((id) => !byId.has(id)))
      issue('unknown_owner', `Unknown owner on ${fn.id}.`, [fn.id]);
    const expected = [
      ...new Set(
        fn.ownerIds.flatMap((id) => {
          const node = byId.get(id);
          return node?.kind === 'unit' ? [id] : node?.scopeId ? [node.scopeId] : [];
        }),
      ),
    ].sort();
    if (JSON.stringify([...fn.departmentIds].sort()) !== JSON.stringify(expected))
      issue('department_index_mismatch', `Department roll-up disagrees with ownership for ${fn.id}.`, [
        fn.id,
      ]);
  }
  value.coverage.status =
    value.issues.some((i) => i.severity !== 'info') ||
    value.coverage.unreviewedClauseIds.length ||
    value.functions.some((f) => f.uncertainties.length || f.origin === 'agent')
      ? 'needs_review'
      : 'validated';
  return value;
}

export async function extractRevision(
  input: unknown,
  options: {
    store?: Pick<Store, 'cacheGet' | 'cacheSet'>;
    client?: OpenAI;
    session?: AgentSession;
    onProgress?: (message: string) => void;
  } = {},
): Promise<Extraction> {
  const start = performance.now();
  const request = ExtractionRequestSchema.parse(input);
  if (new Set(request.documents.map((d) => d.id)).size !== request.documents.length)
    throw new InputError('Document IDs must be unique within a revision.');
  if (request.documents.reduce((s, d) => s + d.text.length, 0) > 600000)
    throw new InputError('Extraction is limited to 600,000 characters per revision.');
  const index = indexDocuments(request.documents),
    builder = new ExtractionBuilder(request, index);
  options.onProgress?.(`Indexed ${index.clauses.length} source clauses.`);
  if (index.clauses.length > 1800)
    throw new InputError('Extraction is limited to 1,800 clauses per revision.');
  const baseline = localStructure(index);
  if (request.mode === 'local') {
    builder.structure(baseline, 'rule');
    for (const clause of index.clauses) {
      if (
        !/организ|обязан|имеют право|запрещ|осуществ|провер|контрол|утверж|подгот|разраб|согласов|обеспеч|вправе|must|shall|may|approv|audit|report/iu.test(
          clause.text,
        )
      )
        continue;
      if (
        index.clauses.some(
          (c) => c.documentId === clause.documentId && c.number.startsWith(`${clause.number}.`),
        )
      )
        continue;
      const context = [...clause.headingPath, clause.text].join('\n');
      const normalized = normalizeLocal({
        id: clause.id,
        departmentId: 'unresolved',
        description: clause.text,
        evidence: [],
      });
      const prohibition = /не имеют права|не имеет права|не вправе|must not|shall not|prohibited/iu.test(
        context,
      );
      const permission = /имеют право|имеет право|вправе|\bmay\b/iu.test(context);
      const requirement = /обязаны|обязан|\bmust\b|\bshall\b/iu.test(context);
      normalized.canonical.modality = prohibition
        ? 'prohibited'
        : permission
          ? 'permitted'
          : requirement
            ? 'required'
            : normalized.canonical.modality;
      const exceptions = [
        ...context.matchAll(/(?:за исключением|при условии|если|except|provided that)[^\n]+/giu),
      ].map((m) => m[0]);
      try {
        builder.addFunction(
          clause,
          {
            ownerIds: [],
            supportingQuote: clause.text,
            canonical: normalized.canonical,
            contextEvidence: [],
            exceptions,
            uncertainties: [
              'Local mode preserves candidate clauses without claiming semantic normalization or resolved ownership.',
            ],
          },
          'rule',
        );
      } catch (error) {
        builder.issue('rejected_function', String(error), [], [], 'error');
      }
    }
    builder.issue(
      'local_mode',
      'Local extraction is a structural baseline and unassigned responsibility inventory. Use agentic mode and human review for ownership and atomic normalization.',
    );
    builder.output.trace.push({
      stage: 'local',
      action: 'baseline',
      detail: 'Applied general document templates; no LLM calls. Every clause remains unreviewed.',
    });
  } else {
    const session = options.session ?? createAgentSession(index, options.store, options.client);
    const proposals: StructureDraft[] = [];
    for (const batch of batches(index.clauses, (c) => c.text.length, 26000)) {
      options.onProgress?.(
        `Structure agent: ${batch.length} clauses; ${proposals.length} batches completed.`,
      );
      const proposal = await session.run(
        'structure',
        STRUCTURE_INSTRUCTIONS,
        {
          ...batchContext(index, batch),
          baselineCandidates: baseline.nodes.map(({ evidence: _e, ...n }) => n),
        },
        StructureProposal,
      );
      proposals.push(proposal);
    }
    // Resolve a whole-document registry before attaching cross-chunk relationships.
    builder.structure(
      {
        nodes: proposals.flatMap((p) => p.nodes),
        edges: proposals.flatMap((p) => p.edges),
        uncertainties: proposals.flatMap((p) => p.uncertainties),
      },
      'agent',
    );
    if (!builder.output.graph.nodes.length)
      builder.issue('no_structure', 'No grounded organizational entities were extracted.');
    const registry = builder.output.graph.nodes.map(({ id, kind, name, aliases, scopeId }) => ({
      id,
      kind,
      name,
      aliases,
      scopeId,
    }));
    for (const batch of batches(index.clauses, (c) => JSON.stringify(c).length, 14000)) {
      options.onProgress?.(
        `Responsibility agent: ${builder.output.coverage.reviewedClauses}/${index.clauses.length} clauses reviewed.`,
      );
      const payload = { registry, ...batchContext(index, batch) };
      let proposal = await session.run('responsibilities', FUNCTION_INSTRUCTIONS, payload, FunctionProposal);
      const check = (value: typeof proposal) => {
        const ids = value.clauses.map((c) => c.clauseId);
        if (
          ids.length !== batch.length ||
          new Set(ids).size !== batch.length ||
          batch.some((c) => !ids.includes(c.id))
        )
          return ['Every requested clause must appear exactly once.'];
        const errors: string[] = [];
        for (const item of value.clauses) {
          if ((item.disposition === 'functions') !== Boolean(item.functions.length))
            errors.push(`${item.clauseId}: disposition and functions disagree.`);
          for (const atom of item.functions)
            try {
              evidenceFor(index, item.clauseId, atom.supportingQuote);
              atom.contextEvidence.forEach((r) => evidenceFor(index, r.clauseId, r.quote));
              if (atom.ownerIds.some((id) => !registry.some((n) => n.id === id)))
                errors.push(`${item.clauseId}: owner is outside the registry.`);
            } catch (error) {
              errors.push(String(error));
            }
        }
        return errors;
      };
      const errors = check(proposal);
      if (errors.length)
        proposal = await session.run(
          'repair',
          FUNCTION_INSTRUCTIONS,
          { ...payload, previousProposal: proposal, validationErrors: errors },
          FunctionProposal,
        );
      const remaining = check(proposal);
      if (remaining.length)
        throw new InputError(
          'Responsibility extraction failed validation after one repair. No partial result was published.',
          remaining,
        );
      for (const item of proposal.clauses) {
        const clause = index.byId.get(item.clauseId)!;
        if (item.disposition === 'uncertain')
          builder.issue('unreviewed_clause', item.reason, [evidenceFor(index, clause.id)]);
        else {
          builder.output.coverage.reviewedClauses++;
          builder.output.coverage.unreviewedClauseIds = builder.output.coverage.unreviewedClauseIds.filter(
            (id) => id !== clause.id,
          );
        }
        for (const atom of item.functions) builder.addFunction(clause, atom, 'agent');
      }
    }
    const review = await session.run(
      'review',
      `Review the extracted organization for unsupported ownership, role conflation, missing contextual prohibitions/exceptions and conflicting reporting types. Search/read source clauses before alleging a problem. These are advisory review flags, not automatic deletions or repairs. Refer only to existing entity IDs. Do not declare a duty lost without a before/after comparison.`,
      {
        nodes: builder.output.graph.nodes.map(({ evidence: _e, ...n }) => n),
        edges: builder.output.graph.edges,
        functions: builder.output.functions.map((f) => ({
          id: f.id,
          ownerIds: f.ownerIds,
          clauseId: f.evidence[0].clauseId,
          canonical: f.canonical,
        })),
        issues: builder.output.issues.slice(0, 30),
      },
      ReviewProposal,
    );
    const entityIds = new Set(
      [...builder.output.graph.nodes, ...builder.output.graph.edges, ...builder.output.functions].map(
        (e) => e.id,
      ),
    );
    for (const flag of review.issues) {
      try {
        if (flag.entityIds.some((id) => !entityIds.has(id)))
          throw new Error('Reviewer referenced an unknown entity');
        builder.issue(
          `agent_review:${flag.code}`,
          flag.message,
          builder.citations(flag.evidence),
          flag.entityIds,
        );
        for (const fn of builder.output.functions)
          if (flag.entityIds.includes(fn.id) || fn.ownerIds.some((id) => flag.entityIds.includes(id)))
            fn.uncertainties.push(`Reviewer: ${flag.message}`);
      } catch (error) {
        builder.issue('rejected_review', String(error), [], [], 'error');
      }
    }
    builder.output.metrics = session.metrics;
    builder.output.trace.push(...session.trace);
  }
  builder.output.metrics.durationMs = Math.round(performance.now() - start);
  builder.output.trace.push({
    stage: 'validation',
    action: 'source_and_graph_checks',
    detail:
      'Verified source hashes, exact spans, endpoint kinds, membership and each reporting graph separately. Semantic findings remain advisory.',
  });
  return validateExtraction(builder.output);
}
