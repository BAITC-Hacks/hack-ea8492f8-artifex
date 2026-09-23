import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createApp } from '../server/app.js';
import { Store } from '../server/store.js';
import { demoGraph } from '../server/demo.js';
import { htmlReport, csvReport } from '../server/report.js';
import type { AnalysisRun } from '../shared/schema.js';
import { ExtractionSchema, type ExtractedPair } from '../shared/extraction.js';

let server: Server, base: string, store: Store, run: AnalysisRun;
beforeAll(async () => {
  store = new Store(':memory:');
  server = createServer(createApp(store));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : ''}`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  store.close();
});

describe('API workflow', () => {
  it('analyzes an imported graph', async () => {
    const response = await fetch(`${base}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ graph: demoGraph, normalization: 'local' }),
    });
    expect(response.status).toBe(201);
    run = await response.json();
    expect(run.result.findings.length).toBeGreaterThan(0);
  });
  it('persists reviews and retrieves them with the analysis', async () => {
    const id = run.result.findings[0].id;
    const response = await fetch(`${base}/api/runs/${run.result.id}/findings/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'confirmed', note: 'Verified with source owner.' }),
    });
    expect(response.status).toBe(200);
    const saved = (await (await fetch(`${base}/api/runs/${run.result.id}`)).json()) as AnalysisRun;
    expect(saved.reviews[id].status).toBe('confirmed');
    expect(saved.reviews[id].note).toBe('Verified with source owner.');
  });
  it('returns a useful validation error', async () => {
    const response = await fetch(`${base}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ graph: { title: 'bad' } }),
    });
    expect(response.status).toBe(422);
    expect((await response.json()).details.length).toBeGreaterThan(0);
  });
  it('returns JSON 404 for unknown API endpoints', async () => {
    expect((await fetch(`${base}/api/missing`)).status).toBe(404);
  });
  it('prevents cross-origin mutation', async () => {
    const response = await fetch(`${base}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://unrelated.example' },
      body: '{}',
    });
    expect(response.status).toBe(403);
  });
  it('exports reports, findings and a reimportable graph', async () => {
    for (const format of ['html', 'csv', 'json', 'graph'])
      expect((await fetch(`${base}/api/runs/${run.result.id}/export/${format}`)).status).toBe(200);
    const graph = await (await fetch(`${base}/api/runs/${run.result.id}/export/graph`)).json();
    expect(graph.after.functions[0]).not.toHaveProperty('normalization');
  });
  it('escapes imported HTML in the printable report', () => {
    const dangerous = structuredClone(run);
    dangerous.result.title = '<script>alert(1)</script>';
    const report = htmlReport(dangerous);
    expect(report).not.toContain('<script>alert(1)</script>');
    expect(report).toContain('&lt;script&gt;');
  });
  it('neutralizes spreadsheet formulas in CSV cells', () => {
    const dangerous = structuredClone(run);
    dangerous.result.findings[0].title = '=HYPERLINK("https://example.com")';
    expect(csvReport(dangerous)).toContain('"\'=HYPERLINK');
  });
  it('ingests UTF-8 text and rejects unsupported file types', async () => {
    const send = (name: string) =>
      fetch(`${base}/api/documents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          base64: Buffer.from('1. Finance must approve contracts.').toString('base64'),
        }),
      });
    const response = await send('policy.txt');
    expect(response.status).toBe(201);
    expect((await response.json()).text).toContain('Finance');
    expect((await send('policy.exe')).status).toBe(422);
  });
  it('returns single-revision graph and function JSON', async () => {
    const response = await fetch(`${base}/api/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        revision: { id: 'v1', label: 'One', date: '2026-01-01' },
        documents: [{ id: 'd', title: 'Policy', text: '1. Finance must approve contracts.' }],
        mode: 'local',
      }),
    });
    expect(response.status).toBe(201);
    const value = ExtractionSchema.parse(await response.json());
    expect(value.functions).toHaveLength(1);
    expect(value.issues.some((i) => i.code === 'unresolved_owner')).toBe(true);
  });
  it('persists pair jobs, compares version 2 JSON, and exports the complete extraction', async () => {
    const revision = {
      revision: { id: 'v1', label: 'One', date: '2026-01-01' },
      documents: [{ id: 'd', title: 'Policy', text: '1. Finance must approve contracts.' }],
    };
    const started = await fetch(`${base}/api/extraction-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Document API test',
        before: revision,
        after: { ...revision, revision: { ...revision.revision, id: 'v2' } },
        mode: 'local',
        referenceDocuments: [
          { id: 'reference-1', title: 'Rule', text: '1. Finance must approve contracts.' },
        ],
        operators: [
          {
            name: 'Peer A',
            documents: [
              {
                id: 'peer-1',
                title: 'Peer structure',
                text: '1. Департамент внешнего аудита (ДВА) осуществляет контроль.',
              },
            ],
          },
        ],
      }),
    });
    expect(started.status).toBe(202);
    const { id } = await started.json();
    let job: { status: string; result: ExtractedPair } | undefined;
    for (let attempt = 0; attempt < 30; attempt++) {
      job = await (await fetch(`${base}/api/extraction-jobs/${id}`)).json();
      if (job?.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(job?.status).toBe('complete');
    expect(store.getExtraction(id)?.after.functions).toHaveLength(1);
    expect(job?.result.supplementary?.checks.some((check) => check.category === 'reference')).toBe(true);
    expect(job?.result.supplementary?.checks.some((check) => check.category === 'operator')).toBe(false);
    expect(job?.result.supplementary?.documents).toHaveLength(2);
    const response = await fetch(`${base}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ graph: job!.result }),
    });
    expect(response.status).toBe(201);
    const run = await response.json();
    expect(run.result.extraction.before.functions).toHaveLength(1);
    expect(await (await fetch(`${base}/api/runs/${run.result.id}/export/html`)).text()).toContain(
      'Standards and other operators',
    );
    expect(run.result.warnings.join(' ')).toContain('unassigned');
    const exported = await (await fetch(`${base}/api/runs/${run.result.id}/export/extraction`)).json();
    expect(exported.schemaVersion).toBe('2.0');
    expect((await fetch(`${base}/api/extractions/${id}`)).status).toBe(200);
  });
  it('serves full real example documents and output schema', async () => {
    const examples = await (await fetch(`${base}/api/document-example`)).json();
    expect(examples.before.documents[0].text.length).toBeGreaterThan(80000);
    expect((await (await fetch(`${base}/api/extraction-schema`)).json()).properties).toHaveProperty(
      'functions',
    );
  });
  it('rejects malformed origins rather than returning an internal error', async () => {
    expect((await fetch(`${base}/api/config`, { headers: { Origin: 'null' } })).status).toBe(403);
  });
});
