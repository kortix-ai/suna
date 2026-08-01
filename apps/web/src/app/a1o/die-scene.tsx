'use client';

import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as CANNON from 'cannon-es';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

import { LAYERS } from './content';

/**
 * A real die, thrown with real rigid-body physics.
 *
 * The die is not animated along a path — it is a cannon-es body given an
 * impulse and a tumble, left to bounce off the table and settle wherever it
 * settles. Whichever face ends up pointing at the sky is read back and becomes
 * the layer shown on the page, so the roll genuinely decides the content.
 *
 * Physics runs at a fixed 1/60 step with the frame delta as the accumulator, so
 * the throw behaves the same on a 60Hz and a 144Hz display.
 */

/** Half-extent of the die. */
const HALF = 0.5;
/**
 * Gap between the walls and the edge of the visible table, in world units.
 * The pen is not a fixed size — it is measured from the camera every resize so
 * the die can roll anywhere you can actually see, and only meets a wall at the
 * edge of frame. A fixed pen was far smaller than the viewport, so the die
 * spent most of its time ricocheting off boundaries that were not visible.
 */
const WALL_INSET = 0.35;
/** Linear impulse per pixel of drag. */
const NUDGE_FORCE = 0.05;
/**
 * Rolling spin per pixel of drag. Without this a shove just skids the die
 * across the table on its face — the linear push alone rarely carries the
 * centre of mass past the tipping edge, which is what "it won't fall over"
 * looks like. Real dice roll because the contact edge acts as a pivot.
 */
const ROLL_TORQUE = 0.4;
/** Angular speed of the deliberate spin action, in rad/s. */
const SPIN_RATE = 19;
/** Hard ceiling on angular speed, so a frantic drag cannot explode the solver. */
const MAX_SPIN = 34;
/** Below this linear + angular speed, the die counts as coming to rest. */
const REST_SPEED = 0.09;
/** Consecutive resting steps required before the face is read. */
const REST_STEPS = 22;
/** Failsafe: read the face anyway after this many steps. */
const MAX_STEPS = 60 * 9;

/**
 * Local face normals and the content slot printed on each. Opposite faces sum
 * to seven, the way a real die is arranged, so the six layers sit on the cube
 * in a genuine die layout rather than an arbitrary one.
 */
const DIE_FACES: readonly { normal: THREE.Vector3; slot: number }[] = [
  { normal: new THREE.Vector3(0, 1, 0), slot: 1 },
  { normal: new THREE.Vector3(0, 0, 1), slot: 3 },
  { normal: new THREE.Vector3(1, 0, 0), slot: 2 },
  { normal: new THREE.Vector3(-1, 0, 0), slot: 5 },
  { normal: new THREE.Vector3(0, 0, -1), slot: 4 },
  { normal: new THREE.Vector3(0, -1, 0), slot: 6 },
];

/**
 * A face of the die: the layer's name set large, its ordinal above. Drawn on a
 * transparent canvas and laid over the body as a decal, so the die's bevel and
 * shading stay intact underneath the type.
 */
function drawFace(label: string, ordinal: string): THREE.CanvasTexture {
  const px = 512;
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d');
  if (!ctx) return new THREE.CanvasTexture(canvas);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.fillStyle = '#8e8e8e';
  ctx.font = '500 46px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillText(ordinal, px / 2, px * 0.31);

  ctx.fillStyle = '#0a0a0a';
  try {
    ctx.letterSpacing = '1px';
  } catch {
    /* older engines simply render without tracking */
  }

  // Multi-word titles stack rather than shrink, so "CLOUD RUNTIME" stays as
  // readable as "MODELS" instead of being squeezed onto one thin line.
  const lines = label.includes(' ') ? label.split(' ') : [label];
  const maxWidth = px * 0.78;
  const font = (s: number) =>
    `600 ${s}px ui-sans-serif, system-ui, -apple-system, sans-serif`;

  // Size to the widest line rather than guessing one size for all six faces.
  let size = lines.length > 1 ? 78 : 92;
  ctx.font = font(size);
  const widest = () => Math.max(...lines.map((l) => ctx.measureText(l).width));
  while (size > 34 && widest() > maxWidth) {
    size -= 2;
    ctx.font = font(size);
  }

  const lineHeight = size * 1.05;
  // Centre the block on the same optical point a single line would occupy.
  const top = px * 0.58 - ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((line, i) => {
    ctx.fillText(line, px / 2, top + i * lineHeight);
  });

  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 4;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Orientation laying a +Z-facing plane flat against a given face normal. */
function plateQuaternion(normal: THREE.Vector3) {
  return new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 0, 1),
    normal,
  );
}

type DieProps = {
  /** Incrementing this token throws the die from above. */
  rollToken: number;
  /** Incrementing this token spins the die in place, like a top. */
  spinToken: number;
  /** Fires whenever the die comes to rest on a different face than before. */
  onSettle: (slot: number) => void;
  onImpact: (strength: number) => void;
  /** Screen-space drag deltas, consumed as pushes against the die. */
  nudgeRef: React.RefObject<{ x: number; y: number } | null>;
  reducedMotion: boolean;
};

function Die({
  rollToken,
  spinToken,
  onSettle,
  onImpact,
  nudgeRef,
  reducedMotion,
}: DieProps) {
  const meshRef = useRef<THREE.Group>(null);

  const geometry = useMemo(
    () => new RoundedBoxGeometry(HALF * 2, HALF * 2, HALF * 2, 5, 0.11),
    [],
  );
  useEffect(() => () => geometry.dispose(), [geometry]);

  const faceTextures = useMemo(
    () =>
      DIE_FACES.map((face) => {
        const layer = LAYERS.find((l) => l.slot === face.slot);
        return {
          ...face,
          // Derived from the title, so the face and the copy cannot disagree.
          map: drawFace(
            (layer?.title ?? '').toUpperCase(),
            layer?.ordinal ?? '',
          ),
        };
      }),
    [],
  );
  useEffect(
    () => () => faceTextures.forEach((f) => f.map.dispose()),
    [faceTextures],
  );

  // World, ground and walls are built once and reused across throws.
  const physics = useMemo(() => {
    const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -34, 0) });
    world.defaultContactMaterial.restitution = 0.22;
    // Grippy on purpose: a low-friction die slides instead of tipping, and a
    // sliding die never changes face.
    world.defaultContactMaterial.friction = 0.55;

    const ground = new CANNON.Body({ mass: 0, shape: new CANNON.Plane() });
    ground.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    world.addBody(ground);

    // Invisible pen so an energetic throw cannot leave the frame. Positions are
    // assigned from the camera below; only the facings are fixed here.
    //
    // A CANNON.Plane's normal is local +Z, and the solid half-space is the side
    // the normal points AWAY from — so each wall's normal must face inward, at
    // the origin. Rotating +Z about Y by θ gives (sinθ, 0, cosθ), which makes
    // the correct yaws: +X wall needs -π/2, -X wall needs +π/2. Getting these
    // backwards silently ejects the die out of frame instead of containing it.
    const yaws = [-Math.PI / 2, Math.PI / 2, Math.PI, 0];
    const walls = yaws.map((yaw) => {
      const wall = new CANNON.Body({ mass: 0, shape: new CANNON.Plane() });
      wall.quaternion.setFromEuler(0, yaw, 0);
      world.addBody(wall);
      return wall;
    });

    const die = new CANNON.Body({
      mass: 1,
      shape: new CANNON.Box(new CANNON.Vec3(HALF, HALF, HALF)),
      linearDamping: 0.08,
      // Low, so an imparted roll survives long enough to actually tumble.
      angularDamping: 0.035,
    });
    world.addBody(die);

    return { world, die, walls };
  }, []);

  // Fit the pen to the ground the camera can actually see, and refit on every
  // resize. The walls then sit just outside the frame instead of boxing the die
  // into a small square in the middle of a much larger view.
  const camera = useThree((state) => state.camera);
  const size = useThree((state) => state.size);
  useEffect(() => {
    const raycaster = new THREE.Raycaster();
    const table = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const groundAt = (x: number, y: number) => {
      raycaster.setFromCamera(new THREE.Vector2(x, y), camera);
      const hit = new THREE.Vector3();
      return raycaster.ray.intersectPlane(table, hit) ? hit : null;
    };

    // Full width, but a bounded depth band rather than the whole visible
    // trapezoid. Two reasons: the ground stretches to the horizon, where a die
    // is tiny and jammed against the top edge, and the copy occupies the lower
    // part of the frame, which the die should not wander behind.
    const left = groundAt(-1, -0.1);
    const right = groundAt(1, -0.1);
    const near = groundAt(0, -0.55);
    const far = groundAt(0, 0.5);
    if (!left || !right || !near || !far) return;

    const margin = HALF + WALL_INSET;
    const halfX = Math.max(
      1.5,
      Math.min(Math.abs(left.x), Math.abs(right.x)) - margin,
    );
    const zNear = near.z - margin;
    const zFar = far.z + margin;

    const [xPos, xNeg, zPos, zNeg] = physics.walls;
    xPos.position.set(halfX, 0, 0);
    xNeg.position.set(-halfX, 0, 0);
    zPos.position.set(0, 0, zNear);
    zNeg.position.set(0, 0, zFar);
  }, [camera, size, physics]);

  // Per-throw bookkeeping, in refs so the physics loop never re-renders.
  const restCount = useRef(0);
  const stepCount = useRef(0);
  const settled = useRef(true);
  /** Last reported face, so a re-settle on the same face stays quiet. */
  const lastSlot = useRef<number | null>(null);

  useEffect(() => {
    const { die } = physics;
    const onCollide = (event: { contact: CANNON.ContactEquation }) => {
      if (settled.current) return;
      const speed = Math.abs(event.contact.getImpactVelocityAlongNormal());
      if (speed > 1.2) onImpact(Math.min(speed / 14, 1));
    };
    die.addEventListener('collide', onCollide);
    // Braces matter: cannon returns the EventTarget, and a bare arrow would
    // hand React a non-void "destructor".
    return () => {
      die.removeEventListener('collide', onCollide);
    };
  }, [physics, onImpact]);

  /** Reads which face currently points most directly at the sky. */
  const readUpFace = () => {
    const q = new THREE.Quaternion(
      physics.die.quaternion.x,
      physics.die.quaternion.y,
      physics.die.quaternion.z,
      physics.die.quaternion.w,
    );
    let best = DIE_FACES[0];
    let bestDot = -Infinity;
    for (const face of DIE_FACES) {
      const dot = face.normal.clone().applyQuaternion(q).y;
      if (dot > bestDot) {
        bestDot = dot;
        best = face;
      }
    }
    return best;
  };

  // Throw on every token change, including the first.
  useEffect(() => {
    const { die } = physics;
    settled.current = false;
    restCount.current = 0;
    stepCount.current = 0;

    if (reducedMotion) {
      // No tumble: place the die flat with a random face up and report it.
      const face = DIE_FACES[Math.floor(Math.random() * DIE_FACES.length)];
      const q = new THREE.Quaternion().setFromUnitVectors(
        face.normal,
        new THREE.Vector3(0, 1, 0),
      );
      die.position.set(0, HALF, 0);
      die.quaternion.set(q.x, q.y, q.z, q.w);
      die.velocity.setZero();
      die.angularVelocity.setZero();
      die.sleep();
      settled.current = true;
      lastSlot.current = face.slot;
      onSettle(face.slot);
      return;
    }

    die.wakeUp();
    // Spawn comfortably inside the pen. Starting on or past a wall puts the die
    // in the wall's solid half-space and it gets shoved out on the first step.
    const sx = (Math.random() - 0.5) * 2.2;
    const sz = 0.6 + Math.random() * 0.7;
    die.position.set(sx, 4.6 + Math.random() * 0.8, sz);
    die.quaternion.setFromEuler(
      Math.random() * Math.PI * 2,
      Math.random() * Math.PI * 2,
      Math.random() * Math.PI * 2,
    );
    die.velocity.set(-sx * 1.1, -3.5, -sz * 1.9);
    die.angularVelocity.set(
      (Math.random() - 0.5) * 26,
      (Math.random() - 0.5) * 26,
      (Math.random() - 0.5) * 26,
    );
  }, [rollToken, physics, reducedMotion, onSettle]);

  // Spin in place. Skips the initial mount so the opening throw is not
  // immediately overwritten.
  const spinMounted = useRef(false);
  useEffect(() => {
    if (!spinMounted.current) {
      spinMounted.current = true;
      return;
    }
    if (reducedMotion) return;
    const { die } = physics;
    die.wakeUp();
    settled.current = false;
    restCount.current = 0;
    stepCount.current = 0;

    // Mostly yaw, so it pirouettes rather than tumbling, plus a little tilt and
    // lift so it wobbles down to a face instead of grinding flat on the spot.
    const direction = Math.random() < 0.5 ? -1 : 1;
    // The tilt is what makes a spin worth doing: a pure yaw keeps the same face
    // up forever, so the die is thrown slightly off-axis and allowed to topple
    // out of the spin the way a real one does.
    die.angularVelocity.set(
      (Math.random() - 0.5) * 13,
      direction * (SPIN_RATE + Math.random() * 6),
      (Math.random() - 0.5) * 13,
    );
    die.velocity.set(0, 2.6, 0);
  }, [spinToken, physics, reducedMotion]);

  useFrame((_, delta) => {
    const { world, die } = physics;
    const group = meshRef.current;
    if (!group) return;
    // Clamped: a backgrounded tab resumes with a huge delta, which would both
    // explode the solver and snap the centring ease straight to its end.
    const dt = Math.min(delta, 0.05);

    // A drag since the last frame becomes a shove against the die.
    const nudge = nudgeRef.current;
    if (nudge && !reducedMotion) {
      nudgeRef.current = null;

      if (settled.current) {
        // The settled die is drawn at its centred position, not at the body's
        // resting position. Move the body under the mesh before waking it, or
        // it visibly snaps back to where it originally landed.
        die.position.set(group.position.x, group.position.y, group.position.z);
        die.velocity.setZero();
        die.angularVelocity.setZero();
        settled.current = false;
        restCount.current = 0;
        stepCount.current = 0;
      }
      die.wakeUp();

      // Screen right maps to world +X; screen down maps to world +Z, since the
      // camera looks along -Z from above.
      const len = Math.hypot(nudge.x, nudge.y);
      if (len > 0.5) {
        // Clamped so a fast flick pushes firmly without launching the die.
        const power = Math.min(len, 42);
        const dirX = nudge.x / len;
        const dirZ = nudge.y / len;

        die.applyImpulse(
          new CANNON.Vec3(
            dirX * power * NUDGE_FORCE,
            0,
            dirZ * power * NUDGE_FORCE,
          ),
          // Above the centre of mass, so the shove leans the die as well.
          new CANNON.Vec3(0, HALF * 0.7, 0),
        );

        // Roll about (up x direction): for a push toward +X that is -Z, which
        // tips the top of the die forward into the direction of travel.
        const spin = power * ROLL_TORQUE;
        die.angularVelocity.x += dirZ * spin;
        die.angularVelocity.z += -dirX * spin;

        const w = die.angularVelocity;
        const wLen = Math.hypot(w.x, w.y, w.z);
        if (wLen > MAX_SPIN) w.scale(MAX_SPIN / wLen, w);
      }
    }

    if (!settled.current) {
      world.step(1 / 60, dt, 4);
      stepCount.current += 1;

      const resting =
        die.velocity.length() < REST_SPEED &&
        die.angularVelocity.length() < REST_SPEED;
      restCount.current = resting ? restCount.current + 1 : 0;

      if (restCount.current >= REST_STEPS || stepCount.current > MAX_STEPS) {
        settled.current = true;
        die.sleep();
        const face = readUpFace();
        // Nudging the die and landing it back on the same face is not new
        // information — keep the copy still rather than re-animating it.
        if (face.slot !== lastSlot.current) {
          lastSlot.current = face.slot;
          onSettle(face.slot);
        }
      }
    }

    // The mesh mirrors the body exactly — position and orientation, always.
    // Nothing recentres, reorients, or otherwise touches the die after it
    // settles; where physics leaves it is where it stays.
    group.position.set(die.position.x, die.position.y, die.position.z);
    group.quaternion.set(
      die.quaternion.x,
      die.quaternion.y,
      die.quaternion.z,
      die.quaternion.w,
    );
  });

  return (
    <group ref={meshRef}>
      <mesh geometry={geometry} castShadow receiveShadow>
        <meshStandardMaterial color="#f4f4f4" roughness={0.34} metalness={0.02} />
      </mesh>
      {faceTextures.map((face) => (
        <mesh
          key={face.slot}
          position={face.normal.clone().multiplyScalar(HALF + 0.001)}
          quaternion={plateQuaternion(face.normal)}
        >
          <planeGeometry args={[HALF * 2 * 0.92, HALF * 2 * 0.92]} />
          <meshStandardMaterial
            map={face.map}
            transparent
            roughness={0.4}
            polygonOffset
            polygonOffsetFactor={-2}
          />
        </mesh>
      ))}
    </group>
  );
}

export type DieSceneProps = {
  rollToken: number;
  spinToken: number;
  onSettle: (slot: number) => void;
  onImpact: (strength: number) => void;
  /** Fires on the first drag, so the page can retire the "drag to roll" hint. */
  onFirstDrag?: () => void;
};

export default function DieScene({
  rollToken,
  spinToken,
  onSettle,
  onImpact,
  onFirstDrag,
}: DieSceneProps) {
  const [mounted, setMounted] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);

  // Drag deltas are handed to the physics loop through a ref rather than state:
  // a pointermove per frame must not re-render the React tree.
  const nudgeRef = useRef<{ x: number; y: number } | null>(null);
  const dragging = useRef(false);
  const last = useRef({ x: 0, y: 0 });
  const dragged = useRef(false);

  const onPointerDown = (e: React.PointerEvent) => {
    dragging.current = true;
    last.current = { x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    const dx = e.clientX - last.current.x;
    const dy = e.clientY - last.current.y;
    last.current = { x: e.clientX, y: e.clientY };
    if (dx === 0 && dy === 0) return;
    if (!dragged.current) {
      dragged.current = true;
      onFirstDrag?.();
    }
    // Accumulate, so several moves inside one frame all land as one shove.
    const pending = nudgeRef.current;
    nudgeRef.current = pending
      ? { x: pending.x + dx, y: pending.y + dy }
      : { x: dx, y: dy };
  };

  const endDrag = (e: React.PointerEvent) => {
    dragging.current = false;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  useEffect(() => {
    setMounted(true);
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(query.matches);
    const onChange = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  if (!mounted) return <div className="h-full w-full" aria-hidden />;

  return (
    <Canvas
      shadows
      // `flat` = NoToneMapping. R3F's default ACES curve rolls the die's white
      // down to grey, which is the one thing a white-die-on-black page cannot
      // afford.
      flat
      // Wide enough that the fitted pen is a genuine arena, close enough that
      // the die still reads as an object rather than a speck.
      camera={{ position: [0, 7.0, 5.6], fov: 44 }}
      dpr={[1, 2]}
      gl={{ antialias: true, alpha: true }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      style={{ cursor: 'grab', touchAction: 'none' }}
      onCreated={({ gl, camera }) => {
        camera.lookAt(0, 0, 0);
        // A lost context otherwise leaves a permanently blank stage.
        gl.domElement.addEventListener('webglcontextlost', (event) => {
          event.preventDefault();
        });
      }}
    >
      <ambientLight intensity={0.5} />
      {/* Key light doubles as the pool of light the die lands in. */}
      <spotLight
        position={[0, 9, 3]}
        angle={0.62}
        penumbra={1}
        intensity={230}
        distance={26}
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-bias={-0.0006}
      />
      <directionalLight position={[-5, 4, -4]} intensity={0.5} />

      {/* Table. Near-black so the lit pool reads, never a visible edge. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[60, 60]} />
        <meshStandardMaterial color="#0b0b0b" roughness={0.95} metalness={0} />
      </mesh>

      <Die
        rollToken={rollToken}
        spinToken={spinToken}
        onSettle={onSettle}
        onImpact={onImpact}
        nudgeRef={nudgeRef}
        reducedMotion={reducedMotion}
      />
    </Canvas>
  );
}
