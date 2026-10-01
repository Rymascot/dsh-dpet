import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { readFile, stat } from "node:fs/promises";
import { defineTool } from "@deepseek-ai/dsh-tools";
function record(value) {
	return typeof value === "object" && value !== null ? value : {};
}
/**
* Map one durable session event onto a transition; undefined leaves the
* current phase alone (log-only and unknown events).
*/
function projectSessionEvent(event, runtime) {
	const data = record(event.data);
	switch (event.type) {
		case "turn/start":
			runtime.openTools.clear();
			return {
				phase: "waiting",
				line: "prepare"
			};
		case "step/start":
			runtime.openTools.clear();
			return {
				phase: "waiting",
				line: "waiting"
			};
		case "assistant/message": return {
			phase: "review",
			line: "writing"
		};
		case "tool/call": {
			const name = typeof data.name === "string" ? data.name : "";
			runtime.openTools.set(String(data.callId ?? runtime.openTools.size), name);
			return {
				phase: "tool",
				line: "tool",
				tool: name
			};
		}
		case "tool/result": {
			const message = record(data.message);
			runtime.openTools.delete(String(message.toolCallId ?? data.callId ?? ""));
			const failed = data.error !== void 0 || message.isError === true;
			const remaining = [...runtime.openTools.values()];
			if (remaining.length > 0) return {
				phase: "tool",
				line: "tool",
				tool: remaining.at(-1)
			};
			return failed ? {
				phase: "thinking",
				line: "toolRetry"
			} : {
				phase: "thinking",
				line: "thinking"
			};
		}
		case "turn/end":
			runtime.openTools.clear();
			switch (record(data.reason).kind) {
				case "completed": return {
					phase: "done",
					line: "done"
				};
				case "error":
				case "max-tokens": return {
					phase: "failed",
					line: "failed"
				};
				case "blocked": return {
					phase: "waiting",
					line: "blocked"
				};
				case "interrupted": return {
					phase: "idle",
					line: "interrupted"
				};
				default: return { phase: "idle" };
			}
		default: return;
	}
}
/** Map one live stream frame: reasoning keeps the pet thinking, text means it is writing. */
function projectStreamFrame(frame) {
	if (frame.type !== "chunk" || frame.chunk === void 0) return void 0;
	const { type, text } = frame.chunk;
	if (typeof text !== "string" || text.length === 0) return void 0;
	if (type === "reasoning-delta") return {
		phase: "thinking",
		line: "thinking"
	};
	if (type === "text-delta") return {
		phase: "review",
		line: "writing"
	};
}
/** Tracks every live session and exposes the one the pet should follow. */
var ActivityTracker = class {
	now;
	sessions = /* @__PURE__ */ new Map();
	current;
	currentSession;
	/** Last time any event refreshed the current phase (stale detection). */
	touchedAt = 0;
	constructor(now = Date.now) {
		this.now = now;
		this.current = {
			phase: "idle",
			since: now()
		};
	}
	runtimeOf(sessionId) {
		let runtime = this.sessions.get(sessionId);
		if (runtime === void 0) {
			runtime = { openTools: /* @__PURE__ */ new Map() };
			this.sessions.set(sessionId, runtime);
		}
		return runtime;
	}
	apply(sessionId, transition) {
		if (transition === void 0) return;
		const at = this.now();
		const same = this.current.phase === transition.phase && this.current.line === transition.line && this.current.tool === transition.tool;
		this.currentSession = sessionId;
		this.current = {
			phase: transition.phase,
			since: same ? this.current.since : at,
			...transition.line === void 0 ? {} : { line: transition.line },
			...transition.tool === void 0 ? {} : { tool: transition.tool }
		};
		this.touchedAt = at;
	}
	/** Feed one durable `session/event`. */
	onSessionEvent(sessionId, event) {
		this.apply(sessionId, projectSessionEvent(event, this.runtimeOf(sessionId)));
	}
	/** Feed one `agent/assistant-stream` frame. */
	onStreamFrame(sessionId, frame) {
		this.apply(sessionId, projectStreamFrame(frame));
	}
	/** Forget a disposed session; if the pet was following it, settle to idle. */
	onSessionDisposed(sessionId) {
		this.sessions.delete(sessionId);
		if (this.currentSession === sessionId) {
			this.currentSession = void 0;
			this.current = {
				phase: "idle",
				since: this.now()
			};
		}
	}
	/** The phase to show right now (terminal and stale phases settle to idle). */
	snapshot() {
		const now = this.now();
		const { phase } = this.current;
		if (phase === "done" || phase === "failed" ? now - this.current.since > 5e3 : phase !== "idle" && now - Math.max(this.touchedAt, this.current.since) > 6e5) {
			this.current = {
				phase: "idle",
				since: now
			};
			this.currentSession = void 0;
		}
		return { ...this.current };
	}
};
//#endregion
//#region src/server/common/files.ts
/**
* Small filesystem helpers shared by the host modules.
* @module dsh-dpet/server/common/files
*/
/** Write a file atomically (temp file + rename), creating parent directories. */
function writeFileAtomic(file, data) {
	mkdirSync(dirname(file), { recursive: true });
	const temp = file + "." + process.pid + ".tmp";
	writeFileSync(temp, data);
	renameSync(temp, file);
}
/** The DSH home directory: $DSH_HOME when set, else ~/.dsh. */
function resolveDshHome(env = process.env, home = homedir()) {
	const raw = env.DSH_HOME?.trim();
	if (raw === void 0 || raw === "") return join(home, ".dsh");
	const expanded = raw === "~" ? home : raw.startsWith("~/") || raw.startsWith("~\\") ? join(home, raw.slice(2)) : raw;
	return isAbsolute(expanded) ? expanded : resolve(expanded);
}
//#endregion
//#region src/server/repository/library.ts
/**
* Pet library — the built-in pets shipped under `assets/pets/` plus the
* user's imported pets under `$DSH_HOME/dpet/pets/`. Each pet is one
* directory holding a `pet.json` manifest, the model or image it names, and
* an optional `preview.png` thumbnail. Only those files are ever served.
* @module dsh-dpet/server/repository/library
*/
/** Browser prefix the asset route serves pet files under. */
const PET_FILE_PREFIX = "/dpet/pets";
/** Name of the optional thumbnail file. */
const PREVIEW_FILE = "preview.png";
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FILE_PATTERN = /^[A-Za-z0-9._-]+\.(glb|png|jpg|jpeg|webp|gif)$/i;
const NAME_MAX = 32;
/** Validate an untrusted manifest; undefined when it is unusable. */
function parseManifest(raw, dirName) {
	if (typeof raw !== "object" || raw === null) return void 0;
	const m = raw;
	if (typeof m.id !== "string" || !ID_PATTERN.test(m.id) || m.id !== dirName) return void 0;
	if (typeof m.name !== "string" || m.name.trim() === "") return void 0;
	if (m.kind !== "3d" && m.kind !== "2d") return void 0;
	if (typeof m.file !== "string" || !FILE_PATTERN.test(m.file)) return void 0;
	if (m.kind === "3d" !== m.file.toLowerCase().endsWith(".glb")) return void 0;
	const optionalString = (value) => typeof value === "string" && value !== "" ? value : void 0;
	const optionalNumber = (value) => typeof value === "number" && Number.isFinite(value) ? value : void 0;
	const manifest = {
		id: m.id,
		name: m.name.trim().slice(0, NAME_MAX),
		kind: m.kind,
		file: m.file
	};
	const description = optionalString(m.description);
	const author = optionalString(m.author);
	const source = optionalString(m.source);
	const bytes = optionalNumber(m.bytes);
	const triangles = optionalNumber(m.triangles);
	const createdAt = optionalNumber(m.createdAt);
	if (description !== void 0) manifest.description = description;
	if (author !== void 0) manifest.author = author;
	if (source !== void 0) manifest.source = source;
	if (bytes !== void 0) manifest.bytes = bytes;
	if (triangles !== void 0) manifest.triangles = triangles;
	if (createdAt !== void 0) manifest.createdAt = createdAt;
	return manifest;
}
/** Turn a display name into a directory id; falls back to a time-based id. */
function idFromName(name, taken, now = Date.now()) {
	const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
	const base = slug === "" ? "pet-" + now.toString(36) : slug;
	let id = base;
	for (let n = 2; taken(id); n += 1) id = base + "-" + n;
	return id;
}
/** Trim and bound a user-supplied display name. */
function cleanName(name) {
	if (typeof name !== "string") return void 0;
	const trimmed = name.replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
	return trimmed === "" ? void 0 : trimmed;
}
var PetLibrary = class {
	dirs;
	constructor(dirs) {
		this.dirs = dirs;
	}
	scan(root, builtin) {
		let names;
		try {
			names = readdirSync(root).filter((name) => !name.startsWith(".")).sort();
		} catch {
			return [];
		}
		const entries = [];
		for (const name of names) {
			const dir = join(root, name);
			let raw;
			try {
				raw = JSON.parse(readFileSync(join(dir, "pet.json"), "utf8"));
			} catch {
				continue;
			}
			const manifest = parseManifest(raw, name);
			if (manifest === void 0 || !existsSync(join(dir, manifest.file))) continue;
			entries.push({
				manifest,
				dir,
				builtin,
				hasPreview: existsSync(join(dir, PREVIEW_FILE))
			});
		}
		return entries;
	}
	/** Every usable pet: built-ins first, then imports (a user pet cannot shadow a built-in id). */
	list() {
		const builtin = this.scan(this.dirs.builtin, true);
		const ids = new Set(builtin.map((entry) => entry.manifest.id));
		return [...builtin, ...this.scan(this.dirs.user, false).filter((entry) => !ids.has(entry.manifest.id))];
	}
	get(id) {
		return this.list().find((entry) => entry.manifest.id === id);
	}
	has(id) {
		return existsSync(join(this.dirs.builtin, id)) || existsSync(join(this.dirs.user, id));
	}
	/** Browser view of one entry. */
	view(entry) {
		const m = entry.manifest;
		const base = "/dpet/pets/" + encodeURIComponent(m.id) + "/";
		let version = "";
		try {
			version = "?v=" + Math.round(statSync(join(entry.dir, m.file)).mtimeMs).toString(36);
		} catch {}
		let previewVersion = "";
		if (entry.hasPreview) try {
			previewVersion = "?v=" + Math.round(statSync(join(entry.dir, PREVIEW_FILE)).mtimeMs).toString(36);
		} catch {}
		return {
			id: m.id,
			name: m.name,
			kind: m.kind,
			fileUrl: base + encodeURIComponent(m.file) + version,
			...entry.hasPreview ? { previewUrl: base + PREVIEW_FILE + previewVersion } : {},
			builtin: entry.builtin,
			...m.description === void 0 ? {} : { description: m.description },
			...m.author === void 0 ? {} : { author: m.author },
			...m.source === void 0 ? {} : { source: m.source },
			...m.bytes === void 0 ? {} : { bytes: m.bytes },
			...m.triangles === void 0 ? {} : { triangles: m.triangles },
			...m.createdAt === void 0 ? {} : { createdAt: m.createdAt }
		};
	}
	/**
	* Resolve a servable file of a pet: only the manifest's own file and the
	* preview thumbnail; anything else (including traversal attempts) is
	* undefined.
	*/
	servableFile(id, file) {
		const entry = this.get(id);
		if (entry === void 0) return void 0;
		if (basename(file) !== file) return void 0;
		if (file === entry.manifest.file) return join(entry.dir, file);
		if (file === "preview.png" && entry.hasPreview) return join(entry.dir, PREVIEW_FILE);
	}
	/** Create a user pet from already-processed bytes. */
	create(manifest, data) {
		const id = manifest.id ?? idFromName(manifest.name, (candidate) => this.has(candidate));
		const dir = join(this.dirs.user, id);
		const full = {
			...manifest,
			id
		};
		writeFileAtomic(join(dir, full.file), data);
		writeFileAtomic(join(dir, "pet.json"), JSON.stringify(full, null, 2) + "\n");
		return {
			manifest: full,
			dir,
			builtin: false,
			hasPreview: false
		};
	}
	/** Rename a user pet. */
	rename(id, name) {
		const entry = this.userEntry(id);
		const manifest = {
			...entry.manifest,
			name
		};
		writeFileAtomic(join(entry.dir, "pet.json"), JSON.stringify(manifest, null, 2) + "\n");
		return {
			...entry,
			manifest
		};
	}
	/** Store a PNG thumbnail for a user pet. */
	setPreview(id, png) {
		const entry = this.userEntry(id);
		writeFileAtomic(join(entry.dir, PREVIEW_FILE), png);
		return {
			...entry,
			hasPreview: true
		};
	}
	/** Delete a user pet directory. */
	remove(id) {
		const entry = this.userEntry(id);
		rmSync(entry.dir, {
			recursive: true,
			force: true
		});
	}
	userEntry(id) {
		const entry = this.get(id);
		if (entry === void 0) throw new Error("pet-not-found");
		if (entry.builtin) throw new Error("builtin-pet");
		return entry;
	}
};
//#endregion
//#region src/server/common/http.ts
/**
* HTTP plumbing for the DPet routes: access control, bounded body readers,
* JSON and file responses.
*
* Access: every route is loopback-only (socket address AND Host header), and
* state-changing requests additionally require a same-origin Origin header
* when the browser sends one, so a web page on another site cannot drive
* the import or settings endpoints through the user's browser.
* @module dsh-dpet/server/common/http
*/
function isIPv4Loopback(v4) {
	const parts = v4.split(".");
	return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
/** Whether a socket address is in the loopback range (127/8, ::1, IPv4-mapped). */
function isLoopbackAddress(address) {
	if (address === void 0) return false;
	const a = address.toLowerCase();
	if (a === "::1") return true;
	if (a.startsWith("::ffff:")) return isIPv4Loopback(a.slice(7));
	return isIPv4Loopback(a);
}
/** Whether a URL hostname names the loopback host. */
function isLoopbackHostname(hostname) {
	return hostname === "localhost" || hostname === "[::1]" || isIPv4Loopback(hostname);
}
/**
* Loopback-only access check, plus a same-origin check for writes.
* @returns undefined when allowed, else the reason.
*/
function accessProblem(req) {
	if (!isLoopbackAddress(req.socket.remoteAddress)) return "loopback-only";
	const host = req.headers.host;
	if (typeof host !== "string") return "missing-host";
	let hostname;
	try {
		hostname = new URL("http://" + host).hostname;
	} catch {
		return "bad-host";
	}
	if (!isLoopbackHostname(hostname)) return "loopback-only";
	if (req.method !== "GET" && req.method !== "HEAD") {
		const origin = req.headers.origin;
		if (origin !== void 0) {
			let originHost;
			try {
				originHost = new URL(origin).host;
			} catch {
				return "bad-origin";
			}
			if (originHost !== host) return "cross-origin";
		}
	}
}
/** Send a JSON body. */
function writeJson(res, status, value) {
	const body = Buffer.from(JSON.stringify(value), "utf8");
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": String(body.byteLength),
		"cache-control": "no-store"
	});
	res.end(body);
}
/** Read a request body up to a byte ceiling; rejects with 'body-too-large' beyond it. */
function readBody(req, maxBytes) {
	return new Promise((resolve, reject) => {
		const declared = Number(req.headers["content-length"]);
		if (Number.isFinite(declared) && declared > maxBytes) {
			reject(/* @__PURE__ */ new Error("body-too-large"));
			req.resume();
			return;
		}
		const chunks = [];
		let size = 0;
		let failed = false;
		req.on("data", (chunk) => {
			if (failed) return;
			size += chunk.byteLength;
			if (size > maxBytes) {
				failed = true;
				reject(/* @__PURE__ */ new Error("body-too-large"));
				req.resume();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (!failed) resolve(Buffer.concat(chunks));
		});
		req.on("error", (error) => {
			if (!failed) reject(error);
		});
	});
}
/** Read and parse a small JSON body ({} when empty). */
async function readJson(req, maxBytes = 16384) {
	const data = await readBody(req, maxBytes);
	if (data.byteLength === 0) return {};
	const parsed = JSON.parse(Buffer.from(data).toString("utf8"));
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("invalid-json");
	return parsed;
}
const MIME = {
	".glb": "model/gltf-binary",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".js": "application/javascript; charset=utf-8",
	".map": "application/json"
};
/** Content type by extension (octet-stream fallback). */
function mimeOf(file) {
	const dot = file.lastIndexOf(".");
	return (dot < 0 ? void 0 : MIME[file.slice(dot).toLowerCase()]) ?? "application/octet-stream";
}
/** Serve one file with a weak validator so repeat loads settle as 304. */
async function sendFile(req, res, file) {
	let info;
	try {
		info = await stat(file);
		if (!info.isFile()) throw new Error("not-a-file");
	} catch {
		res.writeHead(404);
		res.end();
		return;
	}
	const etag = "\"" + info.size.toString(16) + "-" + Math.round(info.mtimeMs).toString(16) + "\"";
	if (req.headers["if-none-match"] === etag) {
		res.writeHead(304, { etag });
		res.end();
		return;
	}
	const body = await readFile(file);
	res.writeHead(200, {
		"content-type": mimeOf(file),
		"content-length": String(body.byteLength),
		"cache-control": "no-cache",
		etag
	});
	res.end(req.method === "HEAD" ? void 0 : body);
}
//#endregion
//#region src/server/service/background.ts
const ALPHA_SOLID = 16;
function median(values) {
	const sorted = values.slice().sort((a, b) => a - b);
	return sorted[sorted.length >> 1] ?? 0;
}
function hex(rgb) {
	return "#" + rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
}
/**
* Clear a uniform backdrop connected to the image border.
* @param rgba - straight RGBA pixels, modified in place.
* @param width - image width in px.
* @param height - image height in px.
*/
function removeUniformBackground(rgba, width, height, options = {}) {
	const fill = options.fill ?? 32;
	const feather = options.feather ?? 40;
	const agreement = options.agreement ?? .6;
	const total = width * height;
	if (width < 3 || height < 3) return { verdict: "not-uniform" };
	const border = [];
	for (let x = 0; x < width; x++) border.push(x, (height - 1) * width + x);
	for (let y = 1; y < height - 1; y++) border.push(y * width, y * width + width - 1);
	const solid = border.filter((i) => rgba[i * 4 + 3] >= ALPHA_SOLID);
	if (solid.length < border.length * .8) return { verdict: "transparent" };
	const bg = [
		0,
		1,
		2
	].map((c) => median(solid.map((i) => rgba[i * 4 + c])));
	const distance = (i) => {
		const o = i * 4;
		const dr = rgba[o] - bg[0];
		const dg = rgba[o + 1] - bg[1];
		const db = rgba[o + 2] - bg[2];
		return Math.sqrt(dr * dr + dg * dg + db * db);
	};
	if (solid.filter((i) => distance(i) <= fill).length < border.length * agreement) return {
		verdict: "not-uniform",
		color: hex(bg)
	};
	const state = new Uint8Array(total);
	const queue = new Int32Array(total);
	let head = 0;
	let tail = 0;
	for (const i of border) if (state[i] === 0 && distance(i) <= fill) {
		state[i] = 1;
		queue[tail++] = i;
	}
	const rim = [];
	const visit = (n) => {
		if (state[n] !== 0) return;
		if (distance(n) <= fill) {
			state[n] = 1;
			queue[tail++] = n;
		} else {
			state[n] = 2;
			rim.push(n);
		}
	};
	while (head < tail) {
		const i = queue[head++];
		const x = i % width;
		if (x > 0) visit(i - 1);
		if (x < width - 1) visit(i + 1);
		if (i >= width) visit(i - width);
		if (i < total - width) visit(i + width);
	}
	for (let k = 0; k < tail; k++) rgba[queue[k] * 4 + 3] = 0;
	for (const i of rim) {
		const a = Math.min(1, (distance(i) - fill) / feather);
		if (a >= 1) continue;
		const o = i * 4;
		for (let c = 0; c < 3; c++) {
			const value = (rgba[o + c] - bg[c] * (1 - a)) / Math.max(a, .05);
			rgba[o + c] = Math.min(255, Math.max(0, Math.round(value)));
		}
		rgba[o + 3] = Math.round(rgba[o + 3] * a);
	}
	return {
		verdict: "removed",
		color: hex(bg),
		clearedRatio: (tail + rim.length) / total
	};
}
//#endregion
//#region src/server/service/importer.ts
/**
* Import pipeline — turns an uploaded file into a pet-ready asset.
*
* 3D (.glb): AI image-to-3D tools emit meshes with a million-plus triangles
* and 4K textures (the Dongdong model arrived at 76 MB). A desktop pet is a
* few hundred pixels tall, so the pipeline welds and decimates the mesh to
* about 50k triangles and re-encodes textures as 1024 px WebP. The output
* stays uncompressed geometry (no Draco / meshopt) because the browser
* vendor bundle ships no decoders.
*
* 2D (.png/.jpg/.webp): a uniform backdrop (white paper, a studio color) is
* cleared to transparency (./background.ts), then transparent borders are
* trimmed and the image is bounded to 512 px. The caller may keep the
* backdrop instead. GIFs are kept byte-for-byte so their animation survives.
* @module dsh-dpet/server/service/importer
*/
/** Upload ceilings per kind. */
const IMPORT_LIMITS = {
	glb: 314572800,
	image: 20971520
};
/** Target triangle budget for imported models. */
const TARGET_TRIANGLES = 5e4;
/** Texture edge length after import. */
const TEXTURE_SIZE = 1024;
/** Working resolution for backdrop removal (twice the final edge, for clean rims). */
const WORK_EDGE = 1024;
/** Identify an upload by its magic bytes (the file name is only a hint). */
function sniffFormat(data) {
	const at = (i) => data[i] ?? -1;
	const ascii = (from, text) => [...text].every((c, i) => at(from + i) === c.charCodeAt(0));
	if (ascii(0, "glTF")) return "glb";
	if (at(0) === 137 && ascii(1, "PNG")) return "png";
	if (at(0) === 255 && at(1) === 216 && at(2) === 255) return "jpg";
	if (ascii(0, "GIF8")) return "gif";
	if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "webp";
}
/** The pet kind a format produces. */
function kindOf(format) {
	return format === "glb" ? "3d" : "2d";
}
/** Decimation ratio that brings a mesh to the triangle budget (1 = keep). */
function simplifyRatio(triangles, target = TARGET_TRIANGLES) {
	if (triangles <= target * 1.2) return 1;
	return target / triangles;
}
/** Count rendered triangles of a glTF document. */
async function countTriangles(doc) {
	let total = 0;
	for (const mesh of doc.getRoot().listMeshes()) for (const prim of mesh.listPrimitives()) {
		if (prim.getMode() !== 4) continue;
		const indices = prim.getIndices();
		const position = prim.getAttribute("POSITION");
		total += Math.floor((indices?.getCount() ?? position?.getCount() ?? 0) / 3);
	}
	return total;
}
/** Optimize a binary glTF for real-time display. */
async function processGlb(input) {
	const [{ NodeIO }, { ALL_EXTENSIONS }, fns, { MeshoptSimplifier }, sharpModule] = await Promise.all([
		import("@gltf-transform/core"),
		import("@gltf-transform/extensions"),
		import("@gltf-transform/functions"),
		import("meshoptimizer"),
		import("sharp")
	]);
	await MeshoptSimplifier.ready;
	const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
	let doc;
	try {
		doc = await io.readBinary(input);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(/draco|meshopt/i.test(message) ? "compressed-glb-unsupported" : "invalid-glb");
	}
	const originalTriangles = await countTriangles(doc);
	const ratio = simplifyRatio(originalTriangles);
	const steps = [fns.dedup(), fns.prune()];
	if (ratio < 1) steps.push(fns.weld(), fns.simplify({
		simplifier: MeshoptSimplifier,
		ratio,
		error: .002
	}));
	if (doc.getRoot().listTextures().length > 0) steps.push(fns.textureCompress({
		encoder: sharpModule.default,
		targetFormat: "webp",
		resize: [TEXTURE_SIZE, TEXTURE_SIZE]
	}));
	steps.push(fns.prune());
	await doc.transform(...steps);
	const data = await io.writeBinary(doc);
	return {
		data,
		file: "model.glb",
		report: {
			kind: "3d",
			format: "glb",
			originalBytes: input.byteLength,
			finalBytes: data.byteLength,
			originalTriangles,
			finalTriangles: await countTriangles(doc),
			textureSize: TEXTURE_SIZE
		}
	};
}
/** Normalize a flat image (GIFs pass through to keep their animation). */
async function processImage(input, format, background = "remove") {
	if (format === "gif") return {
		data: input,
		file: "image.gif",
		report: {
			kind: "2d",
			format,
			originalBytes: input.byteLength,
			finalBytes: input.byteLength
		}
	};
	const sharp = (await import("sharp")).default;
	let data;
	let verdict = "kept";
	let color;
	try {
		const raw = await sharp(input).rotate().resize({
			width: WORK_EDGE,
			height: WORK_EDGE,
			fit: "inside",
			withoutEnlargement: true
		}).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
		const pixels = new Uint8Array(raw.data.buffer, raw.data.byteOffset, raw.data.byteLength);
		if (background === "remove") {
			const result = removeUniformBackground(pixels, raw.info.width, raw.info.height);
			verdict = result.verdict;
			color = result.color;
		}
		data = await sharp(pixels, { raw: {
			width: raw.info.width,
			height: raw.info.height,
			channels: 4
		} }).trim({ threshold: 8 }).resize({
			width: 512,
			height: 512,
			fit: "inside",
			withoutEnlargement: true
		}).png({
			compressionLevel: 9,
			adaptiveFiltering: true
		}).toBuffer();
	} catch {
		throw new Error("invalid-image");
	}
	return {
		data,
		file: "image.png",
		report: {
			kind: "2d",
			format,
			originalBytes: input.byteLength,
			finalBytes: data.byteLength,
			background: verdict,
			...color === void 0 || verdict !== "removed" ? {} : { backgroundColor: color }
		}
	};
}
/** Sniff, bound, and process one upload. */
async function processUpload(input, background = "remove") {
	const format = sniffFormat(input);
	if (format === void 0) throw new Error("unsupported-format");
	const limit = format === "glb" ? IMPORT_LIMITS.glb : IMPORT_LIMITS.image;
	if (input.byteLength > limit) throw new Error("file-too-large");
	return format === "glb" ? processGlb(input) : processImage(input, format, background);
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
//#region src/server/repository/settings.ts
/**
* User settings — defaults, validation, and persistence to
* `$DSH_HOME/dpet/settings.json`. `sanitizeSettings` is the single gate every
* write passes through: unknown fields are dropped and numbers are clamped,
* so a hand-edited or stale file can never break the pet.
* @module dsh-dpet/server/repository/settings
*/
/** The pet shown on a fresh install. */
const DEFAULT_PET_ID = "dongdong";
/** Settings of a fresh install. */
const DEFAULT_SETTINGS = {
	enabled: true,
	petId: DEFAULT_PET_ID,
	size: 180,
	right: 32,
	bottom: 24,
	opacity: 1,
	lookAtCursor: true,
	bubbles: true,
	motions: {}
};
function clamp(value, min, max, fallback) {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, value));
}
function motionsOf(value) {
	if (typeof value !== "object" || value === null) return {};
	const out = {};
	for (const [phase, motion] of Object.entries(value)) if (ACTIVITY_PHASES.includes(phase) && PET_MOTIONS.includes(motion)) out[phase] = motion;
	return out;
}
/**
* Merge a partial update onto a base, keeping only valid values.
* @param patch - untrusted input (request body or file contents).
* @param base - the settings the patch applies to.
*/
function sanitizeSettings(patch, base = DEFAULT_SETTINGS) {
	const p = typeof patch === "object" && patch !== null ? patch : {};
	const { size, inset, opacity } = SETTINGS_LIMITS;
	return {
		enabled: typeof p.enabled === "boolean" ? p.enabled : base.enabled,
		petId: typeof p.petId === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(p.petId) ? p.petId : base.petId,
		size: Math.round(clamp(p.size, size.min, size.max, base.size)),
		right: Math.round(clamp(p.right, inset.min, inset.max, base.right)),
		bottom: Math.round(clamp(p.bottom, inset.min, inset.max, base.bottom)),
		opacity: clamp(p.opacity, opacity.min, opacity.max, base.opacity),
		lookAtCursor: typeof p.lookAtCursor === "boolean" ? p.lookAtCursor : base.lookAtCursor,
		bubbles: typeof p.bubbles === "boolean" ? p.bubbles : base.bubbles,
		motions: p.motions === void 0 ? { ...base.motions } : motionsOf(p.motions)
	};
}
/** Settings persisted in one JSON file. */
var SettingsStore = class {
	file;
	value;
	constructor(file) {
		this.file = file;
		let raw;
		try {
			raw = JSON.parse(readFileSync(file, "utf8"));
		} catch {
			raw = void 0;
		}
		this.value = sanitizeSettings(raw, DEFAULT_SETTINGS);
	}
	get() {
		return {
			...this.value,
			motions: { ...this.value.motions }
		};
	}
	/** Apply a partial update, persist it, and return the result. */
	update(patch) {
		this.value = sanitizeSettings(patch, this.value);
		writeFileAtomic(this.file, JSON.stringify(this.value, null, 2) + "\n");
		return this.get();
	}
};
//#endregion
//#region src/server/controller/routes.ts
/**
* The DPet route family.
*
*   GET  /api/dpet/state                 activity + settings + current pet
*   GET  /api/dpet/pets                  the library
*   POST /api/dpet/settings              partial settings update (JSON)
*   POST /api/dpet/import/preview        raw picture -> processed PNG (no pet created)
*   POST /api/dpet/import?name=...&background=remove|keep   raw upload -> new pet
*   POST /api/dpet/pet/<id>/rename       { name }
*   POST /api/dpet/pet/<id>/preview      raw PNG thumbnail body
*   POST /api/dpet/pet/<id>/delete
*   GET  /api/dpet/runtime/<vendor>      three.js vendor bundle
*   GET  /dpet/pets/<id>/<file>          a pet's model / image / preview
* @module dsh-dpet/server/controller/routes
*/
/** Runtime files the vendor route may serve, by exact name. */
const RUNTIME_FILES = /* @__PURE__ */ new Set(["gltf-vendor.js", "gltf-vendor.js.map"]);
/** Largest accepted thumbnail upload. */
const PREVIEW_MAX = 2097152;
function backgroundMode(url) {
	return url.searchParams.get("background") === "keep" ? "keep" : "remove";
}
/** Wrap a handler with the access check and uniform error reporting. */
function guarded(handler) {
	return async (req, res) => {
		const problem = accessProblem(req);
		if (problem !== void 0) {
			writeJson(res, 403, {
				ok: false,
				error: problem
			});
			return;
		}
		try {
			await handler(req, res);
		} catch (error) {
			if (res.headersSent) {
				res.end();
				return;
			}
			const message = error instanceof Error ? error.message : String(error);
			writeJson(res, message === "body-too-large" ? 413 : 400, {
				ok: false,
				error: message
			});
		}
	};
}
function methodIs(req, res, ...methods) {
	if (methods.includes(req.method ?? "GET")) return true;
	writeJson(res, 405, {
		ok: false,
		error: "method-not-allowed"
	});
	return false;
}
/** The selected pet, falling back to the default (or first) pet when it is gone. */
function currentPet(library, petId) {
	const pets = library.list();
	return pets.find((p) => p.manifest.id === petId) ?? pets.find((p) => p.manifest.id === "dongdong") ?? pets[0];
}
/** Build every route of the plugin. */
function makeRoutes(deps) {
	const { tracker, library, settings } = deps;
	const state = (req, res) => {
		if (!methodIs(req, res, "GET")) return;
		const current = settings.get();
		const entry = currentPet(library, current.petId);
		if (entry === void 0) {
			writeJson(res, 500, {
				ok: false,
				error: "no-pets"
			});
			return;
		}
		writeJson(res, 200, {
			activity: tracker.snapshot(),
			settings: {
				...current,
				petId: entry.manifest.id
			},
			pet: library.view(entry)
		});
	};
	const pets = (req, res) => {
		if (!methodIs(req, res, "GET")) return;
		writeJson(res, 200, library.list().map((entry) => library.view(entry)));
	};
	const updateSettings = async (req, res) => {
		if (!methodIs(req, res, "POST")) return;
		const patch = await readJson(req);
		if (typeof patch.petId === "string" && library.get(patch.petId) === void 0) {
			writeJson(res, 400, {
				ok: false,
				error: "pet-not-found"
			});
			return;
		}
		writeJson(res, 200, {
			ok: true,
			settings: settings.update(patch)
		});
	};
	const importPet = async (req, res) => {
		if (!methodIs(req, res, "POST")) return;
		const url = new URL(req.url ?? "/", "http://dpet.local");
		const data = await readBody(req, IMPORT_LIMITS.glb);
		let asset;
		try {
			asset = await processUpload(data, backgroundMode(url));
		} catch (error) {
			writeJson(res, 400, {
				ok: false,
				error: error instanceof Error ? error.message : String(error)
			});
			return;
		}
		const name = cleanName(url.searchParams.get("name")) ?? (asset.report.kind === "3d" ? "3D 桌宠" : "桌宠");
		const source = cleanName(url.searchParams.get("source"));
		const entry = library.create({
			name,
			kind: kindOf(asset.report.format),
			file: asset.file,
			bytes: asset.report.finalBytes,
			...asset.report.finalTriangles === void 0 ? {} : { triangles: asset.report.finalTriangles },
			...source === void 0 ? {} : { source },
			createdAt: Date.now()
		}, asset.data);
		writeJson(res, 200, {
			ok: true,
			pet: library.view(entry),
			report: asset.report
		});
	};
	const previewImport = async (req, res) => {
		if (!methodIs(req, res, "POST")) return;
		const url = new URL(req.url ?? "/", "http://dpet.local");
		const data = await readBody(req, IMPORT_LIMITS.image);
		const format = sniffFormat(data);
		if (format === void 0 || format === "glb" || format === "gif") throw new Error("unsupported-format");
		const asset = await processUpload(data, backgroundMode(url));
		res.writeHead(200, {
			"content-type": "image/png",
			"content-length": String(asset.data.byteLength),
			"cache-control": "no-store",
			"x-dpet-report": JSON.stringify(asset.report)
		});
		res.end(asset.data);
	};
	const petAction = async (req, res) => {
		if (!methodIs(req, res, "POST")) return;
		const segments = new URL(req.url ?? "/", "http://dpet.local").pathname.split("/").filter(Boolean);
		const [id, action] = segments.slice(3).map(decodeURIComponent);
		if (id === void 0 || action === void 0 || segments.length !== 5) {
			writeJson(res, 404, {
				ok: false,
				error: "not-found"
			});
			return;
		}
		if (action === "rename") {
			const name = cleanName((await readJson(req)).name);
			if (name === void 0) throw new Error("invalid-name");
			writeJson(res, 200, {
				ok: true,
				pet: library.view(library.rename(id, name))
			});
		} else if (action === "preview") {
			const png = await readBody(req, PREVIEW_MAX);
			if (!(png[0] === 137 && png[1] === 80 && png[2] === 78 && png[3] === 71)) throw new Error("invalid-preview");
			writeJson(res, 200, {
				ok: true,
				pet: library.view(library.setPreview(id, png))
			});
		} else if (action === "delete") {
			library.remove(id);
			if (settings.get().petId === id) settings.update({ petId: DEFAULT_PET_ID });
			writeJson(res, 200, { ok: true });
		} else writeJson(res, 404, {
			ok: false,
			error: "not-found"
		});
	};
	const runtime = async (req, res) => {
		if (!methodIs(req, res, "GET", "HEAD")) return;
		const name = new URL(req.url ?? "/", "http://dpet.local").pathname.slice(18);
		if (!RUNTIME_FILES.has(name)) {
			res.writeHead(404);
			res.end();
			return;
		}
		await sendFile(req, res, join(deps.vendorDir, name));
	};
	const petFile = async (req, res) => {
		if (!methodIs(req, res, "GET", "HEAD")) return;
		const segments = new URL(req.url ?? "/", "http://dpet.local").pathname.split("/").filter(Boolean);
		if (segments.length !== 4) {
			res.writeHead(404);
			res.end();
			return;
		}
		let id;
		let file;
		try {
			id = decodeURIComponent(segments[2]);
			file = decodeURIComponent(segments[3]);
		} catch {
			res.writeHead(400);
			res.end();
			return;
		}
		const path = library.servableFile(id, file);
		if (path === void 0) {
			res.writeHead(404);
			res.end();
			return;
		}
		await sendFile(req, res, path);
	};
	return [
		{
			kind: "exact",
			path: "/api/dpet/state",
			handler: guarded(state)
		},
		{
			kind: "exact",
			path: "/api/dpet/pets",
			handler: guarded(pets)
		},
		{
			kind: "exact",
			path: "/api/dpet/settings",
			handler: guarded(updateSettings)
		},
		{
			kind: "exact",
			path: "/api/dpet/import",
			handler: guarded(importPet)
		},
		{
			kind: "exact",
			path: "/api/dpet/import/preview",
			handler: guarded(previewImport)
		},
		{
			kind: "prefix",
			path: "/api/dpet/pet",
			handler: guarded(petAction)
		},
		{
			kind: "prefix",
			path: "/api/dpet/runtime",
			handler: guarded(runtime)
		},
		{
			kind: "prefix",
			path: PET_FILE_PREFIX,
			handler: guarded(petFile)
		}
	];
}
//#endregion
//#region src/server/controller/agent-tools.ts
/**
* Agent tools — let the DSH agent read and change the pet, so a user can say
* "switch to the flat Dongdong, make it bigger, nod while thinking" in chat.
* These are the AI-facing counterpart of ./routes.ts and go through the same
* library, settings and import pipeline.
*
* The registration pattern (defineTool + ctx.tools.register, descriptions
* that tell the model when to call and when not to) follows
* hherosoul/dsh-task-pet (MIT).
* @module dsh-dpet/server/controller/agent-tools
*/
/** Built-in motion of each state (mirrors the client defaults). */
const DEFAULT_MOTIONS = {
	idle: "bob",
	waiting: "sway",
	thinking: "spin",
	tool: "hop",
	review: "nod",
	done: "cheer",
	failed: "droop"
};
const PHASE_NOTES = {
	idle: "idle (nothing running)",
	waiting: "preparing a turn / waiting for approval",
	thinking: "thinking (reasoning)",
	tool: "running tools",
	review: "writing the reply",
	done: "turn finished",
	failed: "turn failed"
};
const MOTION_NOTES = {
	bob: "breathe gently",
	sway: "look around",
	spin: "turn around slowly",
	hop: "hop",
	nod: "nod",
	cheer: "jump and turn once",
	droop: "droop and bow",
	still: "stand still"
};
const IMPORT_EXTENSIONS = /* @__PURE__ */ new Set([
	".glb",
	".png",
	".jpg",
	".jpeg",
	".webp",
	".gif"
]);
function aborted(signal) {
	if (signal?.aborted === true) throw new Error("aborted");
}
/** Everything the agent needs to reason about the pet. */
function describeState(deps) {
	const settings = deps.settings.get();
	const pets = deps.library.list();
	const current = currentPet(deps.library, settings.petId);
	return {
		shown: settings.enabled,
		current: current === void 0 ? null : {
			id: current.manifest.id,
			name: current.manifest.name,
			kind: current.manifest.kind
		},
		appearance: {
			size: settings.size,
			opacity: settings.opacity,
			right: settings.right,
			bottom: settings.bottom,
			lookAtCursor: settings.lookAtCursor,
			bubbles: settings.bubbles
		},
		motions: Object.fromEntries(ACTIVITY_PHASES.map((phase) => [phase, settings.motions[phase] ?? DEFAULT_MOTIONS[phase]])),
		pets: pets.map((entry) => ({
			id: entry.manifest.id,
			name: entry.manifest.name,
			kind: entry.manifest.kind,
			builtin: entry.builtin,
			...entry.manifest.source === void 0 ? {} : { source: entry.manifest.source }
		}))
	};
}
function summary(state) {
	return JSON.stringify(state, null, 2);
}
/** Build the agent tools over the shared library and settings. */
function makeAgentTools(deps) {
	const { library, settings } = deps;
	const status = defineTool({
		name: "dpet_status",
		description: "Read the DPet desktop pet: whether it is shown, which pet is current, its size / opacity / position, the motion played in each agent state, and every pet in the library (built-in and imported). Call this before changing the pet, and whenever the user asks about their desktop pet (桌宠). Do not call it for unrelated questions.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => [{
				type: "text",
				text: "DPet state:\n" + summary(value)
			}]
		},
		async execute(_args, exec) {
			aborted(exec?.signal);
			return describeState(deps);
		}
	});
	const motionProperties = Object.fromEntries(ACTIVITY_PHASES.map((phase) => [phase, {
		type: "string",
		enum: PET_MOTIONS,
		description: `Motion while the agent is ${PHASE_NOTES[phase]}.`
	}]));
	return [
		status,
		defineTool({
			name: "dpet_update",
			description: "Change the DPet desktop pet. Every field is optional; only the fields given change. petId must be an id from dpet_status. Motions: " + PET_MOTIONS.map((m) => `${m} = ${MOTION_NOTES[m]}`).join(", ") + ". Agent states: " + ACTIVITY_PHASES.map((p) => `${p} = ${PHASE_NOTES[p]}`).join("; ") + ". Use it only when the user asks to change the pet.",
			parameters: {
				petId: {
					type: "string",
					description: "Pet to show (an id from dpet_status)."
				},
				shown: {
					type: "boolean",
					description: "Show (true) or hide (false) the floating pet."
				},
				size: {
					type: "integer",
					description: `Pet height in px, ${SETTINGS_LIMITS.size.min}-${SETTINGS_LIMITS.size.max}. "Bigger" is about +40.`
				},
				opacity: {
					type: "number",
					description: `Opacity, ${SETTINGS_LIMITS.opacity.min}-1.`
				},
				right: {
					type: "integer",
					description: "Distance from the window right edge, px. A large value such as 4000 clamps to the left edge."
				},
				bottom: {
					type: "integer",
					description: "Distance from the window bottom edge, px. A large value such as 4000 clamps to the top edge."
				},
				lookAtCursor: {
					type: "boolean",
					description: "Turn slightly toward the mouse pointer."
				},
				bubbles: {
					type: "boolean",
					description: "Show status bubbles such as \"thinking…\"."
				},
				motions: {
					type: "object",
					additionalProperties: false,
					properties: motionProperties,
					description: "Per-state motion overrides; states not listed keep their current motion."
				},
				resetMotions: {
					type: "boolean",
					description: "Restore the default motion of every state (applied before motions)."
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: true
				},
				render: (_args, value) => [{
					type: "text",
					text: "DPet updated. New state:\n" + summary(value)
				}]
			},
			async execute(args, exec) {
				aborted(exec?.signal);
				if (args.petId !== void 0 && library.get(args.petId) === void 0) throw new Error(`Unknown pet id "${args.petId}". Call dpet_status for the list of pets.`);
				const current = settings.get();
				const motions = args.resetMotions === true ? {} : { ...current.motions };
				for (const [phase, motion] of Object.entries(args.motions ?? {})) if (motion !== void 0) motions[phase] = motion;
				settings.update({
					...args.petId === void 0 ? {} : { petId: args.petId },
					...args.shown === void 0 ? {} : { enabled: args.shown },
					...args.size === void 0 ? {} : { size: args.size },
					...args.opacity === void 0 ? {} : { opacity: args.opacity },
					...args.right === void 0 ? {} : { right: args.right },
					...args.bottom === void 0 ? {} : { bottom: args.bottom },
					...args.lookAtCursor === void 0 ? {} : { lookAtCursor: args.lookAtCursor },
					...args.bubbles === void 0 ? {} : { bubbles: args.bubbles },
					motions
				});
				return describeState(deps);
			}
		}),
		defineTool({
			name: "dpet_import",
			description: "Turn a local file into a new DPet pet: a 3D model (.glb) or a picture (.png .jpg .jpeg .webp .gif). Models are simplified and compressed automatically; a plain single-color picture background is removed unless background is \"keep\". Pass the absolute path the user gave you. Use it only when the user asks to make a pet from a file.",
			parameters: {
				path: {
					type: "string",
					required: true,
					description: "Absolute path of the .glb / .png / .jpg / .jpeg / .webp / .gif file."
				},
				name: {
					type: "string",
					description: "Display name; defaults to the file name."
				},
				background: {
					type: "string",
					enum: ["remove", "keep"],
					description: "Pictures only: remove a plain background (default) or keep it."
				},
				use: {
					type: "boolean",
					description: "Show the new pet right away (default true)."
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: true
				},
				render: (_args, value) => [{
					type: "text",
					text: "DPet import finished:\n" + summary(value)
				}]
			},
			async execute(args, exec) {
				aborted(exec?.signal);
				if (!isAbsolute(args.path)) throw new Error("path must be absolute.");
				if (!IMPORT_EXTENSIONS.has(extname(args.path).toLowerCase())) throw new Error("Unsupported file type. Use .glb for 3D, or .png .jpg .jpeg .webp .gif for 2D.");
				const info = await stat(args.path).catch(() => void 0);
				if (info === void 0 || !info.isFile()) throw new Error(`File not found: ${args.path}`);
				const limit = extname(args.path).toLowerCase() === ".glb" ? IMPORT_LIMITS.glb : IMPORT_LIMITS.image;
				if (info.size > limit) throw new Error(`File too large (${info.size} bytes, limit ${limit}).`);
				const asset = await processUpload(new Uint8Array(await readFile(args.path)), args.background === "keep" ? "keep" : "remove");
				aborted(exec?.signal);
				const name = cleanName(args.name) ?? cleanName(basename(args.path, extname(args.path))) ?? "pet";
				const entry = library.create({
					name,
					kind: kindOf(asset.report.format),
					file: asset.file,
					bytes: asset.report.finalBytes,
					...asset.report.finalTriangles === void 0 ? {} : { triangles: asset.report.finalTriangles },
					createdAt: Date.now()
				}, asset.data);
				if (args.use !== false) settings.update({
					petId: entry.manifest.id,
					enabled: true
				});
				return {
					pet: {
						id: entry.manifest.id,
						name: entry.manifest.name,
						kind: entry.manifest.kind
					},
					report: asset.report,
					shown: args.use !== false
				};
			}
		}),
		defineTool({
			name: "dpet_manage_pet",
			description: "Rename or delete a pet the user imported (built-in pets cannot be changed). Delete is permanent: use it only when the user explicitly asks to delete that pet.",
			parameters: {
				petId: {
					type: "string",
					required: true,
					description: "An imported pet id from dpet_status."
				},
				action: {
					type: "string",
					enum: ["rename", "delete"],
					required: true
				},
				name: {
					type: "string",
					description: "New display name (rename only)."
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: true
				},
				render: (args, value) => [{
					type: "text",
					text: `DPet ${args.action} done:\n` + summary(value)
				}]
			},
			async execute(args, exec) {
				aborted(exec?.signal);
				const entry = library.get(args.petId);
				if (entry === void 0) throw new Error(`Unknown pet id "${args.petId}". Call dpet_status for the list of pets.`);
				if (entry.builtin) throw new Error("Built-in pets cannot be renamed or deleted.");
				if (args.action === "rename") {
					const name = cleanName(args.name);
					if (name === void 0) throw new Error("rename needs a non-empty name.");
					library.rename(args.petId, name);
				} else {
					library.remove(args.petId);
					if (settings.get().petId === args.petId) settings.update({ petId: DEFAULT_PET_ID });
				}
				return describeState(deps);
			}
		})
	];
}
//#endregion
//#region src/server/index.ts
/**
* DPet host half — runs inside the DSH host process.
*
* It follows the agent through the session events, keeps the pet library
* (built-in pets plus imports under $DSH_HOME/dpet), persists the settings,
* and serves all of it to the browser half over same-origin routes. The
* browser half (./client) draws the floating pet and the settings page.
* @module dsh-dpet
*/
/** Stable cordis plugin name (matches the cordis.patch.yml row id). */
const name = "dpet";
/** The web server must be up before routes can register. */
const inject = ["webServer"];
/**
* Package root: the nearest directory above this module holding package.json
* (lib/index.js when built, src/server/index.ts in development).
*/
function packageRoot() {
	let dir = dirname(fileURLToPath(import.meta.url));
	while (!existsSync(join(dir, "package.json"))) {
		const parent = dirname(dir);
		if (parent === dir) throw new Error("dsh-dpet: package.json not found above " + fileURLToPath(import.meta.url));
		dir = parent;
	}
	return dir;
}
/** Mount the activity tracker, the library, and the routes. */
function apply(ctx) {
	const root = packageRoot();
	const dataDir = join(resolveDshHome(), "dpet");
	const library = new PetLibrary({
		builtin: join(root, "assets", "pets"),
		user: join(dataDir, "pets")
	});
	const settings = new SettingsStore(join(dataDir, "settings.json"));
	const tracker = new ActivityTracker();
	ctx.on("session/event", (session, event) => {
		tracker.onSessionEvent(String(session.id), event);
	});
	ctx.on("agent/assistant-stream", ({ agent, frame }) => {
		tracker.onStreamFrame(String(agent.session.id), frame);
	});
	ctx.on("session/disposed", (session) => {
		tracker.onSessionDisposed(String(session.id));
	});
	const routes = makeRoutes({
		tracker,
		library,
		settings,
		vendorDir: join(root, "lib")
	});
	ctx.effect(() => {
		const disposers = routes.map((route) => ctx.webServer.register(route));
		return () => {
			for (const dispose of disposers) dispose();
		};
	}, "dpet: routes");
	ctx.inject(["tools"], (toolsCtx) => {
		const tools = makeAgentTools({
			library,
			settings
		});
		toolsCtx.effect(() => {
			const disposers = tools.map((tool) => toolsCtx.tools.register(tool));
			return () => {
				for (const dispose of disposers) dispose();
			};
		}, "dpet: agent tools");
	});
}
//#endregion
export { ActivityTracker, DEFAULT_SETTINGS, PetLibrary, SettingsStore, apply, inject, makeAgentTools, makeRoutes, name, projectSessionEvent, projectStreamFrame, sanitizeSettings };
