import Foundation
import simd

/// A bubble released at the surface when the fish takes a breath.
struct Bubble {
    var position = Vec3.zero
    var radius: Double = 0
    var age: Double = 0
    var alive = false
}

/// The world: everything assembled, and the order things happen in.
///
/// Order matters. Perception has to run on the state the fish could actually have
/// sensed, forces have to be gathered before anything integrates, and the water
/// has to see the fish's motion from the step it just took rather than the one
/// before. Getting this wrong does not crash anything; it just makes the fish feel
/// very slightly late, in a way that is almost impossible to find afterwards.
final class World {
    var config: WorldConfig
    let morphology: Morphology
    let body: FishBody
    let locomotion: FishLocomotion
    let fins: [FinCloth]
    let water: WaterSurface
    let flow: BulkFlow
    let food: FoodSystem
    let brain: FishBrain
    private(set) var command = MotorCommand()
    private(set) var bubbles: [Bubble]

    /// Stimuli the host fills in each frame.
    var stimuli = Stimuli()

    /// Seconds of simulated time since the start.
    private(set) var time: Double = 0

    private var hasPrevViewer = false
    private var prevViewer = Vec3.zero
    private var lastTapTime: Double = -.infinity

    init(config: WorldConfig = WorldConfig()) throws {
        self.config = config
        morphology = buildMorphology()
        body = FishBody(morphology: morphology)
        locomotion = FishLocomotion(morphology: morphology, body: body)
        fins = buildFins(morphology: morphology)
        water = try WaterSurface()
        flow = BulkFlow(seed: Int32(bitPattern: config.seed))
        food = FoodSystem(seed: config.seed)
        brain = FishBrain(config: config)
        bubbles = [Bubble](repeating: Bubble(), count: 24)

        // Start the fish somewhere plausible: mid-water, facing across the tank.
        locomotion.position = v3(-0.05, Tank.floorY + 0.045, -Tank.depth * 0.55)
        for f in fins { f.initialise(body: body, loco: locomotion, spread: 0.65) }

        // Let the fin sheets settle from their straight starting pose, so the
        // first frame shows a fish rather than a fish with its fins sticking out
        // like a paper aeroplane.
        for _ in 0..<30 { step(dt: 1.0 / 60.0) }
    }

    /// Tell the world how the tank itself is moving.
    ///
    /// On the phone this is the device's linear acceleration with gravity removed,
    /// rotated into tank coordinates. It is what makes the water slosh when you
    /// move, and it is the difference between a tank that is in the room and a
    /// picture of one.
    func setTankAcceleration(x: Double, z: Double) {
        water.setTankAcceleration(x: x, z: z)
    }

    /// A double tap. `x`/`z` are where the tap ray met the water surface.
    ///
    /// Returns false if the tap missed the water, in which case no food is dropped
    /// but the fish still hears the knock.
    @discardableResult
    func feed(atX x: Double, z: Double) -> Bool {
        let dropped = food.drop(x: x, z: z)
        stimuli.tapPosition = v3(x, Tank.waterY, z)
        stimuli.tapImpulse = 1
        lastTapTime = time
        return dropped
    }

    func step(dt: Double) {
        // Clamp the frame time. A long stall — the app backgrounded, a debugger
        // pause — must not be integrated as though it really happened, or the fish
        // teleports and the water explodes.
        let frameDt = clampd(dt, 0, 0.05)
        time += frameDt

        // 1. Viewer motion, for looming. Differentiated here rather than trusted
        //    from outside, so the host only has to supply a position.
        if let viewer = stimuli.viewerPosition {
            if hasPrevViewer {
                // Approach speed is towards the tank, i.e. along -z from the
                // viewer's side of the glass.
                stimuli.viewerApproachSpeed = -(viewer.z - prevViewer.z) / max(1e-4, frameDt)
            }
            prevViewer = viewer
            hasPrevViewer = true
        } else {
            hasPrevViewer = false
            stimuli.viewerApproachSpeed = 0
        }
        stimuli.tapImpulse = max(0, 1 - (time - lastTapTime) * 3)

        // 2. The brain decides, on the state it could have sensed.
        brain.step(&command, loco: locomotion, body: body, pellets: food.pellets,
                   water: water, stimuli: stimuli, dt: frameDt)

        // 3. Consequences of the brain's decisions that the world owns.
        if let eaten = brain.atePelletThisTick { food.consume(eaten, water: water) }
        if brain.gulpedThisTick { releaseBubble() }

        // 4. Physics. The fish first, so the fins and the water see where it
        //    actually ended up rather than where it was last frame.
        flow.step(dt: frameDt)
        locomotion.step(command, water: water, flow: flow, dt: frameDt)
        for f in fins {
            f.step(body: body, loco: locomotion, flow: flow, spread: command.finSpread, dt: frameDt)
        }

        // 5. The fish disturbs the surface it just moved through.
        coupleFishToSurface()

        // 6. Food, then the water it landed in.
        food.step(water: water, flow: flow, dt: frameDt)
        water.step(dt: frameDt)

        stepBubbles(frameDt)
    }

    /// Any part of the fish near the surface pushes it about.
    ///
    /// This is what makes a surface gulp produce a real ring of ripples: the snout
    /// genuinely crosses the water line, and the disturbance is computed from how
    /// fast it did so, not triggered as an effect when an animation reaches a
    /// certain frame.
    private func coupleFishToSurface() {
        let segs = body.segments
        var i = 0
        while i < segs.count {
            let st = segs[i]
            let worldPos = locomotion.toWorld(st.pos)
            let surfaceY = water.height(atX: worldPos.x, z: worldPos.z)
            let depth = surfaceY - worldPos.y
            if abs(depth) > Water.fishCouplingRange {
                i += 2
                continue
            }

            // Vertical velocity of this piece of the fish.
            let r = worldPos - locomotion.position
            let w = locomotion.angularVelocity
            let vy = locomotion.velocity.y + (w.z * r.x - w.x * r.z)

            // Weight by closeness to the surface and by this slice's frontal area
            // — a fish's head displaces far more than its tail stalk.
            let falloff = exp(-pow(depth / Water.fishCouplingRange, 2) * 3)
            let strength = vy * Water.fishCouplingGain * falloff
                * (morphology.segments[i].lateralArea / 1e-5)
            if abs(strength) > 1e-5 {
                water.disturb(x: worldPos.x, z: worldPos.z,
                              strength: clampd(strength, -0.6, 0.6), radius: 0.012)
            }
            i += 2
        }
    }

    private func releaseBubble() {
        guard let idx = bubbles.firstIndex(where: { !$0.alive }) else { return }
        bubbles[idx].position = locomotion.toWorld(body.snout())
        bubbles[idx].radius = 0.0012
        bubbles[idx].age = 0
        bubbles[idx].alive = true
    }

    private func stepBubbles(_ dt: Double) {
        for i in 0..<bubbles.count where bubbles[i].alive {
            bubbles[i].age += dt
            // A bubble this small rises slowly and almost exactly at its terminal
            // speed: at half a millimetre across it reaches it in milliseconds.
            bubbles[i].position.y += 0.06 * dt
            let surfaceY = water.height(atX: bubbles[i].position.x, z: bubbles[i].position.z)
            if bubbles[i].position.y > surfaceY || bubbles[i].age > 4 {
                bubbles[i].alive = false
                water.disturb(x: bubbles[i].position.x, z: bubbles[i].position.z,
                              strength: -0.01, radius: 0.003)
            }
        }
    }

    /// The fish's speed in body lengths per second.
    var speedSL: Double { locomotion.speedSL }

    /// Where the fish's snout is, in world space.
    func snoutWorld() -> Vec3 { locomotion.toWorld(body.snout()) }

    /// A one-line summary of the fish's internal state, phrased the way a person
    /// would describe an animal.
    func describe() -> String {
        let d = brain.drives
        func pct(_ x: Double) -> String { "\(Int((x * 100).rounded()))%" }
        return "\(brain.intention.rawValue)  hunger \(pct(d.hunger))  air \(pct(d.airDebt))  "
            + "fear \(pct(d.fear))  fatigue \(pct(d.fatigue))  aggression \(pct(d.aggression))  "
            + String(format: "%.2f SL/s  %.1f Hz", speedSL, command.frequency)
    }
}

/// Ray to the water plane, for turning a tap into a drop point.
///
/// The surface is nearly flat, so one intersection with the still plane and one
/// correction against the real height field is plenty — iterating further moves
/// the answer by less than a pellet's width.
func rayToWaterSurface(origin: Vec3, direction: Vec3, water: WaterSurface) -> Vec3? {
    if abs(direction.y) < 1e-5 { return nil }
    var t = (Tank.waterY - origin.y) / direction.y
    if t <= 0 { return nil }
    var hit = origin + direction * t

    let h = water.height(atX: hit.x, z: hit.z)
    t = (h - origin.y) / direction.y
    if t <= 0 { return nil }
    hit = origin + direction * t
    return hit
}
