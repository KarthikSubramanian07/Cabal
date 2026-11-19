/**
 * The board of a game in play, as the server last described it. Read only: it shows where every
 * unit stands and who owns each centre. Loaded on its own, so a lobby never waits for the map.
 */
import type { StateView } from "@cabal/protocol";
import { useEffect, useState } from "react";
import { Board } from "../map/Board.jsx";
import { type Board as BoardData, loadBoard } from "../map/boardData.js";

export default function LiveBoard({ state, label }: { state: StateView; label: string }) {
  const [board, setBoard] = useState<BoardData | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    loadBoard().then(
      (b) => live && setBoard(b),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, []);

  if (failed) return <p className="talk-note">The map did not load. Reload the page to try again.</p>;
  if (!board) return <p className="room-wait" role="status">Unrolling the map</p>;
  return (
    <figure className="live-board">
      <Board board={board} state={state} orders={[]} />
      <figcaption className="sr-only">{label}</figcaption>
    </figure>
  );
}
