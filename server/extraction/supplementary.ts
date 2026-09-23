import type { ExtractedPair, SourceDocument, Supplementary } from '../../shared/extraction.js';
import { InputError } from '../engine/validate.js';
import { digest, evidenceFor, identity, indexDocuments, key } from './document.js';
import { localStructure } from './local.js';

const stop = new Set([
  'the',
  'and',
  'for',
  'with',
  'shall',
  'must',
  'this',
  'that',
  'from',
  'департамент',
  'блок',
  'управление',
  'отдел',
  'служба',
  'общества',
  'должен',
  'должны',
  'обязан',
  'обязаны',
  'при',
  'для',
  'или',
  'иных',
  'этого',
  'данного',
  'пункт',
  'части',
  'право',
  'работников',
]);
function terms(value: string) {
  return new Set(
    key(value)
      .split(' ')
      .filter((word) => word.length > 3 && !stop.has(word))
      .map((word) => (word.length > 6 ? word.slice(0, 6) : word)),
  );
}
function similarity(a: string, b: string) {
  const left = terms(a),
    right = terms(b);
  if (!left.size || !right.size) return 0;
  const shared = [...left].filter((word) => right.has(word)).length;
  return shared / Math.sqrt(left.size * right.size);
}

function peerNameMatch(a: string, b: string) {
  const left = terms(a),
    right = terms(b);
  const shared = [...left].filter((word) => right.has(word)).length;
  return key(a) === key(b) || (shared >= 2 && similarity(a, b) >= 0.4);
}

export function buildSupplementary(
  pair: ExtractedPair,
  referenceDocuments: SourceDocument[],
  operators: { name: string; documents: SourceDocument[] }[],
): Supplementary {
  const extra = [...referenceDocuments, ...operators.flatMap((operator) => operator.documents)];
  const all = [...pair.after.documents, ...extra];
  if (new Set(all.map((document) => document.id)).size !== all.length)
    throw new InputError('Reference and operator document IDs must differ from after-document IDs.');
  if (extra.reduce((size, document) => size + document.text.length, 0) > 300000)
    throw new InputError('Optional documents are limited to 300,000 characters in total.');
  const output: Supplementary = {
    documents: extra.map((document) => ({ ...document, sha256: digest(document.text) })),
    referenceDocumentIds: referenceDocuments.map((document) => document.id),
    operators: operators.map((operator) => ({
      name: operator.name,
      documentIds: operator.documents.map((document) => document.id),
    })),
    checks: [],
    warnings: [],
  };
  if (referenceDocuments.length) {
    const index = indexDocuments(referenceDocuments);
    const norms = index.clauses.filter((clause) =>
      /\b(?:must|shall|required|prohibited)\b|обязан[а-я]*|должн[а-я]*|не вправе|запрещ|необходимо/iu.test(
        clause.text,
      ),
    );
    if (!norms.length)
      output.warnings.push('No explicit obligations or prohibitions were found in the reference documents.');
    for (const clause of norms.slice(0, 120)) {
      const candidates = pair.after.functions
        .map((fn) => ({ fn, score: similarity(clause.text, fn.description) }))
        .sort((a, b) => b.score - a.score);
      const best = candidates[0];
      const matched = best && best.score >= 0.3 ? best.fn : null;
      const status = matched?.ownerIds.length ? 'candidate_match' : 'needs_review';
      output.checks.push({
        id: identity('reference-check', `${clause.id}:${matched?.id ?? ''}`),
        category: 'reference',
        status,
        title: `Reference clause ${clause.number}`,
        explanation: matched
          ? matched.ownerIds.length
            ? 'Similar wording appears in an assigned responsibility. This is a candidate mapping, not a compliance conclusion.'
            : 'Similar wording appears in an unassigned responsibility; no accountable owner can yet be confirmed.'
          : 'No sufficiently similar responsibility was found in the supplied after documents. This is a search gap, not proof of noncompliance.',
        recommendation:
          'Compare the full conditions, scope, effective dates and authority with a subject-matter reviewer.',
        entityIds: matched ? [matched.id] : [],
        evidence: [evidenceFor(index, clause.id), ...(matched ? [matched.evidence[0]] : [])],
      });
    }
    if (norms.length > 120)
      output.warnings.push(
        `${norms.length - 120} further reference clauses were not screened; split the reference set.`,
      );
  }
  const beforeUnits = pair.before.graph.nodes.filter((node) => node.kind === 'unit');
  const afterUnits = pair.after.graph.nodes.filter((node) => node.kind === 'unit');
  const changedUnits = afterUnits.filter((unit) => {
    const previous = beforeUnits.find((old) => key(old.name) === key(unit.name));
    if (!previous) return true;
    const count = (nodes: typeof pair.before.graph.nodes, id: string) =>
      nodes.filter((node) => node.kind === 'position' && node.scopeId === id).length;
    return count(pair.before.graph.nodes, previous.id) !== count(pair.after.graph.nodes, unit.id);
  });
  if (operators.length && !changedUnits.length)
    output.warnings.push('No created or composition-changed units were identified for operator comparison.');
  for (const operator of operators) {
    const index = indexDocuments(operator.documents);
    const draft = localStructure(index);
    const peerUnits = draft.nodes.filter((node) => node.kind === 'unit');
    if (!peerUnits.length) {
      output.warnings.push(
        `${operator.name}: no explicit structural units could be extracted from the supplied documents.`,
      );
      continue;
    }
    for (const unit of changedUnits) {
      const best = peerUnits
        .map((peer) => ({ peer, score: similarity(unit.name, peer.name) }))
        .sort((a, b) => b.score - a.score)[0];
      if (!best) continue;
      const peerEvidence = best.peer.evidence[0];
      output.checks.push({
        id: identity('operator-check', `${operator.name}:${unit.id}:${best.peer.name}`),
        category: 'operator',
        status: peerNameMatch(unit.name, best.peer.name) ? 'candidate_match' : 'needs_review',
        title: `${operator.name}: ${unit.name}`,
        explanation: peerNameMatch(unit.name, best.peer.name)
          ? `A similarly named peer unit (${best.peer.name}) was found. This is a structural comparison candidate, not a best-practice judgment.`
          : `No clear counterpart was found by name. The closest extracted peer unit was ${best.peer.name}; its mandate and staffing require manual comparison.`,
        recommendation:
          'Compare reporting lines, documented roles and mandates before considering a structural change.',
        entityIds: [unit.id],
        evidence: [unit.evidence[0], evidenceFor(index, peerEvidence.clauseId, peerEvidence.quote)],
      });
    }
  }
  validateSupplementary(pair, output);
  return output;
}

export function validateSupplementary(pair: ExtractedPair, supplementary: Supplementary) {
  const allDocuments = [...pair.after.documents, ...supplementary.documents];
  if (new Set(allDocuments.map((document) => document.id)).size !== allDocuments.length)
    throw new InputError('Supplementary document IDs must differ from after-document IDs.');
  const index = indexDocuments(allDocuments);
  const documentIds = new Set(supplementary.documents.map((document) => document.id));
  if (
    documentIds.size !== supplementary.documents.length ||
    supplementary.referenceDocumentIds.some((id) => !documentIds.has(id)) ||
    supplementary.operators.some((operator) => operator.documentIds.some((id) => !documentIds.has(id)))
  )
    throw new InputError('Supplementary document registry is inconsistent.');
  for (const document of supplementary.documents)
    if (digest(document.text) !== document.sha256)
      throw new InputError(`Supplementary document hash mismatch: ${document.id}.`);
  const ids = new Set([...pair.after.graph.nodes, ...pair.after.functions].map((entity) => entity.id));
  for (const check of supplementary.checks) {
    if (check.entityIds.some((id) => !ids.has(id)))
      throw new InputError(`Unknown supplementary entity in ${check.id}.`);
    for (const ref of check.evidence) {
      const clause = index.byId.get(ref.clauseId);
      const document = index.documents.find((item) => item.id === ref.documentId);
      if (
        !clause ||
        !document ||
        clause.documentId !== ref.documentId ||
        clause.number !== ref.locator ||
        ref.span[0] < clause.start ||
        ref.span[1] > clause.end ||
        document.text.slice(...ref.span) !== ref.quote
      )
        throw new InputError(`Invalid supplementary citation in ${check.id}.`);
    }
  }
}
