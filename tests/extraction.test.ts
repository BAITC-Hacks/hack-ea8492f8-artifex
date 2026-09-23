import { beforeAll, describe, expect, it, vi } from 'vitest';
import OpenAI from 'openai';
import { z } from 'zod';
import { realExampleRequests } from '../server/extraction/examples.js';
import { indexDocuments, evidenceFor, identity } from '../server/extraction/document.js';
import { extractRevision, ExtractionBuilder, validateExtraction } from '../server/extraction/pipeline.js';
import { createAgentSession, type AgentSession } from '../server/extraction/agent.js';
import { adaptGraph } from '../server/adapters/graph.js';
import { normalizeGraph } from '../server/normalization.js';
import { analyze } from '../server/engine/analyze.js';
import { htmlReport } from '../server/report.js';
import { buildSupplementary, validateSupplementary } from '../server/extraction/supplementary.js';
import { Store } from '../server/store.js';
import { ExtractionSchema, type Extraction, type ExtractionRequest } from '../shared/extraction.js';
import { demoGraph } from '../server/demo.js';

const request = (text: string, mode: 'local' | 'agentic' = 'local'): ExtractionRequest => ({
  revision: { id: 'test', label: 'Test', date: '2026-01-01' },
  documents: [{ id: 'doc', title: 'Test document', text }],
  mode,
});
const canonical = {
  action: 'approve' as const,
  object: 'contract',
  process: 'procurement',
  scope: ['company'],
  authority: 'decision' as const,
  modality: 'required' as const,
  conditions: [],
  frequency: null,
  threshold: null,
};

describe('document segmentation and provenance', () => {
  it('splits glued clauses without splitting an inline reference', () => {
    const index = indexDocuments(
      request(
        '3.9. Staff. 3.10.Workers report to a director in clause 5.10 of this regulation.\n5.10. Approval rules.',
      ).documents,
    );
    expect(index.clauses.map((c) => c.number)).toEqual(['3.9', '3.10', '5.10']);
    expect(index.clauses[1].resolvedReferences).toEqual(['doc:5.10:1']);
  });
  it('retains exact spans even with non-BMP characters', () => {
    const text = '1. A symbol \u{1F4C4} precedes the clause.\n2. Approve contracts.';
    const index = indexDocuments(request(text).documents),
      ref = evidenceFor(index, 'doc:2:1', 'Approve contracts.');
    expect(text.slice(...ref.span)).toBe(ref.quote);
    expect(() => evidenceFor(index, 'doc:2:1', 'approve CONTRACTS')).toThrow('verbatim');
  });
  it('does not confuse references across documents', () => {
    const docs = [
      { id: 'a', title: 'A', text: '1. Read clause 9.2.' },
      { id: 'b', title: 'B', text: '9.2. Different document.' },
    ];
    const index = indexDocuments(docs);
    expect(index.clauses[0].resolvedReferences).toEqual([]);
    expect(index.issues.join(' ')).toContain('unresolved');
  });
  it('flags duplicate numbers and does not guess a reference target', () => {
    const index = indexDocuments(request('1. See clause 2.\n2. One.\n2. Two.').documents);
    expect(index.clauses[0].resolvedReferences).toEqual([]);
    expect(index.issues.join(' ')).toContain('ambiguous');
  });
  it('handles both leading and trailing tables of contents', () => {
    for (const text of [
      '**Оглавление**\n\n**1. INTRODUCTION 1**\n\n1. Actual responsibility.',
      '1. Actual responsibility.\n\n**Оглавление**\n\n**1. INTRODUCTION 1**',
    ]) {
      const index = indexDocuments(request(text).documents);
      expect(index.clauses.filter((c) => c.number === '1')).toHaveLength(1);
      expect(index.clauses.find((c) => c.number === '1')?.text).toContain('Actual responsibility.');
    }
  });
  it('provides stable paragraph anchors for unnumbered documents', () => {
    const index = indexDocuments(
      request('Finance must approve contracts.\n\nAudit must review controls.').documents,
    );
    expect(index.clauses).toHaveLength(2);
    expect(index.clauses[1].number).toBe('paragraph-2');
  });
  it('preserves an unnumbered owner heading as citable context', () => {
    const index = indexDocuments(request('Chief auditor:\n1. Must approve the audit plan.').documents);
    const clause = index.byId.get('doc:1:1')!;
    expect(clause.headingPath).toContain('Chief auditor:');
    expect(clause.contextIds).toContain('doc:preamble:1');
    expect(evidenceFor(index, clause.contextIds[0]).quote).toContain('Chief auditor:');
  });
  it('inherits prohibitions and preserves exceptions', async () => {
    const out = await extractRevision(
      request(
        '5. Employees.\n5.8. Employees must not:\n5.8.1. approve contracts except their own budget contracts.',
      ),
    );
    const fn = out.functions.find((f) => f.evidence[0].locator === '5.8.1')!;
    expect(fn.canonical.modality).toBe('prohibited');
    expect(fn.canonical.conditions.join(' ')).toContain('except their own budget');
    expect(fn.evidence.some((e) => e.locator === '5.8')).toBe(true);
    expect(fn.ownerIds).toEqual([]);
  });
  it('does not inherit a neighboring rights heading into a prohibition', () => {
    const index = indexDocuments(
      request(
        '5. Duties.\n5.7. Employees may:\n5.7.1. request records.\n5.8. Employees must not:\n5.8.1. approve transactions.',
      ).documents,
    );
    const clause = index.byId.get('doc:5.8.1:1')!;
    expect(clause.headingPath).toEqual(['5. Duties.', '5.8. Employees must not:']);
    expect(clause.contextIds).not.toContain('doc:5.7:1');
  });
});

describe('full organizer documents (hand-checked structural expectations)', () => {
  let before: Extraction, after: Extraction;
  beforeAll(async () => {
    const examples = await realExampleRequests();
    before = await extractRevision({ ...examples.before, mode: 'local' });
    after = await extractRevision({ ...examples.after, mode: 'local' });
  });
  it('extracts two versus four departments plus the containing audit block', () => {
    expect(before.graph.nodes.filter((n) => n.kind === 'unit')).toHaveLength(3);
    expect(after.graph.nodes.filter((n) => n.kind === 'unit')).toHaveLength(5);
    expect(after.graph.edges.filter((e) => e.type === 'part_of')).toHaveLength(4);
  });
  it('keeps the four project-director positions distinct by their unit', () => {
    const nodes = after.graph.nodes.filter((n) => n.name === 'Директор проектов');
    expect(nodes).toHaveLength(4);
    expect(new Set(nodes.map((n) => n.scopeId)).size).toBe(4);
  });
  it('does not invent a data-center unit from a role name', () => {
    expect(
      after.graph.nodes.some((n) => n.kind === 'position' && n.name === 'Директор Центра анализа данных'),
    ).toBe(true);
    expect(after.graph.nodes.some((n) => n.kind === 'unit' && n.name.includes('Центр'))).toBe(false);
  });
  it('separates administrative and functional reporting of the chief auditor', () => {
    const chief = after.graph.nodes.find((n) => n.name === 'Главный аудитор')!;
    const edges = after.graph.edges.filter((e) => e.source === chief.id);
    expect(edges.some((e) => e.type === 'reports_functionally')).toBe(true);
    expect(edges.some((e) => e.type === 'reports_administratively')).toBe(true);
  });
  it('keeps functional supervision from assigning the audit manager to the block', () => {
    const managers = before.graph.nodes.filter((n) => n.name === 'Менеджер по аудиту');
    expect(managers).toHaveLength(1);
    const department = before.graph.nodes.find((n) => n.aliases.includes('ДККМ'))!;
    expect(managers[0].scopeId).toBe(department.id);
    expect(
      before.graph.edges.filter((e) => e.source === managers[0].id && e.type === 'reports_functionally'),
    ).toHaveLength(1);
  });
  it('retains real renumbering and redistribution clauses for later semantic comparison', () => {
    const old = indexDocuments(before.documents),
      next = indexDocuments(after.documents);
    expect(old.byId.get('audit-regulation-8:5.4.5:1')!.text.split(' ').slice(1).join(' ')).toBe(
      next.byId.get('audit-regulation-9:5.4.4:1')!.text.split(' ').slice(1).join(' '),
    );
    expect(old.byId.get('audit-regulation-8:5.4.4:1')!.text).toContain('Карты гарантий');
    expect(next.byId.get('audit-regulation-9:5.3.3:1')!.text).toContain('Карты гарантий');
    expect(next.byId.has('audit-regulation-9:3.10:1')).toBe(true);
    expect(next.byId.has('audit-regulation-9:14:1')).toBe(true);
  });
  it('verifies every emitted quote and reports honest incomplete local coverage', () => {
    for (const out of [before, after]) {
      for (const item of [...out.graph.nodes, ...out.graph.edges, ...out.functions])
        for (const e of item.evidence)
          expect(out.documents.find((d) => d.id === e.documentId)!.text.slice(...e.span)).toBe(e.quote);
      expect(out.coverage.status).toBe('needs_review');
      expect(out.coverage.reviewedClauses).toBe(0);
      expect(out.issues.filter((i) => i.severity === 'error')).toEqual([]);
      expect(ExtractionSchema.safeParse(out).success).toBe(true);
    }
  });
  it('keeps unit changes separate from positions and external bodies', async () => {
    const input = adaptGraph({ schemaVersion: '2.0', title: 'Real structural comparison', before, after });
    const result = analyze((await normalizeGraph(input, 'local')).graph);
    expect(result.departmentChanges.filter((d) => d.status === 'created')).toHaveLength(2);
    const quality = result.departmentChanges.find((d) =>
      d.beforeIds.some((id) => before.graph.nodes.find((n) => n.id === id)?.aliases.includes('ДККМ')),
    )!;
    expect(quality.status).toBe('transformed');
    expect(new Set(quality.evidence?.map((e) => e.snapshot))).toEqual(new Set(['before', 'after']));
    expect(quality.evidence?.every((e) => e.verified)).toBe(true);
    const report = htmlReport({ result, reviews: {} });
    expect(report).toContain('Conclusion');
    expect(report).toContain('functional continuity cannot yet be assessed');
    expect(report).toContain('Action plan');
    expect(report).toContain('Internal audit regulation, edition 9');
  });
  it('rejects tampered source spans before comparison', () => {
    const bad = structuredClone(after);
    bad.graph.nodes[0].evidence[0].span[0]++;
    expect(validateExtraction(bad).issues.some((i) => i.code === 'invalid_evidence')).toBe(true);
    expect(() => adaptGraph({ schemaVersion: '2.0', title: 'Bad input', before, after: bad })).toThrow(
      'corrections',
    );
  });
  it('returns cited reference and peer-structure candidates without claiming legal compliance', () => {
    const pair = { schemaVersion: '2.0' as const, title: 'Example', before, after };
    const supplementary = buildSupplementary(
      pair,
      [
        {
          id: 'reference',
          title: 'Provided standard',
          text: '1. Организация должна проводить внутренний аудит.',
        },
      ],
      [
        {
          name: 'Peer',
          documents: [
            {
              id: 'peer',
              title: 'Peer structure',
              text: '1. Департамент операционного аудита (ДОА) осуществляет проверки.',
            },
          ],
        },
      ],
    );
    expect(supplementary.checks.some((check) => check.category === 'reference')).toBe(true);
    expect(supplementary.checks.some((check) => check.category === 'operator')).toBe(true);
    expect(supplementary.checks.every((check) => check.evidence.length > 0)).toBe(true);
    expect(
      supplementary.checks.find((check) => check.title.includes('Департамент операционного аудита'))?.status,
    ).toBe('candidate_match');
    expect(
      supplementary.checks.find((check) => check.title.includes('Департамент ИТ-аудита'))?.status,
    ).toBe('needs_review');
    const tampered = structuredClone(supplementary);
    tampered.checks[0].evidence[0].span[0]++;
    expect(() => validateSupplementary(pair, tampered)).toThrow('Invalid supplementary citation');
    const duplicate = structuredClone(supplementary);
    duplicate.documents[0].id = pair.after.documents[0].id;
    expect(() => validateSupplementary(pair, duplicate)).toThrow('must differ');
  });
  it('verifies issue evidence too, including its clause locator', () => {
    const bad = structuredClone(after);
    const issue = bad.issues.find((i) => i.evidence.length)!;
    issue.evidence[0].locator = '99.99';
    expect(validateExtraction(bad).issues.some((i) => i.code === 'invalid_evidence')).toBe(true);
  });
});

describe('agentic protocol', () => {
  it('produces a fully linked graph and department functions through all specialist stages', async () => {
    const req = request('1. Finance department approves contracts for the company.', 'agentic');
    const session = {
      run: async (stage: string, _instruction: string, payload: { registry?: { id: string }[] }) => {
        if (stage === 'structure')
          return {
            nodes: [
              {
                kind: 'unit',
                name: 'Finance department',
                scopeName: null,
                aliases: ['Finance'],
                evidence: [{ clauseId: 'doc:1:1', quote: req.documents[0].text }],
              },
            ],
            edges: [],
            uncertainties: [],
          };
        if (stage === 'review') return { issues: [] };
        return {
          clauses: [
            {
              clauseId: 'doc:1:1',
              disposition: 'functions',
              reason: 'Explicit assignment',
              functions: [
                {
                  ownerIds: [payload.registry![0].id],
                  supportingQuote: req.documents[0].text,
                  canonical,
                  contextEvidence: [],
                  exceptions: [],
                  uncertainties: [],
                },
              ],
            },
          ],
        };
      },
      metrics: { model: 'mock', calls: 0, cacheHits: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 },
      trace: [],
    } as unknown as AgentSession;
    const result = await extractRevision(req, { session });
    expect(result.graph.nodes[0].functionIds).toEqual([result.functions[0].id]);
    expect(result.functions[0].departmentIds).toEqual([result.graph.nodes[0].id]);
    expect(result.issues).toEqual([]);
    expect(result.coverage.reviewedClauses).toBe(1);
    expect(result.coverage.status).toBe('needs_review');
    expect(
      adaptGraph({ schemaVersion: '2.0', title: 'Linked', before: result, after: result }).after.functions,
    ).toHaveLength(1);
  });
  it('executes document tools, validates JSON, and caches the completed stage', async () => {
    const index = indexDocuments(request('1. Finance approves contracts.').documents);
    const parse = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'completed',
        output: [
          {
            type: 'function_call',
            name: 'read_clause',
            arguments: '{"clauseId":"doc:1:1"}',
            call_id: 'call1',
            id: 'fc1',
          },
        ],
        usage: { input_tokens: 4, output_tokens: 5 },
      })
      .mockResolvedValueOnce({
        status: 'completed',
        output: [],
        output_parsed: { ok: true },
        usage: { input_tokens: 6, output_tokens: 7 },
      });
    const store = new Store(':memory:');
    try {
      const session = createAgentSession(index, store, { responses: { parse } } as unknown as OpenAI);
      expect(await session.run('test', 'Read the clause.', {}, z.object({ ok: z.boolean() }))).toEqual({
        ok: true,
      });
      expect(session.trace.some((e) => e.action === 'read_clause')).toBe(true);
      const sent = parse.mock.calls[1][0].input.find(
        (i: { type: string }) => i.type === 'function_call_output',
      );
      expect(JSON.parse(sent.output).text).toBe('1. Finance approves contracts.');
      await session.run('test', 'Read the clause.', {}, z.object({ ok: z.boolean() }));
      expect(parse).toHaveBeenCalledTimes(2);
      expect(session.metrics.cacheHits).toBe(1);
      expect(session.metrics.inputTokens).toBe(10);
    } finally {
      store.close();
    }
  });
  it('stops bounded tool loops and never runs invented tools', async () => {
    const parse = vi.fn(async () => ({
      output: [{ type: 'function_call', name: 'run_shell', arguments: '{}', call_id: 'blocked', id: 'fc' }],
      usage: {},
    }));
    const session = createAgentSession(indexDocuments(request('1. Data.').documents), undefined, {
      responses: { parse },
    } as unknown as OpenAI);
    await expect(session.run('test', 'Read only.', {}, z.object({ ok: z.boolean() }))).rejects.toThrow(
      'tool-turn limit',
    );
    expect(parse).toHaveBeenCalledTimes(7);
    expect(JSON.stringify(parse.mock.calls)).toContain('Tool is not allowed');
  });
  it('rejects incomplete or refused model output', async () => {
    const client = {
      responses: { parse: async () => ({ status: 'incomplete', output: [], output_parsed: null }) },
    } as unknown as OpenAI;
    const session = createAgentSession(indexDocuments(request('1. Data.').documents), undefined, client);
    await expect(session.run('test', 'Read only.', {}, z.object({ ok: z.boolean() }))).rejects.toThrow(
      'did not finish',
    );
  });
  it('records rejected structural hallucinations instead of silently adding them', () => {
    const req = request('1. Finance approves contracts.'),
      index = indexDocuments(req.documents),
      builder = new ExtractionBuilder(req, index);
    builder.structure(
      {
        nodes: [
          {
            kind: 'unit',
            name: 'Finance',
            scopeName: null,
            aliases: [],
            evidence: [{ clauseId: 'doc:1:1', quote: 'Imaginary quote' }],
          },
        ],
        edges: [],
        uncertainties: [],
      },
      'agent',
    );
    expect(builder.output.graph.nodes).toHaveLength(0);
    expect(builder.output.issues[0].code).toBe('rejected_node');
  });
  it('uses one repair pass and preserves an unassigned function when ownership is unclear', async () => {
    const req = request('1. Finance approves contracts.', 'agentic');
    const run = vi.fn(async (stage: string) => {
      if (stage === 'structure') return { nodes: [], edges: [], uncertainties: [] };
      if (stage === 'review') return { issues: [] };
      return {
        clauses: [
          {
            clauseId: 'doc:1:1',
            disposition: 'functions',
            reason: 'explicit action',
            functions: [
              {
                ownerIds: [],
                supportingQuote: stage === 'repair' ? 'Finance approves contracts.' : 'Invented',
                canonical,
                contextEvidence: [],
                exceptions: [],
                uncertainties: [],
              },
            ],
          },
        ],
      };
    });
    const session = {
      run,
      metrics: { model: 'mock', calls: 0, cacheHits: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 },
      trace: [],
    } as unknown as AgentSession;
    const result = await extractRevision(req, { session });
    expect(run.mock.calls.filter(([stage]) => stage === 'repair')).toHaveLength(1);
    expect(result.functions[0].ownerIds).toEqual([]);
    expect(result.issues.some((i) => i.code === 'unresolved_owner')).toBe(true);
    expect(result.coverage.status).toBe('needs_review');
  });
  it('rejects an invalid repair instead of publishing partial output', async () => {
    const session = {
      run: async (stage: string) =>
        stage === 'structure' ? { nodes: [], edges: [], uncertainties: [] } : { clauses: [] },
      metrics: { model: 'mock', calls: 0, cacheHits: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 },
      trace: [],
    } as unknown as AgentSession;
    await expect(
      extractRevision(request('1. Finance approves contracts.', 'agentic'), { session }),
    ).rejects.toThrow('after one repair');
  });
  it('assigns deterministic scoped IDs rather than accepting model IDs', () => {
    expect(identity('position', 'Project director', 'Department A')).not.toBe(
      identity('position', 'Project director', 'Department B'),
    );
    expect(identity('position', 'Project director', 'Department A')).toBe(
      identity('position', 'Project director', 'Department A'),
    );
  });
});

describe('typed reporting safety', () => {
  it('does not infer independence conflicts from administrative reporting or containment', async () => {
    const graph = structuredClone(demoGraph);
    graph.after.hierarchyKind = 'containment';
    for (const r of graph.after.relationships)
      if (r.type === 'reports_to') r.type = 'reports_administratively';
    const result = analyze((await normalizeGraph(graph, 'local')).graph);
    expect(result.findings.some((f) => f.rule === 'AUDIT_INDEPENDENCE')).toBe(false);
  });
  it('still checks evidenced functional reporting', async () => {
    const graph = structuredClone(demoGraph);
    graph.after.hierarchyKind = 'containment';
    for (const r of graph.after.relationships) if (r.type === 'reports_to') r.type = 'reports_functionally';
    const result = analyze((await normalizeGraph(graph, 'local')).graph);
    expect(result.findings.some((f) => f.rule === 'AUDIT_INDEPENDENCE')).toBe(true);
  });
});
