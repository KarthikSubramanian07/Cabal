/** What a route shows while its code (or the board and engine) is still arriving. */
export function PageLoading({ children = "Setting up the board." }: { children?: string }) {
  return (
    <main className="loading-body" id="main" tabIndex={-1}>
      <p role="status">{children}</p>
    </main>
  );
}
