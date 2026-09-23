#!/usr/bin/env python3
"""Защита от регрессий: python3 tests/smoke.py

Фиксирует то, что нельзя терять: дословность цитат, отсутствие ложных
срабатываний на контрпримерах и достигнутый уровень полноты.
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from orgsolvency.core import load
from orgsolvency.detect import run as detect
from orgsolvency.verify import check
from orgsolvency.score import score

BASELINE_RECALL = 0.47   # текущий рубеж; поднимать вместе с улучшениями

fails = []


def expect(cond, msg):
    print(("  [+] " if cond else "  [!] ") + msg)
    if not cond:
        fails.append(msg)


before, btext, _ = load("corpus/rev8.txt")
after, atext, _ = load("corpus/rev9.txt")

expect(len(before) > 30 and len(after) > 30,
       f"разобрано пунктов: {len(before)} / {len(after)}")

bad_spans = [c.number for c in before if btext[c.span[0]:c.span[1]] != c.text]
bad_spans += [c.number for c in after if atext[c.span[0]:c.span[1]] != c.text]
expect(not bad_spans, f"смещения совпадают с текстом ({len(bad_spans)} расхождений)")

findings = detect(before, after)
ok, rejected = check(findings, {before[0].doc_id: btext, after[0].doc_id: atext})
expect(not rejected, f"все цитаты дословны ({len(rejected)} отклонено)")
expect(all(f["evidence"] for f in ok), "каждый вывод несёт хотя бы одну цитату")
expect(all(f.get("trace") for f in ok), "каждый вывод несёт цепочку получения")

s = score(ok)
expect(not s["violations"],
       f"негативные тесты: {len(s['violations'])} нарушений")
expect(s["recall"] >= BASELINE_RECALL,
       f"полнота {s['recall']:.0%} ≥ рубежа {BASELINE_RECALL:.0%}")

print(f"\n  провалов: {len(fails)}")
sys.exit(1 if fails else 0)
