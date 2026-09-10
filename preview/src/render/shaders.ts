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

// Where a point under water *appears* to be from an eye outside it.
//
// Light from a point inside the tank bends at the pane on its way out, and to
// the eye the point sits closer than it is: a tank 25 cm deep looks about 19.
// Every fish tank does this and it is one of the strongest cues that there is
// water behind the glass rather than air, because the sand, the plants and the
// fish all shift against the frame as the viewer moves.
//
// This is the paraxial result — the part of the path inside the water appears
// shortened by the index of refraction, along the line of sight — applied per
// vertex. Exact for near-normal viewing, and within a degree or two over the
// angles a person looks into a tank at.
vec3 apparentPosition(vec3 p) {
  if (uRefractIOR <= 1.0) return p;
  bool eyeInside = all(greaterThan(uCameraPos, uWaterMin)) && all(lessThan(uCameraPos, uWaterMax));
  bool pointInside = all(greaterThanEqual(p, uWaterMin - 1e-4)) && all(lessThanEqual(p, uWaterMax + 1e-4));
  if (eyeInside || !pointInside) return p;
  vec3 d = p - uCameraPos;
  d += vec3(equal(d, vec3(0.0))) * 1e-7;
  vec3 t0 = (uWaterMin - uCameraPos) / d;
  vec3 t1 = (uWaterMax - uCameraPos) / d;
  vec3 tn = min(t0, t1);
  float tEnter = clamp(max(max(tn.x, tn.y), tn.z), 0.0, 1.0);
  vec3 q = uCameraPos + d * tEnter;
  return q + (p - q) / uRefractIOR;
}

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
 *   3. the pigment layer, with a scale pattern,
 *   4. subsurface scattering, which is what stops thin parts reading as plastic.
 */
export const FISH_FRAG = /* glsl */ `#version 300 es
${COMMON}
${THIN_FILM}

in vec3 vWorldPos;
in vec3 vNormal;
in vec2 vUV;
in vec2 vExtra;
in vec3 vView;

uniform sampler2D uCaustics;
uniform float uWaterY;
uniform vec3 uBaseColour;
uniform vec3 uBellyColour;
uniform float uRoughness;
uniform vec2 uCausticsExtent;   // tank half-width, depth
uniform float uTime;

out vec4 fragColour;

void main() {
  if ((vWorldPos.y - uWaterY) * uClipSide < 0.0) discard;
  vec3 N = normalize(vNormal);
  vec3 V = normalize(vView);
  vec3 L = normalize(uLightDir);
  vec3 H = normalize(V + L);

  float NdotV = max(dot(N, V), 1e-4);
  float NdotL = max(dot(N, L), 0.0);
  float NdotH = max(dot(N, H), 0.0);

  // --- Scales ---
  //
  // A hexagonal-ish lattice running along the body. The pattern perturbs both
  // the normal and the film thickness, so the iridescence breaks up into
  // individual scales rather than sliding across the fish as one sheet.
  float along = vExtra.x;
  vec2 scaleUV = vec2(vUV.x * 26.0, along * 34.0);
  vec2 cell = floor(scaleUV);
  // Offset alternate rows, which is how fish scales actually tile.
  scaleUV.x += mod(cell.y, 2.0) * 0.5;
  cell = floor(scaleUV);
  vec2 local = fract(scaleUV) - 0.5;
  float scaleEdge = smoothstep(0.42, 0.5, max(abs(local.x), abs(local.y) * 0.85));
  float scaleJitter = hash21(cell) - 0.5;

  // Perturb the normal so each scale is a slightly domed plate.
  vec3 tangent = normalize(cross(N, vec3(0.0, 1.0, 0.0)) + vec3(1e-4));
  vec3 bitangent = cross(N, tangent);
  // Gentle doming. At 0.35 every scale's rim was a grazing angle and the
  // iridescence lit up across the whole flank, which read as pink-white
  // rather than red with a sheen.
  N = normalize(N + (tangent * local.x + bitangent * local.y) * 0.16 * (1.0 - scaleEdge));
  NdotV = max(dot(N, V), 1e-4);
  NdotL = max(dot(N, L), 0.0);
  NdotH = max(dot(N, normalize(V + L)), 0.0);

  // --- Thin-film iridescence ---
  float thickness = uFilmThickness + scaleJitter * 90.0
    + 40.0 * sin(along * 9.0 + uTime * 0.05);
  vec3 iridescence = thinFilm(NdotV, thickness);

  // --- Pigment ---
  //
  // Darker along the back, paler on the belly. Countershading is nearly
  // universal in fish and its absence is immediately readable, even to someone
  // who has never thought about why.
  float ventral = smoothstep(-0.2, 0.9, -N.y);
  vec3 albedo = mix(uBaseColour, uBellyColour, ventral * 0.75);
  albedo *= 1.0 - scaleEdge * 0.25;
  // The head is less iridescent than the flank, as it is on the real animal.
  float irisMask = smoothstep(0.05, 0.35, along) * (1.0 - scaleEdge * 0.5);

  // --- Direct lighting ---
  float D = distributionGGX(NdotH, uRoughness);
  float G = geometrySmith(NdotV, NdotL, uRoughness);
  vec3 F = fresnelSchlick3(max(dot(normalize(V + L), V), 0.0), vec3(0.04));
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
                                  0.85 * smoothstep(-0.1, 0.4, N.y) * exp(-depthBelow * 1.5));

  vec3 lit = uLightColour * causticMod * NdotL;
  vec3 colour = albedo * (lit + uAmbient);
  colour += specular * lit * 1.2;
  // Iridescence is a reflection off the guanine platelets, so it lives near
  // the specular direction and at grazing angles, not spread evenly over the
  // flank as a diffuse glow. Weighted evenly it washed the whole fish to a
  // pinkish white; the pigment never showed through.
  float irisView = 0.05 + 0.95 * pow(1.0 - NdotV, 3.0);
  float irisGlint = D * 0.25;
  colour += iridescence * irisMask * (irisView + irisGlint) * (lit * 0.7 + uAmbient * 0.5);

  // --- Subsurface ---
  //
  // Wrapped diffuse plus a back-lit term. Fish flesh is thin and translucent
  // near the edges; without this the silhouette reads as cut from card.
  float wrap = max(0.0, (dot(N, L) + 0.45) / 1.45);
  float back = pow(max(0.0, dot(V, -L)), 4.0);
  vec3 sss = vec3(0.95, 0.42, 0.34) * (wrap * 0.30 + back * 0.55);
  float thin = 1.0 - smoothstep(0.0, 0.55, NdotV); // grazing angles are thin
  colour += sss * uLightColour * thin * 0.35;

  // The water between the fish and the eye takes some of the light out.
  float distanceThroughWater = length(vWorldPos - (vWorldPos + vView * 0.0));
  colour *= transmittance(depthBelow * 0.5 + distanceThroughWater);
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
 * darker struts. Shading it as an opaque surface with a colour map is what makes
 * most rendered fish look like toys.
 */
export const FIN_FRAG = /* glsl */ `#version 300 es
${COMMON}
${THIN_FILM}

in vec3 vWorldPos;
in vec3 vNormal;
in vec2 vUV;
in vec2 vExtra;
in vec3 vView;

uniform sampler2D uCaustics;
uniform float uWaterY;
uniform vec3 uFinColour;
uniform vec2 uCausticsExtent;
uniform float uTime;

out vec4 fragColour;

void main() {
  if ((vWorldPos.y - uWaterY) * uClipSide < 0.0) discard;
  vec3 N = normalize(vNormal);
  vec3 V = normalize(vView);
  vec3 L = normalize(uLightDir);

  // A fin has no front and no back — it is a sheet — so flip the normal to
  // whichever side is facing us before doing any lighting.
  if (dot(N, V) < 0.0) N = -N;

  float NdotV = max(dot(N, V), 1e-4);
  float NdotL = abs(dot(N, L));

  float across = vUV.x;     // 0 to 1 across the rays
  float along = vExtra.x;   // 0 at the body, 1 at the trailing edge
  float thicknessMm = vExtra.y;

  // --- Rays ---
  //
  // The bony struts, running out from the body and branching towards the edge as
  // real ones do.
  float rayCoord = across * float(${'${RAY_COUNT}'});
  float rayPhase = fract(rayCoord * (1.0 + step(0.55, along)));
  float ray = 1.0 - smoothstep(0.06, 0.30, abs(rayPhase - 0.5));

  // --- Transmission ---
  //
  // Beer-Lambert through the membrane. It is thin enough that most light gets
  // through, and the rays are the parts that stop it.
  float thickness = thicknessMm * (1.0 + ray * 2.2);
  float sigma = 2.2;  // per millimetre
  float through = exp(-sigma * thickness / max(0.15, NdotV));
  // Strongest when looking towards the light through the fin.
  float backlight = pow(max(0.0, dot(V, -L)), 3.0);

  // --- Colour ---
  //
  // Betta fin membrane is a saturated wash that deepens towards the edge, with
  // the iridescent sheen concentrated near the body where the scales reach onto
  // the fin base.
  vec3 tint = uFinColour * (0.55 + 0.45 * smoothstep(0.0, 0.8, along));
  vec3 iridescence = thinFilm(NdotV, uFilmThickness * 0.8 + 60.0 * sin(across * 18.0 + uTime * 0.03));
  float sheen = (1.0 - smoothstep(0.05, 0.5, along)) * 0.5;

  vec2 cuv = vec2(
    (vWorldPos.x + uCausticsExtent.x) / (2.0 * uCausticsExtent.x),
    (vWorldPos.z + uCausticsExtent.y) / uCausticsExtent.y
  );
  float depthBelow = max(0.0, uWaterY - vWorldPos.y);
  vec3 lit = uLightColour * causticLight(texture(uCaustics, cuv).r, 0.75 * exp(-depthBelow * 1.5));
  vec3 colour = tint * (NdotL * lit * 0.55 + uAmbient);
  colour += tint * through * (backlight * 2.6 + 0.35) * lit;
  colour += iridescence * sheen * (lit * 0.4 + uAmbient);
  colour *= 1.0 - ray * 0.35;

  colour *= transmittance(depthBelow * 0.5);
  colour *= uWaterTint;

  // A fin is genuinely see-through, and how much depends on the angle and on
  // whether we are looking at membrane or at a ray.
  float alpha = clamp(0.30 + 0.55 * (1.0 - through) + ray * 0.35, 0.0, 1.0);
  alpha *= mix(1.0, 0.75, smoothstep(0.5, 1.0, along));

  fragColour = vec4(tonemap(colour * uExposure), alpha);
}
`.replace('${RAY_COUNT}', '9');

/** Substrate, walls, plants. `aExtra.x` selects which. */
export const TANK_FRAG = /* glsl */ `#version 300 es
${COMMON}

in vec3 vWorldPos;
in vec3 vNormal;
in vec2 vUV;
in vec2 vExtra;
in vec3 vView;

uniform sampler2D uCaustics;
uniform float uWaterY;
uniform vec2 uCausticsExtent;
uniform float uTime;

out vec4 fragColour;

void main() {
  if ((vWorldPos.y - uWaterY) * uClipSide < 0.0) discard;
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
// Same apparent-depth shift as the scene geometry; see SCENE_VERT.
vec3 apparentPosition(vec3 p) {
  if (uRefractIOR <= 1.0) return p;
  bool eyeInside = all(greaterThan(uCameraPos, uWaterMin)) && all(lessThan(uCameraPos, uWaterMax));
  bool pointInside = all(greaterThanEqual(p, uWaterMin - 1e-4)) && all(lessThanEqual(p, uWaterMax + 1e-4));
  if (eyeInside || !pointInside) return p;
  vec3 d = p - uCameraPos;
  d += vec3(equal(d, vec3(0.0))) * 1e-7;
  vec3 t0 = (uWaterMin - uCameraPos) / d;
  vec3 t1 = (uWaterMax - uCameraPos) / d;
  vec3 tn = min(t0, t1);
  float tEnter = clamp(max(max(tn.x, tn.y), tn.z), 0.0, 1.0);
  vec3 q = uCameraPos + d * tEnter;
  return q + (p - q) / uRefractIOR;
}
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
uniform float uWaterY;
out vec4 fragColour;
void main() {
  vec2 d = vUV * 2.0 - 1.0;
  float r2 = dot(d, d);
  if (r2 > 1.0) discard;
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
uniform float uWaterY;
out vec4 fragColour;
void main() {
  vec2 d = vUV * 2.0 - 1.0;
  float r2 = dot(d, d);
  if (r2 > 1.0) discard;
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
