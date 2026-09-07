import Foundation

/// xoshiro128** — a small, seeded, statistically sound random number generator.
///
/// Why not `SystemRandomNumberGenerator`: the simulation has to be reproducible.
/// A seed must replay a run exactly, so a behaviour seen once can be seen again
/// and so this port and the TypeScript one can be checked against each other.
///
/// Why xoshiro128** specifically, and not PCG32, which would be the more usual
/// choice: PCG32's state update is a 64-bit multiply, and JavaScript cannot do
/// one exactly — its bitwise operators are 32-bit and its numbers lose precision
/// above 2^53. A PCG implementation there would silently produce a *different*
/// stream from this one, which destroys the cross-port reproducibility that is
/// the entire point. xoshiro128** uses nothing but 32-bit shifts, xors and
/// multiplies, so both sides produce bit-identical output. It passes TestU01
/// BigCrush and has a 2^128-1 period.
struct Rng {
    private var s0: UInt32
    private var s1: UInt32
    private var s2: UInt32
    private var s3: UInt32
    private var spare: Double?

    init(seed: UInt32 = 0x2545_f491) {
        // splitmix32: turns one seed integer into a well-mixed 128-bit state.
        var a = seed
        func next() -> UInt32 {
            a = a &+ 0x9e37_79b9
            var t = a
            t = (t ^ (t >> 16)) &* 0x21f0_aaad
            t = (t ^ (t >> 15)) &* 0x735a_2d97
            return t ^ (t >> 15)
        }
        s0 = next()
        s1 = next()
        s2 = next()
        s3 = next()
        // A zero state is a fixed point of the recurrence.
        if (s0 | s1 | s2 | s3) == 0 { s0 = 1 }
        spare = nil
    }

    @inline(__always) private static func rotl(_ x: UInt32, _ k: UInt32) -> UInt32 {
        (x << k) | (x >> (32 - k))
    }

    /// Uniform 32-bit unsigned integer.
    mutating func nextUInt() -> UInt32 {
        let result = Rng.rotl(s1 &* 5, 7) &* 9
        let t = s1 << 9

        s2 ^= s0
        s3 ^= s1
        s1 ^= s2
        s0 ^= s3
        s2 ^= t
        s3 = Rng.rotl(s3, 11)

        return result
    }

    /// Uniform in [0, 1). Uses 24 bits, exactly a float32 mantissa.
    mutating func next() -> Double {
        Double(nextUInt() >> 8) * (1.0 / 16_777_216.0)
    }

    mutating func range(_ lo: Double, _ hi: Double) -> Double {
        lo + (hi - lo) * next()
    }

    /// Uniform in [-a, a].
    mutating func sym(_ a: Double) -> Double {
        (next() * 2 - 1) * a
    }

    mutating func int(lessThan n: Int) -> Int {
        min(n - 1, Int(next() * Double(n)))
    }

    mutating func bool(_ pTrue: Double = 0.5) -> Bool {
        next() < pTrue
    }

    /// Standard normal via Marsaglia polar, with the second value cached.
    mutating func normal(mean: Double = 0, sd: Double = 1) -> Double {
        if let v = spare {
            spare = nil
            return mean + sd * v
        }
        var u = 0.0, v = 0.0, s = 0.0
        repeat {
            u = next() * 2 - 1
            v = next() * 2 - 1
            s = u * u + v * v
        } while s >= 1 || s == 0
        let f = (-2 * log(s) / s).squareRoot()
        spare = v * f
        return mean + sd * u * f
    }

    /// Wrapped Cauchy turn angle on (-pi, pi], concentration rho in [0, 1).
    ///
    /// The standard model for turn angles in animal correlated random walks:
    /// rho = 0 is a uniform turn, rho -> 1 is near-straight travel. Foraging fish
    /// sit around 0.6 to 0.8.
    ///
    /// A Gaussian turn angle is the common shortcut and it is wrong in the tails —
    /// it under-produces the occasional sharp reorientation that makes a search
    /// path read as an animal's rather than a drunkard's.
    mutating func wrappedCauchy(_ rho: Double) -> Double {
        if rho < 1e-6 { return (next() * 2 - 1) * .pi }
        if rho > 0.9999 { return 0 }
        let u = next()
        let num = (1 - rho) * tan(.pi * (u - 0.5))
        let den = 1 + rho
        return 2 * atan2(num, den)
    }

    /// Unit vector uniform on the sphere.
    mutating func onSphere() -> Vec3 {
        let z = next() * 2 - 1
        let t = next() * 2 * .pi
        let r = max(0, 1 - z * z).squareRoot()
        return v3(r * cos(t), r * sin(t), z)
    }
}
