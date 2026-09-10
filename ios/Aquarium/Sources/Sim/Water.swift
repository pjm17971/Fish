import Foundation
import simd

/// The water: a height field for the surface, and an analytic divergence-free
/// field for bulk flow.
///
/// The surface is a damped wave equation solved explicitly on a grid. The wave
/// speed is not a tuning knob — it is sqrt(g * depth), the shallow-water result —
/// which is what makes the tank slosh with the period a tank of this size really
/// has.
final class WaterSurface {
    let nx: Int
    let nz: Int
    let dx: Double
    let dz: Double

    /// Surface displacement from the still level, in metres.
    private(set) var height: [Float]
    /// Rate of change of displacement.
    private var vel: [Float]
    /// Forcing accumulated during a frame, applied at the next substep.
    private var force: [Float]
    /// Scratch for the Laplacian of the velocity field.
    private var lapV: [Float]
    /// Surface normals, packed xyz per cell.
    private(set) var normals: [Float]

    private var accumulator: Double = 0
    private(set) var time: Double = 0

    /// Linear acceleration of the tank in world space, gravity already removed.
    private var accelX: Double = 0
    private var accelZ: Double = 0
    /// Simulated time advanced per substep, for the continuous outlet forcing.
    private var substepTime: Double = 0
    /// Cells under the filter outlet, with their Gaussian weights.
    private var outletCells: [Int] = []
    private var outletWeights: [Float] = []

    /// Whether the filter outlet runs. On in the tank; off for checks against
    /// the analytic wave equation.
    private let outlet: Bool

    init(nx: Int = Water.nx, nz: Int = Water.nz, outlet: Bool = true) throws {
        self.outlet = outlet
        self.nx = nx
        self.nz = nz
        self.dx = Tank.width / Double(nx - 1)
        self.dz = Tank.depth / Double(nz - 1)
        let n = nx * nz
        self.height = [Float](repeating: 0, count: n)
        self.vel = [Float](repeating: 0, count: n)
        self.force = [Float](repeating: 0, count: n)
        self.lapV = [Float](repeating: 0, count: n)
        self.normals = [Float](repeating: 0, count: n * 3)
        rebuildNormals()

        // The filter outlet's footprint on the grid, computed once.
        let r = Water.outletRadius
        for j in 0..<nz {
            let wz = worldZ(j) - Water.vortexCentreZ
            for i in 0..<nx {
                let wx = worldX(i) - Water.vortexCentreX
                let d2 = wx * wx + wz * wz
                if d2 > r * r { continue }
                outletCells.append(index(i, j))
                outletWeights.append(Float(exp(-3 * (d2 / (r * r)))))
            }
        }

        // Two explicit-stability conditions have to hold, and checking only the
        // obvious one is a trap: the surface then behaves perfectly well in gentle
        // conditions and goes to NaN the moment it is shaken hard.
        //
        // Both are stated in terms of the largest eigenvalue of the discrete
        // Laplacian, which for the five-point stencil is 4/dx^2 + 4/dz^2 — the
        // shortest wavelength the grid can hold.
        let c = Water.waveSpeed
        let invDx2 = 1 / (dx * dx)
        let invDz2 = 1 / (dz * dz)
        let lambdaMax = 4 * (invDx2 + invDz2)

        // 1. The wave term: the CFL condition.
        let courant = c * Water.dt * (invDx2 + invDz2).squareRoot()
        if courant > 0.9 {
            throw SimulationError.unstableWater(
                "Water timestep \(Water.dt)s violates the CFL condition (Courant number "
                    + "\(String(format: "%.3f", courant)), must stay below 1) for a \(nx)x\(nz) grid "
                    + "at c=\(String(format: "%.3f", c)) m/s. Lower Water.dt or coarsen the grid."
            )
        }

        // 2. The damping terms, which share the velocity update with the wave
        //    term. Writing the scheme as a two-by-two amplification matrix per
        //    Fourier mode gives a determinant of exactly (1 - b), where
        //    b = dt*(alpha*c*lambda + beta). Once b passes 1 the velocity damping
        //    overshoots — it reverses the velocity and makes it larger — and the
        //    shortest wavelength on the grid grows by about 19% per step. That is
        //    not a subtle drift; it reaches infinity in under a second.
        let b = Water.dt * (Water.alpha * c * lambdaMax + Water.beta)
        if b > 0.8 {
            throw SimulationError.unstableWater(
                "Water damping is unstable: dt*(alpha*c*lambda_max + beta) = "
                    + "\(String(format: "%.3f", b)), which must stay well below 1. "
                    + "Lower Water.alpha, Water.beta or Water.dt."
            )
        }
    }

    @inline(__always) func index(_ ix: Int, _ iz: Int) -> Int { iz * nx + ix }

    @inline(__always) func worldX(_ ix: Int) -> Double { Tank.minX + Double(ix) * dx }
    @inline(__always) func worldZ(_ iz: Int) -> Double { Tank.minZ + Double(iz) * dz }

    /// Surface height in world y at a point, bilinearly interpolated.
    func height(atX x: Double, z: Double) -> Double {
        let fx = clampd((x - Tank.minX) / dx, 0, Double(nx) - 1.001)
        let fz = clampd((z - Tank.minZ) / dz, 0, Double(nz) - 1.001)
        let ix = Int(fx)
        let iz = Int(fz)
        let tx = fx - Double(ix)
        let tz = fz - Double(iz)
        let i00 = index(ix, iz)
        let a = Double(height[i00]) + (Double(height[i00 + 1]) - Double(height[i00])) * tx
        let i01 = i00 + nx
        let b = Double(height[i01]) + (Double(height[i01 + 1]) - Double(height[i01])) * tx
        return Tank.waterY + a + (b - a) * tz
    }

    /// Surface normal at a point, from the interpolated gradient.
    func normal(atX x: Double, z: Double) -> Vec3 {
        let e = max(dx, dz)
        let hL = height(atX: x - e, z: z)
        let hR = height(atX: x + e, z: z)
        let hD = height(atX: x, z: z - e)
        let hU = height(atX: x, z: z + e)
        let gx = -(hR - hL) / (2 * e)
        let gz = -(hU - hD) / (2 * e)
        let inv = 1 / (gx * gx + 1 + gz * gz).squareRoot()
        return v3(gx * inv, inv, gz * inv)
    }

    /// Tell the water how the tank itself is accelerating.
    ///
    /// On the phone this is the device's linear acceleration with gravity
    /// removed, rotated into tank coordinates. It is what makes the water slosh
    /// when you move, and it is the difference between a tank that is in the room
    /// and a picture of one.
    func setTankAcceleration(x: Double, z: Double) {
        accelX = x
        accelZ = z
    }

    /// Add an impulse to the surface velocity — a pellet landing, a fish breaking
    /// the surface. `strength` is in metres per second of surface velocity.
    func disturb(x: Double, z: Double, strength: Double, radius: Double) {
        let r2 = radius * radius
        let ixC = (x - Tank.minX) / dx
        let izC = (z - Tank.minZ) / dz
        let rx = Int((radius / dx).rounded(.up))
        let rz = Int((radius / dz).rounded(.up))
        let i0 = max(0, Int(ixC) - rx)
        let i1 = min(nx - 1, Int(ixC) + rx)
        let j0 = max(0, Int(izC) - rz)
        let j1 = min(nz - 1, Int(izC) + rz)
        guard i0 <= i1 && j0 <= j1 else { return }
        for j in j0...j1 {
            let wz = worldZ(j) - z
            for i in i0...i1 {
                let wx = worldX(i) - x
                let d2 = wx * wx + wz * wz
                if d2 > r2 { continue }
                // Gaussian falloff rather than a hard disc: a hard-edged impulse
                // rings at the grid frequency and looks like a pixel artefact,
                // not a splash.
                let w = exp(-3 * (d2 / r2))
                force[index(i, j)] += Float(strength * w)
            }
        }
    }

    /// Advance the surface. Accumulates real time and runs fixed substeps, so the
    /// water behaves identically at 30, 60 and 120 fps.
    func step(dt: Double) {
        accumulator += dt
        time += dt
        var steps = 0
        while accumulator >= Water.dt && steps < Water.maxSubsteps {
            // Disturbances are impulses, applied on the first substep of the
            // frame only. If no substep runs this frame the forcing is kept and
            // applied next time rather than thrown away — losing a pellet's
            // splash because the frame was quick would be a real bug.
            substep(dt: Water.dt, applyForcing: steps == 0)
            accumulator -= Water.dt
            steps += 1
        }
        if steps == Water.maxSubsteps {
            // We fell behind. Drop the backlog rather than spiral: catching up on
            // a long gap is what turns a hitch into an explosion.
            accumulator = 0
        }
        if steps > 0 {
            for i in 0..<force.count { force[i] = 0 }
            rebuildNormals()
        }
    }

    private func substep(dt: Double, applyForcing: Bool) {
        substepTime += dt

        // The filter outlet. A continuous source, applied every substep rather
        // than as a per-frame impulse so the ripple height does not depend on
        // the frame rate. Two slow modulations keep it from being a pure tone.
        if outlet {
            let t = substepTime
            let flutter = 0.7 + 0.3 * sin(2 * Double.pi * 0.23 * t + 1.0)
            let hz = Water.outletRippleHz * (1 + 0.08 * sin(2 * Double.pi * 0.11 * t))
            let a = Float(Water.outletRippleAccel * flutter * sin(2 * Double.pi * hz * t) * dt)
            for n in 0..<outletCells.count {
                vel[outletCells[n]] += a * outletWeights[n]
            }
        }

        let c2 = Float(Water.waveSpeed * Water.waveSpeed)
        let invDx2 = Float(1 / (dx * dx))
        let invDz2 = Float(1 / (dz * dz))
        let alphaC = Float(Water.alpha * Water.waveSpeed)
        let beta = Float(Water.beta)
        let slosh = Float(Water.sloshStiffness)
        let invG = 1 / GRAVITY
        let fdt = Float(dt)

        height.withUnsafeMutableBufferPointer { h in
            vel.withUnsafeMutableBufferPointer { v in
                force.withUnsafeBufferPointer { f in
                    lapV.withUnsafeMutableBufferPointer { lv in
                        // Laplacian of the velocity field, into its own buffer
                        // first because the velocity update reads neighbours.
                        for j in 0..<nz {
                            for i in 0..<nx {
                                let k = j * nx + i
                                // Neumann (reflecting) boundaries: mirror the edge
                                // cell. That is what makes water pile up against a
                                // wall when the tank is tilted, instead of leaking
                                // out of the domain.
                                let l = v[i > 0 ? k - 1 : k]
                                let r = v[i < nx - 1 ? k + 1 : k]
                                let d = v[j > 0 ? k - nx : k]
                                let u = v[j < nz - 1 ? k + nx : k]
                                lv[k] = (l + r - 2 * v[k]) * invDx2 + (d + u - 2 * v[k]) * invDz2
                            }
                        }

                        for j in 0..<nz {
                            let wz = Tank.minZ + Double(j) * dz
                            for i in 0..<nx {
                                let k = j * nx + i
                                let wx = Tank.minX + Double(i) * dx

                                let l = h[i > 0 ? k - 1 : k]
                                let r = h[i < nx - 1 ? k + 1 : k]
                                let d = h[j > 0 ? k - nx : k]
                                let u = h[j < nz - 1 ? k + nx : k]
                                let lapH = (l + r - 2 * h[k]) * invDx2 + (d + u - 2 * h[k]) * invDz2

                                // Sloshing. Accelerating the tank tilts the
                                // effective gravity; the equilibrium surface is
                                // the plane perpendicular to it, which to first
                                // order is this. We push the surface towards it
                                // rather than snapping, and the lag and overshoot
                                // that produces is what reads as liquid.
                                let uEq = Float(-(accelX * wx + accelZ * wz) * invG)

                                var accel = c2 * lapH + alphaC * lv[k] - beta * v[k]
                                    + slosh * (uEq - h[k])
                                if applyForcing { accel += f[k] }
                                v[k] += accel * fdt
                            }
                        }

                        for k in 0..<h.count { h[k] += v[k] * fdt }
                    }
                }
            }
        }
    }

    private func rebuildNormals() {
        let sx = Float(1 / (2 * dx))
        let sz = Float(1 / (2 * dz))
        for j in 0..<nz {
            for i in 0..<nx {
                let k = j * nx + i
                let l = height[i > 0 ? k - 1 : k]
                let r = height[i < nx - 1 ? k + 1 : k]
                let d = height[j > 0 ? k - nx : k]
                let u = height[j < nz - 1 ? k + nx : k]
                let gx = -(r - l) * sx
                let gz = -(u - d) * sz
                let inv = 1 / (gx * gx + 1 + gz * gz).squareRoot()
                normals[k * 3] = gx * inv
                normals[k * 3 + 1] = inv
                normals[k * 3 + 2] = gz * inv
            }
        }
    }
}

enum SimulationError: Error {
    case unstableWater(String)
}

/// Bulk water motion.
///
/// A full 3D fluid solve does not fit in a phone's frame budget alongside
/// everything else, so this is an analytic field instead — but a
/// *divergence-free* one, which is the property that actually matters. Flow with
/// divergence makes suspended particles bunch up and thin out, and the eye reads
/// that as wrong immediately even when it cannot say why. Taking the curl of a
/// potential guarantees div(v) = 0 exactly, for free.
///
/// ## Why it is cached on a grid
///
/// Evaluating this directly is not cheap: the curl needs six finite differences
/// of a two-octave noise, so one sample costs twenty-four noise evaluations. It
/// is asked for once per fin node per substep — around eighteen hundred samples a
/// frame, or a third of a million hash evaluations, which measured at over half
/// the entire frame budget.
///
/// The field varies over centimetres and changes over seconds, so sampling it on
/// a coarse grid once a frame and interpolating loses nothing visible. Trilinear
/// interpolation of a divergence-free field is not exactly divergence-free, but
/// the error is second order in the cell size and far below anything that shows.
final class BulkFlow {
    private static let NX = 14
    private static let NY = 9
    private static let NZ = 11

    private var cache: [Float]
    private var cacheTime: Double = -1
    private var t: Double = 0
    private let seed: Int32

    init(seed: Int32 = 0x1234) {
        self.seed = seed
        self.cache = [Float](repeating: 0, count: BulkFlow.NX * BulkFlow.NY * BulkFlow.NZ * 3)
        rebuild()
    }

    func step(dt: Double) {
        t += dt
        // The field's own time scale is 0.15 Hz, so refreshing at 20 Hz is far
        // more often than anything in it can change.
        if t - cacheTime > 0.05 { rebuild() }
    }

    private func rebuild() {
        var o = 0
        for k in 0..<BulkFlow.NZ {
            let z = Tank.minZ + (Double(k) / Double(BulkFlow.NZ - 1)) * Tank.depth
            for j in 0..<BulkFlow.NY {
                let y = Tank.floorY + (Double(j) / Double(BulkFlow.NY - 1)) * (Tank.waterY - Tank.floorY)
                for i in 0..<BulkFlow.NX {
                    let x = Tank.minX + (Double(i) / Double(BulkFlow.NX - 1)) * Tank.width
                    let v = evaluate(v3(x, y, z))
                    cache[o] = Float(v.x); o += 1
                    cache[o] = Float(v.y); o += 1
                    cache[o] = Float(v.z); o += 1
                }
            }
        }
        cacheTime = t
    }

    /// Water velocity at a point, in m/s. Trilinearly interpolated from the cache.
    func sample(_ p: Vec3) -> Vec3 {
        let NX = BulkFlow.NX, NY = BulkFlow.NY, NZ = BulkFlow.NZ
        let fx = clampd((p.x - Tank.minX) / Tank.width * Double(NX - 1), 0, Double(NX) - 1.001)
        let fy = clampd((p.y - Tank.floorY) / max(1e-4, Tank.waterY - Tank.floorY) * Double(NY - 1),
                        0, Double(NY) - 1.001)
        let fz = clampd((p.z - Tank.minZ) / Tank.depth * Double(NZ - 1), 0, Double(NZ) - 1.001)

        let ix = Int(fx), iy = Int(fy), iz = Int(fz)
        let tx = fx - Double(ix), ty = fy - Double(iy), tz = fz - Double(iz)

        @inline(__always) func at(_ i: Int, _ j: Int, _ k: Int, _ c: Int) -> Double {
            Double(cache[((k * NY + j) * NX + i) * 3 + c])
        }

        var out = Vec3.zero
        for c in 0..<3 {
            let c000 = at(ix, iy, iz, c), c100 = at(ix + 1, iy, iz, c)
            let c010 = at(ix, iy + 1, iz, c), c110 = at(ix + 1, iy + 1, iz, c)
            let c001 = at(ix, iy, iz + 1, c), c101 = at(ix + 1, iy, iz + 1, c)
            let c011 = at(ix, iy + 1, iz + 1, c), c111 = at(ix + 1, iy + 1, iz + 1, c)
            let x00 = c000 + (c100 - c000) * tx
            let x10 = c010 + (c110 - c010) * tx
            let x01 = c001 + (c101 - c001) * tx
            let x11 = c011 + (c111 - c011) * tx
            let a = x00 + (x10 - x00) * ty
            let b = x01 + (x11 - x01) * ty
            let value = a + (b - a) * tz
            if c == 0 { out.x = value } else if c == 1 { out.y = value } else { out.z = value }
        }
        return out
    }

    /// The analytic field, evaluated directly. Fills the cache; also used by tests.
    func evaluate(_ p: Vec3) -> Vec3 {
        // --- Rankine vortex about a vertical axis at the filter outlet ---
        let dx = p.x - Water.vortexCentreX
        let dz = p.z - Water.vortexCentreZ
        let r = (dx * dx + dz * dz).squareRoot()
        var vt: Double
        if r < 1e-5 {
            vt = 0
        } else if r < Water.vortexCoreRadius {
            // Solid-body rotation inside the core: speed grows with radius.
            vt = Water.vortexPeakSpeed * (r / Water.vortexCoreRadius)
        } else {
            // Free vortex outside: speed falls as 1/r, so circulation is conserved.
            vt = (Water.vortexPeakSpeed * Water.vortexCoreRadius) / r
        }

        // Purely horizontal circulation.
        //
        // The tempting thing is to add a vertical component so the roll "actually
        // circulates" rather than spinning in a plane. It cannot be done this way:
        // a vertical velocity that varies with height has a non-zero divergence,
        // and the whole reason for building the flow analytically was to guarantee
        // it has none. Vertical motion comes from the curl noise below, free.
        let inv = r > 1e-5 ? 1 / r : 0
        // Depth falloff depends only on y, so horizontal divergence stays zero.
        let depthFactor = clampd((p.y - Tank.floorY) / max(1e-4, Tank.waterDepth), 0, 1)
        let df = 0.35 + 0.65 * depthFactor
        var vx = -dz * inv * vt * df
        var vy: Double = 0
        var vz = dx * inv * vt * df

        // --- Curl noise ---
        let s = 1 / Water.curlScale
        let tt = t * Water.curlTimeHz
        // The finite-difference step has to be small compared with the noise's own
        // length scale, or the result is the curl of a heavily smoothed potential
        // and no longer divergence-free at the scale things are advected at.
        let e = 0.02 * Water.curlScale

        @inline(__always) func psi(_ px: Double, _ py: Double, _ pz: Double, _ comp: Int32) -> Double {
            fbm3(px * s, py * s + tt, pz * s, seed &+ comp &* 7919)
        }

        let dpsiZ_dy = (psi(p.x, p.y + e, p.z, 2) - psi(p.x, p.y - e, p.z, 2)) / (2 * e)
        let dpsiY_dz = (psi(p.x, p.y, p.z + e, 1) - psi(p.x, p.y, p.z - e, 1)) / (2 * e)
        let dpsiX_dz = (psi(p.x, p.y, p.z + e, 0) - psi(p.x, p.y, p.z - e, 0)) / (2 * e)
        let dpsiZ_dx = (psi(p.x + e, p.y, p.z, 2) - psi(p.x - e, p.y, p.z, 2)) / (2 * e)
        let dpsiY_dx = (psi(p.x + e, p.y, p.z, 1) - psi(p.x - e, p.y, p.z, 1)) / (2 * e)
        let dpsiX_dy = (psi(p.x, p.y + e, p.z, 0) - psi(p.x, p.y - e, p.z, 0)) / (2 * e)

        let a = Water.curlAmplitude * Water.curlScale
        vx += a * (dpsiZ_dy - dpsiY_dz)
        vy += a * (dpsiX_dz - dpsiZ_dx)
        vz += a * (dpsiY_dx - dpsiX_dy)

        return v3(vx, vy, vz)
    }
}
