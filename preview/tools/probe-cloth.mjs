// Cloth in isolation: fish held still, tail beating, no force fed back.
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
// Neutralise feedback so we test the cloth alone.
loc.applyForceAtPoint = () => {};
loc.applyTorque = () => {};

const cmd = createMotorCommand();
cmd.frequency = 3;
const fins = buildFins(morph);
for (const f of fins) f.initialise(body, loc, 0.7);
const caudal = fins.find(f => f.spec.name === 'caudal');
const dt = FISH.dt;

function chordOf(fin) {
  const mid = Math.floor(fin.spec.rays / 2);
  const tip = (mid * fin.spec.along + fin.spec.along - 1) * 3;
  const root = (mid * fin.spec.along) * 3;
  return Math.hypot(fin.pos[tip]-fin.pos[root], fin.pos[tip+1]-fin.pos[root+1], fin.pos[tip+2]-fin.pos[root+2]);
}
// Max stretch of any ray link
function maxRayStrain(fin) {
  let worst = 0;
  for (let r = 0; r < fin.spec.rays; r++) {
    for (let j = 0; j + 1 < fin.spec.along; j++) {
      const a = (r*fin.spec.along + j)*3, b = (r*fin.spec.along + j + 1)*3;
      const d = Math.hypot(fin.pos[b]-fin.pos[a], fin.pos[b+1]-fin.pos[a+1], fin.pos[b+2]-fin.pos[a+2]);
      const rest = fin.spec.extent/(fin.spec.along-1);
      worst = Math.max(worst, Math.abs(d-rest)/rest);
    }
  }
  return worst;
}
for (let i = 0; i < 400; i++) {
  loc.step(cmd, null, null, dt);
  for (const f of fins) f.step(body, loc, null, 0.7, dt);
  if (i % 40 === 0) {
    console.log(`t=${(i*dt).toFixed(3)} chord=${(chordOf(caudal)*1000).toFixed(1)}mm rayStrain=${(maxRayStrain(caudal)*100).toFixed(1)}%`);
  }
}
