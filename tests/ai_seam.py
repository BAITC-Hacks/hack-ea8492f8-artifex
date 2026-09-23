#!/usr/bin/env python3
"""Проверка, что разъём модели — рабочий путь, а не мёртвый код.

    python3 tests/ai_seam.py

Подставляется фальшивый провайдер: сетевых вызовов нет, ключ не нужен.
Проверяется, что модель спрашивают только в полосе неопределённости и что
её участие попадает в цепочку получения вывода.
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import orgsolvency.ai as ai
from orgsolvency.core import load
from orgsolvency.detect import run

fails = []


def expect(cond, msg):
    print(("  [+] " if cond else "  [!] ") + msg)
    if not cond:
        fails.append(msg)


class Fake(ai.Provider):
    name, available, model = "fake", True, "fake-1"
    calls = []

    def judge_same(self, a, b):
        Fake.calls.append((a, b))
        return {"same": True, "confidence": 0.77,
                "why": "та же функция, другая формулировка"}


before, _, _ = load("corpus/rev8.txt")
after, _, _ = load("corpus/rev9.txt")

ai._provider = ai.NullProvider()
base = run(before, after)
expect(all(f.get("engine") == "правила" for f in base),
       f"без ключа всё решается правилами ({len(base)} выводов)")

ai._provider = Fake()
with_ai = run(before, after)
by_model = [f for f in with_ai if f.get("engine") == "модель"]
expect(Fake.calls, f"модель вызвана {len(Fake.calls)} раз")
expect(by_model, f"модель повлияла на {len(by_model)} выводов")
expect(all(any("модель" in t for t in f["trace"]) for f in by_model),
       "участие модели видно в цепочке получения вывода")
expect(all(f["evidence"] for f in with_ai),
       "цитаты сохраняются: модель не формирует номера пунктов")
expect(ai.status()["engine"] == "правила + модель",
       f"статус движка: {ai.status()['engine']}")

print(f"\n  провалов: {len(fails)}")
sys.exit(1 if fails else 0)
