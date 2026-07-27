<script module>
  // Lucide icons, bundled per-icon so only the ones used ship. Lucide is
  // stroke-based: active states (saved star, cast votes) render the same
  // glyph with `filled` instead of a separate filled icon.
  import Play from '@lucide/svelte/icons/play';
  import Pause from '@lucide/svelte/icons/pause';
  import VolumeX from '@lucide/svelte/icons/volume-x';
  import Volume2 from '@lucide/svelte/icons/volume-2';
  import Expand from '@lucide/svelte/icons/expand';
  import Star from '@lucide/svelte/icons/star';
  import ArrowBigUp from '@lucide/svelte/icons/arrow-big-up';
  import ArrowBigDown from '@lucide/svelte/icons/arrow-big-down';
  import MessageCircle from '@lucide/svelte/icons/message-circle';
  import X from '@lucide/svelte/icons/x';
  import Images from '@lucide/svelte/icons/images';
  import Settings from '@lucide/svelte/icons/settings';
  import ChevronsUpDown from '@lucide/svelte/icons/chevrons-up-down';
  import Eye from '@lucide/svelte/icons/eye';

  const ICONS = {
    play: Play,
    pause: Pause,
    'volume-off': VolumeX,
    'volume-on': Volume2,
    expand: Expand,
    star: Star,
    'arrow-big-up': ArrowBigUp,
    'arrow-big-down': ArrowBigDown,
    'message-circle': MessageCircle,
    x: X,
    images: Images,
    settings: Settings,
    'chevrons-up-down': ChevronsUpDown,
    eye: Eye,
  };
</script>

<script>
  let { name, filled = false } = $props();
  const IconComponent = $derived(ICONS[name]);
</script>

<span class="icon" class:icon-filled={filled} aria-hidden="true">
  {#if IconComponent}
    <IconComponent />
  {/if}
</span>
