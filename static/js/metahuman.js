/**
 * metahuman.js — AI Interview Coach
 * ===================================
 * Unreal Engine MetaHuman Pixel Streaming integration controller.
 *
 * Responsibilities:
 *   1. Manages connection lifecycle with Unreal Engine Pixel Streaming 2.
 *   2. Probes Signalling Server health (/api/status) for active streamers.
 *   3. Handles loading, live streaming, error states, and auto-reconnection.
 *   4. Provides seamless fallback toggle to the 2D SVG avatar.
 *   5. Synchronizes interviewer speech & questions with audio/animation.
 *   6. Strictly preserves candidate webcam, timers, STT, and proctoring.
 */

'use strict';

const MetaHuman = (() => {

  /* ── Configuration ──────────────────────────────────────────────────────── */
  const STATUS_POLL_INTERVAL_MS = 3500;
  const CONNECT_TIMEOUT_MS      = 8000;

  let _statusUrl = window.METAHUMAN_STATUS_URL || 'http://127.0.0.1:80/api/status';
  let _streamUrl = window.METAHUMAN_STREAM_URL || 'http://127.0.0.1:80/uiless.html?AutoConnect=true&AutoPlayAudio=true&HoveringMouse=true';

  /* ── State ──────────────────────────────────────────────────────────────── */
  let _isLive          = false;
  let _isFallbackMode  = false;
  let _pollTimer       = null;
  let _lastStreamerId  = null;
  let _signallingOk    = false;
  let _streamerOk      = false;
  let _iframeLoaded    = false;

  /* ── DOM Elements ───────────────────────────────────────────────────────── */
  function el(id) { return document.getElementById(id); }

  /* ── Status Chip Helper ─────────────────────────────────────────────────── */
  function updateStatusChip(state, customLabel) {
    const chip = el('stageChip');
    if (!chip) return;

    if (state === 'live') {
      chip.style.borderColor = 'rgba(16, 185, 129, 0.45)';
      chip.style.background  = 'rgba(16, 185, 129, 0.12)';
      chip.style.color       = '#10b981';
      chip.innerHTML         = '<span class="chip-dot" style="background:#10b981;box-shadow:0 0 10px #10b981"></span>MetaHuman Live';
    } else if (state === 'connecting') {
      chip.style.borderColor = 'rgba(245, 158, 11, 0.4)';
      chip.style.background  = 'rgba(245, 158, 11, 0.1)';
      chip.style.color       = '#f59e0b';
      chip.innerHTML         = '<span class="chip-dot" style="background:#f59e0b;box-shadow:0 0 8px #f59e0b"></span>MetaHuman Connecting...';
    } else if (state === 'offline') {
      chip.style.borderColor = 'rgba(239, 68, 68, 0.35)';
      chip.style.background  = 'rgba(239, 68, 68, 0.08)';
      chip.style.color       = '#f87171';
      chip.innerHTML         = '<span class="chip-dot" style="background:#ef4444;box-shadow:0 0 6px #ef4444"></span>MetaHuman Offline';
    } else if (state === 'fallback') {
      chip.style.borderColor = 'rgba(6, 182, 212, 0.3)';
      chip.style.background  = 'rgba(6, 182, 212, 0.08)';
      chip.style.color       = 'var(--accent3, #06b6d4)';
      chip.innerHTML         = '<span class="chip-dot"></span>AI Interviewer (2D Avatar)';
    }
  }

  /* ── Diagnostic UI Helpers ──────────────────────────────────────────────── */
  function updateDiagnostics(signallingOnline, streamerOnline, streamerCount) {
    const sigDot  = el('diagSignallingDot');
    const sigText = el('diagSignallingText');
    const stmDot  = el('diagStreamerDot');
    const stmText = el('diagStreamerText');

    if (sigDot && sigText) {
      if (signallingOnline) {
        sigDot.className   = 'mh-diag-dot online';
        sigText.textContent = 'Signalling Server: Online';
      } else {
        sigDot.className   = 'mh-diag-dot offline';
        sigText.textContent = 'Signalling Server: Offline (Port 80)';
      }
    }

    if (stmDot && stmText) {
      if (streamerOnline) {
        stmDot.className   = 'mh-diag-dot online';
        stmText.textContent = `Unreal Streamer: Connected (${streamerCount})`;
      } else {
        stmDot.className   = 'mh-diag-dot offline';
        stmText.textContent = 'Unreal Streamer: Waiting for MyProject4 (8888)';
      }
    }
  }

  /* ── State Display Switches ─────────────────────────────────────────────── */
  function showLiveView() {
    _isLive = true;
    _isFallbackMode = false;

    // Show metahuman container, hide fallback avatar
    el('metahumanSlot')?.classList.remove('hidden');
    const fallback = el('stageFallback');
    if (fallback) fallback.style.display = 'none';

    // Hide overlays smoothly
    el('metahumanLoading')?.classList.add('hidden');
    const offline = el('metahumanOffline');
    if (offline) offline.style.display = 'none';

    updateStatusChip('live');
  }

  function showLoadingView(message) {
    _isLive = false;
    if (_isFallbackMode) return;

    el('metahumanSlot')?.classList.remove('hidden');
    const fallback = el('stageFallback');
    if (fallback) fallback.style.display = 'none';

    const loading = el('metahumanLoading');
    if (loading) {
      loading.classList.remove('hidden');
      const sub = el('metahumanLoadingSub');
      if (sub && message) sub.textContent = message;
    }

    const offline = el('metahumanOffline');
    if (offline) offline.style.display = 'none';

    updateStatusChip('connecting');
  }

  function showOfflineView() {
    _isLive = false;
    if (_isFallbackMode) return;

    el('metahumanSlot')?.classList.remove('hidden');
    const fallback = el('stageFallback');
    if (fallback) fallback.style.display = 'none';

    el('metahumanLoading')?.classList.add('hidden');
    const offline = el('metahumanOffline');
    if (offline) offline.style.display = 'flex';

    updateStatusChip('offline');
  }

  /* ── Fallback 2D Avatar Toggle ──────────────────────────────────────────── */
  function switchToFallback() {
    _isFallbackMode = true;
    _isLive = false;

    el('metahumanSlot')?.classList.add('hidden');
    const fallback = el('stageFallback');
    if (fallback) fallback.style.display = 'flex';

    updateStatusChip('fallback');
  }

  /* ── Reconnect Handler ──────────────────────────────────────────────────── */
  function reconnect() {
    _isFallbackMode = false;
    showLoadingView('Probing Unreal Engine MetaHuman stream...');

    const frame = el('metahumanFrame');
    if (frame) {
      // Reload iframe with cache-busting timestamp
      const url = new URL(_streamUrl, window.location.href);
      url.searchParams.set('_t', Date.now().toString());
      frame.src = url.toString();
    }

    checkSignallingStatus(true);
  }

  /* ── Signalling Server Status Poller ────────────────────────────────────── */
  async function checkSignallingStatus(manualTrigger = false) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2500);

      const resp = await fetch(_statusUrl, {
        method: 'GET',
        cache: 'no-store',
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }

      const data = await resp.json();
      _signallingOk = (data.status === 'online');
      const streamers = Array.isArray(data.streamers) ? data.streamers : [];
      _streamerOk = streamers.length > 0;

      updateDiagnostics(_signallingOk, _streamerOk, streamers.length);

      if (_streamerOk) {
        // Unreal Engine is actively streaming
        if (!_isLive && !_isFallbackMode) {
          console.info('[MetaHuman] Active streamer detected:', streamers);
          showLiveView();
        }
      } else {
        // Signalling server is up, but no Unreal Engine streamer has connected yet
        if (!_isFallbackMode) {
          showOfflineView();
        }
      }

    } catch (err) {
      // Signalling server unreachable
      _signallingOk = false;
      _streamerOk   = false;
      updateDiagnostics(false, false, 0);

      if (!_isFallbackMode) {
        showOfflineView();
      }
    }
  }

  /* ── Speech / Animation Coordination ────────────────────────────────────── */
  function sendToMetaHuman(data) {
    try {
      const frame = el('metahumanFrame');
      if (frame && frame.contentWindow) {
        frame.contentWindow.postMessage(JSON.stringify(data), '*');
      }
    } catch (e) {
      // Cross-origin postMessage safety fallback
    }
  }

  /* ── Lifecycle Init ─────────────────────────────────────────────────────── */
  function init() {
    console.info('[MetaHuman] Initializing MetaHuman Streaming Manager...');
    console.info('[MetaHuman] Stream Target:', _streamUrl);
    console.info('[MetaHuman] Signalling Target:', _statusUrl);

    showLoadingView('Connecting to Unreal Engine MetaHuman...');

    const frame = el('metahumanFrame');
    if (frame) {
      frame.addEventListener('load', () => {
        _iframeLoaded = true;
        // Verify with signalling server check
        checkSignallingStatus();
      });

      frame.addEventListener('error', () => {
        console.warn('[MetaHuman] Iframe failed to load stream URL.');
        showOfflineView();
      });
    }

    // Initial check
    checkSignallingStatus();

    // Start background poller for auto-reconnect
    if (_pollTimer) clearInterval(_pollTimer);
    _pollTimer = setInterval(() => checkSignallingStatus(), STATUS_POLL_INTERVAL_MS);
  }

  return {
    init,
    reconnect,
    switchToFallback,
    sendToMetaHuman,
    get isLive() { return _isLive; },
  };

})();

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  // Give DOM elements a moment to bind
  setTimeout(() => MetaHuman.init(), 100);
});
