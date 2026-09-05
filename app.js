// --- DOM refs ---

const stageEl = document.getElementById("stage");
const diceCanvasEl = document.getElementById("dice-canvas");
const diceAnswerEl = document.getElementById("dice-answer");
const statusEl = document.getElementById("status");
const enableBtn = document.getElementById("enable-motion");
const recenterBtn = document.getElementById("recenter-btn");
const viewfinderEl = document.getElementById("viewfinder");
const levelLightEl = document.getElementById("level-light");
const escapeRingFillEl = document.getElementById("escape-ring-fill");
const statusIconPauseEl = document.getElementById("status-icon-pause");
const debugToggleBtn = document.getElementById("debug-toggle");
const debugPanelEl = document.getElementById("debug-panel");
const debugLiveEl = document.getElementById("debug-live");
const debugRecordBtn = document.getElementById("debug-record-btn");
const debugCopyBtn = document.getElementById("debug-copy-btn");
const debugSummaryEl = document.getElementById("debug-summary");

function setStatus(text) {
  statusEl.textContent = text;
}

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
// devicemotion's rotationRate is also used separately (independently of
// this filter) as an accumulating "total rotation" meter to detect a shake
// gesture for dice rolls — see handleMotionEvent.

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
// tilt the phone is currently at. Tightened from 45° so full spin speed is
// reached with a smaller, more responsive tilt.
let tiltZeroBeta = 0;
let tiltZeroGamma = 0;
const TILT_RANGE_DEG = 30;

// Current tilt delta (from zero), refreshed every sensor frame.
let currentDeltaBeta = 0;
let currentDeltaGamma = 0;

// Shake detection for dice rolls, based on TOTAL accumulated rotation
// (gyroscope rotationRate integrated over time) rather than a single sharp
// acceleration spike. This is a decaying "leaky bucket": every devicemotion
// tick adds |βrate|+|γrate| * dt, and the whole total decays by half every
// ROTATION_HALF_LIFE_SEC. That means genuinely shaking back and forth —
// even gently, even if no single tick is a hard jerk — keeps adding to the
// total faster than it drains, and it reliably crosses the threshold;
// stopping lets it drain back down within a couple of seconds.
//
// Two triggers feed off the same accumulator:
//  - INSTANT_SPIKE_RATE_DEG_PER_SEC: a single tick this fast fires
//    immediately, bypassing accumulation entirely — an obviously hard shake
//    shouldn't have to wait on anything.
//  - The accumulator threshold, for everything short of that: LOWER while
//    a roll is already in progress (redirecting is easier once you're
//    already mid-shake than starting cold) than while idle.
//
// Crossing that bar isn't enough on its own, though: the die can only
// actually ROLL (commit to a new result) while the screen is being held
// down (pointerHeld — see the pointerdown/up listeners below and the lock
// icon that reflects this state). A qualifying shake without a hold can't
// roll it — instead it "pulls" the die toward the shake's direction (see
// pullDice/updatePull) as a felt-but-denied cue, with no new result and no
// turning to reveal a face; the die is otherwise left exactly as it was
// (still idle-spinning, or still frozen if it already was).
//
// A shake redirects the die instantly — see rollDice() — so the cooldown
// only needs to be long enough to stop a single continuous shake from
// retriggering many times a second (devicemotion fires ~60Hz), not to
// block deliberate follow-up shakes in a new direction.
const ROTATION_TRIGGER_THRESHOLD_DEG = 45; // total accumulated rotation to START a roll from idle
const ROTATION_REDIRECT_THRESHOLD_DEG = 18; // lower bar to REDIRECT a roll already in progress
const INSTANT_SPIKE_RATE_DEG_PER_SEC = 350; // a single tick this fast triggers immediately, no accumulation needed
// A leaky bucket like this has a hard floor: no matter how long you sustain
// a rotation rate below (threshold * ln2 / half-life), it can NEVER cross
// the threshold — the decay caps its steady-state value below it. At 1.5s
// half-life, the idle-trigger floor is ~21°/s and the redirect floor is
// ~8°/s combined |β|+|γ|, low enough that a genuinely gentle sustained
// back-and-forth still gets there, not just a single hard jerk.
const ROTATION_HALF_LIFE_SEC = 1.5;
let rotationAccumDeg = 0;
let rotationAccumPeakRate = 0; // peak |βrate|+|γrate| seen since the last trigger, drives roll speed
let lastMotionEventAt = null;
const SHAKE_RETRIGGER_COOLDOWN_MS = 150;
let lastRollTriggerAt = 0;

// Auto pause-detection: whenever the phone's own physical motion (not the
// die's spin state, which is driven by held tilt angle rather than actual
// movement) stays below a small angular-speed threshold for a sustained
// stretch, that counts as a "pause" and reveals the current face — this is
// the only way a reveal happens hands-free, and (along with a held-and-
// shaken roll) the only way it happens at all now that a plain tap no
// longer does. Requires genuine movement to have happened first, so it
// can't fire the instant the page loads. Both bounds
// are deliberately generous — natural hand tremor while holding a phone
// "still" is well above 0°/s, and a real intentional pause is worth waiting
// a beat to confirm, so this shouldn't fire on a brief mid-motion lull.
const PAUSE_STILL_THRESHOLD_DEG_PER_SEC = 12; // minimum speed to still count as "moving"
const PAUSE_DURATION_MS = 600; // minimum time held below that speed before it counts as a pause
let stillSinceAt = null;
let hasMovedSincePause = false;
let prevPauseBeta = 0;
let prevPauseGamma = 0;

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
  const now = performance.now();
  const rateValid = !!(rate && rate.beta !== null && rate.gamma !== null);
  const rotSpeed = rateValid ? Math.abs(rate.beta) + Math.abs(rate.gamma) : 0;

  if (rateValid) {
    gyroBeta = rate.beta;
    gyroGamma = rate.gamma;
    hasGyro = true;
    lastGyroAt = now;
  }

  if (lastMotionEventAt !== null) {
    const dt = Math.min((now - lastMotionEventAt) / 1000, 0.2); // clamp for irregular event gaps
    const decay = Math.pow(0.5, dt / ROTATION_HALF_LIFE_SEC);
    rotationAccumDeg *= decay;

    if (rateValid) {
      rotationAccumDeg += rotSpeed * dt;
      rotationAccumPeakRate = Math.max(rotationAccumPeakRate, rotSpeed);
    }

    const cooldownClear = now - lastRollTriggerAt > SHAKE_RETRIGGER_COOLDOWN_MS;
    // Lower bar to redirect a roll already in progress than to start one
    // from idle — you're already mid-shake at that point.
    const activeThreshold = rolling ? ROTATION_REDIRECT_THRESHOLD_DEG : ROTATION_TRIGGER_THRESHOLD_DEG;
    const instantSpike = rotSpeed >= INSTANT_SPIKE_RATE_DEG_PER_SEC;
    const shouldFire = cooldownClear && (instantSpike || rotationAccumDeg > activeThreshold);

    // Snapshot before any reset below, so a recorded sample reflects the
    // accumulator value that actually decided this tick.
    if (debugRecording) {
      recordDebugSample(now, rateValid ? rate.beta : null, rateValid ? rate.gamma : null, rotSpeed, rotationAccumDeg, activeThreshold, shouldFire, instantSpike);
    }
    updateDebugLiveReadout(rotSpeed, rotationAccumDeg);

    if (shouldFire) {
      const peak = Math.max(rotationAccumPeakRate, rotSpeed);
      const beta = rateValid ? rate.beta : undefined;
      const gamma = rateValid ? rate.gamma : undefined;
      // Held: actually roll (no `!rolling` guard — a shake can interrupt
      // and redirect a roll already in progress, not just start a fresh
      // one). Not held: can't roll, so pull instead — but only from a
      // resting state, never on top of a roll/settle animation already
      // playing (that can only have started while held, and finishes on
      // its own regardless of whether the hold is later released).
      if (pointerHeld) {
        rollDice(peak, beta, gamma);
      } else if (!rolling && !settleState) {
        pullDice(peak, beta, gamma);
      }
      lastRollTriggerAt = now;
      rotationAccumDeg = 0;
      rotationAccumPeakRate = 0;
    }
  }
  lastMotionEventAt = now;
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

// Bubble-level style indicator, drawn as a dim light BEHIND the die (see
// #level-light-layer in index.html, positioned before .dice-canvas in the
// DOM) rather than a dot on top of it. It's sized to roughly the die's own
// footprint and centered on it, so at rest the die's opaque render covers
// it completely; tilting shifts it off-center by only a little, letting it
// peek out past the die's edge on the side you're leaning toward while the
// opposite edge stays covered. That keeps the die always fully visible —
// this never draws over it — while still giving a live, subtle sense of
// which way the tilt is going. Centered on frozenZeroBeta/Gamma — the same
// "level" reference the resting-tilt fill uses — so pausing (auto
// pause-detection) recalibrates it right back to dead center behind the
// die. Before the first pause it's centered on physically flat (frozenZero
// starts at 0,0).
const LEVEL_LIGHT_OFFSET_RANGE = 10; // in the 0-100 SVG viewBox; kept small so it stays mostly hidden behind the die

function updateLevelLight() {
  const nx = Math.max(-1, Math.min(1, (filteredGamma - frozenZeroGamma) / TILT_VISUAL_RANGE_DEG));
  const ny = Math.max(-1, Math.min(1, (filteredBeta - frozenZeroBeta) / TILT_VISUAL_RANGE_DEG));
  levelLightEl.setAttribute("cx", String(50 + nx * LEVEL_LIGHT_OFFSET_RANGE));
  levelLightEl.setAttribute("cy", String(50 + ny * LEVEL_LIGHT_OFFSET_RANGE));
}

function updatePauseDetection(now, dt) {
  const gyroFresh = hasGyro && now - lastGyroAt < GYRO_FRESH_WINDOW_MS;
  const deviceSpeed = gyroFresh
    ? Math.hypot(gyroBeta, gyroGamma)
    : Math.hypot(filteredBeta - prevPauseBeta, filteredGamma - prevPauseGamma) / dt;
  prevPauseBeta = filteredBeta;
  prevPauseGamma = filteredGamma;

  if (deviceSpeed > PAUSE_STILL_THRESHOLD_DEG_PER_SEC) {
    stillSinceAt = null;
    hasMovedSincePause = true;
    return;
  }

  if (stillSinceAt === null) stillSinceAt = now;

  // !rolling && !settleState: a shake-triggered roll (or its own settle) is
  // already an active, deliberate action — the phone naturally goes still
  // right after the shake that started it, well within PAUSE_DURATION_MS of
  // the ~1.35s roll+settle animation, so without this guard auto-pause
  // detection would hijack it mid-flight and substitute whatever face
  // happens to be facing the camera at that instant for the real result.
  if (hasMovedSincePause && !frozen && !rolling && !settleState && diceMesh && now - stillSinceAt > PAUSE_DURATION_MS) {
    hasMovedSincePause = false;
    pauseAndReveal();
  }
}

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

  updateLevelLight();
  updatePauseDetection(now, dt);
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
        setStatus(motionOk ? "" : "Gyro/shake permission denied — tilt features only.");
      } else {
        setStatus("Sensor permission denied.");
      }
    });
  } else {
    startListening();
    setStatus("");
  }
}

// --- debug/calibration recorder ---
//
// Captures raw motion samples during real shaking so the shake-trigger
// thresholds above can be tuned against actual data instead of guesses.
// Everything stays local until "Copy data" is tapped, which puts a JSON
// blob (constants + samples) on the clipboard to paste back into chat.

let debugRecording = false;
let debugSamples = [];
let debugRecordStartAt = 0;

function updateDebugLiveReadout(rotSpeed, accum) {
  if (debugPanelEl.hidden) return;
  debugLiveEl.textContent = `rate: ${rotSpeed.toFixed(0)} deg/s\naccum: ${accum.toFixed(0)} deg`;
}

function recordDebugSample(now, beta, gamma, rotSpeed, accum, threshold, triggered, instantSpike) {
  debugSamples.push({
    t: Math.round(now - debugRecordStartAt),
    beta: beta === null ? null : Math.round(beta * 10) / 10,
    gamma: gamma === null ? null : Math.round(gamma * 10) / 10,
    rate: Math.round(rotSpeed * 10) / 10,
    accum: Math.round(accum * 10) / 10,
    threshold,
    triggered,
    instantSpike,
  });
}

function computeDebugSummary(samples) {
  if (samples.length === 0) return "No samples recorded.";
  const rates = samples.map((s) => s.rate);
  const peak = Math.max(...rates);
  const avg = rates.reduce((a, b) => a + b, 0) / rates.length;
  const triggerCount = samples.filter((s) => s.triggered).length;
  const durationSec = (samples[samples.length - 1].t - samples[0].t) / 1000;
  return (
    `${samples.length} samples over ${durationSec.toFixed(1)}s\n` +
    `peak rate: ${peak.toFixed(0)} deg/s, avg: ${avg.toFixed(0)} deg/s\n` +
    `triggers fired: ${triggerCount}`
  );
}

function startDebugRecording() {
  debugRecording = true;
  debugSamples = [];
  debugRecordStartAt = performance.now();
  debugRecordBtn.textContent = "■ Stop";
  debugCopyBtn.hidden = true;
  debugSummaryEl.textContent = "Recording… shake normally, then tap Stop.";
}

function stopDebugRecording() {
  debugRecording = false;
  debugRecordBtn.textContent = "● Record";
  debugCopyBtn.hidden = debugSamples.length === 0;
  debugSummaryEl.textContent = computeDebugSummary(debugSamples);
}

debugToggleBtn.addEventListener("click", () => {
  debugPanelEl.hidden = !debugPanelEl.hidden;
});

debugRecordBtn.addEventListener("click", () => {
  if (debugRecording) {
    stopDebugRecording();
  } else {
    startDebugRecording();
  }
});

debugCopyBtn.addEventListener("click", async () => {
  const payload = JSON.stringify({
    constants: {
      ROTATION_TRIGGER_THRESHOLD_DEG,
      ROTATION_REDIRECT_THRESHOLD_DEG,
      INSTANT_SPIKE_RATE_DEG_PER_SEC,
      ROTATION_HALF_LIFE_SEC,
    },
    samples: debugSamples,
  });
  try {
    await navigator.clipboard.writeText(payload);
    debugSummaryEl.textContent = "Copied to clipboard.";
  } catch {
    debugSummaryEl.textContent = payload;
  }
});

// --- dice (three.js) ---

const OBSIDIAN_COLOR = "#08080b";
const GOLD_COLOR = "#d4af37";

// 20 unique phrases (4 per category: yes / no / leaning-yes / leaning-no /
// inconclusive) — no two faces ever say the same thing.
const OUTCOME_PHRASES = [
  // Yes
  "The stars align in your favor",
  "Without a doubt",
  "Fate says yes",
  "The omens are bright",
  // No
  "The shadows say no",
  "Not a chance",
  "The spirits decline",
  "Firmly no",
  // Maybe yes
  "Signs point to yes",
  "Likely, if you're patient",
  "The odds favor you",
  "Probably — trust your gut",
  // Maybe not
  "Signs point to no",
  "Doubtful, but not impossible",
  "The odds are against you",
  "Probably not — tread carefully",
  // Try again
  "The mists are unclear, ask again",
  "The ball is still thinking",
  "Shake once more",
  "Ask again when the moment is right",
];

// Arranged as a gradient like a traditional d20's success spread: face 1 is
// firmly No, face 20 is firmly Yes, with No -> Maybe not -> Try again ->
// Maybe yes -> Yes moving through the numbers in between.
const FACE_PHRASE_ORDER = [
  4, 5, 6, 7, // 1-4: No
  12, 13, 14, 15, // 5-8: Maybe not
  16, 17, 18, 19, // 9-12: Try again
  8, 9, 10, 11, // 13-16: Maybe yes
  0, 1, 2, 3, // 17-20: Yes
];

const FACES = FACE_PHRASE_ORDER.map((phraseIndex, i) => ({
  number: i + 1,
  phrase: OUTCOME_PHRASES[phraseIndex],
}));

let renderer = null;
let scene = null;
let camera = null;
let diceMesh = null;
let faceNormals = null;
let diceRafId = null;

let rolling = false;
let rollState = null;
let lastDiceFrameAt = null;

const SPIN_DURATION_MS = 900;
const SETTLE_DURATION_MS = 450;

// Idle spin: same tilt-delta/range the ball used, applied as continuous
// angular velocity instead of position — tilting "rolls" the die the same
// direction a rolling ball would move.
const MAX_SPIN_SPEED = Math.PI * 1.5; // radians/sec at full tilt range
const IDLE_SPIN_DEADZONE = 0.01; // ignore sub-noise angular velocity (tightened from 0.02)

// Pausing (the phone going physically still — see updatePauseDetection)
// snaps the die onto whichever face is currently nearest the camera and
// reveals it, then freezes there with a fresh "level" reference. There's no
// tilt threshold that resumes spinning on its own — once it's stopped, it
// stays stopped until a held-and-shaken roll (see rollDice/pointerHeld)
// starts it again. TILT_VISUAL_RANGE_DEG is only a display scale for the
// resting-tilt fill/level light now, not a trigger.
let frozen = false;
let frozenZeroBeta = 0;
let frozenZeroGamma = 0;
let settleState = null;
const TILT_VISUAL_RANGE_DEG = 66;
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

// Every face gets the SAME canonical UV triangle, paired with a texture
// (drawn below) that puts its number in the matching spot — so we don't
// need a real per-face UV unwrap, just a consistent convention the
// geometry and the texture both agree on. Winding is uniform across all 20
// faces (verified separately), so this reads upright on every face.
function assignPerFaceUVs(geometry) {
  const uv = geometry.attributes.uv;
  const corners = [
    [0, 0],
    [1, 0],
    [0.5, 1],
  ];
  for (let face = 0; face < 20; face++) {
    for (let vertex = 0; vertex < 3; vertex++) {
      const i = face * 3 + vertex;
      uv.setXY(i, corners[vertex][0], corners[vertex][1]);
    }
  }
  uv.needsUpdate = true;
}

function makeFaceTexture(number) {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = OBSIDIAN_COLOR;
  ctx.fillRect(0, 0, size, size);

  ctx.fillStyle = GOLD_COLOR;
  ctx.font = "bold 108px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // Sits near the centroid of the canonical UV triangle above (apex at the
  // canvas top, base at the bottom), not the canvas's literal center.
  ctx.fillText(String(number), size / 2, size * 0.66);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

function initDiceScene() {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10);
  camera.position.set(0, 0, 3.2);

  const ambient = new THREE.AmbientLight(0xffffff, 0.35);
  const key = new THREE.DirectionalLight(0xffffff, 1.1);
  key.position.set(2, 3, 4);
  const rim = new THREE.DirectionalLight(0xffffff, 0.5);
  rim.position.set(-3, -1, 2);
  scene.add(ambient, key, rim);

  const geometry = new THREE.IcosahedronGeometry(1, 0);
  geometry.clearGroups();
  for (let i = 0; i < 20; i++) geometry.addGroup(i * 3, 3, i);
  faceNormals = computeFaceNormals(geometry);
  assignPerFaceUVs(geometry);

  const materials = FACES.map(
    (face) =>
      new THREE.MeshPhysicalMaterial({
        map: makeFaceTexture(face.number),
        color: 0xffffff, // texture already carries the final colors; no tint
        roughness: 0.15,
        metalness: 0.15,
        clearcoat: 1,
        clearcoatRoughness: 0.06,
        reflectivity: 1,
      })
  );
  diceMesh = new THREE.Mesh(geometry, materials);

  const edgeLines = new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry),
    new THREE.LineBasicMaterial({ color: 0x000000 })
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

// Fixed axes + scratch quaternions, reused every frame instead of
// allocating fresh THREE objects on this hot 60fps path (idle spin runs
// continuously whenever the die isn't rolling/settling).
const IDLE_SPIN_AXIS_Y = new THREE.Vector3(0, 1, 0);
const IDLE_SPIN_AXIS_X = new THREE.Vector3(1, 0, 0);
const idleSpinScratchQuatY = new THREE.Quaternion();
const idleSpinScratchQuatX = new THREE.Quaternion();

function updateIdleSpin(dt) {
  if (rolling || !diceMesh) return;

  const clampedGamma = Math.max(-TILT_RANGE_DEG, Math.min(TILT_RANGE_DEG, currentDeltaGamma));
  const clampedBeta = Math.max(-TILT_RANGE_DEG, Math.min(TILT_RANGE_DEG, currentDeltaBeta));
  const normGamma = clampedGamma / TILT_RANGE_DEG; // -1..1
  const normBeta = clampedBeta / TILT_RANGE_DEG; // -1..1

  const angVelY = normGamma * MAX_SPIN_SPEED; // left/right tilt -> spin around vertical axis
  const angVelX = normBeta * MAX_SPIN_SPEED; // forward/back tilt -> spin around horizontal axis

  if (Math.abs(angVelX) < IDLE_SPIN_DEADZONE && Math.abs(angVelY) < IDLE_SPIN_DEADZONE) return;

  const qY = idleSpinScratchQuatY.setFromAxisAngle(IDLE_SPIN_AXIS_Y, angVelY * dt);
  const qX = idleSpinScratchQuatX.setFromAxisAngle(IDLE_SPIN_AXIS_X, angVelX * dt);
  // Compose in world space (premultiply) so "tilt right" always spins the
  // same screen-space direction regardless of the die's current orientation.
  diceMesh.quaternion.premultiply(qY).premultiply(qX);
  // Repeated premultiplication accumulates floating-point error over many
  // frames; renormalize every frame so it can't drift off the unit sphere.
  diceMesh.quaternion.normalize();
}

// Purely a visual readout of how far you've tilted since the die came to
// rest — no threshold, tilting never resumes spinning on its own. Only a
// held-and-shaken roll does that.
function updateFrozenFill() {
  const deltaBeta = filteredBeta - frozenZeroBeta;
  const deltaGamma = filteredGamma - frozenZeroGamma;
  const progress = Math.min(Math.hypot(deltaBeta, deltaGamma) / TILT_VISUAL_RANGE_DEG, 1);

  // Fills vertically (bottom to top) rather than sweeping around the
  // circumference: a rect clipped to the circle grows from the bottom.
  const fillHeight = progress * 100;
  escapeRingFillEl.setAttribute("height", String(fillHeight));
  escapeRingFillEl.setAttribute("y", String(100 - fillHeight));
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

// Snaps the die onto whichever face is currently nearest the camera and
// reveals it. Triggered only by the phone going physically still (see
// updatePauseDetection) — a plain tap no longer does this on its own; the
// die can only be committed to a new result by holding the screen down
// while shaking it (see rollDice/pointerHeld).
function pauseAndReveal() {
  if (!diceMesh) return;
  rollState = null;

  // Recalibrate the "level" reference right now, not after the settle
  // animation finishes — the moment you pause is what defines the new
  // resting center, so the level light and escape-threshold fill both reset
  // instantly rather than lagging ~300ms behind the pause.
  frozenZeroBeta = filteredBeta;
  frozenZeroGamma = filteredGamma;
  escapeRingFillEl.setAttribute("height", "0");
  escapeRingFillEl.setAttribute("y", "100");

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
    finishRoll(resultIndex, true); // true: revealed by pauseAndReveal (going still), not a shake-triggered roll
    // The level/escape-threshold reference was already recalibrated back in
    // pauseAndReveal(); just start the "resting" state now that the visual
    // settle has actually finished.
    frozen = true;
  }
}

// The hold surface is the whole screen (not just the die itself), except
// for actual buttons — clicks on those should behave normally and not also
// arm the roll gate. Holding down doesn't reveal or move the die by
// itself; it only determines whether a shake that happens while held can
// actually roll it (see handleMotionEvent) — reflected live by the
// viewfinder's corner brackets (see .is-held in style.css), which double
// as the lock indicator rather than a separate icon.
function isInteractiveElement(target) {
  return target.closest("button, a, input, select, textarea") !== null;
}

let pointerHeld = false;

function setPointerHeld(held) {
  if (pointerHeld === held) return;
  pointerHeld = held;
  viewfinderEl.classList.toggle("is-held", held);
}

document.addEventListener("pointerdown", (event) => {
  if (isInteractiveElement(event.target)) return;
  event.preventDefault();
  setPointerHeld(true);
});

document.addEventListener("pointerup", () => setPointerHeld(false));
document.addEventListener("pointercancel", () => setPointerHeld(false));

// A harder/faster shake spins the die faster: the peak rotation rate seen
// while accumulating toward the trigger maps to how many full turns it
// makes during the fixed spin duration, so the roll visibly moves at "the
// speed of the shake" rather than a constant animation.
const SHAKE_MIN_TURNS = 2;
const SHAKE_MAX_TURNS = 6;
const ROTATION_PEAK_FLOOR_DEG_PER_SEC = 80; // peak rate at/below which turns bottom out at SHAKE_MIN_TURNS
const ROTATION_PEAK_CEILING_DEG_PER_SEC = 500; // peak rate at/above which turns cap out at SHAKE_MAX_TURNS

// Shared by rollDice() (turns) and pullDice() (distance): normalizes a peak
// rotation rate to 0..1 against the same floor/ceiling, clamped at both
// ends, so both scale off one intensity curve instead of two copies of it.
function intensityFromPeakRate(peakRotationRate) {
  const rate = peakRotationRate === undefined ? ROTATION_PEAK_FLOOR_DEG_PER_SEC : peakRotationRate;
  return Math.max(
    0,
    Math.min(1, (rate - ROTATION_PEAK_FLOOR_DEG_PER_SEC) / (ROTATION_PEAK_CEILING_DEG_PER_SEC - ROTATION_PEAK_FLOOR_DEG_PER_SEC))
  );
}

// A shake's direction, not just its magnitude, drives the die: shaking
// left kills whatever spin is already happening and starts a fresh spin
// leftward instantly (no blending old momentum into new — the animation
// always restarts from the die's CURRENT visual orientation), shaking
// right does the same in reverse. Uses the same axis convention as tilt's
// idle spin: rotation rate around the device's beta (X) axis spins the die
// around X, rate around gamma (Y) spins it around Y.
function directionalSpinAxis(betaRate, gammaRate) {
  if (
    betaRate === undefined ||
    gammaRate === undefined ||
    (Math.abs(betaRate) < 1e-6 && Math.abs(gammaRate) < 1e-6)
  ) {
    return new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
  }
  return new THREE.Vector3(betaRate, gammaRate, 0).normalize();
}

function rollDice(peakRotationRate, betaRate, gammaRate) {
  if (!diceMesh) return;
  frozen = false;
  settleState = null; // a shake mid-reveal takes priority; don't let it resume stale later
  rolling = true;
  diceAnswerEl.textContent = "Rolling…";
  statusIconPauseEl.setAttribute("hidden", "");
  escapeRingFillEl.setAttribute("height", "0");
  escapeRingFillEl.setAttribute("y", "100");

  const intensityT = intensityFromPeakRate(peakRotationRate);
  const totalTurns = SHAKE_MIN_TURNS + intensityT * (SHAKE_MAX_TURNS - SHAKE_MIN_TURNS);

  const resultIndex = Math.floor(Math.random() * 20);
  const cameraDir = new THREE.Vector3(0, 0, 1);
  const targetNormal = faceNormals[resultIndex].clone().normalize();
  const settleQuat = new THREE.Quaternion().setFromUnitVectors(targetNormal, cameraDir);
  const spinAroundCam = new THREE.Quaternion().setFromAxisAngle(cameraDir, Math.random() * Math.PI * 2);
  const finalQuat = spinAroundCam.multiply(settleQuat);

  rollState = {
    phase: "spin",
    startAt: performance.now(),
    spinAxis: directionalSpinAxis(betaRate, gammaRate),
    // Current orientation, NOT the previous rollState's spinStartQuat —
    // this is what makes a redirect instant rather than blended.
    spinStartQuat: diceMesh.quaternion.clone(),
    resultIndex,
    finalQuat,
    totalTurns,
  };
}

function updateRoll() {
  if (!rollState) return;
  const now = performance.now();

  if (rollState.phase === "spin") {
    const t = Math.min((now - rollState.startAt) / SPIN_DURATION_MS, 1);
    const eased = easeOutCubic(t);
    const angle = eased * rollState.totalTurns * Math.PI * 2;
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
    // Freeze on the revealed face, same as pauseAndReveal() does — without
    // this, the die had no `frozen` transition at all after a completed
    // roll, so it would immediately resume tilt-driven idle spin off of
    // whatever tilt the phone happened to be at. Recalibrate the "level"
    // reference now too, for the same reason pauseAndReveal() does: so the
    // resting-tilt fill and level light both start from zero instead of
    // measuring drift from a stale, possibly long-past reference.
    frozen = true;
    frozenZeroBeta = filteredBeta;
    frozenZeroGamma = filteredGamma;
  }
}

// A shake that happens while NOT held can't roll the die (see
// handleMotionEvent) — instead it "pulls" the die a short distance toward
// the shake's direction and springs it back, a felt-but-denied cue with no
// rotation and no new result. Purely a position offset (diceMesh.position),
// entirely independent of whatever rotation state (idle spin/frozen/roll)
// is also active, so it layers on top of it without conflict.
const PULL_OUT_DURATION_MS = 160;
const PULL_BACK_DURATION_MS = 320;
const PULL_DISTANCE_MIN = 0.06;
const PULL_DISTANCE_MAX = 0.32;
let pullState = null;

function pullDice(peakRotationRate, betaRate, gammaRate) {
  if (!diceMesh) return;

  const intensityT = intensityFromPeakRate(peakRotationRate);
  const distance = PULL_DISTANCE_MIN + intensityT * (PULL_DISTANCE_MAX - PULL_DISTANCE_MIN);

  // Same axis convention as tilt/shake elsewhere: gamma (left/right) ->
  // screen X, beta (front/back) -> screen Y (inverted, since a positive
  // beta rate is a forward/downward tilt).
  let dirX = 0;
  let dirY = 0;
  if (betaRate !== undefined && gammaRate !== undefined && (Math.abs(betaRate) > 1e-6 || Math.abs(gammaRate) > 1e-6)) {
    const len = Math.hypot(betaRate, gammaRate);
    dirX = gammaRate / len;
    dirY = -betaRate / len;
  }

  pullState = { startAt: performance.now(), dirX, dirY, distance };
}

function updatePull() {
  if (!pullState) return;
  const elapsed = performance.now() - pullState.startAt;

  let progress; // 0 (rest) -> 1 (fully pulled) -> 0 (rest)
  if (elapsed <= PULL_OUT_DURATION_MS) {
    progress = easeOutCubic(elapsed / PULL_OUT_DURATION_MS);
  } else if (elapsed <= PULL_OUT_DURATION_MS + PULL_BACK_DURATION_MS) {
    progress = 1 - easeInOutCubic((elapsed - PULL_OUT_DURATION_MS) / PULL_BACK_DURATION_MS);
  } else {
    diceMesh.position.set(0, 0, 0);
    pullState = null;
    return;
  }

  diceMesh.position.set(pullState.dirX * pullState.distance * progress, pullState.dirY * pullState.distance * progress, 0);
}

// Whether the result was revealed by the phone going still (rather than a
// held-and-shaken roll) is shown as an icon in the viewfinder — a pause
// glyph — instead of text.
function finishRoll(index, revealedByPause) {
  rolling = false;
  diceAnswerEl.textContent = FACES[index].phrase;

  if (revealedByPause) statusIconPauseEl.removeAttribute("hidden");
  else statusIconPauseEl.setAttribute("hidden", "");

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

  // The viewfinder frame itself is always visible; only its color cues
  // whether the die is currently frozen showing a revealed result (a
  // separate concept from the lock icon, which reflects pointerHeld).
  viewfinderEl.classList.toggle("is-frozen", frozen);

  if (rollState) {
    updateRoll();
  } else if (settleState) {
    updateSettle();
  } else if (frozen) {
    updateFrozenFill();
  } else {
    updateIdleSpin(dt);
  }
  updatePull();

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
