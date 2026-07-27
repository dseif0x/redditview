<script>
  import { onMount } from 'svelte';
  import { P, initPlayer } from './lib/player.svelte.js';
  import { settings } from './lib/settings.svelte.js';
  import { initSync } from './lib/syncAccount.svelte.js';
  import TopBar from './components/TopBar.svelte';
  import Viewer from './components/Viewer.svelte';
  import ProgressBar from './components/ProgressBar.svelte';
  import MetaBar from './components/MetaBar.svelte';
  import CommentsSheet from './components/CommentsSheet.svelte';
  import SettingsPage from './components/SettingsPage.svelte';
  import TabBar from './components/TabBar.svelte';
  import Toast from './components/Toast.svelte';
  import ActionSheetHost from './components/ActionSheetHost.svelte';
  import DebugOverlay from './components/DebugOverlay.svelte';

  // Global listeners + session resume run once the shell (progress bar, tab
  // bar) has mounted and registered its elements.
  onMount(() => {
    initPlayer();
    initSync();
  });
</script>

<div id="app" class:vertical={settings.vertical}>
  <TopBar />
  <Viewer />
  <ProgressBar />
  <MetaBar />
  {#if P.tab === 'settings'}
    <SettingsPage />
  {/if}
  <TabBar />
</div>
<CommentsSheet />
<ActionSheetHost />
<Toast />
<DebugOverlay />
