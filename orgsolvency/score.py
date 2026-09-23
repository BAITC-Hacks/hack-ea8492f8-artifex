"""Метрика против золотого набора.

Находка засчитывается, если совпал тип И ГЛАВНЫЙ пункт находки входит в разметку.
Главный — первый в списке цитат, то есть предмет вывода, а не сопутствующая
ссылка: иначе находка засчитывалась бы за совпадение по общему пункту-запрету.
Совпадение по смыслу с неверной ссылкой не засчитывается — так же, как его
не засчитает аудитор.
"""
import json


def score(findings, golden_path="golden/golden.json"):
    g = json.load(open(golden_path, encoding="utf-8"))
    expected = [x for x in g["findings"] if x.get("in_corpus")]
    produced = [(f["type"], f["evidence"][0]["clause"], f) for f in findings]

    caught, missed = [], []
    used = set()
    for exp in expected:
        hit = None
        for i, (ftype, clauses, f) in enumerate(produced):
            if ftype == exp["type"] and clauses in set(exp["clauses"]) and i not in used:
                hit = (i, f)
                break
        if hit:
            used.add(hit[0])
            caught.append((exp, hit[1]))
        else:
            missed.append(exp)

    unmatched = [f for i, (_, _, f) in enumerate(produced) if i not in used]

    violations = []
    for neg in g["negative_tests"]:
        for ftype, clauses, f in produced:
            if ftype == neg["must_not_fire"] and clauses in set(neg["clauses"]):
                violations.append((neg, f))

    recall = len(caught) / len(expected) if expected else 0.0
    return {
        "expected": len(expected), "produced": len(findings),
        "caught": caught, "missed": missed, "unmatched": unmatched,
        "violations": violations, "recall": recall,
    }


def report(s):
    lines = [
        "",
        "=" * 64,
        f"  ЗОЛОТОЙ НАБОР: {len(s['caught'])}/{s['expected']} найдено   "
        f"recall = {s['recall']:.0%}",
        "=" * 64,
    ]
    for exp, f in s["caught"]:
        lines.append(f"  [+] {exp['id']:4} {exp['type']:20} → {f['finding_id']}")
    for exp in s["missed"]:
        lines.append(f"  [-] {exp['id']:4} {exp['type']:20}   {exp['note']}")
    if s["unmatched"]:
        lines.append("")
        lines.append(f"  Вне разметки ({len(s['unmatched'])}) — проверить вручную, "
                     "часть может быть ложными срабатываниями:")
        for f in s["unmatched"]:
            cl = ", ".join(e["clause"] for e in f["evidence"][:3])
            lines.append(f"      {f['type']:20} п. {cl}")
    lines.append("")
    if s["violations"]:
        for neg, f in s["violations"]:
            lines.append(f"  [!] НАРУШЕН негативный тест {neg['id']}: {neg['reason']}")
    else:
        lines.append("  [+] негативные тесты пройдены: ложных срабатываний "
                     "на контрпримерах нет")
    lines.append("")
    return "\n".join(lines)
