window.__ModuleLoader__.load({
	id: "dsh-dpet",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_dom_client = require("react-dom/client");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/api/dpet.ts
		const API = "/api/dpet";
		async function json(response) {
			const body = await response.json().catch(() => ({
				ok: false,
				error: "network"
			}));
			if (!response.ok && body.error === void 0) throw new Error("http-" + response.status);
			return body;
		}
		async function post(path, body, contentType) {
			return json(await fetch(API + path, {
				method: "POST",
				headers: { "content-type": contentType },
				body
			}));
		}
		const api = {
			state: async () => json(await fetch(API + "/state")),
			pets: async () => json(await fetch(API + "/pets")),
			updateSettings: (patch) => post("/settings", JSON.stringify(patch), "application/json"),
			/** Process a picture like an import would and return the result without creating a pet. */
			previewImport: async (file) => {
				try {
					const response = await fetch(API + "/import/preview", {
						method: "POST",
						headers: { "content-type": "application/octet-stream" },
						body: file
					});
					if (!response.ok) return {
						ok: false,
						error: (await response.json().catch(() => ({ error: "network" }))).error ?? "network"
					};
					const report = JSON.parse(response.headers.get("x-dpet-report") ?? "{}");
					return {
						ok: true,
						image: await response.blob(),
						report
					};
				} catch {
					return {
						ok: false,
						error: "network"
					};
				}
			},
			/** Upload through XHR so large models can report upload progress (0..1). */
			importFile: (file, name, background, onProgress) => new Promise((resolve) => {
				const xhr = new XMLHttpRequest();
				xhr.open("POST", API + "/import?name=" + encodeURIComponent(name) + "&background=" + background);
				xhr.setRequestHeader("content-type", "application/octet-stream");
				xhr.upload.onprogress = (e) => {
					if (e.lengthComputable) onProgress?.(e.loaded / e.total);
				};
				xhr.onload = () => {
					try {
						resolve(JSON.parse(xhr.responseText));
					} catch {
						resolve({
							ok: false,
							error: "network"
						});
					}
				};
				xhr.onerror = () => resolve({
					ok: false,
					error: "network"
				});
				xhr.send(file);
			}),
			rename: (id, name) => post("/pet/" + encodeURIComponent(id) + "/rename", JSON.stringify({ name }), "application/json"),
			setPreview: (id, png) => post("/pet/" + encodeURIComponent(id) + "/preview", png, "image/png"),
			remove: (id) => post("/pet/" + encodeURIComponent(id) + "/delete", "{}", "application/json")
		};
		//#endregion
		//#region src/client/store/dpet.ts
		/**
		* Client store — polls the host state while the tab is visible and holds the
		* pet list. Settings edits apply locally at once (sliders stay smooth) and
		* reach the host through one debounced write.
		* @module dsh-dpet/client/store/dpet
		*/
		/** Poll interval for the host snapshot. */
		const POLL_MS = 1e3;
		/** Settings writes are coalesced over this window. */
		const SAVE_DELAY_MS = 300;
		function createDpetStore() {
			let snapshot = {};
			const listeners = /* @__PURE__ */ new Set();
			let timer;
			let seq = 0;
			let pending = {};
			let saveTimer;
			let saving = Promise.resolve();
			const publish = (next) => {
				snapshot = next;
				for (const listener of [...listeners]) listener();
			};
			/** Local edits not yet confirmed by the host win over polled values. */
			const withPending = (state) => {
				if (Object.keys(pending).length === 0) return state;
				return {
					...state,
					settings: {
						...state.settings,
						...pending
					}
				};
			};
			const refresh = () => {
				const mine = ++seq;
				api.state().then((state) => {
					if (mine !== seq || state.settings === void 0) return;
					const petChanged = snapshot.state?.pet.id !== state.pet.id;
					publish({
						...snapshot,
						state: withPending(state)
					});
					if (petChanged || snapshot.pets === void 0) refreshPets();
				}, () => {});
			};
			const refreshPets = async () => {
				try {
					const pets = await api.pets();
					if (Array.isArray(pets)) publish({
						...snapshot,
						pets
					});
				} catch {}
			};
			const flush = () => {
				saveTimer = void 0;
				const patch = pending;
				saving = saving.then(async () => {
					try {
						await api.updateSettings(patch);
					} catch {}
					for (const key of Object.keys(patch)) if (pending[key] === patch[key]) delete pending[key];
					refresh();
				});
			};
			const onVisibility = () => {
				if (document.visibilityState === "visible") {
					refresh();
					if (timer === void 0) timer = window.setInterval(refresh, POLL_MS);
				} else if (timer !== void 0) {
					window.clearInterval(timer);
					timer = void 0;
				}
			};
			return {
				getSnapshot: () => snapshot,
				subscribe(listener) {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				refresh,
				refreshPets,
				patchSettings(patch) {
					pending = {
						...pending,
						...patch
					};
					if (snapshot.state !== void 0) {
						const pet = patch.petId === void 0 ? snapshot.state.pet : snapshot.pets?.find((p) => p.id === patch.petId) ?? snapshot.state.pet;
						publish({
							...snapshot,
							state: {
								...snapshot.state,
								pet,
								settings: {
									...snapshot.state.settings,
									...patch
								}
							}
						});
					}
					if (saveTimer !== void 0) window.clearTimeout(saveTimer);
					saveTimer = window.setTimeout(flush, SAVE_DELAY_MS);
				},
				start() {
					document.addEventListener("visibilitychange", onVisibility);
					onVisibility();
					refreshPets();
				},
				stop() {
					document.removeEventListener("visibilitychange", onVisibility);
					if (timer !== void 0) window.clearInterval(timer);
					timer = void 0;
					if (saveTimer !== void 0) {
						window.clearTimeout(saveTimer);
						flush();
					}
				}
			};
		}
		/** React binding. */
		function useDpet(store) {
			return (0, react.useSyncExternalStore)(store.subscribe, store.getSnapshot, store.getSnapshot);
		}
		//#endregion
		//#region src/client/utils/composer.ts
		/**
		* Inject only into an empty input, or one that still holds exactly what we
		* injected last time. Anything else is the user's unsent edit.
		*/
		function decideInjection(currentDraft, lastInjected) {
			const draft = typeof currentDraft === "string" ? currentDraft : "";
			if (draft.trim() === "") return "inject";
			if (lastInjected !== void 0 && draft === lastInjected) return "inject";
			return "skip";
		}
		/** The session shown in the main view, from a sessions list snapshot. */
		function mainSessionId(snapshot) {
			const byId = snapshot?.byId ?? {};
			return Object.values(byId).find((row) => (row?.retainedBy?.mainView ?? 0) > 0)?.id;
		}
		function readDraft(input) {
			try {
				const draft = (typeof input.snapshot === "function" ? input.snapshot() : input.snapshot)?.draft;
				return typeof draft === "string" ? draft : "";
			} catch {
				return "";
			}
		}
		/**
		* @param getSessions - returns the client sessions service when it is available.
		* @param copy - clipboard writer (injectable for tests).
		*/
		function createComposer(getSessions, copy = (text) => navigator.clipboard.writeText(text)) {
			let lastInjected;
			const fallback = async (text) => {
				try {
					await copy(text);
					return "clipboard";
				} catch {
					return "failed";
				}
			};
			return async (text) => {
				try {
					const sessions = getSessions();
					const id = mainSessionId(sessions?.list?.getSnapshot?.());
					if (sessions?.scope === void 0 || id === void 0) return fallback(text);
					const scoped = sessions.scope(id);
					const input = scoped.get("conversation")?.input?.for(scoped);
					if (input === void 0) return fallback(text);
					if (decideInjection(readDraft(input), lastInjected) === "skip") return "skipped";
					input.setDraft(text);
					lastInjected = text;
					input.focus?.();
					return "injected";
				} catch {
					return fallback(text);
				}
			};
		}
		//#endregion
		//#region src/shared/types.ts
		/** Every activity phase, in display order. */
		const ACTIVITY_PHASES = [
			"idle",
			"waiting",
			"thinking",
			"tool",
			"review",
			"done",
			"failed"
		];
		/** Every motion, in display order. */
		const PET_MOTIONS = [
			"bob",
			"sway",
			"spin",
			"hop",
			"nod",
			"cheer",
			"droop",
			"still"
		];
		/** Bounds for numeric settings. */
		const SETTINGS_LIMITS = {
			size: {
				min: 80,
				max: 480
			},
			inset: {
				min: 0,
				max: 4e3
			},
			opacity: {
				min: .3,
				max: 1
			}
		};
		//#endregion
		//#region src/client/engine/phase-stream.ts
		/** Create a stream. */
		function createPhaseStream(initial = "idle") {
			let current = initial;
			const listeners = /* @__PURE__ */ new Set();
			return {
				get: () => current,
				subscribe(listener) {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				push(phase) {
					if (phase === current) return;
					current = phase;
					for (const listener of [...listeners]) listener(phase);
				}
			};
		}
		/** Largest perspective tilt a turn produces, radians (about 14 degrees). */
		const TILT_MAX = 14 * Math.PI / 180;
		/** Delay of the topmost strip behind the feet, seconds. */
		const FOLLOW_LAG = .12;
		/** Lift (in body heights) at which the shadow is smallest. */
		const SHADOW_LIFT$1 = .2;
		/** Largest sideways shift of the head from bending, in picture heights. */
		const MAX_BEND = .1;
		/** Perspective turn toward the pointer at full look, radians (about 8 degrees). */
		const LOOK_TILT = 8 * Math.PI / 180;
		/** Rigid tip toward the pointer at full look, radians (about 3 degrees). */
		const LOOK_ROLL = 3 * Math.PI / 180;
		const smoothstep = (a, b, x) => {
			const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
			return t * t * (3 - 2 * t);
		};
		/**
		* Lay out one frame.
		* @param poseAt - the motion pose `lag` seconds in the past (0 = now).
		* @param squash - tap squash factors.
		* @param look - where the pointer is, -1 (far left) .. 1 (far right).
		*/
		function jellyFrame(poseAt, squash, look, strips = 40) {
			const base = poseAt(0);
			const lift = Math.max(0, base.y);
			const out = [];
			let ground = lift;
			for (let i = strips - 1; i >= 0; i--) {
				const v0 = i / strips;
				const v1 = (i + 1) / strips;
				const h = 1 - (v0 + v1) / 2;
				const pose = poseAt(FOLLOW_LAG * h);
				const sy = pose.sy * squash.sy;
				const sx = pose.sx * squash.sx;
				const stretch = 1 + (sy - 1) * (.4 + 1.2 * h);
				const bulge = 1 + (sx - 1) * (1.4 - .8 * h);
				const height = stretch * (1 - Math.max(0, pose.pitch) * 1 * smoothstep(.62, 1, h)) / strips;
				const bend = Math.max(-.1, Math.min(MAX_BEND, pose.roll * 1.4)) * Math.pow(h, 1.7);
				out.push({
					v0,
					v1,
					x: bend,
					top: ground + height,
					width: bulge,
					height
				});
				ground += height;
			}
			const lifted = Math.min(1, lift / SHADOW_LIFT$1);
			const facing = Math.max(-1, Math.min(1, look));
			return {
				strips: out.reverse(),
				tilt: Math.max(-TILT_MAX, Math.min(TILT_MAX, TILT_MAX * Math.sin(base.yaw) + LOOK_TILT * facing)),
				roll: LOOK_ROLL * facing,
				shadowScale: 1 - lifted * .45,
				shadowAlpha: 1 - lifted * .6
			};
		}
		//#endregion
		//#region src/client/engine/motion.ts
		/** The rest pose. */
		const REST_POSE = {
			y: 0,
			yaw: 0,
			pitch: 0,
			roll: 0,
			sx: 1,
			sy: 1,
			sz: 1
		};
		/** Built-in phase -> motion mapping; manifests override per phase. */
		const DEFAULT_GLTF_MOTIONS = {
			idle: "bob",
			waiting: "sway",
			thinking: "spin",
			tool: "hop",
			review: "nod",
			done: "cheer",
			failed: "droop"
		};
		/** Duration of the one-shot part of 'cheer' before it settles into 'bob'. */
		const CHEER_SECONDS = 1.1;
		const TAU = Math.PI * 2;
		function easeInOut(p) {
			return p < .5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;
		}
		/** Breathing idle: a slow bob with a matching volume-preserving squash. */
		function bob(t) {
			const breath = Math.sin(TAU * t / 2.4);
			return {
				...REST_POSE,
				y: .012 * breath,
				roll: .03 * Math.sin(TAU * t / 4.8),
				sy: 1 + .012 * breath,
				sx: 1 - .006 * breath,
				sz: 1 - .006 * breath
			};
		}
		/** The pose of one motion at t seconds since the motion started. */
		function motionPose(motion, t) {
			switch (motion) {
				case "still": return { ...REST_POSE };
				case "bob": return bob(t);
				case "sway": return {
					...bob(t),
					yaw: .35 * Math.sin(TAU * t / 4),
					roll: .07 * Math.sin(TAU * t / 2)
				};
				case "spin": return {
					...bob(t),
					yaw: 1.2 * t,
					roll: .06
				};
				case "hop": {
					const p = t / .6 % 1;
					const h = Math.sin(Math.PI * p);
					const land = (1 - h) ** 4;
					return {
						...REST_POSE,
						y: .07 * h,
						sy: 1 + .05 * h - .07 * land,
						sx: 1 + .035 * land,
						sz: 1 + .035 * land
					};
				}
				case "nod": return {
					...bob(t),
					pitch: .12 * Math.max(0, Math.sin(TAU * t / 1.2))
				};
				case "cheer": {
					if (t >= 1.1) return bob(t - CHEER_SECONDS);
					const p = t / CHEER_SECONDS;
					return {
						...REST_POSE,
						y: .18 * Math.sin(Math.PI * p),
						yaw: TAU * easeInOut(p)
					};
				}
				case "droop": {
					const e = Math.min(t / .6, 1);
					return {
						...REST_POSE,
						y: -.02 * e,
						pitch: .15 * e,
						roll: .05 * Math.sin(TAU * t * 3) * Math.exp(-2 * t),
						sy: 1 - .06 * e,
						sx: 1 + .03 * e,
						sz: 1 + .03 * e
					};
				}
			}
		}
		/** Jelly squash-and-stretch layered over the motion after a tap. */
		function tapSquash(tau) {
			if (tau < 0 || tau >= .9) return {
				sx: 1,
				sy: 1
			};
			const s = Math.exp(-5 * tau) * Math.sin(18 * tau);
			return {
				sx: 1 + .1 * s,
				sy: 1 - .15 * s
			};
		}
		/** The motion a phase plays under an optional manifest override map. */
		function motionForPhase(phase, overrides) {
			return overrides?.[phase] ?? DEFAULT_GLTF_MOTIONS[phase];
		}
		//#endregion
		//#region src/client/engine/reduced-motion.ts
		/**
		* The operating system's "reduce motion" accessibility setting. When it is on,
		* both renderers hold the pet still (no hops, spins, squashes or pointer
		* following); the pet still appears and still shows its status bubble.
		* @module dsh-dpet/client/engine/reduced-motion
		*/
		const QUERY = "(prefers-reduced-motion: reduce)";
		/** A live view of the setting; `matches` is cheap to read every frame. */
		function reducedMotionQuery() {
			if (typeof window === "undefined" || typeof window.matchMedia !== "function") return { matches: false };
			return window.matchMedia(QUERY);
		}
		/** Whether reduced motion is requested right now. */
		function prefersReducedMotion() {
			return reducedMotionQuery().matches;
		}
		//#endregion
		//#region src/client/engine/flat.ts
		/** Frame budget, matching the 3D renderer. */
		const FRAME_MS$1 = 1e3 / 30;
		/** Pointer distance (px) at which the look reaches half strength; it saturates smoothly beyond. */
		const LOOK_HALF$1 = 300;
		/** Canvas margins around the pet box, as fractions of the box height. */
		const MARGIN = {
			top: .35,
			side: .3,
			bottom: .1
		};
		/** Resting shadow opacity. */
		const SHADOW_ALPHA$1 = .28;
		/** Mount a 2D pet into a container. */
		function mountFlat(options) {
			const { container, phase } = options;
			let disposed = false;
			let ready = false;
			let readyListener;
			let layoutListener;
			let headTop;
			let errorListener;
			let motions = options.motions;
			let lookAtCursor = options.lookAtCursor ?? true;
			const reduced = reducedMotionQuery();
			let motion = motionForPhase(phase.get(), motions);
			let motionStart = performance.now();
			let tapAt;
			let lookTarget = 0;
			let look = 0;
			const wrap = document.createElement("div");
			Object.assign(wrap.style, {
				position: "relative",
				width: "100%",
				height: "100%",
				pointerEvents: "none"
			});
			const canvas = document.createElement("canvas");
			Object.assign(canvas.style, {
				position: "absolute",
				pointerEvents: "none"
			});
			const img = document.createElement("img");
			img.alt = "";
			img.decoding = "async";
			Object.assign(img.style, {
				position: "absolute",
				width: "1px",
				height: "1px",
				opacity: "0",
				pointerEvents: "none"
			});
			wrap.append(canvas, img);
			container.appendChild(wrap);
			const ctx = canvas.getContext("2d");
			let box = {
				w: 0,
				h: 0
			};
			let pic = {
				w: 0,
				h: 0
			};
			let foot = {
				x: 0,
				y: 0
			};
			let dpr = 1;
			const layout = () => {
				if (!ready) return;
				box = {
					w: Math.max(1, container.clientWidth),
					h: Math.max(1, container.clientHeight)
				};
				const scale = Math.min(box.w / img.naturalWidth, box.h / img.naturalHeight);
				pic = {
					w: img.naturalWidth * scale,
					h: img.naturalHeight * scale
				};
				const top = box.h * MARGIN.top;
				const side = box.h * MARGIN.side;
				const cssW = box.w + side * 2;
				const cssH = box.h + top + box.h * MARGIN.bottom;
				dpr = Math.min(window.devicePixelRatio || 1, 2);
				canvas.width = Math.round(cssW * dpr);
				canvas.height = Math.round(cssH * dpr);
				Object.assign(canvas.style, {
					left: -side + "px",
					top: -top + "px",
					width: cssW + "px",
					height: cssH + "px"
				});
				foot = {
					x: side + box.w / 2,
					y: top + box.h
				};
				canvas.style.transformOrigin = `${foot.x}px ${foot.y}px`;
				const next = Math.max(0, box.h - pic.h);
				if (next !== headTop) {
					headTop = next;
					layoutListener?.(next);
				}
			};
			const observer = typeof ResizeObserver === "undefined" ? void 0 : new ResizeObserver(layout);
			observer?.observe(container);
			const draw = (now) => {
				if (ctx === null || pic.h === 0) return;
				const t = (now - motionStart) / 1e3;
				const still = reduced.matches;
				const frame = jellyFrame((lag) => still ? REST_POSE : motionPose(motion, Math.max(0, t - lag)), still ? {
					sx: 1,
					sy: 1
				} : tapSquash(tapAt === void 0 ? -1 : (now - tapAt) / 1e3), still ? 0 : look);
				ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
				ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
				const rx = pic.w * .34 * frame.shadowScale;
				const ry = Math.max(2, pic.h * .045 * frame.shadowScale);
				const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
				gradient.addColorStop(0, `rgba(0,0,0,${SHADOW_ALPHA$1 * frame.shadowAlpha})`);
				gradient.addColorStop(1, "rgba(0,0,0,0)");
				ctx.save();
				ctx.translate(foot.x, foot.y - ry * .25);
				ctx.scale(rx, ry);
				ctx.fillStyle = gradient;
				ctx.beginPath();
				ctx.arc(0, 0, 1, 0, Math.PI * 2);
				ctx.fill();
				ctx.restore();
				const srcH = img.naturalHeight;
				ctx.save();
				ctx.translate(foot.x, foot.y);
				ctx.rotate(frame.roll);
				ctx.translate(-foot.x, -foot.y);
				for (const strip of frame.strips) {
					const w = pic.w * strip.width;
					const h = pic.h * strip.height;
					const x = foot.x + strip.x * pic.h - w / 2;
					const y = foot.y - strip.top * pic.h;
					ctx.drawImage(img, 0, strip.v0 * srcH, img.naturalWidth, (strip.v1 - strip.v0) * srcH, x, y, w, h + .6);
				}
				ctx.restore();
				canvas.style.transform = frame.tilt === 0 ? "" : `perspective(${Math.round(box.h * 4)}px) rotateY(${frame.tilt.toFixed(4)}rad)`;
			};
			const applyPhase = (next) => {
				motion = motionForPhase(next, motions);
				motionStart = performance.now();
			};
			const unsubscribe = phase.subscribe(applyPhase);
			const onPointerMove = (event) => {
				const rect = container.getBoundingClientRect();
				const dx = event.clientX - (rect.left + rect.width / 2);
				lookTarget = dx / (Math.abs(dx) + LOOK_HALF$1);
			};
			window.addEventListener("pointermove", onPointerMove, { passive: true });
			let frameId = 0;
			let last = 0;
			const tick = (now) => {
				frameId = requestAnimationFrame(tick);
				if (now - last < FRAME_MS$1) return;
				const dt = last === 0 ? 0 : (now - last) / 1e3;
				last = now;
				look += ((lookAtCursor ? lookTarget : 0) - look) * Math.min(1, dt * 4);
				draw(now);
			};
			img.onload = () => {
				if (disposed) return;
				ready = true;
				layout();
				frameId = requestAnimationFrame(tick);
				readyListener?.();
			};
			img.onerror = () => {
				if (!disposed) errorListener?.("load-failed");
			};
			img.src = options.imageUrl;
			return {
				tap() {
					if (!disposed) tapAt = performance.now();
				},
				setMotions(next) {
					motions = next;
					applyPhase(phase.get());
				},
				setLookAtCursor(enabled) {
					lookAtCursor = enabled;
				},
				snapshot: () => void 0,
				onReady(listener) {
					readyListener = listener;
					if (ready) listener();
				},
				onLayout(listener) {
					layoutListener = listener;
					if (headTop !== void 0) listener(headTop);
				},
				onError(listener) {
					errorListener = listener;
				},
				dispose() {
					if (disposed) return;
					disposed = true;
					cancelAnimationFrame(frameId);
					observer?.disconnect();
					unsubscribe();
					window.removeEventListener("pointermove", onPointerMove);
					wrap.remove();
				}
			};
		}
		//#endregion
		//#region src/client/engine/gltf/runtime.ts
		/** Runtime file URL the host serves ('/api/pet/runtime/<name>'). */
		const VENDOR_URL = "/api/dpet/runtime/gltf-vendor.js";
		const defaultInjector = (src) => new Promise((resolve, reject) => {
			const tag = document.createElement("script");
			tag.src = src;
			tag.onload = () => resolve();
			tag.onerror = () => reject(/* @__PURE__ */ new Error("script failed to load: " + src));
			document.head.appendChild(tag);
		});
		let vendorPromise;
		/** Ensure the vendor bundle global exists, injecting the script once when absent. */
		function ensureGltfVendor(probe = {}) {
			if (typeof window !== "undefined" && window.__dshDpetGltf !== void 0) return Promise.resolve(window.__dshDpetGltf);
			if (probe.inject !== void 0) return probe.inject(VENDOR_URL).then(() => typeof window !== "undefined" ? window.__dshDpetGltf : void 0).catch(() => void 0);
			vendorPromise ??= defaultInjector(VENDOR_URL).then(() => typeof window !== "undefined" ? window.__dshDpetGltf : void 0).catch(() => void 0);
			return vendorPromise;
		}
		//#endregion
		//#region src/client/engine/gltf.ts
		/** Frame budget: a desktop pet never needs more than ~30 fps. */
		const FRAME_MS = 1e3 / 30;
		/** Max yaw toward the pointer, in radians. */
		const LOOK_YAW = .35;
		/** Pointer distance (px) at which the look reaches half strength; it saturates smoothly beyond. */
		const LOOK_HALF = 300;
		/** Resting shadow opacity. */
		const SHADOW_ALPHA = .32;
		/** Lift (in model heights) at which the shadow is smallest. */
		const SHADOW_LIFT = .2;
		/** Release GPU resources held by a loaded scene graph. */
		function disposeScene(root) {
			root.traverse((node) => {
				const mesh = node;
				if (mesh.isMesh !== true) return;
				mesh.geometry?.dispose();
				const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
				for (const material of materials) {
					if (material === void 0 || material === null) continue;
					for (const value of Object.values(material)) {
						const texture = value;
						if (texture !== null && typeof texture === "object" && texture.isTexture === true) texture.dispose?.();
					}
					material.dispose();
				}
			});
		}
		/** Mount a 3D pet into a container. */
		function mountGltf(options) {
			const { container, phase } = options;
			let disposed = false;
			let ready = false;
			let readyListener;
			let layoutListener;
			let headTop;
			let errorListener;
			let motions = options.motions;
			let lookAtCursor = options.lookAtCursor ?? true;
			const reduced = reducedMotionQuery();
			let tapAt;
			let motion = motionForPhase(phase.get(), motions);
			let motionStart = performance.now();
			let renderFrame;
			let canvas;
			const teardown = [];
			const destroy = () => {
				for (const fn of teardown.splice(0).reverse()) try {
					fn();
				} catch {}
			};
			const applyPhase = (next) => {
				motion = motionForPhase(next, motions);
				motionStart = performance.now();
			};
			const boot = async () => {
				const vendor = await ensureGltfVendor();
				if (disposed) return;
				if (vendor === void 0) {
					errorListener?.("vendor-missing");
					return;
				}
				const gltf = await new vendor.GLTFLoader().loadAsync(options.modelUrl);
				if (disposed) {
					disposeScene(gltf.scene);
					return;
				}
				teardown.push(() => disposeScene(gltf.scene));
				const box = new vendor.Box3().setFromObject(gltf.scene);
				const size = box.getSize(new vendor.Vector3());
				const center = box.getCenter(new vendor.Vector3());
				const height = Math.max(size.y, 1e-6);
				gltf.scene.position.set(-center.x, -box.min.y, -center.z);
				const pivot = new vendor.Group();
				pivot.add(gltf.scene);
				const scene = new vendor.Scene();
				scene.add(pivot);
				const shadowCanvas = document.createElement("canvas");
				shadowCanvas.width = shadowCanvas.height = 64;
				const sg = shadowCanvas.getContext("2d");
				if (sg !== null) {
					const gradient = sg.createRadialGradient(32, 32, 0, 32, 32, 32);
					gradient.addColorStop(0, "rgba(0,0,0,1)");
					gradient.addColorStop(1, "rgba(0,0,0,0)");
					sg.fillStyle = gradient;
					sg.fillRect(0, 0, 64, 64);
				}
				const shadowTexture = new vendor.CanvasTexture(shadowCanvas);
				const shadowMaterial = new vendor.MeshBasicMaterial({
					map: shadowTexture,
					transparent: true,
					depthWrite: false,
					opacity: SHADOW_ALPHA
				});
				const shadowGeometry = new vendor.PlaneGeometry(1, 1);
				const shadow = new vendor.Mesh(shadowGeometry, shadowMaterial);
				shadow.rotation.x = -Math.PI / 2;
				shadow.position.y = height * .002;
				const footprint = Math.max(size.x, size.z) * .95;
				shadow.scale.set(footprint, footprint * .7, 1);
				shadow.renderOrder = -1;
				scene.add(shadow);
				teardown.push(() => {
					shadowGeometry.dispose();
					shadowMaterial.dispose();
					shadowTexture.dispose();
				});
				scene.add(new vendor.HemisphereLight(16777215, 8947848, 2));
				const key = new vendor.DirectionalLight(16777215, 1.5);
				key.position.set(1, 2, 3);
				scene.add(key);
				const renderer = new vendor.WebGLRenderer({
					antialias: true,
					alpha: true,
					powerPreference: "low-power"
				});
				teardown.push(() => {
					renderer.domElement.remove();
					renderer.dispose();
				});
				renderer.outputColorSpace = vendor.SRGBColorSpace;
				renderer.setClearColor(0, 0);
				renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
				canvas = renderer.domElement;
				canvas.style.display = "block";
				canvas.style.width = "100%";
				canvas.style.height = "100%";
				container.appendChild(canvas);
				const camera = new vendor.PerspectiveCamera(30, 1, .01, 100);
				const layout = () => {
					const width = Math.max(1, Math.round(container.clientWidth || 160));
					const heightPx = Math.max(1, Math.round(container.clientHeight || 180));
					renderer.setSize(width, heightPx, false);
					camera.aspect = width / heightPx;
					const vFov = camera.fov * Math.PI / 180;
					const byHeight = height * 1.3800000000000001 / 2 / Math.tan(vFov / 2);
					const byWidth = Math.max(size.x, size.z) * .6 / (Math.tan(vFov / 2) * camera.aspect);
					const aim = height * 1.22 / 2;
					camera.position.set(0, aim, Math.max(byHeight, byWidth));
					camera.lookAt(0, aim, 0);
					camera.updateProjectionMatrix();
					camera.updateMatrixWorld();
					const top = new vendor.Vector3(0, height, size.z / 2).project(camera);
					headTop = Math.max(0, (1 - top.y) / 2 * heightPx);
					layoutListener?.(headTop);
				};
				layout();
				if (typeof ResizeObserver !== "undefined") {
					const observer = new ResizeObserver(() => layout());
					observer.observe(container);
					teardown.push(() => observer.disconnect());
				}
				applyPhase(phase.get());
				teardown.push(phase.subscribe(applyPhase));
				let lookTarget = 0;
				let look = 0;
				const onPointerMove = (event) => {
					const rect = container.getBoundingClientRect();
					const dx = event.clientX - (rect.left + rect.width / 2);
					lookTarget = dx / (Math.abs(dx) + LOOK_HALF) * LOOK_YAW;
				};
				window.addEventListener("pointermove", onPointerMove, { passive: true });
				teardown.push(() => window.removeEventListener("pointermove", onPointerMove));
				let last = 0;
				const draw = (now, dt) => {
					const still = reduced.matches;
					const pose = still ? REST_POSE : motionPose(motion, (now - motionStart) / 1e3);
					const squash = still ? {
						sx: 1,
						sy: 1
					} : tapSquash(tapAt === void 0 ? -1 : (now - tapAt) / 1e3);
					look += ((lookAtCursor && !still ? lookTarget : 0) - look) * Math.min(1, dt * 4);
					pivot.position.y = pose.y * height;
					pivot.rotation.set(pose.pitch, pose.yaw + look, pose.roll);
					pivot.scale.set(pose.sx * squash.sx, pose.sy * squash.sy, pose.sz * squash.sx);
					const lifted = Math.min(1, Math.max(0, pose.y) / SHADOW_LIFT);
					const shrink = 1 - lifted * .45;
					shadow.scale.set(footprint * shrink, footprint * .7 * shrink, 1);
					shadowMaterial.opacity = SHADOW_ALPHA * (1 - lifted * .6);
					renderer.render(scene, camera);
				};
				renderFrame = () => draw(performance.now(), 0);
				let frame = 0;
				const tick = (now) => {
					frame = requestAnimationFrame(tick);
					if (now - last < FRAME_MS) return;
					const dt = last === 0 ? 0 : (now - last) / 1e3;
					last = now;
					draw(now, dt);
				};
				frame = requestAnimationFrame(tick);
				teardown.push(() => cancelAnimationFrame(frame));
				ready = true;
				readyListener?.();
			};
			boot().catch(() => {
				destroy();
				if (!disposed) errorListener?.("load-failed");
			});
			return {
				tap() {
					if (!disposed) tapAt = performance.now();
				},
				setMotions(next) {
					motions = next;
					applyPhase(phase.get());
				},
				setLookAtCursor(enabled) {
					lookAtCursor = enabled;
				},
				snapshot() {
					if (!ready || renderFrame === void 0 || canvas === void 0) return void 0;
					renderFrame();
					return canvas.toDataURL("image/png");
				},
				onReady(listener) {
					readyListener = listener;
					if (ready) listener();
				},
				onLayout(listener) {
					layoutListener = listener;
					if (headTop !== void 0) listener(headTop);
				},
				onError(listener) {
					errorListener = listener;
				},
				dispose() {
					if (disposed) return;
					disposed = true;
					destroy();
				}
			};
		}
		//#endregion
		//#region src/client/i18n/index.ts
		/**
		* UI copy (zh / en), picked by the document language at call time. The pet
		* lives on a global floating surface and a settings page, and resolves its
		* copy the same small way on both.
		* @module dsh-dpet/client/i18n
		*/
		const zh = {
			"settings.title": "桌宠",
			"settings.subtitle": "把任何形象变成陪你写代码的桌宠：3D 模型、图片、GIF 都能直接用，它会跟着 AI 的状态做动作。",
			"settings.enabled": "显示桌宠",
			"stage.tip": "实时预览 · 点它一下 · 移动鼠标它会看你",
			"stage.previewState": "预览 AI 状态：",
			"stage.loadFailed": "形象加载失败，请检查文件",
			"stage.vendorMissing": "3D 组件缺失，请重新构建插件",
			"phase.idle": "空闲",
			"phase.waiting": "准备",
			"phase.thinking": "思考",
			"phase.tool": "调用工具",
			"phase.review": "回复中",
			"phase.done": "完成",
			"phase.failed": "出错",
			"motion.bob": "呼吸",
			"motion.sway": "张望",
			"motion.spin": "转圈",
			"motion.hop": "蹦跶",
			"motion.nod": "点头",
			"motion.cheer": "欢呼",
			"motion.droop": "低落",
			"motion.still": "静止",
			"info.type": "类型",
			"info.kind3d": "3D 模型",
			"info.kind2d": "2D 图片",
			"info.kindGif": "GIF 动图",
			"info.detail": "详情",
			"info.author": "作者",
			"info.source": "来源",
			"info.builtin": "内置形象",
			"info.imported": "你导入的形象",
			"info.triangles": "{n} 面",
			"info.use": "设为桌宠",
			"info.using": "使用中",
			"info.rename": "改名",
			"info.renameSave": "保存",
			"info.renameCancel": "取消",
			"info.delete": "删除",
			"info.confirmDelete": "确定删除「{name}」吗？删除后无法恢复。",
			"info.highlight3d": "3D 实时渲染：真正的立体模型，会转、会跳",
			"info.highlightAgent": "跟着 AI 动：思考转圈、跑命令蹦跶、完成欢呼",
			"info.highlight2d": "2D 也会动：一张静态图也能呼吸、蹦跶",
			"gallery.title": "我的桌宠",
			"gallery.hint": "点卡片预览，再点「设为桌宠」启用。把 .glb 模型或图片直接拖到这里，就能变成新桌宠，不用写任何配置。",
			"gallery.add": "导入新形象",
			"gallery.addHint": "拖进来或点这里",
			"gallery.formats": "3D：.glb　2D：.png .jpg .webp .gif",
			"gallery.drop": "松手就能导入",
			"import.uploading": "正在上传 {file}（{size}）",
			"import.processing": "正在自动优化…",
			"import.done": "导入完成：{name} 已经加入你的桌宠",
			"import.failed": "导入失败：{reason}",
			"import.close": "收起",
			"import.review": "确认导入：{file}",
			"import.reviewHint": "点选你想要的版本，确认后再生成桌宠。",
			"import.original": "原图",
			"import.cleaned": "去掉背景后",
			"import.bg.working": "正在去背景…",
			"import.bg.removed": "已去掉 {color} 背景",
			"import.bg.transparent": "图片本身就是透明背景，无需处理",
			"import.bg.not-uniform": "背景不是纯色，暂时无法自动去除（复杂背景的 AI 抠图在下一批支持）",
			"import.name": "名字",
			"import.create": "生成桌宠",
			"import.cancel": "取消",
			"import.step.bgRemoved": "去掉纯色背景（{color}）",
			"import.step.bgKept": "保留原背景",
			"import.step.bgTransparent": "图片本身是透明背景",
			"import.step.bgComplex": "背景不是纯色，保留原样",
			"import.step.format": "识别格式：{format}",
			"import.step.mesh": "减面：{from} → {to} 面",
			"import.step.texture": "贴图压缩到 {size}px（WebP）",
			"import.step.bytes": "体积：{from} → {to}",
			"import.step.trim": "去掉透明边、限制尺寸",
			"import.step.gif": "GIF 保留原动画",
			"import.step.ready": "已生成桌宠，自动套用动作",
			"import.step.preview": "已生成封面",
			"error.unsupported-format": "不支持这种文件，3D 请用 .glb，2D 请用 png / jpg / webp / gif",
			"error.file-too-large": "文件太大了",
			"error.body-too-large": "文件太大了",
			"error.invalid-glb": "模型文件无法读取",
			"error.compressed-glb-unsupported": "暂不支持 Draco / meshopt 压缩过的模型",
			"error.invalid-image": "图片无法读取",
			"error.network": "网络错误，请重试",
			"mapping.title": "动作编排",
			"mapping.reset": "恢复默认",
			"place.title": "位置与外观",
			"place.hint": "拖动小窗里的桌宠摆放位置；也可以直接在页面上拖动桌宠本身。",
			"place.window": "DSH 窗口",
			"place.position": "位置：距右 {right}px，距下 {bottom}px",
			"place.size": "大小",
			"place.opacity": "透明度",
			"place.look": "看向鼠标",
			"place.lookHint": "鼠标移动时，桌宠会转头看你",
			"place.bubbles": "状态气泡",
			"place.bubblesHint": "显示「思考中…」这类提示",
			"roadmap.title": "图生 3D：一张照片直接变 3D 桌宠",
			"roadmap.tag": "即将推出",
			"roadmap.hint": "上传一张图片，自动完成生成、优化、导入：",
			"roadmap.step1": "选一张图片",
			"roadmap.step1Hint": "吉祥物、宠物照片都行",
			"roadmap.step2": "腾讯混元生成 3D",
			"roadmap.step2Hint": "使用你自己的腾讯云密钥",
			"roadmap.step3": "自动压缩优化",
			"roadmap.step3Hint": "几十 MB 压到 2 MB 左右",
			"roadmap.step4": "变成桌宠",
			"roadmap.step4Hint": "自动套用动作",
			"line.prepare": "{name}准备开工～",
			"line.waiting": "{name}在等 AI 回话…",
			"line.blocked": "{name}在等你确认",
			"line.thinking": "{name}思考中…",
			"line.writing": "{name}在写回复…",
			"line.tool": "{name}在{tool}…",
			"line.toolRetry": "工具出了点小问题，{name}再想想",
			"line.done": "搞定！",
			"line.failed": "呜…出错了",
			"line.interrupted": "好的，先停下",
			"tool.shell": "跑命令",
			"tool.read": "读文件",
			"tool.edit": "改代码",
			"tool.search": "找东西",
			"tool.web": "上网查资料",
			"tool.other": "用工具",
			"menu.sectionAi": "交给 AI（填入输入框，不会自动发送）",
			"menu.sectionQuick": "快捷操作",
			"menu.aiSwitch": "让 AI 帮我换个形象",
			"menu.aiImport": "用图片或模型做桌宠",
			"menu.aiMotions": "让 AI 调整动作",
			"menu.aiIntro": "问问 AI 桌宠能做什么",
			"menu.bigger": "变大一点",
			"menu.smaller": "变小一点",
			"menu.home": "回到右下角",
			"prompt.switch": "用 DPet 的工具看看我的桌宠库里有哪些形象，帮我挑一个换上，并说说理由。",
			"prompt.import": "用 DPet 的工具把这个文件做成我的桌宠：（在这里粘贴图片或 .glb 模型的完整路径）",
			"prompt.motions": "用 DPet 的工具调整桌宠的动作：思考时（ ），完成时（ ）。可选动作：呼吸、张望、转圈、蹦跶、点头、欢呼、低落、静止。",
			"prompt.intro": "介绍一下 DPet 桌宠插件能做什么，以及我可以怎样用一句话让你帮我设置它。",
			"notice.injected": "已填入输入框，确认后再发送",
			"notice.skipped": "输入框里有你没发的内容，没有覆盖",
			"notice.clipboard": "已复制到剪贴板，粘贴到输入框即可",
			"notice.failed": "没能填入输入框",
			"place.reducedMotion": "系统开启了「减少动画」，桌宠会保持静止。",
			"tap.1": "嘿嘿，被你戳到啦～",
			"tap.2": "别戳啦，在认真干活呢",
			"tap.3": "摸摸头，今天也要加油！",
			"tap.4": "{name}在这儿～"
		};
		const en = {
			"settings.title": "Desktop Pet",
			"settings.subtitle": "Turn any character into a coding companion: 3D models, pictures and GIFs all work, and it moves with what the AI is doing.",
			"settings.enabled": "Show pet",
			"stage.tip": "Live preview · click it · move the mouse and it looks at you",
			"stage.previewState": "Preview AI state:",
			"stage.loadFailed": "Could not load this character; check the file",
			"stage.vendorMissing": "The 3D component is missing; rebuild the plugin",
			"phase.idle": "Idle",
			"phase.waiting": "Preparing",
			"phase.thinking": "Thinking",
			"phase.tool": "Using tools",
			"phase.review": "Replying",
			"phase.done": "Done",
			"phase.failed": "Error",
			"motion.bob": "Breathe",
			"motion.sway": "Look around",
			"motion.spin": "Spin",
			"motion.hop": "Hop",
			"motion.nod": "Nod",
			"motion.cheer": "Cheer",
			"motion.droop": "Droop",
			"motion.still": "Still",
			"info.type": "Type",
			"info.kind3d": "3D model",
			"info.kind2d": "2D image",
			"info.kindGif": "GIF",
			"info.detail": "Details",
			"info.author": "Author",
			"info.source": "Source",
			"info.builtin": "Built-in",
			"info.imported": "Imported by you",
			"info.triangles": "{n} triangles",
			"info.use": "Use this pet",
			"info.using": "In use",
			"info.rename": "Rename",
			"info.renameSave": "Save",
			"info.renameCancel": "Cancel",
			"info.delete": "Delete",
			"info.confirmDelete": "Delete \"{name}\"? This cannot be undone.",
			"info.highlight3d": "Real-time 3D: a real model that spins and jumps",
			"info.highlightAgent": "Follows the AI: spins while thinking, hops while running tools",
			"info.highlight2d": "2D moves too: a still picture breathes and hops",
			"gallery.title": "My pets",
			"gallery.hint": "Click a card to preview, then \"Use this pet\". Drop a .glb model or a picture here to make a new pet — no config needed.",
			"gallery.add": "Import",
			"gallery.addHint": "Drop here or click",
			"gallery.formats": "3D: .glb   2D: .png .jpg .webp .gif",
			"gallery.drop": "Release to import",
			"import.uploading": "Uploading {file} ({size})",
			"import.processing": "Optimizing…",
			"import.done": "Imported: {name} joined your pets",
			"import.failed": "Import failed: {reason}",
			"import.close": "Close",
			"import.review": "Confirm import: {file}",
			"import.reviewHint": "Pick the version you want, then create the pet.",
			"import.original": "Original",
			"import.cleaned": "Background removed",
			"import.bg.working": "Removing background…",
			"import.bg.removed": "Removed the {color} background",
			"import.bg.transparent": "Already transparent, nothing to remove",
			"import.bg.not-uniform": "The background is not a plain color and cannot be removed automatically yet (AI cut-out comes next)",
			"import.name": "Name",
			"import.create": "Create pet",
			"import.cancel": "Cancel",
			"import.step.bgRemoved": "Removed plain background ({color})",
			"import.step.bgKept": "Kept the original background",
			"import.step.bgTransparent": "Already transparent",
			"import.step.bgComplex": "Background is not plain, kept as is",
			"import.step.format": "Format: {format}",
			"import.step.mesh": "Triangles: {from} → {to}",
			"import.step.texture": "Textures resized to {size}px (WebP)",
			"import.step.bytes": "Size: {from} → {to}",
			"import.step.trim": "Trimmed transparent borders, bounded size",
			"import.step.gif": "GIF animation kept as is",
			"import.step.ready": "Pet created with default motions",
			"import.step.preview": "Thumbnail created",
			"error.unsupported-format": "Unsupported file: use .glb for 3D, png / jpg / webp / gif for 2D",
			"error.file-too-large": "The file is too large",
			"error.body-too-large": "The file is too large",
			"error.invalid-glb": "The model file could not be read",
			"error.compressed-glb-unsupported": "Draco / meshopt compressed models are not supported yet",
			"error.invalid-image": "The image could not be read",
			"error.network": "Network error, please retry",
			"mapping.title": "Motions",
			"mapping.reset": "Reset",
			"place.title": "Position & look",
			"place.hint": "Drag the pet in the mini window, or drag the pet itself on the page.",
			"place.window": "DSH window",
			"place.position": "Position: {right}px from right, {bottom}px from bottom",
			"place.size": "Size",
			"place.opacity": "Opacity",
			"place.look": "Look at cursor",
			"place.lookHint": "The pet turns toward your mouse",
			"place.bubbles": "Status bubble",
			"place.bubblesHint": "Shows hints like \"Thinking…\"",
			"roadmap.title": "Image to 3D: turn one photo into a 3D pet",
			"roadmap.tag": "Coming soon",
			"roadmap.hint": "Upload a picture and the rest happens automatically:",
			"roadmap.step1": "Pick a picture",
			"roadmap.step1Hint": "A mascot or a pet photo",
			"roadmap.step2": "Tencent Hunyuan 3D",
			"roadmap.step2Hint": "With your own Tencent Cloud key",
			"roadmap.step3": "Auto-optimize",
			"roadmap.step3Hint": "Tens of MB down to about 2 MB",
			"roadmap.step4": "It becomes a pet",
			"roadmap.step4Hint": "Motions applied",
			"line.prepare": "{name} is getting ready",
			"line.waiting": "{name} is waiting for the AI…",
			"line.blocked": "{name} is waiting for your approval",
			"line.thinking": "{name} is thinking…",
			"line.writing": "{name} is writing…",
			"line.tool": "{name} is {tool}…",
			"line.toolRetry": "A tool hiccuped; {name} is rethinking",
			"line.done": "Done!",
			"line.failed": "Oops, something failed",
			"line.interrupted": "OK, stopping",
			"tool.shell": "running a command",
			"tool.read": "reading files",
			"tool.edit": "editing code",
			"tool.search": "searching",
			"tool.web": "browsing the web",
			"tool.other": "using a tool",
			"menu.sectionAi": "Ask the AI (fills the input, never sends)",
			"menu.sectionQuick": "Quick actions",
			"menu.aiSwitch": "Let the AI pick a new look",
			"menu.aiImport": "Make a pet from a picture or model",
			"menu.aiMotions": "Let the AI adjust the motions",
			"menu.aiIntro": "Ask what the pet can do",
			"menu.bigger": "Bigger",
			"menu.smaller": "Smaller",
			"menu.home": "Back to the bottom right",
			"prompt.switch": "Use the DPet tools to look at the pets in my library, pick one for me, switch to it, and tell me why.",
			"prompt.import": "Use the DPet tools to turn this file into my desktop pet: (paste the full path of the picture or .glb model here)",
			"prompt.motions": "Use the DPet tools to change the pet motions: while thinking ( ), when done ( ). Motions: breathe, look around, spin, hop, nod, cheer, droop, still.",
			"prompt.intro": "Tell me what the DPet desktop pet plugin can do, and how I can set it up with a single sentence to you.",
			"notice.injected": "Put in the input box; send it when ready",
			"notice.skipped": "Your unsent text is in the input box; left it alone",
			"notice.clipboard": "Copied to the clipboard; paste it into the input box",
			"notice.failed": "Could not fill the input box",
			"place.reducedMotion": "Reduced motion is on in your system; the pet stays still.",
			"tap.1": "Hehe, you poked me!",
			"tap.2": "Hey, I am working here",
			"tap.3": "Head pat received. Keep going!",
			"tap.4": "{name} is here"
		};
		/** The dictionary for the current document language. */
		function dictionary() {
			return (typeof document === "undefined" ? "zh" : document.documentElement.lang).toLowerCase().startsWith("en") ? en : zh;
		}
		/** Translate a key with optional `{name}` params. */
		function t(key, params) {
			let text = dictionary()[key] ?? key;
			if (params !== void 0) for (const [name, value] of Object.entries(params)) text = text.replaceAll("{" + name + "}", String(value));
			return text;
		}
		/** Friendly verb for a tool name. */
		function toolLabel(tool) {
			const name = (tool ?? "").toLowerCase();
			if (/bash|shell|exec|command|terminal|run/.test(name)) return t("tool.shell");
			if (/grep|glob|search|find|list|ls/.test(name)) return t("tool.search");
			if (/write|edit|patch|replace|create/.test(name)) return t("tool.edit");
			if (/read|view|cat|open/.test(name)) return t("tool.read");
			if (/web|fetch|http|browse|url/.test(name)) return t("tool.web");
			return t("tool.other");
		}
		/** Human-readable byte size. */
		function formatBytes(bytes) {
			if (bytes >= 1048576) return (bytes / 1024 / 1024).toFixed(1) + " MB";
			if (bytes >= 1024) return Math.round(bytes / 1024) + " KB";
			return bytes + " B";
		}
		/** Human-readable triangle count (zh uses 万). */
		function formatCount(n) {
			if (dictionary() === zh && n >= 1e4) return (n / 1e4).toFixed(n >= 1e5 ? 0 : 1) + " 万";
			return n.toLocaleString();
		}
		//#endregion
		//#region src/client/components/PetStage.tsx
		/**
		* PetStage — mounts the right renderer (3D model or 2D picture) for one pet
		* and keeps it in sync with React props. The floating pet and the settings
		* preview both render through it, so a pet looks and moves the same in both.
		* @module dsh-dpet/client/components/PetStage
		*/
		function PetStage(props) {
			const containerRef = (0, react.useRef)(null);
			const streamRef = (0, react.useRef)(null);
			const handleRef = (0, react.useRef)(void 0);
			const [error, setError] = (0, react.useState)(null);
			const latest = (0, react.useRef)(props);
			latest.current = props;
			(0, react.useEffect)(() => {
				const container = containerRef.current;
				if (container === null) return void 0;
				setError(null);
				streamRef.current ??= createPhaseStream(props.phase);
				const common = {
					container,
					phase: streamRef.current,
					...latest.current.motions === void 0 ? {} : { motions: latest.current.motions },
					lookAtCursor: latest.current.lookAtCursor ?? true
				};
				const handle = props.pet.kind === "3d" ? mountGltf({
					...common,
					modelUrl: props.pet.fileUrl
				}) : mountFlat({
					...common,
					imageUrl: props.pet.fileUrl
				});
				handleRef.current = handle;
				handle.onError(setError);
				handle.onReady(() => latest.current.onReady?.(handle));
				handle.onLayout((top) => latest.current.onLayout?.(top));
				latest.current.onHandle?.(handle);
				return () => {
					handleRef.current = void 0;
					latest.current.onHandle?.(void 0);
					handle.dispose();
				};
			}, [props.pet.kind, props.pet.fileUrl]);
			(0, react.useEffect)(() => {
				streamRef.current?.push(props.phase);
			}, [props.phase]);
			(0, react.useEffect)(() => {
				handleRef.current?.setMotions(props.motions);
			}, [JSON.stringify(props.motions ?? {})]);
			(0, react.useEffect)(() => {
				handleRef.current?.setLookAtCursor(props.lookAtCursor ?? true);
			}, [props.lookAtCursor]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				ref: containerRef,
				className: props.className,
				style: props.className === void 0 ? {
					position: "relative",
					...props.style
				} : props.style,
				"data-dpet-stage": props.pet.id,
				children: error !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: {
						position: "absolute",
						inset: "auto 8px 8px",
						fontSize: 12,
						color: "var(--dsw-alias-state-error-primary, #d92d20)"
					},
					children: error === "vendor-missing" ? t("stage.vendorMissing") : t("stage.loadFailed")
				})
			});
		}
		//#endregion
		//#region \0dsh-css:src/client/styles/dpet.module.css.mjs
		const css = "._dxzea_float{z-index:2147483000;-webkit-user-select:none;user-select:none;touch-action:none;position:fixed}._dxzea_floatStage{cursor:grab;width:100%;height:100%}._dxzea_floatStage:active{cursor:grabbing}._dxzea_bubble{border:1px solid var(--dsw-alias-border-l2,#e4e7ec);background:var(--dsw-alias-bg-layer-3,#fff);width:max-content;color:var(--dsw-alias-label-primary,#1f2329);white-space:nowrap;text-overflow:ellipsis;pointer-events:none;border-radius:14px;padding:5px 12px;line-height:1.4;animation:.2s ease-out _dxzea_bubbleIn;position:absolute;left:50%;overflow:hidden;transform:translate(-50%);box-shadow:0 4px 16px #1018281f}@keyframes _dxzea_bubbleIn{0%{opacity:0;transform:translate(-50%,4px)}to{opacity:1;transform:translate(-50%)}}._dxzea_menu{z-index:2147483001;border:1px solid var(--dsw-alias-border-l2,#e4e7ec);background:var(--dsw-alias-bg-layer-3,#fff);color:var(--dsw-alias-label-primary,#1f2329);border-radius:12px;padding:6px;font-size:13px;position:fixed;box-shadow:0 8px 28px #1018282e}._dxzea_menuLabel{color:var(--dsw-alias-label-tertiary,#98a2b3);padding:6px 10px 4px;font-size:11px}._dxzea_menuItem{width:100%;color:inherit;font:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:8px;padding:7px 10px;display:block}._dxzea_menuItem:hover,._dxzea_menuItem:focus-visible{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2,#f2f4f7));outline:none}._dxzea_menuDivider{background:var(--dsw-alias-border-l2,#e4e7ec);height:1px;margin:6px 4px}@media (prefers-reduced-motion:reduce){._dxzea_bubble{animation:none}._dxzea_card,._dxzea_card:hover{transition:none;transform:none}._dxzea_switch,._dxzea_switch:after{transition:none}}._dxzea_page{color:var(--dsw-alias-label-primary,#1f2329);flex-direction:column;gap:28px;padding-bottom:40px;font-size:14px;display:flex}._dxzea_head{align-items:flex-start;gap:16px;display:flex}._dxzea_head h2{margin:0;font-size:20px;font-weight:600}._dxzea_sub{color:var(--dsw-alias-label-secondary,#667085);margin:4px 0 0}._dxzea_grow{flex:1;min-width:0}._dxzea_muted{color:var(--dsw-alias-label-secondary,#667085)}._dxzea_small{font-size:12px}._dxzea_section h3{margin:0 0 4px;font-size:15px;font-weight:600}._dxzea_hint{color:var(--dsw-alias-label-secondary,#667085);margin:0 0 12px;font-size:13px}._dxzea_switch{background:var(--dsw-alias-label-dimmed,#d0d5dd);cursor:pointer;border:0;border-radius:99px;flex:none;width:38px;height:22px;padding:0;transition:background .15s;position:relative}._dxzea_switch[aria-checked=true]{background:var(--dsw-alias-label-primary,#1f2329)}._dxzea_switch:after{content:\"\";background:var(--dsw-alias-bg-layer-3,#fff);border-radius:50%;width:16px;height:16px;transition:transform .15s;position:absolute;top:3px;left:3px}._dxzea_switch[aria-checked=true]:after{transform:translate(16px)}._dxzea_switchRow{color:var(--dsw-alias-label-secondary,#667085);align-items:center;gap:10px;display:flex}._dxzea_hero{grid-template-columns:minmax(0,1.35fr) minmax(0,1fr);gap:16px;display:grid}._dxzea_stageBox{border:1px solid var(--dsw-alias-border-l2,#e4e7ec);background:var(--dsw-alias-bg-layer-2,#f7f8fa);border-radius:16px;height:340px;position:relative;overflow:hidden}._dxzea_stage{cursor:pointer;position:absolute;inset:36px 0 0}._dxzea_stageTip{color:var(--dsw-alias-label-tertiary,#98a2b3);pointer-events:none;font-size:12px;position:absolute;bottom:10px;left:14px}._dxzea_stageBubble{border:1px solid var(--dsw-alias-border-l2,#e4e7ec);background:var(--dsw-alias-bg-layer-3,#fff);white-space:nowrap;border-radius:14px;padding:5px 12px;font-size:12px;position:absolute;top:12px;left:50%;transform:translate(-50%)}._dxzea_chips{flex-wrap:wrap;align-items:center;gap:6px;margin-top:10px;display:flex}._dxzea_chip{border:1px solid var(--dsw-alias-border-l2,#e4e7ec);background:var(--dsw-alias-bg-layer-3,#fff);color:var(--dsw-alias-label-primary,#1f2329);font:inherit;cursor:pointer;border-radius:99px;padding:3px 12px;font-size:13px}._dxzea_chip:hover{border-color:var(--dsw-alias-label-dimmed,#98a2b3)}._dxzea_chip[aria-pressed=true]{background:var(--dsw-alias-label-primary,#1f2329);border-color:var(--dsw-alias-label-primary,#1f2329);color:var(--dsw-alias-bg-layer-3,#fff)}._dxzea_info{border:1px solid var(--dsw-alias-border-l2,#e4e7ec);background:var(--dsw-alias-bg-layer-3,#fff);border-radius:16px;flex-direction:column;gap:14px;padding:18px;display:flex}._dxzea_infoName{word-break:break-all;font-size:18px;font-weight:600}._dxzea_kv{grid-template-columns:56px 1fr;gap:6px 10px;margin:0;font-size:13px;display:grid}._dxzea_kv dt{color:var(--dsw-alias-label-secondary,#667085)}._dxzea_kv dd{margin:0}._dxzea_btns{flex-wrap:wrap;gap:8px;display:flex}._dxzea_btn{border:1px solid var(--dsw-alias-label-primary,#1f2329);background:var(--dsw-alias-label-primary,#1f2329);color:var(--dsw-alias-bg-layer-3,#fff);font:inherit;cursor:pointer;border-radius:10px;padding:6px 14px;font-size:13px}._dxzea_btn:disabled{opacity:.5;cursor:default}._dxzea_btnGhost{color:var(--dsw-alias-label-primary,#1f2329);border-color:var(--dsw-alias-border-l2,#e4e7ec);background:0 0}._dxzea_btnDanger{color:var(--dsw-alias-state-error-primary,#d92d20)}._dxzea_input{border:1px solid var(--dsw-alias-border-l2,#e4e7ec);background:var(--dsw-alias-bg-layer-2,#f7f8fa);min-width:0;color:var(--dsw-alias-label-primary,#1f2329);font:inherit;border-radius:10px;flex:1;padding:6px 10px}._dxzea_highlights{border:1px dashed var(--dsw-alias-border-l2,#e4e7ec);color:var(--dsw-alias-label-secondary,#667085);border-radius:12px;margin:0;padding:12px 14px;font-size:13px;list-style:none}._dxzea_highlights li+li{margin-top:4px}._dxzea_gallery{grid-template-columns:repeat(auto-fill,minmax(168px,1fr));gap:12px;display:grid}._dxzea_card{text-align:left;border:1px solid var(--dsw-alias-border-l2,#e4e7ec);background:var(--dsw-alias-bg-layer-3,#fff);color:inherit;font:inherit;cursor:pointer;border-radius:14px;flex-direction:column;padding:0;transition:border-color .15s,transform .15s;display:flex;position:relative;overflow:hidden}._dxzea_card:hover{border-color:var(--dsw-alias-label-dimmed,#98a2b3);transform:translateY(-2px)}._dxzea_card[aria-selected=true]{border-color:var(--dsw-alias-label-primary,#1f2329);box-shadow:0 0 0 1px var(--dsw-alias-label-primary,#1f2329)}._dxzea_thumb{background:var(--dsw-alias-bg-layer-2,#f7f8fa);place-items:end center;height:120px;padding-bottom:6px;display:grid}._dxzea_thumb img{object-fit:contain;max-width:80%;max-height:108px}._dxzea_thumbEmpty{color:var(--dsw-alias-label-tertiary,#98a2b3);align-self:center;font-size:28px;font-weight:700}._dxzea_cardBody{padding:9px 12px 11px}._dxzea_cardTitle{align-items:center;gap:6px;font-weight:600;display:flex}._dxzea_cardTitle span:first-child{text-overflow:ellipsis;white-space:nowrap;overflow:hidden}._dxzea_cardMeta{color:var(--dsw-alias-label-secondary,#667085);margin-top:2px;font-size:12px}._dxzea_badge{background:var(--dsw-alias-bg-module-platform,#eef2f6);color:var(--dsw-alias-label-secondary,#475467);border-radius:99px;flex:none;padding:0 7px;font-size:11px;font-weight:600}._dxzea_using{background:var(--dsw-alias-label-primary,#1f2329);color:var(--dsw-alias-bg-layer-3,#fff);border-radius:99px;padding:1px 8px;font-size:11px;position:absolute;top:8px;right:8px}._dxzea_add{text-align:center;border-style:dashed;justify-content:center;align-items:center;min-height:176px;padding:14px}._dxzea_addActive{border-color:var(--dsw-alias-brand-primary,#3964fe);background:var(--dsw-alias-bg-layer-2,#f7f8fa)}._dxzea_plus{background:var(--dsw-alias-bg-module-platform,#eef2f6);border-radius:50%;place-items:center;width:40px;height:40px;margin-bottom:8px;font-size:24px;display:grid}._dxzea_import{border:1px solid var(--dsw-alias-border-l2,#e4e7ec);background:var(--dsw-alias-bg-layer-3,#fff);border-radius:12px;margin-top:12px;padding:12px 16px}._dxzea_importHead{align-items:center;gap:12px;display:flex}._dxzea_importHead b{flex:1;font-weight:600}._dxzea_importSteps{color:var(--dsw-alias-label-secondary,#667085);margin:8px 0 0;padding-left:20px;font-size:13px}._dxzea_importError{color:var(--dsw-alias-state-error-primary,#d92d20)}._dxzea_review{grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;display:grid}._dxzea_tile{border:1px solid var(--dsw-alias-border-l2,#e4e7ec);color:inherit;font:inherit;cursor:pointer;background:0 0;border-radius:12px;flex-direction:column;gap:6px;padding:6px;font-size:12px;display:flex}._dxzea_tile[aria-pressed=true]{border-color:var(--dsw-alias-label-primary,#1f2329);box-shadow:0 0 0 1px var(--dsw-alias-label-primary,#1f2329)}._dxzea_tile:disabled{cursor:default}._dxzea_checker{background:repeating-conic-gradient(var(--dsw-alias-bg-module-platform,#e4e7ec) 0 25%, var(--dsw-alias-bg-layer-3,#fff) 0 50%) 0 0 / 16px 16px;border-radius:8px;place-items:center;height:170px;display:grid;overflow:hidden}._dxzea_checker img{object-fit:contain;max-width:100%;max-height:158px}._dxzea_progress{background:var(--dsw-alias-bg-module-platform,#eef2f6);border-radius:99px;height:4px;margin-top:8px;overflow:hidden}._dxzea_progress>div{background:var(--dsw-alias-brand-primary,#3964fe);height:100%;transition:width .2s}._dxzea_mapping{border:1px solid var(--dsw-alias-border-l2,#e4e7ec);border-radius:14px;overflow:hidden}._dxzea_mapRow{border-top:1px solid var(--dsw-alias-border-l2,#e4e7ec);grid-template-columns:64px 1fr;align-items:center;gap:10px;padding:8px 12px;display:grid}._dxzea_mapRow:first-child{border-top:0}._dxzea_mapRow[data-live=true]{background:var(--dsw-alias-bg-layer-2,#f7f8fa)}._dxzea_mapState{font-weight:500}._dxzea_mapMotions{flex-wrap:wrap;gap:4px;display:flex}._dxzea_mapMotions ._dxzea_chip{padding:2px 9px;font-size:12px}._dxzea_place{grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);gap:16px;display:grid}._dxzea_screen{border:1px solid var(--dsw-alias-border-l2,#e4e7ec);background:var(--dsw-alias-bg-layer-2,#f7f8fa);touch-action:none;border-radius:12px;height:200px;position:relative;overflow:hidden}._dxzea_screenLabel{color:var(--dsw-alias-label-tertiary,#98a2b3);font-size:12px;position:absolute;top:10px;left:12px}._dxzea_fakeLines{background:var(--dsw-alias-border-l2,#e4e7ec);width:55%;height:8px;box-shadow:0 20px 0 var(--dsw-alias-border-l2,#e4e7ec), 0 40px 0 var(--dsw-alias-border-l2,#e4e7ec);border-radius:6px;position:absolute;top:36px;left:12px}._dxzea_miniPet{cursor:grab;filter:drop-shadow(0 2px 3px #00000040);background:bottom/contain no-repeat;position:absolute}._dxzea_miniPet:active{cursor:grabbing}._dxzea_controls{border:1px solid var(--dsw-alias-border-l2,#e4e7ec);background:var(--dsw-alias-bg-layer-3,#fff);border-radius:12px;flex-direction:column;gap:14px;padding:14px 16px;display:flex}._dxzea_row{align-items:center;gap:10px;display:flex}._dxzea_row label{width:48px;color:var(--dsw-alias-label-secondary,#667085);flex:none}._dxzea_row input[type=range]{min-width:0;accent-color:var(--dsw-alias-label-primary,#1f2329);flex:1}._dxzea_row output{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;flex:none;width:60px}._dxzea_toggle{justify-content:space-between;align-items:center;gap:12px;display:flex}._dxzea_toggle small{color:var(--dsw-alias-label-secondary,#667085);font-size:12px;display:block}._dxzea_road{border:1px dashed var(--dsw-alias-border-l2,#e4e7ec);border-radius:14px;padding:16px}._dxzea_roadHead{align-items:center;gap:8px;font-weight:600;display:flex}._dxzea_tag{background:var(--dsw-alias-bg-module-platform,#eef2f6);color:var(--dsw-alias-state-warn-primary,#b54708);border-radius:99px;padding:1px 8px;font-size:11px;font-weight:500}._dxzea_flow{flex-wrap:wrap;align-items:center;gap:8px;margin-top:10px;display:flex}._dxzea_step{border:1px solid var(--dsw-alias-border-l2,#e4e7ec);background:var(--dsw-alias-bg-layer-3,#fff);border-radius:10px;padding:7px 12px;font-size:13px}._dxzea_step small{color:var(--dsw-alias-label-secondary,#667085);font-size:11px;display:block}@media (width<=760px){._dxzea_hero,._dxzea_place{grid-template-columns:1fr}}";
		const tagId = "dsh-dpet/src/client/styles/dpet.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-dpet";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var dpet_module_css_default = {
			"add": "_dxzea_add",
			"addActive": "_dxzea_addActive",
			"badge": "_dxzea_badge",
			"btn": "_dxzea_btn",
			"btnDanger": "_dxzea_btnDanger",
			"btnGhost": "_dxzea_btnGhost",
			"btns": "_dxzea_btns",
			"bubble": "_dxzea_bubble",
			"bubbleIn": "_dxzea_bubbleIn",
			"card": "_dxzea_card",
			"cardBody": "_dxzea_cardBody",
			"cardMeta": "_dxzea_cardMeta",
			"cardTitle": "_dxzea_cardTitle",
			"checker": "_dxzea_checker",
			"chip": "_dxzea_chip",
			"chips": "_dxzea_chips",
			"controls": "_dxzea_controls",
			"fakeLines": "_dxzea_fakeLines",
			"float": "_dxzea_float",
			"floatStage": "_dxzea_floatStage",
			"flow": "_dxzea_flow",
			"gallery": "_dxzea_gallery",
			"grow": "_dxzea_grow",
			"head": "_dxzea_head",
			"hero": "_dxzea_hero",
			"highlights": "_dxzea_highlights",
			"hint": "_dxzea_hint",
			"import": "_dxzea_import",
			"importError": "_dxzea_importError",
			"importHead": "_dxzea_importHead",
			"importSteps": "_dxzea_importSteps",
			"info": "_dxzea_info",
			"infoName": "_dxzea_infoName",
			"input": "_dxzea_input",
			"kv": "_dxzea_kv",
			"mapMotions": "_dxzea_mapMotions",
			"mapRow": "_dxzea_mapRow",
			"mapState": "_dxzea_mapState",
			"mapping": "_dxzea_mapping",
			"menu": "_dxzea_menu",
			"menuDivider": "_dxzea_menuDivider",
			"menuItem": "_dxzea_menuItem",
			"menuLabel": "_dxzea_menuLabel",
			"miniPet": "_dxzea_miniPet",
			"muted": "_dxzea_muted",
			"page": "_dxzea_page",
			"place": "_dxzea_place",
			"plus": "_dxzea_plus",
			"progress": "_dxzea_progress",
			"review": "_dxzea_review",
			"road": "_dxzea_road",
			"roadHead": "_dxzea_roadHead",
			"row": "_dxzea_row",
			"screen": "_dxzea_screen",
			"screenLabel": "_dxzea_screenLabel",
			"section": "_dxzea_section",
			"small": "_dxzea_small",
			"stage": "_dxzea_stage",
			"stageBox": "_dxzea_stageBox",
			"stageBubble": "_dxzea_stageBubble",
			"stageTip": "_dxzea_stageTip",
			"step": "_dxzea_step",
			"sub": "_dxzea_sub",
			"switch": "_dxzea_switch",
			"switchRow": "_dxzea_switchRow",
			"tag": "_dxzea_tag",
			"thumb": "_dxzea_thumb",
			"thumbEmpty": "_dxzea_thumbEmpty",
			"tile": "_dxzea_tile",
			"toggle": "_dxzea_toggle",
			"using": "_dxzea_using"
		};
		//#endregion
		//#region src/client/components/PetMenu.tsx
		/**
		* The pet's right-click menu. "Ask the AI" items put a ready-made prompt in
		* the DSH input box (never sent automatically); the quick items change the
		* pet directly.
		* @module dsh-dpet/client/components/PetMenu
		*/
		/** Menu entries that hand a prompt to the AI. */
		const PROMPT_ITEMS = [
			{
				label: "menu.aiSwitch",
				prompt: "prompt.switch"
			},
			{
				label: "menu.aiImport",
				prompt: "prompt.import"
			},
			{
				label: "menu.aiMotions",
				prompt: "prompt.motions"
			},
			{
				label: "menu.aiIntro",
				prompt: "prompt.intro"
			}
		];
		/** Approximate menu box, for keeping it on screen. */
		const MENU_W = 236;
		const MENU_H = 300;
		function PetMenu(props) {
			const ref = (0, react.useRef)(null);
			(0, react.useEffect)(() => {
				const onDown = (e) => {
					if (ref.current !== null && !ref.current.contains(e.target)) props.onClose();
				};
				const onKey = (e) => {
					if (e.key === "Escape") props.onClose();
				};
				document.addEventListener("pointerdown", onDown, true);
				document.addEventListener("keydown", onKey);
				ref.current?.querySelector("button")?.focus();
				return () => {
					document.removeEventListener("pointerdown", onDown, true);
					document.removeEventListener("keydown", onKey);
				};
			}, []);
			const left = Math.max(8, Math.min(props.x - MENU_W, window.innerWidth - MENU_W - 8));
			const top = Math.max(8, Math.min(props.y - MENU_H / 2, window.innerHeight - MENU_H - 8));
			const run = (action) => () => {
				action();
				props.onClose();
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				ref,
				className: dpet_module_css_default.menu,
				role: "menu",
				style: {
					left,
					top,
					width: MENU_W
				},
				onContextMenu: (e) => e.preventDefault(),
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: dpet_module_css_default.menuLabel,
						children: t("menu.sectionAi")
					}),
					PROMPT_ITEMS.map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						role: "menuitem",
						className: dpet_module_css_default.menuItem,
						onClick: run(() => props.onPrompt(t(item.prompt))),
						children: t(item.label)
					}, item.label)),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: dpet_module_css_default.menuDivider }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: dpet_module_css_default.menuLabel,
						children: t("menu.sectionQuick")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						role: "menuitem",
						className: dpet_module_css_default.menuItem,
						onClick: run(() => props.onResize(40)),
						children: t("menu.bigger")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						role: "menuitem",
						className: dpet_module_css_default.menuItem,
						onClick: run(() => props.onResize(-40)),
						children: t("menu.smaller")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						role: "menuitem",
						className: dpet_module_css_default.menuItem,
						onClick: run(props.onHome),
						children: t("menu.home")
					})
				]
			});
		}
		//#endregion
		//#region src/client/utils/lines.ts
		/** The status line for an activity, or undefined when there is nothing to say. */
		function activityLine(activity, petName) {
			if (activity.line === void 0) return void 0;
			return t("line." + activity.line, {
				name: petName,
				tool: toolLabel(activity.tool)
			});
		}
		const TAP_KEYS = [
			"tap.1",
			"tap.2",
			"tap.3",
			"tap.4"
		];
		/** A tap reaction, rotating through the pool. */
		function tapLine(petName, index) {
			return t(TAP_KEYS[index % TAP_KEYS.length], { name: petName });
		}
		//#endregion
		//#region src/client/utils/bubble.ts
		/**
		* Status bubble placement: just above the pet's head, scaled with the pet,
		* flipping below the pet when the viewport leaves no room above.
		* @module dsh-dpet/client/utils/bubble
		*/
		/** Space a bubble needs above the pet before it flips below instead. */
		const BUBBLE_ROOM = 48;
		/**
		* Place the bubble just above the pet's head.
		* @param boxHeight - pet box height (the size setting), px.
		* @param headTop - distance from the box top to the head, px; undefined before the first layout.
		* @param bottomInset - box distance from the viewport bottom, px.
		* @param viewportHeight - window height, px.
		*/
		function bubbleLayout(boxHeight, headTop, bottomInset, viewportHeight) {
			const gap = Math.round(Math.min(20, Math.max(8, boxHeight * .05)));
			const fontSize = Math.round(Math.min(14, Math.max(11, boxHeight * .07)));
			const maxWidth = Math.max(180, Math.round(boxHeight * 1.6));
			const above = boxHeight - Math.min(boxHeight, Math.max(0, headTop ?? boxHeight * .2)) + gap;
			return viewportHeight - bottomInset - above < BUBBLE_ROOM ? {
				top: boxHeight + gap,
				fontSize,
				maxWidth
			} : {
				bottom: above,
				fontSize,
				maxWidth
			};
		}
		//#endregion
		//#region src/client/utils/import-report.ts
		/** File types the import button accepts. */
		const ACCEPT = ".glb,.png,.jpg,.jpeg,.webp,.gif";
		/** Pictures that go through the before / after review (GIFs keep their animation, models skip it). */
		const REVIEWABLE = /\.(png|jpe?g|webp)$/i;
		/** Default pet name: the file name without its extension. */
		function nameOf(file) {
			return file.name.replace(/\.[^.]+$/, "").slice(0, 32);
		}
		/** Localized text for a host error code (the code itself when unknown). */
		function errorText(code) {
			const key = "error." + code;
			const text = t(key);
			return text === key ? code : text;
		}
		/** The "what the import did" list. */
		function reportSteps(report) {
			const steps = [t("import.step.format", { format: report.format.toUpperCase() })];
			if (report.kind === "3d") {
				if (report.originalTriangles !== void 0 && report.finalTriangles !== void 0) steps.push(t("import.step.mesh", {
					from: formatCount(report.originalTriangles),
					to: formatCount(report.finalTriangles)
				}));
				if (report.textureSize !== void 0) steps.push(t("import.step.texture", { size: report.textureSize }));
			} else if (report.format === "gif") steps.push(t("import.step.gif"));
			else {
				if (report.background === "removed") steps.push(t("import.step.bgRemoved", { color: report.backgroundColor ?? "" }));
				else if (report.background === "transparent") steps.push(t("import.step.bgTransparent"));
				else if (report.background === "not-uniform") steps.push(t("import.step.bgComplex"));
				else if (report.background === "kept") steps.push(t("import.step.bgKept"));
				steps.push(t("import.step.trim"));
			}
			steps.push(t("import.step.bytes", {
				from: formatBytes(report.originalBytes),
				to: formatBytes(report.finalBytes)
			}));
			steps.push(t("import.step.ready"));
			return steps;
		}
		/** Crop a transparent PNG data URL to its content and bound it for a thumbnail. */
		async function thumbnailFrom(dataUrl, maxEdge = 256) {
			const image = new Image();
			image.src = dataUrl;
			await image.decode();
			const src = document.createElement("canvas");
			src.width = image.naturalWidth;
			src.height = image.naturalHeight;
			const g = src.getContext("2d");
			if (g === null) return void 0;
			g.drawImage(image, 0, 0);
			const { data, width, height } = g.getImageData(0, 0, src.width, src.height);
			let minX = width, minY = height, maxX = -1, maxY = -1;
			for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (data[(y * width + x) * 4 + 3] > 8) {
				if (x < minX) minX = x;
				if (x > maxX) maxX = x;
				if (y < minY) minY = y;
				if (y > maxY) maxY = y;
			}
			if (maxX < 0) return void 0;
			const w = maxX - minX + 1;
			const h = maxY - minY + 1;
			const scale = Math.min(1, maxEdge / Math.max(w, h));
			const out = document.createElement("canvas");
			out.width = Math.max(1, Math.round(w * scale));
			out.height = Math.max(1, Math.round(h * scale));
			out.getContext("2d")?.drawImage(src, minX, minY, w, h, 0, 0, out.width, out.height);
			return new Promise((resolve) => out.toBlob((blob) => resolve(blob ?? void 0), "image/png"));
		}
		//#endregion
		//#region src/client/components/FloatingPet.tsx
		/**
		* The floating pet: a fixed-position stage anchored to the bottom-right of
		* the page. Drag it to move (the new position is saved), click it for a
		* squash and a reaction, right-click it for the menu (prompts for the AI and
		* quick size / position actions). Showing and hiding it lives in the
		* settings page.
		*
		* A 3D pet shown without a gallery thumbnail (e.g. imported by the AI through
		* the dpet_import tool) gets one captured here the first time it renders.
		*
		* The status bubble follows the pet's real head: the renderer reports where
		* the head is inside the box, and the bubble sits a size-proportional gap
		* above it, or below the pet when there is no room above.
		* @module dsh-dpet/client/components/FloatingPet
		*/
		/** Width of the pet box relative to its height. */
		const PET_ASPECT = .85;
		/** A pointer that moves farther than this is a drag, not a click. */
		const DRAG_SLOP = 4;
		/** How long a tap reaction or a menu notice stays up. */
		const TAP_LINE_MS = 2600;
		/** The resting corner "back to the bottom right" returns to. */
		const HOME = {
			right: 32,
			bottom: 24
		};
		/** Keep the pet box fully inside the viewport. */
		function clampInset(right, bottom, width, height) {
			const maxRight = Math.max(0, window.innerWidth - width);
			const maxBottom = Math.max(0, window.innerHeight - height);
			return {
				right: Math.min(Math.max(0, right), maxRight),
				bottom: Math.min(Math.max(0, bottom), maxBottom)
			};
		}
		function FloatingPet(props) {
			const { state } = useDpet(props.store);
			const handleRef = (0, react.useRef)(void 0);
			const dragRef = (0, react.useRef)(null);
			const [drag, setDrag] = (0, react.useState)(null);
			const [tap, setTap] = (0, react.useState)(null);
			const [menu, setMenu] = (0, react.useState)(null);
			const thumbnailed = (0, react.useRef)(/* @__PURE__ */ new Set());
			const tapCount = (0, react.useRef)(0);
			const [headTop, setHeadTop] = (0, react.useState)(void 0);
			const [, forceLayout] = (0, react.useState)(0);
			(0, react.useEffect)(() => {
				if (tap === null) return void 0;
				const timer = window.setTimeout(() => setTap(null), TAP_LINE_MS);
				return () => window.clearTimeout(timer);
			}, [tap]);
			(0, react.useEffect)(() => {
				const onResize = () => forceLayout((n) => n + 1);
				window.addEventListener("resize", onResize);
				return () => window.removeEventListener("resize", onResize);
			}, []);
			if (state === void 0 || !state.settings.enabled) return null;
			const { settings, pet, activity } = state;
			const height = settings.size;
			const width = Math.round(settings.size * PET_ASPECT);
			const pos = clampInset(drag?.right ?? settings.right, drag?.bottom ?? settings.bottom, width, height);
			const onPointerDown = (e) => {
				if (e.button !== 0) return;
				e.currentTarget.setPointerCapture(e.pointerId);
				dragRef.current = {
					x: e.clientX,
					y: e.clientY,
					right: pos.right,
					bottom: pos.bottom,
					moved: false
				};
			};
			const onPointerMove = (e) => {
				const d = dragRef.current;
				if (d === null) return;
				const dx = e.clientX - d.x;
				const dy = e.clientY - d.y;
				if (!d.moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
				d.moved = true;
				setDrag(clampInset(d.right - dx, d.bottom - dy, width, height));
			};
			const onPointerUp = () => {
				const d = dragRef.current;
				dragRef.current = null;
				if (d === null) return;
				if (d.moved) {
					if (drag !== null) props.store.patchSettings({
						right: Math.round(drag.right),
						bottom: Math.round(drag.bottom)
					});
					setDrag(null);
					return;
				}
				handleRef.current?.tap();
				const n = tapCount.current++;
				setTap({
					text: tapLine(pet.name, n),
					n
				});
			};
			const notify = (text) => {
				const n = tapCount.current++;
				setTap({
					text,
					n
				});
			};
			const onPrompt = (text) => {
				props.composer(text).then((result) => notify(t("notice." + result)));
			};
			const onResize = (delta) => {
				const size = Math.min(SETTINGS_LIMITS.size.max, Math.max(SETTINGS_LIMITS.size.min, settings.size + delta));
				props.store.patchSettings({ size });
			};
			const onReady = (handle) => {
				if (pet.kind !== "3d" || pet.previewUrl !== void 0 || pet.builtin || thumbnailed.current.has(pet.id)) return;
				thumbnailed.current.add(pet.id);
				const dataUrl = handle.snapshot();
				if (dataUrl === void 0) return;
				thumbnailFrom(dataUrl).then(async (blob) => {
					if (blob === void 0) return;
					if ((await api.setPreview(pet.id, blob)).ok) await props.store.refreshPets();
				});
			};
			const statusLine = settings.bubbles && activity.phase !== "idle" ? activityLine(activity, pet.name) : void 0;
			const bubble = tap?.text ?? statusLine;
			const place = bubbleLayout(height, headTop, pos.bottom, window.innerHeight);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: dpet_module_css_default.float,
				style: {
					right: pos.right,
					bottom: pos.bottom,
					width,
					height,
					opacity: settings.opacity
				},
				"data-dpet-floating": pet.id,
				children: [bubble !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: dpet_module_css_default.bubble,
					style: {
						...place.bottom === void 0 ? { top: place.top } : { bottom: place.bottom },
						fontSize: place.fontSize,
						maxWidth: place.maxWidth
					},
					children: bubble
				}, bubble), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: dpet_module_css_default.floatStage,
					onPointerDown,
					onPointerMove,
					onPointerUp,
					onPointerCancel: () => {
						dragRef.current = null;
						setDrag(null);
					},
					onContextMenu: (e) => {
						e.preventDefault();
						setMenu({
							x: e.clientX,
							y: e.clientY
						});
					},
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PetStage, {
						pet,
						phase: activity.phase,
						motions: settings.motions,
						lookAtCursor: settings.lookAtCursor,
						style: {
							width: "100%",
							height: "100%"
						},
						onHandle: (handle) => {
							handleRef.current = handle;
						},
						onReady,
						onLayout: setHeadTop
					})
				})]
			}), menu !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PetMenu, {
				x: menu.x,
				y: menu.y,
				onPrompt,
				onResize,
				onHome: () => props.store.patchSettings(HOME),
				onClose: () => setMenu(null)
			})] });
		}
		//#endregion
		//#region src/client/hooks/useImportFlow.ts
		/**
		* The import flow of the settings page, as a hook (the React counterpart of
		* a Vue composable): still pictures first go through a before / after review
		* of the background removal; models and GIFs upload directly; a freshly
		* imported 3D model gets its gallery thumbnail captured from the preview
		* stage once it is on screen.
		* @module dsh-dpet/client/hooks/useImportFlow
		*/
		/**
		* @param store - the client store (refreshed after imports).
		* @param onImported - called with the new pet id so the page can select it.
		*/
		function useImportFlow(store, onImported) {
			const [review, setReview] = (0, react.useState)(void 0);
			const [progress, setProgress] = (0, react.useState)(void 0);
			const pendingThumbnail = (0, react.useRef)(void 0);
			const release = (current) => {
				if (current === void 0) return;
				URL.revokeObjectURL(current.originalUrl);
				if (current.cleanedUrl !== void 0) URL.revokeObjectURL(current.cleanedUrl);
			};
			const upload = async (file, name, background) => {
				const base = {
					status: "uploading",
					file: file.name,
					size: file.size,
					progress: 0,
					steps: []
				};
				setProgress(base);
				const result = await api.importFile(file, name, background, (ratio) => {
					setProgress((current) => current === void 0 ? current : {
						...current,
						progress: ratio,
						status: ratio >= 1 ? "processing" : "uploading"
					});
				});
				if (!result.ok) {
					setProgress({
						...base,
						status: "error",
						progress: 1,
						error: errorText(result.error)
					});
					return;
				}
				setProgress({
					...base,
					status: "done",
					progress: 1,
					steps: reportSteps(result.report),
					name: result.pet.name
				});
				await store.refreshPets();
				onImported(result.pet.id);
				if (result.pet.kind === "3d") pendingThumbnail.current = result.pet.id;
			};
			const startReview = async (file) => {
				release(review);
				setProgress(void 0);
				const originalUrl = URL.createObjectURL(file);
				setReview({
					file,
					name: nameOf(file),
					originalUrl,
					choice: "remove"
				});
				const result = await api.previewImport(file);
				setReview((current) => {
					if (current === void 0 || current.originalUrl !== originalUrl) return current;
					if (!result.ok) return {
						...current,
						error: result.error,
						choice: "keep"
					};
					return {
						...current,
						cleanedUrl: URL.createObjectURL(result.image),
						report: result.report,
						choice: result.report.background === "removed" ? "remove" : "keep"
					};
				});
			};
			return {
				review,
				progress,
				start(file) {
					if (REVIEWABLE.test(file.name)) startReview(file);
					else upload(file, nameOf(file), "remove");
				},
				choose(choice) {
					setReview((current) => current === void 0 ? current : {
						...current,
						choice
					});
				},
				rename(name) {
					setReview((current) => current === void 0 ? current : {
						...current,
						name
					});
				},
				confirm() {
					const current = review;
					if (current === void 0) return;
					release(current);
					setReview(void 0);
					upload(current.file, current.name.trim(), current.choice);
				},
				cancel() {
					release(review);
					setReview(void 0);
				},
				dismiss() {
					setProgress(void 0);
				},
				stageReady(handle, petId) {
					if (pendingThumbnail.current === void 0 || pendingThumbnail.current !== petId) return;
					pendingThumbnail.current = void 0;
					const dataUrl = handle.snapshot();
					if (dataUrl === void 0) return;
					thumbnailFrom(dataUrl).then(async (blob) => {
						if (blob === void 0) return;
						if (!(await api.setPreview(petId, blob)).ok) return;
						await store.refreshPets();
						setProgress((current) => current === void 0 ? current : {
							...current,
							steps: [...current.steps, t("import.step.preview")]
						});
					});
				}
			};
		}
		//#endregion
		//#region src/client/components/common/Switch.tsx
		function Switch(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				role: "switch",
				"aria-checked": props.checked,
				"aria-label": props.label,
				className: dpet_module_css_default.switch,
				onClick: () => props.onChange(!props.checked)
			});
		}
		//#endregion
		//#region src/client/components/settings/PreviewStage.tsx
		/**
		* Settings: the live preview stage and the AI-state buttons under it.
		* @module dsh-dpet/client/components/settings/PreviewStage
		*/
		/** The bubble line each previewed state shows. */
		const PREVIEW_LINES = {
			idle: {},
			waiting: { line: "prepare" },
			thinking: { line: "thinking" },
			tool: {
				line: "tool",
				tool: "bash"
			},
			review: { line: "writing" },
			done: { line: "done" },
			failed: { line: "failed" }
		};
		function PreviewStage(props) {
			const handle = (0, react.useRef)(void 0);
			const line = activityLine(PREVIEW_LINES[props.phase], props.pet.name);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: dpet_module_css_default.stageBox,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(PetStage, {
						className: dpet_module_css_default.stage,
						pet: props.pet,
						phase: props.phase,
						motions: props.motions,
						lookAtCursor: props.lookAtCursor,
						onHandle: (h) => {
							handle.current = h;
						},
						onReady: props.onReady
					}),
					line !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: dpet_module_css_default.stageBubble,
						children: line
					}, props.phase),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: dpet_module_css_default.stageTip,
						children: t("stage.tip")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						"aria-label": t("stage.tip"),
						style: {
							position: "absolute",
							inset: "36px 0 0",
							background: "none",
							border: 0,
							cursor: "pointer"
						},
						onClick: () => handle.current?.tap()
					})
				]
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: dpet_module_css_default.chips,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: `${dpet_module_css_default.muted} ${dpet_module_css_default.small}`,
					children: t("stage.previewState")
				}), ACTIVITY_PHASES.map((phase) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: dpet_module_css_default.chip,
					"aria-pressed": phase === props.phase,
					onClick: () => props.onPhase(phase),
					children: t("phase." + phase)
				}, phase))]
			})] });
		}
		//#endregion
		//#region src/client/utils/pet-view.ts
		function isGif(pet) {
			return pet.kind === "2d" && /\.gif(\?|$)/i.test(pet.fileUrl);
		}
		/** The gallery badge: 3D, 2D or GIF. */
		function kindBadge(pet) {
			return pet.kind === "3d" ? "3D" : isGif(pet) ? "GIF" : "2D";
		}
		/** The thumbnail URL: the captured preview, or the picture itself for 2D pets. */
		function thumbOf(pet) {
			return pet.previewUrl ?? (pet.kind === "2d" ? pet.fileUrl : void 0);
		}
		//#endregion
		//#region src/client/components/settings/PetInfoCard.tsx
		/**
		* Settings: the card describing the selected pet, with use / rename / delete.
		* Render it with `key={pet.id}` so an unfinished rename never carries over
		* to another pet.
		* @module dsh-dpet/client/components/settings/PetInfoCard
		*/
		function PetInfoCard(props) {
			const { pet, store } = props;
			const [renaming, setRenaming] = (0, react.useState)(void 0);
			const saveName = (name) => {
				api.rename(pet.id, name).then(async () => {
					setRenaming(void 0);
					await store.refreshPets();
					store.refresh();
				});
			};
			const remove = () => {
				if (!window.confirm(t("info.confirmDelete", { name: pet.name }))) return;
				api.remove(pet.id).then(async () => {
					props.onDeleted();
					await store.refreshPets();
					store.refresh();
				});
			};
			const detail = [pet.bytes === void 0 ? void 0 : formatBytes(pet.bytes), pet.triangles === void 0 ? void 0 : t("info.triangles", { n: formatCount(pet.triangles) })].filter(Boolean).join(" · ");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: dpet_module_css_default.info,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [renaming === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: dpet_module_css_default.infoName,
						children: pet.name
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
						className: dpet_module_css_default.btns,
						onSubmit: (e) => {
							e.preventDefault();
							saveName(renaming);
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								className: dpet_module_css_default.input,
								value: renaming,
								maxLength: 32,
								autoFocus: true,
								onChange: (e) => setRenaming(e.target.value)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "submit",
								className: dpet_module_css_default.btn,
								children: t("info.renameSave")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: `${dpet_module_css_default.btn} ${dpet_module_css_default.btnGhost}`,
								onClick: () => setRenaming(void 0),
								children: t("info.renameCancel")
							})
						]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: `${dpet_module_css_default.muted} ${dpet_module_css_default.small}`,
						children: pet.description ?? t(pet.builtin ? "info.builtin" : "info.imported")
					})] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("dl", {
						className: dpet_module_css_default.kv,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("info.type") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: pet.kind === "3d" ? t("info.kind3d") : isGif(pet) ? t("info.kindGif") : t("info.kind2d") }),
							detail !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("info.detail") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: detail })] }),
							pet.source !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("info.source") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: pet.source })] }),
							pet.author !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("info.author") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: pet.author })] })
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: dpet_module_css_default.btns,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: dpet_module_css_default.btn,
							disabled: props.inUse,
							onClick: props.onUse,
							children: props.inUse ? t("info.using") : t("info.use")
						}), !pet.builtin && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: `${dpet_module_css_default.btn} ${dpet_module_css_default.btnGhost}`,
							onClick: () => setRenaming(pet.name),
							children: t("info.rename")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: `${dpet_module_css_default.btn} ${dpet_module_css_default.btnGhost} ${dpet_module_css_default.btnDanger}`,
							onClick: remove,
							children: t("info.delete")
						})] })]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("ul", {
						className: dpet_module_css_default.highlights,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: t("info.highlight3d") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: t("info.highlightAgent") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: t("info.highlight2d") })
						]
					})
				]
			});
		}
		//#endregion
		//#region src/client/components/settings/PetGallery.tsx
		/**
		* Settings: the pet gallery cards and the import card.
		* @module dsh-dpet/client/components/settings/PetGallery
		*/
		function PetGallery(props) {
			const fileInput = (0, react.useRef)(null);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: dpet_module_css_default.gallery,
				children: [
					props.pets.map((pet) => {
						const thumb = thumbOf(pet);
						return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
							type: "button",
							className: dpet_module_css_default.card,
							"aria-selected": pet.id === props.selectedId,
							onClick: () => props.onSelect(pet.id),
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: dpet_module_css_default.thumb,
									children: thumb === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: dpet_module_css_default.thumbEmpty,
										children: "3D"
									}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("img", {
										src: thumb,
										alt: "",
										draggable: false
									})
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: dpet_module_css_default.cardBody,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: dpet_module_css_default.cardTitle,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: pet.name }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: dpet_module_css_default.badge,
											children: kindBadge(pet)
										})]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: dpet_module_css_default.cardMeta,
										children: pet.bytes === void 0 ? t(pet.builtin ? "info.builtin" : "info.imported") : formatBytes(pet.bytes)
									})]
								}),
								pet.id === props.currentId && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: dpet_module_css_default.using,
									children: t("info.using")
								})
							]
						}, pet.id);
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
						type: "button",
						className: `${dpet_module_css_default.card} ${dpet_module_css_default.add} ${props.dropping ? dpet_module_css_default.addActive : ""}`,
						onClick: () => fileInput.current?.click(),
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: dpet_module_css_default.plus,
								children: "+"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: dpet_module_css_default.cardTitle,
								children: props.dropping ? t("gallery.drop") : t("gallery.add")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: dpet_module_css_default.cardMeta,
								children: [
									t("gallery.addHint"),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("br", {}),
									t("gallery.formats")
								]
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						ref: fileInput,
						type: "file",
						accept: ACCEPT,
						hidden: true,
						onChange: (e) => {
							const file = e.target.files?.[0];
							e.target.value = "";
							if (file !== void 0) props.onFile(file);
						}
					})
				]
			});
		}
		//#endregion
		//#region src/client/components/settings/ImportPanel.tsx
		function ImportPanel(props) {
			const { review, progress } = props.flow;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [review !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: dpet_module_css_default.import,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: dpet_module_css_default.importHead,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: t("import.review", { file: review.file.name }) })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: dpet_module_css_default.hint,
						style: { margin: "4px 0 10px" },
						children: t("import.reviewHint")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: dpet_module_css_default.review,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
							type: "button",
							className: dpet_module_css_default.tile,
							"aria-pressed": review.choice === "keep",
							onClick: () => props.flow.choose("keep"),
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: dpet_module_css_default.checker,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("img", {
									src: review.originalUrl,
									alt: "",
									draggable: false
								})
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("import.original") })]
						}), (review.report === void 0 ? review.error === void 0 : review.report.background === "removed") && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
							type: "button",
							className: dpet_module_css_default.tile,
							"aria-pressed": review.choice === "remove",
							disabled: review.cleanedUrl === void 0,
							onClick: () => props.flow.choose("remove"),
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: dpet_module_css_default.checker,
								children: review.cleanedUrl === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: dpet_module_css_default.muted,
									children: t("import.bg.working")
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("img", {
									src: review.cleanedUrl,
									alt: "",
									draggable: false
								})
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("import.cleaned") })]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: `${dpet_module_css_default.small} ${review.error === void 0 ? dpet_module_css_default.muted : dpet_module_css_default.importError}`,
						style: { marginTop: 8 },
						children: review.error !== void 0 ? errorText(review.error) : review.report === void 0 ? t("import.bg.working") : review.report.background === "removed" ? t("import.bg.removed", { color: review.report.backgroundColor ?? "" }) : review.report.background === "transparent" ? t("import.bg.transparent") : t("import.bg.not-uniform")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: dpet_module_css_default.btns,
						style: { marginTop: 12 },
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								className: dpet_module_css_default.input,
								value: review.name,
								maxLength: 32,
								"aria-label": t("import.name"),
								placeholder: t("import.name"),
								onChange: (e) => props.flow.rename(e.target.value)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: dpet_module_css_default.btn,
								disabled: review.error !== void 0 || review.report === void 0 || review.name.trim() === "",
								onClick: () => props.flow.confirm(),
								children: t("import.create")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: `${dpet_module_css_default.btn} ${dpet_module_css_default.btnGhost}`,
								onClick: () => props.flow.cancel(),
								children: t("import.cancel")
							})
						]
					})
				]
			}), progress !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: dpet_module_css_default.import,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: dpet_module_css_default.importHead,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("b", {
							className: progress.status === "error" ? dpet_module_css_default.importError : void 0,
							children: [
								progress.status === "uploading" && t("import.uploading", {
									file: progress.file,
									size: formatBytes(progress.size)
								}),
								progress.status === "processing" && t("import.processing"),
								progress.status === "done" && t("import.done", { name: progress.name ?? progress.file }),
								progress.status === "error" && t("import.failed", { reason: progress.error ?? "" })
							]
						}), (progress.status === "done" || progress.status === "error") && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: `${dpet_module_css_default.btn} ${dpet_module_css_default.btnGhost}`,
							onClick: () => props.flow.dismiss(),
							children: t("import.close")
						})]
					}),
					(progress.status === "uploading" || progress.status === "processing") && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: dpet_module_css_default.progress,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { style: { width: Math.round(progress.progress * 100) + "%" } })
					}),
					progress.steps.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ol", {
						className: dpet_module_css_default.importSteps,
						children: progress.steps.map((step) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: step }, step))
					})
				]
			})] });
		}
		//#endregion
		//#region src/client/components/settings/MotionEditor.tsx
		function MotionEditor(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: dpet_module_css_default.section,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: dpet_module_css_default.head,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: dpet_module_css_default.grow,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: t("mapping.title") })
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: `${dpet_module_css_default.btn} ${dpet_module_css_default.btnGhost}`,
						onClick: props.onReset,
						children: t("mapping.reset")
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: dpet_module_css_default.mapping,
					children: ACTIVITY_PHASES.map((phase) => {
						const current = motionForPhase(phase, props.motions);
						return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: dpet_module_css_default.mapRow,
							"data-live": phase === props.livePhase,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: dpet_module_css_default.mapState,
								children: t("phase." + phase)
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: dpet_module_css_default.mapMotions,
								children: PET_MOTIONS.map((motion) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: dpet_module_css_default.chip,
									"aria-pressed": motion === current,
									onClick: () => props.onPick(phase, motion),
									children: t("motion." + motion)
								}, motion))
							})]
						}, phase);
					})
				})]
			});
		}
		//#endregion
		//#region src/client/components/settings/PlacementPanel.tsx
		/**
		* Settings: where the pet sits (drag it in a scaled-down window), its size
		* and opacity, and the look-at-cursor / status-bubble switches.
		* @module dsh-dpet/client/components/settings/PlacementPanel
		*/
		function PlacementPanel(props) {
			const { settings, patch } = props;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: dpet_module_css_default.section,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: t("place.title") }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: dpet_module_css_default.hint,
						children: t("place.hint")
					}),
					prefersReducedMotion() && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: dpet_module_css_default.hint,
						children: t("place.reducedMotion")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: dpet_module_css_default.place,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(MiniScreen, {
							pet: props.pet,
							settings,
							onMove: (right, bottom) => patch({
								right,
								bottom
							})
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: dpet_module_css_default.controls,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: t("place.position", {
									right: settings.right,
									bottom: settings.bottom
								}) }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: dpet_module_css_default.row,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
											htmlFor: "dpet-size",
											children: t("place.size")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											id: "dpet-size",
											type: "range",
											min: SETTINGS_LIMITS.size.min,
											max: SETTINGS_LIMITS.size.max,
											value: settings.size,
											onChange: (e) => patch({ size: Number(e.target.value) })
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("output", { children: [settings.size, " px"] })
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: dpet_module_css_default.row,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
											htmlFor: "dpet-opacity",
											children: t("place.opacity")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											id: "dpet-opacity",
											type: "range",
											min: SETTINGS_LIMITS.opacity.min * 100,
											max: 100,
											value: Math.round(settings.opacity * 100),
											onChange: (e) => patch({ opacity: Number(e.target.value) / 100 })
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("output", { children: [Math.round(settings.opacity * 100), "%"] })
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: dpet_module_css_default.toggle,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [t("place.look"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: t("place.lookHint") })] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Switch, {
										checked: settings.lookAtCursor,
										label: t("place.look"),
										onChange: (lookAtCursor) => patch({ lookAtCursor })
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: dpet_module_css_default.toggle,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [t("place.bubbles"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: t("place.bubblesHint") })] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Switch, {
										checked: settings.bubbles,
										label: t("place.bubbles"),
										onChange: (bubbles) => patch({ bubbles })
									})]
								})
							]
						})]
					})
				]
			});
		}
		/** A scaled-down window where the pet can be dragged into place. */
		function MiniScreen(props) {
			const boxRef = (0, react.useRef)(null);
			const dragRef = (0, react.useRef)(null);
			const [box, setBox] = (0, react.useState)({
				w: 400,
				h: 200
			});
			(0, react.useEffect)(() => {
				const el = boxRef.current;
				if (el === null || typeof ResizeObserver === "undefined") return void 0;
				const observer = new ResizeObserver(() => setBox({
					w: el.clientWidth,
					h: el.clientHeight
				}));
				observer.observe(el);
				return () => observer.disconnect();
			}, []);
			const vw = Math.max(1, window.innerWidth);
			const vh = Math.max(1, window.innerHeight);
			const sx = box.w / vw;
			const sy = box.h / vh;
			const height = Math.max(20, props.settings.size * sy);
			const width = height * PET_ASPECT;
			const thumb = thumbOf(props.pet);
			const onPointerDown = (e) => {
				e.currentTarget.setPointerCapture(e.pointerId);
				dragRef.current = {
					x: e.clientX,
					y: e.clientY,
					right: props.settings.right,
					bottom: props.settings.bottom
				};
			};
			const onPointerMove = (e) => {
				const d = dragRef.current;
				if (d === null) return;
				const petW = props.settings.size * PET_ASPECT;
				const right = Math.min(Math.max(0, d.right - (e.clientX - d.x) / sx), Math.max(0, vw - petW));
				const bottom = Math.min(Math.max(0, d.bottom - (e.clientY - d.y) / sy), Math.max(0, vh - props.settings.size));
				props.onMove(Math.round(right), Math.round(bottom));
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				ref: boxRef,
				className: dpet_module_css_default.screen,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: dpet_module_css_default.screenLabel,
						children: t("place.window")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: dpet_module_css_default.fakeLines }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: dpet_module_css_default.miniPet,
						style: {
							right: props.settings.right * sx,
							bottom: props.settings.bottom * sy,
							width,
							height,
							opacity: props.settings.opacity,
							...thumb === void 0 ? {
								background: "var(--dsw-alias-label-dimmed, #98a2b3)",
								borderRadius: 8
							} : { backgroundImage: `url("${thumb}")` }
						},
						onPointerDown,
						onPointerMove,
						onPointerUp: () => {
							dragRef.current = null;
						},
						onPointerCancel: () => {
							dragRef.current = null;
						}
					})
				]
			});
		}
		//#endregion
		//#region src/client/components/settings/ComingSoonCard.tsx
		const STEPS = [
			"1",
			"2",
			"3",
			"4"
		];
		function ComingSoonCard() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: dpet_module_css_default.road,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: dpet_module_css_default.roadHead,
						children: [t("roadmap.title"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: dpet_module_css_default.tag,
							children: t("roadmap.tag")
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: dpet_module_css_default.hint,
						style: { margin: "6px 0 0" },
						children: t("roadmap.hint")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: dpet_module_css_default.flow,
						children: STEPS.map((n, i) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							style: { display: "contents" },
							children: [i > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: dpet_module_css_default.muted,
								children: "→"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: dpet_module_css_default.step,
								children: [t("roadmap.step" + n), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: t("roadmap.step" + n + "Hint") })]
							})]
						}, n))
					})
				]
			});
		}
		//#endregion
		//#region src/client/views/SettingsPage.tsx
		/**
		* The "桌宠" settings page. It only holds page-level state (which pet is
		* previewed, which AI state is previewed, drag-and-drop) and lays out the
		* section components under ../components/settings/.
		* @module dsh-dpet/client/views/SettingsPage
		*/
		function SettingsPage(props) {
			const { store } = props;
			const { state, pets } = useDpet(store);
			const [selectedId, setSelectedId] = (0, react.useState)(void 0);
			const [previewPhase, setPreviewPhase] = (0, react.useState)("idle");
			const [dropping, setDropping] = (0, react.useState)(false);
			const flow = useImportFlow(store, setSelectedId);
			(0, react.useEffect)(() => {
				store.refresh();
				store.refreshPets();
			}, [store]);
			if (state === void 0 || pets === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: dpet_module_css_default.page,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: dpet_module_css_default.muted,
					children: "…"
				})
			});
			const { settings } = state;
			const selected = pets.find((p) => p.id === selectedId) ?? state.pet;
			const patch = (value) => store.patchSettings(value);
			const onDrop = (e) => {
				e.preventDefault();
				setDropping(false);
				const file = e.dataTransfer.files[0];
				if (file !== void 0) flow.start(file);
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: dpet_module_css_default.page,
				onDragOver: (e) => {
					e.preventDefault();
					setDropping(true);
				},
				onDragLeave: (e) => {
					if (e.currentTarget === e.target) setDropping(false);
				},
				onDrop,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: dpet_module_css_default.head,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: dpet_module_css_default.grow,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", { children: t("settings.title") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: dpet_module_css_default.sub,
								children: t("settings.subtitle")
							})]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: dpet_module_css_default.switchRow,
							children: [t("settings.enabled"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Switch, {
								checked: settings.enabled,
								label: t("settings.enabled"),
								onChange: (enabled) => patch({ enabled })
							})]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: dpet_module_css_default.hero,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(PreviewStage, {
							pet: selected,
							phase: previewPhase,
							onPhase: setPreviewPhase,
							motions: settings.motions,
							lookAtCursor: settings.lookAtCursor,
							onReady: (handle) => flow.stageReady(handle, selected.id)
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PetInfoCard, {
							pet: selected,
							inUse: selected.id === state.pet.id,
							store,
							onUse: () => patch({
								petId: selected.id,
								enabled: true
							}),
							onDeleted: () => setSelectedId(void 0)
						}, selected.id)]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						className: dpet_module_css_default.section,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: t("gallery.title") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: dpet_module_css_default.hint,
								children: t("gallery.hint")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(PetGallery, {
								pets,
								selectedId: selected.id,
								currentId: state.pet.id,
								dropping,
								onSelect: setSelectedId,
								onFile: (file) => flow.start(file)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ImportPanel, { flow })
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(MotionEditor, {
						motions: settings.motions,
						livePhase: previewPhase,
						onPick: (phase, motion) => {
							patch({ motions: {
								...settings.motions,
								[phase]: motion
							} });
							setPreviewPhase(phase);
						},
						onReset: () => patch({ motions: {} })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(PlacementPanel, {
						pet: state.pet,
						settings,
						patch
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ComingSoonCard, {})
				]
			});
		}
		//#endregion
		//#region src/client/index.ts
		/**
		* DPet browser half — runs inside the DSH web GUI.
		*
		* Mounts the floating pet as a page-global surface (it must survive session
		* switches and the new-conversation screen, so it lives on document.body,
		* not in a session-scoped slot) and seats the "桌宠" page in the settings
		* navigation. The pet's menu reaches the DSH input box through the sessions
		* service, looked up lazily so the pet never depends on it to appear.
		* @module dsh-dpet/client
		*/
		/** Client services the plugin needs. */
		const inject = ["slots"];
		/** Settings navigation position: right after the built-in sections. */
		const SECTION_ORDER = 130;
		function apply(ctx) {
			const store = createDpetStore();
			store.start();
			for (const stale of Array.from(document.querySelectorAll("div[data-dsh-plugin=\"dpet\"]"))) stale.remove();
			const container = document.createElement("div");
			container.dataset.dshPlugin = "dpet";
			document.body.appendChild(container);
			const root = (0, react_dom_client.createRoot)(container);
			const composer = createComposer(() => {
				try {
					return ctx.get("sessions");
				} catch {
					return;
				}
			});
			root.render((0, react.createElement)(FloatingPet, {
				store,
				composer
			}));
			const Section = () => (0, react.createElement)(SettingsPage, { store });
			ctx.slots.inject("settings.section", () => {
				try {
					return ctx.slots.register({
						name: "settings.section",
						id: "dpet",
						order: SECTION_ORDER,
						label: () => t("settings.title")
					}, Section);
				} catch {
					return () => {};
				}
			});
			ctx.effect(() => () => {
				root.unmount();
				container.remove();
				store.stop();
			}, "dpet: floating pet");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map