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
