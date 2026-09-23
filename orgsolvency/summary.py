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
    proven = sum(1 for f in findings
                 if f.get("certainty", {}).get("key") == "proven"
                 or (not f.get("certainty") and f["type"] not in ASSERTS_ABSENCE))
    return {
        "headline": headline,
        "narrative": parts,
        # Шкала критичности убрана с экрана: она отвечала на вопрос инженера,
        # а не пользователя. Вместо неё — насколько выводам можно доверять.
        "kpi": [
            {"value": len(findings), "label": "отклонений", "tone": "default"},
            {"value": proven, "label": "подтверждено документом", "tone": "ok"},
            {"value": len(findings) - proven, "label": "требует проверки",
             "tone": "critical"},
            {"value": f"{len(before)}→{len(after)}", "label": "пунктов разобрано",
             "tone": "muted"},
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


# ── Подача для человека, а не для инженера ──────────────────────────────────
#
# «critical / high / medium» — шкала из мира уязвимостей. Сотрудник, который
# ведёт реорганизацию, задаёт другие вопросы, и в другом порядке:
#
#   1. что сломалось?          → группировка по последствию
#   2. насколько это точно?    → подтверждённость
#   3. что теперь делать?      → рекомендация
#
# Критичность остаётся внутри как порядок сортировки, но на экран выносится
# не она.

CONSEQUENCE = {
    "orphan": ("not_done", "Функция не исполняется"),
    "lost": ("not_done", "Функция не исполняется"),
    "duplicated": ("blurred", "Ответственность размыта"),
    "conflict_of_interest": ("blurred", "Ответственность размыта"),
    "weakened": ("softened", "Требование ослаблено"),
    "collision": ("contradiction", "Документ противоречит себе"),
    "broken_reference": ("contradiction", "Документ противоречит себе"),
    "transferred": ("tracked", "Изменение прослежено"),
}
CONSEQUENCE_ORDER = ["not_done", "blurred", "contradiction", "softened", "tracked"]
CONSEQUENCE_HINT = {
    "not_done": "Обязанность есть, исполнителя нет. Самое дорогое последствие "
                "реорганизации: выявляется на внешней проверке.",
    "blurred": "За одно и то же отвечают двое либо проверяющий проверяет сам себя. "
               "Работа дублируется, ответственность не персонифицирована.",
    "contradiction": "Документ разрешает то, что сам же запрещает, либо ссылается "
                     "не туда. Применять такую норму нельзя.",
    "softened": "Норма уцелела как текст и ослабла как обязательство: "
                "«должен» стало «может», исчезла периодичность.",
    "tracked": "Функция не потеряна — у неё сменился владелец. Показано, "
               "чтобы передачу не приняли за утрату.",
}

RECOMMEND = {
    "orphan": "Закрепить полномочие за подразделением либо отменить обязательство.",
    "lost": "Передать функцию сохранившемуся подразделению или зафиксировать "
            "сознательный отказ от неё.",
    "transferred": "Убедиться, что принимающее подразделение обеспечено ресурсами "
                   "и полномочиями.",
    "weakened": "Подтвердить, что смягчение нормы намеренное, либо вернуть "
                "прежнюю формулировку.",
    "duplicated": "Разграничить зоны ответственности или назначить ведущее "
                  "подразделение.",
    "collision": "Устранить противоречие: снять функцию либо изменить запрет.",
    "conflict_of_interest": "Вывести оценку из подчинения оцениваемому.",
    "broken_reference": "Обновить перекрёстные ссылки после перенумерации разделов.",
}

# Присутствие нормы доказывается цитатой. Отсутствие — не доказывается ничем:
# его можно только не найти. Поэтому выводы об отсутствии честнее показывать
# как требующие проверки, а не как установленный факт.
ASSERTS_ABSENCE = {"orphan", "lost"}


def certainty(f: dict) -> dict:
    if f.get("engine") == "модель":
        return {"key": "model", "label": "Решено моделью",
                "why": "Совпадение формулировок установлено моделью — "
                       "проверьте цитаты."}
    if f["type"] in ASSERTS_ABSENCE:
        return {"key": "check", "label": "Требует проверки",
                "why": "Вывод об отсутствии: подтверждается ненахождением, "
                       "а не цитатой. Возможен перенос нормы в другой документ."}
    return {"key": "proven", "label": "Подтверждено документом",
            "why": "Обе стороны вывода процитированы дословно из загруженных файлов."}


def enrich(findings: list) -> list:
    """Добавляет к выводу последствие, подтверждённость и рекомендацию."""
    for f in findings:
        key, label = CONSEQUENCE.get(f["type"], ("tracked", "Прочее"))
        f["consequence"] = key
        f["consequence_label"] = label
        f["certainty"] = certainty(f)
        f.setdefault("recommendation", RECOMMEND.get(f["type"]))
    return findings


def by_consequence(findings: list) -> list:
    """Группы в порядке цены последствия, а не в порядке частоты."""
    out = []
    for key in CONSEQUENCE_ORDER:
        group = [f for f in findings if f.get("consequence") == key]
        if not group:
            continue
        label = group[0]["consequence_label"]
        out.append({
            "key": key, "label": label, "hint": CONSEQUENCE_HINT[key],
            "count": len(group),
            "proven": sum(1 for f in group if f["certainty"]["key"] == "proven"),
        })
    return out
