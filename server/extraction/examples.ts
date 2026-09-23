import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function realExampleRequests() {
  const revision = async (version: 8 | 9) => ({
    revision: {
      id: `rev${version}`,
      label: `Internal audit regulation, edition ${version}`,
      date: version === 8 ? '2021-06-25' : '2022-12-23',
    },
    documents: [
      {
        id: `audit-regulation-${version}`,
        title: `Internal audit regulation, edition ${version} (full Markdown export)`,
        text: await readFile(resolve(`corpus/full/rev${version}.md`), 'utf8'),
        sourceUrl:
          version === 8
            ? 'https://docs.google.com/document/d/1X2tNOF9_ZF2ms0Fnx1mWrUaAoMLHabTu/edit'
            : 'https://docs.google.com/document/d/1FUh7Ld40xk-gwXMdj5-_3-p-cYeIl2hu/edit',
        ingestionNotes: [
          'Google Docs Markdown export. Offsets address this exported text, not the original Word XML or page layout.',
        ],
      },
    ],
  });
  return {
    title: 'Internal audit reorganization: edition 8 to 9',
    mode: 'local' as const,
    before: await revision(8),
    after: await revision(9),
  };
}
