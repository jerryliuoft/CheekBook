// Laying stickers out in the scrapbook. A sticker is on a page (page >= 0) or
// back on the sticker sheet (page = SHEET).
import { db, type Sticker } from '../db';

export const PAGE_W = 1000;
export const PAGE_H = 1400;
export const SHEET = -1;

// The area stickers may cover: inside the margins, below the page title.
const AREA = { x0: 50, y0: 130, x1: PAGE_W - 50, y1: PAGE_H - 60 };
const AREA_W = AREA.x1 - AREA.x0, AREA_H = AREA.y1 - AREA.y0;

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const tilt = () => rand(-11, 11);

type Spot = Pick<Sticker, 'x' | 'y' | 'scale' | 'rotation'>;

function shuffled<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Longest side on the page for n stickers sharing it. */
function sizeFor(n: number) {
  return Math.min(620, Math.max(220, Math.sqrt((AREA_W * AREA_H * 0.62) / Math.max(1, n))));
}

/**
 * Spots for stickers sharing a page: a loose grid, shuffled and jittered, so
 * the page looks arranged by hand rather than tiled.
 */
function layout(stickers: Sticker[]): Map<number, Spot> {
  const n = stickers.length;
  const cols = Math.max(1, Math.round(Math.sqrt((n * AREA_W) / AREA_H)));
  const rows = Math.ceil(n / cols);
  const cw = AREA_W / cols, ch = AREA_H / rows;
  const cells = shuffled(Array.from({ length: rows * cols }, (_, i) => i)).slice(0, n);
  const target = Math.min(sizeFor(n), Math.min(cw, ch) * 1.1);
  const out = new Map<number, Spot>();
  stickers.forEach((s, i) => {
    const cell = cells[i];
    const scale = (target * rand(0.88, 1.12)) / Math.max(s.width, s.height);
    const sw = s.width * scale, sh = s.height * scale;
    const cx = AREA.x0 + ((cell % cols) + 0.5) * cw + rand(-0.15, 0.15) * cw;
    const cy = AREA.y0 + (Math.floor(cell / cols) + 0.5) * ch + rand(-0.15, 0.15) * ch;
    out.set(s.id, {
      x: Math.min(PAGE_W - sw / 2 - 20, Math.max(sw / 2 + 20, cx)),
      y: Math.min(PAGE_H - sh / 2 - 20, Math.max(sh / 2 + 100, cy)),
      scale,
      rotation: tilt(),
    });
  });
  return out;
}

/** A free-ish spot for one more sticker on a page, near (x, y) when given. */
async function spotOnPage(page: number, s: Sticker, at?: { x: number; y: number }): Promise<Spot> {
  const others = (await db.stickers.where('page').equals(page).toArray()).filter((o) => o.id !== s.id);
  // Match the size of what's already there.
  const sizes = others.map((o) => Math.max(o.width, o.height) * o.scale).sort((a, b) => a - b);
  const target = sizes.length ? sizes[Math.floor(sizes.length / 2)] : sizeFor(6);
  const scale = target / Math.max(s.width, s.height);
  const sw = s.width * scale, sh = s.height * scale;
  if (at) return { x: at.x, y: at.y, scale, rotation: tilt() };
  let best = { x: PAGE_W / 2, y: PAGE_H / 2, cost: Infinity };
  for (let i = 0; i < 60; i++) {
    const x = rand(AREA.x0 + sw / 2, Math.max(AREA.x0 + sw / 2, AREA.x1 - sw / 2));
    const y = rand(AREA.y0 + sh / 2, Math.max(AREA.y0 + sh / 2, AREA.y1 - sh / 2));
    let cost = 0;
    for (const o of others) {
      const ow = o.width * o.scale, oh = o.height * o.scale;
      const dx = Math.max(0, Math.min(x + sw / 2, o.x + ow / 2) - Math.max(x - sw / 2, o.x - ow / 2));
      const dy = Math.max(0, Math.min(y + sh / 2, o.y + oh / 2) - Math.max(y - sh / 2, o.y - oh / 2));
      cost += dx * dy;
    }
    if (cost < best.cost) best = { x, y, cost };
  }
  return { x: best.x, y: best.y, scale, rotation: tilt() };
}

/** Moves a sticker from the sheet (or another page) onto a page. */
export async function placeSticker(id: number, page: number, at?: { x: number; y: number }) {
  const s = await db.stickers.get(id);
  if (!s) return;
  await db.stickers.update(id, { page, ...(await spotOnPage(page, s, at)) });
}

export async function returnToSheet(id: number) {
  await db.stickers.update(id, { page: SHEET });
}

/** Every sticker back on the sheet: an empty book. */
export async function clearBook() {
  await db.stickers.where('page').aboveOrEqual(0).modify({ page: SHEET });
}

/**
 * Deals every sticker (in the book and on the sheet) into the book in a new
 * random order, at most perPage to a page (0: as many as fit nicely).
 * Returns the number of pages.
 */
export async function shuffleIntoBook(perPage: number): Promise<number> {
  const all = shuffled(await db.stickers.toArray());
  if (!all.length) return 0;
  const pages: Sticker[][] = [];
  if (perPage > 0) {
    for (let i = 0; i < all.length; i += perPage) pages.push(all.slice(i, i + perPage));
  } else {
    // As many as fit nicely: 5 to 8, varying page to page like a real album.
    for (let i = 0; i < all.length; ) {
      const fit = Math.round(rand(5, 8));
      pages.push(all.slice(i, i + fit));
      i += fit;
    }
  }
  await db.transaction('rw', db.stickers, async () => {
    for (const [page, list] of pages.entries()) {
      const spots = layout(list);
      for (const s of list) await db.stickers.update(s.id, { page, ...spots.get(s.id)! });
    }
  });
  return pages.length;
}

/** A new arrangement of the stickers already on one page. */
export async function shufflePage(page: number) {
  const list = await db.stickers.where('page').equals(page).toArray();
  const spots = layout(list);
  await db.transaction('rw', db.stickers, async () => {
    for (const s of list) await db.stickers.update(s.id, spots.get(s.id)!);
  });
}
