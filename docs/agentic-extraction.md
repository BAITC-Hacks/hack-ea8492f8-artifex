# Agentic extraction and integration

## Scope and decisions

Integrated with GitHub `main` on branch `codex/agentic-org-json`.
The earlier local Lineage workspace is preserved; the fetched Python application's
Word loader is reused through `tools/document_bridge.py`. Its own UI and detectors
remain independent and are still tested. No remote commits are rewritten.

The organizer's full editions 8 and 9 are the primary examples. The friend's
`discussion-summary.txt` was consulted as design advice, not ground truth. In
particular:

- Positions and structural units are distinct, including repeated position names.
- Functional supervision does not imply membership or headship.
- Administrative, functional, disciplinary, containment and oversight edges are distinct.
- Multiple containers/heads are review issues, not silently normalized away.
- Unresolved groups remain group actors; their mandates are not broadcast to every child.
- Roles with unknown membership remain representable. No fictional department is created.
- IDs are code-generated from normalized kind/name/unit scope. Explicit alias matches can
  resolve identity; ambiguous endpoints are retained as issues. This is not a universal
  multilingual entity resolver, and cross-company homonyms still need disambiguation.
- The notes' broad modality ranking is not treated as universal law. Permission,
  obligation, prohibition and unknown modality remain distinct without asserting that
  every grammatical rewrite changes enforceability.
- A generic OpenAI-compatible endpoint may lack Responses or strict-output support.

## Workflow

```text
files -> bounded text ingestion -> clauses, headings, references
      -> structure agent <-> search_clauses / read_clause
      -> deterministic entity registry and typed graph
      -> responsibility agent <-> source tools
      -> validation feedback -> at most one responsibility repair
      -> review agent <-> source tools
      -> deterministic source + graph checks -> version 2 JSON
      -> adapter -> canonical comparison, lineage, evidence and human review
```

Agents use the OpenAI Responses API with Zod structured outputs. The application
owns the tool loop, so this is a bounded agentic workflow rather than an Agents SDK
dependency. Tools are read-only and limited to the supplied document set. They
cannot browse, execute code, mutate files, or follow instructions inside documents.
The model can still misinterpret a real quotation; human review is essential.

Implementation references:
- [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling)

## JSON contract

`shared/extraction.ts` is the source of truth. Generated schemas:
`examples/extraction.schema.json` (single revision) and
`examples/extraction-pair.schema.json` (before/after pair).

```json
{
  "schemaVersion": "2.0",
  "title": "Organization review",
  "before": {
    "schemaVersion": "2.0",
    "revision": {"id": "rev8", "label": "Before", "date": "2021-06-25"},
    "documents": [],
    "graph": {"nodes": [], "edges": []},
    "functions": [],
    "issues": [],
    "coverage": {"totalClauses": 0, "reviewedClauses": 0, "unreviewedClauseIds": [], "status": "needs_review"},
    "trace": [],
    "metrics": {"model": null, "calls": 0, "cacheHits": 0, "inputTokens": 0, "outputTokens": 0, "durationMs": 0}
  },
  "after": {}
}
```

This is a shape illustration, not a runnable fixture: `after` must contain the same
revision structure. Generate a complete pair with `npm run extract -- --examples`.
The pair may also include `supplementary`: hashed reference and peer documents,
source-linked candidate checks, and warnings. These inputs do not change the
before/after graph or function ownership.

Nodes carry `id`, `kind`, `name`, `aliases`, `scopeId`, `origin`, `evidence`, and
`functionIds`. Node kinds: `unit`, `position`, `external`, `group`.
Edges carry typed `source` and `target` IDs plus evidence. Edge types:
`part_of`, `member_of`, `heads`, `reports_functionally`, `reports_administratively`,
`reports_disciplinarily`, `accountable_to`, `oversees`, `audits`.

Each function carries exact `description`, authoritative `ownerIds`, a derived
`departmentIds` roll-up, canonical action/object/process/scope/authority/modality/
frequency/conditions/limits, source context and unresolved uncertainties. An empty
owner list is an explicit unresolved assignment, never a made-up department.
`departmentIds` helps consumers retrieve department functions without losing the
distinction between a department mandate and a director's responsibility.

Evidence has `documentId`, `clauseId`, `locator`, `quote`, and `span: [start, end]`.
Offsets are **JavaScript UTF-16 code units**, with exclusive end, into the returned
unchanged `documents[].text`. They are not PDF coordinates or offsets into the
original Word file. Each document includes a SHA-256 of its UTF-8 text.
Graph imports verify spans, clause anchors, hashes, endpoints, and owner indexes.

Unknown canonical values are not filled with guesses. `scope: []` is unknown;
`scope: ["*"]` requires explicit universal scope. Exceptions are retained in both
context and canonical conditions. Parent clauses and referenced clauses are supplied
to extraction. References resolve within their own document only; cross-file targets
remain unresolved rather than guessing which document wins.

## Endpoints

| Method | Path | Result |
| --- | --- | --- |
| POST | `/api/documents` | `{name, base64}` -> extracted source document |
| POST | `/api/extract` | single `{revision, documents, mode}` -> revision JSON |
| POST | `/api/extraction-jobs` | `{title, before, after, mode, referenceDocuments?, operators?}` -> job ID (202) |
| GET | `/api/extraction-jobs/:id` | actual progress, failure, or complete pair |
| GET | `/api/extractions/:id` | persisted pair JSON download |
| GET | `/api/extraction-schema` | single-revision JSON Schema |
| GET | `/api/document-example` | full edition 8/9 extraction request |
| POST | `/api/analyze` | accepts legacy v1 graph or v2 extraction pair |
| GET | `/api/runs/:id/export/extraction` | original full extraction for the analysis |

Extraction jobs are single-concurrency. Completed pairs, model caches and analyses
are persisted in SQLite; active jobs do not survive a server restart. Cached stages
include prompt version, model, endpoint, complete source hash and input. Quotes and
graph invariants are revalidated on reuse. No hidden automatic downgrade from a
failed agentic request to local mode occurs. The UI offers local mode explicitly.

Optional inputs accept up to six reference documents and three named peer
operators with up to six structure documents each, limited to 300,000 extra
characters total. Reference checks retrieve explicit obligation/prohibition
clauses against after-responsibilities. Peer checks compare extracted unit names
for created or composition-changed units. Both are lexical, cited candidates,
not legal compliance or best-practice findings. The printable conclusion groups
unassigned extraction flags into a cited sample; JSON and CSV retain the full
backlog. A same-name unit with a different number of documented positions is
marked `transformed` for review, not asserted to be legally reorganized.

## Bounds and privacy

- Loopback-only, single-user prototype; no authentication or hosted multi-user claim.
- Maximum 12 documents and 600,000 characters per revision, 1,800 clauses.
- Upload 8 MB; expanded Word/Excel archive 30 MB; text PDF 200 pages.
- At most 40 model calls, 7 tool turns per stage, one responsibility-repair stage.
- Budget checks stop further requests beyond 240,000 input or 100,000 output tokens;
  a single in-flight request can cross those cumulative thresholds. Requests allow
  at most 20,000 output tokens each. The provider SDK permits one network retry.
- Ten-minute revision budget, checked between requests; an in-flight request has a
  90-second timeout and can extend elapsed time. No partial extraction is published.
- `store:false` on Responses requests. This is not a promise of zero provider retention.
- Only the configured API endpoint receives document text in agentic mode. Local
  mode makes no model requests. Keys never enter the browser or JSON exports.
- Sources, extraction output, model caches and runs are stored locally. Treat `.data/`
  as potentially sensitive and excluded from Git. Source URLs are metadata, never
  automatically fetched by model tools.

## Review and limitations

The full-doc structural regression expectations are hand-checked from the examples,
not an organizer-supplied answer key. AI semantic accuracy remains unmeasured until
live labeled evaluation. `coverage.reviewedClauses` measures model dispositions,
not human approval or recall. Agent-produced responsibilities remain `needs_review`.

Structural/evidence errors block comparison. Unassigned responsibility candidates
are retained in the extraction and excluded from ownership comparisons with explicit
warnings. Reviewer concerns propagate into normalization uncertainty. Only mapped
unit nodes appear in department-change counts; positions and external bodies stay
separate. Typed administrative/containment paths cannot alone trigger independence
findings. Legacy v1 `reports_to` retains its earlier general reporting semantics.

Still limited: OCR and diagram understanding; full reconstruction of Word numbering;
implicit or cross-document precedence; a complete standard/law corpus; generalized
semantic entity identity; automatic proof of lost duties. A disappeared clause is
never sufficient to prove that the organization has stopped performing its function.
The local full-edition regression yields unassigned responsibility candidates,
so it cannot produce grounded functional continuity, duplication or conflict
conclusions for those editions. Agentic extraction has mocked protocol coverage;
live semantic quality needs an API key and labeled human evaluation.
