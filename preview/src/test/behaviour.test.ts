/**
 * Does the fish behave like an animal?
 *
 * Harder to test than the physics, because "looks alive" is not a number. What
 * can be tested is the structure that produces it: that decisions have
 * hysteresis so the fish does not dither, that internal drives really do build up
 * and get discharged, that the drive hierarchy holds under conflict, and that a
 * run is reproducible from its seed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { World } from '../sim/world.js';
import { Intention } from '../sim/brain.js';
import { TANK } from '../sim/config.js';
import { v3 } from '../sim/math.js';
import { Rng } from '../sim/rng.js';

/** Run the world for `seconds` at a fixed 60 fps, calling `onTick` each frame. */
function run(world: World, seconds: number, onTick?: (t: number) => void): void {
  const dt = 1 / 60;
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) {
    world.step(dt);
    onTick?.(i * dt);
  }
}

test('the fish stays inside the tank, always', () => {
  const world = new World({ seed: 11, timeScale: 40 });
  let worst = 0;
  run(world, 90, () => {
    const p = world.locomotion.position;
    worst = Math.max(
      worst,
      Math.abs(p.x) - TANK.width / 2,
      -p.z - TANK.depth,
      p.z,
      TANK.floorY - p.y,
      p.y - (TANK.waterY + 0.02),
    );
  });
  assert.ok(worst < 0.005, `the fish left the tank by ${(worst * 1000).toFixed(1)} mm`);
});

test('nothing in a long run goes non-finite', () => {
  const world = new World({ seed: 12, timeScale: 60 });
  // Seeded, not Math.random: a stability test that fails one run in twenty and
  // cannot be reproduced is worse than no test at all.
  const rng = new Rng(999);
  run(world, 90, () => {
    if (rng.next() < 0.01) world.feedAt(rng.sym(0.1), -0.1);
  });
  const p = world.locomotion.position;
  assert.ok(Number.isFinite(p.x + p.y + p.z), 'fish position went non-finite');
  assert.ok(Number.isFinite(world.locomotion.speed), 'fish speed went non-finite');
  for (let i = 0; i < world.water.height.length; i++) {
    assert.ok(Number.isFinite(world.water.height[i]), 'water surface went non-finite');
  }
  for (const fin of world.fins) {
    for (let i = 0; i < fin.pos.length; i++) {
      assert.ok(Number.isFinite(fin.pos[i]), `${fin.spec.name} fin went non-finite`);
    }
  }
});

test('the fish does not dither between intentions', () => {
  // A plain argmax over competing desires produces a fish that flickers between
  // two nearly equal options many times a second, which is the single most
  // recognisable tell of a simulated animal. The persistence bonus and the
  // minimum dwell time exist to stop it, and this is what they are for.
  const world = new World({ seed: 21, timeScale: 50 });

  const spans: { intention: Intention; duration: number; next: Intention }[] = [];
  let current: Intention = world.brain.intention;
  let started = 0;

  run(world, 150, (t) => {
    if (world.brain.intention !== current) {
      spans.push({ intention: current, duration: t - started, next: world.brain.intention });
      current = world.brain.intention;
      started = t;
    }
  });

  assert.ok(spans.length > 5, 'the fish never changed its mind at all');
  const mean = spans.reduce((a, b) => a + b.duration, 0) / spans.length;
  assert.ok(mean > 1.5, `mean intention lasted only ${mean.toFixed(2)} s; the fish is dithering`);

  // Anything shorter than the dwell floor must be a *reflex* pre-empting
  // something — a fish that starts to swerve round the glass and is startled
  // mid-swerve genuinely does abandon the swerve on the next frame, and should.
  // What must not happen is two ordinary intentions trading places rapidly,
  // which is the dithering this is here to catch.
  const shortOnes = spans.filter((s) => s.duration < 0.13);
  for (const s of shortOnes) {
    assert.ok(
      s.next === 'escape' || s.next === 'avoid',
      `'${s.intention}' lasted only ${s.duration.toFixed(3)} s and was replaced by ` +
        `'${s.next}', which is not a reflex — that is dithering`,
    );
  }
  assert.ok(
    shortOnes.length < spans.length * 0.12,
    `${shortOnes.length} of ${spans.length} intentions were cut short by a reflex; ` +
      `that is too many to be genuine startles`,
  );
});

test('the fish has to breathe, and does', () => {
  // The behaviour that most makes it read as an animal: an internal state with
  // no external cause, building up until it forces a trip to the surface.
  const world = new World({ seed: 31, timeScale: 260 });

  let gulps = 0;
  let sawHighAirDebt = false;
  const debtAtGulp: number[] = [];

  run(world, 120, () => {
    if (world.brain.drives.airDebt > 0.7) sawHighAirDebt = true;
    if (world.brain.gulpedThisTick) {
      gulps++;
      debtAtGulp.push(world.brain.drives.airDebt);
    }
  });

  assert.ok(sawHighAirDebt, 'air debt never built up');
  assert.ok(gulps >= 2, `the fish surfaced for air only ${gulps} times in a long simulated run`);
  // Every gulp must actually discharge the debt, or the drive is decorative.
  for (const d of debtAtGulp) {
    assert.ok(d < 0.05, `a gulp left the air debt at ${d.toFixed(2)}; it should reset to zero`);
  }
});

test('a gulp happens at the surface, not in mid-water', () => {
  const world = new World({ seed: 32, timeScale: 400 });
  let checked = 0;
  run(world, 100, () => {
    if (world.brain.gulpedThisTick) {
      const snout = world.snoutWorld(v3());
      const surfaceY = world.water.heightAt(snout.x, snout.z);
      assert.ok(
        snout.y > surfaceY - 0.008,
        `the fish gulped air ${((surfaceY - snout.y) * 1000).toFixed(1)} mm below the surface`,
      );
      checked++;
    }
  });
  assert.ok(checked > 0, 'the fish never surfaced, so nothing was checked');
});

test('a hungry fish finds and eats dropped food', () => {
  // Fed the way a person feeds a fish: a pinch dropped in, and another if the
  // first is missed. Not every strike succeeds — real fish miss constantly, and
  // the missing is a large part of what makes feeding look alive — so this
  // checks that the fish gets fed, not that it never misses.
  let fedIn = 0;
  const seeds = [41, 42, 43, 44, 45, 46];

  for (const seed of seeds) {
    const world = new World({ seed, timeScale: 1 });
    world.brain.drives.hunger = 0.9;
    const before = world.brain.drives.hunger;

    run(world, 3);
    for (let feed = 0; feed < 3; feed++) {
      const p = world.locomotion.position;
      world.feedAt(p.x, p.z);
      run(world, 30);
    }
    if (world.brain.drives.hunger < before - 0.05) fedIn++;
  }

  assert.ok(
    fedIn >= seeds.length - 1,
    `the fish only managed to feed in ${fedIn} of ${seeds.length} runs`,
  );
});

test('hunger rises on its own when there is nothing to eat', () => {
  const world = new World({ seed: 42, timeScale: 400 });
  world.brain.drives.hunger = 0.2;
  const before = world.brain.drives.hunger;
  run(world, 60);
  assert.ok(
    world.brain.drives.hunger > before,
    'a fish that has not eaten should get hungrier',
  );
});

test('a fish that badly needs air surfaces even when frightened', () => {
  // A real hierarchy, not a tie-break: a fish must breathe whether or not there
  // is a predator about.
  const world = new World({ seed: 51, timeScale: 1 });
  world.brain.drives.airDebt = 0.99;
  world.brain.drives.fear = 1.0;

  let sawSurface = false;
  run(world, 20, () => {
    if (world.brain.intention === 'surface') sawSurface = true;
  });
  assert.ok(sawSurface, 'a suffocating fish stayed frightened instead of going for air');
});

test('a startled fish escapes immediately, not after deliberating', () => {
  // Escape latency in real fish is 5 to 15 ms. The intention arbitration is
  // allowed to bypass its own dwell time for exactly this.
  const world = new World({ seed: 52, timeScale: 1 });
  run(world, 5);

  world.brain.startle(1.0, v3(0, 0, 1));
  world.step(1 / 60);
  assert.equal(world.brain.intention, 'escape', 'the fish did not react to being startled');
});

test('a face at the glass provokes a display, and the display tires the fish out', () => {
  // Both halves matter. A male betta flares at a rival; and because flaring is
  // hard work, the display self-limits rather than running forever.
  const world = new World({ seed: 61, timeScale: 45 });
  world.stimuli.viewerPosition = v3(0, -0.05, 0.12);

  let sawFlare = false;
  let peakFatigue = 0;
  run(world, 90, () => {
    // Hold the face still, so it reads as a rival rather than as a looming threat.
    world.stimuli.viewerPosition = v3(0, -0.05, 0.12);
    if (world.brain.intention === 'flare') sawFlare = true;
    peakFatigue = Math.max(peakFatigue, world.brain.drives.fatigue);
  });

  assert.ok(sawFlare, 'the fish ignored a face held at the glass');
  assert.ok(world.brain.intention !== 'flare', 'the fish flared indefinitely instead of tiring');
  assert.ok(peakFatigue > 0.05, 'displaying should be tiring');
});

test('the fish explores rather than sitting in one place', () => {
  // Novelty-seeking comes from a familiarity map that decays, so the fish drifts
  // towards places it has not been recently. There is no waypoint list.
  const world = new World({ seed: 71, timeScale: 60 });
  const visited = new Set<string>();
  run(world, 120, () => {
    const p = world.locomotion.position;
    const key = `${Math.floor((p.x + 0.175) / 0.06)},${Math.floor((p.z + 0.25) / 0.06)}`;
    visited.add(key);
  });
  assert.ok(visited.size >= 8, `the fish only visited ${visited.size} parts of the tank`);
});

test('a run is exactly reproducible from its seed', () => {
  // The whole point of the seeded generator. Without this a behaviour seen once
  // cannot be seen again, and the Swift port cannot be checked against this one.
  const runOnce = (): number[] => {
    const w = new World({ seed: 4242, timeScale: 20 });
    const trace: number[] = [];
    const dt = 1 / 60;
    for (let i = 0; i < 900; i++) {
      w.step(dt);
      if (i % 60 === 0) {
        trace.push(w.locomotion.position.x, w.locomotion.position.y, w.locomotion.position.z);
      }
    }
    return trace;
  };

  const a = runOnce();
  const b = runOnce();
  assert.deepEqual(a, b, 'two runs from the same seed diverged');
});

test('the fish keeps swimming even with every drive satisfied', () => {
  // patrol has a floor under it, so a completely contented fish still moves
  // about. A fish that stops dead when it has nothing to do looks broken.
  const world = new World({ seed: 81, timeScale: 1 });
  world.brain.drives.hunger = 0;
  world.brain.drives.airDebt = 0;
  world.brain.drives.fear = 0;
  world.brain.drives.fatigue = 0;
  world.brain.drives.aggression = 0;

  let moved = 0;
  const start = { ...world.locomotion.position };
  run(world, 30, () => {
    moved = Math.max(
      moved,
      Math.hypot(
        world.locomotion.position.x - start.x,
        world.locomotion.position.y - start.y,
        world.locomotion.position.z - start.z,
      ),
    );
  });
  assert.ok(moved > 0.05, `a contented fish moved only ${(moved * 1000).toFixed(0)} mm in thirty seconds`);
});

test('dropped food lands on the water and sinks only once it is soaked', () => {
  const world = new World({ seed: 91, timeScale: 1 });
  world.feedAt(0.05, -0.12);
  run(world, 2);

  const floating = world.food.pellets.filter((p) => p.alive && p.floating);
  assert.ok(floating.length > 0, 'freshly dropped pellets should float');
  for (const p of floating) {
    const surfaceY = world.water.heightAt(p.position.x, p.position.z);
    assert.ok(
      Math.abs(p.position.y - surfaceY) < 0.004,
      'a floating pellet should sit on the surface',
    );
  }
});
