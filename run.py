#!/usr/bin/env python3
"""OrgSolvency — проверка исполнимости обязательств организации.

    python3 run.py                          прогон на корпусе из corpus/
    python3 run.py before.docx after.docx   прогон на документах заказчика
    python3 run.py before.txt  after.txt    то же для размеченного текста

Зависимостей нет: только стандартная библиотека.
"""
import sys, os
from orgsolvency.core import load
from orgsolvency.detect import run as detect
from orgsolvency.verify import check
from orgsolvency.report import render, dump_json
from orgsolvency.score import score, report as score_report


def main(argv):
    before_path = argv[1] if len(argv) > 2 else "corpus/rev8.txt"
    after_path = argv[2] if len(argv) > 2 else "corpus/rev9.txt"

    before, before_text, rep_b = load(before_path)
    after, after_text, rep_a = load(after_path)
    sources = {before[0].doc_id: before_text, after[0].doc_id: after_text}

    findings = detect(before, after)
    findings, rejected = check(findings, sources)

    os.makedirs("out", exist_ok=True)
    dump_json(findings, "out/findings.json")
    render(findings, before, after, "out/report.html")

    print(f"\n  пунктов разобрано: {len(before)} «до» / {len(after)} «после»")
    for name, rep in (("до", rep_b), ("после", rep_a)):
        if rep["autonumbered_unreliable"]:
            print(f"  «{name}»: {rep['autonumbered_unreliable']} абзацев без "
                  f"литерального номера — цитирование по номеру пункта "
                  f"для них недоступно")
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
