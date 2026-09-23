import dotenv from 'dotenv';
import { readFile, writeFile } from 'node:fs/promises';
import { extractRevision } from '../server/extraction/pipeline.js';
import { Store } from '../server/store.js';
import { realExampleRequests } from '../server/extraction/examples.js';

dotenv.config({ quiet: true });

const args = process.argv.slice(2);
const value = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const inputPath = value('--input'),
  outputPath = value('--output');
if (!inputPath && !args.includes('--examples'))
  throw new Error(
    'Use --input request.json or --examples, with optional --agentic and --output result.json.',
  );
const request = inputPath ? JSON.parse(await readFile(inputPath, 'utf8')) : await realExampleRequests();
const store = new Store();
try {
  const mode = args.includes('--agentic') ? 'agentic' : (request.mode ?? 'local');
  const options = { store, onProgress: (message: string) => process.stderr.write(`${message}\n`) };
  const output =
    'before' in request
      ? {
          schemaVersion: '2.0',
          title: request.title,
          before: await extractRevision({ ...request.before, mode }, options),
          after: await extractRevision({ ...request.after, mode }, options),
        }
      : await extractRevision({ ...request, mode }, options);
  const json = JSON.stringify(output, null, 2);
  if (outputPath) await writeFile(outputPath, json + '\n');
  else process.stdout.write(json + '\n');
} finally {
  store.close();
}
