/**
 * Suspended particulate: the specks drifting in the water of any real tank.
 *
 * Fresh water in a planted tank is clear but never empty. It carries fine
 * detritus — bits of plant, food dust, the odd speck of sand — a few tenths of a
 * millimetre across and not much denser than the water. They are almost
 * invisible until light catches them, and then they glint, most brightly when
 * you look up towards the lamp, because small particles throw most of the light
 * they scatter onward, in the direction it was already going.
 *
 * Each speck is carried by the same bulk flow the fish and the food feel,
 * settles at its Stokes speed, and wanders slightly with the small-scale
 * turbulence the bulk flow is too coarse to hold. One that settles onto the
 * sand is picked up again somewhere else, standing in for the stream stirring
 * the substrate. Purely visual: nothing in the simulation reads these, and
 * they draw from their own random stream so the fish's run is unchanged.
 */

import { BulkFlow } from '../sim/water.js';
import { GRAVITY, NU_WATER, RHO_WATER, TANK, TANK_MIN_X, TANK_MIN_Z } from '../sim/config.js';
import { Rng } from '../sim/rng.js';
import { v3 } from '../sim/math.js';

export const PARTICULATE = {
  /**
   * How many specks: about 120 per litre in this 7.4-litre volume. A judgement
   * for a clean, filtered freshwater tank rather than a measured figure — enough
   * that a few are always in view, few enough that the water reads as clear.
   */
  count: 900,
  /** Radius range, metres. Drawn log-uniformly, so most are small. */
  radiusMin: 0.00003,
  radiusMax: 0.00022,
  /** Density above water, kg/m^3. Organic detritus is barely denser than water. */
  excessDensity: 25,
  /**
   * Eddy diffusivity, m^2/s: the stirring below the scale of the bulk flow.
   * Small — enough that neighbouring specks do not move in lockstep.
   */
  diffusivity: 4e-7,
} as const;

/** Floats per speck in the vertex buffer: position (3), radius (1), seed (1). */
export const PARTICULATE_FLOATS = 5;

export class Particulate {
  readonly data: Float32Array;
  readonly count = PARTICULATE.count;
  private readonly settle: Float32Array;
  private readonly rng = new Rng(0x5eec5);
  private readonly flowAt = v3();

  constructor() {
    this.data = new Float32Array(this.count * PARTICULATE_FLOATS);
    this.settle = new Float32Array(this.count);
    const mu = NU_WATER * RHO_WATER;
    const logMin = Math.log(PARTICULATE.radiusMin);
    const logMax = Math.log(PARTICULATE.radiusMax);
    for (let i = 0; i < this.count; i++) {
      const o = i * PARTICULATE_FLOATS;
      this.place(o);
      const r = Math.exp(logMin + (logMax - logMin) * this.rng.next());
      this.data[o + 3] = r;
      this.data[o + 4] = this.rng.next();
      // Stokes settling: 2 (drho) g r^2 / (9 mu). From 0.06 mm/s for the
      // smallest to 3 mm/s for the largest, which crosses the tank in a minute.
      this.settle[i] = (2 * PARTICULATE.excessDensity * GRAVITY * r * r) / (9 * mu);
    }
  }

  private place(o: number): void {
    this.data[o] = TANK_MIN_X + 0.004 + (TANK.width - 0.008) * this.rng.next();
    this.data[o + 1] = TANK.floorY + 0.004 + (TANK.waterY - TANK.floorY - 0.008) * this.rng.next();
    this.data[o + 2] = TANK_MIN_Z + 0.004 + (TANK.depth - 0.008) * this.rng.next();
  }

  step(flow: BulkFlow, dt: number): void {
    if (dt <= 0) return;
    const jitter = Math.sqrt(2 * PARTICULATE.diffusivity * dt);
    const d = this.data;
    const xMin = TANK_MIN_X + 0.002;
    const xMax = -TANK_MIN_X - 0.002;
    const zMin = TANK_MIN_Z + 0.002;
    const zMax = -0.002;
    for (let i = 0; i < this.count; i++) {
      const o = i * PARTICULATE_FLOATS;
      flow.sample(d[o], d[o + 1], d[o + 2], this.flowAt);
      d[o] += (this.flowAt.x) * dt + jitter * this.rng.normal();
      d[o + 1] += (this.flowAt.y - this.settle[i]) * dt + jitter * this.rng.normal();
      d[o + 2] += (this.flowAt.z) * dt + jitter * this.rng.normal();
      // The glass holds them in; the sand takes them, and the stream puts
      // them back somewhere else.
      d[o] = Math.min(xMax, Math.max(xMin, d[o]));
      d[o + 2] = Math.min(zMax, Math.max(zMin, d[o + 2]));
      d[o + 1] = Math.min(TANK.waterY - 0.002, d[o + 1]);
      if (d[o + 1] < TANK.floorY + 0.001) this.place(o);
    }
  }
}
