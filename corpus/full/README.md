# Full organizer examples

These are full Google Docs Markdown exports retrieved on 2026-09-23:

- `rev8.md`: internal-audit regulation edition 8, approved 2021-06-25.
  [Source](https://docs.google.com/document/d/1X2tNOF9_ZF2ms0Fnx1mWrUaAoMLHabTu/edit)
- `rev9.md`: internal-audit regulation edition 9, approved 2022-12-23.
  [Source](https://docs.google.com/document/d/1FUh7Ld40xk-gwXMdj5-_3-p-cYeIl2hu/edit)

The exports are preserved verbatim. They are not original .docx binaries and do not
prove Word metadata or page-layout assertions from the friend's planning notes.
The original team's `corpus/rev8.txt` and `corpus/rev9.txt` are separate excerpts;
its golden dataset is not promoted to ground truth for these complete documents.

Hand-checked expectations used by `tests/extraction.test.ts`:

| Case | Source anchor | Expected distinction |
| --- | --- | --- |
| Composition | 3.4, both editions | two vs four named departments, plus containing BVA block |
| Repeated roles | 3.6-3.9, edition 9 | four separate project-director positions |
| Data-center title | 3.6, edition 9 | a position does not by itself establish a structural unit |
| Dual reporting | 1.5-1.6 | functional board line and administrative president line |
| Functional supervision | 3.6 and 3.8, edition 8 | audit manager stays in DKKM while reporting functionally elsewhere |
| Renumbering | old 5.4.5 -> new 5.4.4 | essentially unchanged consulting clause |
| Candidate redistribution | old 5.4.4 -> new 5.3.3 | assurance-coordination wording appears under different role headings |
| Contextual prohibition | 5.8 -> 5.8.1 | prohibition is inherited; qualifications must survive |
| Glued clauses | 3.10-3.12 and 10-14 | real boundaries differ from paragraphs |

Candidate redistribution is not a declared legal succession or proof of total
coverage. Full semantic precision/recall has not been established. Local extraction
is deliberately incomplete: unowned functions and unresolved references are visible.
