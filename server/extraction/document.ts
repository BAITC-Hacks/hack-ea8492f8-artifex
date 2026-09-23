import { createHash } from 'node:crypto';
import type { SourceDocument, SourceEvidence } from '../../shared/extraction.js';

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function key(value: string) {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
export function identity(kind: string, name: string, scope = '') {
  return `${kind}:${digest(JSON.stringify([key(name), key(scope)])).slice(0, 20)}`;
}
export type Clause = {
  id: string;
  documentId: string;
  number: string;
  text: string;
  start: number;
  end: number;
  headingPath: string[];
  contextIds: string[];
  references: string[];
  resolvedReferences: string[];
};
export type DocumentIndex = {
  documents: SourceDocument[];
  clauses: Clause[];
  byId: Map<string, Clause>;
  issues: string[];
};

export function indexDocuments(documents: SourceDocument[]): DocumentIndex {
  const clauses: Clause[] = [],
    issues: string[] = [];
  for (const doc of documents) {
    // Offsets always address the unchanged supplied text, including Markdown markers.
    const toc = /^(?:\*\*)?(?:СОДЕРЖАНИЕ|ОГЛАВЛЕНИЕ|TABLE OF CONTENTS)(?:\*\*)?\s*$/im.exec(doc.text);
    const text = doc.text;
    let tocEnd = toc ? toc.index + toc[0].length : -1;
    if (toc) {
      for (const line of text.slice(tocEnd).matchAll(/[^\n]*(?:\n|$)/g)) {
        const clean = line[0].trim().replace(/^\*\*|\*\*$/g, '');
        if (clean && !/^\d{1,2}\\?\..*\s\d+(?:\s.*)?$/u.test(clean)) break;
        tocEnd += line[0].length;
      }
      issues.push(`${doc.id}: table-of-contents entries were excluded; source text remains intact.`);
    }
    const inToc = (offset: number) => Boolean(toc && offset >= toc.index && offset < tocEnd);
    const starts = new Map<number, string>();
    const numbered = /^[ \t]*(?:#{1,6}\s+)?(?:\*\*)?(\d{1,2}(?:\\?\.\d{1,3})*)(?:\\?\.)[ \t]*(?=[^\d\s])/gm;
    for (const match of text.matchAll(numbered))
      if (!inToc(match.index)) starts.set(match.index, match[1].replace(/\\/g, ''));
    const glued = /[.;!?)][ \t]+(\d{1,2}(?:\.\d{1,3})*\.)\s*(?=[А-ЯЁA-Z])/g;
    for (const match of text.matchAll(glued)) {
      const start = match.index + match[0].indexOf(match[1]);
      const preceding = text.slice(Math.max(0, match.index - 12), match.index + 1);
      if (!inToc(start) && !/(?:п|пп|ст|пункт)\.$/iu.test(preceding))
        starts.set(start, match[1].slice(0, -1));
    }
    const entries = [...starts.entries()].sort((a, b) => a[0] - b[0]);
    if (entries.length && entries[0][0] > 0 && text.slice(0, entries[0][0]).trim() && !toc)
      entries.unshift([0, 'preamble']);
    if (
      toc &&
      tocEnd < text.length &&
      !entries.some(([offset]) => offset >= tocEnd) &&
      text.slice(tocEnd).trim()
    )
      entries.push([tocEnd, 'appendix']);
    if (!entries.length) {
      for (const match of text.matchAll(/\S[\s\S]*?(?=\n\s*\n|$)/g))
        if (!inToc(match.index)) entries.push([match.index, `paragraph-${entries.length + 1}`]);
    }
    const seen = new Map<string, number>();
    for (let i = 0; i < entries.length; i++) {
      const [start, number] = entries[i];
      let end = entries[i + 1]?.[0] ?? text.length;
      if (toc && start < toc.index && end > toc.index) end = toc.index;
      while (end > start && /\s/.test(text[end - 1])) end--;
      if (end <= start) continue;
      const count = (seen.get(number) ?? 0) + 1;
      seen.set(number, count);
      if (count > 1)
        issues.push(`${doc.id}: duplicate clause number ${number}; references remain ambiguous.`);
      const prefix = text.slice(0, start);
      const headingMatches = [...prefix.matchAll(/^[ \t]*(?:\*\*([^\n]+?)\*\*|([^\n:*]{1,180}:))[ \t]*$/gm)];
      const body = text.slice(start, end);
      const parents = clauses.filter((c) => c.documentId === doc.id && number.startsWith(`${c.number}.`));
      const nearestHeading = headingMatches.at(-1);
      const headingText = nearestHeading && (nearestHeading[1] ?? nearestHeading[2]);
      const unnumberedHeading =
        headingText && !/^\d{1,2}(?:\\?\.\d{1,3})*\\?\./.test(headingText) ? headingText : undefined;
      const headingClause =
        unnumberedHeading &&
        nearestHeading &&
        clauses.find(
          (c) =>
            c.documentId === doc.id &&
            c.start <= nearestHeading.index &&
            c.end >= nearestHeading.index + nearestHeading[0].length,
        );
      clauses.push({
        id: `${doc.id}:${number}:${count}`,
        documentId: doc.id,
        number,
        text: body,
        start,
        end,
        headingPath: [
          ...new Set([
            ...parents.map((c) => c.text.split('\n')[0].slice(0, 300)),
            ...(unnumberedHeading ? [unnumberedHeading] : []),
          ]),
        ],
        contextIds: [...new Set([...parents.map((c) => c.id), ...(headingClause ? [headingClause.id] : [])])],
        references: [
          ...new Set(
            [...body.matchAll(/(?:пп?\.?|пункт[а-я]*|§|clause|section)\s*(\d{1,2}(?:\.\d{1,3})*)/giu)].map(
              (m) => m[1],
            ),
          ),
        ],
        resolvedReferences: [],
      });
    }
  }
  for (const clause of clauses) {
    for (const number of clause.references) {
      const targets = clauses.filter((c) => c.documentId === clause.documentId && c.number === number);
      if (targets.length === 1) clause.resolvedReferences.push(targets[0].id);
      else
        issues.push(
          `${clause.id}: reference ${number} is ${targets.length ? 'ambiguous' : 'unresolved'} in this document.`,
        );
    }
  }
  return { documents, clauses, byId: new Map(clauses.map((c) => [c.id, c])), issues };
}

export function evidenceFor(index: DocumentIndex, clauseId: string, quote?: string): SourceEvidence {
  const clause = index.byId.get(clauseId);
  if (!clause) throw new Error(`Unknown clause ${clauseId}`);
  const value = quote ?? clause.text;
  if (!value.trim()) throw new Error('Empty source quote');
  const offset = clause.text.indexOf(value);
  if (offset < 0) throw new Error(`Quote is not verbatim in ${clauseId}`);
  return {
    documentId: clause.documentId,
    clauseId,
    locator: clause.number,
    quote: value,
    span: [clause.start + offset, clause.start + offset + value.length],
  };
}

export function clauseContext(index: DocumentIndex, clause: Clause) {
  return {
    ...clause,
    context: [...new Set([...clause.contextIds, ...clause.resolvedReferences])].map((id) => {
      const c = index.byId.get(id)!;
      return { id: c.id, number: c.number, text: c.text };
    }),
  };
}

export function batchContext(index: DocumentIndex, clauses: Clause[]) {
  const included = new Set(clauses.map((c) => c.id));
  const ids = [...new Set(clauses.flatMap((c) => [...c.contextIds, ...c.resolvedReferences]))].filter(
    (id) => !included.has(id),
  );
  return {
    clauses: clauses.map(({ start: _start, end: _end, ...clause }) => clause),
    contextClauses: ids.map((id) => {
      const c = index.byId.get(id)!;
      return { id: c.id, documentId: c.documentId, number: c.number, text: c.text };
    }),
  };
}
