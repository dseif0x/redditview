// Action-sheet presenter: promise-based like the old ion-action-sheet
// helper. The host component (ActionSheetHost, built on Bits UI Dialog)
// renders whatever sheet is current.
export const sheet = $state({ current: null });

// Resolves with the chosen option's value, or undefined on cancel/backdrop.
export function presentActionSheet(header, options, current) {
  return new Promise((resolve) => {
    sheet.current?.resolve(undefined); // a new sheet cancels the previous one
    sheet.current = { header, options, currentValue: current, resolve };
  });
}

export function resolveSheet(value) {
  const s = sheet.current;
  if (!s) return;
  sheet.current = null;
  s.resolve(value);
}
