import { mkdir, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { GraphInputSchema } from '../shared/schema.js';
import { demoGraph } from '../server/demo.js';
import { ExtractionSchema, ExtractedPairSchema } from '../shared/extraction.js';

await mkdir('examples', { recursive: true });
await writeFile(
  'examples/graph-input.schema.json',
  JSON.stringify(z.toJSONSchema(GraphInputSchema, { io: 'input' }), null, 2) + '\n',
);
await writeFile('examples/sample-graph.json', JSON.stringify(demoGraph, null, 2) + '\n');
await writeFile(
  'examples/extraction.schema.json',
  JSON.stringify(z.toJSONSchema(ExtractionSchema), null, 2) + '\n',
);
await writeFile(
  'examples/extraction-pair.schema.json',
  JSON.stringify(z.toJSONSchema(ExtractedPairSchema), null, 2) + '\n',
);
console.log('Wrote the internal input schema and a complete synthetic before/after example to examples/.');
