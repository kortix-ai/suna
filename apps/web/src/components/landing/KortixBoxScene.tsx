'use client';

import { useRef, useEffect, useState, Suspense, MutableRefObject, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { useGLTF, Environment, ContactShadows, Float } from '@react-three/drei';
import * as THREE from 'three';

interface KortixBoxModelProps {
  progressRef: MutableRefObject<number>;
  isOn: boolean;
  setIsOn: (isOn: boolean) => void;
}

function useGlowTexture() {
  return useMemo(() => {
    if (typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const context = canvas.getContext('2d');
    if (!context) return null;

    const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
    gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
    gradient.addColorStop(0.2, 'rgba(74, 222, 128, 0.8)');
    gradient.addColorStop(0.5, 'rgba(74, 222, 128, 0.2)');
    gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');

    context.fillStyle = gradient;
    context.fillRect(0, 0, 64, 64);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }, []);
}

function KortixBoxModel({ progressRef, isOn, setIsOn }: KortixBoxModelProps) {
  const groupRef = useRef<THREE.Group>(null!);
  const innerRef = useRef<THREE.Group>(null!);
  const { scene } = useGLTF('/models/kortix_box.glb');
  const [ready, setReady] = useState(false);
  const [hovered, setHovered] = useState(false);
  const ledMatRef = useRef<THREE.MeshStandardMaterial>(null!);
  const glowTexture = useGlowTexture();

  useEffect(() => {
    if (!scene) return;

    const box = new THREE.Box3().setFromObject(scene);
    const size = new THREE.Vector3();
    box.getSize(size);
    const scaleFactor = 2.5 / Math.max(size.x, size.y, size.z);

    if (innerRef.current) {
      innerRef.current.scale.setScalar(scaleFactor);
      const center = new THREE.Vector3();
      box.getCenter(center);
      innerRef.current.position.set(
        -center.x * scaleFactor,
        -center.y * scaleFactor,
        -center.z * scaleFactor,
      );
    }

    scene.traverse((child) => {
      if (child instanceof THREE.Mesh && child.material) {
        child.castShadow = true;
        child.receiveShadow = true;

        if (child.name.toLowerCase().includes('led')) {
          const ledMat = new THREE.MeshStandardMaterial({
            color: '#000000',
            emissive: '#4ade80',
            emissiveIntensity: 0,
            toneMapped: false,
            transparent: true,
            opacity: 1,
            roughness: 0.2,
            metalness: 0
          });
          child.material = ledMat;
          ledMatRef.current = ledMat;

          // Add Point Light for environment illumination
          const existingLight = child.getObjectByName('led_real_light');
          if (!existingLight) {
            const light = new THREE.PointLight('#4ade80', 0, 0.5);
            light.name = 'led_real_light';
            light.position.set(0, 0, 0.02); // Slightly in front
            child.add(light);
          }

          // Add Sprite for "Bloom" glow
          const existingGlow = child.getObjectByName('led_glow_sprite');
          if (!existingGlow && glowTexture) {
            const spriteMat = new THREE.SpriteMaterial({
              map: glowTexture,
              transparent: true,
              opacity: 0,
              blending: THREE.AdditiveBlending,
              depthWrite: false,
              toneMapped: false
            });
            const sprite = new THREE.Sprite(spriteMat);
            sprite.name = 'led_glow_sprite';
            sprite.scale.set(0.15, 0.15, 1);
            sprite.position.set(0, 0, 0.015);
            child.add(sprite);
          }

        } else {
          const original = child.material as THREE.MeshStandardMaterial;
          const mat = new THREE.MeshPhysicalMaterial({
            color: new THREE.Color('#050505'),
            metalness: 0.5,
            roughness: 0.7,
            clearcoat: 0,
            reflectivity: 0.1,
            envMapIntensity: 0.8,
          });

          if (original.normalMap) {
            mat.normalMap = original.normalMap;
            mat.normalScale = original.normalScale.clone();
          }
          if (original.aoMap) {
            mat.aoMap = original.aoMap;
            mat.aoMapIntensity = original.aoMapIntensity;
          }
          child.material = mat;
        }
      }
    });

    setReady(true);
  }, [scene, glowTexture]);

  // Global mouse tracking
  const mouseRef = useRef({ x: 0, y: 0 });
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      mouseRef.current = {
        x: (e.clientX / window.innerWidth) * 2 - 1,
        y: -(e.clientY / window.innerHeight) * 2 + 1,
      };
    };
    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, []);

  useFrame((state, delta) => {
    if (!groupRef.current || !ready) return;

    const t = progressRef.current;
    if (!isOn && t > 0.01) {
      setIsOn(true);
    } else if (isOn && t < 0.01) {
      setIsOn(false);
    }

    if (ledMatRef.current) {
      const targetIntensity = isOn ? 4.0 : 0;

      ledMatRef.current.emissiveIntensity = THREE.MathUtils.lerp(
        ledMatRef.current.emissiveIntensity,
        targetIntensity,
        delta * 5
      );

      const ledMesh = scene.getObjectByName('led_real_light')?.parent;
      if (ledMesh) {
        const light = ledMesh.getObjectByName('led_real_light') as THREE.PointLight;
        if (light) {
          light.intensity = THREE.MathUtils.lerp(light.intensity, isOn ? 2.5 : 0, delta * 5);
        }

        const sprite = ledMesh.getObjectByName('led_glow_sprite') as THREE.Sprite;
        if (sprite) {
          sprite.material.opacity = THREE.MathUtils.lerp(sprite.material.opacity, isOn ? 1.0 : 0, delta * 5);
          const pulse = 1 + Math.sin(state.clock.elapsedTime * 3) * 0.05;
          sprite.scale.set(0.15 * pulse, 0.15 * pulse, 1);
        }
      }
    }

    // Start front-on (LED visible), tilt to reveal top (Kortix engraving) on scroll
    const scrollRX = t * 0.55;
    const scrollRY = t * 1.8;
    const scrollY = -t * 0.5;

    const mouseX = mouseRef.current.x;
    const mouseY = mouseRef.current.y;

    const tRX = scrollRX - mouseY * 0.05;
    const tRY = scrollRY + mouseX * 0.05;

    const pos = groupRef.current.position;
    const rot = groupRef.current.rotation;

    const damp = (current: number, target: number, lambda: number) =>
      THREE.MathUtils.damp(current, target, lambda, delta);

    pos.y = damp(pos.y, scrollY, 4);
    rot.x = damp(rot.x, tRX, 2.5);
    rot.y = damp(rot.y, tRY, 2.5);
  });

  useEffect(() => {
    document.body.style.cursor = hovered ? 'pointer' : 'auto';
    return () => { document.body.style.cursor = 'auto'; };
  }, [hovered]);

  return (
    <group ref={groupRef} scale={1.2} visible={ready}>
      <group
        ref={innerRef}
        onPointerOver={() => setHovered(true)}
        onPointerOut={() => setHovered(false)}
        onClick={() => setIsOn(!isOn)}
      >
        <primitive object={scene} />
      </group>
    </group>
  );
}

function CinematicLights({ progressRef, isOn }: { progressRef: MutableRefObject<number>, isOn: boolean }) {
  const keyRef = useRef<THREE.SpotLight>(null!);
  const rimRef = useRef<THREE.SpotLight>(null!);
  const fillRef = useRef<THREE.PointLight>(null!);

  useFrame((_, delta) => {
    const t = progressRef.current;
    const fade = Math.max(0, 1 - t * 2.0);
    const damp = (current: number, target: number, lambda: number) =>
      THREE.MathUtils.damp(current, target, lambda, delta);

    if (keyRef.current) {
      const keyX = 5 - t * 2;
      const keyZ = 5 + t * 2;
      keyRef.current.position.x = damp(keyRef.current.position.x, keyX, 2);
      keyRef.current.position.z = damp(keyRef.current.position.z, keyZ, 2);

      const targetInt = isOn ? 2 : 5;
      keyRef.current.intensity = damp(keyRef.current.intensity, targetInt * fade, 2);
    }
    if (rimRef.current) {
      const rimX = -5 + t * 15;
      const rimZ = -5 - Math.sin(t * Math.PI) * 2;
      rimRef.current.position.x = damp(rimRef.current.position.x, rimX, 2);
      rimRef.current.position.z = damp(rimRef.current.position.z, rimZ, 2);

      const rimBase = 10 + Math.max(0, Math.sin(t * Math.PI * 1.5)) * 20;
      const targetInt = isOn ? rimBase * 0.6 : rimBase;
      rimRef.current.intensity = damp(rimRef.current.intensity, targetInt * fade, 5);
    }
    if (fillRef.current) {
      fillRef.current.intensity = damp(fillRef.current.intensity, 0.5 * fade, 5);
    }
  });

  return (
    <>
      <ambientLight intensity={0.1} color="#1a1a2e" />
      <spotLight
        ref={keyRef}
        position={[5, 8, 5]}
        intensity={5}
        angle={0.5}
        penumbra={1}
        castShadow
        shadow-bias={-0.0001}
        color="#e0e0ff"
      />
      <spotLight
        ref={rimRef}
        position={[-5, 5, -5]}
        intensity={10}
        angle={0.5}
        penumbra={1}
        color="#ffecd0"
      />
      <pointLight ref={fillRef} position={[0, -2, 2]} intensity={0.5} color="#4a4a6a" distance={10} />
    </>
  );
}

interface MacMiniSceneProps {
  scrollProgressRef: MutableRefObject<number>;
  isOn: boolean;
  setIsOn: (isOn: boolean) => void;
}

export default function MacMiniScene({ scrollProgressRef, isOn, setIsOn }: MacMiniSceneProps) {
  return (
    <div className="absolute inset-0 pointer-events-auto">
      <Canvas
        shadows
        camera={{ position: [0, 1, 6], fov: 35 }}
        gl={{
          antialias: true,
          alpha: true,
          powerPreference: 'high-performance',
          toneMapping: THREE.ACESFilmicToneMapping,
          toneMappingExposure: 1.2,
        }}
        dpr={[1, 2]}
        style={{ background: 'transparent' }}
      >
        <CinematicLights progressRef={scrollProgressRef} isOn={isOn} />
        <Suspense fallback={null}>
          <KortixBoxModel progressRef={scrollProgressRef} isOn={isOn} setIsOn={setIsOn} />
          <ContactShadows
            position={[0, -1.5, 0]}
            opacity={0.4}
            scale={10}
            blur={2.5}
            far={4}
            color="#000000"
          />
          <Environment preset="city" background={false} blur={1} />
        </Suspense>
      </Canvas>
    </div>
  );
}

useGLTF.preload('/models/kortix_box.glb');
