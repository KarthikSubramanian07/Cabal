import { Suspense, lazy } from "react";
import { ErrorBoundary } from "./ErrorBoundary.jsx";
import { PageLoading } from "./PageLoading.jsx";
import { Shell } from "./Shell.jsx";
import { useRoute } from "./router.jsx";

const SandboxPage = lazy(() => import("../pages/SandboxPage.jsx"));
const GamesPage = lazy(() => import("../pages/GamesPage.jsx"));
const GamePage = lazy(() => import("../pages/GamePage.jsx"));
const NotYetPage = lazy(() => import("../pages/NotYetPage.jsx"));
const NotFoundPage = lazy(() => import("../pages/NotFoundPage.jsx"));

export function App() {
  const route = useRoute();
  return (
    <Shell>
      <ErrorBoundary key={route ? `${route.name}:${Object.values(route.params).join("/")}` : "missing"}>
        <Suspense fallback={<PageLoading />}>
          {!route ? (
            <NotFoundPage />
          ) : route.name === "sandbox" ? (
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
