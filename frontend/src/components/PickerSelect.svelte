<script>
  import { Select } from 'bits-ui';
  import Icon from './Icon.svelte';

  // Themed Bits UI Select. Items use the app's option shape { text, value };
  // pass either a flat `items` list or `sections` ([{ label, items }]) for a
  // grouped dropdown. The default trigger is a pill showing the current
  // choice; pass a `trigger` snippet (plus `triggerClass`) for a custom one,
  // e.g. an icon button.
  let {
    value = '',
    items = [],
    sections = null,
    onchange,
    id = undefined,
    triggerClass = '',
    placeholder = 'Select…',
    title = undefined,
    trigger = null,
  } = $props();

  const flat = $derived(sections ? sections.flatMap((s) => s.items) : items);
  const current = $derived(flat.find((i) => i.value === value));
</script>

{#snippet option(it)}
  <Select.Item value={it.value} label={it.text} class="select-item">
    {#snippet children({ selected })}
      <span class="select-item-label">{it.text}</span>
      {#if selected}<Icon name="check" />{/if}
    {/snippet}
  </Select.Item>
{/snippet}

<Select.Root
  type="single"
  {value}
  onValueChange={(v) => onchange?.(v)}
  items={flat.map((i) => ({ value: i.value, label: i.text }))}
>
  <Select.Trigger {id} {title} class={trigger ? triggerClass : `pill select-trigger ${triggerClass}`}>
    {#if trigger}
      {@render trigger()}
    {:else}
      <span class="select-label">{current?.text ?? placeholder}</span>
      <Icon name="chevron-down" />
    {/if}
  </Select.Trigger>
  <Select.Portal>
    <Select.Content class="select-content" sideOffset={6}>
      <Select.Viewport>
        {#if sections}
          {#each sections as sec, i (i)}
            {#if sec.label}
              <Select.Group>
                <Select.GroupHeading class="select-heading">{sec.label}</Select.GroupHeading>
                {#each sec.items as it (it.value)}
                  {@render option(it)}
                {/each}
              </Select.Group>
            {:else}
              {#each sec.items as it (it.value)}
                {@render option(it)}
              {/each}
            {/if}
          {/each}
        {:else}
          {#each items as it (it.value)}
            {@render option(it)}
          {/each}
        {/if}
      </Select.Viewport>
    </Select.Content>
  </Select.Portal>
</Select.Root>
