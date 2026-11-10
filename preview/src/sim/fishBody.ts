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
import { Morphology, TIP_S, amplitudeEnvelope, bendShape } from './morphology.js';

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
  /**
   * The part of that velocity that comes from the fish changing its posture
   * (how hard it is beating, how far it is curled) rather than from the beat
   * itself running along the body. The water treats the two differently; see
   * the reactive force in locomotion.ts.
   */
  velPosture: Vec3;
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
  /**
   * How far the fish curls its whole body round to one side, -1 to +1, same
   * sign as `bend`.
   *
   * This is the turn a fish makes when it wants to face another way rather
   * than adjust its course: the body folds into a C, the head comes round
   * towards the tail, and the fish swims out along the curve. `bend` cannot do
   * it. It leans the tail a centimetre or so off the line, which steers a
   * moving fish round a circle wider than the tank and does nothing for one
   * that is standing still. A betta turning round in its own length is bent
   * through more than a right angle. See FISH.curlMax.
   */
  curl: number;
  /**
   * Where along the body the middle of the curl sits, in body lengths from
   * the snout. Left at FISH.curlAt the fish folds about its middle. Slid back
   * towards and past the tail, the fold runs down the body and off the end of
   * the tail fin, leaving the fish straight and facing the way its head had
   * turned. That is how a turn is finished. Simply unfolding again would undo
   * it, swinging the head back to where it started.
   */
  curlAt: number;
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

/**
 * How much of the full curl the body has turned through by position `s` (in
 * body lengths from the snout), with the fold centred at `at`: 0 ahead of the
 * fold, 1 behind it.
 */
export function curlProfile(s: number, at: number): number {
  const t = Math.max(0, Math.min(1, (s - at) / FISH.curlWidth + 0.5));
  return t * t * (3 - 2 * t);
}

export function createMotorCommand(): MotorCommand {
  return {
    frequency: 0,
    amplitude: FISH.standardLength * FISH.tailAmplitudeRatio,
    bend: 0,
    pitchBend: 0,
    curl: 0,
    curlAt: FISH.curlAt,
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
  /** Where each point would be had only the beat moved on, with the posture held. */
  private readonly beatOnly: Vec3[] = [];
  /** The segments' own position vectors, in order, for layout() to fill. */
  private readonly livePos: Vec3[] = [];

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
  private actualCurl = 0;
  private curlRate = 0;
  private actualCurlAt: number = FISH.curlAt;

  /**
   * How the curl changes the water the fish has to move to get going.
   *
   * A straight fish moving sideways shoves a great slab of water with its
   * flanks and fins, and moving forwards almost none. Curl the fish and that is
   * no longer true of the curled part: a tail fin folded round to stand across
   * the head's line is broadside to the fish's forward motion. These are the
   * sums that say so, over the curled centreline alone (no beat): the mass of
   * water carried along the fish's sideways axis, along its forward axis, the
   * mix of the two, and the same for turning about the vertical.
   *
   * Without them the curl is a catapult. The fin, sweeping round with a couple
   * of grams of water, pushed on a fish that was still being treated as a dart
   * that weighs two grams end-on, and a fish folding up to turn round shot
   * across the tank at the speed limit.
   */
  readonly curlWater = { xx: 0, xz: 0, zz: 0, yaw: 0, xYaw: 0, zYaw: 0, active: false };
  private curlWaterFor = 0;
  private curlWaterSteer = 0;
  /** Each segment's share of the fish's resistance to turning; sums to one. */
  private readonly finWeight: Float64Array;
  private finTurn = 0;
  private curlWaterAt = 0;
  /**
   * How fast the curl is turning the finned part of the fish relative to its
   * head, radians a second, about the fish's own vertical. The fins are what
   * the water grips when the fish turns, so the drag on turning goes by how
   * fast they are turning, and while the fish is curling that is not how fast
   * its head is.
   */
  get finTurnRate(): number {
    return this.finTurn;
  }
  /** The angle the curl has turned the body through at each segment, radians. */
  readonly curlAngle: Float64Array;
  private readonly curlPos: Vec3[] = [];

  constructor(morphology: Morphology) {
    this.morphology = morphology;
    this.curlAngle = new Float64Array(morphology.segments.length);
    {
      this.finWeight = new Float64Array(morphology.segments.length);
      let sum = 0;
      morphology.segments.forEach((seg, i) => {
        const r = Math.abs(seg.arc - morphology.comArc);
        this.finWeight[i] = seg.lateralArea * r * r * r;
        sum += this.finWeight[i];
      });
      for (let i = 0; i < this.finWeight.length; i++) this.finWeight[i] /= sum;
    }
    for (let i = 0; i < morphology.segments.length; i++) {
      this.segments.push({
        pos: v3(),
        tangent: v3(0, 0, -1),
        normal: v3(1, 0, 0),
        up: v3(0, 1, 0),
        velLocal: v3(),
        velPosture: v3(),
      });
      this.prevPos.push(v3());
      this.beatOnly.push(v3());
      this.livePos.push(this.segments[i].pos);
      this.curlPos.push(v3());
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
    const prevAmplitude = this.actualAmplitude;
    const prevBend = this.actualBend;
    const prevPitchBend = this.actualPitchBend;
    const prevAgility = this.actualAgility;
    const prevCurl = this.actualCurl;
    const prevCurlAt = this.actualCurlAt;
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
      // The curl is driven like a weight on a damped spring rather than eased
      // straight towards its target, so that it starts moving from rest and
      // comes to rest again. Easing straight towards the target starts at full
      // speed on the first step, and every part of the body the curl moves
      // would then hit the water at that speed from standing.
      {
        const w = FISH.curlQuickness;
        // A fold asked for beyond the end of the tail is no fold at all.
        // (Without this, a fold that had just run off the tail was started
        // again at the middle of the body for the few steps the brain went
        // on asking for it.)
        const asked = Math.max(-1, Math.min(1, cmd.curl));
        // Nor can a fold be brought back up the body towards the head: that
        // cracks the tail fin like a whip (measured: it threw the fish at up
        // to ten body lengths a second). A new fold asked for while an old
        // one is still partway down the tail waits for the old one to relax.
        const headward =
          cmd.curlAt < this.actualCurlAt - 0.05 && Math.abs(this.actualCurl) > 0.01;
        const target = curlProfile(TIP_S, cmd.curlAt) === 0 || headward ? 0 : asked;
        this.curlRate += (w * w * (target - this.actualCurl) - 2 * w * this.curlRate) * dt;
        this.actualCurl += this.curlRate * dt;
        const offTheTail = curlProfile(TIP_S, this.actualCurlAt) === 0;
        if (offTheTail || (Math.abs(this.actualCurl) <= 0.01 && target === 0)) {
          // Nothing, or next to nothing, of the fold is left on the body, so
          // the numbers can be put back to the start without moving anything.
          this.actualCurl = 0;
          this.curlRate = 0;
          this.actualCurlAt = Math.min(cmd.curlAt, FISH.curlAt);
        } else if (asked !== 0 && !headward) {
          // The fold travels down the body at a steady pace, no faster than
          // FISH.curlTravel body lengths a second. (While the fish is
          // straightening out, the fold stays where it is: sliding it back up
          // the body would fold the fish again.)
          //
          // Eased as well as limited. The brain moves its command once a
          // frame, and a fold that jumped along the body once a frame and
          // then stood still for three steps out of four was moving, when it
          // moved, at four times its average speed. Drag goes as the square
          // of speed, so the tail met four times the drag as the fold ran
          // off it, and that drag is what swings the head back: turns that
          // kept four fifths of their angle when commanded every step kept
          // a quarter when commanded every frame.
          const step = FISH.curlTravel * dt;
          const want = expApproach(this.actualCurlAt, cmd.curlAt, 1 / 0.07, dt) - this.actualCurlAt;
          this.actualCurlAt += Math.max(-step, Math.min(step, want));
        }
      }
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
      this.actualCurl = cmd.curl;
      this.curlRate = 0;
      this.actualCurlAt = cmd.curlAt;
    }

    const segs = this.morphology.segments;
    const n = segs.length;

    // --- 1 to 3 and 5. Lay the body out, centred on its centre of mass ---
    this.tailExcursion = this.layout(
      this.actualAmplitude,
      this.actualBend,
      this.actualPitchBend,
      this.actualAgility,
      this.actualCurl,
      this.actualCurlAt,
      this.wavePhase,
      this.livePos,
    );

    // The same instant of the beat with the posture the fish had a step ago.
    // The difference between the two is what the change of posture alone did.
    const postureMoved =
      dt > 0 &&
      (Math.abs(this.actualAmplitude - prevAmplitude) > 1e-12 ||
        Math.abs(this.actualBend - prevBend) > 1e-12 ||
        Math.abs(this.actualPitchBend - prevPitchBend) > 1e-12 ||
        Math.abs(this.actualAgility - prevAgility) > 1e-12 ||
        Math.abs(this.actualCurl - prevCurl) > 1e-12 ||
        Math.abs(this.actualCurlAt - prevCurlAt) > 1e-12);
    this.updateCurlWater(dt);
    if (postureMoved) {
      this.layout(
        prevAmplitude,
        prevBend,
        prevPitchBend,
        prevAgility,
        prevCurl,
        prevCurlAt,
        this.wavePhase,
        this.beatOnly,
      );
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
        if (postureMoved) {
          seg.velPosture.x = (seg.pos.x - this.beatOnly[i].x) * invDt;
          seg.velPosture.y = (seg.pos.y - this.beatOnly[i].y) * invDt;
          seg.velPosture.z = (seg.pos.z - this.beatOnly[i].z) * invDt;
        } else {
          set(seg.velPosture, 0, 0, 0);
        }
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
      for (let i = 0; i < n; i++) {
        set(this.segments[i].velLocal, 0, 0, 0);
        set(this.segments[i].velPosture, 0, 0, 0);
      }
      set(this.recoilTorque, 0, 0, 0);
    }

    this.commitPrevious();
  }

  /**
   * Where every point of the body sits, in the body frame, for a given beat
   * phase and posture. Returns how far the tail tip is off the centreline.
   */
  private layout(
    amplitude: number,
    bend: number,
    pitchBend: number,
    agility: number,
    curl: number,
    curlAt: number,
    phase: number,
    out: Vec3[],
  ): number {
    const L = this.morphology.standardLength;
    const totalArc = this.morphology.totalArc;
    const k = (2 * Math.PI) / (FISH.waveLengthRatio * L);
    const segs = this.morphology.segments;
    const n = segs.length;

    // --- 1. Dense sample of the laterally offset centreline ---
    for (let j = 0; j <= DENSE; j++) {
      const arc = (j / DENSE) * totalArc;
      // s is measured in body lengths, so it runs past 1 over the caudal fin and
      // the amplitude envelope keeps growing — which is what makes the fin's
      // trailing edge the biggest-amplitude part of the animal.
      const s = arc / L;
      const env = amplitudeEnvelope(s) * amplitude;
      const theta = k * arc - phase;
      const wave = Math.sin(theta);
      const steer = bend * (1 + FISH.bendReflexGain * agility);
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
      this.denseY[j] = pitchBend * bendShape(s) * 0.55;
      this.denseZ[j] = -arc;
    }
    const excursion = Math.abs(this.denseX[DENSE]);

    // --- 1b. The curl ---
    //
    // Laid on by turning each short piece of the centreline through an angle
    // that grows from nothing behind the head to the full curl at the root of
    // the tail fin, and adding the pieces up again. Turning the pieces keeps
    // their lengths, so the body can fold through any angle without the shape
    // above, which is drawn as a sideways offset from a straight line, having
    // to describe a curve that doubles back on itself.
    if (Math.abs(curl) > 1e-9) {
      const full = curl * FISH.curlMax;
      let prevX = this.denseX[0];
      let prevZ = this.denseZ[0];
      for (let j = 1; j <= DENSE; j++) {
        const sMid = ((j - 0.5) / DENSE) * totalArc / L;
        const angle = full * curlProfile(sMid, curlAt);
        const c = Math.cos(angle);
        const sn = Math.sin(angle);
        const dx = this.denseX[j] - prevX;
        const dz = this.denseZ[j] - prevZ;
        prevX = this.denseX[j];
        prevZ = this.denseZ[j];
        this.denseX[j] = this.denseX[j - 1] + dx * c - dz * sn;
        this.denseZ[j] = this.denseZ[j - 1] + dx * sn + dz * c;
      }
    }

    // --- 2. Cumulative arc length along that curve ---
    this.denseArc[0] = 0;
    for (let j = 1; j <= DENSE; j++) {
      const dx = this.denseX[j] - this.denseX[j - 1];
      const dy = this.denseY[j] - this.denseY[j - 1];
      const dz = this.denseZ[j] - this.denseZ[j - 1];
      this.denseArc[j] = this.denseArc[j - 1] + Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    // --- 3. Resample at uniform arc length, so the body cannot stretch ---
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
      set(out[i], x, y, z);
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
      cx += out[i].x * m;
      cy += out[i].y * m;
      cz += out[i].z * m;
    }
    cx /= M;
    cy /= M;
    cz /= M;
    for (let i = 0; i < n; i++) {
      out[i].x -= cx;
      out[i].y -= cy;
      out[i].z -= cz;
    }

    return excursion;
  }

  private updateCurlWater(dt: number): void {
    const cw = this.curlWater;
    // The steering bend counts as well as the curl. It swings the tail and
    // its fins a long way off the fish's line too (twenty degrees for an
    // ordinary bend, over fifty for a startled one), and a fish that bent
    // quickly while the sums still took it for a straight dart was thrown
    // backwards at the speed limit, twelve body lengths a second.
    const steer = this.actualBend * (1 + FISH.bendReflexGain * this.actualAgility);
    if (Math.abs(this.actualCurl) < 1e-9 && Math.abs(steer) < 1e-9) {
      if (cw.active) this.curlAngle.fill(0);
      cw.active = false;
      this.curlWaterFor = 0;
      this.curlWaterSteer = 0;
      this.finTurn = 0;
      return;
    }
    if (
      cw.active &&
      this.actualCurl === this.curlWaterFor &&
      this.actualCurlAt === this.curlWaterAt &&
      steer === this.curlWaterSteer
    ) {
      this.finTurn = 0;
      return;
    }
    this.curlWaterSteer = steer;
    this.layout(0, this.actualBend, 0, this.actualAgility, this.actualCurl, this.actualCurlAt, 0, this.curlPos);
    const segs = this.morphology.segments;
    const n = segs.length;
    let xx = 0;
    let xz = 0;
    let zz = 0;
    let yaw = 0;
    let xYaw = 0;
    let zYaw = 0;
    let turned = 0;
    for (let i = 0; i < n; i++) {
      const angle = this.actualCurl * FISH.curlMax * curlProfile(segs[i].s, this.actualCurlAt);
      turned += this.finWeight[i] * (angle - this.curlAngle[i]);
      this.curlAngle[i] = angle;
      const a = this.curlPos[Math.max(0, i - 1)];
      const b = this.curlPos[Math.min(n - 1, i + 1)];
      const tx = b.x - a.x;
      const tz = b.z - a.z;
      const l = Math.hypot(tx, tz) || 1;
      // Sideways to the centreline, in the plane of the curl.
      const nx = tz / l;
      const nz = -tx / l;
      const m = segs[i].addedMassPerLength * segs[i].ds;
      const r = this.curlPos[i];
      const arm = r.z * nx - r.x * nz;
      xx += m * nx * nx;
      xz += m * nx * nz;
      zz += m * nz * nz;
      yaw += m * arm * arm;
      xYaw += m * nx * arm;
      zYaw += m * nz * arm;
    }
    // The water the fins carry sits well behind the centre of mass, so pushing
    // the fish sideways also turns it, and turning it also pushes it sideways.
    // A straight fish is treated as though that were not so (it is how the
    // swimming was worked out and checked), so the link is brought in as the
    // fish curls rather than all at once.
    const t = Math.min(1, Math.abs(this.actualCurl) / 0.2);
    const link = t * t * (3 - 2 * t);
    cw.xx = xx;
    cw.xz = xz * link;
    cw.zz = zz;
    cw.yaw = yaw;
    cw.xYaw = xYaw * link;
    cw.zYaw = zYaw * link;
    cw.active = true;
    this.curlWaterFor = this.actualCurl;
    this.curlWaterAt = this.actualCurlAt;
    this.finTurn = dt > 0 ? -turned / dt : 0;
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
