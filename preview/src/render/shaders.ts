/**
 * Shaders.
 *
 * The physically interesting ones are the fish skin (thin-film interference over
 * a scattering base), the fins (thin translucent membrane over stiffer rays),
 * the water volume (Beer-Lambert absorption with the real coefficients for
 * water), and the caustics, which are computed from the actual surface rather
 * than played back from a texture.
 *
 * These are written for WebGL2/GLSL ES 3.00. The Metal versions in the iOS app
 * are ports of the same maths; where a constant appears in both, it comes from
 * OPTICS in config.ts.
 */

import { TANK } from '../sim/config.js';
import { TANK_BOTTOM_Y, LAMP_Y, LAMP_HALF_DEPTH, DESK, ROOM } from './scenery.js';

/** A number as a GLSL float literal. */
const f = (x: number): string => (Number.isInteger(x) ? `${x}.0` : `${x}`);

// ---------------------------------------------------------------------------
// Shared chunks
// ---------------------------------------------------------------------------

const COMMON = /* glsl */ `
precision highp float;

const float PI = 3.141592653589793;

// Absorption coefficients of pure water at 600 / 550 / 450 nm, per metre
// (Pope & Fry 1997), plus a tint from dissolved organics. Over the quarter-metre
// of this tank that is a very slight warm-light loss, which is correct — a small
// tank of clean water is very nearly colourless, and pushing it towards the
// postcard blue-green of open ocean is one of the quickest ways to make an
// aquarium look fake.
uniform vec3 uAbsorption;
uniform float uScattering;
uniform vec3 uWaterTint;

uniform vec3 uLightDir;      // towards the light
uniform vec3 uLightColour;
uniform vec3 uAmbient;
uniform float uExposure;

// The box the water occupies: (minX, floorY, minZ) to (maxX, waterY, maxZ).
uniform vec3 uWaterMin;
uniform vec3 uWaterMax;
// Index of refraction applied to geometry seen through the tank's panes, or
// 1.0 to draw geometry where it really is (the reflection pass does that).
uniform float uRefractIOR;
// Reflection-pass clipping: +1 keeps fragments above the water, -1 below,
// 0 keeps everything.
uniform float uClipSide;

// The light a flat surface gets, multiplied by this: 1.0 where the surface is
// flat, brighter where rays converge, darker where they spread. The caustic map
// is in exactly those units (see CAUSTICS_FRAG), so no calibration is needed.
float causticLight(float raw, float strength) {
  return mix(1.0, raw, strength);
}

// The room above the tank, for the surface to reflect. The room is drawn
// (scenery.ts), but reflections are not traced through it, so this is an
// analytic stand-in for it: a dark ceiling, and the hood lamp — a warm
// strip above the tank — which is what a real aquarium surface reflects, as a
// bright stretched streak that breaks up with every ripple.
vec3 envRoom(vec3 dir) {
  // A lit room: a wall across from the tank, brighter towards the ceiling, so
  // that from a low viewing angle the surface has something to reflect. Made
  // near-black the first time, and from eye level the surface simply vanished.
  vec3 room = mix(vec3(0.07, 0.075, 0.085), vec3(0.24, 0.25, 0.27), clamp(dir.y * 0.8 + 0.4, 0.0, 1.0));
  // The wall behind the viewer, with a window or a lamp on it: a broad soft
  // glow in the direction the surface reflects when looked at from the front
  // and a little above. This is what the surface of a tank on a desk shows.
  float win = max(0.0, dot(dir, normalize(vec3(0.0, 0.45, 1.0))));
  room += vec3(0.9, 0.88, 0.85) * pow(win, 6.0) * 0.55;
  return room;
}

vec3 envColour(vec3 from, vec3 dir) {
  vec3 room = envRoom(dir);
  if (dir.y <= 1e-4) return room;
  float lampY = uWaterMax.y + 0.16;
  float t = (lampY - from.y) / dir.y;
  vec3 hit = from + dir * t;
  // The lamp: a strip nearly the width of the tank, over its middle. The
  // room mesh draws the same lamp (scenery.ts), so what the surface reflects
  // is what is hanging there.
  float inX = smoothstep(0.004, 0.0, abs(hit.x) - uWaterMax.x * 0.9);
  float inZ = smoothstep(0.004, 0.0, abs(hit.z - (uWaterMin.z + uWaterMax.z) * 0.5) - ${f(LAMP_HALF_DEPTH)});
  vec3 lamp = vec3(1.0, 0.94, 0.82) * 2.6;
  return room + lamp * inX * inZ;
}

// Beer-Lambert: what survives a path of the given length through the water.
vec3 transmittance(float pathLength) {
  return exp(-uAbsorption * pathLength);
}

// Schlick's approximation to the Fresnel reflectance.
float fresnelSchlick(float cosTheta, float f0) {
  float m = clamp(1.0 - cosTheta, 0.0, 1.0);
  float m2 = m * m;
  return f0 + (1.0 - f0) * m2 * m2 * m;
}

vec3 fresnelSchlick3(float cosTheta, vec3 f0) {
  float m = clamp(1.0 - cosTheta, 0.0, 1.0);
  float m2 = m * m;
  return f0 + (1.0 - f0) * m2 * m2 * m;
}

// GGX / Trowbridge-Reitz normal distribution.
float distributionGGX(float NdotH, float roughness) {
  float a = roughness * roughness;
  float a2 = a * a;
  float d = NdotH * NdotH * (a2 - 1.0) + 1.0;
  return a2 / max(1e-7, PI * d * d);
}

float geometrySmith(float NdotV, float NdotL, float roughness) {
  float r = roughness + 1.0;
  float k = (r * r) / 8.0;
  float gv = NdotV / (NdotV * (1.0 - k) + k);
  float gl = NdotL / (NdotL * (1.0 - k) + k);
  return gv * gl;
}

// Henyey-Greenstein phase function. g = 0.68 here, strongly forward-scattering,
// which is why a beam in water is visible from the side but not from behind.
float phaseHG(float cosTheta, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5));
}

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float hash31(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.x + p.y) * p.z);
}

float noise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash31(i), hash31(i + vec3(1, 0, 0)), f.x),
        mix(hash31(i + vec3(0, 1, 0)), hash31(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(hash31(i + vec3(0, 0, 1)), hash31(i + vec3(1, 0, 1)), f.x),
        mix(hash31(i + vec3(0, 1, 1)), hash31(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}

// Filmic tone mapping (Hejl-Burgess-Dawson), which keeps highlights from
// clipping to flat white the way a plain clamp does.
vec3 tonemap(vec3 x) {
  x = max(vec3(0.0), x - 0.004);
  return (x * (6.2 * x + 0.5)) / (x * (6.2 * x + 1.7) + 0.06);
}
`;

/**
 * Refraction at the tank's panes: where a point under water *appears* to be.
 *
 * Light from a point inside the tank bends where it leaves the water, so the
 * eye sees the point along a different line from the straight one. That is why
 * a tank 25 cm deep looks about 19 cm deep from the front, why the fish looks
 * bigger and nearer than it is, why the back wall swings towards you and the
 * tank seems to flatten as you walk round it, and why a stem crossing the
 * waterline looks broken. It is one of the strongest cues that there is water
 * behind the glass rather than air.
 *
 * For each vertex this finds the real path: the point S on the pane where a ray
 * from the eye, bent by Snell's law, reaches the vertex. The vertex is then
 * drawn on the straight line from the eye through S, which is where the eye
 * sees it. Along that line it is placed |P - S| / n beyond the pane, which is
 * the textbook apparent depth when looking straight in, and which lets the
 * volume pass recover the true length of the underwater path by multiplying
 * back by n.
 *
 * **One pane per pass.** The eye can see into the water through up to three
 * panes at once — the front, a side, the top — and near the edge between two
 * of them the same object is seen through both, in two different places.
 * That is real: it is why a fish at the corner of a tank shows up twice. So
 * the scene is drawn once for each pane the eye can see (uPane), with every
 * vertex bent through that one pane, and each fragment is kept only where its
 * line of sight really does cross that pane (PANE_CLIP). Choosing a pane per
 * vertex instead stretches any triangle whose corners choose different panes
 * across the whole gap between the two images, which was tried first and
 * smeared the fish into a streak when seen from above. The test is made per
 * fragment, from its true position, because made per vertex and blended
 * across each triangle it left gaps and saw-teeth along the tank's edges.
 * What is not in the water at all is drawn once more, where it is, in a pass
 * of its own (uPane zero), and that split at the waterline is a real one too.
 *
 * The panes are treated as flat: the glass is, and the top is flat until it
 * ripples, which the surface shader adds on top. The glass itself is a
 * parallel sheet a few millimetres thick and barely shifts anything, so it is
 * left out.
 *
 * An earlier version shortened the path *along* the straight line of sight,
 * which moves a point towards the eye without moving it on screen at all.
 *
 * render/refraction.ts is the same calculation in TypeScript, which is what the
 * tests check. Change one, change the other.
 *
 * Needs uCameraPos, uWaterMin, uWaterMax and uRefractIOR declared.
 */
const APPARENT_POSITION = /* glsl */ `
// The pane this pass looks through, as its outward normal — one of the six
// axis directions — or zero in the pass that draws what is out of the water.
uniform vec3 uPane;
// How far above the still waterline a point still counts as in the water:
// 0 for the scene, a ripple's height for the surface mesh.
uniform float uTopSlack;

// Where p is drawn in this pass. inPane comes back positive where this pass
// sees p and negative where it does not: where its line of sight crosses the
// plane of the pane outside the pane's edges, or where p is out of the water
// (in a pane's pass) or in it (in the pass for what is not).
vec3 throughPane(vec3 p, out float inPane) {
  inPane = 1.0;
  if (uRefractIOR <= 1.0) return p;
  float n = uRefractIOR;
  vec3 e = uCameraPos;

  // How far p is outside the water; negative inside. The walls lie exactly on
  // the sides of the box, so those get a millimetre of grace, and the ripples
  // in the sand dip a few millimetres below the floor line, so that gets a
  // centimetre. The top gets the surface's slack.
  vec3 lo = uWaterMin - vec3(1e-3, 1e-2, 1e-3);
  vec3 hi = vec3(uWaterMax.x + 1e-3, uWaterMax.y + uTopSlack, uWaterMax.z + 1e-3);
  vec3 out3 = max(lo - p, p - hi);
  float dry = max(max(out3.x, out3.y), out3.z);
  if (dot(uPane, uPane) < 0.5) {
    inPane = dry;
    return p;
  }

  vec3 N = uPane;
  vec3 onPane = mix(uWaterMin, uWaterMax, step(0.0, N.x + N.y + N.z));
  float hE = dot(e - onPane, N);              // eye in front of the pane
  float hP = dot(onPane - p, N);              // point behind it

  vec3 s = p - N * dot(p - onPane, N);        // where the ray crosses the pane
  vec3 apparent = p;
  if (hE > 0.0 && hP > 1e-6) {
    // Distance along the pane between the eye and the point, and the direction.
    vec3 d = p - e;
    vec3 lat = d - dot(d, N) * N;
    float L = length(lat);
    vec3 u = lat / max(L, 1e-9);

    // Find how far along, x, the ray crosses the pane: Snell's law says
    //   x / |ES| = n (L - x) / |SP|.
    // The difference of the two sides rises steadily from x = 0 to x = L, so
    // there is exactly one crossing. Newton's method, starting from the
    // small-angle answer and falling back to halving the bracket whenever a
    // step would leave it. Sixteen steps lands within a micron of the exact
    // crossing from anywhere the camera can be, including an eye a fraction of
    // a millimetre off the plane of a pane; eight were out by millimetres there.
    float xlo = 0.0;
    float xhi = L;
    float x = L * hE / (hE + hP / n);
    for (int i = 0; i < 16; i++) {
      float a = sqrt(x * x + hE * hE);
      float b = sqrt((L - x) * (L - x) + hP * hP);
      float f = x / a - n * (L - x) / b;
      if (f > 0.0) xhi = x; else xlo = x;
      float slope = hE * hE / (a * a * a) + n * hP * hP / (b * b * b);
      float next = x - f / slope;
      x = (next >= xlo && next <= xhi) ? next : 0.5 * (xlo + xhi);
    }
    s = e + u * x - N * hE;
    apparent = s + normalize(s - e) * (length(p - s) / n);
  }

  // How far inside the pane's edges the crossing is, ignoring the pane's own
  // axis, and no further in than p is in the water.
  vec3 edge = mix(min(s - lo, hi - s), vec3(1.0), abs(N));
  inPane = min(min(edge.x, edge.y), min(edge.z, -dry));
  return apparent;
}

vec3 apparentPosition(vec3 p) {
  float inPane;
  return throughPane(p, inPane);
}
`;

/**
 * For fragment shaders: whether this pass is the one that sees a point, from
 * the point's true position. See APPARENT_POSITION.
 */
const PANE_CLIP = /* glsl */ `
uniform vec3 uCameraPos;
${APPARENT_POSITION}
bool seenThroughThisPane(vec3 p) {
  float inPane;
  throughPane(p, inPane);
  return inPane >= 0.0;
}
`;

/**
 * Thin-film interference.
 *
 * This is what a betta's colour actually is. The scales contain stacked guanine
 * platelets a few hundred nanometres thick, and light reflecting off the front
 * and back of each platelet interferes with itself. Which wavelengths reinforce
 * depends on the film's thickness and on the viewing angle, which is why the
 * colour slides from blue to green to violet as the fish turns — and why a plain
 * coloured texture, however well painted, never looks like the animal.
 *
 * Evaluated per-channel at representative wavelengths rather than spectrally.
 * That is an approximation, but the visible behaviour it needs to get right is
 * the *shift with angle*, and that it does exactly.
 */
const THIN_FILM = /* glsl */ `
uniform float uFilmThickness;   // nanometres
uniform float uFilmIOR;
uniform float uBaseIOR;

vec3 thinFilm(float cosTheta, float thicknessNm) {
  // Refracted angle inside the film, from Snell's law.
  float sinTheta2 = (1.0 - cosTheta * cosTheta) / (uFilmIOR * uFilmIOR);
  if (sinTheta2 >= 1.0) return vec3(1.0);          // total internal reflection
  float cosThetaFilm = sqrt(1.0 - sinTheta2);

  // Optical path difference between the two reflections, in nanometres.
  float opd = 2.0 * uFilmIOR * thicknessNm * cosThetaFilm;

  // Reflectance at the two interfaces.
  float r1 = fresnelSchlick(cosTheta, pow((1.0 - uFilmIOR) / (1.0 + uFilmIOR), 2.0));
  float r2 = fresnelSchlick(cosThetaFilm,
    pow((uFilmIOR - uBaseIOR) / (uFilmIOR + uBaseIOR), 2.0));

  // Representative wavelengths for the three channels.
  vec3 lambda = vec3(612.0, 549.0, 465.0);
  vec3 phase = 2.0 * PI * opd / lambda;
  // Two-beam interference. There is a further pi of phase shift at the first
  // interface because the film is denser than the medium above it, which is
  // what puts the first constructive band where it belongs.
  vec3 interference = r1 + r2 + 2.0 * sqrt(r1 * r2) * cos(phase + PI);
  return clamp(interference, 0.0, 1.0);
}
`;

/**
 * Reading the simulated surface smoothly.
 *
 * The water is simulated on a grid 4.4 mm apart, and the texture holds the
 * height and the two slopes at each node. Interpolating slopes linearly
 * between nodes makes their rate of change — the surface's curvature — jump at
 * every grid line, and the caustics are made of exactly that curvature: the
 * light on the sand came out in 4 mm tiles. Catmull-Rom interpolation keeps
 * the slope and its rate of change continuous, so the pattern is as smooth as
 * the water.
 */
const SURFACE_SAMPLE = /* glsl */ `
vec4 catmullRomWeights(float t) {
  float t2 = t * t, t3 = t2 * t;
  return vec4(
    -0.5 * t3 + t2 - 0.5 * t,
     1.5 * t3 - 2.5 * t2 + 1.0,
    -1.5 * t3 + 2.0 * t2 + 0.5 * t,
     0.5 * t3 - 0.5 * t2
  );
}

// (height, dh/dx, dh/dz) at a point given in grid units (node i at i).
vec3 surfaceAt(sampler2D map, vec2 cell) {
  ivec2 size = textureSize(map, 0);
  vec2 base = floor(cell);
  vec2 f = cell - base;
  vec4 wx = catmullRomWeights(f.x);
  vec4 wz = catmullRomWeights(f.y);
  vec3 sum = vec3(0.0);
  for (int j = 0; j < 4; j++) {
    vec3 row = vec3(0.0);
    for (int i = 0; i < 4; i++) {
      ivec2 p = clamp(ivec2(base) + ivec2(i - 1, j - 1), ivec2(0), size - 1);
      row += texelFetch(map, p, 0).rgb * wx[i];
    }
    sum += row * wz[j];
  }
  return sum;
}
`;

/**
 * Shadows.
 *
 * The tank light, after it has bent at the water surface, is rendered as a
 * depth map looking straight down along the light (the shadow map). A point is
 * in shadow when something sits between it and the light in that map.
 *
 * The edge of a shadow is sharp next to the thing casting it and softens with
 * distance, because the lamp is not a point: seen from the sand it covers a
 * small angle, and part of it is still visible just inside the shadow's edge.
 * That is what tells the eye how far above the sand a fish is, and it is the
 * main reason a fish with a hard-edged shadow still looks pasted on. So the
 * shadow is sampled in two steps: first find how far above the point the
 * blockers are, then blur the shadow by the width that distance and the lamp's
 * size give.
 *
 * Fins are thin and see-through, so they get a map of their own that holds the
 * light that gets *through* them — tinted by the pigment — rather than a yes or
 * no. A betta's fins cast red-tinged shade, not black.
 *
 * Underwater there is also a lot of light arriving from every direction above
 * — light scattered by the water and bounced off the glass. That fills
 * shadows in, but it is itself blocked by anything overhanging. The same map,
 * sampled very widely, stands in for how much of the sky above a point is
 * covered, which is what darkens the sand under a resting fish and at the foot
 * of a plant.
 */
const SHADOW = /* glsl */ `
uniform sampler2D uShadowMap;       // depth of the opaque things, seen from the light
uniform highp sampler2DShadow uShadowCompare;  // the same depth, read through a comparing, filtering sampler
uniform sampler2D uFinShadow;       // rgb: light through the fins; a: 1 - depth of the topmost fin
uniform mat4 uLightViewProjection;
uniform vec3 uLightDirWater;        // towards the light, after refraction at the surface
uniform vec2 uShadowExtent;         // metres covered by the map in x and y
uniform float uShadowDepthRange;    // metres covered by depth 0 to 1
uniform float uLightAngle;          // the lamp's angular radius, as seen from the water

const vec2 POISSON[16] = vec2[16](
  vec2(-0.94201624, -0.39906216), vec2(0.94558609, -0.76890725),
  vec2(-0.09418410, -0.92938870), vec2(0.34495938, 0.29387760),
  vec2(-0.91588581, 0.45771432), vec2(-0.81544232, -0.87912464),
  vec2(-0.38277543, 0.27676845), vec2(0.97484398, 0.75648379),
  vec2(0.44323325, -0.97511554), vec2(0.53742981, -0.47373420),
  vec2(-0.26496911, -0.41893023), vec2(0.79197514, 0.19090188),
  vec2(-0.24188840, 0.99706507), vec2(-0.81409955, 0.91437590),
  vec2(0.19984126, 0.78641367), vec2(0.14383161, -0.14100790)
);

vec3 lightSpace(vec3 p) {
  vec4 c = uLightViewProjection * vec4(p, 1.0);
  return c.xyz / c.w * 0.5 + 0.5;
}

// A rotation per pixel, so the handful of taps do not line up into visible
// copies of the shadow.
mat2 tapRotation() {
  float a = 6.2831853 * fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float c = cos(a), s = sin(a);
  return mat2(c, s, -s, c);
}

// How much of the tank light reaches this point, as a colour: 1 in full light,
// 0 in full shadow, and tinted where it came through a fin.
vec3 lightVisibility(vec3 worldPos, vec3 N) {
  // Push the lookup a little off the surface, towards the light, so a surface
  // does not shadow itself.
  vec3 n = dot(N, uLightDirWater) < 0.0 ? -N : N;
  vec3 ls = lightSpace(worldPos + n * 0.0006);
  if (any(lessThan(ls.xy, vec2(0.0))) || any(greaterThan(ls.xy, vec2(1.0)))) return vec3(1.0);
  float bias = 0.0008 / uShadowDepthRange;
  float receiver = ls.z - bias;
  mat2 rot = tapRotation();
  vec2 metresToUV = 1.0 / uShadowExtent;

  // 1. Blockers: how far above this point is whatever is in the way?
  float searchRadius = 0.008;
  float blockerSum = 0.0;
  float blockers = 0.0;
  for (int i = 0; i < 16; i += 2) {
    vec2 uv = ls.xy + rot * POISSON[i] * searchRadius * metresToUV;
    float d = texture(uShadowMap, uv).r;
    if (d < receiver) { blockerSum += d; blockers += 1.0; }
  }
  // The same for the fins, which live in their own map.
  vec4 finCentre = texture(uFinShadow, ls.xy);
  float finDepth = 1.0 - finCentre.a;
  float gap = 0.0;
  if (blockers > 0.0) gap = (receiver - blockerSum / blockers) * uShadowDepthRange;
  else if (finDepth < receiver) gap = (receiver - finDepth) * uShadowDepthRange;
  else return vec3(1.0);

  // 2. The penumbra that gap gives, with a floor for the scattering in the
  // water, which softens even a contact shadow slightly.
  float penumbra = clamp(2.0 * gap * uLightAngle + 0.0007, 0.0007, 0.012);
  float lit = 0.0;
  vec3 through = vec3(0.0);
  for (int i = 0; i < 16; i++) {
    vec2 uv = ls.xy + rot * POISSON[i] * penumbra * metresToUV;
    lit += texture(uShadowCompare, vec3(uv, receiver));
    vec4 fin = texture(uFinShadow, uv);
    through += (1.0 - fin.a) < receiver ? fin.rgb : vec3(1.0);
  }
  return (lit / 16.0) * (through / 16.0);
}

// How much of the bright water above a point is open rather than covered by
// something overhanging. Ambient light underwater mostly comes from above.
float skyVisibility(vec3 worldPos, vec3 N) {
  vec3 ls = lightSpace(worldPos + N * 0.001);
  if (any(lessThan(ls.xy, vec2(0.0))) || any(greaterThan(ls.xy, vec2(1.0)))) return 1.0;
  mat2 rot = tapRotation();
  vec2 metresToUV = 1.0 / uShadowExtent;
  float open = 0.0;
  for (int i = 1; i < 16; i += 2) {
    // Two rings, near and far, so both a close overhang and a broad one count.
    float r = (i < 8 ? 0.010 : 0.022);
    vec2 uv = ls.xy + rot * POISSON[i] * r * metresToUV;
    float d = texture(uShadowMap, uv).r;
    // Something a long way above blocks less of the sky than something close.
    float height = (ls.z - d) * uShadowDepthRange;
    open += height > 0.002 ? smoothstep(0.004, 0.09, height) : 1.0;
  }
  return open / 8.0;
}
`;

// ---------------------------------------------------------------------------
// Scene: body, fins, tank, plants
// ---------------------------------------------------------------------------

export const SCENE_VERT = /* glsl */ `#version 300 es
${COMMON}

// Fixed locations, because the same vertex buffers are drawn by more than one
// program — the shaded pass and the shadow pass — and a vertex array only
// remembers locations, not names.
layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUV;
layout(location = 3) in vec2 aExtra;

uniform mat4 uViewProjection;
uniform vec3 uCameraPos;

out vec3 vWorldPos;
out vec3 vNormal;
out vec2 vUV;
out vec2 vExtra;
out vec3 vView;

// 1 while drawing the plants, whose aExtra.y is how far each vertex sways.
uniform float uSway;
uniform float uTime;

${APPARENT_POSITION}

// Plants moving in the filter's current.
//
// Kinematic, not simulated: nothing here solves for the flow or for the
// stems' stiffness, and the fish's own wake does not reach them. It is a
// steady lean downstream, a slow swing whose phase travels across the tank
// with the current (so neighbouring plants move together, a beat apart, as
// they do in a real tank rather than each on its own), and a faster flutter
// that runs up the length of a leaf. Each vertex's weight grows with the
// square of its distance from the root, which is roughly how a flexible stem
// fixed at one end deflects.
vec3 swayOffset(vec3 p, float w) {
  float travel = p.x * 18.0 - p.z * 7.0;
  float t = uTime;
  vec2 lean = vec2(0.40, 0.15);
  vec2 swing = vec2(sin(t * 1.35 - travel), 0.55 * sin(t * 1.05 - travel * 0.8 + 1.7));
  vec2 flutter = 0.22 * vec2(sin(t * 3.7 + p.y * 900.0 + travel * 2.3), cos(t * 3.1 + p.y * 700.0));
  vec2 d = (lean + swing + flutter) * w * 0.7;
  return vec3(d.x, 0.0, d.y);
}

void main() {
  vec3 p = aPosition;
  if (uSway > 0.5) p += swayOffset(aPosition, aExtra.y);
  vWorldPos = p;
  vNormal = normalize(aNormal);
  vUV = aUV;
  vExtra = aExtra;
  vView = normalize(uCameraPos - p);
  gl_Position = uViewProjection * vec4(apparentPosition(p), 1.0);
}
`;

/**
 * The fish's skin.
 *
 * Four layers, in the order light meets them:
 *   1. a thin specular mucus coat,
 *   2. thin-film interference in the guanine platelets of the scales,
 *   3. the pigment layer, with the scales laid over it,
 *   4. subsurface scattering, which is what stops thin parts reading as plastic.
 *
 * Plus the head, which has no scales: an eye, the edge of the gill cover, and
 * the mouth. Without an eye nothing reads as an animal, however good the rest
 * of the shading is.
 *
 * Positions on the skin come in as millimetres (see meshes.ts), so the scales
 * and the eye keep their real size wherever they are on the body.
 */
export const FISH_FRAG = /* glsl */ `#version 300 es
${COMMON}
${THIN_FILM}
${SHADOW}

in vec3 vWorldPos;
in vec3 vNormal;
in vec2 vUV;
in vec2 vExtra;
in vec3 vView;
${PANE_CLIP}

uniform sampler2D uCaustics;
uniform float uWaterY;
uniform vec3 uBaseColour;
uniform vec3 uBellyColour;
uniform float uRoughness;
uniform vec2 uCausticsExtent;   // tank half-width, depth
uniform float uTime;

out vec4 fragColour;

// Where the eye sits: millimetres back from the snout, height above the
// centreline, and radius. A betta's eye is large, about a sixteenth of its
// body length across, and set high and far forward.
const vec3 EYE = vec3(4.9, 1.5, 1.35);
// Where the gill cover's edge crosses the centreline, in millimetres from the
// snout. The head in front of it has no scales.
const float GILL_ARC = 9.4;
// Size of one scale, in millimetres: about thirty along the flank, as a
// betta has.
const float SCALE_MM = 1.1;

// Directions on the surface in which the two coordinates of \`uv\` increase,
// found from how they change across the pixel. Saves carrying a tangent frame
// in every vertex for something the rasteriser already knows.
void surfaceFrame(vec3 N, vec2 uv, out vec3 T, out vec3 B) {
  vec3 dp1 = dFdx(vWorldPos);
  vec3 dp2 = dFdy(vWorldPos);
  vec2 duv1 = dFdx(uv);
  vec2 duv2 = dFdy(uv);
  vec3 dp2perp = cross(dp2, N);
  vec3 dp1perp = cross(N, dp1);
  T = dp2perp * duv1.x + dp1perp * duv2.x;
  B = dp2perp * duv1.y + dp1perp * duv2.y;
  T = normalize(T + vec3(1e-9));
  B = normalize(B + vec3(1e-9));
}

void main() {
  if ((vWorldPos.y - uWaterY) * uClipSide < 0.0) discard;
  // Only where this pass's pane is the one the eye sees it through; see
  // APPARENT_POSITION.
  if (!seenThroughThisPane(vWorldPos)) discard;
  vec3 N0 = normalize(vNormal);
  vec3 N = N0;
  vec3 V = normalize(vView);
  vec3 L = normalize(uLightDir);

  float around = vUV.x;     // mm round from the top of the back
  float arcMm = vUV.y;      // mm back from the snout
  float along = vExtra.x;   // fraction of body length
  float height = vExtra.y;  // mm above the centreline

  vec3 Tu, Tarc;
  surfaceFrame(N0, vec2(around, arcMm), Tu, Tarc);

  // --- Scales ---
  //
  // Staggered rows of round scales, each overlapping the one behind it, so
  // what shows of each is its rounded rear edge — the pattern that reads as
  // "fish". Found by testing the scales around this point from the front
  // backwards and keeping the first that covers it, since the front one lies
  // on top. The centres are nudged a little at random so the rows never line
  // up into a grid.
  //
  // What the eye picks up is not the scale but the fine curved shadow just
  // behind the rim of the scale in front, so that is all that is drawn in the
  // pigment: a thin arc, and a gentle lightening towards each scale's exposed
  // rear. Outlining every scale, or colouring each one separately, is what
  // turns a flank into floor tiles.
  vec2 g = vec2(around, arcMm) / SCALE_MM;
  float row0 = floor(g.y);
  vec2 rel = vec2(0.0);
  vec2 cellId = vec2(0.0);
  float chosenRow = row0;
  for (int k = -1; k <= 1; k++) {
    float row = row0 + float(k);
    float shift = 0.5 * mod(row, 2.0);
    float col = floor(g.x - shift + 0.5);
    vec2 c = vec2(col + shift, row);
    c += (vec2(hash21(c), hash21(c + 17.3)) - 0.5) * 0.14;
    vec2 dv = (g - c) / 0.74;
    if (dot(dv, dv) < 1.0) { rel = dv; cellId = c; chosenRow = row; break; }
  }
  // Distance past the rims of the row in front, in scale radii.
  float pastRim = 1.0;
  {
    float row = chosenRow - 1.0;
    float shift = 0.5 * mod(row, 2.0);
    float col = floor(g.x - shift);
    for (int m = 0; m <= 1; m++) {
      vec2 c = vec2(col + float(m) + shift, row);
      c += (vec2(hash21(c), hash21(c + 17.3)) - 0.5) * 0.14;
      pastRim = min(pastRim, length(g - c) / 0.74 - 1.0);
    }
  }
  // Scales smaller than a couple of pixels would only alias into a moiré, so
  // the pattern fades out with distance; the head in front of the gill cover
  // has none.
  float footprint = max(fwidth(g.x), fwidth(g.y));
  float scaleVis = (1.0 - smoothstep(0.1, 0.35, footprint))
                 * smoothstep(GILL_ARC - 0.5, GILL_ARC + 2.5, arcMm);
  float scaleJitter = hash21(cellId) - 0.5;
  float aaRim = footprint * 2.0 / 0.74 + 0.02;
  float rimShadow = 1.0 - smoothstep(0.0, 0.07 + aaRim, max(0.0, pastRim));
  float exposed = smoothstep(-0.7, 0.9, rel.y);
  // Each scale is a slightly domed plate, tilted so its rear edge lifts.
  N = normalize(N + (Tu * rel.x + Tarc * (rel.y + 0.3)) * 0.07 * scaleVis);

  // --- Eye ---
  float eyeD = length(vec2(arcMm - EYE.x, height - EYE.y)) / EYE.z;
  float eyeMask = 1.0 - smoothstep(0.96, 1.04, eyeD);
  vec3 eyeN = N;
  if (eyeD < 1.0) {
    // A domed cornea: the normal leans out towards the rim.
    vec2 e = vec2(arcMm - EYE.x, height - EYE.y) / EYE.z;
    vec3 Ea, Eh;
    surfaceFrame(N0, vec2(arcMm, height), Ea, Eh);
    eyeN = normalize(N0 * sqrt(max(0.0, 1.0 - dot(e, e) * 0.6)) + (Ea * e.x + Eh * e.y) * 0.55);
  }

  float NdotV = max(dot(N, V), 1e-4);
  float NdotL = max(dot(N, L), 0.0);
  vec3 H = normalize(V + L);
  float NdotH = max(dot(N, H), 0.0);

  // --- Thin-film iridescence ---
  float thickness = uFilmThickness + scaleJitter * 25.0 * scaleVis
    + 40.0 * sin(along * 9.0 + uTime * 0.05);
  vec3 iridescence = thinFilm(NdotV, thickness);

  // --- Pigment ---
  //
  // Darker along the back, paler on the belly. Countershading is nearly
  // universal in fish and its absence is immediately readable, even to someone
  // who has never thought about why.
  float ventral = smoothstep(-0.2, 0.9, -N0.y);
  float dorsal = smoothstep(0.3, 1.0, N0.y);
  vec3 albedo = mix(uBaseColour, uBellyColour, ventral * 0.75);
  albedo *= 1.0 - dorsal * 0.35;
  // The head is a shade darker than the flank.
  albedo *= mix(0.88, 1.0, smoothstep(GILL_ARC - 6.0, GILL_ARC + 4.0, arcMm));
  albedo *= 1.0 - (rimShadow * 0.22 + (1.0 - exposed) * 0.08) * scaleVis;

  // The gill cover's edge: a curve that sweeps back above and below the
  // middle, drawn as the shadow under the lip of the flap.
  float gillEdge = GILL_ARC + 0.05 * height * height;
  float gill = (1.0 - smoothstep(0.0, 0.28, abs(arcMm - gillEdge - 0.15)))
             * (1.0 - smoothstep(3.2, 4.4, abs(height)));
  albedo *= 1.0 - gill * 0.45;

  // The mouth: a short upturned gape at the tip of the snout.
  float mouthLine = abs(height - (1.05 - 0.4 * arcMm));
  float mouth = (1.0 - smoothstep(0.05, 0.16, mouthLine)) * (1.0 - smoothstep(1.1, 1.5, arcMm));
  albedo *= 1.0 - mouth * 0.7;

  // The head is less iridescent than the flank, as it is on the real animal,
  // and the scales flash individually, strongest at their rims.
  float irisMask = mix(0.45, 1.0, smoothstep(0.08, 0.3, along)) * (0.7 + 0.3 * scaleVis * (exposed + 0.5 * scaleJitter - rimShadow));

  // --- Direct lighting ---
  float D = distributionGGX(NdotH, uRoughness);
  float G = geometrySmith(NdotV, NdotL, uRoughness);
  vec3 F = fresnelSchlick3(max(dot(H, V), 0.0), vec3(0.04));
  vec3 specular = (D * G * F) / max(1e-4, 4.0 * NdotV * NdotL + 1e-4);

  // --- Caustics ---
  //
  // The dappled light from the surface falls on the fish too, not only on the
  // sand. Leaving it off the animal is a common omission and it quietly
  // separates the fish from the scene it is swimming in.
  vec2 cuv = vec2(
    (vWorldPos.x + uCausticsExtent.x) / (2.0 * uCausticsExtent.x),
    (vWorldPos.z + uCausticsExtent.y) / uCausticsExtent.y
  );
  float depthBelow = max(0.0, uWaterY - vWorldPos.y);
  // Only lit surfaces catch it, and less so the deeper they are.
  float causticMod = causticLight(texture(uCaustics, cuv).r,
                                  0.85 * smoothstep(-0.1, 0.4, N0.y) * exp(-depthBelow * 1.5));

  // What the lamp can reach: the fins over the back and the leaves overhead
  // both shade the body.
  vec3 shadow = lightVisibility(vWorldPos, normalize(vNormal));
  vec3 ambient = uAmbient * mix(1.0, skyVisibility(vWorldPos, normalize(vNormal)), 0.5);

  vec3 lit = uLightColour * causticMod * NdotL * shadow;
  vec3 colour = albedo * (lit + ambient);
  colour += specular * lit;
  // Iridescence is a reflection off the guanine platelets, so it lives near
  // the specular direction and at grazing angles, not spread evenly over the
  // flank as a diffuse glow. Weighted evenly it washes the whole fish to a
  // pinkish white and the pigment never shows through.
  float irisView = 0.02 + 0.45 * pow(1.0 - NdotV, 3.0);
  float irisGlint = D * 0.2;
  colour += iridescence * irisMask * (irisView + irisGlint) * (lit * 0.6 + ambient * 0.4);

  // --- Subsurface ---
  //
  // Wrapped diffuse plus a back-lit term. Fish flesh is thin and translucent
  // near the edges; without this the silhouette reads as cut from card.
  float wrap = max(0.0, (dot(N, L) + 0.45) / 1.45);
  float back = pow(max(0.0, dot(V, -L)), 4.0);
  vec3 sss = vec3(0.85, 0.2, 0.16) * (wrap * 0.30 + back * 0.55);
  float thin = 1.0 - smoothstep(0.0, 0.55, NdotV); // grazing angles are thin
  colour += sss * uLightColour * shadow * thin * 0.3;

  // --- The eye, over everything else ---
  if (eyeMask > 0.0) {
    float eNdotV = max(dot(eyeN, V), 1e-4);
    float eNdotL = max(dot(eyeN, L), 0.0);
    // A black pupil filling most of it, a thin ring of dark gold iris, and
    // a darker rim where it meets the skin.
    float pupil = 1.0 - smoothstep(0.58, 0.66, eyeD);
    vec3 iris = mix(vec3(0.07, 0.035, 0.01), vec3(0.02, 0.01, 0.008), smoothstep(0.8, 1.0, eyeD));
    vec3 eyeAlbedo = mix(iris, vec3(0.0), pupil);
    vec3 eyeCol = eyeAlbedo * (uLightColour * shadow * eNdotL * 0.6 + ambient);
    // The cornea is a clean wet lens: a sharp highlight and a reflection of
    // the room, both far brighter than the skin's.
    vec3 eH = normalize(V + L);
    float eD = distributionGGX(max(dot(eyeN, eH), 0.0), 0.06);
    float eF = fresnelSchlick(eNdotV, 0.03);
    eyeCol += uLightColour * shadow * eD * 0.02 * eNdotL;
    eyeCol += envColour(vWorldPos, reflect(-V, eyeN)) * eF * 0.3;
    colour = mix(colour, eyeCol, eyeMask);
  }

  // The water between the fish and the eye takes some of the light out.
  colour *= transmittance(depthBelow * 0.5);
  colour *= uWaterTint;

  fragColour = vec4(tonemap(colour * uExposure), 1.0);
}
`;

/**
 * The outline each fin is cut to from its simulated sheet, shared by the fin
 * shader and the fins' shadow pass so a fin's shadow has the fin's shape.
 * Needs COMMON, for PI and noise2.
 */
const FIN_OUTLINE = /* glsl */ `
// 0 caudal, 1 dorsal, 2 anal, 3 pelvic.
uniform float uFinShape;

// How far out along its rays the fin reaches, as a fraction of the simulated
// sheet, at a point \`u\` of the way across it.
float finReach(float u) {
  if (uFinShape < 0.5) {
    // Caudal (u = 0 is the lower edge): a broad rounded veil, fullest a little
    // below the middle where a long tail hangs.
    float rounded = pow(sin(PI * clamp(u, 0.0, 1.0)), 0.55);
    return 0.62 + 0.36 * rounded + 0.05 * (1.0 - u);
  } else if (uFinShape < 1.5) {
    // Dorsal (u = 0 at the front): low where it starts and rising to a tall
    // rounded rear lobe.
    return 0.3 + 0.7 * sin(0.5 * PI * smoothstep(0.0, 0.8, u)) - 0.1 * smoothstep(0.88, 1.0, u);
  } else if (uFinShape < 2.5) {
    // Anal: shallow at the front, deepening steadily towards the tail.
    return mix(0.38, 0.98, smoothstep(0.0, 0.95, u));
  }
  // Pelvic: a long streamer.
  return 1.0;
}

// How far out towards the fin's edge a point of the sheet is: 0 at the body,
// 1 on the edge, more than 1 outside the fin. \`f\` is the point's place
// between two rays, -0.5 to 0.5.
float finEdge(float across, float along, float f) {
  float reach = finReach(across);
  // Ray tips run slightly beyond the webbing, giving a finely scalloped edge,
  // and the edge wanders a little so it is not ruled.
  float tip = pow(1.0 - clamp(2.0 * abs(f), 0.0, 1.0), 3.0);
  reach += 0.035 * tip + 0.05 * (noise2(vec2(across * 5.0, 1.7 * uFinShape)) - 0.5);
  if (uFinShape > 2.5) {
    // Pelvic streamers taper to a point.
    float halfWidth = 0.5 * pow(max(0.0, 1.0 - along), 0.7);
    if (abs(across - 0.5) > halfWidth) return 2.0;
  }
  return along / max(0.05, reach);
}
`;

/**
 * Fins.
 *
 * A fin is a membrane a tenth of a millimetre thick stretched between rays about
 * three times that. Almost all of what it looks like is transmission, not
 * reflection: it glows when the light is behind it, and the rays show through as
 * fine darker lines. Shading it as an opaque surface with a colour map is what
 * makes most rendered fish look like toys.
 *
 * The simulated sheet is a rectangle of rays, all the same length, because
 * that is what the physics needs. The fin's outline is cut from it here: each
 * fin has its own profile across its rays, and everything outside it fades
 * out, so the dorsal rises towards the back, the anal fin deepens along the
 * belly, the tail opens into a rounded veil and the pelvics taper to a point.
 * The edge is feathered and slightly ragged, since a veiltail's rays run a
 * little past the webbing between them.
 */
export const FIN_FRAG = /* glsl */ `#version 300 es
${COMMON}
${THIN_FILM}
${SHADOW}

in vec3 vWorldPos;
in vec3 vNormal;
in vec2 vUV;
in vec2 vExtra;
in vec3 vView;
${PANE_CLIP}

uniform sampler2D uCaustics;
uniform float uWaterY;
uniform vec3 uFinColour;
uniform vec2 uCausticsExtent;
uniform float uTime;
${FIN_OUTLINE}
// How many bony rays to draw across the fin. Unrelated to how many the
// physics simulates: those are the sheet's grid, these are anatomy.
uniform float uRayCount;

out vec4 fragColour;


void main() {
  if ((vWorldPos.y - uWaterY) * uClipSide < 0.0) discard;
  // Only where this pass's pane is the one the eye sees it through; see
  // APPARENT_POSITION.
  if (!seenThroughThisPane(vWorldPos)) discard;

  float across = vUV.x;     // 0 to 1 across the rays
  float along = vExtra.x;   // 0 at the body, 1 at the end of the simulated rays
  float thicknessMm = vExtra.y;

  // --- Rays ---
  //
  // Thin bony lines running out from the body, each forking in two towards
  // the edge as real fin rays do. Measured in ray spacings; the width is kept
  // to a few percent of the spacing, which is what they are.
  float q = across * uRayCount;
  float f = fract(q) - 0.5;
  float fork = 0.2 * smoothstep(0.3, 0.9, along);
  float d = min(abs(f - fork), abs(f + fork));
  float aa = fwidth(q) * 0.75 + 1e-4;
  float rayWidth = mix(0.05, 0.025, along);
  float ray = 1.0 - smoothstep(rayWidth, rayWidth + aa, d);
  // When the rays get finer than the pixels, fade them out rather than let
  // them alias into stripes.
  ray *= 1.0 - smoothstep(0.25, 0.6, fwidth(q));

  // --- Outline ---
  float edge = finEdge(across, along, f);
  if (edge > 1.0) discard;
  float feather = 1.0 - smoothstep(0.86, 1.0, edge);

  vec3 N = normalize(vNormal);
  vec3 V = normalize(vView);
  vec3 L = normalize(uLightDir);
  // A fin has no front and no back — it is a sheet — so flip the normal to
  // whichever side is facing us before doing any lighting.
  if (dot(N, V) < 0.0) N = -N;
  float NdotV = max(dot(N, V), 1e-4);
  float NdotL = abs(dot(N, L));

  // --- Transmission ---
  //
  // Beer-Lambert through the membrane. It is thin enough that most light gets
  // through; the rays, and the membrane seen edge-on in a fold, stop more.
  float thickness = thicknessMm * (1.0 + ray * 1.5);
  float sigma = 2.2;  // per millimetre
  float through = exp(-sigma * thickness / max(0.15, NdotV));
  // Strongest when looking towards the light through the fin.
  float backlight = pow(max(0.0, dot(V, -L)), 3.0);

  // --- Colour ---
  //
  // A saturated wash, deepest near the body and thinning towards the edge,
  // with the rays a darker red and the iridescence of the body's scales
  // reaching a little way onto the fin base.
  vec3 tint = uFinColour * mix(0.8, 1.15, smoothstep(0.0, 0.9, edge));
  tint = mix(tint, uFinColour * vec3(0.6, 0.4, 0.45), ray * 0.4);
  float filmVar = noise2(vec2(across * 3.0, along * 4.0) + uTime * 0.01) - 0.5;
  vec3 iridescence = thinFilm(NdotV, uFilmThickness * 0.8 + 70.0 * filmVar);
  float sheen = (1.0 - smoothstep(0.0, 0.4, edge)) * 0.25;

  vec2 cuv = vec2(
    (vWorldPos.x + uCausticsExtent.x) / (2.0 * uCausticsExtent.x),
    (vWorldPos.z + uCausticsExtent.y) / uCausticsExtent.y
  );
  float depthBelow = max(0.0, uWaterY - vWorldPos.y);
  vec3 lit = uLightColour * causticLight(texture(uCaustics, cuv).r, 0.75 * exp(-depthBelow * 1.5))
    * lightVisibility(vWorldPos, N);
  vec3 colour = tint * (NdotL * lit * 0.5 + uAmbient);
  colour += tint * through * (backlight * 2.6 + 0.3) * lit;
  colour += iridescence * sheen * (lit * 0.4 + uAmbient);
  // A soft sheen off the folds of the membrane: wet tissue is glossy.
  vec3 H = normalize(V + L);
  colour += vec3(0.9, 0.85, 0.8) * pow(max(dot(N, H), 0.0), 60.0) * 0.18 * lit;

  colour *= transmittance(depthBelow * 0.5);
  colour *= uWaterTint;

  // A fin is genuinely see-through, and more so towards its edge. Seen
  // edge-on in a fold the light crosses more membrane, so it thickens there.
  float alpha = mix(0.62, 0.28, smoothstep(0.0, 1.0, edge));
  alpha += 0.45 * (1.0 - through) + ray * 0.15;
  alpha = clamp(alpha, 0.0, 0.92) * feather;
  if (alpha < 0.004) discard;

  fragColour = vec4(tonemap(colour * uExposure), alpha);
}
`;

/**
 * Sand, the substrate seen through the glass, leaves, driftwood and stone.
 * `aExtra.x` selects which (see SURFACE in scenery.ts).
 */
export const TANK_FRAG = /* glsl */ `#version 300 es
${COMMON}
${SHADOW}

in vec3 vWorldPos;
in vec3 vNormal;
in vec2 vUV;
in vec2 vExtra;
in vec3 vView;
${PANE_CLIP}

uniform sampler2D uCaustics;
uniform float uWaterY;
uniform vec2 uCausticsExtent;
uniform float uTime;

out vec4 fragColour;

void main() {
  if ((vWorldPos.y - uWaterY) * uClipSide < 0.0) discard;
  // Only where this pass's pane is the one the eye sees it through; see
  // APPARENT_POSITION.
  if (!seenThroughThisPane(vWorldPos)) discard;
  vec3 N = normalize(vNormal);
  vec3 V = normalize(vView);
  vec3 L = normalize(uLightDir);
  float kind = vExtra.x;
  bool leaf = kind > 1.5 && kind < 2.95;
  // Leaves are sheets, lit from whichever side faces us.
  if (leaf && dot(N, V) < 0.0) N = -N;

  vec3 albedo;
  float roughness;
  vec3 translucent = vec3(0.0);

  if (kind < 0.5) {
    // Sand. Individual grains, at two scales so it does not read as one texture
    // frequency, and slightly warm.
    //
    // A shade darker than it was: with the caustics now at full strength the
    // bright lines carry two to three times the average light, and on sand
    // this pale they tone-mapped to a broad white wash instead of lines.
    float grain = noise2(vUV * 420.0) * 0.5 + noise2(vUV * 1400.0) * 0.5;
    albedo = mix(vec3(0.15, 0.13, 0.105), vec3(0.32, 0.28, 0.225), grain);
    // A scattering of darker grains, which is what makes real sand read as
    // granular rather than as noise.
    float dark = step(0.86, noise2(vUV * 900.0 + 13.0));
    albedo *= 1.0 - dark * 0.45;
    roughness = 0.9;
  } else if (kind < 1.5) {
    // The substrate's cut face, pressed against the glass: dark soil at the
    // bottom and the sand capping it, with a ragged boundary between them.
    // Seen from outside through dry glass, so none of the water's light
    // reaches it; only the room's.
    vec2 q = vec2(vUV.x, vWorldPos.y);
    float boundary = ${f(TANK_BOTTOM_Y + 0.011)} + 0.003 * (noise2(vec2(q.x * 90.0, 1.0)) - 0.5);
    float soil = 1.0 - smoothstep(boundary - 0.0008, boundary + 0.0008, q.y);
    float g = noise2(q * 2600.0) * 0.6 + noise2(q * 900.0) * 0.4;
    vec3 sandCol = mix(vec3(0.20, 0.17, 0.14), vec3(0.42, 0.37, 0.30), g);
    sandCol *= 1.0 - step(0.84, noise2(q * 1800.0 + 7.0)) * 0.45;
    vec3 soilCol = mix(vec3(0.03, 0.022, 0.016), vec3(0.09, 0.065, 0.045), g);
    soilCol += vec3(0.05, 0.04, 0.03) * step(0.9, noise2(q * 700.0 + 3.0));
    // The top few millimetres are lit a little from above through the sand.
    float nearTop = smoothstep(-0.006, 0.0, vWorldPos.y - ${f(TANK.floorY)});
    vec3 c = mix(sandCol, soilCol, soil) * (uAmbient * 1.6 + vec3(0.06) + nearTop * 0.12);
    fragColour = vec4(tonemap(c * uExposure), 1.0);
    return;
  } else if (leaf) {
    int species = int(floor((kind - 2.0) * 10.0 + 0.5));
    float along = vUV.y;
    float across = abs(vUV.x - 0.5);
    // Midrib, and secondary veins running out obliquely from it.
    float midrib = 1.0 - smoothstep(0.0, 0.05, across);
    float secondary = 1.0 - smoothstep(0.0, 0.07, abs(fract(along * 11.0 - across * 2.5) - 0.5) - 0.43);
    float vein = max(midrib, secondary * 0.6);
    float y = vWorldPos.y - ${f(TANK.floorY)};
    roughness = 0.55;
    if (species == 0) {
      // Amazon sword: fresh mid-green, paler along the veins.
      albedo = mix(vec3(0.05, 0.15, 0.045), vec3(0.12, 0.28, 0.07), along);
    } else if (species == 1) {
      // Vallisneria: pale, thin, and very translucent, with fine parallel
      // veins and tips browning where they trail at the surface.
      albedo = mix(vec3(0.09, 0.22, 0.06), vec3(0.15, 0.30, 0.08), along);
      albedo = mix(albedo, vec3(0.20, 0.20, 0.07), smoothstep(0.75, 1.0, along) * 0.5);
      vein = (1.0 - smoothstep(0.0, 0.08, abs(fract(vUV.x * 4.0) - 0.5) - 0.40)) * 0.4;
    } else if (species == 2) {
      // Hairgrass: bright green blades.
      albedo = mix(vec3(0.07, 0.20, 0.04), vec3(0.18, 0.40, 0.09), along);
      vein = 0.0;
    } else if (species == 3) {
      // Red stem plant: green below, turning red towards the light, as
      // Ludwigia and Rotala do when the light is strong.
      float red = smoothstep(0.022, 0.058, y);
      albedo = mix(vec3(0.09, 0.22, 0.05), vec3(0.42, 0.075, 0.05), red);
      albedo = mix(albedo, albedo * vec3(1.2, 0.7, 0.8), along * 0.4);
    } else if (species == 4) {
      // Stem.
      albedo = mix(vec3(0.16, 0.14, 0.06), vec3(0.34, 0.08, 0.05), smoothstep(0.02, 0.06, y));
      vein = 0.0;
    } else if (species == 5) {
      // Java fern: dark, leathery and glossy, with a strong midrib.
      albedo = mix(vec3(0.025, 0.085, 0.025), vec3(0.05, 0.14, 0.04), along);
      roughness = 0.35;
    } else {
      // Cryptocoryne: olive with a bronze cast.
      albedo = mix(vec3(0.07, 0.09, 0.035), vec3(0.14, 0.15, 0.05), along);
    }
    albedo = mix(albedo, albedo * 1.45, vein);
    // Leaves are thin, and light that falls on one side comes through the
    // other, coloured by the leaf.
    translucent = albedo * 1.8;
  } else if (kind < 3.5) {
    // Driftwood. Streaks along the grain, deep cracks running with it, and a
    // faint film of algae on the upper sides where the light falls.
    float a = vUV.x * 6.2831853;
    float s = vUV.y;
    vec3 ring = vec3(cos(a), sin(a), 0.0);
    float streak = noise3(ring * 2.5 + vec3(0.0, 0.0, s * 90.0)) * 0.6
                 + noise3(ring * 7.0 + vec3(3.0, 1.0, s * 300.0)) * 0.4;
    albedo = mix(vec3(0.035, 0.02, 0.012), vec3(0.15, 0.085, 0.048), streak);
    float crack = smoothstep(0.62, 0.78, noise3(ring * 5.0 + vec3(0.0, 0.0, s * 22.0)));
    albedo *= 1.0 - crack * 0.65;
    float film = smoothstep(0.3, 0.9, N.y) * noise2(vWorldPos.xz * 300.0);
    albedo = mix(albedo, vec3(0.11, 0.13, 0.06), film * 0.35);
    roughness = 0.75;
  } else {
    // Stone: grey limestone, mottled, with pale calcite veins and a few
    // darker pits.
    vec3 q = vWorldPos;
    float m = noise3(q * 160.0) * 0.6 + noise3(q * 520.0) * 0.4;
    albedo = mix(vec3(0.22, 0.23, 0.23), vec3(0.50, 0.51, 0.50), m);
    float v = 1.0 - smoothstep(0.0, 0.03, abs(noise3(q * 80.0 + 7.0) - 0.5));
    albedo = mix(albedo, vec3(0.60, 0.60, 0.56), v * 0.65);
    albedo *= 0.85 + 0.3 * noise3(q * 1500.0);
    albedo = mix(albedo, vec3(0.09, 0.13, 0.06), smoothstep(0.6, 1.0, N.y) * 0.3 * noise3(q * 400.0));
    roughness = 0.6;
  }

  float NdotL = max(dot(N, L), 0.0);

  vec2 cuv = vec2(
    (vWorldPos.x + uCausticsExtent.x) / (2.0 * uCausticsExtent.x),
    (vWorldPos.z + uCausticsExtent.y) / uCausticsExtent.y
  );
  float depthBelow = max(0.0, uWaterY - vWorldPos.y);
  float underWater = step(vWorldPos.y, uWaterY);
  // The caustic map is computed for the sand itself, so on the sand it is the
  // light, not an effect laid over it; elsewhere it is an approximation that
  // fades with height above the floor.
  float onFloor = kind < 0.5 ? 1.0 : exp(-depthBelow * 1.2) * 0.9;
  vec3 shadow = underWater > 0.5 ? lightVisibility(vWorldPos, N) : vec3(1.0);
  float sky = underWater > 0.5 ? skyVisibility(vWorldPos, N) : 1.0;
  vec3 light = uLightColour * shadow
    * causticLight(texture(uCaustics, cuv).r,
                   onFloor * underWater * smoothstep(-0.2, 0.5, N.y));
  vec3 ambient = uAmbient * mix(1.0, sky, 0.75);
  vec3 colour = albedo * (light * NdotL + ambient);

  if (leaf) {
    // Diffuse transmission: light on the far face of the leaf.
    colour += translucent * light * max(-dot(N, L), 0.0) * 0.45;
    // And the glow when looking towards the light through it.
    float back = pow(max(0.0, dot(V, -L)), 2.5);
    colour += translucent * back * light * 0.9;
  }

  // Specular from the wet surfaces.
  vec3 H = normalize(V + L);
  float D = distributionGGX(max(dot(N, H), 0.0), roughness);
  colour += light * D * 0.04 * NdotL;

  colour *= transmittance(depthBelow);
  colour *= uWaterTint;

  fragColour = vec4(tonemap(colour * uExposure), 1.0);
}
`;

/**
 * The shadow pass for solid things: only depth is wanted, so there is nothing
 * to shade.
 */
export const SHADOW_FRAG = /* glsl */ `#version 300 es
precision highp float;
void main() {}
`;

/**
 * The shadow pass for fins: how much light gets through, and what colour it is
 * when it does.
 *
 * Blended multiplicatively into the colour, so two fins over the same spot let
 * through the product of what each lets through, and the alpha keeps the depth
 * of the fin nearest the light, so nothing above the fins is shaded by them.
 * The opacity follows the same membrane-and-rays model the fin shader draws
 * with, looking along the light instead of along the eye.
 */
export const FIN_SHADOW_FRAG = /* glsl */ `#version 300 es
${COMMON}
in vec3 vWorldPos;
in vec3 vNormal;
in vec2 vUV;
in vec2 vExtra;
uniform vec3 uFinColour;
uniform vec3 uLightDirWater;
uniform float uRayCount;
${FIN_OUTLINE}
out vec4 fragColour;
void main() {
  float across = vUV.x;
  float along = vExtra.x;
  // The same rays and outline as the fin shader draws.
  float q = across * uRayCount;
  float f = fract(q) - 0.5;
  float edge = finEdge(across, along, f);
  if (edge > 1.0) discard;
  float fork = 0.2 * smoothstep(0.3, 0.9, along);
  float d = min(abs(f - fork), abs(f + fork));
  // Wider than the drawn rays: the shadow map's texels are coarser than the
  // screen's pixels, and a ray narrower than a texel would flicker in and out.
  float ray = 1.0 - smoothstep(0.06, 0.20, d);
  float cosL = max(0.15, abs(dot(normalize(vNormal), uLightDirWater)));
  float through = exp(-2.2 * vExtra.y * (1.0 + ray * 1.5) / cosL);
  float opacity = clamp(0.30 + 0.55 * (1.0 - through) + ray * 0.25, 0.0, 1.0);
  opacity *= 1.0 - smoothstep(0.86, 1.0, edge);
  // What the pigment lets through: mostly the red end, which is why the
  // pigment looks red.
  vec3 filterColour = uFinColour / max(max(uFinColour.r, uFinColour.g), uFinColour.b);
  vec3 transmitted = mix(vec3(1.0), filterColour * 0.85, opacity);
  fragColour = vec4(transmitted, 1.0 - gl_FragCoord.z);
}
`;

/**
 * The glass. Broad faces are nearly clear and reflect a little of the room,
 * more at a glancing angle; the edges are the green of float glass seen
 * end-on. Blended over what is behind.
 */
export const GLASS_FRAG = /* glsl */ `#version 300 es
${COMMON}

in vec3 vWorldPos;
in vec3 vNormal;
in vec2 vUV;
in vec2 vExtra;
in vec3 vView;
${PANE_CLIP}

uniform float uWaterY;
// 1 to draw only the edges, 0 only the broad faces; see the renderer.
uniform float uEdges;

out vec4 fragColour;

void main() {
  if ((vWorldPos.y - uWaterY) * uClipSide < 0.0) discard;
  if ((vExtra.x > 0.5) != (uEdges > 0.5)) discard;
  // The panes are on the water's edges, so parts of them are seen through the
  // water and parts are not; each is drawn in the pass that sees it.
  if (!seenThroughThisPane(vWorldPos)) discard;
  vec3 N = normalize(vNormal);
  vec3 V = normalize(vView);
  if (dot(N, V) < 0.0) N = -N;
  float NdotV = max(dot(N, V), 1e-4);

  if (vExtra.x > 0.5) {
    // An edge. Light from the lamp enters the top of the panes and is piped
    // down them, so the edges are brighter near the top.
    float top = smoothstep(uWaterY - 0.04, uWaterY + 0.03, vWorldPos.y);
    vec3 green = vec3(0.17, 0.34, 0.30);
    vec3 c = green * (uAmbient * 2.5 + uLightColour * (0.10 + 0.30 * top));
    fragColour = vec4(tonemap(c * uExposure), 0.8);
    return;
  }

  // A broad face: Fresnel reflection of the room, and a faint green cast.
  float F = fresnelSchlick(NdotV, 0.04);
  vec3 R = reflect(-V, N);
  vec3 c = envColour(vWorldPos, R) + vec3(0.0, 0.012, 0.009);
  fragColour = vec4(tonemap(c * uExposure), clamp(F + 0.03, 0.0, 0.85));
}
`;

/**
 * The room around the tank, and the lamp over it. `aExtra.x` selects the
 * surface (see ROOM_SURFACE in scenery.ts).
 *
 * The room is lit by its own light — a window behind the viewer and the
 * ceiling — not by the tank's lamp, and it is kept a good deal dimmer than
 * the tank, which is how a lit aquarium looks in an ordinary room. Detail is
 * soft on purpose: at this distance behind the tank, an eye focused on the
 * fish sees the room out of focus.
 */
export const ROOM_FRAG = /* glsl */ `#version 300 es
${COMMON}

in vec3 vWorldPos;
in vec3 vNormal;
in vec2 vUV;
in vec2 vExtra;
in vec3 vView;

out vec4 fragColour;

const vec3 LAMP = vec3(0.0, ${f(LAMP_Y)}, ${f(TANK.depth * -0.5)});
const vec2 TANK_HALF = vec2(${f(TANK.width / 2 + TANK.glassThickness)}, ${f(TANK.depth / 2 + TANK.glassThickness)});
const float FLOOR_Y = ${f(ROOM.floorY)};
const float CEILING_Y = ${f(ROOM.ceilingY)};

vec3 roomLight(vec3 N) {
  vec3 window = normalize(vec3(0.25, 0.3, 1.0));
  float sky = 0.5 + 0.5 * N.y;
  // Light bounced round the room, from the ceiling, and from the window.
  return vec3(0.022, 0.021, 0.02)
       + vec3(0.04, 0.04, 0.044) * sky
       + vec3(0.085, 0.078, 0.07) * max(dot(N, window), 0.0);
}

// The lamp's light on what is near the tank, falling off with distance and
// thrown mostly downwards.
vec3 lampSpill(vec3 p, vec3 N) {
  vec3 d = LAMP - p;
  float r2 = dot(d, d);
  vec3 dir = d * inversesqrt(r2);
  float down = max(0.0, dir.y);
  return vec3(0.95, 0.92, 0.84) * max(dot(N, dir), 0.0) * down * down * 0.012 / (r2 + 0.01);
}

// Wood grain along x, in metres.
vec3 wood(vec2 q, vec3 dark, vec3 light) {
  float g = noise2(vec2(q.x * 7.0, q.y * 150.0)) * 0.55 + noise2(vec2(q.x * 30.0, q.y * 600.0)) * 0.45;
  float figure = noise2(vec2(q.x * 2.0 + g, q.y * 35.0));
  return mix(dark, light, g * 0.7 + figure * 0.3);
}

void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(vView);
  if (dot(N, V) < 0.0) N = -N;
  vec3 p = vWorldPos;
  int kind = int(vExtra.x + 0.5);

  if (kind == 7) {
    // The lamp's emitting strip.
    fragColour = vec4(tonemap(vec3(1.0, 0.94, 0.82) * 2.6 * uExposure), 1.0);
    return;
  }

  vec3 albedo;
  float ao = 1.0;
  float gloss = 0.0;
  if (kind == 0) {
    albedo = vec3(0.50, 0.48, 0.44);
    // Darker into the corners and towards the floor.
    ao = mix(0.7, 1.0, smoothstep(0.0, 0.6, p.y - FLOOR_Y));
    ao *= mix(0.8, 1.0, smoothstep(0.0, 0.5, CEILING_Y - p.y));
  } else if (kind == 1) {
    // Floorboards running away from the viewer.
    float board = floor(p.x / 0.14);
    float along = p.z + hash21(vec2(board, 3.0)) * 2.0;
    albedo = wood(vec2(along, p.x), vec3(0.10, 0.065, 0.04), vec3(0.24, 0.16, 0.10));
    albedo *= 0.85 + 0.3 * hash21(vec2(board, 7.0));
    float gap = smoothstep(0.004, 0.0, abs(fract(p.x / 0.14) - 0.5) - 0.495);
    albedo *= 1.0 - gap * 0.6;
    gloss = 0.4;
  } else if (kind == 2 || kind == 3) {
    // The desk: walnut, oiled.
    albedo = wood(p.xz, vec3(0.085, 0.048, 0.028), vec3(0.24, 0.145, 0.085));
    if (kind == 3) {
      albedo *= 0.75;
      // Cabinet door gaps.
      float seam = smoothstep(0.003, 0.0, abs(abs(p.x) - 0.3)) + smoothstep(0.003, 0.0, abs(p.x));
      albedo *= 1.0 - clamp(seam, 0.0, 1.0) * 0.7 * step(p.y, ${f(DESK.min.y - 0.001)});
    } else {
      // Contact shadow round the tank's footprint.
      vec2 q = abs(p.xz - vec2(0.0, ${f(TANK.depth * -0.5)})) - TANK_HALF;
      float outside = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
      ao = mix(0.45, 1.0, smoothstep(0.0, 0.035, outside));
      gloss = 0.6;
    }
  } else if (kind == 4) {
    albedo = vec3(0.55, 0.54, 0.52);
  } else if (kind == 5) {
    albedo = vec3(0.60, 0.59, 0.56);
  } else {
    // Lamp housing: dark anodised aluminium.
    albedo = vec3(0.035, 0.036, 0.04);
    gloss = 0.8;
  }

  vec3 c = albedo * (roomLight(N) + lampSpill(p, N)) * ao;
  // A soft sheen off the varnished and metal surfaces, from the window.
  if (gloss > 0.0) {
    vec3 R = reflect(-V, N);
    float F = fresnelSchlick(max(dot(N, V), 0.0), 0.04);
    // The room only: the lamp's reflection in an oiled desk would be a blur,
    // not the sharp strip envColour draws for the water surface.
    c += envRoom(R) * F * gloss * 0.6;
  }
  fragColour = vec4(tonemap(c * uExposure), 1.0);
}
`;

// ---------------------------------------------------------------------------
// Caustics
// ---------------------------------------------------------------------------

/**
 * Caustics, computed rather than looped.
 *
 * A fine mesh of light rays is refracted through the simulated water surface
 * with Snell's law and laid down where each ray lands on the sand. Where the
 * surface bunches the rays together the light is brighter, and the brightness
 * is exactly the ratio of a patch's area where the light entered the water to
 * its area where it lands — the Jacobian of the refraction map.
 *
 * The alternative is a looping caustic texture, which is what most real-time
 * water uses. It is cheaper and it is wrong in a way that shows the moment
 * anything disturbs the water: the dapples carry on their pre-recorded dance
 * while the surface they are supposedly cast by does something else entirely.
 * Here, a pellet hitting the surface sends a ring through the caustics because
 * it sent a ring through the water.
 *
 * The rays form a mesh of triangles rather than a scatter of points. Each
 * triangle is drawn where its corners land, and it knows where its corners
 * started, so the area ratio is exact for every triangle and the pattern has
 * no dot grid in it. Where the surface folds light over on itself, triangles
 * overlap and add, which is what light does.
 */
export const CAUSTICS_VERT = /* glsl */ `#version 300 es
precision highp float;
${SURFACE_SAMPLE}

in vec2 aGrid;                 // position across the water surface, 0..1 (a little beyond at the edges)

uniform sampler2D uHeightMap;  // rgb = simulated height, dh/dx, dh/dz at each grid node
uniform sampler2D uRipples;    // the fine ripples from touches: height (mm), dh/dx, dh/dz
uniform vec2 uTankExtent;      // half-width, depth
uniform float uWaterY;
uniform float uFloorY;
uniform vec3 uLightDir;
uniform float uIOR;

out vec2 vSurface;
out vec2 vFloor;

void main() {
  vec2 world = vec2(
    (aGrid.x - 0.5) * 2.0 * uTankExtent.x,
    -uTankExtent.y + aGrid.y * uTankExtent.y
  );

  // The simulated surface here: its first and last nodes sit on the walls.
  // Rays from beyond the walls (the mesh runs a little past them, to light
  // the strip of floor the slanting light reaches through the glass) meet no
  // surface, so they go straight on.
  vec2 gridSize = vec2(textureSize(uHeightMap, 0));
  bool onSurface = all(greaterThanEqual(aGrid, vec2(0.0))) && all(lessThanEqual(aGrid, vec2(1.0)));
  vec3 s = vec3(0.0);
  if (onSurface) {
    s = surfaceAt(uHeightMap, aGrid * (gridSize - 1.0));
    vec3 fine = texture(uRipples, aGrid).rgb;
    s += vec3(fine.r * 1e-3, fine.g, fine.b);
  }
  float h = s.x;
  vec3 n = normalize(vec3(-s.y, 1.0, -s.z));

  // Snell's law, vector form. Air to water, so the ray bends towards the normal.
  vec3 i = normalize(-uLightDir);
  float eta = 1.0 / uIOR;
  float cosi = -dot(n, i);
  float k = 1.0 - eta * eta * (1.0 - cosi * cosi);
  vec3 refracted = eta * i + (eta * cosi - sqrt(max(k, 0.0))) * n;

  // On to the floor.
  float t = (uFloorY - (uWaterY + h)) / min(-1e-4, refracted.y);
  vec2 landing = world + refracted.xz * t;

  vSurface = world;
  vFloor = landing;
  vec2 uv = vec2(
    (landing.x + uTankExtent.x) / (2.0 * uTankExtent.x),
    (landing.y + uTankExtent.y) / uTankExtent.y
  );
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const CAUSTICS_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 vSurface;
in vec2 vFloor;
out vec4 fragColour;
void main() {
  // Area this pixel of floor covers, against the area of surface its light
  // came through. Both are linear across a triangle, so this is exact for it.
  vec2 a = dFdx(vSurface), b = dFdy(vSurface);
  vec2 c = dFdx(vFloor), d = dFdy(vFloor);
  float before = abs(a.x * b.y - a.y * b.x);
  float after = abs(c.x * d.y - c.y * d.x);
  // A perfect focus is infinitely bright in the maths; the lamp's size and the
  // blur after this keep it finite in reality. Cap it well above anything the
  // blur leaves.
  float intensity = min(before / max(after, 1e-14), 40.0);
  fragColour = vec4(vec3(intensity), 1.0);
}
`;

/** Blur the accumulated caustic map — real caustics have soft edges. */
export const BLUR_VERT = /* glsl */ `#version 300 es
precision highp float;
in vec2 aPosition;
out vec2 vUV;
void main() {
  vUV = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

export const BLUR_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uSource;
uniform vec2 uDirection;
out vec4 fragColour;
void main() {
  // Five-tap Gaussian.
  vec3 sum = texture(uSource, vUV).rgb * 0.227;
  sum += texture(uSource, vUV + uDirection * 1.3846).rgb * 0.3162;
  sum += texture(uSource, vUV - uDirection * 1.3846).rgb * 0.3162;
  sum += texture(uSource, vUV + uDirection * 3.2308).rgb * 0.0702;
  sum += texture(uSource, vUV - uDirection * 3.2308).rgb * 0.0702;
  fragColour = vec4(sum, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Water surface
// ---------------------------------------------------------------------------

/**
 * The water surface, seen from wherever the camera is.
 *
 * Refraction is done in screen space: the scene has already been rendered to a
 * texture, and the surface samples it at an offset given by the refracted ray.
 * That is not physically exact — the offset is a plane approximation, and it can
 * sample something that is not really behind the surface — but it is right where
 * it matters and it costs one texture read.
 *
 * The Fresnel term is the part that must not be fudged. At a grazing angle water
 * is almost a mirror and at normal incidence it is almost clear, and that
 * transition is most of what tells the eye it is looking at water at all.
 */
export const WATER_FRAG = /* glsl */ `#version 300 es
${COMMON}

in vec3 vWorldPos;
in vec3 vNormal;
in vec2 vUV;
in vec2 vExtra;
in vec3 vView;
${PANE_CLIP}

uniform sampler2D uScene;
uniform sampler2D uCaustics;
uniform sampler2D uReflection;   // the scene from the mirrored camera
uniform vec2 uViewport;
uniform float uWaterY;
uniform vec2 uCausticsExtent;
uniform float uTime;
uniform sampler2D uRipples;      // the fine ripples from touches: height (mm), dh/dx, dh/dz

out vec4 fragColour;

void main() {
  // The simulated surface's own normal, tipped by the fine ripples. The same
  // ripples draw the caustics on the sand, so the light on the floor belongs
  // to the surface you are looking at.
  vec2 ruv = vec2(
    (vWorldPos.x + uCausticsExtent.x) / (2.0 * uCausticsExtent.x),
    (vWorldPos.z + uCausticsExtent.y) / uCausticsExtent.y
  );
  vec3 fine = texture(uRipples, ruv).rgb;
  vec3 N = normalize(vNormal);
  N = normalize(N + vec3(-fine.g, 0.0, -fine.b) * sign(N.y));
  vec3 V = normalize(vView);
  bool fromBelow = dot(N, V) < 0.0;
  if (fromBelow) N = -N;

  float NdotV = max(dot(N, V), 1e-4);
  vec3 L = normalize(uLightDir);

  // Only where this pass's pane is the one the eye sees it through; see
  // APPARENT_POSITION.
  if (!seenThroughThisPane(vWorldPos)) discard;

  // Fresnel, with water's f0 of 0.02.
  float F = fresnelSchlick(NdotV, 0.02);

  // Screen-space refraction: offset the lookup by the surface's slope.
  vec2 screenUV = gl_FragCoord.xy / uViewport;
  vec2 offset = N.xz * (fromBelow ? 0.14 : 0.055);
  vec3 refracted = texture(uScene, clamp(screenUV + offset, vec2(0.001), vec2(0.999))).rgb;

  // Reflection: a planar reflection, rendered from the camera mirrored in the
  // water plane. For a flat mirror the reflected image at a pixel is exactly
  // what the mirrored camera sees at that pixel, so this is not an
  // approximation; the ripple normal then nudges the lookup, which is one.
  // Where the reflection pass drew nothing (alpha 0) the room fills in: from
  // above, that is the hood lamp and the ceiling; from underneath, the surface
  // is a mirror past the critical angle and shows the tank back to itself —
  // the single most striking thing about being under water, and almost never
  // rendered.
  //
  // The scene and reflection targets hold colours that are already tone
  // mapped (each object maps its own), so only the room, which is computed
  // here in linear light, is mapped here. Mapping the lot again washed the
  // tank out to near-white whenever it was seen through the surface.
  vec3 R = reflect(-V, N);
  vec2 reflUV = clamp(screenUV + N.xz * 0.06, vec2(0.001), vec2(0.999));
  vec4 reflTex = texture(uReflection, reflUV);
  vec3 reflected = mix(tonemap(envColour(vWorldPos, R) * uExposure), reflTex.rgb, reflTex.a);
  float reflectance = F;
  if (fromBelow) {
    // Total internal reflection beyond the critical angle, 48.6 degrees for
    // water. Past it the surface reflects everything.
    float critical = 1.0 / 1.333;
    float sinT = sqrt(max(0.0, 1.0 - NdotV * NdotV)) / critical;
    reflectance = sinT >= 1.0 ? 1.0 : mix(F, 1.0, smoothstep(0.85, 1.0, sinT));
  }

  vec3 colour = mix(refracted, reflected, reflectance);

  // Specular glint off the surface, which is what makes the ripples read.
  vec3 H = normalize(V + L);
  float spec = distributionGGX(max(dot(N, H), 0.0), 0.06);
  colour += tonemap(uLightColour * spec * 0.35 * (1.0 - float(fromBelow) * 0.7) * uExposure);

  fragColour = vec4(colour, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Water volume and post
// ---------------------------------------------------------------------------

/**
 * The water volume, as a full-screen pass.
 *
 * Everything that has been drawn so far is inside the tank, so this applies what
 * the water does to light on its way to the eye: absorption over the path
 * length, in-scattering from suspended particulate, and a shaft of light coming
 * down through the surface.
 */
export const VOLUME_FRAG = /* glsl */ `#version 300 es
${COMMON}

in vec2 vUV;

uniform sampler2D uScene;
uniform sampler2D uDepth;
uniform vec3 uCameraPos;
uniform mat4 uInverseViewProjection;
uniform float uWaterY;
uniform float uTime;

out vec4 fragColour;

vec3 worldFromDepth(vec2 uv, float depth) {
  vec4 clip = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 world = uInverseViewProjection * clip;
  return world.xyz / world.w;
}

void main() {
  vec3 scene = texture(uScene, vUV).rgb;
  float depth = texture(uDepth, vUV).r;

  if (depth >= 1.0) {
    fragColour = vec4(scene, 1.0);
    return;
  }

  // The depth buffer holds *apparent* positions — geometry under water was
  // drawn where refraction makes it appear (see SCENE_VERT). The line of sight
  // is the same line either way, so the true position is recovered by undoing
  // the shortening along it, from where the ray enters the water.
  vec3 apparent = worldFromDepth(vUV, depth);
  vec3 toEye = uCameraPos - apparent;
  float apparentLength = length(toEye);
  vec3 dir = toEye / max(1e-5, apparentLength);

  // The ray's passage through the water box, as distances from the eye.
  vec3 rd = -dir + vec3(equal(dir, vec3(0.0))) * 1e-7;
  vec3 t0 = (uWaterMin - uCameraPos) / rd;
  vec3 t1 = (uWaterMax - uCameraPos) / rd;
  float tEnter = max(max(min(t0.x, t1.x), min(t0.y, t1.y)), min(t0.z, t1.z));
  float tExit = min(min(max(t0.x, t1.x), max(t0.y, t1.y)), max(t0.z, t1.z));
  bool eyeInside = all(greaterThan(uCameraPos, uWaterMin)) && all(lessThan(uCameraPos, uWaterMax));

  float underwater = 0.0;
  if (eyeInside) {
    underwater = min(apparentLength, max(0.0, tExit));
  } else if (tExit > tEnter && tEnter > 0.0 && apparentLength > tEnter) {
    // Inside the box the apparent path is the true path over the index. For
    // something beyond the water — the room seen through the tank, drawn
    // where it is — the path is the whole way across, and no further.
    underwater = apparentLength > tExit + 1e-3
      ? tExit - tEnter
      : (apparentLength - tEnter) * max(1.0, uRefractIOR);
  }


  vec3 T = transmittance(underwater);

  // In-scattering. The Henyey-Greenstein phase function makes the haze brighten
  // sharply when looking towards the light, which is what a real beam in water
  // does and what a constant fog term cannot do.
  float cosTheta = dot(dir, normalize(uLightDir));
  float phase = phaseHG(cosTheta, 0.68);
  vec3 inScatter = uLightColour * uScattering * phase * underwater * 4.0;

  vec3 colour = scene * T + inScatter;

  fragColour = vec4(colour, 1.0);
}
`;

export const POST_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uScene;
uniform float uTime;
uniform float uGrain;
uniform float uVignette;
out vec4 fragColour;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  // Slight chromatic aberration towards the edges — every real lens has some,
  // and its complete absence is one of the things that reads as computer
  // graphics without anyone being able to name it.
  vec2 centred = vUV - 0.5;
  float r2 = dot(centred, centred);
  vec2 shift = centred * r2 * 0.006;
  vec3 colour;
  colour.r = texture(uScene, vUV + shift).r;
  colour.g = texture(uScene, vUV).g;
  colour.b = texture(uScene, vUV - shift).b;

  // Grain. On the phone this is matched to the camera's own measured noise,
  // because clean rendered content composited over noisy video is the classic
  // tell. Here it is a fixed small amount.
  float n = hash(vUV * 1024.0 + fract(uTime) * 71.0) - 0.5;
  colour += n * uGrain;

  colour *= 1.0 - uVignette * r2 * 1.4;

  fragColour = vec4(colour, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Particles: pellets and bubbles
// ---------------------------------------------------------------------------

export const PARTICLE_VERT = /* glsl */ `#version 300 es
precision highp float;
in vec3 aPosition;
in vec2 aUV;
uniform mat4 uViewProjection;
uniform vec3 uCameraPos;
uniform vec3 uWaterMin;
uniform vec3 uWaterMax;
uniform float uRefractIOR;
out vec2 vUV;
out vec3 vWorldPos;
// The same refraction as the scene geometry.
${APPARENT_POSITION}
void main() {
  vUV = aUV;
  vWorldPos = aPosition;
  gl_Position = uViewProjection * vec4(apparentPosition(aPosition), 1.0);
}
`;

export const PELLET_FRAG = /* glsl */ `#version 300 es
${COMMON}
in vec2 vUV;
in vec3 vWorldPos;
${PANE_CLIP}
uniform float uWaterY;
out vec4 fragColour;
void main() {
  vec2 d = vUV * 2.0 - 1.0;
  float r2 = dot(d, d);
  if (r2 > 1.0) discard;
  if (!seenThroughThisPane(vWorldPos)) discard;
  // Shade it as a sphere: the normal follows from the disc coordinate.
  vec3 N = normalize(vec3(d, sqrt(max(0.0, 1.0 - r2))));
  float NdotL = max(dot(N, normalize(uLightDir)), 0.0);
  vec3 albedo = vec3(0.30, 0.18, 0.09);
  vec3 colour = albedo * (uLightColour * (NdotL * 0.8 + 0.2) + uAmbient);
  colour += uLightColour * pow(NdotL, 24.0) * 0.25;
  colour *= transmittance(max(0.0, uWaterY - vWorldPos.y));
  colour *= uWaterTint;
  fragColour = vec4(tonemap(colour * uExposure), 1.0);
}
`;

export const BUBBLE_FRAG = /* glsl */ `#version 300 es
${COMMON}
in vec2 vUV;
in vec3 vWorldPos;
${PANE_CLIP}
uniform float uWaterY;
out vec4 fragColour;
void main() {
  vec2 d = vUV * 2.0 - 1.0;
  float r2 = dot(d, d);
  if (r2 > 1.0) discard;
  if (!seenThroughThisPane(vWorldPos)) discard;
  float r = sqrt(r2);
  // A bubble is a thin shell of air in water: almost invisible in the middle,
  // with a bright rim where the view grazes the surface and total internal
  // reflection takes over.
  float rim = smoothstep(0.55, 1.0, r);
  float highlight = smoothstep(0.90, 1.0, 1.0 - length(d - vec2(-0.35, 0.35)));
  vec3 colour = uLightColour * (rim * 0.5 + highlight * 1.6);
  colour *= transmittance(max(0.0, uWaterY - vWorldPos.y));
  float alpha = rim * 0.55 + highlight * 0.9;
  fragColour = vec4(tonemap(colour * uExposure), alpha);
}
`;

/**
 * The specks drifting in the water (see render/particulate.ts).
 *
 * Each is far smaller than a pixel from any normal viewing distance: a speck a
 * fifth of a millimetre across, half a metre away, is under half a pixel. A
 * point that small jumps between pixels as it drifts and looks like noise, so
 * each is drawn at least two pixels wide with its brightness spread over that
 * area — the same total light, without the shimmer.
 */
export const MOTE_VERT = /* glsl */ `#version 300 es
${COMMON}
layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec2 aSpeck;   // radius in metres, a random number per speck

uniform mat4 uViewProjection;
uniform vec3 uCameraPos;
uniform float uPixelScale;   // pixels across for one metre at one metre away

out vec3 vWorldPos;
out float vCover;
out float vSeed;

// Bent through this pass's pane like the scene geometry; see APPARENT_POSITION.
${APPARENT_POSITION}

void main() {
  vWorldPos = aPosition;
  vSeed = aSpeck.y;
  gl_Position = uViewProjection * vec4(apparentPosition(aPosition), 1.0);
  float diameter = 2.0 * aSpeck.x * uPixelScale / max(gl_Position.w, 1e-3);
  float drawn = max(diameter, 2.0);
  gl_PointSize = drawn;
  // The fraction of the drawn square the speck really covers.
  vCover = 0.785398 * diameter * diameter / (drawn * drawn);
}
`;

export const MOTE_FRAG = /* glsl */ `#version 300 es
${COMMON}
${SHADOW}
in vec3 vWorldPos;
in float vCover;
in float vSeed;
${PANE_CLIP}

uniform sampler2D uCaustics;
uniform vec2 uCausticsExtent;
uniform float uWaterY;
uniform float uTime;

out vec4 fragColour;

void main() {
  // Only where this pass's pane is the one the eye sees it through; see
  // APPARENT_POSITION.
  if (!seenThroughThisPane(vWorldPos)) discard;

  // --- The light reaching the speck ---
  //
  // The caustic map holds the pattern where the light lands on the sand. Part
  // way down, the rays have had less distance to gather, and for gentle
  // ripples how far the light is from even grows in step with the distance
  // below the surface — so the pattern at a speck is the one on the sand where
  // its ray lands, faded by how far down it is.
  vec3 Lw = normalize(uLightDirWater);
  float depthBelow = max(0.0, uWaterY - vWorldPos.y);
  float waterDepth = uWaterY - uWaterMin.y;
  vec2 floorXZ = vWorldPos.xz - Lw.xz / Lw.y * (vWorldPos.y - uWaterMin.y);
  vec2 cuv = vec2(
    (floorXZ.x + uCausticsExtent.x) / (2.0 * uCausticsExtent.x),
    (floorXZ.y + uCausticsExtent.y) / uCausticsExtent.y
  );
  float caustic = causticLight(texture(uCaustics, cuv).r, clamp(depthBelow / waterDepth, 0.0, 1.0));
  vec3 arriving = uLightColour * caustic * lightVisibility(vWorldPos, Lw) * transmittance(depthBelow);

  // --- The light it sends towards the eye ---
  //
  // A speck many times larger than the wavelength of light removes twice the
  // light that falls on its outline. Half of that is diffraction, bent only a
  // few degrees onward from the light's path; the other half is reflected and
  // refracted by the speck's surface and goes out in every direction. So a
  // speck looked at from the side glows faintly, and one between the eye and
  // the lamp shines. Irregular specks tumble slowly in the current, and the
  // part of their light that comes off a flat face brightens for a second or
  // two when that face turns towards the eye.
  vec3 V = normalize(uCameraPos - vWorldPos);
  float cosTheta = dot(-Lw, V);
  float tumble = pow(max(0.0, sin(6.2831853 * vSeed + uTime * (0.15 + 0.3 * fract(vSeed * 7.31)))), 8.0);
  float phase = 0.5 * phaseHG(cosTheta, 0.9) + 0.5 * (0.25 / PI) * (0.6 + 3.0 * tumble);
  vec3 albedo = vec3(0.80, 0.78, 0.70);   // pale, faintly warm: plant and food debris
  vec3 radiance = arriving * albedo * 2.0 * phase + albedo * uAmbient * 0.25;
  radiance *= uWaterTint;

  // Spread the speck's light over the drawn square: a soft spot whose average
  // over the square is the fraction the speck really covers.
  vec2 pc = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(pc, pc);
  float alpha = vCover >= 0.785
    ? smoothstep(1.0, 0.8, sqrt(r2))
    : min(1.0, vCover * exp(-4.5 * r2) / 0.1736);
  fragColour = vec4(tonemap(radiance * uExposure), alpha);
}
`;

/**
 * One step of the fine ripple layer (see render/ripples.ts): the wave
 * equation, with the damping of the surface film, on a grid whose edges are
 * the glass. Reading past the edge returns the edge itself, which is what a
 * wall that reflects waves amounts to.
 */
export const RIPPLE_STEP_FRAG = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;

uniform sampler2D uState;     // r: height, mm; g: its rate of change, mm/s
uniform vec2 uCell;           // metres between grid points, x and z
uniform vec2 uOrigin;         // world x, z of the grid's corner
uniform float uDt;
uniform float uSpeed2;
uniform float uViscosity;
uniform float uDecay;
uniform int uTouchCount;
uniform vec4 uTouchA[16];     // x, z, surface speed given at the centre (mm/s), 1 / (2 sigma^2)
uniform vec4 uTouchB[16];     // 1 / (2 w^2) of the wider part, its relative height, 1 if a displacement

out vec4 state;

vec2 at(ivec2 p) {
  p = clamp(p, ivec2(0), textureSize(uState, 0) - 1);
  return texelFetch(uState, p, 0).rg;
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 c = at(p);
  vec2 lap = (at(p - ivec2(1, 0)) + at(p + ivec2(1, 0)) - 2.0 * c) / (uCell.x * uCell.x)
           + (at(p - ivec2(0, 1)) + at(p + ivec2(0, 1)) - 2.0 * c) / (uCell.y * uCell.y);
  float v = c.g + uDt * (uSpeed2 * lap.r + uViscosity * lap.g - uDecay * c.g);

  vec2 pos = uOrigin + (vec2(p) + 0.5) * uCell;
  float lift = 0.0;
  for (int i = 0; i < 16; i++) {
    if (i >= uTouchCount) break;
    vec2 d = pos - uTouchA[i].xy;
    float d2 = dot(d, d);
    float shape = uTouchA[i].z * (exp(-d2 * uTouchA[i].w) - uTouchB[i].y * exp(-d2 * uTouchB[i].x));
    if (uTouchB[i].z > 0.5) lift += shape; else v += shape;
  }

  state = vec4(c.r + uDt * v + lift, v, 0.0, 1.0);
}
`;

/** The ripple layer's height and slopes, for the shaders that draw with it. */
export const RIPPLE_RESOLVE_FRAG = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uState;
uniform vec2 uCell;
out vec4 result;
float h(ivec2 p) {
  p = clamp(p, ivec2(0), textureSize(uState, 0) - 1);
  return texelFetch(uState, p, 0).r;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  // Heights are in millimetres, so the slopes come out a thousand times too
  // big in metres per metre.
  float gx = (h(p + ivec2(1, 0)) - h(p - ivec2(1, 0))) / (2.0 * uCell.x) * 1e-3;
  float gz = (h(p + ivec2(0, 1)) - h(p - ivec2(0, 1))) / (2.0 * uCell.y) * 1e-3;
  result = vec4(h(p), gx, gz, 1.0);
}
`;
