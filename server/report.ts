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
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(r.title)} - Lineage report</title>
  <style>body{font:14px/1.6 system-ui,sans-serif;color:#202b25;max-width:1100px;margin:48px auto;padding:0 24px}h1{font-size:30px}h2{font-size:20px;margin-top:36px}h3{font-size:16px}table{border-collapse:collapse;width:100%;font-size:12px;overflow-wrap:anywhere}th,td{text-align:left;border-bottom:1px solid #d7dfd8;padding:10px;vertical-align:top}th{background:#f1f5f2}blockquote{border-left:3px solid #70977c;margin:12px 0;padding:8px 16px;background:#f5f7f5}.meta{color:#617168}.finding{break-inside:avoid;border-top:1px solid #d7dfd8;padding:18px 0}.high{color:#a13a32}.medium{color:#8a631b}small{display:block}pre{white-space:pre-wrap;overflow-wrap:anywhere}a{color:#21694b}@media print{body{margin:0;max-width:none}.finding{break-inside:avoid}a{color:inherit}}</style></head><body>
  <p class="meta">LINEAGE / ORGANIZATION REVIEW</p><h1>${escape(r.title)}</h1>
  <p class="meta">${escape(r.graph.before.label)} (${escape(r.graph.before.date)}) to ${escape(r.graph.after.label)} (${escape(r.graph.after.date)})<br>Generated ${escape(r.createdAt)} | Engine ${escape(r.engineVersion)} | Run ${escape(r.id)}</p>
  <p><strong>${coverage} documented coverage</strong> (${r.metrics.fullyCovered}/${r.metrics.totalBefore} original functions fully covered). ${r.findings.length} review flags; ${Object.values(reviews).filter((v) => v.status === 'confirmed').length} confirmed; ${Object.values(reviews).filter((v) => v.status === 'dismissed').length} dismissed.</p>
  <h2>Department changes</h2><table><thead><tr><th>Before</th><th>After</th><th>Status</th><th>Basis</th></tr></thead><tbody>${r.departmentChanges.map((d) => `<tr><td>${escape(d.beforeIds.map((id) => dept('before', id)).join(', ') || 'None mapped')}</td><td>${escape(d.afterIds.map((id) => dept('after', id)).join(', ') || 'None mapped')}</td><td>${escape(d.status)}</td><td>${escape(d.basis)}</td></tr>`).join('')}</tbody></table>
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
  <h2>Review findings</h2>${r.findings.length ? r.findings.map((f) => `<section class="finding"><h3 class="${f.severity}">${escape(f.title)}</h3><p class="meta">${escape(f.kind)} | ${escape(f.severity)} | ${escape(f.rule)} | ${escape(reviews[f.id]?.status ?? 'unreviewed')}</p><p>${escape(f.explanation)}</p><p><strong>Recommendation:</strong> ${escape(f.recommendation)}</p>${reviews[f.id]?.note ? `<p><strong>Reviewer note:</strong> ${escape(reviews[f.id].note)}</p>` : ''}${f.evidence.map((e) => `<blockquote>${escape(e.quote)}<small>${escape(e.snapshot)}: ${escape(e.documentTitle)}, ${escape(e.locator)} | ${e.verified ? 'Quote located' : 'Quote not located'}</small></blockquote>`).join('')}</section>`).join('') : '<p>No findings were raised by the configured rules. This does not establish that the organization is risk-free.</p>'}
  <h2>Unlinked after-functions</h2><ul>${r.newFunctionIds.map((id) => `<li>${escape(fn('after', id)?.description)} (${escape(dept('after', fn('after', id)!.departmentId))})</li>`).join('') || '<li>None</li>'}</ul>
  <h2>Method and limitations</h2><ul>${r.warnings.map((w) => `<li>${escape(w)}</li>`).join('')}</ul><p>${r.metrics.candidateComparisons} detailed candidate comparisons out of ${r.metrics.possibleComparisons} possible pairs. ${r.metrics.aiCalls} AI normalization calls; ${r.metrics.inputTokens} input tokens; ${r.metrics.outputTokens} output tokens. ${r.metrics.verifiedEvidence}/${r.metrics.totalEvidence} function source quotations located. Duration: ${r.metrics.durationMs} ms.</p>
  </body></html>`;
}
