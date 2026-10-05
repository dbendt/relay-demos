# three.js (vendored)

three.js r169 (npm `three@0.169.0`), copied from jsDelivr on 5 October 2026 so the prototype runs offline:

- `three.module.min.js`: `build/three.module.min.js`
- `lines/`: `examples/jsm/lines/` (`Line2`, `LineSegments2`, `LineGeometry`, `LineSegmentsGeometry`, `LineMaterial`), for
  fat lines (aim lines in screen pixels; WebGL's own lines are one pixel wide)
- `LICENSE`: MIT

`app.html`'s import map points `three` and `three/addons/lines/` here. To upgrade, replace these files from the same
paths of a newer version and check that the line add-ons still import from `three`.
