// ============================================================
// OpenFalcon — Remote Falcon Compatibility Layer
//
// Provides the global functions that RF-style templates expect
// to call from inline onclick handlers, mapped to OpenFalcon's
// real API. Also handles showing the standard error message divs
// RF templates include (requestSuccessful, alreadyVoted, etc.)
// ============================================================

(function () {
  'use strict';

  const boot = window.__OPENFALCON__ || {};
  let cachedLocation = null;
  let hasVoted = false;

  // ======= Error/success message helpers =======
  // RF templates include divs with these IDs; we show the appropriate one.
  const MSG_IDS = {
    success: 'requestSuccessful',
    invalidLocation: 'invalidLocation',
    failed: 'requestFailed',
    alreadyQueued: 'requestPlaying',
    queueFull: 'queueFull',
    alreadyVoted: 'alreadyVoted',
  };

  function showMessage(id, durationMs) {
    const el = document.getElementById(id);
    if (!el) {
      console.warn('OpenFalcon compat: no element with id', id);
      return;
    }
    el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, durationMs || 3000);
  }

  function mapErrorToId(error) {
    const msg = (error || '').toLowerCase();
    if (msg.includes('location')) return MSG_IDS.invalidLocation;
    if (msg.includes('already voted')) return MSG_IDS.alreadyVoted;
    if (msg.includes('already') && (msg.includes('request') || msg.includes('queue'))) return MSG_IDS.alreadyQueued;
    if (msg.includes('queue is full') || msg.includes('full')) return MSG_IDS.queueFull;
    return MSG_IDS.failed;
  }

  // ======= GPS =======
  async function getLocation() {
    if (cachedLocation) return cachedLocation;
    if (!navigator.geolocation) {
      throw new Error('Location not supported');
    }
    return new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          cachedLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          resolve(cachedLocation);
        },
        () => reject(new Error('Location required but denied')),
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
      );
    });
  }

  async function buildBody(baseBody) {
    const body = { ...baseBody };
    if (boot.requiresLocation) {
      try {
        const loc = await getLocation();
        body.viewerLat = loc.lat;
        body.viewerLng = loc.lng;
      } catch (e) {
        showMessage(MSG_IDS.invalidLocation);
        throw e;
      }
    }
    return body;
  }

  // ======= API calls =======
  async function postJson(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
    let data = {};
    try { data = await res.json(); } catch {}
    return { ok: res.ok, status: res.status, data };
  }

  // Globals exposed to template onclick handlers
  window.OpenFalconVote = async function (sequenceName) {
    if (hasVoted) {
      showMessage(MSG_IDS.alreadyVoted);
      return;
    }
    let body;
    try { body = await buildBody({ sequenceName }); }
    catch { return; }

    const result = await postJson('/api/vote', body);
    if (result.ok) {
      hasVoted = true;
      showMessage(MSG_IDS.success);
    } else {
      showMessage(mapErrorToId(result.data?.error));
    }
  };

  window.OpenFalconRequest = async function (sequenceName) {
    let body;
    try { body = await buildBody({ sequenceName }); }
    catch { return; }

    const result = await postJson('/api/jukebox/add', body);
    if (result.ok) {
      showMessage(MSG_IDS.success);
      refreshState();
    } else {
      showMessage(mapErrorToId(result.data?.error));
    }
  };

  // RF aliases in case templates call these names
  window.vote = window.OpenFalconVote;
  window.request = window.OpenFalconRequest;

  // ======= Live state refresh =======
  async function refreshState() {
    try {
      const res = await fetch('/api/state', { credentials: 'include' });
      if (!res.ok) return;
      const data = await res.json();
      applyStateUpdate(data);
    } catch {}
  }

  function applyStateUpdate(data) {
    // --- Vote counts ---
    if (data.voteCounts) {
      // First clear all existing counts to 0 so a removed vote drops visibly
      document.querySelectorAll('[data-seq-count]').forEach(el => {
        el.textContent = '0';
      });
      data.voteCounts.forEach(v => {
        const el = document.querySelector(`[data-seq-count="${v.sequence_name}"]`);
        if (el) el.textContent = v.count;
      });
    }

    // --- Reset "already voted" gate when a new round begins ---
    if (data.viewerControlMode === 'VOTING' && data.voteCounts && data.voteCounts.length === 0) {
      hasVoted = false;
    }

    // --- NOW_PLAYING text ---
    const nowEl = document.querySelector('.now-playing-text');
    if (nowEl) {
      const nowDisplay = data.nowPlaying
        ? (data.sequences || []).find(s => s.name === data.nowPlaying)?.display_name || data.nowPlaying
        : '—';
      if (nowEl.textContent !== nowDisplay) nowEl.textContent = nowDisplay;
    }

    // --- NEXT_PLAYLIST text (RF templates use .body_text inside the jukebox container) ---
    // We can't reliably pick "the right" .body_text element without a data attribute,
    // so we tag it during render-time. Fall back: leave it alone.
    // In templates we render server-side, we add data-openfalcon-next to the NEXT_PLAYLIST spot.
    const nextEl = document.querySelector('[data-openfalcon-next]');
    if (nextEl) {
      const nextDisplay = data.nextScheduled
        ? (data.sequences || []).find(s => s.name === data.nextScheduled)?.display_name || data.nextScheduled
        : '—';
      if (nextEl.textContent !== nextDisplay) nextEl.textContent = nextDisplay;
    }

    // --- Queue size & queue list ---
    const queueSizeEl = document.querySelector('[data-openfalcon-queue-size]');
    if (queueSizeEl) queueSizeEl.textContent = String((data.queue || []).length);

    const queueListEl = document.querySelector('[data-openfalcon-queue-list]');
    if (queueListEl) {
      const byName = Object.fromEntries((data.sequences || []).map(s => [s.name, s]));
      if ((data.queue || []).length === 0) {
        queueListEl.textContent = 'Queue is empty.';
      } else {
        queueListEl.innerHTML = data.queue.map(e => {
          const seq = byName[e.sequence_name];
          const name = seq ? seq.display_name : e.sequence_name;
          return escapeHtml(name);
        }).join('<br />');
      }
    }

    // --- Sequence cover images (live-update when admin changes a cover) ---
    // Each sequence-image carries data-seq-name so we can target it precisely.
    // The server returns image_url with a ?v=<mtime> cache-buster, so a different
    // src means the cover was updated.
    (data.sequences || []).forEach(seq => {
      if (!seq.image_url) return;
      const imgs = document.querySelectorAll(`img[data-seq-name="${CSS.escape(seq.name)}"]`);
      imgs.forEach(img => {
        if (img.getAttribute('src') !== seq.image_url) {
          img.setAttribute('src', seq.image_url);
        }
      });
    });

    // --- Mode container visibility ---
    document.querySelectorAll('[data-openfalcon-container="jukebox"]').forEach(el => {
      el.style.display = data.viewerControlMode === 'JUKEBOX' ? '' : 'none';
    });
    document.querySelectorAll('[data-openfalcon-container="voting"]').forEach(el => {
      el.style.display = data.viewerControlMode === 'VOTING' ? '' : 'none';
    });
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // Heartbeat (for active viewer count)
  setInterval(() => {
    fetch('/api/heartbeat', { method: 'POST', credentials: 'include' }).catch(() => {});
  }, 15000);

  // Poll state every 3s for live updates (Socket.io provides instant updates too)
  setInterval(refreshState, 3000);

  // Initial heartbeat + immediate state refresh
  fetch('/api/heartbeat', { method: 'POST', credentials: 'include' }).catch(() => {});
  refreshState();

  // Try Socket.io if available for instant updates
  try {
    if (window.io) {
      const socket = window.io();
      socket.on('voteUpdate', () => refreshState());
      socket.on('queueUpdated', () => refreshState());
      socket.on('nowPlaying', () => refreshState());
      socket.on('voteReset', () => { hasVoted = false; refreshState(); });
      socket.on('sequencesReordered', () => refreshState()); // covers updated, sequences edited, etc.
      socket.on('sequencesSynced', () => refreshState());
    }
  } catch {}

  // ============================================================
  // LISTEN ON PHONE — in-browser audio player with live sync
  //
  // Connects DIRECTLY to the OpenFalcon audio daemon running on FPP
  // (not through the OpenFalcon server proxy). The daemon serves
  // Range-aware audio + a WebSocket time-sync feed.
  //
  // Sync strategy:
  //   1. WebSocket pushes `{ sequence, position, serverTimestamp }` ~4×/sec
  //   2. Compute target position = serverPosition + (now - serverTimestamp)
  //   3. If drift > 2 seconds → hard seek (audio.currentTime = target)
  //   4. If drift > 100ms     → adjust audio.playbackRate (subtle, inaudible)
  //   5. If drift < 100ms     → playbackRate back to 1.0
  //
  // playbackRate adjustments stay within ±2% (1.02 / 0.98) so they're inaudible
  // but accumulate to several hundred ms of correction per minute. This is the
  // same approach internet radio sync services use.
  //
  // Falls back to /api/now-playing-audio polling if WebSocket fails.
  // ============================================================
  (function initListenOnPhone() {
    const btn = document.createElement('button');
    btn.id = 'of-listen-btn';
    btn.setAttribute('aria-label', 'Listen on phone');
    btn.title = 'Listen on phone';
    btn.innerHTML = '🎧';
    btn.style.cssText = `
      position: fixed; bottom: 16px; right: 16px; z-index: 9998;
      width: 52px; height: 52px; border-radius: 50%;
      background: rgba(220,38,38,0.95); color: white;
      border: 2px solid rgba(255,255,255,0.4);
      font-size: 24px; cursor: pointer;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
      transition: transform 0.15s, background 0.15s;
      padding: 0; line-height: 1;
    `;
    btn.onmouseenter = () => { btn.style.transform = 'scale(1.08)'; };
    btn.onmouseleave = () => { btn.style.transform = 'scale(1)'; };

    const panel = document.createElement('div');
    panel.id = 'of-listen-panel';
    panel.style.cssText = `
      position: fixed; bottom: 78px; right: 16px; z-index: 9999;
      width: min(340px, calc(100vw - 32px));
      background: rgba(20,20,30,0.96); color: #fff;
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 12px; padding: 14px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.5);
      font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      font-size: 14px; line-height: 1.4;
      display: none;
    `;
    panel.innerHTML = `
      <div style="display: flex; gap: 10px; align-items: center; margin-bottom: 10px;">
        <img id="of-listen-cover" src="" alt="" style="width: 56px; height: 56px; border-radius: 6px; object-fit: cover; background: #333; flex-shrink: 0;" />
        <div style="flex: 1; min-width: 0;">
          <div id="of-listen-title" style="font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">Not playing</div>
          <div id="of-listen-artist" style="font-size: 12px; color: #aaa; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;"></div>
        </div>
        <button id="of-listen-close" aria-label="Close" style="background: transparent; border: 0; color: #aaa; font-size: 22px; cursor: pointer; padding: 0; line-height: 1;">×</button>
      </div>
      <audio id="of-listen-audio" controls style="width: 100%; height: 36px; margin-bottom: 6px;"></audio>
      <div style="display: flex; justify-content: space-between; font-size: 10px; color: #777; min-height: 14px;">
        <span id="of-listen-status"></span>
        <span id="of-listen-drift"></span>
      </div>
    `;

    document.body.appendChild(btn);
    document.body.appendChild(panel);

    const audio = panel.querySelector('#of-listen-audio');
    const titleEl = panel.querySelector('#of-listen-title');
    const artistEl = panel.querySelector('#of-listen-artist');
    const coverEl = panel.querySelector('#of-listen-cover');
    const statusEl = panel.querySelector('#of-listen-status');
    const driftEl = panel.querySelector('#of-listen-drift');
    const closeBtn = panel.querySelector('#of-listen-close');

    let panelOpen = false;
    let ws = null;
    let pollFallbackTimer = null;
    let driftCorrectionTimer = null;
    let currentSequence = null;
    let currentMediaName = null;
    let lastSyncMsg = null;     // most recent WS sync message
    let userSeeking = false;
    let metaUrls = null;        // { directStreamUrl, wsSyncUrl } from REST

    btn.onclick = () => {
      panelOpen = !panelOpen;
      panel.style.display = panelOpen ? 'block' : 'none';
      if (panelOpen) startPlayer();
      else stopPlayer();
    };
    closeBtn.onclick = () => { btn.click(); };

    audio.addEventListener('seeking', () => { userSeeking = true; });
    audio.addEventListener('seeked', () => { setTimeout(() => { userSeeking = false; }, 800); });

    async function startPlayer() {
      // Get the daemon URLs from OpenFalcon
      const r = await fetch('/api/now-playing-audio', { credentials: 'include' }).catch(() => null);
      if (!r || !r.ok) {
        statusEl.textContent = 'Server error';
        return;
      }
      const data = await r.json();
      if (!data.playing) {
        statusEl.textContent = 'Show is not playing';
        titleEl.textContent = 'Not playing';
        return;
      }
      if (!data.hasAudio) {
        statusEl.textContent = 'No audio for this sequence';
        titleEl.textContent = data.sequenceName || 'Playing';
        return;
      }

      metaUrls = {
        directStreamUrl: data.directStreamUrl,
        wsSyncUrl: data.wsSyncUrl,
        proxyStreamUrl: data.streamUrl,
      };

      // Update display
      titleEl.textContent = data.displayName || data.sequenceName;
      artistEl.textContent = data.artist || '';
      coverEl.src = data.imageUrl || '';
      coverEl.style.visibility = data.imageUrl ? 'visible' : 'hidden';

      // Try WebSocket first — preferred path with sub-second sync
      if (data.wsSyncUrl) {
        connectWebSocket(data.wsSyncUrl);
      }

      // Always have REST polling as a parallel fallback (covers WS gaps)
      pollFallbackTimer = setInterval(pollNowPlaying, 5000);
      pollNowPlaying(); // first call

      // Continuous drift correction loop — runs every 250ms
      driftCorrectionTimer = setInterval(applyDriftCorrection, 250);
    }

    function stopPlayer() {
      if (ws) { try { ws.close(); } catch {} ws = null; }
      if (pollFallbackTimer) { clearInterval(pollFallbackTimer); pollFallbackTimer = null; }
      if (driftCorrectionTimer) { clearInterval(driftCorrectionTimer); driftCorrectionTimer = null; }
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      audio.playbackRate = 1.0;
      currentSequence = null;
      currentMediaName = null;
      lastSyncMsg = null;
    }

    function connectWebSocket(wsUrl) {
      try {
        ws = new WebSocket(wsUrl);
        ws.onopen = () => {
          statusEl.textContent = '🔗 Connected';
        };
        ws.onmessage = (evt) => {
          try {
            const msg = JSON.parse(evt.data);
            if (msg.type !== 'sync') return;
            handleSyncMessage(msg);
          } catch {}
        };
        ws.onclose = () => {
          statusEl.textContent = 'Disconnected — falling back to polling';
          ws = null;
          // REST polling is already running
        };
        ws.onerror = () => {
          statusEl.textContent = 'WS error — falling back to polling';
        };
      } catch (e) {
        statusEl.textContent = 'WS unavailable — using polling';
      }
    }

    function handleSyncMessage(msg) {
      lastSyncMsg = { ...msg, receivedAt: Date.now() };

      // Track changed?
      if (msg.sequence !== currentSequence) {
        switchToTrack(msg);
      }
    }

    async function pollNowPlaying() {
      try {
        const r = await fetch('/api/now-playing-audio', { credentials: 'include' });
        if (!r.ok) return;
        const data = await r.json();
        if (!data.playing || !data.hasAudio) {
          // Show stopped or no audio — don't disrupt if WS is sending updates
          if (!ws || ws.readyState !== 1) {
            if (currentSequence) stopPlayer();
            statusEl.textContent = data.playing ? 'No audio for this sequence' : 'Show is not playing';
          }
          return;
        }
        // Update metadata that REST has but WS doesn't (cover, artist, displayName)
        if (data.sequenceName === currentSequence) {
          if (data.imageUrl && coverEl.src !== data.imageUrl) coverEl.src = data.imageUrl;
          if (data.artist) artistEl.textContent = data.artist;
        }
        // If WS isn't connected, use REST as the sync source
        if (!ws || ws.readyState !== 1) {
          handleSyncMessage({
            type: 'sync',
            sequence: data.sequenceName,
            mediaName: data.sequenceName,  // best we have without daemon
            position: data.elapsedSec,
            trackDuration: data.durationSec,
            serverTimestamp: Date.now(),
          });
          // Also keep meta refreshed for cover/title
          if (data.sequenceName !== currentSequence) {
            titleEl.textContent = data.displayName || data.sequenceName;
            artistEl.textContent = data.artist || '';
            coverEl.src = data.imageUrl || '';
            coverEl.style.visibility = data.imageUrl ? 'visible' : 'hidden';
          }
        }
      } catch {}
    }

    function switchToTrack(msg) {
      currentSequence = msg.sequence;
      currentMediaName = msg.mediaName || msg.sequence;
      statusEl.textContent = 'Loading audio…';

      // Compute initial seek (target = position + network latency estimate)
      const seekTo = Math.max(0, msg.position - 0.2);

      // Build stream URL — prefer direct daemon, fall back to OpenFalcon proxy
      let streamUrl;
      if (metaUrls && metaUrls.directStreamUrl && currentMediaName) {
        // Daemon URL is keyed by mediaName (the actual filename)
        const baseUrl = metaUrls.directStreamUrl.replace(/\/audio\/[^/]+$/, '/audio/');
        streamUrl = baseUrl + encodeURIComponent(currentMediaName);
      } else if (metaUrls && metaUrls.proxyStreamUrl) {
        streamUrl = metaUrls.proxyStreamUrl;
      } else {
        return;
      }

      // Use Media Fragment URI for initial position
      audio.src = streamUrl + (seekTo > 0 ? ('#t=' + seekTo.toFixed(2)) : '');

      audio.addEventListener('loadedmetadata', function onMeta() {
        audio.removeEventListener('loadedmetadata', onMeta);
        try {
          if (Number.isFinite(audio.duration) && seekTo < audio.duration) {
            audio.currentTime = seekTo;
          }
        } catch {}
        audio.play().catch(() => {
          statusEl.textContent = 'Tap play to start audio';
        });
      }, { once: true });
      audio.addEventListener('canplay', () => { statusEl.textContent = ''; }, { once: true });
    }

    function applyDriftCorrection() {
      if (!lastSyncMsg || !currentSequence || audio.paused || userSeeking) {
        if (driftEl) driftEl.textContent = '';
        return;
      }

      // Compute where we SHOULD be: server's reported position +
      // time elapsed since that report
      const sinceReport = (Date.now() - lastSyncMsg.receivedAt) / 1000;
      const serverPosition = lastSyncMsg.position + sinceReport;

      const drift = audio.currentTime - serverPosition;
      const absDrift = Math.abs(drift);

      // Update drift indicator
      if (driftEl) {
        const ms = Math.round(drift * 1000);
        driftEl.textContent = (ms >= 0 ? '+' : '') + ms + 'ms';
        driftEl.style.color = absDrift < 0.15 ? '#4ade80' : (absDrift < 1 ? '#fb923c' : '#ef4444');
      }

      // Hard seek if way off
      if (absDrift > 2) {
        try {
          if (Number.isFinite(audio.duration) && serverPosition < audio.duration) {
            audio.currentTime = serverPosition;
            audio.playbackRate = 1.0;
          }
        } catch {}
        return;
      }

      // playbackRate correction: speed up or slow down up to 2%
      if (absDrift < 0.1) {
        audio.playbackRate = 1.0;
      } else if (drift < 0) {
        // We're behind — speed up
        audio.playbackRate = absDrift > 0.5 ? 1.02 : 1.01;
      } else {
        // We're ahead — slow down
        audio.playbackRate = absDrift > 0.5 ? 0.98 : 0.99;
      }
    }
  })();
})();
