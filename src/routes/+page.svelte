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
	let observer = $state<IntersectionObserver | null>(null);
	let fillInProgress = $state(false);

	let modalOpen = $state(false);
	let activeVideo = $state<VideoItem | null>(null);
	let activeIndex = $state<number | null>(null);
	let modalVideoEl = $state<HTMLVideoElement | null>(null);
	let allowHoverUnmute = $state(false);

	let incomingVideo = $state<VideoItem | null>(null);
	let slideDir = $state<1 | -1>(1);
	let slideRunning = $state(false);
	let swipeStart = $state<{ x: number; y: number; t: number } | null>(null);

	let prefetchPrevUrl = $state<string | null>(null);
	let prefetchNextUrl = $state<string | null>(null);
	let prefetchPrevEl = $state<HTMLVideoElement | null>(null);
	let prefetchNextEl = $state<HTMLVideoElement | null>(null);

	let copied = $state(false);
	let copyError = $state<string | null>(null);
	let hasHandledDeepLink = $state(false);

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
		const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
		const timeoutId = controller ? setTimeout(() => controller.abort(), 15_000) : null;

		try {
			const res = await fetch(`/api/videos?page=${page}&pageSize=${pageSize}`, {
				signal: controller?.signal
			});
			if (!res.ok) throw new Error(`Failed to load videos (${res.status})`);
			const data = (await res.json()) as VideosResponse;

			videos = [...videos, ...data.items];
			hasMore = data.hasMore;
			if (data.nextPage) page = data.nextPage;
			await tick();
		} catch (e) {
			if (e instanceof DOMException && e.name === 'AbortError') {
				error = 'Request timed out while loading videos';
			} else {
				error = e instanceof Error ? e.message : 'Failed to load videos';
			}
		} finally {
			if (timeoutId) clearTimeout(timeoutId);
			loading = false;
			// If the sentinel is still visible, fetch more to enable scrolling.
			void maybeFillViewport();
		}
	};

	const openModal = async (
		video: VideoItem,
		previewEl?: HTMLVideoElement | null,
		index?: number | null
	) => {
		// Mobile browsers can fire mouseenter/mouseleave semantics on tap.
		// Force the thumbnail preview muted/paused so it can't keep audio playing under the modal.
		if (previewEl) {
			previewEl.muted = true;
			previewEl.pause();
		}

		activeVideo = video;
		activeIndex = typeof index === 'number' ? index : videos.findIndex((v) => v.id === video.id);
		modalOpen = true;
		if (typeof document !== 'undefined') document.documentElement.style.overflow = 'hidden';
		await tick();
		await modalVideoEl?.play().catch(() => {
			// Ignore autoplay errors; user can press play.
		});
	};

	const FULLRES_PREFIX = '_fullres/';
	const FULLRES_SUFFIX = '.mp4';

	const normalizeVideoSlug = (value: string) => {
		let slug = value;
		if (slug.startsWith(FULLRES_PREFIX)) slug = slug.slice(FULLRES_PREFIX.length);
		if (slug.toLowerCase().endsWith(FULLRES_SUFFIX)) slug = slug.slice(0, -FULLRES_SUFFIX.length);
		return slug;
	};

	const keyToSlug = (key: string) => normalizeVideoSlug(key);

	const slugToKey = (slug: string) => {
		const normalized = normalizeVideoSlug(slug);
		return `${FULLRES_PREFIX}${normalized}${FULLRES_SUFFIX}`;
	};

	const getDeepLinkSlug = () => {
		if (typeof window === 'undefined') return null;
		const u = new URL(window.location.href);
		const raw = u.searchParams.get('v');
		return raw ? normalizeVideoSlug(raw) : null;
	};

	const setDeepLinkSlug = (slug: string | null) => {
		if (typeof window === 'undefined') return;
		const u = new URL(window.location.href);
		if (slug) u.searchParams.set('v', normalizeVideoSlug(slug));
		else u.searchParams.delete('v');
		window.history.replaceState({}, '', u);
	};

	const openModalBySlug = async (slug: string) => {
		const key = slugToKey(slug);
		// Try to find in already-loaded results; if not present, fetch additional pages until found.
		// Note: there may be concurrent background loading (infinite scroll fill). Avoid spinning.
		const deadline = Date.now() + 12_000;
		while (Date.now() < deadline) {
			const idx = videos.findIndex((v) => v.id === key);
			if (idx !== -1) {
				await openModal(videos[idx], null, idx);
				return;
			}

			if (!hasMore && !loading) break;

			if (loading) {
				await new Promise((r) => setTimeout(r, 50));
				continue;
			}

			if (hasMore) {
				await fetchNextPage();
			} else {
				break;
			}
		}

		// Not found (or timed out). Keep the query intact so it doesn't get stripped on load.
		error = 'That video link could not be found.';
	};

	const closeModal = () => {
		modalVideoEl?.pause();
		modalVideoEl = null;
		modalOpen = false;
		activeVideo = null;
		activeIndex = null;
		incomingVideo = null;
		slideRunning = false;
		copied = false;
		copyError = null;
		setDeepLinkSlug(null);
		if (typeof document !== 'undefined') document.documentElement.style.overflow = '';
	};

	const canGoPrev = () => activeIndex !== null && activeIndex > 0;
	const canGoNext = () => activeIndex !== null && activeIndex < videos.length - 1;

	const startSlideTo = async (nextVideo: VideoItem, nextIndex: number, dir: 1 | -1) => {
		if (!modalOpen) return;
		if (slideRunning) return;
		modalVideoEl?.pause();

		slideDir = dir;
		incomingVideo = nextVideo;
		slideRunning = false;
		await tick();
		// Kick the transition on the next frame so transforms animate.
		requestAnimationFrame(() => {
			slideRunning = true;
		});

		// After the slide completes, make the incoming video the active one.
		setTimeout(async () => {
			activeVideo = nextVideo;
			activeIndex = nextIndex;
			incomingVideo = null;
			slideRunning = false;
			await tick();
			// Some mobile browsers need an explicit load() when src changes.
			modalVideoEl?.load();
			await modalVideoEl?.play().catch(() => {
				// Ignore autoplay errors; user can press play.
			});
		}, 320);
	};

	$effect(() => {
		if (!modalOpen || activeIndex === null) {
			prefetchPrevUrl = null;
			prefetchNextUrl = null;
			return;
		}

		const prev = activeIndex > 0 ? videos[activeIndex - 1] : null;
		const next = activeIndex < videos.length - 1 ? videos[activeIndex + 1] : null;
		prefetchPrevUrl = prev?.videoUrl ?? null;
		prefetchNextUrl = next?.videoUrl ?? null;

		// If we're at the end of the loaded list while modal is open, fetch ahead so "Next" is ready.
		if (!next && hasMore && !loading) {
			void fetchNextPage();
		}
	});

	$effect(() => {
		// Keep the URL in sync with the currently shown modal video.
		if (!modalOpen || !activeVideo) return;
		setDeepLinkSlug(keyToSlug(activeVideo.id));
	});

	const copyVideoLink = async () => {
		copied = false;
		copyError = null;
		if (typeof window === 'undefined' || !activeVideo) return;

		const u = new URL(window.location.href);
		u.searchParams.set('v', keyToSlug(activeVideo.id));
		const text = u.toString();

		try {
			if (navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(text);
			} else {
				const ta = document.createElement('textarea');
				ta.value = text;
				ta.setAttribute('readonly', '');
				ta.style.position = 'fixed';
				ta.style.left = '-9999px';
				document.body.appendChild(ta);
				ta.select();
				const ok = document.execCommand('copy');
				ta.remove();
				if (!ok) throw new Error('Copy failed');
			}
			copied = true;
			setTimeout(() => {
				copied = false;
			}, 1200);
		} catch {
			copyError = 'Could not copy link';
		}
	};

	$effect(() => {
		if (!prefetchPrevEl || !prefetchPrevUrl) return;
		prefetchPrevEl.load();
	});

	$effect(() => {
		if (!prefetchNextEl || !prefetchNextUrl) return;
		prefetchNextEl.load();
	});

	const goPrev = async () => {
		if (!canGoPrev() || activeIndex === null) return;
		const nextIndex = activeIndex - 1;
		const nextVideo = videos[nextIndex];
		await startSlideTo(nextVideo, nextIndex, -1);
	};

	const goNext = async () => {
		if (activeIndex === null) return;
		if (activeIndex >= videos.length - 1) {
			// If we're at the end of the loaded list but there are more, fetch then try again.
			if (hasMore && !loading) {
				await fetchNextPage();
			}
		}
		if (!canGoNext() || activeIndex === null) return;
		const nextIndex = activeIndex + 1;
		const nextVideo = videos[nextIndex];
		await startSlideTo(nextVideo, nextIndex, 1);
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
		if (e.key === 'ArrowLeft') void goPrev();
		if (e.key === 'ArrowRight') void goNext();
	};

	const onSwipeStart = (e: PointerEvent) => {
		if (!modalOpen) return;
		// Only treat touch as a swipe gesture.
		if (e.pointerType !== 'touch') return;
		swipeStart = { x: e.clientX, y: e.clientY, t: Date.now() };
	};

	const onSwipeEnd = (e: PointerEvent) => {
		if (!modalOpen || !swipeStart) return;
		if (e.pointerType !== 'touch') return;
		const dx = e.clientX - swipeStart.x;
		const dy = e.clientY - swipeStart.y;
		swipeStart = null;

		// Horizontal swipe threshold.
		if (Math.abs(dx) < 60) return;
		if (Math.abs(dx) < Math.abs(dy) * 1.2) return;

		if (dx > 0) void goPrev();
		else void goNext();
	};

	const onModalEnded = () => {
		if (!modalOpen) return;
		if (slideRunning || incomingVideo) return;
		void goNext();
	};

	onMount(async () => {
		allowHoverUnmute =
			typeof window !== 'undefined' &&
			!!window.matchMedia &&
			window.matchMedia('(hover: hover) and (pointer: fine)').matches;

		await fetchNextPage();

		// If we loaded the page with a deep link, open the modal on that item.
		const deepSlug = getDeepLinkSlug();
		if (deepSlug) {
			hasHandledDeepLink = true;
			await openModalBySlug(deepSlug);
		}

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
		// Handle deep-links when navigating within the app (e.g. back/forward).
		if (typeof window === 'undefined') return;
		if (hasHandledDeepLink) return;
		const deepSlug = getDeepLinkSlug();
		if (!deepSlug) return;
		hasHandledDeepLink = true;
		void openModalBySlug(deepSlug);
	});

	$effect(() => {
		if (!observer || !sentinel) return;
		const el = sentinel;
		observer.observe(el);
		return () => observer?.unobserve(el);
	});

	onDestroy(() => {
		observer?.disconnect();
		observer = null;
		if (typeof document !== 'undefined') document.documentElement.style.overflow = '';
	});
</script>

<svelte:head>
	{#if modalOpen && prefetchNextUrl}
		<link rel="preload" as="video" href={prefetchNextUrl} crossorigin="anonymous" />
	{/if}
	{#if modalOpen && prefetchPrevUrl}
		<link rel="prefetch" as="video" href={prefetchPrevUrl} crossorigin="anonymous" />
	{/if}
</svelte:head>

<svelte:window onkeydown={onWindowKeydown} />

<main class="mx-auto max-w-6xl px-4 py-6">
	<header class="mb-5 flex flex-col gap-3 sm:flex-row sm:items-stretch sm:justify-between">
		<div class="flex items-center gap-4">
			<img
				src="https://slop.sfo3.cdn.digitaloceanspaces.com/psyslop-1024.jpg"
				alt="Psyslop"
				width="128"
				height="128"
				class="h-32 w-32 rounded-xl object-cover ring-1 ring-neutral-800"
				decoding="async"
				fetchpriority="high"
			/>
			<div class="pt-1">
				<h1 class="text-xl font-semibold tracking-tight text-neutral-50">All slop. All the time.</h1>
				<a
					href="https://psyslop.tv/discord"
					target="_blank"
					rel="noreferrer"
					class="mt-3 inline-flex items-center gap-2 rounded-lg border border-neutral-800 bg-neutral-950/40 px-3 py-2 text-sm font-medium text-neutral-50 transition hover:border-neutral-700 hover:bg-neutral-950 focus-visible:ring-2 focus-visible:ring-neutral-200/30"
					aria-label="Join our Lab (Discord)"
				>
					<svg
						viewBox="0 0 127.14 96.36"
						class="h-5 w-5"
						aria-hidden="true"
						focusable="false"
					>
						<path
							d="M107.7 8.07A105.15 105.15 0 0 0 81.47 0a72.06 72.06 0 0 0-3.36 6.83A97.68 97.68 0 0 0 49 6.83 72.37 72.37 0 0 0 45.64 0a105.89 105.89 0 0 0-26.27 8.09C2.79 32.65-1.71 56.6.54 80.21A105.73 105.73 0 0 0 32.71 96.36a77.7 77.7 0 0 0 6.89-11.11 68.42 68.42 0 0 1-10.85-5.18c.91-.66 1.8-1.34 2.66-2a75.57 75.57 0 0 0 64.32 0c.87.71 1.76 1.39 2.66 2a68.68 68.68 0 0 1-10.87 5.19 77 77 0 0 0 6.89 11.1 105.25 105.25 0 0 0 32.17-16.14c2.64-27.6-4.5-51.29-18.88-72.15ZM42.45 65.69c-6.18 0-11.25-5.63-11.25-12.57S36.2 40.52 42.45 40.52c6.25 0 11.3 5.68 11.25 12.61 0 6.94-5.06 12.56-11.25 12.56Zm41.89 0c-6.18 0-11.25-5.63-11.25-12.57S78.09 40.52 84.34 40.52c6.25 0 11.3 5.68 11.25 12.61 0 6.94-5.06 12.56-11.25 12.56Z"
							fill="currentColor"
						/>
					</svg>
					<span>Join our Lab</span>
				</a>
			</div>
		</div>
		<p class="text-sm text-neutral-400 sm:self-end sm:text-right">Hover to unmute - click to fullscreen</p>
	</header>

	<section class="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3 lg:grid-cols-4">
		{#each videos as video, i (video.id)}
			<button
				type="button"
				class="group relative overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950/50 ring-0 transition hover:border-neutral-700 hover:bg-neutral-950 focus-visible:ring-2 focus-visible:ring-neutral-200/30"
				aria-label={`Open ${video.id.split('/').at(-1) ?? video.id}`}
				onclick={(e) => {
					const btn = e.currentTarget as HTMLButtonElement;
					const previewEl = btn.querySelector('video');
					void openModal(video, previewEl, i);
				}}
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
						onmouseenter={(e) => {
							if (!allowHoverUnmute) return;
							handlePreviewEnter(e.currentTarget);
						}}
						onmouseleave={(e) => {
							if (!allowHoverUnmute) return;
							handlePreviewLeave(e.currentTarget);
						}}
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
		<p class="mt-2 text-center text-sm text-neutral-400">Stay tuned for more.</p>
	{/if}

	<footer class="mt-10 border-t border-neutral-900 pt-6 text-center text-xs text-neutral-500">
		© 2025 S.L.O.P. Industries. All rights reserved.
	</footer>
</main>

{#if modalOpen && activeVideo}
	<div class="fixed inset-0 z-50 p-3">
		<button
			type="button"
			class="absolute inset-0 bg-black/85"
			aria-label="Close video"
			onclick={closeModal}
		></button>

		<div
			class="relative mx-auto flex h-full max-w-6xl items-center justify-center"
			onclick={(e) => {
				if (e.target === e.currentTarget) closeModal();
			}}
		>
			<div
				class="relative w-full"
				role="dialog"
				aria-modal="true"
				aria-label="Video player"
				tabindex="-1"
				onpointerdown={onSwipeStart}
				onpointerup={onSwipeEnd}
				style="touch-action: pan-y;"
			>
				<div class="pointer-events-none absolute left-[-9999px] top-0 h-1 w-1 overflow-hidden opacity-0">
					{#if prefetchPrevUrl}
						<video
							preload="auto"
							playsinline
							muted
							src={prefetchPrevUrl}
							bind:this={prefetchPrevEl}
						></video>
					{/if}
					{#if prefetchNextUrl}
						<video
							preload="auto"
							playsinline
							muted
							src={prefetchNextUrl}
							bind:this={prefetchNextEl}
						></video>
					{/if}
				</div>

				<div class="absolute left-2 top-2 z-10 flex items-center gap-2">
					<button
						type="button"
						class="rounded-md bg-neutral-950/70 px-3 py-1.5 text-sm text-neutral-50 ring-1 ring-neutral-700/60"
						onclick={() => void copyVideoLink()}
					>
						{#if copied}
							Copied
						{:else}
							Copy link
						{/if}
					</button>
					{#if copyError}
						<span class="text-xs text-neutral-300">{copyError}</span>
					{/if}
				</div>
				<button
					type="button"
					class="absolute right-2 top-2 z-10 rounded-md bg-neutral-950/70 px-3 py-1.5 text-sm text-neutral-50 ring-1 ring-neutral-700/60"
					onclick={closeModal}
				>
					Close
				</button>

				<button
					type="button"
					class="absolute left-2 top-1/2 z-10 -translate-y-1/2 inline-flex h-12 w-12 items-center justify-center rounded-lg bg-neutral-950/70 text-lg text-neutral-50 ring-1 ring-neutral-700/60 disabled:opacity-40"
					aria-label="Previous video"
					disabled={activeIndex === null || activeIndex <= 0}
					onclick={() => void goPrev()}
				>
					<svg
						viewBox="0 0 24 24"
						class="h-7 w-7"
						aria-hidden="true"
						focusable="false"
					>
						<path
							d="M15 6L9 12L15 18"
							fill="none"
							stroke="currentColor"
							stroke-width="2.75"
							stroke-linecap="round"
							stroke-linejoin="round"
						/>
					</svg>
				</button>

				<button
					type="button"
					class="absolute right-2 top-1/2 z-10 -translate-y-1/2 inline-flex h-12 w-12 items-center justify-center rounded-lg bg-neutral-950/70 text-lg text-neutral-50 ring-1 ring-neutral-700/60 disabled:opacity-40"
					aria-label="Next video"
					disabled={activeIndex === null || (activeIndex >= videos.length - 1 && !hasMore)}
					onclick={() => void goNext()}
				>
					<svg
						viewBox="0 0 24 24"
						class="h-7 w-7"
						aria-hidden="true"
						focusable="false"
					>
						<path
							d="M9 6L15 12L9 18"
							fill="none"
							stroke="currentColor"
							stroke-width="2.75"
							stroke-linecap="round"
							stroke-linejoin="round"
						/>
					</svg>
				</button>

				<div class="max-h-[85vh] w-full overflow-hidden rounded-lg bg-black ring-1 ring-neutral-800">
					{#if incomingVideo}
						<div
							class="flex transition-transform duration-300 ease-out"
							style={slideDir === 1
								? `transform: ${slideRunning ? 'translateX(-100%)' : 'translateX(0)'}`
								: `transform: ${slideRunning ? 'translateX(0)' : 'translateX(-100%)'}`}
						>
							{#if slideDir === 1}
								<div class="w-full shrink-0">
									<video
										class="max-h-[85vh] w-full object-contain"
										src={activeVideo.videoUrl}
										preload="auto"
										controls
										autoplay
										playsinline
										onended={onModalEnded}
										bind:this={modalVideoEl}
									>
										<track kind="captions" src="/captions/placeholder.vtt" />
									</video>
								</div>
								<div class="w-full shrink-0">
									<video
										class="max-h-[85vh] w-full object-contain"
										src={incomingVideo.videoUrl}
										preload="auto"
										controls
										autoplay
										playsinline
										muted
									>
										<track kind="captions" src="/captions/placeholder.vtt" />
									</video>
								</div>
							{:else}
								<div class="w-full shrink-0">
									<video
										class="max-h-[85vh] w-full object-contain"
										src={incomingVideo.videoUrl}
										preload="auto"
										controls
										autoplay
										playsinline
										muted
									>
										<track kind="captions" src="/captions/placeholder.vtt" />
									</video>
								</div>
								<div class="w-full shrink-0">
									<video
										class="max-h-[85vh] w-full object-contain"
										src={activeVideo.videoUrl}
										preload="auto"
										controls
										autoplay
										playsinline
										onended={onModalEnded}
										bind:this={modalVideoEl}
									>
										<track kind="captions" src="/captions/placeholder.vtt" />
									</video>
								</div>
							{/if}
						</div>
					{:else}
						<video
							class="max-h-[85vh] w-full object-contain"
							src={activeVideo.videoUrl}
							preload="auto"
							controls
							autoplay
							playsinline
							onended={onModalEnded}
							bind:this={modalVideoEl}
						>
							<track kind="captions" src="/captions/placeholder.vtt" />
						</video>
					{/if}
				</div>
			</div>
		</div>
	</div>
{/if}
