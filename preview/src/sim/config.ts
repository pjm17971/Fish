/**
 * Every physical constant in the simulation, in one place.
 *
 * This mirrors docs/SIMULATION-SPEC.md exactly and is the file the Swift port
 * (ios/Aquarium/Sources/Sim/SimConfig.swift) is kept in step with. If you change
 * a number here, change it there and in the spec.
 *
 * Units are SI throughout: metres, kilograms, seconds, radians.
 */

// ---------------------------------------------------------------------------
// Fluid and environment
// ---------------------------------------------------------------------------

/** Fresh water at 25 C. */
export const RHO_WATER = 997.0; // kg/m^3
/** Kinematic viscosity of fresh water at 25 C. */
export const NU_WATER = 8.9e-7; // m^2/s
export const GRAVITY = 9.81; // m/s^2

// ---------------------------------------------------------------------------
// Tank
//
// Origin at the centre of the front glass, which is physically the phone
// screen. +x right, +y up, +z out of the screen towards the viewer. The tank
// interior is therefore z in [-D, 0].
// ---------------------------------------------------------------------------

export const TANK = {
  width: 0.350,
  height: 0.200,
  depth: 0.250,
  /** Still water level, relative to the front-glass centre. */
  waterY: -0.015,
  /** Top of the substrate at the front of the tank. */
  floorY: -0.100,
  /** The sand slopes up towards the back by this much. */
  floorSlopeBack: 0.012,
  glassThickness: 0.004,
} as const;

/** Still water depth. Drives the shallow-water wave speed, so it is not cosmetic. */
export const WATER_DEPTH = TANK.waterY - TANK.floorY; // 0.085 m

export const TANK_MIN_X = -TANK.width / 2;
export const TANK_MAX_X = TANK.width / 2;
export const TANK_MIN_Z = -TANK.depth;
export const TANK_MAX_Z = 0;

// ---------------------------------------------------------------------------
// Fish morphology — Betta splendens, male veiltail
// ---------------------------------------------------------------------------

export const FISH = {
  /** Standard length: snout to the base of the tail. The reference length for everything. */
  standardLength: 0.048,
  /** Total length including the caudal fin, for reference only. */
  totalLength: 0.072,
  mass: 1.5e-3, // 1.5 g
  bodyDensity: 1000.0,
  maxDepth: 0.0135,
  maxWidth: 0.0062,
  /** Where along the body the depth peaks (0 = snout, 1 = tail base). */
  depthPeakAt: 0.34,

  /** Number of centreline segments the body is discretised into. */
  segments: 24,
  /**
   * Extra segments continuing past the peduncle to represent the caudal fin.
   *
   * The tail fin is treated as the last and deepest part of the body rather than
   * a separate object, which is exactly Lighthill's elongated-body picture. It
   * inherits the same travelling wave, and because the amplitude envelope keeps
   * growing past the body the fin's trailing edge sweeps nearly twice as far as
   * its root — which is where most of the thrust comes from.
   */
  caudalSegments: 6,

  // --- swimming kinematics ---
  /** Body wave length as a fraction of standard length. Subcarangiform. */
  waveLengthRatio: 0.95,
  /** Steady-swimming tail-tip half amplitude, as a fraction of standard length. */
  tailAmplitudeRatio: 0.10,
  /** Escape-burst tail-tip half amplitude. */
  burstAmplitudeRatio: 0.16,
  maxTailBeatHz: 9.0,
  /** Below this speed the fish stops using its tail and rows with its pectorals. */
  pectoralOnlySpeedSL: 0.35,
  maxPectoralHz: 6.0,

  /** Amplitude envelope A(s)/A_tip = a0 + a1*s + a2*s^2. */
  ampEnvelope: { a0: 0.08, a1: -0.30, a2: 1.22 },
  /**
   * Turning bend: bendScale * s^bendExp, a steady one-sided curvature added to
   * the travelling wave.
   *
   * This is the amplitude for *steering*. At 0.010 a full deflection swung the
   * caudal fin's tip nearly forty millimetres off the centreline — an
   * escape-grade C-shape, being used for ordinary course corrections several
   * times a second. Because the reactive force follows the rate of body
   * deformation and the tail carries grams of entrained water, each of those
   * flips produced fifteen to twenty times the fish's weight in force and threw
   * it across the tank at twelve body lengths a second.
   */
  /**
   * Peak sideways offset of the tail beat at full steering deflection, in
   * metres. About 80% of the beat's own amplitude, which makes a strongly
   * one-sided sweep without the tail ever crossing the centreline.
   */
  bendScale: 0.0038,
  /** Static camber of the whole body into a turn, at the tail tip, in metres. */
  bendCamber: 0.010,
  /**
   * How much further the fish can bend in a reflex. A C-start really is an
   * extreme posture — the body folds into a C — and it needs the range.
   */
  bendReflexGain: 2.4,

  // --- hydrodynamic coefficients ---
  /** Cross-flow drag coefficient for a finite plate at this aspect ratio. */
  crossFlowCd: 1.65,
  /**
   * Longitudinal added-mass coefficient (Lamb's k1) for a slender body of this
   * fineness ratio. Sideways and vertical added mass are NOT constants here —
   * they are integrated from the real cross-sections in morphology.ts, because
   * guessing them as multiples of body mass turned out to understate the
   * sideways figure by more than half.
   */
  addedMassSurgeCoefficient: 0.15,

  /** How far the centre of volume sits above the centre of mass — the righting moment. */
  centreOfVolumeOffsetY: 0.0014,
  /** Swim bladder volume range, as a multiple of the neutral-buoyancy volume. */
  bladderRange: [0.85, 1.15] as const,
  /** How fast the bladder can change, per second of its full range. */
  bladderSlewRate: 0.04,

  /** Physics substep. 250 Hz — fast enough that a 9 Hz tail beat is well resolved. */
  dt: 0.004,
  maxSubsteps: 5,
} as const;

/** Pectoral fin rowing stroke. See spec 4.3. */
export const PECTORAL = {
  /** Mean sweep angle from the body axis. */
  sweepMean: 0.35,
  /** Sweep amplitude. */
  sweepAmp: 0.55,
  /** Feathering amplitude. */
  pitchAmp: 0.62,
  /**
   * Phase lead of pitch over sweep. This is the whole trick: with zero offset a
   * rowing fin does equal work on the power and recovery strokes and produces no
   * net thrust. Test `pectoral.phase` asserts exactly that.
   */
  pitchPhase: 1.9,
  area: 0.011 * 0.007,
  span: 0.011,
  /** Where the pectorals attach along the body. */
  attachAt: 0.30,
} as const;

// ---------------------------------------------------------------------------
// Fins simulated as cloth
// ---------------------------------------------------------------------------

export const FINS = {
  caudal: { rows: 9, cols: 11, chord: 0.024, span: 0.030, attachS: 1.0 },
  dorsal: { rows: 7, cols: 9, height: 0.019, fromS: 0.46, toS: 0.92 },
  anal: { rows: 7, cols: 13, height: 0.023, fromS: 0.42, toS: 0.98 },
  pelvic: { rows: 3, cols: 7, height: 0.016, attachS: 0.33 },

  /** Membrane thickness between rays, and at a ray. Used by both physics and shading. */
  membraneThickness: 0.00010,
  rayThickness: 0.00035,
  /**
   * Areal density of fin tissue: roughly 1050 kg/m^3 of tissue at an average
   * thickness of about 0.15 mm.
   */
  arealDensity: 0.16, // kg/m^2
  /**
   * Bending stiffness of a fin ray, as a spring pulling the next node towards
   * where a straight continuation of the ray would put it. In N/m.
   *
   * Real fin rays are extraordinarily floppy: a 0.2 mm bony spine 24 mm long has
   * a tip stiffness of only a couple of newtons per metre, which is why betta
   * fins trail and ripple the way they do rather than holding a shape. This is
   * that figure, and the fin's apparent stiffness comes mostly from the water it
   * has to move, not from the ray.
   */
  rayStiffness: 2.2,
  /**
   * How strongly the webbing pulls a node towards its neighbours on the adjacent
   * rays, per smoothing pass. 0 gives independent streamers, 1 a rigid sheet.
   */
  membraneCoupling: 0.28,
  /**
   * Damping of a fin ray, as a fraction of critical for its own bending mode.
   *
   * Given as a ratio rather than a rate because the rate that matters depends on
   * each fin's stiffness and the water it carries, and those differ by an order
   * of magnitude between the caudal fin and a pelvic streamer. A ray's natural
   * frequency here is 30-60 Hz — far above any tail beat — and at a fixed 6 per
   * second, which looked like a reasonable "tissue is lossy" number, every fin
   * rang at that frequency forever. The ringing then fed the reactive force
   * term, and a fish with nothing but one tiny pelvic fin and a completely still
   * tail swam across the tank at four body lengths a second.
   *
   * Real fins do not ring: at these sizes the surrounding water damps them hard.
   * 0.45 of critical settles a disturbance within a couple of beats while still
   * letting the fin trail and lag, which is the thing worth having.
   */
  dampingRatio: 0.45,
  /** Constraint solver iterations per substep. */
  solverIterations: 8,
  /** Fin substeps per fish substep. The fin is far stiffer than the body. */
  substeps: 4,
} as const;

// ---------------------------------------------------------------------------
// Water surface — damped wave equation on a height field
// ---------------------------------------------------------------------------

export const WATER = {
  /**
   * Grid resolution.
   *
   * Sized against the timestep rather than picked for looks. A finer grid forces
   * a smaller timestep through the CFL condition, so the cost goes up as the
   * *square* of the resolution: going from 80x58 to 96x68 costs 2.3 times the
   * work, and at 4.5 mm per cell there is nothing left to resolve — the ripples
   * that matter at finer scales than this are added as a normal-map detail
   * layer in the shader, which is both cheaper and sharper.
   */
  nx: 80,
  nz: 58,
  /**
   * Wave speed. NOT a tuning parameter: this is sqrt(g * depth), the
   * shallow-water long-wave result, and it is what makes the sloshing period
   * come out at the physically correct value. See test `water.slosh`.
   */
  get waveSpeed(): number {
    return Math.sqrt(GRAVITY * WATER_DEPTH); // 0.913 m/s
  },
  /**
   * Viscous smoothing of the velocity field, which removes grid-scale buzz.
   *
   * The stability limit for this term is not the one it looks like. Taken alone
   * it is a diffusion, so the obvious condition is alpha*c*dt/dx^2 <= 1/2 — but
   * the wave and viscous terms share the same velocity update, and analysing the
   * two-by-two amplification matrix of the combined scheme gives a much tighter
   * requirement: dt*(alpha*c*lambda_max + beta) must stay below 1, where
   * lambda_max is the largest eigenvalue of the discrete Laplacian. Above that
   * the velocity damping overshoots each step and the shortest wavelength on the
   * grid grows instead of decaying.
   *
   * The first value tried, 0.008, satisfied the diffusion condition at 0.4 of
   * its limit and violated this one by 60%. The surface behaved impeccably in
   * gentle conditions and went to NaN within a second of being shaken hard. The
   * constructor now checks the real condition, so a change to the grid, the
   * timestep or the damping cannot quietly reintroduce it.
   */
  alpha: 0.0005,
  /** Bulk damping. Sized so a disturbance dies away over about 4 seconds. */
  beta: 0.45,
  /** How stiffly the bulk follows a tilt of the phone. */
  sloshStiffness: 26.0,
  /**
   * Fixed substep. Sits at 73% of the CFL limit and 59% of the damping limit for
   * the shipped grid, both of which the constructor checks.
   */
  dt: 0.0025,
  maxSubsteps: 10,

  /** Fish coupling: how close to the surface a body segment has to be to disturb it. */
  fishCouplingRange: 0.020,
  fishCouplingGain: 0.35,
  /** Pellet impact: fraction of impact speed injected into the surface velocity. */
  pelletImpactGain: 0.05,
  pelletImpactRadius: 0.004,

  /** Bulk flow: filter-outlet vortex. */
  vortexCentre: { x: 0.13, z: -0.20 },
  vortexCoreRadius: 0.06,
  vortexPeakSpeed: 0.012,
  /** Bulk flow: curl-noise. */
  curlScale: 0.09,
  curlTimeHz: 0.15,
  curlAmplitude: 0.004,
} as const;

// ---------------------------------------------------------------------------
// Food pellets
// ---------------------------------------------------------------------------

export const FOOD: {
  radius: number;
  radiusJitter: number;
  densityDry: number;
  densitySaturated: number;
  soakTau: number;
  pelletsPerDrop: number;
  dropIntervalS: number;
  dropScatter: number;
  hungerPerPellet: number;
  decayTime: number;
  scentDiffusivity: number;
  maxPellets: number;
} = {
  radius: 0.0007,
  radiusJitter: 0.15,
  /** Dry pellets float. */
  densityDry: 640.0,
  /** Once waterlogged they sink. */
  densitySaturated: 1080.0,
  /** Time constant of waterlogging. */
  soakTau: 38.0,
  /** How many pellets a double tap drops, and how far apart in time. */
  pelletsPerDrop: 3,
  dropIntervalS: 0.010,
  dropScatter: 0.004,
  /** Hunger removed by eating one pellet. */
  hungerPerPellet: 0.16,
  /** A pellet left uneaten breaks down over about this long. */
  decayTime: 360.0,
  /** Eddy diffusivity for the scent field the fish smells. */
  scentDiffusivity: 2.5e-5,
  maxPellets: 48,
};

// ---------------------------------------------------------------------------
// Perception
// ---------------------------------------------------------------------------

export const PERCEPTION = {
  /** Half-angle of the visual field either side of the body axis. */
  visionHalfAngle: (160 * Math.PI) / 180,
  visionRange: 0.18,
  /** Half-angle of the binocular wedge straight ahead. */
  binocularHalfAngle: (22 * Math.PI) / 180,
  binocularAcuityBonus: 2.5,
  detectionThreshold: 0.055,

  /** Lateral line: senses water motion, including behind the fish. */
  lateralLineRange: 0.10,
  lateralLineThreshold: 0.006,

  /** Looming: rate of growth of an object's visual angle that triggers escape. */
  loomingThreshold: 2.2,

  /** Familiarity grid, for novelty-driven patrolling. */
  noveltyGrid: { nx: 6, ny: 4, nz: 5 },
  familiarityRise: 0.10,
  familiarityDecay: 0.004,
} as const;

// ---------------------------------------------------------------------------
// Internal state (ethology)
//
// Rates are per second of fish time. `timeScale` in WorldConfig multiplies them
// all, so the whole physiology can be compressed for a demo without touching
// any of the relationships between drives.
// ---------------------------------------------------------------------------

export const DRIVES = {
  /** Hunger fills over about six hours. */
  hungerRate: 1 / (6 * 3600),
  /** Working hard makes the fish hungrier faster. */
  hungerActivityGain: 1.6,

  /**
   * Air debt. A betta has a labyrinth organ and must surface to breathe.
   * Baseline gives a gulp about every 7 minutes; hard swimming cuts that to ~3.
   */
  airRate: 1 / 420,
  airActivityGain: 2.2,
  /** Above this the surfacing drive starts to compete seriously. */
  airUrgentAt: 0.75,
  /** Above this it beats even fear — a fish must breathe, predator or not. */
  airOverrideAt: 0.95,

  fearTau: 26.0,
  fatigueTau: 90.0,
  /** Fatigue accrues with the cube of speed — the cost of transport is steeply nonlinear. */
  fatigueSpeedGain: 0.055,
  /** Flaring is hard work and self-limits after 20-40 s. */
  fatigueFlareGain: 4.0,

  aggressionTau: 45.0,
  /** After a display ends, the fish will not start another for this long. */
  aggressionRefractory: 20.0,

  boredomRate: 0.05,
} as const;

// ---------------------------------------------------------------------------
// Intention arbitration
// ---------------------------------------------------------------------------

export const INTENTION = {
  /** Bonus the running intention gets, so a challenger must be clearly better. */
  persistenceBonus: 0.12,
  /** Nothing can switch faster than this. */
  minDwell: 0.6,
  /** Except escape, which must be able to fire immediately. */
  minDwellEscape: 0.15,
  /** And avoidance, which is brief but must not flicker against escape. */
  minDwellAvoid: 0.25,
  /** A predicted collision inside this many seconds pre-empts everything. */
  collisionLookahead: 0.25,
  /**
   * How close to a wall the fish starts steering away.
   *
   * Three centimetres, not five. In a tank twenty-five centimetres deep, five
   * put the fish inside the avoidance zone almost all the time.
   */
  wallAvoidDistance: 0.03,
  /** Floor under the patrol drive, so an entirely satisfied fish still swims. */
  patrolFloor: 0.14,
} as const;

// ---------------------------------------------------------------------------
// Optics — used by the renderers, kept here so both ports agree
// ---------------------------------------------------------------------------

export const OPTICS = {
  /**
   * Absorption coefficients of pure water at 600 / 550 / 450 nm, per metre
   * (Pope & Fry 1997). Over a 0.25 m tank this is a very slight warm-light
   * loss, which is correct: a small tank of clean water is nearly colourless.
   */
  waterAbsorption: [0.458, 0.0565, 0.0145] as const,
  /** Dissolved organics ("gelbstoff") — real aquarium water is faintly yellow. */
  tanninAbsorption: [0.02, 0.06, 0.16] as const,
  tannin: 0.22,
  /** Suspended particulate. */
  scatteringCoefficient: 0.10,
  /** Henyey-Greenstein asymmetry: strongly forward-scattering, like real water. */
  scatteringG: 0.68,

  iorWater: 1.333,
  iorGlass: 1.52,

  /** Fish skin: thin-film interference in the guanine platelets of the scales. */
  filmThicknessNm: 380,
  filmThicknessVarianceNm: 90,
  iorFilm: 1.83, // guanine
  iorSkinBase: 1.40,
  mucusRoughness: 0.14,
} as const;

// ---------------------------------------------------------------------------
// Viewer / off-axis projection
// ---------------------------------------------------------------------------

export const VIEW = {
  /** Where the virtual eye sits when no face is tracked. */
  fallbackEyeDistance: 0.34,
  /** Blend time when face tracking is gained or lost. */
  eyeSourceBlendTime: 0.5,
  /** 1-euro filter on the eye position: adapts its cutoff to how fast you move. */
  oneEuroMinCutoff: 0.7,
  oneEuroBeta: 0.25,
  oneEuroDerivativeCutoff: 1.0,
  near: 0.02,
  far: 3.0,
} as const;

export interface WorldConfig {
  seed: number;
  /**
   * Multiplies every physiological rate. 1.0 is real time — hunger takes six
   * real hours to fill. Raise it to see the full behavioural repertoire in a
   * few minutes. Only the drives scale; the physics never does.
   */
  timeScale: number;
}

export const DEFAULT_WORLD_CONFIG: WorldConfig = {
  seed: 0x5eed1234,
  timeScale: 1.0,
};
