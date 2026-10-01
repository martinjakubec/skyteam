import { useEffect, useRef } from "react";

/**
 * For a sideways-scrolling track (phones): keep the cell at `index` centred,
 * scrolling smoothly whenever it changes. No-op while the track fits.
 */
export function useFollow<T extends HTMLElement>(index: number) {
  const ref = useRef<T>(null);
  const first = useRef(true);
  useEffect(() => {
    const track = ref.current;
    const cell = track?.children[index] as HTMLElement | undefined;
    if (!track || !cell || track.scrollWidth <= track.clientWidth) return;
    track.scrollTo({
      left: cell.offsetLeft - (track.clientWidth - cell.offsetWidth) / 2,
      behavior: first.current ? "auto" : "smooth",
    });
    first.current = false;
  }, [index]);
  return ref;
}
