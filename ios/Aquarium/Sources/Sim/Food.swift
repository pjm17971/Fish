import Foundation
import simd

/// Food pellets.
///
/// Betta pellets float, then slowly waterlog and sink. Both phases matter,
/// because the fish feeds at the surface first and then has to hunt whatever it
/// missed on the way down — which is why a feed is a sequence of events rather
/// than one.
///
/// A double tap drops pellets at the point where the tap ray meets the water. If
/// the ray misses the water — you tapped the sand, or the glass above the
/// waterline — nothing is dropped. The gesture is the physical act of dropping
/// something into a tank, not a button that spawns food.
final class Pellet {
    var position = Vec3.zero
    var velocity = Vec3.zero
    var radius: Double = Food.radius
    /// Current density, which rises as the pellet takes up water.
    var density: Double = Food.densityDry
    /// Seconds since it hit the water. Drives waterlogging and scent spread.
    var age: Double = 0
    var alive = false
    /// True while riding the surface rather than sinking through it.
    var floating = true
    /// How hard it hit, for the lateral line. Decays.
    var impactEnergy: Double = 0
    /// How much is left of it, 0 to 1. Uneaten food breaks down.
    var integrity: Double = 1
    /// Water velocity imposed from outside — the inflow of a suction strike.
    /// Cleared every step.
    ///
    /// The pellet responds to it through drag, exactly as it responds to the
    /// tank's own flow, rather than having its velocity or position overridden.
    /// That matters: the pellet is buoyant while it is still dry, so simply
    /// detaching it from the surface and pulling it down makes it shoot straight
    /// back up — which looks like the fish blowing its food away every time it
    /// tries to eat.
    ///
    /// Working through drag also makes the outcome a real contest: a 0.1 m/s
    /// inflow produces about 6.6 microNewtons of drag on a 0.7 mm pellet against
    /// 5.0 microNewtons of buoyancy, so the suction wins, but not by much.
    var externalFlow = Vec3.zero

    var mass: Double { density * (4.0 / 3.0) * Double.pi * radius * radius * radius }
}

final class FoodSystem {
    private(set) var pellets: [Pellet] = []
    private var rng: Rng
    /// Pellets waiting to be released, so a drop is a burst rather than a clump.
    private var pending: [(at: Double, x: Double, z: Double)] = []
    private var time: Double = 0

    init(seed: UInt32) {
        rng = Rng(seed: seed ^ 0x005f_3a1c)
        for _ in 0..<Food.maxPellets { pellets.append(Pellet()) }
    }

    var activeCount: Int { pellets.reduce(0) { $0 + ($1.alive ? 1 : 0) } }

    /// Drop food at a point on the water surface.
    ///
    /// Returns false if the point is outside the water, in which case nothing is
    /// dropped — tapping the sand should not conjure food out of the air.
    @discardableResult
    func drop(x: Double, z: Double) -> Bool {
        if x < Tank.minX || x > Tank.maxX || z < Tank.minZ || z > Tank.maxZ { return false }
        for i in 0..<Food.pelletsPerDrop {
            pending.append((
                at: time + Double(i) * Food.dropIntervalS,
                x: x + rng.sym(Food.dropScatter),
                z: z + rng.sym(Food.dropScatter)
            ))
        }
        return true
    }

    private func spawn(x: Double, z: Double, water: WaterSurface) {
        guard let p = pellets.first(where: { !$0.alive }) else { return }
        let surfaceY = water.height(atX: x, z: z)
        p.position = v3(x, surfaceY + 0.002, z)
        // Dropped from just above the surface, so it arrives with a small impact.
        p.velocity = v3(0, -0.15, 0)
        p.radius = Food.radius * (1 + rng.sym(Food.radiusJitter))
        p.density = Food.densityDry
        p.age = 0
        p.alive = true
        p.floating = true
        p.integrity = 1
        p.impactEnergy = 1
        p.externalFlow = .zero
        water.disturb(x: x, z: z, strength: -0.15 * Water.pelletImpactGain * 30,
                      radius: Water.pelletImpactRadius)
    }

    func step(water: WaterSurface, flow: BulkFlow, dt: Double) {
        time += dt

        while let first = pending.first, first.at <= time {
            pending.removeFirst()
            spawn(x: first.x, z: first.z, water: water)
        }

        for p in pellets where p.alive {
            p.age += dt
            p.impactEnergy = max(0, p.impactEnergy - dt * 2)

            // Waterlogging. A dry pellet floats; a soaked one sinks. The crossover
            // is what turns one feeding into two separate events.
            let soak = 1 - exp(-p.age / Food.soakTau)
            p.density = Food.densityDry + (Food.densitySaturated - Food.densityDry) * soak

            // Break down slowly if nothing eats it.
            p.integrity = max(0, 1 - p.age / Food.decayTime)
            if p.integrity <= 0 {
                p.alive = false
                continue
            }

            let volume = (4.0 / 3.0) * Double.pi * p.radius * p.radius * p.radius
            let mass = p.density * volume
            let surfaceY = water.height(atX: p.position.x, z: p.position.z)

            // Whatever the fish's mouth is doing to the water here, on top of the
            // tank's own circulation.
            let ambient = flow.sample(p.position) + p.externalFlow
            let suction = lengthSafe(p.externalFlow)
            let rel = p.velocity - ambient
            let speed = lengthSafe(rel)

            // Drag on a sphere, Schiller-Naumann.
            //
            // At the terminal sink speed the Reynolds number is about 60, which is
            // squarely where neither Stokes' law nor the constant-0.44 sphere
            // figure is right: Stokes is out by a factor of three there, and 0.44
            // is out the other way. Schiller-Naumann covers the whole range a
            // pellet passes through as it accelerates.
            let Re = max(1e-3, (2 * p.radius * speed) / NU_WATER)
            let Cd = Re < 1000 ? (24 / Re) * (1 + 0.15 * pow(Re, 0.687)) : 0.44
            let area = Double.pi * p.radius * p.radius
            let dragMag = 0.5 * RHO_WATER * Cd * area * speed * speed
            let drag = speed > 1e-9 ? rel * (-dragMag / speed) : Vec3.zero

            let netWeight = (mass - RHO_WATER * volume) * GRAVITY
            let accel = v3(drag.x, drag.y - netWeight, drag.z)

            if p.floating && p.density >= RHO_WATER { p.floating = false }
            // A pellet being drawn into a mouth is no longer riding the surface:
            // the contact line has broken. It is still buoyant, though, so if the
            // suction stops it bobs straight back up.
            if p.floating && suction > 0.012 { p.floating = false }

            if p.floating {
                // A floating pellet is *pinned* to the surface, not springily
                // attached to it.
                //
                // Surface tension at this scale is overwhelming: the contact line
                // round a 0.7 mm pellet pulls with about 3e-4 N while the pellet
                // weighs 9e-9 N — thirty-five thousand times less. Modelling that
                // as a spring gives a natural frequency in the tens of kilohertz,
                // which no sane timestep can integrate; softening it until it is
                // integrable gives a pellet that bobs a centimetre and a half on
                // landing, which is absurd for something under a millimetre
                // across. The honest reading of those numbers is that the pellet
                // simply sits on the surface and goes where the surface goes.
                let target = surfaceY + p.radius * 0.35
                p.velocity.y = (target - p.position.y) / max(1e-4, dt)
                p.position.y = target
                // Horizontal motion still comes from drag against the flow.
                p.velocity.x += (drag.x / mass) * dt
                p.velocity.z += (drag.z / mass) * dt
                p.position.x += p.velocity.x * dt
                p.position.z += p.velocity.z * dt
            } else {
                p.velocity += accel * (dt / mass)
                p.position += p.velocity * dt
            }

            // The tank.
            if p.position.y < Tank.floorY + p.radius {
                p.position.y = Tank.floorY + p.radius
                // Sand is soft: almost no bounce, and the pellet stops.
                p.velocity.y = max(0, p.velocity.y * -0.05)
                p.velocity.x *= 0.4
                p.velocity.z *= 0.4
            }
            p.position.x = clampd(p.position.x, Tank.minX + p.radius, Tank.maxX - p.radius)
            p.position.z = clampd(p.position.z, Tank.minZ + p.radius, Tank.maxZ - p.radius)

            // Re-attach to the surface if it drifts back up and nothing is pulling.
            if !p.floating && suction < 0.012 && p.density < RHO_WATER
                && p.position.y > surfaceY - p.radius
            {
                p.floating = true
            }
            p.externalFlow = .zero

            // Crossing the surface on the way down makes a real ripple.
            if !p.floating && p.position.y > surfaceY && p.velocity.y < 0 {
                water.disturb(x: p.position.x, z: p.position.z,
                              strength: p.velocity.y * Water.pelletImpactGain * 30,
                              radius: Water.pelletImpactRadius)
            }
        }
    }

    /// Remove a pellet because the fish ate it.
    func consume(_ p: Pellet, water: WaterSurface) {
        p.alive = false
        // Even a small mouth closing at the surface makes a visible dimple.
        if p.position.y > Tank.waterY - 0.01 {
            water.disturb(x: p.position.x, z: p.position.z, strength: -0.02,
                          radius: Water.pelletImpactRadius * 1.5)
        }
    }

    func reset() {
        for p in pellets { p.alive = false }
        pending.removeAll()
    }
}

/// Terminal sink speed of a fully waterlogged pellet, solved from the force
/// balance rather than measured from a run.
func analyticTerminalSinkSpeed(radius: Double = Food.radius) -> Double {
    let volume = (4.0 / 3.0) * Double.pi * radius * radius * radius
    let area = Double.pi * radius * radius
    let netWeight = (Food.densitySaturated - RHO_WATER) * volume * GRAVITY
    // Iterate: Cd depends on speed through the Reynolds number, and speed depends
    // on Cd. It converges in a handful of passes.
    var v = 0.05
    for _ in 0..<60 {
        let Re = max(1e-3, (2 * radius * v) / NU_WATER)
        let Cd = Re < 1000 ? (24 / Re) * (1 + 0.15 * pow(Re, 0.687)) : 0.44
        v = ((2 * netWeight) / (RHO_WATER * Cd * area)).squareRoot()
    }
    return v
}
