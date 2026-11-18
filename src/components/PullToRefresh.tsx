"use client";

import { useEffect, useRef, useState } from "react";

// Pull-to-refresh for window-scrolled feeds (touch drag on mobile, wheel/trackpad
// overscroll on desktop).
//
// Design notes, because the previous version got each of these wrong:
// - The drag is rendered by writing a transform straight to the bubble element.
//   No React state changes per touchmove, so the page (hundreds of PostCards)
//   never re-renders mid-gesture.
// - The bubble is an overlay in a zero-height wrapper. It never changes layout
//   height, so the feed doesn't get shoved around while pulling or refreshing.
// - Direction is decided only after the finger moves past SLOP px, so a 1px
//   sideways jitter on the first touchmove doesn't abandon the whole gesture.
// - touchcancel is handled, and every touchstart resets gesture state, so a
//   cancelled touch can't leave a stale gesture behind.
// - Only touches/wheels that start inside the page content count, so dragging
//   inside the compose sheet or nav drawer (which pin body, making scrollY 0)
//   doesn't fire a background refresh or block the sheet's own scrolling.
// - Wheel events that are part of a stream that started away from the top
//   (trackpad momentum carrying you up to the top) are ignored, so arriving at
//   the top quickly doesn't refresh by accident.
// - The pull is never disabled while a fetch is running: the bubble just shows
//   the in-flight refresh. onRefresh is expected to join an in-flight fetch
//   rather than return immediately.

const SLOP = 8;           // px of finger travel before we commit to a direction
const TOUCH_RESIST = 0.5; // bubble travel per px of finger travel
const WHEEL_RESIST = 0.4; // bubble travel per px of wheel delta
const THRESHOLD = 48;     // bubble travel needed to trigger
const MAX_PULL = 80;      // bubble travel cap
const REST = 20;          // bubble offset while refreshing
const BUBBLE = 40;        // bubble diameter (keep in sync with .ptr-bubble)
const WHEEL_GAP_MS = 250; // a pause this long starts a new wheel gesture
const HARD_TIMEOUT_MS = 12_000;

type Phase = "idle" | "pending" | "pulling" | "rejected";

function atTop() {
  return window.scrollY <= 1;
}

function inContent(target: EventTarget | null) {
  return target instanceof Element && target.closest(".app-content") !== null;
}

function wheelPixels(e: WheelEvent): number {
  if (e.deltaMode === 1) return Math.abs(e.deltaY) * 16;  // lines → px
  if (e.deltaMode === 2) return Math.abs(e.deltaY) * 400; // pages → px
  return Math.abs(e.deltaY);
}

export function PullToRefresh({
  onRefresh,
  refreshing: externalRefreshing = false,
}: {
  onRefresh: () => Promise<unknown>;
  // Show the bubble for refreshes started elsewhere (initial load, nav-tab tap).
  refreshing?: boolean;
}) {
  const [triggered, setTriggered] = useState(false);
  const spinning = triggered || externalRefreshing;

  const bubbleRef = useRef<HTMLDivElement>(null);
  const onRefreshRef = useRef(onRefresh);
  useEffect(() => { onRefreshRef.current = onRefresh; }, [onRefresh]);
  const spinningRef = useRef(spinning);
  const busyRef = useRef(false);

  // Positions the bubble. `animate` turns on the CSS transition (release,
  // snap-back, refresh start/end); during a drag it's off so it tracks 1:1.
  const paint = useRef((pull: number, animate: boolean) => {
    const el = bubbleRef.current;
    if (!el) return;
    el.classList.toggle("ptr-animating", animate);
    el.classList.toggle("ptr-armed", pull >= THRESHOLD);
    el.style.transform = `translate3d(0, ${pull - BUBBLE}px, 0)`;
    el.style.opacity = pull <= 0 ? "0" : String(Math.min(1, pull / THRESHOLD));
    const arc = el.firstElementChild as HTMLElement | null;
    if (arc) arc.style.transform = `rotate(${pull * 4}deg)`;
  });

  // Refresh state → bubble position. Runs on mount too, which hides it.
  useEffect(() => {
    spinningRef.current = spinning;
    const el = bubbleRef.current;
    el?.classList.toggle("ptr-refreshing", spinning);
    paint.current(spinning ? REST + BUBBLE : 0, true);
  }, [spinning]);

  useEffect(() => {
    const draw = paint.current;

    const trigger = async () => {
      if (busyRef.current) return;
      busyRef.current = true;
      setTriggered(true);
      try {
        await Promise.race([
          onRefreshRef.current(),
          new Promise((resolve) => setTimeout(resolve, HARD_TIMEOUT_MS)),
        ]);
      } catch (err) {
        console.error("[PullToRefresh] onRefresh threw:", err);
      } finally {
        busyRef.current = false;
        setTriggered(false);
      }
    };

    const settle = () => draw(spinningRef.current ? REST + BUBBLE : 0, true);

    // ── touch ─────────────────────────────────────────────────
    let phase: Phase = "idle";
    let startX = 0;
    let startY = 0;
    let pull = 0;
    let frame = 0;

    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (phase === "pulling") draw(pull, false);
      });
    };

    const endGesture = (commit: boolean) => {
      const wasPulling = phase === "pulling";
      const armed = pull >= THRESHOLD;
      phase = "idle";
      pull = 0;
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
      if (!wasPulling) return;
      if (commit && armed) {
        // Leave the bubble where the finger let go; the spinning effect animates
        // it to REST once `triggered` flips.
        trigger();
      } else {
        settle();
      }
    };

    const onTouchStart = (e: TouchEvent) => {
      endGesture(false);
      if (e.touches.length !== 1) return;
      if (busyRef.current || spinningRef.current) return;
      if (!atTop() || !inContent(e.target)) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      phase = "pending";
    };

    const onTouchMove = (e: TouchEvent) => {
      if (phase === "idle" || phase === "rejected") return;
      if (e.touches.length !== 1) { endGesture(false); phase = "rejected"; return; }
      const dy = e.touches[0].clientY - startY;
      const dx = Math.abs(e.touches[0].clientX - startX);

      if (phase === "pending") {
        if (dy < SLOP && dx < SLOP) {
          // Still deciding. Swallow small downward moves so the browser doesn't
          // start a native overscroll that would make later moves uncancelable.
          if (dy > 0 && dy >= dx && e.cancelable) e.preventDefault();
          return;
        }
        if (dy > dx && dy > 0) {
          phase = "pulling";
        } else {
          phase = "rejected";
          return;
        }
      }

      // phase === "pulling"
      if (dy < -SLOP) {
        // Dragged back up past the start: hand the gesture back to scrolling.
        endGesture(false);
        phase = "rejected";
        return;
      }
      if (e.cancelable) e.preventDefault();
      pull = Math.min(Math.max(0, dy - SLOP) * TOUCH_RESIST, MAX_PULL);
      schedule();
    };

    const onTouchEnd = () => endGesture(true);
    const onTouchCancel = () => endGesture(false);

    // ── wheel (desktop overscroll) ────────────────────────────
    let wheelLast = 0;
    let wheelTainted = false;
    let wheelAcc = 0;
    let wheelReset: ReturnType<typeof setTimeout> | null = null;

    const onWheel = (e: WheelEvent) => {
      const now = performance.now();
      if (now - wheelLast > WHEEL_GAP_MS) {
        // New wheel gesture.
        wheelTainted = false;
        wheelAcc = 0;
      }
      wheelLast = now;

      if (busyRef.current || spinningRef.current) { wheelTainted = true; return; }
      // Any part of this stream spent scrolling (not at the top, or moving
      // down) means it's momentum/regular scrolling, not a deliberate pull.
      if (!atTop() || e.deltaY >= 0 || !inContent(e.target)) {
        if (wheelAcc > 0) settle();
        wheelTainted = true;
        wheelAcc = 0;
        return;
      }
      if (wheelTainted) return;

      wheelAcc += wheelPixels(e);
      const wheelPull = Math.min(wheelAcc * WHEEL_RESIST, MAX_PULL);
      draw(wheelPull, false);

      if (wheelReset) clearTimeout(wheelReset);
      wheelReset = setTimeout(() => { wheelAcc = 0; settle(); }, WHEEL_GAP_MS + 50);

      if (wheelPull >= THRESHOLD) {
        wheelTainted = true; // the rest of this stream mustn't re-trigger
        wheelAcc = 0;
        if (wheelReset) clearTimeout(wheelReset);
        trigger();
      }
    };

    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    window.addEventListener("touchcancel", onTouchCancel, { passive: true });
    window.addEventListener("wheel", onWheel, { passive: true });

    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("touchcancel", onTouchCancel);
      window.removeEventListener("wheel", onWheel);
      if (frame) cancelAnimationFrame(frame);
      if (wheelReset) clearTimeout(wheelReset);
    };
  }, []);

  return (
    <div className="ptr" aria-hidden={!spinning}>
      <div className="ptr-bubble" ref={bubbleRef} role="status" aria-label={spinning ? "Refreshing" : undefined}>
        <div className="ptr-arc" />
      </div>
    </div>
  );
}
