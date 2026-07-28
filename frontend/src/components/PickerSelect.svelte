<script>
  import { Select } from 'bits-ui';
  import Icon from './Icon.svelte';

  // Themed Bits UI Select: a pill trigger that opens an anchored dropdown.
  // Items use the app's sheet-option shape: { text, value }.
  let { value = '', items = [], onchange, id = undefined, triggerClass = '', placeholder = 'Select…' } = $props();

  const current = $derived(items.find((i) => i.value === value));
</script>

<Select.Root
  type="single"
  {value}
  onValueChange={(v) => onchange?.(v)}
  items={items.map((i) => ({ value: i.value, label: i.text }))}
>
  <Select.Trigger {id} class="pill select-trigger {triggerClass}">
    <span class="select-label">{current?.text ?? placeholder}</span>
    <Icon name="chevron-down" />
  </Select.Trigger>
  <Select.Portal>
    <Select.Content class="select-content" sideOffset={6}>
      <Select.Viewport>
        {#each items as it (it.value)}
          <Select.Item value={it.value} label={it.text} class="select-item">
            {#snippet children({ selected })}
              <span class="select-item-label">{it.text}</span>
              {#if selected}<Icon name="check" />{/if}
            {/snippet}
          </Select.Item>
        {/each}
      </Select.Viewport>
    </Select.Content>
  </Select.Portal>
</Select.Root>
