import { useEffect, useRef, useState } from "react";

const THRESHOLD = 80;
const MAX_PULL = 96;

// Normalize wheel deltaY to approximate pixels regardless of deltaMode
function wheelPixels(e: WheelEvent): number {
  if (e.deltaMode === 0) return Math.abs(e.deltaY);       // already pixels
  if (e.deltaMode === 1) return Math.abs(e.deltaY) * 16;  // lines → px
  return Math.abs(e.deltaY) * 400;                        // pages → px
}

export function usePullToRefresh(onRefresh: () => Promise<void>, disabled = false) {
  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  // Touch state
  const touchStartY = useRef(0);
  const touchStartX = useRef(0);
  const touchActive = useRef(false);
  const touchDistance = useRef(0);

  // Wheel state
  const wheelAccumulated = useRef(0);
  const wheelResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Use refs for values read inside event handlers to avoid stale closures
  // and prevent the effect from re-running (and re-registering listeners) mid-refresh.
  const refreshingRef = useRef(false);
  const disabledRef = useRef(disabled);
  const onRefreshRef = useRef(onRefresh);
  useEffect(() => { disabledRef.current = disabled; }, [disabled]);
  useEffect(() => { onRefreshRef.current = onRefresh; }, [onRefresh]);

  useEffect(() => {
    // ── shared trigger ────────────────────────────────────────
    const trigger = async () => {
      if (refreshingRef.current) return;
      refreshingRef.current = true;
      setRefreshing(true);
      setPullDistance(0);
      try {
        await onRefreshRef.current();
      } finally {
        refreshingRef.current = false;
        setRefreshing(false);
      }
    };

    // ── touch ─────────────────────────────────────────────────
    const onTouchStart = (e: TouchEvent) => {
      if (disabledRef.current || refreshingRef.current || window.scrollY > 0) return;
      touchStartY.current = e.touches[0].clientY;
      touchStartX.current = e.touches[0].clientX;
      touchActive.current = true;
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!touchActive.current) return;
      const deltaY = e.touches[0].clientY - touchStartY.current;
      const deltaX = Math.abs(e.touches[0].clientX - touchStartX.current);
      if (deltaY <= 0 || window.scrollY > 0 || deltaX > deltaY) {
        touchActive.current = false;
        touchDistance.current = 0;
        setPullDistance(0);
        return;
      }
      e.preventDefault();
      const capped = Math.min(deltaY, MAX_PULL);
      touchDistance.current = capped;
      setPullDistance(capped);
    };

    const onTouchEnd = async () => {
      if (!touchActive.current) return;
      touchActive.current = false;
      const d = touchDistance.current;
      touchDistance.current = 0;
      setPullDistance(0);
      if (d >= THRESHOLD) await trigger();
    };

    // ── wheel (desktop overscroll) ────────────────────────────
    const onWheel = (e: WheelEvent) => {
      if (disabledRef.current || refreshingRef.current) return;

      // Only care about upward scroll at the very top of the page
      if (window.scrollY > 0 || e.deltaY >= 0) {
        if (wheelAccumulated.current > 0) {
          wheelAccumulated.current = 0;
          setPullDistance(0);
        }
        return;
      }

      wheelAccumulated.current = Math.min(
        wheelAccumulated.current + wheelPixels(e),
        MAX_PULL
      );
      setPullDistance(wheelAccumulated.current);

      // Reset indicator if the user stops scrolling
      if (wheelResetTimer.current) clearTimeout(wheelResetTimer.current);
      wheelResetTimer.current = setTimeout(() => {
        wheelAccumulated.current = 0;
        setPullDistance(0);
      }, 400);

      if (wheelAccumulated.current >= THRESHOLD) {
        wheelAccumulated.current = 0;
        if (wheelResetTimer.current) clearTimeout(wheelResetTimer.current);
        trigger();
      }
    };

    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("touchend", onTouchEnd);
    window.addEventListener("wheel", onWheel, { passive: true });

    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("wheel", onWheel);
      if (wheelResetTimer.current) clearTimeout(wheelResetTimer.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { pullDistance, refreshing };
}
