import * as THREE from 'three';

// ── Chess piece profiles (LatheGeometry) ──
function kingProfile() {
  return [
    [0, 0], [0.7, 0], [0.75, 0.05], [0.75, 0.15], [0.7, 0.2],
    [0.35, 0.3], [0.3, 0.5], [0.28, 1.0], [0.3, 1.1],
    [0.45, 1.2], [0.5, 1.3], [0.5, 1.35], [0.48, 1.4],
    [0.35, 1.5], [0.5, 1.7], [0.52, 1.85], [0.48, 2.0],
    [0.4, 2.1], [0.35, 2.15], [0.15, 2.2], [0.12, 2.25],
    [0.12, 2.55], [0.08, 2.55], [0.08, 2.4], [0, 2.4],
  ].map(([x, y]) => new THREE.Vector2(x, y));
}

function queenProfile() {
  return [
    [0, 0], [0.65, 0], [0.7, 0.05], [0.7, 0.15], [0.65, 0.2],
    [0.32, 0.3], [0.28, 0.5], [0.26, 1.0], [0.28, 1.1],
    [0.42, 1.2], [0.48, 1.35], [0.45, 1.4], [0.33, 1.5],
    [0.48, 1.7], [0.5, 1.85], [0.46, 2.0], [0.38, 2.1],
    [0.2, 2.2], [0.15, 2.25], [0.2, 2.35], [0.12, 2.45],
    [0, 2.45],
  ].map(([x, y]) => new THREE.Vector2(x, y));
}

function bishopProfile() {
  return [
    [0, 0], [0.55, 0], [0.6, 0.05], [0.6, 0.12], [0.55, 0.18],
    [0.28, 0.28], [0.24, 0.5], [0.22, 0.9], [0.24, 1.0],
    [0.36, 1.1], [0.4, 1.2], [0.38, 1.25], [0.28, 1.35],
    [0.36, 1.55], [0.38, 1.7], [0.32, 1.85], [0.2, 1.95],
    [0.08, 2.05], [0.1, 2.1], [0.06, 2.15], [0, 2.15],
  ].map(([x, y]) => new THREE.Vector2(x, y));
}

function knightProfile() {
  // Knight is approximated with a lathe — not perfect but looks decent
  return [
    [0, 0], [0.55, 0], [0.58, 0.05], [0.58, 0.12], [0.52, 0.18],
    [0.26, 0.28], [0.22, 0.5], [0.2, 0.8], [0.22, 0.9],
    [0.32, 1.0], [0.35, 1.1], [0.3, 1.2], [0.22, 1.3],
    [0.18, 1.5], [0.22, 1.65], [0.18, 1.75], [0.1, 1.8],
    [0, 1.8],
  ].map(([x, y]) => new THREE.Vector2(x, y));
}

function rookProfile() {
  return [
    [0, 0], [0.6, 0], [0.65, 0.05], [0.65, 0.12], [0.6, 0.18],
    [0.3, 0.28], [0.26, 0.5], [0.24, 0.9], [0.26, 1.0],
    [0.28, 1.05], [0.28, 1.3], [0.38, 1.35], [0.42, 1.4],
    [0.42, 1.55], [0.35, 1.55], [0.35, 1.5], [0.3, 1.5],
    [0.3, 1.55], [0, 1.55],
  ].map(([x, y]) => new THREE.Vector2(x, y));
}

function pawnProfile() {
  return [
    [0, 0], [0.48, 0], [0.52, 0.04], [0.52, 0.1], [0.48, 0.15],
    [0.22, 0.25], [0.18, 0.45], [0.17, 0.65], [0.19, 0.75],
    [0.28, 0.82], [0.3, 0.9], [0.28, 0.95], [0.2, 1.02],
    [0.22, 1.1], [0.18, 1.18], [0, 1.18],
  ].map(([x, y]) => new THREE.Vector2(x, y));
}

const PIECES = [
  { profile: kingProfile, scale: 0.38, name: 'king' },
  { profile: queenProfile, scale: 0.36, name: 'queen' },
  { profile: bishopProfile, scale: 0.34, name: 'bishop' },
  { profile: knightProfile, scale: 0.32, name: 'knight' },
  { profile: rookProfile, scale: 0.33, name: 'rook' },
  { profile: pawnProfile, scale: 0.3, name: 'pawn' },
];

export function initHero(canvas) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, canvas.clientWidth / canvas.clientHeight, 0.1, 100);
  camera.position.set(0, 0, 12);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(canvas.clientWidth, canvas.clientHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  // Environment map for reflections
  const envRT = new THREE.WebGLCubeRenderTarget(256);
  const envScene = new THREE.Scene();
  envScene.background = new THREE.Color(0x0a0a0e);
  const el1 = new THREE.PointLight(0x7c9a3e, 4, 30);
  el1.position.set(5, 5, 5); envScene.add(el1);
  const el2 = new THREE.PointLight(0x3355aa, 3, 30);
  el2.position.set(-5, 3, -5); envScene.add(el2);
  const el3 = new THREE.PointLight(0xffffff, 2, 30);
  el3.position.set(0, -5, 5); envScene.add(el3);
  const envCam = new THREE.CubeCamera(0.1, 100, envRT);
  envCam.update(renderer, envScene);

  // Material — glossy dark glass
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xc8c8d0,
    metalness: 0.2,
    roughness: 0.08,
    clearcoat: 1.0,
    clearcoatRoughness: 0.03,
    reflectivity: 1.0,
    envMap: envRT.texture,
    envMapIntensity: 1.8,
  });

  // Spread pieces in an arc/scattered layout
  const pieces = [];
  const positions = [
    { x: -3.5, y: 1.2, z: -1 },
    { x: 2.8, y: 1.8, z: -0.5 },
    { x: -1.5, y: -1.5, z: 0.5 },
    { x: 4.0, y: -0.8, z: -1.5 },
    { x: -4.2, y: -1.0, z: -0.8 },
    { x: 0.8, y: -2.2, z: 0 },
  ];

  PIECES.forEach((def, i) => {
    const geo = new THREE.LatheGeometry(def.profile(), 32);
    const mesh = new THREE.Mesh(geo, mat);
    const s = def.scale;
    mesh.scale.set(s, s, s);
    const pos = positions[i];
    mesh.position.set(pos.x, pos.y, pos.z);
    // Random initial rotation
    mesh.rotation.y = Math.random() * Math.PI * 2;
    mesh.rotation.x = (Math.random() - 0.5) * 0.3;
    mesh.rotation.z = (Math.random() - 0.5) * 0.2;
    mesh.userData = {
      baseX: pos.x, baseY: pos.y, baseZ: pos.z,
      floatPhase: Math.random() * Math.PI * 2,
      floatSpeed: 0.4 + Math.random() * 0.3,
      floatAmp: 0.12 + Math.random() * 0.08,
      rotSpeed: 0.08 + Math.random() * 0.1,
      idx: i,
    };
    scene.add(mesh);
    pieces.push(mesh);
  });

  // Add king cross arms
  const crossGeo = new THREE.BoxGeometry(0.28, 0.08, 0.08);
  const crossMesh = new THREE.Mesh(crossGeo, mat);
  const kingPiece = pieces[0];
  const ks = PIECES[0].scale;
  crossMesh.scale.set(ks, ks, ks);
  scene.add(crossMesh);

  // Lighting
  scene.add(new THREE.AmbientLight(0x404050, 0.5));
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.2);
  keyLight.position.set(3, 5, 6); scene.add(keyLight);
  const accent = new THREE.PointLight(0x7c9a3e, 1.5, 20);
  accent.position.set(-5, 3, 3); scene.add(accent);
  const rim = new THREE.PointLight(0x3355aa, 1.2, 20);
  rim.position.set(3, -2, -5); scene.add(rim);

  // Mouse tracking
  let mouseX = 0, mouseY = 0;
  let targetMouseX = 0, targetMouseY = 0;
  function onMouseMove(e) {
    const rect = canvas.getBoundingClientRect();
    targetMouseX = ((e.clientX - rect.left) / rect.width - 0.5) * 2;
    targetMouseY = -((e.clientY - rect.top) / rect.height - 0.5) * 2;
  }
  canvas.addEventListener('mousemove', onMouseMove);

  // Animation
  let startTime = Date.now();
  let animId;

  function animate() {
    animId = requestAnimationFrame(animate);
    const t = (Date.now() - startTime) / 1000;

    // Smooth mouse lerp
    mouseX += (targetMouseX - mouseX) * 0.05;
    mouseY += (targetMouseY - mouseY) * 0.05;

    pieces.forEach((mesh) => {
      const d = mesh.userData;
      // Floating
      mesh.position.x = d.baseX + Math.sin(t * d.floatSpeed + d.floatPhase) * d.floatAmp * 0.5;
      mesh.position.y = d.baseY + Math.sin(t * d.floatSpeed + d.floatPhase) * d.floatAmp;
      mesh.position.z = d.baseZ + Math.cos(t * d.floatSpeed * 0.7 + d.floatPhase) * d.floatAmp * 0.3;

      // Slow rotation
      mesh.rotation.y += d.rotSpeed * 0.016;

      // React to mouse — subtle tilt toward cursor
      mesh.rotation.x = (Math.random() - 0.5) * 0.01 + mouseY * 0.15;
      mesh.rotation.z = mouseX * 0.08 * (d.idx % 2 === 0 ? 1 : -1);
    });

    // Sync king cross with king piece
    crossMesh.position.copy(kingPiece.position);
    crossMesh.position.y += 2.47 * ks;
    crossMesh.rotation.copy(kingPiece.rotation);

    // Camera subtle parallax from mouse
    camera.position.x = mouseX * 0.4;
    camera.position.y = mouseY * 0.3;
    camera.lookAt(0, 0, 0);

    renderer.render(scene, camera);
  }
  animate();

  function onResize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }
  window.addEventListener('resize', onResize);

  return () => {
    cancelAnimationFrame(animId);
    window.removeEventListener('resize', onResize);
    canvas.removeEventListener('mousemove', onMouseMove);
    renderer.dispose();
  };
}
