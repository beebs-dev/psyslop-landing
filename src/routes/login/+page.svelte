<script lang="ts">
	import type { PageData } from './$types';

	let { data, form } = $props<{ data: PageData; form?: { message?: string } }>();
</script>

<div class="mx-auto w-full max-w-md px-4 pt-10">
	<h1 class="text-2xl font-semibold">Login</h1>

	{#if data.username}
		<p class="mt-4 text-neutral-300">You are logged in.</p>
		<a
			href="/"
			class="mt-4 inline-flex w-full items-center justify-center rounded-md bg-neutral-100 px-3 py-2 text-sm font-medium text-neutral-950"
		>
			Home
		</a>
	{:else}
		<form method="POST" class="mt-6 space-y-4">
			<div>
				<label class="block text-sm text-neutral-300" for="username">Username</label>
				<input
					id="username"
					name="username"
					autocomplete="username"
					class="mt-1 w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2"
					required
				/>
			</div>
			<div>
				<label class="block text-sm text-neutral-300" for="password">Password</label>
				<input
					id="password"
					name="password"
					type="password"
					autocomplete="current-password"
					class="mt-1 w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2"
					required
				/>
			</div>
			{#if form?.message}
				<p class="text-sm text-red-400">{form.message}</p>
			{/if}
			<button
				type="submit"
				class="w-full rounded-md bg-neutral-100 px-3 py-2 text-sm font-medium text-neutral-950"
			>
				Sign in
			</button>
		</form>
	{/if}
</div>
