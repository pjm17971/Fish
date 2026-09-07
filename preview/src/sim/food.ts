/**
 * Food pellets.
 *
 * Betta pellets float, then slowly waterlog and sink. Both phases matter,
 * because the fish feeds at the surface first and then has to hunt whatever it
 * missed on the way down — which is why a feed is a sequence of events rather
 * than one.
 *
 * A double tap drops pellets at the point where the tap ray meets the water. If
 * the ray misses the water — you tapped the sand, or the glass above the
 * waterline — nothing is dropped. The gesture is the physical act of dropping
 * something into a tank, not a button that spawns food.
 */

import {
  Vec3,
  v3,
  set,
  sub,
  scale,
  addScaled,
  len,
  clamp,
} from './math.js';
import { FOOD, GRAVITY, NU_WATER, RHO_WATER, TANK, TANK_MIN_X, TANK_MAX_X, TANK_MIN_Z, TANK_MAX_Z, WATER } from './config.js';
import { Rng } from './rng.js';
import { BulkFlow, WaterSurface } from './water.js';

export class Pellet {
  readonly position = v3();
  readonly velocity = v3();
  radius = FOOD.radius;
  /** Current density, which rises as the pellet takes up water. */
  density = FOOD.densityDry;
  /** Seconds since it hit the water. Drives both waterlogging and scent spread. */
  age = 0;
  alive = false;
  /** True while the pellet is riding the surface rather than sinking through it. */
  floating = true;
  /** How hard it hit, for the lateral line. Decays. */
  impactEnergy = 0;
  /** How much is left of it, 0 to 1. Uneaten food breaks down. */
  integrity = 1;
  /**
   * Water velocity imposed on this pellet from outside — in practice, the inflow
   * of a fish's suction strike. Cleared every step.
   *
   * The pellet responds to it through drag, exactly as it responds to the tank's
   * own flow, rather than having its velocity or position overridden. That
   * matters: the pellet is buoyant while it is still dry, so simply detaching it
   * from the surface and pulling it down makes it shoot straight back up again —
   * which is precisely what happened, and it looked like the fish blowing its
   * food away every time it tried to eat.
   *
   * Working through drag also makes the outcome a real contest. A 0.1 m/s inflow
   * produces about 6.6 microNewtons of drag on a 0.7 mm pellet against 5.0
   * microNewtons of buoyancy, so the suction wins — but not by much, and a
   * weaker strike genuinely fails.
   */
  readonly externalFlow = v3();

  get mass(): number {
    return this.density * (4 / 3) * Math.PI * this.radius ** 3;
  }
}

const scratch = {
  flow: v3(),
  rel: v3(),
  drag: v3(),
  acc: v3(),
};

export class FoodSystem {
  readonly pellets: Pellet[] = [];
  private readonly rng: Rng;
  /** Pellets waiting to be released, so a drop is a short burst rather than a clump. */
  private pending: { at: number; x: number; z: number }[] = [];
  private time = 0;

  constructor(seed: number) {
    this.rng = new Rng(seed ^ 0x5f3a1c);
    for (let i = 0; i < FOOD.maxPellets; i++) this.pellets.push(new Pellet());
  }

  get activeCount(): number {
    let n = 0;
    for (const p of this.pellets) if (p.alive) n++;
    return n;
  }

  /**
   * Drop food at a point on the water surface.
   *
   * Returns false if the point is outside the water, in which case nothing is
   * dropped — tapping the sand should not conjure food out of the air.
   */
  drop(x: number, z: number): boolean {
    if (x < TANK_MIN_X || x > TANK_MAX_X || z < TANK_MIN_Z || z > TANK_MAX_Z) return false;
    for (let i = 0; i < FOOD.pelletsPerDrop; i++) {
      this.pending.push({
        at: this.time + i * FOOD.dropIntervalS,
        x: x + this.rng.sym(FOOD.dropScatter),
        z: z + this.rng.sym(FOOD.dropScatter),
      });
    }
    return true;
  }

  private spawn(x: number, z: number, water: WaterSurface): void {
    const p = this.pellets.find((q) => !q.alive);
    if (!p) return; // tank is already full of food; refuse rather than churn
    const surfaceY = water.heightAt(x, z);
    set(p.position, x, surfaceY + 0.002, z);
    // Dropped from just above the surface, so it arrives with a small impact.
    set(p.velocity, 0, -0.15, 0);
    p.radius = FOOD.radius * (1 + this.rng.sym(FOOD.radiusJitter));
    p.density = FOOD.densityDry;
    p.age = 0;
    p.alive = true;
    p.floating = true;
    p.integrity = 1;
    p.impactEnergy = 1;
    water.disturb(x, z, -0.15 * WATER.pelletImpactGain * 30, WATER.pelletImpactRadius);
  }

  step(water: WaterSurface, flow: BulkFlow, dt: number): void {
    this.time += dt;

    while (this.pending.length && this.pending[0].at <= this.time) {
      const q = this.pending.shift()!;
      this.spawn(q.x, q.z, water);
    }

    for (const p of this.pellets) {
      if (!p.alive) continue;
      p.age += dt;
      p.impactEnergy = Math.max(0, p.impactEnergy - dt * 2);

      // Waterlogging. A dry pellet floats; a soaked one sinks. The crossover is
      // what turns one feeding into two separate events.
      const soak = 1 - Math.exp(-p.age / FOOD.soakTau);
      p.density = FOOD.densityDry + (FOOD.densitySaturated - FOOD.densityDry) * soak;

      // Break down slowly if nothing eats it.
      p.integrity = Math.max(0, 1 - p.age / FOOD.decayTime);
      if (p.integrity <= 0) {
        p.alive = false;
        continue;
      }

      const volume = (4 / 3) * Math.PI * p.radius ** 3;
      const mass = p.density * volume;
      const surfaceY = water.heightAt(p.position.x, p.position.z);

      flow.sample(p.position.x, p.position.y, p.position.z, scratch.flow);
      // Whatever the fish's mouth is doing to the water here, on top of the
      // tank's own circulation.
      scratch.flow.x += p.externalFlow.x;
      scratch.flow.y += p.externalFlow.y;
      scratch.flow.z += p.externalFlow.z;
      const suction = len(p.externalFlow);
      sub(scratch.rel, p.velocity, scratch.flow);
      const speed = len(scratch.rel);

      // Drag on a sphere, Schiller-Naumann.
      //
      // At the terminal sink speed the Reynolds number is about 60, which is
      // squarely in the range where neither Stokes' law nor the constant-0.44
      // sphere figure is right — Stokes is out by a factor of three at that
      // Reynolds number, and 0.44 is out the other way. Schiller-Naumann covers
      // the whole range a pellet actually passes through as it accelerates.
      const Re = Math.max(1e-3, (2 * p.radius * speed) / NU_WATER);
      const Cd = Re < 1000 ? (24 / Re) * (1 + 0.15 * Math.pow(Re, 0.687)) : 0.44;
      const area = Math.PI * p.radius ** 2;
      const dragMag = 0.5 * RHO_WATER * Cd * area * speed * speed;
      if (speed > 1e-9) scale(scratch.drag, scratch.rel, -dragMag / speed);
      else set(scratch.drag, 0, 0, 0);

      // Weight and buoyancy.
      const netWeight = (mass - RHO_WATER * volume) * GRAVITY;
      set(scratch.acc, scratch.drag.x, scratch.drag.y - netWeight, scratch.drag.z);

      if (p.floating && p.density >= RHO_WATER) p.floating = false;

      // A pellet being drawn into a mouth is no longer riding the surface: the
      // contact line has broken. It is still buoyant, though, so if the suction
      // stops it will bob straight back up.
      if (p.floating && suction > 0.012) p.floating = false;

      if (p.floating) {
        // A floating pellet is *pinned* to the surface, not springily attached
        // to it.
        //
        // Surface tension at this scale is overwhelming. The contact line round
        // a 0.7 mm pellet pulls with about 3e-4 N, while the pellet weighs 9e-9 N
        // — thirty-five thousand times less. Modelling that as a spring gives a
        // stiffness with a natural frequency in the tens of kilohertz, which no
        // sane timestep can integrate; softening it until it is integrable gives
        // a pellet that bobs a centimetre and a half on landing, which is
        // absurd for something under a millimetre across. The honest reading of
        // those numbers is that the pellet simply sits on the surface and goes
        // where the surface goes.
        const target = surfaceY + p.radius * 0.35;
        p.velocity.y = (target - p.position.y) / Math.max(1e-4, dt);
        p.position.y = target;
        // Horizontal motion still comes from drag against the flow.
        p.velocity.x += (scratch.drag.x / mass) * dt;
        p.velocity.z += (scratch.drag.z / mass) * dt;
        p.position.x += p.velocity.x * dt;
        p.position.z += p.velocity.z * dt;
      } else {
        addScaled(p.velocity, scratch.acc, dt / mass);
        addScaled(p.position, p.velocity, dt);
      }

      // The tank.
      const floorY = TANK.floorY;
      if (p.position.y < floorY + p.radius) {
        p.position.y = floorY + p.radius;
        // Sand is soft: almost no bounce, and the pellet stops.
        p.velocity.y = Math.max(0, p.velocity.y * -0.05);
        p.velocity.x *= 0.4;
        p.velocity.z *= 0.4;
      }
      p.position.x = clamp(p.position.x, TANK_MIN_X + p.radius, TANK_MAX_X - p.radius);
      p.position.z = clamp(p.position.z, TANK_MIN_Z + p.radius, TANK_MAX_Z - p.radius);

      // Re-attach to the surface if it drifts back up to it and nothing is
      // pulling on it.
      if (!p.floating && suction < 0.012 && p.density < RHO_WATER && p.position.y > surfaceY - p.radius) {
        p.floating = true;
      }
      p.externalFlow.x = 0;
      p.externalFlow.y = 0;
      p.externalFlow.z = 0;

      // Crossing the surface on the way down makes a real ripple.
      if (p.floating === false && p.position.y > surfaceY && p.velocity.y < 0) {
        water.disturb(
          p.position.x,
          p.position.z,
          p.velocity.y * WATER.pelletImpactGain * 30,
          WATER.pelletImpactRadius,
        );
      }
    }
  }

  /** Remove a pellet because the fish ate it. */
  consume(p: Pellet, water: WaterSurface): void {
    p.alive = false;
    // Even a small mouth closing at the surface makes a visible dimple.
    if (p.position.y > TANK.waterY - 0.01) {
      water.disturb(p.position.x, p.position.z, -0.02, WATER.pelletImpactRadius * 1.5);
    }
  }

  /** Scent concentration at a point, for the debug view. */
  scentAt(pos: Vec3): number {
    let total = 0;
    for (const p of this.pellets) {
      if (!p.alive) continue;
      const dx = p.position.x - pos.x;
      const dy = p.position.y - pos.y;
      const dz = p.position.z - pos.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      const sigma = Math.max(0.005, Math.sqrt(2 * FOOD.scentDiffusivity * p.age));
      total += Math.exp(-d2 / (2 * sigma * sigma));
    }
    return total;
  }

  reset(): void {
    for (const p of this.pellets) p.alive = false;
    this.pending.length = 0;
  }
}

/**
 * Terminal sink speed of a fully waterlogged pellet, solved from the force
 * balance rather than measured from a run. The test compares the simulation
 * against this.
 */
export function analyticTerminalSinkSpeed(radius = FOOD.radius): number {
  const volume = (4 / 3) * Math.PI * radius ** 3;
  const area = Math.PI * radius ** 2;
  const netWeight = (FOOD.densitySaturated - RHO_WATER) * volume * GRAVITY;
  // Iterate: Cd depends on speed through the Reynolds number, and speed depends
  // on Cd. It converges in a handful of passes.
  let v = 0.05;
  for (let i = 0; i < 60; i++) {
    const Re = Math.max(1e-3, (2 * radius * v) / NU_WATER);
    const Cd = Re < 1000 ? (24 / Re) * (1 + 0.15 * Math.pow(Re, 0.687)) : 0.44;
    v = Math.sqrt((2 * netWeight) / (RHO_WATER * Cd * area));
  }
  return v;
}
