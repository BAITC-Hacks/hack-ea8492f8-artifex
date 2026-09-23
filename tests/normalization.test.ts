import { describe, expect, it, vi } from 'vitest';
import type OpenAI from 'openai';
import { demoGraph } from '../server/demo.js';
import { normalizeGraph } from '../server/normalization.js';
import { Store } from '../server/store.js';

function fixture() {
  const input = structuredClone(demoGraph);
  input.before.functions = [input.before.functions[0]];
  input.after.functions = [];
  const canonical = input.before.functions[0].canonical!;
  delete input.before.functions[0].canonical;
  return { input, canonical };
}

describe('AI normalization boundary', () => {
  it('checks supporting quotes and caches successful normalizations', async () => {
    const { input, canonical } = fixture();
    const parse = vi.fn(async (args: { input: { content: string }[] }) => {
      const [entry] = JSON.parse(args.input[1].content);
      return {
        output_parsed: {
          functions: [
            {
              sourceFunctionId: entry.sourceFunctionId,
              atoms: [{ supportingQuote: entry.description, canonical, uncertainties: [] }],
            },
          ],
        },
        usage: { input_tokens: 30, output_tokens: 20 },
      };
    });
    const client = { responses: { parse } } as unknown as OpenAI;
    const store = new Store(':memory:');
    try {
      const first = await normalizeGraph(input, 'ai', store, client);
      const second = await normalizeGraph(input, 'ai', store, client);
      expect(parse).toHaveBeenCalledTimes(1);
      expect(first.graph.before.functions[0].normalization).toBe('ai');
      expect(first.metrics.inputTokens).toBe(30);
      expect(second.metrics.normalizationCacheHits).toBe(1);
    } finally {
      store.close();
    }
  });
  it('rejects fabricated supporting text', async () => {
    const { input, canonical } = fixture();
    const client = {
      responses: {
        parse: async (args: { input: { content: string }[] }) => {
          const [entry] = JSON.parse(args.input[1].content);
          return {
            output_parsed: {
              functions: [
                {
                  sourceFunctionId: entry.sourceFunctionId,
                  atoms: [{ supportingQuote: 'Fabricated quote.', canonical, uncertainties: [] }],
                },
              ],
            },
          };
        },
      },
    } as unknown as OpenAI;
    await expect(normalizeGraph(input, 'ai', undefined, client)).rejects.toThrow('not found');
  });
});
