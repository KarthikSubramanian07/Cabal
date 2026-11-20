import type { MyGame } from "@cabal/protocol";
import { describe, expect, it } from "vitest";
import type { HeldSeat } from "../net/seats.js";
import { yourSeats } from "./yourSeats.js";

const held = (gameId: string): HeldSeat => ({ gameId, power: "FRANCE", token: `${gameId}.t`, name: "ada", savedAt: 1 });
const game = (gameId: string, status: MyGame["status"]): MyGame => ({
  gameId,
  power: "ENGLAND",
  status,
  joinedAt: 1,
  finishedAt: null,
  result: null,
  score: null,
  centers: null,
  ratingDelta: null,
});

describe("yourSeats", () => {
  it("lists this browser's seats, then the account's seats in games still being played", () => {
    const list = yourSeats([held("AAAAAA")], [game("AAAAAA", "playing"), game("BBBBBB", "playing"), game("CCCCCC", "finished"), game("DDDDDD", "left")], "ada");
    expect(list).toEqual([
      { gameId: "AAAAAA", power: "FRANCE", name: "ada", elsewhere: false },
      { gameId: "BBBBBB", power: "ENGLAND", name: "ada", elsewhere: true },
    ]);
  });

  it("lists only this browser's seats when signed out or the account could not be read", () => {
    expect(yourSeats([held("AAAAAA")], null, null)).toHaveLength(1);
    expect(yourSeats([], null, null)).toEqual([]);
  });
});
