import Foundation
import simd

/// The fish's brain: what it senses, what it wants, and what it does about it.
///
/// The architecture follows Tu and Terzopoulos, *Artificial Fishes* (SIGGRAPH
/// 1994) — perception feeds a set of internal state variables, an intention
/// generator picks one with enough hysteresis that the fish does not dither, and
/// a behaviour routine turns that intention into muscle commands. Their fish had
/// hunger, libido and fear. A lone captive betta needs a different set, and the
/// most important one is not on their list at all.
///
/// **The fish has to breathe.** Bettas are labyrinth fish: they take air at the
/// surface every few minutes and will drown without access to it. That single
/// fact does more for the illusion of life than anything else here, because it is
/// an internal state with no external cause. A fish that swims to the surface,
/// breaks it and goes back down — on its own schedule, for its own reasons, with
/// nothing in the scene prompting it — reads as an animal in a way that no amount
/// of reactive behaviour does.
///
/// Nothing in this file moves the fish. Every routine produces a *motor goal*,
/// and the steering layer converts that into a tail-beat frequency, an amplitude
/// and a bend. What actually happens is then up to the water.

enum Intention: String, CaseIterable {
    case escape, surface, flare, strike, forage, rest, inspect, patrol, avoid
}

/// Everything the fish can currently feel.
struct Percepts {
    var nearestFood: Pellet?
    var foodDistance: Double = .infinity
    var scentGradient = Vec3.zero
    /// Something big is approaching the glass fast. 0 to 1.
    var looming: Double = 0
    /// A rival is visible — a face at the glass, or the fish's own reflection.
    var rivalVisible: Double = 0
    var rivalDirection = Vec3.zero
    var wallDistance: Double = .infinity
    var wallAway = Vec3.zero
    /// Water disturbance from the lateral line, including in the blind spot.
    var disturbance: Double = 0
    var disturbanceDirection = Vec3.zero
    /// How familiar the fish's current spot is, 0 (new) to 1 (well explored).
    var familiarity: Double = 0
}

/// The fish's internal state. All in [0, 1].
struct DriveState {
    var hunger: Double = 0.28
    /// How badly it needs a breath of air at the surface.
    var airDebt: Double = 0.15
    var fear: Double = 0
    var fatigue: Double = 0.05
    var aggression: Double = 0
    var boredom: Double = 0.3
}

/// What a behaviour routine asks for. Never a velocity, never a teleport.
struct MotorGoal {
    var target = Vec3.zero
    /// How fast it wants to go, in body lengths per second.
    var speedSL: Double = 0
    /// 0 = ambling, 1 = emergency.
    var urgency: Double = 0
    var finSpread: Double = 0.55
    var gillFlare: Double = 0
    var mouthOpen: Double = 0
    /// Whether the fish should hold station rather than travel.
    var hover = false
}

/// External stimuli the outside world hands to the brain.
struct Stimuli {
    /// Where the viewer's face is, in tank coordinates, or nil if unknown.
    ///
    /// On the phone this comes from the front camera. It is the single most
    /// effective input in the whole system: a betta reacts strongly to a face at
    /// the glass, and a fish that notices you approach and comes to look is the
    /// thing people find uncanny.
    var viewerPosition: Vec3?
    /// How fast the viewer is approaching, m/s. Positive is towards the glass.
    var viewerApproachSpeed: Double = 0
    /// A tap on the glass, decaying.
    var tapImpulse: Double = 0
    var tapPosition = Vec3.zero
}

/// How far a suction strike reaches — about a third of the fish's body length.
///
/// That sounds generous and is not: a suction-feeding fish generates an inflow
/// that entrains prey from roughly one mouth diameter away, and a betta taking a
/// floating pellet essentially engulfs a volume of water around it.
private let STRIKE_RANGE: Double = 0.018
/// How close the pellet has to get before it is inside the mouth. A betta's gape
/// is around 3 mm; this is measured from the snout tip to the pellet's centre, so
/// some of it is simply where the reference point sits relative to the opening.
private let SWALLOW_RANGE: Double = 0.009
/// Peak inflow speed at the mouth during a strike, m/s.
private let SUCTION_SPEED: Double = 0.14
/// How close the snout's centreline must come to the surface for the fish to have
/// its mouth in the air. The top of the head is a few millimetres above the point
/// this is measured from, so this is head depth, not slack.
private let SURFACE_REACH: Double = 0.005

final class FishBrain {
    private(set) var drives = DriveState()
    private(set) var percepts = Percepts()
    private(set) var goal = MotorGoal()

    private(set) var intention: Intention = .patrol
    private(set) var intentionAge: Double = 0
    /// Desire values from the last arbitration, for the debug overlay.
    private(set) var desires: [Intention: Double] = [:]

    /// Where the fish's mouth is, in world space, refreshed each tick.
    ///
    /// Distances to food are measured from here, not from the centre of mass. The
    /// mouth is a couple of centimetres in front of the centre of mass, which is
    /// most of a body length on a fish this size — measuring from the centre means
    /// the strike can only succeed with the pellet somewhere inside the fish.
    private(set) var mouth = Vec3.zero

    /// Set when the fish takes a breath, so the world can make a bubble.
    private(set) var gulpedThisTick = false
    /// Set when the fish's mouth closes on a pellet.
    private(set) var atePelletThisTick: Pellet?

    /// Familiarity of each cell of the tank, driving novelty-seeking.
    private var familiarity: [Float]

    // Routine-internal state.
    private var patrolTarget = Vec3.zero
    private var forageHeading: Double = 0
    private var forageTimer: Double = 0
    private enum SurfacePhase { case approach, gulp, leave }
    private var surfacePhase: SurfacePhase = .approach
    private var surfaceTimer: Double = 0
    private var escapeTimer: Double = 0
    private var escapeDirection = Vec3.zero
    private var aggressionRefractory: Double = 0
    private var strikeTimer: Double = 0
    private var inspectTimer: Double = 0
    private var restTarget = Vec3.zero
    /// The tail-beat frequency commanded last tick, for the effort model.
    private var lastCommandFrequency: Double = 0
    private var yawRateFiltered: Double = 0
    private var pitchRateFiltered: Double = 0

    private var rng: Rng
    private let cfg: WorldConfig

    init(config: WorldConfig) {
        cfg = config
        rng = Rng(seed: config.seed ^ 0x9e37_79b9)
        familiarity = [Float](repeating: 0,
                              count: Perception.noveltyNX * Perception.noveltyNY * Perception.noveltyNZ)
        patrolTarget = v3(0, Tank.waterY - 0.04, -Tank.depth * 0.5)
        restTarget = v3(0, Tank.floorY + 0.01, -Tank.depth * 0.5)
        for i in Intention.allCases { desires[i] = 0 }
    }

    // MARK: - Perception

    private func perceive(
        _ loco: FishLocomotion, _ body: FishBody, _ pellets: [Pellet],
        _ water: WaterSurface, _ stim: Stimuli, _ dt: Double
    ) {
        let fwd = loco.forward()
        mouth = loco.toWorld(body.snout())

        // --- Food, by sight ---
        percepts.nearestFood = nil
        percepts.foodDistance = .infinity
        for pellet in pellets where pellet.alive {
            let toPellet = pellet.position - mouth
            let d = lengthSafe(toPellet)
            if d > Perception.visionRange { continue }

            let dir = normalizeSafe(toPellet)
            let angle = acos(clampd(simd_dot(dir, fwd), -1, 1))
            if angle > Perception.visionHalfAngle { continue }  // blind spot behind

            // Acuity falls off with distance, and the narrow binocular wedge
            // straight ahead is much sharper — which is why the fish turns to face
            // something before it commits to striking at it.
            var acuity = 1 / max(0.01, d)
            if angle < Perception.binocularHalfAngle { acuity *= Perception.binocularAcuityBonus }
            let contrast = pellet.radius * 400
            if contrast * acuity < Perception.detectionThreshold { continue }

            if d < percepts.foodDistance {
                percepts.foodDistance = d
                percepts.nearestFood = pellet
            }
        }

        // --- Food, by smell ---
        //
        // Scent finds food the fish never saw arrive. Each pellet leaves a cloud
        // that spreads as sqrt(time), and the fish climbs the total gradient.
        percepts.scentGradient = .zero
        for pellet in pellets where pellet.alive {
            let toPellet = pellet.position - mouth
            let d = lengthSafe(toPellet)
            let sigma = max(0.005, (2 * Food.scentDiffusivity * pellet.age).squareRoot())
            if d > sigma * 4 { continue }
            let g = exp(-(d * d) / (2 * sigma * sigma)) / max(1e-4, d)
            percepts.scentGradient += toPellet * g
        }

        // --- Walls ---
        let dxMin = loco.position.x - Tank.minX
        let dxMax = Tank.maxX - loco.position.x
        let dzMin = loco.position.z - Tank.minZ
        let dzMax = Tank.maxZ - loco.position.z
        let dyMin = loco.position.y - Tank.floorY

        // The water surface is deliberately not in this list. It is a boundary but
        // not an obstacle: the fish has to reach it to breathe and to take food
        // off it. Counting it as a wall means the avoidance steering pushes the
        // fish down every time it gets close, so it can approach a floating pellet
        // to within a few centimetres and then be shoved away from it, forever.
        percepts.wallDistance = min(dxMin, dxMax, dzMin, dzMax, dyMin)
        percepts.wallAway = .zero
        if percepts.wallDistance < Intent.wallAvoidDistance {
            // Push away from every nearby wall at once, weighted by closeness.
            // Summing rather than picking the nearest is what stops the fish
            // getting stuck oscillating in a corner between two competing pushes.
            func w(_ d: Double) -> Double {
                d < Intent.wallAvoidDistance ? 1 / max(0.004, d * d) : 0
            }
            percepts.wallAway.x += w(dxMin) - w(dxMax)
            percepts.wallAway.z += w(dzMin) - w(dzMax)
            percepts.wallAway.y += w(dyMin)
            percepts.wallAway = normalizeSafe(percepts.wallAway, fallback: .zero)
        }

        // --- The viewer, as both a threat and a rival ---
        percepts.looming = 0
        percepts.rivalVisible = 0
        percepts.rivalDirection = .zero
        if let viewer = stim.viewerPosition {
            let d = lengthSafe(viewer - loco.position)
            // Looming is the rate at which something's apparent size grows. It is
            // a real and fast escape pathway in fish, separate from recognising
            // what the thing is — which is why a hand moving at the glass startles
            // a fish that has seen a hundred hands.
            if stim.viewerApproachSpeed > 0 && d > 0.02 {
                let loomRate = (2 * stim.viewerApproachSpeed) / d
                percepts.looming = saturate(
                    (loomRate - Perception.loomingThreshold) / Perception.loomingThreshold)
            }
            // A face held at the glass reads to a male betta as a rival.
            if d < 0.5 && stim.viewerApproachSpeed < 0.05 {
                percepts.rivalVisible = saturate(1 - d / 0.5)
                percepts.rivalDirection = normalizeSafe(viewer - loco.position)
            }
        }

        // --- Lateral line ---
        //
        // A pressure-gradient sense along the flank. It works in the blind spot
        // and in the dark, and it is how a pellet landing behind the fish gets
        // noticed at all.
        percepts.disturbance = 0
        percepts.disturbanceDirection = .zero
        for pellet in pellets where pellet.alive && pellet.age <= 1.5 {
            let toPellet = pellet.position - loco.position
            let d = lengthSafe(toPellet)
            if d > Perception.lateralLineRange { continue }
            let strength = (1 - d / Perception.lateralLineRange) * pellet.impactEnergy
            if strength > percepts.disturbance {
                percepts.disturbance = strength
                percepts.disturbanceDirection = normalizeSafe(toPellet)
            }
        }
        if stim.tapImpulse > Perception.lateralLineThreshold {
            percepts.disturbance = max(percepts.disturbance, saturate(stim.tapImpulse))
        }

        // --- Familiarity of where it currently is ---
        let cell = cellIndex(loco.position)
        percepts.familiarity = Double(familiarity[cell])
        familiarity[cell] = Float(min(1, Double(familiarity[cell]) + Perception.familiarityRise * dt))
        let decay = Float(Perception.familiarityDecay * dt)
        for i in 0..<familiarity.count { familiarity[i] = max(0, familiarity[i] - decay) }
    }

    private func cellIndex(_ p: Vec3) -> Int {
        let gx = Perception.noveltyNX, gy = Perception.noveltyNY, gz = Perception.noveltyNZ
        let ix = Int(clampd((p.x - Tank.minX) / Tank.width * Double(gx), 0, Double(gx) - 1))
        let iy = Int(clampd((p.y - Tank.floorY) / max(1e-4, Tank.waterY - Tank.floorY) * Double(gy),
                            0, Double(gy) - 1))
        let iz = Int(clampd((p.z - Tank.minZ) / Tank.depth * Double(gz), 0, Double(gz) - 1))
        return (iz * gy + iy) * gx + ix
    }

    // MARK: - Internal state

    private func updateDrives(_ loco: FishLocomotion, _ dt: Double) {
        let ts = cfg.timeScale
        // Effort, from what the muscles are doing rather than from how fast the
        // fish happens to be moving: a fish bounced off the glass is moving fast
        // and working not at all. The tail beat is the muscle's own clock; a
        // brisk cruise is about three beats a second.
        let beat = lastCommandFrequency
        let effort = saturate(beat / 3)

        drives.hunger = saturate(
            drives.hunger + Drives.hungerRate * (1 + Drives.hungerActivityGain * effort) * dt * ts)

        // Air debt. Working hard uses air faster, so an agitated fish surfaces
        // more often than a calm one — a visible, legible consequence of an
        // invisible internal state, and most of why the fish reads as alive.
        drives.airDebt = saturate(
            drives.airDebt + Drives.airRate * (1 + Drives.airActivityGain * effort) * dt * ts)

        drives.fear = expApproach(drives.fear, 0, rate: 1 / Drives.fearTau, dt: dt * ts)
        drives.aggression = expApproach(drives.aggression, 0, rate: 1 / Drives.aggressionTau, dt: dt * ts)
        aggressionRefractory = max(0, aggressionRefractory - dt * ts)

        // Fatigue climbs with the cube of speed above the aerobic threshold: the
        // cost of transport is steeply nonlinear, which is why a fish bursts
        // briefly and then has to stop.
        //
        // The threshold is where the fish switches from red muscle to white —
        // around four body lengths a second for a small fish. Setting it at an
        // ordinary cruising speed means the fish accrues fatigue whenever it moves
        // at all: it saturates, `rest` wins permanently, and the fish lies on the
        // bottom and never surfaces for air again.
        // In beats per second: four body lengths a second is about 4.3 Hz on
        // this fish, and a collision cannot be mistaken for a sprint.
        let burst = max(0, beat - Drives.aerobicBeatHz)
        let flaring = intention == .flare ? Drives.fatigueFlareGain : 0
        drives.fatigue = saturate(
            drives.fatigue + (Drives.fatigueSpeedGain * burst * burst * burst + flaring * 0.01) * dt * ts)
        drives.fatigue = expApproach(drives.fatigue, 0, rate: 1 / Drives.fatigueTau, dt: dt * ts)

        drives.boredom = expApproach(drives.boredom, percepts.familiarity,
                                     rate: Drives.boredomRate * 4, dt: dt * ts)
    }

    /// Something startled the fish. Called for taps, looms and impacts.
    func startle(amount: Double, direction: Vec3) {
        drives.fear = saturate(drives.fear + amount)
        escapeDirection = direction
    }

    // MARK: - Intention arbitration

    private func arbitrate(_ loco: FishLocomotion, _ dt: Double) {
        let d = drives
        let p = percepts
        var de: [Intention: Double] = [:]

        // Escape outranks obstacle avoidance. A startled fish performs its C-start
        // whether or not there is glass in the way — real ones hit the glass, and
        // a fish that politely declines to flee because it is near a wall is not a
        // fish. The only thing above it is suffocation.
        de[.escape] = d.fear * 1.30
        de[.surface] = smoothstep(Drives.airUrgentAt, 1.0, d.airDebt) * (1 - 0.5 * d.fear)
        de[.flare] = d.aggression * p.rivalVisible * (1 - d.fear) * (1 - 0.7 * d.fatigue)
            * (aggressionRefractory > 0 ? 0 : 1)
        de[.strike] = p.nearestFood != nil
            ? smoothstep(0.10, 0.55, d.hunger) * saturate(1 - p.foodDistance / Perception.visionRange)
            : 0
        de[.forage] = smoothstep(0.30, 0.85, d.hunger) * (p.nearestFood != nil ? 0.2 : 1)
        de[.rest] = smoothstep(0.55, 1.0, d.fatigue) * (1 - d.hunger) * (1 - d.fear)
        de[.inspect] = p.rivalVisible * (1 - d.fear) * (0.3 + 0.7 * d.boredom) * 0.6
        de[.patrol] = Intent.patrolFloor + 0.30 * d.boredom

        // Obstacle avoidance, graded by how imminent the collision is.
        //
        // What matters is whether the fish is *closing* on a wall, not whether it
        // happens to be near one. A fish cruising parallel to the glass a
        // centimetre away is in no danger, and in a tank this small — the fish is
        // a fifth of the tank's depth long — it is near a boundary most of the
        // time. Judging by distance alone leaves the fish permanently in
        // avoidance: it never feeds, never displays, and cannot even be startled
        // into fleeing. Nothing looks broken; it just looks listless.
        let closing = -simd_dot(loco.velocity, p.wallAway)
        if closing > 1e-3 && p.wallDistance < Intent.wallAvoidDistance * 3 {
            let timeToImpact = p.wallDistance / closing
            de[.avoid] = smoothstep(Intent.collisionLookahead * 2,
                                    Intent.collisionLookahead * 0.4, timeToImpact)
        } else {
            de[.avoid] = 0
        }

        // A fish that badly needs air surfaces even with a predator present,
        // because it has to. A real hierarchy, not a tie-break.
        if d.airDebt > Drives.airOverrideAt { de[.surface] = 1.45 }

        desires = de

        // Pick the best, with the running intention holding a bonus so a
        // challenger has to be clearly better rather than marginally better.
        var best = intention
        var bestValue = -Double.infinity
        for key in Intention.allCases {
            var value = de[key] ?? 0
            if key == intention { value += Intent.persistenceBonus }
            if value > bestValue {
                bestValue = value
                best = key
            }
        }

        // Minimum dwell. Nothing switches faster than this, so the fish cannot
        // flicker between two nearly equal options — which is what a plain argmax
        // does and what makes simulated animals look twitchy and indecisive.
        //
        // Escape may interrupt anything, including avoidance. Avoidance may
        // interrupt anything except escape. Neither may interrupt itself, which is
        // what stops the two alternating every frame and producing intentions that
        // last zero seconds.
        let dwell: Double
        switch intention {
        case .escape: dwell = Intent.minDwellEscape
        case .avoid: dwell = Intent.minDwellAvoid
        default: dwell = Intent.minDwell
        }
        let preempt = (best == .escape && intention != .escape)
            || (best == .avoid && intention != .avoid && intention != .escape)

        if best != intention && (intentionAge >= dwell || preempt) {
            onIntentionChanged(from: intention, to: best, loco: loco)
            intention = best
            intentionAge = 0
        } else {
            intentionAge += dt
        }
    }

    private func onIntentionChanged(from: Intention, to: Intention, loco: FishLocomotion) {
        if from == .flare { aggressionRefractory = Drives.aggressionRefractory }
        // Having just swerved away from a wall, do not resume a course that
        // pointed straight into it. Without this the fish bounces along the
        // glass, avoiding and un-avoiding several times a second.
        if from == .avoid { pickPatrolTarget() }
        switch to {
        case .surface:
            surfacePhase = .approach
            surfaceTimer = 0
        case .escape:
            escapeTimer = rng.range(0.4, 0.9)
        case .forage:
            forageTimer = 0
            forageHeading = atan2(loco.velocity.x, loco.velocity.z)
        case .strike:
            strikeTimer = 0
        case .inspect:
            inspectTimer = rng.range(2, 6)
        case .patrol:
            pickPatrolTarget()
        case .rest:
            pickRestTarget()
        default:
            break
        }
    }

    /// Head for the least familiar corner of the tank.
    private func pickPatrolTarget() {
        let gx = Perception.noveltyNX, gy = Perception.noveltyNY, gz = Perception.noveltyNZ
        var worst = Double.infinity
        var bestIdx = 0
        // A little noise so the fish does not always visit the cells in the same
        // order.
        for i in 0..<familiarity.count {
            let v = Double(familiarity[i]) + rng.range(0, 0.15)
            if v < worst {
                worst = v
                bestIdx = i
            }
        }
        let ix = bestIdx % gx
        let iy = (bestIdx / gx) % gy
        let iz = bestIdx / (gx * gy)
        patrolTarget = v3(
            Tank.minX + ((Double(ix) + 0.5) / Double(gx)) * Tank.width,
            Tank.floorY + ((Double(iy) + 0.5) / Double(gy)) * (Tank.waterY - Tank.floorY),
            Tank.minZ + ((Double(iz) + 0.5) / Double(gz)) * Tank.depth
        )
    }

    private func pickRestTarget() {
        // Bettas rest on leaves rather than lying on the substrate. The world
        // places a broad leaf in the middle of the water column for exactly this.
        restTarget = v3(
            rng.range(-0.05, 0.05),
            Tank.floorY + 0.045,
            Tank.minZ + Tank.depth * rng.range(0.4, 0.7)
        )
    }

    // MARK: - Behaviour routines

    private func runRoutine(_ loco: FishLocomotion, _ water: WaterSurface, _ dt: Double) {
        let p = percepts
        goal.hover = false
        goal.mouthOpen = 0
        goal.gillFlare = 0
        gulpedThisTick = false
        atePelletThisTick = nil

        switch intention {
        case .avoid:
            goal.target = loco.position + p.wallAway * 0.12
            goal.target.y = clampd(goal.target.y, Tank.floorY + 0.02, Tank.waterY - 0.01)
            goal.speedSL = 1.6
            // A wall is not a predator: a swerve, not a burst.
            goal.urgency = 0.5 * saturate(1 - p.wallDistance / Intent.wallAvoidDistance)
            goal.finSpread = 0.6

        case .escape:
            // A C-start: the fish bends into a C on the first frame and fires.
            // Real escape latency is 5 to 15 ms, so this begins on the very next
            // physics step rather than after a wind-up.
            escapeTimer -= dt
            goal.target = loco.position - escapeDirection * 0.15
            goal.target.y = clampd(goal.target.y, Tank.floorY + 0.02, Tank.waterY - 0.015)
            goal.speedSL = 9
            goal.urgency = 1
            goal.finSpread = 0.25   // fins clamp in a burst, to cut drag
            if escapeTimer <= 0 { drives.fear *= 0.35 }

        case .surface:
            runSurface(loco, water, dt)

        case .flare:
            // Hold station facing the rival, gill covers out, everything spread.
            // Fatigue accumulates fast while doing this, so displays self-limit
            // after twenty to forty seconds, as real ones do.
            goal.target = loco.position + p.rivalDirection * 0.02
            goal.speedSL = 0.1
            goal.hover = true
            goal.urgency = 0.7
            goal.finSpread = 1.0
            goal.gillFlare = saturate(intentionAge / 0.35)

        case .strike:
            runStrike(loco, dt)

        case .forage:
            runForage(loco, dt)

        case .rest:
            goal.target = restTarget
            goal.speedSL = lengthSafe(loco.position - restTarget) > 0.03 ? 0.9 : 0
            goal.hover = goal.speedSL == 0
            goal.urgency = 0.1
            goal.finSpread = 0.35   // fins hang loose at rest

        case .inspect:
            inspectTimer -= dt
            goal.target = loco.position + p.rivalDirection * 0.05
            goal.target.y = clampd(goal.target.y, Tank.floorY + 0.02, Tank.waterY - 0.015)
            goal.speedSL = 0.5
            goal.hover = true
            goal.urgency = 0.25
            goal.finSpread = 0.7
            if inspectTimer <= 0 { drives.boredom = min(1, drives.boredom + 0.3) }

        case .patrol:
            if lengthSafe(loco.position - patrolTarget) < 0.05 { pickPatrolTarget() }
            goal.target = patrolTarget
            goal.speedSL = 1.2
            goal.urgency = 0.2
            goal.finSpread = 0.65
        }
    }

    private func runSurface(_ loco: FishLocomotion, _ water: WaterSurface, _ dt: Double) {
        // Approach, break the surface, gulp, leave. The gulp is what the whole
        // drive exists for and is worth doing properly: the snout genuinely
        // crosses the water line, which makes real ripples.
        let surfaceY = water.height(atX: loco.position.x, z: loco.position.z)
        surfaceTimer += dt
        let fwd = loco.forward()
        let lift = loco.position.y - mouth.y

        switch surfacePhase {
        case .approach:
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
            let ahead = 0.045
            goal.target = v3(mouth.x + fwd.x * ahead, surfaceY + 0.003 + lift, mouth.z + fwd.z * ahead)
            goal.speedSL = 1.4
            goal.urgency = 0.5
            // The tolerance is the depth of the fish's own head: what breaks the
            // surface is the top of the snout, a few millimetres above the
            // centreline point this is measured from.
            if mouth.y > surfaceY - SURFACE_REACH {
                surfacePhase = .gulp
                surfaceTimer = 0
            }

        case .gulp:
            goal.target = v3(mouth.x + fwd.x * 0.02, surfaceY + 0.004 + lift, mouth.z + fwd.z * 0.02)
            goal.speedSL = 0.2
            goal.hover = true
            goal.mouthOpen = 0.8
            // The breath only counts if the snout is genuinely at the surface.
            // Running it off a timer alone lets the fish "gulp air" a centimetre
            // under water whenever it gets jostled on the way up.
            if surfaceTimer > 0.22 && mouth.y > surfaceY - SURFACE_REACH * 1.4 {
                drives.airDebt = 0
                gulpedThisTick = true
                surfacePhase = .leave
                surfaceTimer = 0
            }
            // If it has been trying too long, come back later rather than hanging
            // at the surface indefinitely.
            if surfaceTimer > 2.5 { surfacePhase = .approach }

        case .leave:
            goal.target = v3(loco.position.x, surfaceY - 0.05, loco.position.z - 0.03)
            goal.speedSL = 1.8
            goal.urgency = 0.4
        }
        goal.finSpread = 0.5
    }

    private func runStrike(_ loco: FishLocomotion, _ dt: Double) {
        guard let food = percepts.nearestFood else { return }
        // Steer so the *mouth* arrives at the pellet, not the centre of mass.
        goal.target = food.position + loco.position - mouth
        let d = percepts.foodDistance

        // Slow down as it closes, rather than switching between two speeds.
        // Charging a two-millimetre pellet at two body lengths a second and hoping
        // to stop in time does not work.
        goal.speedSL = clampd(d * 45, 0.5, 2.2)
        goal.urgency = 0.6
        goal.finSpread = 0.55
        // Switch to holding station on the pectorals only at the last moment:
        // pectorals are for station keeping, not for covering ground.
        goal.hover = d < STRIKE_RANGE * 0.6

        // --- The suction strike ---
        //
        // A fish does not catch food by colliding with it. It expands its buccal
        // cavity, which pulls water — and whatever is in it — into the mouth from
        // a short distance away. That is why fish can feed accurately at all: the
        // prey is drawn the last few millimetres rather than intercepted exactly.
        //
        // Modelling it as a proximity test means the fish has to place a mouth a
        // few millimetres across onto a pellet under a millimetre across while
        // both are moving, which is a far harder problem than the animal actually
        // solves, and it fails constantly.
        guard d < STRIKE_RANGE else {
            strikeTimer = 0
            return
        }

        strikeTimer += dt
        // A fish's mouth opens in around 30 ms; the whole strike is over in under
        // a tenth of a second.
        goal.mouthOpen = saturate(strikeTimer / 0.03)

        let toFood = normalizeSafe(food.position - mouth)
        let aligned = simd_dot(toFood, loco.forward())

        if goal.mouthOpen > 0.5 && aligned > 0.2 {
            // The inflow the expanding mouth creates, as a sink flow: fastest at
            // the mouth, falling away with distance. The pellet is *advected* by
            // it rather than nudged — a pellet under a millimetre across has a
            // Stokes number well below one, so it follows the water almost
            // exactly.
            let inflow = SUCTION_SPEED * (1 - d / STRIKE_RANGE)
            food.externalFlow = -toFood * inflow
        }

        // Once the pellet is at the lips with the mouth open, it is taken.
        //
        // Direction is deliberately not part of this. Requiring the pellet to be
        // squarely ahead fails exactly where it matters most: a pellet floating on
        // the surface sits *above* a level fish, and one the fish has just
        // overshot sits behind the snout tip — which is to say, inside its head.
        // Both are cases where a real fish has the food.
        if d < SWALLOW_RANGE && goal.mouthOpen > 0.4 {
            atePelletThisTick = food
            drives.hunger = saturate(drives.hunger - Food.hungerPerPellet)
            strikeTimer = 0
        } else if strikeTimer > 0.9 {
            // Missed. Real fish miss constantly, and the missing is a large part
            // of what makes feeding look alive. Back off and come round again.
            food.velocity += toFood * 0.02
            strikeTimer = 0
            intentionAge = Intent.minDwell   // free to reconsider
        }
    }

    private func runForage(_ loco: FishLocomotion, _ dt: Double) {
        // A correlated random walk, biased up the scent gradient. Turn angles come
        // from a wrapped Cauchy distribution rather than a Gaussian: it has the
        // heavy tails that produce the occasional sharp reorientation, which is
        // what makes a search path look like an animal's rather than a drunkard's.
        forageTimer -= dt
        if forageTimer <= 0 {
            forageTimer = rng.range(0.6, 1.6)
            forageHeading += rng.wrappedCauchy(0.72)
        }
        let gradLen = lengthSafe(percepts.scentGradient)
        goal.target = loco.position
        if gradLen > 1e-6 {
            goal.target += normalizeSafe(percepts.scentGradient) * 0.10
        } else {
            // Nothing to smell: search near the surface, since that is where betta
            // pellets are.
            goal.target.x += sin(forageHeading) * 0.10
            goal.target.z += cos(forageHeading) * 0.10
            goal.target.y = Tank.waterY - 0.025
        }
        goal.speedSL = 1.3
        goal.urgency = 0.3
        goal.finSpread = 0.6
    }

    // MARK: - Steering

    /// The steering layer is deliberately thin, because the water does the work.
    ///
    /// The tail-beat frequency is *integrated* towards the speed error rather than
    /// solved for. That means the fish accelerates on its own hydrodynamic terms
    /// and always lags its own intention slightly, which is how an animal with
    /// muscle and inertia behaves. Setting the frequency directly from the error
    /// gives a fish that reaches its target speed instantly and reads as a puppet.
    private func steer(_ cmd: inout MotorCommand, _ loco: FishLocomotion, _ dt: Double) {
        let p = percepts

        // Wall repulsion, folded into whatever the fish is already trying to do.
        // Every behaviour gets this, so the fish steers round the glass while it
        // is foraging or patrolling instead of having to *decide* to avoid the
        // wall — which is both how a real animal behaves and the only way the
        // other drives ever get a turn.
        if p.wallDistance < Intent.wallAvoidDistance * 2 && intention != .surface {
            let strength = smoothstep(Intent.wallAvoidDistance * 2, 0, p.wallDistance) * 0.09
            goal.target += p.wallAway * strength
        }

        // Whatever a routine asked for, the place to go is inside the tank; a
        // target beyond the glass presses the fish against the pane.
        goal.target.x = clampd(goal.target.x, Tank.minX + 0.03, Tank.maxX - 0.03)
        goal.target.z = clampd(goal.target.z, Tank.minZ + 0.03, -0.03)
        goal.target.y = clampd(goal.target.y, Tank.floorY + 0.02, Tank.waterY - 0.004)

        let toTarget = goal.target - loco.position
        let distance = lengthSafe(toTarget)
        let desired = distance > 1e-6 ? toTarget / distance : v3(0, 0, 1)

        // Heading error in the fish's own frame. The frame is right-handed with
        // +z forward and +y up, which puts +x on the fish's *left*; the signs
        // below were set by measurement, not from the labels.
        let local = rotateInverse(loco.orientation, desired)
        // Heading error in the horizontal plane, and only when there is a
        // horizontal component worth turning for: a target nearly straight above
        // or below needs pitch, not yaw. Clamping the forward component read a
        // pellet overhead as ninety degrees to one side.
        let horizontal = hypot(local.x, local.z)
        let yawError = horizontal > 0.25 ? atan2(local.x, local.z) : 0
        let pitchError = asin(clampd(local.y, -1, 1))

        // Low-pass the rate feedback. Feeding back the raw instantaneous turn rate
        // couples the controller to the body's own recoil oscillation — the head
        // yaws back and forth with every tail beat — and it then chases that
        // instead of the heading.
        let wBody = rotateInverse(loco.orientation, loco.angularVelocity)
        yawRateFiltered = expApproach(yawRateFiltered, wBody.y, rate: 12, dt: dt)
        pitchRateFiltered = expApproach(pitchRateFiltered, wBody.x, rate: 12, dt: dt)

        // Turning is a one-sided bend of the body, driven by a PD controller.
        //
        // The derivative term is not optional. With proportional control alone at
        // a gain high enough to turn briskly, the bend saturates at full
        // deflection for any heading error beyond about twenty degrees — most of
        // the time — so the fish turns as hard as it can, overshoots, turns as
        // hard as it can the other way, and circles its target forever without
        // ever closing on it.
        let turnGain = 1.35 * (0.65 + 0.35 * goal.urgency)
        // Positive bend turns the fish towards +x when the tail is driving —
        // measured. With the sign the other way the fish turned away from its
        // target whenever the tail ran.
        cmd.bend = clampd(turnGain * yawError - 0.035 * yawRateFiltered, -1, 1)

        // Depth is held two ways, on very different timescales.
        //
        // The swim bladder is a trim tank. It drifts slowly towards whatever
        // makes the fish neutrally buoyant at the depth it wants to be, and it
        // is driven by the *height* error, not the pitch error: it has no
        // business responding to which way the nose is pointing. An earlier
        // version fed it the pitch error at a gain that made it the strongest
        // vertical force the fish had, and the fish rose and sank on its bladder
        // with the tail switched off.
        let heightError = goal.target.y - loco.position.y
        cmd.bladder = clampd(heightError / 0.03, -1, 1)
        // The manoeuvring is done by swimming: the body pitches and the
        // pectorals angle, and forward motion carries the fish up or down.
        cmd.pitchBend = clampd(
            pitchError * 1.6 * (0.6 + 0.4 * goal.urgency) - 0.03 * pitchRateFiltered, -1, 1)
        // The pectorals are the elevators and do most of the work: the body's own
        // vertical bend is almost useless for climbing on a fish this laterally
        // compressed.
        cmd.pectoralPitch = clampd(pitchError * 2.4 - 0.20 * pitchRateFiltered, -1, 1)

        // Slow down to turn.
        //
        // The fish's turning radius while cruising is several body lengths — a
        // consequence of how much water its fins have to swing sideways, and a
        // real property of a long-finned betta. In a tank only seven body lengths
        // across it cannot turn round at speed at all; it has to slow down first,
        // which is exactly what a real fish does in a confined space. At walking
        // pace it can pivot almost on the spot with its pectorals.
        let turnPenalty = 1 - 0.75 * saturate(abs(yawError) / 1.1)
        // Forward speed, not total speed. Sinking is not swimming.
        let speedError = goal.speedSL * turnPenalty - loco.forwardSpeedSL

        // A large turn is made on the spot, not on the move: see the pivot
        // branch below.
        let pivoting = abs(yawError) > 0.85

        if pivoting {
            // A tail scull: a slow beat at full asymmetry with the body curled,
            // pectorals folded, brakes on. Three beats a second with half the
            // reflex range of curl measured best: about thirty degrees a second
            // on a ten-centimetre radius. The water the flanks and fins must
            // shove sideways to rotate is thirty-five times the fish's own yaw
            // inertia, and that is what sets the rate.
            cmd.frequency = expApproach(cmd.frequency, 3.0, rate: 6, dt: dt)
            cmd.amplitude = Fish.standardLength * Fish.tailAmplitudeRatio
            cmd.pectoralLeft = expApproach(cmd.pectoralLeft, 0, rate: 4, dt: dt)
            cmd.pectoralRight = expApproach(cmd.pectoralRight, 0, rate: 4, dt: dt)
            cmd.brake = expApproach(cmd.brake, 0.8, rate: 8, dt: dt)
        } else if goal.hover || goal.speedSL < Fish.pectoralOnlySpeedSL {
            // Slow work is done with the pectorals, which is what a hovering betta
            // actually uses. The tail stops.
            cmd.frequency = expApproach(cmd.frequency, 0, rate: 6, dt: dt)
            // No body bend while pivoting: a C-bend at a standstill is a C-start,
            // and the recoil kicks the head the other way. The pectorals turn.
            cmd.bend = expApproach(cmd.bend, 0, rate: 8, dt: dt)
            let base = clampd(1.6 + speedError * 2.5, 0.4, Fish.maxPectoralHz)
            // Differential beat turns the fish on the spot and lets it back up —
            // bettas can swim backwards, and this falls out without extra
            // machinery.
            // Rowing the fin on the -x side (index 0) yaws the fish towards +x.
            let diff = clampd(yawError * 1.4 - 0.03 * yawRateFiltered, -1, 1)
            cmd.pectoralLeft = clampd(base * (1 + diff), 0, Fish.maxPectoralHz)
            cmd.pectoralRight = clampd(base * (1 - diff), 0, Fish.maxPectoralHz)
            cmd.amplitude = Fish.standardLength * Fish.tailAmplitudeRatio * 0.4
        } else {
            // Winding the beat down is faster than winding it up: a fish can stop
            // driving instantly but cannot summon power instantly.
            let rate = speedError < 0 ? 9.0 : 3.5
            cmd.frequency = clampd(cmd.frequency + rate * speedError * dt, 0, Fish.maxTailBeatHz)
            // Keep a slow beat going: the fins have to stay extended to work as
            // elevators.
            // Fold the pectorals: a cruising betta lays them along its flanks, and
            // folded they are edge-on to the flow and act as elevators. Kept
            // half-open and beating they were a dive plane.
            cmd.pectoralLeft = expApproach(cmd.pectoralLeft, 0, rate: 4, dt: dt)
            cmd.pectoralRight = expApproach(cmd.pectoralRight, 0, rate: 4, dt: dt)
            // Amplitude is nearly constant in real steady swimming — fish change
            // speed by changing frequency — and only opens up in a burst.
            let burst = intention == .escape
            cmd.amplitude = Fish.standardLength
                * (burst ? Fish.burstAmplitudeRatio : Fish.tailAmplitudeRatio)
        }

        // Brake when going faster than intended, and hard when much faster.
        if !pivoting { cmd.brake = expApproach(cmd.brake, saturate(-speedError * 0.8), rate: 14, dt: dt) }

        // A pivot gets half the reflex range of body curl: the camber is what
        // points the tail's push sideways instead of backwards.
        // A quarter of the reflex range of curl in a pivot; more is a C-start.
        cmd.agility = intention == .escape ? goal.urgency : (pivoting ? 0.25 : goal.urgency)
        cmd.finSpread = expApproach(cmd.finSpread, goal.finSpread, rate: 3.5, dt: dt)
        cmd.gillFlare = expApproach(cmd.gillFlare, goal.gillFlare, rate: 5, dt: dt)
        cmd.mouthOpen = expApproach(cmd.mouthOpen, goal.mouthOpen, rate: 18, dt: dt)
    }

    // MARK: - Tick

    /// One brain tick. Called at the frame rate, not the physics rate.
    func step(
        _ cmd: inout MotorCommand, loco: FishLocomotion, body: FishBody,
        pellets: [Pellet], water: WaterSurface, stimuli: Stimuli, dt: Double
    ) {
        perceive(loco, body, pellets, water, stimuli, dt)

        // Reflexes that bypass deliberation entirely.
        if percepts.looming > 0 {
            let away = normalizeSafe((stimuli.viewerPosition ?? loco.position) - loco.position)
            startle(amount: percepts.looming * 0.9 * dt * 12, direction: away)
        }
        if percepts.rivalVisible > 0.25 && aggressionRefractory <= 0 {
            // Scaled by timeScale like every other physiological rate. Without it
            // the build-up runs in real time while the decay runs in compressed
            // time, so aggression settles at whatever ratio the two happen to have
            // and never reaches the threshold for a display.
            drives.aggression = saturate(
                drives.aggression + percepts.rivalVisible * 0.55 * dt * cfg.timeScale)
        }

        lastCommandFrequency = cmd.frequency
        updateDrives(loco, dt)
        arbitrate(loco, dt)
        runRoutine(loco, water, dt)
        steer(&cmd, loco, dt)
    }
}
