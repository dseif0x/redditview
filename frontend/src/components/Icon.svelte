<script>
  import { iconSvg } from '../lib/icons.js';

  let { name } = $props();
</script>

<span class="icon" aria-hidden="true">{@html iconSvg(name)}</span>
