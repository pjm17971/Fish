import { buildMorphology } from '../dist/sim/morphology.js';
import { FishBody, createMotorCommand } from '../dist/sim/fishBody.js';
import { createLocomotion } from '../dist/sim/locomotion.js';
import { buildFins } from '../dist/sim/fins.js';
import { FISH } from '../dist/sim/config.js';

function run(freq, keep) {
  const morph = buildMorphology();
  const body = new FishBody(morph);
  const loc = createLocomotion(morph, body);
  loc.bounds = null;
  const cmd = createMotorCommand();
  cmd.frequency = freq;
  const fins = buildFins(morph).filter(f => keep === 'all' || f.spec.name === keep);
  for (const f of fins) f.initialise(body, loc, 0.7);
  const dt = FISH.dt;
  const n = Math.round(12 / dt);
  const p0 = {...loc.position};
  for (let i = 0; i < n; i++) {
    loc.step(cmd, null, null, dt);
    for (const f of fins) f.step(body, loc, null, 0.7, dt);
  }
  const d = Math.hypot(loc.position.x-p0.x, loc.position.y-p0.y, loc.position.z-p0.z);
  return d/12/FISH.standardLength;
}
const sets = ['none','caudal','dorsal','anal','pelvicLeft','all'];
console.log('SL/s        ' + [0,1,3,5].map(f=>('f='+f).padStart(8)).join(''));
for (const k of sets) {
  const row = [0,1,3,5].map(f => run(f, k === 'none' ? '__none__' : k).toFixed(2).padStart(8)).join('');
  console.log(k.padEnd(12) + row);
}
