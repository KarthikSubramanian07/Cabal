import { StatusPage } from "../app/StatusPage.jsx";

/** Shown when a link inside the app points at nothing. The edge answers unknown URLs with a real 404. */
export default function NotFoundPage() {
  return (
    <StatusPage stamp="Not found" tone="alert" title="That province is not on the map." pageTitle="Not found">
      <p>The address does not lead anywhere on Cabal. The board is one step away.</p>
    </StatusPage>
  );
}
