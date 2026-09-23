/**
 * The water: a height field for the surface, and an analytic divergence-free
 * field for bulk flow.
 *
 * The surface is solved as the sum of the tank's own standing waves — its
 * modes — each of which is a damped oscillator ringing at exactly the frequency
 * real water gives a wave of that length in water this deep. See WaterSurface.
 */

import { GRAVITY, TANK, WATER, WATER_DEPTH, TANK_MIN_X, TANK_MIN_Z, RHO_WATER, NU_WATER } from './config.js';
import { fbm3, Rng } from './rng.js';
import { clamp, Vec3 } from './math.js';

/**
 * How a disturbance's `strength` turns into surface velocity. The solver this
 * one replaced applied each disturbance as an acceleration over a single 2.5 ms
 * step; every caller (the fish, pellets, bubbles) was calibrated against that,
 * so the same factor is kept and they disturb the water exactly as much as
 * before.
 */
export const IMPULSE_SECONDS = 0.0025;

/** How many recent disturbances the surface remembers for the renderer. */
export const TOUCH_LOG = 4096;
/** Numbers per disturbance in the log: x, z, amount, radius, time, kind. */
export const TOUCH_FIELDS = 6;
/** A push: `amount` sets surface speed, as disturb() takes it. */
export const TOUCH_PUSH = 0;
/** A displacement: `amount` is a volume of water moved, m^3. */
export const TOUCH_LIFT = 1;

/**
 * The water surface.
 *
 * **Why modes, and not the usual wave equation on a grid.** The obvious
 * approach — the one this replaced — solves the shallow-water wave equation,
 * in which every wave travels at sqrt(g * depth), 0.91 m/s here. That is right
 * for the sloshing of the whole tank and wrong by a factor of four for the
 * centimetre-long ripples that make the light on the sand: real ripples that
 * size travel at about a quarter of a metre a second. Ripples four times too
 * fast read as flicker, and so the ripples used to be added separately, as a
 * pattern laid over the simulation.
 *
 * A rectangular tank with vertical walls has a known set of standing waves,
 * cos(m pi x / W) cos(n pi z / D), and every surface shape is a sum of them.
 * Each one oscillates on its own, at the frequency the linear theory of water
 * waves gives for its wavenumber k in water of depth h:
 *
 *     omega^2 = (g k + (sigma / rho) k^3) tanh(k h)
 *
 * which covers everything from the whole tank sloshing (where tanh(kh) ~ kh
 * and this is the shallow-water result) to ripples short enough that surface
 * tension matters. Nothing is tuned: gravity, depth and the surface tension of
 * water fix every frequency. Each mode is advanced with the exact solution of
 * a damped oscillator, so there is no timestep stability limit either.
 *
 * **Damping.** Two parts. A slow bulk loss for the long waves (the tank walls
 * and floor), and the damping a surface film adds to short waves. The surface
 * of any aquarium carries a thin film of organic matter; a film that resists
 * being stretched damps a wave at a rate of about k * sqrt(nu * omega / 8)
 * (Lamb; Miles 1967), which is tens of times the damping of a clean surface
 * and is why a tank's ripples die out within a hand's width instead of
 * glittering across the whole surface.
 *
 * **What keeps it moving.** Two sources, both random, as turbulence is. The
 * filter's return stream breaks the surface at the outlet: a handful of small
 * patches there, each pushed by band-limited noise. And the current it drives
 * spreads across the whole surface, carrying eddies that keep nudging it
 * everywhere: each mode gets a small random push, sized so that the ripples
 * this keeps going have the spectrum of a gently agitated surface (see
 * WATER.agitation). Everything after that — how fast the ripples travel, how
 * they reflect off the glass and cross each other, how the fish and the food
 * add to them — is the simulation, and it is those ripples, not anything
 * added afterwards, that focus the light on the sand.
 *
 * Heights, and the slopes the renderer needs, are rebuilt from the modes only
 * when someone reads them.
 */
export class WaterSurface {
  readonly nx: number;
  readonly nz: number;
  readonly dx: number;
  readonly dz: number;

  /** Surface displacement from the still level, in metres, at each grid node. */
  private readonly h: Float32Array;
  /** The surface slope, dh/dx and dh/dz, at each node. */
  private readonly gx: Float32Array;
  private readonly gz: Float32Array;
  private readonly n: Float32Array;
  private heightsStale = false;
  private slopesStale = false;

  /** Mode amplitudes and their rates of change, indexed [n * nx + m]. */
  private readonly amp: Float64Array;
  private readonly rate: Float64Array;
  /** Angular frequency squared of each mode, and its one-step transition. */
  private readonly omega2: Float64Array;
  private readonly m00: Float64Array;
  private readonly m01: Float64Array;
  private readonly m10: Float64Array;
  private readonly m11: Float64Array;
  /** Wavenumbers of each column and row of modes. */
  private readonly kx: Float64Array;
  private readonly kz: Float64Array;
  /** cos(m pi i / (nx - 1)), indexed [m * nx + i]; likewise for z. */
  private readonly cosX: Float64Array;
  private readonly cosZ: Float64Array;
  private readonly sinX: Float64Array;
  private readonly sinZ: Float64Array;
  /** Scratch for the separable transforms. */
  private readonly rowsA: Float64Array;
  private readonly rowsB: Float64Array;

  /** Nodal impulses gathered from disturb() since the last step. */
  private readonly force: Float32Array;
  private forcePending = false;
  /** Nodal height changes gathered from displace() since the last step. */
  private readonly lift: Float32Array;
  private liftPending = false;
  /** Modal accelerations for a unit push at each outlet patch, and for a tilt. */
  private readonly outletShapes: Float64Array[] = [];
  private readonly outletNoise: { y: number; v: number }[] = [];
  private readonly tiltX: Float64Array;
  private readonly tiltZ: Float64Array;
  /** Per-mode strength of the random push from the surface current; 0 if off. */
  private readonly agitation: Float64Array;
  private readonly rng = new Rng(0x0e7ea5);

  private accumulator = 0;
  private timeAccum = 0;

  /**
   * Every disturbance, as (x, z, strength, radius, time, kind), in a ring of the most
   * recent TOUCH_LOG entries; `touchCount` counts all of them ever made. The
   * renderer replays them into a much finer ripple layer (see
   * render/ripples.ts), because this grid, at 4.4 mm between nodes, cannot
   * hold the centimetre rings a touch sends out, and those rings are what
   * throw the light on the sand. Nothing in the simulation reads it.
   */
  readonly touchLog = new Float64Array(TOUCH_LOG * TOUCH_FIELDS);
  touchCount = 0;

  /** Linear acceleration of the tank in world space, gravity already removed. */
  private accelX = 0;
  private accelZ = 0;

  /**
   * @param outlet Whether the filter outlet runs. On in the tank; the tests
   *   that compare the surface against theory turn it off, because a surface
   *   with a source in it is never still, and those tests are about the water,
   *   not the tank.
   */
  constructor(nx = WATER.nx, nz = WATER.nz, outlet = true) {
    this.nx = nx;
    this.nz = nz;
    this.dx = TANK.width / (nx - 1);
    this.dz = TANK.depth / (nz - 1);
    const count = nx * nz;
    this.h = new Float32Array(count);
    this.gx = new Float32Array(count);
    this.gz = new Float32Array(count);
    this.n = new Float32Array(count * 3);
    for (let k = 0; k < count; k++) this.n[k * 3 + 1] = 1;
    this.force = new Float32Array(count);
    this.lift = new Float32Array(count);
    this.amp = new Float64Array(count);
    this.rate = new Float64Array(count);
    this.omega2 = new Float64Array(count);
    this.m00 = new Float64Array(count);
    this.m01 = new Float64Array(count);
    this.m10 = new Float64Array(count);
    this.m11 = new Float64Array(count);
    this.rowsA = new Float64Array(count);
    this.rowsB = new Float64Array(count);
    this.agitation = new Float64Array(count);

    this.kx = new Float64Array(nx);
    this.kz = new Float64Array(nz);
    for (let m = 0; m < nx; m++) this.kx[m] = (Math.PI * m) / TANK.width;
    for (let q = 0; q < nz; q++) this.kz[q] = (Math.PI * q) / TANK.depth;
    this.cosX = new Float64Array(nx * nx);
    this.sinX = new Float64Array(nx * nx);
    for (let m = 0; m < nx; m++) {
      for (let i = 0; i < nx; i++) {
        const a = (Math.PI * m * i) / (nx - 1);
        this.cosX[m * nx + i] = Math.cos(a);
        this.sinX[m * nx + i] = Math.sin(a);
      }
    }
    this.cosZ = new Float64Array(nz * nz);
    this.sinZ = new Float64Array(nz * nz);
    for (let q = 0; q < nz; q++) {
      for (let j = 0; j < nz; j++) {
        const a = (Math.PI * q * j) / (nz - 1);
        this.cosZ[q * nz + j] = Math.cos(a);
        this.sinZ[q * nz + j] = Math.sin(a);
      }
    }

    // Each mode's frequency, damping, and the exact one-step solution of
    //   a'' + 2 G a' + omega^2 a = 0
    // over WATER.dt, as a two-by-two matrix on (amplitude, rate).
    const dt = WATER.dt;
    const sigmaOverRho = WATER.surfaceTension / RHO_WATER;
    for (let q = 0; q < nz; q++) {
      for (let m = 0; m < nx; m++) {
        const idx = q * nx + m;
        const k = Math.hypot(this.kx[m], this.kz[q]);
        if (k === 0) continue; // the mean level: fixed, since water is not created
        const w2 = (GRAVITY * k + sigmaOverRho * k * k * k) * Math.tanh(k * WATER_DEPTH);
        const w = Math.sqrt(w2);
        const g = 0.5 * WATER.beta + WATER.filmDamping * k * Math.sqrt((NU_WATER * w) / 8);
        const wd = Math.sqrt(Math.max(1e-12, w2 - g * g));
        const e = Math.exp(-g * dt);
        const c = Math.cos(wd * dt);
        const s = Math.sin(wd * dt) / wd;
        this.omega2[idx] = w2;
        this.m00[idx] = e * (c + g * s);
        this.m01[idx] = e * s;
        this.m10[idx] = -e * w2 * s;
        this.m11[idx] = e * (c - g * s);
      }
    }

    // A tilt of the effective gravity makes a tilted plane the resting shape;
    // its projection onto the modes is worked out once, for a unit slope in x
    // and in z.
    const planeX = new Float32Array(count);
    const planeZ = new Float32Array(count);
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        planeX[j * nx + i] = this.worldX(i);
        planeZ[j * nx + i] = this.worldZ(j);
      }
    }
    this.tiltX = new Float64Array(count);
    this.tiltZ = new Float64Array(count);
    this.project(planeX, this.tiltX);
    this.project(planeZ, this.tiltZ);

    // The current's agitation. A mode pushed by white noise of strength q
    // settles to an amplitude variance of q^2 / (4 G omega^2) (G its damping),
    // so q is chosen per mode to give the target spectrum: slope variance
    // spread log-normally about one wavelength, scaled so the surface's rms
    // slope comes out at the configured value.
    //
    // "Spread about one wavelength" means per step of wavelength, not per
    // mode. Shorter waves have many more modes (their number in a band grows
    // as k^2) and each carries k^2 more slope for the same height, so the
    // weight given to each mode's height is the target divided by k^4.
    // Without that the slope is carried by waves under half the intended
    // length, and the light on the sand flickers at their much higher rate.
    if (outlet) {
      const { slopeRms, wavelength, spread } = WATER.agitation;
      const k0 = (2 * Math.PI) / wavelength;
      const weight = new Float64Array(count);
      let total = 0;
      for (let q = 0; q < nz; q++) {
        for (let m = 0; m < nx; m++) {
          const k = Math.hypot(this.kx[m], this.kz[q]);
          if (k === 0) continue;
          const l = Math.log(k / k0) / spread;
          const w = Math.exp(-0.5 * l * l) / (k * k * k * k);
          weight[q * nx + m] = w;
          // Mean-square slope of cos(kx x) cos(kz z) with unit amplitude.
          const edges = (m === 0 ? 2 : 1) * (q === 0 ? 2 : 1);
          total += (w * k * k * edges) / 4;
        }
      }
      for (let q = 0; q < nz; q++) {
        for (let m = 0; m < nx; m++) {
          const idx = q * nx + m;
          if (weight[idx] === 0) continue;
          const k = Math.hypot(this.kx[m], this.kz[q]);
          // Share of the slope variance this mode carries, as an amplitude variance.
          const variance = (slopeRms * slopeRms * weight[idx]) / total;
          const w = Math.sqrt(this.omega2[idx]);
          const g = 0.5 * WATER.beta + WATER.filmDamping * k * Math.sqrt((NU_WATER * w) / 8);
          this.agitation[idx] = Math.sqrt(4 * g * this.omega2[idx] * variance);
        }
      }
    }

    // The filter outlet: a few small patches of the return stream, each driven
    // by its own noise.
    if (outlet) {
      const layout = new Rng(0x0071e7);
      for (let s = 0; s < WATER.outletPatches; s++) {
        const px = WATER.vortexCentre.x + layout.sym(WATER.outletRadius);
        const pz = WATER.vortexCentre.z + layout.sym(WATER.outletRadius);
        const shape = new Float32Array(count);
        const r = WATER.outletPatchRadius;
        for (let j = 0; j < nz; j++) {
          for (let i = 0; i < nx; i++) {
            const d2 = (this.worldX(i) - px) ** 2 + (this.worldZ(j) - pz) ** 2;
            if (d2 < r * r * 4) shape[j * nx + i] = Math.exp(-3 * (d2 / (r * r)));
          }
        }
        const modal = new Float64Array(count);
        this.project(shape, modal);
        this.outletShapes.push(modal);
        this.outletNoise.push({ y: 0, v: 0 });
      }
    }
  }

  index(ix: number, iz: number): number {
    return iz * this.nx + ix;
  }

  /** Grid cell containing a world x/z, clamped to the tank. */
  cellAt(x: number, z: number): { ix: number; iz: number } {
    const ix = clamp(Math.round((x - TANK_MIN_X) / this.dx), 0, this.nx - 1);
    const iz = clamp(Math.round((z - TANK_MIN_Z) / this.dz), 0, this.nz - 1);
    return { ix, iz };
  }

  worldX(ix: number): number {
    return TANK_MIN_X + ix * this.dx;
  }

  worldZ(iz: number): number {
    return TANK_MIN_Z + iz * this.dz;
  }

  /** Surface displacement from the still level at each node, in metres. */
  get height(): Float32Array {
    if (this.heightsStale) this.rebuildHeights();
    return this.h;
  }

  /** dh/dx at each node, exact for the modes (not a finite difference). */
  get slopeX(): Float32Array {
    if (this.slopesStale) this.rebuildSlopes();
    return this.gx;
  }

  /** dh/dz at each node. */
  get slopeZ(): Float32Array {
    if (this.slopesStale) this.rebuildSlopes();
    return this.gz;
  }

  /** Surface normals, packed xyz per node. */
  get normals(): Float32Array {
    if (this.slopesStale) this.rebuildSlopes();
    return this.n;
  }

  /** Surface height in world y at a point, bilinearly interpolated. */
  heightAt(x: number, z: number): number {
    const h = this.height;
    const fx = clamp((x - TANK_MIN_X) / this.dx, 0, this.nx - 1.001);
    const fz = clamp((z - TANK_MIN_Z) / this.dz, 0, this.nz - 1.001);
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const tx = fx - ix;
    const tz = fz - iz;
    const i00 = this.index(ix, iz);
    const i10 = i00 + 1;
    const i01 = i00 + this.nx;
    const i11 = i01 + 1;
    const a = h[i00] + (h[i10] - h[i00]) * tx;
    const b = h[i01] + (h[i11] - h[i01]) * tx;
    return TANK.waterY + a + (b - a) * tz;
  }

  /** Surface normal at a point, from the interpolated gradient. */
  normalAt(x: number, z: number, out: Vec3): Vec3 {
    const e = Math.max(this.dx, this.dz);
    const hL = this.heightAt(x - e, z);
    const hR = this.heightAt(x + e, z);
    const hD = this.heightAt(x, z - e);
    const hU = this.heightAt(x, z + e);
    const nx = -(hR - hL) / (2 * e);
    const nz = -(hU - hD) / (2 * e);
    const inv = 1 / Math.sqrt(nx * nx + 1 + nz * nz);
    out.x = nx * inv;
    out.y = inv;
    out.z = nz * inv;
    return out;
  }

  /**
   * Tell the water how the tank itself is accelerating. Everything the phone's
   * motion does to the water goes through here.
   */
  setTankAcceleration(ax: number, az: number): void {
    this.accelX = ax;
    this.accelZ = az;
  }

  /**
   * Push the surface — a pellet landing, a fish breaking the surface, a bubble
   * bursting. `strength` sets the surface velocity given at the centre; see
   * IMPULSE_SECONDS for its scale.
   */
  disturb(x: number, z: number, strength: number, radius: number): void {
    this.logTouch(x, z, strength, radius, TOUCH_PUSH);
    const r2 = radius * radius;
    const ixC = (x - TANK_MIN_X) / this.dx;
    const izC = (z - TANK_MIN_Z) / this.dz;
    const rx = Math.ceil(radius / this.dx);
    const rz = Math.ceil(radius / this.dz);
    const i0 = clamp(Math.floor(ixC - rx), 0, this.nx - 1);
    const i1 = clamp(Math.ceil(ixC + rx), 0, this.nx - 1);
    const j0 = clamp(Math.floor(izC - rz), 0, this.nz - 1);
    const j1 = clamp(Math.ceil(izC + rz), 0, this.nz - 1);
    for (let j = j0; j <= j1; j++) {
      const wz = this.worldZ(j) - z;
      for (let i = i0; i <= i1; i++) {
        const wx = this.worldX(i) - x;
        const d2 = wx * wx + wz * wz;
        if (d2 > r2) continue;
        // Gaussian falloff rather than a hard disc: a hard edge puts energy
        // into the shortest waves the grid holds and reads as a pixel artefact.
        const w = Math.exp(-3 * (d2 / r2));
        this.force[this.index(i, j)] += strength * w;
        this.forcePending = true;
      }
    }
  }

  /**
   * Move a volume of water at once: positive raises the surface, negative
   * leaves a hollow. For something that pushes the water aside rather than
   * setting it moving — a snout leaving the surface leaves a hollow where it
   * was, which fills in and sends out a ring. `volume` in cubic metres, spread
   * as the same bell shape disturb() uses.
   */
  displace(x: number, z: number, volume: number, radius: number): void {
    this.logTouch(x, z, volume, radius, TOUCH_LIFT);
    // The bell exp(-3 d^2 / r^2) holds pi r^2 / 3 of area under unit height.
    const peak = volume / ((Math.PI * radius * radius) / 3);
    const r2 = radius * radius;
    for (let j = 0; j < this.nz; j++) {
      const wz = this.worldZ(j) - z;
      if (wz * wz > r2) continue;
      for (let i = 0; i < this.nx; i++) {
        const wx = this.worldX(i) - x;
        const d2 = wx * wx + wz * wz;
        if (d2 > r2) continue;
        this.lift[this.index(i, j)] += peak * Math.exp(-3 * (d2 / r2));
        this.liftPending = true;
      }
    }
  }

  private logTouch(x: number, z: number, amount: number, radius: number, kind: number): void {
    const o = (this.touchCount % TOUCH_LOG) * TOUCH_FIELDS;
    this.touchLog[o] = x;
    this.touchLog[o + 1] = z;
    this.touchLog[o + 2] = amount;
    this.touchLog[o + 3] = radius;
    this.touchLog[o + 4] = this.timeAccum;
    this.touchLog[o + 5] = kind;
    this.touchCount++;
  }

  /**
   * Advance the surface. Accumulates real time and runs fixed steps, so the
   * water behaves identically at 30 and 120 fps.
   */
  step(dt: number): void {
    this.accumulator += dt;
    this.timeAccum += dt;
    let steps = 0;
    while (this.accumulator >= WATER.dt && steps < WATER.maxSubsteps) {
      // Disturbances are impulses, applied once. If no step runs this frame
      // (a very short dt) they are kept for the next one rather than dropped —
      // losing a pellet's splash because the frame was quick would be a bug.
      if (this.forcePending) this.applyImpulses();
      if (this.liftPending) this.applyLift();
      this.substep(WATER.dt);
      this.accumulator -= WATER.dt;
      steps++;
    }
    if (steps === WATER.maxSubsteps) {
      // Fell behind (a stall, or a background tab). Drop the backlog rather
      // than spend the next frame catching up on it.
      this.accumulator = 0;
    }
    if (steps > 0) {
      this.heightsStale = true;
      this.slopesStale = true;
    }
  }

  private applyLift(): void {
    const modal = this.rowsB;
    this.project(this.lift, modal);
    // Mode 0 is the mean level; moving water about does not change it.
    for (let k = 1; k < modal.length; k++) this.amp[k] += modal[k];
    this.lift.fill(0);
    this.liftPending = false;
  }

  private applyImpulses(): void {
    const modal = this.rowsB;
    this.project(this.force, modal);
    for (let k = 1; k < modal.length; k++) this.rate[k] += modal[k] * IMPULSE_SECONDS;
    this.force.fill(0);
    this.forcePending = false;
  }

  private substep(dt: number): void {
    const { amp, rate, omega2, m00, m01, m10, m11 } = this;

    // The outlet's noise: white noise through a resonant filter centred on the
    // outlet's frequency, so each patch flutters the way a turbulent stream
    // does — irregularly, in a band — rather than humming one note.
    const w0 = 2 * Math.PI * WATER.outletHz;
    const damping = w0 / WATER.outletQ;
    const kick = Math.sqrt(dt) * w0 * Math.sqrt(damping);
    for (const noise of this.outletNoise) {
      noise.v += (-w0 * w0 * noise.y - damping * noise.v) * dt + kick * this.rng.normal();
      noise.y += noise.v * dt;
    }

    // Forcing enters as a shift of each mode's resting point: over one step a
    // steady push F moves the equilibrium to F / omega^2, and the exact
    // oscillator solution is applied about that.
    const tx = -this.accelX / GRAVITY;
    const tz = -this.accelZ / GRAVITY;
    const tilted = tx !== 0 || tz !== 0;
    const shapes = this.outletShapes;
    const noises = this.outletNoise;
    const gain = WATER.outletAccel;
    for (let k = 1; k < amp.length; k++) {
      // A tilt's resting shape is the tilted plane itself.
      let rest = tilted ? tx * this.tiltX[k] + tz * this.tiltZ[k] : 0;
      if (shapes.length > 0) {
        let push = 0;
        for (let s = 0; s < shapes.length; s++) push += shapes[s][k] * noises[s].y;
        rest += (push * gain) / omega2[k];
      }
      const a = amp[k] - rest;
      const v = rate[k];
      amp[k] = m00[k] * a + m01[k] * v + rest;
      rate[k] = m10[k] * a + m11[k] * v;
    }

    // The current's random push, as a velocity kick of white noise.
    if (this.outletShapes.length > 0) {
      const root = Math.sqrt(dt);
      const agitation = this.agitation;
      for (let k = 1; k < amp.length; k++) {
        if (agitation[k] > 0) rate[k] += agitation[k] * root * this.rng.normal();
      }
    }
  }

  /**
   * Nodal values to mode amplitudes: the discrete cosine transform that matches
   * this grid, whose first and last nodes sit on the walls.
   */
  private project(field: Float32Array, out: Float64Array): void {
    const { nx, nz, cosX, cosZ, rowsA } = this;
    // Along x, row by row, with the trapezoid weights that make the cosines
    // orthogonal on a grid with nodes on both walls.
    for (let j = 0; j < nz; j++) {
      const row = j * nx;
      let any = false;
      for (let i = 0; i < nx; i++) if (field[row + i] !== 0) { any = true; break; }
      if (!any) {
        for (let m = 0; m < nx; m++) rowsA[row + m] = 0;
        continue;
      }
      for (let m = 0; m < nx; m++) {
        const basis = m * nx;
        let sum = 0.5 * (field[row] * cosX[basis] + field[row + nx - 1] * cosX[basis + nx - 1]);
        for (let i = 1; i < nx - 1; i++) sum += field[row + i] * cosX[basis + i];
        const norm = m === 0 || m === nx - 1 ? nx - 1 : (nx - 1) / 2;
        rowsA[row + m] = sum / norm;
      }
    }
    // Then along z.
    for (let q = 0; q < nz; q++) {
      const basis = q * nz;
      const norm = q === 0 || q === nz - 1 ? nz - 1 : (nz - 1) / 2;
      for (let m = 0; m < nx; m++) {
        let sum = 0.5 * (rowsA[m] * cosZ[basis] + rowsA[(nz - 1) * nx + m] * cosZ[basis + nz - 1]);
        for (let j = 1; j < nz - 1; j++) sum += rowsA[j * nx + m] * cosZ[basis + j];
        out[q * nx + m] = sum / norm;
      }
    }
  }

  /** Mode amplitudes back to heights at the nodes. */
  private rebuildHeights(): void {
    const { nx, nz, amp, cosX, cosZ, rowsA, h } = this;
    // Along z first: rowsA[j][m] = sum over q of amp[q][m] cos(q, j).
    for (let j = 0; j < nz; j++) {
      for (let m = 0; m < nx; m++) rowsA[j * nx + m] = 0;
      for (let q = 0; q < nz; q++) {
        const c = cosZ[q * nz + j];
        const src = q * nx;
        const dst = j * nx;
        for (let m = 0; m < nx; m++) rowsA[dst + m] += amp[src + m] * c;
      }
    }
    // Then along x.
    for (let j = 0; j < nz; j++) {
      const row = j * nx;
      for (let i = 0; i < nx; i++) {
        let sum = 0;
        for (let m = 0; m < nx; m++) sum += rowsA[row + m] * cosX[m * nx + i];
        h[row + i] = sum;
      }
    }
    this.heightsStale = false;
  }

  /**
   * The slopes, differentiated through the modes, so they are exact rather
   * than a finite difference that flattens the shortest ripples by a third.
   * The caustics are made of those ripples' curvature, so it matters.
   */
  private rebuildSlopes(): void {
    const { nx, nz, amp, cosX, cosZ, sinX, sinZ, kx, kz, rowsA, rowsB, gx, gz, n } = this;
    for (let j = 0; j < nz; j++) {
      const dst = j * nx;
      for (let m = 0; m < nx; m++) {
        rowsA[dst + m] = 0;
        rowsB[dst + m] = 0;
      }
      for (let q = 0; q < nz; q++) {
        const c = cosZ[q * nz + j];
        const s = -kz[q] * sinZ[q * nz + j];
        const src = q * nx;
        for (let m = 0; m < nx; m++) {
          const a = amp[src + m];
          rowsA[dst + m] += a * c;
          rowsB[dst + m] += a * s;
        }
      }
    }
    for (let j = 0; j < nz; j++) {
      const row = j * nx;
      for (let i = 0; i < nx; i++) {
        let sx = 0;
        let sz = 0;
        for (let m = 0; m < nx; m++) {
          sx -= rowsA[row + m] * kx[m] * sinX[m * nx + i];
          sz += rowsB[row + m] * cosX[m * nx + i];
        }
        const k = row + i;
        gx[k] = sx;
        gz[k] = sz;
        const inv = 1 / Math.sqrt(sx * sx + 1 + sz * sz);
        n[k * 3] = -sx * inv;
        n[k * 3 + 1] = inv;
        n[k * 3 + 2] = -sz * inv;
      }
    }
    this.slopesStale = false;
  }

  /** Total water volume displacement — should stay near zero. Used by a test. */
  volumeError(): number {
    const h = this.height;
    let sum = 0;
    for (let k = 0; k < h.length; k++) sum += h[k];
    return (sum * this.dx * this.dz) / (TANK.width * TANK.depth);
  }

  get time(): number {
    return this.timeAccum;
  }
}


/**
 * Bulk water motion.
 *
 * A full 3D fluid solve does not fit in a phone's frame budget alongside
 * everything else, so this is an analytic field instead — but a
 * *divergence-free* one, which is the property that actually matters. Flow with
 * divergence makes suspended particles bunch up and thin out, and the eye reads
 * that as wrong immediately even when it cannot say why. Taking the curl of a
 * potential guarantees div(v) = 0 exactly, for free.
 *
 * Two components: a slow convection roll standing in for the filter outlet, and
 * curl noise for the wandering drift on top.
 */
/**
 * Bulk water motion.
 *
 * A full 3D fluid solve does not fit in a phone's frame budget alongside
 * everything else, so this is an analytic field instead — but a
 * *divergence-free* one, which is the property that actually matters. Flow with
 * divergence makes suspended particles bunch up and thin out, and the eye reads
 * that as wrong immediately even when it cannot say why. Taking the curl of a
 * potential guarantees div(v) = 0 exactly, for free.
 *
 * Two components: a slow horizontal circulation standing in for the filter
 * outlet, and curl noise for the wandering drift on top.
 *
 * ## Why it is cached on a grid
 *
 * Evaluating this directly is not cheap: the curl needs six finite differences
 * of a two-octave noise, so one sample costs twenty-four noise evaluations. It
 * is asked for once per fin node per substep, and with five fins, ninety nodes
 * each and four substeps that is eighteen hundred samples a frame — around a
 * third of a million hash evaluations, which measured at over half of the entire
 * frame budget.
 *
 * The field varies over centimetres and changes over seconds, so sampling it on
 * a coarse grid once a frame and interpolating loses nothing visible. Trilinear
 * interpolation of a divergence-free field is not exactly divergence-free, but
 * the error is second order in the cell size and far below anything that shows.
 */
export class BulkFlow {
  private t = 0;

  /** Cache resolution. Coarse: the field has no detail below this scale. */
  private static readonly NX = 14;
  private static readonly NY = 9;
  private static readonly NZ = 11;

  private readonly cache: Float32Array;
  private cacheTime = -1;

  constructor(private readonly seed = 0x1234) {
    this.cache = new Float32Array(BulkFlow.NX * BulkFlow.NY * BulkFlow.NZ * 3);
    this.rebuild();
  }

  step(dt: number): void {
    this.t += dt;
    // The field's own time scale is 0.15 Hz, so refreshing at 20 Hz is far more
    // often than anything in it can change.
    if (this.t - this.cacheTime > 0.05) this.rebuild();
  }

  private rebuild(): void {
    const { NX, NY, NZ } = BulkFlow;
    const out = { x: 0, y: 0, z: 0 };
    let o = 0;
    for (let k = 0; k < NZ; k++) {
      const z = TANK_MIN_Z + (k / (NZ - 1)) * TANK.depth;
      for (let j = 0; j < NY; j++) {
        const y = TANK.floorY + (j / (NY - 1)) * (TANK.waterY - TANK.floorY);
        for (let i = 0; i < NX; i++) {
          const x = TANK_MIN_X + (i / (NX - 1)) * TANK.width;
          this.evaluate(x, y, z, out);
          this.cache[o++] = out.x;
          this.cache[o++] = out.y;
          this.cache[o++] = out.z;
        }
      }
    }
    this.cacheTime = this.t;
  }

  /** Water velocity at a point, in m/s. Trilinearly interpolated from the cache. */
  sample(x: number, y: number, z: number, out: Vec3): Vec3 {
    const { NX, NY, NZ } = BulkFlow;
    const fx = clamp(((x - TANK_MIN_X) / TANK.width) * (NX - 1), 0, NX - 1.001);
    const fy = clamp(
      ((y - TANK.floorY) / Math.max(1e-4, TANK.waterY - TANK.floorY)) * (NY - 1),
      0,
      NY - 1.001,
    );
    const fz = clamp(((z - TANK_MIN_Z) / TANK.depth) * (NZ - 1), 0, NZ - 1.001);

    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const iz = Math.floor(fz);
    const tx = fx - ix;
    const ty = fy - iy;
    const tz = fz - iz;

    const at = (i: number, j: number, k: number, c: number): number =>
      this.cache[((k * NY + j) * NX + i) * 3 + c];

    for (let c = 0; c < 3; c++) {
      const c000 = at(ix, iy, iz, c);
      const c100 = at(ix + 1, iy, iz, c);
      const c010 = at(ix, iy + 1, iz, c);
      const c110 = at(ix + 1, iy + 1, iz, c);
      const c001 = at(ix, iy, iz + 1, c);
      const c101 = at(ix + 1, iy, iz + 1, c);
      const c011 = at(ix, iy + 1, iz + 1, c);
      const c111 = at(ix + 1, iy + 1, iz + 1, c);
      const a = (c000 + (c100 - c000) * tx) + ((c010 + (c110 - c010) * tx) - (c000 + (c100 - c000) * tx)) * ty;
      const b = (c001 + (c101 - c001) * tx) + ((c011 + (c111 - c011) * tx) - (c001 + (c101 - c001) * tx)) * ty;
      const v = a + (b - a) * tz;
      if (c === 0) out.x = v;
      else if (c === 1) out.y = v;
      else out.z = v;
    }
    return out;
  }

  /** The analytic field, evaluated directly. Used to fill the cache, and by tests. */
  evaluate(x: number, y: number, z: number, out: Vec3): Vec3 {
    // --- Rankine vortex about a vertical axis at the filter outlet ---
    const dx = x - WATER.vortexCentre.x;
    const dz = z - WATER.vortexCentre.z;
    const r = Math.sqrt(dx * dx + dz * dz);
    let vt: number;
    if (r < 1e-5) {
      vt = 0;
    } else if (r < WATER.vortexCoreRadius) {
      // Solid-body rotation inside the core: speed grows linearly with radius.
      vt = WATER.vortexPeakSpeed * (r / WATER.vortexCoreRadius);
    } else {
      // Free vortex outside: speed falls as 1/r, so circulation is conserved.
      vt = (WATER.vortexPeakSpeed * WATER.vortexCoreRadius) / r;
    }

    // Purely horizontal circulation.
    //
    // The tempting thing is to add a vertical component so the roll "actually
    // circulates" rather than spinning in a plane. It cannot be done this way: a
    // vertical velocity that varies with height has a non-zero divergence, and
    // the whole reason for building the flow analytically was to guarantee it
    // has none. Vertical motion comes from the curl noise below, where it is
    // free.
    const inv = r > 1e-5 ? 1 / r : 0;
    // Depth falloff: the outlet stirs the upper water more than the bottom. It
    // depends only on y, so the horizontal divergence stays exactly zero.
    const depthFactor = clamp((y - TANK.floorY) / Math.max(1e-4, WATER_DEPTH), 0, 1);
    const df = 0.35 + 0.65 * depthFactor;
    let vx = -dz * inv * vt * df;
    let vy = 0;
    let vz = dx * inv * vt * df;

    // --- Curl noise ---
    const s = 1 / WATER.curlScale;
    const tt = this.t * WATER.curlTimeHz;
    // The finite-difference step has to be small compared with the noise's own
    // length scale, or the result is the curl of a heavily smoothed potential
    // and no longer divergence-free at the scale things are advected at.
    const e = 0.02 * WATER.curlScale;

    const psi = (px: number, py: number, pz: number, comp: number): number =>
      fbm3(px * s, py * s + tt, pz * s, this.seed + comp * 7919);

    const dpsiZ_dy = (psi(x, y + e, z, 2) - psi(x, y - e, z, 2)) / (2 * e);
    const dpsiY_dz = (psi(x, y, z + e, 1) - psi(x, y, z - e, 1)) / (2 * e);
    const dpsiX_dz = (psi(x, y, z + e, 0) - psi(x, y, z - e, 0)) / (2 * e);
    const dpsiZ_dx = (psi(x + e, y, z, 2) - psi(x - e, y, z, 2)) / (2 * e);
    const dpsiY_dx = (psi(x + e, y, z, 1) - psi(x - e, y, z, 1)) / (2 * e);
    const dpsiX_dy = (psi(x, y + e, z, 0) - psi(x, y - e, z, 0)) / (2 * e);

    const a = WATER.curlAmplitude * WATER.curlScale;
    vx += a * (dpsiZ_dy - dpsiY_dz);
    vy += a * (dpsiX_dz - dpsiZ_dx);
    vz += a * (dpsiY_dx - dpsiX_dy);

    out.x = vx;
    out.y = vy;
    out.z = vz;
    return out;
  }
}
