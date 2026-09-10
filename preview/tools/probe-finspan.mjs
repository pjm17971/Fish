import { World } from '../dist/sim/world.js';

const w = new World({ seed: 7, timeScale: 1 });
for (let i = 0; i < 400; i++) w.step(1 / 60);

const get = (p, i) => [p[i*3], p[i*3+1], p[i*3+2]];
const dist = (a, b) => Math.hypot(a[0]-b[0], a[1]-b[1], a[2]-b[2]);

for (const fin of w.fins) {
  const { rays, along, extent } = fin.spec;
  const p = fin.pos;
  // chord: root of a ray to its tip, measured on the middle ray
  let chordSum = 0, linkMin = 1e9, linkMax = 0;
  for (let r = 0; r < rays; r++) {
    chordSum += dist(get(p, r*along), get(p, r*along + along - 1));
    for (let j = 0; j + 1 < along; j++) {
      const d = dist(get(p, r*along+j), get(p, r*along+j+1));
      linkMin = Math.min(linkMin, d); linkMax = Math.max(linkMax, d);
    }
  }
  // span: first ray's tip to last ray's tip
  const span = dist(get(p, along - 1), get(p, (rays-1)*along + along - 1));
  console.log(
    `${String(fin.spec.name).padEnd(12)} rays=${rays} along=${along}  ` +
    `spec extent=${(extent*1000).toFixed(1)} mm  ` +
    `mean chord=${(chordSum/rays*1000).toFixed(1)} mm  span(tip-to-tip)=${(span*1000).toFixed(1)} mm  ` +
    `link ${(linkMin*1000).toFixed(2)}–${(linkMax*1000).toFixed(2)} mm`);
}
