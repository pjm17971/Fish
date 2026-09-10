import { WaterSurface } from '../dist/sim/water.js';
import { Rng } from '../dist/sim/rng.js';
const w = new WaterSurface();
const rng = new Rng(7);
for (let i = 0; i < 3000; i++) {
  w.setTankAcceleration(rng.sym(4), rng.sym(4));
  w.step(1/120);
  if (i % 40 === 0) w.disturb(rng.sym(0.15), -0.1 + rng.sym(0.1), rng.sym(0.5), 0.006);
  let peak = 0, bad = false, peakV = 0;
  for (let k = 0; k < w.height.length; k++) {
    if (!Number.isFinite(w.height[k])) { bad = true; break; }
    peak = Math.max(peak, Math.abs(w.height[k]));
    peakV = Math.max(peakV, Math.abs(w.vel[k]));
  }
  if (bad) { console.log(`NaN at step ${i} (t=${(i/120).toFixed(2)}s)`); break; }
  if (i % 100 === 0) console.log(`i=${i} peak|h|=${peak.toExponential(2)} peak|v|=${peakV.toExponential(2)}`);
}
