import type { Canonical, GraphInput, Snapshot } from '../shared/schema.js';

function makeSnapshot(side: 'before' | 'after'): Snapshot {
  const before = side === 'before';
  const departments = before
    ? [
        ['board', 'Executive board', null, []],
        ['procurement', 'Procurement', 'board', []],
        ['compliance', 'Compliance', 'board', []],
        ['finance', 'Finance', 'board', []],
        ['operations', 'Operations', 'board', []],
        ['support', 'Customer service', 'board', []],
      ]
    : [
        ['board', 'Executive board', null, ['board']],
        ['sourcing', 'Strategic sourcing', 'board', ['procurement']],
        ['assurance', 'Vendor assurance', 'board', ['compliance']],
        ['finance', 'Finance', 'board', ['finance']],
        ['regional', 'Regional operations', 'board', ['operations']],
        ['shared', 'Shared services', 'board', ['operations']],
        ['support', 'Customer service', 'board', ['support']],
        ['audit', 'Internal audit', 'finance', ['compliance']],
      ];
  const entries: { id: string; dept: string; text: string; canonical: Canonical }[] = [];
  const add = (
    id: string,
    dept: string,
    text: string,
    action: Canonical['action'],
    object: string,
    process: string,
    authority: Canonical['authority'],
    extra: Partial<Canonical> = {},
  ) =>
    entries.push({
      id: `${before ? 'b' : 'a'}-${id}`,
      dept,
      text: text.replace(
        /^The department/,
        String(departments.find(([departmentId]) => departmentId === dept)?.[1] ?? 'The department'),
      ),
      canonical: {
        action,
        object,
        process,
        authority,
        scope: ['*'],
        conditions: [],
        modality: 'required',
        frequency: null,
        threshold: null,
        ...extra,
      },
    });
  add(
    'supplier-monitor',
    before ? 'compliance' : 'assurance',
    'The department shall monitor supplier compliance across all regions every month.',
    'monitor',
    'supplier compliance',
    'procurement',
    'oversight',
    { frequency: 'monthly' },
  );
  if (!before)
    add(
      'supplier-monitor-copy',
      'sourcing',
      'Strategic sourcing shall monitor vendor compliance across all regions every month.',
      'monitor',
      'vendor compliance',
      'procurement',
      'oversight',
      { frequency: 'monthly' },
    );
  add(
    'contract-approve',
    before ? 'procurement' : 'sourcing',
    `The department shall approve contracts in all regions up to ${before ? '10,000,000' : '1,000,000'} KZT, inclusive.`,
    'approve',
    'contract',
    'contract management',
    'decision',
    { threshold: { min: 0, max: before ? 10000000 : 1000000, currency: 'KZT' } },
  );
  if (before) {
    add(
      'records-maintain',
      'operations',
      'Operations shall maintain operational records for domestic and international business.',
      'maintain',
      'operational record',
      'record management',
      'execution',
      { scope: ['domestic', 'international'] },
    );
    add(
      'incident-report',
      'compliance',
      'Compliance shall report security incidents across all regions to the executive board.',
      'report',
      'security incident',
      'security',
      'execution',
    );
  } else {
    add(
      'records-domestic',
      'regional',
      'Regional operations shall maintain operational records for domestic business.',
      'maintain',
      'operational record',
      'record management',
      'execution',
      { scope: ['domestic'] },
    );
    add(
      'records-international',
      'shared',
      'Shared services shall maintain operational records for international business.',
      'maintain',
      'operational record',
      'record management',
      'execution',
      { scope: ['international'] },
    );
  }
  add(
    'invoice-process',
    'finance',
    'Finance shall process invoices across all business units.',
    'execute',
    'invoice',
    'payment',
    'execution',
  );
  add(
    'invoice-approve',
    before ? 'board' : 'finance',
    'The department shall approve invoices across all business units.',
    'approve',
    'invoice',
    'payment',
    'decision',
  );
  add(
    'invoice-audit',
    before ? 'compliance' : 'audit',
    'The department shall independently audit invoices across all business units.',
    'audit',
    'invoice',
    'payment',
    'independent_assurance',
  );
  add(
    'complaint-review',
    'support',
    'Customer service shall review customer complaints across all regions.',
    'review',
    'customer complaint',
    'customer service',
    'recommendation',
  );
  add(
    'budget-prepare',
    'finance',
    'Finance shall prepare the annual budget across all business units.',
    'prepare',
    'budget',
    'financial planning',
    'execution',
    { frequency: 'annual' },
  );
  add(
    'supplier-audit',
    before ? 'compliance' : 'assurance',
    'The department shall independently audit supplier compliance across all regions annually.',
    'audit',
    'supplier compliance',
    'procurement',
    'independent_assurance',
    { frequency: 'annual' },
  );
  add(
    'inventory-manage',
    before ? 'operations' : 'regional',
    'The department shall manage inventory across all business units.',
    'manage',
    'inventory',
    'inventory management',
    'execution',
  );
  if (!before)
    add(
      'risk-report',
      'assurance',
      'Vendor assurance shall report supplier concentration risk across all regions quarterly.',
      'report',
      'supplier concentration risk',
      'risk management',
      'execution',
      { frequency: 'quarterly' },
    );

  const documentId = `${side}-mandates`,
    structureId = `${side}-structure`;
  const deptObjects = departments.map(([id, name, parentId, previousIds], i) => {
    const text = `${name} (${id})${parentId ? ` reports to ${parentId}` : ' is the governing body'}.`;
    return {
      id: id as string,
      name: name as string,
      parentId: parentId as string | null,
      previousIds: previousIds as string[],
      evidence: [{ documentId: structureId, locator: `Section ${i + 1}`, quote: text }],
    };
  });
  return {
    id: side,
    label: before ? 'Current organization' : 'Proposed organization',
    date: before ? '2026-06-01' : '2026-09-01',
    documents: [
      {
        id: documentId,
        title: before ? 'Department mandates - June 2026' : 'Department mandates - September 2026',
        text: entries.map((e, i) => `${i + 1}. ${e.text}`).join('\n\n'),
      },
      {
        id: structureId,
        title: before ? 'Organizational structure - June 2026' : 'Organizational structure - September 2026',
        text: deptObjects.map((d) => d.evidence[0].quote).join('\n'),
      },
    ],
    departments: deptObjects,
    functions: entries.map((e, i) => ({
      id: e.id,
      departmentId: e.dept,
      description: e.text,
      canonical: e.canonical,
      evidence: [{ documentId, locator: `Clause ${i + 1}`, quote: e.text }],
    })),
    relationships: deptObjects
      .filter((d) => d.parentId)
      .map((d) => ({
        id: `${side}-${d.id}-reports`,
        fromId: d.id,
        toId: d.parentId!,
        type: 'reports_to',
        evidence: d.evidence,
      })),
  };
}

export const demoGraph: GraphInput = {
  schemaVersion: '1.0',
  title: 'September review (sample)',
  before: makeSnapshot('before'),
  after: makeSnapshot('after'),
};
