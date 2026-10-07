import { useEffect } from "react";
import { App } from "./App";
import { Account } from "./account/Account";
import { Forgot, Register, Reset, SignIn } from "./account/AccountPages";
import { useAccount } from "./account/useAccount";
import { usePath } from "./router";

/** The page for the current path: the game (the default), or one of the pages beside it. */
export function Root() {
  const path = usePath();

  // Who's signed in: at start, and again whenever the tab gets focus (an
  // account page opened from a room signs in in another tab).
  useEffect(() => {
    const load = () => void useAccount.getState().load();
    load();
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, []);

  switch (path.replace(/\/+$/, "") || "/") {
    case "/signin":
      return <SignIn />;
    case "/register":
      return <Register />;
    case "/forgot":
      return <Forgot />;
    case "/reset":
      return <Reset />;
    case "/account":
      return <Account />;
    default:
      return <App />;
  }
}
