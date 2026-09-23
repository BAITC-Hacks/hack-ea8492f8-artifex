import type { AnalysisRun } from '../shared/schema.js';

const escape = (value: unknown) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const csvCell = (value: unknown) => {
  let text = String(value ?? '');
  if (/^[\s]*[=+@\-]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
};

export function csvReport(run: AnalysisRun): string {
  const rows = [
    [
      'id',
      'kind',
      'severity',
      'title',
      'explanation',
      'recommendation',
      'rule',
      'review_status',
      'review_note',
      'sources',
    ],
  ];
  for (const f of run.result.findings)
    rows.push([
      f.id,
      f.kind,
      f.severity,
      f.title,
      f.explanation,
      f.recommendation,
      f.rule,
      run.reviews[f.id]?.status ?? 'unreviewed',
      run.reviews[f.id]?.note ?? '',
      f.evidence.map((e) => `${e.snapshot}: ${e.documentTitle}, ${e.locator}: ${e.quote}`).join('\n'),
    ]);
  return '\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}

export function htmlReport(run: AnalysisRun): string {
  const { result: r, reviews } = run;
  const fn = (side: 'before' | 'after', id: string) => r.graph[side].functions.find((f) => f.id === id);
  const dept = (side: 'before' | 'after', id: string) =>
    r.graph[side].departments.find((d) => d.id === id)?.name ?? id;
  const coverage = r.metrics.totalBefore
    ? Math.round((r.metrics.fullyCovered / r.metrics.totalBefore) * 100) + '%'
    : 'N/A';
  const unresolved = r.extraction
    ? r.extraction.before.functions.filter((f) => !f.ownerIds.length).length +
      r.extraction.after.functions.filter((f) => !f.ownerIds.length).length
    : 0;
  const summary =
    r.metrics.totalBefore === 0
      ? 'The supplied structure can be compared, but functional continuity cannot yet be assessed from owned responsibilities.'
      : `${r.metrics.fullyCovered} of ${r.metrics.totalBefore} original responsibilities have documented full coverage. ${r.findings.filter((f) => f.kind === 'loss').length} possible gaps and ${r.findings.filter((f) => f.kind === 'duplication' || f.kind === 'conflict').length} overlap or conflict flags need review.`;
  const action = (f: (typeof r.findings)[number]) => {
    const names = f.departmentIds.map(
      (id) =>
        r.graph.after.departments.find((d) => d.id === id)?.name ??
        r.graph.before.departments.find((d) => d.id === id)?.name ??
        id,
    );
    return `${f.recommendation}${names.length ? ` Units to consult: ${[...new Set(names)].join(', ')}.` : ''}`;
  };
  const decisionFindings = r.findings.filter((f) => f.rule !== 'EXTRACTION_REVIEW');
  const extractionBacklog = r.findings.filter((f) => f.rule === 'EXTRACTION_REVIEW');
  const findingHtml = (f: (typeof r.findings)[number], compact = false) =>
    `<section class="finding"><h3 class="${f.severity}">${escape(f.title)}</h3><p class="meta">${escape(f.kind)} | ${escape(f.severity)} | ${escape(f.rule)} | ${escape(reviews[f.id]?.status ?? 'unreviewed')}</p><p>${escape(compact ? f.explanation.slice(0, 300) : f.explanation)}</p><p><strong>Recommendation:</strong> ${escape(action(f))}</p>${reviews[f.id]?.note ? `<p><strong>Reviewer note:</strong> ${escape(reviews[f.id].note)}</p>` : ''}${f.evidence.map((e) => `<blockquote>${escape(compact ? e.quote.slice(0, 500) : e.quote)}${compact && e.quote.length > 500 ? '...' : ''}<small>${escape(e.snapshot)}: ${escape(e.documentTitle)}, ${escape(e.locator)} | ${e.verified ? 'Quote located' : 'Quote not located'}</small></blockquote>`).join('')}</section>`;
  const supplementary = r.extraction?.supplementary;
  const supplementaryTitle = (id: string) =>
    supplementary?.documents.find((document) => document.id === id)?.title ??
    r.extraction?.after.documents.find((document) => document.id === id)?.title ??
    id;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(r.title)} - Lineage report</title>
  <style>body{font:14px/1.6 system-ui,sans-serif;color:#202b25;max-width:1100px;margin:48px auto;padding:0 24px}h1{font-size:30px}h2{font-size:20px;margin-top:36px}h3{font-size:16px}table{border-collapse:collapse;width:100%;font-size:12px;overflow-wrap:anywhere}th,td{text-align:left;border-bottom:1px solid #d7dfd8;padding:10px;vertical-align:top}th{background:#f1f5f2}blockquote{border-left:3px solid #70977c;margin:12px 0;padding:8px 16px;background:#f5f7f5}.meta{color:#617168}.finding{break-inside:avoid;border-top:1px solid #d7dfd8;padding:18px 0}.high{color:#a13a32}.medium{color:#8a631b}small{display:block}pre{white-space:pre-wrap;overflow-wrap:anywhere}a{color:#21694b}@media print{body{margin:0;max-width:none}.finding{break-inside:avoid}a{color:inherit}}</style></head><body>
  <p class="meta">LINEAGE / ORGANIZATION REVIEW</p><h1>${escape(r.title)}</h1>
  <p class="meta">${escape(r.graph.before.label)} (${escape(r.graph.before.date)}) to ${escape(r.graph.after.label)} (${escape(r.graph.after.date)})<br>Generated ${escape(r.createdAt)} | Engine ${escape(r.engineVersion)} | Run ${escape(r.id)}</p>
  <p><strong>${coverage} documented coverage</strong> (${r.metrics.fullyCovered}/${r.metrics.totalBefore} original functions fully covered). ${r.findings.length} review flags; ${Object.values(reviews).filter((v) => v.status === 'confirmed').length} confirmed; ${Object.values(reviews).filter((v) => v.status === 'dismissed').length} dismissed.</p>
  <h2>Conclusion</h2><p>${escape(summary)}</p>${unresolved ? `<p>${unresolved} responsibility candidates have unresolved owners and were excluded from functional comparison. No absence or continuity claim is made for them.</p>` : ''}<p>Every flagged change requires confirmation against the cited documents before assigning or removing a responsibility.</p>
  <h2>Department changes</h2><table><thead><tr><th>Before</th><th>After</th><th>Status</th><th>Basis</th><th>Sources</th></tr></thead><tbody>${r.departmentChanges
    .map(
      (d) =>
        `<tr><td>${escape(d.beforeIds.map((id) => dept('before', id)).join(', ') || 'None mapped')}</td><td>${escape(d.afterIds.map((id) => dept('after', id)).join(', ') || 'None mapped')}</td><td>${escape(d.status)}<small>${escape(d.reason ?? '')}</small></td><td>${escape(d.basis)}</td><td>${
          (d.evidence ?? [])
            .filter(
              (e, i, all) =>
                all.findIndex(
                  (v) =>
                    v.snapshot === e.snapshot &&
                    v.documentId === e.documentId &&
                    v.locator === e.locator &&
                    v.quote === e.quote,
                ) === i,
            )
            .map(
              (e) =>
                `<small>${escape(e.snapshot)}: ${escape(e.documentTitle)}, §${escape(e.locator)}<br>${escape(e.quote.slice(0, 300))}</small>`,
            )
            .join('') || 'No cited source'
        }</td></tr>`,
    )
    .join('')}</tbody></table>
  <h2>Function lineage</h2><table><thead><tr><th>Original responsibility</th><th>Successor</th><th>Status / coverage</th><th>Reason</th></tr></thead><tbody>${r.matches
    .map(
      (m) =>
        `<tr><td>${escape(fn('before', m.beforeId)?.description)}<small>${escape(dept('before', fn('before', m.beforeId)!.departmentId))}</small></td><td>${escape(
          m.afterIds
            .map((id) => {
              const f = fn('after', id)!;
              return `${dept('after', f.departmentId)}: ${f.description}`;
            })
            .join('\n') || 'No match found',
        )}</td><td>${escape(m.status)} / ${escape(m.coverage)}</td><td>${escape(m.reason)}</td></tr>`,
    )
    .join('')}</tbody></table>
  <h2>Action plan</h2><ol>${
    r.findings
      .filter((f) => f.kind === 'loss' || f.kind === 'duplication' || f.kind === 'conflict')
      .slice(0, 20)
      .map(
        (f) =>
          `<li><strong>${escape(f.title)}:</strong> ${escape(action(f))} ${f.evidence.length ? `Verify ${escape(f.evidence.map((e) => `${e.documentTitle} §${e.locator}`).join('; '))}.` : 'Find a supporting source before taking action.'}</li>`,
      )
      .join('') || '<li>No grounded redistribution action can be proposed from the current comparison.</li>'
  }</ol>
  <h2>Review findings</h2>${
    decisionFindings.length
      ? decisionFindings
          .slice(0, 50)
          .map((f) => findingHtml(f))
          .join('')
      : '<p>No grounded functional finding was raised by the configured rules. This does not establish that the organization is risk-free.</p>'
  }${decisionFindings.length > 50 ? `<p>${decisionFindings.length - 50} further findings remain in the JSON and CSV exports.</p>` : ''}
  ${
    extractionBacklog.length
      ? `<h2>Extraction backlog</h2><p>${extractionBacklog.length} responsibility candidates require owner review before functional comparison. The first 12 source-linked examples follow; the complete list remains in the JSON and CSV exports.</p>${extractionBacklog
          .slice(0, 12)
          .map((f) => findingHtml(f, true))
          .join('')}`
      : ''
  }
  ${supplementary ? `<h2>Standards and other operators</h2><p>Candidate comparisons based on supplied text. They are not legal-compliance or industry best-practice conclusions.</p>${supplementary.warnings.map((warning) => `<p>${escape(warning)}</p>`).join('')}${supplementary.checks.map((check) => `<section class="finding"><h3>${escape(check.title)}</h3><p class="meta">${escape(check.category)} | ${escape(check.status)}</p><p>${escape(check.explanation)}</p><p>${escape(check.recommendation)}</p>${check.evidence.map((e) => `<blockquote>${escape(e.quote)}<small>${escape(supplementaryTitle(e.documentId))}, §${escape(e.locator)}</small></blockquote>`).join('')}</section>`).join('')}` : ''}
  <h2>Unlinked after-functions</h2><ul>${r.newFunctionIds.map((id) => `<li>${escape(fn('after', id)?.description)} (${escape(dept('after', fn('after', id)!.departmentId))})</li>`).join('') || '<li>None</li>'}</ul>
  <h2>Method and limitations</h2><ul>${r.warnings.map((w) => `<li>${escape(w)}</li>`).join('')}</ul><p>${r.metrics.candidateComparisons} detailed candidate comparisons out of ${r.metrics.possibleComparisons} possible pairs. ${r.metrics.aiCalls} AI normalization calls; ${r.metrics.inputTokens} input tokens; ${r.metrics.outputTokens} output tokens. ${r.metrics.verifiedEvidence}/${r.metrics.totalEvidence} function source quotations located. Duration: ${r.metrics.durationMs} ms.</p>
  </body></html>`;
}
