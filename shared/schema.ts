import { z } from 'zod';
import type { ExtractedPair } from './extraction.js';

const Id = z.string().trim().min(1).max(120);
export const EvidenceSchema = z
  .object({
    documentId: Id,
    locator: z.string().min(1).max(200),
    quote: z.string().min(1).max(12000),
    span: z.tuple([z.number().int().nonnegative(), z.number().int().positive()]).optional(),
    clauseId: z.string().optional(),
  })
  .strict();

export const CanonicalSchema = z
  .object({
    action: z.enum([
      'execute',
      'prepare',
      'review',
      'approve',
      'monitor',
      'audit',
      'manage',
      'report',
      'maintain',
      'unknown',
    ]),
    object: z.string().min(1).max(400),
    process: z.string().min(1).max(400),
    scope: z.array(z.string().min(1).max(160)).max(100),
    authority: z.enum([
      'execution',
      'recommendation',
      'decision',
      'oversight',
      'independent_assurance',
      'unknown',
    ]),
    conditions: z.array(z.string().min(1).max(4000)).max(50),
    modality: z.enum(['required', 'permitted', 'prohibited', 'unknown']),
    frequency: z.string().max(100).nullable(),
    threshold: z
      .object({
        min: z.number().finite().nullable(),
        max: z.number().finite().nullable(),
        currency: z.string().max(20).nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const FunctionSchema = z
  .object({
    id: Id,
    departmentId: Id,
    description: z.string().min(1).max(12000),
    canonical: CanonicalSchema.optional(),
    normalizationNotes: z.array(z.string().max(1000)).max(50).optional(),
    sourceFunctionId: Id.optional(),
    evidence: z.array(EvidenceSchema).min(1).max(20),
  })
  .strict();

export const SnapshotSchema = z
  .object({
    id: Id,
    label: z.string().min(1).max(200),
    date: z.iso.date(),
    hierarchyKind: z.enum(['reporting', 'containment']).optional(),
    documents: z
      .array(
        z
          .object({
            id: Id,
            title: z.string().min(1).max(300),
            text: z.string().min(1).max(1000000),
          })
          .strict(),
      )
      .max(200),
    departments: z
      .array(
        z
          .object({
            id: Id,
            name: z.string().min(1).max(300),
            kind: z.enum(['unit', 'position', 'external', 'group']).optional(),
            parentId: Id.nullable().default(null),
            previousIds: z.array(Id).default([]),
            evidence: z.array(EvidenceSchema).default([]),
          })
          .strict(),
      )
      .max(1000),
    functions: z.array(FunctionSchema).max(3000),
    relationships: z
      .array(
        z
          .object({
            id: Id,
            fromId: Id,
            toId: Id,
            type: z.enum([
              'reports_to',
              'oversees',
              'audits',
              'part_of',
              'member_of',
              'heads',
              'reports_functionally',
              'reports_administratively',
              'reports_disciplinarily',
              'accountable_to',
            ]),
            evidence: z.array(EvidenceSchema).min(1),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export const GraphInputSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    title: z.string().min(1).max(200),
    before: SnapshotSchema,
    after: SnapshotSchema,
  })
  .strict();

export const ReviewSchema = z
  .object({
    status: z.enum(['unreviewed', 'confirmed', 'dismissed']),
    note: z.string().max(4000).default(''),
  })
  .strict();

export type Canonical = z.infer<typeof CanonicalSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type OrgFunction = z.infer<typeof FunctionSchema>;
export type Snapshot = z.infer<typeof SnapshotSchema>;
export type GraphInput = z.infer<typeof GraphInputSchema>;
export type Review = z.infer<typeof ReviewSchema> & { updatedAt?: string };
export type NormalizedFunction = OrgFunction & {
  canonical: Canonical;
  normalization: 'provided' | 'local' | 'ai';
  normalizationWarnings: string[];
};
export type NormalizedSnapshot = Omit<Snapshot, 'functions'> & { functions: NormalizedFunction[] };
export type NormalizedGraph = Omit<GraphInput, 'before' | 'after'> & {
  before: NormalizedSnapshot;
  after: NormalizedSnapshot;
};
export type EvidenceRef = Evidence & {
  snapshot: 'before' | 'after';
  documentTitle: string;
  verified: boolean;
};
export type FindingKind = 'loss' | 'change' | 'duplication' | 'conflict' | 'evidence' | 'uncertainty';
export type Finding = {
  id: string;
  kind: FindingKind;
  severity: 'high' | 'medium' | 'low';
  title: string;
  explanation: string;
  recommendation: string;
  beforeIds: string[];
  afterIds: string[];
  departmentIds: string[];
  evidence: EvidenceRef[];
  rule: string;
  basis: 'deterministic' | 'candidate';
};
export type MatchStatus =
  'preserved' | 'transferred' | 'split' | 'merged' | 'partial' | 'changed' | 'unmatched' | 'uncertain';
export type Match = {
  beforeId: string;
  afterIds: string[];
  status: MatchStatus;
  reason: string;
  differences: { field: string; before: string; after: string }[];
  candidates: { afterId: string; score: number }[];
  coverage: 'full' | 'partial' | 'none' | 'unknown';
};
export type DepartmentChange = {
  beforeIds: string[];
  afterIds: string[];
  status: 'preserved' | 'renamed' | 'split' | 'merged' | 'created' | 'removed';
  basis: 'explicit' | 'identity' | 'name' | 'unmapped';
};
export type AnalysisResult = {
  extraction?: ExtractedPair;
  id: string;
  engineVersion: string;
  createdAt: string;
  title: string;
  graph: NormalizedGraph;
  matches: Match[];
  newFunctionIds: string[];
  departmentChanges: DepartmentChange[];
  findings: Finding[];
  metrics: {
    durationMs: number;
    possibleComparisons: number;
    candidateComparisons: number;
    fullyCovered: number;
    totalBefore: number;
    verifiedEvidence: number;
    totalEvidence: number;
    normalizationCacheHits: number;
    aiCalls: number;
    inputTokens: number;
    outputTokens: number;
  };
  warnings: string[];
};
export type AnalysisRun = { result: AnalysisResult; reviews: Record<string, Review> };
