import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { z } from 'zod';
import { InputError } from '../engine/validate.js';
import { digest } from './document.js';

export async function ingestDocument(payload: unknown) {
  const data = z
    .object({ name: z.string().min(1).max(300), base64: z.string().min(1).max(11200000) })
    .strict()
    .parse(payload);
  const result = await new Promise<{ text: string; ingestionNotes: string[] }>((resolveResult, reject) => {
    const child = spawn(process.env.PYTHON_BIN || 'python3', [resolve('tools/document_bridge.py')], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill();
      reject(new InputError('Document parsing timed out.'));
    }, 30000);
    child.on('error', () => {
      clearTimeout(timer);
      settled = true;
      reject(new InputError('Cannot start the document parser. Check PYTHON_BIN.'));
    });
    child.stdin.on('error', () => {});
    child.stderr.on('data', () => {});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.length > 4000000) {
        settled = true;
        clearTimeout(timer);
        child.kill();
        reject(new InputError('Parsed document exceeds the output limit.'));
      }
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      try {
        const value = JSON.parse(output);
        if (code || value.error) reject(new InputError(value.error || 'Document parsing failed.'));
        else resolveResult(z.object({ text: z.string(), ingestionNotes: z.array(z.string()) }).parse(value));
      } catch {
        reject(new InputError('Document parser returned invalid output.'));
      }
    });
    child.stdin.end(JSON.stringify(data));
  });
  return { id: `doc:${digest(`${data.name}\0${result.text}`).slice(0, 20)}`, title: data.name, ...result };
}
