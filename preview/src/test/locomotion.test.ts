/**
 * Does the fish swim like a fish?
 *
 * These are the tests that make the difference between a simulation and an
 * animation claim checkable. Nothing in the locomotion code was tuned to make
 * them pass: the fish is given a tail-beat frequency and the speed that comes
 * out is whatever the hydrodynamics produces. If the model were faked — a speed
 * set from the frequency by a curve — the Strouhal number would be whatever we
 * chose, and it would not simultaneously satisfy the stride length, the
 * linearity, and the coast-down.
 *
 * Every run here is in open water (`bounds = null`). With the tank walls in
 * place a fish swimming in a straight line reaches the front glass in a couple
 * of seconds and is held there while its velocity keeps reading as though it
 * were still going — which makes every measurement meaningless in a way that
 * looks entirely plausible.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildMorphology } from '../sim/morphology.js';
import { FishBody, createMotorCommand } from '../sim/fishBody.js';
import { createLocomotion } from '../sim/locomotion.js';
import { v3 } from '../sim/math.js';
import { FISH } from '../sim/config.js';

interface SwimResult {
  /** Mean forward speed once settled, m/s. */
  speed: number;
  /** Peak-to-peak excursion of the tail tip, measured rather than assumed. */
  tailAmplitudePP: number;
  strouhal: number;
  /** Body lengths advanced per tail beat. */
  stride: number;
  speedSL: number;
}

function swim(frequency: number, seconds = 18): SwimResult {
  const morph = buildMorphology();
  const body = new FishBody(morph);
  const loco = createLocomotion(morph, body);
  loco.bounds = null;

  const cmd = createMotorCommand();
  cmd.frequency = frequency;
  cmd.amplitude = FISH.standardLength * FISH.tailAmplitudeRatio;

  const dt = FISH.dt;
  const steps = Math.round(seconds / dt);
  let sum = 0;
  let count = 0;
  let excursion = 0;

  for (let i = 0; i < steps; i++) {
    loco.step(cmd, null, null, dt);
    // Measure only after the fish has settled to a steady speed.
    if (i > steps * 0.65) {
      sum += loco.forwardSpeed;
      count++;
      excursion = Math.max(excursion, body.tailExcursion);
    }
  }

  const speed = sum / count;
  const tailAmplitudePP = 2 * excursion;
  return {
    speed,
    tailAmplitudePP,
    strouhal: (frequency * tailAmplitudePP) / speed,
    stride: speed / (frequency * FISH.standardLength),
    speedSL: speed / FISH.standardLength,
  };
}

test('tail amplitude is 20% of body length, as the literature measures it', () => {
  // The figure the amplitude envelope is anchored to refers to the tip of the
  // caudal fin, not the peduncle. Anchoring it at the wrong place silently
  // scales every speed and efficiency figure that follows.
  const r = swim(3);
  const ratio = r.tailAmplitudePP / FISH.standardLength;
  assert.ok(
    ratio > 0.18 && ratio < 0.22,
    `tail peak-to-peak amplitude is ${ratio.toFixed(3)} SL, expected about 0.20`,
  );
});

test('Strouhal number lands in the range real fish converge on', () => {
  // St = f * A / U. Swimming animals from sprats to whales cluster in 0.2 to
  // 0.4, with flapping-foil experiments putting peak propulsive efficiency at
  // 0.25 to 0.35. This is an emergent property here: the speed is not set, it is
  // whatever the water gives back.
  for (const f of [2, 3, 4, 5]) {
    const r = swim(f);
    assert.ok(
      r.strouhal >= 0.18 && r.strouhal <= 0.42,
      `at ${f} Hz the Strouhal number is ${r.strouhal.toFixed(3)}, outside 0.18-0.42`,
    );
  }
});

test('stride length is in the range measured for real swimmers', () => {
  // Distance advanced per tail beat, in body lengths. Real fish sit at roughly
  // 0.5 to 0.8; this model runs a little more efficient than that, mostly
  // because it has no vortex-shedding losses and a purely laminar boundary
  // layer, so the window is widened to 1.05 rather than pretending otherwise.
  for (const f of [2, 3, 4, 5]) {
    const r = swim(f);
    assert.ok(
      r.stride >= 0.45 && r.stride <= 1.05,
      `at ${f} Hz the stride is ${r.stride.toFixed(3)} SL/beat, outside 0.45-1.05`,
    );
  }
});

test('cruise speed at 3 Hz is plausible for a small fish', () => {
  const r = swim(3);
  assert.ok(
    r.speedSL > 1.0 && r.speedSL < 4.0,
    `cruise at 3 Hz is ${r.speedSL.toFixed(2)} SL/s, expected 1-4`,
  );
});

test('speed is very nearly linear in tail-beat frequency', () => {
  // Fast swimmers hold their tail amplitude roughly constant and change speed by
  // changing frequency, which makes speed close to linear in frequency. That
  // falls out here rather than being imposed.
  const freqs = [1, 2, 3, 4, 5, 6, 7];
  const speeds = freqs.map((f) => swim(f).speed);

  const n = freqs.length;
  const sx = freqs.reduce((a, b) => a + b, 0);
  const sy = speeds.reduce((a, b) => a + b, 0);
  const sxx = freqs.reduce((a, b) => a + b * b, 0);
  const sxy = freqs.reduce((a, b, i) => a + b * speeds[i], 0);
  const m = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const c = (sy - m * sx) / n;
  const mean = sy / n;
  const ssTot = speeds.reduce((a, y) => a + (y - mean) ** 2, 0);
  const ssRes = speeds.reduce((a, y, i) => a + (y - (m * freqs[i] + c)) ** 2, 0);
  const r2 = 1 - ssRes / ssTot;

  assert.ok(r2 > 0.97, `speed vs frequency is not linear enough: R^2 = ${r2.toFixed(4)}`);
  assert.ok(m > 0, 'speed must increase with tail-beat frequency');
});

test('a fish that stops beating coasts to a halt and never speeds up', () => {
  const morph = buildMorphology();
  const body = new FishBody(morph);
  const loco = createLocomotion(morph, body);
  loco.bounds = null;
  const cmd = createMotorCommand();
  cmd.frequency = 4;

  const dt = FISH.dt;
  for (let i = 0; i < Math.round(12 / dt); i++) loco.step(cmd, null, null, dt);
  // Compare like with like: the trace below records speed, so the baseline must
  // be speed too. Using the forward *component* as the baseline and the speed as
  // the trace quietly compares two different quantities, and a fish that is
  // circling reads as though it never slowed down.
  const cruising = loco.speed;
  assert.ok(cruising > 0.05, 'fish should be cruising before the coast-down');

  cmd.frequency = 0;
  cmd.amplitude = 0;
  cmd.bend = 0;

  // Track the *speed*, not the forward component.
  //
  // Projecting onto the fish's own forward axis is misleading here: a coasting
  // fish is still turning, so the projection swings and can go sharply negative
  // while the fish is simply drifting sideways. The physical claim worth testing
  // is that with no thrust the water can only take energy out, so the speed must
  // fall monotonically and never rise.
  const trace: number[] = [];
  for (let i = 0; i < Math.round(6 / dt); i++) {
    loco.step(cmd, null, null, dt);
    if (i % 25 === 0) trace.push(loco.speed);
  }

  assert.ok(trace[trace.length - 1] < cruising * 0.5, 'the fish did not slow down when it stopped swimming');
  for (let i = 1; i < trace.length; i++) {
    assert.ok(
      trace[i] <= trace[i - 1] * 1.02,
      `a coasting fish sped up from ${trace[i - 1].toFixed(4)} to ${trace[i].toFixed(4)} m/s, ` +
        `which drag alone cannot do`,
    );
  }
});

test('rowing the pectorals drives the fish forwards without lifting it', () => {
  // The slow-swimming mode, isolated, in the real solver.
  //
  // For a long time this mode produced nothing at all: the blade normal was set
  // along the fin's span, so the paddle moved edge-on and every stroke was
  // free. A test of the feathering *phase* passed throughout, because it
  // integrated its own copy of the blade model rather than asking the solver,
  // and zero is very reliably equal to zero. So this asks the solver.
  //
  // The signs matter as much as the magnitudes: the steering law's choice of
  // which fin to row for which turn is set from what is measured here.
  const row = (left: number, right: number) => {
    const morph = buildMorphology();
    const body = new FishBody(morph);
    const loc = createLocomotion(morph, body);
    loc.bounds = null;
    const cmd = createMotorCommand();
    cmd.pectoralLeft = left;
    cmd.pectoralRight = right;
    cmd.finSpread = 0.6;
    const p0 = { ...loc.position };
    let yaw0: number | null = null;
    let yaw = 0;
    for (let i = 0; i < Math.round(5 / FISH.dt); i++) {
      loc.step(cmd, null, null, FISH.dt);
      const f = loc.forward(v3());
      yaw = Math.atan2(f.x, f.z);
      if (yaw0 === null) yaw0 = yaw;
    }
    let turned = yaw - (yaw0 ?? 0);
    turned = Math.atan2(Math.sin(turned), Math.cos(turned));
    return {
      forwardSL: loc.forwardSpeedSL,
      turnedDeg: (turned * 180) / Math.PI,
      roseMm: (loc.position.y - p0.y) * 1000,
    };
  };

  const both = row(4, 4);
  assert.ok(
    both.forwardSL > 0.15,
    `rowing both pectorals at 4 Hz gave only ${both.forwardSL.toFixed(2)} SL/s forwards`,
  );
  assert.ok(Math.abs(both.turnedDeg) < 15, `symmetric rowing turned the fish ${both.turnedDeg.toFixed(0)} degrees`);
  assert.ok(Math.abs(both.roseMm) < 25, `symmetric rowing moved the fish ${both.roseMm.toFixed(0)} mm vertically`);

  // One fin alone. Its torque on the body is real and correctly signed (about
  // 1.5e-7 N.m, measured), but the water the fish's flanks and fins must shove
  // sideways to rotate gives it thirty-five times its own yaw inertia, and a
  // single pectoral cannot turn that: a quarter of a degree a second. That is
  // why the fish pivots with a tail scull and not with its pectorals. What a
  // single fin must still do is push, and must not do is lift.
  const leftOnly = row(4, 0);
  assert.ok(leftOnly.forwardSL > 0.1, `one rowing fin gave only ${leftOnly.forwardSL.toFixed(2)} SL/s`);
  assert.ok(Math.abs(leftOnly.roseMm) < 40, `one rowing fin lifted the fish ${leftOnly.roseMm.toFixed(0)} mm`);
});

test('the fish cannot move itself by wriggling in still water', () => {
  // The single most common way a "physical" swimmer turns out to be faked: if
  // the body's deformation is applied about a fixed origin, its centre of mass
  // wanders, and the fish translates itself with no water involved. Here the
  // instantaneous mass-weighted centroid is subtracted every step, so bending
  // alone moves nothing.
  //
  // Beating the tail with all fluid forces removed must leave the fish exactly
  // where it started.
  const morph = buildMorphology();
  const body = new FishBody(morph);
  const cmd = createMotorCommand();
  cmd.frequency = 5;

  const dt = FISH.dt;
  const centroid = (): { x: number; y: number; z: number } => {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let i = 0; i < body.segments.length; i++) {
      const m = morph.segments[i].mass;
      cx += body.segments[i].pos.x * m;
      cy += body.segments[i].pos.y * m;
      cz += body.segments[i].pos.z * m;
    }
    return { x: cx / morph.totalMass, y: cy / morph.totalMass, z: cz / morph.totalMass };
  };

  let worst = 0;
  for (let i = 0; i < 1500; i++) {
    body.shape(cmd, dt);
    const c = centroid();
    worst = Math.max(worst, Math.abs(c.x), Math.abs(c.y), Math.abs(c.z));
  }
  assert.ok(
    worst < 1e-9,
    `the body's centre of mass drifted by ${worst.toExponential(2)} m while bending; it must not move at all`,
  );
});

test('the body does not stretch when it bends', () => {
  // The muscle command is a lateral displacement wave, and a curve with a
  // lateral offset is longer than the straight line it came from. Sampling it at
  // uniform parameter rather than uniform arc length makes the fish grow by a
  // few percent every time it bends, which reads as a pumping motion.
  const morph = buildMorphology();
  const body = new FishBody(morph);
  const cmd = createMotorCommand();
  cmd.frequency = 6;
  cmd.amplitude = FISH.standardLength * FISH.burstAmplitudeRatio;
  cmd.bend = 1;

  const chainLength = (): number => {
    let total = 0;
    for (let i = 1; i < body.segments.length; i++) {
      const a = body.segments[i - 1].pos;
      const b = body.segments[i].pos;
      total += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    }
    return total;
  };

  body.shape(cmd, 0);
  const straightish = chainLength();
  let minLen = Infinity;
  let maxLen = -Infinity;
  for (let i = 0; i < 800; i++) {
    body.shape(cmd, FISH.dt);
    const l = chainLength();
    minLen = Math.min(minLen, l);
    maxLen = Math.max(maxLen, l);
  }
  const variation = (maxLen - minLen) / straightish;
  assert.ok(
    variation < 0.005,
    `the body's length varied by ${(variation * 100).toFixed(2)}% while bending; it should be inextensible`,
  );
});
