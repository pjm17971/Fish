/**
 * The rest of the physics, checked against results that can be worked out on
 * paper independently of the code.
 *
 * The point of every test here is that the expected value comes from somewhere
 * other than a previous run of the simulation. A test that asserts the code
 * still does what it did last week catches regressions; it does not tell you the
 * model is right.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildMorphology } from '../sim/morphology.js';
import { WaterSurface, BulkFlow } from '../sim/water.js';
import { FoodSystem, analyticTerminalSinkSpeed } from '../sim/food.js';
import { Rng } from '../sim/rng.js';
import { v3 } from '../sim/math.js';
import { GRAVITY, RHO_WATER, TANK, WATER, WATER_DEPTH } from '../sim/config.js';

// ---------------------------------------------------------------------------
// Water
// ---------------------------------------------------------------------------

test('the tank sloshes at the period a tank this size really has', () => {
  // The fundamental sloshing period of a rectangular tank of length W and depth
  // h is T = 2W / sqrt(g*h) — a standard shallow-water result. Nothing in the
  // water code is tuned to reproduce it; it comes out because the wave speed
  // used is sqrt(g*h) rather than a number picked to look right.
  const expected = (2 * TANK.width) / Math.sqrt(GRAVITY * WATER_DEPTH);

  const water = new WaterSurface(WATER.nx, WATER.nz, false);
  // Tip the tank briefly to set the fundamental mode going, then let it ring.
  water.setTankAcceleration(1.2, 0);
  for (let i = 0; i < 200; i++) water.step(1 / 240);
  water.setTankAcceleration(0, 0);

  // Watch the surface height near one end and time the zero crossings.
  const probe = water.index(4, Math.floor(water.nz / 2));
  const crossings: number[] = [];
  let prev = water.height[probe];
  let t = 0;
  const dt = 1 / 240;
  for (let i = 0; i < 4000 && crossings.length < 6; i++) {
    water.step(dt);
    t += dt;
    const h = water.height[probe];
    if (prev <= 0 && h > 0) crossings.push(t);
    prev = h;
  }

  assert.ok(crossings.length >= 3, 'the surface did not oscillate at all');
  let sum = 0;
  for (let i = 1; i < crossings.length; i++) sum += crossings[i] - crossings[i - 1];
  const measured = sum / (crossings.length - 1);

  const error = Math.abs(measured - expected) / expected;
  assert.ok(
    error < 0.2,
    `sloshing period is ${measured.toFixed(3)} s, theory says ${expected.toFixed(3)} s (${(error * 100).toFixed(1)}% out)`,
  );
});

test('the water surface stays bounded under continuous shaking', () => {
  // An explicit wave equation is only conditionally stable, so this is really a
  // check that the CFL condition holds for the grid actually built rather than
  // for the one the spec describes.
  const water = new WaterSurface(WATER.nx, WATER.nz, false);
  const rng = new Rng(7);
  for (let i = 0; i < 3000; i++) {
    water.setTankAcceleration(rng.sym(4), rng.sym(4));
    water.step(1 / 120);
    if (i % 40 === 0) water.disturb(rng.sym(0.15), -0.1 + rng.sym(0.1), rng.sym(0.5), 0.006);
  }
  let peak = 0;
  for (let i = 0; i < water.height.length; i++) {
    assert.ok(Number.isFinite(water.height[i]), 'the water surface produced a non-finite height');
    peak = Math.max(peak, Math.abs(water.height[i]));
  }
  assert.ok(peak < WATER_DEPTH, `surface displacement reached ${peak.toFixed(3)} m, more than the water is deep`);
});

test('still water stays still', () => {
  const water = new WaterSurface(WATER.nx, WATER.nz, false);
  for (let i = 0; i < 2000; i++) water.step(1 / 120);
  let peak = 0;
  for (let i = 0; i < water.height.length; i++) peak = Math.max(peak, Math.abs(water.height[i]));
  assert.ok(peak < 1e-9, `undisturbed water drifted by ${peak.toExponential(2)} m`);
});

test('a disturbance dies away rather than ringing forever', () => {
  const water = new WaterSurface(WATER.nx, WATER.nz, false);
  water.disturb(0, -0.12, 0.4, 0.01);
  for (let i = 0; i < 120; i++) water.step(1 / 120);
  let early = 0;
  for (let i = 0; i < water.height.length; i++) early = Math.max(early, Math.abs(water.height[i]));

  for (let i = 0; i < 1200; i++) water.step(1 / 120);
  let late = 0;
  for (let i = 0; i < water.height.length; i++) late = Math.max(late, Math.abs(water.height[i]));

  assert.ok(late < early * 0.2, `ripples barely decayed: ${early.toExponential(2)} -> ${late.toExponential(2)}`);
});

test('the filter outlet keeps a millimetre of ripple going, and no more', () => {
  // The tank is never still: the filter's return stream keeps a patch of small
  // ripples going at the outlet, and those ripples are most of what makes the
  // water visible. The source is continuous, so two things have to be true of
  // it: the ripples must settle at about a millimetre rather than growing, and
  // nothing may go non-finite over a long run with the source on.
  const water = new WaterSurface();
  let peak = 0;
  for (let i = 0; i < 40 * 60; i++) {
    water.step(1 / 60);
    if (i > 5 * 60) {
      for (let k = 0; k < water.height.length; k++) {
        const h = Math.abs(water.height[k]);
        assert.ok(Number.isFinite(h), 'the surface went non-finite with the outlet running');
        if (h > peak) peak = h;
      }
    }
  }
  assert.ok(peak > 0.0002, `the outlet barely moved the surface: ${(peak * 1000).toFixed(2)} mm peak`);
  assert.ok(peak < 0.003, `the outlet ripple grew to ${(peak * 1000).toFixed(2)} mm; a filter return makes about one`);
});

test('the bulk flow field is divergence free', () => {
  // Flow with divergence makes suspended particles bunch up and thin out, and
  // the eye reads that as wrong immediately even when it cannot say why. Taking
  // the curl of a potential guarantees this exactly; the test confirms the
  // implementation actually does that.
  const flow = new BulkFlow(1234);
  flow.step(3.7);
  // Test the analytic field, which is what carries the guarantee. `sample`
  // trilinearly interpolates a cached copy of it, and interpolation of a
  // divergence-free field is only divergence-free to second order in the cell
  // size — a real and accepted approximation, but not the thing being asserted
  // here.
  const rng = new Rng(99);
  const e = 1e-4;
  const a = v3();
  const b = v3();

  let worst = 0;
  for (let i = 0; i < 200; i++) {
    const x = rng.range(-0.15, 0.15);
    const y = rng.range(TANK.floorY + 0.01, TANK.waterY - 0.01);
    const z = rng.range(-0.24, -0.01);

    flow.evaluate(x + e, y, z, a);
    flow.evaluate(x - e, y, z, b);
    const dvxdx = (a.x - b.x) / (2 * e);
    flow.evaluate(x, y + e, z, a);
    flow.evaluate(x, y - e, z, b);
    const dvydy = (a.y - b.y) / (2 * e);
    flow.evaluate(x, y, z + e, a);
    flow.evaluate(x, y, z - e, b);
    const dvzdz = (a.z - b.z) / (2 * e);

    // Compare against the local velocity scale, since an absolute tolerance
    // would be meaningless for a field this slow.
    flow.evaluate(x, y, z, a);
    const scale = Math.max(1e-4, Math.hypot(a.x, a.y, a.z));
    worst = Math.max(worst, Math.abs(dvxdx + dvydy + dvzdz) / (scale / 0.01));
  }
  assert.ok(worst < 0.25, `flow divergence is ${worst.toFixed(3)} relative to the local velocity scale`);
});

// ---------------------------------------------------------------------------
// Food
// ---------------------------------------------------------------------------

test('a waterlogged pellet sinks at its analytic terminal speed', () => {
  // The expected value comes from balancing net weight against Schiller-Naumann
  // drag and solving for speed — worked out in food.ts independently of the
  // integrator being tested here.
  const expected = analyticTerminalSinkSpeed();
  assert.ok(expected > 0.01 && expected < 0.2, `analytic terminal speed looks wrong: ${expected}`);

  const water = new WaterSurface(WATER.nx, WATER.nz, false);
  const flow = new BulkFlow(1);
  const food = new FoodSystem(42);
  food.drop(0, -0.12);
  // Run past the surface phase so the pellet is fully saturated and sinking.
  for (let i = 0; i < 400; i++) food.step(water, flow, 1 / 120);
  const pellet = food.pellets.find((p) => p.alive);
  assert.ok(pellet, 'no pellet was created');

  // Age the pellet past its soaking time constant so it is genuinely saturated.
  //
  // Setting the density directly does not work — `step` recomputes it from the
  // pellet's age every frame, so a pellet forced to 1080 kg/m^3 is quietly reset
  // to 676 and measured *rising* instead of sinking. Taking the absolute value
  // of the velocity then hides the sign error and leaves a number that is simply
  // the wrong answer to a different question.
  pellet!.age = 250; // several soak time constants
  pellet!.floating = false;
  pellet!.position.y = TANK.waterY - 0.04;
  for (let i = 0; i < 900; i++) {
    // Keep it off the floor so we measure free fall, not a pellet at rest, and
    // hold the age steady so it does not decay away mid-measurement.
    pellet!.age = 250;
    if (pellet!.position.y < TANK.floorY + 0.02) pellet!.position.y = TANK.waterY - 0.04;
    food.step(water, flow, 1 / 480);
  }
  assert.ok(pellet!.density > RHO_WATER, 'the pellet under test should be denser than water');
  const measured = Math.abs(pellet!.velocity.y);
  const error = Math.abs(measured - expected) / expected;
  assert.ok(
    error < 0.15,
    `pellet sinks at ${measured.toFixed(4)} m/s, analytic balance says ${expected.toFixed(4)} m/s`,
  );
});

test('a fresh pellet floats and a soaked one sinks', () => {
  const water = new WaterSurface(WATER.nx, WATER.nz, false);
  const flow = new BulkFlow(1);
  const food = new FoodSystem(7);
  food.drop(0, -0.12);
  for (let i = 0; i < 60; i++) food.step(water, flow, 1 / 120);

  const pellet = food.pellets.find((p) => p.alive)!;
  assert.ok(pellet.floating, 'a dry pellet should float — betta pellets do');
  const surfaceY = water.heightAt(pellet.position.x, pellet.position.z);
  assert.ok(
    Math.abs(pellet.position.y - surfaceY) < 0.004,
    'a floating pellet should sit on the surface',
  );

  // Long enough to waterlog.
  for (let i = 0; i < Math.round(180 * 120); i++) food.step(water, flow, 1 / 120);
  const later = food.pellets.find((p) => p.alive);
  if (later) {
    assert.ok(later.density > RHO_WATER, 'the pellet should have soaked up enough water to sink');
  }
});

test('tapping outside the water drops no food', () => {
  const food = new FoodSystem(3);
  assert.equal(food.drop(0, -0.12), true, 'a tap inside the tank should drop food');
  assert.equal(food.drop(10, -0.12), false, 'a tap outside the tank should not');
});

// ---------------------------------------------------------------------------
// Morphology
// ---------------------------------------------------------------------------

test('added mass is strongly anisotropic, as it is for a real fish', () => {
  // Accelerating a slender body nose-first barely disturbs the water;
  // accelerating it sideways shoves a great deal of it aside. If this comes out
  // isotropic the fish slides sideways like it is on ice, which is one of the
  // most recognisable tells of a shallow swimming model.
  const m = buildMorphology();
  const [surge, sway, heave] = m.addedMass;
  assert.ok(sway > surge * 8, `sideways added mass (${sway.toExponential(2)}) should dwarf forwards (${surge.toExponential(2)})`);
  assert.ok(sway > heave * 2, 'a laterally compressed fish should resist sideways motion far more than vertical');
  assert.ok(sway > m.totalMass, 'sideways added mass should exceed the fish own mass');
});

test('the fish is deeper than it is wide, so it yaws more easily than it pitches', () => {
  const m = buildMorphology();
  const [, pitch, yaw] = m.inertia;
  assert.ok(yaw < pitch, 'a laterally compressed fish should turn left and right more readily than up and down');
});

test('the body mass sits forward of centre, as a fish body does', () => {
  // Measured over the flesh only. The whole-animal centre of mass sits further
  // back than this, because the caudal fin's own tissue is behind the body — and
  // for a veiltail betta that fin is a third of the animal's length, so the
  // effect is not small. That is a real property of the fish rather than an
  // artefact, so the biologically meaningful claim is about the body.
  const m = buildMorphology();
  const bodySegs = m.segments.filter((s) => !s.isCaudal);
  const bodyMass = bodySegs.reduce((a, s) => a + s.mass, 0);
  const bodyCom = bodySegs.reduce((a, s) => a + s.mass * s.arc, 0) / bodyMass;

  assert.ok(bodyCom > 0 && bodyCom < m.standardLength, 'centre of mass should be inside the body');
  assert.ok(
    bodyCom < m.standardLength * 0.5,
    `body centre of mass is at ${(bodyCom / m.standardLength).toFixed(2)} SL; it should be forward of centre`,
  );
  // And the whole animal, fins included, must still be well ahead of the tail.
  assert.ok(
    m.comArc < m.standardLength * 0.65,
    `whole-animal centre of mass is at ${(m.comArc / m.standardLength).toFixed(2)} SL, too far back`,
  );
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test('the random number generator is exactly reproducible', () => {
  // The whole simulation has to replay identically from a seed, so a behaviour
  // seen once can be seen again and so the Swift and TypeScript ports can be
  // checked against each other. This is also why the generator uses only 32-bit
  // operations: a 64-bit multiply cannot be done exactly in JavaScript, so a
  // PCG-style generator would silently produce a different stream in Swift.
  const a = new Rng(12345);
  const b = new Rng(12345);
  for (let i = 0; i < 1000; i++) {
    assert.equal(a.nextUint(), b.nextUint(), `streams diverged at draw ${i}`);
  }

  const c = new Rng(12346);
  const d = new Rng(12345);
  let same = 0;
  for (let i = 0; i < 100; i++) if (c.nextUint() === d.nextUint()) same++;
  assert.ok(same < 3, 'different seeds should give different streams');
});

test('the generator produces a sane uniform distribution', () => {
  const rng = new Rng(2024);
  const bins = new Array(16).fill(0);
  const n = 160000;
  for (let i = 0; i < n; i++) bins[Math.floor(rng.next() * 16)]++;
  const expected = n / 16;
  for (let i = 0; i < 16; i++) {
    const dev = Math.abs(bins[i] - expected) / expected;
    assert.ok(dev < 0.05, `bin ${i} is ${(dev * 100).toFixed(1)}% off uniform`);
  }
});

test('wrapped Cauchy turn angles have the heavy tails a Gaussian lacks', () => {
  // Foraging animals turn with heavy-tailed angle distributions: mostly small
  // corrections with an occasional sharp reorientation. A Gaussian misses those
  // and makes a search path look like a drunkard's walk rather than an animal's.
  const rng = new Rng(5);
  let big = 0;
  const n = 20000;
  for (let i = 0; i < n; i++) {
    if (Math.abs(rng.wrappedCauchy(0.72)) > 1.5) big++;
  }
  const fraction = big / n;
  assert.ok(
    fraction > 0.02 && fraction < 0.25,
    `${(fraction * 100).toFixed(1)}% of turns exceeded 1.5 rad; expected a small but real tail`,
  );
});

test('the water grid respects its own CFL limit', () => {
  // Constructing the surface throws if the timestep is too large for the grid,
  // so this is really a check that the shipped configuration is inside the
  // stability region rather than close to its edge.
  const water = new WaterSurface(WATER.nx, WATER.nz, false);
  const limit = Math.min(water.dx, water.dz) / (WATER.waveSpeed * Math.SQRT2);
  assert.ok(WATER.dt < limit * 0.9, `water timestep ${WATER.dt} is within 10% of the CFL limit ${limit.toFixed(5)}`);
});
