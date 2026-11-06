// Reads design tokens from src/styles/theme.css for canvas drawing (Konva,
// OffscreenCanvas), which can't use CSS variables directly.

export function token(name: `--${string}`): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function tapeColors(): string[] {
  return [token('--tape-1'), token('--tape-2'), token('--tape-3'), token('--tape-4')];
}
