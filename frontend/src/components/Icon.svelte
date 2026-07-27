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
  import ArrowDownWideNarrow from '@lucide/svelte/icons/arrow-down-wide-narrow';
  import Layers from '@lucide/svelte/icons/layers';
  import Eye from '@lucide/svelte/icons/eye';
  import Users from '@lucide/svelte/icons/users';
  import Newspaper from '@lucide/svelte/icons/newspaper';

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
    sort: ArrowDownWideNarrow,
    layers: Layers,
    eye: Eye,
    users: Users,
    newspaper: Newspaper,
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
