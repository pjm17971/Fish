/**
 * The preview renderer.
 *
 * Pass order, and why:
 *
 *   1. **Caustics.** A grid of light rays is refracted through the current water
 *      surface and scattered additively onto a map of the tank floor, then
 *      blurred. This runs first because everything else reads it.
 *   2. **Scene.** Tank, plants, fish, fins, pellets — everything under the water
 *      — into an offscreen colour target with depth.
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
  WATER_FRAG,
  CAUSTICS_VERT,
  CAUSTICS_FRAG,
  BLUR_VERT,
  BLUR_FRAG,
  VOLUME_FRAG,
  POST_FRAG,
  PARTICLE_VERT,
  PELLET_FRAG,
  BUBBLE_FRAG,
} from './shaders.js';
import {
  BodyMesh,
  FinMesh,
  WaterMesh,
  buildTankMesh,
  buildPlantsMesh,
  VERTEX_ATTRIBUTES,
  VERTEX_STRIDE,
  billboard,
} from './meshes.js';
import { World } from '../sim/world.js';
import { OPTICS, TANK, TANK_MIN_Z } from '../sim/config.js';
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
} from '../sim/math.js';

const CAUSTIC_SIZE = 256;

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
  private readonly waterProgram: Program;
  private readonly causticsProgram: Program;
  private readonly blurProgram: Program;
  private readonly volumeProgram: Program;
  private readonly postProgram: Program;
  private readonly pelletProgram: Program;
  private readonly bubbleProgram: Program;

  private readonly bodyMesh: BodyMesh;
  private readonly bodyGpu: Mesh;
  private readonly finMeshes: FinMesh[] = [];
  private readonly finGpu: Mesh[] = [];
  private readonly waterMesh: WaterMesh;
  private readonly waterGpu: Mesh;
  private readonly tankGpu: Mesh;
  private readonly plantsGpu: Mesh;
  private readonly particleGpu: Mesh;
  private readonly quadGpu: Mesh;
  private readonly causticsGrid: Mesh;
  private causticsPointCount = 0;

  private sceneTarget!: RenderTarget;
  private sceneDepth!: WebGLTexture;
  private volumeTarget!: RenderTarget;
  private surfaceTarget!: RenderTarget;
  private causticsTarget!: RenderTarget;
  private causticsBlur!: RenderTarget;
  private heightTexture!: WebGLTexture;
  private heightData!: Float32Array;

  private readonly view = mat4();
  private readonly projection = mat4();
  private readonly viewProjection = mat4();
  private readonly inverseViewProjection = mat4();
  private readonly cameraPos = v3();

  private readonly particleData = new Float32Array(64 * 6 * 5);

  private width = 1;
  private height = 1;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly world: World,
  ) {
    const gl = createContext(canvas);
    this.gl = gl;

    this.fishProgram = createProgram(gl, SCENE_VERT, FISH_FRAG, 'fish');
    this.finProgram = createProgram(gl, SCENE_VERT, FIN_FRAG, 'fin');
    this.tankProgram = createProgram(gl, SCENE_VERT, TANK_FRAG, 'tank');
    this.waterProgram = createProgram(gl, SCENE_VERT, WATER_FRAG, 'water');
    this.causticsProgram = createProgram(gl, CAUSTICS_VERT, CAUSTICS_FRAG, 'caustics');
    this.blurProgram = createProgram(gl, BLUR_VERT, BLUR_FRAG, 'blur');
    this.volumeProgram = createProgram(gl, BLUR_VERT, VOLUME_FRAG, 'volume');
    this.postProgram = createProgram(gl, BLUR_VERT, POST_FRAG, 'post');
    this.pelletProgram = createProgram(gl, PARTICLE_VERT, PELLET_FRAG, 'pellet');
    this.bubbleProgram = createProgram(gl, PARTICLE_VERT, BUBBLE_FRAG, 'bubble');

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

    const tank = buildTankMesh();
    this.tankGpu = new Mesh(gl, this.tankProgram, VERTEX_ATTRIBUTES, VERTEX_STRIDE);
    this.tankGpu.setVertices(tank.vertices);
    this.tankGpu.setIndices(tank.indices);

    const plants = buildPlantsMesh();
    this.plantsGpu = new Mesh(gl, this.tankProgram, VERTEX_ATTRIBUTES, VERTEX_STRIDE);
    this.plantsGpu.setVertices(plants.vertices);
    this.plantsGpu.setIndices(plants.indices);

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

    this.quadGpu = new Mesh(gl, this.blurProgram, [{ name: 'aPosition', size: 2, offset: 0 }], 8);
    this.quadGpu.setVertices(new Float32Array([-1, -1, 3, -1, -1, 3]));

    // Caustics: one point per cell of the water grid.
    const cw = world.water.nx - 1;
    const ch = world.water.nz - 1;
    const grid = new Float32Array(cw * ch * 2);
    let g = 0;
    for (let j = 0; j < ch; j++) {
      for (let i = 0; i < cw; i++) {
        grid[g++] = (i + 0.5) / world.water.nx;
        grid[g++] = (j + 0.5) / world.water.nz;
      }
    }
    this.causticsPointCount = cw * ch;
    this.causticsGrid = new Mesh(gl, this.causticsProgram, [{ name: 'aGrid', size: 2, offset: 0 }], 8);
    this.causticsGrid.setVertices(grid);

    this.heightData = new Float32Array(world.water.nx * world.water.nz);
    this.heightTexture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.heightTexture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R32F,
      world.water.nx,
      world.water.nz,
      0,
      gl.RED,
      gl.FLOAT,
      this.heightData,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
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

    this.resize();
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
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private setCamera(camera: CameraState): void {
    const cp = Math.cos(camera.pitch);
    this.cameraPos.x = camera.target.x + camera.distance * cp * Math.sin(camera.yaw);
    this.cameraPos.y = camera.target.y + camera.distance * Math.sin(camera.pitch);
    this.cameraPos.z = camera.target.z + camera.distance * cp * Math.cos(camera.yaw);

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

    // A tank light above and slightly forward, which is where an aquarium hood
    // puts it.
    if (u.uLightDir) gl.uniform3f(u.uLightDir, 0.12, 0.96, 0.25);
    if (u.uLightColour) gl.uniform3f(u.uLightColour, 1.05, 1.0, 0.92);
    if (u.uAmbient) gl.uniform3f(u.uAmbient, 0.10, 0.13, 0.15);
    if (u.uExposure) gl.uniform1f(u.uExposure, 1.5);

    if (u.uFilmThickness) gl.uniform1f(u.uFilmThickness, OPTICS.filmThicknessNm);
    if (u.uFilmIOR) gl.uniform1f(u.uFilmIOR, OPTICS.iorFilm);
    if (u.uBaseIOR) gl.uniform1f(u.uBaseIOR, OPTICS.iorSkinBase);
    if (u.uWaterY) gl.uniform1f(u.uWaterY, TANK.waterY);
    if (u.uCausticsExtent) gl.uniform2f(u.uCausticsExtent, TANK.width / 2, TANK.depth);
    if (u.uTime) gl.uniform1f(u.uTime, time);
  }

  private bindCaustics(p: Program, unit = 0): void {
    const gl = this.gl;
    if (!p.uniforms.uCaustics) return;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, this.causticsBlur.texture);
    gl.uniform1i(p.uniforms.uCaustics, unit);
  }

  /** Refract light through the surface and accumulate where it lands. */
  private renderCaustics(): void {
    const gl = this.gl;
    const water = this.world.water;

    // Upload the current surface. The caustics are computed from *this* surface,
    // which is the whole point: a pellet hitting the water sends a ring through
    // the caustics because it sent a ring through the water.
    for (let i = 0; i < this.heightData.length; i++) this.heightData[i] = water.height[i];
    gl.bindTexture(gl.TEXTURE_2D, this.heightTexture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, water.nx, water.nz, gl.RED, gl.FLOAT, this.heightData);

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
    gl.uniform2f(u.uGridSize!, water.nx, water.nz);
    gl.uniform2f(u.uTankExtent!, TANK.width / 2, TANK.depth);
    gl.uniform1f(u.uWaterY!, TANK.waterY);
    gl.uniform1f(u.uFloorY!, TANK.floorY);
    gl.uniform3f(u.uLightDir!, 0.12, 0.96, 0.25);
    gl.uniform1f(u.uIOR!, OPTICS.iorWater);
    this.causticsGrid.vertexCount = this.causticsPointCount;
    this.causticsGrid.draw(gl.POINTS);

    gl.disable(gl.BLEND);

    // Blur, separably. Real caustics have soft edges; a sharp accumulation
    // buffer reads as a scatter of dots.
    gl.useProgram(this.blurProgram.program);
    for (const [src, dst, dir] of [
      [this.causticsTarget, this.causticsBlur, [1 / CAUSTIC_SIZE, 0]],
      [this.causticsBlur, this.causticsTarget, [0, 1 / CAUSTIC_SIZE]],
      [this.causticsTarget, this.causticsBlur, [1.5 / CAUSTIC_SIZE, 0]],
    ] as [RenderTarget, RenderTarget, number[]][]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.framebuffer);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.texture);
      gl.uniform1i(this.blurProgram.uniforms.uSource!, 0);
      gl.uniform2f(this.blurProgram.uniforms.uDirection!, dir[0], dir[1]);
      this.quadGpu.draw();
    }
  }

  private renderScene(time: number): void {
    const gl = this.gl;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneTarget.framebuffer);
    gl.viewport(0, 0, this.width, this.height);
    // The colour behind everything is the dark of a room behind the tank.
    gl.clearColor(0.015, 0.02, 0.024, 1);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);

    // --- Tank and plants ---
    gl.useProgram(this.tankProgram.program);
    this.setSharedUniforms(this.tankProgram, time);
    this.bindCaustics(this.tankProgram);
    this.tankGpu.draw();
    // Leaves are two-sided.
    gl.disable(gl.CULL_FACE);
    this.plantsGpu.draw();

    // --- Fish body ---
    gl.enable(gl.CULL_FACE);
    this.bodyMesh.update(this.world.body, this.world.locomotion, this.world.command.gillFlare);
    this.bodyGpu.updateVertices(this.bodyMesh.vertices);
    gl.useProgram(this.fishProgram.program);
    this.setSharedUniforms(this.fishProgram, time);
    this.bindCaustics(this.fishProgram);
    const fu = this.fishProgram.uniforms;
    // A red-and-blue betta: red pigment layer, with the blue-green iridescence
    // of the guanine platelets over it. That combination is what a "royal blue"
    // or "red dragon" betta actually is.
    if (fu.uBaseColour) gl.uniform3f(fu.uBaseColour, 0.42, 0.045, 0.055);
    if (fu.uBellyColour) gl.uniform3f(fu.uBellyColour, 0.30, 0.10, 0.08);
    if (fu.uRoughness) gl.uniform1f(fu.uRoughness, OPTICS.mucusRoughness);
    this.bodyGpu.draw();

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
      gl.uniform3f(this.finProgram.uniforms.uFinColour, 0.52, 0.06, 0.09);
    }
    for (let i = 0; i < this.finGpu.length; i++) {
      this.finMeshes[i].update();
      this.finGpu[i].updateVertices(this.finMeshes[i].vertices);
      this.finGpu[i].draw();
    }
    gl.depthMask(true);
    gl.disable(gl.BLEND);

    // --- Pellets ---
    this.renderParticles(time);
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
    if (u.uParticleDensity) gl.uniform1f(u.uParticleDensity, 0.35);
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
    this.setSharedUniforms(this.waterProgram, time);
    const u = this.waterProgram.uniforms;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.volumeTarget.texture);
    gl.uniform1i(u.uScene!, 0);
    this.bindCaustics(this.waterProgram, 1);
    if (u.uViewport) gl.uniform2f(u.uViewport, this.width, this.height);
    if (u.uSkyColour) gl.uniform3f(u.uSkyColour, 0.14, 0.17, 0.20);
    this.waterGpu.draw();
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
    this.renderCaustics();
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
