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

// The caustic map is an accumulation of ray splats, and its absolute level
// depends on how many rays were splatted. This scales it so that a perfectly
// flat surface reads exactly 1.0; measured once at start-up from that flat
// surface, so focusing brightens and defocusing darkens relative to a level
// that means something.
uniform float uCausticNorm;
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
// flat, brighter where rays converge, darker where they spread.
float causticLight(float raw, float strength) {
  return mix(1.0, raw * uCausticNorm, strength);
}

// The room above the tank, for the surface to reflect. There is no room
// geometry, so this is analytic: a dark ceiling, and the hood lamp — a warm
// strip above the tank — which is what a real aquarium surface reflects, as a
// bright stretched streak that breaks up with every ripple.
vec3 envColour(vec3 from, vec3 dir) {
  // A lit room: a wall across from the tank, brighter towards the ceiling, so
  // that from a low viewing angle the surface has something to reflect. Made
  // near-black the first time, and from eye level the surface simply vanished.
  vec3 room = mix(vec3(0.07, 0.075, 0.085), vec3(0.24, 0.25, 0.27), clamp(dir.y * 0.8 + 0.4, 0.0, 1.0));
  // The wall behind the viewer, with a window or a lamp on it: a broad soft
  // glow in the direction the surface reflects when looked at from the front
  // and a little above. This is what the surface of a tank on a desk shows.
  float win = max(0.0, dot(dir, normalize(vec3(0.0, 0.45, 1.0))));
  room += vec3(0.9, 0.88, 0.85) * pow(win, 6.0) * 0.55;
  if (dir.y <= 1e-4) return room;
  float lampY = uWaterMax.y + 0.16;
  float t = (lampY - from.y) / dir.y;
  vec3 hit = from + dir * t;
  // A lamp the width of the tank, set back over its middle.
  float inX = smoothstep(0.02, 0.0, abs(hit.x) - uWaterMax.x * 0.9);
  float inZ = smoothstep(0.02, 0.0, abs(hit.z - (uWaterMin.z + uWaterMax.z) * 0.5) - 0.045);
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

// ---------------------------------------------------------------------------
// Scene: body, fins, tank, plants
// ---------------------------------------------------------------------------

export const SCENE_VERT = /* glsl */ `#version 300 es
${COMMON}

in vec3 aPosition;
in vec3 aNormal;
in vec2 aUV;
in vec2 aExtra;

uniform mat4 uViewProjection;
uniform vec3 uCameraPos;

out vec3 vWorldPos;
out vec3 vNormal;
out vec2 vUV;
out vec2 vExtra;
out vec3 vView;

${APPARENT_POSITION}

void main() {
  vWorldPos = aPosition;
  vNormal = normalize(aNormal);
  vUV = aUV;
  vExtra = aExtra;
  vView = normalize(uCameraPos - aPosition);
  gl_Position = uViewProjection * vec4(apparentPosition(aPosition), 1.0);
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

  vec3 lit = uLightColour * causticMod * NdotL;
  vec3 colour = albedo * (lit + uAmbient);
  colour += specular * lit;
  // Iridescence is a reflection off the guanine platelets, so it lives near
  // the specular direction and at grazing angles, not spread evenly over the
  // flank as a diffuse glow. Weighted evenly it washes the whole fish to a
  // pinkish white and the pigment never shows through.
  float irisView = 0.02 + 0.45 * pow(1.0 - NdotV, 3.0);
  float irisGlint = D * 0.2;
  colour += iridescence * irisMask * (irisView + irisGlint) * (lit * 0.6 + uAmbient * 0.4);

  // --- Subsurface ---
  //
  // Wrapped diffuse plus a back-lit term. Fish flesh is thin and translucent
  // near the edges; without this the silhouette reads as cut from card.
  float wrap = max(0.0, (dot(N, L) + 0.45) / 1.45);
  float back = pow(max(0.0, dot(V, -L)), 4.0);
  vec3 sss = vec3(0.85, 0.2, 0.16) * (wrap * 0.30 + back * 0.55);
  float thin = 1.0 - smoothstep(0.0, 0.55, NdotV); // grazing angles are thin
  colour += sss * uLightColour * thin * 0.3;

  // --- The eye, over everything else ---
  if (eyeMask > 0.0) {
    float eNdotV = max(dot(eyeN, V), 1e-4);
    float eNdotL = max(dot(eyeN, L), 0.0);
    // A black pupil filling most of it, a thin ring of dark gold iris, and
    // a darker rim where it meets the skin.
    float pupil = 1.0 - smoothstep(0.58, 0.66, eyeD);
    vec3 iris = mix(vec3(0.07, 0.035, 0.01), vec3(0.02, 0.01, 0.008), smoothstep(0.8, 1.0, eyeD));
    vec3 eyeAlbedo = mix(iris, vec3(0.0), pupil);
    vec3 eyeCol = eyeAlbedo * (uLightColour * eNdotL * 0.6 + uAmbient);
    // The cornea is a clean wet lens: a sharp highlight and a reflection of
    // the room, both far brighter than the skin's.
    vec3 eH = normalize(V + L);
    float eD = distributionGGX(max(dot(eyeN, eH), 0.0), 0.06);
    float eF = fresnelSchlick(eNdotV, 0.03);
    eyeCol += uLightColour * eD * 0.02 * eNdotL;
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
// 0 caudal, 1 dorsal, 2 anal, 3 pelvic.
uniform float uFinShape;
// How many bony rays to draw across the fin. Unrelated to how many the
// physics simulates: those are the sheet's grid, these are anatomy.
uniform float uRayCount;

out vec4 fragColour;

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
  float reach = finReach(across);
  // Ray tips run slightly beyond the webbing, giving a finely scalloped edge,
  // and the edge wanders a little so it is not ruled.
  float tip = pow(1.0 - clamp(2.0 * abs(f), 0.0, 1.0), 3.0);
  reach += 0.035 * tip + 0.05 * (noise2(vec2(across * 5.0, 1.7 * uFinShape)) - 0.5);
  if (uFinShape > 2.5) {
    // Pelvic streamers taper to a point.
    float halfWidth = 0.5 * pow(max(0.0, 1.0 - along), 0.7);
    if (abs(across - 0.5) > halfWidth) discard;
  }
  float edge = along / max(0.05, reach);
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
  vec3 lit = uLightColour * causticLight(texture(uCaustics, cuv).r, 0.75 * exp(-depthBelow * 1.5));
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

/** Substrate, walls, plants. `aExtra.x` selects which. */
export const TANK_FRAG = /* glsl */ `#version 300 es
${COMMON}

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

  vec3 albedo;
  float roughness;

  if (kind < 0.5) {
    // Sand. Individual grains, at two scales so it does not read as one texture
    // frequency, and slightly warm.
    float grain = noise2(vUV * 420.0) * 0.5 + noise2(vUV * 1400.0) * 0.5;
    albedo = mix(vec3(0.20, 0.17, 0.14), vec3(0.42, 0.37, 0.30), grain);
    // A scattering of darker grains, which is what makes real sand read as
    // granular rather than as noise.
    float dark = step(0.86, noise2(vUV * 900.0 + 13.0));
    albedo *= 1.0 - dark * 0.45;
    roughness = 0.9;
  } else if (kind < 1.5) {
    // Glass seen from inside, and the darkness beyond it.
    albedo = vec3(0.04, 0.055, 0.06);
    roughness = 0.25;
  } else {
    // Plant leaf. Translucent, with veins.
    float vein = smoothstep(0.02, 0.0, abs(fract(vUV.x * 5.0) - 0.5) - 0.44);
    albedo = mix(vec3(0.055, 0.16, 0.055), vec3(0.10, 0.26, 0.09), vUV.y);
    albedo = mix(albedo, albedo * 1.5, vein);
    roughness = 0.55;
  }

  float NdotL = max(dot(N, L), 0.0);

  vec2 cuv = vec2(
    (vWorldPos.x + uCausticsExtent.x) / (2.0 * uCausticsExtent.x),
    (vWorldPos.z + uCausticsExtent.y) / uCausticsExtent.y
  );
  float depthBelow = max(0.0, uWaterY - vWorldPos.y);
  float underWater = step(vWorldPos.y, uWaterY);
  vec3 lit = uLightColour * NdotL
    * causticLight(texture(uCaustics, cuv).r,
                   0.9 * underWater * exp(-depthBelow * 1.2) * smoothstep(-0.2, 0.5, N.y));
  vec3 colour = albedo * (lit + uAmbient);

  // Leaves are thin enough to glow when the light is behind them.
  if (kind > 1.5) {
    float back = pow(max(0.0, dot(V, -L)), 2.5);
    colour += vec3(0.10, 0.30, 0.08) * back * uLightColour * 1.4;
  }

  // Specular from the wet sand and the leaf surfaces.
  vec3 H = normalize(V + L);
  float D = distributionGGX(max(dot(N, H), 0.0), roughness);
  colour += uLightColour * D * 0.04 * NdotL;

  colour *= transmittance(depthBelow);
  colour *= uWaterTint;

  fragColour = vec4(tonemap(colour * uExposure), 1.0);
}
`;

// ---------------------------------------------------------------------------
// Caustics
// ---------------------------------------------------------------------------

/**
 * Caustics, computed rather than looped.
 *
 * A grid of light rays is refracted through the real water surface with Snell's
 * law and projected onto the substrate. Where neighbouring rays converge, the
 * light concentrates; the brightness at a point is the ratio of the original
 * cell's area to the deformed cell's area — the Jacobian of the refraction map.
 *
 * The alternative is a looping caustic texture, which is what most real-time
 * water uses. It is cheaper and it is wrong in a way that shows the moment
 * anything disturbs the water: the dapples carry on their pre-recorded dance
 * while the surface they are supposedly cast by does something else entirely.
 * Here, a pellet hitting the surface sends a ring through the caustics because
 * it sent a ring through the water.
 *
 * Drawn as points with additive blending, which is the WebGL2 way of scattering
 * into a target.
 */
export const CAUSTICS_VERT = /* glsl */ `#version 300 es
precision highp float;

in vec2 aGrid;                 // 0..1 across the water surface

uniform sampler2D uHeightMap;  // r = surface displacement
uniform vec2 uGridSize;
uniform vec2 uTankExtent;      // half-width, depth
uniform float uWaterY;
uniform float uFloorY;
uniform vec3 uLightDir;
uniform float uIOR;

out float vIntensity;

// Where does a light ray hitting the surface at this grid point land?
vec2 refractTo(vec2 g) {
  float h = texture(uHeightMap, g).r;
  vec2 texel = 1.0 / uGridSize;
  float hL = texture(uHeightMap, g - vec2(texel.x, 0.0)).r;
  float hR = texture(uHeightMap, g + vec2(texel.x, 0.0)).r;
  float hD = texture(uHeightMap, g - vec2(0.0, texel.y)).r;
  float hU = texture(uHeightMap, g + vec2(0.0, texel.y)).r;

  vec2 world = vec2(
    (g.x - 0.5) * 2.0 * uTankExtent.x,
    -uTankExtent.y + g.y * uTankExtent.y
  );
  float dx = (2.0 * uTankExtent.x) * texel.x;
  float dz = uTankExtent.y * texel.y;
  vec3 n = normalize(vec3(-(hR - hL) / (2.0 * dx), 1.0, -(hU - hD) / (2.0 * dz)));

  // Snell's law, vector form. Air to water, so the ray bends towards the normal.
  vec3 i = normalize(-uLightDir);
  float eta = 1.0 / uIOR;
  float cosi = -dot(n, i);
  float k = 1.0 - eta * eta * (1.0 - cosi * cosi);
  vec3 refracted = (k < 0.0) ? reflect(i, n) : eta * i + (eta * cosi - sqrt(k)) * n;

  // Project to the floor.
  float surfaceY = uWaterY + h;
  float t = (uFloorY - surfaceY) / min(-1e-4, refracted.y);
  return world + refracted.xz * t;
}

void main() {
  vec2 texel = 1.0 / uGridSize;

  vec2 p00 = refractTo(aGrid);
  vec2 p10 = refractTo(aGrid + vec2(texel.x, 0.0));
  vec2 p01 = refractTo(aGrid + vec2(0.0, texel.y));

  // Area of the deformed cell against the area it started with. Where rays
  // converge the ratio is large and the light piles up.
  vec2 e1 = p10 - p00;
  vec2 e2 = p01 - p00;
  float deformedArea = abs(e1.x * e2.y - e1.y * e2.x);
  float originalArea = (2.0 * uTankExtent.x * texel.x) * (uTankExtent.y * texel.y);
  vIntensity = clamp(originalArea / max(1e-9, deformedArea), 0.0, 12.0);

  // To clip space over the floor.
  vec2 uv = vec2(
    (p00.x + uTankExtent.x) / (2.0 * uTankExtent.x),
    (p00.y + uTankExtent.y) / uTankExtent.y
  );
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 2.0;
}
`;

export const CAUSTICS_FRAG = /* glsl */ `#version 300 es
precision highp float;
in float vIntensity;
out vec4 fragColour;
void main() {
  // Soften the point into a small disc so the accumulation does not alias into
  // a grid of dots.
  vec2 d = gl_PointCoord - 0.5;
  float falloff = exp(-8.0 * dot(d, d));
  fragColour = vec4(vec3(vIntensity * falloff * 0.06), 1.0);
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

out vec4 fragColour;

void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(vView);
  bool fromBelow = dot(N, V) < 0.0;
  if (fromBelow) N = -N;

  // Small-scale ripples the height field does not resolve. Two layers drifting
  // against each other, so it never reads as a single scrolling pattern.
  vec2 rippleUV = vWorldPos.xz * 260.0;
  float r1 = noise2(rippleUV + vec2(uTime * 0.6, uTime * 0.35));
  float r2 = noise2(rippleUV * 1.7 - vec2(uTime * 0.42, uTime * 0.71));
  vec3 rippleNormal = normalize(vec3((r1 - 0.5) * 0.10, 1.0, (r2 - 0.5) * 0.10));
  N = normalize(N + rippleNormal * 0.35 - vec3(0.0, 0.35, 0.0));

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
  vec3 R = reflect(-V, N);
  vec2 reflUV = clamp(screenUV + N.xz * 0.06, vec2(0.001), vec2(0.999));
  vec4 reflTex = texture(uReflection, reflUV);
  vec3 reflected = mix(envColour(vWorldPos, R), reflTex.rgb, reflTex.a);
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
  colour += uLightColour * spec * 0.35 * (1.0 - float(fromBelow) * 0.7);

  fragColour = vec4(tonemap(colour * uExposure), 1.0);
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
uniform float uParticleDensity;

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
    // Inside the box the apparent path is the true path over the index.
    underwater = (apparentLength - tEnter) * max(1.0, uRefractIOR);
  }


  vec3 T = transmittance(underwater);

  // In-scattering. The Henyey-Greenstein phase function makes the haze brighten
  // sharply when looking towards the light, which is what a real beam in water
  // does and what a constant fog term cannot do.
  float cosTheta = dot(dir, normalize(uLightDir));
  float phase = phaseHG(cosTheta, 0.68);
  vec3 inScatter = uLightColour * uScattering * phase * underwater * 4.0;

  vec3 colour = scene * T + inScatter;

  // Suspended particulate — the motes drifting in any real tank. Sparse, and
  // only visible when the light catches them.
  float motes = 0.0;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    vec2 p = vUV * (60.0 + fi * 37.0) + vec2(uTime * (0.01 + fi * 0.004), uTime * 0.006);
    float n = noise2(p);
    motes += smoothstep(0.975, 1.0, n) * (1.0 - fi * 0.3);
  }
  colour += vec3(0.8, 0.85, 0.8) * motes * uParticleDensity * (0.3 + phase * 2.0);

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
