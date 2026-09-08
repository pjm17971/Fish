/**
 * Hydrodynamics and rigid-body motion.
 *
 * The contract for this file: **nothing here ever sets the fish's velocity.**
 * The brain sends down a tail-beat frequency, an amplitude and a bend; those
 * shape the body; the shape pushes water; the water pushes back; and the fish's
 * speed is whatever comes out of that. That is the difference between a
 * simulation and an animation, and it is what makes the emergent Strouhal number
 * in `locomotion.test.ts` mean something.
 *
 * Three force families act on every body segment and every fin element:
 *
 *  - **Reactive (added mass).** A slender body pushing sideways drags a cylinder
 *    of water along with it, of mass (pi/4)*rho*depth^2 per unit length. The
 *    force is the rate of change of that water's momentum. This is the discrete
 *    form of Lighthill's elongated-body theory: the momentum the tail throws
 *    into the wake is the momentum the fish gains forwards.
 *
 *  - **Resistive (cross-flow drag).** A segment held at an angle to its own
 *    motion sheds vortices and feels quadratic drag normal to its surface. On a
 *    travelling wave whose wave speed exceeds the swimming speed, this
 *    integrates to net thrust — Taylor's resistive theory.
 *
 *  - **Skin friction.** Tangential, from the boundary layer. Blasius laminar
 *    flat-plate friction with a Hoerner form factor for the body's thickness.
 *
 * At a 3 Hz tail beat all three come out the same order of magnitude, which is
 * the sign the model is balanced rather than dominated by one fudged term.
 */

import {
  Vec3,
  Quat,
  v3,
  quat,
  set,
  copy,
  add,
  sub,
  scale,
  addScaled,
  cross,
  dot,
  len,
  clamp,
  quatRotate,
  quatRotateInv,
  quatIntegrate,
  quatNormalize,
} from './math.js';
import {
  FISH,
  PECTORAL,
  RHO_WATER,
  NU_WATER,
  GRAVITY,
  TANK,
  TANK_MIN_X,
  TANK_MAX_X,
  TANK_MIN_Z,
  TANK_MAX_Z,
} from './config.js';
import { Morphology } from './morphology.js';
import { FishBody, MotorCommand, pectoralPose } from './fishBody.js';
import { WaterSurface, BulkFlow } from './water.js';

/** A force applied at a point, used to report contributions for debugging and tests. */
export interface ForceBreakdown {
  reactive: Vec3;
  crossFlow: Vec3;
  friction: Vec3;
  pectoral: Vec3;
  fin: Vec3;
  buoyancy: Vec3;
  contact: Vec3;
}

const scratch = {
  worldPos: v3(),
  worldVel: v3(),
  rel: v3(),
  n: v3(),
  t: v3(),
  up: v3(),
  r: v3(),
  flow: v3(),
  f: v3(),
  tq: v3(),
  tmp: v3(),
  tmp2: v3(),
  bodyF: v3(),
  bodyT: v3(),
  bladeC: v3(),
  bladeN: v3(),
  bladeV: v3(),
  eyeTmp: v3(),
};

interface SegmentWork {
  /** Offset from the centre of mass, world space. */
  rWorld: Vec3;
  /** World position. */
  posWorld: Vec3;
  /** World-space lateral normal and tangent. */
  n: Vec3;
  t: Vec3;
  /** Normal velocity relative to the water, including rigid-body motion. */
  wFull: number;
  /** Normal velocity from the body's own bending alone. */
  wDeform: number;
  /**
   * Normal velocity from bending plus the fish's translation, but excluding its
   * rigid rotation. This is the quantity Lighthill's convective term is written
   * in: bending gives the dh/dt part, translation through an inclined body gives
   * the U*dh/ds part, and rotation belongs to neither — it is handled by the
   * added inertia in the mass matrix.
   *
   * Using the full relative velocity here instead makes a rigidly rotating body
   * drive its own rotation: its normal velocity varies linearly along its length
   * even with no bending at all, so the convective term reads that as a huge
   * gradient. A fish that stopped swimming span up to the angular clamp and
   * stayed there. Using only the bending part removes that but also removes the
   * genuine speed-dependent drag the term carries, and the fish comes out about
   * 70% too efficient. Translation-without-rotation is the quantity the theory
   * actually calls for.
   */
  wSlender: number;
  /** Tangential velocity relative to the water. */
  vt: number;
}

const pecPose = {
  sweep: 0,
  pitch: 0,
  dSweepDPhase: 0,
  normal: v3(),
  velocityDir: v3(),
};

export class FishLocomotion {
  /** World position of the centre of mass. */
  readonly position = v3(0, -0.045, -0.12);
  /** Body-to-world rotation. */
  readonly orientation: Quat = quat();
  /** World linear velocity of the centre of mass. */
  readonly velocity = v3();
  /** World angular velocity. */
  readonly angularVelocity = v3();

  /** Swim-bladder volume as a multiple of the neutral-buoyancy volume. */
  bladder = 1.0;

  /**
   * The walls the fish is confined by, or null for open water.
   *
   * Tests set this to null. That is not a convenience: with walls in place a
   * fish swimming in a straight line reaches the front glass in a couple of
   * seconds and is held there, while its velocity — which the contact spring
   * never fully kills — keeps reading as though it were still swimming. Every
   * speed measured that way is meaningless, and the numbers look plausible
   * enough to be believed.
   */
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number; floorY: number; ceilY: number } | null = {
    minX: TANK_MIN_X,
    maxX: TANK_MAX_X,
    minZ: TANK_MIN_Z,
    maxZ: TANK_MAX_Z,
    floorY: TANK.floorY,
    ceilY: TANK.waterY + FISH.maxDepth,
  };

  /** Per-segment deformation normal velocity from the previous substep. */
  private readonly prevVn: Float64Array;
  /** Reusable per-segment working set, so the force loops never allocate. */
  private readonly work: SegmentWork[] = [];
  private prevPecVnL = 0;
  private prevPecVnR = 0;
  private hasPrevVn = false;

  /** Force breakdown from the most recent substep. Diagnostics only. */
  readonly forces: ForceBreakdown = {
    reactive: v3(),
    crossFlow: v3(),
    friction: v3(),
    pectoral: v3(),
    fin: v3(),
    buoyancy: v3(),
    contact: v3(),
  };

  /** Net force and torque from the last substep. Diagnostics and the HUD. */
  readonly netForce = v3();
  readonly netTorque = v3();

  /** External force and torque accumulators, so fins can contribute. */
  private readonly externalForce = v3();
  private readonly externalTorque = v3();

  private accumulator = 0;

  /**
   * Integral of (lateral area * r^2 * |r|) over the body — the geometric part of
   * the quadratic rotational drag. Computed once, because the body's shape in
   * this respect barely changes as it bends.
   */
  private readonly rotationalDragFactor: number;

  constructor(
    private readonly morphology: Morphology,
    private readonly body: FishBody,
  ) {
    this.prevVn = new Float64Array(morphology.segments.length);
    for (let i = 0; i < morphology.segments.length; i++) {
      this.work.push({
        rWorld: v3(),
        posWorld: v3(),
        n: v3(),
        t: v3(),
        wFull: 0,
        wDeform: 0,
        wSlender: 0,
        vt: 0,
      });
    }
    let sum = 0;
    for (const seg of morphology.segments) {
      const r = seg.arc - morphology.comArc;
      sum += seg.lateralArea * r * r * Math.abs(r);
    }
    this.rotationalDragFactor = sum;
  }

  /** Fins and other outside contributors add world-space force at a world point. */
  applyForceAtPoint(force: Vec3, worldPoint: Vec3): void {
    add(this.externalForce, this.externalForce, force);
    sub(scratch.r, worldPoint, this.position);
    cross(scratch.tq, scratch.r, force);
    add(this.externalTorque, this.externalTorque, scratch.tq);
  }

  /** Fins add a world-space torque about the centre of mass. */
  applyTorque(torque: Vec3): void {
    add(this.externalTorque, this.externalTorque, torque);
  }

  /** Body-frame point to world space. */
  toWorld(local: Vec3, out: Vec3): Vec3 {
    quatRotate(out, this.orientation, local);
    return add(out, out, this.position);
  }

  /** Body-frame direction to world space. */
  dirToWorld(local: Vec3, out: Vec3): Vec3 {
    return quatRotate(out, this.orientation, local);
  }

  /** The fish's forward direction in world space. */
  forward(out: Vec3): Vec3 {
    return quatRotate(out, this.orientation, { x: 0, y: 0, z: 1 });
  }

  /** The fish's dorsal (up) direction in world space. */
  dorsal(out: Vec3): Vec3 {
    return quatRotate(out, this.orientation, { x: 0, y: 1, z: 0 });
  }

  /** The fish's right direction in world space. */
  right(out: Vec3): Vec3 {
    return quatRotate(out, this.orientation, { x: 1, y: 0, z: 0 });
  }

  /** Forward speed along the body axis (not the speed of the CoM through space). */
  get forwardSpeed(): number {
    this.forward(scratch.tmp);
    return dot(this.velocity, scratch.tmp);
  }

  get speed(): number {
    return len(this.velocity);
  }

  /**
   * Forward speed in body lengths per second: the component of velocity along
   * the fish's own axis. This is what the steering compares against its target
   * speed. Total speed is the wrong quantity there — a fish sinking at one body
   * length a second is not swimming, and treating it as though it were is how
   * the tail ends up switched off while the fish bobs.
   */
  get forwardSpeedSL(): number {
    return this.forwardSpeed / this.morphology.standardLength;
  }

  /** Speed in body lengths per second — the unit fish biology is written in. */
  /** Amplitude the muscles have actually reached. Diagnostics. */
  get bodyAmplitude(): number {
    return this.body.currentAmplitude;
  }

  get speedSL(): number {
    return len(this.velocity) / this.morphology.standardLength;
  }

  /**
   * Advance the fish. Accumulates elapsed time and runs fixed 4 ms substeps, so
   * behaviour is identical at any frame rate.
   */
  step(cmd: MotorCommand, water: WaterSurface | null, flow: BulkFlow | null, dt: number): void {
    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= FISH.dt && steps < FISH.maxSubsteps) {
      this.substep(cmd, water, flow, FISH.dt);
      this.accumulator -= FISH.dt;
      steps++;
    }
    if (steps === FISH.maxSubsteps) this.accumulator = 0;
  }

  private substep(cmd: MotorCommand, water: WaterSurface | null, flow: BulkFlow | null, dt: number): void {
    // 1. Reshape the body for this instant of the muscle command.
    this.body.shape(cmd, dt);
    this.body.stepPectorals(cmd, dt);

    // 2. Swim bladder slews towards its commanded volume. It is deliberately
    //    slow — about four seconds end to end — so the fish hangs slightly
    //    nose-up while it is trimming, as a real one does.
    const bladderTarget = 1.0 + cmd.bladder * 0.15;
    const slew = FISH.bladderSlewRate * (FISH.bladderRange[1] - FISH.bladderRange[0]);
    this.bladder = clamp(
      this.bladder + clamp(bladderTarget - this.bladder, -slew * dt, slew * dt),
      FISH.bladderRange[0],
      FISH.bladderRange[1],
    );

    // 3. Zero the accumulators.
    const F = set(scratch.f, 0, 0, 0);
    const T = set(scratch.tq, 0, 0, 0);
    for (const k of Object.keys(this.forces) as (keyof ForceBreakdown)[]) {
      set(this.forces[k], 0, 0, 0);
    }

    // 4. Body segments.
    this.accumulateBodyForces(F, T, flow, dt);

    // 5. Pectoral fins.
    this.accumulatePectoralForces(cmd, F, T, flow, dt);

    // 6. Weight and buoyancy.
    this.accumulateBuoyancy(F, T, water);

    // 7. Recoil from internal deformation, rotated into world space.
    quatRotate(scratch.tmp, this.orientation, this.body.recoilTorque);
    add(T, T, scratch.tmp);

    // 8. Contact with the glass and the substrate.
    this.accumulateContact(F, T);

    // 9. Anything the fin cloth contributed since the last substep.
    add(F, F, this.externalForce);
    add(T, T, this.externalTorque);
    copy(this.forces.fin, this.externalForce);
    set(this.externalForce, 0, 0, 0);
    set(this.externalTorque, 0, 0, 0);

    copy(this.netForce, F);
    copy(this.netTorque, T);

    // 10. Integrate.
    this.integrate(F, T, dt);
  }

  private accumulateBodyForces(F: Vec3, T: Vec3, flow: BulkFlow | null, dt: number): void {
    const segs = this.morphology.segments;
    const states = this.body.segments;
    const invDt = 1 / dt;
    const n = segs.length;

    // Skin friction coefficients are whole-body properties, evaluated once.
    const speed = Math.max(1e-4, len(this.velocity));
    const Re = (speed * this.morphology.standardLength) / NU_WATER;
    // Blasius laminar flat plate. At a 0.1 m/s cruise Re is about 5.4e3, well
    // inside the laminar range for a body this small — a fish this size never
    // gets a turbulent boundary layer.
    const Cf = 1.328 / Math.sqrt(Math.max(1, Re));
    // Hoerner form factor: a thick body has more than flat-plate friction
    // because the flow has to speed up around it.
    const tRatio = FISH.maxDepth / this.morphology.standardLength;
    const FF = 1 + 1.5 * Math.pow(tRatio, 1.5) + 7 * Math.pow(tRatio, 3);

    // --- Pass 1: relative velocity at every segment ---
    //
    // Two normal velocities are recorded per segment and they do different jobs:
    //
    //   wFull    the full normal velocity relative to the water. Drives the
    //            quadratic cross-flow drag, and its gradient along the body
    //            drives the convective part of the reactive force.
    //
    //   wDeform  the part coming from the body's own bending, with the fish's
    //            rigid-body motion excluded.
    //
    // Only wDeform is differentiated in time. That is the fix for a trap that
    // is easy to fall into and fatal when you do: the reactive force is
    // proportional to acceleration, so if you compute it from the *total*
    // normal acceleration and then apply it as a force, the force feeds back
    // into the acceleration that produced it. With added mass this large —
    // sideways it is about 2.5 times the fish's own mass — that loop has gain
    // well above one and the solver diverges within a second, regardless of
    // timestep. The rigid-body share of the reactive force is already accounted
    // for, exactly and implicitly, by the added mass sitting in the mass matrix
    // in `integrate`. Differentiating only the prescribed bending leaves an
    // explicit term that cannot feed back, because the bending is commanded
    // rather than solved for.
    for (let i = 0; i < n; i++) {
      const st = states[i];
      const w = this.work[i];

      quatRotate(scratch.r, this.orientation, st.pos);
      add(scratch.worldPos, this.position, scratch.r);
      copy(w.rWorld, scratch.r);
      copy(w.posWorld, scratch.worldPos);

      // Rigid-body velocity of this point.
      cross(scratch.worldVel, this.angularVelocity, scratch.r);
      add(scratch.worldVel, scratch.worldVel, this.velocity);
      // Deformation velocity of this point, in world space.
      quatRotate(scratch.tmp, this.orientation, st.velLocal);
      add(scratch.worldVel, scratch.worldVel, scratch.tmp);

      if (flow) {
        flow.sample(scratch.worldPos.x, scratch.worldPos.y, scratch.worldPos.z, scratch.flow);
        sub(scratch.rel, scratch.worldVel, scratch.flow);
      } else {
        copy(scratch.rel, scratch.worldVel);
      }

      quatRotate(w.n, this.orientation, st.normal);
      quatRotate(w.t, this.orientation, st.tangent);

      w.wFull = dot(scratch.rel, w.n);
      w.wDeform = dot(scratch.tmp, w.n);
      // Bending plus translation, without the rigid rotation.
      add(scratch.tmp2, scratch.tmp, this.velocity);
      if (flow) sub(scratch.tmp2, scratch.tmp2, scratch.flow);
      w.wSlender = dot(scratch.tmp2, w.n);
      w.vt = dot(scratch.rel, w.t);
    }

    // --- Pass 2: forces ---
    for (let i = 0; i < n; i++) {
      const seg = segs[i];
      const w = this.work[i];

      // Speed of the water flowing past the body, head to tail. The tangent
      // points tailward, so a fish swimming forwards has a negative tangential
      // relative velocity and a positive U.
      const U = -w.vt;

      // Gradient along the body of the *deformation* normal velocity. Central
      // difference on the interior, one-sided at the ends.
      //
      // The deformation part, not the full relative velocity. Using the full one
      // looks more faithful to Lighthill and is wrong here for the same reason
      // the time derivative uses the deformation part: the rigid-body share of
      // the flow is already accounted for by the added mass in the mass matrix,
      // so including it again produces force from nothing. Concretely, a body
      // rotating rigidly has a normal velocity that varies linearly along its
      // length, so the full gradient is large even with no bending at all — and
      // the resulting term drove the fish's spin instead of damping it. A fish
      // that stopped swimming pinned itself at the angular speed clamp and
      // stayed there indefinitely.
      const iPrev = Math.max(0, i - 1);
      const iNext = Math.min(n - 1, i + 1);
      const dArc = segs[iNext].arc - segs[iPrev].arc;
      const dwds =
        dArc > 1e-9 ? (this.work[iNext].wSlender - this.work[iPrev].wSlender) / dArc : 0;

      // Rate of change of the deforming body's normal velocity.
      //
      // The clamp is a real physical bound, not a large round number picked to
      // catch disasters. A tail tip beating at the fish's maximum 9 Hz through
      // its 4.8 mm amplitude peaks at (2*pi*9)^2 * 0.0048 = 15 m/s^2, so 80 is
      // already five times anything the animal can do. The first version used
      // 400, which sounds harmlessly generous and is not: the caudal segments
      // carry grams of added mass, so an unphysical spike there produced almost
      // a newton of force on a fish that weighs fifteen millinewtons, and a
      // single abrupt change of motor command sent it into a permanent spin.
      const dwdt = this.hasPrevVn ? clamp((w.wDeform - this.prevVn[i]) * invDt, -80, 80) : 0;
      this.prevVn[i] = w.wDeform;

      // Lighthill's material derivative, following a water particle as it slides
      // along the body: D/Dt = d/dt + U * d/ds. The convective term is what
      // makes thrust depend on forward speed as well as on tail motion, and it
      // is the reason the fish reaches a steady cruise instead of accelerating
      // without limit.
      const Dw = dwdt + U * dwds;
      const ma = seg.addedMassPerLength * seg.ds;
      const fReactive = -ma * Dw;

      // Quadratic cross-flow drag, normal to the body.
      const fCross =
        -0.5 * RHO_WATER * FISH.crossFlowCd * seg.lateralArea * Math.abs(w.wFull) * w.wFull;

      // Tangential skin friction.
      const fFric = -0.5 * RHO_WATER * Cf * FF * seg.wettedArea * Math.abs(w.vt) * w.vt;

      scale(scratch.tmp, w.n, fReactive);
      add(this.forces.reactive, this.forces.reactive, scratch.tmp);
      add(F, F, scratch.tmp);
      cross(scratch.tmp2, w.rWorld, scratch.tmp);
      add(T, T, scratch.tmp2);

      scale(scratch.tmp, w.n, fCross);
      add(this.forces.crossFlow, this.forces.crossFlow, scratch.tmp);
      add(F, F, scratch.tmp);
      cross(scratch.tmp2, w.rWorld, scratch.tmp);
      add(T, T, scratch.tmp2);

      scale(scratch.tmp, w.t, fFric);
      add(this.forces.friction, this.forces.friction, scratch.tmp);
      add(F, F, scratch.tmp);
      cross(scratch.tmp2, w.rWorld, scratch.tmp);
      add(T, T, scratch.tmp2);
    }
    this.hasPrevVn = true;
  }

  private accumulatePectoralForces(
    cmd: MotorCommand,
    F: Vec3,
    T: Vec3,
    flow: BulkFlow | null,
    dt: number,
  ): void {
    const invDt = 1 / dt;
    const chord = PECTORAL.area / PECTORAL.span;
    // Added mass of a flat plate moving broadside: rho * pi/4 * chord^2 per unit
    // span, times the span.
    const maBlade = RHO_WATER * (Math.PI / 4) * chord * chord * PECTORAL.span;

    for (let s = 0; s < 2; s++) {
      const side = s === 0 ? -1 : 1; // -1 left, +1 right
      const phase = s === 0 ? this.body.pectoralPhaseLeft : this.body.pectoralPhaseRight;
      // The slewed frequency, not the commanded one.
      const freq = s === 0 ? this.body.pectoralFrequencyLeft : this.body.pectoralFrequencyRight;

      // --- Braking ---
      //
      // The pectoral held broadside to the flow, as a flat plate. Quadratic
      // drag, applied at the fin's attachment so it also pitches the fish
      // nose-up slightly — which is what a braking fish visibly does.
      if (cmd.brake > 1e-3) {
        this.body.pectoralAttach(side, scratch.tmp);
        quatRotate(scratch.r, this.orientation, scratch.tmp);
        add(scratch.worldPos, this.position, scratch.r);
        cross(scratch.worldVel, this.angularVelocity, scratch.r);
        add(scratch.worldVel, scratch.worldVel, this.velocity);
        if (flow) {
          flow.sample(scratch.worldPos.x, scratch.worldPos.y, scratch.worldPos.z, scratch.flow);
          sub(scratch.rel, scratch.worldVel, scratch.flow);
        } else {
          copy(scratch.rel, scratch.worldVel);
        }
        const sp = len(scratch.rel);
        if (sp > 1e-4) {
          const mag = -0.5 * RHO_WATER * FISH.crossFlowCd * PECTORAL.area * cmd.brake * sp;
          scale(scratch.tmp, scratch.rel, mag);
          add(this.forces.pectoral, this.forces.pectoral, scratch.tmp);
          add(F, F, scratch.tmp);
          cross(scratch.tmp2, scratch.r, scratch.tmp);
          add(T, T, scratch.tmp2);
        }
      }

      // The fin still does something when it is not beating: held out at an
      // angle in moving water it is a control surface, and that is how the fish
      // pitches. Skipping it whenever the beat frequency was zero meant the fish
      // had no elevators at all.
      if (freq <= 1e-4 && Math.abs(cmd.pectoralPitch) < 1e-3) {
        if (s === 0) this.prevPecVnL = 0;
        else this.prevPecVnR = 0;
        continue;
      }

      const spread = 0.55 + 0.45 * cmd.finSpread;
      // How far out of its folded position the fin is: fully out by one beat a
      // second, folded flat along the flank when still.
      const rowing = Math.min(1, freq / 1.0);
      pectoralPose(phase, side, spread, cmd.pectoralPitch, rowing, pecPose);

      // Blade centre, half a span out from the attachment along the blade axis.
      this.body.pectoralAttach(side, scratch.tmp);
      const cs = Math.cos(pecPose.sweep);
      const ss = Math.sin(pecPose.sweep);
      set(scratch.bladeC, side * cs, 0, -ss);
      addScaled(scratch.tmp, scratch.bladeC, PECTORAL.span * 0.5);
      copy(scratch.bladeC, scratch.tmp); // body-frame blade centre

      // Blade velocity from the sweep, in the body frame. d(centre)/dt.
      const dSweep = 2 * Math.PI * freq * pecPose.dSweepDPhase;
      set(
        scratch.bladeV,
        side * -ss * dSweep * PECTORAL.span * 0.5,
        0,
        -cs * dSweep * PECTORAL.span * 0.5,
      );

      // To world.
      quatRotate(scratch.r, this.orientation, scratch.bladeC);
      add(scratch.worldPos, this.position, scratch.r);
      cross(scratch.worldVel, this.angularVelocity, scratch.r);
      add(scratch.worldVel, scratch.worldVel, this.velocity);
      quatRotate(scratch.tmp, this.orientation, scratch.bladeV);
      add(scratch.worldVel, scratch.worldVel, scratch.tmp);

      if (flow) {
        flow.sample(scratch.worldPos.x, scratch.worldPos.y, scratch.worldPos.z, scratch.flow);
        sub(scratch.rel, scratch.worldVel, scratch.flow);
      } else {
        copy(scratch.rel, scratch.worldVel);
      }

      quatRotate(scratch.bladeN, this.orientation, pecPose.normal);
      const vn = dot(scratch.rel, scratch.bladeN);
      const prev = s === 0 ? this.prevPecVnL : this.prevPecVnR;
      // As on the body, this bound is physical rather than a large round number.
      // A pectoral beating at its maximum 6 Hz through a 5.5 mm half-stroke
      // peaks at (2*pi*6)^2 * 0.0055 = 7.8 m/s^2, so 40 is five times anything
      // the fin can do.
      const dvn = clamp((vn - prev) * invDt, -40, 40);
      if (s === 0) this.prevPecVnL = vn;
      else this.prevPecVnR = vn;

      // Drag only. Rowing is drag-based propulsion — the literature's own term
      // for it — and the reactive (added-mass) part of a paddle stroke puts an
      // impulse into the water on one half-stroke and takes it back on the
      // other, netting nothing over a cycle. The scalar form used on the body,
      // -m_a * dv_n/dt along the instantaneous normal, does *not* net to zero
      // when the normal rotates with the feathering: it produced a steady lift
      // of several times the drag thrust, and the fish rose or dived on its
      // pectorals at five centimetres a second. So it is left out here, where
      // the normal rotates, and kept on the body, where it does not.
      void dvn;
      void maBlade;
      const fn = -0.5 * RHO_WATER * FISH.crossFlowCd * PECTORAL.area * Math.abs(vn) * vn;

      scale(scratch.tmp, scratch.bladeN, fn);
      add(this.forces.pectoral, this.forces.pectoral, scratch.tmp);
      add(F, F, scratch.tmp);
      cross(scratch.tmp2, scratch.r, scratch.tmp);
      add(T, T, scratch.tmp2);
    }
  }

  private accumulateBuoyancy(F: Vec3, T: Vec3, water: WaterSurface | null): void {
    // How much of the fish is under water. A fish gulping air at the surface has
    // part of its head out, and loses the buoyancy of that part — which is why
    // it has to work to stay up there.
    let submerged = 1.0;
    if (water) {
      const surfaceY = water.heightAt(this.position.x, this.position.z);
      const halfDepth = FISH.maxDepth * 0.5;
      submerged = clamp((surfaceY - (this.position.y - halfDepth)) / (2 * halfDepth), 0, 1);
    }

    const displaced = this.morphology.neutralVolume * this.bladder * submerged;
    const fy = RHO_WATER * displaced * GRAVITY - this.morphology.totalMass * GRAVITY;
    set(scratch.tmp, 0, fy, 0);
    copy(this.forces.buoyancy, scratch.tmp);
    add(F, F, scratch.tmp);

    // Buoyancy acts at the centre of volume, which sits a little above the
    // centre of mass. That offset is the fish's righting moment: it is why a
    // healthy fish rolls upright by itself, and why a sick one lists.
    set(scratch.tmp2, 0, FISH.centreOfVolumeOffsetY, 0);
    quatRotate(scratch.r, this.orientation, scratch.tmp2);
    set(scratch.tmp, 0, RHO_WATER * displaced * GRAVITY, 0);
    cross(scratch.tmp2, scratch.r, scratch.tmp);
    add(T, T, scratch.tmp2);

    // Rotational drag. Without this the fish would spin freely once torqued;
    // in reality the body sweeping sideways through water damps rotation hard.
    // Coefficient from integrating cross-flow drag over the body for a unit
    // angular rate, linearised about the current rate.
    const wl = len(this.angularVelocity);
    if (wl > 1e-6) {
      const cRot = 0.5 * RHO_WATER * FISH.crossFlowCd * this.rotationalDragFactor;
      scale(scratch.tmp, this.angularVelocity, -cRot * wl);
      add(T, T, scratch.tmp);
    }
    // And the viscous part, linear in the rate, which is what actually stops a
    // slow spin. See FISH.rotationalViscousTau. Applied in the body frame so
    // each axis is damped against its own inertia.
    {
      const [Ipitch, Iyaw, Iroll] = this.morphology.effectiveInertiaBody;
      const k = 1 / FISH.rotationalViscousTau;
      quatRotateInv(scratch.tmp, this.orientation, this.angularVelocity);
      set(scratch.tmp, -Ipitch * k * scratch.tmp.x, -Iyaw * k * scratch.tmp.y, -Iroll * k * scratch.tmp.z);
      quatRotate(scratch.tmp2, this.orientation, scratch.tmp);
      add(T, T, scratch.tmp2);
    }
  }

  private accumulateContact(F: Vec3, T: Vec3): void {
    // Soft contact with the tank. The brain steers away from walls long before
    // this fires; this exists so that a startled fish that does clip the glass
    // bounces off it rather than passing through, and so the simulation cannot
    // put the fish somewhere impossible.
    //
    // Spring-damper rather than positional correction: a hard reposition would
    // inject energy and is what makes a bumped fish jitter against a wall.
    const b = this.bounds;
    if (!b) return;
    // Soft, because the fish is. Sized so that a fish arriving at the glass at
    // a fast cruise — five body lengths a second — is brought to rest over
    // about five millimetres: k = m v^2 / x^2 with the water it carries. The
    // first value, 240 N/m, was a table leg: a fish nosing the glass while it
    // struck at a pellet floating there met forces of forty times its weight
    // and was flung back across the tank at twelve body lengths a second, over
    // and over, every time it fed at the front.
    const k = 12; // N/m
    const c = 0.3; // N.s/m, near critical for the fish plus its added mass
    // The margin has to cover the fish's *reach*, not its girth. The centre of
    // mass sits roughly two centimetres behind the snout, so a margin of half
    // the body depth let the head poke straight through the glass while the
    // centre was still comfortably inside the tank.
    const margin = FISH.maxDepth * 0.5 + FISH.standardLength * 0.30;

    const push = (nx: number, ny: number, nz: number, penetration: number): void => {
      if (penetration <= 0) return;
      const vn = this.velocity.x * nx + this.velocity.y * ny + this.velocity.z * nz;
      // Damping only while moving into the wall, so the fish is not sucked back.
      const damp = vn < 0 ? -c * vn : 0;
      const mag = k * penetration + damp;
      set(scratch.tmp, nx * mag, ny * mag, nz * mag);
      add(this.forces.contact, this.forces.contact, scratch.tmp);
      add(F, F, scratch.tmp);
    };

    push(1, 0, 0, b.minX + margin - this.position.x);
    push(-1, 0, 0, this.position.x - (b.maxX - margin));
    push(0, 0, 1, b.minZ + margin - this.position.z);
    push(0, 0, -1, this.position.z - (b.maxZ - margin));
    push(0, 1, 0, b.floorY + margin - this.position.y);
    void T;
  }

  private integrate(F: Vec3, T: Vec3, dt: number): void {

    // --- Linear ---
    // Added mass is strongly direction-dependent: accelerating forwards is
    // cheap, sideways is expensive, because of how much water has to be shoved
    // out of the way. Doing this in the body frame is the whole point; an
    // isotropic added mass makes the fish slide sideways far too easily and is
    // immediately readable as wrong.
    quatRotateInv(scratch.bodyF, this.orientation, F);
    const [mSurge, mSway, mHeave] = this.morphology.effectiveMass;
    const ax = scratch.bodyF.x / mSway;
    const ay = scratch.bodyF.y / mHeave;
    const az = scratch.bodyF.z / mSurge;
    set(scratch.tmp, ax, ay, az);
    quatRotate(scratch.tmp2, this.orientation, scratch.tmp);
    addScaled(this.velocity, scratch.tmp2, dt);

    // --- Angular ---
    // Euler's equations in the body frame, including the gyroscopic term. That
    // term is small for a fish but it is what makes a rolling, turning body
    // precess slightly instead of moving in separable axes.
    quatRotateInv(scratch.bodyT, this.orientation, T);
    quatRotateInv(scratch.tmp, this.orientation, this.angularVelocity);
    // Body-axis order, not [roll, pitch, yaw] order. See the note on
    // effectiveInertiaBody in morphology.ts — these are different permutations
    // and confusing them is silent.
    const [Ix, Iy, Iz] = this.morphology.effectiveInertiaBody;
    const wx = scratch.tmp.x;
    const wy = scratch.tmp.y;
    const wz = scratch.tmp.z;
    const gx = (Iz - Iy) * wy * wz;
    const gy = (Ix - Iz) * wz * wx;
    const gz = (Iy - Ix) * wx * wy;
    set(
      scratch.tmp2,
      (scratch.bodyT.x - gx) / Ix,
      (scratch.bodyT.y - gy) / Iy,
      (scratch.bodyT.z - gz) / Iz,
    );
    // Bound the angular acceleration to something an animal can produce. A
    // C-start in a fish this size reaches about 20 rad/s in 20 ms, so roughly
    // 1000 rad/s^2; twice that is beyond anything real, and anything beyond it
    // is a numerical artefact rather than a manoeuvre.
    const alphaMax = 2000;
    const al = len(scratch.tmp2);
    if (al > alphaMax) scale(scratch.tmp2, scratch.tmp2, alphaMax / al);
    quatRotate(scratch.tmp, this.orientation, scratch.tmp2);
    addScaled(this.angularVelocity, scratch.tmp, dt);

    // Sanity clamps. A fish cannot exceed about 12 body lengths per second in a
    // burst, or roughly 25 rad/s in a C-start; anything beyond that is a bug,
    // and clamping keeps a bug visible rather than catastrophic.
    const maxSpeed = 12 * this.morphology.standardLength;
    const sp = len(this.velocity);
    if (sp > maxSpeed) scale(this.velocity, this.velocity, maxSpeed / sp);
    const wl = len(this.angularVelocity);
    if (wl > 25) scale(this.angularVelocity, this.angularVelocity, 25 / wl);

    addScaled(this.position, this.velocity, dt);
    quatIntegrate(this.orientation, this.orientation, this.angularVelocity, dt);
    quatNormalize(this.orientation, this.orientation);

    // Hard backstop on position. The soft contact above does the work; this only
    // catches the case where something has gone badly wrong, and keeps the fish
    // inside the glass no matter what. Velocity into the wall is killed along
    // with the position, so a pinned fish reads as stopped rather than as still
    // swimming at full speed.
    const b = this.bounds;
    if (b) {
      const margin = FISH.maxDepth * 0.5;
      const clampAxis = (v: number, vel: number, lo: number, hi: number): [number, number] => {
        if (v < lo) return [lo, Math.max(0, vel)];
        if (v > hi) return [hi, Math.min(0, vel)];
        return [v, vel];
      };
      [this.position.x, this.velocity.x] = clampAxis(this.position.x, this.velocity.x, b.minX + margin, b.maxX - margin);
      [this.position.z, this.velocity.z] = clampAxis(this.position.z, this.velocity.z, b.minZ + margin, b.maxZ - margin);
      [this.position.y, this.velocity.y] = clampAxis(this.position.y, this.velocity.y, b.floorY + margin, b.ceilY);
    }
  }
}

export function createLocomotion(morphology: Morphology, body: FishBody): FishLocomotion {
  return new FishLocomotion(morphology, body);
}
