/**
 * The world: everything assembled, and the order things happen in.
 *
 * Order matters here. Perception has to run on the state the fish could actually
 * have sensed, forces have to be gathered before anything integrates, and the
 * water has to see the fish's motion from the step it just took rather than the
 * one before. Getting this wrong does not crash anything; it just makes the fish
 * feel very slightly late, in a way that is almost impossible to find later.
 */

import { Vec3, v3, set, copy, sub, scale, clamp } from './math.js';
import { DEFAULT_WORLD_CONFIG, TANK, WATER, WorldConfig } from './config.js';
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

  constructor(config: Partial<WorldConfig> = {}) {
    this.config = { ...DEFAULT_WORLD_CONFIG, ...config };
    this.morphology = buildMorphology();
    this.body = new FishBody(this.morphology);
    this.locomotion = createLocomotion(this.morphology, this.body);
    this.fins = buildFins(this.morphology);
    this.water = new WaterSurface();
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
