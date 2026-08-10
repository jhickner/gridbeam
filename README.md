# gridbeam

A browser-based 3D editor for Grid Beam furniture — 1.5" square beams drilled
on a 1.5" hole lattice and bolted together. Design a piece, and it generates
the cut list, sheet-packing diagrams and hardware count needed to build it.

Everything is in inches and snapped to the 1.5" grid.

## Features

- Beams (3"–120" in 1.5" steps) on three axes, with optional ±45° tilt
- Peaks — two rafters solved as a linked pair so the apex joint stays valid
  when either rafter's length or foot changes
- Panels in five materials: plywood, hardboard pegboard, aluminium pegboard,
  black aluminium pegboard, and wood
- Pegboard holes and clipped corners modelled in the actual geometry
- Fixtures for scale: crib mattress, single mattress, open 13" MacBook Pro, and
  HDX tough totes in 27 gal, 7 gal and 6.5 qt at their published exterior sizes
- Procedurally generated book rows for shelving
- Bolted connections inferred automatically from hole alignment — no manual
  joining
- Minimal-hole mode: drill only the holes a joint actually needs, with
  per-beam drilling instructions measured from each end
- Grouping, group rotation about Y, multi-select, marquee select, undo/redo
- Select exactly two objects to measure between them — center-to-center offset
  and clear gap on each axis, shown in the sidebar and on the model
- Build plan export: beam cut list, 1D stock packing, 2D guillotine packing of
  panels onto 4'×8' sheets with SVG cut diagrams, hardware count and cost
- Construction plan: a numbered, illustrated assembly order derived from the
  bolted connections — one rendered diagram per step showing the piece so far
  with the part being added highlighted, on a fixed camera
- Parts are lettered (A, B, C…) with identical parts sharing a letter, and the
  same letters run through the cut list, drilling instructions and steps
- The whole plan prints black on white, diagrams included
- Named projects stored in the browser, with whole-store backup and restore
- Import gallery: preview any number of saved JSON files as 3D thumbnails
  before choosing which to import
- Wireframe dome environments to design against

## Keys

Keys act on the current selection unless noted.

| Key | Action |
| --- | --- |
| `R` | Single object: cycle orientation (beams step through axes and ±45° tilts). Multiple: rotate 90° about the selection centroid |
| `T` / `Shift+T` | Rotate a group ±5° about Y |
| `A` / `Z` | Raise / lower by 1.5" |
| `S` | Drop onto the surface below (top of the nearest overlapping part, or the ground) |
| `←` `→` `↑` `↓` | Nudge by 1.5" on the ground plane |
| `Shift`+arrow | Grow the selection in that direction; the opposite edge stays put |
| `[` / `]` | Shrink / grow — beam length, or panel width and height |
| `Tab` / `Shift+Tab` | Cycle through beams of the same length |
| `Delete` / `Backspace` | Delete. Deleting one peak rafter removes its partner |
| `Esc` | Deselect |
| `Cmd/Ctrl+Z` | Undo |
| `Shift+Cmd/Ctrl+Z` | Redo |
| `Cmd/Ctrl+A` | Select all |
| `Cmd/Ctrl+C` / `V` | Copy / paste |
| `Cmd/Ctrl+G` | Group |
| `Shift+Cmd/Ctrl+G` | Ungroup |

## Mouse

| Action | Effect |
| --- | --- |
| Drag empty space | Orbit, or marquee-select in Select mode |
| Drag an object | Move the selection on the ground plane |
| `Shift`+drag an object | Lock movement to the dominant axis |
| Click | Select the object and its group |
| `Shift`+click | Add / remove from the selection |
| `Shift`+click a selected group | Rotate the group by dragging |
| `Alt`+drag | Marquee-select regardless of mode |
| `Shift+Alt`+drag | Add the marquee to the selection |

## Toolbar

| Control | Effect |
| --- | --- |
| Orbit / Select | Whether dragging empty space orbits or marquee-selects |
| type + `+` | Add a beam, panel, peak, fixture, seforim row |
| Projects ▾ | New, open, rename, delete, Save As, per-project export, whole-store backup / restore |
| Import… | Preview JSON files as thumbnails and pick which to import |
| Export Plan | Open the build plan in a new window |
| Minimal Holes | Drill only the holes connections need |
| Clipped Corners | Remove a 3/4" triangle from each panel corner |
| Panels 50% / 100% | Panel transparency |
| Environment | None, 30' dome + 1' stem wall + 7'6" loft, or 16' dome |

## Storage

Projects live in `localStorage`, one key per project (`gridbeam.project.v1.<name>`)
plus an index at `gridbeam.projects.v1`. The active project autosaves, camera
included. Nothing is uploaded and there is no server.

Use **Projects ▾ → Back up all…** to write every project to a single JSON file,
and **Restore…** to read one back — either merged alongside what's there, or
replacing the store entirely. Browsers cap `localStorage` at roughly 5 MB; a
save that fails will say so.

## Run

No build step and no dependencies to install.

```sh
./run.sh
```

Serves the directory on port 8000 (override with `PORT`) and opens a browser.
Any static file server works — it must be served over HTTP, since ES modules
and import maps do not load from `file://`.

three.js r160 is loaded from unpkg via an import map, so the first load needs
network access.

## Notes

- The standalone gallery at `viewer.html` browses JSON files without touching
  the editor's stored projects.
- Sheet and lumber prices in the build plan are hardcoded in `src/bom.js`
  (`SHEET_PRICES`) and `src/exportView.js`, and were current where and when
  they were entered.

## License

MIT — see [LICENSE](LICENSE).
