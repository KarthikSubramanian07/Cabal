/** Vite's `?raw` suffix imports a file as text. Used by the test that checks the docs against the schemas. */
declare module "*?raw" {
  const text: string;
  export default text;
}
