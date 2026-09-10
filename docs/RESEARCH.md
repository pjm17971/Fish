# What this is built on

The brief was "don't fake it" and "research the most cutting edge techniques".
This document is the survey those two sentences produced: what the options were
for each part of the problem, which one was chosen, and why. Where something was
tried and abandoned, that is recorded too, because a technique that does not work
here is worth as much to know about as one that does.

Nothing below is cited for decoration. Every method listed as *used* is
implemented in this repository, and the sections of `SIMULATION-SPEC.md` that
give the actual numbers are named alongside.

---

## 1. Making the phone look like a window

### The problem

A phone that shows a three-dimensional scene is not a window. Tilt an ordinary 3D
app and the scene rotates with the device, because the virtual camera is bolted to
the phone. Tilt a real window and the view stays exactly where it is; what changes
is how much of it you can see round each edge of the frame. The difference is
instantly legible to anyone, and it is the single thing that decides whether the
tank reads as being *behind* the glass.

### What was considered

- **A symmetric frustum rotated with the device.** What almost every "3D effect"
  app does. It is wrong for the reason above, and no amount of polish elsewhere
  recovers from it.
- **Kooima's generalised perspective projection** (Robert Kooima, *Generalized
  Perspective Projection*, 2009). Given the eye's position and the three corners
  that define a screen rectangle, it constructs the asymmetric frustum that
  exactly fills that rectangle. This is the standard construction behind CAVE
  systems and every serious fish-tank-VR display.
- **Head-coupled perspective from the front camera.** Johnny Chung Lee's Wii
  remote head tracking (2007) is the well-known demonstration; the underlying idea
  goes back to Fisher's and Deering's work on fish-tank VR in the late 1980s and
  early 1990s.

### What is used

Kooima's projection, with the eye position coming from ARKit face tracking when a
face is visible and from the device's tilt against gravity when it is not.
Crucially, the screen rectangle is built from the display's **physical** size in
metres, not its size in points — a ten per cent error there reads as the tank
being the wrong size and the parallax being wrong with it
(`ios/Aquarium/Sources/AR/OffAxisProjection.swift`, `App/DeviceScreen.swift`).

Two details matter more than they look.

**Simultaneous world and face tracking.** `ARWorldTrackingConfiguration` has a
`userFaceTrackingEnabled` flag (A12 and later, iOS 13 and later) that runs the
front and rear cameras into one shared world. That is what makes it possible to
have both the room behind the tank *and* the viewer's head position at once. On a
device without it the tilt fallback still gives parallax, just less of it.

**Filtering the eye position.** Raw face tracking is jittery, and jitter in the
eye position becomes the whole scene shaking. A fixed low-pass filter trades that
jitter against lag, and lag when you move your head quickly is worse than the
jitter. The **1-euro filter** (Casiez, Roussel & Vogel, CHI 2012) adapts its
cutoff to how fast the signal is moving: heavy smoothing when you are still, light
smoothing when you move. It is four lines of arithmetic and it is the right tool
(`AR/OffAxisProjection.swift`).

### The honest limitation

The passthrough image comes from the rear camera's viewpoint, not from the
viewer's eye. What you see through the tank is therefore *nearly*, but not
exactly, what you would see if the phone were a hole. At arm's length, against a
room several metres away, the error is a few degrees and nobody notices; it would
matter for an object close behind the phone. Fixing it properly needs depth and a
reprojection, which the LiDAR models could do and the rest could not.

---

## 2. Swimming

This is where "don't fake it" costs the most, and where the largest share of the
work went.

### What was considered

- **Keyframed or curve-driven animation.** A sine wave along a skeleton. Cheap,
  and it is what almost every aquarium app does. It fails the brief by definition:
  the fish's speed is then an input, not a result.
- **Full Navier-Stokes with an immersed boundary.** The gold standard in the
  fish-swimming literature (for example the immersed-boundary work of Mittal and
  colleagues on fish and fin hydrodynamics). It resolves the vortices a real fish
  sheds and it is completely out of reach on a phone at 60 Hz — these are
  supercomputer runs.
- **Reduced-order hydrodynamic models.** Sir James Lighthill's **elongated-body
  theory** (1960, and the large-amplitude form in 1971) and **Sir Geoffrey
  Taylor's resistive theory** (1952). Between them these two account for most of
  what a swimming fish's body does to the water, at a cost of a few hundred
  arithmetic operations per frame.
- **Learned controllers.** Deep reinforcement learning has produced convincing
  swimmers, and it is genuinely cutting edge. It was rejected for this: the
  training loop is the project, the result is hard to inspect, and the physics
  still has to exist underneath it for the controller to learn against.

### What is used

The body is a chain of 24 segments plus 6 more standing for the caudal fin, and
three families of force are integrated along it every substep
(`preview/src/sim/locomotion.ts`, `SIMULATION-SPEC.md` §4.2):

1. **Reactive (added-mass) force**, from Lighthill. As the body accelerates water
   sideways it feels a reaction, and the useful part of it points forwards. The
   quantity that matters is the *material* derivative of the local lateral
   velocity, `Dw/Dt = ∂w/∂t + U ∂w/∂s` — the term with `U` in it is the one that
   turns a travelling wave into thrust, and dropping it (which is easy to do by
   accident) gives a fish that wags and goes nowhere.
2. **Resistive cross-flow drag**, from Taylor. A body element moving sideways
   through water sheds vortices and feels a quadratic drag. This is what makes a
   fish able to turn, and what limits how hard it can beat its tail before the
   returns stop.
3. **Skin friction.** Laminar flat-plate friction, `Cf = 1.328/√Re` (Blasius),
   with a Hoerner form factor for the body's thickness. At a Reynolds number of
   around 10⁴ this is the correct regime for a fish this small.

The added mass is not guessed. It is integrated from the fish's real elliptical
cross-sections — the classical potential-flow result `(π/4)ρd²` per unit length
for broadside motion — which turns out to matter a great deal: the sideways added
mass of this fish is about **3.3 times its own body mass**, where a first guess of
"about the same as the body" would have been out by a factor of three.

Rigid-body motion uses Euler's equations with the gyroscopic term, and the
orientation is integrated with the exponential map rather than the usual
first-order quaternion update, because during a C-start the angular velocity is
large enough that a first-order update visibly drifts.

### How it is checked

The speed the fish swims at is **not set anywhere**. It is what the forces
produce. That makes it testable against the biology, and the test suite
(`preview/src/test/locomotion.test.ts`) asserts, among other things:

- The **Strouhal number** `St = f·A/U` lands between 0.2 and 0.4 at every tail-beat
  frequency tried. Animals that swim by flapping converge on this band across an
  enormous range of sizes (Triantafyllou and colleagues; Taylor, Nudds & Thomas,
  *Nature* 2003), and it is the strongest single check available — it is an
  emergent ratio of three separately computed quantities, and there is no way to
  satisfy it by tuning one number.
- Speed rises roughly **linearly with tail-beat frequency**, which is the
  classical Bainbridge (1958) result.
- **Stride length** — distance covered per tail beat — falls in the 0.5 to 0.8
  body lengths range measured for subcarangiform swimmers.
- A coast-down from speed decays at the rate the drag model predicts.

**Where it is knowingly imperfect:** the model is roughly 15–20 % more efficient
than a real fish, because it has no vortex-shedding losses and treats the boundary
layer as entirely laminar. The consequence is that the fish reaches a given speed
at a slightly lower tail-beat frequency than a real betta would. Turning radius
comes out at several body lengths, which is genuinely at the high end even for a
long-finned betta dragging that much fin area.

### Fins

The fins were the single largest source of failed attempts.

- **XPBD cloth** (Macklin, Müller & Chentanez, 2016) was tried first and is the
  obvious modern choice for cloth. It failed twice over. A fin ray's natural
  frequency is 30–60 Hz, far above any tail beat, so disturbances rang in the fin
  indefinitely; and once those vibrations were allowed to push on the water, the
  same water was being accelerated twice — once by the body and again by the fin
  attached to it. A fish with a completely still tail and one tiny pelvic fin
  swam across the tank at four body lengths a second.
- **What is used** is a *length-exact chain sweep*: each fin ray is walked
  outwards from two driven roots, and each node is placed at exactly its rest
  distance from the last, in the direction it is being dragged. It cannot stretch,
  cannot ring and cannot gain energy. The fins contribute shape only; their
  hydrodynamics are accounted for once, in the body chain (§1.2 of the spec).

---

## 3. Wanting things

A fish that swims correctly but has no reason to go anywhere still looks like a
simulation. The brief asked for "motivation simulation" specifically.

### What was considered

- **Boids** (Reynolds, 1987). Beautiful for a shoal, and irrelevant for one fish.
- **Behaviour trees / state machines.** Standard in games, and they read as
  scripted because they are: the animal's state is a node in a graph the author
  drew.
- **Tu & Terzopoulos, *Artificial Fishes: Physics, Locomotion, Perception,
  Behavior* (SIGGRAPH 1994).** Still, thirty years on, the best-argued design for
  this exact problem: a physically simulated body, a perception system that can
  only see what the fish could see, internal drives that accumulate, and an
  intention generator that turns the drives into a choice.

### What is used

The 1994 architecture, with the drives specialised to *Betta splendens*
(`preview/src/sim/brain.ts`, spec §5). Perception → drives → intention → motor
goal, once per frame. Six internal states rise and fall on their own timescales:
hunger, air debt, fear, fatigue, aggression, boredom. Nine intentions compete for
control.

Three things from the paper matter more than the rest, and all three exist to stop
the fish looking twitchy:

1. **Perception is limited.** The fish sees within a vision cone and a range, with
   a bonus in the binocular overlap; it feels water movement through a lateral
   line at short range; it smells food as a diffused scent gradient. It cannot act
   on what it has not sensed.
2. **Persistence.** The running intention carries a bonus, so a challenger has to
   be clearly better rather than marginally better.
3. **Minimum dwell.** An intention holds for at least a set time before anything
   can replace it — with reflexes (escape, obstacle avoidance) explicitly allowed
   to pre-empt, because a real escape latency is 5 to 15 milliseconds.

Without 2 and 3 a plain "pick the highest score" loop flickers between two nearly
equal options many times a second, which is the most recognisable tell of a
simulated animal there is. There is a test for it.

### Why a betta

Not an arbitrary pick. It is the one popular aquarium fish that is *correctly*
kept alone, so "start with one fish" is the biologically right answer rather than
a simplification. It also has a **labyrinth organ** and must surface to breathe
air every few minutes — which gives the behaviour model a genuine internal drive
with no external cause, visible from outside, on a timescale a person watching
will actually see. And it flares at rivals, including its own reflection in the
glass, which the front pane of this particular tank is full of.

---

## 4. Water

### Surface

A full 3D fluid solve for a tank this size, at a resolution that would show
anything, does not fit in the frame budget alongside everything else. The surface
is where nearly all the visible behaviour is, so that is what is simulated: a
**height field** on an 80 × 58 grid, integrated with the damped wave equation.

The wave speed is not a tuning parameter. For long waves in shallow water,
`c = √(g·h)`, which for this tank's 85 mm depth gives 0.913 m/s — and that is what
makes the sloshing period come out right when you tilt the phone. There is a test
that measures the period of the fundamental mode and compares it against the
analytic result for a rectangular tank.

The one genuinely hard-won detail is the stability condition, which is not the
obvious one; it is set out in full in spec §3.1. The short version: the viscous
term and the wave term share a velocity update, and analysing them together gives
a limit sixteen times tighter than treating the viscous term as a plain diffusion.
The first value tried satisfied the obvious condition comfortably, behaved
impeccably when the phone was still, and produced NaN about a second after the
phone was shaken hard.

### Bulk flow

The water below the surface has a slow circulation, as any tank with a filter
does. Rather than solve for it, it is an analytic field: a decaying vortex plus
**curl noise** (Bridson, Hourihan & Nordenstam, SIGGRAPH 2007), which is
divergence-free by construction because it is the curl of a potential. Free of
charge, that means the flow can never compress or create water, which a naively
noise-driven velocity field does constantly.

### Food

Pellets are simulated with **Schiller-Naumann sphere drag** (`Cd = 24/Re·(1 +
0.15·Re^0.687)`), which is the standard correlation across exactly the Reynolds
range a 1 mm pellet sinking through water occupies. Fresh pellets float, pinned to
the surface; they waterlog over time and their density crosses that of water, at
which point they sink. That behaviour is the actual behaviour of dried fish food
and it is what makes feeding look right.

Two things about pellets took several attempts:

- Surface tension was first modelled as a stiff spring holding the pellet to the
  surface. The stiffness needed is absurd and the integration explodes. Pinning
  the pellet to the surface while it floats is both cheaper and more correct.
- The fish's **suction strike** — bettas feed by opening the mouth fast and
  pulling water in — was first applied as an impulse on the pellet, which made
  buoyant pellets rocket upwards. It is now a velocity field the pellet is dragged
  into, which is what suction physically is, and it is frame-rate independent.

---

## 5. Rendering

The scene is composited in seven passes (`ios/Aquarium/Sources/Render/Renderer.swift`).

### Camera passthrough

ARKit hands over the camera image as a two-plane YCbCr `CVPixelBuffer`.
`CVMetalTextureCache` maps those planes directly as Metal textures with no copy.
Copying a 1080p frame every frame costs several milliseconds, which is most of the
budget for everything else.

### The water volume

Light is absorbed on the way out of the tank, using **Beer-Lambert** with the
measured absorption coefficients of pure water from **Pope & Fry (1997)** — about
(0.458, 0.0565, 0.0145) per metre for red, green and blue. Over a 250 mm tank that
is a very slight warm-light loss, which is correct: a small tank is *not* visibly
blue, and rendering it blue is the classic tell. A little tannin absorption is
added on top, because a planted tank does have some.

Scattering uses the **Henyey-Greenstein** phase function with `g = 0.68`,
forward-scattering, which is what suspended particles in water actually do.

### Caustics

The dancing light on the tank floor is **computed, not a texture**. A grid of
light rays is refracted through the actual simulated water surface using Snell's
law, and the brightness at each point comes from how much that ray bundle has been
compressed or spread — the Jacobian of the refraction map. This is the standard
photon/ray-bundle construction; the reason for doing it rather than scrolling a
caustics texture is that these caustics *are* the water surface, so when you tilt
the phone and the water sloshes, the light on the floor sloshes with it.

### The fish's colour

A betta's blue-green iridescence is not a pigment. It is **thin-film
interference** in stacks of guanine platelets in the scales, which is why the
colour changes with viewing angle and why it cannot be painted on with a texture.
The shader evaluates the interference term over the visible spectrum for the film
thickness and the angle at each pixel (the approach follows Belcour & Barla's 2017
work on rendering iridescence), over a red pigment layer — which is what a "royal
blue" or "red dragon" betta physically is.

### Making the two images look like one photograph

Rendered content over a camera feed betrays itself in three ways, and all three
are addressed:

- **Exposure.** ARKit reports the scene's ambient intensity; the render's exposure
  follows it. A fixed exposure over an auto-exposing camera drifts apart within
  seconds of anyone walking past a window.
- **White balance.** ARKit reports a colour temperature; the tank's lighting is
  built from it, so the fish is lit by the light that is actually in the room
  rather than by daylight in a room full of tungsten lamps.
- **Grain.** The camera's sensor noise rises steeply as the room gets darker.
  Clean rendered pixels next to noisy camera pixels read as a sticker. The post
  pass adds grain matched to the estimated light level.

---

## 6. Determinism

Both simulations — the TypeScript one and the Swift one — must produce
bit-identical runs from the same seed, or the desktop preview cannot be used to
check the phone.

The random number generator is **xoshiro128\*\***, seeded through splitmix32.
The choice is forced: the more common PCG32 needs 64-bit integer multiplication,
which JavaScript cannot do exactly, so a JavaScript port of it silently diverges
from a Swift one. xoshiro128\*\* uses only 32-bit operations, which both languages
agree about exactly.

Everything downstream of it is derived rather than sampled ad hoc — turn angles
from a **wrapped Cauchy** distribution (the standard model for correlated random
walks in animal movement), noise from a value-noise field with a quintic fade
because the curl operator differentiates it.

---

## Sources

Grouped by section, in the order they are referred to above.

**Perspective and display**
- Kooima, R. *Generalized Perspective Projection.* 2009.
- Casiez, G., Roussel, N., Vogel, D. *1€ Filter: A Simple Speed-based Low-pass
  Filter for Noisy Input in Interactive Systems.* CHI 2012.
- Apple, *ARKit* documentation: `ARWorldTrackingConfiguration.userFaceTrackingEnabled`,
  `ARFaceAnchor`, `displayTransform(for:viewportSize:)`.

**Swimming**
- Lighthill, M. J. *Note on the swimming of slender fish.* J. Fluid Mech., 1960.
- Lighthill, M. J. *Large-amplitude elongated-body theory of fish locomotion.*
  Proc. R. Soc. B, 1971.
- Taylor, G. I. *Analysis of the swimming of long and narrow animals.* Proc. R.
  Soc. A, 1952.
- Bainbridge, R. *The speed of swimming of fish as related to size and to the
  frequency and amplitude of the tail beat.* J. Exp. Biol., 1958.
- Triantafyllou, M. S., Triantafyllou, G. S., Gopalkrishnan, R. *Wake mechanics
  for thrust generation in oscillating foils.* Physics of Fluids A, 1991.
- Taylor, G. K., Nudds, R. L., Thomas, A. L. R. *Flying and swimming animals
  cruise at a Strouhal number tuned for high power efficiency.* Nature, 2003.
- Hoerner, S. F. *Fluid-Dynamic Drag.* 1965. (Form factor for a body of
  revolution.)
- Mittal, R., et al. Immersed-boundary simulations of fish swimming — the
  high-fidelity approach this project deliberately does not take.

**Behaviour**
- Tu, X., Terzopoulos, D. *Artificial Fishes: Physics, Locomotion, Perception,
  Behavior.* SIGGRAPH 1994.
- Reynolds, C. *Flocks, Herds, and Schools: A Distributed Behavioral Model.*
  SIGGRAPH 1987.

**Water and food**
- Bridson, R., Hourihan, J., Nordenstam, M. *Curl-noise for procedural fluid
  flow.* SIGGRAPH 2007.
- Schiller, L., Naumann, A. *Über die grundlegenden Berechnungen bei der
  Schwerkraftaufbereitung.* 1933. (The standard sphere-drag correlation.)
- Macklin, M., Müller, M., Chentanez, N. *XPBD: Position-Based Simulation of
  Compliant Constrained Dynamics.* MIG 2016. (Tried; see §2.)

**Rendering**
- Pope, R. M., Fry, E. S. *Absorption spectrum (380–700 nm) of pure water.*
  Applied Optics, 1997.
- Henyey, L. G., Greenstein, J. L. *Diffuse radiation in the galaxy.*
  Astrophysical Journal, 1941.
- Belcour, L., Barla, P. *A Practical Extension to Microfacet Theory for the
  Modeling of Varying Iridescence.* SIGGRAPH 2017.

**Determinism**
- Blackman, D., Vigna, S. *Scrambled Linear Pseudorandom Number Generators.*
  (xoshiro / xoroshiro family.)
