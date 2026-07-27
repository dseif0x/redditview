// Single-toast queue: a new toast replaces the visible one, like the old
// ion-toast wiring did.
export const toast = $state({ msg: '', seq: 0, visible: false });

let hideTimer = null;
export function showToast(msg, ms = 4000) {
  toast.msg = msg;
  toast.seq++; // re-keys the element so the entry animation replays
  toast.visible = true;
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    toast.visible = false;
  }, ms);
}
