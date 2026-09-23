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
const nonRandomRollToggleEl = document.getElementById("non-random-roll-toggle");
const statTotalRollsEl = document.getElementById("stat-total-rolls");
const statNat20El = document.getElementById("stat-nat20");
const statNat1El = document.getElementById("stat-nat1");
const statPauseRevealsEl = document.getElementById("stat-pause-reveals");
const statFaceMostLeastEl = document.getElementById("stat-face-most-least");
const statFaceTableEl = document.getElementById("stat-face-table");
const statDragCurrentEl = document.getElementById("stat-drag-current");
const statDragAvgEl = document.getElementById("stat-drag-avg");
const statDragPeakEl = document.getElementById("stat-drag-peak");
const statShakeAvgEl = document.getElementById("stat-shake-avg");
const statShakePeakEl = document.getElementById("stat-shake-peak");
const statRollsVsPullsEl = document.getElementById("stat-rolls-vs-pulls");
const statHoldCurrentEl = document.getElementById("stat-hold-current");
const statHoldAvgEl = document.getElementById("stat-hold-avg");
const statHoldLongestEl = document.getElementById("stat-hold-longest");
const statsResetBtn = document.getElementById("stats-reset-btn");
const diePickerEl = document.getElementById("die-picker");

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
// gesture for dice rolls — see processShakeSample.

// Time constant (seconds) of the complementary filter's pull back toward the
// absolute orientation reading. Expressed as a time rather than a per-frame
// weight so the blend behaves the same at 60Hz and 120Hz (a fixed 0.96
// per-frame alpha corrected twice as hard on a 120Hz screen). 0.4s matches
// the old 0.96 at 60fps.
const GYRO_FUSION_TAU = 0.4;
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
// A touch drag's "rate" (see DRAG_DEG_PER_PX_PER_SEC below) is derived from
// screen-space distance / event dt, and pointermove events don't arrive on
// the smooth, evenly-spaced schedule a real gyroscope tick does -- a
// perfectly calm, slow drag to look around every side of the die can still
// throw off one freak near-zero-dt sample (touch coalescing, a paused then
// resumed drag, the very first move after pointerdown) whose computed rate
// spikes far above what the finger actually moved. A real device's
// INSTANT_SPIKE_RATE_DEG_PER_SEC is tuned against genuine gyroscope
// readings and doesn't have this failure mode, so it stays as-is; only the
// synthetic drag-derived rate needs a much higher bar before a single tick
// alone can count as "an unmistakably hard flick" and launch a roll instead
// of just continuing the look-around.
const DRAG_INSTANT_SPIKE_RATE_DEG_PER_SEC = 900;
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

// Real devicemotion events only: these are the only samples allowed to
// update the gyro state the fusion filter/tilt-look/pause detection read.
// The drag listener feeds its synthetic rates straight into
// processShakeSample() instead -- routing them through here used to make a
// drag ALSO count as the phone physically rotating, so every drag turned the
// die twice (once by applyDragLook(), again via the fake gyro integrated
// into filteredBeta/Gamma and picked up by tilt-look) and kept pause
// detection from ever seeing the phone as still.
function handleMotionEvent(event) {
  const rate = event.rotationRate;
  if (rate && rate.beta !== null && rate.gamma !== null) {
    gyroBeta = rate.beta;
    gyroGamma = rate.gamma;
    hasGyro = true;
    lastGyroAt = performance.now();
    processShakeSample(rate.beta, rate.gamma);
  } else {
    processShakeSample(undefined, undefined);
  }
}

// accumulate=false (used by the drag-look pointermove listener) skips
// adding this sample into the sustained leaky-bucket accumulator below --
// see the call site for why: a real device shake is naturally an
// oscillating back-and-forth burst the bucket is built to catch, but a
// deliberate, sustained, ONE-directional drag to look around every side of
// the die can otherwise accumulate the exact same total over a few
// seconds and accidentally launch a roll. Instant-spike detection (an
// unmistakably hard flick in a single tick) still applies either way --
// that's the intended way a hard drag launches a roll -- but spikeThreshold
// lets the drag call site require a much harder flick than a real device
// shake needs (see DRAG_INSTANT_SPIKE_RATE_DEG_PER_SEC).
function processShakeSample(betaRate, gammaRate, accumulate = true, spikeThreshold = INSTANT_SPIKE_RATE_DEG_PER_SEC) {
  const now = performance.now();
  const rateValid = betaRate !== undefined;
  const rotSpeed = rateValid ? Math.abs(betaRate) + Math.abs(gammaRate) : 0;

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
    const instantSpike = rotSpeed >= spikeThreshold;
    const shouldFire = cooldownClear && (instantSpike || rotationAccumDeg > activeThreshold);

    if (shouldFire) {
      const peak = Math.max(rotationAccumPeakRate, rotSpeed);

      stats.shakeSpeedSampleCount++;
      stats.shakeSpeedSampleSum += peak;
      if (peak > stats.shakeSpeedPeak) stats.shakeSpeedPeak = peak;

      // Held: actually roll (no `!rolling` guard — a shake can interrupt
      // and redirect a roll already in progress, not just start a fresh
      // one). Not held: can't roll, so pull instead — but only from a
      // resting state, never on top of a roll/settle animation already
      // playing (that can only have started while held, and finishes on
      // its own regardless of whether the hold is later released).
      if (pointerHeld) {
        rollDice(peak, betaRate, gammaRate);
        stats.rollTriggerCount++;
      } else if (!rolling && !settleState) {
        pullDice(peak, betaRate, gammaRate);
        stats.pullTriggerCount++;
      }
      lastRollTriggerAt = now;
      rotationAccumDeg = 0;
      rotationAccumPeakRate = 0;
      saveStats();
      renderStatsPanel();
    }
  }
  lastMotionEventAt = now;
}

// Shortest signed difference between two angles in degrees. beta wraps at
// +/-180, so a plain subtraction across that seam reads as a ~360deg jump
// and would yank the filter (and everything derived from it) the long way
// round.
function angleDiffDeg(to, from) {
  return ((((to - from) % 360) + 540) % 360) - 180;
}

function isGyroFresh(now) {
  return hasGyro && now - lastGyroAt < GYRO_FRESH_WINDOW_MS;
}

function stepFilter(now, dt) {
  if (isGyroFresh(now)) {
    const correction = 1 - Math.exp(-dt / GYRO_FUSION_TAU);
    filteredBeta += gyroBeta * dt;
    filteredGamma += gyroGamma * dt;
    filteredBeta += angleDiffDeg(rawBeta, filteredBeta) * correction;
    filteredGamma += (rawGamma - filteredGamma) * correction;
  } else {
    const k = 1 - Math.exp(-dt / FALLBACK_TAU);
    filteredBeta += angleDiffDeg(rawBeta, filteredBeta) * k;
    filteredGamma += (rawGamma - filteredGamma) * k;
  }
  filteredBeta = angleDiffDeg(filteredBeta, 0); // keep in [-180, 180)
}

// Before the first result, tilt/drag freely rotate the die to look around
// every side (see updateTiltLook()/applyDragLook()) with no fixed "zero"
// to return to on its own -- so Recenter is
// repurposed from "recalibrate the tilt sensor's zero-point" to "jump back
// to the last settled result" (restQuaternion, updated in finishRoll()),
// giving you a quick way back after looking around.
function recenterView() {
  if (!diceMesh) return;
  diceMesh.quaternion.copy(restQuaternion);
  forceRenderPending = true; // mutates the scene from outside diceFrame()'s own dirty tracking
}

recenterBtn.addEventListener("click", recenterView);

// Non-random roll: on by default -- "shake to roll" is a deterministic
// confirm rather than a random pick, landing on whatever face
// findNearestFaceIndex() already says is facing the camera (see rollDice()
// below), the same face pauseAndReveal() would settle on if you just held
// still. Lets someone tilt/drag to the face they actually want, then shake
// to commit to exactly that one. Turning it off restores true random
// rolls. Persisted (best-effort) so the choice survives a reload.
const NON_RANDOM_ROLL_STORAGE_KEY = "ask-ball-non-random-roll";
let nonRandomRoll = true;
try {
  const storedNonRandomRoll = localStorage.getItem(NON_RANDOM_ROLL_STORAGE_KEY);
  if (storedNonRandomRoll !== null) nonRandomRoll = storedNonRandomRoll === "true";
} catch {
  // ignore -- private browsing / storage disabled, defaults to on
}
nonRandomRollToggleEl.checked = nonRandomRoll;

nonRandomRollToggleEl.addEventListener("change", () => {
  nonRandomRoll = nonRandomRollToggleEl.checked;
  try {
    localStorage.setItem(NON_RANDOM_ROLL_STORAGE_KEY, String(nonRandomRoll));
  } catch {
    // ignore -- the toggle still works for this session, just won't persist
  }
});

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
// Below this, a frame-to-frame change is pure sensor noise, not a visible
// shift in the light's position (it's sub-pixel at any real screen size) --
// skipping the write avoids forcing a style/paint pass on this SVG every
// single one of the ~60 frames/sec this runs, for no visible difference.
const LEVEL_LIGHT_MIN_DELTA = 0.05;
let lastLevelLightCx = null;
let lastLevelLightCy = null;

function updateLevelLight() {
  const nx = Math.max(-1, Math.min(1, (filteredGamma - frozenZeroGamma) / TILT_VISUAL_RANGE_DEG));
  const ny = Math.max(-1, Math.min(1, angleDiffDeg(filteredBeta, frozenZeroBeta) / TILT_VISUAL_RANGE_DEG));
  const cx = 50 + nx * LEVEL_LIGHT_OFFSET_RANGE;
  const cy = 50 + ny * LEVEL_LIGHT_OFFSET_RANGE;
  if (
    lastLevelLightCx !== null &&
    Math.abs(cx - lastLevelLightCx) < LEVEL_LIGHT_MIN_DELTA &&
    Math.abs(cy - lastLevelLightCy) < LEVEL_LIGHT_MIN_DELTA
  ) {
    return;
  }
  lastLevelLightCx = cx;
  lastLevelLightCy = cy;
  levelLightEl.setAttribute("cx", String(cx));
  levelLightEl.setAttribute("cy", String(cy));
}

function updatePauseDetection(now, dt) {
  const deviceSpeed = isGyroFresh(now)
    ? Math.hypot(gyroBeta, gyroGamma)
    : Math.hypot(angleDiffDeg(filteredBeta, prevPauseBeta), filteredGamma - prevPauseGamma) / dt;
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

// Runs at the top of diceFrame() rather than in its own requestAnimationFrame
// loop: with two separate loops the dice loop (registered first) always
// read the PREVIOUS frame's filtered orientation, adding a full frame of
// latency to every tilt.
function updateSensors(now, dt) {
  if (!hasOrientation || dt <= 0) return;
  stepFilter(now, dt);
  updateLevelLight();
  updatePauseDetection(now, dt);
}

function startListening() {
  window.addEventListener("deviceorientation", handleOrientationEvent);
  window.addEventListener("devicemotion", handleMotionEvent);
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

// --- manipulation stats ---
//
// Real numbers on how the die is actually being handled: how each face's
// come up, how fast drags/shakes/flicks tend to be, how long a hold
// typically lasts. Persisted to localStorage (best-effort -- private
// browsing or a full/blocked store just means stats don't survive a
// reload, never a hard failure) so the panel reflects usage over time, not
// just the current session.
const STATS_STORAGE_KEY = "ask-ball-stats-v1";

function emptyStats() {
  return {
    totalRolls: 0,
    totalPauseReveals: 0,
    natural20Count: 0,
    natural1Count: 0,
    faceCounts: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [String(i + 1), 0])),
    dragSpeedSampleCount: 0,
    dragSpeedSampleSum: 0,
    dragSpeedPeak: 0,
    shakeSpeedSampleCount: 0,
    shakeSpeedSampleSum: 0,
    shakeSpeedPeak: 0,
    rollTriggerCount: 0,
    pullTriggerCount: 0,
    holdCount: 0,
    holdDurationSumMs: 0,
    holdDurationLongestMs: 0,
  };
}

function loadStats() {
  try {
    const raw = localStorage.getItem(STATS_STORAGE_KEY);
    if (!raw) return emptyStats();
    const parsed = JSON.parse(raw);
    // Merge over a fresh empty() rather than trusting the stored shape
    // directly, so an older/partial save (or a future field this version
    // doesn't know about yet) can't leave a field undefined.
    return { ...emptyStats(), ...parsed, faceCounts: { ...emptyStats().faceCounts, ...(parsed.faceCounts || {}) } };
  } catch {
    return emptyStats();
  }
}

function saveStats() {
  try {
    localStorage.setItem(STATS_STORAGE_KEY, JSON.stringify(stats));
  } catch {
    // ignore -- private browsing / storage disabled, stats just won't persist
  }
}

let stats = loadStats();

// "Current" drag speed and hold duration are live, moment-to-moment
// readouts (not aggregated into `stats`) -- see updateLiveStatValues(),
// called from the always-running frame() loop while the panel is open.
let liveDragSpeedDegPerSec = null;
let holdStartedAt = null;

function recordDragSpeedSample(speedDegPerSec) {
  liveDragSpeedDegPerSec = speedDegPerSec;
  stats.dragSpeedSampleCount++;
  stats.dragSpeedSampleSum += speedDegPerSec;
  if (speedDegPerSec > stats.dragSpeedPeak) stats.dragSpeedPeak = speedDegPerSec;
  // Only the drag readouts change here -- not worth rebuilding the whole
  // panel (including the 20-row face table) on every pointermove.
  if (!settingsPanelEl.hidden) renderDragStats();
}

function renderDragStats() {
  statDragAvgEl.textContent = formatSpeed(stats.dragSpeedSampleSum, stats.dragSpeedSampleCount);
  statDragPeakEl.textContent = formatPeakSpeed(stats.dragSpeedPeak);
}

function formatSpeed(sum, count) {
  return count > 0 ? `${Math.round(sum / count)}°/s` : "–";
}
function formatPeakSpeed(peak) {
  return peak > 0 ? `${Math.round(peak)}°/s` : "–";
}
function formatDurationMs(ms) {
  return ms > 0 ? `${(ms / 1000).toFixed(1)}s` : "–";
}

function renderStatsPanel() {
  if (settingsPanelEl.hidden) return;

  statTotalRollsEl.textContent = String(stats.totalRolls);
  statNat20El.textContent = String(stats.natural20Count);
  statNat1El.textContent = String(stats.natural1Count);
  statPauseRevealsEl.textContent = String(stats.totalPauseReveals);

  const counts = Object.entries(stats.faceCounts).map(([num, count]) => ({ num: Number(num), count }));
  counts.sort((a, b) => a.num - b.num);
  const maxCount = Math.max(1, ...counts.map((c) => c.count));
  if (stats.totalRolls > 0) {
    const rolled = counts.filter((c) => c.count > 0);
    const most = rolled.reduce((a, b) => (b.count > a.count ? b : a));
    const least = rolled.reduce((a, b) => (b.count < a.count ? b : a));
    statFaceMostLeastEl.textContent =
      least.num !== most.num ? `Most: ${most.num} (${most.count}) · Least: ${least.num} (${least.count})` : `Most: ${most.num} (${most.count})`;
  } else {
    statFaceMostLeastEl.textContent = "No rolls yet.";
  }
  statFaceTableEl.innerHTML = counts
    .map(({ num, count }) => {
      const pct = stats.totalRolls > 0 ? Math.round((count / stats.totalRolls) * 100) : 0;
      const barPct = Math.round((count / maxCount) * 100);
      return (
        `<div class="stat-face-row"><span class="stat-face-num">${num}</span>` +
        `<span class="stat-face-bar-track"><span class="stat-face-bar-fill" style="width:${barPct}%"></span></span>` +
        `<span class="stat-face-count">${count} (${pct}%)</span></div>`
      );
    })
    .join("");

  renderDragStats();

  statShakeAvgEl.textContent = formatSpeed(stats.shakeSpeedSampleSum, stats.shakeSpeedSampleCount);
  statShakePeakEl.textContent = formatPeakSpeed(stats.shakeSpeedPeak);
  statRollsVsPullsEl.textContent = `${stats.rollTriggerCount} / ${stats.pullTriggerCount}`;

  statHoldAvgEl.textContent = formatDurationMs(stats.holdCount > 0 ? stats.holdDurationSumMs / stats.holdCount : 0);
  statHoldLongestEl.textContent = formatDurationMs(stats.holdDurationLongestMs);
}

// Cheap per-frame refresh of just the two truly LIVE values, only while the
// panel is actually visible (see the call site in frame()) -- everything
// else in the panel only changes on a real event (a roll, a drag sample, a
// release) and is updated there instead.
function updateLiveStatValues() {
  statDragCurrentEl.textContent = pointerHeld && liveDragSpeedDegPerSec !== null ? `${Math.round(liveDragSpeedDegPerSec)}°/s` : "–";
  statHoldCurrentEl.textContent = pointerHeld && holdStartedAt !== null ? `${((performance.now() - holdStartedAt) / 1000).toFixed(1)}s` : "–";
}

settingsToggleBtn.addEventListener("click", () => {
  settingsPanelEl.hidden = !settingsPanelEl.hidden;
  if (!settingsPanelEl.hidden) renderStatsPanel();
});

statsResetBtn.addEventListener("click", () => {
  stats = emptyStats();
  saveStats();
  renderStatsPanel();
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

// Which physical triangle (by index -- matching faceNormals and the
// geometry's triangle order) shows which printed number. A real d20 puts 1 and
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
// together, not just consecutive numbers along one path.
//
// SECOND, SEPARATE constraint added after a real report ("why are there 2
// 17 faces", later "duplicates" on a revealed "Probably no"): only ONE
// face is ever twisted upright, so every other visible face shows at
// whatever rotation its position leaves it at -- and "1" is drawn as a
// bare vertical bar (see drawFaceNumber(), fixed separately for a "1
// rotated looks like 7" bug) with nothing to mark where it starts or
// ends. Sitting next to almost any other single digit, that bar reads as
// the leading "1" of a two-digit number -- and because faces 10-19 are
// all real, EVERY digit 2-9 next to "1" spells out another face that
// genuinely exists on the die (bar+"2" next to the real "2" looked
// exactly like a second, genuine "12" -- not a misread, an actual
// identically-shaped duplicate of a real answer). Verified by dumping
// every face's raw texture pixel-for-pixel (all 20 unique, confirming
// this was never a data bug) and reproducing the exact illusion live
// (rendering face "2" upright shows the real neighboring "1" bar sitting
// close enough to read as "12"). No permutation can give "1" zero
// neighbors (it always has exactly 3), so the fix is choosing which 3
// numbers land there: this layout gives "1" only 10/11/12 as neighbors --
// each already a self-contained two-digit face, not a bare digit "1" can
// silently attach to.
//
// That constraint alone forced trading the bandwidth-minimal layout's
// worst-case gap (6) up to 11, and the minimum possible cross-polarity
// edges (2, see test-face-numbering.js's exhaustive proof that 0 is
// impossible) up to 3 -- confirmed by extensive search that 0 single-
// digit neighbors for "1" combined with the previous layout's minimums
// isn't achievable at all. Among the many permutations tying on those
// stats, this one was chosen for also minimizing how jarring its 3 forced
// crossings feel (mostly-bordering-neutral pairs like 8/13, not extreme
// swings like 4/15) -- see test-face-numbering.js. Still lands faces 1 and
// 20 on exact geometric opposites (180deg apart) as a bonus of the graph's
// symmetry, same as a real d20. Computed once offline against the real
// geometry (see test-face-numbering.js and test-no-digit-illusion.js for
// the derivation and proof); this is just the resulting permutation.
const TRIANGLE_TO_FACE_NUMBER = [
  16, 18, 15, 17, 19, 12, 11, 14, 20, 7, 10, 5, 8, 4, 2, 1, 6, 13, 9, 3,
];

let renderer = null;
let scene = null;
let camera = null;
let diceMesh = null;
let faceNormals = null;
let faceUpVectors = null;

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
// Must be >= PAUSE_STILL_THRESHOLD_DEG_PER_SEC (defined above) -- a real
// bug, not just a tuning nitpick: at 2, ordinary hand tremor (very
// commonly 2-12deg/s just from holding a phone, especially while tapping
// the screen to check or screenshot a result) fell BETWEEN the two
// thresholds. That tremor read as "still" for pause-detection (so the
// revealed phrase correctly stayed locked) but as genuine rotation for
// tilt-look (so the die kept silently drifting to new faces the whole
// time anyway) -- the exact same phrase staying on screen while the
// numbers underneath kept changing, looking like duplicate/random faces
// on the die when it was really just untracked drift. Keeping this at or
// above the pause threshold guarantees "the phone counts as still" means
// the same thing everywhere: nothing can drift once pause-detection would
// also call it still.
//
// The deadzone is a soft ramp rather than a hard cutoff: below
// TILT_LOOK_DEADZONE_LOW_DEG_PER_SEC the die ignores the phone entirely (the
// invariant above), above TILT_LOOK_DEADZONE_HIGH_DEG_PER_SEC it follows
// 1:1, and in between the follow gain eases up smoothly. A hard cutoff made
// a slow turn hovering around the threshold stutter between "frozen" and
// "full 1:1" frame to frame, which read as a loose, notchy control.
const TILT_LOOK_DEADZONE_LOW_DEG_PER_SEC = PAUSE_STILL_THRESHOLD_DEG_PER_SEC;
const TILT_LOOK_DEADZONE_HIGH_DEG_PER_SEC = 26;

// Locked-in result: once a roll or pause-reveal settles, the die stays on
// its face rather than following the phone 1:1. All it does is lean a
// little with the phone's tilt, so it still feels like a physical object:
// LOCK_PARALLAX_GAIN of the tilt, capped at LOCK_PARALLAX_MAX_DEG. That lean
// is measured against a reference that slowly follows the phone
// (LOCK_REF_RECENTER_TAU), so holding the phone at a new angle eases the
// die back to dead-on instead of leaving it leaning forever.
// Pressing and holding the screen again unlocks a full look-around (see
// lookUnlocked); letting go eases the die back onto the locked face
// (LOCK_FOLLOW_TAU).
const LOCK_PARALLAX_GAIN = 0.12;
const LOCK_PARALLAX_MAX_DEG = 6;
const LOCK_REF_RECENTER_TAU = 2.5; // seconds
const LOCK_FOLLOW_TAU = 0.1; // seconds
const LOCK_REST_EPSILON_RAD = 1e-3; // ~0.06deg: closer than this counts as "at rest", no render needed
const LOCKED_PULL_SCALE = 0.35; // a denied (not-held) shake barely nudges a locked die
const DEG2RAD = Math.PI / 180;

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
// True only while a hold that STARTED after the die locked is still down --
// holding straight through a roll (you have to hold to shake-roll) must not
// leave the fresh result free-spinning with every hand movement.
let lookUnlocked = false;
let lockRefBeta = 0;
let lockRefGamma = 0;

// The last settled result's orientation, updated in finishRoll(). A locked
// die leans around this and eases back onto it after a look-around hold
// (see updateLockedPose()); it's also what the Recenter button jumps back
// to. Starts at identity -- before any result
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

// Groups a non-indexed geometry's triangles into the die's real faces
// (coplanar triangles -- a d6 square is 2, a d12 pentagon 3), in order of
// first appearance, so a one-triangle-per-face d20 keeps exactly the
// triangle order TRIANGLE_TO_FACE_NUMBER was derived against.
//
// Each face also gets the "up" direction of its printed number, in local
// space -- used to twist the die around the camera axis once it locks so the
// number reads upright (see uprightTwist()):
//   - "apex": toward the 3rd vertex of the face's first triangle. For the
//     d20 this is identical to the old base-midpoint-to-apex vector (in an
//     equilateral triangle both point the same way).
//   - "edge": toward the midpoint of the first triangle's first edge -- a
//     d6's number sits square to its edges rather than pointing at a corner.
//   - "far": toward the farthest vertex -- a d10 kite's long point, the pole.
function buildDieFaces(geometry, upMode) {
  const pos = geometry.attributes.position;
  const faces = [];
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

    let face = faces.find((f) => f.normal.dot(cb) > 0.9999);
    if (!face) {
      face = { normal: cb.clone(), vertices: [], triangleStarts: [], firstTriangle: [vA.clone(), vB.clone(), vC.clone()] };
      faces.push(face);
    }
    face.triangleStarts.push(i);
    for (const v of [vA, vB, vC]) {
      if (!face.vertices.some((u) => u.distanceToSquared(v) < 1e-10)) face.vertices.push(v.clone());
    }
  }

  for (const face of faces) {
    const { normal, vertices, firstTriangle } = face;
    const centroid = new THREE.Vector3();
    for (const v of vertices) centroid.add(v);
    centroid.divideScalar(vertices.length);

    const up = new THREE.Vector3();
    if (upMode === "edge") {
      up.addVectors(firstTriangle[0], firstTriangle[1]).multiplyScalar(0.5).sub(centroid);
    } else if (upMode === "far") {
      let far = vertices[0];
      for (const v of vertices) if (v.distanceToSquared(centroid) > far.distanceToSquared(centroid)) far = v;
      up.subVectors(far, centroid);
    } else {
      up.subVectors(firstTriangle[2], centroid);
    }
    up.addScaledVector(normal, -up.dot(normal)).normalize();
    // Screen-right when looking at the face from outside (normal toward the
    // viewer, up as screen-up).
    const right = new THREE.Vector3().crossVectors(up, normal);

    // Outline in face-plane coordinates, sorted around the centroid, for the
    // circumradius (texture span) and inradius (how big the number can be).
    const outline = vertices
      .map((v) => {
        const d = v.clone().sub(centroid);
        return { x: d.dot(right), y: d.dot(up) };
      })
      .sort((p, q) => Math.atan2(p.y, p.x) - Math.atan2(q.y, q.x));
    let radius = 0;
    let inradius = Infinity;
    outline.forEach((p, k) => {
      const q = outline[(k + 1) % outline.length];
      radius = Math.max(radius, Math.hypot(p.x, p.y));
      inradius = Math.min(inradius, Math.abs(p.x * q.y - q.x * p.y) / Math.hypot(q.x - p.x, q.y - p.y));
    });

    Object.assign(face, { centroid, up, right, radius, inradius });
  }
  return faces;
}

// Face numbers for every die but the d20 (which has its own hand-derived
// layout, TRIANGLE_TO_FACE_NUMBER): the standard convention that opposite
// faces sum to sides + 1 (1 opposite 6 on a d6, and so on). A d4 has no
// opposite faces, so it just counts up.
function assignFaceNumbers(faces, def) {
  if (def.numbering) return def.numbering.slice();
  const n = faces.length;
  const numbers = new Array(n).fill(0);
  let low = 1;
  for (let i = 0; i < n; i++) {
    if (numbers[i]) continue;
    numbers[i] = low;
    let opposite = -1;
    let bestDot = -0.5; // anything less antiparallel than this isn't really "opposite"
    for (let j = 0; j < n; j++) {
      if (j === i || numbers[j]) continue;
      const dot = faces[i].normal.dot(faces[j].normal);
      if (dot < bestDot) {
        bestDot = dot;
        opposite = j;
      }
    }
    if (opposite >= 0) numbers[opposite] = n + 1 - low;
    low++;
  }
  return numbers;
}

// Pentagonal trapezohedron: two poles plus a 10-vertex ring zig-zagging
// just above/below the equator, giving 10 kite faces. The pole height is the
// one that makes every kite exactly planar for the chosen zig-zag height
// (poleHeight = ringHeight * (1 + cos 36deg) / (1 - cos 36deg)).
function makeTrapezohedronGeometry(radius) {
  const ringHeight = 0.1;
  const c = Math.cos(Math.PI / 5);
  const poleHeight = (ringHeight * (1 + c)) / (1 - c);
  const top = new THREE.Vector3(0, poleHeight, 0);
  const bottom = new THREE.Vector3(0, -poleHeight, 0);
  const ring = [];
  for (let i = 0; i < 10; i++) {
    const a = (i * Math.PI) / 5;
    ring.push(new THREE.Vector3(Math.cos(a), i % 2 === 0 ? ringHeight : -ringHeight, Math.sin(a)));
  }
  const at = (i) => ring[i % 10];
  const triangles = [];
  for (let i = 0; i < 10; i += 2) {
    triangles.push([top, at(i), at(i + 1)], [top, at(i + 1), at(i + 2)]);
    triangles.push([bottom, at(i + 1), at(i + 2)], [bottom, at(i + 2), at(i + 3)]);
  }

  const scale = radius / Math.max(poleHeight, Math.hypot(1, ringHeight));
  const positions = new Float32Array(triangles.length * 9);
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const centroid = new THREE.Vector3();
  triangles.forEach((tri, t) => {
    // Wind every triangle counter-clockwise from outside (normal pointing
    // away from the center), as three.js expects for front faces.
    e1.subVectors(tri[1], tri[0]);
    e2.subVectors(tri[2], tri[0]);
    centroid.copy(tri[0]).add(tri[1]).add(tri[2]);
    const ordered = e1.cross(e2).dot(centroid) < 0 ? [tri[0], tri[2], tri[1]] : tri;
    ordered.forEach((v, k) => {
      positions[t * 9 + k * 3] = v.x * scale;
      positions[t * 9 + k * 3 + 1] = v.y * scale;
      positions[t * 9 + k * 3 + 2] = v.z * scale;
    });
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.computeVertexNormals(); // non-indexed, so these come out flat per face
  return geometry;
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

// Only ONE face can ever be twisted upright at a time (see uprightTwist());
// every other visible face is necessarily shown at whatever arbitrary
// rotation its own position happens to leave it at -- normal for any
// polyhedral die, but it means a digit's shape has to survive being seen
// at any angle, not just upright. Two real per-digit ambiguities showed up
// under rotation (caught by screenshotting real faces):
//   - "1" in this font carries a diagonal serif flag that, rotated away
//     from upright, reads as the diagonal stroke of a "7" -- so a rotated
//     "11" could be misread as "17"/"71", right next to a genuine "17".
//   - "6" and "9" are literal rotational mirrors of each other in any
//     font -- the exact problem physical dice solve with an underline.
// Fixed the same way: "1" is hand-drawn as a plain vertical bar (a bare
// stroke has no diagonal to misread, at any rotation) instead of the
// font's glyph, and a standalone "6"/"9" gets a short underline on any die
// that actually has both. Every other digit is unambiguous under rotation
// and still uses the font as-is.
const ATLAS_CELL_PX = 256;
const ATLAS_FACE_PADDING = 1.06; // cell spans a little past the face so mipmaps never bleed a neighbor's number in
const FACE_FONT_PER_INRADIUS = 1.46; // font px per inradius px; matches the d20's original digit size
const FACE_TEXT_MAX_WIDTH_PER_INRADIUS = 1.7; // two-digit numbers shrink to fit narrower faces (d10 kites)
const ONE_BAR_WIDTH_PER_FONT = 0.16;
const SIX_NINE_UNDERLINE_HEIGHT_PER_FONT = 0.07;

function drawFaceNumber(ctx, label, cx, cy, fontPx, maxWidthPx, underlineSixNine) {
  ctx.font = `bold ${fontPx}px system-ui, sans-serif`;
  const chars = label.split("");
  let widths = chars.map((ch) => ctx.measureText(ch).width);
  let totalWidth = widths.reduce((a, b) => a + b, 0);
  if (totalWidth > maxWidthPx) {
    fontPx *= maxWidthPx / totalWidth;
    ctx.font = `bold ${fontPx}px system-ui, sans-serif`;
    widths = chars.map((ch) => ctx.measureText(ch).width);
    totalWidth = widths.reduce((a, b) => a + b, 0);
  }

  // The "1" bar's vertical extent (and the vertical centering) is measured
  // from a real digit's actual glyph bounds ("8": full height, no
  // descender) rather than a guessed fraction of the font size, so the bar
  // always sits exactly level with the real digits beside it.
  const ref = ctx.measureText("8");
  const baselineY = cy + (ref.actualBoundingBoxAscent - ref.actualBoundingBoxDescent) / 2;
  const barTop = baselineY - ref.actualBoundingBoxAscent;
  const barBottom = baselineY + ref.actualBoundingBoxDescent;
  const barWidth = fontPx * ONE_BAR_WIDTH_PER_FONT;
  let x = cx - totalWidth / 2;

  chars.forEach((ch, i) => {
    const w = widths[i];
    if (ch === "1") {
      ctx.fillRect(x + w / 2 - barWidth / 2, barTop, barWidth, barBottom - barTop);
    } else {
      ctx.fillText(ch, x, baselineY);
      // Only a standalone 6/9 -- "16"/"19" rotate into "91"/"61", which
      // aren't real faces, so an underline there would just be clutter.
      if (underlineSixNine && chars.length === 1 && (ch === "6" || ch === "9")) {
        ctx.fillRect(x + w * 0.12, barBottom + fontPx * 0.06, w * 0.76, fontPx * SIX_NINE_UNDERLINE_HEIGHT_PER_FONT);
      }
    }
    x += w;
  });
}

// Every face's number goes into ONE texture (a grid of cells), and each
// face's UVs are a flat projection of the face onto its own cell, centered
// on the face's centroid -- one material and one draw call per die. A
// d20 face projects to the same spot its number always sat at (the
// triangle's centroid).
function applyDieAtlas(geometry, faces, def) {
  const cols = Math.ceil(Math.sqrt(faces.length));
  const rows = Math.ceil(faces.length / cols);
  const width = cols * ATLAS_CELL_PX;
  const height = rows * ATLAS_CELL_PX;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = OBSIDIAN_COLOR;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = GOLD_COLOR;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";

  const underlineSixNine = def.sides >= 9;
  const pos = geometry.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  const p = new THREE.Vector3();

  faces.forEach((face, i) => {
    const cellX = (i % cols) * ATLAS_CELL_PX + ATLAS_CELL_PX / 2;
    const cellY = Math.floor(i / cols) * ATLAS_CELL_PX + ATLAS_CELL_PX / 2;
    const pxPerUnit = ATLAS_CELL_PX / (2 * face.radius * ATLAS_FACE_PADDING);
    const label = def.printZeroForTen && face.number === 10 ? "0" : String(face.number);
    drawFaceNumber(
      ctx,
      label,
      cellX,
      cellY,
      FACE_FONT_PER_INRADIUS * face.inradius * pxPerUnit,
      FACE_TEXT_MAX_WIDTH_PER_INRADIUS * face.inradius * pxPerUnit,
      underlineSixNine
    );

    for (const start of face.triangleStarts) {
      for (let k = start; k < start + 3; k++) {
        p.fromBufferAttribute(pos, k).sub(face.centroid);
        uv[k * 2] = (cellX + p.dot(face.right) * pxPerUnit) / width;
        uv[k * 2 + 1] = 1 - (cellY - p.dot(face.up) * pxPerUnit) / height; // canvas y runs down; texture v runs up
      }
    }
  });

  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  return new THREE.CanvasTexture(canvas);
}

// --- die types ---
//
// The standard D&D set. `size` is each die's circumradius, tuned so they
// all read as roughly the same size on screen. `restTiltDeg` tips a die's
// resting pose slightly off dead-on: a d4 or d6 seen exactly face-on is
// just a flat triangle/square, with none of its sides showing. Far too
// small to change which face counts as nearest the camera. Only the die in use exists
// at any time -- built on demand and its GPU resources disposed when
// switching away -- so the set costs nothing at startup beyond the one die
// actually shown. The d20 alone keeps the oracle phrases, glows and
// natural 1/20 fanfare; the others simply show the number rolled.
const DIE_TYPES = {
  d4: { sides: 4, size: 1.18, up: "apex", restTiltDeg: 40, makeGeometry: (r) => new THREE.TetrahedronGeometry(r) },
  d6: {
    sides: 6,
    size: 1.1,
    up: "edge",
    restTiltDeg: 32,
    makeGeometry: (r) => {
      const side = (2 * r) / Math.sqrt(3);
      return new THREE.BoxGeometry(side, side, side).toNonIndexed();
    },
  },
  d8: { sides: 8, size: 1.12, up: "apex", makeGeometry: (r) => new THREE.OctahedronGeometry(r) },
  d10: { sides: 10, size: 1.1, up: "far", makeGeometry: makeTrapezohedronGeometry, printZeroForTen: true },
  d12: { sides: 12, size: 1.05, up: "apex", makeGeometry: (r) => new THREE.DodecahedronGeometry(r) },
  d20: {
    sides: 20,
    size: 1,
    up: "apex",
    makeGeometry: (r) => new THREE.IcosahedronGeometry(r, 0),
    numbering: TRIANGLE_TO_FACE_NUMBER,
    oracle: true,
  },
};
const DEFAULT_DIE = "d20";
const DIE_STORAGE_KEY = "ask-ball-die";
const DIE_APPEAR_MS = 260;

let currentDie = null;
let dieAppearStartAt = null;

function buildDie(key) {
  const def = DIE_TYPES[key];
  const geometry = def.makeGeometry(def.size);
  geometry.clearGroups(); // one material for the whole die (BoxGeometry ships with 6 groups)
  const faces = buildDieFaces(geometry, def.up);
  const numbers = assignFaceNumbers(faces, def);
  faces.forEach((face, i) => {
    face.number = numbers[i];
    face.phrase = def.oracle ? OUTCOME_PHRASES[FACE_PHRASE_ORDER[numbers[i] - 1]] : String(numbers[i]);
  });

  // MeshStandardMaterial rather than MeshPhysicalMaterial: clearcoat adds a
  // whole second specular shading pass per pixel, a real cost on mobile
  // GPUs rendering this canvas every frame during any roll/tilt/drag.
  const material = new THREE.MeshStandardMaterial({
    map: applyDieAtlas(geometry, faces, def),
    color: 0xffffff, // texture already carries the final colors; no tint
    roughness: 0.2,
    metalness: 0.2,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geometry), new THREE.LineBasicMaterial({ color: 0x000000 })));
  return { key, def, mesh, faces };
}

function disposeDie(die) {
  die.mesh.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      if (obj.material.map) obj.material.map.dispose();
      obj.material.dispose();
    }
  });
}

// Face-to-camera, number-upright orientation for a face -- the resting pose
// of a roll landing on it (plus the die's restTiltDeg, if any).
// Turns the front face down-left, away from the key light (tilting it up-
// right points it straight into the light and blows out the whole face), so
// a sliver of the top and right sides shows.
const REST_TILT_AXIS = new THREE.Vector3(1, -1, 0).normalize();

function applyRestTilt(quat) {
  const tiltDeg = currentDie.def.restTiltDeg || 0;
  if (tiltDeg) quat.premultiply(new THREE.Quaternion().setFromAxisAngle(REST_TILT_AXIS, tiltDeg * DEG2RAD));
  return quat;
}

function uprightFaceQuat(index) {
  const alignQuat = new THREE.Quaternion().setFromUnitVectors(faceNormals[index], CAMERA_DIR);
  return applyRestTilt(uprightTwist(faceUpVectors[index], alignQuat, CAMERA_DIR).multiply(alignQuat));
}

function loadDieKey() {
  try {
    const stored = localStorage.getItem(DIE_STORAGE_KEY);
    if (stored && DIE_TYPES[stored]) return stored;
  } catch {
    // ignore -- private browsing / storage disabled
  }
  return DEFAULT_DIE;
}

// Swaps in a new die, presenting its highest face upright, and resets to a
// fresh "shake to roll" state -- any roll, reveal or lock belongs to the
// die being replaced.
function setDieType(key) {
  if (!DIE_TYPES[key]) key = DEFAULT_DIE;
  if (currentDie && currentDie.key === key) return;

  const next = buildDie(key);
  if (currentDie) {
    scene.remove(currentDie.mesh);
    disposeDie(currentDie);
  }
  currentDie = next;
  diceMesh = next.mesh;
  faceNormals = next.faces.map((f) => f.normal);
  faceUpVectors = next.faces.map((f) => f.up);
  scene.add(diceMesh);

  rollState = null;
  settleState = null;
  pullState = null;
  rolling = false;
  frozen = false;
  lookUnlocked = false;
  stillSinceAt = null;
  hasMovedSincePause = false;
  pauseDurationMs = PAUSE_DURATION_BASE_MS;
  clearResultCues();
  statusIconPauseEl.setAttribute("hidden", "");
  diceAnswerEl.classList.remove("is-veiled", "is-revealed");
  diceAnswerEl.textContent = "Shake to roll";

  let highest = 0;
  next.faces.forEach((f, i) => {
    if (f.number > next.faces[highest].number) highest = i;
  });
  restQuaternion.copy(uprightFaceQuat(highest));
  diceMesh.quaternion.copy(restQuaternion);
  dieAppearStartAt = performance.now();
  forceRenderPending = true;

  for (const btn of diePickerEl.querySelectorAll(".die-btn")) {
    btn.setAttribute("aria-pressed", String(btn.dataset.die === key));
  }
  try {
    localStorage.setItem(DIE_STORAGE_KEY, key);
  } catch {
    // ignore -- still switches for this session
  }
}

diePickerEl.addEventListener("click", (event) => {
  const btn = event.target.closest(".die-btn");
  if (btn && diceMesh) setDieType(btn.dataset.die);
});

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

  // antialias:false -- MSAA multiplies the GPU's per-pixel fill cost across
  // the whole canvas every frame, a real cost on mobile GPUs. The capped
  // devicePixelRatio below already supersamples on any screen dense enough
  // to need it (most phones), and the die's facet edges are already inked
  // by its edge lines regardless of MSAA, so the softening MSAA would add
  // is limited to the outer silhouette against the transparent background.
  // powerPreference:"high-performance" is a hint, not a guarantee, but on
  // devices with both a low-power and a high-power GPU (common on
  // Android), the default/unspecified choice can land on the weaker one;
  // asking explicitly costs nothing on single-GPU phones.
  renderer = new THREE.WebGLRenderer({
    canvas: diceCanvasEl,
    antialias: false,
    alpha: true,
    powerPreference: "high-performance",
  });
  // Every visible pixel here is shaded at pixelRatio^2 cost -- measured in
  // this session's own CPU-throttled profiling, capping a 3x-density phone
  // down to 1x (instead of the old flat 2 cap) took a rendering scene from
  // ~32fps/42% dropped frames to ~41fps/22% dropped, a bigger swing than
  // any other single change tried. A die that's a few hundred CSS pixels
  // across doesn't need full display density to read clearly, so this
  // scales the cap down further on lower-spec hardware
  // (hardwareConcurrency, a real signal of an older/budget SoC -- not a
  // perfect proxy, but the only device-capability hint the web platform
  // actually exposes without a permission prompt): capped at 1 (no
  // supersampling at all) at 4 cores or fewer, 1.5 at 5-6, and 2 above
  // that, where there's real headroom to spend on sharpness.
  const pixelRatioCap = (() => {
    const cores = navigator.hardwareConcurrency || 8;
    if (cores <= 4) return 1;
    if (cores <= 6) return 1.5;
    return 2;
  })();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, pixelRatioCap));
  resizeDiceRenderer();
  setDieType(loadDieKey());
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

// Scratch objects, reused every frame instead of allocating fresh THREE
// objects on this hot 60fps path.
const lookScratchAxis = new THREE.Vector3();
const lookScratchQuat = new THREE.Quaternion();
const lockTargetQuat = new THREE.Quaternion();

// Rotates the die in world space (premultiply) so "turn the phone right"
// always turns the die the same screen-space direction regardless of its
// current orientation. Both axes are combined into ONE rotation --
// composing two separate single-axis rotations is order-dependent, since
// rotations don't commute. Renormalized every call so repeated
// premultiplication can't drift off the unit sphere.
function rotateDieWorld(betaDeg, gammaDeg) {
  const angleDeg = Math.hypot(betaDeg, gammaDeg);
  if (angleDeg === 0) return;
  lookScratchAxis.set(betaDeg / angleDeg, gammaDeg / angleDeg, 0);
  lookScratchQuat.setFromAxisAngle(lookScratchAxis, angleDeg * DEG2RAD);
  diceMesh.quaternion.premultiply(lookScratchQuat).normalize();
}

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// How far the phone itself turned since the previous dice frame, sampled
// EVERY frame (see diceFrame()) whether or not anything uses it. It used to
// only be sampled inside updateTiltLook(), which is skipped during a roll or
// settle -- so the first frame after a roll landed applied the entire
// shake's worth of accumulated rotation in one jump. Prefers the gyro's own
// rate when fresh: it's the lowest-latency signal, and look-around is
// relative so gyro drift doesn't matter here. Falls back to the filtered
// orientation's change otherwise.
let lastTiltLookBeta = null;
let lastTiltLookGamma = null;
let tiltDeltaBeta = 0;
let tiltDeltaGamma = 0;

function sampleTiltDelta(now, dt) {
  tiltDeltaBeta = 0;
  tiltDeltaGamma = 0;
  if (!hasOrientation) return;
  if (isGyroFresh(now)) {
    tiltDeltaBeta = gyroBeta * dt;
    tiltDeltaGamma = gyroGamma * dt;
  } else if (lastTiltLookBeta !== null) {
    tiltDeltaBeta = angleDiffDeg(filteredBeta, lastTiltLookBeta);
    tiltDeltaGamma = filteredGamma - lastTiltLookGamma;
  }
  lastTiltLookBeta = filteredBeta;
  lastTiltLookGamma = filteredGamma;
}

// Returns whether it actually rotated the die this frame -- diceFrame()
// uses that to decide whether the scene is dirty and needs a real render,
// so a phone held rock-steady (nothing but sensor noise) doesn't force a
// GPU draw call every single frame for no visible change.
function updateTiltLook(dt) {
  if (dt <= 0) return false;
  // A rate-based deadzone (not an absolute-angle one): ignores sensor
  // jitter while genuinely still, but never blocks real movement
  // regardless of how far from "zero" the phone is currently held -- there
  // IS no zero here, only how much you're turning it right now, which is
  // exactly what makes holding a tilt hold a fixed view.
  const rateDegPerSec = Math.hypot(tiltDeltaBeta, tiltDeltaGamma) / dt;
  const gain = smoothstep(TILT_LOOK_DEADZONE_LOW_DEG_PER_SEC, TILT_LOOK_DEADZONE_HIGH_DEG_PER_SEC, rateDegPerSec);
  if (gain === 0) return false;
  rotateDieWorld(tiltDeltaBeta * gain, tiltDeltaGamma * gain); // 1:1 with the phone once past the ramp
  return true;
}

function lockIn() {
  frozen = true;
  lookUnlocked = false;
  lockRefBeta = filteredBeta;
  lockRefGamma = filteredGamma;
}

// The locked pose: restQuaternion plus a small, capped lean with the
// phone's tilt (see LOCK_PARALLAX_GAIN). Eases toward it rather than
// snapping, which is also what glides the die back onto its face after a
// look-around hold is released. Returns whether the die moved.
function updateLockedPose(dt) {
  const recenter = 1 - Math.exp(-dt / LOCK_REF_RECENTER_TAU);
  lockRefBeta += angleDiffDeg(filteredBeta, lockRefBeta) * recenter;
  lockRefGamma += (filteredGamma - lockRefGamma) * recenter;

  const leanBeta = angleDiffDeg(filteredBeta, lockRefBeta) * LOCK_PARALLAX_GAIN;
  const leanGamma = (filteredGamma - lockRefGamma) * LOCK_PARALLAX_GAIN;
  const leanDeg = Math.hypot(leanBeta, leanGamma);
  lockTargetQuat.copy(restQuaternion);
  if (leanDeg > 0) {
    const cappedDeg = Math.min(leanDeg, LOCK_PARALLAX_MAX_DEG);
    lookScratchAxis.set(leanBeta / leanDeg, leanGamma / leanDeg, 0);
    lookScratchQuat.setFromAxisAngle(lookScratchAxis, cappedDeg * DEG2RAD);
    lockTargetQuat.premultiply(lookScratchQuat);
  }

  if (diceMesh.quaternion.angleTo(lockTargetQuat) < LOCK_REST_EPSILON_RAD) return false;
  diceMesh.quaternion.slerp(lockTargetQuat, 1 - Math.exp(-dt / LOCK_FOLLOW_TAU));
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

function applyDragLook(dx, dy) {
  if (!diceMesh || rolling || settleState || (frozen && !lookUnlocked)) return;
  if (dx === 0 && dy === 0) return;
  // Same axis convention as updateTiltLook(): horizontal movement turns
  // the die around the vertical axis, vertical movement around the
  // horizontal axis.
  rotateDieWorld(dy * DRAG_LOOK_DEG_PER_PX, dx * DRAG_LOOK_DEG_PER_PX);
  forceRenderPending = true; // runs outside diceFrame()'s own dirty tracking
}

// Purely a visual readout of how far you've tilted since the die came to
// rest — no threshold, tilting never resumes spinning on its own. Only a
// held-and-shaken roll does that.
let lastEscapeFillHeight = 0;

// Fills vertically (bottom to top) rather than sweeping around the
// circumference: a rect clipped to the circle grows from the bottom.
// Rounded to 0.1 of the 0-100 viewBox and skipped when unchanged, so a
// steady phone doesn't force an SVG style/paint pass every frame.
function setEscapeFill(height) {
  const rounded = Math.round(height * 10) / 10;
  if (rounded === lastEscapeFillHeight) return;
  lastEscapeFillHeight = rounded;
  escapeRingFillEl.setAttribute("height", String(rounded));
  escapeRingFillEl.setAttribute("y", String(100 - rounded));
}

function updateFrozenFill() {
  const deltaBeta = angleDiffDeg(filteredBeta, frozenZeroBeta);
  const deltaGamma = filteredGamma - frozenZeroGamma;
  setEscapeFill(Math.min(Math.hypot(deltaBeta, deltaGamma) / TILT_VISUAL_RANGE_DEG, 1) * 100);
}

// A new roll/reveal cycle outlives any fanfare held from a previous
// natural 1/20 -- otherwise a stale glow could linger and misleadingly
// suggest the CURRENT face is still critical after settling onto a
// different one.
function clearResultCues() {
  viewfinderEl.classList.remove("is-critical-success", "is-critical-fail");
  sigilLayerEl.style.setProperty("--sigil-glow", "0");
  sigilLayerEl.style.setProperty("--sigil-glow-red", "0");
  setEscapeFill(0);
}

const CAMERA_DIR = new THREE.Vector3(0, 0, 1);
const faceScratchNormal = new THREE.Vector3();

function findNearestFaceIndex() {
  let bestIndex = 0;
  let bestDot = -Infinity;
  for (let i = 0; i < faceNormals.length; i++) {
    const dot = faceScratchNormal.copy(faceNormals[i]).applyQuaternion(diceMesh.quaternion).dot(CAMERA_DIR);
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
  clearResultCues();

  // Recalibrate the "level" reference right now, not after the settle
  // animation finishes — the moment you pause is what defines the new
  // resting center, so the level light and escape-threshold fill both reset
  // instantly rather than lagging ~300ms behind the pause.
  frozenZeroBeta = filteredBeta;
  frozenZeroGamma = filteredGamma;

  const nearestIndex = findNearestFaceIndex();
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
  const correctionQuat = new THREE.Quaternion().setFromUnitVectors(currentWorldNormal, CAMERA_DIR);
  const alignedQuat = correctionQuat.multiply(currentQuat);
  // On top of that minimal correction, twist around the camera axis so the
  // revealed number reads upright — locking always straightens the number,
  // even though the face-alignment step above deliberately preserves
  // whatever roll the die happened to have.
  const twist = uprightTwist(faceUpVectors[nearestIndex], alignedQuat, CAMERA_DIR);
  const finalQuat = applyRestTilt(twist.multiply(alignedQuat));

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
    lockIn();
  }
}

// The hold surface is the whole screen (not just the die itself), except
// for actual buttons — clicks on those should behave normally and not also
// arm the roll gate. Holding down doesn't reveal or move the die by
// itself; it only determines whether a shake that happens while held can
// actually roll it (see processShakeSample) — reflected live by the
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

  if (held) {
    holdStartedAt = performance.now();
  } else if (holdStartedAt !== null) {
    const durationMs = performance.now() - holdStartedAt;
    holdStartedAt = null;
    stats.holdCount++;
    stats.holdDurationSumMs += durationMs;
    if (durationMs > stats.holdDurationLongestMs) stats.holdDurationLongestMs = durationMs;
    saveStats();
    renderStatsPanel();
  }
}

// Tap-and-drag: a second way to "shake" the die, alongside physically
// shaking the phone, for anyone on a device without a working
// gyroscope/orientation sensor (desktop, denied permission) or who just
// prefers touch. Feeds the drag's own speed/direction into the EXACT same
// processShakeSample() pipeline a real device shake uses -- same
// accumulator, same redirect threshold, same direction-driven spin axis --
// rather than a separate roll path, so dragging genuinely IS "shaking it"
// as far as the roll logic is concerned, not a lookalike. The one
// deliberate difference is a much higher instant-spike bar (see
// DRAG_INSTANT_SPIKE_RATE_DEG_PER_SEC) -- a slow, deliberate hold-and-drag
// to look around every face shouldn't ever get mistaken for "a proper
// roll" just because one pointermove sample's computed rate spiked. Only
// produces samples while pointerHeld is true (the same "armed to roll"
// gate a real shake already requires), so a plain drag with nothing held
// down still can't roll the die.
let dragLastX = null;
let dragLastY = null;
let dragLastT = null;
// Screen-space px/s of drag speed -> synthetic deg/s of "rotation rate",
// fed to processShakeSample() with accumulate=false (see the call site) --
// so this only ever matters for the instant-spike check (against
// DRAG_INSTANT_SPIKE_RATE_DEG_PER_SEC, not the real-shake threshold),
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
  // A fresh press on a locked result unlocks a full look-around for as long
  // as it's held (see lookUnlocked).
  if (frozen) lookUnlocked = true;
  dragLastX = event.clientX;
  dragLastY = event.clientY;
  dragLastT = performance.now();
});

// Stats (including drag samples) are checkpointed by setPointerHeld(false)
// ending the hold, rather than on every pointermove sample.
function handlePointerRelease() {
  setPointerHeld(false);
  lookUnlocked = false; // a locked die eases back onto its face (see updateLockedPose())
  dragLastX = null;
  dragLastY = null;
  dragLastT = null;
  liveDragSpeedDegPerSec = null;
}

document.addEventListener("pointerup", handlePointerRelease);
// Leaving the app mid-hold never delivers the pointerup, and coming back
// shouldn't treat the time away as motion or stillness: drop the hold, and
// restart the frame clock, tilt reference, shake accumulator and stillness
// timer so the first frame back doesn't jump, roll or auto-reveal.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    handlePointerRelease();
    return;
  }
  lastDiceFrameAt = null;
  lastTiltLookBeta = null;
  lastMotionEventAt = null;
  rotationAccumDeg = 0;
  rotationAccumPeakRate = 0;
  stillSinceAt = null;
});
document.addEventListener("pointercancel", handlePointerRelease);

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
  recordDragSpeedSample(Math.abs(betaRate) + Math.abs(gammaRate));
  // accumulate=false: a sustained, gentle, one-directional drag (the whole
  // point of look-around -- see applyDragLook() above) must never build up
  // toward a roll just by continuing for a while. Only an unmistakably
  // hard, fast flick (instant-spike, against DRAG_INSTANT_SPIKE_RATE_DEG_
  // PER_SEC -- a deliberately higher bar than a real device shake needs,
  // since a slow hold-and-drag to view faces can otherwise throw one noisy
  // rate sample past a lower bar) can still launch or redirect one.
  processShakeSample(betaRate, gammaRate, false, DRAG_INSTANT_SPIKE_RATE_DEG_PER_SEC);
}, { passive: true }); // never calls preventDefault -- touch-action:none already owns gesture handling

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
  lookUnlocked = false;
  diceAnswerEl.textContent = "Rolling…";
  diceAnswerEl.classList.remove("is-revealed");
  diceAnswerEl.classList.add("is-veiled");
  statusIconPauseEl.setAttribute("hidden", "");
  clearResultCues();

  const intensityT = intensityFromPeakRate(peakRotationRate);
  const totalTurns = SHAKE_MIN_TURNS + intensityT * (SHAKE_MAX_TURNS - SHAKE_MIN_TURNS);

  // Non-random roll (see the toggle above) commits to whatever face is
  // already facing the camera instead of picking a fresh random one --
  // the same "current face" findNearestFaceIndex() reports for a
  // pause-reveal, just triggered by a shake instead of holding still.
  const resultIndex = nonRandomRoll ? findNearestFaceIndex() : Math.floor(Math.random() * faceNormals.length);
  // Lands the number upright -- the spin animation itself still looks
  // dynamic (driven by spinAxis/totalTurns below), only the final resting
  // orientation is fixed.
  const finalQuat = uprightFaceQuat(resultIndex);

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
    lookScratchQuat.setFromAxisAngle(rollState.spinAxis, angle);
    diceMesh.quaternion.copy(rollState.spinStartQuat).premultiply(lookScratchQuat);

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
    lockIn();
    frozenZeroBeta = filteredBeta;
    frozenZeroGamma = filteredGamma;
  }
}

// A shake that happens while NOT held can't roll the die (see
// processShakeSample) — instead it "pulls" the die a short distance toward
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
  const distance =
    (PULL_DISTANCE_MIN + intensityT * (PULL_DISTANCE_MAX - PULL_DISTANCE_MIN)) * (frozen ? LOCKED_PULL_SCALE : 1);

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
// negativeIntensity() uses its own, much flatter curve than the
// affirmative side's -- at 2.5, faces 5-8 (Maybe not: "Leans no" through
// "Almost certainly no") landed at just 0.006-0.18, reading as basically
// still-gold with no real red in them; only faces 1-2 showed any
// meaningful color. Dropping to 1 (linear) makes every face in the whole
// No/Maybe-not half show a clearly visible, proportional amount of red,
// not just the single most extreme face.
const NEGATIVE_GLOW_CURVE_EXPONENT = 1;

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
// for a non-negative one. Uses NEGATIVE_GLOW_CURVE_EXPONENT, not the
// shared affirmative one -- see its comment above.
function negativeIntensity(faceNumber) {
  if (faceNumber >= 9) return 0;
  return Math.pow((9 - faceNumber) / 8, NEGATIVE_GLOW_CURVE_EXPONENT);
}

// Whether the result was revealed by the phone going still (rather than a
// held-and-shaken roll) is shown as an icon in the viewfinder — a pause
// glyph — instead of text.
function finishRoll(index, revealedByPause) {
  rolling = false;
  restQuaternion.copy(diceMesh.quaternion); // what Recenter jumps back to after looking around
  const face = currentDie.faces[index];
  const faceNumber = face.number;
  // Glows, fanfare and face stats are all d20 concepts (the oracle phrases,
  // natural 1s and 20s); the other dice just show their number.
  const isOracle = currentDie.def.oracle === true;
  diceAnswerEl.textContent = face.phrase;
  // Restart the "materialise out of the mist" reveal (see .is-revealed in
  // style.css); the reflow makes re-adding the class replay it.
  diceAnswerEl.classList.remove("is-veiled", "is-revealed");
  void diceAnswerEl.offsetWidth;
  diceAnswerEl.classList.add("is-revealed");
  if (isOracle) {
    sigilLayerEl.style.setProperty("--sigil-glow", String(affirmativeIntensity(faceNumber)));
    sigilLayerEl.style.setProperty("--sigil-glow-red", String(negativeIntensity(faceNumber)));
  }

  if (revealedByPause) statusIconPauseEl.removeAttribute("hidden");
  else statusIconPauseEl.setAttribute("hidden", "");

  // Face-appearance stats only count genuine rolls -- a pause-reveal just
  // settles on whatever face happened to be facing the camera, not a
  // random outcome, so folding it into "how often does each face come up"
  // would skew the numbers toward whatever you last looked at.
  if (revealedByPause) {
    stats.totalPauseReveals++;
  } else if (isOracle) {
    stats.totalRolls++;
    stats.faceCounts[faceNumber] = (stats.faceCounts[faceNumber] || 0) + 1;
    if (faceNumber === 20) stats.natural20Count++;
    if (faceNumber === 1) stats.natural1Count++;
  }
  saveStats();
  renderStatsPanel();

  // Only an actual rolled result can be a "natural 1" or "natural 20" --
  // settling wherever the die happens to be facing when the phone goes
  // still isn't a roll outcome, so it never triggers fanfare.
  const critical = isOracle && !revealedByPause && (faceNumber === 20 || faceNumber === 1);
  if (critical) triggerFanfare(faceNumber === 20 ? "success" : "fail");

  if (navigator.vibrate) {
    try {
      if (critical && faceNumber === 20) navigator.vibrate([40, 30, 40, 30, 90]);
      else if (critical) navigator.vibrate([120, 60, 120]);
      else navigator.vibrate([30, 40, 30]);
    } catch {
      // ignore
    }
  }
}

// The viewfinder frame itself is always visible; only its color cues
// whether the die is currently frozen showing a revealed result (a
// separate concept from the lock icon, which reflects pointerHeld). The
// stage's is-locked/is-rolling drive the scrying-glass ambience in
// style.css. Packed into one bitmask and only written on change -- these
// used to be re-toggled every single frame.
let lastVisualStateMask = -1;

function syncVisualState() {
  const locked = frozen && !lookUnlocked;
  const mask = (frozen ? 1 : 0) | (locked ? 2 : 0) | (rolling ? 4 : 0);
  if (mask === lastVisualStateMask) return;
  lastVisualStateMask = mask;
  viewfinderEl.classList.toggle("is-frozen", frozen);
  stageEl.classList.toggle("is-locked", locked);
  stageEl.classList.toggle("is-rolling", rolling);
}

function diceFrame(now) {
  requestAnimationFrame(diceFrame);

  if (lastDiceFrameAt === null) {
    lastDiceFrameAt = now;
  }
  const dt = Math.min((now - lastDiceFrameAt) / 1000, 0.1); // clamp for tab-switch pauses
  lastDiceFrameAt = now;

  updateSensors(now, dt);
  sampleTiltDelta(now, dt);
  syncVisualState();

  let dirty;
  if (rollState) {
    updateRoll();
    dirty = true; // always advances the animation while active
  } else if (settleState) {
    updateSettle();
    dirty = true;
  } else if (frozen) {
    // Locked on the result: only a small lean with the phone, unless a
    // fresh hold has unlocked a full look-around (see lookUnlocked).
    // updateFrozenFill() is left out of the dirty check since it only ever
    // touches the SVG ring, never the 3D scene.
    updateFrozenFill();
    dirty = lookUnlocked ? updateTiltLook(dt) : updateLockedPose(dt);
  } else if (stillSinceAt !== null) {
    // A stillness attempt is in progress (see updatePauseDetection) --
    // hold the die exactly where it is rather than letting look-around
    // keep drifting it off whatever face was showing when the hold began.
    // This is the fix for the pause-reveal desync bug: without it, the
    // face that ends up revealed once the timer completes could differ
    // from the one that was actually facing the camera when the phone
    // first went still.
    dirty = false; // nothing touches the scene while held
  } else {
    dirty = updateTiltLook(dt); // false while steady/within the deadzone
  }

  // A pull (see pullDice()) moves diceMesh.position independently of
  // whatever rotation state above is also active, including the final
  // frame that springs it back to (0,0,0) -- so it's checked and OR'd in
  // separately rather than folded into the branches above.
  const pullWasActive = pullState !== null;
  updatePull();
  if (pullWasActive) dirty = true;

  // A freshly switched-in die grows into place (see setDieType()).
  if (dieAppearStartAt !== null) {
    const t = Math.min((now - dieAppearStartAt) / DIE_APPEAR_MS, 1);
    diceMesh.scale.setScalar(0.8 + 0.2 * easeOutCubic(t));
    if (t >= 1) dieAppearStartAt = null;
    dirty = true;
  }

  if (!settingsPanelEl.hidden) updateLiveStatValues();

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
  requestAnimationFrame(diceFrame);
}

// --- boot ---

startDiceRendering();
initOrientation();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
