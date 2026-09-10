# Simulation specification

This is the single source of truth for the numerical models. The TypeScript
simulation (`preview/src/sim`) and the Swift simulation (`ios/Aquarium/Sources/Sim`)
are two ports of *this* document, not of each other. If they disagree, this file wins.

One caveat on that, stated plainly rather than left to be discovered. Building the
thing changed a good many of these numbers — a dozen or so of them were wrong in
ways only a running simulation could show, and the reasons are recorded in the
sections below and at more length in the comments in `preview/src/sim/config.ts`.
Where a constant is concerned, `config.ts` and `SimConfig.swift` are checked
against each other and are the working record; this document explains *why* each
one is what it is. If you find one that has drifted, the code is the fact and this
is the argument.

Everything is SI: metres, kilograms, seconds, radians. Water is fresh water at 25 °C
(`rho = 997 kg/m^3`, kinematic viscosity `nu = 8.9e-7 m^2/s`).

---

## 0. What running it changed

The first version of this document described a fish that, when finally watched
rather than tested, bobbed up and down on the spot and could not turn round.
Eighty to ninety per cent of the distance it covered was vertical. Every test
passed, because no test asked where the fish went. The sections below are
updated, but the list of what was wrong is worth having in one place, because
each item is the kind of thing that passes a test and fails an eye:

- **The swim bladder was an elevator.** Commanded from the pitch error, at
  ±15% of body volume, it was the strongest vertical force the fish had. It is
  now a trim tank at ±3%, driven by the height error (§4.4).
- **The speed controller counted sinking as swimming.** It compared the target
  speed with total speed, so a fish rising on its bladder had "reached" its
  speed and the tail switched off. It now uses forward speed.
- **The steering sign was backwards.** The body frame is right-handed with +z
  forward and +y up, which puts +x on the fish's *left*; a comment said right,
  and the turn command was signed for the comment. With the tail driving, the
  fish turned away from every target and only crept towards it in the pauses.
- **The pectoral fins produced no force at all.** The blade normal was set
  along the fin's span, so the paddle moved edge-on. The whole slow-swimming
  mode ran on nothing (§4.6).
- **There was no way to turn at a standstill.** The "asymmetric beat" was a
  static shift of a symmetric wave, which nets nothing at rest; the fish could
  only turn as a rudder does, with water flowing past, on a radius wider than
  the tank. It is now a genuine amplitude asymmetry (§4.1), and large turns are
  made with a tail scull (§5.6).
- **The glass was a table leg.** A contact spring of 240 N/m threw a fish that
  nosed the pane at forty times its weight. It is 12 N/m.
- **Fatigue was kinematic.** Counted from speed, being flung by the glass read
  as a sprint and parked the fish in `rest`. It is now counted from the tail
  beat, which is what the muscles are actually doing.
- **The water was never disturbed**, so the surface was a perfect plane, the
  caustics a constant and the tank looked dry. The filter outlet now keeps a
  millimetre of ripple going (§3.4).

---

## 1. Choice of animal

The fish is a **Siamese fighting fish, *Betta splendens*** (a male veiltail).

This is not an arbitrary pick. The brief says "start with one fish", and the betta is
the one popular aquarium fish that is *correctly* kept alone — males attack each other,
so a single-occupancy tank is the biologically right answer rather than a simplification
we are apologising for. It also buys three things that make the realism much easier to
judge:

- **It breathes air.** Bettas have a labyrinth organ and must surface for a gulp of air
  every few minutes. That gives the behaviour model a genuine, non-negotiable internal
  drive that is visible from outside, on a timescale a person will actually see.
- **It flares.** A male confronted with a rival — including his own reflection in the
  glass — erects his gill covers and fins in a threat display. The front glass of this
  tank is a phone screen, so reflections and the viewer's own face are naturally part
  of the scene, and the fish reacts to them.
- **Its fins are enormous and thin.** They cannot be animated convincingly by a rigid
  skeleton; they have to be simulated as flexible sheets pushed around by water. That
  forces the honest implementation.

### 1.1 Morphometrics

Standard length `SL` (snout to base of tail) is the reference length used everywhere.

| Symbol | Meaning | Value |
|---|---|---|
| `SL` | standard length | `0.048 m` |
| `TL` | total length including caudal fin | `0.072 m` |
| `m` | body mass | `1.5e-3 kg` (1.5 g) |
| `rho_body` | mean body density, bladder at rest | `1000 kg/m^3` |
| `d_max` | maximum body depth (dorsal-ventral, excluding fins) | `0.0135 m` |
| `w_max` | maximum body width (left-right) | `0.0062 m` |
| `s_maxdepth` | position of maximum depth along the body | `0.34` |

The body is described as a chain of `N_SEG = 24` segments along a centreline
parameterised by `s` in `[0, 1]` (0 = snout tip, 1 = caudal peduncle, the narrow stalk
the tail fin attaches to). Each segment has an elliptical cross-section of half-depth
`d(s)/2` and half-width `w(s)/2`.

Profile functions, fitted to give a betta silhouette (deep-bodied anteriorly, sharply
tapering peduncle):

```
d(s) = d_max * (1 - ((s - s_maxdepth) / k_d(s))^2)^0.62      clamped to >= 0.06*d_max
  where k_d(s) = 0.40 for s < s_maxdepth, 0.78 otherwise
w(s) = w_max * (d(s) / d_max)^0.85
```

The `^0.62` exponent makes the profile fuller than an ellipse (a real fish is not a
lens shape), and width tracking depth to the `0.85` power keeps the cross-section
progressively more laterally compressed towards the tail, which is what a betta is.

Segment mass is distributed by cross-sectional area so the centre of mass lands at
`s ≈ 0.38`, forward of centre, as in a real fish.

### 1.2 Fins

| Fin | Count | Attach range in `s` | Span | Simulated as |
|---|---|---|---|---|
| Caudal (tail) | 1 | at `s = 1` | `0.024 m` chord, `0.030 m` span | trailing sheet, 9x11 nodes |
| Dorsal (top) | 1 | `0.46 – 0.92` | `0.019 m` height | trailing sheet, 7x9 |
| Anal (bottom) | 1 | `0.42 – 0.98` | `0.023 m` height | trailing sheet, 7x13 |
| Pectoral (side) | 2 | `0.30` | `0.011 m` | rigid, kinematically beaten |
| Pelvic (ventral) | 2 | `0.33` | `0.016 m` | trailing sheet, 3x7 |

Pectorals are the exception: they are the *engine* for slow swimming, not passive
surfaces, so they are driven directly (section 4.3).

**How the trailing fins are simulated, and why not as cloth.** The first version
solved each fin as a proper cloth — a grid of masses joined by distance
constraints, relaxed a few times a step. It was wrong twice over. Numerically it
rang: a fin ray's natural frequency is 30–60 Hz, far above any tail beat, so
every disturbance stayed in the fin indefinitely, and once those vibrations were
allowed to push back on the water the fish swam on its pelvic fins alone.
Physically it was double counting: the same water was being accelerated once by
the body and again by the fin attached to it.

What is there now is a *length-exact chain sweep*. Each fin ray is walked from
its two driven roots outwards, and each node is placed at exactly its rest
distance from the previous one, in the direction it is being dragged. The ray can
therefore never stretch, never ring, and never gain energy, and it trails and
lags the way real fin tissue does. The fins contribute **shape only**. All the
hydrodynamic force they generate is accounted for in the body chain instead,
where the caudal fin appears as six extra segments past the peduncle and the
dorsal and anal fins are folded into the local body depth (`hydroDepth`,
section 1.1). One surface, one force.

---

## 2. Tank and world frame

Right-handed, origin at the centre of the **front glass** — which is physically the
phone's screen. `+x` right, `+y` up, `+z` out of the screen towards the viewer.
The tank therefore occupies `z` in `[-D, 0]`.

| Symbol | Meaning | Value |
|---|---|---|
| `W` | interior width | `0.350 m` |
| `H` | interior height | `0.200 m` |
| `D` | interior depth | `0.250 m` |
| `y_water` | still water level relative to front-glass centre | `-0.015 m` |
| `y_floor` | substrate surface | `-0.100 m` |
| `h_water` | still water depth = `y_water - y_floor` | `0.085 m` |

Water volume is `W * D * h_water = 7.4 L`. That is small for a betta by modern
fishkeeping standards (5 gal / 19 L is the usual recommendation) and it is a deliberate
compromise: a bigger tank pushes the fish far enough from the glass that it stops being
a *phone-sized* scene. `TankConfig` is data, so this is a one-line change.

The substrate is dark sand with a gentle slope, rising `0.012 m` towards the back so the
floor reads as a surface rather than a plane. Hardscape: one piece of driftwood and
three broadleaf plants — a betta rests on leaves, so at least one leaf is placed at
`y = -0.055 m`, in the middle third of the water column, as a rest target.

---

## 3. Water

### 3.1 Surface: damped wave equation on a height field

The surface is a height field `u(x, z, t)` — a displacement from the still level —
on a grid of `NX x NZ` cells — `80 x 58`, the same on both platforms.

```
d2u/dt2 = c^2 * lap(u) + alpha * c * lap(du/dt) - beta * du/dt + F
```

- `c` is the wave speed. For long waves in shallow water `c = sqrt(g * h_water)`
  = `sqrt(9.81 * 0.085)` = **0.913 m/s**. This is not a tuned number; it is the
  shallow-water result, and it is what makes the slosh period come out right.
- `alpha = 0.0005` — viscous smoothing of the *velocity* field (removes grid-scale
  buzz without killing the wave). The value is set by the stability condition
  below, not chosen for looks.
- `beta = 0.45 s^-1` — bulk damping. Chosen so a disturbance decays over ~4 seconds,
  matching a small tank.
- `F` is the forcing (3.2).

Integrated explicitly with the standard 5-point Laplacian, and there are **two**
stability conditions, not one.

The familiar one is the wave (CFL) condition, `c * dt / dx <= 1/sqrt(2)`. With
`dx = W/NX = 4.375 mm` and `c = 0.913 m/s` that gives `dt <= 3.4 ms`.

The second one is the reason `alpha` is as small as it is. Taken on its own the
viscous term is a diffusion, so the obvious limit is
`alpha * c * dt / dx^2 <= 1/2`. That limit is far too generous, because the wave
term and the viscous term share the same velocity update; writing out the
two-by-two amplification matrix of the *combined* scheme gives the real
requirement:

```
dt * (alpha * c * lambda_max + beta) < 1
```

where `lambda_max = 4*(1/dx^2 + 1/dz^2)` is the largest eigenvalue of the
discrete Laplacian. The first value tried, `alpha = 0.008`, sat at 40 % of the
diffusion limit and 160 % of this one. The surface behaved impeccably when left
alone and went to NaN within about a second of the phone being shaken hard —
the shortest wavelength the grid can hold grew instead of decaying.

The water substeps at a fixed `dt_water = 2.5 ms` regardless of frame rate: 74 %
of the wave limit and 59 % of the damping limit. Both conditions are asserted in
the constructor, so changing the grid, the timestep or the damping cannot quietly
reintroduce the failure.

**Check that falls out of this:** the fundamental sloshing period of a rectangular tank
is `T1 = 2W / sqrt(g * h_water)` = `0.70/0.913` = **0.77 s**. Test `water.slosh`
asserts the simulated period is within 12 % of that. Nothing in the code is tuned to
make that pass — it passes because the wave speed is physical.

Reflecting (Neumann, `du/dn = 0`) boundaries at all four walls, which is what makes
water pile up in a corner when you tilt the phone.

### 3.2 Forcing terms

**Sloshing from device motion.** The phone's linear acceleration `a` (world frame, from
ARKit, gravity removed) tilts the effective gravity vector. The equilibrium surface is
the plane perpendicular to `g_eff = g - a`, which to first order is

```
u_eq(x, z) = -(a_x * x + a_z * z) / g
```

We do not snap the surface to this; we push it, which is what produces the lag and
overshoot that reads as real liquid:

```
F_slosh = k_slosh * (u_eq - u),   k_slosh = 26 s^-2
```

`k_slosh` sets how stiffly the bulk follows the tilt. At 26 the bulk response time is
`1/sqrt(26)` = 0.20 s, comfortably slower than the wave period, so tilting produces a
travelling wave rather than a rigid tilt of the whole surface.

**Fish.** Any body segment within `0.02 m` of the surface injects into `du/dt`
proportional to its vertical velocity, weighted by a `0.02 m` Gaussian and by segment
frontal area. A surface gulp therefore makes a real ring of ripples, because the fish's
snout genuinely broke the surface.

**Pellets.** A pellet crossing the surface injects an impulse into `du/dt` of
`-0.05 * v_impact` over a `0.004 m` radius.

### 3.3 Bulk flow

A full 3-D fluid solve is out of budget on a phone at 60 fps, so bulk water motion is a
**divergence-free analytic field** rather than a grid solve:

1. A slow convection roll driven by the (virtual) filter outlet in the back-right
   corner: a Rankine vortex with core radius `0.06 m` and peak tangential speed
   `0.012 m/s`, axis along `+y`.
2. Curl noise: `v = curl(psi)` where `psi` is a 3-component simplex-noise potential at
   spatial scale `0.09 m` and time scale `0.15 Hz`, amplitude `0.004 m/s`.

Taking the curl of a potential guarantees `div(v) = 0`, i.e. the flow neither creates
nor destroys water — the property that actually matters visually, because divergent
flow makes suspended particles bunch up in a way the eye reads as wrong immediately.

The fish's own wake is *not* fed back into this field. That is the one deliberate
omission in the water model and it is invisible with a single fish; it would matter for
a school.

---

### 3.4 The filter outlet

A tank with a filter running is never still. The return stream keeps a patch of
small ripples going at the outlet, and those ripples are most of what makes the
water visible: they carry the caustics, the wobble in everything seen through
the surface, and the glints. Modelled as a continuous oscillating push on the
surface velocity over a Gaussian patch 14 mm across at the outlet, at 2.6 Hz
with slow flutter in both strength and frequency, sized to give ripples of
about a millimetre. Applied every substep, not per frame, so the ripple height
does not depend on the frame rate. Test: peak displacement between 0.2 and 3 mm,
finite over a long run.

## 4. Fish locomotion

The rule here is: **the fish's brain controls muscles, not velocity.** Nothing in the
code ever sets the fish's speed. Speed is whatever the hydrodynamic forces produce.
This is the difference between a simulation and an animation, and it is testable —
see section 4.5.

### 4.1 Prescribed body curvature (the muscle command)

The brain outputs three motor parameters. The body's lateral displacement at arc
position `s`, in the fish's own frame, is

```
h(s, t) = A(s) * sin(2*pi*s/lambda - 2*pi*f*t) + kappa * bend(s)
```

- `f` — tail-beat frequency, Hz, range `[0, 9]`.
- `A_tip` — tail-tip half-amplitude, metres.
- `kappa` — a steady one-sided bend for turning, range `[-1, 1]`.

Amplitude envelope, normalised so `A(1) = A_tip`:

```
A(s) = A_tip * (0.08 - 0.30*s + 1.22*s^2)
```

This is small but non-zero at the snout (0.08 of tail amplitude — real fish do yaw
their heads slightly), dips to a minimum of 0.062 at `s = 0.123`, and grows
quadratically to the tail. That minimum near the front quarter is a measured feature of
subcarangiform swimmers, not a stylistic choice.

`lambda = 0.95 * SL` — the body wave is very slightly shorter than the body, so a little
under one full wave is visible on the fish at any instant. This is the subcarangiform
range (anguilliform eels run ~0.6 SL, thunniform tuna ~1.2 SL).

Turning is *not* a static bend. A real fish does not hold itself in a curve and
coast round; it beats its tail asymmetrically, sweeping further to one side than
the other, and adds a gentle camber to the whole body. Both are here, and they
follow the amplitude envelope rather than an independent curve:

```
h(s, t) = A(s) * [ sin(theta) + kappa * 0.8 * sin^2(theta) ] + kappa * 0.010 m * s^1.6
```

with `theta = 2*pi*s/lambda - 2*pi*f*t`. The `sin^2` term is one-signed and
largest at the extremes of the stroke: it is an *amplitude* asymmetry, so the
tail sweeps to 1.8 times its normal excursion on the turning side and barely
crosses the centreline on the other. That is what turns the fish at a
standstill — drag goes as the square of speed, so the fast half-stroke puts a
net sideways impulse into the water at the tail. The first version was a
static one-sided *shift* of the wave, with equal speeds both ways, which nets
nothing at rest; the fish could then only turn as a rudder does, and its
turning radius at any speed was wider than the tank. An earlier version
used `0.010 m` for the beat term as well, which swung the fin tip nearly forty
millimetres off the centreline — an escape-grade C-shape — several times a
second; the entrained water on the tail turned each of those flips into fifteen
to twenty times the fish's weight in force and threw it across the tank at twelve
body lengths a second. A reflex may exceed this by `2.4x`, because a C-start
genuinely is that extreme a posture.

**Amplitude is not free.** Real fish hold tail-beat amplitude nearly constant at about
20 % of body length peak-to-peak and change speed by changing *frequency*. So
`A_tip = 0.10 * SL = 4.8 mm` (half of 20 %) during steady swimming, reduced only at the
very bottom of the speed range where the fish switches to pectoral fins (4.3), and
raised to `0.16 * SL` in an escape burst.

**Where the amplitude is measured matters.** The 20 % figure is measured at the
trailing edge of the tail fin, not at the peduncle where the flesh ends. On this
fish the caudal fin is half a body length again, so the two points are at
`s = 1.5` and `s = 1.0` and the envelope has grown by a factor of 2.375 between
them. Normalising at the wrong one gave a fish beating its tail with well over
twice the sweep any real fish uses.

### 4.2 Hydrodynamic forces

Forces are integrated over the body one segment at a time. For segment `i` with
centre `p_i`, outward lateral normal `n_i`, tangent `t_i`, arc length `ds_i`, local
depth `d_i` and width `w_i`:

Relative velocity of the segment through the water (rigid-body motion, plus the
undulation velocity in the body frame, minus the ambient flow from 3.3):

```
v_i = v_body + omega x (p_i - p_com) + v_undulation_i - v_flow(p_i)
v_n = dot(v_i, n_i)        (sideways)
v_t = dot(v_i, t_i)        (along the body)
```

**Reactive / added-mass force.** A slender body pushing sideways drags a cylinder of
water with it. The added mass per unit length for an ellipse of depth `d` moving
broadside is `m_a = (pi/4) * rho * d^2`. The force is the rate of change of that
water's momentum:

```
f_reactive_i = -m_a(s_i) * ds_i * (dv_n/dt) * n_i
```

`dv_n/dt` is taken as a backward difference of `v_n` between frames, clamped to
`+/- 400 m/s^2` so a frame hitch cannot blow the integrator up.

This term is where thrust comes from. It is the discretised form of Lighthill's
elongated-body theory: the momentum the tail throws backwards into the wake is the
momentum the fish gains forwards.

**Resistive / cross-flow drag.** A flat plate broadside to the flow:

```
f_crossflow_i = -0.5 * rho * C_D * (d_i * ds_i) * |v_n| * v_n * n_i,   C_D = 1.65
```

`C_D = 1.65` is the standard cross-flow drag coefficient for a finite plate of this
aspect ratio. Note the `|v_n| * v_n` — quadratic drag, correct above Reynolds ~1000,
which the tail comfortably exceeds.

**Skin friction.** Along the body, using the Blasius laminar flat-plate result with a
Hoerner form factor for a body of revolution:

```
Re    = |v_body| * SL / nu
C_f   = 1.328 / sqrt(Re)                        (laminar; Re here is ~5e3 to 5e4)
FF    = 1 + 1.5*(d_max/SL)^1.5 + 7*(d_max/SL)^3
f_friction_i = -0.5 * rho * C_f * FF * A_wet_i * |v_t| * v_t * t_i
```

At a 0.10 m/s cruise, `Re = 5.4e3`, `C_f = 0.0180`, `FF = 1.20`.

**Fins** contribute through the same three terms, evaluated per cloth triangle using
that triangle's own normal and area. This is what makes the fins do real work: the
caudal fin is roughly 40 % of the total thrust, and the dorsal and anal fins produce
the yaw damping that stops the body from fishtailing.

**Buoyancy and weight.** `f = (rho * V_displaced - m) * g`, applied at the centre of
volume, which sits `1.4 mm` above the centre of mass. That offset is the fish's
righting moment: it is why a fish rolls upright on its own and why a sick or dead one
does not. Swim-bladder volume is a state variable `V_bladder` in
`[0.85, 1.15] * V_neutral`, slewing at `0.04 /s` — so the fish takes about 4 seconds to
change its buoyancy, and hangs slightly nose-up when adjusting.

### 4.3 Pectoral fins (slow speed)

Below `0.35 SL/s` the fish stops beating its tail and rows with its pectoral fins
(labriform swimming), which is what a hovering betta actually does. Each pectoral beats
at `f_pec` in `[0, 6] Hz` with a rowing stroke:

```
sweep(t)  = phi_0 + phi_A * sin(2*pi*f_pec*t)          phi_0 = 0.35 rad, phi_A = 0.55 rad
pitch(t)  = pitch_A * sin(2*pi*f_pec*t + 1.9 rad)      pitch_A = 0.62 rad
```

The `1.9 rad` phase lead between sweep and pitch is what makes a rowing fin produce net
thrust on the power stroke and feather on the recovery stroke — with zero phase offset
it produces zero net force, which the test suite checks. Forces on the pectoral use the
same added-mass and cross-flow terms as the body.

Differential pectoral beat (one side harder than the other) is how the fish turns in
place and how it backs up — bettas can swim backwards, and this falls out for free.

### 4.4 Rigid-body integration

The fish's frame is a 6-DoF rigid body: position, orientation (quaternion), linear and
angular velocity. Segment forces are summed to a net force and torque about the centre
of mass, then:

```
a     = F / (m + m_added)         m_added is direction-dependent (below)
alpha = I^-1 * (T - omega x (I * omega))
```

Added mass on the whole-body scale is strongly anisotropic — accelerating forwards is
cheap, sideways is expensive:

```
m_added_surge = 0.20 * m       (along body)
m_added_sway  = 1.05 * m       (sideways)
m_added_heave = 0.95 * m       (up/down)
```

The inertia tensor is computed from the segment masses as a chain of elliptical
cylinders, with added-inertia factors `[1.1, 1.4, 1.4]` about the roll, pitch and yaw
axes. Quaternion integrated by exponential map and renormalised each step.

Fixed timestep `dt_fish = 4 ms` (250 Hz), with the frame's elapsed time accumulated and
clamped to 5 substeps to survive a stall.

### 4.5 Validation — what makes this "not faked"

The simulation is checked against measurements of real fish that nothing in the code
was tuned to reproduce. From `preview/test/locomotion.test.ts`:

| Quantity | Biology | Test asserts |
|---|---|---|
| Strouhal number `St = f * A_pp / U` at steady cruise | fish converge on 0.2–0.4, optimum 0.25–0.35 | `0.20 <= St <= 0.40` at 2, 3, 4 and 5 Hz |
| Stride length (body lengths advanced per tail beat) | 0.5–0.8 SL | `0.45 <= U/(f*SL) <= 0.85` |
| Cruise speed at 3 Hz | 1–3 SL/s for a small labyrinth fish | `1.0 <= U/SL <= 3.5` |
| Speed vs frequency | close to linear | `R^2 >= 0.97` on a straight-line fit |
| Coast-down after stopping | glides then stops, no reverse | monotonic decay, `< 0.02` overshoot |
| Pectoral thrust at zero phase offset | none | `|net thrust| < 1 % of in-phase` |

If the hydrodynamics were faked — a velocity set directly from frequency — the Strouhal
number would be whatever we made it, and it would not simultaneously satisfy the stride
length and the linearity. Getting all of them at once is the evidence.

---

### 4.6 Pectoral fins, corrected

The pectoral is a paddle standing on its span. The span runs out from the body
at the sweep angle, `(side*cos, 0, -sin)`; the blade's plane contains the span
and the vertical, so its normal is `span x up`, tilted about the span by the
feather angle, and the tilt mirrors with the side. The first version set the
normal *along* the span, so the paddle moved edge-on and every stroke was free.

Rowing is drag-based. The feather profile is `(1 - cos phase)/2` — flat through
the power stroke, 83° edge-on through the recovery — not a sinusoid with a phase
lead, which feathers both strokes equally. The reactive (added-mass) term is
left out on the pectorals: with a normal that rotates during the stroke, the
scalar form does not net to zero over a cycle and produced a steady lift of
several times the drag thrust. When not rowing the fin folds back to 72° along
the flank, edge-on to the flow, and its pitch is then an angle of attack: that
is the elevator. Kept half-open and beating at cruise it was a dive plane.

Measured: both fins at 4 Hz give 0.37 SL/s forwards; a single fin's yaw torque
is real and correctly signed at 1.5e-7 N.m but the fish's effective yaw inertia
is 1.35e-5 kg.m^2 — its own 3.8e-7 plus thirty-five times that of water its
flanks and fins must shove sideways — so a pectoral pivot is a quarter of a
degree a second. Pivots are made with the tail (§5.6).

### 4.7 Swim bladder and depth

The bladder is a trim tank, ±3% of neutral volume, slewing over seconds towards
whatever makes the fish neutrally buoyant at the height it wants. It is driven
by the height error, never the pitch error. Climbing and diving are done by
swimming with the body pitched and the pectorals angled, with the climb rate fed
back into the pitch demand (gain 25 s/m) so the height loop levels off instead
of porpoising.

### 4.8 Contact and damping

The glass is a spring of 12 N/m with 0.3 N.s/m of damping — a fast cruise into
the pane stops over about five millimetres. It acts on the whole fish, not on
its centre: six points in the body frame (snout 27 mm ahead of the centre of
mass, tail-fin tip 47 mm behind, dorsal edge 25 mm up, anal edge 19 mm down
with the fin folded against the substrate, pectoral tips 12 mm out), and the
push comes from whichever is furthest through each pane. Keeping only the
centre inside with a margin sized for the snout put the tail through the front
glass 37 % of the time. Only the snout transmits a torque: the fins are
membranes on a compliant peduncle, and giving the tail a rigid 47 mm lever arm
pitched the fish into the sand every time its tail brushed the glass.
Avoidance senses from the snout and the centre only — sensing from every
extreme made most of an 8.5 cm deep tank "near a wall". Rotation is damped by the cross-flow
drag (quadratic) plus a viscous term with a 2.5 s time constant, so a kicked
fish does not coast in yaw indefinitely but a slow turn is not smothered.

## 5. Behaviour — the fish's brain

The architecture follows Tu and Terzopoulos's *Artificial Fishes* (SIGGRAPH 1994): a
perception stage feeds a set of **internal state variables**, an **intention generator**
picks one intention from them with hysteresis so the fish does not dither, and a
**behaviour routine** turns that intention into motor commands. Their fish had hunger,
libido and fear; a lone captive betta needs a different set.

### 5.1 Perception

- **Vision.** Eyes are lateral, giving a wide monocular field and a narrow binocular
  overlap ahead. Modelled as: full detection within `160°` either side of the body
  axis (so a `40°` blind cone directly behind), out to `0.18 m`. Acuity falls off as
  `1/r`, and detection needs `contrast * acuity > threshold`. Objects in the binocular
  wedge (`+/- 22°` ahead) get a `2.5x` acuity bonus, which is why the fish turns to
  face something before striking at it.
- **Lateral line.** A pressure-gradient sense along the flank that works in the blind
  spot and in the dark. Reads the local water velocity field and the height-field
  gradient, detecting disturbances above `0.006 m/s` within `0.10 m`. This is how a
  pellet hitting the surface behind the fish gets noticed.
- **Chemoreception.** Food released into the water diffuses a scalar concentration
  field (a cheap Gaussian per pellet, `sigma` growing as `sqrt(0.5 * t)` from an
  eddy-diffusivity of `2.5e-5 m^2/s`). The fish climbs the gradient. This is why it
  can find food it never saw land.
- **Looming.** A separate fast pathway. Any large object whose visual angle is growing
  faster than `2.2 rad/s` triggers fear directly, without going through recognition.
  This is a real, well-mapped escape circuit in fish, and it is what fires when a hand
  or face comes at the glass.

### 5.2 Internal state

All in `[0, 1]`. Rates given per second of *fish time*; `timeScale` (default `1.0`)
multiplies them, so the whole physiology can be sped up for demos without touching
anything else.

| State | Rises | Falls | Time constant |
|---|---|---|---|
| `hunger` | continuously, faster when active | eating a pellet: `-0.16` each | full swing ~6 h |
| `airDebt` | continuously, `+2.2x` when swimming hard | a surface gulp: to 0 | forces a gulp every 4–11 min |
| `fear` | looming, impacts, sudden light change | exponential decay | `tau = 26 s` |
| `fatigue` | above an aerobic tail beat of `4.3 Hz` (the beat that gives 4 SL/s), with the cube of the excess | slowly, faster at rest | `tau_recover = 90 s` |
| `aggression` | seeing a rival (reflection / face) | exponential decay | `tau = 45 s`, refractory 20 s |
| `boredom` | in familiar places | exploring novelty | drives patrolling |

`airDebt` deserves a note because it is the one that most makes the fish look alive.
It rises at a baseline `1/420 per second` and up to `2.2x` that when the fish is
working hard, so a calm fish surfaces every ~7 minutes and an agitated one every ~3.
When it passes `0.75` the surfacing intention starts outcompeting everything except
fear, and above `0.95` it beats even fear. That is a real hierarchy — a fish will
surface for air with a predator present, because it has to.

Novelty/habituation: the tank is divided into a `6 x 4 x 5` grid of cells, each with a
familiarity value that rises while occupied (`+0.10/s`) and decays (`-0.004/s`).
`boredom` is driven by the familiarity of the current cell. This gives unforced
patrolling: the fish drifts towards places it has not been recently, without any
waypoint list.

### 5.3 Intention generator

Each intention computes a **desire** in `[0, 1]` from state and perception:

```
escape        = fear
surface       = smoothstep(0.55, 1.0, airDebt) * (1 - 0.5*fear)
flare         = aggression * rivalVisible * (1 - fear) * (1 - 0.7*fatigue)
strikeAtFood  = foodVisible * smoothstep(0.10, 0.55, hunger) * proximity
forage        = smoothstep(0.30, 0.85, hunger) * (1 - foodVisible)
rest          = smoothstep(0.55, 1.0, fatigue) * (1 - hunger) * (1 - fear)
inspect       = novelObjectVisible * (1 - fear) * (0.3 + 0.7*boredom)
patrol        = 0.14 + 0.30 * boredom
```

`patrol` has a floor of 0.14 so there is always something to do — a fish with all drives
satisfied still swims.

Selection has three guards, all from the 1994 paper:

1. **Obstacle override.** If a collision is predicted within `0.25 s`, avoidance
   pre-empts everything. Checked first, every step.
2. **Persistence.** The current intention keeps a bonus of `0.12` while it runs, so a
   challenger must be clearly better, not marginally better, to take over.
3. **Minimum dwell.** Once selected, an intention holds for at least `0.6 s`
   (`0.5 s` for `avoid`, `0.15 s` for `escape`). Nothing can switch faster than
   that. Avoidance gets most of a second because a swerve round the glass takes
   about that long to complete, and a fish that reconsiders halfway through one
   turns back into the wall.

Together these are what stop the twitchy, indecisive look that a plain argmax gives.
The test `the fish does not dither between intentions` runs 150 simulated seconds
and asserts that the mean intention lasts over 1.5 s, that anything cut shorter
than 0.13 s was cut short by a *reflex* — an escape or an avoidance, which are
allowed to pre-empt — and that fewer than 12 % of intentions end that way.

### 5.4 Behaviour routines

Each routine outputs a **motor goal**: a target point, a desired speed in SL/s, and an
urgency in `[0, 1]`. A steering layer converts that to `(f, A_tip, kappa, f_pec_left,
f_pec_right)`.

- **avoid** — the tank walls are the only obstacles. Repulsion grows as
  `1/dist^2` inside `0.05 m`; the fish also banks away, which is a roll, not just a
  yaw, and is a large part of looking real.
- **escape** — a C-start: one frame of `kappa = 1.0` bend to a C-shape, then a burst at
  `f = 9 Hz, A_tip = 0.16 SL` away from the threat, for `0.4 – 0.9 s`. Fish escape
  latency is 5–15 ms, so the response begins on the very next physics step.
- **surface** — swim to the nearest surface point, pitch up `35°`, break the surface
  with the snout, hold `0.22 s`, gulp (a visible bubble and real ripples), dive away.
- **flare** — hold position facing the rival, `f_pec` up to counteract drift, gill
  covers out over `0.35 s`, all fins to maximum spread, body slowly arcing. Fatigue
  accumulates at `4x` while flaring, so displays self-limit after 20–40 s, as they do.
- **strikeAtFood** — approach to `0.02 m`, then a suction strike: mouth opens over
  `60 ms`, a `0.03 m/s` inflow is added to the pellet's velocity for `80 ms`. If the
  pellet is not in the mouth cone it gets pushed aside instead of eaten, and the fish
  has to try again — which is exactly what real fish do and reads as unmistakably alive.
- **forage** — a correlated random walk (turn angles from a wrapped Cauchy
  distribution, concentration `0.72`) biased up the chemical gradient. Fish search near
  the surface first, since that is where betta pellets are.
- **rest** — settle onto the nearest leaf or the substrate, `f = 0`, minimal pectoral
  beat, body pitched `-8°`, occasional slow tail flick. Buoyancy is trimmed so the fish
  neither sinks nor rises.
- **inspect** — approach to `0.04 m`, hover with pectorals, track the object with small
  yaw corrections for `2 – 6 s`, then habituate.
- **patrol** — pick the least familiar cell, cruise there at `1.2 SL/s`.

### 5.5 Steering to muscles

The steering layer is deliberately thin, because the physics does the work:

```
heading error e_yaw  -> kappa   = clamp(2.4 * e_yaw, -1, 1)
heading error e_pitch-> pitch trim on bladder + body attitude
speed error e_u      -> f      = clamp(f + 3.5 * e_u * dt, 0, 9)
```

The frequency is *integrated* towards the speed error rather than solved for. That
means the fish accelerates on its own hydrodynamic terms and always lags its own
intention slightly, the way an animal with muscle and inertia does.

---

### 5.6 Steering, corrected

The heading error is the angle to the target in the fish's horizontal plane,
and only when there is a horizontal component worth turning for: a target
within about 15° of straight up or down needs pitch, not yaw. Targets are
clamped inside the tank before steering, three centimetres from every pane.

Turns of more than about 50° are made on the spot with a **tail scull**: three
beats a second at full asymmetry, the body curled to a quarter of its reflex
range, pectorals folded, brakes on. Measured: about 22°/s on a radius near
10 cm, with peak hydrodynamic force 1.3 times the fish's weight. Half the reflex
range turned faster but at nineteen times the weight, which is a C-start. At
cruise, turning is the asymmetric beat plus the camber acting as a rudder, with
a PD law on the heading (gain 1.35, rate 0.035) whose sign is set by
measurement. The speed controller integrates the tail beat towards the *forward*
speed error; sinking is not swimming.

## 6. Food

Betta pellets float, then waterlog and sink — both phases matter, because the fish
feeds at the surface first and then hunts the sinkers.

| Property | Value |
|---|---|
| radius | `0.7 mm` (`+/- 15 %` per pellet) |
| dry density | `640 kg/m^3` (floats) |
| saturated density | `1080 kg/m^3` (sinks) |
| waterlogging time constant | `38 s` |
| drag coefficient | Schiller-Naumann: `C_D = 24/Re * (1 + 0.15*Re^0.687)`, floor 0.44 |

`Re = 2*r*|v|/nu`. At the terminal sink speed `Re ≈ 62`, which is squarely in the range
where the constant-0.44 sphere assumption is wrong, hence Schiller-Naumann.

Terminal sink speed for a fully saturated pellet comes out at **4.1 cm/s**, which test
`food.terminal-velocity` checks against the analytic balance.

While floating, a pellet is pinned to the height field and rides the surface (including
the slosh), with a surface-tension restoring force. Once its density passes `997` it
detaches and sinks, advected by the bulk flow (3.3).

**Double tap** drops `3` pellets, `10 ms` apart, with `+/- 4 mm` scatter, at the point
where the tap ray meets the water surface. If the tap ray misses the water (you tapped
the wall or the sand), no food is dropped — the gesture is a physical act of dropping
something into the tank, not a UI button.

Uneaten pellets remain, sink, sit on the substrate, and slowly break down over
`~6 min` — and the fish will pick them off the bottom, which is a behaviour a real
betta shows.

---

## 7. Viewer perspective

Two things are being tracked and they do different jobs.

**Device pose (rear camera, ARKit world tracking)** anchors the tank. The tank is
rigidly attached behind the phone — the phone's screen *is* the front glass. So the tank
travels with the phone, and the rear camera sees exactly what is behind the tank: the
real room. That is what makes the passthrough physically consistent rather than a
wallpaper.

Device pose also gives linear acceleration, which drives the sloshing (3.2), and gravity
direction, which tells the water and the fish which way is up. Turn the phone and the
water level stays horizontal.

**Eye position (front camera, ARKit face tracking)** sets the projection. With
`ARWorldTrackingConfiguration.userFaceTrackingEnabled = true` (A12 and later, iOS 13+)
both run at once. The eye midpoint in device coordinates gives an **off-axis projection**
— the asymmetric frustum from Kooima's generalised perspective projection.

Given eye `e` and the screen rectangle by its corners `pa` (bottom-left), `pb`
(bottom-right), `pc` (top-left), in device coordinates:

```
vr = normalize(pb - pa)          screen right
vu = normalize(pc - pa)          screen up
vn = normalize(cross(vr, vu))    screen normal, towards the viewer

va = pa - e,  vb = pb - e,  vc = pc - e      eye to corners
dist = -dot(va, vn)                          eye-to-screen distance

left   = dot(vr, va) * near / dist
right  = dot(vr, vb) * near / dist
bottom = dot(vu, va) * near / dist
top    = dot(vu, vc) * near / dist

P = frustum(left, right, bottom, top, near, far) * M_transpose(vr, vu, vn) * T(-e)
```

This is the correct maths for a window. A symmetric frustum is not: it makes the scene
appear to swing with the phone instead of staying put, which is the tell that gives
away most "3D" phone demos.

Without a face (dark room, phone too far, older device) the eye falls back to a virtual
position `0.34 m` in front of the screen centre, displaced by the device's tilt relative
to gravity:

```
e_fallback = (0.34 * tilt_x, 0.34 * tilt_y, 0.34)
```

so tilting still changes the perspective, just with less fidelity. The transition
between tracked and fallback is blended over `0.5 s` so it never snaps.

Eye position is smoothed with a **1-euro filter** (`f_min = 0.7 Hz, beta = 0.25`)
rather than a fixed low-pass. A fixed filter forces a choice between jitter when still
and lag when moving; the 1-euro filter adapts its cutoff to the speed of motion and
gives neither. Head-tracked displays are unusable without something like this.

---

## 8. Rendering model

Full detail in `docs/ARCHITECTURE.md`; the physical quantities live here.

**Water absorption.** Beer-Lambert with the real absorption coefficients of pure water
at RGB wavelengths (Pope and Fry 1997), in `m^-1`:

```
sigma_a = (0.458, 0.0565, 0.0145)   at 600, 550, 450 nm
```

Over the 0.25 m depth of this tank that is a *very* slight warm-light loss — correctly,
a small tank of clean water is nearly colourless. Aquarium water is not distilled, so a
tint from dissolved organics (yellow, "gelbstoff") is added:
`sigma_a += (0.02, 0.06, 0.16) * tannin`, `tannin = 0.22` by default.

**Scattering.** Suspended particulate: `sigma_s = 0.10 m^-1`, Henyey-Greenstein phase
function with `g = 0.68` (strongly forward-scattering, which is what makes a light beam
visible in water from the side but not from behind).

**Caustics.** Computed, not a looping texture. Each frame a compute pass refracts a
grid of light rays through the water surface using Snell's law at `n = 1.333` and
projects them to the substrate; caustic intensity at a point is the ratio of the
original grid cell area to the deformed cell area (the Jacobian of the refraction map).
Scattered additively into a `256 x 256` map, then blurred `1.5 px`. Because it is
computed from the actual surface, the caustics move correctly when the water sloshes.

**Fish skin.** Layered:
1. GGX specular for the mucus layer, roughness `0.14`.
2. Thin-film interference on the guanine platelets in the scales (Belcour and Barla
   2017), film thickness `380 nm` varying `+/- 90 nm` with a scale-pattern noise, film
   IOR `1.83` (guanine) over a base of `1.40`. This produces the blue-green sheen that
   shifts with angle and is the single most recognisable thing about a betta.
3. Diffuse pigment layer with the scale normal map.
4. Subsurface transmission for the thin parts.

**Fins.** Thin translucent membranes over ray struts. Rendered with a
transmission term: `T = exp(-thickness * sigma_t) * pow(saturate(dot(-L, V)), 8)`, so
they light up when the key light is behind them. Fin thickness is `0.10 mm` at the
membrane and `0.35 mm` at a ray, from the cloth simulation's own geometry.

**Compositing.** The single most important thing for the illusion is that the rendered
tank and the camera image agree on exposure and noise. So:
- Render exposure is driven from `ARFrame.camera.exposureDuration` and the ISO, so the
  virtual light matches the real light meter.
- Ambient light comes from `ARFrame.lightEstimate` (intensity in lumens, colour
  temperature in kelvin), so the fish is lit by the actual room.
- Camera sensor noise is measured from the passthrough frame (temporal variance of a
  low-detail region) and the same amount of grain is applied to the rendered content.
  Clean CG over noisy video is the classic tell.

---

## 9. Determinism

The simulation is deterministic given a seed. All randomness goes through a seeded
PCG32 stream, never the platform RNG, so a seed reproduces a run exactly on both
platforms — which is what makes cross-checking the Swift and TypeScript ports possible
at all. `preview/test/parity.test.ts` records a 60-second state hash that the Swift
side can be checked against.
