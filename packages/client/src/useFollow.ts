import { useEffect, useRef } from "react";

/**
 * For a sideways-scrolling track (phones): keep the cell at `index` centred,
 * scrolling smoothly whenever it changes. No-op while the track fits. Cells
 * are the scroller's children unless `cells` selects them (they must then be
 * positioned relative to the scroller).
 */
export function useFollow<T extends HTMLElement>(index: number, cells?: string) {
  const ref = useRef<T>(null);
  const first = useRef(true);
  useEffect(() => {
    const track = ref.current;
    const cell = (cells ? track?.querySelectorAll(cells)[index] : track?.children[index]) as HTMLElement | undefined;
    if (!track || !cell || track.scrollWidth <= track.clientWidth) return;
    track.scrollTo({
      left: cell.offsetLeft - (track.clientWidth - cell.offsetWidth) / 2,
      behavior: first.current ? "auto" : "smooth",
    });
    first.current = false;
  }, [index, cells]);
  return ref;
}
