---
name: game-dev
description: Guide for building browser games — 3D (Three.js/WebGL) and 2D (Canvas). Covers sandbox constraints, art direction, game UI design systems, typography, image generation for game art, music, renderer setup, ECS architecture, Rapier physics, asset loading, post-processing, and performance.
---

# Three.js Game Development Skill

Build 3D browser games using Three.js. Use WebGL 2 rendering, Rapier for physics, ECS for architecture, and GLTF/GLB for assets. All games are static HTML/CSS/JS deployed to a public URL and rendered inside a sandboxed iframe.

**Mandatory shared files (read if not already loaded):** `skills/GENERAL-KNOWLEDGE-WORKER/website-building/shared/01-design-tokens.md`, `skills/GENERAL-KNOWLEDGE-WORKER/website-building/shared/02-typography.md`.

---

## Sandbox Environment

Games run inside a sandboxed iframe with limited permissions. All code must work within these constraints.

### What Works
- **JavaScript, Canvas, WebGL 2** — fully functional
- **WebAssembly** — works when loaded from CDN (e.g., Rapier via esm.sh)
- **Web Audio API** — works, but AudioContext requires a user gesture (click/tap) to start
- **`<img>`, `<video>`, `<audio>` HTML elements** — load binary files correctly (the browser handles redirects)
- **CDN imports** — `fetch()` to external CDN URLs (esm.sh, jsdelivr, unpkg, gstatic) works fine
- **Keyboard, mouse, touch, gamepad events** — all standard DOM events work

### What Is Blocked
- **`fetch()` of local binary files** — the site proxy redirects `.glb`, `.wasm`, `.mp3`, `.png` etc. to S3, and these redirects fail in the sandbox due to CORS. **Load all binary assets from external CDN URLs, or use HTML elements** (`<img>`, `<audio>`) which bypass this restriction
- **localStorage / sessionStorage / IndexedDB** — blocked (opaque origin). The deploy tool also rejects code containing these. Use in-memory state only. No game saves
- **Pointer Lock API** — blocked. FPS-style mouse capture is unavailable. Use relative mouse movement (`movementX`/`movementY` on `mousemove` events) within the iframe instead
- **Fullscreen API** — blocked. Design the game to fill the iframe viewport
- **`alert()` / `confirm()` / `prompt()`** — blocked. Use in-game UI overlays instead
- **WebGPU** — may fail in opaque-origin iframes. Use WebGL 2 as the default renderer

### Asset Loading Strategy
Because `fetch()` fails for local binary files, follow this rule:

- **3D models, textures, audio, WASM** → load from external CDN URLs (Poly Pizza, Kenney, ambientCG, esm.sh, etc.)
- **HTML, CSS, JS, JSON, text files** → can be local (served inline by the proxy)
- **Generated images** (from `generate_image`) → deployed alongside the site as local files. Use `<img>` elements to display them, NOT `fetch()` + canvas. For Three.js textures from local images, **always set `crossOrigin`** before `src` — the sandbox proxy redirects to S3, which taints the canvas for WebGL unless CORS is explicitly requested:

```js
const img = new Image();
img.crossOrigin = 'anonymous';
img.src = './generated-bg.png';
img.onload = () => {
  const texture = new THREE.Texture(img);
  texture.needsUpdate = true;
  // use texture
};
```

Without `img.crossOrigin = 'anonymous'`, the cross-origin S3 redirect silently taints the image — `texImage2D` fails and WebGL renders a black texture with no error.

---

## Art Direction

Before writing code, establish a cohesive art direction based on the game's subject matter, genre, and tone. Every visual decision — color palette, lighting, asset style, UI treatment, loading screens — should flow from this direction.

### Choosing a Direction
- **Analyze the game concept**: A horror game demands dark palettes, fog, and desaturated textures. A kids' puzzle game calls for bright primaries and rounded shapes. A sci-fi shooter needs neon accents, metallic materials, and volumetric lighting.
- **Pick a visual style**: Low-poly stylized, realistic PBR, pixel-art-inspired 3D, cel-shaded, voxel, neon/synthwave, hand-painted. Commit to one and maintain consistency.
- **Define a color palette**: Choose 3-5 core colors. Use one dominant, one accent, and neutrals. Apply consistently to environment, UI, and particles.
- **Match lighting to mood**: Warm directional light for adventure, cold blue ambient for horror, high-contrast rim lighting for action.
- **UI must match the game world**: Menu screens, HUD, loading screens, and game-over states should share the same palette and typographic style as the game itself.

### Generate Game Art with `generate_image`
Use the image generation tool to create custom art for the game. Do NOT use placeholder rectangles or skip visual assets — generate real art that matches the art direction.

**Always generate these assets:**
- **Title screen / splash image** — a hero image that establishes the game's visual identity
- **Loading screen background** — themed art shown during asset loading
- **Game-over / victory screen art** — emotional payoff images

**Generate when appropriate:**
- Skybox/environment concept art (use as reference for building the 3D scene)
- Character/enemy concept art (use as texture reference or 2D sprite overlays)
- UI background textures or patterns

**Prompting tips for game art:**
- Be specific about style: "low-poly isometric forest scene with warm sunset lighting, stylized"
- Include mood/atmosphere: "dark cyberpunk alley, neon reflections on wet pavement, moody"
- Specify aspect ratio: use `16:9` for backgrounds/loading screens, `1:1` for icons/thumbnails
- Reference the established art direction in every prompt for consistency

---

## Game UI Typography

**Read `skills/GENERAL-KNOWLEDGE-WORKER/website-building/shared/02-typography.md` for font selection, pairing rules, loading, and the blacklist.** All rules apply to games. Below adapts them to game-specific contexts.

### Rules

- **Two fonts max.** One display font for titles/game-over. One legible sans-serif for HUD/menus. Blacklist applies (no Papyrus, Comic Sans, Impact, Lobster, Roboto, Arial, Poppins).
- **Minimum sizes:** 12px tiny labels · 14px buttons/interactive UI · 16px body/dialog. Display fonts only at 24px+.
- **HUD numbers:** Use `font-variant-numeric: tabular-nums lining-nums` so digits don't shift. Clean sans at 14-16px.
- **Load from Google Fonts or Fontshare** — never browser defaults.

### Font-to-Genre Matching

| Genre | Display Font | HUD/Body Font |
|---|---|---|
| Fantasy/RPG | Serif (Cormorant, Playfair, Erode) | Sans (Satoshi, General Sans) |
| Sci-fi/Cyber | Geometric/mono (Cabinet Grotesk, JetBrains Mono) | Technical sans (Inter, Geist) |
| Horror | High-contrast serif (Boska, Instrument Serif) | Neutral sans (Switzer, Inter) |
| Casual/Puzzle | Rounded sans (Plus Jakarta Sans, Chillax) | Same family lighter |
| Retro/Pixel | Mono (Azeret Mono, Fira Code) | Same family |

### Text Rendering

Game UI is HTML/CSS overlaid on the canvas — standard web font rules apply:

```css
.game-ui { position:fixed; inset:0; pointer-events:none; z-index:10; font-family:var(--font-body); color:var(--color-text); }
.game-ui button, .game-ui [data-interactive] { pointer-events:auto; }
.hud-value { font-variant-numeric:tabular-nums lining-nums; font-size:14px; font-weight:600; }
.game-title { font-family:var(--font-display); font-size:clamp(2rem,6vw,4rem); line-height:1.1; }
```

For in-world 3D text (damage numbers, name tags), use `THREE.CanvasTexture` with a hidden 2D canvas drawing the same CSS-loaded font.

---

## Game Design System

Every game screen (HUD, menus, loading, dialogs, settings, game-over, title) must share a unified token system. **Read `skills/GENERAL-KNOWLEDGE-WORKER/website-building/shared/01-design-tokens.md` for token architecture.**

### Building the System

**1. Define tokens** adapted from `skills/GENERAL-KNOWLEDGE-WORKER/website-building/shared/01-design-tokens.md`:

```css
:root {
  --font-display: 'Cabinet Grotesk', sans-serif;
  --font-body: 'Satoshi', sans-serif;
  --color-bg: #0a0a0f;
  --color-surface: rgba(255,255,255,0.05);
  --color-border: rgba(255,255,255,0.12);
  --color-text: #e8e8ec;
  --color-text-muted: #8888a0;
  --color-primary: #4af0c0; /* accent: health, XP, CTAs */
  --color-danger: #ff4466;
  --color-warning: #ffaa22;
  --text-xs: 12px; --text-sm: 14px; --text-base: 16px;
  --text-lg: 20px; --text-xl: 28px; --text-2xl: 40px;
  --space-1: 4px; --space-2: 8px; --space-3: 12px;
  --space-4: 16px; --space-6: 24px; --space-8: 32px;
  --panel-blur: 12px; --panel-radius: 8px;
  --transition-ui: 180ms cubic-bezier(0.16, 1, 0.3, 1);  /* matches --transition-interactive from shared/03-motion.md */
}
```

**2. Panel treatment** — semi-transparent with blur so the 3D scene shows through:

```css
.game-panel {
  background: var(--color-surface);
  backdrop-filter: blur(var(--panel-blur));
  border: 1px solid var(--color-border);
  border-radius: var(--panel-radius);
  padding: var(--space-4);
}
```

**3. Verify** — Render UI elements (HUD, menu, buttons, all type sizes) over a game scene screenshot. Verify contrast and cohesion before building.

### Component Patterns

| Component | Font | Size | Surface |
|---|---|---|---|
| HUD (score, health, timer) | `--font-body` | `--text-sm` | Transparent/subtle bg, tabular nums |
| Title screen | `--font-display` | `--text-2xl` | Background art |
| Menus (main, pause) | `--font-body` | `--text-sm` | `.game-panel` |
| Dialog / tutorial | `--font-body` | `--text-base` | `.game-panel` |
| Settings | `--font-body` | `--text-sm` / `--text-xs` | `.game-panel` |
| Game over / victory | `--font-display` | `--text-xl`–`--text-2xl` | Art + overlay |
| Loading | `--font-body` | `--text-sm` | Background art |
| Tooltip | `--font-body` | `--text-xs` | Small `.game-panel` |

### Contrast Safety

Text overlays on dynamic 3D scenes must always have a background treatment:
- Semi-transparent panel, text shadow, or dark vignette behind HUD text
- Minimum: `text-shadow: 0 1px 3px rgba(0,0,0,0.7), 0 0 8px rgba(0,0,0,0.3);`
- Screenshot HUD over both bright and dark scenes to verify

### 2D Canvas Adaptation

Same tokens, but text drawn via `ctx.font` / `ctx.fillText`. Load fonts via CSS `<link>`, wait for `document.fonts.ready` before rendering:

```js
ctx.font = '600 14px Satoshi, sans-serif'; ctx.fillStyle = '#e8e8ec';
ctx.fillText(`Score: ${score}`, 16, 16);
ctx.font = '700 40px "Cabinet Grotesk", sans-serif'; ctx.textAlign = 'center';
ctx.fillText('GAME OVER', canvas.width/2, canvas.height/3);
```

---

## Music & Sound Design

Every game must include music and sound effects by default. Audio dramatically elevates the experience — never ship a silent game.

### Background Music (Required)
Source royalty-free music that matches the art direction:

| Source | Content | License | URL |
|--------|---------|---------|-----|
| **Pixabay Music** | Thousands of tracks by genre/mood | Royalty-free, no attribution | pixabay.com/music |
| **Freesound** | 500K+ sounds and music loops | CC0/CC-BY | freesound.org |
| **Incompetech** | Hundreds of tracks by Kevin MacLeod | CC-BY 3.0 | incompetech.com |
| **OpenGameArt** | Game-specific music and SFX | CC0/CC-BY | opengameart.org |

**Music selection principles:**
- Match the genre: ambient/atmospheric for exploration, uptempo for action, minimal for puzzles
- Loop seamlessly — choose tracks that loop or edit them to loop cleanly
- Keep file sizes reasonable: 128kbps MP3, 30-90 seconds for loops
- Include volume controls and a mute button in game settings

### Sound Effects (Required)
Add SFX for all player interactions: jumps, hits, pickups, UI clicks, explosions, ambient environment sounds. Source from Freesound, Kenney (kenney.nl/assets?t=audio), or OpenGameArt.

### Audio Implementation
Audio requires a user gesture to start. Show a "Click to Play" screen, then initialize audio on that interaction. Use `<audio>` elements for music (they bypass the binary fetch restriction) and Web Audio API for procedural SFX:

```js
// Music via <audio> element (bypasses fetch CORS issues)
function startMusic() {
  const audio = document.createElement('audio');
  audio.src = 'https://cdn.example.com/bgm.mp3'; // external CDN URL
  audio.loop = true;
  audio.volume = 0.4;
  audio.play();
  return audio;
}

// Procedural SFX via Web Audio API (no file downloads needed)
const audioCtx = new AudioContext();
function playSFX(freq = 440, duration = 0.1, type = 'square') {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + duration);
}

// Start on user interaction
document.addEventListener('click', () => {
  audioCtx.resume();
  startMusic();
}, { once: true });
```

For Three.js positional audio (3D spatialized sounds), use `THREE.PositionalAudio` with audio loaded from CDN URLs:
```js
const listener = new THREE.AudioListener();
camera.add(listener);
const sfx = new THREE.PositionalAudio(listener);
new THREE.AudioLoader().load('https://cdn.example.com/hit.mp3', (buffer) => {
  sfx.setBuffer(buffer);
  sfx.setRefDistance(20);
});
enemyMesh.add(sfx);
```

---

## Core Stack

### Renderer Setup
Use WebGL 2 renderer (WebGPU is blocked in sandboxed iframes):

```js
import * as THREE from 'three';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);
```

### Game Loop
Time-based with fixed-timestep physics, never frame-based:

```js
const clock = new THREE.Clock();
const FIXED_TIMESTEP = 1 / 60;
let accumulator = 0;

function gameLoop() {
  requestAnimationFrame(gameLoop);
  const delta = Math.min(clock.getDelta(), 0.1);
  accumulator += delta;
  while (accumulator >= FIXED_TIMESTEP) {
    updatePhysics(FIXED_TIMESTEP);
    updateGameLogic(FIXED_TIMESTEP);
    accumulator -= FIXED_TIMESTEP;
  }
  updateAnimations(delta);
  composer.render(); // or renderer.render(scene, camera)
}
requestAnimationFrame(gameLoop);
```

### Input Handling
Since Pointer Lock is unavailable, use relative mouse movement for camera control:

```js
let rotX = 0, rotY = 0;
renderer.domElement.addEventListener('mousemove', (e) => {
  if (e.buttons === 1) { // left mouse held
    rotY -= e.movementX * 0.002;
    rotX -= e.movementY * 0.002;
    rotX = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, rotX));
    camera.rotation.set(rotX, rotY, 0, 'YXZ');
  }
});
```

For touch devices, track touch delta similarly. For keyboard input, use standard `keydown`/`keyup` event listeners with a key state map.

---

## Architecture

### Entity Component System (ECS)
Use **Koota** (pmndrs) for complex games. Entities are IDs, traits hold data, systems process queries:

```js
import { createWorld, trait } from 'koota';
const world = createWorld();

const Position = trait({ x: 0, y: 0, z: 0 });
const Velocity = trait({ x: 0, y: 0, z: 0 });
const MeshRef = trait({ mesh: null });

const player = world.spawn(Position, Velocity, MeshRef);

function movementSystem() {
  world.query(Position, Velocity).each((e) => {
    const pos = e.get(Position), vel = e.get(Velocity);
    pos.x += vel.x; pos.y += vel.y; pos.z += vel.z;
  });
}
```

### State Management
Use **Zustand** for global game state (phase, score, settings). Keep game-world state in ECS and UI/menu state in Zustand. Do NOT use the `persist` middleware — it requires localStorage which is blocked.

---

## Physics

Use **Rapier** (`@dimforge/rapier3d-compat`) via CDN import — Rust/WASM, fast, full-featured. Do NOT use Cannon.js. The `-compat` variant loads WASM automatically; when imported from a CDN like esm.sh, the WASM fetch goes to the CDN (cross-origin with CORS), so it works in the sandbox.

```js
import RAPIER from '@dimforge/rapier3d-compat';
await RAPIER.init();

const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });

// Static ground
const groundBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
world.createCollider(RAPIER.ColliderDesc.cuboid(50, 0.1, 50), groundBody);

// Dynamic body
const playerBody = world.createRigidBody(
  RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 5, 0)
);
world.createCollider(RAPIER.ColliderDesc.capsule(0.5, 0.3), playerBody);

function updatePhysics() {
  world.step();
  const pos = playerBody.translation();
  const rot = playerBody.rotation();
  playerMesh.position.set(pos.x, pos.y, pos.z);
  playerMesh.quaternion.set(rot.x, rot.y, rot.z, rot.w);
}
```

---

## Assets

### 3D Models (GLTF/GLB preferred)
Load models from external CDN URLs — not from local files (binary fetch fails in sandbox). No-login-required sources:

| Site | Content | License |
|------|---------|---------|
| **Poly Pizza** | 10K+ low-poly models | CC-BY/CC0 |
| **Kenney** | 40K+ game assets (2D/3D/audio) | CC0 |
| **Quaternius** | Low-poly game-ready models | CC0 |
| **itch.io** (3D tag) | Massive indie collection | Varies |
| **OpenGameArt** | Open source 2D/3D/audio | Varies |

### PBR Textures & HDRIs
- **ambientCG** / **Poly Haven** / **3Dtextures.me** — CC0, no login
- **Poly Haven HDRIs** — up to 16K resolution, CC0

### Loading Models from CDN

```js
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';

const draco = new DRACOLoader();
draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');

const loader = new GLTFLoader();
loader.setDRACOLoader(draco);

// Always use full CDN URLs for models, not local paths
loader.load('https://cdn.example.com/model.glb', (gltf) => {
  scene.add(gltf.scene);
  if (gltf.animations.length) {
    const mixer = new THREE.AnimationMixer(gltf.scene);
    gltf.animations.forEach((clip) => mixer.clipAction(clip).play());
  }
});
```

### Asset Optimization
- Use Draco-compressed GLTFs from asset sources
- Prefer KTX2/Basis Universal textures (75% GPU memory reduction)
- Keep textures at 1K-2K unless close-up detail is needed
- Choose stylized low-poly over high-poly realistic for browser performance
- Remove unused nodes/materials from loaded models

---

## Rendering

### Materials
- `MeshStandardMaterial` for PBR
- `MeshPhysicalMaterial` for clearcoat, transmission, sheen
- Normal maps to fake detail on low-poly surfaces
- Texture atlases to reduce draw calls

### Post-Processing
Use `EffectComposer` for Bloom, SSAO, Depth of Field, Color Grading, Vignette:

```js
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.5, 0.4, 0.85));
composer.addPass(new SMAAPass(innerWidth, innerHeight));
```

### Tone Mapping
- `ACESFilmicToneMapping` — cinematic, good default
- `ReinhardToneMapping` — softer, preserves highlights

---

## Performance

### Key Techniques
- **InstancedMesh** for repeated objects (trees, rocks, particles) — set matrices in a loop, update `instanceMatrix`
- **LOD** (`THREE.LOD`) — swap geometry detail by camera distance
- **Frustum culling** — manage `instancedMesh.count` to render only visible instances

### Rules
- Batch draw calls: fewer meshes with shared materials
- Cap `devicePixelRatio` at 2
- Use `renderer.info` to monitor draw calls and triangles
- Prefer low-poly stylized assets for consistent frame rates
- KTX2 textures to stay under browser GPU memory limits

---

## Testing & Debugging

**Read `skills/GENERAL-KNOWLEDGE-WORKER/website-building/game/game-testing.md` for the complete testing guide.** It covers:

- **Debug overlay** (required for every game) — FPS, frame time, draw calls, triangle count, memory. Visible in screenshots for evaluation.
- **Screenshot-based evaluation** — what to screenshot, when, and how to evaluate each capture.
- **Video capture** — MediaRecorder API for recording gameplay to evaluate animations and physics.
- **Deterministic testing hooks** — `window.advanceTime(ms)`, `window.render_game_to_text()`, `window.simulateInput()` for reproducible, automated testing.
- **Performance profiling** — `renderer.info`, Performance API marks, CPU vs. GPU bottleneck identification, memory leak detection.
- **Common bug prevention** — Three.js resource disposal, animation frame leaks, event listener cleanup, z-fighting, audio context, GC stutter avoidance.
- **Sandbox testing** — defensive API usage, asset loading verification, pre-ship quality checklist.


**Shared files reference:** See `skills/GENERAL-KNOWLEDGE-WORKER/website-building/SKILL.md` for the full shared file table. Key files for games: `game/game-testing.md` (mandatory), `shared/07-toolkit.md` (CDN/Three.js imports), `game/2d-canvas.md` (2D Canvas games).
