import type { StructureDraft } from './proposals.js';
import type { DocumentIndex, Clause } from './document.js';
import { key } from './document.js';

export function nominative(value: string) {
  return value
    .replace(/Главному аудитору/giu, 'Главный аудитор')
    .replace(/Главного аудитора/giu, 'Главный аудитор')
    .replace(/Директор[ау]/giu, 'Директор')
    .replace(/^Блока\b/iu, 'Блок')
    .replace(/^Блока /iu, 'Блок ')
    .replace(/^Департамент[ау] /iu, 'Департамент ')
    .replace(/[.*:;]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function localStructure(index: DocumentIndex): StructureDraft {
  const result: StructureDraft = { nodes: [], edges: [], uncertainties: [] };
  const citation = (c: Clause) => [{ clauseId: c.id, quote: c.text }];
  const add = (
    kind: StructureDraft['nodes'][number]['kind'],
    name: string,
    scopeName: string | null,
    c: Clause,
    aliases: string[] = [],
  ) => {
    name = nominative(name);
    const existing = result.nodes.find(
      (n) => n.kind === kind && key(n.name) === key(name) && key(n.scopeName ?? '') === key(scopeName ?? ''),
    );
    if (existing) {
      existing.aliases = [...new Set([...existing.aliases, ...aliases])];
      if (!existing.evidence.some((e) => e.clauseId === c.id)) existing.evidence.push(...citation(c));
      return existing;
    }
    const node = { kind, name, scopeName, aliases, evidence: citation(c) };
    result.nodes.push(node);
    return node;
  };
  const unit = (name: string) =>
    result.nodes.find(
      (n) => n.kind === 'unit' && [n.name, ...n.aliases].some((a) => key(a) === key(nominative(name))),
    );
  const edge = (
    type: StructureDraft['edges'][number]['type'],
    source: StructureDraft['nodes'][number],
    target: StructureDraft['nodes'][number],
    c: Clause,
  ) => {
    const mention = (n: typeof source) => ({ kind: n.kind, name: n.name, scopeName: n.scopeName });
    result.edges.push({ type, source: mention(source), target: mention(target), evidence: citation(c) });
  };
  for (const c of index.clauses) {
    for (const m of c.text.matchAll(
      /((?:Блок[а]?|Департамент[а]?|Отдел[а]?|Управление|Управления|Служба|Службы)\s+[^\n();]{2,150}?)\s*\((?:далее\s*[-–—\\ ]+)?([А-ЯЁA-Z]{2,12})\)/gu,
    )) {
      add('unit', m[1].replace(/\s+Общества$/u, ''), null, c, [m[2]]);
    }
  }
  for (const c of [...index.clauses].sort(
    (a, b) => Number(/функционально\s/u.test(a.text)) - Number(/функционально\s/u.test(b.text)),
  )) {
    const composition = /([А-ЯЁA-Z]{2,12})\s+состоит из следующих структурных подразделений/iu.exec(c.text);
    if (composition) {
      const parent = unit(composition[1]);
      if (parent)
        for (const child of result.nodes.filter(
          (n) => n.kind === 'unit' && n !== parent && n.evidence.some((e) => e.clauseId === c.id),
        ))
          edge('part_of', child, parent, c);
    }
    const leadership =
      /Руководство\s+([А-ЯЁA-Z]{2,12})\s+осуществляет\s+([^.,\n]+?)(?:\s+в соответствии|[.,\n])/iu.exec(
        c.text,
      );
    if (leadership) {
      const scope = unit(leadership[1]);
      if (scope) {
        const head = add('position', leadership[2], scope.name, c);
        edge('member_of', head, scope, c);
        edge('heads', head, scope, c);
      }
    }
    const reporting =
      /(?:^|\s)(Главному аудитору|Директору[^\n:]+?)\s+подчиняются работники\s+([А-ЯЁA-Z]{2,12})/u.exec(
        c.text,
      );
    if (reporting) {
      const scope = unit(reporting[2]);
      if (!scope) continue;
      const functional = /функционально/iu.test(c.text.split(':')[0]);
      const head = add('position', reporting[1], scope.name, c);
      edge('member_of', head, scope, c);
      if (!functional) edge('heads', head, scope, c);
      for (const item of c.text.matchAll(/(?:^|\n|;)\s*[а-яa-z]\.\s*([^\n;]+)/giu)) {
        const name = item[1]
          .trim()
          .replace(/\.\s+\d[\s\S]*$/, '')
          .replace(/\.$/, '');
        const suffix = name.match(/([А-ЯЁA-Z]{2,12})$/u)?.[1];
        const known = result.nodes.filter(
          (n) => n.kind === 'position' && key(nominative(n.name)) === key(nominative(name)),
        );
        if (functional && !suffix && known.length !== 1) {
          result.uncertainties.push({
            message: `Functional reporting does not establish membership for ${name}.`,
            evidence: citation(c),
          });
          continue;
        }
        const home: StructureDraft['nodes'][number] =
          (suffix && unit(suffix)) ||
          (functional && known[0]?.scopeName && unit(known[0].scopeName)) ||
          scope;
        const position = add('position', name, home.name, c);
        if (!functional) edge('member_of', position, home, c);
        if (position.name !== head.name || position.scopeName !== head.scopeName)
          edge(functional ? 'reports_functionally' : 'reports_administratively', position, head, c);
        if (/^Директор\s+[А-ЯЁA-Z]{2,12}$/u.test(name) && home !== scope && !functional)
          edge('heads', position, home, c);
      }
    }
  }
  for (const c of index.clauses) {
    const functional =
      /(Главный аудитор) находится в функциональном подчинении (Совета директоров[^.,]*)/u.exec(c.text);
    const admin = /административное руководство (Главным аудитором) осуществляется (Президентом[^.,]*)/u.exec(
      c.text,
    );
    const match = functional || admin;
    if (!match) continue;
    const chief = result.nodes.find((n) => n.kind === 'position' && key(n.name) === key('Главный аудитор'));
    if (!chief) continue;
    const external = add(
      'external',
      match[2].replace(/^Совета директоров/u, 'Совет директоров').replace(/^Президентом/u, 'Президент'),
      null,
      c,
    );
    edge(functional ? 'reports_functionally' : 'reports_administratively', chief, external, c);
  }
  return result;
}
