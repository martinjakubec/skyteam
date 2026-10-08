import type React from "react";
// Small line-art icons used as in-slot hints. They paint in `currentColor`, so
// the surrounding element (e.g. .slot-icon) controls size and tint.

/** A headset — marks the Radio spaces. */
export function Headset() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {/* headband arc over the top */}
      <path d="M4 14v-2a8 8 0 0 1 16 0v2" />
      {/* ear cups */}
      <rect x="2.5" y="13" width="4" height="6.5" rx="1.6" />
      <rect x="17.5" y="13" width="4" height="6.5" rx="1.6" />
      {/* mic boom sweeping from the right cup to the front */}
      <path d="M19.5 19.5v.5a2.5 2.5 0 0 1-2.5 2.5h-3" />
    </svg>
  );
}

/** A speech bubble — the phone's button that opens the flight log. */
export function ChatBubble() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {/* rounded balloon with a tail at the bottom left */}
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4H6.5A2.5 2.5 0 0 1 4 13.5z" />
      {/* lines of text */}
      <path d="M8 8h8M8 11.5h5" />
    </svg>
  );
}

// ---- The icon set ---------------------------------------------------------------
// Everything that used to be an emoji or a symbol character. Each sizes itself
// to the text around it (1em, class "ico") and paints in currentColor unless
// its colour means something. With a `title` it is announced (role="img",
// aria-label — not an SVG <title>, which would count as the element's text);
// without one it is decoration, hidden from screen readers.

type IconProps = { title?: string; className?: string };

function Icon({ title, className, children }: IconProps & { children: React.ReactNode }) {
  const a11y = title ? { role: "img", "aria-label": title } : { "aria-hidden": true as const };
  return (
    <svg
      viewBox="0 0 24 24"
      className={className ? `ico ${className}` : "ico"}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...a11y}
    >
      {children}
    </svg>
  );
}

/** ✈ — an airplane seen from above, nose to the right (solid). */
export const Plane = (p: IconProps) => (
  <Icon {...p}>
    <path
      fill="currentColor"
      stroke="none"
      d="M21.6 12c0-.9-.8-1.5-1.8-1.5h-5.1L10 3.2H8l2.3 7.3H5.6L3.8 7.9H2.3l1.2 4.1-1.2 4.1h1.5l1.8-2.6h4.7L8 20.8h2l4.7-7.3h5.1c1 0 1.8-.6 1.8-1.5z"
    />
  </Icon>
);

/** 🛬 — an airplane coming down onto a runway. */
export const PlaneLanding = (p: IconProps) => (
  <Icon {...p}>
    <path
      fill="currentColor"
      stroke="none"
      d="M19.4 15.4c.9.2 1.7-.2 1.9-1 .2-.8-.4-1.5-1.3-1.8l-4.8-1.3-3.4-7.1-1.9-.5.9 6.6-4.4-1.2-1.2-2.8-1.4-.4.2 4.2 15.4 4.3z"
    />
    <path d="M2.5 20.5h19" />
  </Icon>
);

/** ☕ — a cup with steam. */
export const Coffee = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 10h12v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z" />
    <path d="M16 11.5h1.5a2.5 2.5 0 0 1 0 5H15.5" />
    <path d="M8 3.5c-.8 1 .8 2 0 3M12 3.5c-.8 1 .8 2 0 3" />
  </Icon>
);

/** 🎲 — a die. */
export const Dice = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3.5" y="3.5" width="17" height="17" rx="4" />
    <g fill="currentColor" stroke="none">
      <circle cx="8.5" cy="8.5" r="1.5" />
      <circle cx="15.5" cy="8.5" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="8.5" cy="15.5" r="1.5" />
      <circle cx="15.5" cy="15.5" r="1.5" />
    </g>
  </Icon>
);

/** 🎓 — a graduation cap (the Intern). */
export const GradCap = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 5 2 9.5 12 14l10-4.5z" />
    <path d="M6.5 11.6V16c0 1.5 2.5 3 5.5 3s5.5-1.5 5.5-3v-4.4" />
    <path d="M22 9.5v5" />
  </Icon>
);

/** ⛽ — a fuel pump (Kerosene). */
export const FuelPump = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16" />
    <path d="M3 21h12" />
    <path d="M6.5 8h5" />
    <path d="M14 11h2a1.5 1.5 0 0 1 1.5 1.5v3.5a1.5 1.5 0 0 0 3 0V8.5L18 6" />
  </Icon>
);

/** ⚠ — the same yellow caution triangle as over a mandatory space. */
export const Warning = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3.6 21.8 20.4H2.2Z" fill="#ffce47" stroke="#6d4f00" strokeWidth="1.4" />
    <rect x="10.9" y="9" width="2.2" height="6.2" rx="1.1" fill="#3a2c00" stroke="none" />
    <circle cx="12" cy="18" r="1.25" fill="#3a2c00" stroke="none" />
  </Icon>
);

/** ❄ — a snowflake (Ice Brakes). */
export const Snowflake = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 2.5v19M3.8 7.2l16.4 9.6M3.8 16.8l16.4-9.6" />
    <path d="m9.5 4 2.5 2 2.5-2M9.5 20l2.5-2 2.5 2" />
  </Icon>
);

/** ⏱ — a stopwatch (Real-Time). */
export const Stopwatch = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="13.5" r="7.5" />
    <path d="M12 13.5V9.5M10 2.5h4M18.5 6.5l1.5-1.5" />
  </Icon>
);

/** ✕ — a cross: close buttons, forbidden positions. */
export const Cross = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 6l12 12M18 6 6 18" strokeWidth="2.4" />
  </Icon>
);

/** ★ — a star (the Special Ability count). */
export const Star = (p: IconProps) => (
  <Icon {...p}>
    <path fill="currentColor" d="m12 3 2.7 5.6 6.1.8-4.5 4.2 1.1 6-5.4-2.9-5.4 2.9 1.1-6-4.5-4.2 6.1-.8z" strokeWidth="1" />
  </Icon>
);

/** ▾ — the dropdown's caret. */
export const ChevronDown = (p: IconProps) => (
  <Icon {...p}>
    <path d="m6 9 6 6 6-6" strokeWidth="2.2" />
  </Icon>
);

/** ●/○ (🟢/🔴) — a status light: filled, or a ring when off. */
export const Dot = ({ on = true, color, ...p }: IconProps & { on?: boolean; color?: string }) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r={on ? 7.5 : 6.5} fill={on ? (color ?? "currentColor") : "none"} stroke={color ?? "currentColor"} strokeWidth={on ? 0 : 2} />
  </Icon>
);

/** 👑 — a crown (the host), in gold. */
export const Crown = (p: IconProps) => (
  <Icon {...p}>
    <path fill="#facc15" stroke="#a16207" strokeWidth="1.2" d="M3.5 8.5 8 12l4-6.5 4 6.5 4.5-3.5-1.8 10H5.3z" />
  </Icon>
);

/** 🤖 — a robot (the bot). */
export const Robot = (p: IconProps) => (
  <Icon {...p}>
    <rect x="4" y="7.5" width="16" height="12" rx="3.5" />
    <path d="M12 7.5V4.5M2 12.5v3M22 12.5v3" />
    <circle cx="12" cy="3.5" r="1" fill="currentColor" stroke="none" />
    <g fill="currentColor" stroke="none">
      <circle cx="9" cy="12.5" r="1.4" />
      <circle cx="15" cy="12.5" r="1.4" />
    </g>
    <path d="M9.5 16.3h5" />
  </Icon>
);

/** ℹ️ — information (a tutorial). */
export const Info = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5.5" strokeWidth="2.2" />
    <circle cx="12" cy="7.6" r="1.25" fill="currentColor" stroke="none" />
  </Icon>
);

// Replay controls: ⏮ ⏪ ◀ ▶ ⏸ ▶| ⏩ ⏭ (solid shapes, as the characters were).
const solid = { fill: "currentColor", stroke: "currentColor", strokeWidth: 1.2 } as const;
export const SkipBack = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.5 5.5v13" strokeWidth="2.4" />
    <path {...solid} d="M13 6.5v11L6 12zM21 6.5v11L14 12z" />
  </Icon>
);
export const Rewind = (p: IconProps) => (
  <Icon {...p}>
    <path {...solid} d="M12 6v12L3.5 12zM21 6v12l-8.5-6z" />
  </Icon>
);
export const StepBack = (p: IconProps) => (
  <Icon {...p}>
    <path {...solid} d="M17 5.5v13L6.5 12z" />
  </Icon>
);
export const Play = (p: IconProps) => (
  <Icon {...p}>
    <path {...solid} d="M7 5.5v13L17.5 12z" />
  </Icon>
);
export const Pause = (p: IconProps) => (
  <Icon {...p}>
    <rect {...solid} x="6.5" y="5.5" width="3.5" height="13" rx="1" />
    <rect {...solid} x="14" y="5.5" width="3.5" height="13" rx="1" />
  </Icon>
);
export const StepForward = (p: IconProps) => (
  <Icon {...p}>
    <path {...solid} d="M5 5.5v13L15.5 12z" />
    <path d="M19 5v14" strokeWidth="2.4" />
  </Icon>
);
export const FastForward = (p: IconProps) => (
  <Icon {...p}>
    <path {...solid} d="M3 6v12l8.5-6zM12 6v12l8.5-6z" />
  </Icon>
);
export const SkipForward = (p: IconProps) => (
  <Icon {...p}>
    <path {...solid} d="M3 6.5v11l7-5.5zM11 6.5v11l7-5.5z" />
    <path d="M20.5 5.5v13" strokeWidth="2.4" />
  </Icon>
);
