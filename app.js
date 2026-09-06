// --- DOM refs ---

const stageEl = document.getElementById("stage");
const diceCanvasEl = document.getElementById("dice-canvas");
const diceAnswerEl = document.getElementById("dice-answer");
const statusEl = document.getElementById("status");
const enableBtn = document.getElementById("enable-motion");
const recenterBtn = document.getElementById("recenter-btn");
const viewfinderEl = document.getElementById("viewfinder");
const sigilLayerEl = document.getElementById("sigil-layer");
const levelLightEl = document.getElementById("level-light");
const escapeRingFillEl = document.getElementById("escape-ring-fill");
const statusIconPauseEl = document.getElementById("status-icon-pause");
const settingsToggleBtn = document.getElementById("settings-toggle");
const settingsPanelEl = document.getElementById("settings-panel");
const debugLiveEl = document.getElementById("debug-live");
const debugRecordBtn = document.getElementById("debug-record-btn");
const debugCopyBtn = document.getElementById("debug-copy-btn");
const debugSummaryEl = document.getElementById("debug-summary");
const frameLiveEl = document.getElementById("frame-live");
const frameRecordBtn = document.getElementById("frame-record-btn");
const frameCopyBtn = document.getElementById("frame-copy-btn");
const frameSummaryEl = document.getElementById("frame-summary");

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
// (mid-look-around, or still frozen if it already was).
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

// Auto pause-detection: whenever the phone's own physical motion stays
// below a small angular-speed threshold for a sustained stretch, that
// counts as a "pause" and reveals the current face — this is the only way
// a reveal happens hands-free, and (along with a held-and-shaken roll) the
// only way it happens at all now that a plain tap no longer does. Requires
// genuine movement to have happened first, so it can't fire the instant
// the page loads. The speed bound is deliberately generous — natural hand
// tremor while holding a phone "still" is well above 0°/s.
//
// The die's own look-around rotation (see updateTiltLook()) is driven
// directly by the PHONE's own rotation rate now, not by absolute tilt
// angle, so "the phone's rotation rate is below threshold" and "the die
// isn't currently turning" are the same fact by construction -- no second
// die-specific speed check is needed here the way there used to be (idle
// spin previously ran off absolute tilt and could keep spinning even while
// the phone read as perfectly still; see git history / test-pause-face-
// lock.js for that bug). A finger actively dragging the die to look around
// also counts as "still busy, not presenting a result" even on the rare
// setup where the phone itself isn't moving (e.g. resting on a stand).
//
// Settling into a lock naturally needs a minimum time, so the required
// stillness duration is a soft 3s baseline rather than a hair-trigger --
// but it also adapts: every time stillness is broken mid-attempt (you
// started going still, then moved again before it confirmed), that's a
// sign you're still fidgeting into position, so the bar for NEXT time
// goes up by half a second, capped at 5s. A clean, decisive settle always
// just needs the 3s baseline; only repeated false starts make it more
// patient. Resets back to the baseline once a pause actually fires.
const PAUSE_STILL_THRESHOLD_DEG_PER_SEC = 12; // minimum speed to still count as "moving"
const PAUSE_DURATION_BASE_MS = 3000;
const PAUSE_DURATION_STEP_MS = 500;
const PAUSE_DURATION_MAX_MS = 5000;
let pauseDurationMs = PAUSE_DURATION_BASE_MS;
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

// accumulate=false (used by the drag-look pointermove listener) skips
// adding this sample into the sustained leaky-bucket accumulator below --
// see the call site for why: a real device shake is naturally an
// oscillating back-and-forth burst the bucket is built to catch, but a
// deliberate, sustained, ONE-directional drag to look around every side of
// the die can otherwise accumulate the exact same total over a few
// seconds and accidentally launch a roll. Instant-spike detection (an
// unmistakably hard flick in a single tick) still applies either way --
// that's the intended way a hard drag launches a roll.
function handleMotionEvent(event, accumulate = true) {
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

    if (rateValid && accumulate) {
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

// Now that tilt/drag can freely rotate the die to look around every side
// (see updateTiltLook()/applyDragLook()) with no auto-snap-back, there's no
// longer a fixed "zero" to return to on its own -- so Recenter is
// repurposed from "recalibrate the tilt sensor's zero-point" to "jump back
// to the last settled result" (restQuaternion, updated in finishRoll()),
// giving you a quick way back after looking around.
function recenterView() {
  if (!diceMesh) return;
  diceMesh.quaternion.copy(restQuaternion);
  forceRenderPending = true; // mutates the scene from outside diceFrame()'s own dirty tracking
}

recenterBtn.addEventListener("click", recenterView);

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

  // A finger actively dragging the die to look around it counts as "not
  // presenting a result yet" too, even if the phone itself happens to be
  // perfectly still (e.g. propped on a stand) -- see the pointermove
  // listener, which drives the same freeform look-around rotation.
  if (deviceSpeed > PAUSE_STILL_THRESHOLD_DEG_PER_SEC || pointerHeld) {
    if (stillSinceAt !== null) {
      // Broke an in-progress stillness attempt before it confirmed — ask
      // for a little more patience next time.
      pauseDurationMs = Math.min(pauseDurationMs + PAUSE_DURATION_STEP_MS, PAUSE_DURATION_MAX_MS);
    }
    stillSinceAt = null;
    hasMovedSincePause = true;
    return;
  }

  if (stillSinceAt === null) stillSinceAt = now;

  // !rolling && !settleState: a shake-triggered roll (or its own settle) is
  // already an active, deliberate action — the phone naturally goes still
  // right after the shake that started it, comfortably within
  // pauseDurationMs (3-5s) of the ~1.35s roll+settle animation, so without
  // this guard auto-pause detection would hijack it mid-flight and
  // substitute whatever face happens to be facing the camera at that
  // instant for the real result.
  if (hasMovedSincePause && !frozen && !rolling && !settleState && diceMesh && now - stillSinceAt > pauseDurationMs) {
    hasMovedSincePause = false;
    pauseDurationMs = PAUSE_DURATION_BASE_MS; // settled cleanly -- reset the patience meter
    // Also clear stillSinceAt: otherwise the next movement (e.g. picking
    // the phone back up right after seeing the result) would see a
    // non-null stillSinceAt left over from THIS already-successful attempt
    // and wrongly read it as "broke an in-progress attempt", escalating
    // the duration for no reason.
    stillSinceAt = null;
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
  if (settingsPanelEl.hidden) return;
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

settingsToggleBtn.addEventListener("click", () => {
  settingsPanelEl.hidden = !settingsPanelEl.hidden;
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

// --- frame-timing recorder ---
//
// Same reasoning as the shake-calibration recorder above, aimed at the
// die's animation instead of the shake gesture: captures real per-frame
// timing and rotation data during a roll/look-around session so "is this
// smooth" becomes a number to check (dropped-frame-sized gaps between
// frames, per-frame rotation size) instead of an eyeballed guess. Stays
// local until "Copy data" is tapped, same as the shake recorder.

let frameRecording = false;
let frameSamples = [];
let frameRecordStartAt = 0;
let prevRecordedQuat = null;

function updateFrameLiveReadout(dt, angleDeltaDeg) {
  if (settingsPanelEl.hidden) return;
  const fps = dt > 0 ? 1 / dt : 0;
  frameLiveEl.textContent = `fps: ${fps.toFixed(0)}\nΔ°/frame: ${angleDeltaDeg.toFixed(2)}`;
}

// A frame-to-frame gap much larger than even a slow-but-steady 30fps frame
// (33ms) is a real stall/dropped frame, not just a low-but-consistent
// frame rate -- this is the number that actually answers "was there jank".
const FRAME_STALL_THRESHOLD_MS = 50;

function recordFrameSample(now, dt, stateLabel) {
  const angleDeltaDeg = prevRecordedQuat && diceMesh ? prevRecordedQuat.angleTo(diceMesh.quaternion) * (180 / Math.PI) : 0;
  if (diceMesh) prevRecordedQuat = diceMesh.quaternion.clone();
  const dtMs = dt * 1000;
  frameSamples.push({
    t: Math.round(now - frameRecordStartAt),
    dtMs: Math.round(dtMs * 10) / 10,
    state: stateLabel,
    angleDeltaDeg: Math.round(angleDeltaDeg * 100) / 100,
  });
  updateFrameLiveReadout(dt, angleDeltaDeg);
}

function computeFrameSummary(samples) {
  if (samples.length === 0) return "No samples recorded.";
  const dts = samples.map((s) => s.dtMs);
  const avgDt = dts.reduce((a, b) => a + b, 0) / dts.length;
  const maxDt = Math.max(...dts);
  const avgFps = avgDt > 0 ? 1000 / avgDt : 0;
  const durationSec = (samples[samples.length - 1].t - samples[0].t) / 1000;
  const stalls = samples.filter((s) => s.dtMs > FRAME_STALL_THRESHOLD_MS);
  return (
    `${samples.length} samples over ${durationSec.toFixed(1)}s\n` +
    `avg fps: ${avgFps.toFixed(0)}, worst frame gap: ${maxDt.toFixed(0)}ms\n` +
    `stalls (>${FRAME_STALL_THRESHOLD_MS}ms gap): ${stalls.length}`
  );
}

function startFrameRecording() {
  frameRecording = true;
  frameSamples = [];
  frameRecordStartAt = performance.now();
  prevRecordedQuat = diceMesh ? diceMesh.quaternion.clone() : null;
  frameRecordBtn.textContent = "■ Stop";
  frameCopyBtn.hidden = true;
  frameSummaryEl.textContent = "Recording… roll, tilt, and let it settle a few times, then tap Stop.";
}

function stopFrameRecording() {
  frameRecording = false;
  frameRecordBtn.textContent = "● Record";
  frameCopyBtn.hidden = frameSamples.length === 0;
  frameSummaryEl.textContent = computeFrameSummary(frameSamples);
}

frameRecordBtn.addEventListener("click", () => {
  if (frameRecording) {
    stopFrameRecording();
  } else {
    startFrameRecording();
  }
});

frameCopyBtn.addEventListener("click", async () => {
  const payload = JSON.stringify({
    constants: { FRAME_STALL_THRESHOLD_MS },
    samples: frameSamples,
  });
  try {
    await navigator.clipboard.writeText(payload);
    frameSummaryEl.textContent = "Copied to clipboard.";
  } catch {
    frameSummaryEl.textContent = payload;
  }
});

// --- dice (three.js) ---

const OBSIDIAN_COLOR = "#08080b";
const GOLD_COLOR = "#d4af37";

// 20 unique phrases (4 per category: yes / no / leaning-yes / leaning-no /
// inconclusive) — no two faces ever say the same thing. Deliberately plain
// and decisive rather than atmospheric: at most 3 words each, reading as a
// precise verdict (this is the decision that passes) rather than mystical
// flavor text. Yes and No are each their own internal gradient too,
// matching FACE_PHRASE_ORDER below: index 0 (face 17, right at the
// Maybe-yes border) is the plainest "Yes" and index 3 (face 20, the far
// edge of the whole spread) is the single most grandiose verdict on the
// die, "Resoundingly yes"; index 4 (face 1, the far edge) is its mirror,
// "Resoundingly no", and index 7 (face 4, right at the Maybe-not border)
// softens to a plain "No". So the strongest wording always sits at the two
// extreme edges of the d20, easing toward plain/bare as you approach the
// Maybe middle. The Maybe bands use the same weakest-to-strongest
// confidence ladder (Leans/Likely/Probably/Almost certainly) on both
// sides, mirrored, so "how sure" reads consistently whichever direction
// it's leaning.
const OUTCOME_PHRASES = [
  // Yes: plain -> most grandiose
  "Yes",
  "Clearly yes",
  "Strongly yes",
  "Resoundingly yes",
  // No: most grandiose -> plain
  "Resoundingly no",
  "Strongly no",
  "Clearly no",
  "No",
  // Maybe yes: leaning -> almost certain
  "Leans yes",
  "Likely yes",
  "Probably yes",
  "Almost certainly yes",
  // Maybe not: almost certain -> leaning
  "Almost certainly no",
  "Probably no",
  "Likely no",
  "Leans no",
  // Try again
  "Inconclusive",
  "Ask again",
  "Try again",
  "Roll again",
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

// Which physical triangle (by index -- matching faceNormals/materials/
// geometry group order) shows which printed number. A real d20 puts 1 and
// 20 on opposite faces on purpose, so the two most extreme outcomes are as
// far apart as possible; THREE.IcosahedronGeometry's own triangle order
// has no such consideration. Left as "number: i + 1", measuring the real
// geometry shows the fallout: two GEOMETRICALLY ADJACENT faces could carry
// numbers up to 14 apart (e.g. faces 17 and 20, both "Yes" outcomes, end
// up 138.19deg apart -- nearly opposite -- while faces 12 and 13, meant to
// feel different, are the closest possible pair at 41.81deg). A die nudged
// just off one face onto a geometric neighbor could land on a face that
// feels totally different, not similar.
//
// Fixed by treating this as a graph-bandwidth-minimization problem: every
// face borders exactly 3 others (the adjacency graph is 3-regular), and we
// want every one of those ~30 edges to connect two numbers that are close
// together, not just consecutive numbers along one path. A breadth-first
// layering from a fixed starting face (Cuthill-McKee-style: number each
// face in the order a BFS from one face visits it) keeps geometric
// neighbors numerically close throughout, cutting the worst-case gap
// across ANY adjacent pair from 14 down to 6 -- and, as a bonus of the
// graph's symmetry, still lands faces 1 and 20 on exact geometric
// opposites (180deg apart), same as a real d20. Computed once offline
// against the real geometry (see test-face-numbering.js for the
// derivation and proof); this is just the resulting permutation.
const TRIANGLE_TO_FACE_NUMBER = [
  1, 2, 5, 7, 3, 6, 4, 8, 13, 11, 15, 16, 19, 20, 18, 9, 10, 14, 17, 12,
];

const FACES = TRIANGLE_TO_FACE_NUMBER.map((number) => ({
  number,
  phrase: OUTCOME_PHRASES[FACE_PHRASE_ORDER[number - 1]],
}));

let renderer = null;
let scene = null;
let camera = null;
let diceMesh = null;
let faceNormals = null;
let faceUpVectors = null;
let diceRafId = null;

// Render-skip-at-rest: diceFrame() runs requestAnimationFrame continuously
// no matter what (cheap -- it's the only way to promptly notice a shake or
// tilt starting a new animation), but the actual GPU draw call
// (renderer.render()) is skipped on any frame where nothing in the scene
// actually changed -- frozen showing a result, or "held-still" mid-pause,
// or look-around sitting in its deadzone with the phone/finger steady.
// Continuous rendering at 60fps costs real battery on a device that might
// otherwise sit at rest for a long time (viewing a result, or just left idle).
// Starts true so the very first frame always renders once a scene exists;
// resizeDiceRenderer() also sets it, since a resize needs a fresh frame
// even when nothing else changed.
let forceRenderPending = true;

let rolling = false;
let rollState = null;
let lastDiceFrameAt = null;

const SPIN_DURATION_MS = 900;
const SETTLE_DURATION_MS = 650; // softened: was 450, paired with a gentler easing curve below

// Tilt-look: rotating the phone turns the die 1:1, like slowly spinning it
// in your hand to look at every side -- holding a tilt (even a steep one)
// holds that view, rather than the old idle spin's continuous velocity
// (which kept spinning for as long as you held ANY non-zero tilt). Driven
// directly by the phone's OWN rotation rate (see updateTiltLook()), not by
// how far from level it's held, so it's a direct position-follow rather
// than a speed control.
const TILT_LOOK_DEADZONE_DEG_PER_SEC = 2; // ignores sensor noise while the phone is genuinely still

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

// The last settled result's orientation, updated in finishRoll(). Tilt and
// drag can freely rotate the die to look around every side with no auto-
// snap-back (see updateTiltLook()/applyDragLook()), so this is what the
// Recenter button jumps back to. Starts at identity -- before any result
// has ever been shown, there's nothing else meaningful to recenter to.
const restQuaternion = new THREE.Quaternion();
let settleState = null;
const TILT_VISUAL_RANGE_DEG = 66;
const RELEASE_SETTLE_DURATION_MS = 300;

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// Same ease-in/ease-out shape as easeInOutCubic but flatter at both ends
// and steeper through the middle — starts and finishes even more gently.
// Used for the roll's final settle onto the chosen face: the spin phase
// right before it ends at essentially zero angular velocity (easeOutCubic
// approaching t=1), so starting the settle at zero velocity too (rather
// than a curve like easeOutQuart, which is fastest at its own t=0) avoids
// a velocity discontinuity between the two phases — and the equally soft
// tail means it drifts to rest at the end instead of stopping abruptly.
function easeInOutQuart(t) {
  return t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2;
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

// The "up" direction of each face's printed number, in local (object)
// space — used to correct the die's twist around the camera axis once it
// locks, so the number reads upright instead of landing at whatever angle
// the settle happened to leave it at. Per the canonical UV triangle in
// assignPerFaceUVs (vertex 0/1 = the base, vertex 2 = the apex, which maps
// to the top of the printed texture), "up" points from the base's midpoint
// toward the apex vertex. That vector already lies in the face's own
// plane (all three points are face vertices), so orthogonalizing against
// the normal below is just a numerical-safety normalization, not a real
// correction.
function computeFaceUpVectors(geometry, normals) {
  const pos = geometry.attributes.position;
  const ups = [];
  const vA = new THREE.Vector3();
  const vB = new THREE.Vector3();
  const vC = new THREE.Vector3();
  const base = new THREE.Vector3();
  const up = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 3) {
    const face = i / 3;
    vA.fromBufferAttribute(pos, i);
    vB.fromBufferAttribute(pos, i + 1);
    vC.fromBufferAttribute(pos, i + 2);
    base.addVectors(vA, vB).multiplyScalar(0.5);
    up.subVectors(vC, base);
    const normal = normals[face];
    up.addScaledVector(normal, -up.dot(normal));
    up.normalize();
    ups.push(up.clone());
  }
  return ups;
}

// After aligning some local vector to the camera direction via alignQuat,
// computes the additional twist AROUND that camera axis needed to make
// localUp (once carried along by alignQuat) point toward screen-up —
// i.e., the rotation that makes a locked face's number read upright
// rather than sideways/upside-down. Applying the result on top of
// alignQuat (as `twist.multiply(alignQuat)`) preserves the original
// alignment exactly, since rotating a vector around itself leaves it
// unchanged: cameraDir stays mapped to cameraDir.
function uprightTwist(localUp, alignQuat, cameraDir) {
  const worldUp = localUp.clone().applyQuaternion(alignQuat);
  const angle = Math.PI / 2 - Math.atan2(worldUp.y, worldUp.x);
  return new THREE.Quaternion().setFromAxisAngle(cameraDir, angle);
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

// Only ONE face can ever be twisted upright at a time (see uprightTwist());
// every other visible face is necessarily shown at whatever arbitrary
// rotation its own position happens to leave it at -- normal for any
// polyhedral die, but it means a digit's shape has to survive being seen
// at any angle, not just upright. Two real per-digit ambiguities showed up
// under rotation (caught by screenshotting real faces, see
// scratchpad/crop-11.png from that investigation):
//   - "1" in this font carries a diagonal serif flag that, rotated away
//     from upright, reads as the diagonal stroke of a "7" -- so a rotated
//     "11" could be misread as "17"/"71", right next to a genuine "17".
//   - "6" and "9" are literal rotational mirrors of each other in any
//     font, and both are real face numbers on this die -- the exact
//     problem physical dice solve with an underline under one or both.
// Fixed the same way: "1" is hand-drawn as a plain vertical bar (a bare
// stroke has no diagonal to misread, at any rotation) instead of the
// font's glyph, and "6"/"9" get a short underline. Every other digit is
// unambiguous under rotation and still uses the font as-is.
const DIGIT_FONT_SIZE = 108;
const ONE_BAR_WIDTH = DIGIT_FONT_SIZE * 0.16;
const SIX_NINE_UNDERLINE_HEIGHT = DIGIT_FONT_SIZE * 0.07;

function makeFaceTexture(number) {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = OBSIDIAN_COLOR;
  ctx.fillRect(0, 0, size, size);

  ctx.fillStyle = GOLD_COLOR;
  ctx.font = `bold ${DIGIT_FONT_SIZE}px system-ui, sans-serif`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";

  // Sits near the centroid of the canonical UV triangle above (apex at the
  // canvas top, base at the bottom), not the canvas's literal center.
  const baselineY = size * 0.66;
  const chars = String(number).split("");
  const widths = chars.map((ch) => ctx.measureText(ch).width);
  const totalWidth = widths.reduce((a, b) => a + b, 0);
  let x = size / 2 - totalWidth / 2;

  // The "1" bar's vertical extent is measured from a real digit's actual
  // glyph bounds ("8": full height, no descender) rather than a guessed
  // fraction of the font size -- a fixed guess left the bar sitting
  // slightly lower than the real digits (most visible in "16"/"19", where
  // the "1" bar read as sitting noticeably below the "6"/"9" next to it).
  // Measuring the real glyph keeps the two always in exact agreement, in
  // this font or any other.
  const refMetrics = ctx.measureText("8");
  const barTop = baselineY - refMetrics.actualBoundingBoxAscent;
  const barBottom = baselineY + refMetrics.actualBoundingBoxDescent;

  chars.forEach((ch, i) => {
    const w = widths[i];
    if (ch === "1") {
      ctx.fillRect(x + w / 2 - ONE_BAR_WIDTH / 2, barTop, ONE_BAR_WIDTH, barBottom - barTop);
    } else {
      ctx.fillText(ch, x, baselineY);
      // Only the standalone faces 6 and 9 get the underline -- those are
      // the pair that's actually ambiguous with each other (both are real
      // face numbers on this die). 16 and 19 rotate into "91"/"61", which
      // aren't real faces here, so there's nothing to disambiguate and the
      // underline was just visual clutter on them.
      if (chars.length === 1 && (ch === "6" || ch === "9")) {
        const underlineY = barBottom + DIGIT_FONT_SIZE * 0.06;
        ctx.fillRect(x + w * 0.12, underlineY, w * 0.76, SIX_NINE_UNDERLINE_HEIGHT);
      }
    }
    x += w;
  });

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
  faceUpVectors = computeFaceUpVectors(geometry, faceNormals);
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
  forceRenderPending = true; // new size needs a fresh frame even if the scene itself didn't change
}

window.addEventListener("resize", resizeDiceRenderer);

// Scratch vector/quaternion, reused every frame instead of allocating
// fresh THREE objects on this hot 60fps path.
const tiltLookScratchAxis = new THREE.Vector3();
const tiltLookScratchQuat = new THREE.Quaternion();

// Tracks the phone's own orientation as of the last tick this ran, so each
// call only has to apply the CHANGE since then -- not an absolute tilt
// value the way the old idle spin worked. null until the first real tick
// (can't take a delta against nothing).
let lastTiltLookBeta = null;
let lastTiltLookGamma = null;

// Returns whether it actually rotated the die this frame -- diceFrame()
// uses that to decide whether the scene is dirty and needs a real render,
// so a phone held rock-steady (nothing but sensor noise) doesn't force a
// GPU draw call every single frame for no visible change.
function updateTiltLook(dt) {
  if (rolling || !diceMesh) return false;

  if (lastTiltLookBeta === null) {
    lastTiltLookBeta = filteredBeta;
    lastTiltLookGamma = filteredGamma;
    return false;
  }

  const deltaBeta = filteredBeta - lastTiltLookBeta;
  const deltaGamma = filteredGamma - lastTiltLookGamma;
  lastTiltLookBeta = filteredBeta;
  lastTiltLookGamma = filteredGamma;
  if (dt <= 0) return false;

  // A rate-based deadzone (not an absolute-angle one, unlike the old idle
  // spin): ignores sensor jitter while genuinely still, but never blocks
  // real movement regardless of how far from "zero" the phone is currently
  // held -- there IS no zero here, only how much you're turning it right
  // now, which is exactly what makes holding a tilt hold a fixed view.
  const rateDegPerSec = Math.hypot(deltaBeta, deltaGamma) / dt;
  if (rateDegPerSec < TILT_LOOK_DEADZONE_DEG_PER_SEC) return false;

  // Both axes combined into ONE rotation (same reasoning as the old idle
  // spin fix: composing two separate single-axis rotations is order-
  // dependent and frame-rate dependent, since rotations don't commute).
  // Here it's simpler still -- each tick applies the ACTUAL measured
  // change directly, so there's no velocity to integrate or step-size to
  // depend on: the total rotation over any stretch of real time is just
  // the sum of the real deltas, however finely diceFrame() happens to
  // sample them.
  tiltLookScratchAxis.set(deltaBeta, deltaGamma, 0).normalize();
  const angleRad = (Math.hypot(deltaBeta, deltaGamma) * Math.PI) / 180; // 1:1 with the phone's own rotation
  const q = tiltLookScratchQuat.setFromAxisAngle(tiltLookScratchAxis, angleRad);
  // Compose in world space (premultiply) so "turn the phone right" always
  // turns the die the same screen-space direction regardless of its
  // current orientation.
  diceMesh.quaternion.premultiply(q);
  // Repeated premultiplication accumulates floating-point error over many
  // frames; renormalize every frame so it can't drift off the unit sphere.
  diceMesh.quaternion.normalize();
  return true;
}

// Drag-to-look: a direct, position-based sibling to updateTiltLook() above,
// for touch/mouse -- every pointermove (see the listener below, which
// calls this) rotates the die by an amount proportional to how far the
// pointer actually moved, not how fast, so it works the instant you touch
// down with no separate "hold to arm" step, and stops exactly where you
// release it (no momentum, no snap-back). A drag that's ALSO fast enough
// separately feeds the existing shake-accumulator (see the same listener),
// which can still launch or redirect a real roll -- the two are
// independent: this is purely visual, the accumulator is purely about
// triggering a result.
const DRAG_LOOK_DEG_PER_PX = 0.35;
const dragLookScratchAxis = new THREE.Vector3();
const dragLookScratchQuat = new THREE.Quaternion();

function applyDragLook(dx, dy) {
  if (!diceMesh || rolling || settleState) return;
  if (dx === 0 && dy === 0) return;
  // Same axis convention as updateTiltLook(): horizontal movement turns
  // the die around the vertical axis, vertical movement around the
  // horizontal axis.
  const deltaGamma = dx * DRAG_LOOK_DEG_PER_PX;
  const deltaBeta = dy * DRAG_LOOK_DEG_PER_PX;
  dragLookScratchAxis.set(deltaBeta, deltaGamma, 0).normalize();
  const angleRad = (Math.hypot(deltaBeta, deltaGamma) * Math.PI) / 180;
  const q = dragLookScratchQuat.setFromAxisAngle(dragLookScratchAxis, angleRad);
  diceMesh.quaternion.premultiply(q);
  diceMesh.quaternion.normalize();
  forceRenderPending = true; // runs outside diceFrame()'s own dirty tracking
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

  // A new reveal cycle starting outlives any fanfare held from a previous
  // natural 1/20 -- otherwise a stale glow could linger and misleadingly
  // suggest the CURRENT face is still critical after settling onto a
  // different one.
  viewfinderEl.classList.remove("is-critical-success", "is-critical-fail");
  sigilLayerEl.style.setProperty("--sigil-glow", "0");
  sigilLayerEl.style.setProperty("--sigil-glow-red", "0");

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
  const alignedQuat = correctionQuat.multiply(currentQuat);
  // On top of that minimal correction, twist around the camera axis so the
  // revealed number reads upright — locking always straightens the number,
  // even though the face-alignment step above deliberately preserves
  // whatever roll the die happened to have.
  const twist = uprightTwist(faceUpVectors[nearestIndex], alignedQuat, cameraDir);
  const finalQuat = twist.multiply(alignedQuat);

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

// Tap-and-drag: a second way to "shake" the die, alongside physically
// shaking the phone, for anyone on a device without a working
// gyroscope/orientation sensor (desktop, denied permission) or who just
// prefers touch. Feeds the drag's own speed/direction into the EXACT same
// handleMotionEvent() pipeline a real device shake uses -- same
// accumulator, same instant-spike check, same redirect threshold, same
// direction-driven spin axis -- rather than a separate roll path, so
// dragging genuinely IS "shaking it" as far as the roll logic is
// concerned, not a lookalike. Only produces samples while pointerHeld is
// true (the same "armed to roll" gate a real shake already requires), so
// a plain drag with nothing held down still can't roll the die.
let dragLastX = null;
let dragLastY = null;
let dragLastT = null;
// Screen-space px/s of drag speed -> synthetic deg/s of "rotation rate",
// fed to handleMotionEvent() with accumulate=false (see the call site) --
// so this only ever matters for the INSTANT_SPIKE_RATE_DEG_PER_SEC check,
// never the sustained accumulator. Tuned so a brisk flick (a few hundred
// px in ~100ms, i.e. a couple thousand px/s) clears that spike threshold
// on its own, the way a hard physical shake does, while any slower,
// sustained drag -- however long you keep it up -- never launches a roll
// on its own, only looks around (see applyDragLook()).
const DRAG_DEG_PER_PX_PER_SEC = 0.22;

document.addEventListener("pointerdown", (event) => {
  if (isInteractiveElement(event.target)) return;
  event.preventDefault();
  setPointerHeld(true);
  dragLastX = event.clientX;
  dragLastY = event.clientY;
  dragLastT = performance.now();
});

document.addEventListener("pointerup", () => {
  setPointerHeld(false);
  dragLastX = null;
  dragLastY = null;
  dragLastT = null;
});
document.addEventListener("pointercancel", () => {
  setPointerHeld(false);
  dragLastX = null;
  dragLastY = null;
  dragLastT = null;
});

document.addEventListener("pointermove", (event) => {
  if (!pointerHeld || dragLastX === null) return;
  const now = performance.now();
  const dt = Math.min((now - dragLastT) / 1000, 0.1); // clamp for irregular event gaps
  const dx = event.clientX - dragLastX;
  const dy = event.clientY - dragLastY;
  dragLastX = event.clientX;
  dragLastY = event.clientY;
  dragLastT = now;

  // Gentle or fast, every drag directly rotates the die to look around
  // (position-based, not a rate -- so it works regardless of dt). A drag
  // that's ALSO fast enough is separately picked up by the accumulator
  // below, exactly as before, and can still launch/redirect a roll.
  applyDragLook(dx, dy);

  if (dt <= 0) return; // duplicate/zero-gap event; nothing to derive a rate from

  // Horizontal drag -> gamma-like rate, vertical drag -> beta-like rate,
  // matching the same axis convention tilt-look uses (deltaGamma =
  // left/right, deltaBeta = up/down).
  const gammaRate = (dx / dt) * DRAG_DEG_PER_PX_PER_SEC;
  const betaRate = (dy / dt) * DRAG_DEG_PER_PX_PER_SEC;
  // accumulate=false: a sustained, gentle, one-directional drag (the whole
  // point of look-around -- see applyDragLook() above) must never build up
  // toward a roll just by continuing for a while. Only an unmistakably
  // hard, fast flick (instant-spike, checked either way) can still launch
  // or redirect one.
  handleMotionEvent({ rotationRate: { beta: betaRate, gamma: gammaRate } }, false);
});

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
// tilt-look: rotation rate around the device's beta (X) axis spins the die
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
  // A new roll outlives any fanfare held from the previous result -- see
  // the same reasoning in pauseAndReveal().
  viewfinderEl.classList.remove("is-critical-success", "is-critical-fail");
  sigilLayerEl.style.setProperty("--sigil-glow", "0");
  sigilLayerEl.style.setProperty("--sigil-glow-red", "0");
  escapeRingFillEl.setAttribute("height", "0");
  escapeRingFillEl.setAttribute("y", "100");

  const intensityT = intensityFromPeakRate(peakRotationRate);
  const totalTurns = SHAKE_MIN_TURNS + intensityT * (SHAKE_MAX_TURNS - SHAKE_MIN_TURNS);

  const resultIndex = Math.floor(Math.random() * 20);
  const cameraDir = new THREE.Vector3(0, 0, 1);
  const targetNormal = faceNormals[resultIndex].clone().normalize();
  const settleQuat = new THREE.Quaternion().setFromUnitVectors(targetNormal, cameraDir);
  // Twist around the camera axis to land the number upright, rather than
  // the arbitrary/random angle this used to settle at — the spin animation
  // itself still looks dynamic (driven by spinAxis/totalTurns below), only
  // the final resting orientation is now fixed to always read upright.
  const twist = uprightTwist(faceUpVectors[resultIndex], settleQuat, cameraDir);
  const finalQuat = twist.multiply(settleQuat);

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
  const eased = easeInOutQuart(t);
  diceMesh.quaternion.copy(rollState.settleFromQuat).slerp(rollState.finalQuat, eased);

  if (t >= 1) {
    finishRoll(rollState.resultIndex);
    rollState = null;
    // Freeze on the revealed face, same as pauseAndReveal() does — without
    // this, the die had no `frozen` transition at all after a completed
    // roll, so it would immediately resume tilt-look off of whatever tilt
    // the phone happened to be at. Recalibrate the "level"
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
// entirely independent of whatever rotation state (tilt-look/frozen/roll)
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

// Fanfare for a natural 1 or 20 -- entirely through the viewfinder (corner
// brackets flash/glow, the resting-tilt ring flashes along with them; a
// fail also gets a brief shake), no new UI elements and no die-position
// change. The CSS animations these classes trigger override .is-frozen/
// .is-held's static stroke/filter for their duration regardless of
// selector specificity, so this always takes visual precedence while it
// plays. Deliberately NOT cleared by a timer: the CSS keyframes pulse a
// few times and then (via `forwards` fill-mode) hold a sustained glow, and
// that hold lasts for as long as the natural 1/20 stays the current
// result -- only cleared where frozen is reset to false, i.e. the next
// roll (rollDice) or reveal cycle (pauseAndReveal) starting.
function triggerFanfare(kind) {
  viewfinderEl.classList.remove("is-critical-success", "is-critical-fail");
  // Force a reflow so re-adding the same class restarts its CSS animation
  // from scratch if triggered twice in a row (e.g. two natural 20s back to
  // back) rather than being a no-op.
  void viewfinderEl.offsetWidth;
  viewfinderEl.classList.add(kind === "success" ? "is-critical-success" : "is-critical-fail");
}

// Power curve applied to both intensity ramps below: a plain linear ramp
// (faceNumber-12)/8 made faces 13-16 nearly as visible as 17-20, reading as
// "already pretty bright" long before the actual extreme. Raising the
// linear fraction to this power keeps early faces in each band close to 0
// (barely visible) and concentrates the real jump to "big visible" in the
// last couple of steps toward the edge -- e.g. face 16 (linear 0.5) lands
// at just ~0.18, while face 20 (linear 1) is still exactly 1.
const GLOW_CURVE_EXPONENT = 2.5;

// 0 for any face in the No/Maybe not/Try again bands (faces 1-12), then
// curving up to 1 at face 20 (the single most emphatic "yes") across the
// Maybe yes/Yes bands (faces 13-20) -- see FACE_PHRASE_ORDER and
// GLOW_CURVE_EXPONENT above. Drives --sigil-glow on the viewfinder so the
// sigil preview glows brighter the more affirmative the answer, never for
// a non-affirmative one.
function affirmativeIntensity(faceNumber) {
  if (faceNumber <= 12) return 0;
  return Math.pow((faceNumber - 12) / 8, GLOW_CURVE_EXPONENT);
}

// Mirror of affirmativeIntensity() for the No/Maybe not bands (faces 1-8):
// 0 for any face in Try again/Maybe yes/Yes (faces 9-20), then curving up
// to 1 at face 1 (the single most emphatic "no"). Drives --sigil-glow-red
// so the sigil preview gets a red glow the more negative the answer, never
// for a non-negative one.
function negativeIntensity(faceNumber) {
  if (faceNumber >= 9) return 0;
  return Math.pow((9 - faceNumber) / 8, GLOW_CURVE_EXPONENT);
}

// Whether the result was revealed by the phone going still (rather than a
// held-and-shaken roll) is shown as an icon in the viewfinder — a pause
// glyph — instead of text.
function finishRoll(index, revealedByPause) {
  rolling = false;
  restQuaternion.copy(diceMesh.quaternion); // what Recenter jumps back to after looking around
  const faceNumber = FACES[index].number;
  diceAnswerEl.textContent = FACES[index].phrase;
  sigilLayerEl.style.setProperty("--sigil-glow", String(affirmativeIntensity(faceNumber)));
  sigilLayerEl.style.setProperty("--sigil-glow-red", String(negativeIntensity(faceNumber)));

  if (revealedByPause) statusIconPauseEl.removeAttribute("hidden");
  else statusIconPauseEl.setAttribute("hidden", "");

  // Only an actual rolled result can be a "natural 1" or "natural 20" --
  // settling wherever the die happens to be facing when the phone goes
  // still isn't a roll outcome, so it never triggers fanfare.
  if (!revealedByPause && faceNumber === 20) triggerFanfare("success");
  else if (!revealedByPause && faceNumber === 1) triggerFanfare("fail");

  if (navigator.vibrate) {
    try {
      if (!revealedByPause && faceNumber === 20) navigator.vibrate([40, 30, 40, 30, 90]);
      else if (!revealedByPause && faceNumber === 1) navigator.vibrate([120, 60, 120]);
      else navigator.vibrate([30, 40, 30]);
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

  let frameStateLabel;
  let dirty;
  if (rollState) {
    frameStateLabel = rollState.phase === "spin" ? "roll-spin" : "roll-settle";
    updateRoll();
    dirty = true; // always advances the animation while active
  } else if (settleState) {
    frameStateLabel = "pause-settle";
    updateSettle();
    dirty = true;
  } else if (frozen) {
    // Look-around (tilt/drag) still works while frozen showing a result --
    // that's the whole point: inspect every side of what you rolled. Only
    // updateFrozenFill() is skipped from the dirty check itself since it
    // only ever touches the SVG ring, never the 3D scene.
    frameStateLabel = "frozen";
    updateFrozenFill();
    dirty = updateTiltLook(dt);
  } else if (stillSinceAt !== null) {
    // A stillness attempt is in progress (see updatePauseDetection) --
    // hold the die exactly where it is rather than letting look-around
    // keep drifting it off whatever face was showing when the hold began.
    // This is the fix for the pause-reveal desync bug: without it, the
    // face that ends up revealed once the timer completes could differ
    // from the one that was actually facing the camera when the phone
    // first went still.
    frameStateLabel = "held-still";
    dirty = false; // nothing touches the scene while held
  } else {
    frameStateLabel = "idle";
    dirty = updateTiltLook(dt); // false while steady/within the deadzone
  }

  // A pull (see pullDice()) moves diceMesh.position independently of
  // whatever rotation state above is also active, including the final
  // frame that springs it back to (0,0,0) -- so it's checked and OR'd in
  // separately rather than folded into the branches above.
  const pullWasActive = pullState !== null;
  updatePull();
  if (pullWasActive) dirty = true;

  if (frameRecording) recordFrameSample(now, dt, frameStateLabel);

  // Render-skip-at-rest: skip the actual GPU draw call on any frame where
  // nothing in the scene changed (see forceRenderPending's own comment).
  // The rAF loop above still runs every frame regardless, so a new shake
  // or tilt is always noticed promptly -- this only skips the expensive
  // renderer.render() call itself.
  if (dirty || forceRenderPending) {
    renderer.render(scene, camera);
    forceRenderPending = false;
  }
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
