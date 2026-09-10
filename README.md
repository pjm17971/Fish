# A fish tank behind your phone

Hold an iPhone on its side and the screen becomes the front glass of a small
planted aquarium sitting behind it. The rear camera shows the room *through* the
tank, so the phone reads as a pane of glass rather than a picture of one. Tilt or
move your head and the perspective changes the way it would through a real window.
There is one fish. **Double tap to drop food.**

Two programs are in this repository:

- **`ios/`** — the app. Swift, Metal and ARKit.
- **`preview/`** — a desktop version of the same simulation in TypeScript and
  WebGL2, with the test suite. This is where the physics and the behaviour were
  developed and where they are checked.

Both run the same simulation, seeded from the same generator, and produce
identical runs from the same seed.

---

## What "don't fake it" turned into

Nothing about the fish's movement is animated. The tail beat is a muscle command;
the thrust comes out of hydrodynamics; the **speed is a result, not a setting**.
That is what makes it checkable, so it is checked: the test suite asserts against
numbers from the fish-swimming literature rather than against previous output.

The strongest of those checks is the **Strouhal number** — beat frequency times
tail amplitude divided by swimming speed. Animals that swim by flapping converge on
0.2 to 0.4, across an enormous range of body sizes, because that is where the
efficiency is. The fish here lands in that band at every beat frequency tested,
and it does so as the ratio of three quantities computed separately, which is not
something you can arrange by tuning one number.

The same applies to the rest of it:

- The **water's sloshing period** matches the analytic result for a rectangular
  tank, because the wave speed is `√(g·depth)` rather than a number that looked
  right.
- **Food pellets** float, waterlog, and sink at the terminal velocity the standard
  sphere-drag correlation predicts.
- The fish has to **surface for air** every few minutes because a betta has a
  labyrinth organ and genuinely must, and that drive builds with no external cause
  and beats everything else — including fear — when it gets high enough.
- The blue-green on its flanks is **thin-film interference** in the guanine
  platelets of its scales, evaluated per pixel, which is why it shifts as the fish
  turns. It is not a texture, because in a real fish it is not a pigment.
- The **caustics** on the gravel are computed by refracting light through the
  actual simulated surface, so when you tilt the phone and the water sloshes, the
  light on the floor sloshes with it.

`docs/RESEARCH.md` sets out what was surveyed and what was chosen for each part,
with sources. `docs/SIMULATION-SPEC.md` is the numerical model. `docs/ARCHITECTURE.md`
is how the code is arranged.

---

## Running the desktop preview

Requires Node 20 or later and a browser with WebGL2.

```sh
cd preview
npm install
npm start          # builds, then serves on http://localhost:8080
```

Controls:

| | |
|---|---|
| drag | orbit the tank |
| scroll | zoom |
| **double click** | drop food where you clicked |
| `f` | drop food in the middle, when aiming is a nuisance |
| move the mouse near the glass | stands in for the phone's front camera seeing your face |
| `s` | startle the fish |
| `t` | cycle the physiological clock (1x / 30x / 120x / 600x) |
| `space` | pause |
| `h` | hide the readout |
| `?` | help |

That last one is worth trying. Hold the pointer still close to the glass and the
fish will come over and look at you, and then — because it is a male betta and you
are a rival — flare at you until it tires itself out.

The physiological clock is worth knowing about. Hunger really does take about six
hours to build and air debt about seven minutes; at `1x` you will wait. Press `t`
a couple of times and you can watch a whole day of the fish's life in a few
minutes. Only the *drives* are sped up — the physics never is.

To run the tests:

```sh
cd preview
npm test           # 41 tests
```

---

## Building the iPhone app

### What you need

- A Mac with Xcode 15 or later.
- **A real iPhone.** ARKit does not run in the simulator, and neither does the
  camera passthrough the whole thing is built around.
- An iPhone with an **A12 chip or newer** (iPhone XS / XR and later) for the head
  tracking. It runs on older devices, but the perspective then follows the phone's
  tilt rather than your head, which is less convincing.
- iOS 15 or later.

### With XcodeGen (easiest)

```sh
brew install xcodegen
cd ios
xcodegen generate
open Aquarium.xcodeproj
```

Then set your own team and bundle identifier under Signing & Capabilities, pick
your phone, and run.

The `.xcodeproj` is not checked in on purpose: it is a large generated file that
conflicts on nearly every merge and tells a reader almost nothing. `ios/project.yml`
says the same thing in thirty lines.

### Without XcodeGen

1. New Project → iOS → App. Name it `Aquarium`, interface **Storyboard**,
   language **Swift**. Delete the `ViewController.swift`, `Main.storyboard`,
   `SceneDelegate.swift` and `AppDelegate.swift` it creates for you.
2. Drag `ios/Aquarium/Sources` into the project, with **Create groups** selected.
3. Replace the generated `Info.plist` with `ios/Aquarium/Resources/Info.plist`, or
   copy across the `NSCameraUsageDescription` and the landscape-only orientation
   list from it.
4. Three build settings:
   - **Objective-C Bridging Header** → `Aquarium/Sources/Aquarium-Bridging-Header.h`
   - **User Header Search Paths** → `$(SRCROOT)/Aquarium/Sources`
   - Under Info, remove the storyboard entries (`UIMainStoryboardFile` and the
     scene manifest) — the app builds its window in code.

### Getting a good result out of it

- **Hold it in landscape**, roughly at arm's length, screen towards you.
- **Have some light.** ARKit needs texture in the room to track against, and the
  camera image is half of what your eye is judging.
- **Let it settle** for a second or two after launch while world tracking
  initialises. There is a line of text at the bottom if something is wrong.
- **Move your head, not just the phone.** The parallax is the whole effect and
  head movement is what shows it.

---

## What is honestly not right yet

Stated plainly, because the brief was "don't fake it" and that has to include
saying what is faked or missing.

**This was watched, late.** For a long time every test passed and the fish
bobbed up and down on the spot, turned away from its targets, and could not
turn round. `docs/SIMULATION-SPEC.md` §0 lists the eight things that were
wrong, all of the kind that pass a test and fail an eye. The tests now include
one that asks where the fish went.

**The Swift code has never been compiled.** It was written in an environment with
no Swift toolchain — Linux, no Xcode. Every constant has been checked against the
TypeScript version programmatically, every shader entry point and uniform field
cross-checked against the header, and every configuration reference verified to
resolve; two real divergences were found that way and fixed. But none of that is
the same as a compiler, and you should expect to fix some build errors the first
time through. The simulation *logic* is the part that has been tested hard, and
it has been tested in the other language.

**The passthrough is from the camera's viewpoint, not your eye.** What you see
through the tank is nearly, but not exactly, what you would see if the phone were
a hole. At arm's length, against a room a few metres away, the error is a few
degrees. It would matter for something close behind the phone. Fixing it properly
needs depth and a reprojection.

**Turning is slow.** A routine turn on the spot runs at about 20 degrees a
second on a radius near 10 cm, in a tank 35 cm wide. That is set by physics the
model gets right: the fish's own yaw inertia is small, but the water its flanks
and 5 cm fins must shove sideways to rotate is thirty-five times larger. Real
long-finned bettas are sluggish turners for the same reason, though not quite
this sluggish; the difference is that a real one bends further into the turn
than this model's routine turn allows itself.

**Strikes are fast.** The lunge at a pellet briefly reaches eight to twelve body
lengths a second. Real suction strikes are fast too, but this is at the upper
end and it shows.

**The swimmer is about 15 to 20 per cent too efficient.** There is no
vortex-shedding loss in the model and the boundary layer is treated as entirely
laminar. The fish therefore reaches a given speed at a slightly lower tail-beat
frequency than a real betta would. Everything downstream of that is right; the
fish is just a slightly better swimmer than it should be.

**Turning radius is at the high end.** Several body lengths. A long-finned betta
dragging that much fin area genuinely does turn slowly, but this is at the wide
end of plausible rather than the middle of it.

**Feeding does not always work.** The fish finds and eats the food in most runs
but not every one. Real fish miss constantly, and the missing is a good part of
what makes feeding look alive, so this is only partly a defect — but the strike
geometry is at the edge of reliable and it could be better.

**One fish, one tank, and the plants do not move.** All three were in scope for
"start with one fish" and none of them are hard to extend; they are just not done.
