//! WebAssembly surface of the Cabal engine. Scaffold.

use wasm_bindgen::prelude::*;

/// Engine version string, useful as a smoke test that the module loaded.
#[wasm_bindgen]
pub fn version() -> String {
    cabal_engine::VERSION.to_string()
}
