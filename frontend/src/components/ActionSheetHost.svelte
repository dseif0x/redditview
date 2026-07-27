<script>
  // iOS-style action sheet built on Bits UI's Dialog. The presenter in
  // lib/sheet.svelte.js resolves a promise with the tapped option's value,
  // or undefined on cancel/backdrop/Escape — same contract as the old
  // ion-action-sheet helper.
  import { Dialog } from 'bits-ui';
  import { sheet, resolveSheet } from '../lib/sheet.svelte.js';

  const open = $derived(!!sheet.current);
</script>

<Dialog.Root
  {open}
  onOpenChange={(o) => {
    if (!o) resolveSheet(undefined);
  }}
>
  <Dialog.Portal>
    <Dialog.Overlay class="sheet-backdrop" />
    <!-- No auto-focus on open: the sheet is anchored to the real screen
         bottom, which sits below iOS's cut-short layout viewport in
         standalone mode — focusing it makes WebKit scroll the whole app
         up and snap back. -->
    <Dialog.Content
      class="action-sheet"
      aria-describedby={undefined}
      onOpenAutoFocus={(e) => e.preventDefault()}
    >
      {#if sheet.current}
        <div class="as-group">
          <Dialog.Title class="as-header">{sheet.current.header}</Dialog.Title>
          {#if sheet.current.loading}
            <div class="as-loading"><div class="spinner"></div></div>
          {/if}
          {#each sheet.current.options as o (o.value)}
            <button
              type="button"
              class="as-btn"
              class:sheet-current={o.value === sheet.current.currentValue}
              onclick={() => resolveSheet(o.value)}
            >
              {o.text}
            </button>
          {/each}
        </div>
        <button type="button" class="as-btn as-cancel" onclick={() => resolveSheet(undefined)}>Cancel</button>
      {/if}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
