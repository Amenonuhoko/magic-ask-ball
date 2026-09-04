// --- DOM refs ---

const stageEl = document.getElementById("stage");
const shapeEl = document.getElementById("shape");
const diceCanvasEl = document.getElementById("dice-canvas");
const diceAnswerEl = document.getElementById("dice-answer");
const statusEl = document.getElementById("status");
const enableBtn = document.getElementById("enable-motion");
const modeButtons = document.querySelectorAll(".mode-btn");
const calibrationPanel = document.getElementById("calibration");
const calibrationReadoutEl = document.getElementById("calibration-readout");
const rangeSlider = document.getElementById("range-slider");
const rangeValueEl = document.getElementById("range-value");
const calibrateBtn = document.getElementById("calibrate-btn");
const recenterBtn = document.getElementById("recenter-btn");

function setStatus(text) {
  statusEl.textContent = text;
}

// --- modes ---

const MODE_HINTS = {
  calibrate: "Tilt to see live sensor readings",
  magic: "Shake your phone to roll",
  ball: "Tilt to roll the ball",
};

let mode = "magic"; // "calibrate" | "magic" | "ball"

function setMode(nextMode) {
  mode = nextMode;

  modeButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.mode === nextMode));

  stageEl.hidden = nextMode === "calibrate";
  shapeEl.hidden = nextMode !== "ball";
  diceCanvasEl.hidden = nextMode !== "magic";
  diceAnswerEl.hidden = nextMode !== "magic";
  calibrationPanel.hidden = nextMode !== "calibrate";

  setStatus(MODE_HINTS[nextMode]);

  if (nextMode === "magic") {
    startDiceRendering();
  } else {
    stopDiceRendering();
  }
}

modeButtons.forEach((btn) => {
  btn.addEventListener("click", () => setMode(btn.dataset.mode));
});

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

// Ball/calibration: neutral zero-point and sensitivity (degrees of tilt = full travel).
let ballZeroBeta = 0;
let ballZeroGamma = 0;
let ballRangeDeg = 45;

let calibrating = false;
let calibrationEndAt = 0;
let calibrationMaxBeta = 0;
let calibrationMaxGamma = 0;
let lastReadoutAt = 0;

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
      if (
        mode === "magic" &&
        !rolling &&
        delta > SHAKE_THRESHOLD &&
        performance.now() - lastRollAt > ROLL_COOLDOWN_MS
      ) {
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

function recenterBall() {
  ballZeroBeta = filteredBeta;
  ballZeroGamma = filteredGamma;
}

function updateCalibrationReadout(deltaBeta, deltaGamma) {
  const now = performance.now();
  if (now - lastReadoutAt < 100) return;
  lastReadoutAt = now;
  calibrationReadoutEl.textContent =
    `raw β${rawBeta.toFixed(0)}° γ${rawGamma.toFixed(0)}°\n` +
    `filtered β${filteredBeta.toFixed(0)}° γ${filteredGamma.toFixed(0)}°\n` +
    `Δβ${deltaBeta.toFixed(0)}° Δγ${deltaGamma.toFixed(0)}°  range ${ballRangeDeg}°`;
}

function updateBallMode(deltaBeta, deltaGamma) {
  const clampedGamma = Math.max(-ballRangeDeg, Math.min(ballRangeDeg, deltaGamma));
  const clampedBeta = Math.max(-ballRangeDeg, Math.min(ballRangeDeg, deltaBeta));
  shapeEl.style.left = `${50 + (clampedGamma / ballRangeDeg) * 40}%`;
  shapeEl.style.top = `${50 + (clampedBeta / ballRangeDeg) * 40}%`;
}

function startCalibration() {
  recenterBall();
  calibrationMaxBeta = 0;
  calibrationMaxGamma = 0;
  calibrating = true;
  calibrationEndAt = performance.now() + 3000;
  calibrateBtn.disabled = true;
  calibrateBtn.textContent = "Tilt to every extreme… (3s)";
}

function finishCalibration() {
  calibrating = false;
  calibrateBtn.disabled = false;
  calibrateBtn.textContent = "Calibrate range (tilt to extremes)";
  const measured = Math.round(Math.max(calibrationMaxBeta, calibrationMaxGamma, 10));
  ballRangeDeg = Math.min(measured, Number(rangeSlider.max));
  rangeSlider.value = String(ballRangeDeg);
  rangeValueEl.textContent = `${ballRangeDeg}°`;
}

calibrateBtn.addEventListener("click", startCalibration);
recenterBtn.addEventListener("click", recenterBall);

rangeSlider.addEventListener("input", () => {
  ballRangeDeg = Number(rangeSlider.value);
  rangeValueEl.textContent = `${ballRangeDeg}°`;
});

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

  const deltaBeta = filteredBeta - ballZeroBeta;
  const deltaGamma = filteredGamma - ballZeroGamma;

  if (calibrating) {
    calibrationMaxBeta = Math.max(calibrationMaxBeta, Math.abs(deltaBeta));
    calibrationMaxGamma = Math.max(calibrationMaxGamma, Math.abs(deltaGamma));
    if (now > calibrationEndAt) finishCalibration();
  }

  if (mode === "calibrate") {
    updateCalibrationReadout(deltaBeta, deltaGamma);
  } else if (mode === "ball") {
    updateBallMode(deltaBeta, deltaGamma);
  }
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
        setStatus(motionOk ? MODE_HINTS[mode] : "Gyro/shake permission denied — tilt features only.");
      } else {
        setStatus("Sensor permission denied.");
      }
    });
  } else {
    startListening();
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

const SPIN_DURATION_MS = 900;
const SETTLE_DURATION_MS = 450;

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

function rollDice() {
  if (rolling) return;
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

function diceFrame() {
  diceRafId = requestAnimationFrame(diceFrame);
  updateRoll();
  renderer.render(scene, camera);
}

function startDiceRendering() {
  if (typeof THREE === "undefined") {
    setStatus("Couldn't load the 3D dice library.");
    return;
  }
  if (!renderer) initDiceScene();
  resizeDiceRenderer();
  if (diceRafId === null) diceRafId = requestAnimationFrame(diceFrame);
}

function stopDiceRendering() {
  if (diceRafId !== null) {
    cancelAnimationFrame(diceRafId);
    diceRafId = null;
  }
}

// --- boot ---

setMode("magic");
initOrientation();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
