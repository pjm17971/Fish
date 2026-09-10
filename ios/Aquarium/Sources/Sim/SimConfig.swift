import Foundation

/// Every physical constant in the simulation, in one place.
///
/// This is kept in step with `preview/src/sim/config.ts` and with
/// `docs/SIMULATION-SPEC.md`. If you change a number here, change it in both.
///
/// Units are SI throughout: metres, kilograms, seconds, radians.

// MARK: - Fluid and environment

/// Fresh water at 25 C.
let RHO_WATER: Double = 997.0
/// Kinematic viscosity of fresh water at 25 C.
let NU_WATER: Double = 8.9e-7
let GRAVITY: Double = 9.81

// MARK: - Tank

/// The tank.
///
/// The origin is the centre of the front glass, which is physically the phone's
/// screen: +x right, +y up, +z out of the screen towards you. The tank interior
/// is therefore z in [-depth, 0], directly behind the device.
enum Tank {
    static let width: Double = 0.350
    static let height: Double = 0.200
    static let depth: Double = 0.250
    /// Still water level, relative to the centre of the front glass.
    static let waterY: Double = -0.015
    /// Top of the substrate at the front of the tank.
    static let floorY: Double = -0.100
    /// The sand slopes up towards the back by this much.
    static let floorSlopeBack: Double = 0.012
    static let glassThickness: Double = 0.004

    /// Still water depth. This drives the shallow-water wave speed, so it is not
    /// a cosmetic number.
    static var waterDepth: Double { waterY - floorY }

    static var minX: Double { -width / 2 }
    static var maxX: Double { width / 2 }
    static var minZ: Double { -depth }
    static var maxZ: Double { 0 }
}

// MARK: - Fish morphology (Betta splendens, male veiltail)

enum Fish {
    /// Standard length: snout to the base of the tail. The reference for everything.
    static let standardLength: Double = 0.048
    /// Total length including the caudal fin, for reference only.
    static let totalLength: Double = 0.072
    static let mass: Double = 1.5e-3
    static let bodyDensity: Double = 1000.0
    static let maxDepth: Double = 0.0135
    static let maxWidth: Double = 0.0062
    /// Where along the body the depth peaks (0 = snout, 1 = tail base).
    static let depthPeakAt: Double = 0.34

    /// Centreline segments the body is discretised into.
    static let segments: Int = 24
    /// Extra segments continuing past the peduncle to represent the caudal fin.
    ///
    /// The tail fin is treated as the last and deepest part of the body rather
    /// than a separate object, which is exactly Lighthill's elongated-body
    /// picture. It inherits the same travelling wave, and because the amplitude
    /// envelope keeps growing past the body its trailing edge sweeps furthest —
    /// which is where most of the thrust comes from.
    static let caudalSegments: Int = 6

    // Swimming kinematics
    /// Body wave length as a fraction of standard length. Subcarangiform.
    static let waveLengthRatio: Double = 0.95
    /// Steady-swimming tail-tip half amplitude, as a fraction of standard length.
    static let tailAmplitudeRatio: Double = 0.10
    /// Escape-burst tail-tip half amplitude.
    static let burstAmplitudeRatio: Double = 0.16
    static let maxTailBeatHz: Double = 9.0
    /// Below this speed the fish stops using its tail and rows with its pectorals.
    static let pectoralOnlySpeedSL: Double = 0.35
    static let maxPectoralHz: Double = 6.0

    /// Amplitude envelope A(s)/A_tip = a0 + a1*s + a2*s^2, before normalisation.
    static let ampA0: Double = 0.08
    static let ampA1: Double = -0.30
    static let ampA2: Double = 1.22

    /// Peak sideways offset of the tail beat at full steering deflection, metres.
    /// How much harder the tail beats to one side than the other in a turn, as
    /// a fraction of the beat amplitude. This is what turns the fish at a
    /// standstill: a beat that is further and faster to one side puts a net
    /// sideways impulse into the water at the tail. The earlier static one-sided
    /// shift of a symmetric wave had equal speeds both ways and netted nothing
    /// at rest, so the fish could only turn as a rudder does, with water
    /// flowing past, and could not turn round in the tank.
    static let bendAsymmetry: Double = 0.8
    /// Static camber of the whole body into a turn, at the tail tip, metres.
    static let bendCamber: Double = 0.010
    /// How much further the fish can bend in a reflex. A C-start is an extreme
    /// posture and needs the range.
    static let bendReflexGain: Double = 2.4

    // Hydrodynamic coefficients
    /// Cross-flow drag coefficient for a finite plate at this aspect ratio.
    static let crossFlowCd: Double = 1.65
    /// Longitudinal added-mass coefficient (Lamb's k1) for a slender body.
    ///
    /// Sideways and vertical added mass are *not* constants — they are integrated
    /// from the real cross-sections in Morphology, because guessing them as
    /// multiples of body mass understated the sideways figure by more than half.
    static let addedMassSurgeCoefficient: Double = 0.15

    /// How far the centre of volume sits above the centre of mass — the fish's
    /// righting moment, and why a healthy fish rolls upright by itself.
    /// Viscous rotational damping, as a time constant. Quadratic damping alone
    /// decays as 1/t and a kicked fish coasted in yaw for seconds; a small fish
    /// in water stops within a fraction of a second.
    static let rotationalViscousTau: Double = 2.5
    static let centreOfVolumeOffsetY: Double = 0.0014
    /// Small, and deliberately so. At ±15% the bladder was the strongest
    /// vertical force the fish had and it rose and sank on it with the tail
    /// switched off. A real bladder is a trim tank, not an elevator: ±3% is
    /// enough to trim and not enough to fly on.
    static let bladderRange: (Double, Double) = (0.97, 1.03)
    static let bladderSlewRate: Double = 0.04

    /// Physics substep. 250 Hz — fast enough that a 9 Hz tail beat is well resolved.
    static let dt: Double = 0.004
    static let maxSubsteps: Int = 5
}

/// Pectoral fin rowing stroke.
enum Pectoral {
    static let sweepMean: Double = 0.35
    static let sweepAmp: Double = 0.55
    /// Feathering: how far the blade turns edge-on during the recovery stroke.
    /// The profile is (1 - cos(phase))/2 — flat through the power stroke, edge-on
    /// through the recovery. A sinusoid with a phase lead feathered both strokes
    /// equally and produced no thrust, only a large vertical force per fin.
    static let pitchAmp: Double = 1.45
    /// Sweep angle the fin folds back to when it is not rowing. An outstretched
    /// paddle is a brake; a folded one is edge-on and, tilted, an elevator.
    static let sweepFolded: Double = 1.25
    static let area: Double = 0.011 * 0.007
    static let span: Double = 0.011
    static let attachAt: Double = 0.30
}

// MARK: - Fins

struct FinDimensions {
    let rows: Int
    let cols: Int
    let extent: Double
    let span: Double
    let fromS: Double
    let toS: Double
}

enum Fins {
    static let caudal = FinDimensions(rows: 9, cols: 11, extent: 0.024, span: 0.030, fromS: 1.0, toS: 1.0)
    static let dorsal = FinDimensions(rows: 7, cols: 9, extent: 0.019, span: 0.0, fromS: 0.46, toS: 0.92)
    static let anal = FinDimensions(rows: 7, cols: 13, extent: 0.023, span: 0.0, fromS: 0.42, toS: 0.98)
    static let pelvic = FinDimensions(rows: 3, cols: 7, extent: 0.016, span: 0.0035, fromS: 0.33, toS: 0.33)

    static let membraneThickness: Double = 0.00010
    static let rayThickness: Double = 0.00035
    /// Roughly 1050 kg/m^3 of tissue at an average thickness of about 0.15 mm.
    static let arealDensity: Double = 0.16

    /// Bending stiffness of a fin ray, N/m.
    ///
    /// Real fin rays are extraordinarily floppy: a 0.2 mm bony spine 24 mm long
    /// has a tip stiffness of only a couple of newtons per metre, which is why
    /// betta fins trail and ripple rather than holding a shape. A fin's apparent
    /// stiffness comes mostly from the water it has to move, not from the ray.
    static let rayStiffness: Double = 2.2
    /// Damping as a fraction of critical for the ray's own bending mode.
    ///
    /// Given as a ratio rather than a rate because the rate that matters depends
    /// on each fin's stiffness and entrained water, and those differ by an order
    /// of magnitude between the caudal fin and a pelvic streamer. A ray's natural
    /// frequency here is 30 to 60 Hz, and at a fixed low damping every fin rang
    /// at that frequency indefinitely.
    static let dampingRatio: Double = 0.45
    /// How strongly the webbing pulls a node towards its neighbours, per pass.
    static let membraneCoupling: Double = 0.28
    /// Fin substeps per fish substep.
    static let substeps: Int = 4
}

// MARK: - Water

enum Water {
    /// Grid resolution.
    ///
    /// Sized against the timestep rather than picked for looks. A finer grid
    /// forces a smaller timestep through the CFL condition, so cost rises as the
    /// *square* of resolution; at 4.5 mm per cell there is nothing left to
    /// resolve that the shader's ripple detail layer does not do better.
    static let nx: Int = 80
    static let nz: Int = 58

    /// Wave speed.
    ///
    /// NOT a tuning parameter: this is sqrt(g * depth), the shallow-water
    /// long-wave result, and it is what makes the sloshing period come out at the
    /// value a tank this size really has.
    static var waveSpeed: Double { (GRAVITY * Tank.waterDepth).squareRoot() }

    /// Viscous smoothing of the velocity field.
    ///
    /// Its stability limit is not the one it looks like. Taken alone it is a
    /// diffusion, so the obvious condition is alpha*c*dt/dx^2 <= 1/2 — but the
    /// wave and viscous terms share the same velocity update, and the combined
    /// scheme's amplification matrix requires dt*(alpha*c*lambda_max + beta) to
    /// stay below 1. `WaterSurface` checks the real condition at start-up.
    static let alpha: Double = 0.0005
    /// Bulk damping, sized so a disturbance dies away over about four seconds.
    static let beta: Double = 0.45
    /// How stiffly the bulk follows a tilt of the phone.
    static let sloshStiffness: Double = 26.0
    /// Fixed substep. Sits at 74% of the CFL limit and 59% of the damping limit
    /// for the shipped grid, both of which `WaterSurface` checks at start-up.
    static let dt: Double = 0.0025
    static let maxSubsteps: Int = 10

    static let fishCouplingRange: Double = 0.020
    static let fishCouplingGain: Double = 0.35
    static let pelletImpactGain: Double = 0.05
    static let pelletImpactRadius: Double = 0.004

    static let vortexCentreX: Double = 0.13
    static let vortexCentreZ: Double = -0.20
    static let vortexCoreRadius: Double = 0.06
    static let vortexPeakSpeed: Double = 0.012
    static let curlScale: Double = 0.09
    static let curlTimeHz: Double = 0.15
    static let curlAmplitude: Double = 0.004
    /// The filter outlet, where the return stream meets the surface and keeps
    /// a patch of millimetre ripples going all the time. Without a source the
    /// surface settles to a perfect plane and the tank looks dry: the ripples
    /// carry the caustics, the wobble in everything seen through the surface,
    /// and the glints.
    static let outletRadius: Double = 0.014
    static let outletRippleHz: Double = 2.6
    static let outletRippleAccel: Double = 2.0
}

// MARK: - Food

enum Food {
    static let radius: Double = 0.0007
    static let radiusJitter: Double = 0.15
    /// Dry pellets float.
    static let densityDry: Double = 640.0
    /// Once waterlogged they sink.
    static let densitySaturated: Double = 1080.0
    static let soakTau: Double = 38.0
    static let pelletsPerDrop: Int = 3
    static let dropIntervalS: Double = 0.010
    static let dropScatter: Double = 0.004
    static let hungerPerPellet: Double = 0.16
    static let decayTime: Double = 360.0
    static let scentDiffusivity: Double = 2.5e-5
    static let maxPellets: Int = 48
}

// MARK: - Perception

enum Perception {
    static let visionHalfAngle: Double = 160.0 * .pi / 180.0
    static let visionRange: Double = 0.18
    static let binocularHalfAngle: Double = 22.0 * .pi / 180.0
    static let binocularAcuityBonus: Double = 2.5
    static let detectionThreshold: Double = 0.055

    static let lateralLineRange: Double = 0.10
    static let lateralLineThreshold: Double = 0.006

    /// Rate of growth of an object's visual angle that triggers escape.
    static let loomingThreshold: Double = 2.2

    static let noveltyNX: Int = 6
    static let noveltyNY: Int = 4
    static let noveltyNZ: Int = 5
    static let familiarityRise: Double = 0.10
    static let familiarityDecay: Double = 0.004
}

// MARK: - Drives

/// Internal state rates, per second of fish time.
///
/// `WorldConfig.timeScale` multiplies them all, so the whole physiology can be
/// compressed for a demonstration without touching any of the relationships
/// between drives.
enum Drives {
    /// Hunger fills over about six hours.
    static let hungerRate: Double = 1.0 / (6 * 3600)
    static let hungerActivityGain: Double = 1.6

    /// Air debt. A betta has a labyrinth organ and must surface to breathe.
    /// Baseline gives a gulp about every seven minutes; hard swimming cuts that
    /// to roughly three.
    static let airRate: Double = 1.0 / 420
    static let airActivityGain: Double = 2.2
    /// Above this the surfacing drive starts to compete seriously.
    static let airUrgentAt: Double = 0.75
    /// Above this it beats even fear — a fish must breathe, predator or not.
    static let airOverrideAt: Double = 0.95

    static let fearTau: Double = 26.0
    static let fatigueTau: Double = 90.0
    /// Speed above which the fish is working anaerobically and starts to tire,
    /// in body lengths per second. Below it, it can swim indefinitely.
    ///
    /// This is where the fish switches from red muscle to white — around four
    /// body lengths a second for a fish this size. An earlier value of two is an
    /// ordinary cruising speed, and at two the fish accrued fatigue whenever it
    /// moved at all: fatigue saturated, `rest` won permanently, and the fish lay
    /// on the bottom and never surfaced for air again.
    static let aerobicSpeedSL: Double = 4.0
    /// The same threshold as a tail-beat frequency, which is what the fatigue
    /// model uses: from the speed-against-beat fit, four body lengths a second
    /// is about 4.3 beats a second.
    static let aerobicBeatHz: Double = 4.3
    /// Fatigue accrues with the cube of the speed above that threshold: cost of
    /// transport is steeply nonlinear, which is why a fish bursts briefly and
    /// then has to stop.
    static let fatigueSpeedGain: Double = 0.030
    static let fatigueFlareGain: Double = 4.0

    static let aggressionTau: Double = 45.0
    static let aggressionRefractory: Double = 20.0
    static let boredomRate: Double = 0.05
}

// MARK: - Intention arbitration

enum Intent {
    /// Bonus the running intention gets, so a challenger must be clearly better.
    static let persistenceBonus: Double = 0.12
    static let minDwell: Double = 0.6
    static let minDwellEscape: Double = 0.15
    /// Avoidance holds for half a second — long enough to actually complete the
    /// swerve. A fish that reconsiders halfway through a turn away from the glass
    /// turns back into it.
    static let minDwellAvoid: Double = 0.5
    static let collisionLookahead: Double = 0.25
    /// How close to a wall the fish starts steering away. Three centimetres, not
    /// five: in a tank twenty-five centimetres deep, five put the fish inside the
    /// avoidance zone almost all the time.
    static let wallAvoidDistance: Double = 0.03
    /// Floor under the patrol drive, so an entirely contented fish still swims.
    static let patrolFloor: Double = 0.14
}

// MARK: - Optics

enum Optics {
    /// Absorption coefficients of pure water at 600 / 550 / 450 nm, per metre
    /// (Pope & Fry 1997). Over a 0.25 m tank this is a very slight warm-light
    /// loss, which is correct: a small tank of clean water is nearly colourless.
    static let waterAbsorption = SIMD3<Float>(0.458, 0.0565, 0.0145)
    /// Dissolved organics — real aquarium water is faintly yellow.
    static let tanninAbsorption = SIMD3<Float>(0.02, 0.06, 0.16)
    static let tannin: Float = 0.22
    static let scatteringCoefficient: Float = 0.10
    /// Henyey-Greenstein asymmetry: strongly forward-scattering, like real water.
    static let scatteringG: Float = 0.68

    static let iorWater: Float = 1.333
    static let iorGlass: Float = 1.52

    /// Fish skin: thin-film interference in the guanine platelets of the scales.
    static let filmThicknessNm: Float = 380
    static let filmThicknessVarianceNm: Float = 90
    static let iorFilm: Float = 1.83  // guanine
    static let iorSkinBase: Float = 1.40
    static let mucusRoughness: Float = 0.14
}

// MARK: - Viewer

enum ViewConfig {
    /// Where the virtual eye sits when no face is tracked.
    static let fallbackEyeDistance: Double = 0.34
    /// Blend time when face tracking is gained or lost.
    static let eyeSourceBlendTime: Double = 0.5
    /// 1-euro filter on the eye position: adapts its cutoff to how fast you move.
    static let oneEuroMinCutoff: Double = 0.7
    static let oneEuroBeta: Double = 0.25
    static let oneEuroDerivativeCutoff: Double = 1.0
    static let near: Float = 0.02
    static let far: Float = 3.0
}

struct WorldConfig {
    var seed: UInt32 = 0x5eed_1234
    /// Multiplies every physiological rate. 1.0 is real time — hunger takes six
    /// real hours to fill. Only the drives scale; the physics never does.
    var timeScale: Double = 1.0
}
