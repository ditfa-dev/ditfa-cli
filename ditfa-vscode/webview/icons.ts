/** Inline icons, so the panel needs no icon font and no extra requests. */

const icon = (body: string) =>
  `<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icons = {
  plus: icon('<path d="M8 3v10M3 8h10"/>'),
  history: icon('<path d="M2.5 8a5.5 5.5 0 1 0 1.8-4L2.5 5.6"/><path d="M2.5 2.6v3h3"/><path d="M8 5v3.2l2 1.3"/>'),
  more: icon('<circle cx="3.5" cy="8" r=".6" fill="currentColor"/><circle cx="8" cy="8" r=".6" fill="currentColor"/><circle cx="12.5" cy="8" r=".6" fill="currentColor"/>'),
  send: icon('<path d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/>'),
  stop: '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" rx="2" fill="currentColor"/></svg>',
  at: icon('<circle cx="8" cy="8" r="2.6"/><path d="M10.6 5.4V9a1.7 1.7 0 0 0 3.4 0V8a6 6 0 1 0-2.4 4.8"/>'),
  chevron: icon('<path d="m5 6.5 3 3 3-3"/>'),
  caret: icon('<path d="m6 4.5 3.5 3.5L6 11.5"/>'),
  check: icon('<path d="m3.5 8.5 3 3 6-7"/>'),
  close: icon('<path d="m4 4 8 8M12 4l-8 8"/>'),
  file: icon('<path d="M9 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V6z"/><path d="M9 2v4h4"/>'),
  terminal: icon('<path d="m3 4.5 3.5 3.5L3 11.5M8 12h5"/>'),
  tool: icon('<path d="M10.5 2.5a3 3 0 0 0-3.8 3.8L2.5 10.5v3h3l4.2-4.2a3 3 0 0 0 3.8-3.8L11.5 7.5l-2-.9-.9-2z"/>'),
  search: icon('<circle cx="7" cy="7" r="4.2"/><path d="m10.2 10.2 3.3 3.3"/>'),
  globe: icon('<circle cx="8" cy="8" r="5.8"/><path d="M2.2 8h11.6M8 2.2c2 1.8 2 9.8 0 11.6M8 2.2c-2 1.8-2 9.8 0 11.6"/>'),
  undo: icon('<path d="M5.5 3 2.5 6l3 3"/><path d="M2.5 6H10a3.5 3.5 0 0 1 0 7H6"/>'),
  eye: icon('<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>'),
  pencil: icon('<path d="m10.5 3 2.5 2.5L6 12.5l-3 .5.5-3z"/>'),
  trash: icon('<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>'),
  shield: icon('<path d="M8 2 3 4v4c0 3 2.2 5 5 6 2.8-1 5-3 5-6V4z"/>'),
  plan: icon('<path d="M3 4h10M3 8h10M3 12h6"/>'),
  bolt: icon('<path d="M9 2 3.5 9H8l-1 5 5.5-7H8z"/>'),
  warn: icon('<path d="M8 2.5 1.8 13h12.4zM8 6.5v3M8 11.4v.1"/>'),
  key: icon('<circle cx="5.5" cy="10.5" r="3"/><path d="m7.7 8.3 5.3-5.3M11 5l2 2"/>'),
  cpu: icon('<rect x="4" y="4" width="8" height="8" rx="1.5"/><path d="M6.5 1.8V4M9.5 1.8V4M6.5 12v2.2M9.5 12v2.2M1.8 6.5H4M1.8 9.5H4M12 6.5h2.2M12 9.5h2.2"/>'),
  folder: icon('<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 2h4.5A1.5 1.5 0 0 1 14 6.5v5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"/>'),
};
