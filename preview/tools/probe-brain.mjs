import { World } from '../dist/sim/world.js';
// --- startle ---
{
  const w = new World({ seed: 52, timeScale: 1 });
  for (let i = 0; i < 300; i++) w.step(1/60);
  console.log('before startle:', w.brain.intention, 'fear', w.brain.drives.fear.toFixed(3));
  w.brain.startle(1.0, {x:0,y:0,z:1});
  w.step(1/60);
  console.log('after startle :', w.brain.intention, 'fear', w.brain.drives.fear.toFixed(3),
    'desires', Object.entries(w.brain.desires).map(([k,v])=>`${k}=${v.toFixed(2)}`).join(' '));
}
// --- feeding ---
{
  const w = new World({ seed: 41, timeScale: 1 });
  w.brain.drives.hunger = 0.9;
  for (let i = 0; i < 180; i++) w.step(1/60);
  const p = w.locomotion.position;
  w.feedAt(p.x, p.z);
  let sawStrike = false, ate = 0, minDist = 99;
  for (let i = 0; i < 3600; i++) {
    w.step(1/60);
    if (w.brain.intention === 'strike') sawStrike = true;
    if (w.brain.atePelletThisTick) ate++;
    if (w.brain.percepts.nearestFood) minDist = Math.min(minDist, w.brain.percepts.foodDistance);
  }
  console.log('feeding: sawStrike', sawStrike, 'ate', ate, 'minDist(mm)', (minDist*1000).toFixed(1),
    'hunger', w.brain.drives.hunger.toFixed(3), 'pellets left', w.food.activeCount);
}
// --- flare ---
{
  const w = new World({ seed: 61, timeScale: 45 });
  let maxAgg = 0, maxFlareDesire = 0, sawFlare = false, maxRival = 0;
  for (let i = 0; i < 60*90; i++) {
    w.stimuli.viewerPosition = {x:0,y:-0.05,z:0.12};
    w.step(1/60);
    maxAgg = Math.max(maxAgg, w.brain.drives.aggression);
    maxRival = Math.max(maxRival, w.brain.percepts.rivalVisible);
    maxFlareDesire = Math.max(maxFlareDesire, w.brain.desires.flare);
    if (w.brain.intention === 'flare') sawFlare = true;
  }
  console.log('flare: sawFlare', sawFlare, 'maxAggression', maxAgg.toFixed(3),
    'maxRivalVisible', maxRival.toFixed(3), 'maxFlareDesire', maxFlareDesire.toFixed(3));
}
