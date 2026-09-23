#!/usr/bin/env python3
"""OrgSolvency — проверка исполнимости обязательств организации.

    python3 run.py                      прогон на корпусе из corpus/
    python3 run.py before.txt after.txt  прогон на своих файлах

Зависимостей нет: только стандартная библиотека.
"""
import sys, os
from orgsolvency.core import parse
from orgsolvency.detect import run as detect
from orgsolvency.verify import check
from orgsolvency.report import render, dump_json
from orgsolvency.score import score, report as score_report


def main(argv):
    before_path = argv[1] if len(argv) > 2 else "corpus/rev8.txt"
    after_path = argv[2] if len(argv) > 2 else "corpus/rev9.txt"

    before, after = parse(before_path), parse(after_path)
    sources = {before[0].doc_id: open(before_path, encoding="utf-8").read(),
               after[0].doc_id: open(after_path, encoding="utf-8").read()}

    findings = detect(before, after)
    findings, rejected = check(findings, sources)

    os.makedirs("out", exist_ok=True)
    dump_json(findings, "out/findings.json")
    render(findings, before, after, "out/report.html")

    print(f"\n  пунктов разобрано: {len(before)} «до» / {len(after)} «после»")
    print(f"  отклонений: {len(findings)}")
    print(f"  цитат отклонено контролем дословности: {len(rejected)}")
    for f in findings:
        cl = ", ".join(e["clause"] for e in f["evidence"][:3])
        print(f"    [{f['severity']:8}] {f['type']:20} п. {cl}")

    if os.path.exists("golden/golden.json") and "corpus/" in before_path:
        print(score_report(score(findings)))

    print("  отчёт: out/report.html    машинный вывод: out/findings.json\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
