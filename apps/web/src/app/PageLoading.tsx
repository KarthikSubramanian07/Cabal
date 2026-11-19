/**
 * What a route shows while its code, the map and the rules engine are still arriving.
 * It says what is coming, so a visitor on a slow connection reads something true about
 * the game instead of watching an empty page.
 *
 * The words live in loading.json because the build writes the same card into index.html
 * (scripts/emit-agent-site.mjs), so the first paint is already this screen and nothing
 * changes when React takes over.
 */
import copy from "./loading.json";

export function PageLoading() {
  return (
    <main className="loading-body" id="main" tabIndex={-1}>
      <div className="loading-card">
        <p className="loading-title" role="status">
          {copy.title}
        </p>
        <p className="loading-line">{copy.line}</p>
        <p className="loading-note">{copy.note}</p>
      </div>
    </main>
  );
}
