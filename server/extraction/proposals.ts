import { z } from 'zod';
import { CanonicalSchema } from '../../shared/schema.js';
import { EdgeKindSchema, NodeKindSchema } from '../../shared/extraction.js';

export const Citation = z.object({ clauseId: z.string(), quote: z.string() }).strict();
export const Mention = z
  .object({ kind: NodeKindSchema, name: z.string(), scopeName: z.string().nullable() })
  .strict();
export const StructureProposal = z
  .object({
    nodes: z.array(Mention.extend({ aliases: z.array(z.string()), evidence: z.array(Citation) })),
    edges: z.array(
      z
        .object({ type: EdgeKindSchema, source: Mention, target: Mention, evidence: z.array(Citation) })
        .strict(),
    ),
    uncertainties: z.array(z.object({ message: z.string(), evidence: z.array(Citation) }).strict()),
  })
  .strict();
export const FunctionProposal = z
  .object({
    clauses: z.array(
      z
        .object({
          clauseId: z.string(),
          disposition: z.enum(['functions', 'context_only', 'uncertain']),
          reason: z.string(),
          functions: z.array(
            z
              .object({
                ownerIds: z.array(z.string()),
                supportingQuote: z.string(),
                canonical: CanonicalSchema,
                contextEvidence: z.array(Citation),
                exceptions: z.array(z.string()),
                uncertainties: z.array(z.string()),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict();
export const ReviewProposal = z
  .object({
    issues: z.array(
      z
        .object({
          code: z.string(),
          message: z.string(),
          entityIds: z.array(z.string()),
          evidence: z.array(Citation),
        })
        .strict(),
    ),
  })
  .strict();
export type StructureDraft = z.infer<typeof StructureProposal>;
