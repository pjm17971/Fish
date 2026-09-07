# Probes

These are not tests. They are the instruments the simulation was built with, kept
because they are the record of how each number was arrived at, and because when
something starts behaving oddly the fastest way to find out why is usually to
point one of these at it.

A test answers "is this still right". A probe answers "what is it actually doing",
and prints a table. Run one with `node tools/probe-<name>.mjs` after `npm run
build`. Several of them run a long simulated time and take a minute or two.

| Probe | What it prints |
|---|---|
| `probe-strouhal` | speed, stride and Strouhal number against tail-beat frequency, with a linear fit. The single most useful one — the fit's `R²` against Bainbridge's linear speed-frequency law, and the Strouhal band, are what say whether the swimmer is physical. |
| `probe-speed` | steady speed as a function of the motor command |
| `probe-swim` | a swimming trace: position, attitude, forces per step |
| `probe-thrust` | the three force families separately, so it is visible which one is doing the work |
| `probe-forces` | the same, integrated over a beat cycle |
| `probe-coast` | coast-down from speed, against the drag model's prediction |
| `probe-onset` / `probe-onset2` | how quickly the fish gets moving from rest |
| `probe-burst` | escape burst: peak acceleration and speed |
| `probe-turn` | turning rate and radius against steering command |
| `probe-spin` | angular dynamics in isolation, for the gyroscopic term |
| `probe-inertia` | the mass and inertia tensor the morphology produces |
| `probe-sweep` | a parameter sweep, for finding where something goes non-linear |
| `probe-isolate` | one force family at a time, everything else off |
| `probe-zero` | the fish with no motor command at all — it should sink slowly and do nothing |
| `probe-fin` / `probe-cloth` | fin shape and its response to being dragged |
| `probe-water` | surface: sloshing period, decay, stability margins |
| `probe-feed` / `probe-feedmany` | one feeding attempt, and the success rate over many seeds |
| `probe-close` | close-range strike geometry — mouth position against pellet position |
| `probe-track` | how well the fish holds a heading it has been given |
| `probe-brain` | drives and the chosen intention over a long run |
| `probe-breathe` | air debt building and discharging; long-running |
| `probe-surface` | the approach to the surface, mouth height against water height |
| `probe-finmesh` | the fin *render* meshes: bounding box, longest triangle edge. Written to tell a simulation bug from a rendering one, which it did |
| `probe-finspan` | each fin's chord, span and link lengths, against the shape it is supposed to be |
| `timing.mjs` | milliseconds per simulated step, broken down by subsystem |
