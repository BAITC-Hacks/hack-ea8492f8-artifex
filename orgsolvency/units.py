"""Подразделения: кто существовал, кто уцелел, кто появился.

Must-have №1. Сопоставление ведётся не по названию: при реорганизации
департамент переименовывают, а функции оставляют, — и наоборот, сохраняют
имя, вынув половину полномочий. Поэтому совпадение считается по четырём
признакам сразу, и каждый виден в обосновании.
"""
import re
from .core import overlap, tokens, UNIT_LABEL

# «БВА состоит из следующих структурных подразделений: Департамент А (ДА); ...»
COMPOSITION = re.compile(
    r"состои[тл]\s+из\s+следующих\s+структурных\s+подразделений\s*:?\s*(.+)", re.I)
# «Директору ДИТААД подчиняются работники ... в составе следующих должностей: ...»
SUBORDINATION = re.compile(
    r"^(Директору|Руководителю)\s+(.+?)\s+подчиняются\b(.*)$", re.I)
POSITIONS = re.compile(r"должностей\s*:?\s*(.+)", re.I)
ABBREV = re.compile(r"\(([А-ЯЁA-Z]{2,10})\)")

MATCH_MIN = 0.34          # ниже — считаем, что соответствия нет
TRANSFORM_DROP = 0.55     # доля сохранённых функций, ниже которой это уже не «сохранено»

# Одно подразделение приходит из документа дважды: полным наименованием из
# состава блока и аббревиатурой из заголовка раздела. Приводим к одному ключу.
CANON = {}
for _uid_, _label_ in UNIT_LABEL.items():
    CANON[_uid_.lower()] = _uid_
    CANON[_label_.lower()] = _uid_
NOT_A_UNIT = {"COMPANY", "STAFF", "DEPT_DIRS"}   # не структурные подразделения
UNIT_WORDS = ("департамент", "управление", "отдел", "блок", "служба", "дирекц")
# Слова, не различающие подразделения: «Директор Департамента X» и
# «Департамент X» — одна и та же сущность, названная с разных сторон.
GENERIC = {"директор", "директору", "директора", "руководитель", "руководителю",
           "руководителя", "департамент", "департамента", "департаменту",
           "управление", "управления", "отдел", "отдела", "блок", "блока",
           "служба", "службы", "по", "и"}


def _key(name: str) -> str:
    t = re.sub(r"\(.*?\)", " ", name).lower()
    t = re.sub(r"[^а-яёa-z ]", " ", t)
    return " ".join(w for w in t.split() if w not in GENERIC and len(w) > 2)


def _split(text: str):
    return [p.strip(" .;") for p in re.split(r"[;,]", text) if len(p.strip()) > 2]


def extract(clauses) -> dict:
    """Пункты → подразделения с их составом, функциями и подчинением."""
    units, order = {}, 0

    def touch(name, uid=None, structural=False):
        nonlocal order
        uid = uid or _uid(name)
        if uid not in units:
            order += 1
            units[uid] = {"unit_id": uid, "name": name.strip(), "abbrev": None,
                          "positions": [], "functions": [], "parent": None,
                          "evidence": [], "order": order, "structural": structural}
        u = units[uid]
        u["structural"] = u["structural"] or structural
        # полное наименование информативнее аббревиатуры
        if structural and len(name.strip()) > len(u["name"]):
            u["name"] = name.strip()
        return u

    for c in clauses:
        if c.is_header:
            # Заголовок раздела задаёт владельца функций: «5.5. Директор ДККМ:»
            continue
        m = COMPOSITION.search(c.text)
        if m:
            for piece in _split(m.group(1)):
                ab = ABBREV.search(piece)
                u = touch(ABBREV.sub("", piece).strip(),
                          _uid(piece), structural=True)
                u["abbrev"] = ab.group(1) if ab else u["abbrev"]
                u["evidence"].append({"clause": c.number, "quote": c.text,
                                      "doc_id": c.doc_id, "span": list(c.span),
                                      "role": "after"})
        m = SUBORDINATION.match(c.text)
        if m:
            head = m.group(2).strip()
            # «Директору направления ВА подчиняются…» — сущность называется
            # «Директор направления ВА», а не обрывком после предлога.
            title = {"директору": "Директор", "руководителю": "Руководитель"}[
                m.group(1).lower()]
            named = head if re.fullmatch(r"[А-ЯЁA-Z]{2,10}", head) or \
                any(w in head.lower() for w in UNIT_WORDS) else f"{title} {head}"
            u = touch(named, _uid(head), structural=True)
            if not u["abbrev"] and re.fullmatch(r"[А-ЯЁA-Z]{2,10}", head):
                u["abbrev"] = head
            p = POSITIONS.search(c.text)
            if p:
                u["positions"] = _split(p.group(1))
            if not u["evidence"]:
                u["evidence"].append({"clause": c.number, "quote": c.text,
                                      "doc_id": c.doc_id, "span": list(c.span),
                                      "role": "after"})

    # функции: всё, что закреплено за владельцем в разделах о правах и обязанностях
    for c in clauses:
        if c.kind != "capability" or not c.owner:
            continue
        uid = c.owner
        u = units.get(uid) or touch(UNIT_LABEL.get(uid, uid), uid)
        u["functions"].append({"clause": c.number, "text": c.text,
                               "tokens": c.tokens})

    structural = {uid: u for uid, u in units.items() if u["structural"]}
    for uid, u in list(units.items()):
        if u["structural"] or uid in NOT_A_UNIT or not u["functions"]:
            continue
        k = _key(u["name"])
        host = None
        for sid, su in structural.items():
            if not k:
                break
            if overlap(set(k.split()), set(_key(su["name"]).split())) >= 0.5:
                host = su
                break
        if host:
            host["functions"].extend(u["functions"])
            units.pop(uid)

    # Роли, адресаты обязанностей и заголовки разделов — не подразделения.
    def is_unit(uid, u):
        low = u["name"].lower()
        if uid in NOT_A_UNIT or u["name"].rstrip().endswith(":"):
            return False
        if any(p in low for p in ("имеют право", "имеет право", "обязан",
                                  "не имеют", "для выполнения")):
            return False
        return u["structural"] or bool(u["abbrev"]) or \
            any(w in low for w in UNIT_WORDS)

    return {uid: u for uid, u in units.items() if is_unit(uid, u)}


def _uid(name: str) -> str:
    ab = ABBREV.search(name) or (re.fullmatch(r"\s*([А-ЯЁA-Z]{2,10})\s*", name))
    if ab and ab.group(1).lower() in CANON:
        return CANON[ab.group(1).lower()]
    if ab:
        return ab.group(1).upper()
    plain = re.sub(r"\(.*?\)", "", name).strip().lower()
    if plain in CANON:
        return CANON[plain]
    for label, uid in CANON.items():
        if len(label) > 6 and label in plain:
            return uid
    return (_key(name)[:28] or name[:28]).strip()


def _sim(a: dict, b: dict) -> tuple:
    """Четыре признака: аббревиатура, название, функции, должности."""
    by_abbrev = bool(a["abbrev"]) and a["abbrev"] == b["abbrev"]
    by_name = overlap(tokens(a["name"]), tokens(b["name"]))
    fa = set().union(*[f["tokens"] for f in a["functions"]]) if a["functions"] else set()
    fb = set().union(*[f["tokens"] for f in b["functions"]]) if b["functions"] else set()
    by_func = overlap(fa, fb)
    pa = {tuple(sorted(tokens(p))) for p in a["positions"]}
    pb = {tuple(sorted(tokens(p))) for p in b["positions"]}
    by_pos = len(pa & pb) / len(pa | pb) if (pa or pb) else 0.0

    score = max(1.0 if by_abbrev else 0.0,
                0.45 * by_name + 0.35 * by_func + 0.20 * by_pos)
    why = []
    if by_abbrev:
        why.append(f"совпадает аббревиатура {a['abbrev']}")
    if by_name >= .3:
        why.append(f"сходство наименований {by_name:.2f}")
    if by_func >= .2:
        why.append(f"общий функционал {by_func:.2f}")
    if by_pos > 0:
        why.append(f"совпадают должности {by_pos:.2f}")
    return score, why, by_func, by_pos


def compare(before_clauses, after_clauses) -> dict:
    """→ структура для интерфейса и выводы о подразделениях."""
    B, A = extract(before_clauses), extract(after_clauses)
    pairs, taken = {}, set()

    for bid, b in sorted(B.items(), key=lambda kv: kv[1]["order"]):
        best, score, why, fsim, psim = None, MATCH_MIN, [], 0, 0
        for aid, a in A.items():
            if aid in taken:
                continue
            s, w, f, p = _sim(b, a)
            if s > score:
                best, score, why, fsim, psim = aid, s, w, f, p
        if best:
            taken.add(best)
            kept = fsim
            # Преобразованием считается утрата функционала либо изменение
            # штатного состава. Переименование должности при том же их числе
            # преобразованием не является: «Директор проектов ДНМ» и
            # «Директор проектов» — одна и та же позиция.
            nb, na = len(b["positions"]), len(A[best]["positions"])
            staff_changed = bool(nb and na) and abs(na - nb) / max(nb, na) > 0.25
            status = "transformed" if (
                (b["functions"] and kept < TRANSFORM_DROP) or staff_changed
            ) else "preserved"
            pairs[bid] = {"to": best, "score": round(score, 2), "why": why,
                          "status": status, "kept": round(kept, 2)}

    findings, nodes_b, nodes_a, links = [], [], [], []

    for bid, b in sorted(B.items(), key=lambda kv: kv[1]["order"]):
        p = pairs.get(bid)
        st = "abolished" if not p else p["status"]
        nodes_b.append(_node(b, st, "before"))
        if p:
            links.append({"from": bid, "to": p["to"], "status": p["status"],
                          "score": p["score"], "why": p["why"]})

    for aid, a in sorted(A.items(), key=lambda kv: kv[1]["order"]):
        st = "created" if aid not in taken else \
            next(p["status"] for p in pairs.values() if p["to"] == aid)
        nodes_a.append(_node(a, st, "after"))

    # выводы
    for bid, b in B.items():
        if bid not in pairs:
            findings.append(_uf(
                f"U-ABOL-{bid}", "unit_abolished", "R-UNIT-01", "high",
                f"Подразделение «{b['name']}» упразднено: в новой редакции нет "
                f"подразделения с сопоставимым наименованием, функционалом или составом",
                b, None, [f"проверено {len(A)} подразделений новой редакции",
                          f"лучшее совпадение ниже порога {MATCH_MIN}"]))
    for aid, a in A.items():
        if aid not in taken:
            findings.append(_uf(
                f"U-NEW-{aid}", "unit_created", "R-UNIT-02", "info",
                f"Создано подразделение «{a['name']}»",
                None, a, [f"в прежней редакции соответствия не найдено "
                          f"(порог {MATCH_MIN})"]))
    for bid, p in pairs.items():
        if p["status"] != "transformed":
            continue
        b, a = B[bid], A[p["to"]]
        findings.append(_uf(
            f"U-TR-{bid}", "unit_transformed", "R-UNIT-03", "medium",
            f"Подразделение «{b['name']}» преобразовано: сохранено "
            f"{p['kept']:.0%} функционала, должностей "
            f"{len(b['positions'])} → {len(a['positions'])}",
            b, a, [f"сопоставление: {', '.join(p['why'])}",
                   f"должностей было {len(b['positions'])}, стало {len(a['positions'])}",
                   f"функций было {len(b['functions'])}, стало {len(a['functions'])}"]))

    return {
        "structure": {"before": nodes_b, "after": nodes_a, "links": links},
        "findings": findings,
        "counts": {
            "preserved": sum(1 for p in pairs.values() if p["status"] == "preserved"),
            "transformed": sum(1 for p in pairs.values() if p["status"] == "transformed"),
            "created": len(A) - len(taken),
            "abolished": len(B) - len(pairs),
        },
    }


def _node(u, status, side):
    return {"id": u["unit_id"], "name": u["name"], "abbrev": u["abbrev"],
            "status": status, "side": side,
            "positions": u["positions"], "functions": len(u["functions"]),
            "clauses": [f["clause"] for f in u["functions"]],
            "evidence": u["evidence"][:1]}


def _uf(fid, ftype, rule, sev, statement, b, a, trace):
    ev = []
    for src, role in ((b, "before"), (a, "after")):
        if src and src["evidence"]:
            e = dict(src["evidence"][0]); e["role"] = role
            ev.append(e)
    return {"finding_id": fid, "type": ftype, "rule_id": rule, "severity": sev,
            "statement": statement, "evidence": ev, "trace": trace,
            "confidence": 0.8, "engine": "правила"}
