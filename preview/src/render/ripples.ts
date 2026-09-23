/**
 * The fine ripples: what a touch on the water sends out.
 *
 * The simulated surface (sim/water.ts) has 4.4 mm between grid nodes, which is
 * plenty for the slosh of the tank and the gentle swell the filter keeps up,
 * but not for the rings a fish's gulp or a bursting bubble makes. Those are
 * about a centimetre from crest to crest, and it is exactly ripples that
 * short that bring light to a focus within the few centimetres down to the
 * sand. A grid needs several points per wavelength to hold a wave, so on the
 * coarse grid they were smeared out before they could throw any light.
 *
 * This layer runs on the graphics card, on a grid of 1.4 mm, the way Evan
 * Wallace's WebGL water demo does. It is a plain wave equation, which moves
 * every wave at one speed, and here that is not a shortcut: ripples from one
 * to three centimetres long all travel at 23 to 25 cm/s in real water (where
 * surface tension and gravity balance), so a single speed of 24 cm/s is right
 * for all the ones that matter. They die away at the rate the surface film
 * damps them: a one-centimetre ripple loses half its height in a fifth of a
 * second, a three-centimetre one in about a second.
 *
 * Every disturbance of the simulated surface is replayed here (the surface
 * keeps a log), minus the broad part of it the coarse grid already carries,
 * so nothing is counted twice. It is only for drawing: the fish and the food
 * feel the coarse surface, and these rings are far too small to matter to
 * them.
 */

import { TANK, TANK_MIN_X, TANK_MIN_Z } from '../sim/config.js';
import { IMPULSE_SECONDS, TOUCH_FIELDS, TOUCH_LIFT, TOUCH_LOG, WaterSurface } from '../sim/water.js';
import { createProgram, createRenderTarget, Mesh, Program, RenderTarget } from './gl.js';
import { BLUR_VERT, RIPPLE_RESOLVE_FRAG, RIPPLE_STEP_FRAG } from './shaders.js';

export const RIPPLES = {
  /** Grid size: 1.37 mm between points across the width, and the same in depth. */
  nx: 256,
  nz: 183,
  /** The speed of centimetre ripples, m/s. */
  speed: 0.24,
  /**
   * Damping of the velocity's curvature, m^2/s. A wave loses height at
   * nu k^2 / 2 per second, which with this value matches the surface film's
   * damping (see WATER.filmDamping) at two centimetres, and is about a third
   * more at one centimetre and a fifth less at three.
   */
  viscosity: 1.8e-5,
  /** The slow loss every wave has, per second (half of WATER.beta). */
  decay: 0.225,
  /** Step, s. About half the grid's stability limit of 4 ms at this speed. */
  dt: 1 / 480,
  /** Disturbances applied in one step, at most. */
  maxTouches: 16,
} as const;

/** How fine a feature the coarse surface can hold, as a Gaussian width, m. */
const COARSE_SIGMA = TANK.width / 79;

export class RippleLayer {
  /** r: height (mm), g: dh/dx, b: dh/dz, sampled with filtering. */
  get texture(): WebGLTexture {
    return this.output.texture;
  }

  private readonly states: [RenderTarget, RenderTarget];
  private readonly output: RenderTarget;
  private readonly stepProgram: Program;
  private readonly resolveProgram: Program;
  private current = 0;
  private clock = -1;
  private cursor = 0;
  private readonly touchA = new Float32Array(RIPPLES.maxTouches * 4);
  private readonly touchB = new Float32Array(RIPPLES.maxTouches * 4);

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly water: WaterSurface,
    private readonly quad: Mesh,
  ) {
    const make = (): RenderTarget =>
      createRenderTarget(gl, RIPPLES.nx, RIPPLES.nz, gl.RGBA32F, gl.RGBA, gl.FLOAT, gl.NEAREST);
    this.states = [make(), make()];
    this.output = createRenderTarget(gl, RIPPLES.nx, RIPPLES.nz, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT);
    for (const t of [...this.states, this.output]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.framebuffer);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.stepProgram = createProgram(gl, BLUR_VERT, RIPPLE_STEP_FRAG, 'ripple step');
    this.resolveProgram = createProgram(gl, BLUR_VERT, RIPPLE_RESOLVE_FRAG, 'ripple resolve');
    this.cursor = water.touchCount;
  }

  /** Bring the ripples up to the surface's own clock. */
  update(): void {
    const gl = this.gl;
    const target = this.water.time;
    // Start from now, and skip a long gap (a paused tab) rather than catch up
    // on it; either way, touches from before the clock are dropped, not piled
    // into one step.
    if (this.clock < 0 || target < this.clock) this.clock = target;
    if (target - this.clock > 1) this.clock = target - 1;
    this.cursor = Math.max(this.cursor, this.water.touchCount - TOUCH_LOG);
    const log = this.water.touchLog;
    while (this.cursor < this.water.touchCount && log[(this.cursor % TOUCH_LOG) * TOUCH_FIELDS + 4] < this.clock) {
      this.cursor++;
    }

    const cellX = TANK.width / RIPPLES.nx;
    const cellZ = TANK.depth / RIPPLES.nz;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.viewport(0, 0, RIPPLES.nx, RIPPLES.nz);
    gl.useProgram(this.stepProgram.program);
    const u = this.stepProgram.uniforms;
    gl.uniform2f(u.uCell!, cellX, cellZ);
    gl.uniform2f(u.uOrigin!, TANK_MIN_X, TANK_MIN_Z);
    gl.uniform1f(u.uDt!, RIPPLES.dt);
    gl.uniform1f(u.uSpeed2!, RIPPLES.speed * RIPPLES.speed);
    gl.uniform1f(u.uViscosity!, RIPPLES.viscosity);
    gl.uniform1f(u.uDecay!, RIPPLES.decay);

    let stepped = false;
    while (this.clock + RIPPLES.dt <= target) {
      const end = this.clock + RIPPLES.dt;
      const count = this.gatherTouches(end);
      gl.uniform1i(u.uTouchCount!, count);
      if (count > 0) {
        gl.uniform4fv(u.uTouchA!, this.touchA);
        gl.uniform4fv(u.uTouchB!, this.touchB);
      }
      const from = this.states[this.current];
      const to = this.states[1 - this.current];
      gl.bindFramebuffer(gl.FRAMEBUFFER, to.framebuffer);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, from.texture);
      gl.uniform1i(u.uState!, 0);
      this.quad.draw();
      this.current = 1 - this.current;
      this.clock = end;
      stepped = true;
    }
    if (!stepped) return;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.output.framebuffer);
    gl.useProgram(this.resolveProgram.program);
    const r = this.resolveProgram.uniforms;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.states[this.current].texture);
    gl.uniform1i(r.uState!, 0);
    gl.uniform2f(r.uCell!, cellX, cellZ);
    this.quad.draw();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * The touches made before `end` that have not been applied yet, as uniforms.
   * Each is the Gaussian the coarse surface was given, less a wider one of the
   * same volume: the broad part is the coarse grid's to carry.
   */
  private gatherTouches(end: number): number {
    const log = this.water.touchLog;
    let n = 0;
    while (this.cursor < this.water.touchCount && n < RIPPLES.maxTouches) {
      const o = (this.cursor % TOUCH_LOG) * TOUCH_FIELDS;
      if (log[o + 4] >= end) break;
      // disturb() uses exp(-3 d^2 / r^2), a Gaussian of variance r^2 / 6.
      const s2 = (log[o + 3] * log[o + 3]) / 6;
      const w2 = s2 + COARSE_SIGMA * COARSE_SIGMA;
      this.touchA[n * 4] = log[o];
      this.touchA[n * 4 + 1] = log[o + 1];
      const lift = log[o + 5] === TOUCH_LIFT;
      // A push gives the surface a speed at the centre, in mm/s; a
      // displacement raises it by a height there, in mm (volume over the
      // bell's area, 2 pi s^2).
      this.touchA[n * 4 + 2] = lift
        ? (log[o + 2] / (2 * Math.PI * s2)) * 1000
        : log[o + 2] * IMPULSE_SECONDS * 1000;
      this.touchA[n * 4 + 3] = 0.5 / s2;
      this.touchB[n * 4] = 0.5 / w2;
      this.touchB[n * 4 + 1] = s2 / w2;
      this.touchB[n * 4 + 2] = lift ? 1 : 0;
      this.cursor++;
      n++;
    }
    return n;
  }
}
