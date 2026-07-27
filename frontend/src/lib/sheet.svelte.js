// Action-sheet presenter: promise-based like the old ion-action-sheet
// helper. The host component (ActionSheetHost, built on Bits UI Dialog)
// renders whatever sheet is current.
export const sheet = $state({ current: null });

let seq = 0;

// Resolves with the chosen option's value, or undefined on cancel/backdrop.
// `options` may itself be a Promise: the sheet opens immediately with a
// spinner and fills in when it resolves. Resolving to null/empty (the
// loader handled its own error, e.g. via toast) closes the sheet.
export function presentActionSheet(header, options, current) {
  return new Promise((resolve) => {
    sheet.current?.resolve(undefined); // a new sheet cancels the previous one
    const id = ++seq;
    const isAsync = typeof options?.then === 'function';
    sheet.current = {
      id,
      header,
      options: isAsync ? [] : options,
      currentValue: current,
      resolve,
      loading: isAsync,
    };
    if (isAsync) {
      options.then(
        (opts) => {
          if (sheet.current?.id !== id) return; // dismissed or replaced meanwhile
          if (!opts || opts.length === 0) {
            resolveSheet(undefined);
            return;
          }
          sheet.current.options = opts;
          sheet.current.loading = false;
        },
        () => {
          if (sheet.current?.id === id) resolveSheet(undefined);
        }
      );
    }
  });
}

export function resolveSheet(value) {
  const s = sheet.current;
  if (!s) return;
  sheet.current = null;
  s.resolve(value);
}
