import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { DIFFICULTIES, MODULE_LABELS, SCENARIO_TEMPLATES, templateFor, type ScenarioId, type ScenarioTemplate } from "@skyteam/shared";

/** The lobby id a card is picked by ("YUL" for the first game). */
const idOf = (t: ScenarioTemplate): ScenarioId => (t.id === "green-YUL" ? "YUL" : t.id);

/** Cards in list order: by difficulty, then as the rulebook lists them. */
const ORDER = DIFFICULTIES.flatMap((d) => SCENARIO_TEMPLATES.filter((t) => t.difficulty === d.id));

/** What a card adds to the base game, e.g. "Kerosene · Intern · ★1". */
function extras(t: ScenarioTemplate): string {
  const parts = t.modules.map((m) => MODULE_LABELS[m]);
  if (t.abilityCount) parts.push(`★${t.abilityCount}`);
  return parts.join(" · ");
}

function CardLabel({ t }: { t: ScenarioTemplate }) {
  return (
    <>
      <span className="pick-code">{t.code}</span>
      <span className="pick-name">
        {t.airport}
        <span className="pick-city">{t.city}</span>
      </span>
      <span className="pick-extras">{extras(t)}</span>
    </>
  );
}

/**
 * The lobby's scenario picker: a listbox of the rulebook's cards grouped by
 * difficulty, each group headed by a band in its difficulty colour (the colour
 * of the strip's header on the physical card).
 */
export function ScenarioPicker({
  value,
  disabled,
  onChange,
}: {
  value: ScenarioId;
  disabled: boolean;
  onChange: (id: ScenarioId) => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const uid = useId();
  const current = templateFor(value) ?? ORDER[0];

  const show = () => {
    setActive(Math.max(0, ORDER.indexOf(current)));
    setOpen(true);
  };
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  const choose = (t: ScenarioTemplate) => {
    if (idOf(t) !== value) onChange(idOf(t));
    close();
  };

  // Focus the list when it opens; close on a click anywhere else.
  useEffect(() => {
    if (!open) return;
    list.current?.focus();
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  // Keep the active option in view while arrowing through the list.
  useEffect(() => {
    if (open) document.getElementById(`${uid}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, uid]);

  const onTriggerKey = (e: KeyboardEvent) => {
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
      e.preventDefault();
      show();
    }
  };
  const onListKey = (e: KeyboardEvent) => {
    const step: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, PageDown: 5, PageUp: -5 };
    if (e.key in step) setActive((a) => Math.min(ORDER.length - 1, Math.max(0, a + step[e.key])));
    else if (e.key === "Home") setActive(0);
    else if (e.key === "End") setActive(ORDER.length - 1);
    else if (e.key === "Enter" || e.key === " ") choose(ORDER[active]);
    else if (e.key === "Escape" || e.key === "Tab") return close(e.key === "Escape");
    else return;
    e.preventDefault();
  };

  return (
    <div className="picker" ref={root} data-value={value}>
      <button
        ref={trigger}
        type="button"
        className={`picker-trigger diff-${current.difficulty}`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Scenario: ${current.code} ${current.airport}, ${DIFFICULTIES.find((d) => d.id === current.difficulty)?.label}`}
        onClick={() => (open ? close() : show())}
        onKeyDown={onTriggerKey}
      >
        <CardLabel t={current} />
        <span className="pick-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        // The frame clips the scrolling list (and its scrollbar) to rounded corners.
        <div className="picker-frame">
          <div
            ref={list}
            className="picker-list"
            role="listbox"
            tabIndex={-1}
            aria-label="Scenarios"
            aria-activedescendant={`${uid}-${active}`}
            onKeyDown={onListKey}
          >
            {DIFFICULTIES.map((d) => (
              <div key={d.id} role="group" aria-labelledby={`${uid}-${d.id}`} className={`picker-group diff-${d.id}`}>
                <div id={`${uid}-${d.id}`} className="picker-band">
                  {d.label}
                </div>
                {ORDER.map((t, i) =>
                  t.difficulty !== d.id ? null : (
                    <div
                      key={t.id}
                      id={`${uid}-${i}`}
                      role="option"
                      data-value={idOf(t)}
                      aria-selected={t === current}
                      className={`picker-option${i === active ? " active" : ""}`}
                      onPointerMove={() => i !== active && setActive(i)}
                      onClick={() => choose(t)}
                    >
                      <CardLabel t={t} />
                    </div>
                  ),
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
