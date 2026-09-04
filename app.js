const SHAPES = [
  { name: "circle", clipPath: "circle(50% at 50% 50%)" },
  { name: "square", clipPath: "polygon(0 0, 100% 0, 100% 100%, 0 100%)" },
  { name: "triangle", clipPath: "polygon(50% 0, 100% 100%, 0 100%)" },
  { name: "diamond", clipPath: "polygon(50% 0, 100% 50%, 50% 100%, 0 50%)" },
  {
    name: "pentagon",
    clipPath: "polygon(50% 0%, 100% 38%, 82% 100%, 18% 100%, 0% 38%)",
  },
  {
    name: "hexagon",
    clipPath: "polygon(25% 0, 75% 0, 100% 50%, 75% 100%, 25% 100%, 0 50%)",
  },
  {
    name: "star",
    clipPath:
      "polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%)",
  },
  {
    name: "arrow",
    clipPath: "polygon(0 20%, 60% 20%, 60% 0, 100% 50%, 60% 100%, 60% 80%, 0 80%)",
  },
];

// Shapes triggered by tilting the phone in a given direction (default mode).
// "circle" is reserved for holding the phone flat/level.
const TILT_SHAPES = ["square", "triangle", "diamond", "pentagon", "hexagon", "star", "arrow"];
const FLAT_SHAPE = "circle";

const stageEl = document.getElementById("stage");
const shapeEl = document.getElementById("shape");
const infoTextEl = document.getElementById("info-text");
const statusEl = document.getElementById("status");
const enableBtn = document.getElementById("enable-motion");
const modeButtons = document.querySelectorAll(".mode-btn");
const calibrationPanel = document.getElementById("calibration");
const calibrationReadoutEl = document.getElementById("calibration-readout");
const rangeSlider = document.getElementById("range-slider");
const rangeValueEl = document.getElementById("range-value");
const calibrateBtn = document.getElementById("calibrate-btn");

const shapesByName = Object.fromEntries(SHAPES.map((s) => [s.name, s]));

let mode = "default"; // "info" | "default" | "ball"
let currentShapeName = null;

function setStatus(text) {
  statusEl.textContent = text;
}

// Status/HUD text is throttled independently of position updates below —
// text doesn't need 60fps, the shape/ball position does.
let lastStatusAt = 0;
function throttledStatus(text) {
  const now = performance.now();
  if (now - lastStatusAt < 100) return;
  lastStatusAt = now;
  setStatus(text);
}

function applyShape(name) {
  currentShapeName = name;
  shapeEl.style.clipPath = shapesByName[name].clipPath;
  shapeEl.classList.add("pulse");
  setTimeout(() => shapeEl.classList.remove("pulse"), 200);
}

function setMode(nextMode) {
  mode = nextMode;
  currentShapeName = null;

  modeButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.mode === nextMode));

  shapeEl.classList.remove("mode-info", "mode-ball");
  shapeEl.style.left = "";
  shapeEl.style.top = "";
  infoTextEl.hidden = true;
  calibrationPanel.hidden = nextMode !== "ball";

  if (nextMode === "info") {
    shapeEl.classList.add("mode-info");
    infoTextEl.hidden = false;
    infoTextEl.textContent = "Flat";
  } else if (nextMode === "ball") {
    shapeEl.classList.add("mode-ball");
    shapeEl.style.clipPath = shapesByName[FLAT_SHAPE].clipPath;
    recenterBall();
  } else {
    shapeEl.style.clipPath = shapesByName[FLAT_SHAPE].clipPath;
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

const GYRO_FUSION_ALPHA = 0.96; // weight on the gyro-predicted value vs. raw orientation
const GYRO_FRESH_WINDOW_MS = 300; // ignore stale rotationRate if devicemotion stopped firing
const FALLBACK_TAU = 0.05; // seconds; smoothing time-constant when no gyro is available

const FLAT_THRESHOLD = 15; // degrees of tilt below which we call it "flat"
const FLAT_HYSTERESIS = 5; // extra margin to avoid flickering at the boundary

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

let isFlat = true;
let lastFrameAt = null;

// Ball mode: calibrated neutral point and sensitivity (degrees of tilt = full travel).
let ballZeroBeta = 0;
let ballZeroGamma = 0;
let ballRangeDeg = 45;

let calibrating = false;
let calibrationEndAt = 0;
let calibrationMaxBeta = 0;
let calibrationMaxGamma = 0;
let lastReadoutAt = 0;

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
  if (!rate || rate.beta === null || rate.gamma === null) return;
  gyroBeta = rate.beta;
  gyroGamma = rate.gamma;
  hasGyro = true;
  lastGyroAt = performance.now();
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

function directionLabel(beta, gamma, magnitude) {
  if (magnitude < FLAT_THRESHOLD) return "Flat";
  const parts = [];
  if (Math.abs(beta) > FLAT_THRESHOLD / 2) {
    parts.push(beta > 0 ? "Tilted forward" : "Tilted back");
  }
  if (Math.abs(gamma) > FLAT_THRESHOLD / 2) {
    parts.push(gamma > 0 ? "right" : "left");
  }
  return parts.join(", ") || "Flat";
}

function updateDefaultMode() {
  const name = isFlat
    ? FLAT_SHAPE
    : TILT_SHAPES[
        Math.floor(
          ((Math.atan2(filteredGamma, filteredBeta) * (180 / Math.PI) + 180) / 360) *
            TILT_SHAPES.length
        ) % TILT_SHAPES.length
      ];

  if (name !== currentShapeName) applyShape(name);
  throttledStatus(`Shape: ${name} (β${filteredBeta.toFixed(0)}° γ${filteredGamma.toFixed(0)}°)`);
}

function updateInfoMode(magnitude) {
  infoTextEl.textContent = directionLabel(filteredBeta, filteredGamma, magnitude);
  throttledStatus(`Orientation (β${filteredBeta.toFixed(0)}° γ${filteredGamma.toFixed(0)}°)`);
}

function recenterBall() {
  ballZeroBeta = filteredBeta;
  ballZeroGamma = filteredGamma;
}

function updateBallMode() {
  const deltaBeta = filteredBeta - ballZeroBeta;
  const deltaGamma = filteredGamma - ballZeroGamma;

  if (calibrating) {
    calibrationMaxBeta = Math.max(calibrationMaxBeta, Math.abs(deltaBeta));
    calibrationMaxGamma = Math.max(calibrationMaxGamma, Math.abs(deltaGamma));
    if (performance.now() > calibrationEndAt) finishCalibration();
  }

  const clampedGamma = Math.max(-ballRangeDeg, Math.min(ballRangeDeg, deltaGamma));
  const clampedBeta = Math.max(-ballRangeDeg, Math.min(ballRangeDeg, deltaBeta));
  shapeEl.style.left = `${50 + (clampedGamma / ballRangeDeg) * 40}%`;
  shapeEl.style.top = `${50 + (clampedBeta / ballRangeDeg) * 40}%`;

  throttledStatus("Ball rolling");

  const now = performance.now();
  if (now - lastReadoutAt >= 100) {
    lastReadoutAt = now;
    calibrationReadoutEl.textContent =
      `raw β${rawBeta.toFixed(0)}° γ${rawGamma.toFixed(0)}°  ` +
      `filtered β${filteredBeta.toFixed(0)}° γ${filteredGamma.toFixed(0)}°  ` +
      `Δβ${deltaBeta.toFixed(0)}° Δγ${deltaGamma.toFixed(0)}°  range ${ballRangeDeg}°`;
  }
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
  calibrateBtn.textContent = "Calibrate (tap, then tilt to extremes)";
  const measured = Math.round(Math.max(calibrationMaxBeta, calibrationMaxGamma, 10));
  ballRangeDeg = Math.min(measured, Number(rangeSlider.max));
  rangeSlider.value = String(ballRangeDeg);
  rangeValueEl.textContent = `${ballRangeDeg}°`;
}

calibrateBtn.addEventListener("click", startCalibration);

rangeSlider.addEventListener("input", () => {
  ballRangeDeg = Number(rangeSlider.value);
  rangeValueEl.textContent = `${ballRangeDeg}°`;
});

stageEl.addEventListener("click", () => {
  if (mode === "ball" && !calibrating) recenterBall();
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

  const magnitude = Math.hypot(filteredBeta, filteredGamma);
  if (isFlat) {
    if (magnitude > FLAT_THRESHOLD + FLAT_HYSTERESIS) isFlat = false;
  } else if (magnitude < FLAT_THRESHOLD - FLAT_HYSTERESIS) {
    isFlat = true;
  }

  if (mode === "info") {
    updateInfoMode(magnitude);
  } else if (mode === "ball") {
    updateBallMode();
  } else {
    updateDefaultMode();
  }
}

function startListening() {
  window.addEventListener("deviceorientation", handleOrientationEvent);
  window.addEventListener("devicemotion", handleMotionEvent);
  requestAnimationFrame(frame);
  setStatus("Listening for tilt…");
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
    setStatus("This device doesn't support orientation detection.");
    return;
  }

  // iOS 13+ requires an explicit user gesture to grant sensor access.
  if (typeof DeviceOrientationEvent.requestPermission === "function") {
    enableBtn.hidden = false;
    setStatus("Tap the button to enable orientation detection");
    enableBtn.addEventListener("click", async () => {
      const { orientationOk, motionOk } = await requestSensorPermissions();
      if (orientationOk) {
        enableBtn.hidden = true;
        startListening();
        if (!motionOk) setStatus("Gyro permission denied — using smoothing fallback.");
      } else {
        setStatus("Orientation permission denied.");
      }
    });
  } else {
    startListening();
  }
}

setMode("default");
initOrientation();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
