`game.json` is a two-phase, message-free excerpt from the publicly released
Cicero redacted game `game_433761_ENGLAND_AG.json`. Orders and states are retained
as published; message text and logs are omitted from this import fixture.

`tests/cicero_import.rs` deserializes it and replays Spring 1901 through
`Game::from_saved`, which fails unless the engine reproduces Cicero's recorded
Fall 1901 units and supply centres.

Source: <https://github.com/facebookresearch/diplomacy_cicero/blob/main/data/cicero_redacted_games/game_433761_ENGLAND_AG.json>
