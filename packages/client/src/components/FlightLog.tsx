import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { MAX_CHAT_LENGTH, type ChatMessage, type Crew, type RoomSnapshot } from "@skyteam/shared";
import { unreadChat, useGame } from "../store";
import { useMediaQuery } from "../useMediaQuery";
import { seatNames } from "./Seats";
import { ChatBubble } from "./icons";

/** Phones (the cockpit's own breakpoint) get the bubble and a full-screen log. */
const PHONE = "(max-width: 760px)";

/**
 * The lobby's chat: the crew agree on a card and Special Abilities here. On a
 * wide screen the log sits beside the lobby; on a phone a bubble in the corner
 * opens it full-screen, with a dot while the other player's lines wait unread.
 */
export function LobbyChat({ snapshot }: { snapshot: RoomSnapshot }) {
  const phone = useMediaQuery(PHONE);
  const [open, setOpen] = useState(false);
  const chatReadAt = useGame((s) => s.chatReadAt);
  const markChatRead = useGame((s) => s.markChatRead);
  const me = snapshot.you.playerId;
  const visible = !phone || open;

  // Whatever is on screen has been read.
  useEffect(() => {
    if (visible) markChatRead();
  }, [visible, snapshot.chat.length, markChatRead]);

  // Escape closes the full-screen log.
  useEffect(() => {
    if (!phone || !open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [phone, open]);

  if (!phone) return <FlightLog snapshot={snapshot} />;
  if (open) {
    return (
      <div className="chat-modal fullscreen" role="dialog" aria-modal="true" aria-label="Flight log">
        <FlightLog snapshot={snapshot} autoFocus onClose={() => setOpen(false)} />
      </div>
    );
  }
  const unread = unreadChat(snapshot.chat, me, chatReadAt) > 0;
  return (
    <button
      type="button"
      className="chat-bubble"
      aria-label={unread ? "Open flight log (unread messages)" : "Open flight log"}
      onClick={() => setOpen(true)}
    >
      <ChatBubble />
      {unread && <span className="chat-dot" aria-hidden="true" />}
    </button>
  );
}

const SEAT_LABEL: Record<Crew, string> = { pilot: "Pilot", copilot: "Co-Pilot" };
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** The log itself: lines oldest first, kept scrolled to the newest, and the box
 *  to write in. Lines are tinted by crew — blue Pilot, orange Co-Pilot. */
function FlightLog({ snapshot, autoFocus, onClose }: { snapshot: RoomSnapshot; autoFocus?: boolean; onClose?: () => void }) {
  const sendChat = useGame((s) => s.sendChat);
  const [draft, setDraft] = useState("");
  const names = seatNames(snapshot);
  const me = snapshot.you.playerId;
  const messages: ChatMessage[] = snapshot.chat;

  // Each new line pushes the older ones up; keep the newest in view.
  const logRef = useRef<HTMLOListElement>(null);
  useLayoutEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [messages.length]);

  const canSend = draft.trim() !== "";
  return (
    <section className="flight-log" aria-label="Flight log">
      <header className="flight-log-head">
        <h2 className="setup-label">Flight log</h2>
        {onClose && (
          <button type="button" className="flight-log-close" aria-label="Close flight log" onClick={onClose}>
            ✕
          </button>
        )}
      </header>
      <ol className="flight-log-lines" role="log" aria-live="polite" ref={logRef}>
        {messages.length === 0 && <li className="flight-log-empty">No messages yet. Talk over the scenario and Special Abilities here.</li>}
        {messages.map((m) => (
          <li key={m.id} className={`log-line ${m.crew}${m.playerId === me ? " mine" : ""}`}>
            <span className="log-who">{names[m.crew] ?? SEAT_LABEL[m.crew]}</span>
            <time className="log-time" dateTime={new Date(m.at).toISOString()}>
              {clock(m.at)}
            </time>
            <p className="log-text">{m.text}</p>
          </li>
        ))}
      </ol>
      <form
        className="flight-log-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSend) sendChat(draft, () => setDraft(""));
        }}
      >
        <input
          aria-label="Message"
          value={draft}
          maxLength={MAX_CHAT_LENGTH}
          placeholder="Message your crew…"
          autoComplete="off"
          enterKeyHint="send"
          autoFocus={autoFocus}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" disabled={!canSend}>
          Send
        </button>
      </form>
    </section>
  );
}
