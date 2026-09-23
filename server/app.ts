import express from 'express';
import { z } from 'zod';
import { GraphInputSchema, ReviewSchema } from '../shared/schema.js';
import { toInput } from '../shared/input.js';
import { adaptGraph } from './adapters/graph.js';
import { InputError } from './engine/validate.js';
import { analyze } from './engine/analyze.js';
import { normalizeGraph } from './normalization.js';
import { demoGraph } from './demo.js';
import { Store } from './store.js';
import { csvReport, htmlReport } from './report.js';
import { buildSupplementary } from './extraction/supplementary.js';
import { randomUUID } from 'node:crypto';
import {
  ExtractedPairSchema,
  ExtractionSchema,
  ExtractPairRequestSchema,
  type ExtractedPair,
} from '../shared/extraction.js';
import { extractRevision } from './extraction/pipeline.js';
import { ingestDocument } from './extraction/ingest.js';
import { realExampleRequests } from './extraction/examples.js';

export function createApp(store = new Store()) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '12mb' }));
  app.use('/api', (req, res, next) => {
    const origin = req.get('origin');
    try {
      const host = new URL(`http://${req.get('host')}`).hostname;
      if (
        !['localhost', '127.0.0.1', '[::1]'].includes(host) ||
        (origin && new URL(origin).host !== req.get('host'))
      )
        return res.status(403).json({ error: 'Cross-origin or non-loopback API access is disabled.' });
    } catch {
      return res.status(403).json({ error: 'Invalid request origin.' });
    }
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.get('/api/config', (_req, res) =>
    res.json({
      aiAvailable: Boolean(process.env.OPENAI_API_KEY),
      model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
      engineVersion: '1.0.0',
    }),
  );
  app.get('/api/demo', (_req, res) => res.json(demoGraph));
  app.get('/api/schema', (_req, res) => res.json(z.toJSONSchema(GraphInputSchema, { io: 'input' })));
  app.get('/api/extraction-schema', (_req, res) => res.json(z.toJSONSchema(ExtractionSchema)));
  app.get('/api/document-example', async (_req, res, next) => {
    try {
      res.json(await realExampleRequests());
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/documents', async (req, res, next) => {
    try {
      res.status(201).json(await ingestDocument(req.body));
    } catch (error) {
      next(error);
    }
  });
  type Job = {
    id: string;
    status: 'running' | 'complete' | 'failed';
    progress: string;
    error?: string;
    result?: ExtractedPair;
  };
  const jobs = new Map<string, Job>();
  let activeExtraction = false;
  app.post('/api/extract', async (req, res, next) => {
    if (activeExtraction) return res.status(409).json({ error: 'An extraction is already running.' });
    activeExtraction = true;
    try {
      res.status(201).json(await extractRevision(req.body, { store }));
    } catch (error) {
      next(error);
    } finally {
      activeExtraction = false;
    }
  });
  app.post('/api/extraction-jobs', (req, res, next) => {
    try {
      if (activeExtraction) return res.status(409).json({ error: 'An extraction is already running.' });
      const request = ExtractPairRequestSchema.parse(req.body);
      if (request.before.revision.date > request.after.revision.date)
        throw new InputError('The before date must precede the after date.');
      if (request.mode === 'agentic' && !process.env.OPENAI_API_KEY)
        throw new InputError('Configure OPENAI_API_KEY on the server before starting agentic extraction.');
      const job: Job = { id: randomUUID(), status: 'running', progress: 'Reading before documents.' };
      if (jobs.size >= 50) {
        const oldest = [...jobs.values()].find((j) => j.status !== 'running');
        if (oldest) jobs.delete(oldest.id);
      }
      jobs.set(job.id, job);
      activeExtraction = true;
      res.status(202).json({ id: job.id });
      void (async () => {
        try {
          const before = await extractRevision(
            { ...request.before, mode: request.mode },
            {
              store,
              onProgress: (text) => {
                job.progress = `Before: ${text}`;
              },
            },
          );
          const after = await extractRevision(
            { ...request.after, mode: request.mode },
            {
              store,
              onProgress: (text) => {
                job.progress = `After: ${text}`;
              },
            },
          );
          job.result = { schemaVersion: '2.0', title: request.title, before, after };
          if (request.referenceDocuments.length || request.operators.length) {
            job.progress = 'Comparing optional sources.';
            job.result.supplementary = buildSupplementary(
              job.result,
              request.referenceDocuments,
              request.operators,
            );
          }
          store.saveExtraction(job.id, job.result);
          job.status = 'complete';
          job.progress = 'JSON ready for review.';
        } catch (error) {
          job.status = 'failed';
          job.error =
            error instanceof InputError
              ? [error.message, ...error.details].join('\n')
              : 'Extraction failed. Check provider configuration and server logs.';
          console.error('Extraction failed:', error instanceof Error ? error.name : 'Unknown');
        } finally {
          activeExtraction = false;
        }
      })();
    } catch (error) {
      next(error);
    }
  });
  app.get('/api/extraction-jobs/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (job) return res.json(job);
    const result = store.getExtraction(req.params.id);
    if (result)
      return res.json({ id: req.params.id, status: 'complete', progress: 'JSON ready for review.', result });
    return res.status(404).json({ error: 'Extraction job not found.' });
  });
  app.get('/api/extractions/:id', (req, res) => {
    const result = store.getExtraction(req.params.id);
    if (!result) return res.status(404).json({ error: 'Extraction not found.' });
    res.attachment(`organization-${req.params.id}.json`).json(result);
  });
  app.get('/api/runs', (_req, res) => res.json(store.list()));
  app.get('/api/runs/:id', (req, res) => {
    const run = store.get(req.params.id);
    if (!run) return res.status(404).json({ error: 'Analysis not found.' });
    res.json(run);
  });
  let activeAnalysis = false;
  app.post('/api/analyze', async (req, res, next) => {
    if (activeAnalysis)
      return res.status(409).json({ error: 'An analysis is already running. Please wait for it to finish.' });
    try {
      const body = z
        .object({ graph: z.unknown(), normalization: z.enum(['local', 'ai']).default('local') })
        .strict()
        .parse(req.body);
      const input = adaptGraph(body.graph);
      activeAnalysis = true;
      const start = performance.now();
      const { graph, metrics } = await normalizeGraph(input, body.normalization, store);
      const result = analyze(graph, metrics);
      const extracted = ExtractedPairSchema.safeParse(body.graph);
      if (extracted.success) {
        result.extraction = extracted.data;
        const quotationKeys = new Set<string>();
        for (const side of ['before', 'after'] as const) {
          const item = extracted.data[side];
          for (const entity of [...item.graph.nodes, ...item.graph.edges, ...item.functions, ...item.issues])
            for (const ref of entity.evidence)
              quotationKeys.add(`${side}:${ref.documentId}:${ref.span.join(':')}`);
        }
        result.metrics.totalEvidence = quotationKeys.size;
        result.metrics.verifiedEvidence = quotationKeys.size;
        result.metrics.normalizationCacheHits +=
          extracted.data.before.metrics.cacheHits + extracted.data.after.metrics.cacheHits;
        result.metrics.aiCalls += extracted.data.before.metrics.calls + extracted.data.after.metrics.calls;
        result.metrics.inputTokens +=
          extracted.data.before.metrics.inputTokens + extracted.data.after.metrics.inputTokens;
        result.metrics.outputTokens +=
          extracted.data.before.metrics.outputTokens + extracted.data.after.metrics.outputTokens;
        for (const side of ['before', 'after'] as const) {
          const extraction = extracted.data[side];
          const unowned = extraction.functions.filter((f) => !f.ownerIds.length).length;
          result.warnings.push(
            `${side}: ${unowned} unassigned responsibility candidates excluded from ownership comparison; ${extraction.coverage.unreviewedClauseIds.length} clauses unreviewed. Full extraction is retained in the JSON export.`,
          );
          for (const issue of extraction.issues) {
            if (!issue.evidence.length) continue;
            result.findings.push({
              id: `${side}:${issue.id}`,
              kind: 'uncertainty',
              severity: issue.severity === 'error' ? 'high' : 'medium',
              title: issue.code.replaceAll('_', ' '),
              explanation: issue.message,
              recommendation:
                'Review the cited source and correct the extraction before relying on this finding.',
              beforeIds: [],
              afterIds: [],
              departmentIds: [],
              rule: 'EXTRACTION_REVIEW',
              basis: 'candidate',
              evidence: issue.evidence.map((e) => ({
                ...e,
                snapshot: side,
                documentTitle: extraction.documents.find((d) => d.id === e.documentId)!.title,
                verified: true,
              })),
            });
          }
        }
      }
      result.metrics.durationMs = Math.round(performance.now() - start);
      store.save(result);
      res.status(201).json({ result, reviews: {} });
    } catch (error) {
      next(error);
    } finally {
      activeAnalysis = false;
    }
  });
  app.patch('/api/runs/:id/findings/:findingId', (req, res, next) => {
    try {
      const run = store.get(req.params.id);
      if (!run || !run.result.findings.some((f) => f.id === req.params.findingId))
        return res.status(404).json({ error: 'Finding not found.' });
      const review = ReviewSchema.parse(req.body);
      res.json(store.review(req.params.id, req.params.findingId, review));
    } catch (error) {
      next(error);
    }
  });
  app.get('/api/runs/:id/export/:format', (req, res) => {
    const run = store.get(req.params.id);
    if (!run) return res.status(404).json({ error: 'Analysis not found.' });
    const base = `lineage-${run.result.id}`;
    switch (req.params.format) {
      case 'html':
        res
          .type('html')
          .set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
          .send(htmlReport(run));
        break;
      case 'csv':
        res.type('text/csv').attachment(`${base}-findings.csv`).send(csvReport(run));
        break;
      case 'json':
        res.attachment(`${base}.json`).json(run);
        break;
      case 'graph':
        res.attachment(`${base}-graph.json`).json(toInput(run.result.graph));
        break;
      case 'extraction':
        if (!run.result.extraction)
          return res
            .status(404)
            .json({ error: 'This run was created from a legacy graph, not source extraction.' });
        res.attachment(`${base}-organization.json`).json(run.result.extraction);
        break;
      default:
        res.status(400).json({ error: 'Use html, csv, json, or graph.' });
    }
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found.' }));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof z.ZodError)
      return res.status(400).json({
        error: 'Invalid request.',
        details: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    if (error instanceof InputError)
      return res.status(422).json({ error: error.message, details: error.details });
    if (error instanceof SyntaxError)
      return res.status(400).json({ error: 'Invalid JSON. Check the imported file.' });
    if (error && typeof error === 'object' && 'type' in error && error.type === 'entity.too.large')
      return res.status(413).json({ error: 'The graph exceeds the 12 MB request limit.' });
    if (error && typeof error === 'object' && 'status' in error)
      return res.status(502).json({
        error: `The AI provider request failed (status ${Number(error.status) || 'unknown'}). Check the server API configuration and retry.`,
      });
    console.error('Analysis request failed:', error instanceof Error ? error.name : 'Unknown error');
    return res
      .status(500)
      .json({ error: 'The request could not be completed. Check the server log and retry.' });
  });
  return app;
}
