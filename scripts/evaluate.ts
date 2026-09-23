import { demoGraph } from '../server/demo.js';
import { normalizeGraph } from '../server/normalization.js';
import { analyze } from '../server/engine/analyze.js';

const result = analyze((await normalizeGraph(demoGraph, 'local')).graph);
const expected: Record<string, string> = {
  'b-supplier-monitor': 'transferred',
  'b-contract-approve': 'partial',
  'b-records-maintain': 'split',
  'b-incident-report': 'unmatched',
  'b-invoice-process': 'preserved',
  'b-invoice-approve': 'transferred',
  'b-invoice-audit': 'transferred',
  'b-complaint-review': 'preserved',
  'b-budget-prepare': 'preserved',
  'b-supplier-audit': 'transferred',
  'b-inventory-manage': 'transferred',
};
const correct = result.matches.filter((m) => expected[m.beforeId] === m.status).length;
const expectedFindings = [
  ['LINEAGE_PARTIAL', 'b-contract-approve'],
  ['LINEAGE_UNMATCHED', 'b-incident-report'],
  ['DUPLICATE_RESPONSIBILITY', 'a-supplier-monitor'],
  ['EXECUTE_APPROVE', 'a-invoice-process'],
  ['AUDIT_INDEPENDENCE', 'a-invoice-process'],
  ['AUDIT_INDEPENDENCE', 'a-invoice-approve'],
];
const truePositives = expectedFindings.filter(([rule, id]) =>
  result.findings.some((f) => f.rule === rule && [...f.beforeIds, ...f.afterIds].includes(id)),
).length;
const metrics = {
  dataset: 'Synthetic sample only; not an estimate of real-document accuracy',
  lineageExactMatch: `${correct}/${Object.keys(expected).length}`,
  findingPrecision: truePositives / (result.findings.length || 1),
  findingRecall: truePositives / expectedFindings.length,
  quotePresence: `${result.metrics.verifiedEvidence}/${result.metrics.totalEvidence}`,
  detailedComparisons: result.metrics.candidateComparisons,
  possiblePairs: result.metrics.possibleComparisons,
  engineDurationMs: result.metrics.durationMs,
};
console.log(JSON.stringify(metrics, null, 2));
if (
  correct !== Object.keys(expected).length ||
  truePositives !== expectedFindings.length ||
  result.findings.length !== expectedFindings.length
)
  process.exitCode = 1;
