/**
 * The fish's brain: what it senses, what it wants, and what it does about it.
 *
 * The architecture follows Tu and Terzopoulos, *Artificial Fishes* (SIGGRAPH
 * 1994) — perception feeds a set of internal state variables, an intention
 * generator picks one intention with enough hysteresis that the fish does not
 * dither, and a behaviour routine turns that intention into muscle commands.
 * Their fish had hunger, libido and fear. A lone captive betta needs a different
 * set, and the most important one is not on their list at all.
 *
 * **The fish has to breathe.** Bettas are labyrinth fish: they take air at the
 * surface every few minutes and will drown without access to it. That single
 * fact does more for the illusion of life than anything else here, because it is
 * an internal state with no external cause. A fish that swims to the surface,
 * breaks it, and goes back down — on its own schedule, for its own reasons, with
 * nothing in the scene prompting it — reads as an animal in a way that no amount
 * of reactive behaviour does.
 *
 * Nothing in this file moves the fish. Every routine produces a *motor goal*,
 * and the steering layer converts that into a tail-beat frequency, an amplitude
 * and a bend. What actually happens is then up to the water.
 */

import {
  Vec3,
  v3,
  set,
  copy,
  sub,
  scale,
  addScaled,
  dot,
  len,
  dist,
  normalize,
  clamp,
  saturate,
  smoothstep,
  expApproach,
  quatRotateInv,
} from './math.js';
import {
  DRIVES,
  FISH,
  FOOD,
  INTENTION,
  PERCEPTION,
  TANK,
  TANK_MIN_X,
  TANK_MAX_X,
  TANK_MIN_Z,
  TANK_MAX_Z,
  WorldConfig,
} from './config.js';
import { Rng } from './rng.js';
import { TIP_S } from './morphology.js';
import { MotorCommand } from './fishBody.js';
import { FishBody } from './fishBody.js';
import { FishLocomotion } from './locomotion.js';
import { WaterSurface } from './water.js';
import { Pellet } from './food.js';
import { NavGrid } from './navigation.js';

export type Intention =
  | 'escape'
  | 'surface'
  | 'flare'
  | 'strike'
  | 'forage'
  | 'rest'
  | 'inspect'
  | 'patrol'
  | 'avoid';

export const ALL_INTENTIONS: Intention[] = [
  'escape',
  'surface',
  'flare',
  'strike',
  'forage',
  'rest',
  'inspect',
  'patrol',
  'avoid',
];

/** Everything the fish can currently feel, refreshed once per brain tick. */
export interface Percepts {
  /** Nearest pellet the fish can actually detect, or null. */
  nearestFood: Pellet | null;
  foodDistance: number;
  /** Strength of the food scent gradient, and which way it points. */
  scentGradient: Vec3;
  /** Something big is approaching the glass fast. 0 to 1. */
  looming: number;
  /** A rival is visible — in practice, a face at the glass or the fish's own reflection. */
  rivalVisible: number;
  rivalDirection: Vec3;
  /** How close the nearest wall is, and the direction away from it. */
  wallDistance: number;
  wallAway: Vec3;
  /** Water disturbance picked up by the lateral line, including in the blind spot. */
  disturbance: number;
  disturbanceDirection: Vec3;
  /** How familiar the fish's current spot is, 0 (new) to 1 (thoroughly explored). */
  familiarity: number;
}

/** The fish's internal state. All in [0, 1]. */
export interface Drives {
  hunger: number;
  /** How badly it needs a breath of air at the surface. */
  airDebt: number;
  fear: number;
  fatigue: number;
  aggression: number;
  boredom: number;
}

/** What a behaviour routine asks for. Never a velocity, never a position to teleport to. */
export interface MotorGoal {
  /** Where the fish is trying to get to. */
  target: Vec3;
  /** How fast it wants to go, in body lengths per second. */
  speedSL: number;
  /** 0 = ambling, 1 = emergency. Scales how hard it turns and how much it flares. */
  urgency: number;
  /** How far the fish wants its fins spread, 0 (clamped) to 1 (full display). */
  finSpread: number;
  /** Gill covers out, for the threat display. */
  gillFlare: number;
  /** Mouth open, for the suction strike. */
  mouthOpen: number;
  /** Whether the fish should be holding station rather than travelling. */
  hover: boolean;
  /**
   * Coasting: the tail stops and the fish runs on with what speed it has. A
   * fish going nowhere in particular does not beat its tail without a break;
   * it gives a few beats and glides, and gives a few more.
   */
  glide: boolean;
  /**
   * Bending the front of the body round to look at something beside it,
   * -1 to +1, without swimming off that way. Straightening again brings the
   * head back.
   */
  look: number;
}

/** External stimuli the outside world hands to the brain. */
export interface Stimuli {
  /**
   * Where the viewer's face is, in tank coordinates, or null if unknown.
   *
   * On the phone this comes from the front camera. It is the single most
   * effective input in the whole system: a betta reacts strongly to a face at
   * the glass, and a fish that notices you approach and comes to look is the
   * thing people find uncanny.
   */
  viewerPosition: Vec3 | null;
  /** How fast the viewer is approaching, m/s. Positive is towards the glass. */
  viewerApproachSpeed: number;
  /** A tap on the glass, decaying. */
  tapImpulse: number;
  /** Where the tap was. */
  tapPosition: Vec3;
}

/**
 * How far a suction strike reaches.
 *
 * About a third of the fish's body length. That sounds generous and is not: a
 * suction-feeding fish generates an inflow that entrains prey from roughly one
 * mouth diameter away, and a betta taking a floating pellet essentially engulfs
 * a volume of water around it rather than picking it up precisely.
 */
const STRIKE_RANGE = 0.018;
/**
 * How close the pellet has to get before it is inside the mouth.
 *
 * A betta's gape is around 3 mm. This is measured from the snout tip to the
 * pellet's centre, so a couple of millimetres of that is simply the geometry of
 * where the reference point sits relative to the opening.
 */
const SWALLOW_RANGE = 0.009;
/**
 * How close the snout's centreline has to come to the surface for the fish to
 * have its mouth in the air. The top of the head is a few millimetres above the
 * point this is measured from, so this is head depth, not slack.
 */
const SURFACE_REACH = 0.005;
/** Peak inflow speed at the mouth during a strike, m/s. */
const SUCTION_SPEED = 0.14;

/** The fish turns round by folding, rather than steering, when its goal is further off its nose than this. Radians. */
const TURN_FOLD_FROM = 0.5;
/** How far ahead, in seconds, a hovering fish looks at its own rise or fall when trimming its bladder. */
const BLADDER_LEAD = 3;
/** How long the fold is given to form before the fish swims out of it, seconds. */
const TURN_FOLD_TIME = 0.42;
/** Where the middle of the fold has to get to for the whole of it to be off the tail, in body lengths. */
const TURN_FOLD_OFF = TIP_S + FISH.curlWidth / 2 + 0.15;

const scratch = {
  extremes: [v3(), v3(), v3(), v3(), v3(), v3()] as Vec3[],
  toTarget: v3(),
  desired: v3(),
  fwd: v3(),
  up: v3(),
  right: v3(),
  tmp: v3(),
  tmp2: v3(),
  local: v3(),
  away: v3(),
};

export class FishBrain {
  readonly drives: Drives = {
    hunger: 0.28,
    airDebt: 0.15,
    fear: 0,
    fatigue: 0.05,
    aggression: 0,
    boredom: 0.3,
  };

  readonly percepts: Percepts = {
    nearestFood: null,
    foodDistance: Infinity,
    scentGradient: v3(),
    looming: 0,
    rivalVisible: 0,
    rivalDirection: v3(),
    wallDistance: Infinity,
    wallAway: v3(),
    disturbance: 0,
    disturbanceDirection: v3(),
    familiarity: 0,
  };

  readonly goal: MotorGoal = {
    target: v3(),
    speedSL: 0,
    urgency: 0,
    finSpread: 0.55,
    gillFlare: 0,
    mouthOpen: 0,
    hover: false,
    glide: false,
    look: 0,
  };

  intention: Intention = 'patrol';
  /** How long the current intention has been running. */
  intentionAge = 0;
  /** Desire values from the last arbitration, for the debug HUD. */
  readonly desires: Record<Intention, number> = Object.fromEntries(
    ALL_INTENTIONS.map((i) => [i, 0]),
  ) as Record<Intention, number>;

  /** Familiarity of each cell of the tank, driving novelty-seeking. */
  private readonly familiarity: Float32Array;
  private readonly grid = PERCEPTION.noveltyGrid;

  /** State internal to individual routines. */
  private patrolTarget = v3();
  private forageHeading = 0;
  private forageTimer = 0;
  private surfacePhase: 'approach' | 'gulp' | 'leave' = 'approach';
  /** Exposed for diagnostics. */
  get surfacePhaseDebug(): string { return this.surfacePhase; }
  private surfaceTimer = 0;
  private escapeTimer = 0;
  private escapeDirection = v3();
  private aggressionRefractory = 0;
  private strikeTimer = 0;
  private inspectTimer = 0;
  private restTarget = v3();
  private yawRateFiltered = 0;
  private pitchRateFiltered = 0;

  /**
   * Turning round. 'fold': the body is curling and the head coming round.
   * 'follow': the fish is swimming out along the curve while the fold runs
   * down its body and off its tail.
   */
  private turnPhase: 'none' | 'fold' | 'follow' = 'none';
  /** Exposed for diagnostics. */
  get turnPhaseDebug(): string { return this.turnPhase; }
  private turnTimer = 0;
  private turnCurl = 0;
  private turnFoldAt: number = FISH.curlAt;
  private turnRest = 0;

  /** What the fish is doing when it has nothing it needs to do. */
  private idleMode: 'amble' | 'pause' = 'pause';
  /** Exposed for diagnostics. */
  get idleModeDebug(): string { return this.idleMode; }
  private idleTimer = 1.5;
  private ambleSpeed = 0.8;
  private strokeTimer = 0;
  private stroking = true;
  private lookTimer = 3;
  private lookHold = 0;
  private lookCurl = 0;
  private readonly pauseHeading = v3(0, 0, 1);

  /** Set when the fish takes a breath, so the world can make a bubble and ripples. */
  gulpedThisTick = false;
  /** Set when the fish's mouth closes on a pellet. */
  atePelletThisTick: Pellet | null = null;

  /**
   * Where the fish's mouth is, in world space, refreshed each tick.
   *
   * Distances to food are measured from here, not from the centre of mass. The
   * mouth is a couple of centimetres in front of the centre of mass, which is
   * most of a body length on a fish this size — measuring from the centre meant
   * the strike could only succeed with the pellet somewhere inside the fish, so
   * it never did.
   */
  readonly mouth = v3();

  private readonly rng: Rng;
  private readonly cfg: WorldConfig;

  /**
   * The route-finding grid, which knows where the wood, the stones and the
   * plants are. Null in open-water tests, where the fish steers straight.
   */
  nav: NavGrid | null = null;
  /** The route being followed, cube centres from the fish to its goal. */
  readonly route: Vec3[] = [];
  /** Where the route was planned to. */
  private readonly routeGoal = v3();
  private routeTimer = 0;
  /** Where the fish is heading along its route this tick, for diagnostics; equal to the goal in open water. */
  readonly waypoint = v3();
  /** Whether the fish is following a route round something rather than heading straight for its goal. */
  detouring = false;

  constructor(cfg: WorldConfig) {
    this.cfg = cfg;
    this.rng = new Rng(cfg.seed ^ 0x9e3779b9);
    this.familiarity = new Float32Array(this.grid.nx * this.grid.ny * this.grid.nz);
    set(this.patrolTarget, 0, TANK.waterY - 0.04, -TANK.depth * 0.5);
    set(this.restTarget, 0, TANK.floorY + 0.01, -TANK.depth * 0.5);
  }

  // -------------------------------------------------------------------------
  // Perception
  // -------------------------------------------------------------------------

  private perceive(
    loco: FishLocomotion,
    body: FishBody,
    pellets: Pellet[],
    water: WaterSurface,
    stim: Stimuli,
    dt: number,
  ): void {
    const p = this.percepts;
    loco.forward(scratch.fwd);
    loco.toWorld(body.snout(scratch.tmp2), this.mouth);

    // --- Food, by sight ---
    p.nearestFood = null;
    p.foodDistance = Infinity;
    for (const pellet of pellets) {
      if (!pellet.alive) continue;
      const d = dist(pellet.position, this.mouth);
      if (d > PERCEPTION.visionRange) continue;

      sub(scratch.tmp, pellet.position, this.mouth);
      normalize(scratch.tmp, scratch.tmp);
      const cosAngle = dot(scratch.tmp, scratch.fwd);
      const angle = Math.acos(clamp(cosAngle, -1, 1));
      if (angle > PERCEPTION.visionHalfAngle) continue; // in the blind spot behind

      // Acuity falls off with distance, and the narrow binocular wedge straight
      // ahead is much sharper — which is why the fish turns to face something
      // before it commits to striking at it.
      let acuity = 1 / Math.max(0.01, d);
      if (angle < PERCEPTION.binocularHalfAngle) acuity *= PERCEPTION.binocularAcuityBonus;
      const contrast = pellet.radius * 400;
      if (contrast * acuity < PERCEPTION.detectionThreshold) continue;

      if (d < p.foodDistance) {
        p.foodDistance = d;
        p.nearestFood = pellet;
      }
    }

    // --- Food, by smell ---
    //
    // Scent finds food the fish never saw arrive. Each pellet leaves a cloud
    // that spreads as sqrt(time), and the fish climbs the total gradient.
    set(p.scentGradient, 0, 0, 0);
    for (const pellet of pellets) {
      if (!pellet.alive) continue;
      sub(scratch.tmp, pellet.position, this.mouth);
      const d = len(scratch.tmp);
      const sigma = Math.max(0.005, Math.sqrt(2 * 2.5e-5 * pellet.age));
      if (d > sigma * 4) continue;
      const g = Math.exp(-(d * d) / (2 * sigma * sigma)) / Math.max(1e-4, d);
      addScaled(p.scentGradient, scratch.tmp, g);
    }

    // --- Walls ---
    // Distances from the snout and the centre of mass. Avoidance is about
    // where the fish is going, so the front of it is what matters; the tail
    // and fins are the contact model's business. Sensing from every extreme of
    // the body was tried and made most of an 8.5 cm deep tank "near a wall":
    // avoidance fired a hundred and forty times in two minutes.
    const snout = loco.bodyExtremes(scratch.extremes)[0];
    const dxMin = Math.min(loco.position.x, snout.x) - TANK_MIN_X;
    const dxMax = TANK_MAX_X - Math.max(loco.position.x, snout.x);
    const dzMin = Math.min(loco.position.z, snout.z) - TANK_MIN_Z;
    const dzMax = TANK_MAX_Z - Math.max(loco.position.z, snout.z);
    const dyMin = Math.min(loco.position.y, snout.y) - TANK.floorY;

    // The water surface is deliberately not in this list.
    //
    // It is a boundary, but it is not an obstacle: the fish has to reach it to
    // breathe and to take food off it. Counting it as a wall meant the avoidance
    // steering pushed the fish down every time it got close, so it could
    // approach a floating pellet to within about three centimetres and then be
    // shoved away from it — repeatedly, and forever. The fish starved next to
    // its food.
    p.wallDistance = Math.min(dxMin, dxMax, dzMin, dzMax, dyMin);

    // The driftwood and the stones count as walls too, measured from the
    // head (allowing for its own size) and from the middle of the body, and
    // pushing away from them may be up as well as sideways: the way past a
    // branch is often over it.
    let hard = Infinity;
    const ob = this.nav?.obstacles;
    if (ob) {
      const atSnout = ob.hardDistance(snout.x, snout.y, snout.z, scratch.away) - 0.003;
      const atMiddle =
        ob.hardDistance(loco.position.x, loco.position.y, loco.position.z, scratch.tmp) - FISH.maxDepth / 2;
      hard = atSnout;
      if (atMiddle < atSnout) {
        hard = atMiddle;
        copy(scratch.away, scratch.tmp);
      }
      // Counted at twice its distance. Judged like the glass, from three
      // centimetres out, the wood beside the route the fish was following
      // round it (findWay keeps it one to two centimetres clear) set off a
      // swerve twenty to forty times in five minutes, mostly as the fish
      // swam out of a turn, and each one threw it off its route.
      hard *= 2;
      p.wallDistance = Math.min(p.wallDistance, hard);
    }
    set(p.wallAway, 0, 0, 0);
    if (p.wallDistance < INTENTION.wallAvoidDistance) {
      // Push away from every nearby wall at once, weighted by how close it is.
      // Summing rather than picking the nearest is what stops the fish getting
      // stuck oscillating in a corner between two competing pushes.
      const w = (d: number) => (d < INTENTION.wallAvoidDistance ? 1 / Math.max(0.004, d * d) : 0);
      p.wallAway.x += w(dxMin) - w(dxMax);
      p.wallAway.z += w(dzMin) - w(dzMax);
      p.wallAway.y += w(dyMin);
      addScaled(p.wallAway, scratch.away, w(hard));
      normalize(p.wallAway, p.wallAway);
    }

    // --- The viewer, as both a threat and a rival ---
    p.looming = 0;
    p.rivalVisible = 0;
    set(p.rivalDirection, 0, 0, 0);
    if (stim.viewerPosition) {
      const d = dist(stim.viewerPosition, loco.position);
      // Looming is the rate at which something's apparent size grows. It is a
      // real and fast escape pathway in fish, separate from recognising what the
      // thing is — which is why a hand moving at the glass startles a fish that
      // has seen a hundred hands.
      if (stim.viewerApproachSpeed > 0 && d > 0.02) {
        const loomRate = (2 * stim.viewerApproachSpeed) / d;
        p.looming = saturate((loomRate - PERCEPTION.loomingThreshold) / PERCEPTION.loomingThreshold);
      }
      // A face held at the glass reads to a male betta as a rival to be seen off.
      if (d < 0.5 && stim.viewerApproachSpeed < 0.05) {
        p.rivalVisible = saturate(1 - d / 0.5);
        sub(p.rivalDirection, stim.viewerPosition, loco.position);
        normalize(p.rivalDirection, p.rivalDirection);
      }
    }

    // --- Lateral line ---
    //
    // A pressure-gradient sense running along the flank. It works in the blind
    // spot and in the dark, and it is how a pellet landing behind the fish gets
    // noticed at all.
    p.disturbance = 0;
    set(p.disturbanceDirection, 0, 0, 0);
    for (const pellet of pellets) {
      if (!pellet.alive || pellet.age > 1.5) continue;
      const d = dist(pellet.position, loco.position);
      if (d > PERCEPTION.lateralLineRange) continue;
      const strength = (1 - d / PERCEPTION.lateralLineRange) * pellet.impactEnergy;
      if (strength > p.disturbance) {
        p.disturbance = strength;
        sub(p.disturbanceDirection, pellet.position, loco.position);
        normalize(p.disturbanceDirection, p.disturbanceDirection);
      }
    }
    if (stim.tapImpulse > PERCEPTION.lateralLineThreshold) {
      p.disturbance = Math.max(p.disturbance, saturate(stim.tapImpulse));
    }

    // --- Familiarity of where it currently is ---
    const cell = this.cellIndex(loco.position);
    p.familiarity = this.familiarity[cell];
    this.familiarity[cell] = Math.min(1, this.familiarity[cell] + PERCEPTION.familiarityRise * dt);
    for (let i = 0; i < this.familiarity.length; i++) {
      this.familiarity[i] = Math.max(0, this.familiarity[i] - PERCEPTION.familiarityDecay * dt);
    }
  }

  private cellIndex(p: Vec3): number {
    const g = this.grid;
    const ix = clamp(Math.floor(((p.x - TANK_MIN_X) / TANK.width) * g.nx), 0, g.nx - 1);
    const iy = clamp(
      Math.floor(((p.y - TANK.floorY) / Math.max(1e-4, TANK.waterY - TANK.floorY)) * g.ny),
      0,
      g.ny - 1,
    );
    const iz = clamp(Math.floor(((p.z - TANK_MIN_Z) / TANK.depth) * g.nz), 0, g.nz - 1);
    return (iz * g.ny + iy) * g.nx + ix;
  }

  // -------------------------------------------------------------------------
  // Internal state
  // -------------------------------------------------------------------------

  private updateDrives(loco: FishLocomotion, dt: number): void {
    const d = this.drives;
    const ts = this.cfg.timeScale;
    // (speed itself is no longer an input to the drives; see `effort` below)
    // Effort, from what the muscles are doing rather than from how fast the
    // fish happens to be moving. The two differ exactly when it matters: a fish
    // bounced off the glass is moving fast and working not at all, and a fish
    // pushing against a current is working hard and going nowhere. The tail-beat
    // frequency is the muscle's own clock; a brisk cruise is about three beats a
    // second on this fish.
    const beat = this.lastCommandFrequency;
    const effort = saturate(beat / 3);

    d.hunger = saturate(d.hunger + DRIVES.hungerRate * (1 + DRIVES.hungerActivityGain * effort) * dt * ts);

    // Air debt. Working hard uses air faster, so an agitated fish surfaces more
    // often than a calm one — which is a visible, legible consequence of an
    // invisible internal state, and is most of why the fish reads as alive.
    d.airDebt = saturate(d.airDebt + DRIVES.airRate * (1 + DRIVES.airActivityGain * effort) * dt * ts);

    d.fear = expApproach(d.fear, 0, 1 / DRIVES.fearTau, dt * ts);
    d.aggression = expApproach(d.aggression, 0, 1 / DRIVES.aggressionTau, dt * ts);
    this.aggressionRefractory = Math.max(0, this.aggressionRefractory - dt * ts);

    // Fatigue climbs with the cube of speed above the aerobic threshold: the
    // cost of transport is steeply nonlinear, which is why a fish bursts briefly
    // and then has to stop.
    //
    // The threshold is where the fish switches from red muscle to white — around
    // four body lengths a second for a small fish. Setting it at two, which is
    // an ordinary cruising speed, meant the fish was accruing fatigue whenever it
    // moved at all: it saturated, `rest` won permanently, and the fish lay on the
    // bottom and never surfaced for air again.
    // In beats per second rather than body lengths per second: the fit of speed
    // against beat frequency for this fish puts four body lengths a second at
    // about 4.3 Hz, and using the beat means a collision cannot be mistaken for
    // a sprint.
    const burst = Math.max(0, beat - DRIVES.aerobicBeatHz);
    const flaring = this.intention === 'flare' ? DRIVES.fatigueFlareGain : 0;
    d.fatigue = saturate(
      d.fatigue + (DRIVES.fatigueSpeedGain * burst * burst * burst + flaring * 0.01) * dt * ts,
    );
    d.fatigue = expApproach(d.fatigue, 0, 1 / DRIVES.fatigueTau, dt * ts);

    // Boredom tracks how well the fish already knows where it is.
    const target = this.percepts.familiarity;
    d.boredom = expApproach(d.boredom, target, DRIVES.boredomRate * 4, dt * ts);
  }

  /** Something startled the fish. Called by the world for taps, looms and impacts. */
  startle(amount: number, direction: Vec3): void {
    this.drives.fear = saturate(this.drives.fear + amount);
    copy(this.escapeDirection, direction);
  }

  // -------------------------------------------------------------------------
  // Intention arbitration
  // -------------------------------------------------------------------------

  private arbitrate(loco: FishLocomotion, dt: number): void {
    const d = this.drives;
    const p = this.percepts;
    const de = this.desires;

    // Escape outranks obstacle avoidance. A startled fish performs its C-start
    // whether or not there is glass in the way — real ones hit the glass, and a
    // fish that politely declines to flee because it is near a wall is not a
    // fish. The only thing above it is suffocation.
    de.escape = d.fear * 1.30;
    de.surface = smoothstep(DRIVES.airUrgentAt, 1.0, d.airDebt) * (1 - 0.5 * d.fear);
    de.flare =
      d.aggression * p.rivalVisible * (1 - d.fear) * (1 - 0.7 * d.fatigue) *
      (this.aggressionRefractory > 0 ? 0 : 1);
    de.strike = p.nearestFood
      ? smoothstep(0.10, 0.55, d.hunger) * saturate(1 - p.foodDistance / PERCEPTION.visionRange)
      : 0;
    de.forage = smoothstep(0.30, 0.85, d.hunger) * (p.nearestFood ? 0.2 : 1);
    de.rest = smoothstep(0.55, 1.0, d.fatigue) * (1 - d.hunger) * (1 - d.fear);
    de.inspect = p.rivalVisible * (1 - d.fear) * (0.3 + 0.7 * d.boredom) * 0.6;
    de.patrol = INTENTION.patrolFloor + 0.30 * d.boredom;
    de.avoid = 0;

    // 1. Obstacle avoidance, graded by how imminent the collision is.
    //
    // Not a binary override. The first version set this to 1 whenever the fish
    // was within five centimetres of any wall — which, in a tank twenty-five
    // centimetres deep, is very nearly always. With the persistence bonus on top
    // it then beat every other drive permanently, and the fish spent its entire
    // life avoiding walls: it never fed, never displayed, and could not even be
    // startled into fleeing. Nothing looked broken; it just looked listless.
    //
    // Steering away from walls is handled in `runRoutine` for *every* behaviour,
    // so this intention only has to exist for the case where the fish is about
    // to hit something and everything else must stop.
    // What matters is whether the fish is *closing* on a wall, not whether it
    // happens to be near one. A fish cruising parallel to the glass a centimetre
    // away is in no danger at all, and in a tank this small — the fish is a fifth
    // of the tank's depth long — it is near a boundary most of the time. Judging
    // by distance alone left the fish permanently in avoidance.
    loco.forward(scratch.fwd);
    const closing = -dot(loco.velocity, p.wallAway);
    if (closing > 1e-3 && p.wallDistance < INTENTION.wallAvoidDistance * 3) {
      const timeToImpact = p.wallDistance / closing;
      de.avoid = smoothstep(INTENTION.collisionLookahead * 2, INTENTION.collisionLookahead * 0.4, timeToImpact);
    } else {
      de.avoid = 0;
    }
    // A fish already turning round is already dealing with it, unless the
    // glass is right there.
    if (this.turnPhase !== 'none' && p.wallDistance > 0.012) de.avoid = 0;

    // 2. A fish that badly needs air surfaces even with a predator present,
    //    because it has to. This is a real hierarchy, not a tie-break.
    if (d.airDebt > DRIVES.airOverrideAt) de.surface = 1.45;

    // Pick the best, with the running intention holding a bonus so a challenger
    // has to be clearly better rather than marginally better.
    let best: Intention = this.intention;
    let bestValue = -Infinity;
    for (const key of ALL_INTENTIONS) {
      let value = de[key];
      if (key === this.intention) value += INTENTION.persistenceBonus;
      if (value > bestValue) {
        bestValue = value;
        best = key;
      }
    }

    // 3. Minimum dwell. Nothing switches faster than this, so the fish cannot
    //    flicker between two nearly equal options — which is what a plain argmax
    //    does and what makes simulated animals look twitchy and indecisive.
    //
    // Escape and avoidance may pre-empt anything else immediately, but once one
    // of them is running it has to serve its own dwell like everything else.
    // Letting both bypass it in *both* directions lets them alternate every
    // frame, producing intentions that last zero seconds — the exact dithering
    // this is here to prevent.
    const dwell =
      this.intention === 'escape'
        ? INTENTION.minDwellEscape
        : this.intention === 'avoid'
          ? INTENTION.minDwellAvoid
          : INTENTION.minDwell;
    // Escape may interrupt anything, including avoidance — a startled fish flees
    // whether or not there is glass in front of it. Avoidance may interrupt
    // anything except escape. Neither may interrupt itself, which is what stops
    // the two from alternating every frame.
    const preempt =
      (best === 'escape' && this.intention !== 'escape') ||
      (best === 'avoid' && this.intention !== 'avoid' && this.intention !== 'escape');
    const maySwitch = this.intentionAge >= dwell || preempt;

    if (best !== this.intention && maySwitch) {
      this.onIntentionChanged(this.intention, best, loco);
      this.intention = best;
      this.intentionAge = 0;
    } else {
      this.intentionAge += dt;
    }
  }

  private onIntentionChanged(from: Intention, to: Intention, loco: FishLocomotion): void {
    if (from === 'flare') this.aggressionRefractory = DRIVES.aggressionRefractory;
    // Having just swerved away from a wall, do not resume a course that pointed
    // straight into it. Without this the fish bounces along the glass, avoiding
    // and un-avoiding several times a second.
    //
    // The new course is somewhere ahead of where the swerve has left the fish
    // pointing, not the least-visited corner of the tank, which was usually
    // behind it: every swerve was followed at once by a second turn, and the
    // fish spent two thirds of its time turning round.
    if (from === 'avoid') this.pickPatrolTarget(loco);
    switch (to) {
      case 'surface':
        this.surfacePhase = 'approach';
        this.surfaceTimer = 0;
        break;
      case 'escape':
        this.escapeTimer = this.rng.range(0.4, 0.9);
        break;
      case 'forage':
        this.forageTimer = 0;
        this.forageHeading = Math.atan2(loco.velocity.x, loco.velocity.z);
        break;
      case 'strike':
        this.strikeTimer = 0;
        break;
      case 'inspect':
        this.inspectTimer = this.rng.range(2, 6);
        break;
      case 'patrol':
        this.pickPatrolTarget();
        break;
      case 'rest':
        this.pickRestTarget();
        break;
      default:
        break;
    }
  }

  /** Head for the least familiar corner of the tank. */
  private pickPatrolTarget(loco?: FishLocomotion): void {
    const g = this.grid;
    let worst = Infinity;
    let bestIdx = 0;
    let hx = 0;
    let hz = 0;
    if (loco) {
      loco.forward(scratch.fwd);
      const h = Math.hypot(scratch.fwd.x, scratch.fwd.z) || 1;
      hx = scratch.fwd.x / h;
      hz = scratch.fwd.z / h;
    }
    // A little noise on the comparison so the fish does not always visit the
    // cells in exactly the same order.
    for (let i = 0; i < this.familiarity.length; i++) {
      let v = this.familiarity[i] + this.rng.range(0, 0.15);
      if (loco) {
        // A fish wanders on from where it is facing. Somewhere behind it has
        // to be a good deal less familiar than somewhere ahead to be worth
        // turning right round for, and somewhere a body length away is not
        // worth setting out for at all.
        const cx = TANK_MIN_X + (((i % g.nx) + 0.5) / g.nx) * TANK.width - loco.position.x;
        const cz =
          TANK_MIN_Z + ((Math.floor(i / (g.nx * g.ny)) + 0.5) / g.nz) * TANK.depth - loco.position.z;
        const d = Math.hypot(cx, cz);
        if (d > 1e-6) {
          const cos = (cx * hx + cz * hz) / d;
          v += 0.35 * (1 - cos) * 0.5;
        }
        if (d < 0.13) v += 0.4;
      }
      if (v < worst) {
        worst = v;
        bestIdx = i;
      }
    }
    const ix = bestIdx % g.nx;
    const iy = Math.floor(bestIdx / g.nx) % g.ny;
    const iz = Math.floor(bestIdx / (g.nx * g.ny));
    // Somewhere in that cell, but not hard against the glass, the sand or
    // the surface. The fish is seven centimetres long with its tail fin, and
    // a spot three centimetres from a pane is one it can only reach by
    // brushing the pane with its fins on the way in and again turning to
    // leave. It was touching glass or sand about eighty times a minute.
    set(
      this.patrolTarget,
      clamp(TANK_MIN_X + ((ix + 0.5) / g.nx) * TANK.width, TANK_MIN_X + 0.055, TANK_MAX_X - 0.055),
      clamp(
        TANK.floorY + ((iy + 0.5) / g.ny) * (TANK.waterY - TANK.floorY),
        TANK.floorY + 0.03,
        TANK.waterY - 0.022,
      ),
      clamp(TANK_MIN_Z + ((iz + 0.5) / g.nz) * TANK.depth, TANK_MIN_Z + 0.055, TANK_MAX_Z - 0.055),
    );
    // Not inside the wood or a stone, nor in the thick of a plant: somewhere
    // to wander to is somewhere in the open. (The fish still goes into the
    // plants on its way, where the way lies through them.)
    if (this.nav) this.nav.openPoint(this.patrolTarget, this.patrolTarget, 1.5);
  }

  private pickRestTarget(): void {
    // Bettas rest on leaves rather than lying on the substrate. The world places
    // a broad leaf in the middle of the water column for exactly this.
    set(
      this.restTarget,
      this.rng.range(-0.05, 0.05),
      TANK.floorY + 0.045,
      TANK_MIN_Z + TANK.depth * this.rng.range(0.4, 0.7),
    );
  }

  // -------------------------------------------------------------------------
  // Behaviour routines: intention -> motor goal
  // -------------------------------------------------------------------------

  private runRoutine(loco: FishLocomotion, water: WaterSurface, dt: number): void {
    const g = this.goal;
    const p = this.percepts;
    g.hover = false;
    g.glide = false;
    g.look = 0;
    g.mouthOpen = 0;
    g.gillFlare = 0;
    this.gulpedThisTick = false;
    this.atePelletThisTick = null;

    switch (this.intention) {
      case 'avoid': {
        copy(g.target, loco.position);
        addScaled(g.target, p.wallAway, 0.12);
        g.target.y = clamp(g.target.y, TANK.floorY + 0.02, TANK.waterY - 0.01);
        g.speedSL = 1.6;
        // A wall is not a predator. Half urgency at most: a swerve, not a
        // burst — at full urgency the swerve itself flung the fish about.
        g.urgency = 0.5 * saturate(1 - p.wallDistance / INTENTION.wallAvoidDistance);
        g.finSpread = 0.6;
        break;
      }

      case 'escape': {
        // A C-start: the fish bends into a C on the first frame and fires. Real
        // escape latency is 5 to 15 ms, so this begins on the very next physics
        // step rather than after a wind-up.
        this.escapeTimer -= dt;
        copy(g.target, loco.position);
        addScaled(g.target, this.escapeDirection, -0.15);
        g.target.y = clamp(g.target.y, TANK.floorY + 0.02, TANK.waterY - 0.015);
        g.speedSL = 9;
        g.urgency = 1;
        g.finSpread = 0.25; // fins clamp in a burst, to cut drag
        if (this.escapeTimer <= 0) this.drives.fear *= 0.35;
        break;
      }

      case 'surface': {
        // Approach, break the surface, gulp, leave. The gulp is what the whole
        // drive exists for and it is worth doing properly: the snout genuinely
        // crosses the water line, which makes real ripples. The water line is
        // taken where the snout is: with the surface rippled, the height above
        // the middle of the body can be a couple of millimetres off.
        const surfaceY = water.heightAt(this.mouth.x, this.mouth.z);
        this.surfaceTimer += dt;
        switch (this.surfacePhase) {
          case 'approach': {
            // Aim so the *snout* reaches the surface, at a point *ahead* of the
            // fish rather than directly above it.
            //
            // A target straight overhead is ill-conditioned: the heading error is
            // the angle to something at zero horizontal distance, so it is
            // essentially arbitrary and flips about. The fish then spends all its
            // effort turning — and because it slows down to turn, it stalls a few
            // millimetres short of the air it needs and hangs there indefinitely.
            // Swimming up at a shallow angle is also simply what a fish does; it
            // does not levitate.
            const lift = loco.position.y - this.mouth.y;
            loco.forward(scratch.fwd);
            const ahead = 0.045;
            set(
              g.target,
              this.mouth.x + scratch.fwd.x * ahead,
              surfaceY + 0.003 + lift,
              this.mouth.z + scratch.fwd.z * ahead,
            );
            g.speedSL = 1.4;
            g.urgency = 0.5;
            // The tolerance is the depth of the fish's own head. What actually
            // breaks the surface is the top of the snout, a few millimetres above
            // the centreline point this is measured from.
            if (this.mouth.y > surfaceY - SURFACE_REACH) {
              this.surfacePhase = 'gulp';
              this.surfaceTimer = 0;
            }
            break;
          }
          case 'gulp': {
            const lift = loco.position.y - this.mouth.y;
            loco.forward(scratch.fwd);
            set(
              g.target,
              this.mouth.x + scratch.fwd.x * 0.02,
              surfaceY + 0.004 + lift,
              this.mouth.z + scratch.fwd.z * 0.02,
            );
            g.speedSL = 0.2;
            g.hover = true;
            g.mouthOpen = 0.8;
            // The breath only counts if the snout is genuinely at the surface.
            // Running it off a timer alone let the fish "gulp air" a centimetre
            // and a half under water whenever it got jostled on the way up.
            if (this.surfaceTimer > 0.22 && this.mouth.y > surfaceY - SURFACE_REACH * 1.4) {
              this.drives.airDebt = 0;
              this.gulpedThisTick = true;
              this.surfacePhase = 'leave';
              this.surfaceTimer = 0;
            }
            // If it has been trying for too long, give up and come back later,
            // rather than hanging at the surface indefinitely.
            if (this.surfaceTimer > 2.5) this.surfacePhase = 'approach';
            break;
          }
          case 'leave':
            set(g.target, loco.position.x, surfaceY - 0.05, loco.position.z - 0.03);
            g.speedSL = 1.8;
            g.urgency = 0.4;
            break;
        }
        g.finSpread = 0.5;
        break;
      }

      case 'flare': {
        // Hold station facing the rival, gill covers out, everything spread.
        // Fatigue accumulates fast while doing this, so displays self-limit
        // after twenty to forty seconds, as real ones do.
        copy(g.target, loco.position);
        addScaled(g.target, p.rivalDirection, 0.02);
        g.speedSL = 0.1;
        g.hover = true;
        g.urgency = 0.7;
        g.finSpread = 1.0;
        g.gillFlare = saturate(this.intentionAge / 0.35);
        break;
      }

      case 'strike': {
        const food = p.nearestFood;
        if (!food) break;
        // Head straight for the pellet. The mouth is on the fish's centreline,
        // two and a half centimetres ahead of the centre of mass, so pointing
        // the body at the pellet is what brings the mouth onto it.
        //
        // An earlier version aimed the centre of mass at the pellet shifted
        // back by the mouth's offset, so that the mouth would land on it. That
        // is how you would move a point, but a fish cannot slide sideways; it
        // turns. Close in, with the pellet a few millimetres to one side of the
        // snout, the shifted point sat beside the fish's middle, and a ten-
        // degree correction read as a ninety-degree turn. The fish pivoted on
        // the spot in seven of every ten frames within two centimetres of its
        // food, instead of closing on it, and often circled away.
        copy(g.target, food.position);
        const d = p.foodDistance;

        // Slow down as it closes, rather than switching between two speeds.
        // Charging a two-millimetre pellet at two body lengths a second and
        // hoping to stop in time does not work: the fish overshot every single
        // time and then had to come round again.
        g.speedSL = clamp(d * 45, 0.5, 2.2);
        g.urgency = 0.6;
        g.finSpread = 0.55;
        // Switch to holding station on the pectorals only at the last moment.
        //
        // The threshold matters more than it looks. Hovering means the tail
        // stops and the pectorals take over, and pectorals are for station
        // keeping, not for covering ground — set this too far out and the fish
        // coasts to a halt just short of the pellet and sits there rowing
        // gently, unable to close the last two centimetres. It looks for all the
        // world like a fish that has decided not to bother.
        g.hover = d < STRIKE_RANGE * 0.6;

        // --- The suction strike ---
        //
        // A fish does not catch food by colliding with it. It expands its
        // buccal cavity, which pulls water — and whatever is in it — into the
        // mouth from a short distance away. That is why fish can feed
        // accurately at all: the prey is drawn the last few millimetres rather
        // than having to be intercepted exactly.
        //
        // Modelling it as a proximity test instead means the fish has to place
        // a mouth a few millimetres across onto a pellet under a millimetre
        // across while both are moving, which is a far harder problem than the
        // animal actually solves, and it fails constantly.
        if (d < STRIKE_RANGE) {
          this.strikeTimer += dt;
          // A fish's mouth opens in around 30 ms — the whole strike, from first
          // gape to closure, is over in under a tenth of a second.
          g.mouthOpen = saturate(this.strikeTimer / 0.03);

          sub(scratch.tmp, food.position, this.mouth);
          normalize(scratch.tmp, scratch.tmp);
          loco.forward(scratch.fwd);
          const aligned = dot(scratch.tmp, scratch.fwd);

          if (g.mouthOpen > 0.5 && aligned > 0.2) {
            // The inflow the expanding mouth creates, as a sink flow: fastest at
            // the mouth, falling away with distance.
            //
            // The pellet is *advected* by it rather than nudged. A pellet under
            // a millimetre across has a Stokes number well below one, which
            // means it follows the water almost exactly rather than ploughing
            // through it — so the right model is to relax its velocity towards
            // the local flow, not to add an impulse. (Adding an impulse per
            // frame is also frame-rate dependent, which is its own bug: the
            // strike then works at 60 fps and not at 30.)
            const inflow = SUCTION_SPEED * (1 - d / STRIKE_RANGE);
            food.externalFlow.x = -scratch.tmp.x * inflow;
            food.externalFlow.y = -scratch.tmp.y * inflow;
            food.externalFlow.z = -scratch.tmp.z * inflow;
          }

          // Once the pellet is at the lips with the mouth open, it is taken.
          //
          // Direction is deliberately not part of this. Requiring the pellet to
          // be squarely ahead fails exactly where it matters most: a pellet
          // floating on the surface sits *above* a level fish, and one the fish
          // has just overshot sits behind the snout tip — which is to say,
          // inside its head. Both are cases where a real fish has the food. With
          // an alignment gate the fish nuzzled its dinner indefinitely and
          // starved next to it.
          if (d < SWALLOW_RANGE && g.mouthOpen > 0.4) {
            this.atePelletThisTick = food;
            this.drives.hunger = saturate(this.drives.hunger - FOOD.hungerPerPellet);
            this.strikeTimer = 0;
          } else if (this.strikeTimer > 0.9) {
            // Missed. Real fish miss constantly, and the missing is a large part
            // of what makes feeding look alive. Back off and come round again.
            addScaled(food.velocity, scratch.tmp, 0.02);
            this.strikeTimer = 0;
            this.intentionAge = INTENTION.minDwell; // free to reconsider
          }
        } else {
          this.strikeTimer = 0;
        }
        break;
      }

      case 'forage': {
        // A correlated random walk, biased up the scent gradient. Turn angles
        // come from a wrapped Cauchy distribution rather than a Gaussian: it has
        // the heavy tails that produce the occasional sharp reorientation, which
        // is what makes a search path look like an animal's rather than a
        // drunkard's.
        this.forageTimer -= dt;
        if (this.forageTimer <= 0) {
          this.forageTimer = this.rng.range(0.6, 1.6);
          this.forageHeading += this.rng.wrappedCauchy(0.72);
        }
        const gradLen = len(p.scentGradient);
        set(g.target, loco.position.x, loco.position.y, loco.position.z);
        if (gradLen > 1e-6) {
          normalize(scratch.tmp, p.scentGradient);
          addScaled(g.target, scratch.tmp, 0.10);
        } else {
          // Nothing to smell: search near the surface, since that is where betta
          // pellets are.
          g.target.x += Math.sin(this.forageHeading) * 0.10;
          g.target.z += Math.cos(this.forageHeading) * 0.10;
          g.target.y = TANK.waterY - 0.025;
        }
        g.speedSL = 1.3;
        g.urgency = 0.3;
        g.finSpread = 0.6;
        break;
      }

      case 'rest': {
        copy(g.target, this.restTarget);
        g.speedSL = dist(loco.position, this.restTarget) > 0.03 ? 0.9 : 0;
        g.hover = g.speedSL === 0;
        g.urgency = 0.1;
        g.finSpread = 0.35; // fins hang loose at rest
        break;
      }

      case 'inspect': {
        this.inspectTimer -= dt;
        copy(g.target, loco.position);
        addScaled(g.target, p.rivalDirection, 0.05);
        g.target.y = clamp(g.target.y, TANK.floorY + 0.02, TANK.waterY - 0.015);
        g.speedSL = 0.5;
        g.hover = true;
        g.urgency = 0.25;
        g.finSpread = 0.7;
        if (this.inspectTimer <= 0) this.drives.boredom = Math.min(1, this.drives.boredom + 0.3);
        break;
      }

      case 'patrol':
      default: {
        this.runIdle(loco, dt);
        break;
      }
    }
  }

  /**
   * Ordinary life: what the fish does when nothing is pressing.
   *
   * It used to swim, without a break, from one end of the tank to the other
   * and back, and measured over five minutes it was never once still. A betta
   * does not live like that, and a long-finned one least of all: its fins are
   * a great deal of sail to drag about. It hangs in the water fanning its
   * pectoral fins, looks at things, ambles a little way with a few beats of
   * its tail and a glide, and hangs again. (How the time divides between the
   * two is an estimate from watching them. No measured figure was to hand.)
   */
  private runIdle(loco: FishLocomotion, dt: number): void {
    const g = this.goal;
    this.idleTimer -= dt;

    if (this.idleMode === 'pause') {
      // Hang where it is, facing the way it was facing when it stopped.
      set(
        g.target,
        loco.position.x + this.pauseHeading.x * 0.06,
        this.patrolTarget.y,
        loco.position.z + this.pauseHeading.z * 0.06,
      );
      g.speedSL = 0;
      g.hover = true;
      g.urgency = 0.1;
      g.finSpread = 0.6;

      // Every so often, bend round for a look to one side, hold it, and
      // straighten up again.
      this.lookTimer -= dt;
      if (this.lookHold > 0) {
        this.lookHold -= dt;
        g.look = this.lookCurl;
      } else if (this.lookTimer <= 0) {
        this.lookTimer = this.rng.range(3, 9);
        this.lookHold = this.rng.range(0.8, 2.2);
        this.lookCurl = (this.rng.next() < 0.5 ? -1 : 1) * this.rng.range(0.2, 0.55);
      }

      // Not against the glass, though: a fish that has drifted up to a pane
      // moves off.
      // (The glass, not the sand: a betta hanging just over the bottom with
      // its fins brushing it is a betta at rest.)
      const snout = loco.bodyExtremes(scratch.extremes)[0];
      const glass = Math.min(
        Math.min(loco.position.x, snout.x) - TANK_MIN_X,
        TANK_MAX_X - Math.max(loco.position.x, snout.x),
        Math.min(loco.position.z, snout.z) - TANK_MIN_Z,
        TANK_MAX_Z - Math.max(loco.position.z, snout.z),
      );
      if (this.idleTimer <= 0 || glass < 0.02) {
        this.idleMode = 'amble';
        // Long enough to get somewhere, not so long that a spot it cannot
        // reach keeps it trying.
        this.idleTimer = this.rng.range(6, 14);
        this.ambleSpeed = this.rng.range(0.6, 1.1);
        this.stroking = true;
        this.strokeTimer = this.rng.range(0.8, 1.8);
        this.lookHold = 0;
        this.pickPatrolTarget(loco);
      }
      return;
    }

    // Ambling: a few beats, a glide, a few beats.
    this.strokeTimer -= dt;
    if (this.strokeTimer <= 0) {
      this.stroking = !this.stroking;
      this.strokeTimer = this.stroking ? this.rng.range(0.7, 1.7) : this.rng.range(0.5, 1.6);
    }
    copy(g.target, this.patrolTarget);
    g.speedSL = this.ambleSpeed;
    g.glide = !this.stroking;
    g.urgency = 0.2;
    g.finSpread = 0.65;

    const arrived = dist(loco.position, this.patrolTarget) < 0.05;
    // A spot close by and well off to one side is inside the circle the fish
    // turns in, and it cannot get there by turning towards it: it goes round
    // and round the spot instead. (Measured: the fish was turning fifteen
    // times a minute, and most turns ended with the spot it wanted still
    // seventy to a hundred degrees off its nose and ten centimetres away.)
    // It gives that spot up and wanders on.
    {
      loco.forward(scratch.fwd);
      const tx = this.patrolTarget.x - loco.position.x;
      const tz = this.patrolTarget.z - loco.position.z;
      const d = Math.hypot(tx, tz);
      const h = Math.hypot(scratch.fwd.x, scratch.fwd.z) || 1;
      const cos = d > 1e-6 ? (tx * scratch.fwd.x + tz * scratch.fwd.z) / (d * h) : 1;
      if (!arrived && this.turnPhase === 'none' && d < 0.13 && cos < 0.5) this.pickPatrolTarget(loco);
    }
    if (arrived || this.idleTimer <= 0) {
      this.idleMode = 'pause';
      // Mostly a few seconds; now and then a long, still spell.
      this.idleTimer = 2 + Math.min(22, -6 * Math.log(Math.max(1e-6, this.rng.next())));
      this.lookTimer = this.rng.range(1.5, 5);
      loco.forward(scratch.fwd);
      const h = Math.hypot(scratch.fwd.x, scratch.fwd.z) || 1;
      set(this.pauseHeading, scratch.fwd.x / h, 0, scratch.fwd.z / h);
      this.patrolTarget.y = clamp(loco.position.y, TANK.floorY + 0.03, TANK.waterY - 0.022);
    }
  }

  // -------------------------------------------------------------------------
  // Finding a way round things
  // -------------------------------------------------------------------------

  /**
   * Replace `target` with the point the fish should head for to get there
   * round the wood, the stones and the thick of the plants: the target
   * itself when the way is clear, which in open water it nearly always is.
   */
  private findWay(target: Vec3, loco: FishLocomotion, dt: number): void {
    const nav = this.nav;
    this.detouring = false;
    if (!nav) return;
    const pos = loco.position;
    // Straight there, if nothing is in the way: no wood or stone, and no
    // more plant than there is at the goal itself (food lying in a plant
    // has to be gone in for).
    const allowance = Math.max(1, nav.costOf(target));
    if (nav.lineCost(pos, target) <= allowance) {
      this.route.length = 0;
      return;
    }
    // Otherwise follow a route, planned afresh when the goal has moved or
    // every so often as the fish drifts off it.
    this.routeTimer -= dt;
    if (this.route.length < 2 || dist(this.routeGoal, target) > 0.015 || this.routeTimer <= 0) {
      nav.plan(pos, target, this.route);
      copy(this.routeGoal, target);
      this.routeTimer = 0.6;
    }
    const r = this.route;
    if (r.length < 2) return;
    // Head for the furthest point along the route that can be seen in a
    // clear line, no dearer than the route itself is up to there. That cuts
    // the corners off the cubes, as a fish swimming through would.
    let best = 0;
    let routeWorst = 0;
    for (let i = 1; i < r.length; i++) {
      routeWorst = Math.max(routeWorst, nav.costOf(r[i]));
      if (nav.lineCost(pos, r[i]) <= routeWorst + 0.25) best = i;
      else if (dist(pos, r[i]) > 0.06) break;
    }
    if (best === r.length - 1 && nav.lineCost(pos, target) <= routeWorst + 0.25) return;
    // Not too close: aiming at a point a centimetre away turns the fish round
    // the moment it passes it.
    let i = Math.max(1, best);
    while (i < r.length - 1 && dist(pos, r[i]) < 0.02) i++;
    copy(target, r[i]);
    this.detouring = true;
  }

  // -------------------------------------------------------------------------
  // Steering: motor goal -> muscle command
  // -------------------------------------------------------------------------

  /**
   * The steering layer is deliberately thin, because the water does the work.
   *
   * The tail-beat frequency is *integrated* towards the speed error rather than
   * solved for. That means the fish accelerates on its own hydrodynamic terms
   * and always lags its own intention slightly, which is how an animal with
   * muscle and inertia behaves. Setting the frequency directly from the error
   * gives a fish that reaches its target speed instantly and reads as a puppet.
   */
  private steer(cmd: MotorCommand, loco: FishLocomotion, dt: number): void {
    const g = this.goal;
    const p = this.percepts;

    // Wall repulsion, folded into whatever the fish is already trying to do.
    //
    // Every behaviour gets this, so the fish steers round the glass while it is
    // foraging or patrolling instead of having to *decide* to avoid the wall.
    // That is both how a real animal behaves and the only way the other drives
    // ever get a turn.
    //
    // Sideways only. The sand counts as a wall, and in eight and a half
    // centimetres of water the fish is within reach of it most of the time:
    // pushed up from the sand as well, a fish with somewhere low to go was
    // sent to the surface whenever it got down there and back down when it
    // had risen, and went on bouncing between the two. The depth it may aim
    // for is limited just below instead. And not while it is hanging still:
    // the spot it is "heading for" then is only a way of saying which way it
    // faces, and moving that spot turned the fish round and round.
    const holding = g.hover && g.speedSL === 0 && this.intention === 'patrol';
    if (
      p.wallDistance < INTENTION.wallAvoidDistance * 2 &&
      this.intention !== 'surface' &&
      !holding
    ) {
      const strength =
        smoothstep(INTENTION.wallAvoidDistance * 2, 0, p.wallDistance) * 0.09;
      g.target.x += p.wallAway.x * strength;
      g.target.z += p.wallAway.z * strength;
    }

    // Whatever a routine asked for, the place to go is inside the tank. A
    // forage heading or a scent gradient can put the target beyond the glass,
    // and a fish steering for a point outside the tank presses itself against
    // the pane until the contact model throws it back.
    g.target.x = clamp(g.target.x, TANK_MIN_X + 0.03, -TANK_MIN_X - 0.03);
    g.target.z = clamp(g.target.z, TANK_MIN_Z + 0.03, -0.03);
    // The centre of mass cannot go lower than the anal fin allows.
    g.target.y = clamp(g.target.y, TANK.floorY + 0.026, TANK.waterY - 0.004);

    // Find a way there round whatever is in between. Not in a fright, which
    // is a reflex; not while flaring or taking a breath, which happen where
    // the fish already is; and not while it hangs still.
    const routed =
      !holding &&
      this.intention !== 'escape' &&
      this.intention !== 'flare' &&
      !(this.intention === 'surface' && this.surfacePhase === 'gulp');
    if (routed) this.findWay(g.target, loco, dt);
    else {
      this.route.length = 0;
      this.detouring = false;
    }
    copy(this.waypoint, g.target);

    sub(scratch.toTarget, g.target, loco.position);
    const distance = len(scratch.toTarget);
    if (distance > 1e-6) scale(scratch.desired, scratch.toTarget, 1 / distance);
    else set(scratch.desired, 0, 0, 1);

    // Heading error, in the fish's own frame. The frame is right-handed with +z
    // forward and +y up, which puts +x on the fish's *left*; the sign
    // conventions below were set by measurement (see probe-turn), not from the
    // labels.
    quatRotateInv(scratch.local, loco.orientation, scratch.desired);
    // The yaw error is the heading error in the horizontal plane, and only
    // when there is a horizontal component worth turning for. A target nearly
    // straight above or below needs pitch, not yaw — a pellet floating four
    // centimetres over the fish's head is reached by climbing, and an earlier
    // version, which clamped the forward component to a hair above zero,
    // read that pellet as ninety degrees off to one side and had the fish
    // pivot on the spot beneath its food indefinitely. Behind is behind:
    // clamping also turned every target astern into one abeam.
    const horizontal = Math.hypot(scratch.local.x, scratch.local.z);
    const yawError =
      horizontal > 0.25 && !holding ? Math.atan2(scratch.local.x, scratch.local.z) : 0;
    const pitchError = Math.asin(clamp(scratch.local.y, -1, 1));

    // Turning is a steady one-sided bend of the body, driven by a PD controller
    // on the heading error.
    //
    // The derivative term is not optional. With proportional control alone at a
    // gain high enough to turn briskly, the bend saturates at full deflection
    // for any heading error beyond about twenty degrees — which is most of the
    // time — so the fish turns as hard as it can, overshoots, turns as hard as
    // it can the other way, and circles its target forever without ever closing
    // on it. It looks like a fish that has lost interest. Feeding back the yaw
    // *rate* lets it ease off as it comes round, which is what converging on
    // something looks like.
    quatRotateInv(scratch.tmp, loco.orientation, loco.angularVelocity);
    // Low-pass the rate feedback. Feeding back the raw instantaneous turn rate
    // couples the controller to the body's own recoil oscillation — the head
    // yaws back and forth with every tail beat — and the controller then chases
    // that instead of the heading.
    this.yawRateFiltered = expApproach(this.yawRateFiltered, scratch.tmp.y, 12, dt);
    this.pitchRateFiltered = expApproach(this.pitchRateFiltered, scratch.tmp.x, 12, dt);
    const yawRate = this.yawRateFiltered;
    const pitchRate = this.pitchRateFiltered;
    const turnGain = 1.35 * (0.65 + 0.35 * g.urgency);
    // Positive bend sweeps the tail towards +x and, with water flowing past,
    // turns the fish towards +x — measured, and the opposite of what this line
    // said for a long time. With the sign wrong the fish turned *away* from its
    // target whenever the tail was driving, and only crept towards it in the
    // pauses in between; it was never more than a limit cycle fifty degrees off
    // where it wanted to go.
    cmd.bend = clamp(turnGain * yawError - 0.035 * yawRate, -1, 1);

    // Depth is held two ways, on two very different timescales.
    //
    // The swim bladder is a trim tank. It drifts slowly towards whatever makes
    // the fish neutrally buoyant at the depth it wants to be, and it is driven
    // by the *height* error, not the pitch error: it has no business responding
    // to which way the fish's nose is pointing. An earlier version fed it the
    // pitch error at a gain that made it the strongest vertical force the fish
    // had, and the fish rose and sank on its bladder with the tail switched off.
    const heightError = g.target.y - loco.position.y;
    // A fish hanging in the water has nothing else to hold its depth with: the
    // body's bend and the pectorals' tilt both work on water flowing past, and
    // there is none. The bladder is slow (twelve seconds from empty to full),
    // so steering it by the height error alone overshoots every time: measured,
    // a pausing fish bobbed three centimetres up and down every three and a
    // half seconds, at up to three quarters of a body length a second, and
    // ended most pauses on the sand. So when hovering it is also told how
    // fast the fish is already rising or sinking, and backs off early.
    const hanging = g.hover || this.turnPhase !== 'none';
    cmd.bladder = clamp((heightError - (hanging ? BLADDER_LEAD * loco.velocity.y : 0)) / 0.03, -1, 1);
    // The manoeuvring is done by swimming: the body pitches and the pectorals
    // angle, and the fish's own forward motion carries it up or down.
    //
    // The height loop needs damping of its own. Pointing at the target and
    // holding that pitch is a controller on *angle*; the quantity that actually
    // has to settle is *height*, which is the integral of climb rate, and a
    // proportional controller on the integral of what it controls oscillates.
    // Feeding back the climb rate is what turns porpoising into a level-off.
    // Twenty-five is the gain at which climbing at two centimetres a second —
    // a brisk rate for this fish — halves the commanded pitch.
    const climbRate = loco.velocity.y;
    const pitchDemand = pitchError - clamp(25 * climbRate, -0.6, 0.6);
    cmd.pitchBend = clamp(pitchDemand * 1.6 * (0.6 + 0.4 * g.urgency) - 0.03 * pitchRate, -1, 1);
    // The pectorals are the elevators, and they do most of the work: the body's
    // own vertical bend is almost useless for climbing on a fish this laterally
    // compressed.
    cmd.pectoralPitch = clamp(pitchDemand * 2.4 - 0.20 * pitchRate, -1, 1);

    // Slow down to turn.
    //
    // The fish's turning radius while cruising is several body lengths — a
    // consequence of how much water its fins have to swing sideways, and a real
    // property of a long-finned betta rather than a shortcut. In a tank only
    // seven body lengths across, that means it cannot turn round at speed at
    // all; it has to slow down first, which is exactly what a real fish does
    // when it changes direction in a confined space. At walking pace it can pivot
    // almost on the spot with its pectorals.
    const turnPenalty = 1 - 0.75 * saturate(Math.abs(yawError) / 1.1);
    // Forward speed, not total speed. Sinking is not swimming.
    const speedError = g.speedSL * turnPenalty - loco.forwardSpeedSL;

    // Turning round.
    //
    // A fish that wants to face another way folds its body: the head comes
    // round towards the tail, which stays where it was, because the tail and
    // the long fins hold a great deal of water and the head holds very
    // little. Then it swims out along the curve it has made, and the fold
    // runs back along its body and off the end of its tail, the way a train
    // goes round a bend. The fold has to run back no faster than the fish
    // moves forward. If the fish simply straightened up where it was, the
    // head would swing back as easily as it came round, and the turn would
    // be undone. (Measured on the bare swimmer: a full fold brings the head
    // round 106 degrees in half a second within a centimetre; unfolding on the
    // spot gives all but 6 of them back; swimming out of it keeps 65 to 75.)
    //
    // What was here before was a slow beat of a bent tail with the pectorals
    // out as brakes, meant as a turn on the spot. Measured, it turned the fish
    // 23 degrees a second on a circle 36 centimetres across, in a tank 25 by
    // 35. For nearly half its life the fish was in that turn, and it ended
    // most of them against the glass.
    this.turnRest = Math.max(0, this.turnRest - dt);
    if (
      this.turnPhase === 'none' &&
      this.turnRest <= 0 &&
      Math.abs(yawError) > TURN_FOLD_FROM &&
      this.intention !== 'escape'
    ) {
      this.turnPhase = 'fold';
      this.turnTimer = 0;
      // The head comes round by about nine tenths of the fold, and the fish
      // goes on turning for as long as it swims with the fold in it. Never
      // more than three quarters of a full fold: past a right angle the tail
      // points across the head's line and its beat drives the fish backwards
      // (measured: a full fold swum out of went backwards at up to three body
      // lengths a second first).
      this.turnCurl =
        Math.sign(yawError) * clamp(Math.abs(yawError) / (0.9 * FISH.curlMax), 0.25, 0.75);
      this.turnFoldAt = FISH.curlAt;
    }
    if (this.turnPhase !== 'none' && this.intention === 'escape') {
      // A fright interrupts anything.
      this.turnPhase = 'none';
      this.turnRest = 0.3;
    }
    const turning = this.turnPhase !== 'none';
    if (this.turnPhase === 'fold') {
      this.turnTimer += dt;
      cmd.curl = this.turnCurl;
      cmd.curlAt = FISH.curlAt;
      if (this.turnTimer > TURN_FOLD_TIME) this.turnPhase = 'follow';
    } else if (this.turnPhase === 'follow') {
      // The fold runs back along the body and off the tail, slowly while the
      // fish still has turning to do and quickly once it is facing where it
      // means to go. While the fold is on the body the fish swims round a
      // corner; running it off quickly straightens the fish but gives some
      // of the turn back. (Measured on the bare swimmer, a 48 degree fold
      // swum out of at 2.5 beats a second: run off at half a body length a
      // second the fish ends up turned 85 degrees, at 0.9 it is 57, at 1.5
      // it is 32.)
      const left = yawError * Math.sign(this.turnCurl);
      this.turnFoldAt += (0.45 + 0.95 * saturate(1 - left / 0.6)) * dt;
      cmd.curl = this.turnCurl;
      cmd.curlAt = this.turnFoldAt;
      if (this.turnFoldAt > TURN_FOLD_OFF) {
        this.turnPhase = 'none';
        this.turnRest = 0.4;
      }
    }
    if (this.turnPhase === 'none') {
      // Not turning round: the fold is free for a sideways look, if the fish
      // is having one.
      cmd.curl = g.look;
      cmd.curlAt = FISH.curlAt;
    }
    if (turning) {
      cmd.bend = 0;
      // A level turn. The up-and-down bend and the pectorals' tilt steer by
      // the water running past the fish, and a fish folded round to turn has
      // almost none running past it: what the bend does then is point the
      // beating tail up or down. Measured in the tank: a fish turning with its
      // goal four millimetres below it, bent fully to dive, climbed at nine
      // centimetres a second, and the faster it climbed the harder it bent.
      // Depth is left to the swim bladder until the fish is swimming again.
      cmd.pitchBend = 0;
      cmd.pectoralPitch *= saturate(loco.forwardSpeedSL);
    }

    // The tail's beat is as wide as the fish needs and no wider: a fish that
    // is not beating its tail holds it straight. It used to keep the full
    // width with the beat stopped, which froze the body in an S, and a fish
    // gliding with its body in an S does not glide straight.
    const beatWidth = FISH.standardLength * FISH.tailAmplitudeRatio;

    if (this.turnPhase === 'fold') {
      // Fold first, then swim. The tail is still while the head comes round.
      cmd.frequency = expApproach(cmd.frequency, 0, 8, dt);
      cmd.amplitude = beatWidth * saturate(cmd.frequency / 0.5);
      cmd.pectoralLeft = expApproach(cmd.pectoralLeft, 0.8, 4, dt);
      cmd.pectoralRight = expApproach(cmd.pectoralRight, 0.8, 4, dt);
    } else if (this.turnPhase === 'follow') {
      // Swim out of it, gently: a beat or two a second is enough to carry the
      // fish round the curve.
      const beat = clamp(1.8 + 0.6 * g.speedSL, 2.2, 3.2);
      cmd.frequency = expApproach(cmd.frequency, beat, 5, dt);
      cmd.amplitude = beatWidth;
      cmd.pectoralLeft = expApproach(cmd.pectoralLeft, 0, 4, dt);
      cmd.pectoralRight = expApproach(cmd.pectoralRight, 0, 4, dt);
    } else if (g.hover || g.speedSL < FISH.pectoralOnlySpeedSL) {
      // Slow work is done with the pectorals, which is what a hovering betta
      // actually uses. The tail stops.
      cmd.frequency = expApproach(cmd.frequency, 0, 6, dt);
      // No body bend while pivoting. Bending into a C at a standstill is a
      // C-start, not a turn: the recoil kicks the head the *other* way and the
      // fish spins on the kick. The pectorals do the turning here.
      cmd.bend = expApproach(cmd.bend, 0, 8, dt);
      // A fish that means to stay put fans its fins slowly; one creeping
      // forwards rows.
      const base =
        g.speedSL === 0
          ? clamp(0.9 + speedError * 4, 0.35, 1.2)
          : clamp(1.6 + speedError * 2.5, 0.4, FISH.maxPectoralHz);
      // Differential beat turns the fish on the spot, and lets it back up —
      // bettas can swim backwards, and this falls out without extra machinery.
      // Rowing the fin on the -x side (index 0) yaws the fish towards +x, as
      // rowing one oar turns a boat away from it. Sign by measurement.
      const diff = clamp(yawError * 1.4 - 0.03 * yawRate, -1, 1);
      // Both fins keep rowing through a pivot — one harder than the other — so
      // the fish also creeps forwards, as a real one does.
      cmd.pectoralLeft = clamp(base * (1 + diff), 0, FISH.maxPectoralHz);
      cmd.pectoralRight = clamp(base * (1 - diff), 0, FISH.maxPectoralHz);
      cmd.amplitude = beatWidth * saturate(cmd.frequency / 0.5);
    } else if (g.glide) {
      // Coasting between strokes: the tail stops, the pectorals stay folded,
      // and nothing brakes.
      cmd.frequency = expApproach(cmd.frequency, 0, 5, dt);
      cmd.amplitude = beatWidth * saturate(cmd.frequency / 0.5);
      cmd.pectoralLeft = expApproach(cmd.pectoralLeft, 0, 4, dt);
      cmd.pectoralRight = expApproach(cmd.pectoralRight, 0, 4, dt);
    } else {
      // Winding the beat down is faster than winding it up: a fish can stop
      // driving instantly but cannot summon power instantly.
      const rate = speedError < 0 ? 9.0 : 3.5;
      cmd.frequency = clamp(cmd.frequency + rate * speedError * dt, 0, FISH.maxTailBeatHz);
      // Fold the pectorals. A cruising betta lays them along its flanks, and in
      // this model that is also what makes them elevators: folded, the blade is
      // edge-on to the flow and its pitch is an angle of attack. An earlier
      // version kept a slow beat going "so the fins stay extended", and a
      // half-open fin with a one-sided feather in a thirteen-centimetre-a-second
      // flow was a dive plane: the fish sank at seven centimetres a second at
      // cruise, whatever its tail was doing.
      cmd.pectoralLeft = expApproach(cmd.pectoralLeft, 0, 4, dt);
      cmd.pectoralRight = expApproach(cmd.pectoralRight, 0, 4, dt);
      // Amplitude is nearly constant in real steady swimming — fish change speed
      // by changing frequency — and only opens up in a burst.
      const burst = this.intention === 'escape';
      cmd.amplitude = burst
        ? FISH.standardLength * FISH.burstAmplitudeRatio
        : beatWidth * saturate(cmd.frequency / 0.5);
    }

    // Brake when going faster than intended, and hard when much faster. Not
    // while coasting, which is meant to run on, nor while turning round.
    const braking = turning || g.glide ? 0 : saturate(-speedError * 0.8);
    cmd.brake = expApproach(cmd.brake, braking, 14, dt);

    // Only a fright bends the body at reflex speed. Measured on a fish at
    // rest: a full bend at half urgency threw it backwards at three body
    // lengths a second, and at full urgency at twelve, because the long fins
    // are swung through the water like paddles. That belongs to an escape and
    // to nothing else the fish does.
    cmd.agility = this.intention === 'escape' ? g.urgency : Math.min(g.urgency, 0.25);
    cmd.finSpread = expApproach(cmd.finSpread, g.finSpread, 3.5, dt);
    cmd.gillFlare = expApproach(cmd.gillFlare, g.gillFlare, 5, dt);
    cmd.mouthOpen = expApproach(cmd.mouthOpen, g.mouthOpen, 18, dt);
  }

  // -------------------------------------------------------------------------

  /** The tail-beat frequency commanded last tick, for the effort model. */
  private lastCommandFrequency = 0;

  /** One brain tick. Called at the frame rate, not the physics rate. */
  step(
    cmd: MotorCommand,
    loco: FishLocomotion,
    body: FishBody,
    pellets: Pellet[],
    water: WaterSurface,
    stim: Stimuli,
    dt: number,
  ): void {
    this.perceive(loco, body, pellets, water, stim, dt);

    // Reflexes that bypass deliberation entirely.
    if (this.percepts.looming > 0) {
      sub(scratch.tmp, stim.viewerPosition ?? loco.position, loco.position);
      normalize(scratch.tmp, scratch.tmp);
      this.startle(this.percepts.looming * 0.9 * dt * 12, scratch.tmp);
    }
    if (this.percepts.rivalVisible > 0.25 && this.aggressionRefractory <= 0) {
      // Scaled by timeScale like every other physiological rate. Without it the
      // build-up runs in real time while the decay runs in compressed time, so
      // aggression settles at whatever ratio the two happen to have and never
      // reaches the threshold for a display.
      this.drives.aggression = saturate(
        this.drives.aggression +
          this.percepts.rivalVisible * 0.55 * dt * this.cfg.timeScale,
      );
    }

    this.lastCommandFrequency = cmd.frequency;
    this.updateDrives(loco, dt);
    this.arbitrate(loco, dt);
    this.runRoutine(loco, water, dt);
    this.steer(cmd, loco, dt);
  }
}
