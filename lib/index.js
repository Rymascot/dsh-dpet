import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { readFile, stat } from "node:fs/promises";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createHash, createHmac, randomBytes } from "node:crypto";
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
/**
* Write a file atomically (temp file + rename), creating parent directories.
* @param mode - file permissions for a new file, e.g. 0o600 for secrets (ignored on Windows).
*/
function writeFileAtomic(file, data, mode) {
	mkdirSync(dirname(file), { recursive: true });
	const temp = file + "." + process.pid + ".tmp";
	writeFileSync(temp, data, mode === void 0 ? void 0 : { mode });
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
/** Answer 405 unless the request uses one of the methods. */
function methodIs(req, res, ...methods) {
	if (methods.includes(req.method ?? "GET")) return true;
	writeJson(res, 405, {
		ok: false,
		error: "method-not-allowed"
	});
	return false;
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
* and 4K textures (the Dong Xiaolong model arrived at 76 MB). A desktop pet is a
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
/** Every model tier, in display order. */
const GENERATE_MODELS = ["rapid", "pro"];
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
		const generation = deps.generation?.brief();
		writeJson(res, 200, {
			activity: tracker.snapshot(),
			settings: {
				...current,
				petId: entry.manifest.id
			},
			pet: library.view(entry),
			...generation === void 0 ? {} : { generation }
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
//#region src/server/service/hunyuan/image.ts
/**
* Prepare a picture for Hunyuan image-to-3D. The API takes jpg / png / webp
* with each side between 128 and 5000 px and at most 6 MB once base64
* encoded. Pictures are upright-rotated by their EXIF orientation, bounded to
* 2048 px, kept as PNG when they have transparency (a cut-out subject gives
* the cleanest model) and as JPEG otherwise, and shrunk further until they
* fit. A small thumbnail is made at the same time for the job list.
* @module dsh-dpet/server/service/hunyuan/image
*/
/** Accepted upload size for a generation picture. */
const GENERATE_UPLOAD_LIMIT = 20971520;
/** Edges tried, largest first. */
const EDGES = [
	2048,
	1536,
	1024,
	768
];
/** Edge of the job-list thumbnail. */
const THUMB_EDGE = 192;
/** Output size for an upright picture: long side at most `edge`, short side at least the API minimum. */
function fitEdges(width, height, edge) {
	const long = Math.max(width, height);
	const short = Math.min(width, height);
	let scale = Math.min(1, edge / long);
	if (short * scale < 128) scale = 128 / short;
	const w = Math.round(width * scale);
	const h = Math.round(height * scale);
	if (Math.min(w, h) < 128 || Math.max(w, h) > 5e3) throw new Error("image-bad-shape");
	return {
		width: w,
		height: h
	};
}
async function prepareGenerateImage(input) {
	const format = sniffFormat(input);
	if (format === void 0 || format === "glb") throw new Error("unsupported-format");
	const { default: sharp } = await import("sharp");
	let meta;
	try {
		meta = await sharp(input, { animated: false }).metadata();
	} catch {
		throw new Error("invalid-image");
	}
	if (meta.width === void 0 || meta.height === void 0) throw new Error("invalid-image");
	const upright = (meta.orientation ?? 1) >= 5 ? {
		width: meta.height,
		height: meta.width
	} : {
		width: meta.width,
		height: meta.height
	};
	const alpha = meta.hasAlpha === true;
	for (const edge of EDGES) {
		const size = fitEdges(upright.width, upright.height, edge);
		const pipeline = sharp(input, { animated: false }).rotate().resize(size.width, size.height, { fit: "fill" });
		const data = alpha ? await pipeline.png({ compressionLevel: 9 }).toBuffer() : await pipeline.flatten({ background: "#ffffff" }).jpeg({ quality: 92 }).toBuffer();
		if (data.byteLength > 44e5) continue;
		const thumbnail = await sharp(data).resize(THUMB_EDGE, THUMB_EDGE, { fit: "inside" }).png().toBuffer();
		return {
			data,
			base64: data.toString("base64"),
			format: alpha ? "png" : "jpg",
			width: size.width,
			height: size.height,
			thumbnail
		};
	}
	throw new Error("image-too-large");
}
//#endregion
//#region src/server/controller/agent-tools.ts
/**
* Agent tools — let the DSH agent read and change the pet, so a user can say
* "switch to the flat Dong Xiaolong, make it bigger, nod while thinking" in chat.
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
const GENERATE_EXTENSIONS = /* @__PURE__ */ new Set([
	".png",
	".jpg",
	".jpeg",
	".webp"
]);
/** Jobs listed by dpet_status. */
const STATUS_JOBS = 5;
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
		})),
		...deps.generator === void 0 ? {} : { imageTo3d: describeGeneration(deps.generator) }
	};
}
/** Image-to-3D connection and recent jobs (never secrets). */
function describeGeneration(generator) {
	const status = generator.status();
	return {
		connected: status.configured,
		...status.method === void 0 ? {} : { method: status.method },
		recentJobs: generator.list().slice(0, STATUS_JOBS).map((job) => ({
			id: job.id,
			name: job.name,
			model: job.model,
			status: job.status,
			...job.petId === void 0 ? {} : { petId: job.petId },
			...job.error === void 0 ? {} : { error: job.error },
			...job.detail === void 0 ? {} : { detail: job.detail }
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
	const tools = [
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
	const generator = deps.generator;
	if (generator === void 0) return tools;
	const generate = defineTool({
		name: "dpet_generate_3d",
		description: "Turn a local picture (.png .jpg .jpeg .webp) into a 3D desktop pet with Tencent Hunyuan 3D, using the key the user saved in DSH Settings → 桌宠 → Key 密钥 tab. Each job spends the user's Tencent Cloud credits, so call it only when the user explicitly asks to generate a 3D model or 3D pet from a picture. The job runs in the background (about 1-3 minutes for rapid, longer for pro); the pet appears in the library when done. Check progress with dpet_status. If it reports not-configured, tell the user to open Settings → 桌宠 → Key 密钥 and connect Tencent Hunyuan there. Never ask the user to paste API keys or secrets into the chat.",
		parameters: {
			path: {
				type: "string",
				required: true,
				description: "Absolute path of the picture. A subject on a plain or transparent background works best."
			},
			name: {
				type: "string",
				description: "Display name of the new pet; defaults to the file name."
			},
			model: {
				type: "string",
				enum: ["rapid", "pro"],
				description: "rapid (default): faster and cheaper. pro: finer detail, slower, more credits."
			},
			use: {
				type: "boolean",
				description: "Show the new pet as soon as it is ready (default true)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => [{
				type: "text",
				text: "DPet image-to-3D:\n" + summary(value)
			}]
		},
		async execute(args, exec) {
			aborted(exec?.signal);
			if (!isAbsolute(args.path)) throw new Error("path must be absolute.");
			if (!GENERATE_EXTENSIONS.has(extname(args.path).toLowerCase())) throw new Error("Use a .png, .jpg, .jpeg or .webp picture.");
			const info = await stat(args.path).catch(() => void 0);
			if (info === void 0 || !info.isFile()) throw new Error(`File not found: ${args.path}`);
			if (info.size > 20971520) throw new Error(`Picture too large (${info.size} bytes, limit ${GENERATE_UPLOAD_LIMIT}).`);
			if (!generator.status().configured) throw new Error("not-configured: Tencent Hunyuan is not connected. Ask the user to open DSH Settings → 桌宠 → Key 密钥 and save their key there (never in chat).");
			const name = cleanName(args.name) ?? cleanName(basename(args.path, extname(args.path))) ?? "3D pet";
			let job;
			try {
				job = await generator.start(new Uint8Array(await readFile(args.path)), {
					name,
					model: args.model ?? "rapid",
					use: args.use !== false
				});
			} catch (error) {
				if ((error instanceof Error ? error.message : String(error)) === "busy") throw new Error("busy: another image-to-3D job is still running (Hunyuan runs one at a time). Check dpet_status and try again when it finishes.");
				throw error;
			}
			if (job.status === "failed") throw new Error(`Submitting to Tencent Hunyuan failed: ${job.error ?? "error"}${job.detail === void 0 ? "" : " (" + job.detail + ")"}`);
			return {
				job: {
					id: job.id,
					name: job.name,
					model: job.model,
					status: job.status
				},
				note: "Generation runs in the background. The new pet appears in the library when done" + (args.use !== false ? " and is shown right away" : "") + ". Use dpet_status to check progress."
			};
		}
	});
	return [...tools, generate];
}
/** Printable ASCII without spaces. */
const TOKEN = /^[\x21-\x7e]{8,512}$/;
const SECRET_ID = /^[A-Za-z0-9]{8,128}$/;
const REGION = /^[a-z]{2,}(-[a-z]+)+(-\d+)?$/;
function text(value) {
	return typeof value === "string" ? value.trim() : void 0;
}
/** Validate untrusted credentials (from the page or the file); undefined when unusable. */
function parseCredentials(raw) {
	if (typeof raw !== "object" || raw === null) return void 0;
	const r = raw;
	if (r.method === "tokenhub") {
		const apiKey = text(r.apiKey);
		return apiKey !== void 0 && TOKEN.test(apiKey) ? {
			method: "tokenhub",
			apiKey
		} : void 0;
	}
	if (r.method === "tencentcloud") {
		const secretId = text(r.secretId);
		const secretKey = text(r.secretKey);
		const region = text(r.region) || "ap-guangzhou";
		if (secretId === void 0 || !SECRET_ID.test(secretId)) return void 0;
		if (secretKey === void 0 || !TOKEN.test(secretKey)) return void 0;
		if (!REGION.test(region)) return void 0;
		return {
			method: "tencentcloud",
			secretId,
			secretKey,
			region
		};
	}
}
/** Credentials from environment variables, if any. */
function credentialsFromEnv(env) {
	const apiKey = text(env.HUNYUAN_TOKENHUB_API_KEY);
	if (apiKey) return parseCredentials({
		method: "tokenhub",
		apiKey
	});
	const secretId = text(env.TENCENTCLOUD_SECRET_ID) || text(env.HUNYUAN3D_SECRET_ID);
	const secretKey = text(env.TENCENTCLOUD_SECRET_KEY) || text(env.HUNYUAN3D_SECRET_KEY);
	if (secretId && secretKey) return parseCredentials({
		method: "tencentcloud",
		secretId,
		secretKey,
		region: text(env.TENCENTCLOUD_REGION)
	});
}
/** The last four characters of the key id, for "connected as …a1b2". */
function hintOf(credentials) {
	return "…" + (credentials.method === "tokenhub" ? credentials.apiKey : credentials.secretId).slice(-4);
}
/** Browser-safe description (no secrets). */
function describeCredentials(resolved) {
	if (resolved === void 0) return { configured: false };
	const { credentials, source } = resolved;
	return {
		configured: true,
		method: credentials.method,
		source,
		hint: hintOf(credentials),
		...credentials.method === "tencentcloud" ? { region: credentials.region } : {}
	};
}
var CredentialStore = class {
	file;
	env;
	constructor(file, env = process.env) {
		this.file = file;
		this.env = env;
	}
	/** Saved credentials first, then the environment. */
	resolve() {
		try {
			const saved = parseCredentials(JSON.parse(readFileSync(this.file, "utf8")));
			if (saved !== void 0) return {
				credentials: saved,
				source: "local"
			};
		} catch {}
		const fromEnv = credentialsFromEnv(this.env);
		return fromEnv === void 0 ? void 0 : {
			credentials: fromEnv,
			source: "env"
		};
	}
	/** Validate and save credentials entered on the settings page. */
	save(raw) {
		const credentials = parseCredentials(raw);
		if (credentials === void 0) throw new Error("invalid-credentials");
		writeFileAtomic(this.file, JSON.stringify(credentials, null, 2) + "\n", 384);
		return credentials;
	}
	/** Forget the saved credentials (environment variables are untouched). */
	clear() {
		rmSync(this.file, { force: true });
	}
};
//#endregion
//#region src/server/service/hunyuan/tc3.ts
/**
* Tencent Cloud API 3.0 request signing (TC3-HMAC-SHA256), written from the
* official "签名方法 v3" document. Signs the content-type and host headers,
* the same set the official SDK signs.
* @module dsh-dpet/server/service/hunyuan/tc3
*/
const TC3_CONTENT_TYPE = "application/json";
function sha256Hex(data) {
	return createHash("sha256").update(data, "utf8").digest("hex");
}
function hmac(key, data) {
	return createHmac("sha256", key).update(data, "utf8").digest();
}
/** UTC calendar date of a Unix timestamp, YYYY-MM-DD. */
function tc3Date(timestamp) {
	return (/* @__PURE__ */ new Date(timestamp * 1e3)).toISOString().slice(0, 10);
}
/** The Authorization header value. */
function tc3Authorization(req) {
	const canonicalRequest = [
		"POST",
		"/",
		"",
		"content-type:application/json\nhost:" + req.host + "\n",
		"content-type;host",
		sha256Hex(req.payload)
	].join("\n");
	const date = tc3Date(req.timestamp);
	const scope = date + "/" + req.service + "/tc3_request";
	const stringToSign = [
		"TC3-HMAC-SHA256",
		String(req.timestamp),
		scope,
		sha256Hex(canonicalRequest)
	].join("\n");
	const secretSigning = hmac(hmac(hmac("TC3" + req.secretKey, date), req.service), "tc3_request");
	const signature = createHmac("sha256", secretSigning).update(stringToSign, "utf8").digest("hex");
	return "TC3-HMAC-SHA256 Credential=" + req.secretId + "/" + scope + ", SignedHeaders=content-type;host, Signature=" + signature;
}
/** Every header a signed request carries (fetch adds Host from the URL). */
function tc3Headers(req) {
	return {
		"Authorization": tc3Authorization(req),
		"Content-Type": TC3_CONTENT_TYPE,
		"X-TC-Action": req.action,
		"X-TC-Timestamp": String(req.timestamp),
		"X-TC-Version": req.version,
		"X-TC-Region": req.region
	};
}
//#endregion
//#region src/server/service/hunyuan/client.ts
/**
* Tencent Hunyuan 3D clients: submit an image-to-3D job, poll it, download
* the GLB. Two official ways in, behind one interface:
*
* - TokenHub (Tencent's recommended platform for Hunyuan now): an API key
*   sent as `Authorization: Bearer`. Models hy-3d-express (rapid) and
*   hy-3d-3.0 (pro). https://cloud.tencent.com/document/product/1823/137175
* - Tencent Cloud API 3.0 (ai3d.tencentcloudapi.com, 2025-05-13): a
*   SecretId / SecretKey pair with TC3 signing. Submit/QueryHunyuanTo3DRapidJob
*   and Submit/QueryHunyuanTo3DProJob.
*   https://cloud.tencent.com/document/api/1804/123463
*
* A third, mock client answers from a local GLB without any network access,
* for development and demos (DPET_HUNYUAN_MOCK=1).
* @module dsh-dpet/server/service/hunyuan/client
*/
var HunyuanError = class extends Error {
	code;
	detail;
	constructor(code, detail) {
		super(code);
		this.code = code;
		this.detail = detail;
		this.name = "HunyuanError";
	}
};
/** Per-request time limit for API calls. */
const API_TIMEOUT_MS = 3e4;
/** Time limit for downloading the model. */
const DOWNLOAD_TIMEOUT_MS = 3e5;
function withTimeout(signal, ms) {
	const timeout = AbortSignal.timeout(ms);
	return signal === void 0 ? timeout : AbortSignal.any([signal, timeout]);
}
/** Run a fetch, turning transport failures into HunyuanError('network'). */
async function send(fetchImpl, url, init) {
	try {
		return await fetchImpl(url, init);
	} catch (error) {
		if (init.signal?.aborted === true && error?.name === "AbortError") throw error;
		throw new HunyuanError("network", error instanceof Error ? error.message : String(error));
	}
}
async function readJsonBody(response) {
	const raw = await response.text().catch(() => "");
	try {
		const parsed = JSON.parse(raw);
		return typeof parsed === "object" && parsed !== null ? parsed : {};
	} catch {
		return {};
	}
}
function str(value) {
	return typeof value === "string" && value !== "" ? value : void 0;
}
/** Pick the GLB entry out of a result file list ({type|Type, url|Url}). */
function pickGlb(files) {
	if (!Array.isArray(files)) return void 0;
	for (const file of files) {
		if (typeof file !== "object" || file === null) continue;
		const f = file;
		const type = str(f.type) ?? str(f.Type);
		const url = str(f.url) ?? str(f.Url);
		if (type?.toLowerCase() === "glb" && url !== void 0) return url;
	}
}
/** Download over HTTPS with a byte ceiling. */
async function downloadBytes(fetchImpl, url, maxBytes, signal) {
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		throw new HunyuanError("remote-error", "bad download url");
	}
	if (parsed.protocol !== "https:") throw new HunyuanError("remote-error", "download url is not https");
	const response = await send(fetchImpl, url, { signal: withTimeout(signal, DOWNLOAD_TIMEOUT_MS) });
	if (!response.ok) throw new HunyuanError("remote-error", "download HTTP " + response.status);
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > maxBytes) throw new HunyuanError("download-too-large");
	if (response.body === null) return /* @__PURE__ */ new Uint8Array(0);
	const chunks = [];
	let size = 0;
	try {
		for await (const chunk of response.body) {
			size += chunk.byteLength;
			if (size > maxBytes) throw new HunyuanError("download-too-large");
			chunks.push(chunk);
		}
	} catch (error) {
		if (error instanceof HunyuanError) throw error;
		throw new HunyuanError("network", error instanceof Error ? error.message : String(error));
	}
	return Buffer.concat(chunks);
}
const TOKENHUB_BASE = "https://tokenhub.tencentmaas.com/v1/api/3d";
const TOKENHUB_MODELS = {
	rapid: "hy-3d-express",
	pro: "hy-3d-3.0"
};
/** Map a TokenHub error (HTTP status + OpenAI-style error body). */
function tokenHubError(status, body) {
	const error = typeof body.error === "object" && body.error !== null ? body.error : {};
	const code = str(error.code) ?? str(error.type) ?? str(body.code) ?? "";
	const message = str(error.message) ?? str(body.message) ?? str(body.error) ?? (status === 0 ? "" : "HTTP " + status);
	const detail = [code, message].filter(Boolean).join(": ") || void 0;
	if (status === 401) return new HunyuanError("unauthorized", detail);
	if (status === 403) return new HunyuanError("forbidden", detail);
	if (status === 429) return new HunyuanError("rate-limited", detail);
	if (status === 402) return new HunyuanError("quota", detail);
	const hay = (code + " " + message).toLowerCase();
	if (/quota|balance|insufficient|arrear|credit|余额|额度|欠费/.test(hay)) return new HunyuanError("quota", detail);
	if (/rate|limit|concurren|并发/.test(hay)) return new HunyuanError("rate-limited", detail);
	if (/auth|api.?key|unauthori/.test(hay)) return new HunyuanError("unauthorized", detail);
	if (status >= 500) return new HunyuanError("remote-error", detail);
	return new HunyuanError("rejected", detail);
}
function tokenHubClient(apiKey, fetchImpl = fetch, base = TOKENHUB_BASE) {
	const call = async (path, body, signal) => {
		const response = await send(fetchImpl, base + "/" + path, {
			method: "POST",
			headers: {
				"Authorization": "Bearer " + apiKey,
				"Content-Type": "application/json"
			},
			body: JSON.stringify(body),
			signal: withTimeout(signal, API_TIMEOUT_MS)
		});
		const json = await readJsonBody(response);
		if (!response.ok || json.error !== void 0 && json.error !== null && json.status === void 0) throw tokenHubError(response.ok ? 0 : response.status, json);
		return json;
	};
	const query = async (jobId, model, signal) => {
		const json = await call("query", {
			model: TOKENHUB_MODELS[model],
			id: jobId
		}, signal);
		const status = str(json.status)?.toLowerCase();
		if (status === "completed" || status === "succeeded" || status === "success" || status === "done") {
			const glbUrl = pickGlb(json.data);
			return {
				state: "done",
				...glbUrl === void 0 ? {} : { glbUrl }
			};
		}
		if (status === "failed" || status === "error" || status === "cancelled") {
			const error = typeof json.error === "object" && json.error !== null ? json.error : {};
			const code = str(error.code) ?? str(json.error_code);
			const message = str(error.message) ?? str(json.error_message) ?? str(json.message);
			return {
				state: "failed",
				...code === void 0 ? {} : { code },
				...message === void 0 ? {} : { message }
			};
		}
		if (status === "in_progress" || status === "running" || status === "processing") return { state: "running" };
		return { state: "queued" };
	};
	return {
		method: "tokenhub",
		async submit(imageBase64, model, signal) {
			const json = await call("submit", {
				model: TOKENHUB_MODELS[model],
				image_base64: imageBase64,
				...model === "rapid" ? { result_format: "glb" } : {}
			}, signal);
			const id = str(json.id) ?? (typeof json.id === "number" ? String(json.id) : void 0);
			if (id === void 0) throw new HunyuanError("remote-error", "no job id in response");
			return id;
		},
		query,
		async check(signal) {
			try {
				await query("0", "rapid", signal);
			} catch (error) {
				if (error instanceof HunyuanError && error.code === "rejected") return;
				throw error;
			}
		},
		download: (url, maxBytes, signal) => downloadBytes(fetchImpl, url, maxBytes, signal)
	};
}
const AI3D_HOST = "ai3d.tencentcloudapi.com";
const AI3D_VERSION = "2025-05-13";
const AI3D_ACTIONS = {
	rapid: {
		submit: "SubmitHunyuanTo3DRapidJob",
		query: "QueryHunyuanTo3DRapidJob"
	},
	pro: {
		submit: "SubmitHunyuanTo3DProJob",
		query: "QueryHunyuanTo3DProJob"
	}
};
/** Map a Tencent Cloud error code (Response.Error.Code). */
function tencentCloudError(code, message) {
	const detail = message === void 0 ? code : code + ": " + message;
	if (code.startsWith("AuthFailure")) return new HunyuanError("unauthorized", detail);
	if (code.startsWith("UnauthorizedOperation")) return new HunyuanError("forbidden", detail);
	if (code.startsWith("LimitExceeded") || code === "RequestLimitExceeded" || code.startsWith("RequestLimitExceeded")) return new HunyuanError("rate-limited", detail);
	if (code.startsWith("ResourceInsufficient") || code.startsWith("ResourceUnavailable") || code.startsWith("ResourcesSoldOut") || /arrear|balance|quota/i.test(code)) return new HunyuanError("quota", detail);
	if (code.startsWith("InvalidParameter") || code.startsWith("MissingParameter") || code.startsWith("UnsupportedOperation") || code.startsWith("UnknownParameter")) return new HunyuanError("rejected", detail);
	return new HunyuanError("remote-error", detail);
}
function tencentCloudClient(credentials, fetchImpl = fetch, now = Date.now) {
	const call = async (action, body, signal) => {
		const payload = JSON.stringify(body);
		const headers = tc3Headers({
			...credentials,
			service: "ai3d",
			host: AI3D_HOST,
			action,
			version: AI3D_VERSION,
			payload,
			timestamp: Math.floor(now() / 1e3)
		});
		const response = await send(fetchImpl, "https://" + AI3D_HOST + "/", {
			method: "POST",
			headers,
			body: payload,
			signal: withTimeout(signal, API_TIMEOUT_MS)
		});
		const json = await readJsonBody(response);
		const inner = typeof json.Response === "object" && json.Response !== null ? json.Response : void 0;
		if (inner === void 0) throw new HunyuanError(response.status >= 500 ? "remote-error" : "network", "HTTP " + response.status);
		const error = typeof inner.Error === "object" && inner.Error !== null ? inner.Error : void 0;
		if (error !== void 0) throw tencentCloudError(str(error.Code) ?? "UnknownError", str(error.Message));
		return inner;
	};
	const query = async (jobId, model, signal) => {
		const json = await call(AI3D_ACTIONS[model].query, { JobId: jobId }, signal);
		const status = str(json.Status)?.toUpperCase();
		if (status === "DONE") {
			const glbUrl = pickGlb(json.ResultFile3Ds);
			return {
				state: "done",
				...glbUrl === void 0 ? {} : { glbUrl }
			};
		}
		if (status === "FAIL") {
			const code = str(json.ErrorCode);
			const message = str(json.ErrorMessage);
			return {
				state: "failed",
				...code === void 0 ? {} : { code },
				...message === void 0 ? {} : { message }
			};
		}
		if (status === "RUN") return { state: "running" };
		return { state: "queued" };
	};
	return {
		method: "tencentcloud",
		async submit(imageBase64, model, signal) {
			const id = str((await call(AI3D_ACTIONS[model].submit, {
				ImageBase64: imageBase64,
				...model === "rapid" ? { ResultFormat: "GLB" } : {}
			}, signal)).JobId);
			if (id === void 0) throw new HunyuanError("remote-error", "no JobId in response");
			return id;
		},
		query,
		async check(signal) {
			try {
				await query("0", "rapid", signal);
			} catch (error) {
				if (error instanceof HunyuanError && error.code === "rejected") return;
				throw error;
			}
		},
		download: (url, maxBytes, signal) => downloadBytes(fetchImpl, url, maxBytes, signal)
	};
}
/** Download URL the mock client hands out. */
const MOCK_GLB_URL = "mock:glb";
/**
* A client that never touches the network: jobs queue, run, and finish with
* the GLB at `glbPath` after `steps` polls.
*/
function mockClient(glbPath, steps = 3) {
	const polls = /* @__PURE__ */ new Map();
	let next = 1;
	return {
		method: "mock",
		async submit() {
			const id = "mock-" + Date.now().toString(36) + "-" + next++;
			polls.set(id, 0);
			return id;
		},
		async query(jobId) {
			const n = (polls.get(jobId) ?? steps) + 1;
			polls.set(jobId, n);
			if (n >= steps) return {
				state: "done",
				glbUrl: MOCK_GLB_URL
			};
			return { state: n === 1 ? "queued" : "running" };
		},
		async check() {},
		async download(url, maxBytes) {
			if (url !== "mock:glb") throw new HunyuanError("remote-error", "unknown mock url");
			const data = await readFile(glbPath);
			if (data.byteLength > maxBytes) throw new HunyuanError("download-too-large");
			return new Uint8Array(data);
		}
	};
}
/** The client for a set of credentials. */
function clientFor(credentials, fetchImpl = fetch) {
	return credentials.method === "tokenhub" ? tokenHubClient(credentials.apiKey, fetchImpl) : tencentCloudClient(credentials, fetchImpl);
}
//#endregion
//#region src/server/service/generator.ts
/**
* Image-to-3D jobs: picture → Tencent Hunyuan 3D → GLB → the regular import
* pipeline (decimate, compress) → a new pet in the library.
*
* Jobs are kept in `$DSH_HOME/dpet/generate/jobs.json` with a thumbnail of
* each input picture, so the settings page can list them and a DSH restart
* resumes polling (a Hunyuan job id stays valid for 24 hours). Hunyuan runs
* one job per account at a time by default, so a new job is refused while
* another is still running.
* @module dsh-dpet/server/service/generator
*/
/** Browser prefix of the job routes. */
const JOB_PREFIX = "/api/dpet/generate/job";
/** Job records kept on disk. */
const MAX_JOBS = 20;
/** A Hunyuan job id expires after 24 hours. */
const JOB_TTL_MS = 864e5;
/** Consecutive network failures tolerated while polling. */
const MAX_POLL_FAILURES = 8;
/** How long a finished job keeps the floating pet's bubble. */
const BRIEF_AFTER_MS = 1e4;
const ACTIVE = /* @__PURE__ */ new Set([
	"submitting",
	"queued",
	"running",
	"downloading",
	"importing"
]);
/** 3 s for the first two minutes, then 6 s. */
function defaultPollDelay(ageMs) {
	return ageMs < 12e4 ? 3e3 : 6e3;
}
function isRecord(raw) {
	if (typeof raw !== "object" || raw === null) return false;
	const r = raw;
	return typeof r.id === "string" && /^[a-z0-9]{6,32}$/.test(r.id) && typeof r.name === "string" && GENERATE_MODELS.includes(r.model) && typeof r.status === "string" && typeof r.createdAt === "number" && typeof r.updatedAt === "number";
}
var Generator = class {
	options;
	jobs = [];
	timers = /* @__PURE__ */ new Map();
	failures = /* @__PURE__ */ new Map();
	waiters = /* @__PURE__ */ new Map();
	abort = new AbortController();
	now;
	pollDelay;
	constructor(options) {
		this.options = options;
		this.now = options.now ?? Date.now;
		this.pollDelay = options.pollDelay ?? defaultPollDelay;
		this.jobs = this.load();
	}
	/** Connection status for the page (no secrets). */
	status() {
		if (this.options.mock === true) return {
			configured: true,
			method: "mock",
			source: "mock"
		};
		return describeCredentials(this.options.credentials.resolve());
	}
	/** Every job, newest first. */
	list() {
		return [...this.jobs].sort((a, b) => b.createdAt - a.createdAt).map((job) => this.view(job));
	}
	get(id) {
		const job = this.jobs.find((j) => j.id === id);
		return job === void 0 ? void 0 : this.view(job);
	}
	/** The running job, or one that just finished, for the floating pet. */
	brief() {
		const now = this.now();
		const job = this.jobs.find((j) => ACTIVE.has(j.status)) ?? this.jobs.filter((j) => j.finishedAt !== void 0 && now - j.finishedAt < BRIEF_AFTER_MS).sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))[0];
		if (job === void 0) return void 0;
		return {
			name: job.name,
			status: job.status,
			...job.petId === void 0 ? {} : { petId: job.petId }
		};
	}
	/** Path of a job's input thumbnail, if it exists. */
	inputFile(id) {
		if (!this.jobs.some((j) => j.id === id)) return void 0;
		const file = join(this.options.dir, id + ".png");
		return existsSync(file) ? file : void 0;
	}
	/**
	* Start a job from a picture. Resolves once the job is submitted (or has
	* failed to submit); generation itself continues in the background.
	* Throws 'busy', 'not-configured', or a picture error before any job exists.
	*/
	async start(input, request) {
		if (this.jobs.some((j) => ACTIVE.has(j.status))) throw new Error("busy");
		const client = this.options.client();
		if (client === void 0) throw new HunyuanError("not-configured");
		const model = request.model === "pro" ? "pro" : "rapid";
		const image = await prepareGenerateImage(input);
		if (this.jobs.some((j) => ACTIVE.has(j.status))) throw new Error("busy");
		const now = this.now();
		const job = {
			id: randomBytes(8).toString("hex"),
			name: cleanName(request.name) ?? "3D 桌宠",
			model,
			status: "submitting",
			createdAt: now,
			updatedAt: now,
			method: client.method,
			...request.use === true ? { use: true } : {}
		};
		writeFileAtomic(join(this.options.dir, job.id + ".png"), image.thumbnail);
		this.jobs.push(job);
		this.prune();
		this.save();
		try {
			job.remoteId = await client.submit(image.base64, model, this.abort.signal);
			this.patch(job, { status: "queued" });
			this.schedule(job, Math.min(1e3, this.pollDelay(0)));
		} catch (error) {
			if (this.abort.signal.aborted) throw error;
			this.fail(job, error);
		}
		return this.view(job);
	}
	/** Remove a finished job from the list. */
	dismiss(id) {
		const job = this.jobs.find((j) => j.id === id);
		if (job === void 0) throw new Error("job-not-found");
		if (ACTIVE.has(job.status)) throw new Error("job-active");
		this.jobs = this.jobs.filter((j) => j.id !== id);
		rmSync(join(this.options.dir, id + ".png"), { force: true });
		this.save();
	}
	/** Resolve when a job reaches done or failed. */
	settled(id) {
		const job = this.jobs.find((j) => j.id === id);
		if (job === void 0) return Promise.reject(/* @__PURE__ */ new Error("job-not-found"));
		if (!ACTIVE.has(job.status)) return Promise.resolve(this.view(job));
		return new Promise((resolve) => {
			const list = this.waiters.get(id) ?? [];
			list.push(resolve);
			this.waiters.set(id, list);
		});
	}
	/** Pick up jobs that were running when DSH last stopped. */
	resume() {
		const now = this.now();
		for (const job of this.jobs) {
			if (!ACTIVE.has(job.status)) continue;
			if (job.remoteId === void 0) this.fail(job, /* @__PURE__ */ new Error("interrupted"));
			else if (now - job.createdAt > JOB_TTL_MS) this.fail(job, /* @__PURE__ */ new Error("timeout"));
			else this.schedule(job, 500);
		}
	}
	/** Stop polling (jobs stay on disk and resume next time). */
	dispose() {
		this.abort.abort();
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
	}
	view(job) {
		return {
			id: job.id,
			name: job.name,
			model: job.model,
			status: job.status,
			createdAt: job.createdAt,
			updatedAt: job.updatedAt,
			...job.finishedAt === void 0 ? {} : { finishedAt: job.finishedAt },
			...job.petId === void 0 ? {} : { petId: job.petId },
			...job.error === void 0 ? {} : { error: job.error },
			...job.detail === void 0 ? {} : { detail: job.detail },
			...job.report === void 0 ? {} : { report: job.report },
			...existsSync(join(this.options.dir, job.id + ".png")) ? { inputUrl: "/api/dpet/generate/job/" + job.id + "/input.png" } : {}
		};
	}
	load() {
		try {
			const raw = JSON.parse(readFileSync(join(this.options.dir, "jobs.json"), "utf8"));
			return Array.isArray(raw) ? raw.filter(isRecord) : [];
		} catch {
			return [];
		}
	}
	save() {
		if (this.abort.signal.aborted) return;
		writeFileAtomic(join(this.options.dir, "jobs.json"), JSON.stringify(this.jobs, null, 2) + "\n");
	}
	/** Keep the newest records; finished ones go first. */
	prune() {
		while (this.jobs.length > MAX_JOBS) {
			const oldest = [...this.jobs].filter((j) => !ACTIVE.has(j.status)).sort((a, b) => a.createdAt - b.createdAt)[0];
			if (oldest === void 0) break;
			this.jobs = this.jobs.filter((j) => j !== oldest);
			rmSync(join(this.options.dir, oldest.id + ".png"), { force: true });
		}
	}
	patch(job, change) {
		Object.assign(job, change, { updatedAt: this.now() });
		this.save();
	}
	finish(job, change) {
		const now = this.now();
		Object.assign(job, change, {
			updatedAt: now,
			finishedAt: now
		});
		this.timers.delete(job.id);
		this.failures.delete(job.id);
		this.save();
		const view = this.view(job);
		for (const resolve of this.waiters.get(job.id) ?? []) resolve(view);
		this.waiters.delete(job.id);
	}
	fail(job, error) {
		if (error instanceof HunyuanError) this.finish(job, {
			status: "failed",
			error: error.code,
			...error.detail === void 0 ? {} : { detail: error.detail.slice(0, 300) }
		});
		else this.finish(job, {
			status: "failed",
			error: error instanceof Error ? error.message : String(error)
		});
	}
	schedule(job, delay) {
		if (this.abort.signal.aborted) return;
		const timer = setTimeout(() => {
			this.poll(job);
		}, delay);
		timer.unref?.();
		this.timers.set(job.id, timer);
	}
	async poll(job) {
		this.timers.delete(job.id);
		if (this.abort.signal.aborted || !ACTIVE.has(job.status) || job.remoteId === void 0) return;
		const age = this.now() - job.createdAt;
		if (age > 12e5) {
			this.fail(job, /* @__PURE__ */ new Error("timeout"));
			return;
		}
		const client = this.options.client();
		if (client === void 0) {
			this.fail(job, new HunyuanError("not-configured"));
			return;
		}
		if (job.method !== void 0 && client.method !== job.method) {
			this.fail(job, /* @__PURE__ */ new Error("credentials-changed"));
			return;
		}
		try {
			const remote = await client.query(job.remoteId, job.model, this.abort.signal);
			this.failures.delete(job.id);
			if (remote.state === "queued" || remote.state === "running") {
				if (job.status !== remote.state) this.patch(job, { status: remote.state });
				this.schedule(job, this.pollDelay(age));
				return;
			}
			if (remote.state === "failed") {
				const detail = [remote.code, remote.message].filter(Boolean).join(": ");
				this.fail(job, new HunyuanError("rejected", detail === "" ? void 0 : detail));
				return;
			}
			if (remote.glbUrl === void 0) {
				this.fail(job, new HunyuanError("no-glb"));
				return;
			}
			this.patch(job, { status: "downloading" });
			const data = await client.download(remote.glbUrl, IMPORT_LIMITS.glb, this.abort.signal);
			this.patch(job, { status: "importing" });
			const asset = await processUpload(data);
			if (asset.report.format !== "glb") throw new HunyuanError("no-glb");
			const entry = this.options.library.create({
				name: job.name,
				kind: "3d",
				file: asset.file,
				bytes: asset.report.finalBytes,
				...asset.report.finalTriangles === void 0 ? {} : { triangles: asset.report.finalTriangles },
				source: client.method === "mock" ? "腾讯混元 3D（演示模式）" : "腾讯混元 3D",
				createdAt: this.now()
			}, asset.data);
			if (job.use === true) this.options.settings.update({
				petId: entry.manifest.id,
				enabled: true
			});
			this.finish(job, {
				status: "done",
				petId: entry.manifest.id,
				report: asset.report
			});
		} catch (error) {
			if (this.abort.signal.aborted) return;
			const transient = error instanceof HunyuanError && (error.code === "network" || error.code === "remote-error" || error.code === "rate-limited");
			const count = (this.failures.get(job.id) ?? 0) + 1;
			if (transient && count < MAX_POLL_FAILURES) {
				this.failures.set(job.id, count);
				if (job.status !== "queued" && job.status !== "running") this.patch(job, { status: "running" });
				this.schedule(job, this.pollDelay(age) * 2);
				return;
			}
			this.fail(job, error);
		}
	}
};
//#endregion
//#region src/server/controller/generate-routes.ts
const GENERATE_PATH = "/api/dpet/generate";
function errorBody(error) {
	if (error instanceof HunyuanError) return {
		ok: false,
		error: error.code,
		...error.detail === void 0 ? {} : { detail: error.detail.slice(0, 300) }
	};
	return {
		ok: false,
		error: error instanceof Error ? error.message : String(error)
	};
}
function makeGenerateRoutes(deps) {
	const { generator, credentials } = deps;
	const root = async (req, res) => {
		if (!methodIs(req, res, "GET", "POST")) return;
		if (req.method === "GET") {
			writeJson(res, 200, {
				hunyuan: generator.status(),
				jobs: generator.list()
			});
			return;
		}
		const url = new URL(req.url ?? "/", "http://dpet.local");
		const data = await readBody(req, GENERATE_UPLOAD_LIMIT);
		try {
			writeJson(res, 200, {
				ok: true,
				job: await generator.start(data, {
					name: url.searchParams.get("name"),
					model: url.searchParams.get("model"),
					use: url.searchParams.get("use") === "1"
				})
			});
		} catch (error) {
			const body = errorBody(error);
			writeJson(res, body.error === "busy" ? 409 : 400, body);
		}
	};
	const saveCredentials = async (req, res) => {
		if (!methodIs(req, res, "POST")) return;
		const body = await readJson(req);
		if (body.clear === true) credentials.clear();
		else credentials.save(body);
		writeJson(res, 200, {
			ok: true,
			hunyuan: generator.status()
		});
	};
	const check = async (req, res) => {
		if (!methodIs(req, res, "POST")) return;
		try {
			await deps.check();
			writeJson(res, 200, { ok: true });
		} catch (error) {
			writeJson(res, 200, errorBody(error));
		}
	};
	const job = async (req, res) => {
		const segments = new URL(req.url ?? "/", "http://dpet.local").pathname.split("/").filter(Boolean);
		const [id, action] = segments.slice(4);
		if (segments.length !== 6 || id === void 0 || action === void 0 || !/^[a-z0-9]{6,32}$/.test(id)) {
			writeJson(res, 404, {
				ok: false,
				error: "not-found"
			});
			return;
		}
		if (action === "input.png") {
			if (!methodIs(req, res, "GET", "HEAD")) return;
			const file = generator.inputFile(id);
			if (file === void 0) {
				res.writeHead(404);
				res.end();
				return;
			}
			await sendFile(req, res, file);
			return;
		}
		if (action === "dismiss") {
			if (!methodIs(req, res, "POST")) return;
			generator.dismiss(id);
			writeJson(res, 200, { ok: true });
			return;
		}
		writeJson(res, 404, {
			ok: false,
			error: "not-found"
		});
	};
	return [
		{
			kind: "exact",
			path: GENERATE_PATH,
			handler: guarded(root)
		},
		{
			kind: "exact",
			path: GENERATE_PATH + "/credentials",
			handler: guarded(saveCredentials)
		},
		{
			kind: "exact",
			path: GENERATE_PATH + "/check",
			handler: guarded(check)
		},
		{
			kind: "prefix",
			path: JOB_PREFIX,
			handler: guarded(job)
		}
	];
}
//#endregion
//#region src/server/index.ts
/**
* DPet host half — runs inside the DSH host process.
*
* It follows the agent through the session events, keeps the pet library
* (built-in pets plus imports under $DSH_HOME/dpet), persists the settings,
* runs Tencent Hunyuan image-to-3D jobs with the user's own key, and serves
* all of it to the browser half over same-origin routes. The browser half
* (./client) draws the floating pet and the settings page.
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
	const credentials = new CredentialStore(join(dataDir, "credentials.json"));
	const mock = process.env.DPET_HUNYUAN_MOCK === "1";
	const mocked = mock ? mockClient(join(root, "assets", "pets", "dongdong", "dongdong.glb")) : void 0;
	const client = () => {
		if (mocked !== void 0) return mocked;
		const resolved = credentials.resolve();
		return resolved === void 0 ? void 0 : clientFor(resolved.credentials);
	};
	const generator = new Generator({
		dir: join(dataDir, "generate"),
		library,
		settings,
		credentials,
		client,
		mock
	});
	ctx.on("session/event", (session, event) => {
		tracker.onSessionEvent(String(session.id), event);
	});
	ctx.on("agent/assistant-stream", ({ agent, frame }) => {
		tracker.onStreamFrame(String(agent.session.id), frame);
	});
	ctx.on("session/disposed", (session) => {
		tracker.onSessionDisposed(String(session.id));
	});
	const routes = [...makeRoutes({
		tracker,
		library,
		settings,
		vendorDir: join(root, "lib"),
		generation: generator
	}), ...makeGenerateRoutes({
		generator,
		credentials,
		check: async () => {
			const current = client();
			if (current === void 0) throw new HunyuanError("not-configured");
			await current.check();
		}
	})];
	ctx.effect(() => {
		const disposers = routes.map((route) => ctx.webServer.register(route));
		return () => {
			for (const dispose of disposers) dispose();
		};
	}, "dpet: routes");
	ctx.effect(() => {
		generator.resume();
		return () => generator.dispose();
	}, "dpet: image-to-3D jobs");
	ctx.inject(["tools"], (toolsCtx) => {
		const tools = makeAgentTools({
			library,
			settings,
			generator
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
export { ActivityTracker, CredentialStore, DEFAULT_SETTINGS, Generator, PetLibrary, SettingsStore, apply, inject, makeAgentTools, makeGenerateRoutes, makeRoutes, name, projectSessionEvent, projectStreamFrame, sanitizeSettings };
