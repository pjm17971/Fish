/**
 * The water: a height field for the surface, and an analytic divergence-free
 * field for bulk flow.
 *
 * The surface is a damped wave equation solved explicitly on a grid. The wave
 * speed is not a tuning knob — it is sqrt(g * depth), the shallow-water result —
 * which is what makes the tank slosh with the period a tank of this size really
 * has. See test `water.slosh`.
 */

import { GRAVITY, TANK, WATER, WATER_DEPTH, TANK_MIN_X, TANK_MIN_Z } from './config.js';
import { fbm3 } from './rng.js';
import { clamp, Vec3 } from './math.js';

export class WaterSurface {
  readonly nx: number;
  readonly nz: number;
  readonly dx: number;
  readonly dz: number;

  /** Surface displacement from the still level, in metres. */
  readonly height: Float32Array;
  /** Rate of change of displacement. */
  readonly vel: Float32Array;
  /** Forcing accumulated during a frame, applied at the next substep. */
  private readonly force: Float32Array;
  /** Scratch for the Laplacian of the velocity field. */
  private readonly lapV: Float32Array;

  /** Surface normals, packed xyz per cell. Rebuilt after each frame's substeps. */
  readonly normals: Float32Array;

  private accumulator = 0;
  private timeAccum = 0;
  /** Simulated time advanced per substep, for the continuous outlet forcing. */
  private substepTime = 0;
  /** Cells under the filter outlet, with their Gaussian weights. */
  private readonly outletCells: Int32Array;
  private readonly outletWeights: Float32Array;

  /** Linear acceleration of the tank in world space, gravity already removed. */
  private accelX = 0;
  private accelZ = 0;

  /**
   * @param outlet Whether the filter outlet runs. On in the tank; the tests
   *   that compare the surface against the analytic wave equation turn it off,
   *   because a surface with a source in it is never still and never fully
   *   decays, and those tests are about the equation, not the tank.
   */
  constructor(nx = WATER.nx, nz = WATER.nz, private readonly outlet = true) {
    this.nx = nx;
    this.nz = nz;
    this.dx = TANK.width / (nx - 1);
    this.dz = TANK.depth / (nz - 1);
    const n = nx * nz;
    this.height = new Float32Array(n);
    this.vel = new Float32Array(n);
    this.force = new Float32Array(n);
    this.lapV = new Float32Array(n);
    this.normals = new Float32Array(n * 3);
    this.rebuildNormals();

    // Confirm the CFL condition holds for the grid we actually built, rather
    // than trusting the number written in the spec. An unstable water surface
    // does not look wrong, it explodes, and it is worth failing loudly.
    const c = WATER.waveSpeed;
    // Two explicit-stability conditions have to hold, and only checking the
    // obvious one is a trap: the surface then behaves perfectly well in gentle
    // conditions and goes to NaN the moment it is shaken hard.
    //
    // Both are stated in terms of the largest eigenvalue of the discrete
    // Laplacian, which for the five-point stencil on this grid is
    // 4/dx^2 + 4/dz^2 — the shortest wavelength the grid can hold.
    const invDx2 = 1 / (this.dx * this.dx);
    const invDz2 = 1 / (this.dz * this.dz);
    const lambdaMax = 4 * (invDx2 + invDz2);

    // 1. The wave term: the CFL condition.
    const courant = c * WATER.dt * Math.sqrt(invDx2 + invDz2);
    if (courant > 0.9) {
      throw new Error(
        `Water timestep ${WATER.dt}s violates the CFL condition (Courant number ` +
          `${courant.toFixed(3)}, must stay below 1) for a ${nx}x${nz} grid at ` +
          `c=${c.toFixed(3)} m/s. Lower WATER.dt or coarsen the grid.`,
      );
    }

    // 2. The damping terms, which share the velocity update with the wave term.
    //
    // Writing the scheme as a two-by-two amplification matrix per Fourier mode
    // gives a determinant of exactly (1 - b), where b = dt*(alpha*c*lambda +
    // beta). Once b passes 1 the velocity damping overshoots — it reverses the
    // velocity and makes it larger — and the shortest wavelength on the grid
    // grows by about 19% per step. That is not a subtle drift; it reaches
    // infinity in under a second.
    const b = WATER.dt * (WATER.alpha * c * lambdaMax + WATER.beta);
    if (b > 0.8) {
      throw new Error(
        `Water damping is unstable: dt*(alpha*c*lambda_max + beta) = ${b.toFixed(3)}, ` +
          `which must stay well below 1. Lower WATER.alpha, WATER.beta or WATER.dt.`,
      );
    }
    // The filter outlet's footprint on the grid, computed once. The forcing
    // runs every substep, so the cells it touches and their weights are worth
    // having ready.
    {
      const cells: number[] = [];
      const weights: number[] = [];
      const r = WATER.outletRadius;
      const cx = WATER.vortexCentre.x;
      const cz = WATER.vortexCentre.z;
      for (let j = 0; j < this.nz; j++) {
        const wz = this.worldZ(j) - cz;
        for (let i = 0; i < this.nx; i++) {
          const wx = this.worldX(i) - cx;
          const d2 = wx * wx + wz * wz;
          if (d2 > r * r) continue;
          cells.push(this.index(i, j));
          weights.push(Math.exp(-3 * (d2 / (r * r))));
        }
      }
      this.outletCells = Int32Array.from(cells);
      this.outletWeights = Float32Array.from(weights);
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

  /** Surface height in world y at a point, bilinearly interpolated. */
  heightAt(x: number, z: number): number {
    const fx = clamp((x - TANK_MIN_X) / this.dx, 0, this.nx - 1.001);
    const fz = clamp((z - TANK_MIN_Z) / this.dz, 0, this.nz - 1.001);
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const tx = fx - ix;
    const tz = fz - iz;
    const h = this.height;
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
   * Add an impulse to the surface velocity — a pellet landing, a fish breaking
   * the surface. `strength` is in metres per second of surface velocity.
   */
  disturb(x: number, z: number, strength: number, radius: number): void {
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
        // Gaussian falloff rather than a hard disc: a hard-edged impulse rings
        // at the grid frequency and looks like a pixel artefact, not a splash.
        const w = Math.exp(-3 * (d2 / r2));
        this.force[this.index(i, j)] += strength * w;
      }
    }
  }

  /**
   * Advance the surface. Accumulates real time and runs fixed substeps, so the
   * water behaves identically at 30 and 120 fps.
   */
  step(dt: number): void {
    this.accumulator += dt;
    this.timeAccum += dt;
    let steps = 0;
    while (this.accumulator >= WATER.dt && steps < WATER.maxSubsteps) {
      // Disturbances are impulses, so they are applied on the first substep of
      // the frame only. If no substep runs this frame (a very short dt) the
      // forcing is kept and applied next time rather than thrown away — losing
      // a pellet's splash because the frame was quick would be a real bug.
      this.substep(WATER.dt, steps === 0);
      this.accumulator -= WATER.dt;
      steps++;
    }
    if (steps === WATER.maxSubsteps) {
      // We fell behind (a stall, or a background tab). Drop the backlog rather
      // than spiral: catching up on a long gap is what turns a hitch into an
      // explosion.
      this.accumulator = 0;
    }
    if (steps > 0) {
      this.force.fill(0);
      this.rebuildNormals();
    }
  }

  private substep(dt: number, applyForcing: boolean): void {
    const { nx, nz, height: h, vel: v, force: f, lapV } = this;
    this.substepTime += dt;

    // The filter outlet. A continuous source, so it is applied every substep
    // rather than as a per-frame impulse, which would make the ripple height
    // depend on the frame rate. Two slow modulations keep it from being a pure
    // tone: a real return stream flutters.
    if (this.outlet) {
      const t = this.substepTime;
      const flutter = 0.7 + 0.3 * Math.sin(2 * Math.PI * 0.23 * t + 1.0);
      const hz = WATER.outletRippleHz * (1 + 0.08 * Math.sin(2 * Math.PI * 0.11 * t));
      const a = WATER.outletRippleAccel * flutter * Math.sin(2 * Math.PI * hz * t) * dt;
      for (let n = 0; n < this.outletCells.length; n++) {
        v[this.outletCells[n]] += a * this.outletWeights[n];
      }
    }
    const c2 = WATER.waveSpeed * WATER.waveSpeed;
    const invDx2 = 1 / (this.dx * this.dx);
    const invDz2 = 1 / (this.dz * this.dz);
    const invG = 1 / GRAVITY;

    // Laplacian of the velocity field, for the viscous term. Computed into its
    // own buffer first because the velocity update below reads neighbours.
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        // Neumann (reflecting) boundaries: mirror the edge cell. This is what
        // makes water pile up against a wall when the tank is tilted, instead
        // of leaking out of the domain.
        const l = v[i > 0 ? k - 1 : k];
        const r = v[i < nx - 1 ? k + 1 : k];
        const d = v[j > 0 ? k - nx : k];
        const u = v[j < nz - 1 ? k + nx : k];
        lapV[k] = (l + r - 2 * v[k]) * invDx2 + (d + u - 2 * v[k]) * invDz2;
      }
    }

    for (let j = 0; j < nz; j++) {
      const wz = TANK_MIN_Z + j * this.dz;
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        const wx = TANK_MIN_X + i * this.dx;

        const l = h[i > 0 ? k - 1 : k];
        const r = h[i < nx - 1 ? k + 1 : k];
        const d = h[j > 0 ? k - nx : k];
        const u = h[j < nz - 1 ? k + nx : k];
        const lapH = (l + r - 2 * h[k]) * invDx2 + (d + u - 2 * h[k]) * invDz2;

        // Sloshing. Accelerating the tank tilts the effective gravity; the
        // equilibrium surface is the plane perpendicular to it, which to first
        // order is this. We push the surface towards it rather than snapping,
        // and the lag and overshoot that produces is what reads as liquid.
        const uEq = -(this.accelX * wx + this.accelZ * wz) * invG;

        const accel =
          c2 * lapH +
          WATER.alpha * WATER.waveSpeed * lapV[k] -
          WATER.beta * v[k] +
          WATER.sloshStiffness * (uEq - h[k]) +
          (applyForcing ? f[k] : 0);

        v[k] += accel * dt;
      }
    }

    for (let k = 0; k < h.length; k++) {
      h[k] += v[k] * dt;
    }
  }

  private rebuildNormals(): void {
    const { nx, nz, height: h, normals: n } = this;
    const sx = 1 / (2 * this.dx);
    const sz = 1 / (2 * this.dz);
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        const l = h[i > 0 ? k - 1 : k];
        const r = h[i < nx - 1 ? k + 1 : k];
        const d = h[j > 0 ? k - nx : k];
        const u = h[j < nz - 1 ? k + nx : k];
        const gx = -(r - l) * sx;
        const gz = -(u - d) * sz;
        const inv = 1 / Math.sqrt(gx * gx + 1 + gz * gz);
        n[k * 3] = gx * inv;
        n[k * 3 + 1] = inv;
        n[k * 3 + 2] = gz * inv;
      }
    }
  }

  /** Total water volume displacement — should stay near zero. Used by a test. */
  volumeError(): number {
    let sum = 0;
    for (let k = 0; k < this.height.length; k++) sum += this.height[k];
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
