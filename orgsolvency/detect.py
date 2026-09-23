"""Детекторы отклонений.

Каждый детектор возвращает Finding с обязательной цитатой. Цитата не
формулируется, а вырезается из исходного текста по символьным смещениям —
поэтому выдуманная ссылка на пункт структурно невозможна.
"""
import re
from .core import overlap, tokens, stem

SIM_SAME = 0.45      # порог «та же норма, другая формулировка»
SIM_DUP = 0.50       # порог дублирования внутри одного документа
COVER_COLLIDE = 0.34  # доля предмета запрета, покрытая формулировкой функции
SIM_COVER = 0.20     # порог «эта функция покрывает это обязательство»


def _ev(c, role):
    return {"doc_id": c.doc_id, "clause": c.number, "quote": c.text,
            "span": list(c.span), "role": role}


def _f(fid, ftype, rule, sev, statement, evidence, trace, conf=1.0):
    return {"finding_id": fid, "type": ftype, "rule_id": rule, "severity": sev,
            "statement": statement, "evidence": evidence, "trace": trace,
            "confidence": conf}


def _best(clause, pool, minimum=0.0):
    best, score = None, minimum
    for cand in pool:
        s = overlap(clause.tokens, cand.tokens)
        if s > score:
            best, score = cand, s
    return best, score


def broken_references(before, after):
    """Ссылка «п. X» пережила перенумерацию и указывает на другой по смыслу пункт."""
    out, bi = [], {c.number: c for c in before}
    ai = {c.number: c for c in after}
    for src in after:
        for ref in src.refs():
            tgt_after = ai.get(ref)
            tgt_before = bi.get(ref)
            if not tgt_after or not tgt_before:
                continue
            # ссылающийся пункт не изменился по смыслу?
            twin, sim_src = _best(src, before, 0.0)
            if not twin or sim_src < SIM_SAME:
                continue
            if ref not in twin.refs():
                continue
            drift = overlap(tgt_before.tokens, tgt_after.tokens)
            if drift >= SIM_SAME:
                continue
            # куда уехал первоначальный адресат
            moved, sim_moved = _best(tgt_before, after, 0.6)
            ev = [_ev(src, "reference_source"), _ev(tgt_after, "reference_target"),
                  _ev(twin, "before")]
            if moved:
                ev.append(_ev(moved, "requirement"))
            out.append(_f(
                f"BR-{src.number}-{ref}", "broken_reference", "R-REF-01", "high",
                f"Пункт {src.number} ссылается на п. {ref}, который после "
                f"перенумерации содержит другую норму"
                + (f"; первоначальный адресат перенесён в п. {moved.number}" if moved else ""),
                ev,
                [f"ссылающийся пункт {src.number} совпадает с {twin.number} ред. «до» (сходство {sim_src:.2f})",
                 f"адресат п. {ref} изменился: сходство текста {drift:.2f} < {SIM_SAME}",
                 (f"исходная норма найдена в п. {moved.number} (сходство {sim_moved:.2f})"
                  if moved else "исходная норма в новой редакции не найдена")],
                round(1 - drift, 2)))
    return out


def modality_downgrades(before, after):
    """Норма выжила текстом и ослабла как обязательство."""
    out = []
    for b in before:
        a, sim = _best(b, after, SIM_SAME)
        if not a or a.modality >= b.modality or b.modality == 0 or a.modality == 0:
            continue
        out.append(_f(
            f"W-{b.number}", "weakened", "R-WEAK-01",
            "critical" if b.modality >= 4 else "high",
            f"Норма п. {b.number} ослаблена: уровень обязательности снижен "
            f"с {b.modality} до {a.modality} (п. {a.number} новой редакции)",
            [_ev(b, "before"), _ev(a, "after")],
            [f"сопоставление по тексту: сходство {sim:.2f}",
             f"модальность {b.modality} → {a.modality} по решётке обязан>должен>осуществляется>может"],
            round(sim, 2)))
    return out


def capability_changes(before, after):
    """Функция исчезла у владельца: утрачена либо передана другому."""
    out = []
    for b in [c for c in before if c.kind == "capability"]:
        a, sim = _best(b, [c for c in after if c.kind == "capability"], SIM_SAME)
        if a is None:
            out.append(_f(
                f"L-{b.number}", "lost", "R-LOST-01", "high",
                f"Функция из п. {b.number} ({b.owner}) не закреплена ни за одним "
                f"подразделением в новой редакции",
                [_ev(b, "before")],
                [f"владелец в ред. «до»: {b.owner}",
                 f"в ред. «после» нет функции со сходством ≥ {SIM_SAME}"],
                0.8))
        elif a.owner != b.owner:
            out.append(_f(
                f"T-{b.number}", "transferred", "R-TRANS-01", "info",
                f"Функция передана: {b.owner} (п. {b.number}) → {a.owner} (п. {a.number})",
                [_ev(b, "before"), _ev(a, "after")],
                [f"сходство формулировок {sim:.2f}", "владелец изменился → не потеря"],
                round(sim, 2)))
    return out


def duplicates(clauses):
    """Одна функция у двух владельцев внутри одного документа."""
    out, caps = [], [c for c in clauses if c.kind == "capability"]
    for i, x in enumerate(caps):
        for y in caps[i + 1:]:
            if x.owner == y.owner or not x.owner or not y.owner:
                continue
            sim = overlap(x.tokens, y.tokens)
            if sim < SIM_DUP:
                continue
            out.append(_f(
                f"D-{x.number}-{y.number}", "duplicated", "R-DUP-01", "medium",
                f"Одна и та же функция закреплена за {x.owner} (п. {x.number}) "
                f"и {y.owner} (п. {y.number})",
                [_ev(x, "after"), _ev(y, "after")],
                [f"сходство формулировок {sim:.2f} ≥ {SIM_DUP}",
                 "владельцы различны и не связаны отношением подчинения"],
                round(sim, 2)))
    return out


def collisions(clauses):
    """Закреплённая функция описывает действие, прямо запрещённое тем же документом.

    Запрет перечисляет несколько действий через «;». Сравнение ведётся по
    покрытию предмета каждого запрещённого действия, а не по сходству абзацев:
    абзац запрета длинный, и мера Жаккара его размывает.
    """
    out = []
    acts = []
    for ban in [c for c in clauses if c.kind == "prohibition"]:
        for piece in ban.text.split(";"):
            tok = tokens(piece)
            if len(tok) < 4:   # трёхсловные запреты дают шум на коротких пересечениях
                continue
            # Первый значимый токен — действие. Без совпадения действия
            # совпадение предмета ничего не доказывает: «контрольные процедуры»
            # упоминают многие пункты, но запрещено именно «внедрять» их.
            words = re.findall(r"[а-яёa-z]+", piece.lower())
            verb = stem(words[0]) if words else None
            acts.append((ban, piece.strip(), tok, verb))
    for c in clauses:
        if c.kind in ("prohibition", "header"):
            continue
        for ban, piece, act_tok, verb in acts:
            cover = len(act_tok & c.tokens) / len(act_tok)
            if cover < COVER_COLLIDE or (verb and verb not in c.tokens):
                continue
            out.append(_f(
                f"C-{c.number}", "collision", "R-COLL-01", "high",
                f"Функция из п. {c.number} описывает действие, запрещённое п. {ban.number}",
                [_ev(c, "after"), _ev(ban, "prohibition")],
                [f"запрещённое действие: «{piece[:70]}»",
                 f"совпало действие ({verb}), а не только предмет",
                 f"покрытие предмета запрета формулировкой функции {cover:.2f} ≥ {COVER_COLLIDE}"],
                round(cover, 2)))
    return out


def orphan_obligations(clauses):
    """Обязательство есть, а полномочия его исполнить нет ни у кого.

    Ядро продукта: не сравнение текстов, а проверка исполнимости обязательства.
    """
    out = []
    caps = [c for c in clauses if c.kind == "capability" and c.owner]
    for ob in [c for c in clauses if c.kind == "obligation" and c.modality >= 3]:
        if ob.chapter in ("2", "3"):
            continue
        holder, sim = _best(ob, caps, SIM_COVER)
        if holder:
            continue
        out.append(_f(
            f"O-{ob.number}", "orphan", "R-ORPH-01", "critical",
            f"Обязательство п. {ob.number} действует, но ни одно подразделение "
            f"не наделено полномочием его исполнить",
            [_ev(ob, "requirement")],
            [f"обязательность: уровень {ob.modality}",
             f"ни одна функция с владельцем не покрывает предмет (порог {SIM_COVER})",
             "исполнимость обязательства не обеспечена структурой"],
            0.75))
    return out


def self_assessment(clauses):
    """Оценивающий и оцениваемый — одно лицо."""
    out = []
    for c in clauses:
        if "самооценк" not in c.text.lower():
            continue
        ev = [_ev(c, "after")]
        for other in clauses:
            if other.number.startswith(("3.5", "10.3")):
                ev.append(_ev(other, "after"))
        out.append(_f(
            f"K-{c.number}", "conflict_of_interest", "R-COI-01", "high",
            f"Оценка качества по п. {c.number} проводится самим оцениваемым "
            f"подразделением; независимость оценки не обеспечена",
            ev,
            ["предмет оценки и исполнитель оценки совпадают",
             "подчинённость оценивающего оцениваемому подтверждается структурой раздела 3"],
            0.85))
    return out


def run(before, after):
    before = [c for c in before if not c.is_header]
    after = [c for c in after if not c.is_header]
    findings = []
    findings += broken_references(before, after)
    findings += modality_downgrades(before, after)
    findings += capability_changes(before, after)
    findings += duplicates(after)
    findings += collisions(after)
    findings += orphan_obligations(after)
    findings += self_assessment(after)
    order = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}
    findings.sort(key=lambda f: (order.get(f["severity"], 9), f["finding_id"]))
    return findings
