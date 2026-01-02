<script lang="ts">
	import { onDestroy, onMount, tick } from 'svelte';
	import { replaceState } from '$app/navigation';

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

	type VideoInfo = {
		id: string;
		tags: string[];
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
	let modalVideoAEl = $state<HTMLVideoElement | null>(null);
	let modalVideoBEl = $state<HTMLVideoElement | null>(null);
	let modalVideoASrc = $state<string>('');
	let modalVideoBSrc = $state<string>('');
	let modalCurrentSlot = $state<'a' | 'b'>('a');
	let modalControls = $state(true);
	let modalMuted = $state(true);
	let showTapToUnmuteOverlay = $state(false);
	let suppressVolumeSync = $state(false);
	let allowHoverUnmute = $state(false);
	let preferSoundOnTap = $state(false);
	let hasUserInteracted = $state(false);

	let slideDir = $state<1 | -1>(1);
	let sliding = $state(false);
	let slideRunning = $state(false);
	let swipeStart = $state<{ x: number; y: number; t: number } | null>(null);

	let prefetchPrevUrl = $state<string | null>(null);
	let prefetchNextUrl = $state<string | null>(null);
	let prefetchPrevEl = $state<HTMLVideoElement | null>(null);
	let prefetchNextEl = $state<HTMLVideoElement | null>(null);

	let copied = $state(false);
	let copyError = $state<string | null>(null);
	let hasHandledDeepLink = $state(false);

	let videoInfo = $state<VideoInfo | null>(null);
	let videoInfoLoading = $state(false);
	let videoInfoError = $state<string | null>(null);
	let tagDraft = $state('');
	let tagSaving = $state(false);
	let deletingVideo = $state(false);
	let videoInfoFetchSeq = 0;

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

	const recordVideoPlay = (videoId: string) => {
		// Best-effort analytics: never block playback.
		void fetch('/api/video-hit', {
			method: 'POST',
			headers: {
				'content-type': 'application/json'
			},
			body: JSON.stringify({ videoId }),
			keepalive: true
		}).catch(() => {
			// ignore
		});
	};

	let lastRecordedPlay = $state<{ videoId: string; at: number } | null>(null);

	const onModalPlay = () => {
		if (!activeVideo) return;
		const videoId = keyToSlug(activeVideo.id);
		const now = Date.now();
		// Some browsers can emit multiple 'play' events during initial autoplay/fallback.
		if (
			lastRecordedPlay &&
			lastRecordedPlay.videoId === videoId &&
			now - lastRecordedPlay.at < 2000
		)
			return;
		lastRecordedPlay = { videoId, at: now };
		recordVideoPlay(videoId);
	};

	const openModal = async (
		video: VideoItem,
		previewEl?: HTMLVideoElement | null,
		index?: number | null,
		preferSound?: boolean
	) => {
		// Mobile browsers can fire mouseenter/mouseleave semantics on tap.
		// Force the thumbnail preview muted/paused so it can't keep audio playing under the modal.
		if (previewEl) {
			previewEl.muted = true;
			previewEl.pause();
		}

		activeVideo = video;
		activeIndex = typeof index === 'number' ? index : videos.findIndex((v) => v.id === video.id);
		// Opens from an explicit user gesture (thumbnail click/tap) can start with sound.
		// Deep links (no user gesture) should stay muted for autoplay compatibility.
		modalMuted = preferSound ? false : true;
		showTapToUnmuteOverlay = preferSound ? false : true;
		modalControls = true;
		modalCurrentSlot = 'a';
		sliding = false;
		slideRunning = false;
		modalOpen = true;
		if (typeof document !== 'undefined') document.documentElement.style.overflow = 'hidden';

		// Set sources first, then wait for DOM to update before load()/play().
		suppressVolumeSync = true;
		modalVideoASrc = video.videoUrl;
		modalVideoBSrc = '';
		await tick();
		const el = modalVideoAEl;
		if (!el) {
			suppressVolumeSync = false;
			return;
		}

		el.muted = modalMuted;
		if (!modalMuted) el.volume = 1;
		el.load();
		// Prefer to start playing immediately (user gesture).
		try {
			await el.play();
		} catch {
			// If the browser blocks unmuted autoplay, fall back to muted playback.
			if (!modalMuted) {
				modalMuted = true;
				el.muted = true;
				el.load();
				await el.play().catch(() => {
					// User can press play.
				});
			}
		}
		suppressVolumeSync = false;
		modalVideoEl = el;
	};

	const FULLRES_PREFIX = '_full/';
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
		replaceState(`${u.pathname}${u.search}${u.hash}`, {});
	};

	const openModalBySlug = async (slug: string) => {
		const key = normalizeVideoSlug(slug);
		// Try to find in already-loaded results; if not present, fetch additional pages until found.
		// Note: there may be concurrent background loading (infinite scroll fill). Avoid spinning.
		const deadline = Date.now() + 12_000;
		while (Date.now() < deadline) {
			const idx = videos.findIndex((v) => v.id === key);
			if (idx !== -1) {
				modalMuted = true;
				showTapToUnmuteOverlay = true;
				await openModal(videos[idx], null, idx, false);
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
		modalOpen = false;
		activeVideo = null;
		activeIndex = null;
		sliding = false;
		slideRunning = false;
		showTapToUnmuteOverlay = false;
		modalControls = true;
		copied = false;
		copyError = null;
		videoInfo = null;
		videoInfoLoading = false;
		videoInfoError = null;
		tagDraft = '';
		tagSaving = false;
		deletingVideo = false;
		setDeepLinkSlug(null);
		if (typeof document !== 'undefined') document.documentElement.style.overflow = '';
	};

	const normalizeTag = (value: string) => value.trim();

	const uniqTags = (tags: string[]) => {
		const seen = new Set<string>();
		const out: string[] = [];
		for (const t of tags) {
			const n = normalizeTag(t);
			if (!n) continue;
			if (seen.has(n)) continue;
			seen.add(n);
			out.push(n);
		}
		return out;
	};

	const getActiveVideoId = () => {
		if (!activeVideo) return null;
		return keyToSlug(activeVideo.id);
	};

	const fetchVideoInfo = async (videoId: string, seq: number) => {
		videoInfoLoading = true;
		videoInfoError = null;
		try {
			const res = await fetch(`/api/video/${encodeURIComponent(videoId)}`);
			if (!res.ok) throw new Error(`Failed to load tags (${res.status})`);
			const data = (await res.json()) as VideoInfo;
			if (seq !== videoInfoFetchSeq) return;
			videoInfo = {
				id: String(data?.id ?? videoId),
				tags: Array.isArray(data?.tags) ? data.tags.filter((t) => typeof t === 'string') : []
			};
		} catch (e) {
			if (seq !== videoInfoFetchSeq) return;
			videoInfoError = e instanceof Error ? e.message : 'Failed to load tags';
			videoInfo = { id: videoId, tags: [] };
		} finally {
			if (seq !== videoInfoFetchSeq) return;
			videoInfoLoading = false;
		}
	};

	$effect(() => {
		if (!modalOpen || !activeVideo) {
			videoInfo = null;
			videoInfoLoading = false;
			videoInfoError = null;
			tagDraft = '';
			return;
		}

		const videoId = getActiveVideoId();
		if (!videoId) return;

		videoInfoFetchSeq += 1;
		const seq = videoInfoFetchSeq;
		void fetchVideoInfo(videoId, seq);
	});

	const saveTags = async (nextTags: string[]) => {
		const videoId = getActiveVideoId();
		if (!videoId) return;

		const prev = videoInfo?.tags ?? [];
		videoInfo = { id: videoId, tags: nextTags };
		tagSaving = true;
		videoInfoError = null;
		try {
			const res = await fetch(`/api/video/${encodeURIComponent(videoId)}`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ tags: nextTags })
			});
			if (!res.ok) throw new Error(`Failed to save tags (${res.status}): ${await res.text()}`);
			const updated = (await res.json()) as VideoInfo;
			videoInfo = {
				id: String(updated?.id ?? videoId),
				tags: Array.isArray(updated?.tags)
					? updated.tags.filter((t) => typeof t === 'string')
					: nextTags
			};
		} catch (e) {
			videoInfoError = e instanceof Error ? e.message : 'Failed to save tags';
			videoInfo = { id: videoId, tags: prev };
		} finally {
			tagSaving = false;
		}
	};

	const addTag = async () => {
		const draft = normalizeTag(tagDraft);
		if (!draft) return;
		const current = videoInfo?.tags ?? [];
		const next = uniqTags([...current, draft]);
		tagDraft = '';
		await saveTags(next);
	};

	const deleteTag = async (tag: string) => {
		const current = videoInfo?.tags ?? [];
		const next = current.filter((t) => t !== tag);
		await saveTags(next);
	};

	const deleteVideo = async () => {
		const videoId = getActiveVideoId();
		if (!videoId) return;
		if (typeof window !== 'undefined') {
			const ok = window.confirm('Delete this video? This cannot be undone.');
			if (!ok) return;
		}
		deletingVideo = true;
		videoInfoError = null;
		try {
			const res = await fetch(`/api/video/${encodeURIComponent(videoId)}`, { method: 'DELETE' });
			if (!res.ok) throw new Error(`Failed to delete video (${res.status})`);

			// Remove from the local list so it's gone after closing the modal.
			videos = videos.filter((v) => keyToSlug(v.id) !== videoId);

			// If the modal is still open, close it.
			closeModal();
			// Clear deep-link state.
			hasHandledDeepLink = false;
			// If we deleted the deep-linked item, also clear any existing query param.
			if (typeof window !== 'undefined') {
				const u = new URL(window.location.href);
				u.searchParams.delete('v');
				replaceState(`${u.pathname}${u.search}${u.hash}`, {});
			}
		} catch (e) {
			videoInfoError = e instanceof Error ? e.message : 'Failed to delete video';
		} finally {
			deletingVideo = false;
		}
	};

	const dismissTapToUnmute = async () => {
		showTapToUnmuteOverlay = false;
		modalMuted = false;
		const el = modalVideoEl;
		if (!el) return;
		suppressVolumeSync = true;
		el.muted = false;
		el.volume = 1;
		try {
			await el.play();
		} catch {
			// If unmuted play is blocked, user can hit play in controls.
		}
		suppressVolumeSync = false;
	};

	const onModalVolumeChange = (e: Event) => {
		if (suppressVolumeSync) return;
		const target = e.currentTarget as HTMLVideoElement;
		if (target !== modalVideoEl) return;
		modalMuted = target.muted;
	};

	const onModalEnded = (e: Event) => {
		if (!modalOpen) return;
		if (sliding) return;
		const target = e.currentTarget as HTMLVideoElement;
		if (target !== modalVideoEl) return;
		// When the next video autoplays, don't pop the native controls back up.
		modalControls = false;
		void goNext();
	};

	const panelTransform = (slot: 'a' | 'b') => {
		const outgoing = modalCurrentSlot;
		const incoming = outgoing === 'a' ? 'b' : 'a';

		if (!sliding) {
			return slot === outgoing ? 'translateX(0)' : 'translateX(100%)';
		}

		if (!slideRunning) {
			if (slot === outgoing) return 'translateX(0)';
			return slideDir === 1 ? 'translateX(100%)' : 'translateX(-100%)';
		}

		if (slot === outgoing) return slideDir === 1 ? 'translateX(-100%)' : 'translateX(100%)';
		return 'translateX(0)';
	};

	$effect(() => {
		// Keep a reference to the currently active modal video element.
		if (!modalOpen) return;
		modalVideoEl = modalCurrentSlot === 'a' ? modalVideoAEl : modalVideoBEl;
	});

	const canGoPrev = () => activeIndex !== null && activeIndex > 0;
	const canGoNext = () => activeIndex !== null && activeIndex < videos.length - 1;

	const startSlideTo = async (nextVideo: VideoItem, nextIndex: number, dir: 1 | -1) => {
		if (!modalOpen) return;
		if (sliding) return;
		modalVideoEl?.pause();
		if (!modalVideoAEl || !modalVideoBEl) return;

		slideDir = dir;
		sliding = true;
		slideRunning = false;

		const outgoingSlot = modalCurrentSlot;
		const incomingSlot = outgoingSlot === 'a' ? 'b' : 'a';
		const incomingEl = incomingSlot === 'a' ? modalVideoAEl : modalVideoBEl;
		const outgoingEl = outgoingSlot === 'a' ? modalVideoAEl : modalVideoBEl;

		if (incomingSlot === 'a') modalVideoASrc = nextVideo.videoUrl;
		else modalVideoBSrc = nextVideo.videoUrl;
		await tick();

		incomingEl.muted = modalMuted;
		if (!modalMuted) incomingEl.volume = 1;
		// Start the incoming playback immediately inside the user gesture.
		incomingEl.load();
		await incomingEl.play().catch(() => {
			// If unmuted playback is blocked, fall back to muted.
			if (!modalMuted) {
				modalMuted = true;
				incomingEl.muted = true;
				incomingEl.load();
				void incomingEl.play().catch(() => {
					// User can press play.
				});
			}
		});

		// Kick the transition on the next frame so transforms animate.
		requestAnimationFrame(() => {
			slideRunning = true;
		});

		// After the slide completes, make the incoming video the active one.
		setTimeout(async () => {
			activeVideo = nextVideo;
			activeIndex = nextIndex;
			modalCurrentSlot = incomingSlot;
			modalVideoEl = incomingEl;
			outgoingEl.pause();
			// Clear the now-offscreen slot's src so it doesn't keep buffering.
			if (outgoingSlot === 'a') modalVideoASrc = '';
			else modalVideoBSrc = '';
			slideRunning = false;
			sliding = false;
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
		// Many browsers treat hover as *not* a user gesture.
		// Avoid trying to unmute until we've had a real user interaction,
		// otherwise Chrome logs "Unmuting failed ..." and may pause the element.
		if (!hasUserInteracted) return;
		el.muted = false;
		el.volume = 1;
		void el.play().catch(() => {
			// If unmuted play fails, keep it muted (no console spam).
			el.muted = true;
		});
	};

	const handlePreviewLeave = (el: HTMLVideoElement) => {
		el.muted = true;
	};

	const onWindowKeydown = (e: KeyboardEvent) => {
		hasUserInteracted = true;
		if (!modalOpen) return;
		if (e.key === 'Escape') closeModal();
		if (e.key === 'ArrowLeft') void goPrev();
		if (e.key === 'ArrowRight') void goNext();
	};

	let lastWheelNavAt = 0;
	const onWindowWheel = (e: WheelEvent) => {
		if (!modalOpen) return;
		// Ignore wheel events while a transition is in progress.
		if (sliding || slideRunning) return;
		// Trackpads can emit many small wheel events; throttle to one nav per gesture.
		const now = Date.now();
		if (now - lastWheelNavAt < 350) return;

		const dy = e.deltaY;
		if (!Number.isFinite(dy) || Math.abs(dy) < 20) return;

		lastWheelNavAt = now;
		hasUserInteracted = true;
		if (dy > 0) void goNext();
		else void goPrev();
	};

	const onWindowPointerDown = () => {
		hasUserInteracted = true;
	};

	const onWindowTouchStart = () => {
		hasUserInteracted = true;
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

	onMount(async () => {
		allowHoverUnmute =
			typeof window !== 'undefined' &&
			!!window.matchMedia &&
			window.matchMedia('(hover: hover) and (pointer: fine)').matches;
		preferSoundOnTap =
			typeof window !== 'undefined' &&
			!!window.matchMedia &&
			window.matchMedia('(pointer: coarse)').matches;

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

<svelte:window
	onkeydown={onWindowKeydown}
	onwheel={onWindowWheel}
	onpointerdown={onWindowPointerDown}
	ontouchstart={onWindowTouchStart}
/>

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
				<h1 class="text-xl font-semibold tracking-tight text-neutral-50">
					All slop. All the time.
				</h1>
			</div>
		</div>
		<p class="text-sm text-neutral-400 sm:self-end sm:text-right">
			Hover to unmute - click to fullscreen
		</p>
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
					// This is an explicit user gesture; try to start the modal with sound.
					void openModal(video, previewEl, i, true);
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
		<div
			class="mt-4 rounded-lg border border-neutral-800 bg-neutral-950/60 p-3 text-sm text-neutral-200"
		>
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

	<footer class="mt-10 border-t border-neutral-800 pt-6 text-center text-xs text-neutral-400">
		<span class="tracking-wide">
			© 2026
			<span
				class="bg-gradient-to-r from-lime-400 to-emerald-400 bg-clip-text font-semibold text-transparent"
				><a class="transition-colors hover:text-lime-400" href="https://psyslop.tv">PsySlop.TV</a
				></span
			>, a subsidiary of
			<span
				class="bg-gradient-to-r from-lime-400 to-emerald-400 bg-clip-text font-semibold text-transparent"
				><a class="transition-colors hover:text-lime-400" href="https://slopindustries.com"
					>S.L.O.P. Industries</a
				></span
			>
		</span>
		<br />
		<a
			class="mt-2 inline-block text-neutral-400 transition-colors hover:text-emerald-400"
			href="mailto:compliance@psyslop.tv">compliance@psyslop.tv</a
		>
	</footer>
</main>

<div
	class={`fixed inset-0 z-50 p-3 transition-opacity duration-150 ${modalOpen && activeVideo ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'}`}
	aria-hidden={!(modalOpen && activeVideo)}
>
	<button
		type="button"
		class="absolute inset-0 bg-black/85"
		aria-label="Close video"
		onclick={closeModal}
	></button>

	<div class="relative mx-auto flex h-full max-w-6xl items-center justify-center">
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
			<div
				class="pointer-events-none absolute top-0 left-[-9999px] h-1 w-1 overflow-hidden opacity-0"
			>
				{#if prefetchPrevUrl}
					<video preload="auto" playsinline muted src={prefetchPrevUrl} bind:this={prefetchPrevEl}
					></video>
				{/if}
				{#if prefetchNextUrl}
					<video preload="auto" playsinline muted src={prefetchNextUrl} bind:this={prefetchNextEl}
					></video>
				{/if}
			</div>

			<div class="absolute top-2 left-2 z-10 flex items-center gap-2">
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
				class="absolute top-2 right-2 z-10 rounded-md bg-neutral-950/70 px-3 py-1.5 text-sm text-neutral-50 ring-1 ring-neutral-700/60"
				onclick={closeModal}
			>
				Close
			</button>

			<button
				type="button"
				class="absolute top-1/2 left-2 z-10 inline-flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-lg bg-neutral-950/70 text-lg text-neutral-50 ring-1 ring-neutral-700/60 disabled:opacity-40"
				aria-label="Previous video"
				disabled={activeIndex === null || activeIndex <= 0}
				onclick={() => void goPrev()}
			>
				<svg viewBox="0 0 24 24" class="h-7 w-7" aria-hidden="true" focusable="false">
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
				class="absolute top-1/2 right-2 z-10 inline-flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-lg bg-neutral-950/70 text-lg text-neutral-50 ring-1 ring-neutral-700/60 disabled:opacity-40"
				aria-label="Next video"
				disabled={activeIndex === null || (activeIndex >= videos.length - 1 && !hasMore)}
				onclick={() => void goNext()}
			>
				<svg viewBox="0 0 24 24" class="h-7 w-7" aria-hidden="true" focusable="false">
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

			<div
				class="relative h-[85vh] w-full overflow-hidden rounded-lg bg-black ring-1 ring-neutral-800"
			>
				{#if showTapToUnmuteOverlay && modalMuted}
					<button
						type="button"
						class="absolute inset-0 z-20 flex items-center justify-center bg-black/40 px-6 text-center text-xl font-semibold text-neutral-50 sm:text-2xl"
						aria-label="Tap to unmute"
						onclick={(e) => {
							e.stopPropagation();
							void dismissTapToUnmute();
						}}
					>
						Tap to unmute!
					</button>
				{/if}

				<div
					class="absolute inset-0 transition-transform duration-300 ease-out"
					style={`transform: ${panelTransform('a')};`}
				>
					<video
						class="h-full w-full object-contain"
						src={modalVideoASrc}
						preload="auto"
						controls={modalControls && modalCurrentSlot === 'a'}
						playsinline
						muted={modalMuted}
						onplay={onModalPlay}
						onvolumechange={onModalVolumeChange}
						onended={onModalEnded}
						onpointerdown={(e) => {
							// Make the native controls appear immediately on the first tap/click.
							(e.currentTarget as HTMLVideoElement).controls = true;
							modalControls = true;
						}}
						bind:this={modalVideoAEl}
						style="width: 100%;"
					>
						<track kind="captions" src="/captions/placeholder.vtt" />
					</video>
				</div>

				<div
					class="absolute inset-0 transition-transform duration-300 ease-out"
					style={`transform: ${panelTransform('b')};`}
				>
					<video
						class="h-full w-full object-contain"
						src={modalVideoBSrc}
						preload="auto"
						controls={modalControls && modalCurrentSlot === 'b'}
						playsinline
						muted={modalMuted}
						onplay={onModalPlay}
						onvolumechange={onModalVolumeChange}
						onended={onModalEnded}
						onpointerdown={(e) => {
							// Make the native controls appear immediately on the first tap/click.
							(e.currentTarget as HTMLVideoElement).controls = true;
							modalControls = true;
						}}
						bind:this={modalVideoBEl}
						style="width: 100%;"
					>
						<track kind="captions" src="/captions/placeholder.vtt" />
					</video>
				</div>

				<div
					class="absolute right-0 bottom-0 left-0 z-30 border-t border-neutral-800 bg-neutral-950/80 p-2"
				>
					<div class="flex items-center gap-2">
						<div class="min-w-0 flex-1">
							<div class="flex flex-wrap items-center gap-2">
								{#if videoInfoLoading}
									<span class="text-xs text-neutral-300">Loading tags…</span>
								{:else}
									{#each (videoInfo?.tags ?? []) as tag (tag)}
										<span
											class="group relative inline-flex items-center gap-1 rounded-full bg-neutral-900 px-2.5 py-1 text-xs text-neutral-100 ring-1 ring-neutral-800"
										>
											<span class="max-w-[11rem] truncate">{tag}</span>
											<button
												type="button"
												class="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full text-neutral-300 opacity-0 transition group-hover:opacity-100 hover:text-neutral-50"
												aria-label={`Remove tag ${tag}`}
												disabled={tagSaving || deletingVideo}
												onclick={() => void deleteTag(tag)}
											>
												×
											</button>
										</span>
									{/each}
									<input
										type="text"
										placeholder="Add tag"
										class="min-w-[10rem] flex-1 rounded-md bg-neutral-900 px-2.5 py-1 text-xs text-neutral-50 ring-1 ring-neutral-800 placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-neutral-200/30"
										bind:value={tagDraft}
										disabled={tagSaving || deletingVideo}
										onkeydown={(e) => {
											if (e.key === 'Enter') {
												e.preventDefault();
												void addTag();
											}
										}}
									/>
								{/if}
							</div>
							{#if videoInfoError}
								<p class="mt-1 text-xs text-neutral-300">{videoInfoError}</p>
							{/if}
						</div>

						<button
							type="button"
							class="shrink-0 rounded-md bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-900 disabled:opacity-60"
							disabled={deletingVideo}
							onclick={() => void deleteVideo()}
						>
							{#if deletingVideo}
								Deleting…
							{:else}
								Delete Video
							{/if}
						</button>
					</div>
				</div>
			</div>
		</div>
	</div>
</div>
