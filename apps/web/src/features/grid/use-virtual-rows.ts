'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Row windowing.
 *
 * The whole reason the grid can hold a million records: only the rows inside the viewport (plus
 * a small overscan) are mounted, so the DOM node count is a function of the window height rather
 * than of the dataset. Without this, a 50,000-row table means 50,000 x columns nodes and the tab
 * dies before the data finishes arriving.
 *
 * Deliberately hand-written rather than pulled from a library: the grid also needs a pinned first
 * column and a scroll position that survives a page of new data arriving, and those interact. A
 * generic virtualiser makes each of them a fight.
 */

export interface VirtualRange {
  /** Index of the first row to mount. */
  readonly start: number;
  /** Index one past the last row to mount. */
  readonly end: number;
  /** Pixel offset of the first mounted row, applied as a transform. */
  readonly offsetTop: number;
  /** Total scrollable height, so the scrollbar reflects the whole dataset. */
  readonly totalHeight: number;
}

export interface UseVirtualRowsOptions {
  readonly rowCount: number;
  readonly rowHeight: number;
  /** Extra rows above and below the viewport, so fast scrolling does not show blank space. */
  readonly overscan?: number;
}

export function useVirtualRows({ rowCount, rowHeight, overscan = 8 }: UseVirtualRowsOptions): {
  scrollRef: React.RefObject<HTMLDivElement>;
  range: VirtualRange;
  scrollToRow: (index: number) => void;
} {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    const handleScroll = (): void => {
      // Read synchronously in the scroll handler and let React batch the update. Deferring the
      // read to a rAF makes the rows lag the scrollbar by a frame, which reads as jank.
      setScrollTop(element.scrollTop);
    };

    element.addEventListener('scroll', handleScroll, { passive: true });

    const observer = new ResizeObserver((entries) => {
      const height = entries[0]?.contentRect.height;
      if (height) setViewportHeight(height);
    });
    observer.observe(element);
    setViewportHeight(element.clientHeight);

    return () => {
      element.removeEventListener('scroll', handleScroll);
      observer.disconnect();
    };
  }, []);

  const range = useMemo<VirtualRange>(() => {
    const first = Math.floor(scrollTop / rowHeight);
    const visible = Math.ceil(viewportHeight / rowHeight);

    const start = Math.max(0, first - overscan);
    const end = Math.min(rowCount, first + visible + overscan);

    return { start, end, offsetTop: start * rowHeight, totalHeight: rowCount * rowHeight };
  }, [scrollTop, viewportHeight, rowHeight, rowCount, overscan]);

  const scrollToRow = useCallback(
    (index: number) => {
      const element = scrollRef.current;
      if (!element) return;

      const top = index * rowHeight;
      const bottom = top + rowHeight;

      // Only scrolls when the row is actually outside the viewport. Scrolling unconditionally
      // makes arrow-key navigation jump the view on every keystroke.
      if (top < element.scrollTop) {
        element.scrollTop = top;
      } else if (bottom > element.scrollTop + element.clientHeight) {
        element.scrollTop = bottom - element.clientHeight;
      }
    },
    [rowHeight],
  );

  return { scrollRef, range, scrollToRow };
}
