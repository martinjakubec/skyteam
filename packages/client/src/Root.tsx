import { lazy, Suspense, useEffect } from "react";
import { App } from "./App";
import { Account } from "./account/Account";
import { Forgot, Register, Reset, SignIn } from "./account/AccountPages";
import { useAccount } from "./account/useAccount";
import { History } from "./history/History";
import { usePath } from "./router";
import { OfflineBar } from "./pwa/OfflineBar";
import { UpdateBar } from "./pwa/UpdateBar";

// Pages most players never open: loaded only when they do.
const GamePage = lazy(() => import("./history/GamePage"));
const AdminStats = lazy(() => import("./admin/AdminStats"));
const AdminUsers = lazy(() => import("./admin/AdminUsers"));
const AdminUserGames = lazy(() => import("./admin/AdminUserGames"));

/** The page for the current path, with the app's bars (offline, a new version) over any of them. */
export function Root() {
  return (
    <>
      <Page />
      <OfflineBar />
      <UpdateBar />
    </>
  );
}

/** The page for the current path: the game (the default), or one of the pages beside it. */
function Page() {
  const path = usePath();

  // Who's signed in: at start, and again whenever the tab gets focus (an
  // account page opened from a room signs in in another tab).
  useEffect(() => {
    const load = () => void useAccount.getState().load();
    load();
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, []);

  const route = path.replace(/\/+$/, "") || "/";
  const game = /^\/games\/([^/]+)$/.exec(route);
  if (game) {
    return (
      <Suspense fallback={null}>
        <GamePage id={decodeURIComponent(game[1])} />
      </Suspense>
    );
  }
  const userGames = /^\/admin\/users\/([^/]+)\/games$/.exec(route);
  if (userGames) {
    return (
      <Suspense fallback={null}>
        <AdminUserGames userId={decodeURIComponent(userGames[1])} />
      </Suspense>
    );
  }
  switch (route) {
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
    case "/history":
      return <History />;
    case "/admin":
      return (
        <Suspense fallback={null}>
          <AdminStats />
        </Suspense>
      );
    case "/admin/users":
      return (
        <Suspense fallback={null}>
          <AdminUsers />
        </Suspense>
      );
    default:
      return <App />;
  }
}
