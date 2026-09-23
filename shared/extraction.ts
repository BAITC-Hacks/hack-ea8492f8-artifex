import { z } from 'zod';
import { CanonicalSchema } from './schema.js';

export const NodeKindSchema = z.enum(['unit', 'position', 'external', 'group']);
export const EdgeKindSchema = z.enum([
  'part_of',
  'member_of',
  'heads',
  'reports_functionally',
  'reports_administratively',
  'reports_disciplinarily',
  'accountable_to',
  'oversees',
  'audits',
]);
export const SourceDocumentSchema = z
  .object({
    id: z.string().min(1).max(120),
    title: z.string().min(1).max(300),
    text: z.string().min(1).max(500000),
    sourceUrl: z.string().url().optional(),
    ingestionNotes: z.array(z.string()).optional(),
  })
  .strict();
export const ExtractionRequestSchema = z
  .object({
    revision: z
      .object({ id: z.string().min(1).max(120), label: z.string().min(1).max(200), date: z.iso.date() })
      .strict(),
    documents: z.array(SourceDocumentSchema).min(1).max(12),
    mode: z.enum(['local', 'agentic']).default('local'),
  })
  .strict();
export const SourceEvidenceSchema = z
  .object({
    documentId: z.string(),
    clauseId: z.string(),
    locator: z.string(),
    quote: z.string().min(1),
    span: z.tuple([z.number().int().nonnegative(), z.number().int().positive()]),
  })
  .strict();
export const ExtractedNodeSchema = z
  .object({
    id: z.string(),
    kind: NodeKindSchema,
    name: z.string(),
    aliases: z.array(z.string()),
    scopeId: z.string().nullable(),
    origin: z.enum(['rule', 'agent', 'manual']),
    evidence: z.array(SourceEvidenceSchema).min(1),
    functionIds: z.array(z.string()),
  })
  .strict();
export const ExtractedEdgeSchema = z
  .object({
    id: z.string(),
    type: EdgeKindSchema,
    source: z.string(),
    target: z.string(),
    origin: z.enum(['rule', 'agent', 'manual']),
    evidence: z.array(SourceEvidenceSchema).min(1),
  })
  .strict();
export const ExtractedFunctionSchema = z
  .object({
    id: z.string(),
    ownerIds: z.array(z.string()),
    departmentIds: z.array(z.string()),
    description: z.string(),
    canonical: CanonicalSchema,
    context: z
      .object({
        headingPath: z.array(z.string()),
        references: z.array(z.string()),
        resolvedReferences: z.array(z.string()),
        exceptions: z.array(z.string()),
      })
      .strict(),
    evidence: z.array(SourceEvidenceSchema).min(1),
    origin: z.enum(['rule', 'agent', 'manual']),
    uncertainties: z.array(z.string()),
  })
  .strict();
export const ExtractionIssueSchema = z
  .object({
    id: z.string(),
    code: z.string(),
    severity: z.enum(['info', 'warning', 'error']),
    message: z.string(),
    entityIds: z.array(z.string()),
    evidence: z.array(SourceEvidenceSchema),
  })
  .strict();
export const ExtractionSchema = z
  .object({
    schemaVersion: z.literal('2.0'),
    revision: ExtractionRequestSchema.shape.revision,
    documents: z.array(SourceDocumentSchema.extend({ sha256: z.string() })),
    graph: z.object({ nodes: z.array(ExtractedNodeSchema), edges: z.array(ExtractedEdgeSchema) }).strict(),
    functions: z.array(ExtractedFunctionSchema),
    issues: z.array(ExtractionIssueSchema),
    coverage: z
      .object({
        totalClauses: z.number(),
        reviewedClauses: z.number(),
        unreviewedClauseIds: z.array(z.string()),
        status: z.enum(['needs_review', 'validated']),
      })
      .strict(),
    trace: z.array(
      z
        .object({
          stage: z.string(),
          action: z.string(),
          detail: z.string(),
        })
        .strict(),
    ),
    metrics: z
      .object({
        model: z.string().nullable(),
        calls: z.number(),
        cacheHits: z.number(),
        inputTokens: z.number(),
        outputTokens: z.number(),
        durationMs: z.number(),
      })
      .strict(),
  })
  .strict();
export const SupplementarySchema = z
  .object({
    documents: z.array(SourceDocumentSchema.extend({ sha256: z.string() })).max(18),
    referenceDocumentIds: z.array(z.string()),
    operators: z.array(z.object({ name: z.string(), documentIds: z.array(z.string()) }).strict()),
    checks: z
      .array(
        z
          .object({
            id: z.string(),
            category: z.enum(['reference', 'operator']),
            status: z.enum(['candidate_match', 'needs_review']),
            title: z.string(),
            explanation: z.string(),
            recommendation: z.string(),
            entityIds: z.array(z.string()),
            evidence: z.array(SourceEvidenceSchema).min(1),
          })
          .strict(),
      )
      .max(500),
    warnings: z.array(z.string()),
  })
  .strict();
export const ExtractedPairSchema = z
  .object({
    schemaVersion: z.literal('2.0'),
    title: z.string().min(1),
    before: ExtractionSchema,
    after: ExtractionSchema,
    supplementary: SupplementarySchema.optional(),
  })
  .strict();
export type SourceDocument = z.infer<typeof SourceDocumentSchema>;
export type SourceEvidence = z.infer<typeof SourceEvidenceSchema>;
export type ExtractionRequest = z.infer<typeof ExtractionRequestSchema>;
export type Extraction = z.infer<typeof ExtractionSchema>;
export type ExtractedNode = z.infer<typeof ExtractedNodeSchema>;
export type ExtractedEdge = z.infer<typeof ExtractedEdgeSchema>;
export type ExtractedFunction = z.infer<typeof ExtractedFunctionSchema>;
export type ExtractionIssue = z.infer<typeof ExtractionIssueSchema>;
export type ExtractedPair = z.infer<typeof ExtractedPairSchema>;
export type Supplementary = z.infer<typeof SupplementarySchema>;
export const ExtractPairRequestSchema = z
  .object({
    title: z.string().min(1).max(200),
    mode: z.enum(['local', 'agentic']),
    before: ExtractionRequestSchema.omit({ mode: true }),
    after: ExtractionRequestSchema.omit({ mode: true }),
    referenceDocuments: z.array(SourceDocumentSchema).max(6).default([]),
    operators: z
      .array(
        z
          .object({
            name: z.string().min(1).max(160),
            documents: z.array(SourceDocumentSchema).min(1).max(6),
          })
          .strict(),
      )
      .max(3)
      .default([]),
  })
  .strict();
