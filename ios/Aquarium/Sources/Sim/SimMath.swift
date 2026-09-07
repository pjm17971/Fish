import Foundation
import simd

/// Small maths helpers shared by the simulation.
///
/// The simulation works in `Double`. That is deliberate rather than cautious:
/// the fish is 48 mm long, the physics substep is 4 ms, and several quantities —
/// the body's deformation velocity, the added-mass time derivative — are
/// differences of nearly equal numbers. In `Float` those differences lose most
/// of their significant digits, and the noise that leaves behind is
/// indistinguishable from a real force. Rendering converts to `Float` at the
/// boundary, where it costs nothing.

typealias Vec3 = SIMD3<Double>
typealias Quat = simd_quatd

@inline(__always) func v3(_ x: Double = 0, _ y: Double = 0, _ z: Double = 0) -> Vec3 {
    Vec3(x, y, z)
}

@inline(__always) func clampd(_ x: Double, _ lo: Double, _ hi: Double) -> Double {
    x < lo ? lo : (x > hi ? hi : x)
}

@inline(__always) func saturate(_ x: Double) -> Double { clampd(x, 0, 1) }

@inline(__always) func lerp(_ a: Double, _ b: Double, _ t: Double) -> Double {
    a + (b - a) * t
}

@inline(__always) func smoothstep(_ edge0: Double, _ edge1: Double, _ x: Double) -> Double {
    if edge0 == edge1 { return x < edge0 ? 0 : 1 }
    let t = saturate((x - edge0) / (edge1 - edge0))
    return t * t * (3 - 2 * t)
}

/// Wrap an angle into (-pi, pi].
@inline(__always) func wrapAngle(_ a: Double) -> Double {
    var x = (a + .pi).truncatingRemainder(dividingBy: 2 * .pi)
    if x < 0 { x += 2 * .pi }
    return x - .pi
}

/// Frame-rate independent exponential approach.
///
/// `x += (target - x) * rate * dt` is the usual form and it is wrong: how far it
/// moves depends on how the frame was chopped up, so a 30 fps and a 120 fps run
/// disagree. This is the exact solution of the same differential equation.
@inline(__always) func expApproach(_ current: Double, _ target: Double, rate: Double, dt: Double) -> Double {
    target + (current - target) * exp(-rate * dt)
}

@inline(__always) func expApproach(_ current: Vec3, _ target: Vec3, rate: Double, dt: Double) -> Vec3 {
    let k = exp(-rate * dt)
    return target + (current - target) * k
}

@inline(__always) func lengthSafe(_ v: Vec3) -> Double {
    let l2 = simd_length_squared(v)
    return l2 > 1e-24 ? sqrt(l2) : 0
}

@inline(__always) func normalizeSafe(_ v: Vec3, fallback: Vec3 = v3(0, 0, 1)) -> Vec3 {
    let l = lengthSafe(v)
    return l > 1e-12 ? v / l : fallback
}

@inline(__always) func clampLength(_ v: Vec3, _ maxLen: Double) -> Vec3 {
    let l = lengthSafe(v)
    return (l <= maxLen || l < 1e-12) ? v : v * (maxLen / l)
}

// MARK: - Quaternions

@inline(__always) func quatIdentity() -> Quat { simd_quatd(ix: 0, iy: 0, iz: 0, r: 1) }

@inline(__always) func rotate(_ q: Quat, _ v: Vec3) -> Vec3 { q.act(v) }

@inline(__always) func rotateInverse(_ q: Quat, _ v: Vec3) -> Vec3 { q.inverse.act(v) }

/// Integrate an orientation by an angular velocity, using the exponential map.
///
/// The cheap first-order form (`q += 0.5 * w * q`) drifts badly when the body
/// spins fast, and a startled fish puts several hundred degrees per second
/// through this during a C-start.
func integrateOrientation(_ q: Quat, angularVelocity w: Vec3, dt: Double) -> Quat {
    let half = w * (dt * 0.5)
    let theta = lengthSafe(half)
    let s: Double
    let c: Double
    if theta < 1e-8 {
        // sin(t)/t tends to 1; expanding avoids a 0/0.
        s = 1 - theta * theta / 6
        c = 1 - theta * theta / 2
    } else {
        s = sin(theta) / theta
        c = cos(theta)
    }
    let dq = simd_quatd(ix: half.x * s, iy: half.y * s, iz: half.z * s, r: c)
    return simd_normalize(dq * q)
}

/// Shortest-arc rotation taking `from` to `to`. Both must be unit vectors.
func quatFromTo(_ from: Vec3, _ to: Vec3) -> Quat {
    let d = simd_dot(from, to)
    if d > 0.999999 { return quatIdentity() }
    if d < -0.999999 {
        // Opposite vectors: any perpendicular axis will do; pick a stable one.
        var axis = v3(1, 0, 0)
        if abs(from.x) > 0.9 { axis = v3(0, 1, 0) }
        let a = normalizeSafe(simd_cross(from, axis))
        return simd_quatd(angle: .pi, axis: a)
    }
    let c = simd_cross(from, to)
    return simd_normalize(simd_quatd(ix: c.x, iy: c.y, iz: c.z, r: 1 + d))
}

// MARK: - Float conversion for rendering

@inline(__always) func f3(_ v: Vec3) -> SIMD3<Float> {
    SIMD3<Float>(Float(v.x), Float(v.y), Float(v.z))
}

@inline(__always) func f4x4(_ m: simd_double4x4) -> simd_float4x4 {
    simd_float4x4(
        SIMD4<Float>(Float(m.columns.0.x), Float(m.columns.0.y), Float(m.columns.0.z), Float(m.columns.0.w)),
        SIMD4<Float>(Float(m.columns.1.x), Float(m.columns.1.y), Float(m.columns.1.z), Float(m.columns.1.w)),
        SIMD4<Float>(Float(m.columns.2.x), Float(m.columns.2.y), Float(m.columns.2.z), Float(m.columns.2.w)),
        SIMD4<Float>(Float(m.columns.3.x), Float(m.columns.3.y), Float(m.columns.3.z), Float(m.columns.3.w))
    )
}

// MARK: - Deterministic noise

/// Deterministic 3D value noise with a quintic fade.
///
/// The fade is quintic rather than the cheaper cubic because the curl of this
/// field is taken to build the water flow: a cubic fade is only C1, so its
/// derivative creases on the cell boundaries and the creases show up as a grid
/// pattern in the drifting particles.
func valueNoise3(_ x: Double, _ y: Double, _ z: Double, _ seed: Int32) -> Double {
    let xi = Int32(x.rounded(.down))
    let yi = Int32(y.rounded(.down))
    let zi = Int32(z.rounded(.down))
    let xf = x - Double(xi)
    let yf = y - Double(yi)
    let zf = z - Double(zi)

    let u = xf * xf * xf * (xf * (xf * 6 - 15) + 10)
    let v = yf * yf * yf * (yf * (yf * 6 - 15) + 10)
    let w = zf * zf * zf * (zf * (zf * 6 - 15) + 10)

    func h(_ ix: Int32, _ iy: Int32, _ iz: Int32) -> Double {
        var n = UInt32(bitPattern: ix &* 0x27d4_eb2d) ^ UInt32(bitPattern: iy &* 0x1656_67b1)
            ^ UInt32(bitPattern: iz &* -0x61c8_864f) ^ UInt32(bitPattern: seed)
        n = (n ^ (n >> 15)) &* 0x85eb_ca6b
        n = (n ^ (n >> 13)) &* 0xc2b2_ae35
        n = n ^ (n >> 16)
        return Double(n) / 4_294_967_295.0 - 0.5
    }

    @inline(__always) func lx(_ a: Double, _ b: Double) -> Double { a + (b - a) * u }
    @inline(__always) func ly(_ a: Double, _ b: Double) -> Double { a + (b - a) * v }
    @inline(__always) func lz(_ a: Double, _ b: Double) -> Double { a + (b - a) * w }

    let c000 = h(xi, yi, zi), c100 = h(xi + 1, yi, zi)
    let c010 = h(xi, yi + 1, zi), c110 = h(xi + 1, yi + 1, zi)
    let c001 = h(xi, yi, zi + 1), c101 = h(xi + 1, yi, zi + 1)
    let c011 = h(xi, yi + 1, zi + 1), c111 = h(xi + 1, yi + 1, zi + 1)

    return lz(
        ly(lx(c000, c100), lx(c010, c110)),
        ly(lx(c001, c101), lx(c011, c111))
    )
}

/// Two octaves of value noise — enough structure for the flow field, still cheap.
func fbm3(_ x: Double, _ y: Double, _ z: Double, _ seed: Int32) -> Double {
    valueNoise3(x, y, z, seed)
        + 0.5 * valueNoise3(x * 2.03, y * 2.03, z * 2.03, seed ^ 0x9e37)
}
