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

const shapeEl = document.getElementById("shape");
const statusEl = document.getElementById("status");
const enableBtn = document.getElementById("enable-motion");

let currentShapeIndex = 0;

function setStatus(text) {
  statusEl.textContent = text;
}

function nextShape() {
  let index;
  do {
    index = Math.floor(Math.random() * SHAPES.length);
  } while (index === currentShapeIndex);
  currentShapeIndex = index;

  const shape = SHAPES[index];
  shapeEl.style.clipPath = shape.clipPath;
  shapeEl.classList.add("pulse");
  setTimeout(() => shapeEl.classList.remove("pulse"), 200);
  setStatus(`Shape: ${shape.name}`);
}

// --- movement detection ---

const MOVEMENT_THRESHOLD = 15; // sum of abs deltas across x/y/z, in m/s^2
const TRIGGER_COOLDOWN_MS = 400;

let lastX = null;
let lastY = null;
let lastZ = null;
let lastTriggerAt = 0;

function handleMotion(event) {
  const acc = event.accelerationIncludingGravity || event.acceleration;
  if (!acc || acc.x === null) return;

  const { x, y, z } = acc;

  if (lastX === null) {
    lastX = x;
    lastY = y;
    lastZ = z;
    return;
  }

  const delta = Math.abs(x - lastX) + Math.abs(y - lastY) + Math.abs(z - lastZ);
  lastX = x;
  lastY = y;
  lastZ = z;

  const now = Date.now();
  if (delta > MOVEMENT_THRESHOLD && now - lastTriggerAt > TRIGGER_COOLDOWN_MS) {
    lastTriggerAt = now;
    nextShape();
  }
}

function startMotionListening() {
  window.addEventListener("devicemotion", handleMotion);
  setStatus("Listening for movement…");
}

function initMotion() {
  if (typeof DeviceMotionEvent === "undefined") {
    setStatus("This device doesn't support motion detection.");
    return;
  }

  // iOS 13+ requires an explicit user gesture to grant motion access.
  if (typeof DeviceMotionEvent.requestPermission === "function") {
    enableBtn.hidden = false;
    setStatus("Tap the button to enable motion detection");
    enableBtn.addEventListener("click", async () => {
      try {
        const result = await DeviceMotionEvent.requestPermission();
        if (result === "granted") {
          enableBtn.hidden = true;
          startMotionListening();
        } else {
          setStatus("Motion permission denied.");
        }
      } catch (err) {
        setStatus("Could not request motion permission.");
      }
    });
  } else {
    startMotionListening();
  }
}

initMotion();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
