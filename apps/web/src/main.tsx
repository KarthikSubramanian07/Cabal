import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

function App() {
  return <main>Cabal scaffold</main>;
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
