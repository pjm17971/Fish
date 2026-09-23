/**
 * The preview renderer.
 *
 * Pass order, and why:
 *
 *   1. **Caustics.** A mesh of light rays is refracted through the current water
 *      surface and laid additively onto a map of the tank floor, then
 *      blurred. This runs first because everything else reads it.
 *   1b. **Shadows.** Depth from the light's point of view for the solid things,
 *      and the light the fins let through, for everything else to look up.
 *   2. **Scene.** The room, the tank, its planting and hardscape, the fish,
 *      the glass, the fins and the pellets, into an offscreen colour target
 *      with depth.
 *   3. **Volume.** A full-screen pass that applies what the water does to light
 *      on its way out: Beer-Lambert absorption over the path length, and
 *      in-scattering from suspended particulate.
 *   4. **Surface.** The water surface, which refracts the pass-3 result and
 *      reflects the room, with a proper Fresnel mix.
 *   5. **Post.** Tone mapping, a touch of chromatic aberration and grain.
 *
 * The volume pass has to come before the surface and after the scene, because
 * the absorption applies to the light travelling from the object to the eye and
 * the surface then bends what is left. Doing the surface first and fogging
 * afterwards is the more common arrangement and it puts the haze in front of the
 * reflections, which looks like a dirty window rather than deep water.
 */

import {
  createContext,
  createProgram,
  createRenderTarget,
  Mesh,
  Program,
  RenderTarget,
} from './gl.js';
import {
  SCENE_VERT,
  FISH_FRAG,
  FIN_FRAG,
  TANK_FRAG,
  GLASS_FRAG,
  ROOM_FRAG,
  WATER_FRAG,
  CAUSTICS_VERT,
  CAUSTICS_FRAG,
  BLUR_VERT,
  BLUR_FRAG,
  VOLUME_FRAG,
  POST_FRAG,
  SHADOW_FRAG,
  FIN_SHADOW_FRAG,
  PARTICLE_VERT,
  MOTE_VERT,
  MOTE_FRAG,
  PELLET_FRAG,
  BUBBLE_FRAG,
} from './shaders.js';
import {
  BodyMesh,
  FinMesh,
  WaterMesh,
  VERTEX_ATTRIBUTES,
  VERTEX_STRIDE,
  billboard,
} from './meshes.js';
import { visiblePanes } from './refraction.js';
import {
  buildTankMesh,
  buildGlassMesh,
  buildHardscape,
  buildPlantsMesh,
  buildRoomMesh,
  BuiltMesh,
} from './scenery.js';
import { World } from '../sim/world.js';
import { Particulate, PARTICULATE_FLOATS } from './particulate.js';
import { RippleLayer } from './ripples.js';
import { OPTICS, TANK, TANK_MIN_Z, WATER_DEPTH } from '../sim/config.js';
import {
  Mat4,
  mat4,
  mat4Multiply,
  mat4Invert,
  mat4LookAt,
  mat4Perspective,
  v3,
  Vec3,
  sub,
  cross,
  normalize,
  copy,
} from '../sim/math.js';

const CAUSTIC_SIZE = 1024;

/**
 * The caustic ray mesh. Under a millimetre between rays, so even the shortest
 * ripple is crossed by ten of them and a focused line is drawn by many
 * triangles rather than by one stretched one.
 */
const CAUSTIC_GRID_X = 480;
const CAUSTIC_GRID_Z = 340;
/**
 * How far past the walls the ray mesh reaches, as a fraction of the tank. The
 * light comes in at a slant, so rays entering just outside the water's
 * footprint are the ones that land along the front of the floor; without them
 * the front strip of sand reads as unlit.
 */
const CAUSTIC_MARGIN = 0.12;

/**
 * The tank light: above and slightly forward, which is where an aquarium hood
 * puts it. Pointing towards the light.
 */
const LIGHT_DIR = normalize(v3(), v3(0.12, 0.96, 0.25));
/**
 * The lamp's angular radius seen from the water, in radians. An LED hood a
 * quarter of a metre above the sand, with emitters a few millimetres across,
 * subtends about this much. It sets how quickly a shadow's edge softens with
 * the distance between the thing casting it and the sand.
 */
const LIGHT_ANGLE = 0.02;
const SHADOW_SIZE = 1024;

/** The fins' pigment. The fin shadow pass needs it too: a red fin passes red light. */
const FIN_COLOUR = [0.52, 0.06, 0.09] as const;

/** The light's direction after bending at a flat water surface. */
function refractedLight(towardsLight: Vec3, ior: number): Vec3 {
  // Snell's law in vector form for the ray travelling down into the water,
  // then turned back round to point towards the light.
  const i = v3(-towardsLight.x, -towardsLight.y, -towardsLight.z);
  const eta = 1 / ior;
  const cosi = towardsLight.y;
  const k = 1 - eta * eta * (1 - cosi * cosi);
  const t = eta * cosi - Math.sqrt(k);
  const r = v3(-(eta * i.x), -(eta * i.y + t), -(eta * i.z));
  return normalize(r, r);
}

/** An orthographic projection, column-major like the rest of the matrices. */
function mat4Ortho(o: Mat4, l: number, r: number, b: number, t: number, n: number, f: number): Mat4 {
  o.fill(0);
  o[0] = 2 / (r - l);
  o[5] = 2 / (t - b);
  o[10] = -2 / (f - n);
  o[12] = -(r + l) / (r - l);
  o[13] = -(t + b) / (t - b);
  o[14] = -(f + n) / (f - n);
  o[15] = 1;
  return o;
}

/**
 * Per fin: which outline the fin shader cuts from the simulated sheet, and how
 * many bony rays to draw across it. The ray counts are a betta's, roughly: a
 * dozen-odd in the tail, fewer in the dorsal, over twenty along the anal fin.
 */
const FIN_LOOK: Record<string, { shape: number; rays: number }> = {
  caudal: { shape: 0, rays: 14 },
  dorsal: { shape: 1, rays: 10 },
  anal: { shape: 2, rays: 22 },
  pelvicLeft: { shape: 3, rays: 1 },
  pelvicRight: { shape: 3, rays: 1 },
};

export interface CameraState {
  /** Orbit angles, radians. */
  yaw: number;
  pitch: number;
  distance: number;
  target: Vec3;
}

export class Renderer {
  readonly gl: WebGL2RenderingContext;

  private readonly fishProgram: Program;
  private readonly finProgram: Program;
  private readonly tankProgram: Program;
  private readonly glassProgram: Program;
  private readonly roomProgram: Program;
  private readonly waterProgram: Program;
  private readonly causticsProgram: Program;
  private readonly blurProgram: Program;
  private readonly volumeProgram: Program;
  private readonly postProgram: Program;
  private readonly pelletProgram: Program;
  private readonly bubbleProgram: Program;
  private readonly shadowProgram: Program;
  private readonly finShadowProgram: Program;
  private readonly moteProgram: Program;

  private readonly bodyMesh: BodyMesh;
  private readonly bodyGpu: Mesh;
  private readonly finMeshes: FinMesh[] = [];
  private readonly finGpu: Mesh[] = [];
  private readonly waterMesh: WaterMesh;
  private readonly waterGpu: Mesh;
  private readonly tankGpu: Mesh;
  private readonly plantsGpu: Mesh;
  private readonly hardscapeGpu: Mesh;
  private readonly glassGpu: Mesh;
  private readonly roomGpu: Mesh;
  private readonly particleGpu: Mesh;
  private readonly quadGpu: Mesh;
  private readonly causticsGrid: Mesh;
  private readonly motesGpu: Mesh;
  private readonly ripples: RippleLayer;
  private readonly particulate = new Particulate();
  private lastTime = -1;

  private sceneTarget!: RenderTarget;
  private sceneDepth!: WebGLTexture;
  /** The scene from the camera mirrored in the water plane, for the surface. */
  private reflectionTarget!: RenderTarget;
  private reflectionDepth!: WebGLRenderbuffer;
  /** Reflection-pass clipping side; 0 in the main pass. */
  private clipSide = 0;
  /** Index applied to geometry seen through the panes; 1 in the reflection pass. */
  private refractIOR: number = OPTICS.iorWater;
  /** How far above the still waterline still counts as water; see uTopSlack. */
  private topSlack = 0;
  /**
   * The pane of the tank the current pass looks through, as its outward
   * normal; zero in the pass that draws what is out of the water.
   */
  private readonly pane = v3();
  /**
   * The top of the water box refraction works in: the waterline, except in
   * the reflection pass (see renderReflection).
   */
  private waterTop: number = TANK.waterY;
  private mirrored = false;
  private volumeTarget!: RenderTarget;
  private surfaceTarget!: RenderTarget;
  private causticsTarget!: RenderTarget;
  private causticsBlur!: RenderTarget;
  private heightTexture!: WebGLTexture;
  private heightData!: Float32Array;

  /** Depth of the solid things, seen from the light. */
  private shadowDepth!: WebGLTexture;
  private shadowFramebuffer!: WebGLFramebuffer;
  /**
   * Two ways of reading the same depth map: as plain numbers, to find how far
   * away a blocker is, and through the hardware's comparing filter, which
   * gives a smooth fraction at every lookup rather than a yes or no.
   */
  private shadowRawSampler!: WebGLSampler;
  private shadowCompareSampler!: WebGLSampler;
  /** The light the fins let through, and how high the topmost fin is. */
  private finShadowTarget!: RenderTarget;
  private readonly lightDirWater = refractedLight(LIGHT_DIR, OPTICS.iorWater);
  private readonly lightViewProjection = mat4();
  private shadowExtentX = 1;
  private shadowExtentY = 1;
  private shadowDepthRange = 1;

  private readonly view = mat4();
  private readonly projection = mat4();
  private readonly viewProjection = mat4();
  private readonly inverseViewProjection = mat4();
  private readonly cameraPos = v3();

  private readonly particleData = new Float32Array(64 * 6 * 5);

  private width = 1;
  private height = 1;
  private readonly cameraTarget = v3();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly world: World,
  ) {
    const gl = createContext(canvas);
    this.gl = gl;

    this.fishProgram = createProgram(gl, SCENE_VERT, FISH_FRAG, 'fish');
    this.finProgram = createProgram(gl, SCENE_VERT, FIN_FRAG, 'fin');
    this.tankProgram = createProgram(gl, SCENE_VERT, TANK_FRAG, 'tank');
    this.glassProgram = createProgram(gl, SCENE_VERT, GLASS_FRAG, 'glass');
    this.roomProgram = createProgram(gl, SCENE_VERT, ROOM_FRAG, 'room');
    this.waterProgram = createProgram(gl, SCENE_VERT, WATER_FRAG, 'water');
    this.causticsProgram = createProgram(gl, CAUSTICS_VERT, CAUSTICS_FRAG, 'caustics');
    this.blurProgram = createProgram(gl, BLUR_VERT, BLUR_FRAG, 'blur');
    this.volumeProgram = createProgram(gl, BLUR_VERT, VOLUME_FRAG, 'volume');
    this.postProgram = createProgram(gl, BLUR_VERT, POST_FRAG, 'post');
    this.pelletProgram = createProgram(gl, PARTICLE_VERT, PELLET_FRAG, 'pellet');
    this.bubbleProgram = createProgram(gl, PARTICLE_VERT, BUBBLE_FRAG, 'bubble');
    this.shadowProgram = createProgram(gl, SCENE_VERT, SHADOW_FRAG, 'shadow');
    this.finShadowProgram = createProgram(gl, SCENE_VERT, FIN_SHADOW_FRAG, 'fin shadow');
    this.moteProgram = createProgram(gl, MOTE_VERT, MOTE_FRAG, 'mote');

    // --- Geometry ---
    this.bodyMesh = new BodyMesh(world.morphology);
    this.bodyGpu = new Mesh(gl, this.fishProgram, VERTEX_ATTRIBUTES, VERTEX_STRIDE);
    this.bodyGpu.setVertices(this.bodyMesh.vertices, true);
    this.bodyGpu.setIndices(this.bodyMesh.indices);

    for (const fin of world.fins) {
      const mesh = new FinMesh(fin);
      const gpu = new Mesh(gl, this.finProgram, VERTEX_ATTRIBUTES, VERTEX_STRIDE);
      mesh.update();
      gpu.setVertices(mesh.vertices, true);
      gpu.setIndices(mesh.indices);
      this.finMeshes.push(mesh);
      this.finGpu.push(gpu);
    }

    this.waterMesh = new WaterMesh(world.water);
    this.waterGpu = new Mesh(gl, this.waterProgram, VERTEX_ATTRIBUTES, VERTEX_STRIDE);
    this.waterMesh.update();
    this.waterGpu.setVertices(this.waterMesh.vertices, true);
    this.waterGpu.setIndices(this.waterMesh.indices);

    const staticMesh = (program: Program, built: BuiltMesh): Mesh => {
      const m = new Mesh(gl, program, VERTEX_ATTRIBUTES, VERTEX_STRIDE);
      m.setVertices(built.vertices);
      m.setIndices(built.indices);
      return m;
    };
    this.tankGpu = staticMesh(this.tankProgram, buildTankMesh());
    this.plantsGpu = staticMesh(this.tankProgram, buildPlantsMesh());
    this.hardscapeGpu = staticMesh(this.tankProgram, buildHardscape());
    this.glassGpu = staticMesh(this.glassProgram, buildGlassMesh());
    this.roomGpu = staticMesh(this.roomProgram, buildRoomMesh());

    this.particleGpu = new Mesh(
      gl,
      this.pelletProgram,
      [
        { name: 'aPosition', size: 3, offset: 0 },
        { name: 'aUV', size: 2, offset: 12 },
      ],
      20,
    );
    this.particleGpu.setVertices(this.particleData, true);

    this.motesGpu = new Mesh(
      gl,
      this.moteProgram,
      [
        { name: 'aPosition', size: 3, offset: 0 },
        { name: 'aSpeck', size: 2, offset: 12 },
      ],
      PARTICULATE_FLOATS * 4,
    );
    this.motesGpu.setVertices(this.particulate.data, true);

    this.quadGpu = new Mesh(gl, this.blurProgram, [{ name: 'aPosition', size: 2, offset: 0 }], 8);
    this.quadGpu.setVertices(new Float32Array([-1, -1, 3, -1, -1, 3]));
    this.ripples = new RippleLayer(gl, world.water, this.quadGpu);

    // Caustics: a mesh of rays over the surface, a little wider than it.
    const grid = new Float32Array((CAUSTIC_GRID_X + 1) * (CAUSTIC_GRID_Z + 1) * 2);
    let g = 0;
    for (let j = 0; j <= CAUSTIC_GRID_Z; j++) {
      for (let i = 0; i <= CAUSTIC_GRID_X; i++) {
        grid[g++] = -CAUSTIC_MARGIN + ((1 + 2 * CAUSTIC_MARGIN) * i) / CAUSTIC_GRID_X;
        grid[g++] = -CAUSTIC_MARGIN + ((1 + 2 * CAUSTIC_MARGIN) * j) / CAUSTIC_GRID_Z;
      }
    }
    const gridIndices = new Uint32Array(CAUSTIC_GRID_X * CAUSTIC_GRID_Z * 6);
    let gi = 0;
    for (let j = 0; j < CAUSTIC_GRID_Z; j++) {
      for (let i = 0; i < CAUSTIC_GRID_X; i++) {
        const a = j * (CAUSTIC_GRID_X + 1) + i;
        const b = a + 1;
        const c = a + CAUSTIC_GRID_X + 1;
        const d = c + 1;
        gridIndices[gi++] = a;
        gridIndices[gi++] = c;
        gridIndices[gi++] = b;
        gridIndices[gi++] = b;
        gridIndices[gi++] = c;
        gridIndices[gi++] = d;
      }
    }
    this.causticsGrid = new Mesh(gl, this.causticsProgram, [{ name: 'aGrid', size: 2, offset: 0 }], 8);
    this.causticsGrid.setVertices(grid);
    this.causticsGrid.setIndices(gridIndices);

    // Height and the two slopes per grid node, for the caustics.
    this.heightData = new Float32Array(world.water.nx * world.water.nz * 4);
    this.heightTexture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.heightTexture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA32F,
      world.water.nx,
      world.water.nz,
      0,
      gl.RGBA,
      gl.FLOAT,
      this.heightData,
    );
    // Read with texelFetch and interpolated in the shader (see SURFACE_SAMPLE).
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.causticsTarget = createRenderTarget(
      gl,
      CAUSTIC_SIZE,
      CAUSTIC_SIZE,
      gl.RGBA16F,
      gl.RGBA,
      gl.FLOAT,
    );
    this.causticsBlur = createRenderTarget(
      gl,
      CAUSTIC_SIZE,
      CAUSTIC_SIZE,
      gl.RGBA16F,
      gl.RGBA,
      gl.FLOAT,
    );

    this.createShadowTargets();
    this.resize();
  }

  /**
   * The shadow maps, and the light's view of the tank.
   *
   * The light does not move, so its view is worked out once: an orthographic
   * box looking down the refracted light direction, just large enough to hold
   * the water (and a fish breaking the surface to breathe).
   */
  private createShadowTargets(): void {
    const gl = this.gl;

    this.shadowDepth = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.shadowDepth);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, SHADOW_SIZE, SHADOW_SIZE, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.shadowRawSampler = gl.createSampler()!;
    gl.samplerParameteri(this.shadowRawSampler, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.samplerParameteri(this.shadowRawSampler, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.samplerParameteri(this.shadowRawSampler, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.samplerParameteri(this.shadowRawSampler, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.shadowCompareSampler = gl.createSampler()!;
    gl.samplerParameteri(this.shadowCompareSampler, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.samplerParameteri(this.shadowCompareSampler, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.samplerParameteri(this.shadowCompareSampler, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.samplerParameteri(this.shadowCompareSampler, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.samplerParameteri(this.shadowCompareSampler, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.samplerParameteri(this.shadowCompareSampler, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    this.shadowFramebuffer = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.shadowDepth, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.finShadowTarget = createRenderTarget(
      gl,
      SHADOW_SIZE,
      SHADOW_SIZE,
      gl.RGBA16F,
      gl.RGBA,
      gl.FLOAT,
      gl.NEAREST,
    );

    const L = this.lightDirWater;
    const centre = v3(0, (TANK.floorY + TANK.waterY) / 2, -TANK.depth / 2);
    const eye = v3(centre.x + L.x * 0.5, centre.y + L.y * 0.5, centre.z + L.z * 0.5);
    const view = mat4();
    mat4LookAt(view, eye, centre, v3(0, 0, -1));
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const x of [-TANK.width / 2, TANK.width / 2]) {
      for (const y of [TANK.floorY - 0.004, TANK.waterY + 0.02]) {
        for (const z of [TANK_MIN_Z, 0]) {
          const vx = view[0] * x + view[4] * y + view[8] * z + view[12];
          const vy = view[1] * x + view[5] * y + view[9] * z + view[13];
          const vz = view[2] * x + view[6] * y + view[10] * z + view[14];
          minX = Math.min(minX, vx); maxX = Math.max(maxX, vx);
          minY = Math.min(minY, vy); maxY = Math.max(maxY, vy);
          minZ = Math.min(minZ, vz); maxZ = Math.max(maxZ, vz);
        }
      }
    }
    const projection = mat4();
    mat4Ortho(projection, minX, maxX, minY, maxY, -maxZ, -minZ);
    mat4Multiply(this.lightViewProjection, projection, view);
    this.shadowExtentX = maxX - minX;
    this.shadowExtentY = maxY - minY;
    this.shadowDepthRange = maxZ - minZ;
  }

  resize(): void {
    const gl = this.gl;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (w === this.width && h === this.height) return;

    this.canvas.width = w;
    this.canvas.height = h;
    this.width = w;
    this.height = h;

    // Rebuild the offscreen targets at the new size.
    this.sceneTarget = createRenderTarget(gl, w, h, gl.RGBA16F, gl.RGBA, gl.FLOAT);
    this.volumeTarget = createRenderTarget(gl, w, h, gl.RGBA16F, gl.RGBA, gl.FLOAT);
    this.surfaceTarget = createRenderTarget(gl, w, h, gl.RGBA16F, gl.RGBA, gl.FLOAT);

    // Depth as a texture, because the volume pass reconstructs world positions
    // from it to work out how far light travelled through the water.
    this.sceneDepth = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.sceneDepth);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, w, h, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneTarget.framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.sceneDepth, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.surfaceTarget.framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.sceneDepth, 0);

    // The reflection at half resolution: it is seen through a rippling surface
    // and blurred by it, and a full-size copy of the scene pass is not worth
    // its cost.
    const rw = Math.max(1, w >> 1);
    const rh = Math.max(1, h >> 1);
    this.reflectionTarget = createRenderTarget(gl, rw, rh, gl.RGBA16F, gl.RGBA, gl.FLOAT);
    this.reflectionDepth = gl.createRenderbuffer()!;
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.reflectionDepth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, rw, rh);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.reflectionTarget.framebuffer);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.reflectionDepth);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private setCamera(camera: CameraState): void {
    const cp = Math.cos(camera.pitch);
    this.cameraPos.x = camera.target.x + camera.distance * cp * Math.sin(camera.yaw);
    this.cameraPos.y = camera.target.y + camera.distance * Math.sin(camera.pitch);
    this.cameraPos.z = camera.target.z + camera.distance * cp * Math.cos(camera.yaw);

    copy(this.cameraTarget, camera.target);
    mat4LookAt(this.view, this.cameraPos, camera.target, v3(0, 1, 0));
    mat4Perspective(this.projection, (38 * Math.PI) / 180, this.width / this.height, 0.01, 4);
    mat4Multiply(this.viewProjection, this.projection, this.view);
    mat4Invert(this.inverseViewProjection, this.viewProjection);
  }

  /** Common uniforms every scene shader wants. */
  private setSharedUniforms(p: Program, time: number): void {
    const gl = this.gl;
    const u = p.uniforms;
    if (u.uViewProjection) gl.uniformMatrix4fv(u.uViewProjection, false, this.viewProjection);
    if (u.uCameraPos) gl.uniform3f(u.uCameraPos, this.cameraPos.x, this.cameraPos.y, this.cameraPos.z);

    // Absorption over the tank, including the tannin tint of real aquarium water.
    const a = OPTICS.waterAbsorption;
    const t = OPTICS.tanninAbsorption;
    if (u.uAbsorption) {
      gl.uniform3f(
        u.uAbsorption,
        a[0] + t[0] * OPTICS.tannin,
        a[1] + t[1] * OPTICS.tannin,
        a[2] + t[2] * OPTICS.tannin,
      );
    }
    if (u.uScattering) gl.uniform1f(u.uScattering, OPTICS.scatteringCoefficient);
    if (u.uWaterTint) gl.uniform3f(u.uWaterTint, 0.94, 1.0, 0.97);

    if (u.uLightDir) gl.uniform3f(u.uLightDir, LIGHT_DIR.x, LIGHT_DIR.y, LIGHT_DIR.z);
    if (u.uLightColour) gl.uniform3f(u.uLightColour, 1.05, 1.0, 0.92);
    if (u.uAmbient) gl.uniform3f(u.uAmbient, 0.10, 0.13, 0.15);
    if (u.uExposure) gl.uniform1f(u.uExposure, 1.5);

    if (u.uWaterMin) gl.uniform3f(u.uWaterMin, -TANK.width / 2, TANK.floorY, TANK_MIN_Z);
    if (u.uWaterMax) gl.uniform3f(u.uWaterMax, TANK.width / 2, this.waterTop, 0);
    if (u.uRefractIOR) gl.uniform1f(u.uRefractIOR, this.refractIOR);
    if (u.uTopSlack) gl.uniform1f(u.uTopSlack, this.topSlack);
    if (u.uPane) gl.uniform3f(u.uPane, this.pane.x, this.pane.y, this.pane.z);
    if (u.uClipSide) gl.uniform1f(u.uClipSide, this.clipSide);
    if (u.uFilmThickness) gl.uniform1f(u.uFilmThickness, OPTICS.filmThicknessNm);
    if (u.uFilmIOR) gl.uniform1f(u.uFilmIOR, OPTICS.iorFilm);
    if (u.uBaseIOR) gl.uniform1f(u.uBaseIOR, OPTICS.iorSkinBase);
    if (u.uWaterY) gl.uniform1f(u.uWaterY, TANK.waterY);
    if (u.uCausticsExtent) gl.uniform2f(u.uCausticsExtent, TANK.width / 2, TANK.depth);
    if (u.uTime) gl.uniform1f(u.uTime, time);

    const L = this.lightDirWater;
    if (u.uLightDirWater) gl.uniform3f(u.uLightDirWater, L.x, L.y, L.z);
    if (u.uLightViewProjection) gl.uniformMatrix4fv(u.uLightViewProjection, false, this.lightViewProjection);
    if (u.uShadowExtent) gl.uniform2f(u.uShadowExtent, this.shadowExtentX, this.shadowExtentY);
    if (u.uShadowDepthRange) gl.uniform1f(u.uShadowDepthRange, this.shadowDepthRange);
    if (u.uLightAngle) gl.uniform1f(u.uLightAngle, LIGHT_ANGLE);
    if (u.uShadowMap) {
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, this.shadowDepth);
      gl.bindSampler(3, this.shadowRawSampler);
      gl.uniform1i(u.uShadowMap, 3);
    }
    if (u.uShadowCompare) {
      gl.activeTexture(gl.TEXTURE5);
      gl.bindTexture(gl.TEXTURE_2D, this.shadowDepth);
      gl.bindSampler(5, this.shadowCompareSampler);
      gl.uniform1i(u.uShadowCompare, 5);
    }
    if (u.uFinShadow) {
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, this.finShadowTarget.texture);
      gl.uniform1i(u.uFinShadow, 4);
    }
  }

  private bindCaustics(p: Program, unit = 0): void {
    const gl = this.gl;
    if (!p.uniforms.uCaustics) return;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, this.causticsTarget.texture);
    gl.uniform1i(p.uniforms.uCaustics, unit);
  }

  /** Refract light through the surface and accumulate where it lands. */
  private renderCaustics(): void {
    const gl = this.gl;
    const water = this.world.water;

    // Upload the current surface. The caustics are computed from *this* surface,
    // which is the whole point: a pellet hitting the water sends a ring through
    // the caustics because it sent a ring through the water.
    const height = water.height;
    const slopeX = water.slopeX;
    const slopeZ = water.slopeZ;
    for (let i = 0; i < height.length; i++) {
      this.heightData[i * 4] = height[i];
      this.heightData[i * 4 + 1] = slopeX[i];
      this.heightData[i * 4 + 2] = slopeZ[i];
    }
    gl.bindTexture(gl.TEXTURE_2D, this.heightTexture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, water.nx, water.nz, gl.RGBA, gl.FLOAT, this.heightData);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.causticsTarget.framebuffer);
    gl.viewport(0, 0, CAUSTIC_SIZE, CAUSTIC_SIZE);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE); // additive: rays pile up where they converge

    gl.useProgram(this.causticsProgram.program);
    const u = this.causticsProgram.uniforms;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.heightTexture);
    gl.uniform1i(u.uHeightMap!, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.ripples.texture);
    gl.uniform1i(u.uRipples!, 1);
    gl.uniform2f(u.uTankExtent!, TANK.width / 2, TANK.depth);
    gl.uniform1f(u.uWaterY!, TANK.waterY);
    gl.uniform1f(u.uFloorY!, TANK.floorY);
    gl.uniform3f(u.uLightDir!, LIGHT_DIR.x, LIGHT_DIR.y, LIGHT_DIR.z);
    gl.uniform1f(u.uIOR!, OPTICS.iorWater);
    gl.disable(gl.CULL_FACE); // where the light folds over, triangles flip
    this.causticsGrid.draw();

    gl.disable(gl.BLEND);

    // Blur, separably, by what the lamp's size does over the depth of the
    // water: a lamp that is not a point never brings light to a perfect line.
    //
    // The five-tap kernel is only a Gaussian when its taps are a texel apart
    // (its spread is then about 1.65 texels). Stretching it to blur further
    // leaves gaps between the taps, and every bright line comes out as a row of
    // faint parallel copies. So it is repeated instead, which adds the spreads
    // in quadrature. The result ends up back in causticsTarget.
    const radiusTexels = (WATER_DEPTH * LIGHT_ANGLE) / (TANK.width / CAUSTIC_SIZE);
    const passes = Math.max(1, Math.ceil(((radiusTexels * 0.5) / 1.65) ** 2));
    gl.useProgram(this.blurProgram.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(this.blurProgram.uniforms.uSource!, 0);
    for (let i = 0; i < passes; i++) {
      for (const [src, dst, dx, dy] of [
        [this.causticsTarget, this.causticsBlur, 1, 0],
        [this.causticsBlur, this.causticsTarget, 0, 1],
      ] as [RenderTarget, RenderTarget, number, number][]) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, dst.framebuffer);
        gl.bindTexture(gl.TEXTURE_2D, src.texture);
        gl.uniform2f(this.blurProgram.uniforms.uDirection!, dx / CAUSTIC_SIZE, dy / CAUSTIC_SIZE);
        this.quadGpu.draw();
      }
    }
  }

  /** The fish's body and fins move every frame; rebuild them once, before any pass. */
  private updateDynamicMeshes(): void {
    this.bodyMesh.update(this.world.body, this.world.locomotion, this.world.command.gillFlare);
    this.bodyGpu.updateVertices(this.bodyMesh.vertices);
    for (let i = 0; i < this.finGpu.length; i++) {
      this.finMeshes[i].update();
      this.finGpu[i].updateVertices(this.finMeshes[i].vertices);
    }
  }

  /**
   * The scene from the light: depth for the solid things (body, plants, wood
   * and stones), then the fins' transmitted light. The sand is left out — it
   * only receives shadow here, and a floor in its own shadow map is the usual
   * source of speckled self-shadowing.
   */
  private renderShadows(time: number): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFramebuffer);
    gl.viewport(0, 0, SHADOW_SIZE, SHADOW_SIZE);
    gl.clearDepth(1);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);
    // Both faces: leaves are single sheets, and a closed body casts the same
    // shadow either way.
    gl.disable(gl.CULL_FACE);

    gl.useProgram(this.shadowProgram.program);
    const u = this.shadowProgram.uniforms;
    gl.uniformMatrix4fv(u.uViewProjection!, false, this.lightViewProjection);
    if (u.uRefractIOR) gl.uniform1f(u.uRefractIOR, 1);
    // The plants' shadows sway with them.
    if (u.uTime) gl.uniform1f(u.uTime, time);
    if (u.uSway) gl.uniform1f(u.uSway, 1);
    this.plantsGpu.draw();
    if (u.uSway) gl.uniform1f(u.uSway, 0);
    this.hardscapeGpu.draw();
    this.bodyGpu.draw();

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.finShadowTarget.framebuffer);
    gl.viewport(0, 0, SHADOW_SIZE, SHADOW_SIZE);
    gl.clearColor(1, 1, 1, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    // Colour: multiply, so overlapping fins compound. Alpha: keep the largest
    // (1 - depth), which is the fin nearest the light.
    gl.blendEquationSeparate(gl.FUNC_ADD, gl.MAX);
    gl.blendFuncSeparate(gl.DST_COLOR, gl.ZERO, gl.ONE, gl.ONE);
    gl.useProgram(this.finShadowProgram.program);
    const f = this.finShadowProgram.uniforms;
    gl.uniformMatrix4fv(f.uViewProjection!, false, this.lightViewProjection);
    if (f.uRefractIOR) gl.uniform1f(f.uRefractIOR, 1);
    if (f.uFinColour) gl.uniform3f(f.uFinColour, FIN_COLOUR[0], FIN_COLOUR[1], FIN_COLOUR[2]);
    const L = this.lightDirWater;
    if (f.uLightDirWater) gl.uniform3f(f.uLightDirWater, L.x, L.y, L.z);
    for (let i = 0; i < this.finGpu.length; i++) {
      const look = FIN_LOOK[this.world.fins[i].spec.name] ?? FIN_LOOK.pelvicLeft;
      if (f.uFinShape) gl.uniform1f(f.uFinShape, look.shape);
      if (f.uRayCount) gl.uniform1f(f.uRayCount, look.rays);
      this.finGpu[i].draw();
    }
    gl.blendEquation(gl.FUNC_ADD);
    gl.disable(gl.BLEND);
  }

  private renderScene(time: number): void {
    const gl = this.gl;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneTarget.framebuffer);
    gl.viewport(0, 0, this.width, this.height);
    // The room covers the whole view; this only shows if it is not drawn.
    gl.clearColor(0.015, 0.02, 0.024, 1);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    this.clipSide = 0;
    this.mirrored = false;
    const passes = this.refractionPasses();
    // From inside the water nothing between the eye and the scene bends it.
    if (!passes) this.refractIOR = 1;
    this.drawInPasses(passes, time);
    copy(this.pane, v3());
    this.refractIOR = OPTICS.iorWater;
  }

  /**
   * The passes the scene is drawn in: first one for what is out of the water,
   * then one for each pane the eye can see into the water through — at most
   * three, since at most three faces of a box face any one point. Null when
   * the eye is in the water itself. See APPARENT_POSITION in the shaders for
   * why each pane gets its own pass.
   */
  private refractionPasses(): Vec3[] | null {
    const panes = visiblePanes(
      this.cameraPos,
      v3(-TANK.width / 2, TANK.floorY, TANK_MIN_Z),
      v3(TANK.width / 2, this.waterTop, 0),
    );
    return panes.length > 0 ? [v3(), ...panes] : null;
  }

  /**
   * The scene as seen from the camera mirrored in the water plane.
   *
   * For a flat mirror the reflection at a pixel is exactly what the mirrored
   * camera sees at that pixel, so this is the correct way to reflect a plane,
   * not an approximation; the surface shader then perturbs the lookup with the
   * ripple normal, which is one. Only geometry on the far side of the water
   * from the real camera is drawn: from above, the rim of the glass and the
   * room; from below, the tank interior, which is what the underside of the
   * surface shows past the critical angle.
   *
   * From below, the mirror is itself seen through the front glass, so what it
   * shows is bent by the glass like everything else, and has to be, or the
   * reflection of a wall stops meeting the wall. Unfolded about the mirror,
   * the path from an object to the eye is a straight line through a tank
   * twice as tall, so that is the tank this pass refracts through. From
   * above, the mirror shows the room, which no water bends.
   */
  private renderReflection(time: number): void {
    const gl = this.gl;
    const wy = TANK.waterY;

    // Reflect the *world* in the plane y = waterY and draw it with the real
    // camera. That puts the reflection of each point on exactly the pixel where
    // the surface shader will look for it. (A camera merely moved to the
    // mirrored position sees a left-right mirrored image instead, which was
    // the first attempt.) The reflection reverses handedness, hence the cull
    // flip in drawSceneGeometry. Lighting uses the mirrored eye, so specular
    // highlights land where the mirror would put them.
    const savedPos = v3(this.cameraPos.x, this.cameraPos.y, this.cameraPos.z);
    const savedVP = new Float32Array(this.viewProjection);
    const reflect = mat4();
    reflect[5] = -1;
    reflect[13] = 2 * wy;
    mat4Multiply(this.viewProjection, savedVP as unknown as Mat4, reflect);
    copy(this.cameraPos, v3(savedPos.x, 2 * wy - savedPos.y, savedPos.z));

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.reflectionTarget.framebuffer);
    gl.viewport(0, 0, this.width >> 1, this.height >> 1);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    this.clipSide = savedPos.y > wy ? 1 : -1;
    this.mirrored = true;
    this.waterTop = 2 * wy - TANK.floorY;
    const passes = this.clipSide < 0 ? this.refractionPasses() : null;
    if (!passes) this.refractIOR = 1;
    this.drawInPasses(passes, time);

    // Restore the real camera.
    copy(this.cameraPos, savedPos);
    this.viewProjection.set(savedVP);
    this.clipSide = 0;
    this.refractIOR = OPTICS.iorWater;
    this.waterTop = TANK.waterY;
    copy(this.pane, v3());
    this.mirrored = false;
  }

  /**
   * Draw the scene once per refraction pass (or once, with no passes), in
   * three rounds: everything solid in every pass, then the glass, then what
   * is blended.
   *
   * The glass is see-through and does not write depth, so anything drawn
   * after it that lies behind it paints over it. It is on the water's edges,
   * so what is behind a pane is often drawn in another pane's pass; drawn in
   * the same round as the solid things, a pane's reflection vanished wherever
   * a later pass put something behind it. The fins and specks come last so
   * that they, in turn, are drawn over the glass they are in front of.
   */
  private drawInPasses(passes: Vec3[] | null, time: number): void {
    for (const round of ['solid', 'glass', 'blended'] as const) {
      for (const pane of passes ?? [v3()]) {
        copy(this.pane, pane);
        this.drawSceneGeometry(time, round);
      }
    }
  }

  private drawSceneGeometry(time: number, round: 'solid' | 'glass' | 'blended'): void {
    const gl = this.gl;
    gl.viewport(0, 0, this.mirrored ? this.width >> 1 : this.width, this.mirrored ? this.height >> 1 : this.height);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    // A mirrored view reverses the winding of every triangle.
    gl.cullFace(this.mirrored ? gl.FRONT : gl.BACK);

    if (round === 'glass') {
      this.drawGlass(time);
      return;
    }
    if (round === 'blended') {
      this.drawBlended(time);
      return;
    }

    // --- The room ---
    //
    // Only in the pass for what is out of the water, which it all is. Not in
    // the reflection: the surface's reflection of the room above it comes
    // from envColour, which already has the ceiling and the lamp in it.
    const dryPass = this.pane.x === 0 && this.pane.y === 0 && this.pane.z === 0;
    if (!this.mirrored && dryPass) {
      gl.disable(gl.CULL_FACE);
      gl.useProgram(this.roomProgram.program);
      this.setSharedUniforms(this.roomProgram, time);
      this.roomGpu.draw();
      gl.enable(gl.CULL_FACE);
    }

    // --- Substrate, hardscape and plants ---
    gl.useProgram(this.tankProgram.program);
    this.setSharedUniforms(this.tankProgram, time);
    this.bindCaustics(this.tankProgram);
    const tu = this.tankProgram.uniforms;
    if (tu.uSway) gl.uniform1f(tu.uSway, 0);
    this.tankGpu.draw();
    this.hardscapeGpu.draw();
    // Leaves are two-sided, and move.
    gl.disable(gl.CULL_FACE);
    if (tu.uSway) gl.uniform1f(tu.uSway, 1);
    this.plantsGpu.draw();
    if (tu.uSway) gl.uniform1f(tu.uSway, 0);

    // --- Fish body ---
    gl.enable(gl.CULL_FACE);
    gl.useProgram(this.fishProgram.program);
    this.setSharedUniforms(this.fishProgram, time);
    this.bindCaustics(this.fishProgram);
    const fu = this.fishProgram.uniforms;
    // A red-and-blue betta: red pigment layer, with the blue-green iridescence
    // of the guanine platelets over it. That combination is what a "royal blue"
    // or "red dragon" betta actually is.
    if (fu.uBaseColour) gl.uniform3f(fu.uBaseColour, 0.55, 0.045, 0.06);
    if (fu.uBellyColour) gl.uniform3f(fu.uBellyColour, 0.30, 0.10, 0.08);
    if (fu.uRoughness) gl.uniform1f(fu.uRoughness, OPTICS.mucusRoughness);
    this.bodyGpu.draw();
  }

  /**
   * The glass: first the edges, which are nearly opaque and write depth, so
   * nothing behind one is drawn over it later; then the broad faces, which
   * are nearly clear and do not, so the room and the tank show through them.
   */
  private drawGlass(time: number): void {
    const gl = this.gl;
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.glassProgram.program);
    this.setSharedUniforms(this.glassProgram, time);
    const u = this.glassProgram.uniforms;
    if (u.uEdges) gl.uniform1f(u.uEdges, 1);
    this.glassGpu.draw();
    gl.depthMask(false);
    if (u.uEdges) gl.uniform1f(u.uEdges, 0);
    this.glassGpu.draw();
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  private drawBlended(time: number): void {
    const gl = this.gl;

    // --- Fins ---
    //
    // Two-sided and blended. Drawn after the body so they blend over it, with
    // depth writes off — a fin is a sheet, and letting each part of it occlude
    // the rest produces hard internal edges no real fin has.
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.useProgram(this.finProgram.program);
    this.setSharedUniforms(this.finProgram, time);
    this.bindCaustics(this.finProgram);
    if (this.finProgram.uniforms.uFinColour) {
      gl.uniform3f(this.finProgram.uniforms.uFinColour, FIN_COLOUR[0], FIN_COLOUR[1], FIN_COLOUR[2]);
    }
    const fu2 = this.finProgram.uniforms;
    for (let i = 0; i < this.finGpu.length; i++) {
      const look = FIN_LOOK[this.world.fins[i].spec.name] ?? FIN_LOOK.pelvicLeft;
      if (fu2.uFinShape) gl.uniform1f(fu2.uFinShape, look.shape);
      if (fu2.uRayCount) gl.uniform1f(fu2.uRayCount, look.rays);
      this.finGpu[i].draw();
    }
    gl.depthMask(true);
    gl.disable(gl.BLEND);

    // --- Pellets ---
    this.renderParticles(time);

    // --- Specks in the water ---
    //
    // Not in the mirrored pass: a reflection of something a fraction of a
    // pixel across is lost in the ripples anyway.
    if (!this.mirrored) this.renderMotes(time);
  }

  private renderMotes(time: number): void {
    const gl = this.gl;
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
    gl.depthMask(false);
    gl.useProgram(this.moteProgram.program);
    this.setSharedUniforms(this.moteProgram, time);
    this.bindCaustics(this.moteProgram);
    const u = this.moteProgram.uniforms;
    if (u.uPixelScale) gl.uniform1f(u.uPixelScale, this.projection[5] * this.height * 0.5);
    this.motesGpu.updateVertices(this.particulate.data);
    this.motesGpu.draw(gl.POINTS);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  private renderParticles(time: number): void {
    const gl = this.gl;
    const right = v3();
    const up = v3();
    const forward = v3();
    sub(forward, this.cameraPos, this.world.locomotion.position);
    normalize(forward, forward);
    cross(right, v3(0, 1, 0), forward);
    normalize(right, right);
    cross(up, forward, right);

    // Pellets.
    let o = 0;
    let count = 0;
    for (const p of this.world.food.pellets) {
      if (!p.alive || count >= 48) continue;
      o = billboard(p.position, right, up, p.radius * 1.6, this.particleData, o);
      count++;
    }
    if (count > 0) {
      gl.useProgram(this.pelletProgram.program);
      this.setSharedUniforms(this.pelletProgram, time);
      this.particleGpu.setVertices(this.particleData.subarray(0, o), true);
      this.particleGpu.vertexCount = count * 6;
      this.particleGpu.indexCount = 0;
      this.particleGpu.draw();
    }

    // Bubbles.
    o = 0;
    count = 0;
    for (const b of this.world.bubbles) {
      if (!b.alive || count >= 24) continue;
      o = billboard(b.position, right, up, b.radius * 2.2, this.particleData, o);
      count++;
    }
    if (count > 0) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.useProgram(this.bubbleProgram.program);
      this.setSharedUniforms(this.bubbleProgram, time);
      this.particleGpu.setVertices(this.particleData.subarray(0, o), true);
      this.particleGpu.vertexCount = count * 6;
      this.particleGpu.indexCount = 0;
      this.particleGpu.draw();
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }
  }

  private renderVolume(time: number): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.volumeTarget.framebuffer);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.DEPTH_TEST);

    gl.useProgram(this.volumeProgram.program);
    const u = this.volumeProgram.uniforms;
    this.setSharedUniforms(this.volumeProgram, time);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sceneTarget.texture);
    gl.uniform1i(u.uScene!, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.sceneDepth);
    gl.uniform1i(u.uDepth!, 1);
    if (u.uInverseViewProjection) {
      gl.uniformMatrix4fv(u.uInverseViewProjection, false, this.inverseViewProjection);
    }
    this.quadGpu.draw();
  }

  private renderSurface(time: number): void {
    const gl = this.gl;

    // Copy the volume result forward, then draw the surface over it sampling
    // that copy — the surface has to read what is behind it, and a texture
    // cannot be read and written in the same pass.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.surfaceTarget.framebuffer);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.blurProgram.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.volumeTarget.texture);
    gl.uniform1i(this.blurProgram.uniforms.uSource!, 0);
    gl.uniform2f(this.blurProgram.uniforms.uDirection!, 0, 0);
    this.quadGpu.draw();

    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    this.waterMesh.update();
    this.waterGpu.updateVertices(this.waterMesh.vertices);

    gl.useProgram(this.waterProgram.program);
    // The surface is refracted like everything else under water: from below,
    // through the front glass, its underside is seen through the water and
    // has to line up with the walls it meets. Its ripples rise a little above
    // the still waterline and are still water, hence the slack; seen from
    // above it lies on the pane it is seen through, and does not move.
    this.topSlack = 0.02;
    const passes = this.refractionPasses();
    if (!passes) this.refractIOR = 1;
    this.setSharedUniforms(this.waterProgram, time);
    this.topSlack = 0;
    this.refractIOR = OPTICS.iorWater;
    const u = this.waterProgram.uniforms;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.volumeTarget.texture);
    gl.uniform1i(u.uScene!, 0);
    this.bindCaustics(this.waterProgram, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.reflectionTarget.texture);
    if (u.uReflection) gl.uniform1i(u.uReflection, 2);
    if (u.uViewport) gl.uniform2f(u.uViewport, this.width, this.height);
    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D, this.ripples.texture);
    if (u.uRipples) gl.uniform1i(u.uRipples, 6);
    // Once per pane, like the scene. The surface is never out of the water, so
    // it skips the scene's first pass, the one for what is.
    for (const pane of passes ? passes.slice(1) : [v3()]) {
      if (u.uPane) gl.uniform3f(u.uPane, pane.x, pane.y, pane.z);
      this.waterGpu.draw();
    }
  }

  private renderPost(time: number): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.postProgram.program);
    const u = this.postProgram.uniforms;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.surfaceTarget.texture);
    gl.uniform1i(u.uScene!, 0);
    if (u.uTime) gl.uniform1f(u.uTime, time);
    if (u.uGrain) gl.uniform1f(u.uGrain, 0.012);
    if (u.uVignette) gl.uniform1f(u.uVignette, 0.45);
    this.quadGpu.draw();
  }

  render(camera: CameraState, time: number): void {
    this.resize();
    this.setCamera(camera);
    // The specks are only for looking at, so they move with the frames drawn.
    const dt = this.lastTime < 0 ? 0 : Math.min(0.05, Math.max(0, time - this.lastTime));
    this.lastTime = time;
    this.particulate.step(this.world.flow, dt);
    this.updateDynamicMeshes();
    this.ripples.update();
    this.renderCaustics();
    this.renderShadows(time);
    this.renderReflection(time);
    this.renderScene(time);
    this.renderVolume(time);
    this.renderSurface(time);
    this.renderPost(time);
  }

  /**
   * Turn a click into a point on the water surface.
   *
   * Unprojects the click through the current camera and intersects the ray with
   * the water. Returns null if the ray misses — tapping the sand or the wall
   * should not conjure food out of the air.
   */
  pickWater(clientX: number, clientY: number, camera: CameraState): { x: number; z: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = 1 - ((clientY - rect.top) / rect.height) * 2;

    this.setCamera(camera);
    const inv: Mat4 = this.inverseViewProjection;
    const unproject = (z: number): Vec3 => {
      const x = inv[0] * ndcX + inv[4] * ndcY + inv[8] * z + inv[12];
      const y = inv[1] * ndcX + inv[5] * ndcY + inv[9] * z + inv[13];
      const w = inv[3] * ndcX + inv[7] * ndcY + inv[11] * z + inv[15];
      const zz = inv[2] * ndcX + inv[6] * ndcY + inv[10] * z + inv[14];
      return v3(x / w, y / w, zz / w);
    };

    const near = unproject(-1);
    const far = unproject(1);
    const dir = v3();
    sub(dir, far, near);
    normalize(dir, dir);

    if (Math.abs(dir.y) < 1e-5) return null;
    const t = (TANK.waterY - near.y) / dir.y;
    if (t <= 0) return null;
    const x = near.x + dir.x * t;
    const z = near.z + dir.z * t;

    if (Math.abs(x) > TANK.width / 2 || z < TANK_MIN_Z || z > 0) return null;
    return { x, z };
  }
}
