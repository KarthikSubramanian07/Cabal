/**
 * What a route shows while its code, the map and the rules engine are still arriving.
 * It says what is coming, so a visitor on a slow connection reads something true about
 * the game instead of watching an empty page.
 */
export function PageLoading() {
  return (
    <main className="loading-body" id="main" tabIndex={-1}>
      <div className="loading-card">
        <p className="loading-title" role="status">
          Setting up the board.
        </p>
        <p className="loading-line">Spring 1901 · seven powers · thirty-four supply centres</p>
        <p className="loading-note">
          Diplomacy with receipts. Every order you give is resolved in your browser by a Rust adjudicator, and every
          result comes back with the reason it succeeded or failed.
        </p>
      </div>
    </main>
  );
}
