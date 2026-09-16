/**
 * War-room map geometry: one anchor point per province on a 1000 x 760 canvas,
 * hand placed to read as Europe without tracing borders. Multi-coast provinces
 * carry an offset per coast so fleets on different coasts are distinguishable.
 */
export interface Anchor {
  x: number;
  y: number;
}

export const CANVAS = { width: 1000, height: 760 } as const;

export const POSITIONS: Record<string, Anchor> = {
  // north and west seas
  NAO: { x: 90, y: 150 },
  NWG: { x: 300, y: 70 },
  BAR: { x: 620, y: 40 },
  IRI: { x: 150, y: 300 },
  NTH: { x: 330, y: 220 },
  HEL: { x: 420, y: 280 },
  SKA: { x: 470, y: 190 },
  ENG: { x: 230, y: 360 },
  MAO: { x: 90, y: 470 },
  BAL: { x: 560, y: 250 },
  BOT: { x: 610, y: 150 },
  // British Isles
  CLY: { x: 225, y: 190 },
  EDI: { x: 265, y: 225 },
  LVP: { x: 230, y: 265 },
  YOR: { x: 275, y: 280 },
  WAL: { x: 225, y: 315 },
  LON: { x: 280, y: 325 },
  // Scandinavia and Russia
  NWY: { x: 470, y: 120 },
  SWE: { x: 545, y: 130 },
  FIN: { x: 660, y: 110 },
  STP: { x: 760, y: 110 },
  DEN: { x: 470, y: 250 },
  LVN: { x: 690, y: 230 },
  MOS: { x: 830, y: 220 },
  WAR: { x: 660, y: 310 },
  UKR: { x: 770, y: 330 },
  SEV: { x: 880, y: 350 },
  PRU: { x: 600, y: 285 },
  // Germany and Low Countries
  KIE: { x: 470, y: 320 },
  BER: { x: 530, y: 320 },
  SIL: { x: 590, y: 360 },
  MUN: { x: 480, y: 400 },
  RUH: { x: 420, y: 370 },
  HOL: { x: 380, y: 320 },
  BEL: { x: 350, y: 360 },
  // France and Iberia
  PIC: { x: 300, y: 380 },
  PAR: { x: 280, y: 430 },
  BRE: { x: 200, y: 420 },
  BUR: { x: 350, y: 440 },
  GAS: { x: 230, y: 500 },
  MAR: { x: 320, y: 520 },
  SPA: { x: 160, y: 590 },
  POR: { x: 80, y: 590 },
  // Central Europe
  BOH: { x: 560, y: 410 },
  GAL: { x: 660, y: 400 },
  TYR: { x: 500, y: 460 },
  VIE: { x: 580, y: 460 },
  BUD: { x: 660, y: 470 },
  TRI: { x: 560, y: 520 },
  // Italy
  PIE: { x: 400, y: 520 },
  VEN: { x: 470, y: 530 },
  TUS: { x: 440, y: 580 },
  ROM: { x: 480, y: 625 },
  APU: { x: 540, y: 620 },
  NAP: { x: 530, y: 670 },
  // Balkans and Turkey
  SER: { x: 660, y: 540 },
  RUM: { x: 740, y: 470 },
  BUL: { x: 750, y: 550 },
  ALB: { x: 640, y: 600 },
  GRE: { x: 690, y: 640 },
  CON: { x: 820, y: 580 },
  ANK: { x: 900, y: 520 },
  ARM: { x: 960, y: 470 },
  SMY: { x: 880, y: 640 },
  SYR: { x: 970, y: 650 },
  // southern seas
  WES: { x: 280, y: 640 },
  LYO: { x: 370, y: 590 },
  TYS: { x: 450, y: 680 },
  ION: { x: 600, y: 700 },
  ADR: { x: 580, y: 590 },
  AEG: { x: 760, y: 660 },
  EAS: { x: 860, y: 720 },
  BLA: { x: 860, y: 450 },
  NAF: { x: 250, y: 720 },
  TUN: { x: 420, y: 730 },
  SWI: { x: 420, y: 480 },
};

/** Offsets for fleets on named coasts, added to the province anchor. */
export const COAST_OFFSETS: Record<string, Anchor> = {
  "STP/NC": { x: -24, y: -26 },
  "STP/SC": { x: -30, y: 22 },
  "SPA/NC": { x: 0, y: -30 },
  "SPA/SC": { x: 20, y: 28 },
  "BUL/EC": { x: 34, y: -6 },
  "BUL/SC": { x: 10, y: 30 },
};

/** Anchor for a region name such as `STP/NC` or `PAR`. */
export function anchorOf(region: string): Anchor {
  const [prov] = region.split("/");
  const base = POSITIONS[prov ?? ""] ?? { x: 0, y: 0 };
  const off = COAST_OFFSETS[region];
  return off ? { x: base.x + off.x, y: base.y + off.y } : base;
}

/** Sea zones get bigger, softer shapes; land is a compact hexagon. */
export const NODE_RADIUS = { land: 26, coast: 26, sea: 34 } as const;
