use std::process::Command;

#[test]
fn graph_flag_outputs_standalone_dot_and_preserves_plain_explain() {
    let orders = ["FRA: A PAR - BUR", "FRA: A MAR S A PAR - BUR"];
    let output = Command::new(env!("CARGO_BIN_EXE_cabal"))
        .arg("explain")
        .arg("--graph")
        .args(orders)
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let dot = String::from_utf8(output.stdout).unwrap();
    assert!(dot.starts_with("digraph movement {\n"));
    assert!(dot.contains(" -> "));
    assert!(dot.ends_with("}\n"));
    let plain = Command::new(env!("CARGO_BIN_EXE_cabal"))
        .arg("explain")
        .args(orders)
        .output()
        .unwrap();
    assert!(plain.status.success());
    assert!(String::from_utf8(plain.stdout).unwrap().starts_with("ok "));
}
