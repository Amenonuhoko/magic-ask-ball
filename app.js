// --- DOM refs ---

const stageEl = document.getElementById("stage");
const diceCanvasEl = document.getElementById("dice-canvas");
const diceAnswerEl = document.getElementById("dice-answer");
const statusEl = document.getElementById("status");
const enableBtn = document.getElementById("enable-motion");
const recenterBtn = document.getElementById("recenter-btn");

function setStatus(text) {
  statusEl.textContent = text;
}

const IDLE_HINT = "Tilt to spin, shake to roll, hold to stop";
setStatus("Loading…");

// --- sensor pipeline ---
//
// deviceorientation gives an absolute angle but only fires ~a few dozen
// times/sec and is itself internally filtered by the OS, which reads as
// laggy. devicemotion's rotationRate (gyroscope, deg/s) is near-instant but
// drifts if integrated alone. We fuse them every animation frame with a
// complementary filter: integrate the gyro for immediate response, then
// continuously pull the result back toward the absolute orientation reading
// so it can't drift. If no gyro is available we fall back to a tight,
// frame-rate-independent low-pass filter directly on the raw orientation.
//
// devicemotion's accelerationIncludingGravity is used separately (and
// independently of this filter) to detect a shake gesture for dice rolls.

const GYRO_FUSION_ALPHA = 0.96; // weight on the gyro-predicted value vs. raw orientation
const GYRO_FRESH_WINDOW_MS = 300; // ignore stale rotationRate if devicemotion stopped firing
const FALLBACK_TAU = 0.05; // seconds; smoothing time-constant when no gyro is available

let rawBeta = 0;
let rawGamma = 0;
let hasOrientation = false;

let gyroBeta = 0;
let gyroGamma = 0;
let hasGyro = false;
let lastGyroAt = 0;

let filteredBeta = 0;
let filteredGamma = 0;
let filterInitialized = false;

let lastFrameAt = null;

// Neutral zero-point and sensitivity (degrees of tilt = full spin speed),
// used by the die's idle spin. Recenter sets the zero-point to whatever
// tilt the phone is currently at.
let tiltZeroBeta = 0;
let tiltZeroGamma = 0;
const TILT_RANGE_DEG = 45;

// Current tilt delta (from zero), refreshed every sensor frame.
let currentDeltaBeta = 0;
let currentDeltaGamma = 0;

// Shake detection for dice rolls.
let prevAccelX = 0;
let prevAccelY = 0;
let prevAccelZ = 0;
let hasPrevAccel = false;
const SHAKE_THRESHOLD = 16; // sum of abs deltas across x/y/z, in m/s^2
const ROLL_COOLDOWN_MS = 600;

function handleOrientationEvent(event) {
  if (event.beta === null || event.gamma === null) return;
  rawBeta = event.beta;
  rawGamma = event.gamma;
  if (!filterInitialized) {
    filteredBeta = rawBeta;
    filteredGamma = rawGamma;
    filterInitialized = true;
  }
  hasOrientation = true;
}

function handleMotionEvent(event) {
  const rate = event.rotationRate;
  if (rate && rate.beta !== null && rate.gamma !== null) {
    gyroBeta = rate.beta;
    gyroGamma = rate.gamma;
    hasGyro = true;
    lastGyroAt = performance.now();
  }

  const acc = event.accelerationIncludingGravity;
  if (acc && acc.x !== null) {
    if (hasPrevAccel) {
      const delta = Math.abs(acc.x - prevAccelX) + Math.abs(acc.y - prevAccelY) + Math.abs(acc.z - prevAccelZ);
      if (!rolling && delta > SHAKE_THRESHOLD && performance.now() - lastRollAt > ROLL_COOLDOWN_MS) {
        rollDice();
      }
    }
    prevAccelX = acc.x;
    prevAccelY = acc.y;
    prevAccelZ = acc.z;
    hasPrevAccel = true;
  }
}

function stepFilter(dt) {
  const gyroFresh = hasGyro && performance.now() - lastGyroAt < GYRO_FRESH_WINDOW_MS;

  if (gyroFresh) {
    const predictedBeta = filteredBeta + gyroBeta * dt;
    const predictedGamma = filteredGamma + gyroGamma * dt;
    filteredBeta = GYRO_FUSION_ALPHA * predictedBeta + (1 - GYRO_FUSION_ALPHA) * rawBeta;
    filteredGamma = GYRO_FUSION_ALPHA * predictedGamma + (1 - GYRO_FUSION_ALPHA) * rawGamma;
  } else {
    const k = 1 - Math.exp(-dt / FALLBACK_TAU);
    filteredBeta += (rawBeta - filteredBeta) * k;
    filteredGamma += (rawGamma - filteredGamma) * k;
  }
}

function recenterTilt() {
  tiltZeroBeta = filteredBeta;
  tiltZeroGamma = filteredGamma;
}

recenterBtn.addEventListener("click", recenterTilt);

function frame(now) {
  requestAnimationFrame(frame);
  if (!hasOrientation) return;

  if (lastFrameAt === null) {
    lastFrameAt = now;
    return;
  }
  const dt = Math.min((now - lastFrameAt) / 1000, 0.1); // clamp for tab-switch pauses
  lastFrameAt = now;

  stepFilter(dt);

  currentDeltaBeta = filteredBeta - tiltZeroBeta;
  currentDeltaGamma = filteredGamma - tiltZeroGamma;
}

function startListening() {
  window.addEventListener("deviceorientation", handleOrientationEvent);
  window.addEventListener("devicemotion", handleMotionEvent);
  requestAnimationFrame(frame);
}

async function requestSensorPermissions() {
  let orientationOk = true;
  let motionOk = true;

  if (typeof DeviceOrientationEvent.requestPermission === "function") {
    try {
      orientationOk = (await DeviceOrientationEvent.requestPermission()) === "granted";
    } catch {
      orientationOk = false;
    }
  }

  if (typeof DeviceMotionEvent !== "undefined" && typeof DeviceMotionEvent.requestPermission === "function") {
    try {
      motionOk = (await DeviceMotionEvent.requestPermission()) === "granted";
    } catch {
      motionOk = false;
    }
  }

  return { orientationOk, motionOk };
}

function initOrientation() {
  if (typeof DeviceOrientationEvent === "undefined") {
    setStatus("This device doesn't support motion/orientation sensors.");
    return;
  }

  // iOS 13+ requires an explicit user gesture to grant sensor access.
  if (typeof DeviceOrientationEvent.requestPermission === "function") {
    enableBtn.hidden = false;
    setStatus("Tap the button to enable sensors");
    enableBtn.addEventListener("click", async () => {
      const { orientationOk, motionOk } = await requestSensorPermissions();
      if (orientationOk) {
        enableBtn.hidden = true;
        startListening();
        setStatus(motionOk ? IDLE_HINT : "Gyro/shake permission denied — tilt features only.");
      } else {
        setStatus("Sensor permission denied.");
      }
    });
  } else {
    startListening();
    setStatus(IDLE_HINT);
  }
}

// --- dice (three.js) ---

const OUTCOMES = [
  { label: "YES", color: 0x34d399 },
  { label: "NO", color: 0xff5c5c },
  { label: "MAYBE YES", color: 0xfacc15 },
  { label: "MAYBE NOT", color: 0xfb923c },
  { label: "TRY AGAIN", color: 0x8b93a6 },
];

// 20 faces, 4 of each outcome, order shuffled so it's not grouped 5-by-5.
const FACE_OUTCOME_INDEX = [0, 2, 4, 1, 3, 1, 4, 0, 3, 2, 3, 0, 2, 4, 1, 4, 1, 3, 2, 0];
const FACES = FACE_OUTCOME_INDEX.map((outcomeIndex, i) => ({
  number: i + 1,
  ...OUTCOMES[outcomeIndex],
}));

let renderer = null;
let scene = null;
let camera = null;
let diceMesh = null;
let faceNormals = null;
let diceRafId = null;

let rolling = false;
let lastRollAt = 0;
let rollState = null;
let lastDiceFrameAt = null;

const SPIN_DURATION_MS = 900;
const SETTLE_DURATION_MS = 450;

// Idle spin: same tilt-delta/range the ball used, applied as continuous
// angular velocity instead of position — tilting "rolls" the die the same
// direction a rolling ball would move.
const MAX_SPIN_SPEED = Math.PI * 1.5; // radians/sec at full tilt range
const IDLE_SPIN_DEADZONE = 0.02; // ignore sub-noise angular velocity

// Tap-and-hold: freezes the die at whatever orientation it's currently in
// and captures the phone's current tilt as a dedicated "level" reference —
// independent of the Recenter zero-point used for idle spin. While frozen,
// tilting away from that captured reference past a threshold breaks the
// freeze and resumes spinning (still held or not). Releasing always snaps
// the die onto whichever face is currently nearest the camera, then
// re-freezes with a fresh reference captured at that moment — so a further
// tilt past the threshold resumes spinning again from there too.
let frozen = false;
let frozenZeroBeta = 0;
let frozenZeroGamma = 0;
let settleState = null;
const HOLD_ESCAPE_THRESHOLD_DEG = 22;
const RELEASE_SETTLE_DURATION_MS = 300;

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function computeFaceNormals(geometry) {
  const pos = geometry.attributes.position;
  const normals = [];
  const vA = new THREE.Vector3();
  const vB = new THREE.Vector3();
  const vC = new THREE.Vector3();
  const cb = new THREE.Vector3();
  const ab = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 3) {
    vA.fromBufferAttribute(pos, i);
    vB.fromBufferAttribute(pos, i + 1);
    vC.fromBufferAttribute(pos, i + 2);
    cb.subVectors(vC, vB);
    ab.subVectors(vA, vB);
    cb.cross(ab).normalize();
    normals.push(cb.clone());
  }
  return normals;
}

function initDiceScene() {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10);
  camera.position.set(0, 0, 3.2);

  const ambient = new THREE.AmbientLight(0xffffff, 0.6);
  const key = new THREE.DirectionalLight(0xffffff, 0.8);
  key.position.set(2, 3, 4);
  scene.add(ambient, key);

  const geometry = new THREE.IcosahedronGeometry(1, 0);
  geometry.clearGroups();
  for (let i = 0; i < 20; i++) geometry.addGroup(i * 3, 3, i);
  faceNormals = computeFaceNormals(geometry);

  const materials = FACES.map(
    (face) => new THREE.MeshStandardMaterial({ color: face.color, roughness: 0.55, metalness: 0.05 })
  );
  diceMesh = new THREE.Mesh(geometry, materials);

  const edgeLines = new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry),
    new THREE.LineBasicMaterial({ color: 0x0b0d12 })
  );
  diceMesh.add(edgeLines);

  scene.add(diceMesh);

  renderer = new THREE.WebGLRenderer({ canvas: diceCanvasEl, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  resizeDiceRenderer();
}

function resizeDiceRenderer() {
  if (!renderer) return;
  const rect = stageEl.getBoundingClientRect();
  const size = Math.max(1, Math.min(rect.width, rect.height));
  renderer.setSize(size, size, false);
  camera.aspect = 1;
  camera.updateProjectionMatrix();
}

window.addEventListener("resize", resizeDiceRenderer);

function updateIdleSpin(dt) {
  if (rolling || !diceMesh) return;

  const clampedGamma = Math.max(-TILT_RANGE_DEG, Math.min(TILT_RANGE_DEG, currentDeltaGamma));
  const clampedBeta = Math.max(-TILT_RANGE_DEG, Math.min(TILT_RANGE_DEG, currentDeltaBeta));
  const normGamma = clampedGamma / TILT_RANGE_DEG; // -1..1
  const normBeta = clampedBeta / TILT_RANGE_DEG; // -1..1

  const angVelY = normGamma * MAX_SPIN_SPEED; // left/right tilt -> spin around vertical axis
  const angVelX = normBeta * MAX_SPIN_SPEED; // forward/back tilt -> spin around horizontal axis

  if (Math.abs(angVelX) < IDLE_SPIN_DEADZONE && Math.abs(angVelY) < IDLE_SPIN_DEADZONE) return;

  const qY = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), angVelY * dt);
  const qX = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), angVelX * dt);
  // Compose in world space (premultiply) so "tilt right" always spins the
  // same screen-space direction regardless of the die's current orientation.
  diceMesh.quaternion.premultiply(qY).premultiply(qX);
  // Repeated premultiplication accumulates floating-point error over many
  // frames; renormalize every frame so it can't drift off the unit sphere.
  diceMesh.quaternion.normalize();
}

function checkFrozenEscape() {
  const deltaBeta = filteredBeta - frozenZeroBeta;
  const deltaGamma = filteredGamma - frozenZeroGamma;
  if (Math.hypot(deltaBeta, deltaGamma) > HOLD_ESCAPE_THRESHOLD_DEG) {
    frozen = false;
  }
}

function findNearestFaceIndex() {
  const cameraDir = new THREE.Vector3(0, 0, 1);
  let bestIndex = 0;
  let bestDot = -Infinity;
  for (let i = 0; i < faceNormals.length; i++) {
    const worldNormal = faceNormals[i].clone().applyQuaternion(diceMesh.quaternion);
    const dot = worldNormal.dot(cameraDir);
    if (dot > bestDot) {
      bestDot = dot;
      bestIndex = i;
    }
  }
  return bestIndex;
}

function freezeDice() {
  if (!diceMesh) return;
  rollState = null;
  settleState = null;
  rolling = false;
  frozen = true;
  frozenZeroBeta = filteredBeta;
  frozenZeroGamma = filteredGamma;
}

function releaseDice() {
  if (!diceMesh) return;
  frozen = false;
  rollState = null;

  const nearestIndex = findNearestFaceIndex();
  const cameraDir = new THREE.Vector3(0, 0, 1);
  const targetNormalLocal = faceNormals[nearestIndex].clone().normalize();
  // setFromUnitVectors(local, camera) alone would compute a fresh
  // "canonical" orientation from scratch, discarding whatever roll the die
  // currently has — since that target vector doesn't depend on currentQuat,
  // the result can differ from the current orientation by a large, jarring
  // twist even though the chosen face was already nearly camera-facing.
  // Instead, correct just the small residual misalignment on top of the
  // current orientation, so the snap is minimal and preserves roll.
  const currentQuat = diceMesh.quaternion.clone();
  const currentWorldNormal = targetNormalLocal.clone().applyQuaternion(currentQuat);
  const correctionQuat = new THREE.Quaternion().setFromUnitVectors(currentWorldNormal, cameraDir);
  const finalQuat = correctionQuat.multiply(currentQuat);

  settleState = {
    startAt: performance.now(),
    fromQuat: diceMesh.quaternion.clone(),
    finalQuat,
    resultIndex: nearestIndex,
  };
}

function updateSettle() {
  if (!settleState) return;
  const now = performance.now();
  const t = Math.min((now - settleState.startAt) / RELEASE_SETTLE_DURATION_MS, 1);
  const eased = easeInOutCubic(t);
  diceMesh.quaternion.copy(settleState.fromQuat).slerp(settleState.finalQuat, eased);

  if (t >= 1) {
    const resultIndex = settleState.resultIndex;
    settleState = null;
    finishRoll(resultIndex);
    // Re-freeze with a fresh reference so a further tilt past the
    // threshold resumes spinning again from this resting position.
    frozen = true;
    frozenZeroBeta = filteredBeta;
    frozenZeroGamma = filteredGamma;
  }
}

// The tap-and-hold surface is the whole screen (not just the die itself),
// except for actual buttons — clicks on those should behave normally and
// not also freeze/release the die.
function isInteractiveElement(target) {
  return target.closest("button, a, input, select, textarea") !== null;
}

document.addEventListener("pointerdown", (event) => {
  if (!diceMesh || isInteractiveElement(event.target)) return;
  event.preventDefault();
  try {
    document.documentElement.setPointerCapture(event.pointerId);
  } catch {
    // ignore — pointer capture is a nicety, not required for correctness
  }
  freezeDice();
});

document.addEventListener("pointerup", (event) => {
  if (!diceMesh || isInteractiveElement(event.target)) return;
  releaseDice();
});

document.addEventListener("pointercancel", (event) => {
  if (!diceMesh || isInteractiveElement(event.target)) return;
  releaseDice();
});

function rollDice() {
  if (rolling || !diceMesh) return;
  frozen = false;
  settleState = null; // a shake mid-release-settle takes priority; don't let it resume stale later
  rolling = true;
  diceAnswerEl.textContent = "Rolling…";
  diceAnswerEl.style.color = "";

  const resultIndex = Math.floor(Math.random() * 20);
  const cameraDir = new THREE.Vector3(0, 0, 1);
  const targetNormal = faceNormals[resultIndex].clone().normalize();
  const settleQuat = new THREE.Quaternion().setFromUnitVectors(targetNormal, cameraDir);
  const spinAroundCam = new THREE.Quaternion().setFromAxisAngle(cameraDir, Math.random() * Math.PI * 2);
  const finalQuat = spinAroundCam.multiply(settleQuat);

  const spinAxis = new THREE.Vector3(
    Math.random() - 0.5,
    Math.random() - 0.5,
    Math.random() - 0.5
  ).normalize();

  rollState = {
    phase: "spin",
    startAt: performance.now(),
    spinAxis,
    spinStartQuat: diceMesh.quaternion.clone(),
    resultIndex,
    finalQuat,
  };
}

function updateRoll() {
  if (!rollState) return;
  const now = performance.now();

  if (rollState.phase === "spin") {
    const t = Math.min((now - rollState.startAt) / SPIN_DURATION_MS, 1);
    const eased = easeOutCubic(t);
    const totalTurns = 3.5;
    const angle = eased * totalTurns * Math.PI * 2;
    const q = new THREE.Quaternion().setFromAxisAngle(rollState.spinAxis, angle);
    diceMesh.quaternion.copy(rollState.spinStartQuat).premultiply(q);

    if (t >= 1) {
      rollState.phase = "settle";
      rollState.settleStartAt = now;
      rollState.settleFromQuat = diceMesh.quaternion.clone();
    }
    return;
  }

  const t = Math.min((now - rollState.settleStartAt) / SETTLE_DURATION_MS, 1);
  const eased = easeInOutCubic(t);
  diceMesh.quaternion.copy(rollState.settleFromQuat).slerp(rollState.finalQuat, eased);

  if (t >= 1) {
    finishRoll(rollState.resultIndex);
    rollState = null;
  }
}

function finishRoll(index) {
  rolling = false;
  lastRollAt = performance.now();
  const face = FACES[index];
  diceAnswerEl.textContent = face.label;
  diceAnswerEl.style.color = `#${face.color.toString(16).padStart(6, "0")}`;
  if (navigator.vibrate) {
    try {
      navigator.vibrate([30, 40, 30]);
    } catch {
      // ignore
    }
  }
}

function diceFrame(now) {
  diceRafId = requestAnimationFrame(diceFrame);

  if (lastDiceFrameAt === null) {
    lastDiceFrameAt = now;
  }
  const dt = Math.min((now - lastDiceFrameAt) / 1000, 0.1); // clamp for tab-switch pauses
  lastDiceFrameAt = now;

  if (rollState) {
    updateRoll();
  } else if (settleState) {
    updateSettle();
  } else if (frozen) {
    checkFrozenEscape();
  } else {
    updateIdleSpin(dt);
  }

  renderer.render(scene, camera);
}

function startDiceRendering() {
  if (typeof THREE === "undefined") {
    setStatus("Couldn't load the 3D dice library.");
    return;
  }
  try {
    initDiceScene();
  } catch (err) {
    setStatus("This device/browser can't render 3D (no WebGL).");
    return;
  }
  lastDiceFrameAt = null;
  diceRafId = requestAnimationFrame(diceFrame);
}

// --- boot ---

startDiceRendering();
initOrientation();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
