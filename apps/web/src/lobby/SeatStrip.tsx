/**
 * Seven squares for the seven seats: filled for a player, open for a seat still free, ruled
 * through for one the AI plays. The count is said in words beside it, so the squares are never
 * the only way to read the table.
 */
export function SeatStrip({ humans, open }: { humans: number; open: number }) {
  const ai = Math.max(0, 7 - humans - open);
  const cells = [...Array<"human">(humans).fill("human"), ...Array<"ai">(ai).fill("ai"), ...Array<"open">(open).fill("open")].slice(0, 7);
  return (
    <span className="seat-strip">
      <span className="seat-cells" aria-hidden="true">
        {cells.map((kind, i) => (
          <span key={i} className={`seat-cell ${kind}`} />
        ))}
      </span>
      <span className="seat-count">
        {humans} of 7 seated{open > 0 ? `, ${open} open` : ""}
      </span>
    </span>
  );
}
