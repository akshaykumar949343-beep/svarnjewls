/* ============================================================
   WEAR — scroll-scrubbed "shop by category" video.
   A single video (one product shot per category, back to back) has
   its currentTime driven by scroll position while the user is actively
   scrolling. The instant scrolling goes idle, control hands off to the
   video's own native (looped) playback — so the category on screen keeps
   auto-advancing to the next one, particles and all, exactly as if you
   kept scrolling yourself, until the user scrolls again. Pure video +
   rAF — no WebGL.
   ============================================================ */

const REDUCE_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* start/end (seconds) of each category's shot inside category-video.mp4,
   in the order they appear in the footage — matches the .wear-cat[data-cat]
   markup 1:1. Small gaps between a category's `end` and the next one's
   `start` are the transition beats (empty branch, a leaf drifting past)
   and are left in — scrubbing plays straight through them. */
const SEGMENTS = [
  { start: 0.0, end: 8.0 },   // 0 · Necklaces
  { start: 9.5, end: 17.0 },  // 1 · Bangles
  { start: 18.0, end: 26.5 }, // 2 · Chains
  { start: 27.0, end: 37.0 }, // 3 · Earrings
  { start: 38.0, end: 43.5 }, // 4 · Rings
];
const FALLBACK_DURATION = 43.583333;
const IDLE_MS = 220; // how long the scroll has to sit still before we hand off to native playback
const SCRUB_LERP = 0.35;

const root = document.getElementById('wear');
if (root) initWear(root);

function initWear(root) {
  if (REDUCE_MOTION) {
    root.classList.add('no-motion');
    return;
  }

  const pin = root.querySelector('.wear-pin');
  const cats = Array.from(root.querySelectorAll('.wear-cat'));
  const progressFill = root.querySelector('.wear-progress i');
  const video = document.getElementById('wearVideo');
  if (!pin || cats.length < 2 || !video) return;

  // the desktop clip is shot landscape; phone widths get their own portrait
  // re-shoot instead (same category order/timing, so SEGMENTS below still
  // applies — object-fit:cover would otherwise crop the landscape source
  // down to a sliver, same issue as the hero video)
  if (window.matchMedia('(max-width:680px)').matches) {
    video.src = 'duo/video/category-video-mobile.mp4';
  }

  const N = cats.length;

  // lazily start loading the video once the section is within reach, rather
  // than competing with the hero videos for bandwidth on first paint
  let loadStarted = false;
  const preloadIO = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting && !loadStarted) {
        loadStarted = true;
        video.preload = 'auto';
        video.load();
        preloadIO.disconnect();
      }
    });
  }, { rootMargin: '800px 0px 800px 0px' });
  preloadIO.observe(root);

  let duration = FALLBACK_DURATION;
  video.addEventListener('loadedmetadata', () => {
    if (isFinite(video.duration) && video.duration > 0) duration = video.duration;
  });

  // per-category fade window, in dwell fraction (0-1): opaque across its own
  // [start,end], crossfading with its neighbour across the gap between them
  function windowsFor(dur) {
    return cats.map((_, i) => {
      const seg = SEGMENTS[i] || SEGMENTS[SEGMENTS.length - 1];
      const prevEnd = i === 0 ? 0 : (SEGMENTS[i - 1].end / dur);
      const nextStart = i === N - 1 ? 1 : (SEGMENTS[i + 1].start / dur);
      return {
        fadeInStart: prevEnd,
        fadeInEnd: seg.start / dur,
        fadeOutStart: seg.end / dur,
        fadeOutEnd: nextStart,
      };
    });
  }

  let active = false;
  let raf = null;
  let displayedTime = 0;
  let lastScrollDwell = -1;
  let lastMoveAt = 0;
  let playingIdle = false;

  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      active = entry.isIntersecting;
      if (active && !raf) raf = requestAnimationFrame(tick);
      if (!active) {
        video.pause();
        video.loop = false;
        playingIdle = false;
      }
    });
  }, { threshold: 0 });
  io.observe(root);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { video.pause(); video.loop = false; playingIdle = false; }
    else if (active && !raf) raf = requestAnimationFrame(tick);
  });

  function tick() {
    raf = null;
    if (!active || document.hidden) return;

    const vh = window.innerHeight;

    const wearTop = root.getBoundingClientRect().top;
    const dwellRange = Math.max(1, root.offsetHeight - vh);
    const scrollDwell = clamp(-wearTop / dwellRange, 0, 1);

    // ---- decide who's driving: the scrollbar, or the video's own clock ----
    // scrolling scrubs the video to match scroll position; the moment
    // scrolling goes idle, the video free-plays (looped) on its own and
    // *that* playback position becomes the source of truth for which
    // category is on screen — so idle dwelling auto-advances through the
    // categories exactly like continued scrolling would.
    if (Math.abs(scrollDwell - lastScrollDwell) > 0.00025) lastMoveAt = performance.now();
    lastScrollDwell = scrollDwell;
    const idle = performance.now() - lastMoveAt > IDLE_MS;
    const videoReady = video.readyState >= 1;

    let dwell = scrollDwell;
    if (videoReady) {
      if (!idle) {
        if (playingIdle) { video.pause(); video.loop = false; playingIdle = false; }
        const targetTime = scrollDwell * duration;
        displayedTime += (targetTime - displayedTime) * SCRUB_LERP;
        if (Math.abs(displayedTime - video.currentTime) > 0.02) {
          try { video.currentTime = displayedTime; } catch (e) { /* not seekable yet */ }
        }
        dwell = scrollDwell;
      } else {
        if (!playingIdle) {
          playingIdle = true;
          video.loop = true;
          const p = video.play();
          if (p && p.catch) p.catch(() => {});
        }
        displayedTime = video.currentTime;
        dwell = clamp(video.currentTime / duration, 0, 1);
      }
    }

    const windows = windowsFor(duration);
    windows.forEach((w, i) => {
      let weight = 0;
      if (dwell <= w.fadeInStart) weight = i === 0 ? 1 : 0;
      else if (dwell < w.fadeInEnd) weight = smoothstep((dwell - w.fadeInStart) / Math.max(0.0001, w.fadeInEnd - w.fadeInStart));
      else if (dwell <= w.fadeOutStart) weight = 1;
      else if (dwell < w.fadeOutEnd) weight = 1 - smoothstep((dwell - w.fadeOutStart) / Math.max(0.0001, w.fadeOutEnd - w.fadeOutStart));
      else weight = i === N - 1 ? 1 : 0;

      cats[i].style.opacity = weight.toFixed(3);
      // every .wear-cat stacks at inset:0 on top of the others, so without
      // this a hidden category's CTA link would still be hoverable/clickable
      // underneath whichever one is actually showing
      cats[i].style.pointerEvents = weight > 0.5 ? 'auto' : 'none';
    });

    if (progressFill) progressFill.style.width = (dwell * 100).toFixed(2) + '%';

    raf = requestAnimationFrame(tick);
  }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function smoothstep(t) { const c = clamp(t, 0, 1); return c * c * (3 - 2 * c); }
