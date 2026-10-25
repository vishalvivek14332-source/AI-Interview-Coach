/**
 * avatar.js — AI Interview Coach
 *
 * Manages the animated SVG AI avatar:
 *   • Talking animation (mouth, ear-wave, ring pulse)
 *   • Eye blinking (idle + accelerated during speech)
 *   • Idle breathing / head-bob animation
 *   • Text-to-Speech (Web Speech API) with voice selection
 *   • Stop speaking
 *   • Replay question
 *   • TTS wave indicator in the UI
 *
 * Depends on:
 *   DOM IDs:  avatarRing, avatarSvg, avatarMouth, earL, earR,
 *             ttsWave, bubbleText
 *   CSS classes: talking (on avatarRing & avatarSvg), active (on ttsWave)
 *
 * No external libraries — pure Web APIs only.
 */

'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   MODULE STATE
   ───────────────────────────────────────────────────────────────────────── */

const Avatar = (() => {

  /* Internal state --------------------------------------------------------- */
  let _isTalking    = false;
  let _isSpeaking   = false;
  let _utterance    = null;   // current SpeechSynthesisUtterance
  let _currentText  = '';     // last spoken string, for replay
  let _voiceList    = [];     // cached voices
  let _mouthTick    = null;   // setInterval for mouth morph
  let _blinkTick    = null;   // setInterval for eye blink
  let _idleTick     = null;   // setInterval for idle float animation
  let _mouthPhase   = 0;      // 0–1 oscillator for the SVG mouth path
  let _idlePhase    = 0;      // 0–2π oscillator for idle bob

  /* SVG mouth path constants ----------------------------------------------- */
  const MOUTH_REST   = 'M68 105 Q80 112 92 105';   // gentle smile
  const MOUTH_OPEN_1 = 'M68 103 Q80 117 92 103';   // mid open
  const MOUTH_OPEN_2 = 'M68 102 Q80 120 92 102';   // wide open
  const MOUTH_CLOSED = 'M68 106 Q80 108 92 106';   // nearly closed

  /* ─────────────────────────────────────────────────────────────────────────
     DOM HELPERS
     ─────────────────────────────────────────────────────────────────────── */

  function el(id)  { return document.getElementById(id); }
  function cls(id) { return document.getElementById(id)?.classList; }

  /* ─────────────────────────────────────────────────────────────────────────
     TALKING STATE
     ─────────────────────────────────────────────────────────────────────── */

  /**
   * Enable or disable the "talking" visual state on the avatar.
   * Controls: glowing ring pulse, ear-wave bars, mouth animation, TTS wave.
   *
   * @param {boolean} yes
   */
  function setTalking(yes) {
    _isTalking = yes;

    // Ring + SVG class toggles (CSS handles the pulse animation).
    cls('avatarRing')?.toggle('talking', yes);
    cls('avatarSvg')?.toggle('talking', yes);

    // Ear-wave bars are visible only while talking.
    ['earL', 'earR'].forEach((id) => {
      const e = el(id);
      if (e) e.style.display = yes ? 'block' : 'none';
    });

    // TTS wave indicator in the speech bubble header.
    const wave = el('ttsWave');
    if (wave) wave.classList.toggle('active', yes);

    if (yes) {
      startMouthAnimation();
      stopIdleAnimation();
    } else {
      stopMouthAnimation();
      restoreMouthPath();
      startIdleAnimation();
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
     MOUTH ANIMATION
     ─────────────────────────────────────────────────────────────────────── */

  /**
   * Cycle the SVG mouth path through three positions at ~10 fps to mimic
   * speech lip movement.  The oscillation pattern is irregular so it looks
   * more natural than a simple sine wave.
   */
  function startMouthAnimation() {
    if (_mouthTick) return; // already running

    const mouthEl = el('avatarMouth');
    if (!mouthEl) return;

    const frames = [
      MOUTH_REST,
      MOUTH_OPEN_1,
      MOUTH_OPEN_2,
      MOUTH_OPEN_1,
      MOUTH_REST,
      MOUTH_CLOSED,
      MOUTH_OPEN_1,
      MOUTH_OPEN_2,
      MOUTH_REST,
      MOUTH_CLOSED,
    ];
    let frameIdx = 0;

    _mouthTick = setInterval(() => {
      // Add slight randomness: sometimes skip a frame.
      if (Math.random() > 0.85) frameIdx = (frameIdx + 2) % frames.length;
      mouthEl.setAttribute('d', frames[frameIdx]);
      frameIdx = (frameIdx + 1) % frames.length;
    }, 95);
  }

  function stopMouthAnimation() {
    if (_mouthTick) { clearInterval(_mouthTick); _mouthTick = null; }
  }

  function restoreMouthPath() {
    const mouthEl = el('avatarMouth');
    if (mouthEl) mouthEl.setAttribute('d', MOUTH_REST);
  }

  /* ─────────────────────────────────────────────────────────────────────────
     EYE BLINK ANIMATION (independent of talking state)
     ─────────────────────────────────────────────────────────────────────── */

  /**
   * Start the eye-blink interval.  Eyes blink every 3–6 seconds at rest, or
   * every 1.5–3 seconds during speech (people blink more when they talk).
   * The CSS keyframe @keyframes blink handles the actual squint, but we
   * can also manually morph the ry attribute for a more pronounced blink.
   */
  function startBlinkAnimation() {
    if (_blinkTick) return;

    function scheduleBlink() {
      const interval = _isTalking
        ? 1500 + Math.random() * 1500
        : 3000 + Math.random() * 3000;

      _blinkTick = setTimeout(() => {
        doBlink();
        scheduleBlink(); // reschedule after each blink
      }, interval);
    }

    scheduleBlink();
  }

  function stopBlinkAnimation() {
    if (_blinkTick) { clearTimeout(_blinkTick); _blinkTick = null; }
  }

  /**
   * Morph the eye ellipse ry attributes to 1 (closed) then back to 6 (open).
   */
  function doBlink() {
    const eyes = document.querySelectorAll('.av-eye');
    if (!eyes.length) return;

    // Close
    eyes.forEach((eye) => eye.setAttribute('ry', '1'));

    // Re-open after 110 ms
    setTimeout(() => {
      eyes.forEach((eye) => eye.setAttribute('ry', '6'));
    }, 110);
  }

  /* ─────────────────────────────────────────────────────────────────────────
     IDLE ANIMATION — subtle vertical float
     ─────────────────────────────────────────────────────────────────────── */

  /**
   * Gently bob the entire avatar SVG up and down using a CSS transform.
   * This runs when the avatar is not talking, giving it a "breathing" feel.
   */
  function startIdleAnimation() {
    if (_idleTick) return;
    const svg = el('avatarSvg');
    if (!svg) return;

    _idleTick = setInterval(() => {
      _idlePhase += 0.035; // ~0.56 radians/second at 16ms intervals
      const yOffset = Math.sin(_idlePhase) * 3; // ±3 px
      svg.style.transform = `translateY(${yOffset.toFixed(2)}px)`;
    }, 33); // ~30 fps
  }

  function stopIdleAnimation() {
    if (_idleTick) { clearInterval(_idleTick); _idleTick = null; }
    const svg = el('avatarSvg');
    if (svg) svg.style.transform = '';
  }

  /* ─────────────────────────────────────────────────────────────────────────
     SPEECH BUBBLE
     ─────────────────────────────────────────────────────────────────────── */

  /**
   * Update the speech bubble's inner content.
   *
   * @param {string}  html      - HTML to place inside the bubble.
   * @param {boolean} [loading] - If true, skip the fade-in animation class.
   */
  function setBubble(html, loading = false) {
    const bubble = el('bubbleText');
    if (!bubble) return;
    bubble.classList.remove('text-appear');
    bubble.innerHTML = html;
    if (!loading) {
      // Force a reflow so the class removal registers before we re-add it.
      void bubble.offsetWidth;
      bubble.classList.add('text-appear');
    }
  }

  /** Show the three-dot loading indicator in the speech bubble. */
  function setBubbleLoading() {
    setBubble(
      '<div class="loading-dots"><span></span><span></span><span></span></div>',
      true
    );
  }

  /* ─────────────────────────────────────────────────────────────────────────
     TEXT-TO-SPEECH
     ─────────────────────────────────────────────────────────────────────── */

  /**
   * Load the browser's available TTS voices and cache them.
   * Browsers load voices asynchronously, so we listen to voiceschanged as well.
   */
  function loadVoices() {
    if (!window.speechSynthesis) return;
    _voiceList = speechSynthesis.getVoices();
    speechSynthesis.addEventListener('voiceschanged', () => {
      _voiceList = speechSynthesis.getVoices();
    });
  }

  /**
   * Pick the best available English voice.
   * Preference order:
   *   1. Google English (high-quality)
   *   2. en-US locale
   *   3. en-GB locale
   *   4. Any English locale
   *   5. First available voice (fallback)
   *
   * @returns {SpeechSynthesisVoice|null}
   */
  function pickVoice() {
    if (!_voiceList.length) _voiceList = speechSynthesis.getVoices();

    return (
      _voiceList.find((v) => v.name.includes('Google') && v.lang.startsWith('en')) ||
      _voiceList.find((v) => v.lang === 'en-US') ||
      _voiceList.find((v) => v.lang === 'en-GB') ||
      _voiceList.find((v) => v.lang.startsWith('en')) ||
      _voiceList[0] ||
      null
    );
  }

  /**
   * Speak a string of text using the Web Speech API.
   * Activates the talking animation for the duration of speech.
   *
   * @param {string}    text        - Text to speak.
   * @param {Function}  [onEndCb]   - Optional callback fired when speech ends.
   */
  function speakText(text, onEndCb) {
    if (!window.speechSynthesis) {
      console.warn('[avatar.js] SpeechSynthesis not available in this browser.');
      if (onEndCb) onEndCb();
      return;
    }

    // Cancel any utterance currently in progress.
    stopSpeaking();

    _currentText = text;

    const utter    = new SpeechSynthesisUtterance(text);
    utter.rate     = 0.92;   // slightly slower than default for clarity
    utter.pitch    = 1.05;   // very slightly higher for a friendly tone
    utter.volume   = 1;

    const voice = pickVoice();
    if (voice) utter.voice = voice;

    utter.onstart = () => {
      _isSpeaking = true;
      setTalking(true);
      if (window.MetaHuman?.sendToMetaHuman) {
        window.MetaHuman.sendToMetaHuman({ type: 'speak', text });
      }
    };

    utter.onend = () => {
      _isSpeaking = false;
      setTalking(false);
      if (window.MetaHuman?.sendToMetaHuman) {
        window.MetaHuman.sendToMetaHuman({ type: 'stop' });
      }
      if (onEndCb) onEndCb();
    };

    utter.onerror = (event) => {
      // Ignore "interrupted" errors — they are triggered by our own cancel() calls.
      if (event.error === 'interrupted') return;
      console.warn('[avatar.js] SpeechSynthesis error:', event.error);
      _isSpeaking = false;
      setTalking(false);
      if (window.MetaHuman?.sendToMetaHuman) {
        window.MetaHuman.sendToMetaHuman({ type: 'stop' });
      }
      if (onEndCb) onEndCb();
    };

    _utterance = utter;

    // A short delay prevents Chrome from occasionally swallowing the first
    // syllable when the synth is cold-starting.
    setTimeout(() => {
      if (speechSynthesis.speaking) speechSynthesis.cancel();
      speechSynthesis.speak(utter);
    }, 150);
  }

  /**
   * Cancel any ongoing TTS speech immediately.
   */
  function stopSpeaking() {
    if (!window.speechSynthesis) return;
    if (speechSynthesis.speaking || speechSynthesis.pending) {
      speechSynthesis.cancel();
    }
    _isSpeaking = false;
    setTalking(false);
    if (window.MetaHuman?.sendToMetaHuman) {
      window.MetaHuman.sendToMetaHuman({ type: 'stop' });
    }
    _utterance = null;
  }

  /**
   * Replay the most recently spoken question.
   * Called by the "🔊 Replay question" button in the interview UI.
   */
  function replayTTS() {
    if (_currentText) speakText(_currentText);
  }

  /* ─────────────────────────────────────────────────────────────────────────
     EXPRESSION HELPERS
     ─────────────────────────────────────────────────────────────────────── */

  /**
   * Briefly show a "thinking" expression: slightly furrowed brows achieved by
   * shifting the brow SVG paths downward a couple of pixels for 1.5 seconds.
   */
  function showThinkingExpression() {
    const brows = document.querySelectorAll('[d^="M57 67"], [d^="M87 67"]');
    brows.forEach((b) => {
      const orig = b.getAttribute('d');
      const shifted = orig.replace(/Q(\d+) 63/, 'Q$1 66');
      b.setAttribute('d', shifted);
      setTimeout(() => b.setAttribute('d', orig), 1500);
    });
  }

  /**
   * Flash a brief "happy" expression: wider smile for 1 second.
   * Called after a high-scoring answer.
   */
  function showHappyExpression() {
    const mouth = el('avatarMouth');
    if (!mouth) return;
    mouth.setAttribute('d', 'M65 104 Q80 122 95 104');
    setTimeout(() => {
      if (!_isTalking) restoreMouthPath();
    }, 1000);
  }

  /* ─────────────────────────────────────────────────────────────────────────
     PUBLIC API
     ─────────────────────────────────────────────────────────────────────── */

  /** Called once during page init to wire up voices and kick off idle anim. */
  function init() {
    loadVoices();
    startBlinkAnimation();
    startIdleAnimation();
  }

  return {
    // Talking state
    setTalking,

    // TTS
    speakText,
    stopSpeaking,
    replayTTS,

    // Bubble
    setBubble,
    setBubbleLoading,

    // Expressions
    showThinkingExpression,
    showHappyExpression,

    // Lifecycle
    init,

    // Accessors (read-only)
    get isSpeaking() { return _isSpeaking; },
    get isTalking()  { return _isTalking;  },
    get currentText(){ return _currentText; },
  };

})(); // end Avatar IIFE

/* ─────────────────────────────────────────────────────────────────────────────
   GLOBAL SHIMS
   The interview.html inline script calls speakText(), replayTTS(), and
   setAvatarTalking() directly, so we proxy them here.
   ───────────────────────────────────────────────────────────────────────── */

function speakText(text, onEndCb)     { Avatar.speakText(text, onEndCb); }
function replayTTS()                   { Avatar.replayTTS(); }
function setAvatarTalking(yes)         { Avatar.setTalking(yes); }
function stopSpeaking()                { Avatar.stopSpeaking(); }
function setBubble(html, loading)      { Avatar.setBubble(html, loading); }
function setBubbleLoading()            { Avatar.setBubbleLoading(); }
function showThinkingExpression()      { Avatar.showThinkingExpression(); }
function showHappyExpression()         { Avatar.showHappyExpression(); }

/* ─────────────────────────────────────────────────────────────────────────────
   BOOT
   ───────────────────────────────────────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', () => {
  // Only initialise on the interview page (avatar elements must be present).
  if (document.getElementById('avatarSvg')) {
    Avatar.init();
  }
});
