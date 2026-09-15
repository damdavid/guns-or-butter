# Sources

`docs/MECHANICS-SPEC.md` is reconstructed from the four sources below. None of them are
committed to this repository — they are copyrighted and not ours to redistribute — so
fetch them here if you want to check the spec's citations.

| Source | Where | Spec references |
|---|---|---|
| Original 30pp manual (`gb-manual.pdf`) | [lucasabandonware mirror](http://lucasabandonware.free.fr/manuels/The%20Global%20Dilemma%20-%20Guns%20or%20Butter.pdf) | Appendix A (production internals), Appendix B (combat numbers, the 342 t crossover), Appendix D "A Weird Appendix" (Crawford's design derivation), and the Production Summary screenshot on p.12 that anchors §8.1 |
| *Chris Crawford on Game Design* (2006), ch. 24 | [flylib](https://flylib.com/books/en/2.178.1.166/), or buy the book — it is still in print | World generation, economy rationale, combat, and the postmortem quoted in §6.3 and §9 |
| The 1990 DOS build | [Internet Archive](https://archive.org/details/msdos_The_Global_Dilemma_-_Guns_or_Butter_1990) | Commodity names and UI strings lifted from `G&B.EXE`; the source of every in-game measurement in §2.2 |
| Crawford's source-code library | [erasmatazz.com](https://www.erasmatazz.com/library/source-code/index.html) | Confirms no source exists for this title — he notes he does not think he has anything on it |

The measurement files in this directory are original readings taken from that build,
not material from any of the sources above. `gb_resources.xlsx` is the working
workbook and `gb_resources.txt` a pipe-delimited export of it; the two CSVs are the
canonical form and the only one the tooling reads. They are the basis for every productivity
parameter in `src/calibration.ts`.

To reproduce the §2.2 terrain measurements yourself, run the DOS build under
[js-dos](https://js-dos.com) or DOSBox and read `Factory Size` off the factory screens.

Note on the p.12 screenshot: extract it at 600 DPI or the Production Summary figures
are not legible. Every number in §8.1 came from that one page.
