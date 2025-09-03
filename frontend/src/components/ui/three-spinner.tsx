'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';

interface ThreeSpinnerProps {
  size?: number;
  color?: string;
  className?: string;
}

export function ThreeSpinner({ 
  size = 64,
  color = 'currentColor',
  className = ''
}: ThreeSpinnerProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const frameRef = useRef<number>();
  const [isDarkMode, setIsDarkMode] = useState(false);

  // Function to detect current theme
  const detectTheme = useCallback(() => {
    const darkMode = document.documentElement.classList.contains('dark') || 
                    window.matchMedia('(prefers-color-scheme: dark)').matches;
    setIsDarkMode(darkMode);
    return darkMode;
  }, []);

  // Set up theme change detection
  useEffect(() => {
    // Initial theme detection
    detectTheme();

    // Create a MutationObserver to watch for theme changes
    const observer = new MutationObserver(() => {
      detectTheme();
    });

    // Watch for class changes on document.documentElement
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class']
    });

    // Also listen for system theme changes
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleMediaChange = () => detectTheme();
    mediaQuery.addEventListener('change', handleMediaChange);

    return () => {
      observer.disconnect();
      mediaQuery.removeEventListener('change', handleMediaChange);
    };
  }, [detectTheme]);

  useEffect(() => {
    if (!mountRef.current) return;

    // Scene setup
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer({ 
      alpha: true, 
      antialias: true,
      powerPreference: 'low-power'
    });
    
    renderer.setSize(size, size);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0); // Transparent background
    
    mountRef.current.appendChild(renderer.domElement);

    // Create both simple and complex geometries - we'll blend between them based on speed
    // Complex geometries (visible when slow)
    const complexOuter = new THREE.IcosahedronGeometry(1, 0);
    const complexMiddle = new THREE.DodecahedronGeometry(0.8, 0);
    const complexInner = new THREE.TetrahedronGeometry(0.5, 0);
    
    // Simple geometries (visible when fast)
    const simpleOuter = new THREE.SphereGeometry(1, 8, 6);
    const simpleMiddle = new THREE.SphereGeometry(0.7, 6, 4);

    // Function to get current theme color
    const getThemeColor = () => {
      let threeColor = new THREE.Color(0x000000); // black fallback for light mode
      if (color === 'currentColor') {
        if (isDarkMode) {
          // Use muted foreground color in dark mode
          threeColor = new THREE.Color(0x9ca3af); // gray-400
        } else {
          // Use black in light mode for better visibility and energy
          threeColor = new THREE.Color(0x000000);
        }
      } else {
        try {
          threeColor = new THREE.Color(color);
        } catch {
          // Fallback to theme-appropriate color
          threeColor = new THREE.Color(isDarkMode ? 0x9ca3af : 0x000000);
        }
      }
      return threeColor;
    };

    // Create materials that will have dynamic opacity based on speed
    const complexOuterMaterial = new THREE.MeshBasicMaterial({
      color: getThemeColor(),
      wireframe: true,
      transparent: true,
      opacity: 0.8
    });
    
    const complexMiddleMaterial = new THREE.MeshBasicMaterial({
      color: getThemeColor(),
      wireframe: true,
      transparent: true,
      opacity: 0.6
    });
    
    const complexInnerMaterial = new THREE.MeshBasicMaterial({
      color: getThemeColor(),
      wireframe: true,
      transparent: true,
      opacity: 0.4
    });
    
    const simpleOuterMaterial = new THREE.MeshBasicMaterial({
      color: getThemeColor(),
      wireframe: true,
      transparent: true,
      opacity: 0.0 // Start invisible
    });
    
    const simpleMiddleMaterial = new THREE.MeshBasicMaterial({
      color: getThemeColor(),
      wireframe: true,
      transparent: true,
      opacity: 0.0 // Start invisible
    });

    // Create all meshes
    const complexOuterMesh = new THREE.Mesh(complexOuter, complexOuterMaterial);
    const complexMiddleMesh = new THREE.Mesh(complexMiddle, complexMiddleMaterial);
    const complexInnerMesh = new THREE.Mesh(complexInner, complexInnerMaterial);
    const simpleOuterMesh = new THREE.Mesh(simpleOuter, simpleOuterMaterial);
    const simpleMiddleMesh = new THREE.Mesh(simpleMiddle, simpleMiddleMaterial);

    // Add all meshes to scene
    scene.add(complexOuterMesh);
    scene.add(complexMiddleMesh);
    scene.add(complexInnerMesh);
    scene.add(simpleOuterMesh);
    scene.add(simpleMiddleMesh);

    // Position camera
    camera.position.z = 2.5;

    // Store refs
    sceneRef.current = scene;
    rendererRef.current = renderer;

    // Function to update material colors when theme changes
    const updateMaterialColors = () => {
      const newColor = getThemeColor();
      complexOuterMaterial.color.copy(newColor);
      complexMiddleMaterial.color.copy(newColor);
      complexInnerMaterial.color.copy(newColor);
      simpleOuterMaterial.color.copy(newColor);
      simpleMiddleMaterial.color.copy(newColor);
    };

    // Physics-based spinning animation
    let currentSpeed = 0;
    let targetSpeed = 0.12; // Initial high speed
    let acceleration = 0.002;
    const deceleration = 0.0008;
    let isAccelerating = true;
    let cycleTime = 0;
    const spinDirection = { x: 1, y: 1, z: 0.3 }; // Primary spin axes
    
    const animate = () => {
      cycleTime += 0.016; // ~60fps
      
      // Update material colors based on current theme
      updateMaterialColors();
      
      // Physics-based speed control - energetic spin that slows down then speeds up again
      if (isAccelerating) {
        currentSpeed += acceleration;
        if (currentSpeed >= targetSpeed) {
          isAccelerating = false;
          // Start deceleration after a moment at max speed
          setTimeout(() => {
            targetSpeed = 0.005; // Very slow, almost stopped
          }, 800 + Math.random() * 1200); // Random duration at high speed (0.8-2s)
        }
      } else {
        if (currentSpeed > targetSpeed) {
          currentSpeed = Math.max(currentSpeed - deceleration, targetSpeed);
        }
        
        // When nearly stopped, start new cycle with burst of energy
        if (currentSpeed <= 0.008 && Math.random() < 0.008) { // 0.8% chance per frame when slow
          isAccelerating = true;
          targetSpeed = 0.08 + Math.random() * 0.08; // Randomize next max speed (0.08-0.16)
          acceleration = 0.001 + Math.random() * 0.003; // Randomize acceleration
          // Vary the spin direction slightly for more organic feel
          spinDirection.x = 0.8 + Math.random() * 0.4; // 0.8-1.2
          spinDirection.y = 0.8 + Math.random() * 0.4; // 0.8-1.2
          spinDirection.z = 0.1 + Math.random() * 0.4; // 0.1-0.5
        }
      }
      
      // Dynamic opacity based on speed - higher speed = more simple, lower speed = more complex
      const speedThreshold = 0.05; // Speed above which we start transitioning to simple
      const maxSpeed = 0.15; // Speed at which we're fully simple
      
      // Calculate blend factor (0 = fully complex, 1 = fully simple)
      const blendFactor = Math.min(Math.max((currentSpeed - speedThreshold) / (maxSpeed - speedThreshold), 0), 1);
      
      // Update complex geometry opacity (visible when slow)
      complexOuterMaterial.opacity = (1 - blendFactor) * 0.8;
      complexMiddleMaterial.opacity = (1 - blendFactor) * 0.6;
      complexInnerMaterial.opacity = (1 - blendFactor) * 0.4;
      
      // Update simple geometry opacity (visible when fast)
      simpleOuterMaterial.opacity = blendFactor * 0.7;
      simpleMiddleMaterial.opacity = blendFactor * 0.5;

      // Apply rotation with variable speed and direction to all meshes
      const rotationX = currentSpeed * spinDirection.x;
      const rotationY = currentSpeed * spinDirection.y;
      const rotationZ = currentSpeed * spinDirection.z;
      
      // Complex meshes
      complexOuterMesh.rotation.x += rotationX;
      complexOuterMesh.rotation.y += rotationY;
      complexOuterMesh.rotation.z += rotationZ;
      
      complexMiddleMesh.rotation.x -= currentSpeed * 0.8;
      complexMiddleMesh.rotation.y += currentSpeed * 0.9;
      complexMiddleMesh.rotation.z += currentSpeed * 0.5;
      
      const innerSpeed = currentSpeed * 0.6;
      complexInnerMesh.rotation.x -= innerSpeed * 0.7;
      complexInnerMesh.rotation.y += innerSpeed * 1.2;
      complexInnerMesh.rotation.z -= innerSpeed * 0.4;
      
      // Simple meshes (rotate slightly differently for visual distinction)
      simpleOuterMesh.rotation.x += rotationX * 1.1;
      simpleOuterMesh.rotation.y += rotationY * 1.1;
      simpleOuterMesh.rotation.z += rotationZ * 0.8;
      
      simpleMiddleMesh.rotation.x -= currentSpeed * 0.7;
      simpleMiddleMesh.rotation.y += currentSpeed * 1.1;
      simpleMiddleMesh.rotation.z -= currentSpeed * 0.3;

      renderer.render(scene, camera);
      frameRef.current = requestAnimationFrame(animate);
    };

    animate();

    // Cleanup function
    return () => {
      if (frameRef.current) {
        cancelAnimationFrame(frameRef.current);
      }
      
      if (rendererRef.current) {
        rendererRef.current.dispose();
      }
      
      if (sceneRef.current) {
        // Dispose of all geometries and materials
        sceneRef.current.traverse((object) => {
          if (object instanceof THREE.Mesh) {
            object.geometry.dispose();
            if (Array.isArray(object.material)) {
              object.material.forEach(material => material.dispose());
            } else {
              object.material.dispose();
            }
          }
        });
        
        // Dispose of additional geometries created
        complexOuter.dispose();
        complexMiddle.dispose();
        complexInner.dispose();
        simpleOuter.dispose();
        simpleMiddle.dispose();
        
        // Dispose of materials
        complexOuterMaterial.dispose();
        complexMiddleMaterial.dispose();
        complexInnerMaterial.dispose();
        simpleOuterMaterial.dispose();
        simpleMiddleMaterial.dispose();
      }
      
      if (mountRef.current && renderer.domElement) {
        mountRef.current.removeChild(renderer.domElement);
      }
    };
  }, [size, color, isDarkMode]); // Added isDarkMode to dependencies

  return (
    <div 
      ref={mountRef} 
      className={className}
      style={{ 
        width: size, 
        height: size,
        display: 'inline-block'
      }} 
    />
  );
} 