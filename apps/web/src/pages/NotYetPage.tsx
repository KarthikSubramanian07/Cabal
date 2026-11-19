/**
 * Placeholders for the routes the multiplayer release fills in. Each says plainly what
 * will live at the address, so a shared link never lands on a blank screen or a 404.
 */
import { StatusPage } from "../app/StatusPage.jsx";
import type { RouteMatch } from "../app/routes.js";

interface Copy {
  eyebrow?: string;
  title: string;
  pageTitle: string;
  body: string;
}

function copyFor(route: RouteMatch): Copy {
  switch (route.name) {
    case "game":
      return {
        eyebrow: `Game ${route.params["code"] ?? ""}`,
        title: "This table is not set yet.",
        pageTitle: `Game ${route.params["code"] ?? ""}`,
        body: "Multiplayer games will open at this address: seven seats, sealed orders and a deadline clock. Until then every power is yours in the sandbox.",
      };
    case "games":
      return {
        title: "The games room is not open yet.",
        pageTitle: "Games",
        body: "Open tables, games waiting on your orders and the ones you have finished will be listed here.",
      };
    case "ledger":
      return {
        title: "The Ledger is not open yet.",
        pageTitle: "The Ledger",
        body: "Every finished game, every pledge kept and every pledge broken will go on the record here, with the receipts to prove it.",
      };
    case "profile":
      return {
        eyebrow: `Player ${route.params["handle"] ?? ""}`,
        title: "No file on this player yet.",
        pageTitle: route.params["handle"] ?? "Player",
        body: "Player files will show a record of games, a rating and how often a word given was a word kept.",
      };
    case "replay":
      return {
        eyebrow: `Replay ${route.params["code"] ?? ""}`,
        title: "This replay is not ready yet.",
        pageTitle: `Replay ${route.params["code"] ?? ""}`,
        body: "Finished games will play back here phase by phase, every order and every receipt. You can already step through your own games in the sandbox.",
      };
    case "home":
    case "sandbox":
      return { title: "Sandbox", pageTitle: "Sandbox", body: "" };
  }
}

export default function NotYetPage({ route }: { route: RouteMatch }) {
  const copy = copyFor(route);
  return (
    <StatusPage stamp="Not yet" eyebrow={copy.eyebrow} title={copy.title} pageTitle={copy.pageTitle}>
      <p>{copy.body}</p>
    </StatusPage>
  );
}
