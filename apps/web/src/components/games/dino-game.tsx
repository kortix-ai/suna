'use client';

import { useTranslations } from 'next-intl';

import { useCallback, useEffect, useRef, useState } from 'react';

// ─── Sprite sheet data (1:1 with Chrome's T-Rex runner) ─────────────────────
// All sprites are drawn procedurally to avoid external asset dependencies.

const CANVAS_WIDTH = 600;
const CANVAS_HEIGHT = 150;
const GROUND_Y = 120;
const GRAVITY = 0.6;
const JUMP_VELOCITY = -10;
const INITIAL_SPEED = 6;
const MAX_SPEED = 13;
const ACCELERATION = 0.001;

// ─── Colors ─────────────────────────────────────────────────────────────────
const COLOR_DINO = '#535353';
const COLOR_GROUND = '#535353';
const COLOR_CLOUD = '#d4d4d4';
const COLOR_OBSTACLE = '#535353';
const COLOR_TEXT = '#535353';
const COLOR_GAMEOVER = '#535353';

// ─── Dino sprite dimensions ─────────────────────────────────────────────────
const DINO_WIDTH = 44;
const DINO_HEIGHT = 47;
const DINO_DUCK_WIDTH = 59;
const DINO_DUCK_HEIGHT = 30;

// ─── Obstacle types ─────────────────────────────────────────────────────────
interface Obstacle {
  x: number;
  width: number;
  height: number;
  y: number;
  type: 'cactus-small' | 'cactus-large' | 'cactus-group' | 'pterodactyl';
  pteroFrame?: number;
}

interface Cloud {
  x: number;
  y: number;
}

interface Star {
  x: number;
  y: number;
  size: number;
}

interface GameState {
  dino: {
    x: number;
    y: number;
    vy: number;
    width: number;
    height: number;
    ducking: boolean;
    frame: number;
  };
  obstacles: Obstacle[];
  clouds: Cloud[];
  stars: Star[];
  ground: { offset: number };
  speed: number;
  score: number;
  highScore: number;
  isRunning: boolean;
  isGameOver: boolean;
  isNight: boolean;
  nightAlpha: number;
  frameCount: number;
  obstacleTimer: number;
  hasStarted: boolean;
}

// ─── Draw helpers ───────────────────────────────────────────────────────────

function drawDino(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  ducking: boolean,
  frame: number,
  isGameOver: boolean,
) {
  ctx.fillStyle = COLOR_DINO;

  if (ducking) {
    // Ducking dino — wider, shorter
    const dy = GROUND_Y - DINO_DUCK_HEIGHT;

    // Body
    ctx.fillRect(x + 10, dy, 49, 16);
    ctx.fillRect(x + 4, dy + 4, 10, 12);

    // Head
    ctx.fillRect(x + 40, dy - 8, 19, 14);
    ctx.fillRect(x + 52, dy - 8, 7, 6);

    // Eye
    ctx.fillStyle = '#fff';
    ctx.fillRect(x + 52, dy - 5, 3, 3);
    ctx.fillStyle = COLOR_DINO;

    // Legs (animated)
    if (!isGameOver) {
      if (frame % 2 === 0) {
        ctx.fillRect(x + 16, dy + 16, 5, 8);
        ctx.fillRect(x + 30, dy + 16, 5, 4);
      } else {
        ctx.fillRect(x + 16, dy + 16, 5, 4);
        ctx.fillRect(x + 30, dy + 16, 5, 8);
      }
    } else {
      ctx.fillRect(x + 16, dy + 16, 5, 6);
      ctx.fillRect(x + 30, dy + 16, 5, 6);
    }
  } else {
    // Standing dino
    const dy = y;

    // Body
    ctx.fillRect(x + 8, dy + 10, 28, 26);

    // Tail
    ctx.fillRect(x, dy + 14, 12, 6);
    ctx.fillRect(x - 2, dy + 18, 6, 4);

    // Neck
    ctx.fillRect(x + 22, dy + 2, 12, 14);

    // Head
    ctx.fillRect(x + 18, dy - 4, 26, 16);
    ctx.fillRect(x + 34, dy - 4, 10, 8);

    // Eye
    ctx.fillStyle = isGameOver ? COLOR_DINO : '#fff';
    ctx.fillRect(x + 35, dy + 1, 4, 4);
    ctx.fillStyle = COLOR_DINO;

    // Dead eye (X)
    if (isGameOver) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(x + 35, dy + 1, 4, 4);
      ctx.fillStyle = COLOR_DINO;
      ctx.fillRect(x + 36, dy + 2, 1, 1);
      ctx.fillRect(x + 38, dy + 2, 1, 1);
      ctx.fillRect(x + 37, dy + 3, 1, 1);
      ctx.fillRect(x + 36, dy + 4, 1, 1);
      ctx.fillRect(x + 38, dy + 4, 1, 1);
    }

    // Arms
    ctx.fillRect(x + 24, dy + 28, 4, 8);

    // Legs (animated)
    if (!isGameOver && y >= GROUND_Y - DINO_HEIGHT) {
      if (frame % 2 === 0) {
        ctx.fillRect(x + 12, dy + 36, 6, 11);
        ctx.fillRect(x + 24, dy + 36, 6, 6);
      } else {
        ctx.fillRect(x + 12, dy + 36, 6, 6);
        ctx.fillRect(x + 24, dy + 36, 6, 11);
      }
    } else {
      ctx.fillRect(x + 12, dy + 36, 6, 11);
      ctx.fillRect(x + 24, dy + 36, 6, 11);
    }
  }
}

function drawCactusSmall(ctx: CanvasRenderingContext2D, x: number) {
  ctx.fillStyle = COLOR_OBSTACLE;
  // Trunk
  ctx.fillRect(x + 5, GROUND_Y - 35, 7, 35);
  // Left arm
  ctx.fillRect(x, GROUND_Y - 22, 7, 4);
  ctx.fillRect(x, GROUND_Y - 30, 4, 12);
  // Right arm
  ctx.fillRect(x + 10, GROUND_Y - 18, 7, 4);
  ctx.fillRect(x + 13, GROUND_Y - 26, 4, 12);
}

function drawCactusLarge(ctx: CanvasRenderingContext2D, x: number) {
  ctx.fillStyle = COLOR_OBSTACLE;
  // Trunk
  ctx.fillRect(x + 7, GROUND_Y - 50, 11, 50);
  // Left arm
  ctx.fillRect(x, GROUND_Y - 35, 9, 5);
  ctx.fillRect(x, GROUND_Y - 45, 5, 15);
  // Right arm
  ctx.fillRect(x + 16, GROUND_Y - 28, 9, 5);
  ctx.fillRect(x + 20, GROUND_Y - 40, 5, 17);
}

function drawCactusGroup(ctx: CanvasRenderingContext2D, x: number) {
  ctx.fillStyle = COLOR_OBSTACLE;
  // Three small cacti close together
  // Cactus 1
  ctx.fillRect(x, GROUND_Y - 30, 6, 30);
  ctx.fillRect(x - 3, GROUND_Y - 20, 5, 3);
  ctx.fillRect(x - 3, GROUND_Y - 25, 3, 8);

  // Cactus 2
  ctx.fillRect(x + 10, GROUND_Y - 38, 7, 38);
  ctx.fillRect(x + 7, GROUND_Y - 28, 5, 3);
  ctx.fillRect(x + 7, GROUND_Y - 34, 3, 10);
  ctx.fillRect(x + 15, GROUND_Y - 22, 5, 3);
  ctx.fillRect(x + 17, GROUND_Y - 30, 3, 12);

  // Cactus 3
  ctx.fillRect(x + 22, GROUND_Y - 32, 6, 32);
  ctx.fillRect(x + 26, GROUND_Y - 24, 5, 3);
  ctx.fillRect(x + 28, GROUND_Y - 28, 3, 8);
}

function drawPterodactyl(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  frame: number,
) {
  ctx.fillStyle = COLOR_OBSTACLE;

  // Body
  ctx.fillRect(x + 6, y + 10, 34, 8);

  // Head / beak
  ctx.fillRect(x + 36, y + 8, 10, 6);
  ctx.fillRect(x + 42, y + 10, 8, 4);

  // Tail
  ctx.fillRect(x, y + 12, 8, 4);

  // Wings (animated)
  if (frame % 2 === 0) {
    // Wings up
    ctx.fillRect(x + 10, y, 6, 12);
    ctx.fillRect(x + 14, y - 2, 10, 6);
    ctx.fillRect(x + 22, y, 6, 4);
  } else {
    // Wings down
    ctx.fillRect(x + 10, y + 16, 6, 12);
    ctx.fillRect(x + 14, y + 22, 10, 6);
    ctx.fillRect(x + 22, y + 24, 6, 4);
  }
}

function drawCloud(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.fillStyle = COLOR_CLOUD;
  ctx.fillRect(x + 6, y, 30, 8);
  ctx.fillRect(x, y + 4, 42, 8);
  ctx.fillRect(x + 4, y + 8, 34, 6);
}

function drawGround(
  ctx: CanvasRenderingContext2D,
  offset: number,
  width: number,
) {
  ctx.fillStyle = COLOR_GROUND;
  ctx.fillRect(0, GROUND_Y, width, 1);

  // Ground texture bumps
  const bump = (bx: number) => {
    ctx.fillRect(bx, GROUND_Y + 3, 2, 1);
    ctx.fillRect(bx + 6, GROUND_Y + 5, 3, 1);
    ctx.fillRect(bx + 14, GROUND_Y + 2, 1, 1);
    ctx.fillRect(bx + 20, GROUND_Y + 4, 4, 1);
    ctx.fillRect(bx + 30, GROUND_Y + 3, 2, 1);
    ctx.fillRect(bx + 38, GROUND_Y + 5, 1, 1);
    ctx.fillRect(bx + 44, GROUND_Y + 2, 3, 1);
    ctx.fillRect(bx + 56, GROUND_Y + 4, 2, 1);
    ctx.fillRect(bx + 64, GROUND_Y + 3, 1, 1);
  };

  const patternWidth = 70;
  const startX = -(offset % patternWidth);
  for (let bx = startX; bx < width + patternWidth; bx += patternWidth) {
    bump(bx);
  }
}

function drawScore(
  ctx: CanvasRenderingContext2D,
  score: number,
  highScore: number,
  width: number,
) {
  ctx.fillStyle = COLOR_TEXT;
  ctx.font = '11px "Courier New", monospace';
  ctx.textAlign = 'right';

  const scoreStr = String(Math.floor(score)).padStart(5, '0');

  if (highScore > 0) {
    const hiStr = 'HI ' + String(Math.floor(highScore)).padStart(5, '0');
    ctx.fillStyle = '#757575';
    ctx.fillText(hiStr, width - 70, 18);
    ctx.fillStyle = COLOR_TEXT;
    ctx.fillText(scoreStr, width - 10, 18);
  } else {
    ctx.fillText(scoreStr, width - 10, 18);
  }
}

function drawGameOver(ctx: CanvasRenderingContext2D, width: number) {
  ctx.fillStyle = COLOR_GAMEOVER;
  ctx.font = '12px "Courier New", monospace';
  ctx.textAlign = 'center';
  ctx.fillText('G A M E  O V E R', width / 2, 50);

  // Replay button
  const bx = width / 2 - 15;
  const by = 60;
  ctx.strokeStyle = COLOR_GAMEOVER;
  ctx.lineWidth = 1;
  ctx.strokeRect(bx - 5, by - 2, 40, 28);

  // Circular arrow
  ctx.beginPath();
  ctx.arc(bx + 15, by + 12, 8, -Math.PI * 0.8, Math.PI * 0.8);
  ctx.stroke();

  // Arrowhead
  ctx.beginPath();
  ctx.moveTo(bx + 9, by + 5);
  ctx.lineTo(bx + 9, by + 10);
  ctx.lineTo(bx + 5, by + 7);
  ctx.fillStyle = COLOR_GAMEOVER;
  ctx.fill();
}

// ─── Collision detection ────────────────────────────────────────────────────
function checkCollision(
  dino: GameState['dino'],
  obs: Obstacle,
): boolean {
  // Shrink hitboxes slightly for fairness (just like the original)
  const pad = 6;
  const dx = dino.x + pad;
  const dw = dino.width - pad * 2;
  const dy = dino.y + pad;
  const dh = dino.height - pad * 2;

  const ox = obs.x + pad;
  const ow = obs.width - pad * 2;
  const oy = obs.y + (obs.type === 'pterodactyl' ? pad : 0);
  const oh =
    obs.height - (obs.type === 'pterodactyl' ? pad * 2 : pad);

  return dx < ox + ow && dx + dw > ox && dy < oy + oh && dy + dh > oy;
}

// ─── Component ──────────────────────────────────────────────────────────────

export function DinoGame() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<GameState | null>(null);
  const animFrameRef = useRef<number>(0);
  const [, setRender] = useState(0);

  const getInitialState = useCallback((): GameState => {
    const stored = typeof window !== 'undefined'
      ? parseInt(localStorage.getItem('dino-high-score') || '0', 10)
      : 0;
    return {
      dino: {
        x: 30,
        y: GROUND_Y - DINO_HEIGHT,
        vy: 0,
        width: DINO_WIDTH,
        height: DINO_HEIGHT,
        ducking: false,
        frame: 0,
      },
      obstacles: [],
      clouds: [
        { x: 100, y: 20 },
        { x: 300, y: 35 },
        { x: 500, y: 15 },
      ],
      stars: [],
      ground: { offset: 0 },
      speed: INITIAL_SPEED,
      score: 0,
      highScore: stored,
      isRunning: false,
      isGameOver: false,
      isNight: false,
      nightAlpha: 0,
      frameCount: 0,
      obstacleTimer: 0,
      hasStarted: false,
    };
  }, []);

  const startGame = useCallback(() => {
    const s = stateRef.current;
    if (!s) return;
    if (s.isGameOver) {
      const hs = s.highScore;
      Object.assign(s, getInitialState());
      s.highScore = hs;
    }
    s.isRunning = true;
    s.hasStarted = true;
    s.dino.vy = JUMP_VELOCITY;
  }, [getInitialState]);

  const jump = useCallback(() => {
    const s = stateRef.current;
    if (!s) return;
    if (!s.hasStarted || s.isGameOver) {
      startGame();
      return;
    }
    if (s.dino.y >= GROUND_Y - DINO_HEIGHT - 1) {
      s.dino.vy = JUMP_VELOCITY;
      s.dino.ducking = false;
    }
  }, [startGame]);

  const setDuck = useCallback((ducking: boolean) => {
    const s = stateRef.current;
    if (!s || !s.isRunning || s.isGameOver) return;
    s.dino.ducking = ducking;
    if (ducking) {
      s.dino.width = DINO_DUCK_WIDTH;
      s.dino.height = DINO_DUCK_HEIGHT;
      // Fast fall when ducking in air
      if (s.dino.y < GROUND_Y - DINO_HEIGHT) {
        s.dino.vy = Math.max(s.dino.vy, 4);
      }
    } else {
      s.dino.width = DINO_WIDTH;
      s.dino.height = DINO_HEIGHT;
    }
  }, []);

  // ─── Game loop ──────────────────────────────────────────────────────────
  const gameLoop = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    const s = stateRef.current;
    if (!canvas || !ctx || !s) return;

    const w = canvas.width;
    const h = canvas.height;

    // Clear
    if (s.isNight) {
      ctx.fillStyle = `rgba(0, 0, 0, ${s.nightAlpha * 0.85})`;
      ctx.fillRect(0, 0, w, h);
      // Re-clear with transparent bg
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = `rgba(${Math.round(255 * (1 - s.nightAlpha * 0.85))}, ${Math.round(255 * (1 - s.nightAlpha * 0.85))}, ${Math.round(255 * (1 - s.nightAlpha * 0.85))}, 1)`;
      ctx.fillRect(0, 0, w, h);
    } else {
      ctx.clearRect(0, 0, w, h);
    }

    if (s.isRunning && !s.isGameOver) {
      s.frameCount++;

      // ── Update speed ──
      s.speed = Math.min(MAX_SPEED, INITIAL_SPEED + s.frameCount * ACCELERATION);

      // ── Update score ──
      s.score += s.speed * 0.02;

      // ── Day/Night cycle — every 700 points ──
      const cycle = Math.floor(s.score / 700);
      const targetNight = cycle % 2 === 1;
      if (targetNight && !s.isNight) {
        s.isNight = true;
        // Generate stars
        s.stars = Array.from({ length: 12 }, () => ({
          x: Math.random() * w,
          y: Math.random() * (GROUND_Y - 30),
          size: Math.random() > 0.7 ? 2 : 1,
        }));
      }
      if (!targetNight && s.isNight) s.isNight = false;

      s.nightAlpha = s.isNight
        ? Math.min(1, s.nightAlpha + 0.01)
        : Math.max(0, s.nightAlpha - 0.01);

      // ── Update dino ──
      s.dino.vy += GRAVITY;
      s.dino.y += s.dino.vy;

      const floorY = s.dino.ducking
        ? GROUND_Y - DINO_DUCK_HEIGHT
        : GROUND_Y - DINO_HEIGHT;

      if (s.dino.y >= floorY) {
        s.dino.y = floorY;
        s.dino.vy = 0;
      }

      // Animate legs every 6 frames
      if (s.frameCount % 6 === 0) {
        s.dino.frame = s.dino.frame === 0 ? 1 : 0;
      }

      // ── Update ground ──
      s.ground.offset += s.speed;

      // ── Update clouds ──
      for (const c of s.clouds) {
        c.x -= s.speed * 0.3;
        if (c.x < -50) {
          c.x = w + Math.random() * 100;
          c.y = 10 + Math.random() * 40;
        }
      }

      // ── Spawn obstacles ──
      s.obstacleTimer -= s.speed;
      if (s.obstacleTimer <= 0) {
        const minGap = Math.max(200, 400 - s.speed * 15);
        const maxGap = minGap + 200;
        s.obstacleTimer = minGap + Math.random() * (maxGap - minGap);

        const r = Math.random();
        let obs: Obstacle;

        if (r < 0.25) {
          obs = {
            x: w,
            width: 17,
            height: 35,
            y: GROUND_Y - 35,
            type: 'cactus-small',
          };
        } else if (r < 0.5) {
          obs = {
            x: w,
            width: 25,
            height: 50,
            y: GROUND_Y - 50,
            type: 'cactus-large',
          };
        } else if (r < 0.75) {
          obs = {
            x: w,
            width: 33,
            height: 38,
            y: GROUND_Y - 38,
            type: 'cactus-group',
          };
        } else {
          const pteroY = [GROUND_Y - 60, GROUND_Y - 40, GROUND_Y - 75][
            Math.floor(Math.random() * 3)
          ];
          obs = {
            x: w,
            width: 46,
            height: 28,
            y: pteroY,
            type: 'pterodactyl',
            pteroFrame: 0,
          };
        }

        s.obstacles.push(obs);
      }

      // ── Update obstacles ──
      for (let i = s.obstacles.length - 1; i >= 0; i--) {
        const obs = s.obstacles[i];
        obs.x -= s.speed;

        if (obs.type === 'pterodactyl' && s.frameCount % 10 === 0) {
          obs.pteroFrame = obs.pteroFrame === 0 ? 1 : 0;
        }

        // Remove off-screen
        if (obs.x < -60) {
          s.obstacles.splice(i, 1);
          continue;
        }

        // Collision
        if (checkCollision(s.dino, obs)) {
          s.isGameOver = true;
          s.isRunning = false;
          if (s.score > s.highScore) {
            s.highScore = s.score;
            try {
              localStorage.setItem(
                'dino-high-score',
                String(Math.floor(s.highScore)),
              );
            } catch {
              // noop
            }
          }
          setRender((r) => r + 1);
        }
      }

      // ── Score milestone flash (every 100 pts) ──
      if (Math.floor(s.score) % 100 === 0 && Math.floor(s.score) > 0 && s.frameCount % 6 < 3) {
        // Brief flash handled by not drawing score for a few frames
      }
    }

    // ─── Draw ───────────────────────────────────────────────────────────

    // Night background
    if (s.nightAlpha > 0) {
      ctx.clearRect(0, 0, w, h);
      const bgVal = Math.round(255 * (1 - s.nightAlpha * 0.82));
      ctx.fillStyle = `rgb(${bgVal}, ${bgVal}, ${bgVal})`;
      ctx.fillRect(0, 0, w, h);

      // Stars
      if (s.nightAlpha > 0.3) {
        ctx.fillStyle = `rgba(255, 255, 255, ${s.nightAlpha})`;
        for (const star of s.stars) {
          ctx.fillRect(star.x, star.y, star.size, star.size);
        }
      }
    }

    // Clouds
    for (const c of s.clouds) {
      drawCloud(ctx, c.x, c.y);
    }

    // Ground
    drawGround(ctx, s.ground.offset, w);

    // Obstacles
    for (const obs of s.obstacles) {
      switch (obs.type) {
        case 'cactus-small':
          drawCactusSmall(ctx, obs.x);
          break;
        case 'cactus-large':
          drawCactusLarge(ctx, obs.x);
          break;
        case 'cactus-group':
          drawCactusGroup(ctx, obs.x);
          break;
        case 'pterodactyl':
          drawPterodactyl(ctx, obs.x, obs.y, obs.pteroFrame ?? 0);
          break;
      }
    }

    // Dino
    drawDino(
      ctx,
      s.dino.x,
      s.dino.y,
      s.dino.ducking,
      s.dino.frame,
      s.isGameOver,
    );

    // Score
    drawScore(ctx, s.score, s.highScore, w);

    // Game over overlay
    if (s.isGameOver) {
      drawGameOver(ctx, w);
    }

    // Idle state — blinking dino
    if (!s.hasStarted) {
      ctx.fillStyle = COLOR_TEXT;
      ctx.font = '10px "Courier New", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('Press Space or Tap to Start', w / 2, 70);
    }

    animFrameRef.current = requestAnimationFrame(gameLoop);
  }, []);

  // ─── Init ─────────────────────────────────────────────────────────────
  useEffect(() => {
    stateRef.current = getInitialState();
    animFrameRef.current = requestAnimationFrame(gameLoop);

    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [getInitialState, gameLoop]);

  // ─── Input handlers ───────────────────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' || e.code === 'ArrowUp') {
        e.preventDefault();
        jump();
      }
      if (e.code === 'ArrowDown') {
        e.preventDefault();
        setDuck(true);
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'ArrowDown') {
        e.preventDefault();
        setDuck(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [jump, setDuck]);

  const handleCanvasClick = useCallback(() => {
    jump();
  }, [jump]);

  return (
    <div className="flex flex-col items-center gap-2">
      <canvas
        ref={canvasRef}
        width={CANVAS_WIDTH}
        height={CANVAS_HEIGHT}
        onClick={handleCanvasClick}
        onTouchStart={(e) => {
          e.preventDefault();
          jump();
        }}
        className="cursor-pointer rounded-lg"
        style={{
          maxWidth: '100%',
          imageRendering: 'pixelated',
        }}
      />
      <p className="text-xs text-foreground/20 select-none">{tHardcodedUi.raw('componentsGamesDinoGame.line747JsxTextSpaceJumpDuck')}</p>
    </div>
  );
}
