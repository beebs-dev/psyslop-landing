<script lang="ts">
	import { onDestroy, onMount, tick } from 'svelte';

	type VideoItem = {
		id: string;
		videoUrl: string;
		thumbUrl: string;
	};

	type VideosResponse = {
		items: VideoItem[];
		page: number;
		pageSize: number;
		hasMore: boolean;
		nextPage: number | null;
		total: number;
	};

	let videos = $state<VideoItem[]>([]);
	let page = $state(1);
	const pageSize = 12;
	let hasMore = $state(true);
	let loading = $state(false);
	let error = $state<string | null>(null);

	let sentinel = $state<HTMLDivElement | null>(null);
	let observer: IntersectionObserver | null = null;
	let fillInProgress = $state(false);

	let modalOpen = $state(false);
	let activeVideo = $state<VideoItem | null>(null);
	let modalVideoEl = $state<HTMLVideoElement | null>(null);

	const isSentinelNearViewport = () => {
		if (!sentinel) return false;
		if (typeof window === 'undefined') return false;
		const rect = sentinel.getBoundingClientRect();
		return rect.top <= window.innerHeight + 200;
	};

	const maybeFillViewport = async () => {
		if (fillInProgress) return;
		fillInProgress = true;
		try {
			// If the page isn't scrollable yet, keep fetching until it is.
			// Cap iterations to avoid accidental infinite loops.
			let iterations = 0;
			while (hasMore && !loading && isSentinelNearViewport() && iterations < 6) {
				iterations += 1;
				await fetchNextPage();
			}
		} finally {
			fillInProgress = false;
		}
	};

	const fetchNextPage = async () => {
		if (loading || !hasMore) return;
		loading = true;
		error = null;

		try {
			const res = await fetch(`/api/videos?page=${page}&pageSize=${pageSize}`);
			if (!res.ok) throw new Error(`Failed to load videos (${res.status})`);
			const data = (await res.json()) as VideosResponse;

			videos = [...videos, ...data.items];
			hasMore = data.hasMore;
			if (data.nextPage) page = data.nextPage;
			await tick();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load videos';
		} finally {
			loading = false;
			// If the sentinel is still visible, fetch more to enable scrolling.
			void maybeFillViewport();
		}
	};

	const openModal = async (video: VideoItem) => {
		activeVideo = video;
		modalOpen = true;
		if (typeof document !== 'undefined') document.documentElement.style.overflow = 'hidden';
		await tick();
		await modalVideoEl?.play().catch(() => {
			// Ignore autoplay errors; user can press play.
		});
	};

	const closeModal = () => {
		modalVideoEl?.pause();
		modalVideoEl = null;
		modalOpen = false;
		activeVideo = null;
		if (typeof document !== 'undefined') document.documentElement.style.overflow = '';
	};

	const handlePreviewEnter = (el: HTMLVideoElement) => {
		el.muted = false;
		void el.play().catch(() => {
			// Some browsers may block programmatic play; ignore.
		});
	};

	const handlePreviewLeave = (el: HTMLVideoElement) => {
		el.muted = true;
	};

	const onWindowKeydown = (e: KeyboardEvent) => {
		if (!modalOpen) return;
		if (e.key === 'Escape') closeModal();
	};

	onMount(async () => {
		await fetchNextPage();

		observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) void fetchNextPage();
			},
			{ rootMargin: '800px 0px' }
		);

		if (sentinel) observer.observe(sentinel);
		void maybeFillViewport();
	});

	$effect(() => {
		if (!observer) return;
		observer.disconnect();
		if (sentinel) observer.observe(sentinel);
	});

	onDestroy(() => {
		observer?.disconnect();
		observer = null;
		if (typeof document !== 'undefined') document.documentElement.style.overflow = '';
	});
</script>

<svelte:window on:keydown={onWindowKeydown} />

<main class="mx-auto max-w-6xl px-4 py-6">
	<header class="mb-5 flex items-baseline justify-between gap-3">
		<h1 class="text-lg font-semibold tracking-tight text-neutral-50">All slop. All the time.</h1>
		<p class="text-sm text-neutral-400">Hover to unmute • Click to fullscreen</p>
	</header>

	<section class="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3 lg:grid-cols-4 xl:grid-cols-5">
		{#each videos as video (video.id)}
			<button
				type="button"
				class="group relative overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950/50 ring-0 transition hover:border-neutral-700 hover:bg-neutral-950 focus-visible:ring-2 focus-visible:ring-neutral-200/30"
				aria-label={`Open ${video.id.split('/').at(-1) ?? video.id}`}
				onclick={() => void openModal(video)}
			>
				<div class="aspect-[4/5] w-full">
					<video
						class="h-full w-full object-cover"
						src={video.thumbUrl}
						playsinline
						autoplay
						loop
						muted
						preload="metadata"
						onmouseenter={(e) => handlePreviewEnter(e.currentTarget)}
						onmouseleave={(e) => handlePreviewLeave(e.currentTarget)}
					></video>
				</div>
			</button>
		{/each}
	</section>

	{#if error}
		<div class="mt-4 rounded-lg border border-neutral-800 bg-neutral-950/60 p-3 text-sm text-neutral-200">
			<p class="font-medium text-neutral-50">Couldn’t load videos</p>
			<p class="mt-1 text-neutral-400">{error}</p>
			<button
				type="button"
				class="mt-3 rounded-md bg-neutral-100 px-3 py-1.5 text-neutral-900"
				onclick={() => void fetchNextPage()}
			>
				Try again
			</button>
		</div>
	{/if}

	<div class="mt-6 flex items-center justify-center">
		<div bind:this={sentinel} class="h-10 w-full" aria-hidden="true"></div>
	</div>

	{#if loading}
		<p class="mt-2 text-center text-sm text-neutral-400">Loading…</p>
	{:else if !hasMore && videos.length > 0}
		<p class="mt-2 text-center text-sm text-neutral-400">You’ve reached the end.</p>
	{/if}
</main>

{#if modalOpen && activeVideo}
	<div class="fixed inset-0 z-50 p-3">
		<button
			type="button"
			class="absolute inset-0 bg-black/85"
			aria-label="Close video"
			onclick={closeModal}
		></button>

		<div class="relative mx-auto flex h-full max-w-6xl items-center justify-center">
			<div class="relative w-full" role="dialog" aria-modal="true" aria-label="Video player" tabindex="-1">
				<button
					type="button"
					class="absolute right-2 top-2 z-10 rounded-md bg-neutral-950/70 px-3 py-1.5 text-sm text-neutral-50 ring-1 ring-neutral-700/60"
					onclick={closeModal}
				>
					Close
				</button>

				<video
					class="max-h-[85vh] w-full rounded-lg bg-black ring-1 ring-neutral-800"
					src={activeVideo.videoUrl}
					controls
					autoplay
					playsinline
					bind:this={modalVideoEl}
				>
					<track kind="captions" src="/captions/placeholder.vtt" />
				</video>
			</div>
		</div>
	</div>
{/if}
