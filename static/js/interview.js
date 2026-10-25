/**
 * interview.js — AI Interview Coach
 *
 * Owns the entire live-interview page lifecycle:
 *   • Read ?id= param and validate session
 *   • Display candidate session info from sessionStorage
 *   • Global interview timer (elapsed, shown in nav)
 *   • Per-question timer (shown below speech bubble)
 *   • Progress bar (fills as questions are answered)
 *   • Fetch next question from /api/generate_question
 *   • Display question + type badge + hints in sidebar
 *   • Tab switching: text input ↔ voice input
 *   • Speech Recognition (Web Speech API, continuous, interim results)
 *   • Char count for text textarea
 *   • Submit answer → /api/evaluate_answer
 *   • Render 5-dimension score rings + strengths / weaknesses / suggestions
 *   • Update sidebar history list and running averages
 *   • Next Question / Skip Question flow
 *   • Finish Interview → /api/complete_interview → completion overlay
 *   • Redirect to /report/<id> from the overlay button
 *   • confirmExit() for the ✕ Exit nav button
 *   • Calls avatar.js globals: speakText(), setAvatarTalking(),
 *     setBubble(), setBubbleLoading(), showHappyExpression(),
 *     showThinkingExpression(), replayTTS()
 *   • Calls main.js globals: toggleTheme(), showToast(), fmtTime()
 *
 * All functions that are referenced by HTML onclick= attributes are
 * intentionally kept on the global scope (no ES-module wrapper).
 */

'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   CONSTANTS
   ───────────────────────────────────────────────────────────────────────── */

const TOTAL_QUESTIONS = 10;   // total questions per interview session
const FINISH_EARLY_AT = 8;    // show "Finish Interview" button from Q8 onward

/* ─────────────────────────────────────────────────────────────────────────────
   SESSION STATE
   ───────────────────────────────────────────────────────────────────────── */

// Parsed from the URL query string (?id=N)
const _params      = new URLSearchParams(window.location.search);
const _interviewId = _params.get('id');

// Increments from 1 to TOTAL_QUESTIONS
let _currentQ = 0;

// The most recent question object returned by the API:
// { question, type, hints, question_number }
let _currentQData = null;

// Accumulates { question, answer } pairs for the "previous_answers" context
// sent to /api/generate_question so it can adapt difficulty.
let _previousAnswers = [];

// Running score arrays, keyed by dimension name, used for sidebar averages.
const _runningScores = {
  technical:     [],
  communication: [],
  confidence:    [],
  relevance:     [],
  completeness:  [],
};

/* ─────────────────────────────────────────────────────────────────────────────
   TIMER STATE
   ───────────────────────────────────────────────────────────────────────── */

let _globalSec  = 0;   // total elapsed seconds for the whole interview
let _qSec       = 0;   // elapsed seconds for the current question
let _globalTick = null;
let _qTick      = null;

/* ─────────────────────────────────────────────────────────────────────────────
   SPEECH RECOGNITION STATE
   ───────────────────────────────────────────────────────────────────────── */

let _recognition  = null;  // SpeechRecognition instance (created lazily)
let _isRecording  = false; // true while the mic is actively capturing

/* ─────────────────────────────────────────────────────────────────────────────
   TINY DOM HELPER
   ───────────────────────────────────────────────────────────────────────── */

/** @param {string} id @returns {HTMLElement|null} */
function $id(id) { return document.getElementById(id); }

/* ─────────────────────────────────────────────────────────────────────────────
   THEME — delegate to main.js global
   ───────────────────────────────────────────────────────────────────────── */

// toggleTheme() is already global from main.js; the HTML onclick calls it directly.
// We only need to sync the icon on page load.
(function _syncThemeIcon() {
  const stored = localStorage.getItem('theme') || 'dark';
  document.documentElement.setAttribute('data-theme', stored);
  const btn = $id('themeToggle');
  if (btn) btn.textContent = stored === 'dark' ? '🌙' : '☀️';
})();

/* ─────────────────────────────────────────────────────────────────────────────
   GLOBAL TIMER
   ───────────────────────────────────────────────────────────────────────── */

/** Start the nav-bar elapsed-time counter. */
function _startGlobalTimer() {
  _globalSec = 0;
  clearInterval(_globalTick);
  _globalTick = setInterval(() => {
    _globalSec++;
    const el = $id('globalTimer');
    if (el) el.textContent = _fmtTime(_globalSec);
  }, 1000);
}

/** Stop both timers (called on finish or exit). */
function _stopAllTimers() {
  clearInterval(_globalTick);
  clearInterval(_qTick);
  _globalTick = null;
  _qTick      = null;
}

/* ─── Proctor timer-pause API (called by proctor.js) ──────────────────── */
// Snapshot of tick intervals saved while paused so they can be resumed exactly
let _pausedGlobalSec = null;
let _pausedQSec      = null;

/**
 * Pause both running timers without losing their current counts.
 * Exposed on window so proctor.js (loaded after interview.js) can call it.
 */
window._interviewPauseTimers = function () {
  if (_globalTick) { clearInterval(_globalTick); _globalTick = null; }
  if (_qTick)      { clearInterval(_qTick);      _qTick      = null; }
};

/**
 * Resume timers from wherever they left off.
 * Re-creates the setInterval ticks with the current counter values.
 */
window._interviewResumeTimers = function () {
  // Resume global timer only if it is not already running
  if (!_globalTick) {
    _globalTick = setInterval(() => {
      _globalSec++;
      const el = document.getElementById('globalTimer');
      if (el) el.textContent = _fmtTime(_globalSec);
    }, 1000);
  }
  // Resume per-question timer only if it is not already running
  if (!_qTick) {
    _qTick = setInterval(() => {
      _qSec++;
      const el2 = document.getElementById('qTimer');
      if (el2) el2.textContent = _fmtTime(_qSec);
    }, 1000);
  }
};



/* ─────────────────────────────────────────────────────────────────────────────
   PER-QUESTION TIMER
   ───────────────────────────────────────────────────────────────────────── */

/** Reset and restart the per-question stopwatch shown below the speech bubble. */
function _resetQTimer() {
  clearInterval(_qTick);
  _qSec = 0;
  const el = $id('qTimer');
  if (el) el.textContent = '00:00';

  _qTick = setInterval(() => {
    _qSec++;
    const el2 = $id('qTimer');
    if (el2) el2.textContent = _fmtTime(_qSec);
  }, 1000);
}

/* ─────────────────────────────────────────────────────────────────────────────
   FORMAT TIME — uses main.js fmtTime if available, else local fallback
   ───────────────────────────────────────────────────────────────────────── */

function _fmtTime(totalSec) {
  if (typeof fmtTime === 'function') return fmtTime(totalSec);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/* ─────────────────────────────────────────────────────────────────────────────
   PROGRESS BAR
   ───────────────────────────────────────────────────────────────────────── */

/**
 * Update the progress bar fill width and the "Question N of 10" label.
 * Called before loading each question.
 */
function _updateProgress() {
  // Fill represents questions *completed*, so use currentQ - 1 completed.
  const pct  = ((_currentQ - 1) / TOTAL_QUESTIONS) * 100;
  const fill = $id('progressFill');
  const text = $id('progressText');
  if (fill) fill.style.width = `${pct}%`;
  if (text) text.textContent = `Question ${_currentQ} of ${TOTAL_QUESTIONS}`;
}

/* ─────────────────────────────────────────────────────────────────────────────
   SESSION INFO SIDEBAR
   ───────────────────────────────────────────────────────────────────────── */

/** Populate the right-sidebar session card from sessionStorage metadata. */
function _populateSessionInfo() {
  const raw = sessionStorage.getItem('interview_meta');
  if (!raw) return;

  let meta;
  try { meta = JSON.parse(raw); } catch { return; }

  const card = $id('sessionInfo');
  if (card) card.style.display = 'block';

  const nameEl = $id('sessionName');
  const roleEl = $id('sessionRole');
  const expEl  = $id('sessionExp');
  if (nameEl) nameEl.textContent = meta.name || '—';
  if (roleEl) roleEl.textContent = meta.role || '—';
  if (expEl)  expEl.textContent  = meta.exp  || '—';
}

/* ─────────────────────────────────────────────────────────────────────────────
   LOAD NEXT QUESTION
   ───────────────────────────────────────────────────────────────────────── */

/**
 * Increment the question counter, reset the UI, fetch the next question from
 * Flask, then display it and trigger TTS.
 * If we've exceeded TOTAL_QUESTIONS, call finishInterview() instead.
 */
async function loadNextQuestion() {
  _currentQ++;

  if (_currentQ > TOTAL_QUESTIONS) {
    finishInterview();
    return;
  }

  // ── Reset UI for the incoming question ──────────────────────────────────
  _updateProgress();

  // Avatar loading state
  if (typeof setBubbleLoading === 'function') setBubbleLoading();
  if (typeof setAvatarTalking === 'function') setAvatarTalking(false);
  if (typeof showThinkingExpression === 'function') showThinkingExpression();

  // Hide cards that belong to the previous question
  _setVisible('questionCard', false);
  _setVisible('answerCard',   false);
  _hideFeedback();

  // Clear both answer textareas
  const ta1 = $id('answerText');
  const ta2 = $id('answerText2');
  if (ta1) ta1.value = '';
  if (ta2) ta2.value = '';
  _updateCharCount(0);

  // Reset to text tab
  switchTab('text');

  // Hide hints until new ones arrive
  _setVisible('hintsCard', false);

  // Show "Finish Interview" button once we reach FINISH_EARLY_AT
  if (_currentQ >= FINISH_EARLY_AT) {
    const finBtn = $id('finishBtn');
    if (finBtn) finBtn.classList.add('visible');
  }

  // ── API call ─────────────────────────────────────────────────────────────
  let data;
  try {
    const res = await fetch('/api/generate_question', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        interview_id:     _interviewId,
        question_number:  _currentQ,
        previous_answers: _previousAnswers,
      }),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    data = await res.json();

    if (data.error) throw new Error(data.error);

  } catch (err) {
    console.error('[interview.js] generate_question error:', err);
    if (typeof setBubble === 'function') {
      setBubble('⚠️ Failed to load question. Please check your connection and try again.');
    }
    if (typeof showToast === 'function') showToast('Failed to load question.', 'error');
    return;
  }

  _currentQData = data;

  // ── Populate question card ────────────────────────────────────────────────
  const badge = $id('qTypeBadge');
  if (badge) {
    badge.textContent = data.type || 'General';
    badge.className   = `q-badge ${data.type || 'General'}`;
  }

  const qNumEl = $id('qNumber');
  if (qNumEl) qNumEl.textContent = `Q${_currentQ}`;

  const qTextEl = $id('questionText');
  if (qTextEl) qTextEl.textContent = data.question || '';

  // ── Hints sidebar ─────────────────────────────────────────────────────────
  if (data.hints && data.hints.length) {
    const hintsList = $id('hintsList');
    if (hintsList) {
      hintsList.innerHTML = data.hints
        .map((h) => `<div class="hint-item">${_escHtml(h)}</div>`)
        .join('');
    }
    _setVisible('hintsCard', true);
  }

  // ── Show the question + answer cards ─────────────────────────────────────
  _setVisible('questionCard', true);
  _setVisible('answerCard',   true);

  // ── Update the avatar speech bubble and speak the question ────────────────
  if (typeof setBubble === 'function') setBubble(_escHtml(data.question));
  if (typeof speakText === 'function') speakText(data.question);

  // ── Start per-question timer ───────────────────────────────────────────────
  _resetQTimer();

  // ── Re-attach char-count listener (textarea may have been replaced) ───────
  _attachCharCountListener();
}

/* ─────────────────────────────────────────────────────────────────────────────
   TAB SWITCHING — text vs voice
   ───────────────────────────────────────────────────────────────────────── */

/**
 * Switch the answer input between "Type Answer" and "Voice Answer" tabs.
 * Called from HTML onclick: switchTab('text') / switchTab('voice')
 *
 * @param {'text'|'voice'} tab
 */
function switchTab(tab) {
  const tabText  = $id('tabText');
  const tabVoice = $id('tabVoice');
  const textArea = $id('textArea');
  const voiceArea= $id('voiceArea');

  if (tabText)   tabText.classList.toggle('active',  tab === 'text');
  if (tabVoice)  tabVoice.classList.toggle('active', tab === 'voice');
  if (textArea)  textArea.style.display  = tab === 'text'  ? 'block' : 'none';
  if (voiceArea) voiceArea.style.display = tab === 'voice' ? 'block' : 'none';

  if (tab === 'voice') {
    _initSpeechRecognition();
  } else {
    // Stop recording if the user switches back to text while recording.
    if (_isRecording) _stopRecording();
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   CHAR COUNT
   ───────────────────────────────────────────────────────────────────────── */

function _updateCharCount(n) {
  const el = $id('charCount');
  if (el) el.textContent = `${n} character${n !== 1 ? 's' : ''}`;
}

function _attachCharCountListener() {
  const ta = $id('answerText');
  if (!ta) return;
  // Remove previous listener to avoid double-firing.
  ta.removeEventListener('input', _onAnswerInput);
  ta.addEventListener('input', _onAnswerInput);
}

function _onAnswerInput() {
  const ta = $id('answerText');
  if (ta) _updateCharCount(ta.value.length);
}

/** Called from HTML onclick: clearAnswer() */
function clearAnswer() {
  const ta = $id('answerText');
  if (ta) ta.value = '';
  _updateCharCount(0);
}

/* ─────────────────────────────────────────────────────────────────────────────
   SPEECH RECOGNITION
   ───────────────────────────────────────────────────────────────────────── */

/** Lazily create the SpeechRecognition instance.  No-op if already created. */
function _initSpeechRecognition() {
  if (_recognition) return;

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    const status = $id('voiceStatus');
    if (status) status.textContent = '⚠️ Speech recognition is not supported in this browser. Please use Chrome or Edge.';
    return;
  }

  _recognition = new SR();
  _recognition.continuous     = true;   // keep running until we stop it
  _recognition.interimResults = true;   // show words as they're spoken
  _recognition.lang           = 'en-US';
  _recognition.maxAlternatives = 1;

  // Accumulate final transcript separately so interim results don't duplicate.
  let _finalTranscript = '';

  _recognition.onresult = (event) => {
    let interim = '';

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        _finalTranscript += transcript + ' ';
      } else {
        interim += transcript;
      }
    }

    const ta = $id('answerText2');
    if (ta) {
      ta.value = _finalTranscript + interim;
      ta.scrollTop = ta.scrollHeight;
    }
  };

  _recognition.onerror = (event) => {
    // "no-speech" is non-fatal — just keep waiting.
    if (event.error === 'no-speech') return;

    console.warn('[interview.js] SpeechRecognition error:', event.error);
    _isRecording = false;
    _updateMicUI();

    const status = $id('voiceStatus');
    if (status) {
      const messages = {
        'not-allowed':  '🚫 Microphone access denied. Please allow microphone permission.',
        'audio-capture':'🎤 No microphone found. Please connect one and try again.',
        'network':      '🌐 Network error during speech recognition.',
        'aborted':      'Recording cancelled.',
      };
      status.textContent = messages[event.error] || `⚠️ Error: ${event.error}`;
    }
  };

  _recognition.onend = () => {
    // If we are still supposed to be recording (e.g. the browser auto-stopped),
    // restart to maintain continuous capture.
    if (_isRecording) {
      try { _recognition.start(); } catch { /* already started */ }
    }
  };

  // Reset the final transcript accumulator each time we load a new question.
  _recognition._resetTranscript = () => { _finalTranscript = ''; };
}

/** Start recording. */
function _startRecording() {
  if (!_recognition) _initSpeechRecognition();
  if (!_recognition) return;

  // Reset accumulated transcript for this new recording session.
  if (typeof _recognition._resetTranscript === 'function') {
    _recognition._resetTranscript();
  }
  const ta = $id('answerText2');
  if (ta) ta.value = '';

  try {
    _recognition.start();
  } catch (e) {
    // Already started — ignore.
  }
  _isRecording = true;

  const status = $id('voiceStatus');
  if (status) status.textContent = '🔴 Recording… speak your answer clearly';

  _updateMicUI();
}

/** Stop recording. */
function _stopRecording() {
  if (_recognition) {
    try { _recognition.stop(); } catch { /* already stopped */ }
  }
  _isRecording = false;

  const status = $id('voiceStatus');
  if (status) status.textContent = 'Recording stopped. Review your answer and click Submit.';

  _updateMicUI();
}

/**
 * Toggle mic on/off.
 * Called from HTML onclick: toggleVoice()
 */
function toggleVoice() {
  if (_isRecording) {
    _stopRecording();
  } else {
    _startRecording();
  }
}

/** Sync the mic button appearance with the recording state. */
function _updateMicUI() {
  const btn = $id('micBtn');
  if (!btn) return;
  btn.classList.toggle('recording', _isRecording);
  btn.textContent = _isRecording ? '⏹' : '🎤';
}

/* ─────────────────────────────────────────────────────────────────────────────
   GET CURRENT ANSWER TEXT
   ───────────────────────────────────────────────────────────────────────── */

/**
 * Return the trimmed answer text from whichever input tab is active.
 * @returns {string}
 */
function _getAnswerText() {
  const isVoiceActive = $id('tabVoice')?.classList.contains('active');
  const ta = isVoiceActive ? $id('answerText2') : $id('answerText');
  return (ta?.value || '').trim();
}

/* ─────────────────────────────────────────────────────────────────────────────
   SUBMIT ANSWER
   ───────────────────────────────────────────────────────────────────────── */

/**
 * Validate the answer, POST to /api/evaluate_answer, then render feedback.
 * Called from HTML onclick: submitAnswer()
 */
async function submitAnswer() {
  const answer = _getAnswerText();

  if (!answer) {
    if (typeof showToast === 'function') {
      showToast('Please type or speak your answer before submitting.', 'error');
    } else {
      alert('Please provide an answer before submitting.');
    }
    return;
  }

  // Stop microphone if still recording.
  if (_isRecording) _stopRecording();

  // Stop TTS if still speaking (so evaluation feedback can play after).
  if (typeof stopSpeaking === 'function') stopSpeaking();

  // Disable submit button and show loading state.
  const submitBtn = $id('submitBtn');
  if (submitBtn) {
    submitBtn.disabled  = true;
    submitBtn.innerHTML = '<span class="loader"></span> Evaluating…';
  }

  let evalData;
  try {
    const res = await fetch('/api/evaluate_answer', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        interview_id:    _interviewId,
        question_number: _currentQ,
        question_text:   _currentQData?.question || '',
        question_type:   _currentQData?.type     || 'General',
        answer_text:     answer,
      }),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    evalData = await res.json();
    if (evalData.error) throw new Error(evalData.error);

  } catch (err) {
    console.error('[interview.js] evaluate_answer error:', err);
    if (submitBtn) {
      submitBtn.disabled  = false;
      submitBtn.textContent = 'Submit Answer →';
    }
    if (typeof showToast === 'function') {
      showToast('Failed to evaluate answer. Please try again.', 'error');
    } else {
      alert('Error evaluating answer. Please try again.');
    }
    return;
  }

  // Restore button.
  if (submitBtn) {
    submitBtn.disabled  = false;
    submitBtn.textContent = 'Submit Answer →';
  }

  // Record this Q&A for adaptive context on the next question.
  _previousAnswers.push({
    question: _currentQData?.question || '',
    answer,
  });

  // Render the score rings + feedback lists.
  _renderFeedback(evalData);

  // Update the right-sidebar history and running averages.
  _addToHistory(_currentQ, _currentQData?.question || '', evalData.scores);
  _updateRunningAverages(evalData.scores);

  // Trigger avatar reaction based on overall score.
  const avg = _avgScore(evalData.scores);
  if (avg >= 7.5 && typeof showHappyExpression === 'function') showHappyExpression();

  // Speak the brief feedback summary.
  if (evalData.brief_feedback && typeof speakText === 'function') {
    speakText(evalData.brief_feedback);
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   FEEDBACK RENDERING
   ───────────────────────────────────────────────────────────────────────── */

/**
 * Populate and reveal the feedback card beneath the answer card.
 *
 * @param {{
 *   scores: { relevance, technical, communication, confidence, completeness },
 *   strengths:   string[],
 *   weaknesses:  string[],
 *   suggestions: string[],
 *   brief_feedback?: string
 * }} data
 */
function _renderFeedback(data) {
  const scores = data.scores || {};

  // Score rings ─────────────────────────────────────────────────────────────
  const dimensions = [
    { key: 'relevance',     label: 'Relevance',  color: '#6366f1' },
    { key: 'technical',     label: 'Technical',  color: '#06b6d4' },
    { key: 'communication', label: 'Comm.',      color: '#10b981' },
    { key: 'confidence',    label: 'Confidence', color: '#f59e0b' },
    { key: 'completeness',  label: 'Complete.',  color: '#8b5cf6' },
  ];

  const scoreGrid = $id('scoreGrid');
  if (scoreGrid) {
    scoreGrid.innerHTML = dimensions.map((d) => {
      const val = (scores[d.key] || 0);
      const pct = val * 10; // 0–100
      return `
        <div class="score-item">
          <div class="score-ring"
               style="--pct:${pct};background:conic-gradient(${d.color} calc(${pct}% * 1),var(--bg3) 0%)">
            <span>${val.toFixed(1)}</span>
          </div>
          <div class="score-lbl">${d.label}</div>
        </div>`;
    }).join('');
  }

  // Feedback lists ──────────────────────────────────────────────────────────
  _renderFeedbackList('strengthsList',   data.strengths);
  _renderFeedbackList('weaknessesList',  data.weaknesses);
  _renderFeedbackList('suggestionsList', data.suggestions);

  // Reveal the card ─────────────────────────────────────────────────────────
  const card = $id('feedbackCard');
  if (card) {
    card.classList.add('visible');
    // Smooth-scroll so the user can see the feedback without manually scrolling.
    setTimeout(() => {
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 80);
  }
}

/**
 * Populate a <ul> feedback list.
 *
 * @param {string}   listId - element id of the <ul>
 * @param {string[]} items  - array of strings; falls back to ["—"] if empty
 */
function _renderFeedbackList(listId, items) {
  const ul = $id(listId);
  if (!ul) return;
  const safe = Array.isArray(items) && items.length ? items : ['—'];
  ul.innerHTML = safe.map((item) => `<li>${_escHtml(item)}</li>`).join('');
}

/** Hide the feedback card and clear its contents. */
function _hideFeedback() {
  const card = $id('feedbackCard');
  if (card) card.classList.remove('visible');
}

/* ─────────────────────────────────────────────────────────────────────────────
   SIDEBAR — QUESTION HISTORY
   ───────────────────────────────────────────────────────────────────────── */

/**
 * Prepend a row to the right-sidebar history list.
 *
 * @param {number} qNum   - question number (1-based)
 * @param {string} qText  - full question text (truncated for display)
 * @param {object} scores - dimension score object from the API
 */
function _addToHistory(qNum, qText, scores) {
  const avg = _avgScore(scores);
  const cls = avg >= 7 ? 'score-high' : avg >= 5 ? 'score-mid' : 'score-low';

  const hist = $id('qHistory');
  if (!hist) return;

  // Remove placeholder "No answers yet" text on first entry.
  const placeholder = hist.querySelector('[style*="text-align:center"]');
  if (placeholder) placeholder.remove();

  const row = document.createElement('div');
  row.className = 'q-history-item text-appear';
  row.innerHTML = `
    <div class="num">${qNum}</div>
    <div style="flex:1;font-size:0.78rem;color:var(--muted);overflow:hidden;white-space:nowrap;text-overflow:ellipsis">
      ${_escHtml(qText.substring(0, 46))}${qText.length > 46 ? '…' : ''}
    </div>
    <div class="score-badge ${cls}">${avg.toFixed(1)}</div>
  `;

  // Most-recent question appears at the top.
  hist.prepend(row);
}

/* ─────────────────────────────────────────────────────────────────────────────
   SIDEBAR — RUNNING AVERAGES
   ───────────────────────────────────────────────────────────────────────── */

/**
 * Push new dimension scores into the running arrays and refresh the sidebar
 * "Running Avg" card.
 *
 * @param {object} scores - { relevance, technical, communication, confidence, completeness }
 */
function _updateRunningAverages(scores) {
  if (!scores) return;

  Object.keys(_runningScores).forEach((key) => {
    if (scores[key] !== undefined) {
      _runningScores[key].push(scores[key]);
    }
  });

  const card = $id('avgCard');
  if (!card) return;
  card.style.display = 'block';

  const arrAvg = (key) => {
    const arr = _runningScores[key];
    if (!arr.length) return '—';
    return (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1);
  };

  const rows = [
    { label: '🔵 Technical',     key: 'technical'     },
    { label: '🟢 Communication', key: 'communication' },
    { label: '🟡 Confidence',    key: 'confidence'    },
    { label: '🟣 Relevance',     key: 'relevance'     },
    { label: '⚪ Completeness',  key: 'completeness'  },
  ];

  const container = $id('avgScores');
  if (container) {
    container.innerHTML = rows.map((r) => `
      <div style="display:flex;justify-content:space-between;align-items:center;font-size:0.82rem">
        <span style="color:var(--muted)">${r.label}</span>
        <span style="font-weight:700">${arrAvg(r.key)}</span>
      </div>
    `).join('');
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   NEXT QUESTION / SKIP
   ───────────────────────────────────────────────────────────────────────── */

/**
 * Move to the next question.
 * Called from HTML onclick: nextQuestion() (the "Next Question →" button
 * inside the feedback card).
 */
function nextQuestion() {
  if (_currentQ >= TOTAL_QUESTIONS) {
    finishInterview();
    return;
  }
  loadNextQuestion();
}

/**
 * Skip the current question without submitting an answer.
 * The question is skipped entirely — no score is recorded.
 * Called from HTML onclick: skipQuestion()
 */
function skipQuestion() {
  if (!confirm('Skip this question? It will not be scored.')) return;
  if (_currentQ >= TOTAL_QUESTIONS) {
    finishInterview();
    return;
  }
  loadNextQuestion();
}

/* ─────────────────────────────────────────────────────────────────────────────
   FINISH INTERVIEW
   ───────────────────────────────────────────────────────────────────────── */

/**
 * Confirm, POST to /api/complete_interview, show the completion overlay, then
 * wire the "View Full Report" button to redirect to /report/<id>.
 * Called from HTML onclick: finishInterview()
 */
async function finishInterview() {
  if (!confirm('Are you sure you want to finish the interview? This cannot be undone.')) return;

  // Stop timers and speech first.
  _stopAllTimers();
  if (typeof stopSpeaking === 'function') stopSpeaking();
  if (_isRecording) _stopRecording();

  // Collect presence and body-language metrics BEFORE stopping the proctor (stopProctor finalises logs).
  const presenceScore = (typeof window.getPresenceScore === 'function')
    ? window.getPresenceScore()
    : null;
  const absenceLog = (typeof window.getAbsenceLog === 'function')
    ? window.getAbsenceLog()
    : [];
  const gazeScore = (typeof window.getGazeScore === 'function')
    ? window.getGazeScore()
    : null;
  const postureScore = (typeof window.getPostureScore === 'function')
    ? window.getPostureScore()
    : null;
  const handScore = (typeof window.getHandStillnessScore === 'function')
    ? window.getHandStillnessScore()
    : null;

  // Stop webcam / detection loop now that the interview is over.
  if (typeof window.stopProctor === 'function') window.stopProctor();

  let result;
  try {
    const res = await fetch('/api/complete_interview', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        interview_id:    _interviewId,
        presence_score:  presenceScore,   // percentage 0-100
        absence_count:   absenceLog.length,
        absence_log:     absenceLog,      // array of { start, end, durationMs }
        gaze_score:      gazeScore,
        posture_score:   postureScore,
        hand_score:      handScore,
      }),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    result = await res.json();
    if (result.error) throw new Error(result.error);

  } catch (err) {
    console.error('[interview.js] complete_interview error:', err);
    if (typeof showToast === 'function') {
      showToast('Failed to complete interview. Please try again.', 'error');
    } else {
      alert('Failed to complete the interview: ' + err.message);
    }
    return;
  }

  // Build body-language score cards HTML (shown only when proctoring ran)
  const presenceCardHtml = (presenceScore !== null) ? `
      <div class="c-score">
        <div class="v" style="font-size:1.4rem;">${presenceScore}%</div>
        <div class="l">Presence Score</div>
      </div>` : '';
  const gazeCardHtml = (gazeScore !== null) ? `
      <div class="c-score">
        <div class="v" style="font-size:1.4rem;">${gazeScore}%</div>
        <div class="l">Eye Contact</div>
      </div>` : '';
  const postureCardHtml = (postureScore !== null) ? `
      <div class="c-score">
        <div class="v" style="font-size:1.4rem;">${postureScore}%</div>
        <div class="l">Posture</div>
      </div>` : '';
  const handCardHtml = (handScore !== null) ? `
      <div class="c-score">
        <div class="v" style="font-size:1.4rem;">${handScore}%</div>
        <div class="l">Hand Stillness</div>
      </div>` : '';

  // Populate the completion overlay score cards.
  const scoresEl = $id('completionScores');
  if (scoresEl) {
    const fmt = (v) => (v || 0).toFixed(1);
    scoresEl.innerHTML = `
      <div class="c-score">
        <div class="v">${fmt(result.overall_score)}</div>
        <div class="l">Overall Score</div>
      </div>
      <div class="c-score">
        <div class="v">${fmt(result.technical_score)}</div>
        <div class="l">Technical</div>
      </div>
      <div class="c-score">
        <div class="v">${fmt(result.communication_score)}</div>
        <div class="l">Communication</div>
      </div>
      <div class="c-score">
        <div class="v">${fmt(result.confidence_score)}</div>
        <div class="l">Confidence</div>
      </div>
      ${presenceCardHtml}
      ${gazeCardHtml}
      ${postureCardHtml}
      ${handCardHtml}
    `;
  }

  // Store metrics on window for the report page to read if needed.
  window._lastPresenceScore = presenceScore;
  window._lastAbsenceLog    = absenceLog;

  // Wire the "View Full Report" button.
  const reportBtn = $id('viewReportBtn');
  if (reportBtn) {
    reportBtn.onclick = () => {
      // Pass metrics as query params so report.html can display them
      const urlParams = new URLSearchParams();
      if (presenceScore !== null) urlParams.set('presence', presenceScore);
      if (absenceLog !== null) urlParams.set('absences', absenceLog.length);
      if (gazeScore !== null) urlParams.set('gaze', gazeScore);
      if (postureScore !== null) urlParams.set('posture', postureScore);
      if (handScore !== null) urlParams.set('hands', handScore);

      const qs = urlParams.toString() ? `?${urlParams.toString()}` : '';
      window.location.href = `/report/${_interviewId}${qs}`;
    };
  }

  // Show the overlay.
  const overlay = $id('completionOverlay');
  if (overlay) overlay.classList.add('active');

  // Avatar celebration speech.
  const overall = (result.overall_score || 0).toFixed(1);
  if (typeof speakText === 'function') {
    speakText(
      `Congratulations! Your interview is complete. Your overall score is ${overall} out of 10. Great work!`
    );
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   CONFIRM EXIT — nav "✕ Exit" button
   ───────────────────────────────────────────────────────────────────────── */

/**
 * Prompt the user to confirm exit.  If confirmed, stop everything and redirect
 * to the landing page.
 * Called from HTML onclick: confirmExit()
 */
function confirmExit() {
  if (!confirm('Exit the interview? Your answers so far have been saved.')) return;
  _stopAllTimers();
  if (typeof window.stopProctor === 'function') window.stopProctor();
  if (typeof stopSpeaking === 'function') stopSpeaking();
  if (_isRecording) _stopRecording();
  window.location.href = '/';
}

/* ─────────────────────────────────────────────────────────────────────────────
   UTILITY HELPERS
   ───────────────────────────────────────────────────────────────────────── */

/**
 * Show or hide an element by toggling its display style.
 *
 * @param {string}  id
 * @param {boolean} visible
 * @param {string}  [displayValue='block']
 */
function _setVisible(id, visible, displayValue = 'block') {
  const el = $id(id);
  if (el) el.style.display = visible ? displayValue : 'none';
}

/**
 * Compute the arithmetic mean of all five score dimensions.
 * Gracefully returns 0 when scores object is absent.
 *
 * @param {object} scores
 * @returns {number}
 */
function _avgScore(scores) {
  if (!scores) return 0;
  const vals = [
    scores.relevance     || 0,
    scores.technical     || 0,
    scores.communication || 0,
    scores.confidence    || 0,
    scores.completeness  || 0,
  ];
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/**
 * Minimal HTML entity escaper — avoids XSS when inserting API-returned strings
 * into innerHTML.  Delegates to main.js escHtml() if available.
 *
 * @param {string} str
 * @returns {string}
 */
function _escHtml(str) {
  if (typeof escHtml === 'function') return escHtml(str);
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* ─────────────────────────────────────────────────────────────────────────────
   PAGE BOOT
   ───────────────────────────────────────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', () => {

  // Guard: if there's no ?id= in the URL, we can't do anything useful.
  if (!_interviewId) {
    console.error('[interview.js] No interview ID in URL. Redirecting to home.');
    window.location.href = '/';
    return;
  }

  // Pre-load browser TTS voice list (browsers load voices asynchronously).
  if (window.speechSynthesis) {
    speechSynthesis.getVoices();
    speechSynthesis.addEventListener('voiceschanged', () => speechSynthesis.getVoices());
  }

  // Populate the session info sidebar from sessionStorage.
  _populateSessionInfo();

  // Start the global elapsed-time counter.
  _startGlobalTimer();

  // Attach the char-count listener to the text textarea.
  _attachCharCountListener();

  // Kick off the first question — this drives the entire interview flow.
  loadNextQuestion();
});
