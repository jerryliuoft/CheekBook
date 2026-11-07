// Album styles. Colours and lettering live in styles/theme.css under
// [data-book='<id>']; this file adds what CSS can't: names, page titles, tape.

export interface BookStyle {
  id: string;
  name: string;
  tape: boolean; // washi tape on some stickers
  title: (page: number) => string; // page is 1-based
}

function roman(n: number): string {
  const parts: [number, string][] = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
    [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
  ];
  let out = '';
  for (const [v, s] of parts) while (n >= v) { out += s; n -= v; }
  return out;
}

export const BOOK_STYLES: BookStyle[] = [
  { id: 'linen', name: 'Linen', tape: true, title: (n) => `little cheeks · page ${n}` },
  { id: 'gallery', name: 'Gallery', tape: false, title: (n) => `Plate ${roman(n)}` },
  { id: 'kraft', name: 'Kraft', tape: true, title: (n) => `page ${n}` },
  { id: 'sage', name: 'Sage', tape: true, title: (n) => `— ${n} —` },
  { id: 'noir', name: 'Noir', tape: false, title: (n) => roman(n) },
];

export function bookStyle(id: string): BookStyle {
  return BOOK_STYLES.find((s) => s.id === id) ?? BOOK_STYLES[0];
}
