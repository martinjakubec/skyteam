// Browser APIs jsdom lacks that the client uses. Import first in client tests.

// Pointer events (drags): a MouseEvent carries the coordinates the cockpit reads.
if (typeof globalThis.PointerEvent === "undefined") {
  class PointerEvent extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
    }
  }
  globalThis.PointerEvent = PointerEvent as typeof globalThis.PointerEvent;
}

// Layout-only scrolling (pickers keep the active option in view, tracks follow
// the marker): jsdom has no layout, so these do nothing.
Element.prototype.scrollIntoView ??= function () {};
Element.prototype.scrollTo ??= function () {};
Element.prototype.scrollBy ??= function () {};
window.scrollTo = () => {};
window.scrollBy = () => {};
