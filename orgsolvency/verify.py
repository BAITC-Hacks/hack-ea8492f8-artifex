"""Контроль цитат: дословное вхождение в исходный файл.

Не модель проверяет модель — обычный поиск подстроки. Дешево и делает
выдуманную ссылку структурно невозможной.
"""


def check(findings, sources: dict):
    """sources: {doc_id: полный текст}. Возвращает (прошедшие, отклонённые)."""
    ok, rejected = [], []
    for f in findings:
        bad = [x for x in f["evidence"]
               if x["quote"] not in sources.get(x["doc_id"], "")]
        if bad:
            f["rejected_evidence"] = bad
            rejected.append(f)
        else:
            ok.append(f)
    return ok, rejected
