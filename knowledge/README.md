# Approved knowledge files

Source files for the agent's approved knowledge. Each `.md` file is one knowledge source; `manifest.json`
holds its metadata (source type, product, version, language).

```
npm run kb:import    # creates each file as a source in PENDING REVIEW (re-runnable; unchanged files are skipped)
```

Then review and approve each source in **Admin → Knowledge Sources**. Nothing reaches the agent before approval.

## Format

- `#` title, then one `##` heading per section. The chunker keeps each section in its own passage and uses
  the heading as the citation label.
- Procedure steps are one numbered line each (`1.`, `2.` …), so a procedure stays in one passage.
- Wording is kept as in the original leaflet. The ™ sign appears once per file (in the device name line)
  so that searches for the plain product name match.
- To update a document: edit the file (or add a new one with the new revision), run `kb:import`, and when
  approving set it to supersede the previous version.

## Contents

The English and Hebrew panels of the official IFU leaflets (`6_REGUM.pdf`, `6_MICROFOAM.pdf`,
`6_VETFOAM.pdf`, `6_VITALOC.pdf`). The PDFs have no text layer, so the text was transcribed from the
rendered pages.

Corrections made to the Hebrew VetFoam leaflet (LB92 H Rev06):
- The component table read "Empty syringe" next to the 800 mg powder syringe. Written as in the English version.
- The inhalation pictogram line named "vitaloc". Written without the product name.

Differences between the English and Hebrew versions, kept as printed:
- MicroFoam side effects: English says "any non-surgical procedure", Hebrew says "כל הליך רפואי".
- VetFoam step 19: only the Hebrew explains that the needle is held for ~30 seconds "to allow the crosslinking reaction".
