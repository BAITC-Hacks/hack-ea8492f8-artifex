"""Отчёт: карта исполнимости обязательств + перечень отклонений с цитатами."""
import html, json, datetime

SEV = {"critical": ("#7f1d1d", "#fee2e2"), "high": ("#9a3412", "#ffedd5"),
       "medium": ("#854d0e", "#fef9c3"), "low": ("#1e40af", "#dbeafe"),
       "info": ("#334155", "#e2e8f0")}
RU = {"lost": "потеря функции", "transferred": "передача функции",
      "weakened": "ослабление нормы", "duplicated": "дублирование",
      "orphan": "обязательство без исполнителя", "collision": "нормативная коллизия",
      "conflict_of_interest": "конфликт интересов",
      "broken_reference": "нарушенная ссылка"}


def render(findings, before, after, path):
    e = html.escape
    n_crit = sum(1 for f in findings if f["severity"] == "critical")
    rows = []
    for f in findings:
        fg, bg = SEV.get(f["severity"], SEV["info"])
        ev = "".join(
            f'<div class="ev"><span class="cl">{e(x["doc_id"])} п. {e(x["clause"])}</span>'
            f'<span class="role">{e(x.get("role",""))}</span>'
            f'<blockquote>{e(x["quote"])}</blockquote></div>'
            for x in f["evidence"])
        tr = "".join(f"<li>{e(t)}</li>" for t in f.get("trace", []))
        rows.append(f"""
<details class="f">
  <summary><span class="sev" style="color:{fg};background:{bg}">{e(f["severity"])}</span>
  <span class="ty">{e(RU.get(f["type"], f["type"]))}</span>
  <span class="st">{e(f["statement"])}</span>
  <span class="rid">{e(f["rule_id"])} · {f.get("confidence", 0):.2f}</span></summary>
  <div class="body"><div class="trace"><b>Как получен вывод</b><ol>{tr}</ol></div>{ev}</div>
</details>""")

    open(path, "w", encoding="utf-8").write(f"""<!doctype html><html lang="ru"><meta charset="utf-8">
<title>OrgSolvency — заключение</title>
<style>
:root{{--bg:#fff;--fg:#0f172a;--mut:#64748b;--line:#e2e8f0;--card:#f8fafc}}
@media(prefers-color-scheme:dark){{:root:not([data-theme=light]){{--bg:#0b1120;--fg:#e2e8f0;--mut:#94a3b8;--line:#1e293b;--card:#111c33}}}}
body{{background:var(--bg);color:var(--fg);font:15px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:24px 16px}}
.wrap{{max-width:940px;margin:0 auto}}
h1{{font-size:22px;margin:0 0 4px}} .sub{{color:var(--mut);margin:0 0 20px;font-size:14px}}
.kpi{{display:flex;gap:10px;flex-wrap:wrap;margin:0 0 22px}}
.kpi div{{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px;flex:1;min-width:130px}}
.kpi b{{display:block;font-size:26px;line-height:1.1}} .kpi span{{color:var(--mut);font-size:12px}}
.f{{border:1px solid var(--line);border-radius:10px;margin:0 0 8px;background:var(--card)}}
summary{{cursor:pointer;padding:11px 13px;display:flex;gap:9px;align-items:baseline;flex-wrap:wrap}}
.sev{{font-size:11px;padding:2px 7px;border-radius:5px;font-weight:600}}
.ty{{font-size:12px;color:var(--mut);white-space:nowrap}} .st{{flex:1;min-width:230px}}
.rid{{font-size:11px;color:var(--mut);font-family:ui-monospace,monospace}}
.body{{padding:0 13px 13px;border-top:1px solid var(--line)}}
.trace ol{{margin:6px 0 14px;padding-left:20px;color:var(--mut);font-size:13px}}
.ev{{margin:0 0 10px}} .cl{{font-family:ui-monospace,monospace;font-size:12px}}
.role{{font-size:11px;color:var(--mut);margin-left:8px}}
blockquote{{margin:4px 0 0;padding:7px 11px;border-left:3px solid var(--line);font-size:13.5px}}
footer{{color:var(--mut);font-size:12px;margin-top:22px;border-top:1px solid var(--line);padding-top:12px}}
</style><div class="wrap">
<h1>Заключение по анализу организационных изменений</h1>
<p class="sub">Сопоставление: <b>{e(before[0].doc_id)}</b> → <b>{e(after[0].doc_id)}</b> ·
{datetime.date.today().isoformat()}</p>
<div class="kpi">
  <div><b>{len(findings)}</b><span>отклонений</span></div>
  <div><b>{n_crit}</b><span>критических</span></div>
  <div><b>{len(before)}</b><span>пунктов «до»</span></div>
  <div><b>{len(after)}</b><span>пунктов «после»</span></div>
</div>
{''.join(rows)}
<footer>Каждая цитата вырезана из исходного файла по символьным смещениям и проверена
на дословное вхождение. Выводы носят рекомендательный характер и требуют проверки
ответственным сотрудником.</footer></div></html>""")
    return path


def dump_json(findings, path):
    json.dump(findings, open(path, "w", encoding="utf-8"),
              ensure_ascii=False, indent=2)
    return path
