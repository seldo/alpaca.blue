import { useEffect, useRef, useState } from "react";

const THRESHOLD = 72;
const MAX_PULL = 96;

export function usePullToRefresh(onRefresh: () => Promise<void>, disabled = false) {
  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const startYRef = useRef(0);
  const activeRef = useRef(false);
  const pullDistanceRef = useRef(0);

  useEffect(() => {
    // ── shared release logic ──────────────────────────────────
    const release = async () => {
      if (!activeRef.current) return;
      activeRef.current = false;
      setDragging(false);
      const distance = pullDistanceRef.current;
      setPullDistance(0);
      pullDistanceRef.current = 0;
      if (distance >= THRESHOLD) {
        setRefreshing(true);
        try {
          await onRefresh();
        } finally {
          setRefreshing(false);
        }
      }
    };

    const updatePull = (clientY: number) => {
      const delta = clientY - startYRef.current;
      if (delta <= 0 || window.scrollY > 0) {
        activeRef.current = false;
        setDragging(false);
        setPullDistance(0);
        pullDistanceRef.current = 0;
        return;
      }
      const capped = Math.min(delta, MAX_PULL);
      pullDistanceRef.current = capped;
      setPullDistance(capped);
    };

    // ── touch ─────────────────────────────────────────────────
    const onTouchStart = (e: TouchEvent) => {
      if (disabled || refreshing || window.scrollY > 0) return;
      startYRef.current = e.touches[0].clientY;
      activeRef.current = true;
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!activeRef.current) return;
      updatePull(e.touches[0].clientY);
    };

    // ── mouse ─────────────────────────────────────────────────
    const onMouseDown = (e: MouseEvent) => {
      if (disabled || refreshing || window.scrollY > 0 || e.button !== 0) return;
      startYRef.current = e.clientY;
      activeRef.current = true;
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!activeRef.current) return;
      // Only show indicator once the user has actually started dragging down
      const delta = e.clientY - startYRef.current;
      if (delta > 4) setDragging(true);
      updatePull(e.clientY);
    };

    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("touchend", release);
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", release);
    window.addEventListener("mouseleave", release);

    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", release);
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", release);
      window.removeEventListener("mouseleave", release);
    };
  }, [onRefresh, disabled, refreshing]);

  return { pullDistance, refreshing, dragging };
}
