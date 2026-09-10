import { buildMorphology } from '../dist/sim/morphology.js';
import { FishBody, createMotorCommand } from '../dist/sim/fishBody.js';
import { createLocomotion } from '../dist/sim/locomotion.js';
import { buildFins } from '../dist/sim/fins.js';
import { FISH } from '../dist/sim/config.js';

function run(freq, withFins) {
  const morph = buildMorphology();
  const body = new FishBody(morph);
  const loc = createLocomotion(morph, body);
  loc.bounds = null;
  const cmd = createMotorCommand();
  cmd.frequency = freq;
  const fins = withFins ? buildFins(morph) : [];
  for (const f of fins) f.initialise(body, loc, 0.7);
  const dt = FISH.dt;
  const n = Math.round(12 / dt);
  const p0 = {...loc.position};
  let printed = 0;
  for (let i = 0; i < n; i++) {
    loc.step(cmd, null, null, dt);
    for (const f of fins) f.step(body, loc, null, 0.7, dt);
    if (i % Math.round(n/6) === 0 && printed++ < 8) {
      console.log(`  t=${(i*dt).toFixed(2)} |v|=${loc.speed.toFixed(4)} fwd=${loc.forwardSpeed.toFixed(4)} |w|=${Math.hypot(loc.angularVelocity.x,loc.angularVelocity.y,loc.angularVelocity.z).toFixed(2)} pos=(${loc.position.x.toFixed(3)},${loc.position.y.toFixed(3)},${loc.position.z.toFixed(3)})`);
    }
  }
  const d = Math.hypot(loc.position.x-p0.x, loc.position.y-p0.y, loc.position.z-p0.z);
  console.log(`  => net displacement ${d.toFixed(4)} m in 12 s = ${(d/12).toFixed(4)} m/s mean  (${(d/12/FISH.standardLength).toFixed(2)} SL/s)`);
}
for (const f of [1,3,5]) {
  console.log(`--- f=${f} Hz, body only ---`); run(f, false);
  console.log(`--- f=${f} Hz, with fins ---`); run(f, true);
}
