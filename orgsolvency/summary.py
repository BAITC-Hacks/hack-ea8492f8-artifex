"""Итоговое аналитическое заключение на человеческом языке.

Must-have №5: заключение должно читаться как факт, а не как дамп выводов.
Формулировки собираются из посчитанных величин, поэтому цифра в тексте и
цифра в таблице не могут разойтись.
"""

RU = {
    "orphan": ("обязательство без исполнителя", "обязательства без исполнителя",
               "обязательств без исполнителя"),
    "lost": ("утраченная функция", "утраченные функции", "утраченных функций"),
    "transferred": ("переданная функция", "переданные функции", "переданных функций"),
    "weakened": ("ослабленная норма", "ослабленные нормы", "ослабленных норм"),
    "duplicated": ("дублирование функции", "дублирования функций", "дублирований функций"),
    "collision": ("нормативная коллизия", "нормативные коллизии", "нормативных коллизий"),
    "conflict_of_interest": ("конфликт интересов", "конфликта интересов", "конфликтов интересов"),
    "broken_reference": ("нарушенная ссылка", "нарушенные ссылки", "нарушенных ссылок"),
}
SEV_RU = {"critical": "критический", "high": "высокий",
          "medium": "средний", "low": "низкий", "info": "справочный"}


def plural(n: int, one: str, few: str, many: str) -> str:
    """Русские три формы: 1 функция, 2 функции, 5 функций."""
    n10, n100 = n % 10, n % 100
    if n10 == 1 and n100 != 11:
        return one
    if 2 <= n10 <= 4 and not 12 <= n100 <= 14:
        return few
    return many


def summarize(findings, before, after, doc_titles):
    by_type, by_sev = {}, {}
    for f in findings:
        by_type.setdefault(f["type"], []).append(f)
        by_sev[f["severity"]] = by_sev.get(f["severity"], 0) + 1

    orphans = by_type.get("orphan", [])
    lost = by_type.get("lost", [])
    critical = [f for f in findings if f["severity"] == "critical"]

    # Заголовок заключения: самое дорогое последствие, а не самая частая находка.
    if orphans:
        n = len(orphans)
        headline = (f"Реорганизация оставила {n} "
                    f"{plural(n, 'обязательство', 'обязательства', 'обязательств')} "
                    f"без исполнителя")
    elif lost:
        n = len(lost)
        headline = (f"После реорганизации не закреплена {n} "
                    f"{plural(n, 'функция', 'функции', 'функций')}"
                    if n % 10 == 1 and n % 100 != 11 else
                    f"После реорганизации не закреплено {n} "
                    f"{plural(n, 'функция', 'функции', 'функций')}")
    elif findings:
        headline = f"Выявлено {len(findings)} отклонений, критических среди них нет"
    else:
        headline = "Отклонений не выявлено"

    parts = []
    if orphans:
        cl = ", ".join(f"п. {f['evidence'][0]['clause']}" for f in orphans[:4])
        parts.append(
            f"Документ сохраняет обязательства ({cl}), но ни одно подразделение "
            f"не наделено полномочием их исполнить: полномочие было утрачено при "
            f"перераспределении функций.")
    if lost:
        cl = ", ".join(f"п. {f['evidence'][0]['clause']}" for f in lost[:4])
        parts.append(
            f"Полномочия из {cl} присутствовали в прежней редакции, их владелец "
            f"сохранился, но в новой редакции они не закреплены ни за кем.")
    if by_type.get("weakened"):
        n = len(by_type["weakened"])
        parts.append(
            f"{n} {plural(n, 'норма ослаблена', 'нормы ослаблены', 'норм ослаблено')} без изменения "
            f"существа: обязанность заменена возможностью либо снята периодичность.")
    if by_type.get("duplicated"):
        n = len(by_type["duplicated"])
        parts.append(
            f"Обнаружено {n} {plural(n, 'пересечение', 'пересечения', 'пересечений')} зон "
            f"ответственности между подразделениями, не связанными подчинением.")
    if by_type.get("collision"):
        parts.append(
            "Отдельным подразделениям закреплены действия, прямо запрещённые "
            "этим же документом.")
    if by_type.get("conflict_of_interest"):
        parts.append(
            "Зафиксирован конфликт интересов: оценивающий и оцениваемый совпадают.")
    if by_type.get("broken_reference"):
        parts.append(
            "Перенумерация разделов оставила перекрёстные ссылки, указывающие "
            "на другие по смыслу пункты.")

    cited = sum(1 for f in findings if f.get("evidence"))
    return {
        "headline": headline,
        "narrative": parts,
        "kpi": [
            {"value": len(findings), "label": "отклонений", "tone": "default"},
            {"value": len(critical), "label": "критических", "tone": "critical"},
            {"value": f"{len(before)}→{len(after)}", "label": "пунктов разобрано",
             "tone": "muted"},
            {"value": f"{(cited / len(findings) * 100) if findings else 100:.0f}%",
             "label": "выводов с источником", "tone": "ok"},
        ],
        "by_type": [
            {"type": t, "label": plural(len(v), *RU.get(t, (t, t))),
             "count": len(v),
             "severity": min((f["severity"] for f in v),
                             key=lambda s: ["critical", "high", "medium",
                                            "low", "info"].index(s))}
            for t, v in sorted(by_type.items(), key=lambda kv: -len(kv[1]))
        ],
        "by_severity": by_sev,
        "documents": doc_titles,
    }
