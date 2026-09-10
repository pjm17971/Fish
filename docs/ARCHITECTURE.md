# How the code is put together

Two programs share one simulation.

```
docs/SIMULATION-SPEC.md          the numerical contract both ports implement
                                 (config.ts and SimConfig.swift are the working
                                  record of the constants; this explains them)

preview/                         desktop: TypeScript + WebGL2
  src/sim/                       the simulation
  src/render/                    a preview renderer
  src/test/                      38 tests, run with `npm test`

ios/Aquarium/                    phone: Swift + Metal + ARKit
  Sources/Sim/                   the same simulation, ported
  Sources/AR/                    camera, face tracking, the window projection
  Sources/Render/                the Metal renderer
  Sources/Shaders/               the Metal shaders
  Sources/App/                   the app shell and the double-tap
```

The TypeScript version exists so the physics and the behaviour can be *tested* —
in a fast loop, on a machine, with a test suite — instead of being debugged
through a phone. Both are seeded from the same generator and produce identical
runs from the same seed, which is what makes the desktop version a useful check
on the phone one rather than a separate program that looks similar.

---

## The simulation

Eleven modules, in dependency order. Nothing later in this list is imported by
anything earlier.

| Module | What it owns |
|---|---|
| `math` | vectors, quaternions, matrices; allocation-free in the hot paths |
| `rng` | xoshiro128\*\*, plus the distributions and the noise built on it |
| `config` | every constant, with the argument for it in the comment |
| `morphology` | the fish's shape: cross-sections, mass distribution, inertia |
| `fishBody` | the body's deformation — the travelling wave and the bends |
| `locomotion` | the hydrodynamics, and the rigid-body integration |
| `fins` | fin shape, as trailing sheets |
| `water` | the surface height field, and the bulk flow |
| `food` | pellets: floating, waterlogging, sinking, scent |
| `brain` | perception, drives, intentions, motor goals |
| `world` | the ordering that ties them together |

### Why the order in `world.step` matters

It is the least obvious part of the whole system and the easiest to get subtly
wrong, because getting it wrong does not crash anything — it just makes the fish
feel very slightly late, in a way that is nearly impossible to find afterwards.

```
1. viewer motion        differentiated here, so the host only supplies a position
2. brain                perceive, update drives, choose an intention, emit a goal
3. consequences         eating, gulping air — things the brain decided last step
4. flow / locomotion    the water the fish is in, then the forces, then integrate
   / fins
5. surface coupling     the fish disturbs the water it just moved through
6. food                 pellets, in the flow field that now exists
7. water                the surface integrates, having received all its forcing
8. bubbles
```

The rule behind it: everything is sensed before anything moves, all forces are
gathered before anything integrates, and the water sees the fish's motion from the
step it has just taken rather than the one before.

### Two timesteps, not one

The physics runs at a fixed **4 ms** step and the water surface at a fixed
**2.5 ms** step, both independent of the frame rate. A frame at 60 Hz takes four
physics substeps; at 120 Hz it takes two. Long stalls — a backgrounded app, a
debugger pause — are clamped rather than integrated, because integrating a
two-second stall teleports the fish and detonates the water.

Fixed steps are not a stylistic preference here. The added-mass forces make the
equations stiff, and a variable step turns a stable simulation into one whose
behaviour depends on how busy the phone is.

---

## The renderer

Seven passes, in this order:

1. **Caustics** — refract a grid of light rays through the real water surface;
   brightness is the Jacobian of the refraction map. Rendered to an offscreen
   texture, then blurred.
2. **Camera** — the rear-camera image, which is the room behind the tank, drawn
   as the background. Zero-copy, via `CVMetalTextureCache`.
3. **Scene** — the tank, plants, gravel, the fish, its fins, pellets, bubbles.
4. **Volume** — what the water does to light travelling from those objects to the
   eye: Beer-Lambert absorption plus scattering.
5. **Surface** — the water's top surface, with reflection and refraction.
6. **Glass** — the front pane, which is the phone's own screen.
7. **Post** — tone mapping and camera-matched grain.

**Why the volume pass sits where it does.** It has to come after the scene and
before the surface, because the absorption applies to light travelling from the
object to the eye, and the surface then bends whatever is left. Doing the surface
first and fogging afterwards is the more common arrangement, and it puts the haze
in front of the reflections — which looks like a dirty window rather than deep
water.

Everything before the post pass works in half-float. The water and the thin-film
colours on the fish's flanks both have a much wider range than eight bits can
hold, and banding across a fish's flank is very visible.

---

## The AR layer

`ARSessionController` runs one `ARWorldTrackingConfiguration` with
`userFaceTrackingEnabled`, so the rear camera (the room, and the device's pose)
and the front camera (where your head is) share a single world.

### Coordinate frames, which is where the bodies are buried

Three frames are in play and they are not the same:

- **The camera's frame**, which ARKit reports poses in.
- **CoreMotion's device frame**, which is defined with the phone in *portrait*.
- **The tank's frame**: origin at the centre of the screen, +x to the right as the
  viewer sees it, +y up the screen, +z out through the glass towards them. This is
  the frame the simulation lives in, and the tank is rigidly attached behind the
  phone, so no world transform is ever involved.

Both conversions are **measured at runtime rather than assumed**, and that is
deliberate. ARKit's camera frame and UIKit's landscape orientation names are both
fixed conventions, but they are conventions that are easy to get backwards, and
getting them backwards gives a tank whose parallax runs the wrong way or whose
water sloshes sideways when you nod the phone — symptoms that look like bugs in
the physics rather than in an axis.

- **Camera → tank** comes from ARKit itself: `viewMatrix(for:)` composed with the
  camera's own transform. `viewMatrix` is ARKit's answer to "which way is up on
  screen right now", so the convention never has to be guessed at.
- **CoreMotion → tank** is measured from gravity. Both frames share the screen's
  normal, so they differ only by a rotation about it, and gravity is one physical
  vector that both systems report. Comparing the two gives the angle directly; it
  is snapped to the nearest quarter turn, and held when the phone is too flat for
  the measurement to mean anything.

### Why the device's motion comes from CoreMotion, not from ARKit

ARKit's pose is the output of a filter fusing vision and inertial data, tuned for
*position* accuracy. Differentiating it twice gives an acceleration signal buried
in the filter's own corrections, which reads as the water being kicked at random.
CoreMotion reports the accelerometer's own reading, with gravity already separated
out, at 100 Hz — which is exactly the quantity the sloshing needs.

---

## The app shell

One view controller, no interface. The only control is the one the brief asked
for: a double tap drops food.

A tap is turned into food by casting a ray from the eye through the point of glass
that was touched — the same construction the projection uses — and intersecting it
with the water surface. So the food goes in where you were looking when you
tapped, not where it would have gone if you had been staring straight down the
middle. A tap that misses the water drops nothing, but the fish still hears the
knock through its lateral line.

---

## Testing

`preview/src/test/` holds 38 tests in three files:

- `physics.test.js` — conservation, stability, the water's sloshing period against
  the analytic result, pellet terminal velocity against Schiller-Naumann.
- `locomotion.test.js` — the biological invariants: Strouhal number, stride
  length, speed against tail-beat frequency, coast-down rate.
- `behaviour.test.js` — that decisions have hysteresis, that drives really
  accumulate and discharge, that the drive hierarchy holds under conflict, that a
  run is reproducible from its seed.

Every assertion is against a number derived independently — from the literature or
analytically — and never against the output of a previous run. A test that asserts
"the same as last time" locks in whatever was wrong last time.

The one thing this repository cannot test is the Swift build: there is no Swift
toolchain in the environment it was written in. See the README.
