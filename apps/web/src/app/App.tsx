import { Suspense, lazy, useLayoutEffect } from "react";
import { ErrorBoundary } from "./ErrorBoundary.jsx";
import { PageLoading } from "./PageLoading.jsx";
import { Shell } from "./Shell.jsx";
import { applyHead, metaForRoute } from "./meta.js";
import { usePathname } from "./router.jsx";
import { matchRoute } from "./routes.js";

const SandboxPage = lazy(() => import("../pages/SandboxPage.jsx"));
const GamesPage = lazy(() => import("../pages/GamesPage.jsx"));
const GamePage = lazy(() => import("../pages/GamePage.jsx"));
const NotYetPage = lazy(() => import("../pages/NotYetPage.jsx"));
const NotFoundPage = lazy(() => import("../pages/NotFoundPage.jsx"));

export function App() {
  const path = usePathname();
  const route = matchRoute(path);
  // A layout effect runs before any page's own effects, so a page that names itself more
  // precisely once its data arrives (a player's handle as they wrote it) has the last word.
  useLayoutEffect(() => applyHead(metaForRoute(matchRoute(path), path)), [path]);
  return (
    <Shell>
      <ErrorBoundary key={route ? `${route.name}:${Object.values(route.params).join("/")}` : "missing"}>
        <Suspense fallback={<PageLoading />}>
          {!route ? (
            <NotFoundPage />
          ) : route.name === "sandbox" || route.name === "home" ? (
            <SandboxPage />
          ) : route.name === "games" ? (
            <GamesPage />
          ) : route.name === "game" ? (
            <GamePage code={route.params["code"] ?? ""} />
          ) : (
            <NotYetPage route={route} />
          )}
        </Suspense>
      </ErrorBoundary>
    </Shell>
  );
}
