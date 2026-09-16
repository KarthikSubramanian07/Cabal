//! `cabal` CLI. Scaffold: subcommands land with the engine.

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("datc") => println!(
            "DATC corpus not wired yet (engine {})",
            cabal_engine::VERSION
        ),
        Some("version") | None => println!("cabal {}", cabal_engine::VERSION),
        Some(other) => {
            eprintln!("unknown subcommand: {other}");
            std::process::exit(2);
        }
    }
}
