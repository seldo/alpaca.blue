import { useEffect, useRef, useState } from "react";

const THRESHOLD = 72; // px needed to trigger refresh
const MAX_PULL = 96;  // px cap on visual indicator travel

export function usePullToRefresh(onRefresh: () => Promise<void>, disabled = false) {
  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const startYRef = useRef(0);
  const activeRef = useRef(false);
  const pullDistanceRef = useRef(0);

  useEffect(() => {
    const onTouchStart = (e: TouchEvent) => {
      if (disabled || refreshing || window.scrollY > 0) return;
      startYRef.current = e.touches[0].clientY;
      activeRef.current = true;
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!activeRef.current) return;
      const delta = e.touches[0].clientY - startYRef.current;
      if (delta <= 0) {
        activeRef.current = false;
        setPullDistance(0);
        pullDistanceRef.current = 0;
        return;
      }
      // Re-check scroll position in case user scrolled while pulling
      if (window.scrollY > 0) {
        activeRef.current = false;
        setPullDistance(0);
        pullDistanceRef.current = 0;
        return;
      }
      const capped = Math.min(delta, MAX_PULL);
      pullDistanceRef.current = capped;
      setPullDistance(capped);
    };

    const onTouchEnd = async () => {
      if (!activeRef.current) return;
      activeRef.current = false;
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

    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("touchend", onTouchEnd);

    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
    };
  }, [onRefresh, disabled, refreshing]);

  return {
    pullDistance,  // 0–MAX_PULL: how far pulled (for visual)
    refreshing,    // true while onRefresh is running
  };
}
