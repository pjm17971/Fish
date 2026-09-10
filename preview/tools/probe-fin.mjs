import { buildMorphology } from '../dist/sim/morphology.js';
import { FishBody, createMotorCommand } from '../dist/sim/fishBody.js';
import { createLocomotion } from '../dist/sim/locomotion.js';
import { buildFins } from '../dist/sim/fins.js';
import { FISH } from '../dist/sim/config.js';

const morph = buildMorphology();
const body = new FishBody(morph);
const loc = createLocomotion(morph, body);
loc.bounds = null;
  loc.bounds = null; // free water: no walls to swim into
const cmd = createMotorCommand();
cmd.frequency = 3;
const fins = buildFins(morph);
for (const f of fins) f.initialise(body, loc, 0.7);

const caudal = fins.find(f => f.spec.name === 'caudal');
const dt = FISH.dt;
const W = FISH.mass * 9.81;
console.log('fish weight N =', W.toExponential(3));
console.log('caudal: rays', caudal.spec.rays, 'along', caudal.spec.along,
  'massTissue tot', [...caudal.massTissue].reduce((a,b)=>a+b,0).toExponential(3),
  'massAdded tot', [...caudal.massAdded].reduce((a,b)=>a+b,0).toExponential(3));

for (let i = 0; i < 500; i++) {
  loc.step(cmd, null, null, dt);
  for (const f of fins) f.step(body, loc, null, 0.7, dt);
  if (i % 25 === 0) {
    const bf = caudal.bodyForce;
    // tip of the middle ray
    const mid = Math.floor(caudal.spec.rays/2);
    const tip = (mid*caudal.spec.along + caudal.spec.along - 1)*3;
    const root = (mid*caudal.spec.along)*3;
    const dxr = caudal.pos[tip]-caudal.pos[root], dyr = caudal.pos[tip+1]-caudal.pos[root+1], dzr = caudal.pos[tip+2]-caudal.pos[root+2];
    const chord = Math.hypot(dxr,dyr,dzr);
    console.log(`t=${(i*dt).toFixed(3)} U=${loc.forwardSpeed.toFixed(4)} `
      + `caudalF=(${bf.x.toExponential(2)},${bf.y.toExponential(2)},${bf.z.toExponential(2)}) |F|/W=${(Math.hypot(bf.x,bf.y,bf.z)/W).toFixed(1)} `
      + `chord=${(chord*1000).toFixed(1)}mm (rest ${(caudal.spec.extent*1000).toFixed(1)}mm)`);
  }
}
// per-fin contributions
for (const f of fins) {
  const bf = f.bodyForce;
  console.log(f.spec.name.padEnd(12), 'F/W =', (Math.hypot(bf.x,bf.y,bf.z)/W).toFixed(2));
}
