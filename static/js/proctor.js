/**
 * proctor.js — AI Interview Coach
 * ================================
 * Client-side proctoring panel using MediaPipe Tasks Vision (WASM/JS).
 * All processing happens in the browser — no video is ever sent to a server.
 *
 * What it does:
 *   1. Requests webcam access and streams video into #proctorVideo.
 *   2. Runs MediaPipe FaceLandmarker, PoseLandmarker, and HandLandmarker on animation frames.
 *   3. If no face is detected for > ABSENT_THRESHOLD_MS (3 s), it:
 *        - Pauses the interview timers (global + per-question).
 *        - Disables the Submit Answer button.
 *        - Shows the #proctorWarning overlay.
 *        - Speaks a TTS warning (rate-limited to once every 6 s).
 *   4. When a face is detected again it immediately:
 *        - Resumes timers.
 *        - Re-enables Submit.
 *        - Hides the overlay.
 *   5. Tracks body language metrics (Presence, Eye Contact/Gaze, Posture, Hand Stillness).
 *   6. Draws face detection box on #proctorCanvas while face is present.
 *
 * Integration contract (functions called on interview.js):
 *   window._proctor_pauseTimers()   — defined below, called internally
 *   window._proctor_resumeTimers()  — defined below, called internally
 *   interview.js exposes nothing extra; proctor patches the timer ticks.
 *
 * Dependencies (CDN, dynamic ESM import):
 *   @mediapipe/tasks-vision 0.10.x
 */

'use strict';

/* ─── Config ────────────────────────────────────────────────────────────── */
const ABSENT_THRESHOLD_MS = 3000;   // ms before warning triggers
const TTS_COOLDOWN_MS = 6000;       // ms between repeated TTS warnings
const WARNING_MESSAGE = 'Please remain in front of the camera to continue the interview.';

/* ─── State ─────────────────────────────────────────────────────────────── */
let _faceLandmarker = null;
let _handLandmarker = null;
let _poseLandmarker = null;
let _stream = null;
let _lastSeenFaceAt = Date.now();   // timestamp of last successful detection
let _isAbsent = false;              // true while no face present > threshold
let _lastTtsAt = 0;                  // timestamp of last TTS warning
let _rafId = null;                  // requestAnimationFrame handle
let _initialized = false;

/* ─── Body language frame state ─────────────────────────────────────────── */
let _currentFaceLandmarks = null;
let _currentPoseLandmarks = null;
let _currentHandLandmarks = null;

/* ─── Metrics sampling counters ─────────────────────────────────────────── */
// We sample every PRESENCE_SAMPLE_MS ms whether metrics criteria are met.
const PRESENCE_SAMPLE_MS = 500;     // sample every 500 ms
let _presenceTotalSamples = 0;
let _presenceFaceSamples = 0;

let _gazeFaceSamples = 0;
let _gazeGoodSamples = 0;

let _posturePoseSamples = 0;
let _postureGoodSamples = 0;

let _handSamples = 0;

let _presenceSampleTick = null;     // setInterval handle
let _absenceLog = [];               // array of { start, end, durationMs }
let _currentAbsenceStart = null;     // timestamp when current absence began

/** Return presence confidence as a 0-100 number (one decimal place). */
function getPresenceScore() {
  if (_presenceTotalSamples === 0) return 100;
  const pct = (_presenceFaceSamples / _presenceTotalSamples) * 100;
  return parseFloat(Math.max(0, Math.min(100, pct)).toFixed(1));
}

/** Return eye contact (gaze) score as a 0-100 number (one decimal place). */
function getGazeScore() {
  if (_gazeFaceSamples === 0) return 100;
  const pct = (_gazeGoodSamples / _gazeFaceSamples) * 100;
  return parseFloat(Math.max(0, Math.min(100, pct)).toFixed(1));
}

/** Return posture score as a 0-100 number (one decimal place). */
function getPostureScore() {
  if (_posturePoseSamples === 0) return 100;
  const pct = (_postureGoodSamples / _posturePoseSamples) * 100;
  return parseFloat(Math.max(0, Math.min(100, pct)).toFixed(1));
}

/** Return hand stillness score as a 0-100 number (one decimal place). */
function getHandStillnessScore() {
  if (_presenceTotalSamples === 0) return 100;
  const pct = 100 - ((_handSamples / _presenceTotalSamples) * 100);
  return parseFloat(Math.max(0, Math.min(100, pct)).toFixed(1));
}

/** Return a copy of the absence log entries. */
function getAbsenceLog() {
  return [..._absenceLog];
}

/* ─── Detection math ────────────────────────────────────────────────────── */

/** Gaze (eye contact) detection using 478-point face mesh landmarks */
function isFacingForward(landmarks) {
  if (!landmarks || landmarks.length < 473) return false;
  const rightEyeOuter = landmarks[33];
  const rightEyeInner = landmarks[133];
  const irisLandmarks = landmarks.slice(468, 473);
  if (!rightEyeOuter || !rightEyeInner || irisLandmarks.length < 5) return false;

  const irisCenter = irisLandmarks.reduce(
    (acc, cur) => ({ x: acc.x + cur.x, y: acc.y + cur.y }),
    { x: 0, y: 0 }
  );
  irisCenter.x /= irisLandmarks.length;
  irisCenter.y /= irisLandmarks.length;

  const AB = { x: rightEyeInner.x - rightEyeOuter.x, y: rightEyeInner.y - rightEyeOuter.y };
  const AI = { x: irisCenter.x - rightEyeOuter.x, y: irisCenter.y - rightEyeOuter.y };
  const dot = AI.x * AB.x + AI.y * AB.y;
  const norm2 = AB.x * AB.x + AB.y * AB.y;
  if (norm2 === 0) return false;

  const t = dot / norm2;
  return t >= 0.4 && t <= 0.6;
}

/** Posture detection using BlazePose 33-point landmarks */
function isBadPosture(landmarks) {
  const head = landmarks[0];
  const leftShoulder = landmarks[11];
  const rightShoulder = landmarks[12];
  if (!head || !leftShoulder || !rightShoulder) return false;

  const midShoulders = {
    x: (leftShoulder.x + rightShoulder.x) / 2,
    y: (leftShoulder.y + rightShoulder.y) / 2,
  };
  const dx = head.x - midShoulders.x;
  const dy = head.y - midShoulders.y;
  const distance = Math.sqrt(dx * dx + dy * dy);
  return distance < 0.3;
}

/* ─── Sampler ───────────────────────────────────────────────────────────── */

function _startPresenceSampler() {
  if (_presenceSampleTick) return;
  _presenceSampleTick = setInterval(() => {
    _presenceTotalSamples++;

    // Presence
    if (!_isAbsent) {
      _presenceFaceSamples++;
    }

    // Gaze
    if (_currentFaceLandmarks) {
      _gazeFaceSamples++;
      if (isFacingForward(_currentFaceLandmarks)) {
        _gazeGoodSamples++;
      }
    }

    // Posture
    if (_currentPoseLandmarks) {
      _posturePoseSamples++;
      if (!isBadPosture(_currentPoseLandmarks)) {
        _postureGoodSamples++;
      }
    }

    // Hands
    if (_currentHandLandmarks && _currentHandLandmarks.length > 0) {
      _handSamples++;
    }

    // Update sidebar display
    _updatePresenceDisplay();
  }, PRESENCE_SAMPLE_MS);
}

function _stopPresenceSampler() {
  if (_presenceSampleTick) {
    clearInterval(_presenceSampleTick);
    _presenceSampleTick = null;
  }
}

function _updatePresenceDisplay() {
  // Presence
  const pScoreEl = document.getElementById('proctorPresenceScore');
  if (pScoreEl) pScoreEl.textContent = getPresenceScore() + '%';
  const pBar = document.getElementById('proctorPresenceBar');
  if (pBar) pBar.style.width = getPresenceScore() + '%';

  // Eye Contact
  const gScoreEl = document.getElementById('proctorGazeScore');
  if (gScoreEl) gScoreEl.textContent = getGazeScore() + '%';
  const gBar = document.getElementById('proctorGazeBar');
  if (gBar) gBar.style.width = getGazeScore() + '%';

  // Posture
  const posScoreEl = document.getElementById('proctorPostureScore');
  if (posScoreEl) posScoreEl.textContent = getPostureScore() + '%';
  const posBar = document.getElementById('proctorPostureBar');
  if (posBar) posBar.style.width = getPostureScore() + '%';

  // Hand Stillness
  const hScoreEl = document.getElementById('proctorHandScore');
  if (hScoreEl) hScoreEl.textContent = getHandStillnessScore() + '%';
  const hBar = document.getElementById('proctorHandBar');
  if (hBar) hBar.style.width = getHandStillnessScore() + '%';
}

/* ─── DOM refs (resolved after DOMContentLoaded) ─────────────────────── */
let $video, $canvas, $ctx, $statusDot, $statusText, $warningBanner, $submitBtn;

/* ─── Timer pause hooks ─────────────────────────────────────────────────── */
function _pauseTimers() {
  if (typeof window._interviewPauseTimers === 'function') {
    window._interviewPauseTimers();
  }
}
function _resumeTimers() {
  if (typeof window._interviewResumeTimers === 'function') {
    window._interviewResumeTimers();
  }
}

/* ─── TTS helper ────────────────────────────────────────────────────────── */
function _speakWarning() {
  const now = Date.now();
  if (now - _lastTtsAt < TTS_COOLDOWN_MS) return;
  _lastTtsAt = now;

  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel();

  const utt = new SpeechSynthesisUtterance(WARNING_MESSAGE);
  utt.rate = 0.9;
  utt.pitch = 1.0;
  utt.volume = 1;

  const voices = speechSynthesis.getVoices();
  const preferred = voices.find(v => v.name.includes('Google') && v.lang.startsWith('en'))
    || voices.find(v => v.lang === 'en-US')
    || voices[0];
  if (preferred) utt.voice = preferred;

  speechSynthesis.speak(utt);
}

/* ─── UI helpers ─────────────────────────────────────────────────────────── */
function _setAbsent(absent) {
  if (_isAbsent === absent) return;   // no change — skip DOM work
  _isAbsent = absent;

  if (absent) {
    // Log absence start
    _currentAbsenceStart = Date.now();

    // Pause interview
    _pauseTimers();
    if ($submitBtn) $submitBtn.disabled = true;
    if ($warningBanner) $warningBanner.style.display = 'flex';
    const ao = document.getElementById('proctorAbsentOverlay');
    if (ao) ao.classList.add('visible');
    if ($statusDot) { $statusDot.style.background = 'var(--danger)'; $statusDot.style.boxShadow = '0 0 8px var(--danger)'; }
    if ($statusText) { $statusText.textContent = 'No face detected'; $statusText.style.color = 'var(--danger)'; }
    _speakWarning();
    console.warn('[proctor] Face absent — interview paused. Total absences:', _absenceLog.length + 1);
  } else {
    // Log absence end
    if (_currentAbsenceStart !== null) {
      const end = Date.now();
      _absenceLog.push({
        start: new Date(_currentAbsenceStart).toISOString(),
        end: new Date(end).toISOString(),
        durationMs: end - _currentAbsenceStart,
      });
      _currentAbsenceStart = null;
    }

    // Resume interview
    _resumeTimers();
    // Only re-enable submit if the answer card is actually visible
    const answerCard = document.getElementById('answerCard');
    if ($submitBtn && answerCard && answerCard.style.display !== 'none') {
      $submitBtn.disabled = false;
    }
    if ($warningBanner) $warningBanner.style.display = 'none';
    const ao2 = document.getElementById('proctorAbsentOverlay');
    if (ao2) ao2.classList.remove('visible');
    if ($statusDot) { $statusDot.style.background = 'var(--success)'; $statusDot.style.boxShadow = '0 0 8px var(--success)'; }
    if ($statusText) { $statusText.textContent = 'Face detected'; $statusText.style.color = 'var(--success)'; }
    console.info('[proctor] Face resumed — interview active. Presence score:', getPresenceScore() + '%');
  }
}

/* ─── Canvas drawing ─────────────────────────────────────────────────────── */
function _drawDetections(landmarks) {
  if (!$canvas || !$ctx || !$video) return;

  $canvas.width = $video.videoWidth || $canvas.offsetWidth;
  $canvas.height = $video.videoHeight || $canvas.offsetHeight;
  $ctx.clearRect(0, 0, $canvas.width, $canvas.height);

  if (!landmarks || landmarks.length === 0) return;

  let minX = 1, minY = 1, maxX = 0, maxY = 0;
  landmarks.forEach(pt => {
    if (pt.x < minX) minX = pt.x;
    if (pt.x > maxX) maxX = pt.x;
    if (pt.y < minY) minY = pt.y;
    if (pt.y > maxY) maxY = pt.y;
  });

  const vw = $canvas.width;
  const vh = $canvas.height;
  const x = minX * vw;
  const y = minY * vh;
  const w = (maxX - minX) * vw;
  const h = (maxY - minY) * vh;
  const r = 8;

  // Rounded rect in accent colour
  $ctx.strokeStyle = 'rgba(99,102,241,0.85)';
  $ctx.lineWidth = 2;
  $ctx.beginPath();
  $ctx.moveTo(x + r, y);
  $ctx.lineTo(x + w - r, y);
  $ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  $ctx.lineTo(x + w, y + h - r);
  $ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  $ctx.lineTo(x + r, y + h);
  $ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  $ctx.lineTo(x, y + r);
  $ctx.quadraticCurveTo(x, y, x + r, y);
  $ctx.closePath();
  $ctx.stroke();

  // Corner accent marks
  const cl = 10;
  $ctx.strokeStyle = '#6366f1';
  $ctx.lineWidth = 3;
  [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]].forEach(([cx, cy, dx, dy]) => {
    $ctx.beginPath();
    $ctx.moveTo(cx + dx * cl, cy); $ctx.lineTo(cx, cy); $ctx.lineTo(cx, cy + dy * cl);
    $ctx.stroke();
  });
}

/* ─── MediaPipe initialisation ──────────────────────────────────────────── */
async function _initMediaPipe() {
  try {
    const visionModule = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21');
    const { FilesetResolver, FaceLandmarker, HandLandmarker, PoseLandmarker } = visionModule;
    const vision = await FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm'
    );

    _faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'
      },
      runningMode: 'VIDEO',
      numFaces: 1,
    });

    // Lazily/asynchronously initialize hand and pose landmarker to ensure fast camera launch
    HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'
      },
      runningMode: 'VIDEO',
      numHands: 2,
    }).then(hl => { _handLandmarker = hl; }).catch(err => console.warn('[proctor] HandLandmarker load error:', err));

    PoseLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task'
      },
      runningMode: 'VIDEO',
      numPoses: 1,
    }).then(pl => { _poseLandmarker = pl; }).catch(err => console.warn('[proctor] PoseLandmarker load error:', err));

    return true;
  } catch (err) {
    console.warn('[proctor] MediaPipe initialization error:', err);
    _showUnavailable('MediaPipe load failed. Refresh the page.');
    return false;
  }
}

/* ─── Webcam access ─────────────────────────────────────────────────────── */
async function _startCamera() {
  try {
    _stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 320 }, height: { ideal: 240 }, facingMode: 'user' },
      audio: false,
    });
    $video.srcObject = _stream;
    await new Promise(resolve => { $video.onloadedmetadata = resolve; });
    await $video.play();
    return true;
  } catch (err) {
    console.warn('[proctor] Camera error:', err.name, err.message);
    const msgs = {
      NotAllowedError: 'Camera access denied. Allow camera in browser settings.',
      NotFoundError: 'No camera found. Connect a webcam to enable proctoring.',
      NotReadableError: 'Camera is in use by another app.',
    };
    _showUnavailable(msgs[err.name] || `Camera error: ${err.message}`);
    return false;
  }
}

/* ─── Detection loop ────────────────────────────────────────────────────── */
function _detectionLoop() {
  if (!_faceLandmarker || !$video || $video.readyState < 2) {
    _rafId = requestAnimationFrame(_detectionLoop);
    return;
  }

  const nowMs = performance.now();
  const now = Date.now();

  try {
    const faceResult = _faceLandmarker.detectForVideo($video, nowMs);
    const hasFace = faceResult && faceResult.faceLandmarks && faceResult.faceLandmarks.length > 0;

    if (hasFace) {
      _currentFaceLandmarks = faceResult.faceLandmarks[0];
      _lastSeenFaceAt = now;
      _setAbsent(false);
      _drawDetections(_currentFaceLandmarks);
    } else {
      _currentFaceLandmarks = null;
      _drawDetections(null);
      if (!_isAbsent && (now - _lastSeenFaceAt) >= ABSENT_THRESHOLD_MS) {
        _setAbsent(true);
      }
      if (_isAbsent) {
        _speakWarning();
      }
    }

    if (_poseLandmarker) {
      const poseResult = _poseLandmarker.detectForVideo($video, nowMs);
      _currentPoseLandmarks = (poseResult && poseResult.landmarks && poseResult.landmarks.length > 0)
        ? poseResult.landmarks[0]
        : null;
    }

    if (_handLandmarker) {
      const handResult = _handLandmarker.detectForVideo($video, nowMs);
      _currentHandLandmarks = (handResult && handResult.landmarks && handResult.landmarks.length > 0)
        ? handResult.landmarks
        : null;
    }

  } catch (_) {
    /* ignore single-frame errors */
  }

  _rafId = requestAnimationFrame(_detectionLoop);
}

/* ─── Unavailable state ─────────────────────────────────────────────────── */
function _showUnavailable(msg) {
  const panel = document.getElementById('proctorPanel');
  if (!panel) return;

  const body = panel.querySelector('.proctor-body');
  if (body) {
    body.innerHTML = `
      <div style="text-align:center;padding:1.2rem 0.5rem">
        <div style="font-size:2rem;margin-bottom:0.6rem">📵</div>
        <div style="font-size:0.8rem;color:var(--muted);line-height:1.5">${msg}</div>
        <div style="font-size:0.72rem;color:var(--muted);margin-top:0.5rem;opacity:0.6">Interview continues without proctoring.</div>
      </div>`;
  }
  if ($statusDot) { $statusDot.style.background = 'var(--muted)'; $statusDot.style.boxShadow = 'none'; }
  if ($statusText) { $statusText.textContent = 'Unavailable'; }
}

/* ─── Public init ───────────────────────────────────────────────────────── */
async function initProctor() {
  if (_initialized) return;
  _initialized = true;

  // Resolve DOM refs
  $video = document.getElementById('proctorVideo');
  $canvas = document.getElementById('proctorCanvas');
  $statusDot = document.getElementById('proctorStatusDot');
  $statusText = document.getElementById('proctorStatusText');
  $warningBanner = document.getElementById('proctorWarning');
  $submitBtn = document.getElementById('submitBtn');
  $ctx = $canvas ? $canvas.getContext('2d') : null;

  if (!$video || !$canvas) {
    console.warn('[proctor] Proctor DOM elements not found.');
    return;
  }

  // Check mediaDevices API
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    _showUnavailable('Your browser does not support camera access. Use Chrome or Edge on localhost/HTTPS.');
    return;
  }

  // Status: initialising
  if ($statusText) $statusText.textContent = 'Starting camera…';

  const cameraOk = await _startCamera();
  if (!cameraOk) return;

  if ($statusText) $statusText.textContent = 'Loading detector…';

  const mpOk = await _initMediaPipe();
  if (!mpOk) return;

  // Pre-load voices
  if (window.speechSynthesis) {
    speechSynthesis.getVoices();
    speechSynthesis.addEventListener('voiceschanged', () => speechSynthesis.getVoices());
  }

  // Mark active
  if ($statusDot) { $statusDot.style.background = 'var(--success)'; $statusDot.style.boxShadow = '0 0 8px var(--success)'; }
  if ($statusText) { $statusText.textContent = 'Proctoring active'; $statusText.style.color = 'var(--success)'; }

  _lastSeenFaceAt = Date.now();
  _startPresenceSampler();
  _detectionLoop();
}

/* ─── Cleanup (called by finishInterview / confirmExit in interview.js) ── */
function stopProctor() {
  // Close out any in-progress absence
  if (_isAbsent && _currentAbsenceStart !== null) {
    const end = Date.now();
    _absenceLog.push({
      start: new Date(_currentAbsenceStart).toISOString(),
      end: new Date(end).toISOString(),
      durationMs: end - _currentAbsenceStart,
    });
    _currentAbsenceStart = null;
  }

  _stopPresenceSampler();
  if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
  if (_stream) { _stream.getTracks().forEach(t => t.stop()); _stream = null; }
  if (_faceLandmarker) { _faceLandmarker.close(); _faceLandmarker = null; }
  if (_handLandmarker) { _handLandmarker.close(); _handLandmarker = null; }
  if (_poseLandmarker) { _poseLandmarker.close(); _poseLandmarker = null; }

  console.info(
    '[proctor] Stopped. Final presence score:', getPresenceScore() + '%',
    '| Gaze:', getGazeScore() + '%',
    '| Posture:', getPostureScore() + '%',
    '| Hand Stillness:', getHandStillnessScore() + '%',
    '| Absences:', _absenceLog.length,
    '| Log:', _absenceLog
  );
}

/* ─── Expose on window for interview.js integration ─────────────────────── */
window.initProctor = initProctor;
window.stopProctor = stopProctor;
window.getPresenceScore = getPresenceScore;
window.getAbsenceLog = getAbsenceLog;
window.getGazeScore = getGazeScore;
window.getPostureScore = getPostureScore;
window.getHandStillnessScore = getHandStillnessScore;

/* ─── Boot ──────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  // Small delay so interview.js finishes its own DOMContentLoaded first
  setTimeout(initProctor, 400);
});
