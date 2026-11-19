declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}

/** Wrangler bundles `.sql` files as text modules. */
declare module "*.sql" {
  const text: string;
  export default text;
}
