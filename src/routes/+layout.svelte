<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';
	import type { LayoutData } from './$types';

	let { children, data } = $props<{ children: unknown; data: LayoutData }>();
</script>


<svelte:head><link rel="icon" href={favicon} /></svelte:head>

<div class="mx-auto w-full max-w-6xl px-4">
	<div class="flex h-10 items-center justify-end text-sm text-neutral-300">
		{#if data?.username}
			<div>Logged in as {data.username}</div>
		{/if}
	</div>
</div>

{@render children()}

