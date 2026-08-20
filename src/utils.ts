import { createHash, randomUUID } from 'node:crypto';

export const nowIso = () => new Date().toISOString();
export const trackingId = () => randomUUID().slice(0, 8);
export function stableUuid(input: string): string {
  const hex = createHash('sha256').update(input).digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const s = hex.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
export function normalizeSlackText(text: string): string {
  return text.replace(/<@([A-Z0-9]+)>/g, '@$1').replace(/<#([A-Z0-9]+)\|([^>]+)>/g, '#$2').replace(/<([^|>]+)\|([^>]+)>/g, '$2 ($1)').replace(/<([^>]+)>/g, '$1').trim();
}
export const truncate = (s: string, max = 2000) => s.length <= max ? s : `${s.slice(0, max - 1)}…`;
