import type { Canonical, NormalizedFunction, OrgFunction } from '../../shared/schema.js';

const aliases: Record<string, string> = {
  vendors: 'supplier',
  vendor: 'supplier',
  suppliers: 'supplier',
  invoices: 'invoice',
  contracts: 'contract',
  purchases: 'purchase',
  payments: 'payment',
  employees: 'employee',
  complaints: 'complaint',
  incidents: 'incident',
  records: 'record',
  reports: 'report',
  поставщиков: 'supplier',
  поставщик: 'supplier',
  поставщика: 'supplier',
  договоров: 'contract',
  договоры: 'contract',
  договор: 'contract',
  закупок: 'procurement',
  закупки: 'procurement',
  закупка: 'procurement',
  счетов: 'invoice',
  счета: 'invoice',
  счет: 'invoice',
};

export function normalizeTerm(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}*]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .map((word) => aliases[word] ?? word)
    .join(' ');
}

export function cleanCanonical(value: Canonical): Canonical {
  return {
    ...value,
    object: normalizeTerm(value.object),
    process: normalizeTerm(value.process),
    scope: [...new Set(value.scope.map(normalizeTerm))].sort(),
    conditions: [
      ...new Set(value.conditions.map((item) => item.normalize('NFKC').trim().toLowerCase())),
    ].sort(),
    frequency: value.frequency ? normalizeTerm(value.frequency) : null,
    threshold: value.threshold
      ? { ...value.threshold, currency: value.threshold.currency?.toUpperCase() ?? null }
      : null,
  };
}

const actionRules: [RegExp, Canonical['action'], Canonical['authority']][] = [
  [/\b(audit|audits|auditing)\b|аудит/iu, 'audit', 'independent_assurance'],
  [/\b(approve|approves|authorize|authorise)\b|утвержда|одобря/iu, 'approve', 'decision'],
  [/\b(review|reviews|assess|check|checks)\b|проверя|рассматрива/iu, 'review', 'recommendation'],
  [/\b(monitor|monitors|oversee|oversees)\b|монитор|контролир/iu, 'monitor', 'oversight'],
  [/\b(prepare|prepares|draft|drafts)\b|подготавлива|составля/iu, 'prepare', 'execution'],
  [/\b(maintain|maintains|retain|retains)\b|ведени|храни/iu, 'maintain', 'execution'],
  [/\b(report|reports|reporting)\b|отчитыва/iu, 'report', 'execution'],
  [
    /\b(execute|executes|process|processes|perform|performs|pay|issue)\b|выполня|осуществля/iu,
    'execute',
    'execution',
  ],
  [/\b(manage|manages)\b|управля/iu, 'manage', 'execution'],
];

const objectRules: [RegExp, string, string][] = [
  [/supplier compliance|vendor compliance|соблюдени.*поставщик/iu, 'supplier compliance', 'procurement'],
  [/\b(contract|contracts)\b|договор/iu, 'contract', 'contract management'],
  [/\b(invoice|invoices)\b|счет/iu, 'invoice', 'payment'],
  [/\b(payment|payments)\b|платеж/iu, 'payment', 'payment'],
  [/\b(purchase|purchases|procurement)\b|закуп/iu, 'purchase', 'procurement'],
  [/\b(complaint|complaints)\b|жалоб/iu, 'complaint', 'customer service'],
  [/\b(incident|incidents)\b|инцидент/iu, 'incident', 'security'],
];

export function normalizeLocal(fn: OrgFunction): NormalizedFunction {
  if (fn.canonical) {
    const canonical = cleanCanonical(fn.canonical);
    const warnings: string[] = [...(fn.normalizationNotes ?? [])];
    if (
      canonical.action === 'unknown' ||
      canonical.authority === 'unknown' ||
      canonical.modality === 'unknown' ||
      !canonical.scope.length
    ) {
      warnings.push('Some responsibility fields are unknown; equivalence needs review.');
    }
    return { ...fn, canonical, normalization: 'provided', normalizationWarnings: warnings };
  }
  const action = actionRules.find(([pattern]) => pattern.test(fn.description));
  const object = objectRules.find(([pattern]) => pattern.test(fn.description));
  const prohibited =
    /\b(must not|shall not|may not|prohibited|not permitted|does not)\b|не вправе|запрещен|не осуществля/iu.test(
      fn.description,
    );
  const canonical: Canonical = {
    action: action?.[1] ?? 'unknown',
    object:
      object?.[1] ??
      (normalizeTerm(fn.description).length <= 400 ? normalizeTerm(fn.description) : 'unknown'),
    process: object?.[2] ?? 'unknown',
    scope: [],
    authority: action?.[2] ?? 'unknown',
    conditions: [],
    modality: prohibited
      ? 'prohibited'
      : /\b(must|shall)\b|обязан/iu.test(fn.description)
        ? 'required'
        : 'unknown',
    frequency: null,
    threshold: null,
  };
  return {
    ...fn,
    canonical,
    normalization: 'local',
    normalizationWarnings: [
      'Local extraction is a candidate only. Supply canonical fields or use AI normalization; scope, limits and conditions require verification.',
    ],
  };
}

export function tokens(value: string): Set<string> {
  return new Set(
    normalizeTerm(value)
      .split(' ')
      .filter((word) => word.length > 1),
  );
}

export function similarity(a: string, b: string): number {
  if (normalizeTerm(a) === normalizeTerm(b)) return 1;
  const left = tokens(a),
    right = tokens(b);
  const intersection = [...left].filter((t) => right.has(t)).length;
  return intersection / (left.size + right.size - intersection || 1);
}
