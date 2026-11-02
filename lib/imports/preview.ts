import { detectAll } from './detect';

/** Detection for a browser preview slice: the bytes may stop part-way through a row or a character. */
export function parseCsvPreview(bytes: Uint8Array, truncated: boolean) {
  const detected = detectAll(bytes, { truncated });
  if (!truncated) return detected;
  // The last line of a cut-off slice is incomplete, so it isn't shown.
  const end = detected.text.lastIndexOf('\n');
  return end > 0 ? { ...detected, text: detected.text.slice(0, end + 1) } : detected;
}
