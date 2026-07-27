<script>
  import { toast } from '../lib/toast.svelte.js';
</script>

{#if toast.visible}
  {#key toast.seq}
    <div class="toast" role="status">{toast.msg}</div>
  {/key}
{/if}
