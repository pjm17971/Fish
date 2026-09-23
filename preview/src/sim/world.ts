/**
 * The world: everything assembled, and the order things happen in.
 *
 * Order matters here. Perception has to run on the state the fish could actually
 * have sensed, forces have to be gathered before anything integrates, and the
 * water has to see the fish's motion from the step it just took rather than the
 * one before. Getting this wrong does not crash anything; it just makes the fish
 * feel very slightly late, in a way that is almost impossible to find later.
 */

import { Vec3, v3, set, copy, sub, scale, clamp, add, cross, smoothstep } from './math.js';
import { DEFAULT_WORLD_CONFIG, GRAVITY, TANK, WATER, WorldConfig } from './config.js';
import { buildMorphology, Morphology } from './morphology.js';
import { FishBody, MotorCommand, createMotorCommand } from './fishBody.js';
import { FishLocomotion, createLocomotion } from './locomotion.js';
import { FinCloth, buildFins } from './fins.js';
import { BulkFlow, WaterSurface } from './water.js';
import { FoodSystem } from './food.js';
import { FishBrain, Stimuli } from './brain.js';

/** A bubble released at the surface when the fish takes a breath. */
export interface Bubble {
  position: Vec3;
  radius: number;
  age: number;
  alive: boolean;
}

const scratch = {
  tmp: v3(),
  segWorld: v3(),
  segVel: v3(),
  axis: v3(),
  dipole: v3(),
  prevViewer: v3(),
};

export class World {
  readonly config: WorldConfig;
  readonly morphology: Morphology;
  readonly body: FishBody;
  readonly locomotion: FishLocomotion;
  readonly fins: FinCloth[];
  readonly water: WaterSurface;
  readonly flow: BulkFlow;
  readonly food: FoodSystem;
  readonly brain: FishBrain;
  readonly command: MotorCommand;

  readonly bubbles: Bubble[] = [];

  /** Stimuli the host (phone or preview) fills in each frame. */
  readonly stimuli: Stimuli = {
    viewerPosition: null,
    viewerApproachSpeed: 0,
    tapImpulse: 0,
    tapPosition: v3(),
  };

  /** Seconds of simulated time since the start. */
  time = 0;

  private hasPrevViewer = false;
  private lastTapTime = -Infinity;

  /** Where the fish holds the surface, at each node, m; see holdSurfaceOverFish(). */
  private readonly surfaceHold: Float32Array;

  constructor(config: Partial<WorldConfig> = {}) {
    this.config = { ...DEFAULT_WORLD_CONFIG, ...config };
    this.morphology = buildMorphology();
    this.body = new FishBody(this.morphology);
    this.locomotion = createLocomotion(this.morphology, this.body);
    this.fins = buildFins(this.morphology);
    this.water = new WaterSurface();
    this.surfaceHold = new Float32Array(this.water.nx * this.water.nz);
    this.flow = new BulkFlow(this.config.seed);
    this.food = new FoodSystem(this.config.seed);
    this.brain = new FishBrain(this.config);
    this.command = createMotorCommand();

    for (let i = 0; i < 24; i++) {
      this.bubbles.push({ position: v3(), radius: 0, age: 0, alive: false });
    }

    // Start the fish somewhere plausible: mid-water, facing across the tank.
    set(this.locomotion.position, -0.05, TANK.floorY + 0.045, -TANK.depth * 0.55);
    for (const f of this.fins) f.initialise(this.body, this.locomotion, 0.65);
  }

  /**
   * Tell the world how the tank itself is moving.
   *
   * On the phone this is the device's linear acceleration with gravity removed,
   * rotated into tank coordinates. It is what makes the water slosh when you
   * move, and it is the difference between a tank that is in the room and a
   * picture of one.
   */
  setTankAcceleration(ax: number, az: number): void {
    this.water.setTankAcceleration(ax, az);
  }

  /**
   * A double tap. `x`/`z` are where the tap ray met the water surface.
   *
   * Returns false if the tap missed the water, in which case no food is dropped
   * but the fish still hears the knock.
   */
  feedAt(x: number, z: number): boolean {
    const dropped = this.food.drop(x, z);
    set(this.stimuli.tapPosition, x, TANK.waterY, z);
    this.stimuli.tapImpulse = 1;
    this.lastTapTime = this.time;
    return dropped;
  }

  step(dt: number): void {
    // Clamp the frame time. A long stall — a tab in the background, a debugger
    // pause — must not be integrated as though it really happened, or the fish
    // teleports and the water explodes.
    const frameDt = clamp(dt, 0, 0.05);

    // A zero-length step is a no-op, and has to be handled rather than run
    // through the integrators with dt = 0.
    //
    // This is not a hypothetical. A browser hands two animation frames the same
    // timestamp fairly regularly — reliably on the first frame after load — and
    // the fin sweep divides by the timestep to get node velocities. At dt = 0
    // that is 1/0 = Infinity, multiplied by a zero displacement, which is NaN;
    // and once a fin node is NaN it stays NaN, so the fins are wrecked for the
    // rest of the run. The test suite missed it for a long time because every
    // test steps at a fixed 1/60 and never sees a zero.
    if (frameDt <= 0) return;

    this.time += frameDt;

    // 1. Viewer motion, for looming. Differentiated here rather than trusted
    //    from outside, so the host only has to supply a position.
    if (this.stimuli.viewerPosition) {
      if (this.hasPrevViewer) {
        sub(scratch.tmp, this.stimuli.viewerPosition, scratch.prevViewer);
        // Approach speed is towards the tank, i.e. along -z from the viewer's
        // side of the glass.
        this.stimuli.viewerApproachSpeed = -scratch.tmp.z / Math.max(1e-4, frameDt);
      }
      copy(scratch.prevViewer, this.stimuli.viewerPosition);
      this.hasPrevViewer = true;
    } else {
      this.hasPrevViewer = false;
      this.stimuli.viewerApproachSpeed = 0;
    }
    this.stimuli.tapImpulse = Math.max(
      0,
      1 - (this.time - this.lastTapTime) * 3,
    );

    // 2. The brain decides, on the state it could have sensed.
    this.brain.step(
      this.command,
      this.locomotion,
      this.body,
      this.food.pellets,
      this.water,
      this.stimuli,
      frameDt,
    );

    // 3. Consequences of the brain's decisions that the world owns.
    if (this.brain.atePelletThisTick) {
      this.food.consume(this.brain.atePelletThisTick, this.water);
    }
    if (this.brain.gulpedThisTick) {
      this.releaseBubble();
      this.locomotion.toWorld(this.body.snout(scratch.tmp), scratch.segWorld);
      this.water.displace(scratch.segWorld.x, scratch.segWorld.z, -WATER.gulpVolume, WATER.gulpRadius);
    }

    // 4. Physics. The fish first, so the fins and the water see where it
    //    actually ended up rather than where it was last frame.
    this.flow.step(frameDt);
    this.locomotion.step(this.command, this.water, this.flow, frameDt);
    for (const f of this.fins) {
      f.step(this.body, this.locomotion, this.flow, this.command.finSpread, frameDt);
    }

    // 5. The fish disturbs the surface it just moved through.
    this.coupleFishToSurface(frameDt);
    this.holdSurfaceOverFish();

    // 6. Food, then the water it landed in.
    this.food.step(this.water, this.flow, frameDt);
    this.water.step(frameDt);

    this.stepBubbles(frameDt);
  }

  /**
   * Any part of the fish near the surface pushes it about.
   *
   * This is what makes a surface gulp produce a real ring of ripples: the
   * snout genuinely crosses the water line, and the disturbance is computed from
   * how fast it did so, not triggered as an effect when the animation reaches a
   * certain frame.
   */
  private coupleFishToSurface(dt: number): void {
    void dt;
    const segs = this.body.segments;
    for (let i = 0; i < segs.length; i += 2) {
      const st = segs[i];
      this.locomotion.toWorld(st.pos, scratch.segWorld);
      const surfaceY = this.water.heightAt(scratch.segWorld.x, scratch.segWorld.z);
      const depth = surfaceY - scratch.segWorld.y;
      if (Math.abs(depth) > WATER.fishCouplingRange) continue;

      // Vertical velocity of this piece of the fish.
      sub(scratch.tmp, scratch.segWorld, this.locomotion.position);
      set(
        scratch.segVel,
        this.locomotion.velocity.x,
        this.locomotion.velocity.y,
        this.locomotion.velocity.z,
      );
      const w = this.locomotion.angularVelocity;
      scratch.segVel.y += w.z * scratch.tmp.x - w.x * scratch.tmp.z;

      // Weight by how close to the surface it is, and by the frontal area of
      // this slice — a fish's head displaces far more than its tail stalk.
      const falloff = Math.exp(-((depth / WATER.fishCouplingRange) ** 2) * 3);
      const strength =
        scratch.segVel.y *
        WATER.fishCouplingGain *
        falloff *
        (this.morphology.segments[i].lateralArea / 1e-5);
      if (Math.abs(strength) < 1e-5) continue;
      this.water.disturb(
        scratch.segWorld.x,
        scratch.segWorld.z,
        clamp(strength, -0.6, 0.6),
        0.012,
      );
    }
  }

  /**
   * The small dip a fish makes in the surface as it swims along just under it.
   *
   * Water has to get out of the fish's way. Above a fish cruising a centimetre
   * down it runs over the fish's back faster than the water around it, and
   * faster water is at lower pressure, so the surface there sags a little; just
   * ahead of the snout and behind the tail the water is slowed and the surface
   * stands a little higher. With the fish's back a few millimetres under, at
   * cruising speed, this is a few tenths of a millimetre, too little to see, but the surface bends the light
   * like a weak lens and the sand shows a soft patch moving with the fish.
   *
   * The calculation is the textbook one for a body moving under a surface slow
   * enough that the surface barely gives. Each slice of the fish moves some
   * water with it (its own volume, plus the water it drags when it moves
   * sideways), which from a distance looks like a doublet — a source and a sink
   * side by side. The surface is treated as a flat lid, which doubles that flow
   * at the lid (a mirror image of the fish above it), and the height the
   * surface would take there is the slice's velocity times the slope of the
   * flow potential along the lid, over g: the dip that travels with a body
   * moving steadily. The water then follows that shape with its own dynamics
   * (see WaterSurface.holdSurface), so below 23 cm/s — the slowest a ripple can
   * run — the dip simply travels with the fish, and when the fish turns away
   * or dives, the surface it was holding springs back and rings a little.
   *
   * Two things are left out. The fish speeding up and slowing down also
   * changes the pressure at the surface, but it does so with every tail beat,
   * and computed frame by frame it jittered enough to set the surface ringing
   * by millimetres. And only horizontal motion counts; the fish rising or
   * sinking near the surface is coupleFishToSurface's.
   */
  private holdSurfaceOverFish(): void {
    const water = this.water;
    const hold = this.surfaceHold;
    const segs = this.body.segments;
    const morph = this.morphology.segments;
    const reach = WATER.fishHoldReach;
    const deepest = WATER.fishHoldDepth;
    let live = false;
    let fastest2 = 0;
    hold.fill(0);
    for (let i = 0; i < segs.length; i++) {
      const st = segs[i];
      const sg = morph[i];
      this.locomotion.toWorld(st.pos, scratch.segWorld);
      const centreDepth = water.heightAt(scratch.segWorld.x, scratch.segWorld.z) - scratch.segWorld.y;
      const halfHeight = 0.5 * sg.depth;
      if (centreDepth - halfHeight > deepest) continue;

      // How this slice is moving: the fish as a whole, its turning, and its
      // own bending.
      sub(scratch.tmp, scratch.segWorld, this.locomotion.position);
      cross(scratch.segVel, this.locomotion.angularVelocity, scratch.tmp);
      add(scratch.segVel, scratch.segVel, this.locomotion.velocity);
      this.locomotion.dirToWorld(st.velLocal, scratch.tmp);
      add(scratch.segVel, scratch.segVel, scratch.tmp);

      // Its doublet: the water it carries along each of its own axes, times
      // its speed along that axis. Endways only its own volume; sideways and
      // up-and-down also the water it drags with it (added mass, pi/4 of the
      // square of its depth or width per unit length).
      //
      // The body only, not the fins. Counted as stiff plates, the betta's
      // long fins drag some twenty times the body's volume of water sideways,
      // and the dip came out at 2 to 9 mm when the fish turned near the
      // surface. That cannot be right: moving water can lower the surface by
      // at most about speed^2 / 2g, half a millimetre at 10 cm/s. The fins are
      // thin, loose membranes that fold and trail with the water rather than
      // shove it like a stiff plate; how much they do push is not something
      // this simple picture can say, so they are left out.
      const volume = sg.area * sg.ds;
      const sideways = volume + 0.25 * Math.PI * sg.depth * sg.depth * sg.ds;
      const upwards = volume + 0.25 * Math.PI * sg.width * sg.width * sg.ds;
      set(scratch.dipole, 0, 0, 0);
      this.locomotion.dirToWorld(st.tangent, scratch.axis);
      addAlong(scratch.dipole, scratch.axis, volume * dotV(scratch.segVel, scratch.axis));
      this.locomotion.dirToWorld(st.normal, scratch.axis);
      addAlong(scratch.dipole, scratch.axis, sideways * dotV(scratch.segVel, scratch.axis));
      this.locomotion.dirToWorld(st.up, scratch.axis);
      addAlong(scratch.dipole, scratch.axis, upwards * dotV(scratch.segVel, scratch.axis));
      if (scratch.dipole.x === 0 && scratch.dipole.z === 0) continue;

      // A slice can be taller than it is deep under the surface, so it is
      // not one point: spread its doublet over its height, most in
      // the middle and none at the tips (as the flow round a flat plate
      // has it), and let each part act from its own depth. Parts out of
      // the water drop out. Close to the lid a point over-states a body of
      // any thickness, and the surface grid cannot show anything much
      // narrower than its spacing, so each point is softened by the
      // slice's half-width and half a grid spacing.
      const core = 0.25 * (sg.width * sg.width + water.dx * water.dx);
      this.locomotion.dirToWorld(st.up, scratch.axis);
      for (let q = 1; q <= HOLD_POINTS; q++) {
        const angle = (q * Math.PI) / (HOLD_POINTS + 1);
        const along = Math.cos(angle) * halfHeight;
        // Gauss-Chebyshev weights for a half-ellipse, summing to 1.
        const share = ((2 / (HOLD_POINTS + 1)) * Math.sin(angle) * Math.sin(angle));
        const x0 = scratch.segWorld.x + scratch.axis.x * along;
        const z0 = scratch.segWorld.z + scratch.axis.z * along;
        const depth = centreDepth - scratch.axis.y * along;
        // In the water, and not so deep it no longer matters.
        const weight = share * smoothstep(0, 0.002, depth) * (1 - smoothstep(0.6 * deepest, deepest, depth));
        if (weight <= 0) continue;
        live = true;
        // Doubled by the mirror image above the lid, over 4 pi for a doublet,
        // and then over g, and times the slice's own speed, for the height.
        const mx = (2 * weight * scratch.dipole.x) / (4 * Math.PI * GRAVITY);
        const mz = (2 * weight * scratch.dipole.z) / (4 * Math.PI * GRAVITY);
        const ux = scratch.segVel.x;
        const uz = scratch.segVel.z;
        fastest2 = Math.max(fastest2, ux * ux + uz * uz);
        const lift = depth * depth + core;
        const i0 = Math.max(0, Math.floor((x0 - reach - water.worldX(0)) / water.dx));
        const i1 = Math.min(water.nx - 1, Math.ceil((x0 + reach - water.worldX(0)) / water.dx));
        const j0 = Math.max(0, Math.floor((z0 - reach - water.worldZ(0)) / water.dz));
        const j1 = Math.min(water.nz - 1, Math.ceil((z0 + reach - water.worldZ(0)) / water.dz));
        for (let j = j0; j <= j1; j++) {
          const rz = water.worldZ(j) - z0;
          for (let ii = i0; ii <= i1; ii++) {
            const rx = water.worldX(ii) - x0;
            const flat = rx * rx + rz * rz;
            // Taper the far edge so the patch moving with the fish does not
            // leave a step behind it.
            const edge = 1 - smoothstep(0.5 * reach * reach, reach * reach, flat);
            if (edge <= 0) continue;
            const r2 = flat + lift;
            const inv3 = 1 / (r2 * Math.sqrt(r2));
            // The flow potential here is -(m . r) / r^3; the surface stands
            // at the slice's velocity dotted with its slope along the lid.
            const mr = (3 * (mx * rx + mz * rz)) / r2;
            hold[water.index(ii, j)] += edge * inv3 * (ux * (mr * rx - mx) + uz * (mr * rz - mz));
          }
        }
      }
    }

    // The picture above is for water that is disturbed only a little, and
    // it breaks down when the fish's back comes within a few millimetres of
    // the surface: there it can call for dips of several millimetres. Water
    // moving at speed u lowers the surface by u^2 / 2g, and past a body it
    // runs at most about one and a half times the body's own speed, so the
    // most any part of the fish can do is about half of U^2 / g. Hold the
    // shape to that, easing into the limit rather than cutting it off.
    const limit = (0.5 * fastest2) / GRAVITY;
    if (live && limit > 1e-7) {
      for (let k = 0; k < hold.length; k++) {
        if (hold[k] !== 0) hold[k] = limit * Math.tanh(hold[k] / limit);
      }
    } else {
      live = false;
    }
    water.holdSurface(live ? hold : null);
  }

  private releaseBubble(): void {
    const b = this.bubbles.find((q) => !q.alive);
    if (!b) return;
    this.locomotion.toWorld(this.body.snout(scratch.tmp), b.position);
    b.radius = 0.0012;
    b.age = 0;
    b.alive = true;
  }

  private stepBubbles(dt: number): void {
    for (const b of this.bubbles) {
      if (!b.alive) continue;
      b.age += dt;
      // A bubble this small rises slowly and almost exactly at its terminal
      // speed: at half a millimetre across it reaches it in a few milliseconds.
      b.position.y += 0.06 * dt;
      const surfaceY = this.water.heightAt(b.position.x, b.position.z);
      if (b.position.y > surfaceY || b.age > 4) {
        b.alive = false;
        this.water.disturb(b.position.x, b.position.z, -0.01, 0.003);
      }
    }
  }

  /**
   * The fish's forward speed in body lengths per second — the unit fish biology
   * is written in, and the one worth putting on a debug readout.
   */
  get speedSL(): number {
    return this.locomotion.speedSL;
  }

  /** Where the fish's snout is, in world space. Used for the camera and the HUD. */
  snoutWorld(out: Vec3): Vec3 {
    this.body.snout(scratch.tmp);
    return this.locomotion.toWorld(scratch.tmp, out);
  }

  /**
   * A one-line summary of the fish's internal state, for the preview HUD.
   * Deliberately phrased the way a person would describe an animal.
   */
  describe(): string {
    const d = this.brain.drives;
    const pct = (x: number) => `${Math.round(x * 100)}%`;
    return (
      `${this.brain.intention}  ` +
      `hunger ${pct(d.hunger)}  air ${pct(d.airDebt)}  fear ${pct(d.fear)}  ` +
      `fatigue ${pct(d.fatigue)}  aggression ${pct(d.aggression)}  ` +
      `${this.speedSL.toFixed(2)} SL/s  ${this.command.frequency.toFixed(1)} Hz`
    );
  }
}

/** Ray from a point in a direction to the water plane, for turning a tap into a drop point. */
export function rayToWaterSurface(
  origin: Vec3,
  direction: Vec3,
  water: WaterSurface,
  out: Vec3,
): boolean {
  // The surface is nearly flat, so one intersection with the still plane and one
  // correction against the real height field is plenty — iterating further moves
  // the answer by less than a pellet's width.
  if (Math.abs(direction.y) < 1e-5) return false;
  let t = (TANK.waterY - origin.y) / direction.y;
  if (t <= 0) return false;
  scale(out, direction, t);
  out.x += origin.x;
  out.y += origin.y;
  out.z += origin.z;

  const h = water.heightAt(out.x, out.z);
  t = (h - origin.y) / direction.y;
  if (t <= 0) return false;
  scale(out, direction, t);
  out.x += origin.x;
  out.y += origin.y;
  out.z += origin.z;
  return true;
}

export type { Morphology, MotorCommand, Stimuli };

/** Points each slice is spread over, top to bottom. */
const HOLD_POINTS = 5;

function addAlong(out: Vec3, axis: Vec3, amount: number): void {
  out.x += axis.x * amount;
  out.y += axis.y * amount;
  out.z += axis.z * amount;
}

function dotV(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
