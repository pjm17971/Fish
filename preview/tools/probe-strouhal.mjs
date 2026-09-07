import { buildMorphology } from '../dist/sim/morphology.js';
import { FishBody, createMotorCommand } from '../dist/sim/fishBody.js';
import { createLocomotion } from '../dist/sim/locomotion.js';
import { FISH } from '../dist/sim/config.js';

function run(freq, seconds = 18) {
  const morph = buildMorphology();
  const body = new FishBody(morph);
  const loc = createLocomotion(morph, body);
  loc.bounds = null;
  const cmd = createMotorCommand();
  cmd.frequency = freq;
  const dt = FISH.dt;
  const n = Math.round(seconds / dt);
  let sum = 0, cnt = 0, exc = 0;
  for (let i = 0; i < n; i++) {
    loc.step(cmd, null, null, dt);
    if (i > n * 0.65) { sum += loc.forwardSpeed; cnt++; exc = Math.max(exc, body.tailExcursion); }
  }
  const U = sum / cnt;
  const App = 2 * exc; // measured, not assumed
  return { U, App, SLps: U / FISH.standardLength, St: (freq * App) / U, stride: U / (freq * FISH.standardLength) };
}
console.log('freq   U (m/s)   SL/s   tail A_pp (mm)  A_pp/SL   Strouhal   stride (SL/beat)');
const xs = [], ys = [];
for (const f of [1,2,3,4,5,6,7]) {
  const r = run(f);
  xs.push(f); ys.push(r.U);
  console.log(`${f}Hz    ${r.U.toFixed(4)}   ${r.SLps.toFixed(2)}    ${(r.App*1000).toFixed(2)}          ${(r.App/FISH.standardLength).toFixed(3)}     ${r.St.toFixed(3)}      ${r.stride.toFixed(3)}`);
}
// linearity
const n=xs.length, sx=xs.reduce((a,b)=>a+b,0), sy=ys.reduce((a,b)=>a+b,0);
const sxx=xs.reduce((a,b)=>a+b*b,0), sxy=xs.reduce((a,b,i)=>a+b*ys[i],0);
const m=(n*sxy-sx*sy)/(n*sxx-sx*sx), c=(sy-m*sx)/n;
const ssTot=ys.reduce((a,y)=>a+(y-sy/n)**2,0), ssRes=ys.reduce((a,y,i)=>a+(y-(m*xs[i]+c))**2,0);
console.log(`\nlinear fit U = ${m.toFixed(5)}*f + ${c.toFixed(5)}   R^2 = ${(1-ssRes/ssTot).toFixed(5)}`);
