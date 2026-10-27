/* ─────────────────────────────────────────────────────────────────────────────
   Kit — deterministic motion helpers for HyperFrames scenes (GSAP core only).
   Rules (HyperFrames determinism): no Math.random, no Date, no network.
   Every helper takes the scene timeline `tl` and an absolute scene time `at`
   (seconds from scene start). Use Kit.cue(CUES, beat, word) for `at` so the
   animation stays locked to the narration when the voice is regenerated.
   ───────────────────────────────────────────────────────────────────────────── */
(function () {
  const Kit = {};

  Kit.palette = {
    ink: "#0e1b3d", deep: "#162a5c", dusk: "#24407f", sky: "#3fa7f5", skyDeep: "#1554b8", mint: "#3fe0b0",
    sun: "#ffc94a", coral: "#ff6b5e", violet: "#8e6cf0", paper: "#f6f1e7", muted: "#9fb0d6",
  };

  /** Seeded PRNG (mulberry32). Same seed → same layout on every render. */
  Kit.rng = function (seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  /** Create and register the scene's paused root timeline. */
  Kit.scene = function (id, duration) {
    window.__timelines = window.__timelines || {};
    const tl = gsap.timeline({ paused: true, defaults: { ease: "power3.out" } });
    // Pin the timeline length to the narration window so seek(0..duration) is always defined.
    tl.set({}, {}, duration);
    window.__timelines[id] = tl;
    return tl;
  };

  /**
   * Scene-relative time of a narration cue. `word` is matched case-insensitively against the beat's
   * words (first occurrence); omit it for the beat start. `nth` picks a later occurrence.
   */
  Kit.cue = function (CUES, beat, word, offset, nth) {
    const b = CUES.beats[beat];
    if (!b) throw new Error("unknown beat " + beat);
    let t = b.start;
    if (word) {
      const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
      const target = norm(word);
      let seen = 0;
      for (const [w, ws] of b.words) {
        if (norm(w) === target && seen++ === (nth || 0)) { t = ws; break; }
      }
    }
    return Math.max(0, t + (offset || 0));
  };

  /** End of speech for a beat (scene-relative). */
  Kit.beatEnd = function (CUES, beat) { return CUES.beats[beat].speech_end; };

  // ── Entrances ───────────────────────────────────────────────────────────────
  Kit.pop = function (tl, target, at, o) {
    o = o || {};
    tl.fromTo(target, { scale: 0, opacity: 0, transformOrigin: o.origin || "50% 50%" },
      { scale: 1, opacity: 1, duration: o.duration || 0.55, ease: o.ease || "back.out(1.8)", stagger: o.stagger || 0 }, at);
    return tl;
  };

  Kit.fadeUp = function (tl, target, at, o) {
    o = o || {};
    tl.fromTo(target, { y: o.y || 40, opacity: 0 },
      { y: 0, opacity: 1, duration: o.duration || 0.6, stagger: o.stagger || 0, ease: o.ease || "power3.out" }, at);
    return tl;
  };

  Kit.fadeOut = function (tl, target, at, o) {
    o = o || {};
    tl.to(target, { opacity: 0, y: o.y || 0, duration: o.duration || 0.4, ease: "power2.in" }, at);
    return tl;
  };

  /** Draw an SVG stroke on (paths, lines, circles). */
  Kit.drawOn = function (tl, target, at, duration, o) {
    o = o || {};
    const els = gsap.utils.toArray(target);
    els.forEach(function (el, i) {
      const len = el.getTotalLength ? el.getTotalLength() : 1000;
      gsap.set(el, { strokeDasharray: len, strokeDashoffset: len });
      tl.to(el, { strokeDashoffset: 0, duration: duration || 1, ease: o.ease || "power2.inOut" }, at + i * (o.stagger || 0));
    });
    return tl;
  };

  /** Reveal text character by character (wraps characters in spans once). */
  Kit.typeOn = function (tl, target, at, cps) {
    gsap.utils.toArray(target).forEach(function (el) {
      const text = el.textContent;
      el.textContent = "";
      const spans = Array.from(text).map(function (ch) {
        const s = document.createElement("span");
        s.textContent = ch;
        s.style.opacity = "0";
        el.appendChild(s);
        return s;
      });
      tl.to(spans, { opacity: 1, duration: 0.01, stagger: 1 / (cps || 28), ease: "none" }, at);
    });
    return tl;
  };

  /** Animate a number from `from` to `to`. `fmt(n)` formats the displayed value. */
  Kit.countUp = function (tl, target, at, to, duration, o) {
    o = o || {};
    const el = document.querySelector(target);
    const state = { v: o.from || 0 };
    const fmt = o.fmt || function (n) { return Math.round(n).toLocaleString("en-US"); };
    el.textContent = fmt(state.v);
    tl.to(state, { v: to, duration: duration || 1.5, ease: o.ease || "power2.out", onUpdate: function () { el.textContent = fmt(state.v); } }, at);
    return tl;
  };

  // ── Life ────────────────────────────────────────────────────────────────────
  /** Gentle bob between `from` and `to` (seek-safe: a finite repeat count, no infinite tweens). */
  Kit.float = function (tl, target, from, to, o) {
    o = o || {};
    const period = o.period || 3;
    const reps = Math.max(0, Math.floor((to - from) / (period / 2)) - 1);
    tl.fromTo(target, { y: -(o.y || 10) }, { y: o.y || 10, duration: period / 2, ease: "sine.inOut", yoyo: true, repeat: reps }, from);
    return tl;
  };

  /** Blink Mote's eyes at the given scene times. */
  Kit.blink = function (tl, eyes, times) {
    times.forEach(function (t) {
      tl.to(eyes, { scaleY: 0.1, transformOrigin: "50% 50%", duration: 0.07, ease: "power1.in" }, t)
        .to(eyes, { scaleY: 1, duration: 0.1, ease: "power1.out" }, t + 0.08);
    });
    return tl;
  };

  /** Camera move on a world container: keys = [{at, x, y, scale, duration, ease}]. */
  Kit.camera = function (tl, world, keys) {
    keys.forEach(function (k) {
      tl.to(world, { x: k.x || 0, y: k.y || 0, scale: k.scale || 1, duration: k.duration || 1.2, ease: k.ease || "power2.inOut", transformOrigin: "50% 50%" }, k.at);
    });
    return tl;
  };

  /** Full-frame colour wipe through an element with class k-wipe (place it last in the stage). */
  Kit.wipe = function (tl, el, at, o) {
    o = o || {};
    const d = o.duration || 0.7;
    tl.set(el, { transformOrigin: "left center" }, at)
      .fromTo(el, { scaleX: 0 }, { scaleX: 1, duration: d / 2, ease: "power2.in" }, at)
      .set(el, { transformOrigin: "right center" }, at + d / 2)
      .to(el, { scaleX: 0, duration: d / 2, ease: "power2.out" }, at + d / 2);
    return tl;
  };

  // ── Builders ────────────────────────────────────────────────────────────────
  /** Deterministic star field. Returns the container. */
  Kit.stars = function (container, o) {
    o = o || {};
    const rnd = Kit.rng(o.seed || 7);
    const host = typeof container === "string" ? document.querySelector(container) : container;
    const w = o.width || 1920, h = o.height || 1080, n = o.count || 140;
    let html = '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + " " + h + '">';
    for (let i = 0; i < n; i++) {
      const r = rnd() < 0.85 ? 1 + rnd() * 1.6 : 2.5 + rnd() * 1.5;
      html += '<circle class="k-star" cx="' + (rnd() * w).toFixed(1) + '" cy="' + (rnd() * h).toFixed(1) + '" r="' + r.toFixed(2) +
        '" fill="#f6f1e7" opacity="' + (0.25 + rnd() * 0.6).toFixed(2) + '"/>';
    }
    host.innerHTML += html + "</svg>";
    return host;
  };

  const MOUTHS = {
    happy: '<path class="m-mouth" d="M84 128 Q100 146 116 128"/>',
    curious: '<ellipse class="m-mouth-o" cx="104" cy="134" rx="7" ry="8"/>',
    surprised: '<ellipse class="m-mouth-o" cx="100" cy="136" rx="12" ry="15"/>',
    thinking: '<path class="m-mouth" d="M88 134 Q100 128 114 136"/>',
    worried: '<path class="m-mouth" d="M86 138 Q100 126 114 138"/>',
  };

  /**
   * Mote — the channel's guide character: a speck of curiosity. Parts are addressable for animation:
   * .m-body .m-eye .m-pupil .m-mouth .m-arm-l .m-arm-r .m-spark
   */
  Kit.mascot = function (o) {
    o = o || {};
    const size = o.size || 220;
    const mood = MOUTHS[o.mood] ? o.mood : "happy";
    return (
      '<svg class="mote ' + (o.className || "") + '" width="' + size + '" height="' + size + '" viewBox="0 0 200 200">' +
      '<ellipse cx="100" cy="186" rx="52" ry="8" fill="rgba(4,10,30,.35)"/>' +
      '<path class="m-arm m-arm-l" d="M40 122 Q20 116 22 96"/>' +
      '<path class="m-arm m-arm-r" d="M160 122 Q180 116 178 96"/>' +
      '<circle class="m-shade" cx="100" cy="110" r="68"/>' +
      '<circle class="m-body" cx="95" cy="104" r="62"/>' +
      '<ellipse cx="72" cy="70" rx="14" ry="9" fill="#fff" opacity=".35" transform="rotate(-30 72 70)"/>' +
      '<ellipse class="m-cheek" cx="62" cy="122" rx="11" ry="7"/><ellipse class="m-cheek" cx="138" cy="122" rx="11" ry="7"/>' +
      '<g class="m-eyes"><ellipse class="m-eye" cx="80" cy="98" rx="16" ry="20"/><ellipse class="m-eye" cx="120" cy="98" rx="16" ry="20"/>' +
      '<circle class="m-pupil" cx="83" cy="102" r="8"/><circle class="m-pupil" cx="123" cy="102" r="8"/></g>' +
      MOUTHS[mood] +
      '<path class="m-spark" d="M100 20 L104 34 L118 38 L104 42 L100 56 L96 42 L82 38 L96 34 Z"/>' +
      "</svg>"
    );
  };

  /**
   * A flat-vector Earth: ocean disc, two copies of a land strip (animate `.g-land` x from 0 to -720
   * for one seamless rotation), night-side shading, highlight and atmosphere ring (`.g-air`).
   */
  Kit.globe = function (o) {
    o = o || {};
    const id = o.id || "globe";
    const size = o.size || 400;
    const land =
      '<path d="M40 120 q40 -50 110 -30 q50 10 60 50 q-10 40 -60 50 q-30 40 -80 20 q-50 -30 -30 -90z"/>' +
      '<path d="M250 60 q50 -20 90 10 q20 30 -10 60 q-40 20 -70 0 q-30 -30 -10 -70z"/>' +
      '<path d="M200 230 q60 -20 100 20 q30 60 -10 110 q-40 40 -70 0 q-40 -60 -20 -130z"/>' +
      '<path d="M420 140 q80 -60 170 -20 q60 30 40 90 q-20 50 -80 40 q-30 60 -90 30 q-60 -40 -40 -140z"/>' +
      '<path d="M560 290 q50 -10 70 30 q0 40 -50 40 q-40 -20 -20 -70z"/>';
    return (
      '<svg class="globe ' + (o.className || "") + '" width="' + size + '" height="' + size + '" viewBox="0 0 400 400">' +
      '<defs><clipPath id="' + id + '-clip"><circle cx="200" cy="200" r="180"/></clipPath></defs>' +
      '<circle class="g-air" cx="200" cy="200" r="194" fill="none" stroke="#3fa7f5" stroke-opacity=".35" stroke-width="10" stroke-dasharray="30 18"/>' +
      '<circle cx="200" cy="200" r="180" fill="#2b7fd4"/>' +
      '<g clip-path="url(#' + id + '-clip)">' +
      '<g class="g-land" fill="#3fe0b0"><g transform="translate(-160 0)">' + land + '</g><g transform="translate(560 0)">' + land + '</g></g>' +
      '<circle cx="290" cy="215" r="200" fill="#0e1b3d" opacity=".32"/>' +
      '<ellipse cx="130" cy="110" rx="46" ry="26" fill="#fff" opacity=".18" transform="rotate(-35 130 110)"/>' +
      "</g>" +
      '<line class="g-equator" x1="20" y1="200" x2="380" y2="200" stroke="#f6f1e7" stroke-opacity=".0" stroke-width="3" stroke-dasharray="8 8"/>' +
      "</svg>"
    );
  };

  /** Spin a globe made by Kit.globe: `turns` land-strip loops between `from` and `to`. */
  Kit.spinGlobe = function (tl, globeSel, from, to, turns) {
    const land = document.querySelector(globeSel + " .g-land");
    const n = Math.max(1, turns || 1);
    tl.fromTo(land, { x: 0 }, { x: -720, duration: (to - from) / n, ease: "none", repeat: n - 1 }, from);
    tl.fromTo(globeSel + " .g-air", { rotation: 0, transformOrigin: "200px 200px" }, { rotation: -60 * n, duration: to - from, ease: "none" }, from);
    return tl;
  };

  /** Insert HTML into a selector and return the element. */
  Kit.mount = function (selector, html) {
    const el = document.querySelector(selector);
    el.innerHTML = html;
    return el;
  };

  window.Kit = Kit;
})();
