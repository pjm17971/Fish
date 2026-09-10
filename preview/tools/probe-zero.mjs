import { buildMorphology } from '../dist/sim/morphology.js';
import { FishBody, createMotorCommand } from '../dist/sim/fishBody.js';
import { createLocomotion } from '../dist/sim/locomotion.js';
import { buildFins } from '../dist/sim/fins.js';
import { FISH } from '../dist/sim/config.js';

const morph = buildMorphology();
const body = new FishBody(morph);
const loc = createLocomotion(morph, body);
loc.bounds = null;
const cmd = createMotorCommand();
cmd.frequency = 0;
const fins = buildFins(morph).filter(f => f.spec.name === 'dorsal');
for (const f of fins) f.initialise(body, loc, 0.7);
const d = fins[0];
const W = FISH.mass*9.81;
const dt = FISH.dt;
// how far a free particle is from its driven neighbour, to see if the fin is ringing
function tipSpeed(f) {
  let m = 0;
  for (let i = 0; i < f.count; i++) {
    if (f.invMass[i] === 0) continue;
    m = Math.max(m, Math.hypot(f.vel[i*3], f.vel[i*3+1], f.vel[i*3+2]));
  }
  return m;
}
for (let i = 0; i < 1200; i++) {
  loc.step(cmd, null, null, dt);
  for (const f of fins) f.step(body, loc, null, 0.7, dt);
  if (i % 100 === 0) {
    const bf = d.bodyForceOut;
    console.log(`t=${(i*dt).toFixed(2)} fishSpeed=${loc.speed.toFixed(4)} finF/W=${(Math.hypot(bf.x,bf.y,bf.z)/W).toFixed(3)} `
      + `F=(${bf.x.toExponential(1)},${bf.y.toExponential(1)},${bf.z.toExponential(1)}) maxFinPartSpeed=${tipSpeed(d).toFixed(4)}`);
  }
}
