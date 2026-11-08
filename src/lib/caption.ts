// Meme-style captions (表情包) on stickers: the phrase lists, the lettering
// styles, and the canvas drawing shared by the book and the sticker sheet.
// Captions are drawn live from Sticker.caption, so the cut-out PNG never changes.

import '@fontsource/noto-sans-sc/900.css';
import '@fontsource/zcool-kuaile/400.css';
import '@fontsource/ma-shan-zheng/400.css';
import type { Caption, CaptionPos, Expression } from '../db';
import { token } from './theme';

export interface CaptionStyle {
  id: string;
  name: string;
}

export const CAPTION_STYLES: CaptionStyle[] = [
  { id: 'classic', name: '经典 Classic' },
  { id: 'cute', name: '可爱 Cute' },
  { id: 'hand', name: '手写 Handwritten' },
  { id: 'bubble', name: '气泡 Bubble' },
];

export const CAPTION_LANGS: [string, string][] = [
  ['zh', '中文'],
  ['en', 'English'],
  ['both', '中文 + English'],
];

type Phrases = { zh: string[]; en: string[] };

const PHRASES: Record<Expression | 'any', Phrases> = {
  laughing: {
    zh: ['笑死我了', '开心到飞起', '哈哈哈哈哈', '嘿嘿嘿', '乐出声'],
    en: ['LOL', 'Best day ever', 'Hehehe', "Can't stop laughing"],
  },
  smiling: {
    zh: ['今天也很可爱', '嘻嘻', '美滋滋', '被自己可爱到了', '今日份可爱'],
    en: ['Hi hi!', 'Feeling cute', 'Mood: good', 'Too cute to handle'],
  },
  surprised: {
    zh: ['震惊!', '啊这', '什么?!', '我惊呆了', '不敢相信'],
    en: ['Wait, what?!', 'Excuse me?', 'Shook', 'No way!'],
  },
  ooh: {
    zh: ['哇哦~', '好奇宝宝', '让我看看', '哦~原来如此'],
    en: ['Ooooh', 'Tell me more', 'Interesting…', 'Whoa'],
  },
  sleepy: {
    zh: ['困了困了', '别吵', '再睡五分钟', '电量不足'],
    en: ['Nap time', 'Five more minutes', 'Low battery', 'Do not disturb'],
  },
  crying: {
    zh: ['委屈巴巴', '我不听我不听', '呜呜呜', '要抱抱'],
    en: ['Waaah', 'Not fair!', 'Hold me', 'Big feelings'],
  },
  upset: {
    zh: ['哼!', '不开心', '别碰我', '生气了哦'],
    en: ['Hmph!', 'Not amused', "Don't talk to me", "I'm the boss"],
  },
  calm: {
    zh: ['淡定', '我很好', '岁月静好', '看透一切'],
    en: ['Unbothered', 'Just vibing', 'Chill', 'Zen mode'],
  },
  any: {
    zh: ['宝宝驾到', '看什么看', '可爱本爱', '嗨~'],
    en: ['Hello world', "It's me!", 'Hi!', 'Who, me?'],
  },
};

function pick<T>(list: T[], avoid?: T): T {
  const choices = list.length > 1 ? list.filter((x) => x !== avoid) : list;
  return choices[Math.floor(Math.random() * choices.length)];
}

/** A random caption for this expression, different from `avoid` when possible. */
export function suggestCaption(expression: Expression | undefined, lang: string, avoid?: string): string {
  const p = PHRASES[expression ?? 'any'] ?? PHRASES.any;
  const list = lang === 'en' ? p.en : lang === 'both' ? [...p.zh, ...p.en] : p.zh;
  return pick(list, avoid);
}

export function newCaption(expression: Expression | undefined, lang: string, style: string, pos: CaptionPos = 'bottom'): Caption {
  return { text: suggestCaption(expression, lang), style, pos };
}

// ---- Drawing ---------------------------------------------------------------

interface Lettering {
  font: (px: number) => string;
  size: number; // font size as a share of the sticker width
}

function lettering(style: string): Lettering {
  switch (style) {
    case 'cute':
      return { font: (px) => `400 ${px}px ${token('--font-caption-cute')}`, size: 0.26 };
    case 'hand':
      return { font: (px) => `400 ${px}px ${token('--font-caption-hand')}`, size: 0.28 };
    case 'bubble':
      return { font: (px) => `900 ${px}px ${token('--font-caption-bold')}`, size: 0.17 };
    default:
      return { font: (px) => `900 ${px}px ${token('--font-caption-bold')}`, size: 0.24 };
  }
}

const isCJK = (ch: string) => /[⺀-鿿豈-﫿＀-￯]/.test(ch);

/** Splits text into at most two lines no wider than maxW at the current font. */
function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  if (ctx.measureText(text).width <= maxW) return [text];
  // Break between words, or anywhere between Chinese characters; take the most even split.
  const breaks: number[] = [];
  for (let i = 1; i < text.length; i++) {
    if (text[i] === ' ' || isCJK(text[i]) || isCJK(text[i - 1])) breaks.push(i);
  }
  let best: string[] = [text];
  let bestW = Infinity;
  for (const i of breaks) {
    const lines = [text.slice(0, i).trim(), text.slice(i).trim()];
    const w = Math.max(...lines.map((l) => ctx.measureText(l).width));
    if (w < bestW) [best, bestW] = [lines, w];
  }
  return best;
}

/** A small, steady tilt per sticker, so captions look hand-placed but don't jump around. */
export const captionTilt = (stickerId: number) => (((stickerId * 37) % 9) - 4) * (Math.PI / 180);

export interface Composed {
  canvas: HTMLCanvasElement;
  ax: number; // centre of the cut-out inside the canvas, in canvas pixels
  ay: number;
}

/**
 * Draws a sticker with its caption onto one canvas, in the sticker's own
 * pixels. The canvas grows to fit text that hangs past the cut-out.
 */
export async function composeSticker(img: CanvasImageSource & { width: number; height: number }, caption: Caption, tilt = 0): Promise<Composed> {
  const w = img.width;
  const h = img.height;
  const text = caption.text.trim();
  const look = lettering(caption.style);
  const measure = document.createElement('canvas').getContext('2d')!;

  // Size the text to the sticker; shrink until it fits in two lines.
  let px = Math.round(w * look.size);
  await document.fonts.load(look.font(px), text);
  const maxW = w * 1.05;
  let lines: string[] = [];
  for (; px > 10; px = Math.round(px * 0.92)) {
    measure.font = look.font(px);
    lines = wrap(measure, text, maxW);
    if (Math.max(...lines.map((l) => measure.measureText(l).width)) <= maxW) break;
  }
  measure.font = look.font(px);
  const lineH = px * 1.12;
  const textW = Math.max(...lines.map((l) => measure.measureText(l).width));
  const textH = lineH * lines.length;

  const bubble = caption.style === 'bubble';
  const padX = bubble ? px * 0.6 : px * 0.25;
  const padY = bubble ? px * 0.4 : px * 0.15;
  const blockW = textW + padX * 2;
  const blockH = textH + padY * 2;

  // The block overlaps the cut-out a little, like a caption stuck on the photo.
  const overlap = blockH * (bubble ? 0.15 : 0.32);
  const cy = caption.pos === 'top' ? overlap - blockH / 2 : h - overlap + blockH / 2;
  const cx = w / 2;

  // Room for the tilted block (and the bubble's tail).
  const cos = Math.abs(Math.cos(tilt));
  const sin = Math.abs(Math.sin(tilt));
  const rw = blockW * cos + blockH * sin;
  const rh = blockW * sin + blockH * cos + (bubble ? px * 0.5 : 0);
  const margin = px * 0.3;
  const left = Math.min(0, cx - rw / 2 - margin);
  const top = Math.min(0, cy - rh / 2 - margin);
  const right = Math.max(w, cx + rw / 2 + margin);
  const bottom = Math.max(h, cy + rh / 2 + margin);

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(right - left);
  canvas.height = Math.ceil(bottom - top);
  const ctx = canvas.getContext('2d')!;
  ctx.translate(-left, -top);
  ctx.drawImage(img, 0, 0, w, h);

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(tilt);
  ctx.font = look.font(px);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  const shadow = () => {
    ctx.shadowColor = token('--caption-shadow');
    ctx.shadowBlur = px * 0.14;
    ctx.shadowOffsetY = px * 0.05;
  };
  const noShadow = () => {
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
  };
  const eachLine = (draw: (line: string, y: number) => void) =>
    lines.forEach((l, i) => draw(l, (i - (lines.length - 1) / 2) * lineH));
  // Outline first, then the fill on top, so the letters stay full width.
  const outline = (color: string, width: number) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    eachLine((l, y) => ctx.strokeText(l, 0, y));
  };
  const fill = (color: string) => {
    ctx.fillStyle = color;
    eachLine((l, y) => ctx.fillText(l, 0, y));
  };

  switch (caption.style) {
    case 'cute':
      shadow();
      outline(token('--caption-cute-edge'), px * 0.34);
      noShadow();
      outline(token('--caption-cute-stroke'), px * 0.22);
      fill(token('--caption-cute-fill'));
      break;
    case 'hand':
      shadow();
      outline(token('--caption-hand-stroke'), px * 0.2);
      noShadow();
      fill(token('--caption-hand-fill'));
      break;
    case 'bubble': {
      const r = Math.min(blockH / 2, px * 0.7);
      const tailDir = caption.pos === 'top' ? 1 : -1; // points toward the face
      const edge = (tailDir * blockH) / 2;
      ctx.beginPath();
      ctx.roundRect(-blockW / 2, -blockH / 2, blockW, blockH, r);
      ctx.moveTo(-px * 0.35, edge);
      ctx.lineTo(px * 0.05, edge + tailDir * px * 0.5);
      ctx.lineTo(px * 0.35, edge);
      ctx.fillStyle = token('--caption-bubble-fill');
      shadow();
      ctx.fill();
      noShadow();
      ctx.strokeStyle = token('--caption-bubble-stroke');
      ctx.lineWidth = px * 0.09;
      ctx.stroke();
      // Cover the stroke where the tail joins the bubble.
      ctx.fillRect(-px * 0.3, edge - (tailDir * px * 0.06), px * 0.6, tailDir * px * 0.12);
      fill(token('--caption-bubble-ink'));
      break;
    }
    default:
      shadow();
      outline(token('--caption-classic-stroke'), px * 0.26);
      noShadow();
      fill(token('--caption-classic-fill'));
  }
  ctx.restore();

  return { canvas, ax: w / 2 - left, ay: h / 2 - top };
}
