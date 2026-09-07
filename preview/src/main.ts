/**
 * The desktop preview.
 *
 * This is not the product — the product is the iOS app. This exists so the
 * simulation and the look can be judged, adjusted and argued about without a
 * build-and-deploy cycle to a phone in between, and so the fish's internal state
 * can be watched directly rather than inferred from what it happens to be doing.
 *
 * It runs exactly the same simulation code the phone runs.
 */

import { World } from './sim/world.js';
import { Renderer, CameraState } from './render/renderer.js';
import { TANK } from './sim/config.js';
import { v3 } from './sim/math.js';
import { ALL_INTENTIONS } from './sim/brain.js';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLDivElement;
const help = document.getElementById('help') as HTMLDivElement;

const world = new World({ seed: 0x5eed1234, timeScale: 1 });
const renderer = new Renderer(canvas, world);

const camera: CameraState = {
  yaw: 0,
  pitch: 0.12,
  distance: 0.42,
  target: v3(0, TANK.floorY + 0.05, -TANK.depth * 0.5),
};

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

let dragging = false;
let lastX = 0;
let lastY = 0;

canvas.addEventListener('pointerdown', (e) => {
  dragging = true;
  lastX = e.clientX;
  lastY = e.clientY;
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener('pointerup', (e) => {
  dragging = false;
  canvas.releasePointerCapture(e.pointerId);
});

canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const dx = e.clientX - lastX;
  const dy = e.clientY - lastY;
  lastX = e.clientX;
  lastY = e.clientY;
  camera.yaw -= dx * 0.005;
  // Stop just short of straight up or down, where the look-at basis degenerates.
  camera.pitch = Math.max(-1.2, Math.min(1.2, camera.pitch + dy * 0.005));
});

canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    camera.distance = Math.max(0.12, Math.min(1.2, camera.distance * Math.exp(e.deltaY * 0.001)));
  },
  { passive: false },
);

/**
 * Double click to feed — the preview's stand-in for the phone's double tap.
 *
 * The click is unprojected to the water surface, so food lands where you aimed
 * it. Clicking somewhere that is not water drops nothing; the gesture is
 * dropping something into a tank, not a button that spawns food.
 */
canvas.addEventListener('dblclick', (e) => {
  const hit = renderer.pickWater(e.clientX, e.clientY, camera);
  if (hit) {
    world.feedAt(hit.x, hit.z);
    flash('fed');
  } else {
    flash('that is not water');
  }
});

/**
 * Moving the mouse near the glass stands in for the phone's front camera seeing
 * your face. It is worth trying: hold still close to the glass and the fish will
 * come and look at you, then flare at you.
 */
canvas.addEventListener('pointermove', (e) => {
  const rect = canvas.getBoundingClientRect();
  const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  const ny = 1 - ((e.clientY - rect.top) / rect.height) * 2;
  world.stimuli.viewerPosition = v3(nx * 0.12, TANK.floorY + 0.05 + ny * 0.06, 0.10);
});

canvas.addEventListener('pointerleave', () => {
  world.stimuli.viewerPosition = null;
});

let showHud = true;
let paused = false;
let timeScale = 1;

window.addEventListener('keydown', (e) => {
  switch (e.key) {
    case 'h':
      showHud = !showHud;
      hud.style.display = showHud ? '' : 'none';
      break;
    case ' ':
      paused = !paused;
      flash(paused ? 'paused' : 'running');
      e.preventDefault();
      break;
    case 'f':
      // Feed at the middle of the tank, for when aiming is a nuisance.
      world.feedAt(0, -TANK.depth * 0.5);
      flash('fed');
      break;
    case 't': {
      // Cycle the physiological clock. Hunger really does take six hours to
      // build; watching that in real time is not a good use of an afternoon.
      const rates = [1, 30, 120, 600];
      timeScale = rates[(rates.indexOf(timeScale) + 1) % rates.length];
      (world.config as { timeScale: number }).timeScale = timeScale;
      flash(`physiology at ${timeScale}x`);
      break;
    }
    case 's':
      world.brain.startle(1, v3(0, 0, 1));
      flash('startled');
      break;
    case '?':
      help.style.display = help.style.display === 'none' ? '' : 'none';
      break;
    default:
      break;
  }
});

let flashText = '';
let flashUntil = 0;
function flash(text: string): void {
  flashText = text;
  flashUntil = performance.now() + 1400;
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

let last = performance.now();
let frameTimeAvg = 16;
let simTimeAvg = 0;

function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  if (!paused) {
    const t0 = performance.now();
    world.step(dt);
    simTimeAvg += (performance.now() - t0 - simTimeAvg) * 0.05;
  }

  renderer.render(camera, world.time);

  frameTimeAvg += ((now - last + dt * 1000) - frameTimeAvg) * 0.05;
  updateHud(now);
  requestAnimationFrame(frame);
}

function bar(value: number, width = 14): string {
  const filled = Math.round(Math.max(0, Math.min(1, value)) * width);
  return '█'.repeat(filled) + '·'.repeat(width - filled);
}

function updateHud(now: number): void {
  if (!showHud) return;
  const d = world.brain.drives;
  const b = world.brain;

  // The intention list, with the winner marked. Seeing *why* the fish chose what
  // it chose is most of the value of having a debug view at all.
  const desires = ALL_INTENTIONS.map((i) => {
    const v = b.desires[i];
    const mark = i === b.intention ? '▸' : ' ';
    return `${mark} ${i.padEnd(8)} ${bar(v, 10)} ${v.toFixed(2)}`;
  }).join('\n');

  const rows = [
    `hunger     ${bar(d.hunger)} ${(d.hunger * 100).toFixed(0)}%`,
    `air debt   ${bar(d.airDebt)} ${(d.airDebt * 100).toFixed(0)}%`,
    `fear       ${bar(d.fear)} ${(d.fear * 100).toFixed(0)}%`,
    `fatigue    ${bar(d.fatigue)} ${(d.fatigue * 100).toFixed(0)}%`,
    `aggression ${bar(d.aggression)} ${(d.aggression * 100).toFixed(0)}%`,
    `boredom    ${bar(d.boredom)} ${(d.boredom * 100).toFixed(0)}%`,
  ].join('\n');

  const motor = [
    `speed      ${world.speedSL.toFixed(2)} SL/s`,
    `tail beat  ${world.command.frequency.toFixed(2)} Hz`,
    `bend       ${world.command.bend >= 0 ? ' ' : ''}${world.command.bend.toFixed(2)}`,
    `pitch      ${world.command.pitchBend >= 0 ? ' ' : ''}${world.command.pitchBend.toFixed(2)}`,
    `fins       ${bar(world.command.finSpread, 8)}`,
    `gills      ${bar(world.command.gillFlare, 8)}`,
  ].join('\n');

  const flashLine = now < flashUntil ? `\n\n→ ${flashText}` : '';

  hud.textContent =
    `${world.time.toFixed(1)} s   physiology ${timeScale}x   ` +
    `sim ${simTimeAvg.toFixed(1)} ms/frame   food ${world.food.activeCount}\n` +
    `\nDRIVES\n${rows}\n\nINTENTIONS\n${desires}\n\nMOTOR\n${motor}${flashLine}`;
}

// A debug handle. The preview exists to be poked at — from the browser console,
// or by a script driving the page — and without a way in, every question about
// what the simulation is doing has to be answered by squinting at pixels.
(window as unknown as { aquarium: unknown }).aquarium = { world, renderer, camera };

// A short delay before the first frame lets the fin sheets settle from their
// straight starting pose, so the first thing you see is a fish rather than a
// fish with its fins sticking out like a paper aeroplane.
for (let i = 0; i < 30; i++) world.step(1 / 60);

requestAnimationFrame(frame);
