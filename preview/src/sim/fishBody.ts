/**
 * The fish's body shape at an instant: where every segment of the centreline is,
 * which way it points, and how fast it is moving through the water.
 *
 * Three things here are easy to get wrong and all three change how the fish
 * behaves rather than just how it looks:
 *
 * 1. **The body does not stretch.** The muscle command is a lateral displacement
 *    wave, but a curve with a lateral offset is *longer* than the straight line
 *    it came from. Sampling that curve at uniform `s` would make the fish grow
 *    by a few percent every time it bent, which shows up as a pumping motion.
 *    So the offset curve is built densely, then resampled at uniform *arc
 *    length*. A bent fish therefore spans less distance nose-to-tail than a
 *    straight one, which is what a real bent fish does.
 *
 * 2. **Internal motion must not move the fish.** If you undulate a body about a
 *    fixed origin, its centre of mass wanders — and if the rigid-body position
 *    is that origin, the fish translates itself by wiggling, with no water
 *    involved. That is a free-energy machine and it is the single most common
 *    way a "physical" swimmer turns out to be faked. Here the instantaneous
 *    mass-weighted centroid is subtracted every step, so deformation moves
 *    nothing; only fluid forces do.
 *
 * 3. **Internal motion does produce recoil.** The angular equivalent is real and
 *    visible: a fish's head yaws in opposition to its tail. That comes out of
 *    conserving angular momentum, so the rate of change of the body's internal
 *    angular momentum is fed back as a reaction torque.
 */

import {
  Vec3,
  v3,
  set,
  sub,
  cross,
  normalize,
  scale,
  addScaled,
  copy,
  len,
  expApproach,
} from './math.js';
import { FISH, PECTORAL } from './config.js';
import { Morphology, amplitudeEnvelope, bendShape } from './morphology.js';

/** Number of dense samples used before arc-length resampling. */
const DENSE = 120;

export interface BodySegmentState {
  /** Position in the body frame, measured from the instantaneous centre of mass. */
  pos: Vec3;
  /** Unit tangent, pointing from head towards tail. */
  tangent: Vec3;
  /** Unit lateral normal (the fish's local "sideways"). */
  normal: Vec3;
  /** Unit dorsal direction (the fish's local "up"). */
  up: Vec3;
  /** Velocity of this point in the body frame, from deformation alone. */
  velLocal: Vec3;
}

/** The muscle command the brain sends down. Nothing here is a velocity. */
export interface MotorCommand {
  /** Tail-beat frequency, Hz. */
  frequency: number;
  /** Tail-tip half-amplitude, metres. */
  amplitude: number;
  /** Steady one-sided bend for turning, -1 (right) to +1 (left). */
  bend: number;
  /**
   * Steady vertical bend, -1 (nose down) to +1 (nose up).
   *
   * A fish pitches by angling its body and letting its forward motion do the
   * rest — the same cross-flow forces that turn it sideways turn it upwards when
   * the bend is vertical. Without this the fish can only steer in yaw, and in a
   * tank where the food floats and the air is at the top, a fish that cannot aim
   * upwards is in real trouble: it would approach a floating pellet to within a
   * centimetre or two and then circle it indefinitely, unable to raise its mouth
   * the last few millimetres.
   */
  pitchBend: number;
  /** Left and right pectoral beat frequency, Hz. */
  pectoralLeft: number;
  pectoralRight: number;
  /**
   * Steady tilt of both pectoral fins, -1 (nose down) to +1 (nose up).
   *
   * The pectorals are the fish's elevators. Angled into the oncoming water they
   * generate lift ahead of the centre of mass, which pitches the whole animal —
   * and once the animal is pitched, its tail thrust has a vertical component and
   * it can climb or dive.
   *
   * Without this the fish simply cannot change depth by swimming. Bending the
   * body vertically is not enough on its own: a laterally compressed fish
   * presents almost no planform area, so the lift from an angled *body* comes
   * out at a fraction of a percent of its weight. A fish that needed to reach
   * the surface for air stalled six millimetres below it and hung there, level,
   * indefinitely.
   */
  pectoralPitch: number;
  /** Commanded change in swim-bladder volume, -1 to +1. */
  bladder: number;
  /** How far the mouth is open, 0 to 1. Drives the suction strike. */
  mouthOpen: number;
  /** How far the fins are spread, 0 (clamped) to 1 (full flare). */
  finSpread: number;
  /** Gill cover erection, 0 to 1. Part of the threat display. */
  gillFlare: number;
  /**
   * Braking, 0 to 1: pectoral fins held out broadside as air brakes.
   *
   * This is how a fish stops, and without it one cannot. A tail-beat frequency
   * wound down to zero still leaves the fish coasting for most of a second — far
   * enough to sail straight past a two-millimetre pellet it had lined up
   * perfectly — because a streamlined body in water has very little drag along
   * its own axis. Turning the pectorals side-on multiplies that drag by an order
   * of magnitude, which is exactly what the fins are for.
   */
  brake: number;
  /**
   * How fast the fish is allowed to change its body bend, 0 (deliberate) to
   * 1 (reflex).
   *
   * A startle response and a cruising course correction do not use the same
   * muscle. A C-start recruits fast white fibre and reaches full deflection in
   * under twenty milliseconds; steady swimming uses slow red fibre and takes
   * several times that. Letting every steering correction move at C-start speed
   * is not a free upgrade — it lets the steering controller oscillate at the
   * frame rate, and because the reactive force goes with the *rate* of body
   * deformation, a bend flickering by a few tenths every four milliseconds
   * produced forces around forty times the fish's weight and span it into the
   * angular clamp.
   */
  agility: number;
}

export function createMotorCommand(): MotorCommand {
  return {
    frequency: 0,
    amplitude: FISH.standardLength * FISH.tailAmplitudeRatio,
    bend: 0,
    pitchBend: 0,
    pectoralLeft: 0,
    pectoralRight: 0,
    pectoralPitch: 0,
    bladder: 0,
    mouthOpen: 0,
    finSpread: 0.55,
    gillFlare: 0,
    brake: 0,
    agility: 0,
  };
}

export class FishBody {
  readonly morphology: Morphology;
  readonly segments: BodySegmentState[] = [];

  /** Phase of the travelling body wave, in radians. Integrated, never reset. */
  private wavePhase = 0;
  /** Phase of the pectoral stroke, per side. */
  pectoralPhaseLeft = 0;
  pectoralPhaseRight = 0;

  /** Dense sample buffers, reused every step. */
  private readonly denseX = new Float64Array(DENSE + 1);
  private readonly denseY = new Float64Array(DENSE + 1);
  private readonly denseZ = new Float64Array(DENSE + 1);
  private readonly denseArc = new Float64Array(DENSE + 1);

  /** Previous body-frame positions, for the deformation velocity. */
  private readonly prevPos: Vec3[] = [];
  private hasPrev = false;

  /** Internal angular momentum from the last step, for the recoil torque. */
  private prevInternalL = v3();
  /** The recoil torque to apply to the rigid body this step. */
  readonly recoilTorque = v3();

  /** Amplitude actually reached by the tail tip last step — used by the tests. */
  tailExcursion = 0;

  /**
   * The amplitude and bend the muscles have actually reached, which lag what the
   * brain asked for.
   *
   * Muscle cannot change its contraction instantly, and neither can this. It is
   * not cosmetic: an amplitude that snaps from full to zero in one 4 ms step
   * makes the whole body straighten in that step, which the deformation velocity
   * reads as the tail moving at metres per second and turns into an enormous
   * spurious impulse. A fish told to stop swimming was flung into a spin it never
   * came out of.
   */
  private actualAmplitude = 0;
  private actualBend = 0;
  private actualPitchBend = 0;
  private actualFrequency = 0;
  private actualAgility = 0;

  constructor(morphology: Morphology) {
    this.morphology = morphology;
    for (let i = 0; i < morphology.segments.length; i++) {
      this.segments.push({
        pos: v3(),
        tangent: v3(0, 0, -1),
        normal: v3(1, 0, 0),
        up: v3(0, 1, 0),
        velLocal: v3(),
      });
      this.prevPos.push(v3());
    }
    // Start straight so the first step has a sane previous state.
    this.shape(createMotorCommand(), 0);
    this.commitPrevious();
  }

  /**
   * Rebuild the body's shape for the current motor command.
   *
   * Body frame: +x is the fish's right, +y is up (dorsal), +z is forward. The
   * snout sits near z = 0 and the tail near z = -SL, before the centroid shift.
   */
  shape(cmd: MotorCommand, dt: number): void {
    const L = this.morphology.standardLength;
    // The chain runs past the body: the last segments are the caudal fin.
    const totalArc = this.morphology.totalArc;
    const lambda = FISH.waveLengthRatio * L;
    const k = (2 * Math.PI) / lambda; // spatial wavenumber, rad per metre of arc

    if (dt > 0) {
      // Muscle slew limits. Amplitude relaxes over about 60 ms; bend can change
      // faster, because a startled fish's C-start really does begin within
      // 5 to 15 ms and has to be able to.
      this.actualAmplitude = expApproach(this.actualAmplitude, cmd.amplitude, 1 / 0.06, dt);
      // Finite muscle: the fish cannot bend fully sideways and fully upwards at
      // the same time, any more than a person can, so the combined demand is
      // scaled back to what one body can do.
      let bendX = cmd.bend;
      let bendY = cmd.pitchBend;
      const total = Math.hypot(bendX, bendY);
      if (total > 1) {
        bendX /= total;
        bendY /= total;
      }
      // Deliberate steering is slow; a reflex is fast. 120 ms is about right for
      // red muscle making a course correction, and it is also what keeps the
      // steering controller from being able to slam the bend from one extreme to
      // the other inside a single tail beat.
      const agility = Math.max(0, Math.min(1, cmd.agility));
      this.actualAgility = expApproach(this.actualAgility, agility, 1 / 0.05, dt);
      const bendTau = 0.120 + (0.015 - 0.120) * agility;
      this.actualBend = expApproach(this.actualBend, bendX, 1 / bendTau, dt);
      this.actualPitchBend = expApproach(this.actualPitchBend, bendY, 1 / (bendTau * 2.5), dt);
      this.actualFrequency = expApproach(this.actualFrequency, cmd.frequency, 1 / 0.04, dt);
      this.wavePhase += 2 * Math.PI * this.actualFrequency * dt;
      // Keep the phase bounded so it never loses precision over a long session.
      if (this.wavePhase > 2 * Math.PI) this.wavePhase -= 2 * Math.PI * Math.floor(this.wavePhase / (2 * Math.PI));
    } else {
      this.actualAmplitude = cmd.amplitude;
      this.actualBend = cmd.bend;
      this.actualPitchBend = cmd.pitchBend;
      this.actualFrequency = cmd.frequency;
      this.actualAgility = cmd.agility;
    }

    // --- 1. Dense sample of the laterally offset centreline ---
    let minX = Infinity;
    let maxX = -Infinity;
    for (let j = 0; j <= DENSE; j++) {
      const arc = (j / DENSE) * totalArc;
      // s is measured in body lengths, so it runs past 1 over the caudal fin and
      // the amplitude envelope keeps growing — which is what makes the fin's
      // trailing edge the biggest-amplitude part of the animal.
      const s = arc / L;
      const env = amplitudeEnvelope(s) * this.actualAmplitude;
      const theta = k * arc - this.wavePhase;
      const wave = Math.sin(theta);
      const steer = this.actualBend * (1 + FISH.bendReflexGain * this.actualAgility);
      // Three things at once in a turn: the ordinary wave; the same wave beaten
      // harder to one side (sin^2 is one-signed and largest at the extremes, so
      // it is an amplitude asymmetry rather than a shift — see bendAsymmetry);
      // and a camber of the whole body into the turn, which is the rudder.
      const h =
        env * wave +
        steer * (FISH.bendAsymmetry * env * wave * wave + bendShape(s));
      this.denseX[j] = h;
      // Vertical bend. Gentler than the lateral one — a fish is far stiffer in
      // that plane, which is why it turns much more readily than it climbs.
      this.denseY[j] = this.actualPitchBend * bendShape(s) * 0.55;
      this.denseZ[j] = -arc;
      if (h < minX) minX = h;
      if (h > maxX) maxX = h;
    }
    this.tailExcursion = Math.abs(this.denseX[DENSE]);

    // --- 2. Cumulative arc length along that curve ---
    this.denseArc[0] = 0;
    for (let j = 1; j <= DENSE; j++) {
      const dx = this.denseX[j] - this.denseX[j - 1];
      const dy = this.denseY[j] - this.denseY[j - 1];
      const dz = this.denseZ[j] - this.denseZ[j - 1];
      this.denseArc[j] = this.denseArc[j - 1] + Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    // --- 3. Resample at uniform arc length, so the body cannot stretch ---
    const segs = this.morphology.segments;
    const n = segs.length;
    let cursor = 0;
    for (let i = 0; i < n; i++) {
      const targetArc = segs[i].arc; // distance from the snout along the body
      while (cursor < DENSE && this.denseArc[cursor + 1] < targetArc) cursor++;
      const a0 = this.denseArc[cursor];
      const a1 = this.denseArc[Math.min(cursor + 1, DENSE)];
      const t = a1 > a0 ? (targetArc - a0) / (a1 - a0) : 0;
      const j1 = Math.min(cursor + 1, DENSE);
      const x = this.denseX[cursor] + (this.denseX[j1] - this.denseX[cursor]) * t;
      const y = this.denseY[cursor] + (this.denseY[j1] - this.denseY[cursor]) * t;
      const z = this.denseZ[cursor] + (this.denseZ[j1] - this.denseZ[cursor]) * t;
      set(this.segments[i].pos, x, y, z);
    }

    // --- 4. Frames: tangent along the body, normal sideways, up = t x n ---
    const tmp = v3();
    const upRef = v3();
    for (let i = 0; i < n; i++) {
      const a = this.segments[Math.max(0, i - 1)].pos;
      const b = this.segments[Math.min(n - 1, i + 1)].pos;
      sub(tmp, b, a);
      if (len(tmp) < 1e-9) set(tmp, 0, 0, -1);
      normalize(this.segments[i].tangent, tmp);
      const tg = this.segments[i].tangent;

      // Rotation-minimising frame, carried along the body from the head.
      //
      // Building each segment's frame independently from a fixed "up" reference
      // is the obvious approach and it fails as soon as the body bends in both
      // planes at once: the reference becomes nearly parallel to the tangent,
      // the cross product collapses, and the frame spins wildly from one segment
      // to the next. Every hydrodynamic force is computed against those
      // directions, so the fish then tears itself apart — a fish told to turn
      // and climb at the same time span up to the angular clamp within a second
      // and stayed there. Turning alone was fine; climbing alone was fine.
      //
      // Propagating the previous segment's normal and projecting out whatever
      // component the new tangent has picked up carries the frame along the body
      // with the least possible twist, and cannot degenerate as long as
      // consecutive tangents are not opposed — which, on a body that cannot
      // fold back on itself, they never are.
      if (i === 0) {
        set(upRef, 0, 1, 0);
        cross(this.segments[i].normal, upRef, tg);
        if (len(this.segments[i].normal) < 1e-6) {
          set(upRef, 0, 0, 1);
          cross(this.segments[i].normal, upRef, tg);
        }
      } else {
        // Project the previous normal onto the plane perpendicular to this
        // tangent.
        const prev = this.segments[i - 1].normal;
        const d = prev.x * tg.x + prev.y * tg.y + prev.z * tg.z;
        set(
          this.segments[i].normal,
          prev.x - tg.x * d,
          prev.y - tg.y * d,
          prev.z - tg.z * d,
        );
        if (len(this.segments[i].normal) < 1e-6) {
          set(upRef, 0, 1, 0);
          cross(this.segments[i].normal, upRef, tg);
        }
      }
      normalize(this.segments[i].normal, this.segments[i].normal);
      cross(this.segments[i].up, this.segments[i].tangent, this.segments[i].normal);
      normalize(this.segments[i].up, this.segments[i].up);
    }

    // --- 5. Shift so the mass-weighted centroid is at the body-frame origin ---
    //
    // Without this the fish would translate itself by wiggling, with no water
    // involved. See the note at the top of this file.
    let cx = 0;
    let cy = 0;
    let cz = 0;
    const M = this.morphology.totalMass;
    for (let i = 0; i < n; i++) {
      const m = segs[i].mass;
      cx += this.segments[i].pos.x * m;
      cy += this.segments[i].pos.y * m;
      cz += this.segments[i].pos.z * m;
    }
    cx /= M;
    cy /= M;
    cz /= M;
    for (let i = 0; i < n; i++) {
      this.segments[i].pos.x -= cx;
      this.segments[i].pos.y -= cy;
      this.segments[i].pos.z -= cz;
    }

    // --- 6. Deformation velocity, and the recoil torque it implies ---
    if (dt > 0 && this.hasPrev) {
      const invDt = 1 / dt;
      let lx = 0;
      let ly = 0;
      let lz = 0;
      for (let i = 0; i < n; i++) {
        const seg = this.segments[i];
        seg.velLocal.x = (seg.pos.x - this.prevPos[i].x) * invDt;
        seg.velLocal.y = (seg.pos.y - this.prevPos[i].y) * invDt;
        seg.velLocal.z = (seg.pos.z - this.prevPos[i].z) * invDt;
        // Internal angular momentum L = sum m * (r x v)
        const m = segs[i].mass;
        lx += m * (seg.pos.y * seg.velLocal.z - seg.pos.z * seg.velLocal.y);
        ly += m * (seg.pos.z * seg.velLocal.x - seg.pos.x * seg.velLocal.z);
        lz += m * (seg.pos.x * seg.velLocal.y - seg.pos.y * seg.velLocal.x);
      }
      // Reaction torque on the rigid frame is minus the rate of change of the
      // internal angular momentum. This is what makes the head yaw against the
      // tail — the recoil that a real swimming fish shows.
      set(
        this.recoilTorque,
        -(lx - this.prevInternalL.x) * invDt,
        -(ly - this.prevInternalL.y) * invDt,
        -(lz - this.prevInternalL.z) * invDt,
      );
      set(this.prevInternalL, lx, ly, lz);
    } else {
      for (let i = 0; i < n; i++) set(this.segments[i].velLocal, 0, 0, 0);
      set(this.recoilTorque, 0, 0, 0);
    }

    this.commitPrevious();
  }

  private commitPrevious(): void {
    for (let i = 0; i < this.segments.length; i++) copy(this.prevPos[i], this.segments[i].pos);
    this.hasPrev = true;
  }

  /** Pectoral beat frequencies the muscles have actually reached. */
  private actualPecLeft = 0;
  private actualPecRight = 0;

  get pectoralFrequencyLeft(): number {
    return this.actualPecLeft;
  }
  get pectoralFrequencyRight(): number {
    return this.actualPecRight;
  }

  /**
   * Advance the pectoral stroke phases.
   *
   * The commanded frequency is slewed, for the same reason the tail's is: an
   * instantaneous change in beat rate makes the blade's normal velocity jump,
   * and the added-mass term differentiates that into an enormous force. The fin
   * carries about a third of a gram of water and the fish weighs one and a half,
   * so a spike there is not a small perturbation — a fish switching between
   * hovering and swimming would spin itself up to the angular clamp.
   */
  stepPectorals(cmd: MotorCommand, dt: number): void {
    this.actualPecLeft = expApproach(this.actualPecLeft, cmd.pectoralLeft, 1 / 0.08, dt);
    this.actualPecRight = expApproach(this.actualPecRight, cmd.pectoralRight, 1 / 0.08, dt);
    this.pectoralPhaseLeft += 2 * Math.PI * this.actualPecLeft * dt;
    this.pectoralPhaseRight += 2 * Math.PI * this.actualPecRight * dt;
    const twoPi = 2 * Math.PI;
    if (this.pectoralPhaseLeft > twoPi) this.pectoralPhaseLeft %= twoPi;
    if (this.pectoralPhaseRight > twoPi) this.pectoralPhaseRight %= twoPi;
  }

  /** Body-frame position of the snout tip, for the mouth and strike logic. */
  snout(out: Vec3): Vec3 {
    const s0 = this.segments[0];
    // Half a segment further forward than the first sample point.
    return addScaled(copy(out, s0.pos), s0.tangent, -this.morphology.segments[0].ds * 0.5);
  }

  /** Body-frame position of the caudal peduncle, where the tail fin attaches. */
  peduncle(out: Vec3): Vec3 {
    return copy(out, this.segments[this.segments.length - 1].pos);
  }

  /** Body-frame attachment point of a pectoral fin. `side` is -1 left, +1 right. */
  pectoralAttach(side: number, out: Vec3): Vec3 {
    const segs = this.morphology.segments;
    const targetArc = 0.30 * this.morphology.standardLength;
    let idx = 0;
    for (let i = 0; i < segs.length; i++) {
      if (segs[i].arc >= targetArc) {
        idx = i;
        break;
      }
    }
    const seg = this.segments[idx];
    copy(out, seg.pos);
    // The segment normal points towards -x on a straight body, and the blade
    // extends towards +x for side = +1, so the sign here is what puts the fin's
    // root on the same side of the body as its blade. With it the other way
    // each blade crossed through the body to the far side, its lever arm about
    // the yaw axis all but vanished, and rowing one fin could not turn the fish.
    return addScaled(out, seg.normal, -side * segs[idx].width * 0.5);
  }

  get phase(): number {
    return this.wavePhase;
  }

  /** The tail-beat frequency the muscles have actually reached. */
  get frequency(): number {
    return this.actualFrequency;
  }

  /** The amplitude the muscles have actually reached. */
  get currentAmplitude(): number {
    return this.actualAmplitude;
  }
}

/**
 * Position and orientation of a pectoral fin at its current stroke phase.
 *
 * The rowing stroke is a sweep back and forth combined with a feathering pitch,
 * and the *phase offset between them* is the whole mechanism. On the power
 * stroke the fin is broadside to its motion and pushes a lot of water; on the
 * recovery stroke it is edge-on and pushes almost none. Set the offset to zero
 * and the two cancel exactly, giving a fin that waves about and produces no
 * thrust at all — which test `pectoral.phase` checks, because it is the
 * difference between simulating a rowing fin and drawing one.
 */
const PECTORAL_CACHE = {
  sweepMean: PECTORAL.sweepMean,
  sweepAmp: PECTORAL.sweepAmp,
  pitchAmp: PECTORAL.pitchAmp,
  sweepFolded: PECTORAL.sweepFolded,
};

export function pectoralPose(
  phase: number,
  side: number,
  spread: number,
  pitchBias: number,
  rowing: number,
  out: { sweep: number; pitch: number; dSweepDPhase: number; normal: Vec3; velocityDir: Vec3 },
): void {
  const { sweepMean, sweepAmp, pitchAmp, sweepFolded } = PECTORAL_CACHE;
  // Folded back along the flank when still; out and rowing when beating. The
  // sweep angle increasing means the fin moving backwards, which is the power
  // stroke.
  const fold = 1 - rowing;
  const sweep = sweepFolded * fold + rowing * (sweepMean + sweepAmp * spread * Math.sin(phase));
  // Feathering: flat through the power stroke (phase near 0), edge-on through
  // the recovery (phase near pi). The steady tilt rides on top of it, so a fin
  // can row and act as an elevator at the same time — which is what they do.
  const feather = rowing * pitchAmp * 0.5 * (1 - Math.cos(phase));
  // Positive bias is nose-up: it tilts the blade so forward flow lifts it.
  // Sign by measurement.
  const pitch = feather - pitchBias * 0.55;
  out.sweep = sweep;
  out.pitch = pitch;
  out.dSweepDPhase = rowing * sweepAmp * spread * Math.cos(phase);

  // Fin blade normal in the body frame. The blade lies in a plane that sweeps
  // about the dorsal axis and feathers about its own span.
  //
  // The span runs outwards from the body at the sweep angle, (side*cs, 0, -ss).
  // The blade is a paddle standing on that span: its plane contains the span
  // and the vertical, so its normal is perpendicular to both — span x up — and
  // feathering tilts that normal about the span. Earlier this was set *along*
  // the span, which made the paddle move edge-on through the water on every
  // stroke. It then produced no force at all: no thrust from rowing, no yaw
  // from rowing one side, and no lift when held as an elevator. The whole slow
  // swimming mode ran on nothing, and the test that checks the fin's feathering
  // phase passed because zero is very reliably equal to zero.
  const cs = Math.cos(sweep);
  const ss = Math.sin(sweep);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  // The tilt about the span mirrors with the side: a feather that lifts the
  // leading edge on one fin must lift it on the other, and the sense of a
  // rotation about a mirrored axis is itself mirrored. Without the `side` on
  // the vertical term the two fins' vertical forces had opposite signs — they
  // cancelled with both fins rowing, and every turn became a climb.
  set(out.normal, ss * cp, side * sp, side * cs * cp);
  normalize(out.normal, out.normal);

  // Direction the blade centre is travelling: derivative of the sweep.
  const dSweep = out.dSweepDPhase;
  set(out.velocityDir, side * -ss * dSweep, 0, -cs * dSweep);
  const l = len(out.velocityDir);
  if (l > 1e-9) scale(out.velocityDir, out.velocityDir, 1 / l);
}
