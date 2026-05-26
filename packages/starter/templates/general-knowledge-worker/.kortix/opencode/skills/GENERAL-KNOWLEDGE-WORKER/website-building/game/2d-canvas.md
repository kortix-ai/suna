# 2D Canvas Game Engineering

Engineering patterns for building 2D browser games with HTML5 Canvas API. Companion reference to `skills/GENERAL-KNOWLEDGE-WORKER/website-building/game/game.md`.

**Mandatory shared files (read if not already loaded):** `skills/GENERAL-KNOWLEDGE-WORKER/website-building/shared/01-design-tokens.md`.

## Project Architecture

Four logical layers: Engine (game loop, rendering, input, audio), Game Logic (state machines, entity behaviors, rules), Data (configuration, levels, asset references), Visual (canvas drawing, sprite rendering, UI).

For single-file games (the default output), organize code in this order:
1. Constants and configuration
2. Utility functions (math, random, easing)
3. Core engine (game loop, input, audio)
4. Entity/component definitions
5. Game state and scene management
6. Initialization and startup

## The Game Loop

`requestAnimationFrame` with fixed timestep for physics, variable rendering:

```javascript
const TICK_RATE = 1000 / 60; // 60 updates per second
let lastTime = 0;
let accumulator = 0;

function gameLoop(timestamp) {
  const deltaTime = timestamp - lastTime;
  lastTime = timestamp;
  accumulator += deltaTime;
  // Fixed timestep updates (physics, game logic)
  while (accumulator >= TICK_RATE) {
    update(TICK_RATE / 1000); // pass seconds
    accumulator -= TICK_RATE;
  }
  // Variable timestep rendering
  const alpha = accumulator / TICK_RATE;
  render(alpha); // alpha for interpolation
  requestAnimationFrame(gameLoop);
}
requestAnimationFrame(gameLoop);
```

## Canvas Rendering

```javascript
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
ctx.imageSmoothingEnabled = false; // for pixel art

function render(alpha) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawBackground(ctx);
  // Draw game entities (sorted by z-order or y-position)
  entities.sort((a, b) => a.y - b.y);
  for (const entity of entities) {
    entity.draw(ctx, alpha);
  }
  drawUI(ctx); // always on top
}
```

## Sprite Animation

```javascript
class SpriteAnimation {
  constructor(image, frameWidth, frameHeight, frameCount, frameDuration) {
    this.image = image;
    this.frameWidth = frameWidth;
    this.frameHeight = frameHeight;
    this.frameCount = frameCount;
    this.frameDuration = frameDuration;
    this.currentFrame = 0;
    this.elapsed = 0;
  }

  update(dt) {
    this.elapsed += dt;
    if (this.elapsed >= this.frameDuration) {
      this.elapsed -= this.frameDuration;
      this.currentFrame = (this.currentFrame + 1) % this.frameCount;
    }
  }

  draw(ctx, x, y, flipX = false) {
    ctx.save();
    if (flipX) {
      ctx.scale(-1, 1);
      x = -x - this.frameWidth;
    }
    ctx.drawImage(
      this.image,
      this.currentFrame * this.frameWidth, 0,
      this.frameWidth, this.frameHeight,
      x, y, this.frameWidth, this.frameHeight
    );
    ctx.restore();
  }
}
```

## Input Handling

Track input state rather than responding to events directly:

```javascript
const Input = {
  keys: {},
  mouse: { x: 0, y: 0, down: false },
  justPressed: {},

  init(canvas) {
    document.addEventListener('keydown', (e) => {
      if (!this.keys[e.code]) this.justPressed[e.code] = true;
      this.keys[e.code] = true;
    });
    document.addEventListener('keyup', (e) => { this.keys[e.code] = false; });
    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      this.mouse.x = e.clientX - rect.left;
      this.mouse.y = e.clientY - rect.top;
    });
    canvas.addEventListener('mousedown', () => this.mouse.down = true);
    canvas.addEventListener('mouseup', () => this.mouse.down = false);
  },

  endFrame() { this.justPressed = {}; },
  isDown(code) { return !!this.keys[code]; },
  wasPressed(code) { return !!this.justPressed[code]; }
};
```

## Physics and Collision Detection

### Basic Physics with Euler Integration

```javascript
class PhysicsBody {
  constructor(x, y, w, h) {
    this.x = x; this.y = y; this.w = w; this.h = h;
    this.vx = 0; this.vy = 0; this.ax = 0; this.ay = 0;
    this.friction = 0.85;
    this.gravity = 980; // pixels/sec^2
    this.grounded = false;
  }

  update(dt) {
    this.vy += this.gravity * dt;
    this.vx += this.ax * dt;
    this.vy += this.ay * dt;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.vx *= this.friction;
    this.ax = 0; this.ay = 0;
  }
}
```

### AABB Collision Detection

```javascript
function aabbCollision(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x &&
         a.y < b.y + b.h && a.y + a.h > b.y;
}

function resolveCollision(entity, obstacle) {
  const overlapX = Math.min(entity.x + entity.w - obstacle.x, obstacle.x + obstacle.w - entity.x);
  const overlapY = Math.min(entity.y + entity.h - obstacle.y, obstacle.y + obstacle.h - entity.y);
  if (overlapX < overlapY) {
    entity.x += (entity.vx > 0) ? -overlapX : overlapX;
    entity.vx = 0;
  } else {
    entity.y += (entity.vy > 0) ? -overlapY : overlapY;
    if (entity.vy > 0) entity.grounded = true;
    entity.vy = 0;
  }
}
```

### Circle Collision

```javascript
function circleCollision(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy) < a.radius + b.radius;
}
```

### Spatial Partitioning (for many entities)

```javascript
class SpatialGrid {
  constructor(cellSize) { this.cellSize = cellSize; this.cells = new Map(); }

  key(x, y) {
    return `${Math.floor(x / this.cellSize)},${Math.floor(y / this.cellSize)}`;
  }

  insert(entity) {
    const k = this.key(entity.x, entity.y);
    if (!this.cells.has(k)) this.cells.set(k, []);
    this.cells.get(k).push(entity);
  }

  query(x, y, radius) {
    const results = [], cs = this.cellSize;
    const minX = Math.floor((x - radius) / cs), maxX = Math.floor((x + radius) / cs);
    const minY = Math.floor((y - radius) / cs), maxY = Math.floor((y + radius) / cs);
    for (let cx = minX; cx <= maxX; cx++)
      for (let cy = minY; cy <= maxY; cy++) {
        const cell = this.cells.get(`${cx},${cy}`);
        if (cell) results.push(...cell);
      }
    return results;
  }

  clear() { this.cells.clear(); }
}
```

## Entity-Component Pattern

```javascript
class Entity {
  constructor(id) {
    this.id = id;
    this.components = {};
    this.active = true;
  }

  add(name, component) {
    this.components[name] = component;
    component.entity = this;
    return this;
  }

  get(name) { return this.components[name]; }
  has(name) { return name in this.components; }
}
```

## State Machines

```javascript
class StateMachine {
  constructor(owner) {
    this.owner = owner;
    this.states = {};
    this.current = null;
  }

  add(name, state) {
    this.states[name] = state;
    state.machine = this;
    state.owner = this.owner;
  }

  transition(name) {
    if (this.current) this.current.exit();
    this.current = this.states[name];
    this.current.enter();
  }

  update(dt) { if (this.current) this.current.update(dt); }
}
```

## Camera Systems

```javascript
class Camera {
  constructor(width, height) {
    this.x = 0; this.y = 0;
    this.width = width; this.height = height;
    this.smoothing = 0.1;
  }

  follow(target) {
    const targetX = target.x - this.width / 2;
    const targetY = target.y - this.height / 2;
    this.x += (targetX - this.x) * this.smoothing;
    this.y += (targetY - this.y) * this.smoothing;
  }

  clamp(worldWidth, worldHeight) {
    this.x = Math.max(0, Math.min(this.x, worldWidth - this.width));
    this.y = Math.max(0, Math.min(this.y, worldHeight - this.height));
  }

  apply(ctx) { ctx.translate(-Math.round(this.x), -Math.round(this.y)); }
}

// Parallax scrolling
function drawParallax(ctx, layers, camera) {
  for (const layer of layers) {
    const offsetX = camera.x * layer.speed;
    const x = -(offsetX % layer.width);
    ctx.drawImage(layer.image, x, 0);
    ctx.drawImage(layer.image, x + layer.width, 0);
  }
}
```

## Particle Systems (with Object Pooling)

```javascript
class Particle {
  constructor() { this.active = false; }

  init(x, y, vx, vy, life, color, size) {
    this.x = x; this.y = y; this.vx = vx; this.vy = vy;
    this.life = life; this.maxLife = life;
    this.color = color; this.size = size;
    this.active = true;
  }

  update(dt) {
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.vy += 200 * dt;
    this.life -= dt;
    if (this.life <= 0) this.active = false;
  }

  draw(ctx) {
    const alpha = this.life / this.maxLife;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = this.color;
    ctx.fillRect(this.x, this.y, this.size * alpha, this.size * alpha);
    ctx.globalAlpha = 1;
  }
}

class ParticlePool {
  constructor(size) { this.pool = Array.from({ length: size }, () => new Particle()); }

  emit(x, y, count, cfg) {
    let emitted = 0;
    for (const p of this.pool) {
      if (!p.active && emitted < count) {
        p.init(x, y, (Math.random() - 0.5) * cfg.spread, -Math.random() * cfg.speed,
          cfg.life + Math.random() * cfg.lifeVariance, cfg.color, cfg.size);
        emitted++;
      }
    }
  }

  update(dt) { for (const p of this.pool) if (p.active) p.update(dt); }
  draw(ctx) { for (const p of this.pool) if (p.active) p.draw(ctx); }
}
```

## Scene Management

```javascript
const SceneManager = {
  scenes: {},
  stack: [],

  register(name, scene) { this.scenes[name] = scene; },

  push(name, data) {
    const scene = this.scenes[name];
    this.stack.push(scene);
    if (scene.enter) scene.enter(data);
  },

  pop() {
    const scene = this.stack.pop();
    if (scene && scene.exit) scene.exit();
    return this.current;
  },

  replace(name, data) { this.pop(); this.push(name, data); },
  get current() { return this.stack[this.stack.length - 1]; },
  update(dt) { if (this.current) this.current.update(dt); },
  render(ctx) { if (this.current) this.current.render(ctx); }
};
```

## Tilemap Systems

```javascript
class Tilemap {
  constructor(data, tileSize) {
    this.data = data; // 2D array of tile IDs
    this.tileSize = tileSize;
    this.rows = data.length;
    this.cols = data[0].length;
  }

  getTile(col, row) {
    if (row < 0 || row >= this.rows || col < 0 || col >= this.cols) return 1;
    return this.data[row][col];
  }

  draw(ctx, camera, tileColors) {
    const ts = this.tileSize;
    const startCol = Math.floor(camera.x / ts), endCol = Math.ceil((camera.x + camera.width) / ts);
    const startRow = Math.floor(camera.y / ts), endRow = Math.ceil((camera.y + camera.height) / ts);
    for (let row = startRow; row <= endRow; row++) {
      for (let col = startCol; col <= endCol; col++) {
        const tile = this.getTile(col, row);
        if (tile === 0) continue;
        ctx.fillStyle = tileColors[tile] || '#888';
        ctx.fillRect(col * ts, row * ts, ts, ts);
      }
    }
  }

  isSolid(x, y) {
    return this.getTile(Math.floor(x / this.tileSize), Math.floor(y / this.tileSize)) !== 0;
  }
}
```

## Simple AI Patterns

```javascript
function patrol(entity, pointA, pointB, speed) {
  const target = entity.movingToB ? pointB : pointA;
  const dx = target.x - entity.x, dy = target.y - entity.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 5) { entity.movingToB = !entity.movingToB; }
  else { entity.vx = (dx / dist) * speed; entity.vy = (dy / dist) * speed; }
}

function chase(entity, target, speed) {
  const dx = target.x - entity.x, dy = target.y - entity.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist > 0) { entity.vx = (dx / dist) * speed; entity.vy = (dy / dist) * speed; }
}

function flee(entity, target, speed) { chase(entity, target, -speed); }

function hasLineOfSight(entity, target, tilemap) {
  const steps = 20;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = entity.x + (target.x - entity.x) * t;
    const y = entity.y + (target.y - entity.y) * t;
    if (tilemap.isSolid(x, y)) return false;
  }
  return true;
}
```

## Procedural Generation

```javascript
// Cave/dungeon via cellular automata
function generateCaveMap(width, height, fillChance = 0.45, iterations = 5) {
  let map = Array.from({ length: height }, () =>
    Array.from({ length: width }, () => Math.random() < fillChance ? 1 : 0)
  );
  for (let i = 0; i < iterations; i++) {
    const newMap = map.map(row => [...row]);
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        let neighbors = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            neighbors += map[y + dy][x + dx];
          }
        newMap[y][x] = neighbors > 4 ? 1 : neighbors < 4 ? 0 : map[y][x];
      }
    }
    map = newMap;
  }
  for (let y = 0; y < height; y++) { map[y][0] = 1; map[y][width - 1] = 1; }
  for (let x = 0; x < width; x++) { map[0][x] = 1; map[height - 1][x] = 1; }
  return map;
}
```

## Utility Functions

```javascript
const Utils = {
  lerp: (a, b, t) => a + (b - a) * t,
  clamp: (val, min, max) => Math.max(min, Math.min(max, val)),
  randRange: (min, max) => Math.random() * (max - min) + min,
  randInt: (min, max) => Math.floor(Math.random() * (max - min + 1)) + min,
  distance: (x1, y1, x2, y2) => Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2),
  angle: (x1, y1, x2, y2) => Math.atan2(y2 - y1, x2 - x1),
  easeOutQuad: (t) => t * (2 - t),
  easeInOutCubic: (t) => t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2,
  easeOutElastic: (t) => {
    const c4 = (2 * Math.PI) / 3;
    return t === 0 ? 0 : t === 1 ? 1
      : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
  },
  easeOutBounce: (t) => {
    const n1 = 7.5625, d1 = 2.75;
    if (t < 1 / d1) return n1 * t * t;
    if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
    if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
    return n1 * (t -= 2.625 / d1) * t + 0.984375;
  }
};
```
