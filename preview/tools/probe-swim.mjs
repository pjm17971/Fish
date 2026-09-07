// Scratch probe: does the fish actually swim, and at what speed?
import { buildMorphology } from '../dist/sim/morphology.js';
import { FishBody, createMotorCommand } from '../dist/sim/fishBody.js';
import { createLocomotion } from '../dist/sim/locomotion.js';
import { buildFins } from '../dist/sim/fins.js';
import { FISH } from '../dist/sim/config.js';

function run(freq, seconds = 16, withFins = true) {
  const morph = buildMorphology();
  const body = new FishBody(morph);
  const loc = createLocomotion(morph, body);
  loc.bounds = null; // free water: no walls to swim into
  const cmd = createMotorCommand();
  cmd.frequency = freq;
  cmd.amplitude = FISH.standardLength * FISH.tailAmplitudeRatio;
  const fins = withFins ? buildFins(morph) : [];
  for (const f of fins) f.initialise(body, loc, 0.7);

  const dt = FISH.dt;
  const n = Math.round(seconds / dt);
  let sum = 0, count = 0;
  for (let i = 0; i < n; i++) {
    loc.step(cmd, null, null, dt);
    for (const f of fins) f.step(body, loc, null, 0.7, dt);
    if (i > n * 0.65) { sum += loc.forwardSpeed; count++; }
  }
  const U = sum / count;
  const App = 2 * FISH.standardLength * FISH.tailAmplitudeRatio;
  return { freq, U, SLps: U / FISH.standardLength, St: (freq * App) / Math.abs(U), stride: U / (freq * FISH.standardLength) };
}

const morph = buildMorphology();
console.log('body mass', morph.totalMass.toExponential(3), 'kg  volume', morph.volume.toExponential(3), 'm^3');
console.log('added mass [surge,sway,heave] kg:', morph.addedMass.map(x=>x.toExponential(2)).join(', '));
console.log('  as multiples of body mass:', morph.addedMass.map(x=>(x/morph.totalMass).toFixed(2)).join(', '));
console.log('inertia [roll,pitch,yaw]:', morph.inertia.map(x=>x.toExponential(2)).join(', '));
console.log('added inertia:', morph.addedInertia.map(x=>x.toExponential(2)).join(', '));
console.log('');
for (const f of [1,2,3,4,5,6]) {
  const r = run(f);
  console.log(`WITH FINS f=${r.freq}Hz  U=${r.U.toFixed(4)} m/s  ${r.SLps.toFixed(2)} SL/s  St=${r.St.toFixed(3)}  stride=${r.stride.toFixed(3)} SL/beat`);
}
