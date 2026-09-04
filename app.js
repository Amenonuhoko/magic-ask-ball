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

const shapeEl = document.getElementById("shape");
const infoTextEl = document.getElementById("info-text");
const statusEl = document.getElementById("status");
const enableBtn = document.getElementById("enable-motion");
const modeButtons = document.querySelectorAll(".mode-btn");

const shapesByName = Object.fromEntries(SHAPES.map((s) => [s.name, s]));

let mode = "default"; // "info" | "default" | "ball"
let currentShapeName = null;

function setStatus(text) {
  statusEl.textContent = text;
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

  if (nextMode === "info") {
    shapeEl.classList.add("mode-info");
    infoTextEl.hidden = false;
    infoTextEl.textContent = "Flat";
  } else if (nextMode === "ball") {
    shapeEl.classList.add("mode-ball");
    shapeEl.style.clipPath = shapesByName[FLAT_SHAPE].clipPath;
  } else {
    shapeEl.style.clipPath = shapesByName[FLAT_SHAPE].clipPath;
  }
}

modeButtons.forEach((btn) => {
  btn.addEventListener("click", () => setMode(btn.dataset.mode));
});

// --- orientation detection ---

const FLAT_THRESHOLD = 15; // degrees of tilt below which we call it "flat"
const FLAT_HYSTERESIS = 5; // extra margin to avoid flickering at the edge
const UPDATE_INTERVAL_MS = 120;
const BALL_RANGE_DEG = 45; // tilt needed to roll the ball fully to an edge

// Smoothed readings, low-pass filtered to cut sensor jitter.
let smoothBeta = 0;
let smoothGamma = 0;
let hasReading = false;
let isFlat = true;
let lastUpdateAt = 0;

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

function updateDefaultMode(magnitude, angle, debugSuffix) {
  const name = isFlat
    ? FLAT_SHAPE
    : TILT_SHAPES[Math.floor(((angle + 180) / 360) * TILT_SHAPES.length) % TILT_SHAPES.length];

  if (name !== currentShapeName) applyShape(name);
  setStatus(`Shape: ${name}${debugSuffix}`);
}

function updateInfoMode(beta, gamma, magnitude, debugSuffix) {
  infoTextEl.textContent = directionLabel(beta, gamma, magnitude);
  setStatus(`Orientation${debugSuffix}`);
}

function updateBallMode(beta, gamma, debugSuffix) {
  const clampedGamma = Math.max(-BALL_RANGE_DEG, Math.min(BALL_RANGE_DEG, gamma));
  const clampedBeta = Math.max(-BALL_RANGE_DEG, Math.min(BALL_RANGE_DEG, beta));
  const left = 50 + (clampedGamma / BALL_RANGE_DEG) * 40; // keep within 10%-90%
  const top = 50 + (clampedBeta / BALL_RANGE_DEG) * 40;
  shapeEl.style.left = `${left}%`;
  shapeEl.style.top = `${top}%`;
  setStatus(`Ball rolling${debugSuffix}`);
}

function handleOrientation(event) {
  const { beta, gamma } = event; // beta: front/back tilt, gamma: left/right tilt
  if (beta === null || gamma === null) return;

  const smoothing = 0.2;
  if (!hasReading) {
    smoothBeta = beta;
    smoothGamma = gamma;
    hasReading = true;
  } else {
    smoothBeta += (beta - smoothBeta) * smoothing;
    smoothGamma += (gamma - smoothGamma) * smoothing;
  }

  const now = Date.now();
  if (now - lastUpdateAt < UPDATE_INTERVAL_MS) return;
  lastUpdateAt = now;

  const magnitude = Math.sqrt(smoothBeta * smoothBeta + smoothGamma * smoothGamma);
  const debugSuffix = ` (β${smoothBeta.toFixed(0)}° γ${smoothGamma.toFixed(0)}°)`;

  // Schmitt trigger between flat/tilted so it doesn't flicker right at the boundary.
  if (isFlat) {
    if (magnitude > FLAT_THRESHOLD + FLAT_HYSTERESIS) isFlat = false;
  } else if (magnitude < FLAT_THRESHOLD - FLAT_HYSTERESIS) {
    isFlat = true;
  }

  if (mode === "info") {
    updateInfoMode(smoothBeta, smoothGamma, magnitude, debugSuffix);
  } else if (mode === "ball") {
    updateBallMode(smoothBeta, smoothGamma, debugSuffix);
  } else {
    const angle = Math.atan2(smoothGamma, smoothBeta) * (180 / Math.PI); // -180..180
    updateDefaultMode(magnitude, angle, debugSuffix);
  }
}

function startOrientationListening() {
  window.addEventListener("deviceorientation", handleOrientation);
  setStatus("Listening for tilt…");
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
      try {
        const result = await DeviceOrientationEvent.requestPermission();
        if (result === "granted") {
          enableBtn.hidden = true;
          startOrientationListening();
        } else {
          setStatus("Orientation permission denied.");
        }
      } catch (err) {
        setStatus("Could not request orientation permission.");
      }
    });
  } else {
    startOrientationListening();
  }
}

setMode("default");
initOrientation();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
