import { describe, expect, it } from 'vitest';
import { demoGraph } from '../server/demo.js';
import { normalizeGraph } from '../server/normalization.js';
import { analyze, coverage } from '../server/engine/analyze.js';
import { validateGraph } from '../server/engine/validate.js';
import { cleanCanonical, normalizeLocal } from '../server/engine/normalize.js';
import { toInput } from '../shared/input.js';
import { locateQuote } from '../shared/text.js';
import type { Canonical, GraphInput } from '../shared/schema.js';

const copy = (): GraphInput => structuredClone(demoGraph);
const run = async (input = copy()) => analyze((await normalizeGraph(validateGraph(input), 'local')).graph);
const canonical = (extra: Partial<Canonical> = {}): Canonical => ({
  action: 'approve',
  object: 'contract',
  process: 'contract management',
  scope: ['*'],
  authority: 'decision',
  conditions: [],
  modality: 'required',
  frequency: null,
  threshold: null,
  ...extra,
});

describe('lineage analysis', () => {
  it('finds the known preserved, transferred, split, partial and missing functions', async () => {
    const result = await run();
    const statuses = Object.fromEntries(result.matches.map((m) => [m.beforeId, m.status]));
    expect(statuses['b-complaint-review']).toBe('preserved');
    expect(statuses['b-supplier-monitor']).toBe('transferred');
    expect(statuses['b-records-maintain']).toBe('split');
    expect(statuses['b-contract-approve']).toBe('partial');
    expect(statuses['b-incident-report']).toBe('unmatched');
    expect(result.newFunctionIds).toContain('a-risk-report');
    expect(result.metrics.verifiedEvidence).toBe(result.metrics.totalEvidence);
    expect(result.metrics.candidateComparisons).toBeLessThan(result.metrics.possibleComparisons);
  });
  it('detects duplicate ownership without confusing review, execution and audit', async () => {
    const result = await run();
    const duplicates = result.findings.filter((f) => f.kind === 'duplication');
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0].afterIds.sort()).toEqual(['a-supplier-monitor', 'a-supplier-monitor-copy']);
    expect(result.findings.some((f) => f.rule === 'EXECUTE_APPROVE')).toBe(true);
    expect(result.findings.some((f) => f.rule === 'AUDIT_INDEPENDENCE')).toBe(true);
  });
  it('keeps action and approval authority changes visible', async () => {
    const input = copy();
    const fn = input.after.functions.find((f) => f.id === 'a-contract-approve')!;
    fn.canonical!.action = 'review';
    fn.canonical!.authority = 'recommendation';
    const result = await run(input);
    const match = result.matches.find((m) => m.beforeId === 'b-contract-approve')!;
    expect(match.status).toBe('changed');
    expect(match.coverage).toBe('none');
    expect(match.differences.map((d) => d.field)).toContain('authority');
  });
  it('does not treat a prohibition as continued ownership', async () => {
    const input = copy();
    input.after.functions.find((f) => f.id === 'a-complaint-review')!.canonical!.modality = 'prohibited';
    expect((await run(input)).matches.find((m) => m.beforeId === 'b-complaint-review')?.coverage).toBe(
      'none',
    );
  });
  it('flags changed conditions and frequency', async () => {
    const input = copy();
    input.after.functions.find((f) => f.id === 'a-budget-prepare')!.canonical!.frequency = 'quarterly';
    expect((await run(input)).matches.find((m) => m.beforeId === 'b-budget-prepare')?.status).toBe('changed');
  });
  it('does not claim equivalence when a source quote is invented', async () => {
    const input = copy();
    input.before.functions.find((f) => f.id === 'b-complaint-review')!.evidence[0].quote =
      'This passage does not exist.';
    const result = await run(input);
    expect(result.matches.find((m) => m.beforeId === 'b-complaint-review')?.status).toBe('uncertain');
    expect(result.findings.some((f) => f.rule === 'SOURCE_QUOTE_MISMATCH')).toBe(true);
  });
  it('keeps raw local extraction explicitly uncertain', async () => {
    const input = copy();
    delete input.before.functions.find((f) => f.id === 'b-complaint-review')!.canonical;
    const result = await run(input);
    expect(result.matches.find((m) => m.beforeId === 'b-complaint-review')?.status).toBe('uncertain');
    expect(
      normalizeLocal(input.before.functions.find((f) => f.id === 'b-complaint-review')!).normalizationWarnings
        .length,
    ).toBeGreaterThan(0);
  });
  it('does not raise an audit independence flag when auditor reports to the board', async () => {
    const input = copy();
    input.after.departments.find((d) => d.id === 'audit')!.parentId = 'board';
    input.after.relationships.find((r) => r.fromId === 'audit')!.toId = 'board';
    const result = await run(input);
    expect(result.findings.some((f) => f.rule === 'AUDIT_INDEPENDENCE')).toBe(false);
  });
  it('requires source evidence for an audit reporting-line claim', async () => {
    const input = copy();
    input.after.departments.find((d) => d.id === 'audit')!.evidence = [];
    input.after.relationships = input.after.relationships.filter((r) => r.fromId !== 'audit');
    expect((await run(input)).findings.some((f) => f.rule === 'AUDIT_INDEPENDENCE')).toBe(false);
  });
  it('allows empty after snapshots and warns that input may be incomplete', async () => {
    const input = copy();
    input.after.functions = [];
    const result = await run(input);
    expect(result.matches.every((m) => m.status === 'unmatched')).toBe(true);
    expect(result.warnings.some((w) => w.includes('no functions'))).toBe(true);
  });
  it('keeps finding IDs stable across reanalysis', async () => {
    expect((await run()).findings.map((f) => f.id)).toEqual((await run()).findings.map((f) => f.id));
  });
  it('preserves uncertainty through export and reanalysis', async () => {
    const input = copy();
    delete input.before.functions[0].canonical;
    const first = await run(input),
      second = await run(toInput(first.graph));
    expect(first.matches[0].status).toBe('uncertain');
    expect(second.matches[0].status).toBe('uncertain');
  });
  it('detects audit independence risk despite different work frequencies', async () => {
    const input = copy();
    input.after.functions.find((f) => f.id === 'a-invoice-audit')!.canonical!.frequency = 'annual';
    expect((await run(input)).findings.some((f) => f.rule === 'AUDIT_INDEPENDENCE')).toBe(true);
  });
  it('recognizes previously disjoint functions consolidated under one successor', async () => {
    const input = copy();
    const fn = input.before.functions.find((f) => f.id === 'b-records-maintain')!;
    fn.canonical!.scope = ['domestic'];
    input.before.functions.push({
      ...structuredClone(fn),
      id: 'b-records-international',
      canonical: { ...fn.canonical!, scope: ['international'] },
    });
    input.after.functions = input.after.functions.filter((f) => f.id !== 'a-records-international');
    input.after.functions.find((f) => f.id === 'a-records-domestic')!.canonical!.scope = [
      'domestic',
      'international',
    ];
    const result = await run(input);
    expect(result.matches.find((m) => m.beforeId === 'b-records-maintain')?.status).toBe('merged');
    expect(result.matches.find((m) => m.beforeId === 'b-records-international')?.status).toBe('merged');
  });
  it('does not label a duplicate successor as a new unlinked function', async () => {
    expect((await run()).newFunctionIds).not.toContain('a-supplier-monitor-copy');
  });
});

describe('coverage calculation', () => {
  it('recognizes a function split into complementary scopes', () => {
    expect(
      coverage(canonical({ scope: ['domestic', 'international'] }), [
        canonical({ scope: ['domestic'] }),
        canonical({ scope: ['international'] }),
      ]),
    ).toBe('full');
  });
  it('does not claim finite scopes cover an unspecified universal domain', () => {
    expect(
      coverage(canonical(), [canonical({ scope: ['domestic'] }), canonical({ scope: ['international'] })]),
    ).toBe('partial');
  });
  it('finds monetary gaps between successor functions', () => {
    const c = (min: number, max: number) => canonical({ threshold: { min, max, currency: 'KZT' } });
    expect(coverage(c(0, 100), [c(0, 40), c(60, 100)])).toBe('partial');
    expect(coverage(c(0, 100), [c(0, 40), c(40, 100)])).toBe('full');
  });
  it('does not invent coverage by combining different scopes and different limits', () => {
    const old = canonical({
      scope: ['domestic', 'international'],
      threshold: { min: 0, max: 100, currency: 'KZT' },
    });
    expect(
      coverage(old, [
        canonical({ scope: ['domestic'], threshold: { min: 0, max: 50, currency: 'KZT' } }),
        canonical({ scope: ['international'], threshold: { min: 50, max: 100, currency: 'KZT' } }),
      ]),
    ).toBe('partial');
  });
  it('does not confuse unknown scope with all scope', () => {
    expect(coverage(canonical({ scope: [] }), [canonical()])).toBe('unknown');
  });
  it('normalizes supported terminology aliases', () => {
    expect(cleanCanonical(canonical({ object: 'Vendor compliance' })).object).toBe('supplier compliance');
  });
});

describe('graph validation', () => {
  it('locates evidence with normalized whitespace and literal punctuation', () => {
    const text = 'Section 1: Approve contracts (up to 1m).\n\nNext section.';
    const range = locateQuote(text, 'contracts (up to 1m). Next');
    expect(range).not.toBeNull();
    expect(text.slice(range!.start, range!.end)).toBe('contracts (up to 1m).\n\nNext');
    expect(locateQuote(text, '.*')).toBeNull();
  });
  it('checks explicit audit edges against the sourced reporting hierarchy', async () => {
    const input = copy();
    const quote = 'Internal audit audits Finance.';
    input.after.documents[1].text += `\n${quote}`;
    input.after.relationships.push({
      id: 'explicit-audit',
      type: 'audits',
      fromId: 'audit',
      toId: 'finance',
      evidence: [{ documentId: input.after.documents[1].id, locator: 'Section 9', quote }],
    });
    expect((await run(input)).findings.some((f) => f.rule === 'AUDIT_REPORTING_LINE')).toBe(true);
  });
  it('rejects missing department references', () => {
    const g = copy();
    g.before.functions[0].departmentId = 'absent';
    expect(() => validateGraph(g)).toThrow('invalid references');
  });
  it('rejects duplicate IDs', () => {
    const g = copy();
    g.before.functions.push(g.before.functions[0]);
    expect(() => validateGraph(g)).toThrow('invalid references');
  });
  it('rejects reporting cycles', () => {
    const g = copy();
    g.after.departments.find((d) => d.id === 'board')!.parentId = 'finance';
    expect(() => validateGraph(g)).toThrow('invalid references');
  });
  it('rejects inverted monetary bounds', () => {
    const g = copy();
    g.after.functions[0].canonical!.threshold = { min: 10, max: 1, currency: 'KZT' };
    expect(() => validateGraph(g)).toThrow('invalid references');
  });
  it('rejects invalid previous department IDs', () => {
    const g = copy();
    g.after.departments[0].previousIds = ['missing'];
    expect(() => validateGraph(g)).toThrow('invalid references');
  });
  it('rejects malformed input', () => {
    expect(() => validateGraph({ before: {} })).toThrow('contract');
  });
});
