import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMediaQuery } from "../useMediaQuery";
import { Cross, MenuIcon } from "./icons";

/** Phones (the cockpit's own breakpoint) fold the header's entries into a menu. */
const PHONE = "(max-width: 760px)";

/**
 * The header's entries (account links, Leave room / Exit / Reset): in a row on
 * a wide screen; on a phone behind a ☰ button, as a dropdown list. `children`
 * renders them for either: `phone` says which.
 */
export function TopbarMenu({ children }: { children: (phone: boolean) => ReactNode }) {
  const phone = useMediaQuery(PHONE);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // A tap anywhere else, or Escape, closes the menu.
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => ref.current?.contains(e.target as Node) || setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!phone) return <>{children(false)}</>;
  return (
    <div className="topbar-menu" ref={ref}>
      <button
        className="menu-btn"
        aria-label={open ? "Close menu" : "Menu"}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? <Cross /> : <MenuIcon />}
      </button>
      {/* An entry chosen (a link, or a button after its confirm) closes it. */}
      {open && (
        <nav className="account-menu topbar-menu-list" onClick={() => setOpen(false)}>
          {children(true)}
        </nav>
      )}
    </div>
  );
}
