#!/usr/bin/env node

// src/index.ts
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ../core/dist/database.js
import { mkdirSync } from "fs";
import { homedir } from "os";
import { dirname, resolve } from "path";
import sqlite3 from "sqlite3";
var TaskDatabase = class {
  db;
  constructor(dbPath) {
    const actualDbPath = this.resolveDbPath(dbPath);
    const dir = dirname(actualDbPath);
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      console.error(`Failed to create database directory ${dir}:`, err);
      throw new Error(`Cannot create database directory: ${dir}`);
    }
    this.db = new sqlite3.Database(actualDbPath);
    this.initializeDatabase();
  }
  resolveDbPath(dbPath) {
    if (dbPath) {
      return resolve(dbPath);
    }
    const homeDir = homedir();
    return resolve(homeDir, ".kie-ai", "tasks.db");
  }
  initializeDatabase() {
    this.db.serialize(() => {
      this.db.run(`
        CREATE TABLE IF NOT EXISTS tasks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT UNIQUE NOT NULL,
          api_type TEXT NOT NULL,
          status TEXT DEFAULT 'pending',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          result_url TEXT,
          error_message TEXT,
          credits_consumed REAL
        )
      `);
      this.db.run(`ALTER TABLE tasks ADD COLUMN credits_consumed REAL`, (err) => {
        if (err && !err.message.includes("duplicate column name")) {
          console.error("Failed to add tasks.credits_consumed:", err);
        }
      });
      this.db.run(`
        CREATE TABLE IF NOT EXISTS generation_plans (
          plan_id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          plan_json TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          approval_context TEXT NOT NULL,
          submitted_at TEXT,
          task_results_json TEXT
        )
      `);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_task_id ON tasks(task_id)`);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_status ON tasks(status)`);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_generation_plans_status ON generation_plans(status)`);
      this.db.run(`ALTER TABLE generation_plans ADD COLUMN approval_context TEXT`, (err) => {
        if (err && !err.message.includes("duplicate column name")) {
          console.error("Failed to add generation_plans.approval_context:", err);
        }
      });
    });
  }
  async createTask(taskData) {
    return new Promise((resolve2, reject) => {
      this.db.run(`INSERT INTO tasks (task_id, api_type, status, result_url, error_message, credits_consumed)
         VALUES (?, ?, ?, ?, ?, ?)`, [
        taskData.task_id,
        taskData.api_type,
        taskData.status,
        taskData.result_url || null,
        taskData.error_message || null,
        taskData.credits_consumed ?? null
      ], (err) => {
        if (err)
          reject(err);
        else
          resolve2();
      });
    });
  }
  async getTask(taskId) {
    return new Promise((resolve2, reject) => {
      this.db.get(`SELECT * FROM tasks WHERE task_id = ?`, [taskId], (err, row) => {
        if (err)
          reject(err);
        else
          resolve2(row || null);
      });
    });
  }
  async updateTask(taskId, updates) {
    const updateFields = [];
    const values = [];
    if (updates.status) {
      updateFields.push("status = ?");
      values.push(updates.status);
    }
    if (updates.result_url) {
      updateFields.push("result_url = ?");
      values.push(updates.result_url);
    }
    if (updates.error_message) {
      updateFields.push("error_message = ?");
      values.push(updates.error_message);
    }
    if (updates.credits_consumed !== void 0) {
      updateFields.push("credits_consumed = ?");
      values.push(updates.credits_consumed);
    }
    updateFields.push("updated_at = CURRENT_TIMESTAMP");
    values.push(taskId);
    if (updateFields.length > 1) {
      return new Promise((resolve2, reject) => {
        this.db.run(`UPDATE tasks SET ${updateFields.join(", ")} WHERE task_id = ?`, values, (err) => {
          if (err)
            reject(err);
          else
            resolve2();
        });
      });
    }
  }
  async getAllTasks(limit = 100) {
    return new Promise((resolve2, reject) => {
      this.db.all(`SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?`, [limit], (err, rows) => {
        if (err)
          reject(err);
        else
          resolve2(rows);
      });
    });
  }
  async getTasksByStatus(status, limit = 50) {
    return new Promise((resolve2, reject) => {
      this.db.all(`SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC LIMIT ?`, [status, limit], (err, rows) => {
        if (err)
          reject(err);
        else
          resolve2(rows);
      });
    });
  }
  async createGenerationPlan(plan, approvalContext) {
    return new Promise((resolve2, reject) => {
      this.db.run(`INSERT INTO generation_plans (plan_id, status, created_at, expires_at, plan_json, request_hash, approval_context)
         VALUES (?, 'prepared', ?, ?, ?, ?, ?)`, [
        plan.id,
        plan.createdAt,
        plan.expiresAt,
        JSON.stringify(plan),
        plan.requestHash,
        approvalContext
      ], (err) => err ? reject(err) : resolve2());
    });
  }
  async getGenerationPlan(planId) {
    return new Promise((resolve2, reject) => {
      this.db.get(`SELECT status, plan_json, request_hash, task_results_json FROM generation_plans WHERE plan_id = ?`, [planId], (err, row) => {
        if (err)
          return reject(err);
        if (!row)
          return resolve2(null);
        const stored = row;
        try {
          resolve2({
            plan: JSON.parse(stored.plan_json),
            status: stored.status,
            requestHash: stored.request_hash,
            ...stored.task_results_json ? { results: JSON.parse(stored.task_results_json) } : {}
          });
        } catch (parseError) {
          reject(parseError);
        }
      });
    });
  }
  /** Atomically records approval for an unchanged, unexpired prepared plan. */
  async approveGenerationPlan(planId, requestHash, approvalContext) {
    return new Promise((resolve2, reject) => {
      this.db.run(`UPDATE generation_plans
         SET status = 'approved'
          WHERE plan_id = ? AND request_hash = ? AND approval_context = ? AND status = 'prepared' AND expires_at > ?`, [planId, requestHash, approvalContext, (/* @__PURE__ */ new Date()).toISOString()], function(err) {
        if (err)
          reject(err);
        else
          resolve2(this.changes === 1);
      });
    });
  }
  /** Atomically consumes an approved plan before any provider call can start. */
  async claimGenerationPlan(planId, requestHash, approvalContext) {
    return new Promise((resolve2, reject) => {
      this.db.run(`UPDATE generation_plans
         SET status = 'submitting', submitted_at = CURRENT_TIMESTAMP
          WHERE plan_id = ? AND request_hash = ? AND approval_context = ? AND status = 'approved' AND expires_at > ?`, [planId, requestHash, approvalContext, (/* @__PURE__ */ new Date()).toISOString()], function(err) {
        if (err)
          reject(err);
        else
          resolve2(this.changes === 1);
      });
    });
  }
  async finishGenerationPlan(planId, results) {
    return new Promise((resolve2, reject) => {
      this.db.run(`UPDATE generation_plans SET status = 'submitted', task_results_json = ? WHERE plan_id = ? AND status = 'submitting'`, [JSON.stringify(results), planId], (err) => err ? reject(err) : resolve2());
    });
  }
  /** A claimed plan is terminal after any provider result to prevent duplicate paid creates. */
  async failGenerationPlan(planId, results) {
    return new Promise((resolve2, reject) => {
      this.db.run(`UPDATE generation_plans SET status = 'failed', task_results_json = ? WHERE plan_id = ? AND status = 'submitting'`, [JSON.stringify(results), planId], (err) => err ? reject(err) : resolve2());
    });
  }
  async close() {
    return new Promise((resolve2, reject) => {
      this.db.close((err) => {
        if (err)
          reject(err);
        else
          resolve2();
      });
    });
  }
};

// ../core/dist/media-validation.js
import { isIP } from "node:net";
var SUPPORTED_UPLOAD_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/ogg",
  "audio/aac",
  "audio/mp4"
];
function startsWith(bytes, signature, offset = 0) {
  return signature.every((value, index) => bytes[offset + index] === value);
}
function detectUploadMimeType(bytes) {
  if (startsWith(bytes, [137, 80, 78, 71, 13, 10, 26, 10])) {
    return "image/png";
  }
  if (startsWith(bytes, [255, 216, 255]))
    return "image/jpeg";
  if (startsWith(bytes, [82, 73, 70, 70]) && startsWith(bytes, [87, 69, 66, 80], 8)) {
    return "image/webp";
  }
  if (startsWith(bytes, [26, 69, 223, 163]))
    return "video/webm";
  if (startsWith(bytes, [102, 116, 121, 112], 4))
    return "video/mp4";
  if (startsWith(bytes, [82, 73, 70, 70]) && startsWith(bytes, [87, 65, 86, 69], 8)) {
    return "audio/wav";
  }
  if (startsWith(bytes, [79, 103, 103, 83]))
    return "audio/ogg";
  if (startsWith(bytes, [73, 68, 51]))
    return "audio/mpeg";
  if (bytes.length >= 2 && bytes[0] === 255 && (bytes[1] & 224) === 224) {
    return "audio/mpeg";
  }
  if (bytes.length >= 2 && bytes[0] === 255 && (bytes[1] & 246) === 240) {
    return "audio/aac";
  }
  return null;
}
function normalizeUploadMimeType(value) {
  const normalized = value.toLowerCase().split(";", 1)[0].trim();
  if (normalized === "audio/x-wav")
    return "audio/wav";
  return SUPPORTED_UPLOAD_MIME_TYPES.includes(normalized) ? normalized : null;
}
function validateUploadBytes(bytes, declaredType) {
  if (bytes.length === 0)
    throw new Error("The upload is empty.");
  const detected = detectUploadMimeType(bytes);
  if (!detected)
    throw new Error("Unsupported or invalid media file.");
  if (declaredType) {
    const normalized = normalizeUploadMimeType(declaredType);
    const compatibleMp4 = detected === "video/mp4" && (normalized === "video/mp4" || normalized === "video/quicktime" || normalized === "audio/mp4");
    if (!normalized || normalized !== detected && !compatibleMp4) {
      throw new Error("The declared content_type does not match the file bytes.");
    }
    return normalized;
  }
  return detected;
}
function uploadPathForMimeType(type) {
  if (type.startsWith("video/"))
    return "videos/user-uploads";
  if (type.startsWith("audio/"))
    return "audios/user-uploads";
  return "images/user-uploads";
}
function validatePublicHttpUrl(value, label = "URL") {
  const url3 = new URL(value);
  const hostname = url3.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (url3.protocol !== "https:" && url3.protocol !== "http:" || url3.username || url3.password || url3.port && url3.port !== "80" && url3.port !== "443" || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal") || isIP(hostname) !== 0) {
    throw new Error(`${label} must be a public HTTP(S) hostname without credentials or a custom port.`);
  }
  return url3;
}

// ../core/dist/kie-ai-client.js
var KieAiRequestError = class extends Error {
  status;
  providerCode;
  constructor(message, status, providerCode) {
    super(message);
    this.status = status;
    this.providerCode = providerCode;
    this.name = "KieAiRequestError";
  }
};
function isAbortError(error) {
  return typeof error === "object" && error !== null && (error.name === "AbortError" || error.name === "TimeoutError");
}
function providerMessage(value, fallback) {
  if (typeof value === "object" && value !== null) {
    for (const key of ["msg", "message"]) {
      const message = value[key];
      if (typeof message === "string" && message.trim())
        return message;
    }
  }
  return fallback;
}
async function readResponseBytes(response, maxBytes) {
  const contentLength = Number(response.headers.get("content-length"));
  if (maxBytes !== void 0 && Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new KieAiRequestError("The provider result exceeded the download size limit.", 502);
  }
  if (!response.body) {
    const bytes2 = new Uint8Array(await response.arrayBuffer());
    if (maxBytes !== void 0 && bytes2.length > maxBytes) {
      throw new KieAiRequestError("The provider result exceeded the download size limit.", 502);
    }
    return bytes2;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (; ; ) {
      const { done, value } = await reader.read();
      if (done)
        break;
      total += value.byteLength;
      if (maxBytes !== void 0 && total > maxBytes) {
        await reader.cancel();
        throw new KieAiRequestError("The provider result exceeded the download size limit.", 502);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
var KieAiClient = class {
  config;
  constructor(config) {
    this.config = config;
  }
  callbackUrl(value) {
    return value || this.config.callbackUrlFallback || void 0;
  }
  fileUploadEndpoint(path) {
    const rawBase = this.config.fileUploadBaseUrl ?? "https://kieai.redpandaai.co";
    const parsed = new URL(rawBase);
    const isLoopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1";
    if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) {
      throw new Error("KIE_AI_FILE_UPLOAD_BASE_URL must be HTTPS without credentials, query, or fragment.");
    }
    let pathname = parsed.pathname.replace(/\/+$/, "");
    if (pathname.endsWith("/api/v1"))
      pathname = pathname.slice(0, -"/api/v1".length);
    if (pathname && pathname !== "/") {
      throw new Error("KIE_AI_FILE_UPLOAD_BASE_URL must not contain an application path.");
    }
    parsed.pathname = path;
    return parsed.toString();
  }
  async uploadRequest(endpoint, body, contentType) {
    const response = await fetch(this.fileUploadEndpoint(endpoint), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        ...contentType ? { "Content-Type": contentType } : {}
      },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(this.config.timeout)
    });
    let data;
    try {
      data = await response.json();
    } catch {
      throw new KieAiRequestError(`HTTP ${response.status}: The provider returned an invalid upload response.`, response.status);
    }
    if (!response.ok) {
      throw new KieAiRequestError(`HTTP ${response.status}: ${providerMessage(data, "The provider rejected the file upload.")}`, response.status, data.code);
    }
    if (data.data?.downloadUrl && !data.data.fileUrl) {
      data.data.fileUrl = data.data.downloadUrl;
    }
    const resultUrl = data.data?.downloadUrl ?? data.data?.fileUrl;
    if (resultUrl) {
      const parsed = validatePublicHttpUrl(resultUrl, "Kie upload result URL");
      if (parsed.protocol !== "https:") {
        throw new Error("Kie upload result URL must use HTTPS.");
      }
    }
    return data;
  }
  async makeRequest(endpoint, method = "POST", body) {
    const url3 = `${this.config.baseUrl}${endpoint}`;
    const headers = {
      Authorization: `Bearer ${this.config.apiKey}`,
      "Content-Type": "application/json"
    };
    const requestOptions = {
      method,
      headers,
      signal: AbortSignal.timeout(this.config.timeout)
    };
    if (body && method === "POST") {
      requestOptions.body = JSON.stringify(body);
    }
    try {
      const response = await fetch(url3, requestOptions);
      let data;
      try {
        data = await response.json();
      } catch {
        throw new KieAiRequestError(`HTTP ${response.status}: The provider returned an invalid response.`, response.status);
      }
      if (!response.ok) {
        throw new KieAiRequestError(`HTTP ${response.status}: ${providerMessage(data, "The provider rejected the request.")}`, response.status, data.code);
      }
      return data;
    } catch (error) {
      if (error instanceof KieAiRequestError || isAbortError(error)) {
        throw error;
      }
      if (error instanceof Error) {
        throw new Error(`Request failed: ${error.message}`);
      }
      throw error;
    }
  }
  async uploadFile(file, uploadPath = "images/user-uploads") {
    const form = new FormData();
    form.append("file", new Blob([file.bytes], { type: file.contentType }), file.filename);
    form.append("uploadPath", uploadPath);
    form.append("fileName", file.filename);
    try {
      return await this.uploadRequest("/api/file-stream-upload", form);
    } catch (error) {
      if (error instanceof KieAiRequestError || isAbortError(error)) {
        throw error;
      }
      if (error instanceof Error) {
        throw new Error(`Request failed: ${error.message}`);
      }
      throw error;
    }
  }
  async uploadBase64(request) {
    return this.uploadRequest("/api/file-base64-upload", JSON.stringify(request), "application/json");
  }
  async uploadFromUrl(request) {
    return this.uploadRequest("/api/file-url-upload", JSON.stringify(request), "application/json");
  }
  async downloadFile(url3, options = {}) {
    let currentUrl = url3;
    let previousUrl;
    const maxRedirects = options.maxRedirects ?? 3;
    for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
      options.validateUrl?.(currentUrl, previousUrl);
      try {
        const response = await fetch(currentUrl, {
          method: "GET",
          redirect: "manual",
          signal: AbortSignal.timeout(this.config.timeout)
        });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (!location || redirect === maxRedirects) {
            throw new KieAiRequestError("The provider result could not be downloaded.", response.status);
          }
          previousUrl = currentUrl;
          currentUrl = new URL(location, currentUrl).toString();
          continue;
        }
        if (!response.ok) {
          throw new KieAiRequestError(`HTTP ${response.status}: The provider result could not be downloaded.`, response.status);
        }
        return {
          bytes: await readResponseBytes(response, options.maxBytes),
          contentType: response.headers.get("content-type")
        };
      } catch (error) {
        if (error instanceof KieAiRequestError || isAbortError(error)) {
          throw error;
        }
        if (error instanceof Error) {
          throw new Error(`Request failed: ${error.message}`);
        }
        throw error;
      }
    }
    throw new KieAiRequestError("HTTP 502: The provider result could not be downloaded.", 502);
  }
  async generateNanoBananaImage(request) {
    const hasImageInput = !!request.image_input && request.image_input.length > 0;
    const isLite = request.model === "nano-banana-2-lite";
    const input = {
      prompt: request.prompt,
      ...request.aspect_ratio && { aspect_ratio: request.aspect_ratio }
    };
    if (isLite) {
      if (request.image_input && request.image_input.length > 10) {
        throw new Error("Nano Banana 2 Lite supports at most 10 reference images");
      }
      input.image_urls = request.image_input || [];
    } else {
      if (hasImageInput) {
        input.image_input = request.image_input;
      } else {
        input.image_input = [];
      }
      if (request.output_format)
        input.output_format = request.output_format;
      if (request.resolution)
        input.resolution = request.resolution;
      if (request.google_search)
        input.google_search = true;
    }
    const jobRequest = {
      model: request.model || "nano-banana-2",
      input,
      callBackUrl: this.callbackUrl(request.callBackUrl)
    };
    return this.makeRequest("/jobs/createTask", "POST", jobRequest);
  }
  async generateVeo3Video(request) {
    return this.makeRequest("/veo/generate", "POST", request);
  }
  async getTaskStatus(taskId, apiType) {
    if (apiType === "veo3") {
      return this.makeRequest(`/veo/record-info?taskId=${taskId}`, "GET");
    } else if (apiType === "nano-banana" || apiType === "nano-banana-edit" || apiType === "nano-banana-image") {
      return this.makeRequest(`/jobs/recordInfo?taskId=${taskId}`, "GET");
    } else if (apiType === "suno") {
      return this.makeRequest(`/generate/record-info?taskId=${taskId}`, "GET");
    } else if (apiType === "elevenlabs-tts" || apiType === "elevenlabs-sound-effects" || apiType === "bytedance-seedance-video" || apiType === "bytedance-seedream-image" || apiType === "qwen-image" || apiType === "wan-video" || apiType === "recraft-remove-background" || apiType === "ideogram-reframe" || apiType === "kling-3.0-video" || apiType === "hailuo" || apiType === "flux2-image" || apiType === "wan-animate" || apiType === "topaz-upscale" || apiType === "happyhorse-video" || apiType === "omnihuman-video" || apiType === "gemini-omni-video" || apiType === "gpt-image-2" || apiType === "z-image" || apiType === "grok-imagine") {
      return this.makeRequest(`/jobs/recordInfo?taskId=${taskId}`, "GET");
    } else if (apiType === "runway-aleph-video") {
      return this.makeRequest(`/api/v1/aleph/record-info?taskId=${taskId}`, "GET");
    } else if (apiType === "midjourney") {
      return this.makeRequest(`/mj/record-info?taskId=${taskId}`, "GET");
    } else if (apiType === "flux-kontext-image") {
      return this.makeRequest(`/flux/kontext/record-info?taskId=${taskId}`, "GET");
    }
    try {
      return await this.makeRequest(`/jobs/recordInfo?taskId=${taskId}`, "GET");
    } catch (error) {
      try {
        return await this.makeRequest(`/veo/record-info?taskId=${taskId}`, "GET");
      } catch (veoError) {
        try {
          return await this.makeRequest(`/generate/record-info?taskId=${taskId}`, "GET");
        } catch (sunoError) {
          try {
            return await this.makeRequest(`/mj/record-info?taskId=${taskId}`, "GET");
          } catch (mjError) {
            try {
              return this.makeRequest(`/flux/kontext/record-info?taskId=${taskId}`, "GET");
            } catch (fluxError) {
              throw error;
            }
          }
        }
      }
    }
  }
  async generateSunoMusic(request) {
    const jobRequest = {
      ...request,
      model: request.model || "V5"
    };
    return this.makeRequest("/generate", "POST", jobRequest);
  }
  async generateElevenLabsTTS(request) {
    const model = request.model === "multilingual" ? "elevenlabs/text-to-speech-multilingual-v2" : "elevenlabs/text-to-speech-turbo-2-5";
    const input = {
      text: request.text,
      voice: request.voice || "Rachel",
      stability: request.stability || 0.5,
      similarity_boost: request.similarity_boost || 0.75,
      style: request.style || 0,
      speed: request.speed || 1,
      timestamps: request.timestamps || false
    };
    if (request.model === "multilingual") {
      input.previous_text = request.previous_text || "";
      input.next_text = request.next_text || "";
    } else {
      input.language_code = request.language_code || "";
    }
    const jobRequest = {
      model,
      input,
      callBackUrl: this.callbackUrl(request.callBackUrl)
    };
    return this.makeRequest("/jobs/createTask", "POST", jobRequest);
  }
  async generateElevenLabsSoundEffects(request) {
    const jobRequest = {
      model: "elevenlabs/sound-effect-v2",
      input: {
        text: request.text,
        loop: request.loop || false,
        ...request.duration_seconds !== void 0 && {
          duration_seconds: request.duration_seconds
        },
        prompt_influence: request.prompt_influence || 0.3,
        output_format: request.output_format || "mp3_44100_192"
      },
      callBackUrl: this.callbackUrl(request.callBackUrl)
    };
    return this.makeRequest("/jobs/createTask", "POST", jobRequest);
  }
  async generateByteDanceSeedanceVideo(request) {
    const input = {
      prompt: request.prompt
    };
    for (const key of [
      "extension_task_id",
      "first_frame_url",
      "last_frame_url",
      "reference_image_urls",
      "reference_video_urls",
      "reference_audio_urls",
      "generate_audio",
      "resolution",
      "aspect_ratio",
      "duration",
      "return_last_frame"
    ]) {
      if (request[key] !== void 0)
        input[key] = request[key];
    }
    const jobRequest = {
      model: "bytedance/seedance-2-5",
      input,
      callBackUrl: this.callbackUrl(request.callBackUrl)
    };
    return this.makeRequest("/jobs/createTask", "POST", jobRequest);
  }
  async generateRunwayAlephVideo(request) {
    const jobRequest = {
      prompt: request.prompt,
      videoUrl: request.videoUrl,
      waterMark: request.waterMark || "",
      uploadCn: request.uploadCn || false,
      aspectRatio: request.aspectRatio || "16:9",
      ...request.seed !== void 0 && { seed: request.seed },
      ...request.referenceImage && { referenceImage: request.referenceImage },
      callBackUrl: this.callbackUrl(request.callBackUrl)
    };
    return this.makeRequest("/api/v1/aleph/generate", "POST", jobRequest);
  }
  async generateWanVideo(request) {
    const input = {};
    if (request.prompt)
      input.prompt = request.prompt;
    if (request.first_frame_url)
      input.first_frame_url = request.first_frame_url;
    if (request.last_frame_url)
      input.last_frame_url = request.last_frame_url;
    if (request.reference_image_urls?.length)
      input.reference_image_urls = request.reference_image_urls;
    if (request.reference_video_urls?.length)
      input.reference_video_urls = request.reference_video_urls;
    if (request.reference_audio_urls?.length)
      input.reference_audio_urls = request.reference_audio_urls;
    if (request.reference_file_urls?.length)
      input.reference_file_urls = request.reference_file_urls;
    if (request.reference_link_urls?.length)
      input.reference_link_urls = request.reference_link_urls;
    if (request.seed !== void 0)
      input.seed = request.seed;
    if (request.nsfw_checker !== void 0)
      input.nsfw_checker = request.nsfw_checker;
    input.resolution = request.resolution || "1080P";
    input.aspect_ratio = request.aspect_ratio || "adaptive";
    input.duration = request.duration || 5;
    input.audio = request.audio !== false;
    const jobRequest = {
      model: "wan/3-0-video",
      input,
      callBackUrl: this.callbackUrl(request.callBackUrl)
    };
    return this.makeRequest("/jobs/createTask", "POST", jobRequest);
  }
  async generateByteDanceSeedreamImage(request) {
    const isEdit = !!request.image_urls && request.image_urls.length > 0;
    const isV5Lite = request.version === "5-lite" || !request.version;
    const isV5Pro = request.version === "5-pro";
    let model;
    let input;
    if (isV5Pro) {
      if (request.image_urls && request.image_urls.length > 10) {
        throw new Error("Seedream 5 Pro supports at most 10 reference images");
      }
      model = isEdit ? "seedream/5-pro-image-to-image" : "seedream/5-pro-text-to-image";
      input = {
        prompt: request.prompt,
        aspect_ratio: request.aspect_ratio || "1:1",
        quality: request.quality || "basic",
        output_format: request.output_format || "png",
        nsfw_checker: request.nsfw_checker === true
      };
      if (isEdit)
        input.image_urls = request.image_urls;
    } else if (isV5Lite) {
      model = isEdit ? "seedream/5-lite-image-to-image" : "seedream/5-lite-text-to-image";
      input = {
        prompt: request.prompt,
        aspect_ratio: request.aspect_ratio || "1:1",
        quality: request.quality || "basic"
      };
      if (isEdit) {
        input.image_urls = request.image_urls;
      }
    } else {
      model = isEdit ? "bytedance/seedream-v4-edit" : "bytedance/seedream-v4-text-to-image";
      input = {
        prompt: request.prompt,
        image_size: request.image_size || "1:1",
        image_resolution: request.image_resolution || "1K",
        max_images: request.max_images || 1,
        seed: request.seed !== void 0 ? request.seed : -1
      };
      if (isEdit) {
        input.image_urls = request.image_urls;
      }
    }
    const jobRequest = {
      model,
      input,
      callBackUrl: this.callbackUrl(request.callBackUrl)
    };
    return this.makeRequest("/jobs/createTask", "POST", jobRequest);
  }
  async generateOmniHumanVideo(request) {
    const input = {
      image_url: request.image_url,
      audio_url: request.audio_url,
      output_resolution: request.output_resolution || "1080",
      pe_fast_mode: request.pe_fast_mode === true,
      seed: request.seed ?? -1
    };
    if (request.mask_url?.length)
      input.mask_url = request.mask_url;
    if (request.prompt)
      input.prompt = request.prompt;
    return this.makeRequest("/jobs/createTask", "POST", {
      model: "omnihuman-1-5",
      input,
      callBackUrl: this.callbackUrl(request.callBackUrl)
    });
  }
  async generateGeminiOmni(request) {
    if (request.operation === "audio") {
      return this.makeRequest("/omni/audio/create", "POST", {
        audio_id: request.audio_id,
        name: request.name,
        ...request.voice_description && {
          voice_description: request.voice_description
        },
        ...request.example_dialogue && {
          example_dialogue: request.example_dialogue
        }
      });
    }
    if (request.operation === "character") {
      return this.makeRequest("/omni/character/create", "POST", {
        descriptions: request.descriptions,
        image_urls: request.image_urls,
        ...request.audio_ids?.length && { audio_ids: request.audio_ids },
        ...request.character_name && {
          character_name: request.character_name
        }
      });
    }
    const input = { prompt: request.prompt };
    for (const key of [
      "image_urls",
      "audio_ids",
      "video_list",
      "character_ids",
      "duration",
      "aspect_ratio",
      "resolution",
      "seed"
    ]) {
      if (request[key] !== void 0)
        input[key] = request[key];
    }
    return this.makeRequest("/jobs/createTask", "POST", {
      model: "gemini-omni-video",
      input,
      callBackUrl: this.callbackUrl(request.callBackUrl)
    });
  }
  async generateQwenImage(request) {
    const isEdit = !!request.image_url;
    const model = isEdit ? "qwen/image-edit" : "qwen/text-to-image";
    const input = {
      prompt: request.prompt,
      image_size: request.image_size || "square_hd",
      num_inference_steps: request.num_inference_steps || (isEdit ? 25 : 30),
      seed: request.seed,
      guidance_scale: request.guidance_scale || (isEdit ? 4 : 2.5),
      enable_safety_checker: request.enable_safety_checker === true,
      output_format: request.output_format || "png",
      negative_prompt: request.negative_prompt || (isEdit ? "blurry, ugly" : " "),
      acceleration: request.acceleration || "none"
    };
    if (isEdit) {
      input.image_url = request.image_url;
      if (request.num_images) {
        input.num_images = request.num_images;
      }
      if (request.sync_mode !== void 0) {
        input.sync_mode = request.sync_mode;
      }
    }
    const jobRequest = {
      model,
      input,
      callBackUrl: this.callbackUrl(request.callBackUrl)
    };
    return this.makeRequest("/jobs/createTask", "POST", jobRequest);
  }
  async generateMidjourney(request) {
    let taskType = request.taskType;
    const hasImage = request.fileUrl || request.fileUrls && request.fileUrls.length > 0;
    const isVideoMode = request.motion || request.videoBatchSize || request.high_definition_video;
    const isOmniMode = request.ow || request.taskType === "mj_omni_reference";
    const isStyleMode = request.taskType === "mj_style_reference";
    if (!taskType) {
      if (isOmniMode) {
        taskType = "mj_omni_reference";
      } else if (isStyleMode) {
        taskType = "mj_style_reference";
      } else if (isVideoMode) {
        taskType = request.high_definition_video ? "mj_video_hd" : "mj_video";
      } else if (hasImage) {
        taskType = "mj_img2img";
      } else {
        taskType = "mj_txt2img";
      }
    }
    const payload = {
      taskType,
      prompt: request.prompt,
      aspectRatio: request.aspectRatio || "16:9",
      version: request.version || "7",
      enableTranslation: request.enableTranslation || false,
      callBackUrl: this.callbackUrl(request.callBackUrl)
    };
    if (request.fileUrls && request.fileUrls.length > 0) {
      payload.fileUrls = request.fileUrls;
    } else if (request.fileUrl) {
      payload.fileUrls = [request.fileUrl];
    }
    if (request.speed && !["mj_video", "mj_video_hd", "mj_omni_reference"].includes(taskType)) {
      payload.speed = request.speed;
    }
    if (request.variety !== void 0) {
      payload.variety = request.variety;
    }
    if (request.stylization !== void 0) {
      payload.stylization = request.stylization;
    }
    if (request.weirdness !== void 0) {
      payload.weirdness = request.weirdness;
    }
    if (request.waterMark !== void 0) {
      payload.waterMark = request.waterMark;
    }
    if (taskType === "mj_omni_reference" && request.ow) {
      payload.ow = request.ow;
    }
    if (taskType === "mj_video" || taskType === "mj_video_hd") {
      payload.motion = request.motion === void 0 ? "high" : request.motion >= 50 ? "high" : "low";
      if (request.videoBatchSize) {
        payload.videoBatchSize = parseInt(request.videoBatchSize.toString());
      }
    }
    return this.makeRequest("/mj/generate", "POST", payload);
  }
  async generateGptImage2(request) {
    const hasInputUrls = request.input_urls && request.input_urls.length > 0;
    const model = hasInputUrls ? "gpt-image-2-image-to-image" : "gpt-image-2-text-to-image";
    const input = {
      prompt: request.prompt
    };
    if (hasInputUrls)
      input.input_urls = request.input_urls;
    if (request.aspect_ratio)
      input.aspect_ratio = request.aspect_ratio;
    if (request.resolution)
      input.resolution = request.resolution;
    const jobRequest = {
      model,
      input,
      callBackUrl: this.callbackUrl(request.callBackUrl)
    };
    return this.makeRequest("/jobs/createTask", "POST", jobRequest);
  }
  async generateHappyHorseVideo(request) {
    const mode = request.mode || (request.video_url ? "video-edit" : request.reference_image?.length ? "reference-to-video" : request.image_urls?.length ? "image-to-video" : "text-to-video");
    const modelMap = {
      "text-to-video": "happyhorse/text-to-video",
      "image-to-video": "happyhorse/image-to-video",
      "reference-to-video": "happyhorse/reference-to-video",
      "video-edit": "happyhorse/video-edit"
    };
    const model = modelMap[mode];
    const input = { prompt: request.prompt };
    if (request.image_urls?.length)
      input.image_urls = request.image_urls;
    if (request.reference_image?.length)
      input.reference_image = request.reference_image;
    if (request.video_url)
      input.video_url = request.video_url;
    if (request.reference_image_edit?.length)
      input.reference_image_edit = request.reference_image_edit;
    if (request.audio_setting)
      input.audio_setting = request.audio_setting;
    if (request.seed !== void 0)
      input.seed = request.seed;
    input.resolution = request.resolution || "1080p";
    input.aspect_ratio = request.aspect_ratio || "16:9";
    input.duration = request.duration || 5;
    const jobRequest = {
      model,
      input,
      callBackUrl: this.callbackUrl(request.callBackUrl)
    };
    return this.makeRequest("/jobs/createTask", "POST", jobRequest);
  }
  async generateFluxKontextImage(request) {
    const payload = {
      prompt: request.prompt,
      enableTranslation: request.enableTranslation !== false,
      // Default to true
      uploadCn: request.uploadCn || false,
      aspectRatio: request.aspectRatio || "16:9",
      outputFormat: request.outputFormat || "jpeg",
      promptUpsampling: request.promptUpsampling || false,
      model: request.model || "flux-kontext-pro",
      callBackUrl: this.callbackUrl(request.callBackUrl),
      safetyTolerance: request.safetyTolerance || 6
    };
    if (request.inputImage) {
      payload.inputImage = request.inputImage;
    }
    if (request.watermark) {
      payload.watermark = request.watermark;
    }
    return this.makeRequest("/flux/kontext/generate", "POST", payload);
  }
  async generateRecraftRemoveBackground(request) {
    const jobRequest = {
      model: "recraft/remove-background",
      input: {
        image: request.image
      },
      callBackUrl: this.callbackUrl(request.callBackUrl)
    };
    return this.makeRequest("/jobs/createTask", "POST", jobRequest);
  }
  async generateIdeogramReframe(request) {
    const jobRequest = {
      model: "ideogram/v3-reframe",
      input: {
        image_url: request.image_url,
        image_size: request.image_size,
        rendering_speed: request.rendering_speed,
        style: request.style,
        num_images: request.num_images,
        seed: request.seed
      },
      callBackUrl: this.callbackUrl(request.callBackUrl)
    };
    return this.makeRequest("/jobs/createTask", "POST", jobRequest);
  }
  async getVeo1080pVideo(taskId, index) {
    const params = new URLSearchParams({ taskId });
    if (index !== void 0) {
      params.append("index", index.toString());
    }
    return this.makeRequest(`/veo/get-1080p-video?${params}`, "GET");
  }
  async generateKlingVideo(request) {
    const input = {
      prompt: request.prompt,
      duration: request.duration || "5",
      aspect_ratio: request.aspect_ratio || "16:9",
      mode: request.mode || "std",
      sound: request.sound ?? false
    };
    if (request.image_urls && request.image_urls.length > 0) {
      input.image_urls = request.image_urls;
    }
    if (request.multi_shots) {
      input.multi_shots = true;
      if (request.multi_prompt) {
        input.multi_prompt = request.multi_prompt;
      }
    }
    if (request.kling_elements && request.kling_elements.length > 0) {
      input.kling_elements = request.kling_elements;
    }
    const jobRequest = {
      model: "kling-3.0/video",
      input,
      callBackUrl: this.callbackUrl(request.callBackUrl)
    };
    return this.makeRequest("/jobs/createTask", "POST", jobRequest);
  }
  async generateHailuoVideo(request) {
    const hasReferenceInputs = Boolean(request.referenceImageUrls?.length || request.referenceVideoUrls?.length || request.referenceAudioUrls?.length);
    let model;
    const input = {
      prompt: request.prompt,
      duration: request.duration
    };
    if (request.imageUrl) {
      model = "minimax-h3/image-to-video";
      input.first_frame_url = request.imageUrl;
      if (request.endImageUrl)
        input.last_frame_url = request.endImageUrl;
    } else if (hasReferenceInputs) {
      model = "minimax-h3/reference-to-video";
      if (request.referenceImageUrls) {
        input.reference_image_urls = request.referenceImageUrls;
      }
      if (request.referenceVideoUrls) {
        input.reference_video_urls = request.referenceVideoUrls;
      }
      if (request.referenceAudioUrls) {
        input.reference_audio_urls = request.referenceAudioUrls;
      }
      if (request.aspectRatio)
        input.aspect_ratio = request.aspectRatio;
      if (request.resolution)
        input.resolution = request.resolution;
    } else {
      model = "minimax-h3/text-to-video";
      input.aspect_ratio = request.aspectRatio;
    }
    const jobRequest = {
      model,
      input,
      callBackUrl: this.callbackUrl(request.callBackUrl)
    };
    return this.makeRequest("/jobs/createTask", "POST", jobRequest);
  }
  async generateFlux2Image(request) {
    const hasInputUrls = !!request.input_urls && request.input_urls.length > 0;
    const modelType = request.model_type || "pro";
    let model;
    if (hasInputUrls) {
      model = modelType === "flex" ? "flux-2/flex-image-to-image" : "flux-2/pro-image-to-image";
    } else {
      model = modelType === "flex" ? "flux-2/flex-text-to-image" : "flux-2/pro-text-to-image";
    }
    const input = {
      prompt: request.prompt,
      aspect_ratio: request.aspect_ratio || "1:1",
      resolution: request.resolution || "1K"
    };
    if (hasInputUrls) {
      input.input_urls = request.input_urls;
    }
    const jobRequest = {
      model,
      input,
      callBackUrl: this.callbackUrl(request.callBackUrl)
    };
    return this.makeRequest("/jobs/createTask", "POST", jobRequest);
  }
  async generateWanAnimate(request) {
    const model = request.mode === "replace" ? "wan/2-2-animate-replace" : "wan/2-2-animate-move";
    const input = {
      video_url: request.video_url,
      image_url: request.image_url,
      resolution: request.resolution || "480p"
    };
    const jobRequest = {
      model,
      input,
      callBackUrl: this.callbackUrl(request.callBackUrl)
    };
    return this.makeRequest("/jobs/createTask", "POST", jobRequest);
  }
  async generateZImage(request) {
    const input = {
      prompt: request.prompt,
      aspect_ratio: request.aspect_ratio || "1:1"
    };
    const jobRequest = {
      model: "z-image",
      input,
      callBackUrl: this.callbackUrl(request.callBackUrl)
    };
    return this.makeRequest("/jobs/createTask", "POST", jobRequest);
  }
  async generateGrokImagine(request) {
    const hasImageUrls = request.image_urls && request.image_urls.length > 0;
    const hasTaskId = !!request.task_id;
    const hasPrompt = !!request.prompt;
    let mode = request.generation_mode || (hasTaskId && !hasPrompt && !hasImageUrls ? "upscale" : hasImageUrls || hasTaskId ? "image-to-video" : "text-to-video");
    if (request.generation_mode === "text-to-image") {
      mode = "text-to-image";
    }
    let model;
    let input = {};
    switch (mode) {
      case "upscale":
        model = "grok-imagine/upscale";
        input = { task_id: request.task_id };
        break;
      case "image-to-video":
        model = "grok-imagine/image-to-video";
        if (hasImageUrls) {
          input.image_urls = request.image_urls;
        }
        if (hasTaskId) {
          input.task_id = request.task_id;
          if (request.index !== void 0) {
            input.index = request.index;
          }
        }
        if (hasPrompt) {
          input.prompt = request.prompt;
        }
        if (request.aspect_ratio) {
          input.aspect_ratio = request.aspect_ratio;
        }
        input.mode = request.mode || "normal";
        break;
      case "text-to-video":
        model = "grok-imagine/text-to-video";
        input = {
          prompt: request.prompt,
          aspect_ratio: request.aspect_ratio || "1:1",
          mode: request.mode || "normal"
        };
        break;
      case "image-to-image":
        model = "grok-imagine-image-2-0/image-edit";
        input = {
          prompt: request.prompt,
          aspect_ratio: request.aspect_ratio || "1:1",
          image_urls: request.image_urls
        };
        break;
      case "text-to-image":
        model = "grok-imagine-image-2-0/text-to-image";
        input = {
          prompt: request.prompt,
          aspect_ratio: request.aspect_ratio || "1:1"
        };
        break;
      default:
        throw new Error(`Unsupported Grok Imagine generation mode: ${mode}`);
    }
    const jobRequest = {
      model,
      input,
      callBackUrl: this.callbackUrl(request.callBackUrl)
    };
    return this.makeRequest("/jobs/createTask", "POST", jobRequest);
  }
  async generateInfiniTalk(request) {
    const input = {
      image_url: request.image_url,
      audio_url: request.audio_url,
      prompt: request.prompt,
      resolution: request.resolution || "480p"
    };
    if (request.seed !== void 0) {
      input.seed = request.seed;
    }
    const jobRequest = {
      model: "infinitalk/from-audio",
      input,
      callBackUrl: this.callbackUrl(request.callBackUrl)
    };
    return this.makeRequest("/jobs/createTask", "POST", jobRequest);
  }
  async generateTopazUpscaleImage(request) {
    const jobRequest = {
      model: "topaz/image-upscale",
      input: {
        image_url: request.image_url,
        upscale_factor: request.upscale_factor || "2"
      },
      callBackUrl: this.callbackUrl(request.callBackUrl)
    };
    return this.makeRequest("/jobs/createTask", "POST", jobRequest);
  }
  async generateKlingAvatar(request) {
    const quality = request.quality || "standard";
    const model = quality === "pro" ? "kling/ai-avatar-v1-pro" : "kling/v1-avatar-standard";
    const input = {
      image_url: request.image_url,
      audio_url: request.audio_url,
      prompt: request.prompt
    };
    const jobRequest = {
      model,
      input,
      callBackUrl: this.callbackUrl(request.callBackUrl)
    };
    return this.makeRequest("/jobs/createTask", "POST", jobRequest);
  }
};

// ../core/dist/tools/format-error.js
function formatToolError(toolName, error, paramDescriptions) {
  let errorMessage = "Unknown error";
  let errorDetails = "";
  if (error instanceof Error) {
    errorMessage = error.message;
    if (errorMessage.includes("ZodError")) {
      const lines = errorMessage.split("\n");
      const validationErrors = lines.filter((line) => line.includes("Expected") || line.includes("Required") || line.includes("Invalid"));
      if (validationErrors.length > 0) {
        errorDetails = `Validation errors:
${validationErrors.map((err) => `- ${err.trim()}`).join("\n")}`;
      }
    }
  }
  const paramGuidance = Object.entries(paramDescriptions).map(([param, desc]) => `- ${param}: ${desc}`).join("\n");
  return {
    // `isError` marks the tool call as failed for MCP clients (and future
    // outputSchema validation releases tools whose structured content is
    // absent on error). CLI adapters ignore it and keep printing the text.
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({
          success: false,
          tool: toolName,
          error: errorMessage,
          details: errorDetails,
          parameter_guidance: paramGuidance,
          message: `Failed to execute ${toolName}. Check parameters and try again.`
        }, null, 2)
      }
    ],
    structuredContent: {
      success: false,
      tool: toolName,
      error: errorMessage
    }
  };
}

// ../core/dist/tools/bytedance_seedance_video.js
import { z as z2 } from "zod";

// ../core/dist/types.js
import { z } from "zod";
var NanoBananaImageSchema = z.object({
  model: z.enum(["nano-banana-2", "nano-banana-2-lite"]).default("nano-banana-2").optional().describe("Nano Banana model: nano-banana-2 supports up to 4K and 14 references; nano-banana-2-lite is the faster 1K model with up to 10 references"),
  // Text-to-image parameters
  prompt: z.string().min(1).max(5e3).optional().describe("Text prompt for image generation or editing (max 20000 chars). Nano Banana models support up to 20K characters."),
  // Edit mode parameters - up to 14 reference images for multi-reference
  image_input: z.array(z.string().url()).min(1).max(14).optional().describe("Array of reference image URLs for editing mode (up to 14 images for multi-reference)"),
  // Common parameters for generate/edit modes
  output_format: z.enum(["png", "jpg"]).default("png").optional().describe("Output format for generate/edit modes"),
  aspect_ratio: z.enum([
    "1:1",
    "1:4",
    "1:8",
    "2:3",
    "3:2",
    "3:4",
    "4:1",
    "4:3",
    "4:5",
    "5:4",
    "8:1",
    "9:16",
    "16:9",
    "21:9",
    "auto"
  ]).default("1:1").optional().describe("Aspect ratio for generate/edit modes"),
  resolution: z.enum(["1K", "2K", "4K"]).default("1K").optional().describe("Output resolution: 1K (8 credits), 2K (12 credits), 4K (18 credits)"),
  google_search: z.boolean().default(false).optional().describe("Enable Google Search grounding for factual image generation"),
  callBackUrl: z.string().url().optional().describe("Optional URL for task completion notifications (uses KIE_AI_CALLBACK_URL if not provided)")
}).refine((data) => {
  const hasPrompt = !!data.prompt;
  const hasImageInput = !!data.image_input && data.image_input.length > 0;
  if (data.model === "nano-banana-2-lite" && ((data.image_input?.length || 0) > 10 || data.resolution !== void 0 && data.resolution !== "1K")) {
    return false;
  }
  if (hasImageInput) {
    return hasPrompt;
  }
  if (hasPrompt) {
    return true;
  }
  return false;
}, {
  message: "Invalid parameter combination. Provide either: 1) prompt only (generate mode), or 2) prompt + image_input (edit mode)",
  path: []
});
var Veo3GenerateSchema = z.object({
  prompt: z.string().min(1).max(2e3).describe("Text prompt describing desired video content"),
  imageUrls: z.array(z.string().url()).min(1).max(2).optional().describe("Image URLs for image-to-video generation: 1 image (video unfolds around it) or 2 images (first=start frame, second=end frame)"),
  model: z.enum(["veo3", "veo3_fast"]).default("veo3").describe("Model type: veo3 (quality) or veo3_fast (cost-efficient)"),
  watermark: z.string().max(100).optional().describe("Watermark text to add to video"),
  aspectRatio: z.enum(["16:9", "9:16", "Auto"]).default("16:9").describe("Video aspect ratio (16:9 supports 1080P)"),
  seeds: z.number().int().min(1e4).max(99999).optional().describe("Random seed for consistent results"),
  callBackUrl: z.string().url().optional().describe("Callback URL for task completion notifications"),
  enableFallback: z.boolean().default(false).describe("Enable fallback mechanism for content policy failures (Note: fallback videos cannot use 1080P endpoint)"),
  enableTranslation: z.boolean().default(true).optional().describe("Auto-translate prompts to English for better results")
});
var SunoGenerateSchema = z.object({
  prompt: z.string().min(1).max(5e3).describe("Description of the desired audio content. In custom mode: used as exact lyrics (max 5000 chars for V4_5+, V5; 3000 for V3_5, V4). In non-custom mode: core idea for auto-generated lyrics (max 500 chars)"),
  customMode: z.boolean().describe("Enable advanced parameter customization. If true: requires style and title. If false: simplified mode with only prompt required"),
  instrumental: z.boolean().describe("Generate instrumental music (no lyrics). In custom mode: if true, only style and title required; if false, prompt used as exact lyrics"),
  model: z.enum(["V3_5", "V4", "V4_5", "V4_5PLUS", "V5", "V5_5"]).default("V5").optional().describe("AI model version for generation"),
  callBackUrl: z.string().url().optional().describe("URL to receive task completion updates (optional, will use KIE_AI_CALLBACK_URL env var if not provided)"),
  style: z.string().max(1e3).optional().describe("Music style/genre (required in custom mode, max 1000 chars for V4_5+, V5; 200 for V3_5, V4)"),
  title: z.string().max(80).optional().describe("Track title (required in custom mode, max 80 chars)"),
  duration: z.number().int().positive().optional().describe("Requested track duration in seconds (available only with V5_5)"),
  negativeTags: z.string().max(200).optional().describe("Music styles to exclude (optional, max 200 chars)"),
  vocalGender: z.enum(["m", "f"]).optional().describe("Vocal gender preference (optional, only effective in custom mode)"),
  styleWeight: z.number().min(0).max(1).multipleOf(0.01).optional().describe("Strength of style adherence (optional, range 0-1, up to 2 decimal places)"),
  weirdnessConstraint: z.number().min(0).max(1).multipleOf(0.01).optional().describe("Controls experimental/creative deviation (optional, range 0-1, up to 2 decimal places)"),
  audioWeight: z.number().min(0).max(1).multipleOf(0.01).optional().describe("Balance weight for audio features (optional, range 0-1, up to 2 decimal places)")
}).refine((data) => {
  if (data.customMode) {
    if (data.instrumental) {
      if (!data.style || !data.title)
        return false;
    } else {
      if (!data.style || !data.title || !data.prompt)
        return false;
    }
  }
  if (data.duration !== void 0 && data.model !== "V5_5")
    return false;
  return true;
}, {
  message: "In customMode: style and title are always required, prompt is required when instrumental is false. duration is only available with V5_5.",
  path: []
});
var ElevenLabsTTSSchema = z.object({
  text: z.string().min(1).max(5e3).describe("The text to convert to speech (max 5000 characters)"),
  model: z.enum(["turbo", "multilingual"]).default("turbo").optional().describe("TTS model to use - turbo (faster, default) or multilingual (supports context)"),
  voice: z.enum([
    "Rachel",
    "Aria",
    "Roger",
    "Sarah",
    "Laura",
    "Charlie",
    "George",
    "Callum",
    "River",
    "Liam",
    "Charlotte",
    "Alice",
    "Matilda",
    "Will",
    "Jessica",
    "Eric",
    "Chris",
    "Brian",
    "Daniel",
    "Lily",
    "Bill"
  ]).default("Rachel").optional().describe("Voice to use for speech generation"),
  stability: z.number().min(0).max(1).multipleOf(0.01).default(0.5).optional().describe("Voice stability (0-1, step 0.01)"),
  similarity_boost: z.number().min(0).max(1).multipleOf(0.01).default(0.75).optional().describe("Similarity boost (0-1, step 0.01)"),
  style: z.number().min(0).max(1).multipleOf(0.01).default(0).optional().describe("Style exaggeration (0-1, step 0.01)"),
  speed: z.number().min(0.7).max(1.2).multipleOf(0.01).default(1).optional().describe("Speech speed (0.7-1.2, step 0.01)"),
  timestamps: z.boolean().default(false).optional().describe("Whether to return timestamps for each word"),
  previous_text: z.string().max(5e3).default("").optional().describe("Text that came before current request (multilingual model only, max 5000 characters)"),
  next_text: z.string().max(5e3).default("").optional().describe("Text that comes after current request (multilingual model only, max 5000 characters)"),
  language_code: z.string().max(500).default("").optional().describe("Language code (ISO 639-1) for language enforcement (turbo model only)"),
  callBackUrl: z.string().url().optional().describe("Optional: URL for task completion notifications (uses KIE_AI_CALLBACK_URL env var if not provided)")
});
var ElevenLabsSoundEffectsSchema = z.object({
  text: z.string().min(1).max(5e3).describe("The text describing the sound effect to generate (max 5000 characters)"),
  loop: z.boolean().default(false).optional().describe("Whether to create a sound effect that loops smoothly"),
  duration_seconds: z.number().min(0.5).max(22).multipleOf(0.1).optional().describe("Duration in seconds (0.5-22). If not specified, optimal duration will be determined from prompt"),
  prompt_influence: z.number().min(0).max(1).multipleOf(0.01).default(0.3).optional().describe("How closely to follow the prompt (0-1). Higher values mean less variation"),
  output_format: z.enum([
    "mp3_22050_32",
    "mp3_44100_32",
    "mp3_44100_64",
    "mp3_44100_96",
    "mp3_44100_128",
    "mp3_44100_192",
    "pcm_8000",
    "pcm_16000",
    "pcm_22050",
    "pcm_24000",
    "pcm_44100",
    "pcm_48000",
    "ulaw_8000",
    "alaw_8000",
    "opus_48000_32",
    "opus_48000_64",
    "opus_48000_96",
    "opus_48000_128",
    "opus_48000_192"
  ]).default("mp3_44100_192").optional().describe("Output format of the generated audio"),
  callBackUrl: z.string().url().optional().describe("Optional: URL for task completion notifications (uses KIE_AI_CALLBACK_URL env var if not provided)")
});
var ByteDanceSeedanceVideoSchema = z.object({
  prompt: z.string().min(1).describe("Text prompt for video generation"),
  extension_task_id: z.string().min(1).optional().describe("Experimental: previous Seedance task ID used as semantic continuation context; does not guarantee frame-to-frame continuity"),
  first_frame_url: z.string().url().optional().describe("URL of the first-frame image for image-to-video"),
  last_frame_url: z.string().url().optional().describe("URL of the last-frame image; requires first_frame_url"),
  reference_image_urls: z.array(z.string().url()).optional().describe("Reference image URLs for multimodal reference-to-video"),
  reference_video_urls: z.array(z.string().url()).optional().describe("Reference video URLs for multimodal reference-to-video"),
  reference_audio_urls: z.array(z.string().url()).optional().describe("Reference audio URLs for multimodal reference-to-video"),
  return_last_frame: z.boolean().optional().describe("Return the generated last frame when requested"),
  generate_audio: z.boolean().optional().describe("Generate audio for the video when requested"),
  resolution: z.string().min(1).optional().describe("Output resolution (the official example uses 720p)"),
  aspect_ratio: z.string().min(1).optional().describe("Aspect ratio of the generated video"),
  duration: z.number().int().optional().describe("Video duration in seconds (the official example uses 15)"),
  callBackUrl: z.string().url().optional().describe("Optional: URL for task completion notifications (uses KIE_AI_CALLBACK_URL env var if not provided)")
}).strict().superRefine((data, ctx) => {
  const hasFrames = Boolean(data.first_frame_url || data.last_frame_url);
  const hasReferences = Boolean(data.reference_image_urls?.length || data.reference_video_urls?.length || data.reference_audio_urls?.length);
  if (data.last_frame_url && !data.first_frame_url) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["last_frame_url"],
      message: "last_frame_url requires first_frame_url."
    });
  }
  if (hasFrames && hasReferences) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [],
      message: "Frame inputs and multimodal reference inputs are mutually exclusive."
    });
  }
});
var RunwayAlephVideoSchema = z.object({
  prompt: z.string().min(1).max(1e3).describe("Text prompt describing the desired video transformation (max 1000 characters)"),
  videoUrl: z.string().url().describe("URL of the input video to transform"),
  waterMark: z.string().max(100).default("").optional().describe("Watermark text to add to the video"),
  uploadCn: z.boolean().default(false).optional().describe("Whether to upload to China servers"),
  aspectRatio: z.enum(["16:9", "9:16", "4:3", "3:4", "1:1", "21:9"]).default("16:9").optional().describe("Aspect ratio of the output video"),
  seed: z.number().int().min(1).max(999999).optional().describe("Random seed for reproducible results (1-999999)"),
  referenceImage: z.string().url().optional().describe("URL of reference image for style guidance"),
  callBackUrl: z.string().url().optional().describe("Optional: URL for task completion notifications (uses KIE_AI_CALLBACK_URL env var if not provided)")
});
var Wan30VideoSchema = z.object({
  prompt: z.string().min(1).max(2e4).optional().describe("Text prompt for video generation (max 20000 characters). Required when no media reference is provided."),
  first_frame_url: z.string().url().optional().describe("URL of the first-frame image (cannot be mixed with reference_*_urls)"),
  last_frame_url: z.string().url().optional().describe("URL of the last-frame image; requires first_frame_url"),
  reference_image_urls: z.array(z.string().url()).max(10).optional().describe("Reference image URLs mapped to Image1, Image2, and so on (up to 10)"),
  reference_video_urls: z.array(z.string().url()).max(5).optional().describe("Reference video URLs mapped to Video1, Video2, and so on (up to 5)"),
  reference_audio_urls: z.array(z.string().url()).max(5).optional().describe("Reference audio URLs mapped to Audio1, Audio2, and so on (up to 5)"),
  reference_file_urls: z.array(z.string().url()).max(1).optional().describe("Public document URL for file-to-video generation (maximum 1)"),
  reference_link_urls: z.array(z.string().url()).max(1).optional().describe("Public webpage URL for link-to-video generation (maximum 1)"),
  resolution: z.enum(["480P", "720P", "1080P"]).default("1080P").optional().describe("Video resolution"),
  aspect_ratio: z.enum(["adaptive", "16:9", "4:3", "1:1", "3:4", "9:16"]).default("adaptive").optional().describe("Aspect ratio of the generated video"),
  duration: z.union([z.literal(-1), z.number().int().min(2).max(30)]).default(5).optional().describe("Duration in seconds (2-30), or -1 for smart duration"),
  audio: z.boolean().default(true).optional().describe("Whether the generated video includes an audio track"),
  seed: z.number().int().min(0).max(2147483647).optional().describe("Random seed for reproducible results (0-2147483647)"),
  nsfw_checker: z.boolean().optional().describe("Enable NSFW content filter"),
  callBackUrl: z.string().url().optional().describe("Optional: URL for task completion notifications")
}).strict().superRefine((data, ctx) => {
  const hasReferences = Boolean(data.reference_image_urls?.length || data.reference_video_urls?.length || data.reference_audio_urls?.length || data.reference_file_urls?.length || data.reference_link_urls?.length);
  if (!data.prompt && !data.first_frame_url && !hasReferences) {
    ctx.addIssue({
      code: "custom",
      message: "Provide prompt, first_frame_url, or at least one reference URL"
    });
  }
  if (data.last_frame_url && !data.first_frame_url) {
    ctx.addIssue({
      code: "custom",
      path: ["last_frame_url"],
      message: "last_frame_url requires first_frame_url"
    });
  }
  if ((data.first_frame_url || data.last_frame_url) && hasReferences) {
    ctx.addIssue({
      code: "custom",
      message: "First/last frame URLs cannot be combined with reference_*_urls"
    });
  }
  if (data.reference_file_urls?.length && data.reference_link_urls?.length) {
    ctx.addIssue({
      code: "custom",
      message: "reference_file_urls and reference_link_urls are mutually exclusive"
    });
  }
});
var ByteDanceSeedreamImageSchema = z.object({
  prompt: z.string().min(1).max(5e3).describe("Text prompt for image generation or editing. V4: max 5000 chars, V5 Lite: max 3000 chars (API returns 500 error if exceeded)"),
  image_urls: z.array(z.string().url()).min(1).max(14).optional().describe("Array of image URLs for editing mode (optional - if not provided, uses text-to-image). V4: max 10, V4.5: max 14"),
  // Version selection: V4, Seedream 5.0 Lite, or Seedream 5.0 Pro
  version: z.enum(["4", "5-lite", "5-pro"]).default("5-lite").optional().describe("Seedream version: '4' for V4, '5-lite' for V5 Lite (default), or '5-pro' for controlled 1K/2K generation and editing"),
  // V4 parameters
  image_size: z.enum([
    "square",
    "square_hd",
    "portrait_4_3",
    "portrait_3_2",
    "portrait_16_9",
    "landscape_4_3",
    "landscape_3_2",
    "landscape_16_9",
    "landscape_21_9"
  ]).default("square_hd").optional().describe("Image aspect ratio (V4 only)"),
  image_resolution: z.enum(["1K", "2K", "4K"]).default("1K").optional().describe("Image resolution (V4 only)"),
  max_images: z.number().int().min(1).max(6).default(1).optional().describe("Number of images to generate (V4 only)"),
  seed: z.number().optional().describe("Random seed for reproducible results (V4 only, use -1 for random)"),
  // V5 Lite parameters (same as V4.5: aspect_ratio, quality)
  aspect_ratio: z.enum(["1:1", "4:3", "3:4", "16:9", "9:16", "2:3", "3:2", "21:9"]).default("1:1").optional().describe("Aspect ratio for V5 Lite output (V5 Lite only)"),
  quality: z.enum(["basic", "high"]).default("basic").optional().describe("Output quality for V5 Lite (V5 Lite only): 'basic' = 2K, 'high' = 3K resolution"),
  output_format: z.enum(["png", "jpeg"]).optional().describe("Output format for Seedream 5 Pro: png or jpeg"),
  nsfw_checker: z.boolean().optional().describe("Enable NSFW filtering for Seedream 5 Pro"),
  callBackUrl: z.string().url().optional().describe("Optional: URL for task completion notifications (uses KIE_AI_CALLBACK_URL env var if not provided)")
});
var OmniHumanVideoSchema = z.object({
  image_url: z.string().url().describe("Portrait image URL to animate"),
  audio_url: z.string().url().describe("Audio URL that drives the animation"),
  mask_url: z.array(z.string().url()).max(5).optional(),
  prompt: z.string().max(1e3).optional(),
  output_resolution: z.enum(["720", "1080"]).default("1080").optional(),
  pe_fast_mode: z.boolean().default(false).optional(),
  seed: z.number().int().default(-1).optional(),
  callBackUrl: z.string().url().optional()
});
var GeminiOmniSchema = z.object({
  operation: z.enum(["video", "character", "audio"]).default("video").optional(),
  prompt: z.string().max(2e4).optional(),
  image_urls: z.array(z.string().url()).max(7).optional(),
  audio_ids: z.array(z.string()).max(3).optional(),
  video_list: z.array(z.object({
    url: z.string().url(),
    start: z.number().min(0),
    ends: z.number().min(0)
  })).max(1).optional(),
  character_ids: z.array(z.string()).max(3).optional(),
  duration: z.enum(["4", "6", "8", "10"]).optional(),
  aspect_ratio: z.enum(["16:9", "9:16"]).optional(),
  resolution: z.enum(["720p", "1080p", "4k"]).optional(),
  seed: z.number().int().min(0).max(2147483647).optional(),
  character_name: z.string().max(210).optional(),
  descriptions: z.string().max(2e4).optional(),
  audio_id: z.string().optional(),
  name: z.string().max(210).optional(),
  voice_description: z.string().max(2e4).optional(),
  example_dialogue: z.string().max(120).optional(),
  callBackUrl: z.string().url().optional()
}).refine((data) => {
  if (data.operation === "audio")
    return !!data.audio_id && !!data.name;
  if (data.operation === "character")
    return !!data.descriptions && data.image_urls?.length === 1;
  const video = data.video_list?.[0];
  const quota = (data.image_urls?.length || 0) + (video ? 2 : 0) + (data.character_ids?.length || 0);
  return !!data.prompt && (!video || video.ends > video.start) && quota <= 7;
}, {
  message: "Invalid Gemini Omni operation inputs or video quota",
  path: []
});
var ZImageSchema = z.object({
  prompt: z.string().min(1).max(5e3).describe("Text prompt describing the desired image (max 5000 characters). Supports bilingual prompts."),
  aspect_ratio: z.enum(["1:1", "4:3", "3:4", "16:9", "9:16"]).default("1:1").describe("Aspect ratio for the generated image"),
  callBackUrl: z.string().url().optional().describe("Optional: URL for task completion notifications (uses KIE_AI_CALLBACK_URL env var if not provided)")
});
var GrokImagineSchema = z.object({
  prompt: z.string().max(5e3).optional().describe("Text prompt describing the desired content (required for text modes, optional for image-to-video)"),
  // Image-to-video mode: use image_urls OR task_id+index. Image edit accepts up to five URLs.
  image_urls: z.array(z.string().url()).max(5).optional().describe("Reference image URLs. image-to-video accepts exactly one; image-to-image accepts one to five."),
  task_id: z.string().optional().describe("Task ID from a previous Grok generation (for upscale or image-to-video from generated image)"),
  index: z.number().int().min(0).max(5).optional().describe("Image index from task_id (0-5, Grok generates 6 images per task)"),
  // Common parameters
  aspect_ratio: z.enum(["1:1", "2:3", "3:2", "16:9", "9:16", "auto"]).optional().describe("Aspect ratio. Image 2.0 image modes default to 1:1; image-to-image also accepts auto."),
  mode: z.enum(["fun", "normal", "spicy"]).optional().describe("Video generation style: fun, normal, or spicy (spicy is not available with external images)"),
  // Mode selection (auto-detected if not provided)
  generation_mode: z.enum([
    "text-to-image",
    "image-to-image",
    "text-to-video",
    "image-to-video",
    "upscale"
  ]).optional().describe("Explicit mode selection. image-to-image must be explicit; otherwise image_urls auto-detects image-to-video."),
  callBackUrl: z.string().url().optional().describe("Optional: URL for task completion notifications")
}).superRefine((data, ctx) => {
  const hasImages = (data.image_urls?.length ?? 0) > 0;
  const effectiveMode = data.generation_mode ?? (data.task_id && !data.prompt && !hasImages ? "upscale" : data.task_id || hasImages ? "image-to-video" : "text-to-video");
  const addIssue = (message, path) => ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
  const reject = (field, message) => {
    if (data[field] !== void 0)
      addIssue(message, [field]);
  };
  const imageRatios = ["1:1", "2:3", "3:2", "16:9", "9:16"];
  const videoRatios = ["1:1", "2:3", "3:2", "16:9", "9:16"];
  switch (effectiveMode) {
    case "text-to-image":
      if (!data.prompt)
        addIssue("prompt is required for text-to-image", ["prompt"]);
      if (data.aspect_ratio && !imageRatios.includes(data.aspect_ratio))
        addIssue("text-to-image aspect_ratio must be 1:1, 2:3, 3:2, 16:9, or 9:16", ["aspect_ratio"]);
      reject("image_urls", "image_urls is not supported for text-to-image");
      reject("task_id", "task_id is not supported for text-to-image");
      reject("index", "index is not supported for text-to-image");
      reject("mode", "mode is not supported for text-to-image");
      break;
    case "image-to-image":
      if (!data.prompt)
        addIssue("prompt is required for image-to-image", ["prompt"]);
      if (!hasImages)
        addIssue("image_urls with one to five URLs is required for image-to-image", ["image_urls"]);
      reject("task_id", "task_id is not supported for image-to-image");
      reject("index", "index is not supported for image-to-image");
      reject("mode", "mode is not supported for image-to-image");
      break;
    case "text-to-video":
      if (!data.prompt)
        addIssue("prompt is required for text-to-video", ["prompt"]);
      if (data.aspect_ratio && !videoRatios.includes(data.aspect_ratio))
        addIssue("text-to-video aspect_ratio must be 1:1, 2:3, or 3:2", [
          "aspect_ratio"
        ]);
      reject("image_urls", "image_urls is not supported for text-to-video");
      reject("task_id", "task_id is not supported for text-to-video");
      reject("index", "index is not supported for text-to-video");
      break;
    case "image-to-video":
      if (!hasImages && !data.task_id)
        addIssue("image_urls or task_id is required for image-to-video", [
          "image_urls"
        ]);
      if (hasImages && data.image_urls?.length !== 1)
        addIssue("image-to-video accepts exactly one image URL", [
          "image_urls"
        ]);
      if (hasImages && data.task_id)
        addIssue("image-to-video accepts image_urls or task_id, not both", [
          "task_id"
        ]);
      if (data.index !== void 0 && !data.task_id)
        addIssue("index requires task_id", ["index"]);
      if (data.mode === "spicy" && hasImages)
        addIssue("mode spicy is not available with external images", [
          "mode"
        ]);
      break;
    case "upscale":
      if (!data.task_id)
        addIssue("task_id is required for upscale", ["task_id"]);
      reject("prompt", "prompt is not supported for upscale");
      reject("image_urls", "image_urls is not supported for upscale");
      reject("index", "index is not supported for upscale");
      reject("aspect_ratio", "aspect_ratio is not supported for upscale");
      reject("mode", "mode is not supported for upscale");
      break;
  }
});
var InfiniTalkSchema = z.object({
  image_url: z.string().url().describe("URL of the portrait image to animate (JPEG, PNG, WEBP, max 10MB)"),
  audio_url: z.string().url().describe("URL of the audio file for lip sync (MPEG, WAV, AAC, MP4, OGG, max 10MB)"),
  prompt: z.string().min(1).max(1500).describe("Text prompt to guide video generation (e.g., 'A young woman talking on a podcast')"),
  resolution: z.enum(["480p", "720p"]).default("480p").optional().describe("Video resolution: 480p (faster, cheaper) or 720p (higher quality)"),
  seed: z.number().int().min(1e4).max(1e6).optional().describe("Random seed for reproducibility (10000-1000000)"),
  callBackUrl: z.string().url().optional().describe("Optional: URL for task completion notifications")
});
var KlingAvatarSchema = z.object({
  image_url: z.string().url().describe("URL of the portrait image for avatar (JPEG, PNG, WEBP, max 10MB)"),
  audio_url: z.string().url().describe("URL of the audio file for the avatar to speak (MPEG, WAV, AAC, MP4, OGG, max 10MB)"),
  prompt: z.string().min(1).max(1500).describe("Text prompt to guide video generation (emotions, expressions, scene settings)"),
  // Quality: standard (720P) or pro (1080P)
  quality: z.enum(["standard", "pro"]).default("standard").optional().describe("Video quality: standard (720P, faster) or pro (1080P, higher quality)"),
  callBackUrl: z.string().url().optional().describe("Optional: URL for task completion notifications")
});
var HappyHorseVideoSchema = z.object({
  mode: z.enum([
    "text-to-video",
    "image-to-video",
    "reference-to-video",
    "video-edit"
  ]).optional().describe("Generation mode: text-to-video (default), image-to-video, reference-to-video, or video-edit. Auto-detected from parameters if omitted."),
  prompt: z.string().min(1).max(5e3).describe("Text prompt for video generation (max 5000 characters)"),
  // I2V
  image_urls: z.array(z.string().url()).max(1).optional().describe("Input image URL for image-to-video mode (max 1)"),
  // R2V
  reference_image: z.array(z.string().url()).max(9).optional().describe("Reference images for reference-to-video mode (up to 9)"),
  // Video Edit
  video_url: z.string().url().optional().describe("Video URL to edit (video-edit mode)"),
  reference_image_edit: z.array(z.string().url()).max(5).optional().describe("Reference images for video-edit mode (up to 5)"),
  audio_setting: z.enum(["auto", "origin"]).optional().describe("Audio handling for video-edit: auto or origin"),
  // Common
  resolution: z.enum(["720p", "1080p"]).default("1080p").optional().describe("Video resolution"),
  aspect_ratio: z.enum(["16:9", "9:16", "1:1", "4:3", "3:4"]).default("16:9").optional().describe("Aspect ratio of the generated video"),
  duration: z.number().int().min(3).max(15).default(5).optional().describe("Duration in seconds (3-15)"),
  seed: z.number().int().min(0).max(2147483647).optional().describe("Random seed for reproducible results (0-2147483647)"),
  callBackUrl: z.string().url().optional().describe("Optional: URL for task completion notifications")
}).refine((data) => {
  const mode = data.mode || (data.video_url ? "video-edit" : data.reference_image?.length ? "reference-to-video" : data.image_urls?.length ? "image-to-video" : "text-to-video");
  if (mode === "image-to-video" && !data.image_urls?.length)
    return false;
  if (mode === "reference-to-video" && !data.reference_image?.length)
    return false;
  if (mode === "video-edit" && !data.video_url)
    return false;
  return true;
}, {
  message: "Invalid parameter combination for the detected mode. Ensure required inputs are provided.",
  path: []
});
var QwenImageSchema = z.object({
  prompt: z.string().min(1).describe("Text prompt for image generation or editing"),
  image_url: z.string().url().optional().describe("URL of image to edit (optional - if not provided, uses text-to-image)"),
  // Required for edit mode, optional for text-to-image
  image_size: z.enum([
    "square",
    "square_hd",
    "portrait_4_3",
    "portrait_16_9",
    "landscape_4_3",
    "landscape_16_9"
  ]).default("square_hd").optional().describe("Image size"),
  num_inference_steps: z.number().int().min(2).max(250).optional().describe("Number of inference steps (2-250 for text-to-image, 2-49 for edit)"),
  seed: z.number().optional().describe("Random seed for reproducible results"),
  guidance_scale: z.number().min(0).max(20).optional().describe("CFG scale (0-20, default: 2.5 for text-to-image, 4 for edit)"),
  enable_safety_checker: z.boolean().default(false).optional().describe("Enable safety checker"),
  output_format: z.enum(["png", "jpeg"]).default("png").optional().describe("Output format"),
  negative_prompt: z.string().max(500).default(" ").optional().describe("Negative prompt (max 500 characters)"),
  acceleration: z.enum(["none", "regular", "high"]).default("none").optional().describe("Acceleration level"),
  // Edit-specific parameters
  num_images: z.enum(["1", "2", "3", "4"]).optional().describe("Number of images (1-4, edit mode only)"),
  sync_mode: z.boolean().default(false).optional().describe("Sync mode (edit mode only)"),
  callBackUrl: z.string().url().optional().describe("Optional: URL for task completion notifications (uses KIE_AI_CALLBACK_URL env var if not provided)")
}).refine((data) => {
  const isEditMode = !!data.image_url;
  if (isEditMode) {
    if (data.num_inference_steps && (data.num_inference_steps < 2 || data.num_inference_steps > 49)) {
      return false;
    }
    if (data.prompt && data.prompt.length > 2e3) {
      return false;
    }
  } else {
    if (data.prompt && data.prompt.length > 5e3) {
      return false;
    }
  }
  return true;
}, {
  message: "Invalid parameters for detected mode",
  path: []
});
var MidjourneyGenerateSchema = z.object({
  prompt: z.string().min(1).max(4e3).describe("Text prompt describing the desired image or video (max 2000 characters)"),
  fileUrl: z.string().url().optional().describe("Single image URL for image-to-image or video generation (legacy - use fileUrls instead)"),
  fileUrls: z.array(z.string().url()).max(5).optional().describe("Array of image URLs for image-to-image or video generation (recommended)"),
  taskType: z.enum([
    "mj_txt2img",
    "mj_img2img",
    "mj_style_reference",
    "mj_omni_reference",
    "mj_video",
    "mj_video_hd"
  ]).optional().describe("Task type for generation mode (auto-detected if not provided)"),
  aspectRatio: z.enum(["1:1", "9:16", "16:9", "4:3", "3:4", "21:9", "2:3", "3:2"]).default("1:1").optional().describe("Output aspect ratio"),
  processMode: z.enum(["relax", "fast"]).default("relax").optional(),
  weird: z.number().int().min(0).max(1e3).optional(),
  raw: z.boolean().default(false).optional(),
  seed: z.number().int().min(0).max(4294967295).optional(),
  stylize: z.number().int().min(0).max(1e3).optional(),
  quality: z.number().min(0.1).max(1).multipleOf(0.1).optional(),
  chaos: z.number().int().min(0).max(100).optional(),
  repeat: z.number().int().min(1).max(40).optional(),
  stop: z.number().int().min(10).max(100).optional(),
  // Video-specific parameters
  motion: z.number().min(0).max(100).optional().describe("Motion level for video generation (required for video mode)"),
  videoBatchSize: z.number().int().min(1).max(4).optional().describe("Number of videos to generate (video mode only)"),
  high_definition_video: z.boolean().default(false).optional().describe("Use high definition video generation instead of standard definition"),
  // Omni reference specific
  ow: z.string().min(1).max(4e3).optional().describe("Omni intensity parameter for omni reference tasks (1-1000)"),
  // Style reference specific
  sref: z.string().min(1).max(4e3).optional(),
  // Additional parameters used by client code
  version: z.string().optional().describe("Midjourney model version"),
  speed: z.enum(["relax", "fast", "turbo"]).optional().describe("Generation speed (not required for video/omni tasks)"),
  variety: z.number().int().min(0).max(100).optional().describe("Controls diversity of generated results (0-100, increment by 5)"),
  stylization: z.number().int().min(0).max(1e3).optional().describe("Artistic style intensity (0-1000, suggested multiple of 50)"),
  weirdness: z.number().int().min(0).max(3e3).optional().describe("Creativity and uniqueness level (0-3000, suggested multiple of 100)"),
  enableTranslation: z.boolean().optional().describe("Auto-translate non-English prompts to English"),
  waterMark: z.string().max(100).optional().describe("Watermark identifier"),
  callBackUrl: z.string().url().optional().describe("Optional: URL for task completion notifications (uses KIE_AI_CALLBACK_URL env var if not provided)")
}).refine((data) => {
  const hasImage = data.fileUrl || data.fileUrls && data.fileUrls.length > 0;
  const isVideoMode = data.motion || data.videoBatchSize || data.high_definition_video;
  const isOmniMode = data.taskType === "mj_omni_reference" || data.ow;
  const isStyleMode = data.taskType === "mj_style_reference";
  if (data.taskType) {
    if ((data.taskType === "mj_video" || data.taskType === "mj_video_hd") && !data.motion) {
      return false;
    }
    if (data.taskType === "mj_omni_reference" && !data.ow) {
      return false;
    }
    if ((data.taskType === "mj_img2img" || data.taskType === "mj_style_reference" || data.taskType === "mj_omni_reference") && !hasImage) {
      return false;
    }
    if ((data.taskType === "mj_video" || data.taskType === "mj_video_hd") && !hasImage) {
      return false;
    }
    if (data.taskType === "mj_txt2img" && hasImage) {
      return false;
    }
  }
  return true;
}, {
  message: "Invalid combination of parameters for the detected task type",
  path: []
});
var GptImage2Schema = z.object({
  prompt: z.string().min(1).max(2e4).describe("Text prompt describing the desired image (max 20000 characters)"),
  input_urls: z.array(z.string().url()).max(16).optional().describe("Array of up to 16 image URLs for image-to-image mode. Omit for text-to-image."),
  aspect_ratio: z.enum(["auto", "1:1", "9:16", "16:9", "4:3", "3:4"]).default("auto").optional().describe("Image aspect ratio"),
  resolution: z.enum(["1K", "2K", "4K"]).default("1K").optional().describe("Output resolution"),
  callBackUrl: z.string().url().optional().describe("Optional: URL for task completion notifications (uses KIE_AI_CALLBACK_URL env var if not provided)")
});
var FluxKontextImageSchema = z.object({
  prompt: z.string().min(1).max(5e3).describe("Text prompt describing the desired image or edit (max 5000 characters, English recommended)"),
  enableTranslation: z.boolean().default(true).describe("Automatically translate non-English prompts to English"),
  uploadCn: z.boolean().default(false).describe("Route uploads via China servers for better performance in Asia"),
  inputImage: z.string().url().optional().describe("Input image URL for editing mode (required for image editing, omit for text-to-image generation)"),
  aspectRatio: z.enum(["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]).default("16:9").describe("Output image aspect ratio (default: 16:9)"),
  outputFormat: z.enum(["jpeg", "png"]).default("jpeg").describe("Output image format"),
  promptUpsampling: z.boolean().default(false).describe("Enable prompt enhancement for better results (may increase processing time)"),
  model: z.enum(["flux-kontext-pro", "flux-kontext-max"]).default("flux-kontext-pro").describe("Model version to use for generation"),
  callBackUrl: z.string().url().optional().describe("Optional: URL for task completion notifications (uses KIE_AI_CALLBACK_URL env var if not provided)"),
  safetyTolerance: z.number().int().min(0).max(6).default(6).describe("Content moderation level (0-6 for generation, 0-2 for editing)"),
  watermark: z.string().optional().describe("Watermark identifier to add to the generated image")
}).refine((data) => {
  const hasInputImage = !!data.inputImage;
  if (hasInputImage && data.safetyTolerance > 2) {
    return false;
  }
  return true;
}, {
  message: "For image editing mode, safetyTolerance must be between 0 and 2",
  path: ["safetyTolerance"]
});
var TopazUpscaleImageSchema = z.object({
  image_url: z.string().url().describe("URL of image to upscale (JPEG, PNG, WEBP, max 10MB)"),
  upscale_factor: z.enum(["1", "2", "4", "8"]).default("2").describe("Upscale factor: 1x (enhance only), 2x (default), 4x, or 8x. Max output dimension is 20,000px."),
  callBackUrl: z.string().url().optional().describe("Optional: URL for task completion notifications (uses KIE_AI_CALLBACK_URL env var if not provided)")
});
var RecraftRemoveBackgroundSchema = z.object({
  image: z.string().url().describe("URL of image to remove background from (PNG, JPG, WEBP, max 5MB, 16MP, 4096px max, 256px min)"),
  callBackUrl: z.string().url().optional().describe("Optional: URL for task completion notifications (uses KIE_AI_CALLBACK_URL env var if not provided)")
}).refine((data) => {
  const hasCallBackUrl = data.callBackUrl || process.env.KIE_AI_CALLBACK_URL;
  return true;
});
var IdeogramReframeSchema = z.object({
  image_url: z.string().url().describe("URL of image to reframe (JPEG, PNG, WEBP, max 10MB)"),
  image_size: z.enum([
    "square",
    "square_hd",
    "portrait_4_3",
    "portrait_16_9",
    "landscape_4_3",
    "landscape_16_9"
  ]).default("square_hd").describe("Output size for the reframed image"),
  rendering_speed: z.enum(["TURBO", "BALANCED", "QUALITY"]).default("BALANCED").optional().describe("Rendering speed for generation"),
  style: z.enum(["AUTO", "GENERAL", "REALISTIC", "DESIGN"]).default("AUTO").optional().describe("Style type for generation"),
  num_images: z.enum(["1", "2", "3", "4"]).default("1").optional().describe("Number of images to generate"),
  seed: z.number().int().min(0).max(2147483647).default(0).optional().describe("Seed for reproducible results"),
  callBackUrl: z.string().url().optional().describe("Optional: URL for task completion notifications (uses KIE_AI_CALLBACK_URL env var if not provided)")
}).refine((data) => {
  const hasCallBackUrl = data.callBackUrl || process.env.KIE_AI_CALLBACK_URL;
  return true;
});
var KlingVideoSchema = z.object({
  prompt: z.string().min(1).max(5e3).describe("Text prompt describing the desired video content (max 5000 characters). For audio: use [Character name, voice style] format for dialogue"),
  // Up to 2 images: first = start frame, second = end frame
  image_urls: z.array(z.string().url()).max(2).optional().describe("Up to 2 image URLs: first = start frame, second = end frame (optional - if not provided, uses text-to-video)"),
  duration: z.string().refine((val) => {
    const num = parseInt(val);
    return !isNaN(num) && num >= 3 && num <= 15;
  }, {
    message: "Duration must be a string number between 3 and 15"
  }).default("5").optional().describe("Duration of video in seconds (3-15)"),
  aspect_ratio: z.enum(["16:9", "9:16", "1:1"]).default("16:9").optional().describe("Aspect ratio of video (text-to-video mode only)"),
  mode: z.enum(["std", "pro"]).default("std").optional().describe("Quality mode: 'std' for standard (faster, cheaper), 'pro' for professional quality"),
  sound: z.boolean().default(false).optional().describe("Enable native audio generation including multilingual speech, sound effects, and ambient sound. Pricing: with audio is 2x credits"),
  multi_shots: z.boolean().default(false).optional().describe("Enable multi-shot mode for cinematic storytelling with multiple scenes (requires multi_prompt)"),
  multi_prompt: z.array(z.object({
    prompt: z.string(),
    duration: z.number().int().min(1).max(12)
  })).optional().describe("Array of shot definitions for multi-shot mode. Each shot has a prompt and duration (1-12s)"),
  kling_elements: z.array(z.object({
    name: z.string(),
    description: z.string(),
    element_input_urls: z.array(z.string().url()).optional(),
    element_input_video_urls: z.array(z.string().url()).optional()
  })).optional().describe("Character/object elements for consistent identity across shots. Provide name, description, and reference images/videos"),
  callBackUrl: z.string().url().optional().describe("Optional: URL for task completion notifications (uses KIE_AI_CALLBACK_URL env var if not provided)")
}).refine((data) => {
  if (data.multi_shots && (!data.multi_prompt || data.multi_prompt.length === 0)) {
    return false;
  }
  return true;
}, {
  message: "multi_shots requires multi_prompt array with at least one shot definition",
  path: []
});
var HailuoVideoSchema = z.object({
  prompt: z.string().min(1).describe("Text prompt describing the desired video content"),
  imageUrl: z.string().url().optional().describe("First-frame image URL for image-to-video mode. Cannot be combined with reference inputs."),
  endImageUrl: z.string().url().optional().describe("Optional last-frame image URL for image-to-video mode. Requires imageUrl."),
  referenceImageUrls: z.array(z.string().url()).min(1).max(9).optional().describe("Reference image URLs for reference-to-video mode (up to 9 images)."),
  referenceVideoUrls: z.array(z.string().url()).min(1).max(3).optional().describe("Reference video URLs for reference-to-video mode (up to 3 videos)."),
  referenceAudioUrls: z.array(z.string().url()).min(1).max(3).optional().describe("Reference audio URLs for reference-to-video mode (up to 3 audio files)."),
  duration: z.number().int().min(4).max(15).describe("Video duration in seconds (4-15)."),
  aspectRatio: z.enum(["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]).optional().describe("Output aspect ratio. Required for text-to-video; reference-to-video also supports adaptive."),
  resolution: z.enum(["768p"]).optional().describe("Reference-to-video output resolution. 768p has a verified rate-card formula."),
  callBackUrl: z.string().url().optional().describe("Optional: URL for task completion notifications (uses KIE_AI_CALLBACK_URL env var if not provided)")
}).strict().superRefine((data, ctx) => {
  const hasReferenceInputs = Boolean(data.referenceImageUrls?.length || data.referenceVideoUrls?.length || data.referenceAudioUrls?.length);
  if (data.endImageUrl && !data.imageUrl) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["endImageUrl"],
      message: "endImageUrl requires imageUrl."
    });
  }
  if (data.imageUrl && hasReferenceInputs) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [],
      message: "imageUrl and reference inputs select different MiniMax H3 modes and cannot be combined."
    });
  }
  if (data.imageUrl && data.aspectRatio) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["aspectRatio"],
      message: "aspectRatio is not supported for image-to-video mode."
    });
  }
  if (data.resolution && !hasReferenceInputs) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["resolution"],
      message: "resolution is currently supported only for reference-to-video mode."
    });
  }
  if (!data.imageUrl && !hasReferenceInputs) {
    if (!data.aspectRatio) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["aspectRatio"],
        message: "aspectRatio is required for text-to-video mode."
      });
    } else if (data.aspectRatio === "adaptive") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["aspectRatio"],
        message: "adaptive aspectRatio is only supported for reference-to-video mode."
      });
    }
  }
});
var Flux2ImageSchema = z.object({
  prompt: z.string().min(3).max(5e3).describe("Text prompt describing the desired image (3-5000 characters)"),
  input_urls: z.array(z.string().url()).min(1).max(8).optional().describe("Reference images for image-to-image mode (1-8 URLs). Omit for text-to-image mode."),
  aspect_ratio: z.enum(["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "auto"]).default("1:1").describe("Aspect ratio for the generated image. 'auto' only valid with input_urls."),
  resolution: z.enum(["1K", "2K"]).default("1K").describe("Output resolution."),
  model_type: z.enum(["pro", "flex"]).default("pro").optional().describe("Model variant: 'pro' for fast reliable results, 'flex' for more control and fine-tuning."),
  callBackUrl: z.string().url().optional().describe("Optional: URL for task completion notifications (uses KIE_AI_CALLBACK_URL env var if not provided)")
}).refine((data) => {
  if (data.aspect_ratio === "auto") {
    return data.input_urls && data.input_urls.length > 0;
  }
  return true;
}, {
  message: "aspect_ratio 'auto' is only valid in image-to-image mode (requires input_urls)",
  path: ["aspect_ratio"]
});
var WanAnimateSchema = z.object({
  video_url: z.string().url().describe("URL of the reference video (MP4, QUICKTIME, X-MATROSKA, max 10MB, max 30 seconds)"),
  image_url: z.string().url().describe("URL of the character image (JPEG, PNG, WEBP, max 10MB). Will be resized and center-cropped to match video aspect ratio."),
  mode: z.enum(["animate", "replace"]).default("animate").describe("Animation mode: 'animate' transfers motion/expressions from video to image, 'replace' swaps the character in video with the image"),
  resolution: z.enum(["480p", "580p", "720p"]).default("480p").optional().describe("Output resolution: 480p, 580p, or 720p"),
  callBackUrl: z.string().url().optional().describe("Optional: URL for task completion notifications (uses KIE_AI_CALLBACK_URL env var if not provided)")
});
var GetTaskStatusSchema = z.object({
  task_id: z.string().min(1).describe("Task ID to check status for")
});
var ListTasksSchema = z.object({
  limit: z.number().int().max(100).default(20).describe("Maximum number of tasks to return"),
  status: z.enum(["pending", "processing", "completed", "failed"]).optional().describe("Filter by status")
});
function isSafeFileName(value) {
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (ch === "/" || ch === "\\" || code < 32 || code === 127) {
      return false;
    }
  }
  return true;
}
var UploadFileNameSchema = z.string().min(1).max(160).refine(isSafeFileName, "file_name must not contain path separators or control characters");
var UploadFileSchema = z.object({
  file_base64: z.string().min(1).max(14e6).optional().describe("Base64 media bytes or a data URL (maximum 10 MiB decoded)"),
  file_path: z.string().min(1).max(4096).optional().describe("CLI-only local media path. Requires KIE_CLI_UPLOAD_ROOTS and is unavailable to MCP adapters"),
  file_name: UploadFileNameSchema.optional().describe("Optional output filename including extension"),
  content_type: z.string().min(1).max(100).optional().describe("MIME type for raw Base64; data URLs provide it inline")
}).superRefine((data, ctx) => {
  const sources = Number(data.file_path !== void 0) + Number(data.file_base64 !== void 0);
  if (sources !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide exactly one of file_path or file_base64",
      path: []
    });
  }
  if (data.file_path && data.content_type) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "content_type is only supported with file_base64",
      path: ["content_type"]
    });
  }
});
var GetUploadUrlSchema = z.object({
  app_grant: z.string().min(32).max(200).describe("Short-lived widget grant"),
  filename: UploadFileNameSchema.describe("Original filename shown in download metadata"),
  content_type: z.enum([
    "image/jpeg",
    "image/png",
    "image/webp",
    "video/mp4",
    "video/webm",
    "video/quicktime",
    "audio/mpeg",
    "audio/wav",
    "audio/x-wav",
    "audio/ogg",
    "audio/aac",
    "audio/mp4"
  ]).describe("Declared media MIME type; bytes are checked after upload"),
  size: z.number().int().positive().max(25 * 1024 * 1024).describe("Exact upload size in bytes, maximum 25 MiB")
});
var FinalizeUploadSchema = z.object({
  app_grant: z.string().min(32).max(200).describe("Short-lived widget grant"),
  media_id: z.string().uuid().describe("Opaque media ID returned after browser upload")
});
var UploadWidgetSchema = z.object({});
var ListModelsSchema = z.object({
  filter: z.string().min(1).optional().describe("Optional text or capability filter, for example: lip sync")
});
var PrepareMediaGenerationSchema = z.object({
  items: z.array(z.object({
    tool: z.string().min(1).describe("Registered generation tool name"),
    args: z.record(z.string(), z.unknown()).describe("Arguments for that tool")
  })).min(1).max(6).describe("One to six independent generation requests"),
  defaultProfile: z.enum(["safe"]).optional().describe("Optional explicit safe default policy. The current catalog policy is safe."),
  maxConcurrency: z.number().int().min(1).max(4).optional().describe("Maximum concurrent task creates for this plan (1-4, default 4)"),
  expiresInSeconds: z.number().int().min(60).max(3600).optional().describe("Plan expiry in seconds (60-3600, default 900)")
});
var SubmitMediaGenerationSchema = z.object({
  planId: z.string().uuid().describe("Approved plan ID to submit exactly once")
});
var WaitForTaskSchema = z.object({
  task_id: z.string().min(1).describe("Task ID returned by a generation tool to wait for"),
  timeout_seconds: z.number().int().min(5).max(600).default(180).describe("Max seconds to wait before giving up"),
  interval_seconds: z.number().int().min(1).max(60).default(5).describe("Seconds between status checks while waiting"),
  rendezvous_url: z.string().url().optional().describe("Optional callback rendezvous result base URL (e.g. https://felo-workers.felo.workers.dev/kie/result). Omit to poll the Kie API directly (the default). When set, or when KIE_AI_RESULT_URL / a KIE_AI_CALLBACK_URL ending in /kie/callback is configured, it waits on the rendezvous instead")
});
var Veo3Get1080pVideoSchema = z.object({
  task_id: z.string().min(1).describe("Veo3 task ID to get 1080p video for"),
  index: z.number().int().min(0).optional().describe("Video index (optional, for multiple video results)")
});

// ../core/dist/tools/bytedance_seedance_video.js
var bytedanceSeedanceVideoTool = {
  name: "bytedance_seedance_video",
  description: "Generate videos with ByteDance Seedance 2.5 using text, experimental semantic task continuation, first/last frames, or multimodal image/video/audio references.",
  category: "video",
  schema: ByteDanceSeedanceVideoSchema,
  async run(args, ctx) {
    try {
      const request = ByteDanceSeedanceVideoSchema.parse(args);
      request.callBackUrl = ctx.getCallbackUrl(request.callBackUrl);
      const response = await ctx.client.generateByteDanceSeedanceVideo(request);
      if (response.code === 200 && response.data?.taskId) {
        await ctx.db.createTask({
          task_id: response.data.taskId,
          api_type: "bytedance-seedance-video",
          status: "pending"
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                task_id: response.data.taskId,
                message: "ByteDance Seedance 2.5 video generation task created successfully",
                parameters: {
                  prompt: request.prompt.substring(0, 100) + (request.prompt.length > 100 ? "..." : ""),
                  ...request.extension_task_id && {
                    extension_task_id: request.extension_task_id
                  },
                  ...request.first_frame_url && {
                    first_frame_url: request.first_frame_url
                  },
                  ...request.last_frame_url && {
                    last_frame_url: request.last_frame_url
                  },
                  ...request.reference_image_urls?.length && {
                    reference_images: request.reference_image_urls.length
                  },
                  ...request.reference_video_urls?.length && {
                    reference_videos: request.reference_video_urls.length
                  },
                  ...request.reference_audio_urls?.length && {
                    reference_audios: request.reference_audio_urls.length
                  },
                  ...request.return_last_frame !== void 0 && {
                    return_last_frame: request.return_last_frame
                  },
                  ...request.generate_audio !== void 0 && {
                    generate_audio: request.generate_audio
                  },
                  ...request.resolution && {
                    resolution: request.resolution
                  },
                  ...request.aspect_ratio && {
                    aspect_ratio: request.aspect_ratio
                  },
                  ...request.duration !== void 0 && {
                    duration: request.duration
                  }
                },
                next_steps: [
                  "Use get_task_status to check generation progress",
                  "Task completion will be sent to the provided callback URL"
                ]
              }, null, 2)
            }
          ]
        };
      } else {
        throw new Error(response.msg || "Failed to create ByteDance Seedance video generation task");
      }
    } catch (error) {
      if (error instanceof z2.ZodError) {
        return ctx.formatError("bytedance_seedance_video", error, {
          prompt: "Required: text prompt for Seedance 2.5 video generation",
          extension_task_id: "Optional, experimental: previous Seedance task ID for semantic continuation; use first_frame_url for visual continuity",
          first_frame_url: "Optional: URL of image to use as the first frame",
          last_frame_url: "Optional: URL of image to use as the last frame; requires first_frame_url",
          reference_image_urls: "Optional: reference images for multimodal reference-to-video",
          reference_video_urls: "Optional: reference videos for multimodal reference-to-video",
          reference_audio_urls: "Optional: reference audio for multimodal reference-to-video",
          return_last_frame: "Optional: return the generated last frame",
          aspect_ratio: "Optional: video aspect ratio",
          resolution: "Optional: video resolution (the official example uses 720p)",
          duration: "Optional: integer video duration in seconds",
          generate_audio: "Optional: generate audio for the video",
          callBackUrl: "Optional: URL for task completion notifications"
        });
      }
      return ctx.formatError("bytedance_seedance_video", error, {
        prompt: "Required: text prompt for Seedance 2.5 video generation",
        extension_task_id: "Optional, experimental: previous Seedance task ID for semantic continuation; use first_frame_url for visual continuity",
        first_frame_url: "Optional: first-frame image URL",
        last_frame_url: "Optional: last-frame image URL (requires first_frame_url)",
        reference_image_urls: "Optional: multimodal reference image URLs",
        reference_video_urls: "Optional: multimodal reference video URLs",
        reference_audio_urls: "Optional: multimodal reference audio URLs",
        return_last_frame: "Optional: return the generated last frame",
        aspect_ratio: "Optional: Video aspect ratio",
        resolution: "Optional: video resolution",
        duration: "Optional: integer duration in seconds",
        generate_audio: "Optional: generate audio for the video",
        callBackUrl: "Optional: URL for task completion notifications"
      });
    }
  }
};

// ../core/dist/tools/bytedance_seedream_image.js
import { z as z3 } from "zod";
var bytedanceSeedreamImageTool = {
  name: "bytedance_seedream_image",
  description: "Generate and edit images using ByteDance Seedream V4, V5 Lite, or V5 Pro. V5 Pro provides controlled 1K/2K output, PNG/JPEG export, and up to 10 references.",
  category: "image",
  schema: ByteDanceSeedreamImageSchema,
  async run(args, ctx) {
    try {
      const request = ByteDanceSeedreamImageSchema.parse(args);
      request.callBackUrl = ctx.getCallbackUrl(request.callBackUrl);
      const response = await ctx.client.generateByteDanceSeedreamImage(request);
      if (response.code === 200 && response.data?.taskId) {
        const isEdit = !!request.image_urls && request.image_urls.length > 0;
        const mode = isEdit ? "Image Editing" : "Text-to-Image";
        await ctx.db.createTask({
          task_id: response.data.taskId,
          api_type: "bytedance-seedream-image",
          status: "pending"
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                task_id: response.data.taskId,
                message: `ByteDance Seedream ${request.version === "4" ? "V4" : request.version === "5-pro" ? "V5 Pro" : "V5 Lite"} ${mode} task created successfully`,
                parameters: {
                  mode,
                  prompt: request.prompt.substring(0, 100) + (request.prompt.length > 100 ? "..." : ""),
                  image_size: request.image_size || "1:1",
                  image_resolution: request.image_resolution || "1K",
                  max_images: request.max_images || 1,
                  seed: request.seed !== void 0 ? request.seed : -1,
                  ...isEdit && {
                    image_urls_count: request.image_urls?.length || 0
                  }
                },
                next_steps: [
                  `Use get_task_status with task_id: ${response.data.taskId} to check progress`,
                  'Generated images will be available when status is "completed"'
                ],
                usage_examples: [
                  `get_task_status: {"task_id": "${response.data.taskId}"}`,
                  `list_tasks: {"limit": 10}`
                ]
              }, null, 2)
            }
          ]
        };
      } else {
        throw new Error(response.msg || "Failed to create ByteDance Seedream image task");
      }
    } catch (error) {
      if (error instanceof z3.ZodError) {
        return ctx.formatError("bytedance_seedream_image", error, {
          prompt: "Required: Text prompt for image generation or editing (max 10000 characters)",
          image_urls: "Optional: Array of image URLs for editing mode (1-10 images)",
          image_size: "Optional: Image aspect ratio (default: 1:1)",
          image_resolution: "Optional: Image resolution - 1K/2K/4K (default: 1K)",
          max_images: "Optional: Number of images to generate (1-6, default: 1)",
          seed: "Optional: Random seed for reproducible results (default: -1 for random)",
          callBackUrl: "Optional: URL for task completion notifications (uses KIE_AI_CALLBACK_URL env var if not provided)"
        });
      }
      return ctx.formatError("bytedance_seedream_image", error, {
        prompt: "Required: Text prompt for image generation or editing (max 10000 characters)",
        image_urls: "Optional: Array of image URLs for editing mode (1-10 images)",
        image_size: "Optional: Image aspect ratio (default: 1:1)",
        image_resolution: "Optional: Image resolution - 1K/2K/4K (default: 1K)",
        max_images: "Optional: Number of images to generate (1-6, default: 1)",
        seed: "Optional: Random seed for reproducible results (default: -1 for random)",
        callBackUrl: "Optional: URL for task completion notifications (uses KIE_AI_CALLBACK_URL env var if not provided)"
      });
    }
  }
};

// ../core/dist/tools/elevenlabs_tts.js
import { z as z4 } from "zod";
var elevenlabsTtsTool = {
  name: "elevenlabs_tts",
  description: "Generate speech from text using ElevenLabs TTS models (Turbo 2.5 by default, with optional Multilingual v2 support)",
  category: "audio",
  schema: ElevenLabsTTSSchema,
  async run(args, ctx) {
    try {
      const request = ElevenLabsTTSSchema.parse(args);
      request.callBackUrl = ctx.getCallbackUrl(request.callBackUrl);
      const response = await ctx.client.generateElevenLabsTTS(request);
      if (response.code === 200 && response.data?.taskId) {
        await ctx.db.createTask({
          task_id: response.data.taskId,
          api_type: "elevenlabs-tts",
          status: "pending"
        });
        const model = request.model === "multilingual" ? "Multilingual v2" : "Turbo 2.5";
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                task_id: response.data.taskId,
                message: `ElevenLabs TTS (${model}) generation task created successfully`,
                parameters: {
                  model,
                  text: request.text.substring(0, 100) + (request.text.length > 100 ? "..." : ""),
                  voice: request.voice || "Rachel",
                  speed: request.speed || 1,
                  stability: request.stability || 0.5,
                  similarity_boost: request.similarity_boost || 0.75,
                  ...request.model === "multilingual" && {
                    previous_text: request.previous_text || "None",
                    next_text: request.next_text || "None"
                  },
                  ...request.model === "turbo" && {
                    language_code: request.language_code || "None"
                  }
                },
                next_steps: [
                  "Use get_task_status to check generation progress",
                  "Task completion will be sent to the provided callback URL",
                  request.model === "turbo" ? "Turbo 2.5 generation is faster and supports language enforcement (15-60 seconds)" : "Multilingual v2 generation supports context and continuity (30-120 seconds)"
                ]
              }, null, 2)
            }
          ]
        };
      } else {
        throw new Error(response.msg || "Failed to create TTS generation task");
      }
    } catch (error) {
      if (error instanceof z4.ZodError) {
        return ctx.formatError("elevenlabs_tts", error, {
          text: "Required: The text to convert to speech (max 5000 characters)",
          model: "Optional: TTS model - turbo (faster, default) or multilingual (supports context)",
          voice: "Optional: Voice to use (default: Rachel). Available: Rachel, Aria, Roger, Sarah, Laura, Charlie, George, Callum, River, Liam, Charlotte, Alice, Matilda, Will, Jessica, Eric, Chris, Brian, Daniel, Lily, Bill",
          stability: "Optional: Voice stability (0-1, default: 0.5)",
          similarity_boost: "Optional: Similarity boost (0-1, default: 0.75)",
          style: "Optional: Style exaggeration (0-1, default: 0)",
          speed: "Optional: Speech speed (0.7-1.2, default: 1.0)",
          timestamps: "Optional: Return word timestamps (default: false)",
          previous_text: "Optional: Previous text for continuity (multilingual model only, max 5000 chars)",
          next_text: "Optional: Next text for continuity (multilingual model only, max 5000 chars)",
          language_code: "Optional: ISO 639-1 language code for enforcement (turbo model only)",
          callBackUrl: "Optional: URL for task completion notifications (uses KIE_AI_CALLBACK_URL env var if not provided)"
        });
      }
      return ctx.formatError("elevenlabs_tts", error, {
        text: "Required: The text to convert to speech (max 5000 characters)",
        model: "Optional: TTS model - turbo (default) or multilingual",
        voice: "Optional: Voice to use (default: Rachel)",
        callBackUrl: "Optional: URL for task completion notifications"
      });
    }
  }
};

// ../core/dist/tools/elevenlabs_ttsfx.js
import { z as z5 } from "zod";
var elevenlabsTtsfxTool = {
  name: "elevenlabs_ttsfx",
  description: "Generate sound effects from text descriptions using ElevenLabs Sound Effects v2 model",
  category: "audio",
  schema: ElevenLabsSoundEffectsSchema,
  async run(args, ctx) {
    try {
      const request = ElevenLabsSoundEffectsSchema.parse(args);
      request.callBackUrl = ctx.getCallbackUrl(request.callBackUrl);
      const response = await ctx.client.generateElevenLabsSoundEffects(request);
      if (response.code === 200 && response.data?.taskId) {
        await ctx.db.createTask({
          task_id: response.data.taskId,
          api_type: "elevenlabs-sound-effects",
          status: "pending"
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                task_id: response.data.taskId,
                message: "ElevenLabs Sound Effects generation task created successfully",
                parameters: {
                  text: request.text.substring(0, 100) + (request.text.length > 100 ? "..." : ""),
                  duration_seconds: request.duration_seconds || "Auto-determined",
                  prompt_influence: request.prompt_influence || 0.3,
                  output_format: request.output_format || "mp3_44100_192",
                  loop: request.loop || false
                },
                next_steps: [
                  "Use get_task_status to check generation progress",
                  "Task completion will be sent to the provided callback URL",
                  "Sound effects generation typically takes 30-90 seconds depending on complexity"
                ]
              }, null, 2)
            }
          ]
        };
      } else {
        throw new Error(response.msg || "Failed to create Sound Effects generation task");
      }
    } catch (error) {
      if (error instanceof z5.ZodError) {
        return ctx.formatError("elevenlabs_ttsfx", error, {
          text: "Required: The text describing the sound effect to generate (max 5000 characters)",
          loop: "Optional: Whether to create a looping sound effect (default: false)",
          duration_seconds: "Optional: Duration in seconds (0.5-22, step 0.1)",
          prompt_influence: "Optional: How closely to follow the prompt (0-1, step 0.01, default: 0.3)",
          output_format: "Optional: Audio output format (default: mp3_44100_128)",
          callBackUrl: "Optional: URL for task completion notifications (uses KIE_AI_CALLBACK_URL env var if not provided)"
        });
      }
      return ctx.formatError("elevenlabs_ttsfx", error, {
        text: "Required: The text describing the sound effect to generate (max 5000 characters)",
        duration_seconds: "Optional: Duration in seconds (0.5-22)",
        output_format: "Optional: Audio output format",
        callBackUrl: "Optional: URL for task completion notifications"
      });
    }
  }
};

// ../core/dist/tools/finalize_upload.js
var finalizeUploadTool = {
  name: "finalize_upload",
  description: "Finalize staged widget media server-side and upload it to Kie.ai. App-only helper; public capabilities never enter model content.",
  category: "utility",
  schema: FinalizeUploadSchema,
  ui: { visibility: ["app"] },
  async run(args, ctx) {
    try {
      const request = FinalizeUploadSchema.parse(args);
      if (!ctx.validateWidgetGrant?.(request.app_grant)) {
        throw new Error("Invalid or expired widget grant.");
      }
      if (!ctx.finalizeUpload) {
        throw new Error("Temporary HTTP upload finalization is unavailable.");
      }
      const finalized = await ctx.finalizeUpload({
        mediaId: request.media_id,
        owner: ctx.approvalContext
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              download_url: finalized.downloadUrl,
              filename: finalized.filename,
              content_type: finalized.contentType,
              size: finalized.size,
              retention: "Temporary Kie URL; consume promptly."
            }, null, 2)
          }
        ],
        structuredContent: {
          download_url: finalized.downloadUrl,
          filename: finalized.filename,
          content_type: finalized.contentType,
          size: finalized.size
        }
      };
    } catch (error) {
      return ctx.formatError("finalize_upload", error, {
        app_grant: "Short-lived grant emitted by upload_widget metadata",
        media_id: "Opaque media ID returned by get_upload_url"
      });
    }
  }
};

// ../core/dist/tools/flux_kontext_image.js
import { z as z6 } from "zod";
var fluxKontextImageTool = {
  name: "flux_kontext_image",
  description: "Generate or edit images using Flux Kontext AI models (unified tool for text-to-image generation and image editing)",
  category: "image",
  schema: FluxKontextImageSchema,
  async run(args, ctx) {
    try {
      const request = FluxKontextImageSchema.parse(args);
      const hasInputImage = !!request.inputImage;
      const modeDisplay = hasInputImage ? "Image Editing" : "Text-to-Image Generation";
      request.callBackUrl = ctx.getCallbackUrl(request.callBackUrl);
      const response = await ctx.client.generateFluxKontextImage(request);
      if (response.code === 200 && response.data?.taskId) {
        await ctx.db.createTask({
          task_id: response.data.taskId,
          api_type: "flux-kontext-image",
          status: "pending"
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                task_id: response.data.taskId,
                message: `Flux Kontext ${modeDisplay} task created successfully`,
                parameters: {
                  mode: modeDisplay,
                  prompt: request.prompt.substring(0, 100) + (request.prompt.length > 100 ? "..." : ""),
                  aspect_ratio: request.aspectRatio || "16:9",
                  output_format: request.outputFormat || "jpeg",
                  model: request.model || "flux-kontext-pro",
                  enable_translation: request.enableTranslation !== false,
                  prompt_upsampling: request.promptUpsampling || false,
                  safety_tolerance: request.safetyTolerance || 2,
                  upload_cn: request.uploadCn || false,
                  ...hasInputImage && {
                    input_image: request.inputImage
                  },
                  ...request.watermark && {
                    watermark: request.watermark
                  }
                },
                next_steps: [
                  `Use get_task_status with task_id: ${response.data.taskId} to check progress`,
                  'Generated images will be available when status is "completed"',
                  hasInputImage ? "Image editing typically takes 1-3 minutes depending on complexity" : "Image generation typically takes 30-60 seconds depending on complexity"
                ],
                usage_examples: [
                  `get_task_status: {"task_id": "${response.data.taskId}"}`,
                  `list_tasks: {"limit": 10}`
                ]
              }, null, 2)
            }
          ]
        };
      } else {
        throw new Error(response.msg || "Failed to create Flux Kontext image task");
      }
    } catch (error) {
      if (error instanceof z6.ZodError) {
        return ctx.formatError("flux_kontext_image", error, {
          prompt: "Required: Text prompt describing the desired image or edit (max 5000 chars, English recommended)",
          inputImage: "Optional: Input image URL for editing mode (required for image editing)",
          aspectRatio: "Optional: Output aspect ratio (21:9, 16:9, 4:3, 1:1, 3:4, 9:16, default: 16:9)",
          outputFormat: "Optional: Output format (jpeg, png, default: jpeg)",
          model: "Optional: Model version (flux-kontext-pro, flux-kontext-max, default: flux-kontext-pro)",
          enableTranslation: "Optional: Auto-translate non-English prompts (default: true)",
          promptUpsampling: "Optional: Enable prompt enhancement (default: false)",
          safetyTolerance: "Optional: Content moderation level (0-6 for generation, 0-2 for editing, default: 2)",
          uploadCn: "Optional: Route uploads via China servers (default: false)",
          watermark: "Optional: Watermark identifier to add to generated image",
          callBackUrl: "Optional: Webhook URL for completion notifications"
        });
      }
      return ctx.formatError("flux_kontext_image", error, {
        prompt: "Required: Text prompt describing the desired image or edit (max 5000 chars, English recommended)",
        inputImage: "Optional: Input image URL for editing mode (required for image editing)",
        aspectRatio: "Optional: Output aspect ratio (21:9, 16:9, 4:3, 1:1, 3:4, 9:16, default: 16:9)",
        outputFormat: "Optional: Output format (jpeg, png, default: jpeg)",
        model: "Optional: Model version (flux-kontext-pro, flux-kontext-max, default: flux-kontext-pro)",
        enableTranslation: "Optional: Auto-translate non-English prompts (default: true)",
        promptUpsampling: "Optional: Enable prompt enhancement (default: false)",
        safetyTolerance: "Optional: Content moderation level (0-6 for generation, 0-2 for editing, default: 2)",
        uploadCn: "Optional: Route uploads via China servers (default: false)",
        watermark: "Optional: Watermark identifier to add to generated image",
        callBackUrl: "Optional: Webhook URL for completion notifications"
      });
    }
  }
};

// ../core/dist/tools/flux2_image.js
import { z as z7 } from "zod";
var flux2ImageTool = {
  name: "flux2_image",
  description: "Generate and edit images using Black Forest Labs' Flux 2 models (Pro/Flex) with multi-reference consistency, photoreal detail, and accurate text rendering",
  category: "image",
  schema: Flux2ImageSchema,
  async run(args, ctx) {
    try {
      const request = Flux2ImageSchema.parse(args);
      request.callBackUrl = ctx.getCallbackUrl(request.callBackUrl);
      const response = await ctx.client.generateFlux2Image(request);
      const hasInputUrls = !!request.input_urls && request.input_urls.length > 0;
      const modelType = request.model_type || "pro";
      const modeDescription = hasInputUrls ? `image-to-image (${modelType})` : `text-to-image (${modelType})`;
      if (response.code === 200 && response.data?.taskId) {
        await ctx.db.createTask({
          task_id: response.data.taskId,
          api_type: "flux2-image",
          status: "pending"
        });
      } else {
        throw new Error(response.msg || "Failed to create Flux 2 image task");
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              task_id: response.data?.taskId,
              mode: modeDescription,
              message: `Flux 2 image generation task created successfully (${modeDescription})`,
              parameters: {
                prompt: request.prompt,
                input_urls: request.input_urls,
                aspect_ratio: request.aspect_ratio || "1:1",
                resolution: request.resolution || "1K",
                model_type: modelType,
                callBackUrl: request.callBackUrl
              },
              next_steps: [
                "Use get_task_status to check generation progress",
                "Task completion will be sent to the provided callback URL",
                "Image generation typically takes 10-30 seconds"
              ]
            }, null, 2)
          }
        ]
      };
    } catch (error) {
      if (error instanceof z7.ZodError) {
        return ctx.formatError("flux2_image", error, {
          prompt: "Required: text description of desired image (3-5000 characters)",
          input_urls: "Optional: array of reference image URLs for image-to-image mode (1-8 URLs)",
          aspect_ratio: 'Optional: aspect ratio (1:1, 4:3, 3:4, 16:9, 9:16, 3:2, 2:3, auto). Default: 1:1. "auto" only valid with input_urls.',
          resolution: "Optional: output resolution (1K or 2K). Default: 1K.",
          model_type: 'Optional: model variant ("pro" for fast results, "flex" for more control). Default: pro.',
          callBackUrl: "Optional: callback URL for notifications (uses KIE_AI_CALLBACK_URL env var if not provided)"
        });
      }
      return ctx.formatError("flux2_image", error, {
        prompt: "Required: text description of desired image",
        input_urls: "Optional: reference images for image-to-image mode (1-8 URLs)",
        aspect_ratio: "Optional: aspect ratio (default: 1:1)",
        resolution: "Optional: output resolution (1K or 2K)",
        model_type: "Optional: pro or flex (default: pro)",
        callBackUrl: "Optional: URL for task completion notifications"
      });
    }
  }
};

// ../core/dist/tools/gemini_omni.js
var geminiOmniTool = {
  name: "gemini_omni",
  description: "Create Gemini Omni videos or reusable Omni characters and voices from multimodal inputs.",
  category: "video",
  schema: GeminiOmniSchema,
  async run(args, ctx) {
    try {
      const request = GeminiOmniSchema.parse(args);
      request.callBackUrl = ctx.getCallbackUrl(request.callBackUrl);
      const response = await ctx.client.generateGeminiOmni(request);
      if (response.code !== 200 && response.code !== 0)
        throw new Error(response.msg || "Gemini Omni request failed");
      if (request.operation === "video") {
        const taskId = response.data?.taskId;
        if (!taskId)
          throw new Error("Gemini Omni did not return a task ID");
        await ctx.db.createTask({
          task_id: taskId,
          api_type: "gemini-omni-video",
          status: "pending"
        });
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              operation: request.operation || "video",
              data: response.data
            }, null, 2)
          }
        ]
      };
    } catch (error) {
      return ctx.formatError("gemini_omni", error, {
        operation: 'Optional: "video" (default), "character", or "audio"'
      });
    }
  }
};

// ../core/dist/tools/get_task_status.js
var getTaskStatusTool = {
  name: "get_task_status",
  description: "Get the status of a generation task with intelligent polling guidance. Returns task status, results, and recommended polling strategy (interval, timing, next steps) based on task type (image/video/audio).",
  category: "utility",
  schema: GetTaskStatusSchema,
  async run(args, ctx) {
    try {
      const { task_id } = GetTaskStatusSchema.parse(args);
      const localTask = await ctx.db.getTask(task_id);
      let apiResponse = null;
      let parsedResult = null;
      try {
        apiResponse = await ctx.client.getTaskStatus(task_id, localTask?.api_type);
        if (apiResponse?.data) {
          const apiData = apiResponse.data;
          let status = "pending";
          let resultUrl;
          let errorMessage;
          const creditsConsumed = typeof apiData.creditsConsumed === "number" ? apiData.creditsConsumed : typeof apiData.credits_consumed === "number" ? apiData.credits_consumed : void 0;
          if (localTask?.api_type === "suno") {
            const sunoStatus = apiData.status;
            if (sunoStatus === "SUCCESS")
              status = "completed";
            else if (sunoStatus === "CREATE_TASK_FAILED" || sunoStatus === "GENERATE_AUDIO_FAILED" || sunoStatus === "CALLBACK_EXCEPTION" || sunoStatus === "SENSITIVE_WORD_ERROR")
              status = "failed";
            else if (sunoStatus === "PENDING" || sunoStatus === "TEXT_SUCCESS" || sunoStatus === "FIRST_SUCCESS")
              status = "processing";
            if (apiData.response?.sunoData && apiData.response.sunoData.length > 0) {
              resultUrl = apiData.response.sunoData[0].audioUrl;
            }
            if (apiData.errorMessage) {
              errorMessage = apiData.errorMessage;
            }
          } else if (localTask?.api_type === "elevenlabs-tts" || localTask?.api_type === "elevenlabs-sound-effects") {
            const elevenlabsState = apiData.state;
            if (elevenlabsState === "success")
              status = "completed";
            else if (elevenlabsState === "fail")
              status = "failed";
            else if (elevenlabsState === "waiting")
              status = "processing";
            if (apiData.resultJson) {
              try {
                parsedResult = JSON.parse(apiData.resultJson);
                if (parsedResult.resultUrls && parsedResult.resultUrls.length > 0) {
                  resultUrl = parsedResult.resultUrls[0];
                }
              } catch (e) {
              }
            }
            if (apiData.failMsg) {
              errorMessage = apiData.failMsg;
            }
          } else if (localTask?.api_type === "flux-kontext-image") {
            const successFlag = apiData.successFlag;
            if (successFlag === 1)
              status = "completed";
            else if (successFlag === 2 || successFlag === 3)
              status = "failed";
            else if (successFlag === 0)
              status = "processing";
            if (apiData.response?.resultImageUrl) {
              resultUrl = apiData.response.resultImageUrl;
            }
            if (apiData.errorMessage) {
              errorMessage = apiData.errorMessage;
            }
          } else if (localTask?.api_type === "topaz-upscale") {
            const state = apiData.state;
            if (state === "success")
              status = "completed";
            else if (state === "fail")
              status = "failed";
            else if (state === "waiting")
              status = "processing";
            if (apiData.resultJson) {
              try {
                parsedResult = JSON.parse(apiData.resultJson);
                if (parsedResult.resultUrls && parsedResult.resultUrls.length > 0) {
                  resultUrl = parsedResult.resultUrls[0];
                }
              } catch (e) {
              }
            }
            if (apiData.failMsg) {
              errorMessage = apiData.failMsg;
            }
          } else if (localTask?.api_type === "recraft-remove-background") {
            const state = apiData.state;
            if (state === "success")
              status = "completed";
            else if (state === "fail")
              status = "failed";
            else if (state === "waiting")
              status = "processing";
            if (apiData.resultJson) {
              try {
                parsedResult = JSON.parse(apiData.resultJson);
                if (parsedResult.resultUrls && parsedResult.resultUrls.length > 0) {
                  resultUrl = parsedResult.resultUrls[0];
                }
              } catch (e) {
              }
            }
            if (apiData.failMsg) {
              errorMessage = apiData.failMsg;
            }
          } else if (localTask?.api_type === "ideogram-reframe") {
            const state = apiData.state;
            if (state === "success")
              status = "completed";
            else if (state === "fail")
              status = "failed";
            else if (state === "waiting")
              status = "processing";
            if (apiData.resultJson) {
              try {
                parsedResult = JSON.parse(apiData.resultJson);
                if (parsedResult.resultUrls && parsedResult.resultUrls.length > 0) {
                  resultUrl = parsedResult.resultUrls[0];
                }
              } catch (e) {
              }
            }
            if (apiData.failMsg) {
              errorMessage = apiData.failMsg;
            }
          } else {
            const { state, resultJson, failCode, failMsg } = apiData;
            if (state === "success")
              status = "completed";
            else if (state === "fail")
              status = "failed";
            else if (state === "waiting")
              status = "processing";
            if (resultJson) {
              try {
                parsedResult = JSON.parse(resultJson);
              } catch (e) {
              }
            }
            resultUrl = parsedResult?.resultUrls?.[0] || void 0;
            errorMessage = failMsg || void 0;
          }
          await ctx.db.updateTask(task_id, {
            status,
            result_url: resultUrl,
            error_message: errorMessage,
            credits_consumed: creditsConsumed
          });
        }
      } catch (error) {
      }
      const updatedTask = await ctx.db.getTask(task_id);
      const getPollingStrategy = (apiType) => {
        const imageModels = [
          "nano-banana",
          "nano-banana-edit",
          "nano-banana-image",
          "bytedance-seedream-image",
          "qwen-image",
          "gpt-image-2",
          "flux-kontext-image",
          "topaz-upscale",
          "recraft-remove-background",
          "ideogram-reframe",
          "midjourney"
        ];
        const videoModels = [
          "veo3",
          "veo3-fast",
          "veo3-1080p",
          "kling-3.0-video",
          "bytedance-seedance-video",
          "wan-video",
          "happyhorse-video",
          "hailuo",
          "runway-aleph-video"
        ];
        const audioModels = [
          "suno",
          "elevenlabs-tts",
          "elevenlabs-sound-effects"
        ];
        let taskType = "image";
        let recommendedInterval = 15;
        let maxWaitTime = 300;
        if (apiType) {
          if (imageModels.some((model) => apiType.includes(model))) {
            taskType = "image";
            recommendedInterval = 15;
            maxWaitTime = 180;
          } else if (videoModels.some((model) => apiType.includes(model))) {
            taskType = "video";
            recommendedInterval = 45;
            maxWaitTime = 600;
          } else if (audioModels.some((model) => apiType.includes(model))) {
            taskType = "audio";
            recommendedInterval = 20;
            maxWaitTime = 240;
          }
        }
        const status = updatedTask?.status;
        let nextAction = "continue_polling";
        if (status === "completed") {
          nextAction = "task_complete";
        } else if (status === "failed") {
          nextAction = "task_failed";
        }
        return {
          task_type: taskType,
          recommended_interval_seconds: recommendedInterval,
          max_wait_time_seconds: maxWaitTime,
          backoff_strategy: "fixed",
          next_action: nextAction,
          current_status: status,
          polling_instructions: {
            continue_polling: `Continue polling every ${recommendedInterval} seconds until status changes to 'completed' or 'failed'`,
            task_complete: "Task completed successfully - no further polling needed",
            task_failed: "Task failed - check error message and consider retrying"
          }
        };
      };
      const responseData = {
        success: true,
        task_id,
        status: updatedTask?.status,
        result_urls: updatedTask?.result_url ? [updatedTask.result_url] : [],
        error: updatedTask?.error_message,
        api_response: apiResponse,
        message: updatedTask ? "Task found" : "Task not found in local database",
        // Add self-documenting polling strategy
        polling_strategy: getPollingStrategy(localTask?.api_type)
      };
      if (typeof updatedTask?.credits_consumed === "number") {
        responseData.creditsConsumed = updatedTask.credits_consumed;
      }
      if (localTask?.api_type === "suno" && apiResponse?.data) {
        const sunoData = apiResponse.data;
        responseData.status = sunoData.status;
        if (sunoData.response?.sunoData) {
          responseData.audio_files = sunoData.response.sunoData.map((audio) => ({
            id: audio.id,
            audio_url: audio.audioUrl,
            stream_url: audio.streamAudioUrl,
            image_url: audio.imageUrl,
            title: audio.title,
            duration: audio.duration,
            model_name: audio.modelName,
            tags: audio.tags,
            create_time: audio.createTime
          }));
          responseData.result_urls = sunoData.response.sunoData.map((audio) => audio.audioUrl);
        }
        responseData.suno_metadata = {
          task_type: sunoData.type,
          operation_type: sunoData.operationType,
          parent_music_id: sunoData.parentMusicId,
          parameters: sunoData.param ? JSON.parse(sunoData.param) : null,
          error_code: sunoData.errorCode,
          error_message: sunoData.errorMessage
        };
      } else if ((localTask?.api_type === "elevenlabs-tts" || localTask?.api_type === "elevenlabs-sound-effects") && apiResponse?.data) {
        const elevenlabsData = apiResponse.data;
        responseData.status = elevenlabsData.state;
        if (elevenlabsData.resultJson) {
          try {
            const resultData = JSON.parse(elevenlabsData.resultJson);
            if (resultData.resultUrls) {
              responseData.result_urls = resultData.resultUrls;
              responseData.audio_url = resultData.resultUrls[0];
            }
          } catch (e) {
          }
        }
        responseData.elevenlabs_metadata = {
          model: elevenlabsData.model,
          state: elevenlabsData.state,
          cost_time: elevenlabsData.costTime,
          complete_time: elevenlabsData.completeTime,
          create_time: elevenlabsData.createTime,
          parameters: elevenlabsData.param ? JSON.parse(elevenlabsData.param) : null,
          fail_code: elevenlabsData.failCode,
          fail_message: elevenlabsData.failMsg
        };
      } else {
        responseData.status = apiResponse?.data?.state || updatedTask?.status;
        responseData.result_urls = parsedResult?.resultUrls || (updatedTask?.result_url ? [updatedTask.result_url] : []);
        responseData.error = apiResponse?.data?.failMsg || updatedTask?.error_message;
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(responseData, null, 2)
          }
        ]
      };
    } catch (error) {
      return ctx.formatError("get_task_status", error, {
        task_id: "Required: task ID to check status for"
      });
    }
  }
};

// ../core/dist/tools/get_upload_url.js
var getUploadUrlTool = {
  name: "get_upload_url",
  description: "Create short-lived capability URLs for a browser or HTTP client to upload media to this MCP server. Available only when Streamable HTTP storage is explicitly configured.",
  category: "utility",
  schema: GetUploadUrlSchema,
  ui: { visibility: ["app"] },
  async run(args, ctx) {
    try {
      const request = GetUploadUrlSchema.parse(args);
      if (!ctx.validateWidgetGrant?.(request.app_grant)) {
        throw new Error("Invalid or expired widget grant.");
      }
      if (!ctx.createUploadCapability) {
        throw new Error("Temporary HTTP upload storage is unavailable on this adapter. Use upload_file with file_base64 or a CLI-approved file_path, or run Streamable HTTP with KIE_MCP_PUBLIC_BASE_URL configured.");
      }
      const capability = await ctx.createUploadCapability({
        filename: request.filename,
        contentType: request.content_type,
        size: request.size,
        owner: ctx.approvalContext
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              media_id: capability.mediaId,
              upload_expires_at: capability.uploadExpiresAt,
              instructions: "The app received a one-use upload capability outside model-visible content. PUT exactly size bytes, then finalize media_id."
            }, null, 2)
          }
        ],
        structuredContent: { media_id: capability.mediaId },
        _meta: {
          upload: {
            upload_url: capability.uploadUrl,
            media_id: capability.mediaId,
            upload_expires_at: capability.uploadExpiresAt
          }
        }
      };
    } catch (error) {
      return ctx.formatError("get_upload_url", error, {
        app_grant: "Short-lived grant emitted by upload_widget metadata",
        filename: "Filename without path separators or control characters",
        content_type: "Supported image, video, or audio MIME type",
        size: "Exact size in bytes, maximum 25 MiB"
      });
    }
  }
};

// ../core/dist/tools/gpt_image_2.js
import { z as z8 } from "zod";
var gptImage2Tool = {
  name: "gpt_image_2",
  description: "Generate images using GPT Image 2 (text-to-image and image-to-image with up to 16 reference images)",
  category: "image",
  schema: GptImage2Schema,
  async run(args, ctx) {
    try {
      const request = GptImage2Schema.parse(args);
      request.callBackUrl = ctx.getCallbackUrl(request.callBackUrl);
      const response = await ctx.client.generateGptImage2(request);
      if (response.code === 200 && response.data?.taskId) {
        const mode = request.input_urls?.length ? "Image-to-Image" : "Text-to-Image";
        await ctx.db.createTask({
          task_id: response.data.taskId,
          api_type: "gpt-image-2",
          status: "pending"
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                task_id: response.data.taskId,
                message: `GPT Image 2 ${mode} task created successfully`,
                parameters: {
                  mode,
                  prompt: request.prompt.substring(0, 100) + (request.prompt.length > 100 ? "..." : ""),
                  aspect_ratio: request.aspect_ratio || "auto",
                  resolution: request.resolution || "1K",
                  ...request.input_urls && {
                    input_urls: request.input_urls
                  }
                },
                next_steps: [
                  `Use get_task_status with task_id: ${response.data.taskId} to check progress`,
                  'Generated images will be available when status is "completed"'
                ]
              }, null, 2)
            }
          ]
        };
      } else {
        throw new Error(response.msg || "Failed to create GPT Image 2 task");
      }
    } catch (error) {
      if (error instanceof z8.ZodError) {
        return ctx.formatError("gpt_image_2", error, {
          prompt: "Required: Text prompt describing the desired image (max 20000 chars)",
          input_urls: "Optional: Array of up to 16 image URLs for image-to-image mode",
          aspect_ratio: "Optional: auto, 1:1, 9:16, 16:9, 4:3, 3:4 (default: auto)",
          resolution: "Optional: 1K, 2K, 4K (default: 1K)"
        });
      }
      return ctx.formatError("gpt_image_2", error, {
        prompt: "Required: Text prompt describing the desired image (max 20000 chars)",
        input_urls: "Optional: Array of up to 16 image URLs for image-to-image mode",
        aspect_ratio: "Optional: auto, 1:1, 9:16, 16:9, 4:3, 3:4 (default: auto)",
        resolution: "Optional: 1K, 2K, 4K (default: 1K)"
      });
    }
  }
};

// ../core/dist/tools/grok_imagine.js
import { z as z9 } from "zod";
var grokImagineTool = {
  name: "grok_imagine",
  description: "Generate images and videos using xAI's Grok Imagine (5 modes: Image 2.0 text-to-image, Image 2.0 image-to-image, text-to-video, image-to-video, upscale). Supports synchronized audio with video.",
  category: "video",
  schema: GrokImagineSchema,
  async run(args, ctx) {
    try {
      const request = GrokImagineSchema.parse(args);
      request.callBackUrl = ctx.getCallbackUrl(request.callBackUrl);
      const response = await ctx.client.generateGrokImagine(request);
      if (response.code === 200 && response.data?.taskId) {
        const hasImageUrls = request.image_urls && request.image_urls.length > 0;
        const hasTaskId = !!request.task_id;
        const hasPrompt = !!request.prompt;
        const detectedMode = request.generation_mode || (hasTaskId && !hasPrompt && !hasImageUrls ? "upscale" : hasImageUrls || hasTaskId ? "image-to-video" : "text-to-video");
        await ctx.db.createTask({
          task_id: response.data.taskId,
          api_type: "grok-imagine",
          status: "pending"
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                task_id: response.data.taskId,
                message: `Grok Imagine ${detectedMode} task created successfully`,
                parameters: {
                  mode: detectedMode,
                  prompt: request.prompt ? request.prompt.substring(0, 100) + (request.prompt.length > 100 ? "..." : "") : void 0,
                  aspect_ratio: detectedMode === "text-to-image" || detectedMode === "image-to-image" ? request.aspect_ratio || "1:1" : request.aspect_ratio,
                  style_mode: detectedMode === "text-to-video" || detectedMode === "image-to-video" ? request.mode || "normal" : void 0
                },
                pricing: "unknown: no verified local rate-card formula",
                next_steps: [
                  `Use get_task_status with task_id: ${response.data.taskId} to check progress`,
                  'Generated content will be available when status is "completed"'
                ]
              }, null, 2)
            }
          ]
        };
      } else {
        throw new Error(response.msg || "Failed to create Grok Imagine task");
      }
    } catch (error) {
      if (error instanceof z9.ZodError) {
        return ctx.formatError("grok_imagine", error, {
          prompt: "Text prompt (required for text modes, optional for image-to-video)",
          image_urls: "One image URL for image-to-video, or one to five for explicit image-to-image",
          task_id: "Task ID for upscale or image-to-video from generated image",
          index: "Image index (0-5) when using task_id",
          aspect_ratio: "Image 2.0 image modes default to 1:1. text-to-image: 1:1, 2:3, 3:2, 16:9, or 9:16; image-to-image also accepts auto",
          mode: "Video style mode: fun, normal, or spicy",
          generation_mode: "Explicit mode: text-to-image, image-to-image, text-to-video, image-to-video, upscale"
        });
      }
      return ctx.formatError("grok_imagine", error, {
        prompt: "Text prompt (required for text modes, optional for image-to-video)",
        generation_mode: "Explicit mode: text-to-image, image-to-image, text-to-video, image-to-video, upscale"
      });
    }
  }
};

// ../core/dist/tools/hailuo_video.js
import { z as z10 } from "zod";
var hailuoVideoTool = {
  name: "hailuo_video",
  description: "Generate videos using MiniMax H3 (Hailuo 03) with text-to-video, image-to-video, or multimodal reference-to-video inputs.",
  category: "video",
  schema: HailuoVideoSchema,
  async run(args, ctx) {
    try {
      const request = HailuoVideoSchema.parse(args);
      request.callBackUrl = ctx.getCallbackUrl(request.callBackUrl);
      const response = await ctx.client.generateHailuoVideo(request);
      let mode;
      if (request.imageUrl) {
        mode = "image-to-video";
      } else if (request.referenceImageUrls?.length || request.referenceVideoUrls?.length || request.referenceAudioUrls?.length) {
        mode = "reference-to-video";
      } else {
        mode = "text-to-video";
      }
      if (response.code === 200 && response.data?.taskId) {
        await ctx.db.createTask({
          task_id: response.data.taskId,
          api_type: "hailuo",
          status: "pending"
        });
      } else {
        throw new Error(response.msg || "Failed to create MiniMax H3 video task");
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              task_id: response.data?.taskId,
              mode,
              message: `MiniMax H3 ${mode} task created successfully`,
              parameters: {
                prompt: request.prompt,
                imageUrl: request.imageUrl,
                endImageUrl: request.endImageUrl,
                referenceImageUrls: request.referenceImageUrls,
                referenceVideoUrls: request.referenceVideoUrls,
                referenceAudioUrls: request.referenceAudioUrls,
                duration: request.duration,
                aspectRatio: request.aspectRatio,
                resolution: request.resolution,
                callBackUrl: request.callBackUrl
              },
              next_steps: [
                "Use get_task_status to check generation progress",
                "Task completion will be sent to the provided callback URL"
              ]
            }, null, 2)
          }
        ]
      };
    } catch (error) {
      if (error instanceof z10.ZodError) {
        return ctx.formatError("hailuo_video", error, {
          prompt: "Required: video description",
          duration: "Required: integer video duration from 4 to 15 seconds",
          aspectRatio: "Text-to-video: required output ratio (21:9, 16:9, 4:3, 1:1, 3:4, or 9:16). Reference-to-video also accepts adaptive.",
          resolution: "Reference-to-video only: 768p",
          imageUrl: "Image-to-video: first-frame image URL",
          endImageUrl: "Image-to-video: optional last-frame image URL (requires imageUrl)",
          referenceImageUrls: "Reference-to-video: up to 9 reference image URLs",
          referenceVideoUrls: "Reference-to-video: up to 3 reference video URLs",
          referenceAudioUrls: "Reference-to-video: up to 3 reference audio URLs",
          callBackUrl: "Optional: callback URL for notifications (uses KIE_AI_CALLBACK_URL env var if not provided)"
        });
      }
      return ctx.formatError("hailuo_video", error, {
        prompt: "Required: text description for MiniMax H3 video generation",
        duration: "Required: integer video duration from 4 to 15 seconds",
        imageUrl: "Image-to-video: first-frame image URL",
        referenceImageUrls: "Reference-to-video: reference image URLs",
        referenceVideoUrls: "Reference-to-video: reference video URLs",
        referenceAudioUrls: "Reference-to-video: reference audio URLs",
        callBackUrl: "Optional: URL for task completion notifications"
      });
    }
  }
};

// ../core/dist/tools/happyhorse_video.js
import { z as z11 } from "zod";
var happyhorseVideoTool = {
  name: "happyhorse_video",
  description: "Generate videos using Alibaba HappyHorse 1.0 (text-to-video, image-to-video, reference-to-video with up to 9 images, video-edit with native audio)",
  category: "video",
  schema: HappyHorseVideoSchema,
  async run(args, ctx) {
    try {
      const request = HappyHorseVideoSchema.parse(args);
      request.callBackUrl = ctx.getCallbackUrl(request.callBackUrl);
      const response = await ctx.client.generateHappyHorseVideo(request);
      if (response.code === 200 && response.data?.taskId) {
        const mode = request.mode || (request.video_url ? "video-edit" : request.reference_image?.length ? "reference-to-video" : request.image_urls?.length ? "image-to-video" : "text-to-video");
        await ctx.db.createTask({
          task_id: response.data.taskId,
          api_type: "happyhorse-video",
          status: "pending"
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                task_id: response.data.taskId,
                message: `HappyHorse 1.0 ${mode} task created successfully`,
                parameters: {
                  mode,
                  prompt: request.prompt.substring(0, 100) + (request.prompt.length > 100 ? "..." : ""),
                  resolution: request.resolution || "1080p",
                  aspect_ratio: request.aspect_ratio || "16:9",
                  duration: request.duration || 5
                },
                next_steps: [
                  `Use get_task_status with task_id: ${response.data.taskId} to check progress`,
                  'Video will be available when status is "completed"'
                ]
              }, null, 2)
            }
          ]
        };
      } else {
        throw new Error(response.msg || "Failed to create HappyHorse task");
      }
    } catch (error) {
      if (error instanceof z11.ZodError) {
        return ctx.formatError("happyhorse_video", error, {
          prompt: "Required: Text prompt for video generation (max 5000 chars)",
          mode: "Optional: text-to-video, image-to-video, reference-to-video, video-edit",
          image_urls: "I2V: Single image URL",
          reference_image: "R2V: Up to 9 reference image URLs",
          video_url: "Video Edit: Video URL to edit"
        });
      }
      return ctx.formatError("happyhorse_video", error, {
        prompt: "Required: Text prompt for video generation (max 5000 chars)",
        mode: "Optional: text-to-video, image-to-video, reference-to-video, video-edit"
      });
    }
  }
};

// ../core/dist/tools/ideogram_reframe.js
import { z as z12 } from "zod";
var ideogramReframeTool = {
  name: "ideogram_reframe",
  description: "Reframe images to different aspect ratios and sizes using Ideogram V3 Reframe model",
  category: "image",
  schema: IdeogramReframeSchema,
  async run(args, ctx) {
    try {
      const request = IdeogramReframeSchema.parse(args);
      request.callBackUrl = ctx.getCallbackUrl(request.callBackUrl);
      const response = await ctx.client.generateIdeogramReframe(request);
      if (response.code === 200 && response.data?.taskId) {
        await ctx.db.createTask({
          task_id: response.data.taskId,
          api_type: "ideogram-reframe",
          status: "pending"
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                task_id: response.data.taskId,
                message: "Ideogram V3 Reframe task created successfully",
                parameters: {
                  image_url: request.image_url,
                  image_size: request.image_size,
                  rendering_speed: request.rendering_speed,
                  style: request.style,
                  num_images: request.num_images,
                  seed: request.seed,
                  callBackUrl: request.callBackUrl
                },
                next_steps: [
                  "Use get_task_status to check generation progress",
                  "Task completion will be sent to the provided callback URL",
                  "Image reframing typically takes 30-120 seconds depending on complexity and settings"
                ]
              }, null, 2)
            }
          ]
        };
      } else {
        throw new Error(response.msg || "Failed to create Ideogram V3 Reframe task");
      }
    } catch (error) {
      if (error instanceof z12.ZodError) {
        return ctx.formatError("ideogram_reframe", error, {
          image_url: "Required: URL of image to reframe (JPEG, PNG, WEBP, max 10MB)",
          image_size: "Required: Output size (square, square_hd, portrait_4_3, portrait_16_9, landscape_4_3, landscape_16_9)",
          rendering_speed: "Optional: Rendering speed (TURBO, BALANCED, QUALITY) - default: BALANCED",
          style: "Optional: Style type (AUTO, GENERAL, REALISTIC, DESIGN) - default: AUTO",
          num_images: "Optional: Number of images (1, 2, 3, 4) - default: 1",
          seed: "Optional: Seed for reproducible results (default: 0)",
          callBackUrl: "Optional: URL for task completion notifications (uses KIE_AI_CALLBACK_URL env var if not provided)"
        });
      }
      return ctx.formatError("ideogram_reframe", error, {
        image_url: "Required: URL of image to reframe",
        image_size: "Required: Output size for the reframed image",
        rendering_speed: "Optional: Rendering speed preference",
        style: "Optional: Style type for generation",
        num_images: "Optional: Number of images to generate",
        seed: "Optional: Seed for reproducible results",
        callBackUrl: "Optional: URL for task completion notifications"
      });
    }
  }
};

// ../core/dist/tools/infinitalk_lip_sync.js
import { z as z13 } from "zod";
var infinitalkLipSyncTool = {
  name: "infinitalk_lip_sync",
  description: "Generate AI lip-sync talking videos using MeiGen-AI InfiniTalk. Transforms portrait image and audio into a natural talking avatar with synchronized lips, facial expressions, and head movements.",
  category: "video",
  schema: InfiniTalkSchema,
  async run(args, ctx) {
    try {
      const request = InfiniTalkSchema.parse(args);
      request.callBackUrl = ctx.getCallbackUrl(request.callBackUrl);
      const response = await ctx.client.generateInfiniTalk(request);
      if (response.code === 200 && response.data?.taskId) {
        await ctx.db.createTask({
          task_id: response.data.taskId,
          api_type: "infinitalk",
          status: "pending"
        });
        const resolution = request.resolution || "480p";
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                task_id: response.data.taskId,
                message: "InfiniTalk lip-sync video task created successfully",
                parameters: {
                  prompt: request.prompt.substring(0, 100) + (request.prompt.length > 100 ? "..." : ""),
                  resolution,
                  seed: request.seed
                },
                pricing: "unknown: no verified local rate-card formula",
                next_steps: [
                  `Use get_task_status with task_id: ${response.data.taskId} to check progress`,
                  'Lip-synced video will be available when status is "completed"'
                ]
              }, null, 2)
            }
          ]
        };
      } else {
        throw new Error(response.msg || "Failed to create InfiniTalk lip-sync task");
      }
    } catch (error) {
      if (error instanceof z13.ZodError) {
        return ctx.formatError("infinitalk_lip_sync", error, {
          image_url: "Required: URL of portrait image to animate",
          audio_url: "Required: URL of audio file for lip sync",
          prompt: "Required: Text prompt to guide video generation",
          resolution: "Optional: 480p (default, cheaper) or 720p (higher quality)",
          seed: "Optional: Random seed for reproducibility (10000-1000000)",
          callBackUrl: "Optional: URL for task completion notifications"
        });
      }
      return ctx.formatError("infinitalk_lip_sync", error, {
        image_url: "Required: URL of portrait image to animate",
        audio_url: "Required: URL of audio file for lip sync",
        prompt: "Required: Text prompt to guide video generation"
      });
    }
  }
};

// ../core/dist/tools/kling_avatar.js
import { z as z14 } from "zod";
var klingAvatarTool = {
  name: "kling_avatar",
  description: "Generate lifelike talking avatar videos using Kuaishou Kling AI. Transforms portrait photo and audio into a realistic avatar with accurate lip-sync, emotions, and identity preservation.",
  category: "video",
  schema: KlingAvatarSchema,
  async run(args, ctx) {
    try {
      const request = KlingAvatarSchema.parse(args);
      request.callBackUrl = ctx.getCallbackUrl(request.callBackUrl);
      const response = await ctx.client.generateKlingAvatar(request);
      if (response.code === 200 && response.data?.taskId) {
        await ctx.db.createTask({
          task_id: response.data.taskId,
          api_type: "kling-avatar",
          status: "pending"
        });
        const quality = request.quality || "standard";
        const resolution = quality === "pro" ? "1080P" : "720P";
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                task_id: response.data.taskId,
                message: "Kling Avatar video task created successfully",
                parameters: {
                  quality,
                  resolution,
                  prompt: request.prompt.substring(0, 100) + (request.prompt.length > 100 ? "..." : "")
                },
                pricing: "unknown: no verified local rate-card formula",
                next_steps: [
                  `Use get_task_status with task_id: ${response.data.taskId} to check progress`,
                  'Avatar video will be available when status is "completed"'
                ]
              }, null, 2)
            }
          ]
        };
      } else {
        throw new Error(response.msg || "Failed to create Kling Avatar task");
      }
    } catch (error) {
      if (error instanceof z14.ZodError) {
        return ctx.formatError("kling_avatar", error, {
          image_url: "Required: URL of portrait image for avatar",
          audio_url: "Required: URL of audio file for avatar to speak",
          prompt: "Required: Text prompt to guide video generation",
          quality: "Optional: standard (720P, default) or pro (1080P)",
          callBackUrl: "Optional: URL for task completion notifications"
        });
      }
      return ctx.formatError("kling_avatar", error, {
        image_url: "Required: URL of portrait image for avatar",
        audio_url: "Required: URL of audio file for avatar to speak",
        prompt: "Required: Text prompt to guide video generation"
      });
    }
  }
};

// ../core/dist/tools/kling_video.js
import { z as z15 } from "zod";
var klingVideoTool = {
  name: "kling_video",
  description: "Generate videos using Kling 3.0 AI - supports 3-15s flexible duration, native multilingual audio, multi-shot storytelling, character elements, and std/pro quality modes",
  category: "video",
  schema: KlingVideoSchema,
  async run(args, ctx) {
    try {
      const request = KlingVideoSchema.parse(args);
      request.callBackUrl = ctx.getCallbackUrl(request.callBackUrl);
      const response = await ctx.client.generateKlingVideo(request);
      const hasImages = !!request.image_urls && request.image_urls.length > 0;
      const modeDescription = request.multi_shots ? "Kling 3.0 multi-shot" : hasImages ? "Kling 3.0 image-to-video" : "Kling 3.0 text-to-video";
      if (response.code === 200 && response.data?.taskId) {
        await ctx.db.createTask({
          task_id: response.data.taskId,
          api_type: "kling-3.0-video",
          status: "pending"
        });
      } else {
        throw new Error(response.msg || "Failed to create Kling 3.0 video task");
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              task_id: response.data?.taskId,
              mode: modeDescription,
              message: `Kling 3.0 video generation task created successfully (${modeDescription})`,
              parameters: {
                prompt: request.prompt,
                duration: request.duration || "5",
                aspect_ratio: request.aspect_ratio || "16:9",
                mode: request.mode || "std",
                sound: request.sound ?? false,
                multi_shots: request.multi_shots ?? false,
                callBackUrl: request.callBackUrl
              },
              next_steps: [
                "Use get_task_status to check generation progress",
                "Task completion will be sent to the provided callback URL",
                "Video generation typically takes 1-5 minutes depending on duration and complexity"
              ]
            }, null, 2)
          }
        ]
      };
    } catch (error) {
      if (error instanceof z15.ZodError) {
        return ctx.formatError("kling_video", error, {
          prompt: "Required: video description (max 5000 chars)",
          image_urls: "Optional: up to 2 image URLs (start frame, end frame)",
          duration: 'Optional: video duration "3"-"15" (default: "5")',
          aspect_ratio: 'Optional: aspect ratio "16:9", "9:16", or "1:1" (default: "16:9")',
          mode: 'Optional: "std" or "pro" (default: "std")',
          sound: "Optional: enable native audio (default: false)",
          multi_shots: "Optional: enable multi-shot mode (requires multi_prompt)",
          multi_prompt: "Optional: array of {prompt, duration} for multi-shot scenes",
          kling_elements: "Optional: character/object elements for identity consistency",
          callBackUrl: "Optional: callback URL (uses KIE_AI_CALLBACK_URL env var if not provided)"
        });
      }
      return ctx.formatError("kling_video", error, {
        prompt: "Required: text description for video generation",
        image_urls: "Optional: up to 2 image URLs for image-to-video",
        duration: "Optional: video duration 3-15 seconds",
        aspect_ratio: "Optional: aspect ratio (16:9, 9:16, 1:1)",
        mode: "Optional: quality mode (std or pro)",
        sound: "Optional: enable native audio generation",
        callBackUrl: "Optional: URL for task completion notifications"
      });
    }
  }
};

// ../core/dist/model-catalog.js
var marketDocs = "https://docs.kie.ai/market-api/quickstart";
var MODEL_CATALOG = [
  {
    toolName: "nano_banana_image",
    model: "nano-banana-2",
    capabilities: ["image generation", "image editing"],
    description: "Nano Banana 2 image generation and editing.",
    status: "active",
    evidenceUrl: "https://docs.kie.ai/market/google/nano-banana-2-lite",
    defaultProfile: "image-fast"
  },
  {
    toolName: "bytedance_seedream_image",
    model: "seedream-5-lite",
    capabilities: ["image generation", "image editing"],
    description: "ByteDance Seedream image generation and editing.",
    status: "active",
    evidenceUrl: marketDocs
  },
  {
    toolName: "qwen_image",
    model: "qwen-image",
    capabilities: ["image generation", "image editing"],
    description: "Qwen image generation and editing.",
    status: "active",
    evidenceUrl: marketDocs
  },
  {
    toolName: "gpt_image_2",
    model: "gpt-image-2",
    capabilities: ["image generation", "image editing"],
    description: "GPT Image 2 generation and image-to-image.",
    status: "active",
    evidenceUrl: marketDocs
  },
  {
    toolName: "flux_kontext_image",
    model: "flux-kontext-pro",
    capabilities: ["image generation", "image editing"],
    description: "Flux Kontext generation and editing.",
    status: "active",
    evidenceUrl: marketDocs
  },
  {
    toolName: "flux2_image",
    model: "flux-2-pro",
    capabilities: ["image generation", "image editing"],
    description: "Flux 2 generation and image-to-image.",
    status: "active",
    evidenceUrl: marketDocs
  },
  {
    toolName: "z_image",
    model: "z-image",
    capabilities: ["image generation"],
    description: "Tongyi-MAI Z-Image generation.",
    status: "active",
    evidenceUrl: marketDocs
  },
  {
    toolName: "topaz_upscale_image",
    model: "topaz-image-upscale",
    capabilities: ["image upscale"],
    description: "Topaz image enhancement and upscaling.",
    status: "active",
    evidenceUrl: marketDocs
  },
  {
    toolName: "ideogram_reframe",
    model: "ideogram-v3-reframe",
    capabilities: ["image reframe"],
    description: "Ideogram aspect-ratio reframing.",
    status: "active",
    evidenceUrl: marketDocs
  },
  {
    toolName: "recraft_remove_background",
    model: "recraft-remove-background",
    capabilities: ["background removal"],
    description: "Recraft background removal.",
    status: "active",
    evidenceUrl: marketDocs
  },
  {
    toolName: "midjourney_generate",
    model: "midjourney",
    capabilities: ["image generation", "image to image", "image to video"],
    description: "Midjourney image and video generation modes.",
    status: "active",
    evidenceUrl: marketDocs
  },
  {
    toolName: "veo3_generate_video",
    model: "veo3",
    capabilities: ["text to video", "image to video", "audio"],
    description: "Google Veo 3 video generation.",
    status: "active",
    evidenceUrl: "https://docs.kie.ai/veo3-api/quickstart",
    defaultProfile: "veo-fast"
  },
  {
    toolName: "bytedance_seedance_video",
    model: "bytedance/seedance-2-5",
    capabilities: [
      "text to video",
      "image to video",
      "reference to video",
      "audio"
    ],
    description: "ByteDance Seedance 2.5 video generation.",
    status: "active",
    evidenceUrl: "https://docs.kie.ai/market/bytedance/seedance-2-5",
    defaultProfile: "seedance-safe"
  },
  {
    toolName: "kling_video",
    model: "kling-3.0",
    capabilities: ["text to video", "image to video", "audio", "multi shot"],
    description: "Kling 3.0 video generation.",
    status: "active",
    evidenceUrl: marketDocs,
    defaultProfile: "kling-safe"
  },
  {
    toolName: "hailuo_video",
    model: "minimax-h3",
    capabilities: ["text to video", "image to video", "reference to video"],
    description: "MiniMax H3 video generation.",
    status: "active",
    evidenceUrl: "https://docs.kie.ai/market/minimax-h3/reference-to-video",
    defaultProfile: "hailuo-safe"
  },
  {
    toolName: "wan_video",
    model: "wan-3.0",
    capabilities: [
      "text to video",
      "image to video",
      "reference to video",
      "file to video",
      "link to video",
      "audio"
    ],
    description: "Wan video generation and editing.",
    status: "active",
    evidenceUrl: "https://docs.kie.ai/market/wan/3-0-video"
  },
  {
    toolName: "wan_animate",
    model: "wan-animate",
    capabilities: ["character animation", "character replacement"],
    description: "Wan character animation and replacement.",
    status: "active",
    evidenceUrl: marketDocs
  },
  {
    toolName: "happyhorse_video",
    model: "happyhorse-1.0",
    capabilities: [
      "text to video",
      "image to video",
      "reference to video",
      "video editing"
    ],
    description: "HappyHorse video generation and editing.",
    status: "active",
    evidenceUrl: marketDocs
  },
  {
    toolName: "runway_aleph_video",
    model: "runway-aleph",
    capabilities: ["video editing"],
    description: "Runway Aleph video transformation.",
    status: "active",
    evidenceUrl: "https://docs.kie.ai/runway-api/quickstart"
  },
  {
    toolName: "grok_imagine",
    model: "grok-imagine-image-2-0",
    capabilities: [
      "text to image",
      "image to image",
      "text to video",
      "image to video",
      "image upscale"
    ],
    description: "Grok Imagine Image 2.0 image generation and Grok Imagine video generation.",
    status: "active",
    evidenceUrl: "https://docs.kie.ai/market/grok-imagine-image-2-0/text-to-image"
  },
  {
    toolName: "infinitalk_lip_sync",
    model: "infinitalk",
    capabilities: ["lip sync", "talking avatar"],
    description: "InfiniTalk lip-sync video generation.",
    status: "active",
    evidenceUrl: marketDocs
  },
  {
    toolName: "kling_avatar",
    model: "kling-avatar",
    capabilities: ["lip sync", "talking avatar"],
    description: "Kling talking-avatar generation.",
    status: "active",
    evidenceUrl: marketDocs
  },
  {
    toolName: "omnihuman_video",
    model: "omnihuman-1.5",
    capabilities: ["talking avatar", "lip sync"],
    description: "OmniHuman avatar video generation.",
    status: "active",
    evidenceUrl: marketDocs
  },
  {
    toolName: "gemini_omni",
    model: "gemini-omni",
    capabilities: ["text to video", "character", "voice"],
    description: "Gemini Omni video, character, and voice generation.",
    status: "active",
    evidenceUrl: marketDocs
  },
  {
    toolName: "suno_generate_music",
    model: "suno-v5",
    capabilities: ["music generation"],
    description: "Suno music generation.",
    status: "active",
    evidenceUrl: "https://docs.kie.ai/suno-api/quickstart"
  },
  {
    toolName: "elevenlabs_tts",
    model: "elevenlabs-tts",
    capabilities: ["text to speech"],
    description: "ElevenLabs text-to-speech.",
    status: "active",
    evidenceUrl: marketDocs
  },
  {
    toolName: "elevenlabs_ttsfx",
    model: "elevenlabs-sound-effects",
    capabilities: ["sound effects"],
    description: "ElevenLabs sound-effect generation.",
    status: "active",
    evidenceUrl: marketDocs
  }
];
function getCatalogEntry(toolName) {
  return MODEL_CATALOG.find((entry) => entry.toolName === toolName);
}
function filterCatalog(filter) {
  if (!filter?.trim())
    return MODEL_CATALOG;
  const terms = filter.toLowerCase().split(/\s+/).filter(Boolean);
  return MODEL_CATALOG.filter((entry) => {
    const searchable = [
      entry.toolName,
      entry.model,
      entry.description,
      ...entry.capabilities
    ].join(" ").toLowerCase();
    return terms.every((term) => searchable.includes(term));
  });
}

// ../core/dist/tools/list_models.js
var listModelsTool = {
  name: "list_models",
  description: "List source-backed catalog models. Filter by words from capabilities, model names, or descriptions.",
  category: "utility",
  schema: ListModelsSchema,
  async run(args, ctx) {
    try {
      const { filter } = ListModelsSchema.parse(args);
      const models = filterCatalog(filter);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              filter: filter ?? null,
              models,
              count: models.length,
              note: "Capabilities and descriptions are catalog metadata. Follow each evidenceUrl for provider facts."
            }, null, 2)
          }
        ]
      };
    } catch (error) {
      return ctx.formatError("list_models", error, {
        filter: "Optional capability or text filter, for example: lip sync"
      });
    }
  }
};

// ../core/dist/tools/list_tasks.js
var listTasksTool = {
  name: "list_tasks",
  description: "List recent tasks with their status",
  category: "utility",
  schema: ListTasksSchema,
  async run(args, ctx) {
    try {
      const { limit = 20, status } = ListTasksSchema.parse(args);
      const tasks = status ? await ctx.db.getTasksByStatus(status, limit) : await ctx.db.getAllTasks(limit);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              tasks,
              count: tasks.length,
              message: `Retrieved ${tasks.length} tasks`
            }, null, 2)
          }
        ]
      };
    } catch (error) {
      return ctx.formatError("list_tasks", error, {
        limit: "Optional: max tasks to return (1-100, default: 20)",
        status: "Optional: filter by status (pending, processing, completed, failed)"
      });
    }
  }
};

// ../core/dist/tools/midjourney_generate.js
import { z as z16 } from "zod";
var midjourneyGenerateTool = {
  name: "midjourney_generate",
  description: "Generate images and videos using Midjourney AI models (unified tool for text-to-image, image-to-image, style reference, omni reference, and video generation)",
  category: "image",
  schema: MidjourneyGenerateSchema,
  async run(args, ctx) {
    try {
      const request = MidjourneyGenerateSchema.parse(args);
      request.callBackUrl = ctx.getCallbackUrl(request.callBackUrl);
      const response = await ctx.client.generateMidjourney(request);
      if (response.code === 200 && response.data?.taskId) {
        const hasImage = request.fileUrl || request.fileUrls && request.fileUrls.length > 0;
        const isVideoMode = request.motion || request.videoBatchSize || request.high_definition_video;
        const isOmniMode = request.ow || request.taskType === "mj_omni_reference";
        const isStyleMode = request.taskType === "mj_style_reference";
        let taskTypeDisplay = "Text-to-Image";
        if (isOmniMode) {
          taskTypeDisplay = "Omni Reference";
        } else if (isStyleMode) {
          taskTypeDisplay = "Style Reference";
        } else if (isVideoMode) {
          taskTypeDisplay = request.high_definition_video ? "Image-to-HD-Video" : "Image-to-Video";
        } else if (hasImage) {
          taskTypeDisplay = "Image-to-Image";
        }
        await ctx.db.createTask({
          task_id: response.data.taskId,
          api_type: "midjourney",
          status: "pending"
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                task_id: response.data.taskId,
                message: `Midjourney ${taskTypeDisplay} task created successfully`,
                parameters: {
                  task_type: taskTypeDisplay,
                  prompt: request.prompt.substring(0, 100) + (request.prompt.length > 100 ? "..." : ""),
                  aspect_ratio: request.aspectRatio || "16:9",
                  version: request.version || "7",
                  speed: request.speed,
                  variety: request.variety,
                  stylization: request.stylization,
                  weirdness: request.weirdness,
                  enable_translation: request.enableTranslation || false,
                  waterMark: request.waterMark,
                  ...hasImage && {
                    file_urls: request.fileUrls || [request.fileUrl]
                  },
                  ...isVideoMode && {
                    motion: request.motion || "high",
                    video_batch_size: request.videoBatchSize || "1",
                    high_definition_video: request.high_definition_video || false
                  },
                  ...isOmniMode && {
                    ow: request.ow
                  }
                },
                next_steps: [
                  `Use get_task_status with task_id: ${response.data.taskId} to check progress`,
                  'Generated content will be available when status is "completed"'
                ],
                usage_examples: [
                  `get_task_status: {"task_id": "${response.data.taskId}"}`,
                  `list_tasks: {"limit": 10}`
                ]
              }, null, 2)
            }
          ]
        };
      } else {
        throw new Error(response.msg || "Failed to create Midjourney task");
      }
    } catch (error) {
      if (error instanceof z16.ZodError) {
        return ctx.formatError("midjourney_generate", error, {
          prompt: "Required: Text prompt describing the desired image (max 2000 chars)",
          taskType: "Optional: Task type (mj_txt2img, mj_img2img, mj_style_reference, mj_omni_reference, mj_video, mj_video_hd) - auto-detected if not provided",
          fileUrl: "Optional: Single image URL for image-to-image or video generation (legacy)",
          fileUrls: "Optional: Array of image URLs for image-to-image or video generation (recommended)",
          speed: "Optional: Generation speed (relaxed/fast/turbo) - not required for video/omni tasks",
          aspectRatio: "Optional: Output aspect ratio (1:2, 9:16, 2:3, 3:4, 5:6, 6:5, 4:3, 3:2, 1:1, 16:9, 2:1, default: 16:9)",
          version: "Optional: Midjourney model version (7, 6.1, 6, 5.2, 5.1, niji6, default: 7)",
          variety: "Optional: Diversity control (0-100, increment by 5)",
          stylization: "Optional: Artistic style intensity (0-1000, suggested multiple of 50)",
          weirdness: "Optional: Creativity level (0-3000, suggested multiple of 100)",
          ow: "Optional: Omni intensity for omni reference tasks (1-1000)",
          waterMark: "Optional: Watermark identifier (max 100 chars)",
          enableTranslation: "Optional: Auto-translate non-English prompts (default: false)",
          videoBatchSize: "Optional: Number of videos to generate (1/2/4, default: 1, video mode only)",
          motion: "Optional: Video motion level (high/low, default: high, required for video)",
          high_definition_video: "Optional: Use HD video generation (default: false, uses standard definition)",
          callBackUrl: "Optional: URL for task completion notifications (uses KIE_AI_CALLBACK_URL env var if not provided)"
        });
      }
      return ctx.formatError("midjourney_generate", error, {
        prompt: "Required: Text prompt describing the desired image (max 2000 chars)",
        taskType: "Optional: Task type (mj_txt2img, mj_img2img, mj_style_reference, mj_omni_reference, mj_video, mj_video_hd) - auto-detected if not provided",
        fileUrl: "Optional: Single image URL for image-to-image or video generation (legacy)",
        fileUrls: "Optional: Array of image URLs for image-to-image or video generation (recommended)",
        speed: "Optional: Generation speed (relaxed/fast/turbo) - not required for video/omni tasks",
        aspectRatio: "Optional: Output aspect ratio (1:2, 9:16, 2:3, 3:4, 5:6, 6:5, 4:3, 3:2, 1:1, 16:9, 2:1, default: 16:9)",
        version: "Optional: Midjourney model version (7, 6.1, 6, 5.2, 5.1, niji6, default: 7)",
        variety: "Optional: Diversity control (0-100, increment by 5)",
        stylization: "Optional: Artistic style intensity (0-1000, suggested multiple of 50)",
        weirdness: "Optional: Creativity level (0-3000, suggested multiple of 100)",
        ow: "Optional: Omni intensity for omni reference tasks (1-1000)",
        waterMark: "Optional: Watermark identifier (max 100 chars)",
        enableTranslation: "Optional: Auto-translate non-English prompts (default: false)",
        videoBatchSize: "Optional: Number of videos to generate (1/2/4, default: 1, video mode only)",
        motion: "Optional: Video motion level (high/low, default: high, required for video)",
        high_definition_video: "Optional: Use HD video generation (default: false, uses standard definition)",
        callBackUrl: "Optional: URL for task completion notifications (uses KIE_AI_CALLBACK_URL env var if not provided)"
      });
    }
  }
};

// ../core/dist/tools/nano_banana_image.js
var nanoBananaImageTool = {
  name: "nano_banana_image",
  description: "Generate and edit images using Nano Banana 2 or the faster 1K Nano Banana 2 Lite. Nano Banana 2 supports 4K, 14 references, and Google Search grounding; Lite supports up to 10 references.",
  category: "image",
  schema: NanoBananaImageSchema,
  async run(args, ctx) {
    try {
      const request = NanoBananaImageSchema.parse(args);
      const response = await ctx.client.generateNanoBananaImage(request);
      const isEdit = !!request.image_input && request.image_input.length > 0;
      const apiType = isEdit ? "nano-banana-edit" : "nano-banana-image";
      const modeDescription = isEdit ? "edit" : "generate";
      if (response.code === 200 && response.data?.taskId) {
        await ctx.db.createTask({
          task_id: response.data.taskId,
          api_type: apiType,
          status: "pending",
          result_url: response.data.imageUrl
        });
      } else {
        throw new Error(response.msg || "Failed to create Nano Banana image task");
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              response,
              mode: modeDescription,
              message: `${request.model === "nano-banana-2-lite" ? "Nano Banana 2 Lite" : "Nano Banana 2"} image ${modeDescription} initiated`
            }, null, 2)
          }
        ]
      };
    } catch (error) {
      return ctx.formatError("nano_banana_image", error, {
        prompt: "Required for generate/edit modes: text description (max 5000 chars)",
        model: 'Optional: "nano-banana-2" (default) or "nano-banana-2-lite"',
        image_input: "Optional for edit mode: array of up to 14 reference image URLs",
        output_format: 'Optional: "png" or "jpg"',
        aspect_ratio: 'Optional: aspect ratio like "16:9", "1:1", etc.',
        resolution: 'Optional: "1K", "2K", or "4K"',
        google_search: "Optional: enable Google Search grounding (default: false)"
      });
    }
  }
};

// ../core/dist/tools/omnihuman_video.js
var omniHumanVideoTool = {
  name: "omnihuman_video",
  description: "Animate a portrait, pet, or character from an image and audio using ByteDance OmniHuman 1.5.",
  category: "video",
  schema: OmniHumanVideoSchema,
  async run(args, ctx) {
    try {
      const request = OmniHumanVideoSchema.parse(args);
      request.callBackUrl = ctx.getCallbackUrl(request.callBackUrl);
      const response = await ctx.client.generateOmniHumanVideo(request);
      if (response.code !== 200 || !response.data?.taskId) {
        throw new Error(response.msg || "Failed to create OmniHuman video task");
      }
      await ctx.db.createTask({
        task_id: response.data.taskId,
        api_type: "omnihuman-video",
        status: "pending"
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              task_id: response.data.taskId,
              message: "OmniHuman 1.5 video task created successfully"
            }, null, 2)
          }
        ]
      };
    } catch (error) {
      return ctx.formatError("omnihuman_video", error, {
        image_url: "Required: publicly accessible portrait image URL",
        audio_url: "Required: audio URL under 60 seconds",
        mask_url: "Optional: subject mask URLs (up to 5)"
      });
    }
  }
};

// ../core/dist/generation-plan.js
import { createHash, randomUUID } from "crypto";

// ../core/dist/pricing/rate-card.js
var RATE_CARD_VERSION = "2026-08-17";
var RATE_CARD = [
  {
    toolName: "nano_banana_image",
    scope: "text-to-image",
    name: "Nano Banana 2 Lite image",
    sourceUrl: "https://kie.ai/pricing",
    sourceFingerprint: "kie-pricing-2026-08-17:nano-banana-2-lite:4-per-image",
    verifiedAt: "2026-08-17",
    matches: (args, model, mode) => mode === "text-to-image" && model === "nano-banana-2-lite" && Number(args.outputCount ?? 1) === 1,
    credits: () => 4
  },
  {
    toolName: "hailuo_video",
    scope: "reference-to-video",
    name: "MiniMax H3 reference-to-video at 768p",
    sourceUrl: "https://kie.ai/pricing",
    sourceFingerprint: "kie-pricing-2026-08-17:minimax-h3-reference-768p:16-per-second",
    verifiedAt: "2026-08-17",
    matches: (args, _model, mode) => mode === "reference-to-video" && args.resolution === "768p" && typeof args.duration === "number",
    credits: (args) => typeof args.duration === "number" ? args.duration * 16 : void 0
  }
];
function priceRequest(toolName, args, model, mode) {
  const entry = RATE_CARD.find((candidate) => candidate.toolName === toolName && candidate.matches(args, model, mode));
  if (!entry)
    return { status: "unknown", rateCardVersion: RATE_CARD_VERSION };
  const credits = entry.credits(args);
  if (credits === void 0)
    return { status: "unknown", rateCardVersion: RATE_CARD_VERSION };
  return {
    status: "exact",
    credits,
    sourceUrl: entry.sourceUrl,
    sourceFingerprint: entry.sourceFingerprint,
    verifiedAt: entry.verifiedAt,
    rateCardVersion: RATE_CARD_VERSION
  };
}

// ../core/dist/generation-plan.js
var POLICY_DEFAULTS = {
  "image-fast": { model: "nano-banana-2-lite", resolution: "1K" },
  "seedance-safe": { resolution: "720p", duration: 5, generate_audio: false },
  "kling-safe": { mode: "std", duration: "5", sound: false },
  "veo-fast": { model: "veo3_fast" },
  "hailuo-safe": { duration: 5, aspectRatio: "16:9" }
};
function stableJson(value) {
  if (Array.isArray(value))
    return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function hashPlanPayload(payload) {
  return createHash("sha256").update(stableJson(payload)).digest("hex");
}
function hasValues(value) {
  return Array.isArray(value) && value.length > 0;
}
function resolveGenerationMode(tool, args) {
  switch (tool) {
    case "nano_banana_image":
      return hasValues(args.image_input) ? "image-to-image" : "text-to-image";
    case "bytedance_seedream_image":
      return hasValues(args.image_urls) ? "image-to-image" : "text-to-image";
    case "qwen_image":
      return args.image_url ? "image-to-image" : "text-to-image";
    case "gpt_image_2":
      return hasValues(args.input_urls) ? "image-to-image" : "text-to-image";
    case "flux_kontext_image":
      return args.inputImage ? "image-to-image" : "text-to-image";
    case "flux2_image":
      return hasValues(args.input_urls) ? "image-to-image" : "text-to-image";
    case "midjourney_generate": {
      const taskTypeModes = {
        mj_txt2img: "text-to-image",
        mj_img2img: "image-to-image",
        mj_style_reference: "style-reference",
        mj_omni_reference: "omni-reference",
        mj_video: "image-to-video",
        mj_video_hd: "image-to-hd-video"
      };
      if (typeof args.taskType === "string" && taskTypeModes[args.taskType]) {
        return taskTypeModes[args.taskType];
      }
      if (args.ow)
        return "omni-reference";
      if (args.motion || args.videoBatchSize || args.high_definition_video) {
        return args.high_definition_video ? "image-to-hd-video" : "image-to-video";
      }
      return args.fileUrl || hasValues(args.fileUrls) ? "image-to-image" : "text-to-image";
    }
    case "grok_imagine":
      if (typeof args.generation_mode === "string")
        return args.generation_mode;
      if (args.task_id && !args.prompt && !hasValues(args.image_urls))
        return "upscale";
      return args.task_id || hasValues(args.image_urls) ? "image-to-video" : "text-to-video";
    case "hailuo_video":
      return args.imageUrl ? "image-to-video" : hasValues(args.referenceImageUrls) || hasValues(args.referenceVideoUrls) || hasValues(args.referenceAudioUrls) ? "reference-to-video" : "text-to-video";
    case "bytedance_seedance_video":
      return args.first_frame_url ? "image-to-video" : hasValues(args.reference_image_urls) || hasValues(args.reference_video_urls) || hasValues(args.reference_audio_urls) ? "reference-to-video" : "text-to-video";
    case "veo3_generate_video":
      return hasValues(args.imageUrls) ? "image-to-video" : "text-to-video";
    case "kling_video":
      return args.multi_shots ? "multi-shot" : hasValues(args.image_urls) ? "image-to-video" : "text-to-video";
    case "wan_video":
      return hasValues(args.reference_file_urls) ? "file-to-video" : hasValues(args.reference_link_urls) ? "link-to-video" : hasValues(args.reference_image_urls) || hasValues(args.reference_video_urls) || hasValues(args.reference_audio_urls) ? "reference-to-video" : args.first_frame_url || args.last_frame_url ? "image-to-video" : "text-to-video";
    case "happyhorse_video":
      if (typeof args.mode === "string")
        return args.mode;
      return args.video_url ? "video-edit" : hasValues(args.reference_image) ? "reference-to-video" : hasValues(args.image_urls) ? "image-to-video" : "text-to-video";
    case "wan_animate":
      return args.mode === "replace" ? "character-replacement" : "animation";
    case "gemini_omni":
      return args.operation === "character" ? "character" : args.operation === "audio" ? "audio" : "video";
    case "infinitalk_lip_sync":
    case "kling_avatar":
    case "omnihuman_video":
      return "lip-sync";
    case "runway_aleph_video":
      return "video-edit";
    case "topaz_upscale_image":
      return "upscale";
    case "ideogram_reframe":
      return "reframe";
    case "recraft_remove_background":
      return "background-removal";
    case "suno_generate_music":
      return "music-generation";
    case "elevenlabs_tts":
      return "text-to-speech";
    case "elevenlabs_ttsfx":
      return "sound-effects";
    default:
      return "generate";
  }
}
function resolveModel(tool, parsed) {
  const catalog = getCatalogEntry(tool);
  if (tool === "nano_banana_image" || tool === "veo3_generate_video")
    return String(parsed.model);
  return catalog?.model ?? tool;
}
function resolveOutputCount(args) {
  for (const key of ["max_images", "num_images", "videoBatchSize", "repeat"]) {
    const value = args[key];
    const count = typeof value === "number" ? value : Number(value);
    if (Number.isInteger(count) && count > 0)
      return count;
  }
  return 1;
}
function toolSchemaDefaults(schema, before, parsed) {
  const defaults = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!(key in before))
      defaults[key] = value;
  }
  return defaults;
}
function prepareGenerationPlan(requestedItems, tools, options = {}) {
  const createdAt = (/* @__PURE__ */ new Date()).toISOString();
  const expiresAt = new Date(Date.now() + (options.expiresInSeconds ?? 15 * 60) * 1e3).toISOString();
  const maxConcurrency = Math.min(4, Math.max(1, options.maxConcurrency ?? 4));
  const defaultProfile = options.defaultProfile ?? "safe";
  const items = requestedItems.map((requested, index) => {
    const tool = tools.get(requested.tool);
    const catalog = getCatalogEntry(requested.tool);
    if (!tool || !catalog)
      throw new Error(`Unsupported generation tool: ${requested.tool}`);
    const profileDefaults = catalog.defaultProfile ? POLICY_DEFAULTS[catalog.defaultProfile] ?? {} : {};
    const isHailuoNonTextMode = requested.tool === "hailuo_video" && (requested.args.imageUrl || hasValues(requested.args.referenceImageUrls) || hasValues(requested.args.referenceVideoUrls) || hasValues(requested.args.referenceAudioUrls));
    const applicableProfileDefaults = isHailuoNonTextMode ? Object.fromEntries(Object.entries(profileDefaults).filter(([key]) => key !== "aspectRatio")) : profileDefaults;
    const policyApplied = Object.fromEntries(Object.entries(applicableProfileDefaults).filter(([key]) => requested.args[key] === void 0));
    const beforeParse = { ...policyApplied, ...requested.args };
    const parsed = tool.schema.parse(beforeParse);
    const appliedDefaults = {
      ...policyApplied,
      ...toolSchemaDefaults(tool.schema, beforeParse, parsed)
    };
    const model = resolveModel(requested.tool, parsed);
    const mode = resolveGenerationMode(requested.tool, parsed);
    const outputCount = resolveOutputCount(parsed);
    const price = priceRequest(requested.tool, { ...parsed, outputCount }, model, mode);
    return {
      index,
      tool: requested.tool,
      model,
      mode,
      outputCount,
      userSettings: requested.args,
      appliedDefaults,
      effectiveSettings: parsed,
      price
    };
  });
  const exact = items.every((item) => item.price.status === "exact");
  const totalCredits = exact ? items.reduce((sum, item) => sum + (item.price.credits ?? 0), 0) : void 0;
  const payload = {
    createdAt,
    expiresAt,
    defaultProfile,
    maxConcurrency,
    items,
    total: exact ? { credits: totalCredits, status: "exact" } : { status: "unknown" }
  };
  return {
    id: randomUUID(),
    ...payload,
    requestHash: hashPlanPayload(payload)
  };
}

// ../core/dist/tools/prepare_media_generation.js
function pendingResult(plan, reason) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          success: true,
          planId: plan.id,
          plan,
          status: "prepared",
          approved: false,
          reason,
          message: "No provider task was created. This plan remains unapproved and cannot be submitted."
        }, null, 2)
      }
    ],
    structuredContent: {
      plan_id: plan.id,
      status: "prepared",
      approved: false
    }
  };
}
function approvalRequiredResult(plan) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          success: true,
          planId: plan.id,
          status: "prepared",
          approved: false,
          input_required: true,
          message: "Host approval required. The MCP host will present the approval form."
        }, null, 2)
      }
    ],
    structuredContent: {
      plan_id: plan.id,
      status: "prepared",
      approved: false,
      input_required: true
    },
    _meta: { "kie/approval-plan": plan }
  };
}
var prepareMediaGenerationTool = {
  name: "prepare_media_generation",
  description: "Prepare one to six validated media generations, resolve safe defaults and pricing, persist a caller-context-bound plan, then request host approval when the transport supports it without calling a provider.",
  category: "utility",
  schema: PrepareMediaGenerationSchema,
  async run(args, ctx) {
    try {
      const request = PrepareMediaGenerationSchema.parse(args);
      const tools = new Map(request.items.map((item) => [item.tool, ctx.getTool(item.tool)]).filter((entry) => entry[1] !== void 0));
      const plan = prepareGenerationPlan(request.items, tools, {
        defaultProfile: request.defaultProfile,
        maxConcurrency: request.maxConcurrency,
        expiresInSeconds: request.expiresInSeconds
      });
      await ctx.db.createGenerationPlan(plan, ctx.approvalContext);
      if (!ctx.requestPlanApproval) {
        return pendingResult(plan, "This transport cannot request approval during preparation. Use its explicit approval boundary before submission.");
      }
      let decision;
      try {
        decision = await ctx.requestPlanApproval(plan);
      } catch (error) {
        return pendingResult(plan, `Approval elicitation failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (decision.inputRequired) {
        return approvalRequiredResult(plan);
      }
      if (!decision.approved) {
        return pendingResult(plan, decision.reason);
      }
      if (!await ctx.db.approveGenerationPlan(plan.id, plan.requestHash, ctx.approvalContext)) {
        return pendingResult(plan, "Approval could not be recorded because the plan expired, changed, or was no longer prepared.");
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              planId: plan.id,
              plan,
              status: "approved",
              approved: true,
              message: "No provider task was created. Host approval was recorded; submit this planId before it expires."
            }, null, 2)
          }
        ],
        structuredContent: {
          plan_id: plan.id,
          status: "approved",
          approved: true
        }
      };
    } catch (error) {
      return ctx.formatError("prepare_media_generation", error, {
        items: "Required: one to six objects with a registered generation tool and its args object",
        maxConcurrency: "Optional: concurrent task creates from 1 to 4",
        expiresInSeconds: "Optional: plan lifetime from 60 to 3600 seconds"
      });
    }
  }
};

// ../core/dist/tools/qwen_image.js
import { z as z17 } from "zod";
var qwenImageTool = {
  name: "qwen_image",
  description: "Generate and edit images using Qwen models (unified tool for both text-to-image and image editing)",
  category: "image",
  schema: QwenImageSchema,
  async run(args, ctx) {
    try {
      const request = QwenImageSchema.parse(args);
      request.callBackUrl = ctx.getCallbackUrl(request.callBackUrl);
      const response = await ctx.client.generateQwenImage(request);
      if (response.code === 200 && response.data?.taskId) {
        const isEdit = !!request.image_url;
        const mode = isEdit ? "Image Editing" : "Text-to-Image";
        await ctx.db.createTask({
          task_id: response.data.taskId,
          api_type: "qwen-image",
          status: "pending"
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                task_id: response.data.taskId,
                message: `Qwen ${mode} task created successfully`,
                parameters: {
                  mode,
                  prompt: request.prompt.substring(0, 100) + (request.prompt.length > 100 ? "..." : ""),
                  image_size: request.image_size || "square_hd",
                  num_inference_steps: request.num_inference_steps || (isEdit ? 25 : 30),
                  guidance_scale: request.guidance_scale || (isEdit ? 4 : 2.5),
                  enable_safety_checker: request.enable_safety_checker !== false,
                  output_format: request.output_format || "png",
                  negative_prompt: request.negative_prompt || (isEdit ? "blurry, ugly" : " "),
                  acceleration: request.acceleration || "none",
                  seed: request.seed,
                  ...isEdit && {
                    image_url: request.image_url,
                    num_images: request.num_images,
                    sync_mode: request.sync_mode
                  }
                },
                next_steps: [
                  `Use get_task_status with task_id: ${response.data.taskId} to check progress`,
                  'Generated images will be available when status is "completed"'
                ],
                usage_examples: [
                  `get_task_status: {"task_id": "${response.data.taskId}"}`,
                  `list_tasks: {"limit": 10}`
                ]
              }, null, 2)
            }
          ]
        };
      } else {
        throw new Error(response.msg || "Failed to create Qwen image task");
      }
    } catch (error) {
      if (error instanceof z17.ZodError) {
        return ctx.formatError("qwen_image", error, {
          prompt: "Required: Text prompt for image generation or editing",
          image_url: "Optional: URL of image to edit (required for edit mode)",
          image_size: "Optional: Image size (square, square_hd, portrait_4_3, portrait_16_9, landscape_4_3, landscape_16_9)",
          num_inference_steps: "Optional: Number of inference steps (2-250 for text-to-image, 2-49 for edit)",
          guidance_scale: "Optional: CFG scale (0-20, default: 2.5 for text-to-image, 4 for edit)",
          enable_safety_checker: "Optional: Enable safety checker (default: true)",
          output_format: "Optional: Output format (png/jpeg, default: png)",
          negative_prompt: "Optional: Negative prompt (max 500 chars)",
          acceleration: "Optional: Acceleration level (none/regular/high, default: none)",
          num_images: "Optional: Number of images (1-4, edit mode only)",
          sync_mode: "Optional: Sync mode (edit mode only)",
          seed: "Optional: Random seed for reproducible results",
          callBackUrl: "Optional: URL for task completion notifications (uses KIE_AI_CALLBACK_URL env var if not provided)"
        });
      }
      return ctx.formatError("qwen_image", error, {
        prompt: "Required: Text prompt for image generation or editing",
        image_url: "Optional: URL of image to edit (required for edit mode)",
        image_size: "Optional: Image size (square, square_hd, portrait_4_3, portrait_16_9, landscape_4_3, landscape_16_9)",
        num_inference_steps: "Optional: Number of inference steps (2-250 for text-to-image, 2-49 for edit)",
        guidance_scale: "Optional: CFG scale (0-20, default: 2.5 for text-to-image, 4 for edit)",
        enable_safety_checker: "Optional: Enable safety checker (default: true)",
        output_format: "Optional: Output format (png/jpeg, default: png)",
        negative_prompt: "Optional: Negative prompt (max 500 chars)",
        acceleration: "Optional: Acceleration level (none/regular/high, default: none)",
        num_images: "Optional: Number of images (1-4, edit mode only)",
        sync_mode: "Optional: Sync mode (edit mode only)",
        seed: "Optional: Random seed for reproducible results",
        callBackUrl: "Optional: URL for task completion notifications (uses KIE_AI_CALLBACK_URL env var if not provided)"
      });
    }
  }
};

// ../core/dist/tools/recraft_remove_background.js
import { z as z18 } from "zod";
var recraftRemoveBackgroundTool = {
  name: "recraft_remove_background",
  description: "Remove backgrounds from images using Recraft AI background removal model",
  category: "image",
  schema: RecraftRemoveBackgroundSchema,
  async run(args, ctx) {
    try {
      const request = RecraftRemoveBackgroundSchema.parse(args);
      request.callBackUrl = ctx.getCallbackUrl(request.callBackUrl);
      const response = await ctx.client.generateRecraftRemoveBackground(request);
      if (response.code === 200 && response.data?.taskId) {
        await ctx.db.createTask({
          task_id: response.data.taskId,
          api_type: "recraft-remove-background",
          status: "pending"
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                task_id: response.data.taskId,
                message: "Recraft Remove Background task created successfully",
                parameters: {
                  image: request.image,
                  callBackUrl: request.callBackUrl
                },
                next_steps: [
                  "Use get_task_status to check generation progress",
                  "Task completion will be sent to the provided callback URL",
                  "Background removal typically takes 30-60 seconds depending on image complexity"
                ]
              }, null, 2)
            }
          ]
        };
      } else {
        throw new Error(response.msg || "Failed to create Recraft Remove Background task");
      }
    } catch (error) {
      if (error instanceof z18.ZodError) {
        return ctx.formatError("recraft_remove_background", error, {
          image: "Required: URL of image to remove background from (PNG, JPG, WEBP, max 5MB, 16MP, 4096px max, 256px min)",
          callBackUrl: "Optional: URL for task completion notifications (uses KIE_AI_CALLBACK_URL env var if not provided)"
        });
      }
      return ctx.formatError("recraft_remove_background", error, {
        image: "Required: URL of image to remove background from",
        callBackUrl: "Optional: URL for task completion notifications"
      });
    }
  }
};

// ../core/dist/tools/runway_aleph_video.js
import { z as z19 } from "zod";
var runwayAlephVideoTool = {
  name: "runway_aleph_video",
  description: "Transform videos using Runway Aleph video-to-video generation with AI-powered editing",
  category: "video",
  schema: RunwayAlephVideoSchema,
  async run(args, ctx) {
    try {
      const request = RunwayAlephVideoSchema.parse(args);
      request.callBackUrl = ctx.getCallbackUrl(request.callBackUrl);
      const response = await ctx.client.generateRunwayAlephVideo(request);
      if (response.code === 200 && response.data?.taskId) {
        await ctx.db.createTask({
          task_id: response.data.taskId,
          api_type: "runway-aleph-video",
          status: "pending"
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                task_id: response.data.taskId,
                message: "Runway Aleph video-to-video transformation task created successfully",
                parameters: {
                  prompt: request.prompt.substring(0, 100) + (request.prompt.length > 100 ? "..." : ""),
                  video_url: request.videoUrl,
                  aspect_ratio: request.aspectRatio || "16:9",
                  water_mark: request.waterMark || "",
                  upload_cn: request.uploadCn || false,
                  ...request.seed !== void 0 && { seed: request.seed },
                  ...request.referenceImage && {
                    reference_image: request.referenceImage
                  }
                },
                next_steps: [
                  "Use get_task_status to check transformation progress",
                  "Task completion will be sent to the provided callback URL",
                  "Video-to-video transformation typically takes 3-8 minutes depending on complexity and length"
                ]
              }, null, 2)
            }
          ]
        };
      } else {
        throw new Error(response.msg || "Failed to create Runway Aleph video transformation task");
      }
    } catch (error) {
      if (error instanceof z19.ZodError) {
        return ctx.formatError("runway_aleph_video", error, {
          prompt: "Required: Text prompt describing desired video transformation (max 1000 characters)",
          videoUrl: "Required: URL of the input video to transform",
          waterMark: "Optional: Watermark text to add to the video (max 100 characters)",
          uploadCn: "Optional: Whether to upload to China servers (default: false)",
          aspectRatio: "Optional: Output video aspect ratio (default: 16:9)",
          seed: "Optional: Random seed for reproducible results (1-999999)",
          referenceImage: "Optional: URL of reference image for style guidance",
          callBackUrl: "Optional: URL for task completion notifications (uses KIE_AI_CALLBACK_URL env var if not provided)"
        });
      }
      return ctx.formatError("runway_aleph_video", error, {
        prompt: "Required: Text prompt for video transformation",
        videoUrl: "Required: URL of input video",
        aspectRatio: "Optional: Output video aspect ratio",
        callBackUrl: "Optional: URL for task completion notifications"
      });
    }
  }
};

// ../core/dist/tools/submit_media_generation.js
function parseToolResult(result) {
  const text = result.content[0]?.text ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
function extractTaskId(result) {
  if (!result || typeof result !== "object")
    return void 0;
  const data = result;
  if (typeof data.task_id === "string")
    return data.task_id;
  return typeof data.response?.data?.taskId === "string" ? data.response.data.taskId : void 0;
}
function resultError(envelope, result) {
  if (envelope.isError)
    return "Target tool returned an error envelope.";
  if (!result || typeof result !== "object")
    return void 0;
  const payload = result;
  if (payload.success !== false)
    return void 0;
  return typeof payload.error === "string" ? payload.error : "Target tool reported failure.";
}
async function withConcurrency(items, limit, run) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const index = next++;
      if (index >= items.length)
        return;
      results[index] = await run(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
var submitMediaGenerationTool = {
  name: "submit_media_generation",
  description: "Submit a single unexpired, unchanged plan approved in this caller context exactly once. The persisted approval state is the authorization boundary; the plan hash detects accidental mutation only. The stored plan controls a maximum of four concurrent task creates.",
  category: "utility",
  schema: SubmitMediaGenerationSchema,
  async run(args, ctx) {
    try {
      const { planId } = SubmitMediaGenerationSchema.parse(args);
      const stored = await ctx.db.getGenerationPlan(planId);
      if (!stored)
        throw new Error("Prepared plan not found.");
      const { plan } = stored;
      const computedHash = hashPlanPayload({
        createdAt: plan.createdAt,
        expiresAt: plan.expiresAt,
        defaultProfile: plan.defaultProfile,
        maxConcurrency: plan.maxConcurrency,
        items: plan.items,
        total: plan.total
      });
      if (plan.id !== planId || plan.requestHash !== stored.requestHash || computedHash !== stored.requestHash) {
        throw new Error("Prepared plan integrity check failed.");
      }
      if (new Date(plan.expiresAt).getTime() <= Date.now())
        throw new Error("Prepared plan has expired.");
      if (stored.status !== "approved") {
        throw new Error("Plan is not approved, has already been submitted, or is being submitted.");
      }
      const unavailableTools = [
        ...new Set(plan.items.map((item) => item.tool))
      ].filter((name) => !ctx.getTool(name));
      if (unavailableTools.length > 0) {
        throw new Error(`Prepared plan contains unavailable tool(s): ${unavailableTools.join(", ")}.`);
      }
      if (!await ctx.db.claimGenerationPlan(planId, stored.requestHash, ctx.approvalContext)) {
        throw new Error("Approved plan is unavailable in this approval context, expired, changed, or already submitted.");
      }
      const results = await withConcurrency(plan.items, plan.maxConcurrency, async (item) => {
        const target = ctx.getTool(item.tool);
        if (!target) {
          throw new Error(`Prepared plan contains unavailable tool: ${item.tool}.`);
        }
        try {
          const envelope = await target.run(item.effectiveSettings, ctx);
          const result = parseToolResult(envelope);
          const error = resultError(envelope, result);
          return {
            index: item.index,
            tool: item.tool,
            taskId: extractTaskId(result),
            result,
            ...error ? { error } : {}
          };
        } catch (error) {
          return {
            index: item.index,
            tool: item.tool,
            result: null,
            error: error instanceof Error ? error.message : String(error)
          };
        }
      });
      if (results.some((result) => result.error)) {
        await ctx.db.failGenerationPlan(planId, results);
        throw new Error("One or more plan items failed.");
      }
      await ctx.db.finishGenerationPlan(planId, results);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              planId,
              requestHash: stored.requestHash,
              results
            }, null, 2)
          }
        ],
        structuredContent: {
          plan_id: planId,
          request_hash: stored.requestHash,
          results
        }
      };
    } catch (error) {
      return ctx.formatError("submit_media_generation", error, {
        planId: "Required: an unexpired, approved plan ID returned by prepare_media_generation"
      });
    }
  }
};

// ../core/dist/tools/suno_generate_music.js
var sunoGenerateMusicTool = {
  name: "suno_generate_music",
  description: "Generate music with AI using Suno models (V3_5, V4, V4_5, V4_5PLUS, V5, V5_5). V5_5 supports requested duration.",
  category: "audio",
  schema: SunoGenerateSchema,
  async run(args, ctx) {
    try {
      const request = SunoGenerateSchema.parse(args);
      request.callBackUrl = ctx.getCallbackUrl(request.callBackUrl);
      const response = await ctx.client.generateSunoMusic(request);
      if (response.code === 200 && response.data?.taskId) {
        await ctx.db.createTask({
          task_id: response.data.taskId,
          api_type: "suno",
          status: "pending"
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                task_id: response.data.taskId,
                message: "Music generation task created successfully",
                parameters: {
                  model: request.model || "V5",
                  customMode: request.customMode,
                  instrumental: request.instrumental,
                  callBackUrl: request.callBackUrl
                },
                next_steps: [
                  "Use get_task_status to check generation progress",
                  "Task completion will be sent to the provided callback URL",
                  "Generation typically takes 1-3 minutes depending on model and length"
                ]
              }, null, 2)
            }
          ]
        };
      } else {
        throw new Error(response.msg || "Failed to create music generation task");
      }
    } catch (error) {
      return ctx.formatError("suno_generate_music", error, {
        prompt: "Required: Description of desired audio content",
        customMode: "Required: Enable advanced customization (true/false)",
        instrumental: "Required: Generate instrumental music (true/false)",
        model: "Required: AI model version (V3_5, V4, V4_5, V4_5PLUS, V5, V5_5)",
        duration: "Optional: Track duration in seconds (V5_5 only)",
        callBackUrl: "Optional: URL for task completion notifications (uses KIE_AI_CALLBACK_URL env var if not provided)",
        style: "Optional: Music style/genre (required in custom mode)",
        title: "Optional: Track title (required in custom mode, max 80 chars)",
        negativeTags: "Optional: Styles to exclude (max 200 chars)",
        vocalGender: "Optional: Vocal gender preference (m/f, custom mode only)",
        styleWeight: "Optional: Style adherence strength (0-1, 2 decimal places)",
        weirdnessConstraint: "Optional: Creative deviation control (0-1, 2 decimal places)",
        audioWeight: "Optional: Audio feature balance (0-1, 2 decimal places)"
      });
    }
  }
};

// ../core/dist/tools/topaz_upscale_image.js
import { z as z20 } from "zod";
var topazUpscaleImageTool = {
  name: "topaz_upscale_image",
  description: "Upscale and enhance images using Topaz Labs AI upscaler. Increases resolution with high-fidelity detail restoration, natural texture reconstruction, and improved clarity. Supports 1x-8x upscaling (max output 20,000px per side). Pricing: 10 credits (\u22642K), 20 credits (4K), 40 credits (8K).",
  category: "image",
  schema: TopazUpscaleImageSchema,
  async run(args, ctx) {
    try {
      const request = TopazUpscaleImageSchema.parse(args);
      request.callBackUrl = ctx.getCallbackUrl(request.callBackUrl);
      const response = await ctx.client.generateTopazUpscaleImage(request);
      if (response.code === 200 && response.data?.taskId) {
        await ctx.db.createTask({
          task_id: response.data.taskId,
          api_type: "topaz-upscale",
          status: "pending"
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                task_id: response.data.taskId,
                message: "Topaz Image Upscale task created successfully",
                parameters: {
                  image_url: request.image_url,
                  upscale_factor: request.upscale_factor,
                  callBackUrl: request.callBackUrl
                },
                next_steps: [
                  "Use get_task_status to check generation progress",
                  "Task completion will be sent to the provided callback URL",
                  "Upscaling typically takes 30-90 seconds depending on image size and upscale factor"
                ]
              }, null, 2)
            }
          ]
        };
      } else {
        throw new Error(response.msg || "Failed to create Topaz Image Upscale task");
      }
    } catch (error) {
      if (error instanceof z20.ZodError) {
        return ctx.formatError("topaz_upscale_image", error, {
          image_url: "Required: URL of image to upscale (JPEG, PNG, WEBP, max 10MB)",
          upscale_factor: 'Optional: Upscale factor "1", "2" (default), "4", or "8". Max output dimension is 20,000px.',
          callBackUrl: "Optional: URL for task completion notifications (uses KIE_AI_CALLBACK_URL env var if not provided)"
        });
      }
      return ctx.formatError("topaz_upscale_image", error, {
        image_url: "Required: URL of image to upscale",
        upscale_factor: 'Optional: Upscale factor "1", "2", "4", or "8"',
        callBackUrl: "Optional: URL for task completion notifications"
      });
    }
  }
};

// ../core/dist/tools/upload_file.js
var MAX_DECODED_BYTES = 10 * 1024 * 1024;
function decodeBase64(value, declaredType) {
  const match = value.match(/^data:([^;,]+);base64,(.*)$/s);
  const contentType = match?.[1] ?? declaredType;
  const encoded = (match?.[2] ?? value).replace(/\s+/g, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error("file_base64 is not valid Base64.");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length > MAX_DECODED_BYTES) {
    throw new Error("file_base64 exceeds the 10 MiB decoded limit.");
  }
  const detectedType = validateUploadBytes(bytes, contentType);
  return {
    bytes,
    providerValue: `data:${detectedType};base64,${encoded}`,
    contentType: detectedType
  };
}
var uploadFileTool = {
  name: "upload_file",
  description: "Upload validated media directly to Kie.ai from Base64 or a CLI-approved local file path. Arbitrary URL imports are intentionally unsupported to avoid delegated SSRF.",
  category: "utility",
  schema: UploadFileSchema,
  async run(args, ctx) {
    try {
      const request = UploadFileSchema.parse(args);
      const response = request.file_path ? await (async () => {
        if (!ctx.readLocalUpload) {
          throw new Error("file_path is available only to the CLI when KIE_CLI_UPLOAD_ROOTS is configured.");
        }
        const file = await ctx.readLocalUpload(request.file_path, 25 * 1024 * 1024);
        const contentType = validateUploadBytes(file.bytes, file.contentType);
        return ctx.client.uploadFile({
          bytes: file.bytes,
          filename: request.file_name ?? file.filename,
          contentType
        }, uploadPathForMimeType(contentType));
      })() : await (async () => {
        const decoded = decodeBase64(request.file_base64, request.content_type);
        return ctx.client.uploadBase64({
          base64Data: decoded.providerValue,
          uploadPath: uploadPathForMimeType(decoded.contentType),
          ...request.file_name ? { fileName: request.file_name } : {}
        });
      })();
      const downloadUrl = response.data?.downloadUrl ?? response.data?.fileUrl;
      if (response.code !== 200 && response.code !== 0 || !downloadUrl) {
        throw new Error(response.msg || "Kie.ai did not return a downloadUrl.");
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              download_url: downloadUrl,
              file_name: response.data?.fileName,
              file_size: response.data?.fileSize,
              mime_type: response.data?.mimeType,
              retention: "Temporary provider URL. Consume promptly; official Kie documentation is inconsistent between 24 hours and 3 days."
            }, null, 2)
          }
        ]
      };
    } catch (error) {
      return ctx.formatError("upload_file", error, {
        file_base64: "Base64 media or data URL, maximum 10 MiB decoded",
        file_path: "CLI-only local file under KIE_CLI_UPLOAD_ROOTS, maximum 25 MiB",
        file_name: "Optional filename without path separators",
        content_type: "Required for raw Base64 when MIME cannot be inferred inline"
      });
    }
  }
};

// ../core/dist/tools/upload_widget.js
var UPLOAD_WIDGET_URI = "ui://kie/upload.html";
var uploadWidgetTool = {
  name: "upload_widget",
  description: "Open a secure file picker for uploading local media. MCP Apps hosts render the inline widget; other clients receive instructions for upload_file.",
  category: "utility",
  schema: UploadWidgetSchema,
  ui: {
    resourceUri: UPLOAD_WIDGET_URI,
    visibility: ["model"]
  },
  async run(args, ctx) {
    try {
      UploadWidgetSchema.parse(args);
      const grant = ctx.createWidgetGrant?.();
      const available = Boolean(ctx.createUploadCapability && grant);
      const result = {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: available,
              widget: UPLOAD_WIDGET_URI,
              message: available ? "Use the rendered upload widget. Capabilities remain outside model-visible content; finalized Kie media is added to context." : "This adapter has no configured temporary HTTP storage. Use upload_file with file_base64 or a CLI-approved file_path."
            }, null, 2)
          }
        ]
      };
      result._meta = grant ? { upload: { app_grant: grant } } : void 0;
      return result;
    } catch (error) {
      return ctx.formatError("upload_widget", error, {});
    }
  }
};

// ../core/dist/tools/veo3_generate_video.js
var veo3GenerateVideoTool = {
  name: "veo3_generate_video",
  description: "Generate professional-quality videos using Google's Veo3 API",
  category: "video",
  schema: Veo3GenerateSchema,
  async run(args, ctx) {
    try {
      const request = Veo3GenerateSchema.parse(args);
      request.callBackUrl = ctx.getCallbackUrl(request.callBackUrl);
      const response = await ctx.client.generateVeo3Video(request);
      if (response.code === 200 && response.data?.taskId) {
        await ctx.db.createTask({
          task_id: response.data.taskId,
          api_type: "veo3",
          status: "pending"
        });
      } else {
        throw new Error(response.msg || "Failed to create Veo3 video task");
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              task_id: response.data?.taskId,
              message: "Veo3 video generation task created successfully",
              note: "Use get_task_status to check progress"
            }, null, 2)
          }
        ]
      };
    } catch (error) {
      return ctx.formatError("veo3_generate_video", error, {
        prompt: "Required: video description (max 2000 chars)",
        imageUrls: "Optional: 1-2 image URLs for image-to-video (1 image = unfold around it, 2 images = start to end frame transition)",
        model: 'Optional: "veo3" (quality) or "veo3_fast" (cost-efficient)',
        watermark: "Optional: watermark text (max 100 chars)",
        aspectRatio: 'Optional: "16:9", "9:16", or "Auto"',
        seeds: "Optional: random seed (10000-99999)",
        callBackUrl: "Optional: callback URL for notifications",
        enableFallback: "Optional: enable fallback for content policy failures",
        enableTranslation: "Optional: auto-translate prompts to English"
      });
    }
  }
};

// ../core/dist/tools/veo3_get_1080p_video.js
var veo3Get1080pVideoTool = {
  name: "veo3_get_1080p_video",
  description: "Get 1080P high-definition version of a Veo3 video (not available for fallback mode videos)",
  category: "video",
  schema: Veo3Get1080pVideoSchema,
  async run(args, ctx) {
    try {
      const { task_id, index } = Veo3Get1080pVideoSchema.parse(args);
      const response = await ctx.client.getVeo1080pVideo(task_id, index);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              task_id,
              response,
              message: "Retrieved 1080p video URL",
              note: "Not available for videos generated with fallback mode"
            }, null, 2)
          }
        ]
      };
    } catch (error) {
      return ctx.formatError("veo3_get_1080p_video", error, {
        task_id: "Required: Veo3 task ID to get 1080p video for",
        index: "Optional: video index (for multiple video results)"
      });
    }
  }
};

// ../core/dist/tools/wait_for_task.js
function resolveResultBase(explicit, ctx) {
  const strip = (u) => u.replace(/\/+$/, "");
  if (explicit)
    return strip(explicit);
  if (process.env.KIE_AI_RESULT_URL)
    return strip(process.env.KIE_AI_RESULT_URL);
  const callback = ctx.getCallbackUrl();
  if (callback.endsWith("/kie/callback")) {
    return callback.slice(0, -"/kie/callback".length) + "/kie/result";
  }
  return null;
}
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function pollOnce(ctx, task_id) {
  try {
    const res = await getTaskStatusTool.run({ task_id }, ctx);
    return JSON.parse(res.content[0].text);
  } catch {
    return null;
  }
}
var waitForTaskTool = {
  name: "wait_for_task",
  description: "Wait for a generation task to complete in a single call, so you don't have to poll get_task_status repeatedly. Pass the task_id returned by any generation tool: it blocks until the result is ready (or the timeout) and returns the final URLs, streaming progress meanwhile. By default it polls the Kie API directly (no setup); if a callback rendezvous is configured (KIE_AI_RESULT_URL, rendezvous_url, or a KIE_AI_CALLBACK_URL ending in /kie/callback) it waits on that instead. Tip for long jobs: clients should enable resetTimeoutOnProgress with a generous maxTotalTimeout.",
  category: "utility",
  schema: WaitForTaskSchema,
  async run(args, ctx) {
    try {
      const { task_id, timeout_seconds = 180, interval_seconds = 5, rendezvous_url } = WaitForTaskSchema.parse(args);
      const base = resolveResultBase(rendezvous_url, ctx);
      const start = Date.now();
      const deadline = start + timeout_seconds * 1e3;
      const totalTicks = Math.max(1, Math.ceil(timeout_seconds / interval_seconds));
      let tick = 0;
      const elapsed = () => Math.round((Date.now() - start) / 1e3);
      if (base) {
        const url3 = `${base}/${encodeURIComponent(task_id)}`;
        while (Date.now() < deadline) {
          tick++;
          try {
            const res = await fetch(url3);
            if (res.status === 200) {
              const data = await res.json();
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      success: true,
                      task_id,
                      status: data.status ?? "completed",
                      elapsed_seconds: elapsed(),
                      result_urls: data.urls ?? [],
                      model: data.model ?? null,
                      message: "Result received from rendezvous"
                    }, null, 2)
                  }
                ]
              };
            }
          } catch {
          }
          await ctx.onProgress?.({
            progress: tick,
            total: totalTicks,
            message: `Waiting on rendezvous\u2026 ${elapsed()}s elapsed`
          });
          await sleep(interval_seconds * 1e3);
        }
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                task_id,
                status: "timed_out",
                error: "timeout",
                elapsed_seconds: elapsed(),
                message: `No result after ${timeout_seconds}s. The task may still be running; retry wait_for_task or check get_task_status.`
              }, null, 2)
            }
          ],
          structuredContent: { task_id, status: "timed_out", error: "timeout" }
        };
      }
      while (Date.now() < deadline) {
        tick++;
        const details = await pollOnce(ctx, task_id);
        const task = await ctx.db.getTask(task_id);
        if (task?.status === "completed") {
          const fromDetails = details?.result_urls;
          const result_urls = fromDetails && fromDetails.length > 0 ? fromDetails : task.result_url ? [task.result_url] : [];
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: true,
                  task_id,
                  status: "completed",
                  elapsed_seconds: elapsed(),
                  result_urls,
                  details,
                  message: "Generation completed"
                }, null, 2)
              }
            ]
          };
        }
        if (task?.status === "failed") {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: false,
                  task_id,
                  status: "failed",
                  elapsed_seconds: elapsed(),
                  error: task.error_message ?? "Generation failed",
                  details,
                  message: "Generation failed"
                }, null, 2)
              }
            ],
            structuredContent: {
              task_id,
              status: "failed",
              error: task.error_message ?? "Generation failed"
            }
          };
        }
        await ctx.onProgress?.({
          progress: tick,
          total: totalTicks,
          message: `Generating\u2026 ${elapsed()}s elapsed (status: ${task?.status ?? "pending"})`
        });
        await sleep(interval_seconds * 1e3);
      }
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: false,
              task_id,
              status: "timed_out",
              error: "timeout",
              elapsed_seconds: elapsed(),
              message: `Still running after ${timeout_seconds}s. Call wait_for_task again with the same task_id, or check get_task_status.`
            }, null, 2)
          }
        ],
        structuredContent: { task_id, status: "timed_out", error: "timeout" }
      };
    } catch (error) {
      return ctx.formatError("wait_for_task", error, {
        task_id: "Required: task ID returned by a generation tool",
        timeout_seconds: "Optional: max seconds to wait (5-600, default: 180)",
        interval_seconds: "Optional: seconds between status checks (1-60, default: 5)",
        rendezvous_url: "Optional: rendezvous result base URL (e.g. https://host/kie/result); omit to poll the Kie API directly"
      });
    }
  }
};

// ../core/dist/tools/wan_animate.js
import { z as z21 } from "zod";
var wanAnimateTool = {
  name: "wan_animate",
  description: "Animate static images or replace characters in videos using Alibaba's Wan 2.2 Animate models with motion transfer and seamless environmental integration",
  category: "video",
  schema: WanAnimateSchema,
  async run(args, ctx) {
    try {
      const request = WanAnimateSchema.parse(args);
      request.callBackUrl = ctx.getCallbackUrl(request.callBackUrl);
      const response = await ctx.client.generateWanAnimate(request);
      const modeDescription = request.mode === "replace" ? "character replacement" : "animation";
      if (response.code === 200 && response.data?.taskId) {
        await ctx.db.createTask({
          task_id: response.data.taskId,
          api_type: "wan-animate",
          status: "pending"
        });
      } else {
        throw new Error(response.msg || "Failed to create Wan Animate task");
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              task_id: response.data?.taskId,
              mode: modeDescription,
              message: `Wan 2.2 Animate task created successfully (${modeDescription} mode)`,
              parameters: {
                video_url: request.video_url,
                image_url: request.image_url,
                mode: request.mode || "animate",
                resolution: request.resolution || "480p",
                callBackUrl: request.callBackUrl
              },
              next_steps: [
                "Use get_task_status to check generation progress",
                "Task completion will be sent to the provided callback URL",
                "Video generation time depends on input video length"
              ]
            }, null, 2)
          }
        ]
      };
    } catch (error) {
      if (error instanceof z21.ZodError) {
        return ctx.formatError("wan_animate", error, {
          video_url: "Required: URL of reference video (MP4, max 10MB, max 30 seconds)",
          image_url: "Required: URL of character image (JPEG/PNG/WEBP, max 10MB)",
          mode: 'Optional: "animate" (default) or "replace"',
          resolution: 'Optional: "480p" (default), "580p", or "720p"',
          callBackUrl: "Optional: callback URL for notifications (uses KIE_AI_CALLBACK_URL env var if not provided)"
        });
      }
      return ctx.formatError("wan_animate", error, {
        video_url: "Required: URL of reference video",
        image_url: "Required: URL of character image",
        mode: "Optional: animate or replace",
        resolution: "Optional: 480p, 580p, or 720p",
        callBackUrl: "Optional: URL for task completion notifications"
      });
    }
  }
};

// ../core/dist/tools/wan_video.js
import { z as z22 } from "zod";
var wanVideoTool = {
  name: "wan_video",
  description: "Generate videos using Alibaba Wan 3.0 with text, first/last frames, images, videos, audio, documents, or webpage references",
  category: "video",
  schema: Wan30VideoSchema,
  async run(args, ctx) {
    try {
      const request = Wan30VideoSchema.parse(args);
      request.callBackUrl = ctx.getCallbackUrl(request.callBackUrl);
      const response = await ctx.client.generateWanVideo(request);
      if (response.code === 200 && response.data?.taskId) {
        const mode = request.reference_file_urls?.length ? "file-to-video" : request.reference_link_urls?.length ? "link-to-video" : request.reference_image_urls?.length || request.reference_video_urls?.length || request.reference_audio_urls?.length ? "reference-to-video" : request.first_frame_url ? "image-to-video" : "text-to-video";
        await ctx.db.createTask({
          task_id: response.data.taskId,
          api_type: "wan-video",
          status: "pending"
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                task_id: response.data.taskId,
                message: `Wan 3.0 ${mode} task created successfully`,
                parameters: {
                  mode,
                  prompt: request.prompt && request.prompt.substring(0, 100) + (request.prompt.length > 100 ? "..." : ""),
                  resolution: request.resolution || "1080P",
                  aspect_ratio: request.aspect_ratio || "adaptive",
                  duration: request.duration || 5
                },
                next_steps: [
                  `Use get_task_status with task_id: ${response.data.taskId} to check progress`,
                  'Video will be available when status is "completed"'
                ]
              }, null, 2)
            }
          ]
        };
      } else {
        throw new Error(response.msg || "Failed to create Wan 3.0 video task");
      }
    } catch (error) {
      if (error instanceof z22.ZodError) {
        return ctx.formatError("wan_video", error, {
          prompt: "Text prompt for generation (max 20000 chars)",
          first_frame_url: "Optional first-frame image URL",
          last_frame_url: "Optional last-frame image URL; requires first_frame_url",
          reference_image_urls: "Up to 10 reference image URLs",
          reference_video_urls: "Up to 5 reference video URLs",
          reference_audio_urls: "Up to 5 reference audio URLs"
        });
      }
      return ctx.formatError("wan_video", error, {
        prompt: "Provide a prompt or supported media reference"
      });
    }
  }
};

// ../core/dist/tools/z_image.js
import { z as z23 } from "zod";
var zImageTool = {
  name: "z_image",
  description: "Generate photorealistic images using Tongyi-MAI Z-Image model. Ultra-fast Turbo performance, accurate bilingual text rendering (Chinese/English), and strong semantic understanding.",
  category: "image",
  schema: ZImageSchema,
  async run(args, ctx) {
    try {
      const request = ZImageSchema.parse(args);
      request.callBackUrl = ctx.getCallbackUrl(request.callBackUrl);
      const response = await ctx.client.generateZImage(request);
      if (response.code === 200 && response.data?.taskId) {
        await ctx.db.createTask({
          task_id: response.data.taskId,
          api_type: "z-image",
          status: "pending"
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                task_id: response.data.taskId,
                message: "Z-Image generation task created successfully",
                parameters: {
                  prompt: request.prompt.substring(0, 100) + (request.prompt.length > 100 ? "..." : ""),
                  aspect_ratio: request.aspect_ratio || "1:1"
                },
                pricing: "unknown: no verified local rate-card formula",
                next_steps: [
                  `Use get_task_status with task_id: ${response.data.taskId} to check progress`,
                  'Generated image will be available when status is "completed"'
                ]
              }, null, 2)
            }
          ]
        };
      } else {
        throw new Error(response.msg || "Failed to create Z-Image task");
      }
    } catch (error) {
      if (error instanceof z23.ZodError) {
        return ctx.formatError("z_image", error, {
          prompt: "Required: Text prompt describing the desired image (max 5000 chars)",
          aspect_ratio: "Optional: Aspect ratio (1:1, 4:3, 3:4, 16:9, 9:16, default: 1:1)",
          callBackUrl: "Optional: URL for task completion notifications"
        });
      }
      return ctx.formatError("z_image", error, {
        prompt: "Required: Text prompt describing the desired image (max 5000 chars)",
        aspect_ratio: "Optional: Aspect ratio (1:1, 4:3, 3:4, 16:9, 9:16, default: 1:1)",
        callBackUrl: "Optional: URL for task completion notifications"
      });
    }
  }
};

// ../core/dist/tools/index.js
var TOOL_REGISTRY = [
  bytedanceSeedanceVideoTool,
  bytedanceSeedreamImageTool,
  elevenlabsTtsTool,
  elevenlabsTtsfxTool,
  flux2ImageTool,
  finalizeUploadTool,
  fluxKontextImageTool,
  getTaskStatusTool,
  getUploadUrlTool,
  geminiOmniTool,
  gptImage2Tool,
  grokImagineTool,
  hailuoVideoTool,
  happyhorseVideoTool,
  ideogramReframeTool,
  infinitalkLipSyncTool,
  klingAvatarTool,
  klingVideoTool,
  listModelsTool,
  listTasksTool,
  midjourneyGenerateTool,
  nanoBananaImageTool,
  omniHumanVideoTool,
  qwenImageTool,
  prepareMediaGenerationTool,
  recraftRemoveBackgroundTool,
  runwayAlephVideoTool,
  sunoGenerateMusicTool,
  submitMediaGenerationTool,
  topazUpscaleImageTool,
  uploadFileTool,
  uploadWidgetTool,
  veo3GenerateVideoTool,
  veo3Get1080pVideoTool,
  waitForTaskTool,
  wanAnimateTool,
  wanVideoTool,
  zImageTool
];
function getTool(name) {
  return TOOL_REGISTRY.find((t) => t.name === name);
}

// ../core/dist/json-schema.js
import { z as z24 } from "zod";
function toInputJsonSchema(schema) {
  const js = z24.toJSONSchema(schema);
  delete js.$schema;
  delete js.additionalProperties;
  const required = Array.isArray(js.required) ? js.required : [];
  const properties = js.properties ?? {};
  const defaulted = required.filter((name) => name in properties && "default" in properties[name]);
  if (defaulted.length > 0) {
    const remaining = required.filter((name) => !defaulted.includes(name));
    if (remaining.length > 0)
      js.required = remaining;
    else
      delete js.required;
  }
  return js;
}

// ../core/dist/docs.js
function typeLabel(p) {
  if (p.enum)
    return p.enum.map((v) => `\`${v}\``).join(" / ");
  if (Array.isArray(p.type))
    return p.type.join(" \\| ");
  return p.type || "any";
}
function toolToMarkdown(tool) {
  const js = toInputJsonSchema(tool.schema);
  const props = js.properties || {};
  const required = new Set(js.required || []);
  const keys = Object.keys(props);
  let md = `# ${tool.name}

`;
  md += `**Category:** ${tool.category}

`;
  md += `${tool.description}

`;
  md += `## Parameters

`;
  if (keys.length === 0) {
    md += "_This tool takes no parameters._\n";
    return md;
  }
  md += "| Parameter | Type | Required | Description |\n";
  md += "| --- | --- | --- | --- |\n";
  for (const k of keys) {
    const p = props[k];
    const desc = (p.description || "").replace(/\n/g, " ").replace(/\|/g, "\\|");
    const def = p.default !== void 0 ? ` (default: \`${JSON.stringify(p.default)}\`)` : "";
    md += `| \`${k}\` | ${typeLabel(p)} | ${required.has(k) ? "yes" : "no"} | ${desc}${def} |
`;
  }
  return md;
}
function categoryPromptText(category, tools) {
  const inCat = tools.filter((t) => t.category === category);
  const verb = category === "image" ? "generate, edit and enhance images" : category === "video" ? "generate and transform videos" : `use the ${category} tools`;
  let md = `You can ${verb} using these Kie.ai tools. Choose the one that fits the request and call it with its parameters.

`;
  md += `Generation is asynchronous: most tools return a task id. Poll progress with \`get_task_status\` and review recent work with \`list_tasks\`.

`;
  for (const t of inCat) {
    const js = toInputJsonSchema(t.schema);
    const required = (js.required || []).map((r) => `\`${r}\``);
    md += `## ${t.name}
${t.description}
`;
    md += required.length ? `Required: ${required.join(", ")}

` : `No required parameters.

`;
  }
  return md;
}

// ../../node_modules/@modelcontextprotocol/core/dist/auth-CUe6YdwF.mjs
import * as z25 from "zod/v4";
var LATEST_PROTOCOL_VERSION = "2025-11-25";
var DEFAULT_NEGOTIATED_PROTOCOL_VERSION = "2025-03-26";
var SUPPORTED_PROTOCOL_VERSIONS = [
  LATEST_PROTOCOL_VERSION,
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07"
];
var RELATED_TASK_META_KEY = "io.modelcontextprotocol/related-task";
var PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
var CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo";
var SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo";
var CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";
var SUBSCRIPTION_ID_META_KEY = "io.modelcontextprotocol/subscriptionId";
var LOG_LEVEL_META_KEY = "io.modelcontextprotocol/logLevel";
var JSONRPC_VERSION = "2.0";
var JSONValueSchema = z25.lazy(() => z25.union([
  z25.string(),
  z25.number(),
  z25.boolean(),
  z25.null(),
  z25.record(z25.string(), JSONValueSchema),
  z25.array(JSONValueSchema)
]));
var JSONObjectSchema = z25.record(z25.string(), JSONValueSchema);
var JSONArraySchema = z25.array(JSONValueSchema);
var ProgressTokenSchema = z25.union([z25.string(), z25.number().int()]);
var CursorSchema = z25.string();
var TaskMetadataSchema = z25.object({ ttl: z25.number().optional() });
var RelatedTaskMetadataSchema = z25.object({ taskId: z25.string() });
var RequestMetaSchema = z25.looseObject({
  progressToken: ProgressTokenSchema.optional(),
  [RELATED_TASK_META_KEY]: RelatedTaskMetadataSchema.optional()
});
var BaseRequestParamsSchema = z25.object({ _meta: RequestMetaSchema.optional() });
var TaskAugmentedRequestParamsSchema = BaseRequestParamsSchema.extend({ task: TaskMetadataSchema.optional() });
var RequestSchema = z25.object({
  method: z25.string(),
  params: BaseRequestParamsSchema.loose().optional()
});
var NotificationsParamsSchema = z25.object({ _meta: RequestMetaSchema.optional() });
var NotificationSchema = z25.object({
  method: z25.string(),
  params: NotificationsParamsSchema.loose().optional()
});
var ResultMetaObjectSchema = z25.looseObject({ get [SERVER_INFO_META_KEY]() {
  return ImplementationSchema.optional().catch(void 0);
} });
var ResultSchema = z25.looseObject({ _meta: ResultMetaObjectSchema.optional() });
var RequestIdSchema = z25.union([z25.string(), z25.number().int()]);
var JSONRPCRequestSchema = z25.object({
  jsonrpc: z25.literal(JSONRPC_VERSION),
  id: RequestIdSchema,
  ...RequestSchema.shape
}).strict();
var JSONRPCNotificationSchema = z25.object({
  jsonrpc: z25.literal(JSONRPC_VERSION),
  ...NotificationSchema.shape
}).strict();
var JSONRPCResultResponseSchema = z25.object({
  jsonrpc: z25.literal(JSONRPC_VERSION),
  id: RequestIdSchema,
  result: ResultSchema
}).strict();
var JSONRPCErrorResponseSchema = z25.object({
  jsonrpc: z25.literal(JSONRPC_VERSION),
  id: RequestIdSchema.optional(),
  error: z25.object({
    code: z25.number().int(),
    message: z25.string(),
    data: z25.unknown().optional()
  })
}).strict();
var JSONRPCMessageSchema = z25.union([
  JSONRPCRequestSchema,
  JSONRPCNotificationSchema,
  JSONRPCResultResponseSchema,
  JSONRPCErrorResponseSchema
]);
var JSONRPCResponseSchema = z25.union([JSONRPCResultResponseSchema, JSONRPCErrorResponseSchema]);
var EmptyResultSchema = ResultSchema.strict();
var CancelledNotificationParamsSchema = NotificationsParamsSchema.extend({
  requestId: RequestIdSchema.optional(),
  reason: z25.string().optional()
});
var CancelledNotificationSchema = NotificationSchema.extend({
  method: z25.literal("notifications/cancelled"),
  params: CancelledNotificationParamsSchema
});
var IconSchema = z25.object({
  src: z25.string(),
  mimeType: z25.string().optional(),
  sizes: z25.array(z25.string()).optional(),
  theme: z25.enum(["light", "dark"]).optional()
});
var IconsSchema = z25.object({ icons: z25.array(IconSchema).optional() });
var BaseMetadataSchema = z25.object({
  name: z25.string(),
  title: z25.string().optional()
});
var ImplementationSchema = BaseMetadataSchema.extend({
  ...BaseMetadataSchema.shape,
  ...IconsSchema.shape,
  version: z25.string(),
  websiteUrl: z25.string().optional(),
  description: z25.string().optional()
});
var FormElicitationCapabilitySchema = z25.intersection(z25.object({ applyDefaults: z25.boolean().optional() }), JSONObjectSchema);
var ElicitationCapabilitySchema = z25.preprocess((value) => {
  if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) return { form: {} };
  return value;
}, z25.intersection(z25.object({
  form: FormElicitationCapabilitySchema.optional(),
  url: JSONObjectSchema.optional()
}), JSONObjectSchema.optional()));
var ClientTasksCapabilitySchema = z25.looseObject({
  list: JSONObjectSchema.optional(),
  cancel: JSONObjectSchema.optional(),
  requests: z25.looseObject({
    sampling: z25.looseObject({ createMessage: JSONObjectSchema.optional() }).optional(),
    elicitation: z25.looseObject({ create: JSONObjectSchema.optional() }).optional()
  }).optional()
});
var ServerTasksCapabilitySchema = z25.looseObject({
  list: JSONObjectSchema.optional(),
  cancel: JSONObjectSchema.optional(),
  requests: z25.looseObject({ tools: z25.looseObject({ call: JSONObjectSchema.optional() }).optional() }).optional()
});
var ClientCapabilitiesSchema = z25.object({
  experimental: z25.record(z25.string(), JSONObjectSchema).optional(),
  sampling: z25.object({
    context: JSONObjectSchema.optional(),
    tools: JSONObjectSchema.optional()
  }).optional(),
  elicitation: ElicitationCapabilitySchema.optional(),
  roots: z25.object({ listChanged: z25.boolean().optional() }).optional(),
  tasks: ClientTasksCapabilitySchema.optional(),
  extensions: z25.record(z25.string(), JSONObjectSchema).optional()
});
var InitializeRequestParamsSchema = BaseRequestParamsSchema.extend({
  protocolVersion: z25.string(),
  capabilities: ClientCapabilitiesSchema,
  clientInfo: ImplementationSchema
});
var InitializeRequestSchema = RequestSchema.extend({
  method: z25.literal("initialize"),
  params: InitializeRequestParamsSchema
});
var ServerCapabilitiesSchema = z25.object({
  experimental: z25.record(z25.string(), JSONObjectSchema).optional(),
  logging: JSONObjectSchema.optional(),
  completions: JSONObjectSchema.optional(),
  prompts: z25.object({ listChanged: z25.boolean().optional() }).optional(),
  resources: z25.object({
    subscribe: z25.boolean().optional(),
    listChanged: z25.boolean().optional()
  }).optional(),
  tools: z25.object({ listChanged: z25.boolean().optional() }).optional(),
  tasks: ServerTasksCapabilitySchema.optional(),
  extensions: z25.record(z25.string(), JSONObjectSchema).optional()
});
var InitializeResultSchema = ResultSchema.extend({
  protocolVersion: z25.string(),
  capabilities: ServerCapabilitiesSchema,
  serverInfo: ImplementationSchema,
  instructions: z25.string().optional()
});
var InitializedNotificationSchema = NotificationSchema.extend({
  method: z25.literal("notifications/initialized"),
  params: NotificationsParamsSchema.optional()
});
var DiscoverRequestSchema = RequestSchema.extend({
  method: z25.literal("server/discover"),
  params: BaseRequestParamsSchema.optional()
});
var DiscoverResultSchema = ResultSchema.extend({
  supportedVersions: z25.array(z25.string()),
  capabilities: ServerCapabilitiesSchema,
  instructions: z25.string().optional()
});
var PingRequestSchema = RequestSchema.extend({
  method: z25.literal("ping"),
  params: BaseRequestParamsSchema.optional()
});
var ProgressSchema = z25.object({
  progress: z25.number(),
  total: z25.optional(z25.number()),
  message: z25.optional(z25.string())
});
var ProgressNotificationParamsSchema = z25.object({
  ...NotificationsParamsSchema.shape,
  ...ProgressSchema.shape,
  progressToken: ProgressTokenSchema
});
var ProgressNotificationSchema = NotificationSchema.extend({
  method: z25.literal("notifications/progress"),
  params: ProgressNotificationParamsSchema
});
var PaginatedRequestParamsSchema = BaseRequestParamsSchema.extend({ cursor: CursorSchema.optional() });
var PaginatedRequestSchema = RequestSchema.extend({ params: PaginatedRequestParamsSchema.optional() });
var PaginatedResultSchema = ResultSchema.extend({ nextCursor: CursorSchema.optional() });
var ResourceContentsSchema = z25.object({
  uri: z25.string(),
  mimeType: z25.optional(z25.string()),
  _meta: z25.record(z25.string(), z25.unknown()).optional()
});
var TextResourceContentsSchema = ResourceContentsSchema.extend({ text: z25.string() });
var Base64Schema = z25.string().refine((val) => {
  try {
    atob(val);
    return true;
  } catch {
    return false;
  }
}, { message: "Invalid Base64 string" });
var BlobResourceContentsSchema = ResourceContentsSchema.extend({ blob: Base64Schema });
var RoleSchema = z25.enum(["user", "assistant"]);
var AnnotationsSchema = z25.object({
  audience: z25.array(RoleSchema).optional(),
  priority: z25.number().min(0).max(1).optional(),
  lastModified: z25.iso.datetime({ offset: true }).optional()
});
var ResourceSchema = z25.object({
  ...BaseMetadataSchema.shape,
  ...IconsSchema.shape,
  uri: z25.string(),
  description: z25.optional(z25.string()),
  mimeType: z25.optional(z25.string()),
  size: z25.optional(z25.number()),
  annotations: AnnotationsSchema.optional(),
  _meta: z25.optional(z25.looseObject({}))
});
var ResourceTemplateSchema = z25.object({
  ...BaseMetadataSchema.shape,
  ...IconsSchema.shape,
  uriTemplate: z25.string(),
  description: z25.optional(z25.string()),
  mimeType: z25.optional(z25.string()),
  annotations: AnnotationsSchema.optional(),
  _meta: z25.optional(z25.looseObject({}))
});
var ListResourcesRequestSchema = PaginatedRequestSchema.extend({ method: z25.literal("resources/list") });
var ListResourcesResultSchema = PaginatedResultSchema.extend({ resources: z25.array(ResourceSchema) });
var ListResourceTemplatesRequestSchema = PaginatedRequestSchema.extend({ method: z25.literal("resources/templates/list") });
var ListResourceTemplatesResultSchema = PaginatedResultSchema.extend({ resourceTemplates: z25.array(ResourceTemplateSchema) });
var ResourceRequestParamsSchema = BaseRequestParamsSchema.extend({ uri: z25.string() });
var ReadResourceRequestParamsSchema = ResourceRequestParamsSchema;
var ReadResourceRequestSchema = RequestSchema.extend({
  method: z25.literal("resources/read"),
  params: ReadResourceRequestParamsSchema
});
var ReadResourceResultSchema = ResultSchema.extend({ contents: z25.array(z25.union([TextResourceContentsSchema, BlobResourceContentsSchema])) });
var ResourceListChangedNotificationSchema = NotificationSchema.extend({
  method: z25.literal("notifications/resources/list_changed"),
  params: NotificationsParamsSchema.optional()
});
var SubscribeRequestParamsSchema = ResourceRequestParamsSchema;
var SubscribeRequestSchema = RequestSchema.extend({
  method: z25.literal("resources/subscribe"),
  params: SubscribeRequestParamsSchema
});
var UnsubscribeRequestParamsSchema = ResourceRequestParamsSchema;
var UnsubscribeRequestSchema = RequestSchema.extend({
  method: z25.literal("resources/unsubscribe"),
  params: UnsubscribeRequestParamsSchema
});
var SubscriptionFilterSchema = z25.object({
  toolsListChanged: z25.boolean().optional(),
  promptsListChanged: z25.boolean().optional(),
  resourcesListChanged: z25.boolean().optional(),
  resourceSubscriptions: z25.array(z25.string()).optional()
});
var SubscriptionsListenRequestParamsSchema = BaseRequestParamsSchema.extend({ notifications: SubscriptionFilterSchema });
var SubscriptionsListenRequestSchema = RequestSchema.extend({
  method: z25.literal("subscriptions/listen"),
  params: SubscriptionsListenRequestParamsSchema
});
var SubscriptionsAcknowledgedNotificationParamsSchema = NotificationsParamsSchema.extend({ notifications: SubscriptionFilterSchema });
var SubscriptionsAcknowledgedNotificationSchema = NotificationSchema.extend({
  method: z25.literal("notifications/subscriptions/acknowledged"),
  params: SubscriptionsAcknowledgedNotificationParamsSchema
});
var SubscriptionsListenResultMetaSchema = ResultMetaObjectSchema.extend({ [SUBSCRIPTION_ID_META_KEY]: RequestIdSchema });
var SubscriptionsListenResultSchema = ResultSchema.extend({ _meta: SubscriptionsListenResultMetaSchema });
var ResourceUpdatedNotificationParamsSchema = NotificationsParamsSchema.extend({ uri: z25.string() });
var ResourceUpdatedNotificationSchema = NotificationSchema.extend({
  method: z25.literal("notifications/resources/updated"),
  params: ResourceUpdatedNotificationParamsSchema
});
var PromptArgumentSchema = z25.object({
  name: z25.string(),
  description: z25.optional(z25.string()),
  required: z25.optional(z25.boolean())
});
var PromptSchema = z25.object({
  ...BaseMetadataSchema.shape,
  ...IconsSchema.shape,
  description: z25.optional(z25.string()),
  arguments: z25.optional(z25.array(PromptArgumentSchema)),
  _meta: z25.optional(z25.looseObject({}))
});
var ListPromptsRequestSchema = PaginatedRequestSchema.extend({ method: z25.literal("prompts/list") });
var ListPromptsResultSchema = PaginatedResultSchema.extend({ prompts: z25.array(PromptSchema) });
var GetPromptRequestParamsSchema = BaseRequestParamsSchema.extend({
  name: z25.string(),
  arguments: z25.record(z25.string(), z25.string()).optional()
});
var GetPromptRequestSchema = RequestSchema.extend({
  method: z25.literal("prompts/get"),
  params: GetPromptRequestParamsSchema
});
var TextContentSchema = z25.object({
  type: z25.literal("text"),
  text: z25.string(),
  annotations: AnnotationsSchema.optional(),
  _meta: z25.record(z25.string(), z25.unknown()).optional()
});
var ImageContentSchema = z25.object({
  type: z25.literal("image"),
  data: Base64Schema,
  mimeType: z25.string(),
  annotations: AnnotationsSchema.optional(),
  _meta: z25.record(z25.string(), z25.unknown()).optional()
});
var AudioContentSchema = z25.object({
  type: z25.literal("audio"),
  data: Base64Schema,
  mimeType: z25.string(),
  annotations: AnnotationsSchema.optional(),
  _meta: z25.record(z25.string(), z25.unknown()).optional()
});
var ToolUseContentSchema = z25.object({
  type: z25.literal("tool_use"),
  name: z25.string(),
  id: z25.string(),
  input: z25.record(z25.string(), z25.unknown()),
  _meta: z25.record(z25.string(), z25.unknown()).optional()
});
var EmbeddedResourceSchema = z25.object({
  type: z25.literal("resource"),
  resource: z25.union([TextResourceContentsSchema, BlobResourceContentsSchema]),
  annotations: AnnotationsSchema.optional(),
  _meta: z25.record(z25.string(), z25.unknown()).optional()
});
var ResourceLinkSchema = ResourceSchema.extend({ type: z25.literal("resource_link") });
var ContentBlockSchema = z25.union([
  TextContentSchema,
  ImageContentSchema,
  AudioContentSchema,
  ResourceLinkSchema,
  EmbeddedResourceSchema
]);
var PromptMessageSchema = z25.object({
  role: RoleSchema,
  content: ContentBlockSchema
});
var GetPromptResultSchema = ResultSchema.extend({
  description: z25.string().optional(),
  messages: z25.array(PromptMessageSchema)
});
var PromptListChangedNotificationSchema = NotificationSchema.extend({
  method: z25.literal("notifications/prompts/list_changed"),
  params: NotificationsParamsSchema.optional()
});
var ToolAnnotationsSchema = z25.object({
  title: z25.string().optional(),
  readOnlyHint: z25.boolean().optional(),
  destructiveHint: z25.boolean().optional(),
  idempotentHint: z25.boolean().optional(),
  openWorldHint: z25.boolean().optional()
});
var ToolExecutionSchema = z25.object({ taskSupport: z25.enum([
  "required",
  "optional",
  "forbidden"
]).optional() });
var ToolSchema = z25.object({
  ...BaseMetadataSchema.shape,
  ...IconsSchema.shape,
  description: z25.string().optional(),
  inputSchema: z25.object({
    type: z25.literal("object"),
    properties: z25.record(z25.string(), JSONValueSchema).optional(),
    required: z25.array(z25.string()).optional()
  }).catchall(z25.unknown()),
  outputSchema: z25.looseObject({ $schema: z25.string().optional() }).optional(),
  annotations: ToolAnnotationsSchema.optional(),
  execution: ToolExecutionSchema.optional(),
  _meta: z25.record(z25.string(), z25.unknown()).optional()
});
var ListToolsRequestSchema = PaginatedRequestSchema.extend({ method: z25.literal("tools/list") });
var ListToolsResultSchema = PaginatedResultSchema.extend({ tools: z25.array(ToolSchema) });
var CallToolResultSchema = ResultSchema.extend({
  content: z25.array(ContentBlockSchema).default([]),
  structuredContent: z25.unknown().optional(),
  isError: z25.boolean().optional()
});
var CompatibilityCallToolResultSchema = CallToolResultSchema.or(ResultSchema.extend({ toolResult: z25.unknown() }));
var CallToolRequestParamsSchema = TaskAugmentedRequestParamsSchema.extend({
  name: z25.string(),
  arguments: z25.record(z25.string(), z25.unknown()).optional()
});
var CallToolRequestSchema = RequestSchema.extend({
  method: z25.literal("tools/call"),
  params: CallToolRequestParamsSchema
});
var ToolListChangedNotificationSchema = NotificationSchema.extend({
  method: z25.literal("notifications/tools/list_changed"),
  params: NotificationsParamsSchema.optional()
});
var ListChangedOptionsBaseSchema = z25.object({
  autoRefresh: z25.boolean().default(true),
  debounceMs: z25.number().int().nonnegative().default(300)
});
var LoggingLevelSchema = z25.enum([
  "debug",
  "info",
  "notice",
  "warning",
  "error",
  "critical",
  "alert",
  "emergency"
]);
var SetLevelRequestParamsSchema = BaseRequestParamsSchema.extend({ level: LoggingLevelSchema });
var SetLevelRequestSchema = RequestSchema.extend({
  method: z25.literal("logging/setLevel"),
  params: SetLevelRequestParamsSchema
});
var LoggingMessageNotificationParamsSchema = NotificationsParamsSchema.extend({
  level: LoggingLevelSchema,
  logger: z25.string().optional(),
  data: z25.unknown()
});
var LoggingMessageNotificationSchema = NotificationSchema.extend({
  method: z25.literal("notifications/message"),
  params: LoggingMessageNotificationParamsSchema
});
var ModelHintSchema = z25.object({ name: z25.string().optional() });
var ModelPreferencesSchema = z25.object({
  hints: z25.array(ModelHintSchema).optional(),
  costPriority: z25.number().min(0).max(1).optional(),
  speedPriority: z25.number().min(0).max(1).optional(),
  intelligencePriority: z25.number().min(0).max(1).optional()
});
var ToolChoiceSchema = z25.object({ mode: z25.enum([
  "auto",
  "required",
  "none"
]).optional() });
var ToolResultContentSchema = z25.object({
  type: z25.literal("tool_result"),
  toolUseId: z25.string().describe("The unique identifier for the corresponding tool call."),
  content: z25.array(ContentBlockSchema),
  structuredContent: z25.unknown().optional(),
  isError: z25.boolean().optional(),
  _meta: z25.record(z25.string(), z25.unknown()).optional()
});
var SamplingContentSchema = z25.discriminatedUnion("type", [
  TextContentSchema,
  ImageContentSchema,
  AudioContentSchema
]);
var SamplingMessageContentBlockSchema = z25.discriminatedUnion("type", [
  TextContentSchema,
  ImageContentSchema,
  AudioContentSchema,
  ToolUseContentSchema,
  ToolResultContentSchema
]);
var SamplingMessageSchema = z25.object({
  role: RoleSchema,
  content: z25.union([SamplingMessageContentBlockSchema, z25.array(SamplingMessageContentBlockSchema)]),
  _meta: z25.record(z25.string(), z25.unknown()).optional()
});
var CreateMessageRequestParamsSchema = TaskAugmentedRequestParamsSchema.extend({
  messages: z25.array(SamplingMessageSchema),
  modelPreferences: ModelPreferencesSchema.optional(),
  systemPrompt: z25.string().optional(),
  includeContext: z25.enum([
    "none",
    "thisServer",
    "allServers"
  ]).optional(),
  temperature: z25.number().optional(),
  maxTokens: z25.number().int(),
  stopSequences: z25.array(z25.string()).optional(),
  metadata: JSONObjectSchema.optional(),
  tools: z25.array(ToolSchema).optional(),
  toolChoice: ToolChoiceSchema.optional()
});
var CreateMessageRequestSchema = RequestSchema.extend({
  method: z25.literal("sampling/createMessage"),
  params: CreateMessageRequestParamsSchema
});
var CreateMessageResultSchema = ResultSchema.extend({
  model: z25.string(),
  stopReason: z25.optional(z25.enum([
    "endTurn",
    "stopSequence",
    "maxTokens"
  ]).or(z25.string())),
  role: RoleSchema,
  content: SamplingContentSchema
});
var CreateMessageResultWithToolsSchema = ResultSchema.extend({
  model: z25.string(),
  stopReason: z25.optional(z25.enum([
    "endTurn",
    "stopSequence",
    "maxTokens",
    "toolUse"
  ]).or(z25.string())),
  role: RoleSchema,
  content: z25.union([SamplingMessageContentBlockSchema, z25.array(SamplingMessageContentBlockSchema)])
});
var BooleanSchemaSchema = z25.object({
  type: z25.literal("boolean"),
  title: z25.string().optional(),
  description: z25.string().optional(),
  default: z25.boolean().optional()
});
var StringSchemaSchema = z25.object({
  type: z25.literal("string"),
  title: z25.string().optional(),
  description: z25.string().optional(),
  minLength: z25.number().optional(),
  maxLength: z25.number().optional(),
  format: z25.enum([
    "email",
    "uri",
    "date",
    "date-time"
  ]).optional(),
  default: z25.string().optional()
});
var NumberSchemaSchema = z25.object({
  type: z25.enum(["number", "integer"]),
  title: z25.string().optional(),
  description: z25.string().optional(),
  minimum: z25.number().optional(),
  maximum: z25.number().optional(),
  default: z25.number().optional()
});
var UntitledSingleSelectEnumSchemaSchema = z25.object({
  type: z25.literal("string"),
  title: z25.string().optional(),
  description: z25.string().optional(),
  enum: z25.array(z25.string()),
  default: z25.string().optional()
});
var TitledSingleSelectEnumSchemaSchema = z25.object({
  type: z25.literal("string"),
  title: z25.string().optional(),
  description: z25.string().optional(),
  oneOf: z25.array(z25.object({
    const: z25.string(),
    title: z25.string()
  })),
  default: z25.string().optional()
});
var LegacyTitledEnumSchemaSchema = z25.object({
  type: z25.literal("string"),
  title: z25.string().optional(),
  description: z25.string().optional(),
  enum: z25.array(z25.string()),
  enumNames: z25.array(z25.string()).optional(),
  default: z25.string().optional()
});
var SingleSelectEnumSchemaSchema = z25.union([UntitledSingleSelectEnumSchemaSchema, TitledSingleSelectEnumSchemaSchema]);
var UntitledMultiSelectEnumSchemaSchema = z25.object({
  type: z25.literal("array"),
  title: z25.string().optional(),
  description: z25.string().optional(),
  minItems: z25.number().optional(),
  maxItems: z25.number().optional(),
  items: z25.object({
    type: z25.literal("string"),
    enum: z25.array(z25.string())
  }),
  default: z25.array(z25.string()).optional()
});
var TitledMultiSelectEnumSchemaSchema = z25.object({
  type: z25.literal("array"),
  title: z25.string().optional(),
  description: z25.string().optional(),
  minItems: z25.number().optional(),
  maxItems: z25.number().optional(),
  items: z25.object({ anyOf: z25.array(z25.object({
    const: z25.string(),
    title: z25.string()
  })) }),
  default: z25.array(z25.string()).optional()
});
var MultiSelectEnumSchemaSchema = z25.union([UntitledMultiSelectEnumSchemaSchema, TitledMultiSelectEnumSchemaSchema]);
var EnumSchemaSchema = z25.union([
  LegacyTitledEnumSchemaSchema,
  SingleSelectEnumSchemaSchema,
  MultiSelectEnumSchemaSchema
]);
var PrimitiveSchemaDefinitionSchema = z25.union([
  EnumSchemaSchema,
  BooleanSchemaSchema,
  StringSchemaSchema,
  NumberSchemaSchema
]);
var ElicitRequestFormParamsSchema = TaskAugmentedRequestParamsSchema.extend({
  mode: z25.literal("form").optional(),
  message: z25.string(),
  requestedSchema: z25.object({
    type: z25.literal("object"),
    properties: z25.record(z25.string(), PrimitiveSchemaDefinitionSchema),
    required: z25.array(z25.string()).optional()
  }).catchall(z25.unknown())
});
var ElicitRequestURLParamsSchema = TaskAugmentedRequestParamsSchema.extend({
  mode: z25.literal("url"),
  message: z25.string(),
  elicitationId: z25.string(),
  url: z25.string().url()
});
var ElicitRequestParamsSchema = z25.union([ElicitRequestFormParamsSchema, ElicitRequestURLParamsSchema]);
var ElicitRequestSchema = RequestSchema.extend({
  method: z25.literal("elicitation/create"),
  params: ElicitRequestParamsSchema
});
var ElicitationCompleteNotificationParamsSchema = NotificationsParamsSchema.extend({ elicitationId: z25.string() });
var ElicitationCompleteNotificationSchema = NotificationSchema.extend({
  method: z25.literal("notifications/elicitation/complete"),
  params: ElicitationCompleteNotificationParamsSchema
});
var ElicitResultSchema = ResultSchema.extend({
  action: z25.enum([
    "accept",
    "decline",
    "cancel"
  ]),
  content: z25.preprocess((val) => val === null ? void 0 : val, z25.record(z25.string(), z25.union([
    z25.string(),
    z25.number(),
    z25.boolean(),
    z25.array(z25.string())
  ])).optional())
});
var ResourceTemplateReferenceSchema = z25.object({
  type: z25.literal("ref/resource"),
  uri: z25.string()
});
var PromptReferenceSchema = z25.object({
  type: z25.literal("ref/prompt"),
  name: z25.string()
});
var CompleteRequestParamsSchema = BaseRequestParamsSchema.extend({
  ref: z25.union([PromptReferenceSchema, ResourceTemplateReferenceSchema]),
  argument: z25.object({
    name: z25.string(),
    value: z25.string()
  }),
  context: z25.object({ arguments: z25.record(z25.string(), z25.string()).optional() }).optional()
});
var CompleteRequestSchema = RequestSchema.extend({
  method: z25.literal("completion/complete"),
  params: CompleteRequestParamsSchema
});
var CompleteResultSchema = ResultSchema.extend({ completion: z25.looseObject({
  values: z25.array(z25.string()).max(100),
  total: z25.optional(z25.number().int()),
  hasMore: z25.optional(z25.boolean())
}) });
var RootSchema = z25.object({
  uri: z25.string().startsWith("file://"),
  name: z25.string().optional(),
  _meta: z25.record(z25.string(), z25.unknown()).optional()
});
var ListRootsRequestSchema = RequestSchema.extend({
  method: z25.literal("roots/list"),
  params: BaseRequestParamsSchema.optional()
});
var ListRootsResultSchema = ResultSchema.extend({ roots: z25.array(RootSchema) });
var RootsListChangedNotificationSchema = NotificationSchema.extend({
  method: z25.literal("notifications/roots/list_changed"),
  params: NotificationsParamsSchema.optional()
});
var TaskCreationParamsSchema = z25.looseObject({
  ttl: z25.number().optional(),
  pollInterval: z25.number().optional()
});
var TaskStatusSchema = z25.enum([
  "working",
  "input_required",
  "completed",
  "failed",
  "cancelled"
]);
var TaskSchema = z25.object({
  taskId: z25.string(),
  status: TaskStatusSchema,
  ttl: z25.union([z25.number(), z25.null()]),
  createdAt: z25.string(),
  lastUpdatedAt: z25.string(),
  pollInterval: z25.optional(z25.number()),
  statusMessage: z25.optional(z25.string())
});
var CreateTaskResultSchema = ResultSchema.extend({ task: TaskSchema });
var TaskStatusNotificationParamsSchema = NotificationsParamsSchema.merge(TaskSchema);
var TaskStatusNotificationSchema = NotificationSchema.extend({
  method: z25.literal("notifications/tasks/status"),
  params: TaskStatusNotificationParamsSchema
});
var GetTaskRequestSchema = RequestSchema.extend({
  method: z25.literal("tasks/get"),
  params: BaseRequestParamsSchema.extend({ taskId: z25.string() })
});
var GetTaskResultSchema = ResultSchema.merge(TaskSchema);
var GetTaskPayloadRequestSchema = RequestSchema.extend({
  method: z25.literal("tasks/result"),
  params: BaseRequestParamsSchema.extend({ taskId: z25.string() })
});
var GetTaskPayloadResultSchema = ResultSchema.loose();
var ListTasksRequestSchema = PaginatedRequestSchema.extend({ method: z25.literal("tasks/list") });
var ListTasksResultSchema = PaginatedResultSchema.extend({ tasks: z25.array(TaskSchema) });
var CancelTaskRequestSchema = RequestSchema.extend({
  method: z25.literal("tasks/cancel"),
  params: BaseRequestParamsSchema.extend({ taskId: z25.string() })
});
var CancelTaskResultSchema = ResultSchema.merge(TaskSchema);
var ClientRequestSchema = z25.union([
  PingRequestSchema,
  InitializeRequestSchema,
  DiscoverRequestSchema,
  CompleteRequestSchema,
  SetLevelRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  SubscriptionsListenRequestSchema,
  CallToolRequestSchema,
  ListToolsRequestSchema
]);
var ClientNotificationSchema = z25.union([
  CancelledNotificationSchema,
  ProgressNotificationSchema,
  InitializedNotificationSchema,
  RootsListChangedNotificationSchema
]);
var ClientResultSchema = z25.union([
  EmptyResultSchema,
  CreateMessageResultSchema,
  CreateMessageResultWithToolsSchema,
  ElicitResultSchema,
  ListRootsResultSchema
]);
var ServerRequestSchema = z25.union([
  PingRequestSchema,
  CreateMessageRequestSchema,
  ElicitRequestSchema,
  ListRootsRequestSchema
]);
var ServerNotificationSchema = z25.union([
  CancelledNotificationSchema,
  ProgressNotificationSchema,
  LoggingMessageNotificationSchema,
  ResourceUpdatedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
  PromptListChangedNotificationSchema,
  SubscriptionsAcknowledgedNotificationSchema,
  ElicitationCompleteNotificationSchema
]);
var ServerResultSchema = z25.union([
  EmptyResultSchema,
  InitializeResultSchema,
  DiscoverResultSchema,
  CompleteResultSchema,
  GetPromptResultSchema,
  ListPromptsResultSchema,
  ListResourcesResultSchema,
  ListResourceTemplatesResultSchema,
  ReadResourceResultSchema,
  CallToolResultSchema,
  ListToolsResultSchema,
  SubscriptionsListenResultSchema
]);
var SafeUrlSchema = z25.url().superRefine((val, ctx) => {
  if (!URL.canParse(val)) {
    ctx.addIssue({
      code: z25.ZodIssueCode.custom,
      message: "URL must be parseable",
      fatal: true
    });
    return z25.NEVER;
  }
}).refine((url3) => {
  const u = new URL(url3);
  return u.protocol !== "javascript:" && u.protocol !== "data:" && u.protocol !== "vbscript:";
}, { message: "URL cannot use javascript:, data:, or vbscript: scheme" });
var OAuthProtectedResourceMetadataSchema = z25.looseObject({
  resource: z25.string().url(),
  authorization_servers: z25.array(SafeUrlSchema).optional(),
  jwks_uri: z25.string().url().optional(),
  scopes_supported: z25.array(z25.string()).optional(),
  bearer_methods_supported: z25.array(z25.string()).optional(),
  resource_signing_alg_values_supported: z25.array(z25.string()).optional(),
  resource_name: z25.string().optional(),
  resource_documentation: z25.string().optional(),
  resource_policy_uri: z25.string().url().optional(),
  resource_tos_uri: z25.string().url().optional(),
  tls_client_certificate_bound_access_tokens: z25.boolean().optional(),
  authorization_details_types_supported: z25.array(z25.string()).optional(),
  dpop_signing_alg_values_supported: z25.array(z25.string()).optional(),
  dpop_bound_access_tokens_required: z25.boolean().optional()
});
var OAuthMetadataSchema = z25.looseObject({
  issuer: z25.string(),
  authorization_endpoint: SafeUrlSchema,
  token_endpoint: SafeUrlSchema,
  registration_endpoint: SafeUrlSchema.optional(),
  scopes_supported: z25.array(z25.string()).optional(),
  response_types_supported: z25.array(z25.string()),
  response_modes_supported: z25.array(z25.string()).optional(),
  grant_types_supported: z25.array(z25.string()).optional(),
  token_endpoint_auth_methods_supported: z25.array(z25.string()).optional(),
  token_endpoint_auth_signing_alg_values_supported: z25.array(z25.string()).optional(),
  service_documentation: SafeUrlSchema.optional(),
  revocation_endpoint: SafeUrlSchema.optional(),
  revocation_endpoint_auth_methods_supported: z25.array(z25.string()).optional(),
  revocation_endpoint_auth_signing_alg_values_supported: z25.array(z25.string()).optional(),
  introspection_endpoint: z25.string().optional(),
  introspection_endpoint_auth_methods_supported: z25.array(z25.string()).optional(),
  introspection_endpoint_auth_signing_alg_values_supported: z25.array(z25.string()).optional(),
  code_challenge_methods_supported: z25.array(z25.string()).optional(),
  client_id_metadata_document_supported: z25.boolean().optional(),
  authorization_response_iss_parameter_supported: z25.boolean().optional().catch(void 0)
});
var OpenIdProviderMetadataSchema = z25.looseObject({
  issuer: z25.string(),
  authorization_endpoint: SafeUrlSchema,
  token_endpoint: SafeUrlSchema,
  userinfo_endpoint: SafeUrlSchema.optional(),
  jwks_uri: SafeUrlSchema,
  registration_endpoint: SafeUrlSchema.optional(),
  scopes_supported: z25.array(z25.string()).optional(),
  response_types_supported: z25.array(z25.string()),
  response_modes_supported: z25.array(z25.string()).optional(),
  grant_types_supported: z25.array(z25.string()).optional(),
  acr_values_supported: z25.array(z25.string()).optional(),
  subject_types_supported: z25.array(z25.string()),
  id_token_signing_alg_values_supported: z25.array(z25.string()),
  id_token_encryption_alg_values_supported: z25.array(z25.string()).optional(),
  id_token_encryption_enc_values_supported: z25.array(z25.string()).optional(),
  userinfo_signing_alg_values_supported: z25.array(z25.string()).optional(),
  userinfo_encryption_alg_values_supported: z25.array(z25.string()).optional(),
  userinfo_encryption_enc_values_supported: z25.array(z25.string()).optional(),
  request_object_signing_alg_values_supported: z25.array(z25.string()).optional(),
  request_object_encryption_alg_values_supported: z25.array(z25.string()).optional(),
  request_object_encryption_enc_values_supported: z25.array(z25.string()).optional(),
  token_endpoint_auth_methods_supported: z25.array(z25.string()).optional(),
  token_endpoint_auth_signing_alg_values_supported: z25.array(z25.string()).optional(),
  display_values_supported: z25.array(z25.string()).optional(),
  claim_types_supported: z25.array(z25.string()).optional(),
  claims_supported: z25.array(z25.string()).optional(),
  service_documentation: z25.string().optional(),
  claims_locales_supported: z25.array(z25.string()).optional(),
  ui_locales_supported: z25.array(z25.string()).optional(),
  claims_parameter_supported: z25.boolean().optional(),
  request_parameter_supported: z25.boolean().optional(),
  request_uri_parameter_supported: z25.boolean().optional(),
  require_request_uri_registration: z25.boolean().optional(),
  op_policy_uri: SafeUrlSchema.optional(),
  op_tos_uri: SafeUrlSchema.optional(),
  client_id_metadata_document_supported: z25.boolean().optional(),
  authorization_response_iss_parameter_supported: z25.boolean().optional().catch(void 0)
});
var OpenIdProviderDiscoveryMetadataSchema = z25.object({
  ...OpenIdProviderMetadataSchema.shape,
  ...OAuthMetadataSchema.pick({ code_challenge_methods_supported: true }).shape
});
var OAuthTokensSchema = z25.object({
  access_token: z25.string(),
  id_token: z25.string().optional(),
  token_type: z25.string(),
  expires_in: z25.coerce.number().optional(),
  scope: z25.string().optional(),
  refresh_token: z25.string().optional()
}).strip();
var IdJagTokenExchangeResponseSchema = z25.object({
  issued_token_type: z25.literal("urn:ietf:params:oauth:token-type:id-jag"),
  access_token: z25.string(),
  token_type: z25.string().optional(),
  expires_in: z25.number().optional(),
  scope: z25.string().optional()
}).strip();
var OAuthErrorResponseSchema = z25.object({
  error: z25.string(),
  error_description: z25.string().optional(),
  error_uri: z25.string().optional()
});
var OptionalSafeUrlSchema = SafeUrlSchema.optional().or(z25.literal("").transform(() => void 0));
var OAuthClientMetadataSchema = z25.object({
  redirect_uris: z25.array(SafeUrlSchema),
  token_endpoint_auth_method: z25.string().optional(),
  grant_types: z25.array(z25.string()).optional(),
  response_types: z25.array(z25.string()).optional(),
  application_type: z25.string().optional(),
  client_name: z25.string().optional(),
  client_uri: SafeUrlSchema.optional(),
  logo_uri: OptionalSafeUrlSchema,
  scope: z25.string().optional(),
  contacts: z25.array(z25.string()).optional(),
  tos_uri: OptionalSafeUrlSchema,
  policy_uri: z25.string().optional(),
  jwks_uri: SafeUrlSchema.optional(),
  jwks: z25.any().optional(),
  software_id: z25.string().optional(),
  software_version: z25.string().optional(),
  software_statement: z25.string().optional()
}).strip();
var OAuthClientInformationSchema = z25.object({
  client_id: z25.string(),
  client_secret: z25.string().optional(),
  client_id_issued_at: z25.number().optional(),
  client_secret_expires_at: z25.number().optional()
}).strip();
var OAuthClientInformationFullSchema = OAuthClientMetadataSchema.merge(OAuthClientInformationSchema);
var OAuthClientRegistrationErrorSchema = z25.object({
  error: z25.string(),
  error_description: z25.string().optional()
}).strip();
var OAuthTokenRevocationRequestSchema = z25.object({
  token: z25.string(),
  token_type_hint: z25.string().optional()
}).strip();

// ../../node_modules/@modelcontextprotocol/server/dist/chunk-Br0eD_fh.mjs
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJSMin = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);
var __exportAll = (all, symbols) => {
  let target = {};
  for (var name in all) {
    __defProp(target, name, {
      get: all[name],
      enumerable: true
    });
  }
  if (symbols) {
    __defProp(target, Symbol.toStringTag, { value: "Module" });
  }
  return target;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
      key = keys[i];
      if (!__hasOwnProp.call(to, key) && key !== except) {
        __defProp(to, key, {
          get: ((k) => from[k]).bind(null, key),
          enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
        });
      }
    }
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
  value: mod,
  enumerable: true
}) : target, mod));

// ../../node_modules/@modelcontextprotocol/server/dist/dialects-DoSzNhcb.mjs
var DRAFT_2020_12_URIS = /* @__PURE__ */ new Set(["https://json-schema.org/draft/2020-12/schema", "http://json-schema.org/draft/2020-12/schema"]);
var DRAFT_2019_09_URIS = /* @__PURE__ */ new Set(["https://json-schema.org/draft/2019-09/schema", "http://json-schema.org/draft/2019-09/schema"]);
var DRAFT_07_URIS = /* @__PURE__ */ new Set(["https://json-schema.org/draft-07/schema", "http://json-schema.org/draft-07/schema"]);
var DRAFT_06_URIS = /* @__PURE__ */ new Set(["https://json-schema.org/draft-06/schema", "http://json-schema.org/draft-06/schema"]);
function declares2019Dialect($schema) {
  return typeof $schema === "string" && DRAFT_2019_09_URIS.has($schema.replace(/#$/, ""));
}
function declaredDialect(schema, remedy) {
  if (!("$schema" in schema) || typeof schema.$schema !== "string") return "2020-12";
  const declared = schema.$schema.replace(/#$/, "");
  if (DRAFT_2020_12_URIS.has(declared)) return "2020-12";
  if (DRAFT_2019_09_URIS.has(declared)) return "2019-09";
  if (DRAFT_07_URIS.has(declared) || DRAFT_06_URIS.has(declared)) return "draft-7";
  throw new Error(`JSON Schema declares an unsupported dialect ("$schema": "${schema.$schema.slice(0, 200)}"). The default validator supports JSON Schema 2020-12, 2019-09, draft-07, and draft-06; ${remedy}`);
}

// ../../node_modules/@modelcontextprotocol/server/dist/src-CX2iR2pK.mjs
import * as z26 from "zod/v4";
var BRANDS = Symbol.for("mcp.sdk.errorBrands");
function stampErrorBrands(instance, ctor) {
  const brands = /* @__PURE__ */ new Set();
  let current = ctor;
  while (typeof current === "function") {
    const brand = current.mcpBrand;
    if (Object.prototype.hasOwnProperty.call(current, "mcpBrand") && typeof brand === "string") brands.add(brand);
    current = Object.getPrototypeOf(current);
  }
  if (brands.size === 0) return;
  Object.defineProperty(instance, BRANDS, {
    value: brands,
    enumerable: false,
    configurable: true
  });
}
function brandedHasInstance(cls, value) {
  try {
    if (typeof value === "object" && value !== null && Object.prototype.hasOwnProperty.call(cls, "mcpBrand") && typeof cls.mcpBrand === "string" && Object.prototype.hasOwnProperty.call(value, BRANDS)) {
      const carried = value[BRANDS];
      if (carried && typeof carried.has === "function" && carried.has(cls.mcpBrand)) return true;
    }
  } catch {
  }
  return Function.prototype[Symbol.hasInstance].call(cls, value);
}
var OAuthError = class OAuthError2 extends Error {
  static {
    Object.defineProperty(this, "mcpBrand", { value: "mcp.OAuthError" });
  }
  static [Symbol.hasInstance](value) {
    return brandedHasInstance(this, value);
  }
  /**
  * Brand-based type guard: equivalent to `value instanceof this`, as an
  * explicit static predicate (the axios/AWS-SDK `isInstance` style). Reads
  * the caller's own brand via `this`, so every branded subclass gets a
  * correctly-scoped guard by inheritance. Must be invoked on the class —
  * in callback position write `v => SdkError.isInstance(v)`, not
  * `.filter(SdkError.isInstance)` (detached calls throw rather than
  * silently matching nothing).
  */
  static isInstance(value) {
    if (typeof this !== "function") throw new TypeError("isInstance must be called on the class (e.g. `SdkError.isInstance(value)`); for callbacks use `v => SdkError.isInstance(v)`");
    return brandedHasInstance(this, value);
  }
  constructor(code, message, errorUri) {
    super(message);
    this.code = code;
    this.errorUri = errorUri;
    this.name = "OAuthError";
    stampErrorBrands(this, new.target);
  }
  /**
  * Converts the error to a standard OAuth error response object.
  */
  toResponseObject() {
    const response = {
      error: this.code,
      error_description: this.message
    };
    if (this.errorUri) response.error_uri = this.errorUri;
    return response;
  }
  /**
  * Creates an {@linkcode OAuthError} from an OAuth error response.
  */
  static fromResponse(response) {
    return new OAuthError2(response.error, response.error_description ?? response.error, response.error_uri);
  }
};
var SdkErrorCode = /* @__PURE__ */ function(SdkErrorCode$1) {
  SdkErrorCode$1["NotConnected"] = "NOT_CONNECTED";
  SdkErrorCode$1["AlreadyConnected"] = "ALREADY_CONNECTED";
  SdkErrorCode$1["NotInitialized"] = "NOT_INITIALIZED";
  SdkErrorCode$1["CapabilityNotSupported"] = "CAPABILITY_NOT_SUPPORTED";
  SdkErrorCode$1["RequestTimeout"] = "REQUEST_TIMEOUT";
  SdkErrorCode$1["ConnectionClosed"] = "CONNECTION_CLOSED";
  SdkErrorCode$1["SendFailed"] = "SEND_FAILED";
  SdkErrorCode$1["InvalidResult"] = "INVALID_RESULT";
  SdkErrorCode$1["UnsupportedResultType"] = "UNSUPPORTED_RESULT_TYPE";
  SdkErrorCode$1["InputRequiredRoundsExceeded"] = "INPUT_REQUIRED_ROUNDS_EXCEEDED";
  SdkErrorCode$1["ListPaginationExceeded"] = "LIST_PAGINATION_EXCEEDED";
  SdkErrorCode$1["MethodNotSupportedByProtocolVersion"] = "METHOD_NOT_SUPPORTED_BY_PROTOCOL_VERSION";
  SdkErrorCode$1["EraNegotiationFailed"] = "ERA_NEGOTIATION_FAILED";
  SdkErrorCode$1["ClientHttpNotImplemented"] = "CLIENT_HTTP_NOT_IMPLEMENTED";
  SdkErrorCode$1["ClientHttpAuthentication"] = "CLIENT_HTTP_AUTHENTICATION";
  SdkErrorCode$1["ClientHttpForbidden"] = "CLIENT_HTTP_FORBIDDEN";
  SdkErrorCode$1["ClientHttpUnexpectedContent"] = "CLIENT_HTTP_UNEXPECTED_CONTENT";
  SdkErrorCode$1["ClientHttpFailedToOpenStream"] = "CLIENT_HTTP_FAILED_TO_OPEN_STREAM";
  SdkErrorCode$1["ClientHttpFailedToTerminateSession"] = "CLIENT_HTTP_FAILED_TO_TERMINATE_SESSION";
  return SdkErrorCode$1;
}({});
var SdkError = class extends Error {
  static {
    Object.defineProperty(this, "mcpBrand", { value: "mcp.SdkError" });
  }
  static [Symbol.hasInstance](value) {
    return brandedHasInstance(this, value);
  }
  /**
  * Brand-based type guard: equivalent to `value instanceof this`, as an
  * explicit static predicate (the axios/AWS-SDK `isInstance` style). Reads
  * the caller's own brand via `this`, so every branded subclass gets a
  * correctly-scoped guard by inheritance. Must be invoked on the class —
  * in callback position write `v => SdkError.isInstance(v)`, not
  * `.filter(SdkError.isInstance)` (detached calls throw rather than
  * silently matching nothing).
  */
  static isInstance(value) {
    if (typeof this !== "function") throw new TypeError("isInstance must be called on the class (e.g. `SdkError.isInstance(value)`); for callbacks use `v => SdkError.isInstance(v)`");
    return brandedHasInstance(this, value);
  }
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
    this.name = "SdkError";
    stampErrorBrands(this, new.target);
  }
};
var SdkHttpError = class extends SdkError {
  static {
    Object.defineProperty(this, "mcpBrand", { value: "mcp.SdkHttpError" });
  }
  constructor(code, message, data) {
    super(code, message, data);
    this.name = "SdkHttpError";
  }
  get status() {
    return this.data.status;
  }
  get statusText() {
    return this.data.statusText;
  }
};
function isPlainObject$7(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isImpliedCapabilityMember(capability, member, declaredValue) {
  return capability === "elicitation" && member === "form" && declaredValue["form"] === void 0 && declaredValue["url"] === void 0;
}
function requiredClientCapabilitiesForInputRequest(entry) {
  switch (entry.method) {
    case "elicitation/create":
      if (entry.params?.["mode"] === "url") return { elicitation: { url: {} } };
      return { elicitation: { form: {} } };
    case "sampling/createMessage": {
      const params = entry.params;
      if (params !== void 0 && (params["tools"] !== void 0 || params["toolChoice"] !== void 0)) return { sampling: { tools: {} } };
      return { sampling: {} };
    }
    case "roots/list":
      return { roots: {} };
    default:
      return;
  }
}
function missingClientCapabilities(required, declared) {
  const missing = {};
  for (const [capability, requirement] of Object.entries(required)) {
    if (requirement === void 0) continue;
    const declaredValue = declared === void 0 ? void 0 : declared[capability];
    if (declaredValue === void 0) {
      missing[capability] = requirement;
      continue;
    }
    if (isPlainObject$7(requirement) && isPlainObject$7(declaredValue)) {
      const missingMembers = {};
      for (const [member, memberRequirement] of Object.entries(requirement)) if (memberRequirement !== void 0 && declaredValue[member] === void 0 && !isImpliedCapabilityMember(capability, member, declaredValue)) missingMembers[member] = memberRequirement;
      if (Object.keys(missingMembers).length > 0) missing[capability] = missingMembers;
    }
  }
  return Object.keys(missing).length > 0 ? missing : void 0;
}
var FIRST_MODERN_PROTOCOL_VERSION = "2026-07-28";
function isModernProtocolVersion(version) {
  return version >= FIRST_MODERN_PROTOCOL_VERSION;
}
function legacyProtocolVersions(versions) {
  return versions.filter((version) => !isModernProtocolVersion(version));
}
function modernProtocolVersions(versions) {
  return versions.filter((version) => isModernProtocolVersion(version));
}
function appendTextFallbackForNonObject(result) {
  const sc = result.structuredContent;
  if (sc === void 0) return result;
  if (!(typeof sc !== "object" || sc === null || Array.isArray(sc))) return result;
  if (result.content?.some((c) => c.type === "text") ?? false) return result;
  return {
    ...result,
    content: [...result.content ?? [], {
      type: "text",
      text: JSON.stringify(sc)
    }]
  };
}
var TOOL_RESULT_FOREIGN_FAMILY_KEYS = [
  "task",
  "inputRequests",
  "requestState"
];
function normalizeContentlessToolResult(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || value.content !== void 0 || TOOL_RESULT_FOREIGN_FAMILY_KEYS.some((key) => key in value)) return value;
  return {
    ...value,
    content: []
  };
}
function build$1() {
  const JSONValueSchema$1 = z26.lazy(() => z26.union([
    z26.string(),
    z26.number(),
    z26.boolean(),
    z26.null(),
    z26.record(z26.string(), JSONValueSchema$1),
    z26.array(JSONValueSchema$1)
  ]));
  const JSONObjectSchema$1 = z26.record(z26.string(), JSONValueSchema$1);
  const ProgressTokenSchema$1 = z26.union([z26.string(), z26.number().int()]);
  const CursorSchema$1 = z26.string();
  const TaskMetadataSchema$1 = z26.object({ ttl: z26.number().optional() });
  const RelatedTaskMetadataSchema$1 = z26.object({ taskId: z26.string() });
  const RequestMetaSchema$1 = z26.looseObject({
    progressToken: ProgressTokenSchema$1.optional(),
    "io.modelcontextprotocol/related-task": RelatedTaskMetadataSchema$1.optional()
  });
  const BaseRequestParamsSchema$1 = z26.object({ _meta: RequestMetaSchema$1.optional() });
  const TaskAugmentedRequestParamsSchema$1 = BaseRequestParamsSchema$1.extend({ task: TaskMetadataSchema$1.optional() });
  const RequestSchema$1 = z26.object({
    method: z26.string(),
    params: BaseRequestParamsSchema$1.loose().optional()
  });
  const NotificationsParamsSchema$1 = z26.object({ _meta: RequestMetaSchema$1.optional() });
  const NotificationSchema$1 = z26.object({
    method: z26.string(),
    params: NotificationsParamsSchema$1.loose().optional()
  });
  const ResultSchema$1 = z26.looseObject({ _meta: RequestMetaSchema$1.optional() });
  const RequestIdSchema$1 = z26.union([z26.string(), z26.number().int()]);
  const EmptyResultSchema$1 = ResultSchema$1.strict();
  const CancelledNotificationParamsSchema$1 = NotificationsParamsSchema$1.extend({
    requestId: RequestIdSchema$1.optional(),
    reason: z26.string().optional()
  });
  const CancelledNotificationSchema$1 = NotificationSchema$1.extend({
    method: z26.literal("notifications/cancelled"),
    params: CancelledNotificationParamsSchema$1
  });
  const IconSchema$1 = z26.object({
    src: z26.string(),
    mimeType: z26.string().optional(),
    sizes: z26.array(z26.string()).optional(),
    theme: z26.enum(["light", "dark"]).optional()
  });
  const IconsSchema$1 = z26.object({ icons: z26.array(IconSchema$1).optional() });
  const BaseMetadataSchema$1 = z26.object({
    name: z26.string(),
    title: z26.string().optional()
  });
  const ImplementationSchema$1 = BaseMetadataSchema$1.extend({
    ...BaseMetadataSchema$1.shape,
    ...IconsSchema$1.shape,
    version: z26.string(),
    websiteUrl: z26.string().optional(),
    description: z26.string().optional()
  });
  const FormElicitationCapabilitySchema2 = z26.intersection(z26.object({ applyDefaults: z26.boolean().optional() }), JSONObjectSchema$1);
  const ElicitationCapabilitySchema2 = z26.preprocess((value) => {
    if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) return { form: {} };
    return value;
  }, z26.intersection(z26.object({
    form: FormElicitationCapabilitySchema2.optional(),
    url: JSONObjectSchema$1.optional()
  }), JSONObjectSchema$1.optional()));
  const ClientTasksCapabilitySchema$1 = z26.looseObject({
    list: JSONObjectSchema$1.optional(),
    cancel: JSONObjectSchema$1.optional(),
    requests: z26.looseObject({
      sampling: z26.looseObject({ createMessage: JSONObjectSchema$1.optional() }).optional(),
      elicitation: z26.looseObject({ create: JSONObjectSchema$1.optional() }).optional()
    }).optional()
  });
  const ServerTasksCapabilitySchema$1 = z26.looseObject({
    list: JSONObjectSchema$1.optional(),
    cancel: JSONObjectSchema$1.optional(),
    requests: z26.looseObject({ tools: z26.looseObject({ call: JSONObjectSchema$1.optional() }).optional() }).optional()
  });
  const ClientCapabilitiesSchema$1 = z26.object({
    experimental: z26.record(z26.string(), JSONObjectSchema$1).optional(),
    sampling: z26.object({
      context: JSONObjectSchema$1.optional(),
      tools: JSONObjectSchema$1.optional()
    }).optional(),
    elicitation: ElicitationCapabilitySchema2.optional(),
    roots: z26.object({ listChanged: z26.boolean().optional() }).optional(),
    tasks: ClientTasksCapabilitySchema$1.optional(),
    extensions: z26.record(z26.string(), JSONObjectSchema$1).optional()
  });
  const InitializeRequestParamsSchema$1 = BaseRequestParamsSchema$1.extend({
    protocolVersion: z26.string(),
    capabilities: ClientCapabilitiesSchema$1,
    clientInfo: ImplementationSchema$1
  });
  const InitializeRequestSchema$1 = RequestSchema$1.extend({
    method: z26.literal("initialize"),
    params: InitializeRequestParamsSchema$1
  });
  const ServerCapabilitiesSchema$1 = z26.object({
    experimental: z26.record(z26.string(), JSONObjectSchema$1).optional(),
    logging: JSONObjectSchema$1.optional(),
    completions: JSONObjectSchema$1.optional(),
    prompts: z26.object({ listChanged: z26.boolean().optional() }).optional(),
    resources: z26.object({
      subscribe: z26.boolean().optional(),
      listChanged: z26.boolean().optional()
    }).optional(),
    tools: z26.object({ listChanged: z26.boolean().optional() }).optional(),
    tasks: ServerTasksCapabilitySchema$1.optional(),
    extensions: z26.record(z26.string(), JSONObjectSchema$1).optional()
  });
  const InitializeResultSchema$1 = ResultSchema$1.extend({
    protocolVersion: z26.string(),
    capabilities: ServerCapabilitiesSchema$1,
    serverInfo: ImplementationSchema$1,
    instructions: z26.string().optional()
  });
  const InitializedNotificationSchema$1 = NotificationSchema$1.extend({
    method: z26.literal("notifications/initialized"),
    params: NotificationsParamsSchema$1.optional()
  });
  const PingRequestSchema$1 = RequestSchema$1.extend({
    method: z26.literal("ping"),
    params: BaseRequestParamsSchema$1.optional()
  });
  const ProgressSchema$1 = z26.object({
    progress: z26.number(),
    total: z26.optional(z26.number()),
    message: z26.optional(z26.string())
  });
  const ProgressNotificationParamsSchema$1 = z26.object({
    ...NotificationsParamsSchema$1.shape,
    ...ProgressSchema$1.shape,
    progressToken: ProgressTokenSchema$1
  });
  const ProgressNotificationSchema$1 = NotificationSchema$1.extend({
    method: z26.literal("notifications/progress"),
    params: ProgressNotificationParamsSchema$1
  });
  const PaginatedRequestParamsSchema$1 = BaseRequestParamsSchema$1.extend({ cursor: CursorSchema$1.optional() });
  const PaginatedRequestSchema$1 = RequestSchema$1.extend({ params: PaginatedRequestParamsSchema$1.optional() });
  const PaginatedResultSchema$1 = ResultSchema$1.extend({ nextCursor: CursorSchema$1.optional() });
  const ResourceContentsSchema$1 = z26.object({
    uri: z26.string(),
    mimeType: z26.optional(z26.string()),
    _meta: z26.record(z26.string(), z26.unknown()).optional()
  });
  const TextResourceContentsSchema$1 = ResourceContentsSchema$1.extend({ text: z26.string() });
  const Base64Schema2 = z26.string().refine((val) => {
    try {
      atob(val);
      return true;
    } catch {
      return false;
    }
  }, { message: "Invalid Base64 string" });
  const BlobResourceContentsSchema$1 = ResourceContentsSchema$1.extend({ blob: Base64Schema2 });
  const RoleSchema$1 = z26.enum(["user", "assistant"]);
  const AnnotationsSchema$1 = z26.object({
    audience: z26.array(RoleSchema$1).optional(),
    priority: z26.number().min(0).max(1).optional(),
    lastModified: z26.iso.datetime({ offset: true }).optional()
  });
  const ResourceSchema$1 = z26.object({
    ...BaseMetadataSchema$1.shape,
    ...IconsSchema$1.shape,
    uri: z26.string(),
    description: z26.optional(z26.string()),
    mimeType: z26.optional(z26.string()),
    size: z26.optional(z26.number()),
    annotations: AnnotationsSchema$1.optional(),
    _meta: z26.optional(z26.looseObject({}))
  });
  const ResourceTemplateSchema$1 = z26.object({
    ...BaseMetadataSchema$1.shape,
    ...IconsSchema$1.shape,
    uriTemplate: z26.string(),
    description: z26.optional(z26.string()),
    mimeType: z26.optional(z26.string()),
    annotations: AnnotationsSchema$1.optional(),
    _meta: z26.optional(z26.looseObject({}))
  });
  const ListResourcesRequestSchema$1 = PaginatedRequestSchema$1.extend({ method: z26.literal("resources/list") });
  const ListResourcesResultSchema$1 = PaginatedResultSchema$1.extend({ resources: z26.array(ResourceSchema$1) });
  const ListResourceTemplatesRequestSchema$1 = PaginatedRequestSchema$1.extend({ method: z26.literal("resources/templates/list") });
  const ListResourceTemplatesResultSchema$1 = PaginatedResultSchema$1.extend({ resourceTemplates: z26.array(ResourceTemplateSchema$1) });
  const ResourceRequestParamsSchema$1 = BaseRequestParamsSchema$1.extend({ uri: z26.string() });
  const ReadResourceRequestParamsSchema$1 = ResourceRequestParamsSchema$1;
  const ReadResourceRequestSchema$1 = RequestSchema$1.extend({
    method: z26.literal("resources/read"),
    params: ReadResourceRequestParamsSchema$1
  });
  const ReadResourceResultSchema$1 = ResultSchema$1.extend({ contents: z26.array(z26.union([TextResourceContentsSchema$1, BlobResourceContentsSchema$1])) });
  const ResourceListChangedNotificationSchema$1 = NotificationSchema$1.extend({
    method: z26.literal("notifications/resources/list_changed"),
    params: NotificationsParamsSchema$1.optional()
  });
  const SubscribeRequestParamsSchema$1 = ResourceRequestParamsSchema$1;
  const SubscribeRequestSchema$1 = RequestSchema$1.extend({
    method: z26.literal("resources/subscribe"),
    params: SubscribeRequestParamsSchema$1
  });
  const UnsubscribeRequestParamsSchema$1 = ResourceRequestParamsSchema$1;
  const UnsubscribeRequestSchema$1 = RequestSchema$1.extend({
    method: z26.literal("resources/unsubscribe"),
    params: UnsubscribeRequestParamsSchema$1
  });
  const ResourceUpdatedNotificationParamsSchema$1 = NotificationsParamsSchema$1.extend({ uri: z26.string() });
  const ResourceUpdatedNotificationSchema$1 = NotificationSchema$1.extend({
    method: z26.literal("notifications/resources/updated"),
    params: ResourceUpdatedNotificationParamsSchema$1
  });
  const PromptArgumentSchema$1 = z26.object({
    name: z26.string(),
    description: z26.optional(z26.string()),
    required: z26.optional(z26.boolean())
  });
  const PromptSchema$1 = z26.object({
    ...BaseMetadataSchema$1.shape,
    ...IconsSchema$1.shape,
    description: z26.optional(z26.string()),
    arguments: z26.optional(z26.array(PromptArgumentSchema$1)),
    _meta: z26.optional(z26.looseObject({}))
  });
  const ListPromptsRequestSchema$1 = PaginatedRequestSchema$1.extend({ method: z26.literal("prompts/list") });
  const ListPromptsResultSchema$1 = PaginatedResultSchema$1.extend({ prompts: z26.array(PromptSchema$1) });
  const GetPromptRequestParamsSchema$1 = BaseRequestParamsSchema$1.extend({
    name: z26.string(),
    arguments: z26.record(z26.string(), z26.string()).optional()
  });
  const GetPromptRequestSchema$1 = RequestSchema$1.extend({
    method: z26.literal("prompts/get"),
    params: GetPromptRequestParamsSchema$1
  });
  const TextContentSchema$1 = z26.object({
    type: z26.literal("text"),
    text: z26.string(),
    annotations: AnnotationsSchema$1.optional(),
    _meta: z26.record(z26.string(), z26.unknown()).optional()
  });
  const ImageContentSchema$1 = z26.object({
    type: z26.literal("image"),
    data: Base64Schema2,
    mimeType: z26.string(),
    annotations: AnnotationsSchema$1.optional(),
    _meta: z26.record(z26.string(), z26.unknown()).optional()
  });
  const AudioContentSchema$1 = z26.object({
    type: z26.literal("audio"),
    data: Base64Schema2,
    mimeType: z26.string(),
    annotations: AnnotationsSchema$1.optional(),
    _meta: z26.record(z26.string(), z26.unknown()).optional()
  });
  const ToolUseContentSchema$1 = z26.object({
    type: z26.literal("tool_use"),
    name: z26.string(),
    id: z26.string(),
    input: z26.record(z26.string(), z26.unknown()),
    _meta: z26.record(z26.string(), z26.unknown()).optional()
  });
  const EmbeddedResourceSchema$1 = z26.object({
    type: z26.literal("resource"),
    resource: z26.union([TextResourceContentsSchema$1, BlobResourceContentsSchema$1]),
    annotations: AnnotationsSchema$1.optional(),
    _meta: z26.record(z26.string(), z26.unknown()).optional()
  });
  const ResourceLinkSchema$1 = ResourceSchema$1.extend({ type: z26.literal("resource_link") });
  const ContentBlockSchema$1 = z26.union([
    TextContentSchema$1,
    ImageContentSchema$1,
    AudioContentSchema$1,
    ResourceLinkSchema$1,
    EmbeddedResourceSchema$1
  ]);
  const PromptMessageSchema$1 = z26.object({
    role: RoleSchema$1,
    content: ContentBlockSchema$1
  });
  const GetPromptResultSchema$1 = ResultSchema$1.extend({
    description: z26.string().optional(),
    messages: z26.array(PromptMessageSchema$1)
  });
  const PromptListChangedNotificationSchema$1 = NotificationSchema$1.extend({
    method: z26.literal("notifications/prompts/list_changed"),
    params: NotificationsParamsSchema$1.optional()
  });
  const ToolAnnotationsSchema$1 = z26.object({
    title: z26.string().optional(),
    readOnlyHint: z26.boolean().optional(),
    destructiveHint: z26.boolean().optional(),
    idempotentHint: z26.boolean().optional(),
    openWorldHint: z26.boolean().optional()
  });
  const ToolExecutionSchema$1 = z26.object({ taskSupport: z26.enum([
    "required",
    "optional",
    "forbidden"
  ]).optional() });
  const ToolSchema$1 = z26.object({
    ...BaseMetadataSchema$1.shape,
    ...IconsSchema$1.shape,
    description: z26.string().optional(),
    inputSchema: z26.object({
      type: z26.literal("object"),
      properties: z26.record(z26.string(), JSONValueSchema$1).optional(),
      required: z26.array(z26.string()).optional()
    }).catchall(z26.unknown()),
    outputSchema: z26.object({
      type: z26.literal("object"),
      properties: z26.record(z26.string(), JSONValueSchema$1).optional(),
      required: z26.array(z26.string()).optional()
    }).catchall(z26.unknown()).optional(),
    annotations: ToolAnnotationsSchema$1.optional(),
    execution: ToolExecutionSchema$1.optional(),
    _meta: z26.record(z26.string(), z26.unknown()).optional()
  });
  const ListToolsRequestSchema$1 = PaginatedRequestSchema$1.extend({ method: z26.literal("tools/list") });
  const ListToolsResultSchema$1 = PaginatedResultSchema$1.extend({ tools: z26.array(ToolSchema$1) });
  const CallToolResultSchema$1 = ResultSchema$1.extend({
    content: z26.array(ContentBlockSchema$1),
    structuredContent: z26.record(z26.string(), z26.unknown()).optional(),
    isError: z26.boolean().optional()
  });
  const CallToolRequestParamsSchema$1 = TaskAugmentedRequestParamsSchema$1.extend({
    name: z26.string(),
    arguments: z26.record(z26.string(), z26.unknown()).optional()
  });
  const CallToolRequestSchema$1 = RequestSchema$1.extend({
    method: z26.literal("tools/call"),
    params: CallToolRequestParamsSchema$1
  });
  const ToolListChangedNotificationSchema$1 = NotificationSchema$1.extend({
    method: z26.literal("notifications/tools/list_changed"),
    params: NotificationsParamsSchema$1.optional()
  });
  const LoggingLevelSchema$1 = z26.enum([
    "debug",
    "info",
    "notice",
    "warning",
    "error",
    "critical",
    "alert",
    "emergency"
  ]);
  const SetLevelRequestParamsSchema$1 = BaseRequestParamsSchema$1.extend({ level: LoggingLevelSchema$1 });
  const SetLevelRequestSchema$1 = RequestSchema$1.extend({
    method: z26.literal("logging/setLevel"),
    params: SetLevelRequestParamsSchema$1
  });
  const LoggingMessageNotificationParamsSchema$1 = NotificationsParamsSchema$1.extend({
    level: LoggingLevelSchema$1,
    logger: z26.string().optional(),
    data: z26.unknown()
  });
  const LoggingMessageNotificationSchema$1 = NotificationSchema$1.extend({
    method: z26.literal("notifications/message"),
    params: LoggingMessageNotificationParamsSchema$1
  });
  const ModelHintSchema$1 = z26.object({ name: z26.string().optional() });
  const ModelPreferencesSchema$1 = z26.object({
    hints: z26.array(ModelHintSchema$1).optional(),
    costPriority: z26.number().min(0).max(1).optional(),
    speedPriority: z26.number().min(0).max(1).optional(),
    intelligencePriority: z26.number().min(0).max(1).optional()
  });
  const ToolChoiceSchema$1 = z26.object({ mode: z26.enum([
    "auto",
    "required",
    "none"
  ]).optional() });
  const ToolResultContentSchema$1 = z26.object({
    type: z26.literal("tool_result"),
    toolUseId: z26.string().describe("The unique identifier for the corresponding tool call."),
    content: z26.array(ContentBlockSchema$1),
    structuredContent: z26.object({}).loose().optional(),
    isError: z26.boolean().optional(),
    _meta: z26.record(z26.string(), z26.unknown()).optional()
  });
  const SamplingContentSchema$1 = z26.discriminatedUnion("type", [
    TextContentSchema$1,
    ImageContentSchema$1,
    AudioContentSchema$1
  ]);
  const SamplingMessageContentBlockSchema$1 = z26.discriminatedUnion("type", [
    TextContentSchema$1,
    ImageContentSchema$1,
    AudioContentSchema$1,
    ToolUseContentSchema$1,
    ToolResultContentSchema$1
  ]);
  const SamplingMessageSchema$1 = z26.object({
    role: RoleSchema$1,
    content: z26.union([SamplingMessageContentBlockSchema$1, z26.array(SamplingMessageContentBlockSchema$1)]),
    _meta: z26.record(z26.string(), z26.unknown()).optional()
  });
  const CreateMessageRequestParamsSchema$1 = TaskAugmentedRequestParamsSchema$1.extend({
    messages: z26.array(SamplingMessageSchema$1),
    modelPreferences: ModelPreferencesSchema$1.optional(),
    systemPrompt: z26.string().optional(),
    includeContext: z26.enum([
      "none",
      "thisServer",
      "allServers"
    ]).optional(),
    temperature: z26.number().optional(),
    maxTokens: z26.number().int(),
    stopSequences: z26.array(z26.string()).optional(),
    metadata: JSONObjectSchema$1.optional(),
    tools: z26.array(ToolSchema$1).optional(),
    toolChoice: ToolChoiceSchema$1.optional()
  });
  const CreateMessageRequestSchema$1 = RequestSchema$1.extend({
    method: z26.literal("sampling/createMessage"),
    params: CreateMessageRequestParamsSchema$1
  });
  const CreateMessageResultSchema$1 = ResultSchema$1.extend({
    model: z26.string(),
    stopReason: z26.optional(z26.enum([
      "endTurn",
      "stopSequence",
      "maxTokens"
    ]).or(z26.string())),
    role: RoleSchema$1,
    content: SamplingContentSchema$1
  });
  const CreateMessageResultWithToolsSchema$1 = ResultSchema$1.extend({
    model: z26.string(),
    stopReason: z26.optional(z26.enum([
      "endTurn",
      "stopSequence",
      "maxTokens",
      "toolUse"
    ]).or(z26.string())),
    role: RoleSchema$1,
    content: z26.union([SamplingMessageContentBlockSchema$1, z26.array(SamplingMessageContentBlockSchema$1)])
  });
  const BooleanSchemaSchema$1 = z26.object({
    type: z26.literal("boolean"),
    title: z26.string().optional(),
    description: z26.string().optional(),
    default: z26.boolean().optional()
  });
  const StringSchemaSchema$1 = z26.object({
    type: z26.literal("string"),
    title: z26.string().optional(),
    description: z26.string().optional(),
    minLength: z26.number().optional(),
    maxLength: z26.number().optional(),
    format: z26.enum([
      "email",
      "uri",
      "date",
      "date-time"
    ]).optional(),
    default: z26.string().optional()
  });
  const NumberSchemaSchema$1 = z26.object({
    type: z26.enum(["number", "integer"]),
    title: z26.string().optional(),
    description: z26.string().optional(),
    minimum: z26.number().optional(),
    maximum: z26.number().optional(),
    default: z26.number().optional()
  });
  const UntitledSingleSelectEnumSchemaSchema$1 = z26.object({
    type: z26.literal("string"),
    title: z26.string().optional(),
    description: z26.string().optional(),
    enum: z26.array(z26.string()),
    default: z26.string().optional()
  });
  const TitledSingleSelectEnumSchemaSchema$1 = z26.object({
    type: z26.literal("string"),
    title: z26.string().optional(),
    description: z26.string().optional(),
    oneOf: z26.array(z26.object({
      const: z26.string(),
      title: z26.string()
    })),
    default: z26.string().optional()
  });
  const LegacyTitledEnumSchemaSchema$1 = z26.object({
    type: z26.literal("string"),
    title: z26.string().optional(),
    description: z26.string().optional(),
    enum: z26.array(z26.string()),
    enumNames: z26.array(z26.string()).optional(),
    default: z26.string().optional()
  });
  const SingleSelectEnumSchemaSchema$1 = z26.union([UntitledSingleSelectEnumSchemaSchema$1, TitledSingleSelectEnumSchemaSchema$1]);
  const UntitledMultiSelectEnumSchemaSchema$1 = z26.object({
    type: z26.literal("array"),
    title: z26.string().optional(),
    description: z26.string().optional(),
    minItems: z26.number().optional(),
    maxItems: z26.number().optional(),
    items: z26.object({
      type: z26.literal("string"),
      enum: z26.array(z26.string())
    }),
    default: z26.array(z26.string()).optional()
  });
  const TitledMultiSelectEnumSchemaSchema$1 = z26.object({
    type: z26.literal("array"),
    title: z26.string().optional(),
    description: z26.string().optional(),
    minItems: z26.number().optional(),
    maxItems: z26.number().optional(),
    items: z26.object({ anyOf: z26.array(z26.object({
      const: z26.string(),
      title: z26.string()
    })) }),
    default: z26.array(z26.string()).optional()
  });
  const MultiSelectEnumSchemaSchema$1 = z26.union([UntitledMultiSelectEnumSchemaSchema$1, TitledMultiSelectEnumSchemaSchema$1]);
  const EnumSchemaSchema$1 = z26.union([
    LegacyTitledEnumSchemaSchema$1,
    SingleSelectEnumSchemaSchema$1,
    MultiSelectEnumSchemaSchema$1
  ]);
  const PrimitiveSchemaDefinitionSchema$1 = z26.union([
    EnumSchemaSchema$1,
    BooleanSchemaSchema$1,
    StringSchemaSchema$1,
    NumberSchemaSchema$1
  ]);
  const ElicitRequestFormParamsSchema$1 = TaskAugmentedRequestParamsSchema$1.extend({
    mode: z26.literal("form").optional(),
    message: z26.string(),
    requestedSchema: z26.object({
      type: z26.literal("object"),
      properties: z26.record(z26.string(), PrimitiveSchemaDefinitionSchema$1),
      required: z26.array(z26.string()).optional()
    }).catchall(z26.unknown())
  });
  const ElicitRequestURLParamsSchema$1 = TaskAugmentedRequestParamsSchema$1.extend({
    mode: z26.literal("url"),
    message: z26.string(),
    elicitationId: z26.string(),
    url: z26.string().url()
  });
  const ElicitRequestParamsSchema$1 = z26.union([ElicitRequestFormParamsSchema$1, ElicitRequestURLParamsSchema$1]);
  const ElicitRequestSchema$1 = RequestSchema$1.extend({
    method: z26.literal("elicitation/create"),
    params: ElicitRequestParamsSchema$1
  });
  const ElicitationCompleteNotificationParamsSchema$1 = NotificationsParamsSchema$1.extend({ elicitationId: z26.string() });
  const ElicitationCompleteNotificationSchema$1 = NotificationSchema$1.extend({
    method: z26.literal("notifications/elicitation/complete"),
    params: ElicitationCompleteNotificationParamsSchema$1
  });
  const ElicitResultSchema$1 = ResultSchema$1.extend({
    action: z26.enum([
      "accept",
      "decline",
      "cancel"
    ]),
    content: z26.preprocess((val) => val === null ? void 0 : val, z26.record(z26.string(), z26.union([
      z26.string(),
      z26.number(),
      z26.boolean(),
      z26.array(z26.string())
    ])).optional())
  });
  const ResourceTemplateReferenceSchema$1 = z26.object({
    type: z26.literal("ref/resource"),
    uri: z26.string()
  });
  const PromptReferenceSchema$1 = z26.object({
    type: z26.literal("ref/prompt"),
    name: z26.string()
  });
  const CompleteRequestParamsSchema$1 = BaseRequestParamsSchema$1.extend({
    ref: z26.union([PromptReferenceSchema$1, ResourceTemplateReferenceSchema$1]),
    argument: z26.object({
      name: z26.string(),
      value: z26.string()
    }),
    context: z26.object({ arguments: z26.record(z26.string(), z26.string()).optional() }).optional()
  });
  const CompleteRequestSchema$1 = RequestSchema$1.extend({
    method: z26.literal("completion/complete"),
    params: CompleteRequestParamsSchema$1
  });
  const CompleteResultSchema$1 = ResultSchema$1.extend({ completion: z26.looseObject({
    values: z26.array(z26.string()).max(100),
    total: z26.optional(z26.number().int()),
    hasMore: z26.optional(z26.boolean())
  }) });
  const RootSchema$1 = z26.object({
    uri: z26.string().startsWith("file://"),
    name: z26.string().optional(),
    _meta: z26.record(z26.string(), z26.unknown()).optional()
  });
  const ListRootsRequestSchema$1 = RequestSchema$1.extend({
    method: z26.literal("roots/list"),
    params: BaseRequestParamsSchema$1.optional()
  });
  const ListRootsResultSchema$1 = ResultSchema$1.extend({ roots: z26.array(RootSchema$1) });
  const RootsListChangedNotificationSchema$1 = NotificationSchema$1.extend({
    method: z26.literal("notifications/roots/list_changed"),
    params: NotificationsParamsSchema$1.optional()
  });
  const TaskCreationParamsSchema$1 = z26.looseObject({
    ttl: z26.number().optional(),
    pollInterval: z26.number().optional()
  });
  const TaskStatusSchema$1 = z26.enum([
    "working",
    "input_required",
    "completed",
    "failed",
    "cancelled"
  ]);
  const TaskSchema$1 = z26.object({
    taskId: z26.string(),
    status: TaskStatusSchema$1,
    ttl: z26.union([z26.number(), z26.null()]),
    createdAt: z26.string(),
    lastUpdatedAt: z26.string(),
    pollInterval: z26.optional(z26.number()),
    statusMessage: z26.optional(z26.string())
  });
  const CreateTaskResultSchema$1 = ResultSchema$1.extend({ task: TaskSchema$1 });
  const TaskStatusNotificationParamsSchema$1 = NotificationsParamsSchema$1.merge(TaskSchema$1);
  const TaskStatusNotificationSchema$1 = NotificationSchema$1.extend({
    method: z26.literal("notifications/tasks/status"),
    params: TaskStatusNotificationParamsSchema$1
  });
  const GetTaskRequestSchema$1 = RequestSchema$1.extend({
    method: z26.literal("tasks/get"),
    params: BaseRequestParamsSchema$1.extend({ taskId: z26.string() })
  });
  const GetTaskResultSchema$1 = ResultSchema$1.merge(TaskSchema$1);
  const GetTaskPayloadRequestSchema$1 = RequestSchema$1.extend({
    method: z26.literal("tasks/result"),
    params: BaseRequestParamsSchema$1.extend({ taskId: z26.string() })
  });
  const GetTaskPayloadResultSchema$1 = ResultSchema$1.loose();
  const ListTasksRequestSchema$1 = PaginatedRequestSchema$1.extend({ method: z26.literal("tasks/list") });
  const ListTasksResultSchema$1 = PaginatedResultSchema$1.extend({ tasks: z26.array(TaskSchema$1) });
  const CancelTaskRequestSchema$1 = RequestSchema$1.extend({
    method: z26.literal("tasks/cancel"),
    params: BaseRequestParamsSchema$1.extend({ taskId: z26.string() })
  });
  return {
    JSONValueSchema: JSONValueSchema$1,
    JSONObjectSchema: JSONObjectSchema$1,
    ProgressTokenSchema: ProgressTokenSchema$1,
    CursorSchema: CursorSchema$1,
    TaskMetadataSchema: TaskMetadataSchema$1,
    RelatedTaskMetadataSchema: RelatedTaskMetadataSchema$1,
    RequestMetaSchema: RequestMetaSchema$1,
    BaseRequestParamsSchema: BaseRequestParamsSchema$1,
    TaskAugmentedRequestParamsSchema: TaskAugmentedRequestParamsSchema$1,
    RequestSchema: RequestSchema$1,
    NotificationsParamsSchema: NotificationsParamsSchema$1,
    NotificationSchema: NotificationSchema$1,
    ResultSchema: ResultSchema$1,
    RequestIdSchema: RequestIdSchema$1,
    EmptyResultSchema: EmptyResultSchema$1,
    CancelledNotificationParamsSchema: CancelledNotificationParamsSchema$1,
    CancelledNotificationSchema: CancelledNotificationSchema$1,
    IconSchema: IconSchema$1,
    IconsSchema: IconsSchema$1,
    BaseMetadataSchema: BaseMetadataSchema$1,
    ImplementationSchema: ImplementationSchema$1,
    ClientTasksCapabilitySchema: ClientTasksCapabilitySchema$1,
    ServerTasksCapabilitySchema: ServerTasksCapabilitySchema$1,
    ClientCapabilitiesSchema: ClientCapabilitiesSchema$1,
    InitializeRequestParamsSchema: InitializeRequestParamsSchema$1,
    InitializeRequestSchema: InitializeRequestSchema$1,
    ServerCapabilitiesSchema: ServerCapabilitiesSchema$1,
    InitializeResultSchema: InitializeResultSchema$1,
    InitializedNotificationSchema: InitializedNotificationSchema$1,
    PingRequestSchema: PingRequestSchema$1,
    ProgressSchema: ProgressSchema$1,
    ProgressNotificationParamsSchema: ProgressNotificationParamsSchema$1,
    ProgressNotificationSchema: ProgressNotificationSchema$1,
    PaginatedRequestParamsSchema: PaginatedRequestParamsSchema$1,
    PaginatedRequestSchema: PaginatedRequestSchema$1,
    PaginatedResultSchema: PaginatedResultSchema$1,
    ResourceContentsSchema: ResourceContentsSchema$1,
    TextResourceContentsSchema: TextResourceContentsSchema$1,
    BlobResourceContentsSchema: BlobResourceContentsSchema$1,
    RoleSchema: RoleSchema$1,
    AnnotationsSchema: AnnotationsSchema$1,
    ResourceSchema: ResourceSchema$1,
    ResourceTemplateSchema: ResourceTemplateSchema$1,
    ListResourcesRequestSchema: ListResourcesRequestSchema$1,
    ListResourcesResultSchema: ListResourcesResultSchema$1,
    ListResourceTemplatesRequestSchema: ListResourceTemplatesRequestSchema$1,
    ListResourceTemplatesResultSchema: ListResourceTemplatesResultSchema$1,
    ResourceRequestParamsSchema: ResourceRequestParamsSchema$1,
    ReadResourceRequestParamsSchema: ReadResourceRequestParamsSchema$1,
    ReadResourceRequestSchema: ReadResourceRequestSchema$1,
    ReadResourceResultSchema: ReadResourceResultSchema$1,
    ResourceListChangedNotificationSchema: ResourceListChangedNotificationSchema$1,
    SubscribeRequestParamsSchema: SubscribeRequestParamsSchema$1,
    SubscribeRequestSchema: SubscribeRequestSchema$1,
    UnsubscribeRequestParamsSchema: UnsubscribeRequestParamsSchema$1,
    UnsubscribeRequestSchema: UnsubscribeRequestSchema$1,
    ResourceUpdatedNotificationParamsSchema: ResourceUpdatedNotificationParamsSchema$1,
    ResourceUpdatedNotificationSchema: ResourceUpdatedNotificationSchema$1,
    PromptArgumentSchema: PromptArgumentSchema$1,
    PromptSchema: PromptSchema$1,
    ListPromptsRequestSchema: ListPromptsRequestSchema$1,
    ListPromptsResultSchema: ListPromptsResultSchema$1,
    GetPromptRequestParamsSchema: GetPromptRequestParamsSchema$1,
    GetPromptRequestSchema: GetPromptRequestSchema$1,
    TextContentSchema: TextContentSchema$1,
    ImageContentSchema: ImageContentSchema$1,
    AudioContentSchema: AudioContentSchema$1,
    ToolUseContentSchema: ToolUseContentSchema$1,
    EmbeddedResourceSchema: EmbeddedResourceSchema$1,
    ResourceLinkSchema: ResourceLinkSchema$1,
    ContentBlockSchema: ContentBlockSchema$1,
    PromptMessageSchema: PromptMessageSchema$1,
    GetPromptResultSchema: GetPromptResultSchema$1,
    PromptListChangedNotificationSchema: PromptListChangedNotificationSchema$1,
    ToolAnnotationsSchema: ToolAnnotationsSchema$1,
    ToolExecutionSchema: ToolExecutionSchema$1,
    ToolSchema: ToolSchema$1,
    ListToolsRequestSchema: ListToolsRequestSchema$1,
    ListToolsResultSchema: ListToolsResultSchema$1,
    CallToolResultSchema: CallToolResultSchema$1,
    CallToolRequestParamsSchema: CallToolRequestParamsSchema$1,
    CallToolRequestSchema: CallToolRequestSchema$1,
    ToolListChangedNotificationSchema: ToolListChangedNotificationSchema$1,
    LoggingLevelSchema: LoggingLevelSchema$1,
    SetLevelRequestParamsSchema: SetLevelRequestParamsSchema$1,
    SetLevelRequestSchema: SetLevelRequestSchema$1,
    LoggingMessageNotificationParamsSchema: LoggingMessageNotificationParamsSchema$1,
    LoggingMessageNotificationSchema: LoggingMessageNotificationSchema$1,
    ModelHintSchema: ModelHintSchema$1,
    ModelPreferencesSchema: ModelPreferencesSchema$1,
    ToolChoiceSchema: ToolChoiceSchema$1,
    ToolResultContentSchema: ToolResultContentSchema$1,
    SamplingContentSchema: SamplingContentSchema$1,
    SamplingMessageContentBlockSchema: SamplingMessageContentBlockSchema$1,
    SamplingMessageSchema: SamplingMessageSchema$1,
    CreateMessageRequestParamsSchema: CreateMessageRequestParamsSchema$1,
    CreateMessageRequestSchema: CreateMessageRequestSchema$1,
    CreateMessageResultSchema: CreateMessageResultSchema$1,
    CreateMessageResultWithToolsSchema: CreateMessageResultWithToolsSchema$1,
    BooleanSchemaSchema: BooleanSchemaSchema$1,
    StringSchemaSchema: StringSchemaSchema$1,
    NumberSchemaSchema: NumberSchemaSchema$1,
    UntitledSingleSelectEnumSchemaSchema: UntitledSingleSelectEnumSchemaSchema$1,
    TitledSingleSelectEnumSchemaSchema: TitledSingleSelectEnumSchemaSchema$1,
    LegacyTitledEnumSchemaSchema: LegacyTitledEnumSchemaSchema$1,
    SingleSelectEnumSchemaSchema: SingleSelectEnumSchemaSchema$1,
    UntitledMultiSelectEnumSchemaSchema: UntitledMultiSelectEnumSchemaSchema$1,
    TitledMultiSelectEnumSchemaSchema: TitledMultiSelectEnumSchemaSchema$1,
    MultiSelectEnumSchemaSchema: MultiSelectEnumSchemaSchema$1,
    EnumSchemaSchema: EnumSchemaSchema$1,
    PrimitiveSchemaDefinitionSchema: PrimitiveSchemaDefinitionSchema$1,
    ElicitRequestFormParamsSchema: ElicitRequestFormParamsSchema$1,
    ElicitRequestURLParamsSchema: ElicitRequestURLParamsSchema$1,
    ElicitRequestParamsSchema: ElicitRequestParamsSchema$1,
    ElicitRequestSchema: ElicitRequestSchema$1,
    ElicitationCompleteNotificationParamsSchema: ElicitationCompleteNotificationParamsSchema$1,
    ElicitationCompleteNotificationSchema: ElicitationCompleteNotificationSchema$1,
    ElicitResultSchema: ElicitResultSchema$1,
    ResourceTemplateReferenceSchema: ResourceTemplateReferenceSchema$1,
    PromptReferenceSchema: PromptReferenceSchema$1,
    CompleteRequestParamsSchema: CompleteRequestParamsSchema$1,
    CompleteRequestSchema: CompleteRequestSchema$1,
    CompleteResultSchema: CompleteResultSchema$1,
    RootSchema: RootSchema$1,
    ListRootsRequestSchema: ListRootsRequestSchema$1,
    ListRootsResultSchema: ListRootsResultSchema$1,
    RootsListChangedNotificationSchema: RootsListChangedNotificationSchema$1,
    TaskCreationParamsSchema: TaskCreationParamsSchema$1,
    TaskStatusSchema: TaskStatusSchema$1,
    TaskSchema: TaskSchema$1,
    CreateTaskResultSchema: CreateTaskResultSchema$1,
    TaskStatusNotificationParamsSchema: TaskStatusNotificationParamsSchema$1,
    TaskStatusNotificationSchema: TaskStatusNotificationSchema$1,
    GetTaskRequestSchema: GetTaskRequestSchema$1,
    GetTaskResultSchema: GetTaskResultSchema$1,
    GetTaskPayloadRequestSchema: GetTaskPayloadRequestSchema$1,
    GetTaskPayloadResultSchema: GetTaskPayloadResultSchema$1,
    ListTasksRequestSchema: ListTasksRequestSchema$1,
    ListTasksResultSchema: ListTasksResultSchema$1,
    CancelTaskRequestSchema: CancelTaskRequestSchema$1,
    CancelTaskResultSchema: ResultSchema$1.merge(TaskSchema$1),
    ClientRequestSchema: z26.union([
      PingRequestSchema$1,
      InitializeRequestSchema$1,
      CompleteRequestSchema$1,
      SetLevelRequestSchema$1,
      GetPromptRequestSchema$1,
      ListPromptsRequestSchema$1,
      ListResourcesRequestSchema$1,
      ListResourceTemplatesRequestSchema$1,
      ReadResourceRequestSchema$1,
      SubscribeRequestSchema$1,
      UnsubscribeRequestSchema$1,
      CallToolRequestSchema$1,
      ListToolsRequestSchema$1,
      GetTaskRequestSchema$1,
      GetTaskPayloadRequestSchema$1,
      ListTasksRequestSchema$1,
      CancelTaskRequestSchema$1
    ]),
    ClientNotificationSchema: z26.union([
      CancelledNotificationSchema$1,
      ProgressNotificationSchema$1,
      InitializedNotificationSchema$1,
      RootsListChangedNotificationSchema$1,
      TaskStatusNotificationSchema$1
    ]),
    ClientResultSchema: z26.union([
      EmptyResultSchema$1,
      CreateMessageResultSchema$1,
      CreateMessageResultWithToolsSchema$1,
      ElicitResultSchema$1,
      ListRootsResultSchema$1,
      GetTaskResultSchema$1,
      ListTasksResultSchema$1,
      CreateTaskResultSchema$1
    ]),
    ServerRequestSchema: z26.union([
      PingRequestSchema$1,
      CreateMessageRequestSchema$1,
      ElicitRequestSchema$1,
      ListRootsRequestSchema$1,
      GetTaskRequestSchema$1,
      GetTaskPayloadRequestSchema$1,
      ListTasksRequestSchema$1,
      CancelTaskRequestSchema$1
    ]),
    ServerNotificationSchema: z26.union([
      CancelledNotificationSchema$1,
      ProgressNotificationSchema$1,
      LoggingMessageNotificationSchema$1,
      ResourceUpdatedNotificationSchema$1,
      ResourceListChangedNotificationSchema$1,
      ToolListChangedNotificationSchema$1,
      PromptListChangedNotificationSchema$1,
      TaskStatusNotificationSchema$1,
      ElicitationCompleteNotificationSchema$1
    ]),
    ServerResultSchema: z26.union([
      EmptyResultSchema$1,
      InitializeResultSchema$1,
      CompleteResultSchema$1,
      GetPromptResultSchema$1,
      ListPromptsResultSchema$1,
      ListResourcesResultSchema$1,
      ListResourceTemplatesResultSchema$1,
      ReadResourceResultSchema$1,
      CallToolResultSchema$1,
      ListToolsResultSchema$1,
      GetTaskResultSchema$1,
      ListTasksResultSchema$1,
      CreateTaskResultSchema$1
    ]),
    CallToolResultWireSchema: z26.unknown().superRefine((value, ctx) => {
      if (typeof value !== "object" || value === null || Array.isArray(value) || value.content !== void 0) return;
      for (const key of TOOL_RESULT_FOREIGN_FAMILY_KEYS) if (key in value) {
        ctx.addIssue({
          code: "custom",
          message: `content is required when the body carries '${key}' \u2014 another result family cannot default into an empty tools/call success`
        });
        return;
      }
    }).transform(normalizeContentlessToolResult).pipe(CallToolResultSchema$1)
  };
}
var memo$1;
function buildSchemas2025() {
  return memo$1 ??= build$1();
}
function isNonObjectJsonSchemaRoot(json) {
  return json["type"] !== "object";
}
var REF_REWRITE_DATA_POSITION_KEYS = /* @__PURE__ */ new Set([
  "const",
  "enum",
  "default",
  "examples"
]);
var REF_REWRITE_NAME_MAP_KEYS = /* @__PURE__ */ new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
  "dependencies"
]);
function establishesNewBase(id) {
  return id !== void 0 && !(typeof id === "string" && id.startsWith("#"));
}
function wrapOutputSchemaForLegacy(natural) {
  const $schema = typeof natural["$schema"] === "string" ? natural["$schema"] : void 0;
  if (establishesNewBase(natural["$id"])) return {
    ...$schema !== void 0 && { $schema },
    type: "object",
    properties: { result: natural },
    required: ["result"]
  };
  const convertRecursiveRefs = declares2019Dialect(natural["$schema"]) && natural["$recursiveAnchor"] !== true;
  const rewriteRefs = (node, parentIsNameMap) => {
    if (Array.isArray(node)) return node.map((item) => rewriteRefs(item, false));
    if (node === null || typeof node !== "object") return node;
    if (!parentIsNameMap && establishesNewBase(node["$id"])) return node;
    const out = {};
    let convertedRecursion = false;
    for (const [k, v] of Object.entries(node)) if (parentIsNameMap) out[k] = rewriteRefs(v, false);
    else if ((k === "$ref" || k === "$dynamicRef") && typeof v === "string") out[k] = v === "#" ? "#/properties/result" : v.startsWith("#/") ? `#/properties/result${v.slice(1)}` : v;
    else if (k === "$recursiveRef" && v === "#" && convertRecursiveRefs) convertedRecursion = true;
    else if (REF_REWRITE_DATA_POSITION_KEYS.has(k)) out[k] = v;
    else if (REF_REWRITE_NAME_MAP_KEYS.has(k)) out[k] = rewriteRefs(v, true);
    else out[k] = rewriteRefs(v, false);
    if (convertedRecursion) if ("$ref" in out) out["allOf"] = [...Array.isArray(out["allOf"]) ? out["allOf"] : [], { $ref: "#/properties/result" }];
    else out["$ref"] = "#/properties/result";
    return out;
  };
  return {
    ...$schema !== void 0 && { $schema },
    type: "object",
    properties: { result: rewriteRefs(natural, false) },
    required: ["result"]
  };
}
var requestMethodKeys$1 = {
  ping: null,
  initialize: null,
  "completion/complete": null,
  "logging/setLevel": null,
  "prompts/get": null,
  "prompts/list": null,
  "resources/list": null,
  "resources/templates/list": null,
  "resources/read": null,
  "resources/subscribe": null,
  "resources/unsubscribe": null,
  "tools/call": null,
  "tools/list": null,
  "tasks/get": null,
  "tasks/result": null,
  "tasks/list": null,
  "tasks/cancel": null,
  "sampling/createMessage": null,
  "elicitation/create": null,
  "roots/list": null
};
var notificationMethodKeys$1 = {
  "notifications/cancelled": null,
  "notifications/progress": null,
  "notifications/initialized": null,
  "notifications/roots/list_changed": null,
  "notifications/tasks/status": null,
  "notifications/message": null,
  "notifications/resources/updated": null,
  "notifications/resources/list_changed": null,
  "notifications/tools/list_changed": null,
  "notifications/prompts/list_changed": null,
  "notifications/elicitation/complete": null
};
var resultMethodKeys = {
  ping: null,
  initialize: null,
  "completion/complete": null,
  "logging/setLevel": null,
  "prompts/get": null,
  "prompts/list": null,
  "resources/list": null,
  "resources/templates/list": null,
  "resources/read": null,
  "resources/subscribe": null,
  "resources/unsubscribe": null,
  "tools/call": null,
  "tools/list": null,
  "sampling/createMessage": null,
  "elicitation/create": null,
  "roots/list": null
};
var maps$1;
function registryMaps() {
  if (maps$1) return maps$1;
  const s = buildSchemas2025();
  maps$1 = {
    requestSchemas: {
      ping: s.PingRequestSchema,
      initialize: s.InitializeRequestSchema,
      "completion/complete": s.CompleteRequestSchema,
      "logging/setLevel": s.SetLevelRequestSchema,
      "prompts/get": s.GetPromptRequestSchema,
      "prompts/list": s.ListPromptsRequestSchema,
      "resources/list": s.ListResourcesRequestSchema,
      "resources/templates/list": s.ListResourceTemplatesRequestSchema,
      "resources/read": s.ReadResourceRequestSchema,
      "resources/subscribe": s.SubscribeRequestSchema,
      "resources/unsubscribe": s.UnsubscribeRequestSchema,
      "tools/call": s.CallToolRequestSchema,
      "tools/list": s.ListToolsRequestSchema,
      "tasks/get": s.GetTaskRequestSchema,
      "tasks/result": s.GetTaskPayloadRequestSchema,
      "tasks/list": s.ListTasksRequestSchema,
      "tasks/cancel": s.CancelTaskRequestSchema,
      "sampling/createMessage": s.CreateMessageRequestSchema,
      "elicitation/create": s.ElicitRequestSchema,
      "roots/list": s.ListRootsRequestSchema
    },
    notificationSchemas: {
      "notifications/cancelled": s.CancelledNotificationSchema,
      "notifications/progress": s.ProgressNotificationSchema,
      "notifications/initialized": s.InitializedNotificationSchema,
      "notifications/roots/list_changed": s.RootsListChangedNotificationSchema,
      "notifications/tasks/status": s.TaskStatusNotificationSchema,
      "notifications/message": s.LoggingMessageNotificationSchema,
      "notifications/resources/updated": s.ResourceUpdatedNotificationSchema,
      "notifications/resources/list_changed": s.ResourceListChangedNotificationSchema,
      "notifications/tools/list_changed": s.ToolListChangedNotificationSchema,
      "notifications/prompts/list_changed": s.PromptListChangedNotificationSchema,
      "notifications/elicitation/complete": s.ElicitationCompleteNotificationSchema
    },
    resultSchemas: {
      ping: s.EmptyResultSchema,
      initialize: s.InitializeResultSchema,
      "completion/complete": s.CompleteResultSchema,
      "logging/setLevel": s.EmptyResultSchema,
      "prompts/get": s.GetPromptResultSchema,
      "prompts/list": s.ListPromptsResultSchema,
      "resources/list": s.ListResourcesResultSchema,
      "resources/templates/list": s.ListResourceTemplatesResultSchema,
      "resources/read": s.ReadResourceResultSchema,
      "resources/subscribe": s.EmptyResultSchema,
      "resources/unsubscribe": s.EmptyResultSchema,
      "tools/call": s.CallToolResultWireSchema,
      "tools/list": s.ListToolsResultSchema,
      "sampling/createMessage": s.CreateMessageResultWithToolsSchema,
      "elicitation/create": s.ElicitResultSchema,
      "roots/list": s.ListRootsResultSchema
    }
  };
  return maps$1;
}
function hasRequestMethod2025(method) {
  return Object.prototype.hasOwnProperty.call(requestMethodKeys$1, method);
}
function hasNotificationMethod2025(method) {
  return Object.prototype.hasOwnProperty.call(notificationMethodKeys$1, method);
}
function hasResultMethod(method) {
  return Object.prototype.hasOwnProperty.call(resultMethodKeys, method);
}
function getResultSchema(method) {
  return hasResultMethod(method) ? registryMaps().resultSchemas[method] : void 0;
}
function getRequestSchema(method) {
  return hasRequestMethod2025(method) ? registryMaps().requestSchemas[method] : void 0;
}
function getNotificationSchema(method) {
  return hasNotificationMethod2025(method) ? registryMaps().notificationSchemas[method] : void 0;
}
var rev2025RequestMethods = Object.keys(requestMethodKeys$1);
var rev2025NotificationMethods = Object.keys(notificationMethodKeys$1);
function isPlainObject$6(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function triState$1(schema, raw) {
  if (schema === void 0) return {
    ok: false,
    reason: "not-in-era"
  };
  const parsed = schema.safeParse(raw);
  return parsed.success ? {
    ok: true,
    value: parsed.data
  } : {
    ok: false,
    reason: "invalid",
    message: String(parsed.error)
  };
}
var NOT_IN_ERA$1 = {
  ok: false,
  reason: "not-in-era"
};
function toolNeedsLegacyWrap(t) {
  return isPlainObject$6(t) && isPlainObject$6(t["outputSchema"]) && isNonObjectJsonSchemaRoot(t["outputSchema"]);
}
function toNeutralResult(value) {
  return value;
}
var rev2025Codec = {
  era: "2025-11-25",
  hasRequestMethod: hasRequestMethod2025,
  hasNotificationMethod: hasNotificationMethod2025,
  validateRequest: (method, raw) => triState$1(getRequestSchema(method), raw),
  validateResult: (method, raw) => triState$1(getResultSchema(method), raw),
  validateNotification: (method, raw) => triState$1(getNotificationSchema(method), raw),
  hasInputRequestMethod: () => false,
  validateInputRequest: () => NOT_IN_ERA$1,
  validateInputResponse: () => NOT_IN_ERA$1,
  samplingResultVariant: (hasTools, raw) => {
    const s = buildSchemas2025();
    return triState$1(hasTools ? s.CreateMessageResultWithToolsSchema : s.CreateMessageResultSchema, raw);
  },
  outboundEnvelope: (_material) => void 0,
  validateEnvelopeMeta: (_meta) => [],
  projectCallToolResult(result, advertisedOutputSchema) {
    const withText = appendTextFallbackForNonObject(result);
    const sc = withText.structuredContent;
    if (sc === void 0) return withText;
    const valueIsNonObject = typeof sc !== "object" || sc === null || Array.isArray(sc);
    const schemaWrapped = advertisedOutputSchema !== void 0 && isNonObjectJsonSchemaRoot(advertisedOutputSchema);
    if (!valueIsNonObject && !schemaWrapped) return withText;
    return {
      ...withText,
      structuredContent: { result: sc }
    };
  },
  decodeResult(_method, raw) {
    if (isPlainObject$6(raw) && "resultType" in raw) {
      const stripped = { ...raw };
      delete stripped["resultType"];
      return {
        kind: "complete",
        result: toNeutralResult(stripped)
      };
    }
    return {
      kind: "complete",
      result: toNeutralResult(raw)
    };
  },
  encodeResult(method, result) {
    if (method !== "tools/list") return result;
    const tools = result.tools;
    if (!Array.isArray(tools) || !tools.some((t) => toolNeedsLegacyWrap(t))) return result;
    return {
      ...result,
      tools: tools.map((t) => toolNeedsLegacyWrap(t) ? {
        ...t,
        outputSchema: wrapOutputSchemaForLegacy(t.outputSchema)
      } : t)
    };
  },
  encodeErrorCode: (code) => code === -32002 ? -32602 : code,
  checkInboundEnvelope: (_material) => void 0
};
function build() {
  const JSONValueSchema$1 = z26.lazy(() => z26.union([
    z26.string(),
    z26.number(),
    z26.boolean(),
    z26.null(),
    z26.record(z26.string(), JSONValueSchema$1),
    z26.array(JSONValueSchema$1)
  ]));
  const JSONObjectSchema$1 = z26.record(z26.string(), JSONValueSchema$1);
  const ProgressTokenSchema$1 = z26.union([z26.string(), z26.number().int()]);
  const CursorSchema$1 = z26.string();
  const RequestIdSchema$1 = z26.union([z26.string(), z26.number().int()]);
  const RoleSchema$1 = z26.enum(["user", "assistant"]);
  const LoggingLevelSchema$1 = z26.enum([
    "debug",
    "info",
    "notice",
    "warning",
    "error",
    "critical",
    "alert",
    "emergency"
  ]);
  const Base64Schema2 = z26.string().refine((val) => {
    try {
      atob(val);
      return true;
    } catch {
      return false;
    }
  }, { message: "Invalid Base64 string" });
  const TaskMetadataSchema$1 = z26.object({ ttl: z26.number().optional() });
  const RelatedTaskMetadataSchema$1 = z26.object({ taskId: z26.string() });
  const RequestMetaSchema$1 = z26.looseObject({
    progressToken: ProgressTokenSchema$1.optional(),
    "io.modelcontextprotocol/related-task": RelatedTaskMetadataSchema$1.optional()
  });
  const BaseRequestParamsSchema$1 = z26.object({ _meta: RequestMetaSchema$1.optional() });
  const TaskAugmentedRequestParamsSchema$1 = BaseRequestParamsSchema$1.extend({ task: TaskMetadataSchema$1.optional() });
  const NotificationsParamsSchema$1 = z26.object({ _meta: RequestMetaSchema$1.optional() });
  const NotificationSchema$1 = z26.object({
    method: z26.string(),
    params: NotificationsParamsSchema$1.loose().optional()
  });
  const IconSchema$1 = z26.object({
    src: z26.string(),
    mimeType: z26.string().optional(),
    sizes: z26.array(z26.string()).optional(),
    theme: z26.enum(["light", "dark"]).optional()
  });
  const IconsSchema$1 = z26.object({ icons: z26.array(IconSchema$1).optional() });
  const BaseMetadataSchema$1 = z26.object({
    name: z26.string(),
    title: z26.string().optional()
  });
  const ImplementationSchema$1 = BaseMetadataSchema$1.extend({
    ...BaseMetadataSchema$1.shape,
    ...IconsSchema$1.shape,
    version: z26.string(),
    websiteUrl: z26.string().optional(),
    description: z26.string().optional()
  });
  const FormElicitationCapabilitySchema2 = z26.intersection(z26.object({ applyDefaults: z26.boolean().optional() }), JSONObjectSchema$1);
  const ElicitationCapabilitySchema2 = z26.preprocess((value) => {
    if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) return { form: {} };
    return value;
  }, z26.intersection(z26.object({
    form: FormElicitationCapabilitySchema2.optional(),
    url: JSONObjectSchema$1.optional()
  }), JSONObjectSchema$1.optional()));
  const ClientTasksCapabilitySchema$1 = z26.looseObject({
    list: JSONObjectSchema$1.optional(),
    cancel: JSONObjectSchema$1.optional(),
    requests: z26.looseObject({
      sampling: z26.looseObject({ createMessage: JSONObjectSchema$1.optional() }).optional(),
      elicitation: z26.looseObject({ create: JSONObjectSchema$1.optional() }).optional()
    }).optional()
  });
  const ServerTasksCapabilitySchema$1 = z26.looseObject({
    list: JSONObjectSchema$1.optional(),
    cancel: JSONObjectSchema$1.optional(),
    requests: z26.looseObject({ tools: z26.looseObject({ call: JSONObjectSchema$1.optional() }).optional() }).optional()
  });
  const ClientCapabilitiesSchema$1 = z26.object({
    experimental: z26.record(z26.string(), JSONObjectSchema$1).optional(),
    sampling: z26.object({
      context: JSONObjectSchema$1.optional(),
      tools: JSONObjectSchema$1.optional()
    }).optional(),
    elicitation: ElicitationCapabilitySchema2.optional(),
    roots: z26.object({ listChanged: z26.boolean().optional() }).optional(),
    tasks: ClientTasksCapabilitySchema$1.optional(),
    extensions: z26.record(z26.string(), JSONObjectSchema$1).optional()
  });
  const ServerCapabilitiesSchema$1 = z26.object({
    experimental: z26.record(z26.string(), JSONObjectSchema$1).optional(),
    logging: JSONObjectSchema$1.optional(),
    completions: JSONObjectSchema$1.optional(),
    prompts: z26.object({ listChanged: z26.boolean().optional() }).optional(),
    resources: z26.object({
      subscribe: z26.boolean().optional(),
      listChanged: z26.boolean().optional()
    }).optional(),
    tools: z26.object({ listChanged: z26.boolean().optional() }).optional(),
    tasks: ServerTasksCapabilitySchema$1.optional(),
    extensions: z26.record(z26.string(), JSONObjectSchema$1).optional()
  });
  const ProgressSchema$1 = z26.object({
    progress: z26.number(),
    total: z26.optional(z26.number()),
    message: z26.optional(z26.string())
  });
  const ProgressNotificationParamsSchema$1 = z26.object({
    ...NotificationsParamsSchema$1.shape,
    ...ProgressSchema$1.shape,
    progressToken: ProgressTokenSchema$1
  });
  const ProgressNotificationSchema$1 = NotificationSchema$1.extend({
    method: z26.literal("notifications/progress"),
    params: ProgressNotificationParamsSchema$1
  });
  const LoggingMessageNotificationParamsSchema$1 = NotificationsParamsSchema$1.extend({
    level: LoggingLevelSchema$1,
    logger: z26.string().optional(),
    data: z26.unknown()
  });
  const LoggingMessageNotificationSchema$1 = NotificationSchema$1.extend({
    method: z26.literal("notifications/message"),
    params: LoggingMessageNotificationParamsSchema$1
  });
  const ResourceContentsSchema$1 = z26.object({
    uri: z26.string(),
    mimeType: z26.optional(z26.string()),
    _meta: z26.record(z26.string(), z26.unknown()).optional()
  });
  const TextResourceContentsSchema$1 = ResourceContentsSchema$1.extend({ text: z26.string() });
  const BlobResourceContentsSchema$1 = ResourceContentsSchema$1.extend({ blob: Base64Schema2 });
  const AnnotationsSchema$1 = z26.object({
    audience: z26.array(RoleSchema$1).optional(),
    priority: z26.number().min(0).max(1).optional(),
    lastModified: z26.iso.datetime({ offset: true }).optional()
  });
  const ResourceSchema$1 = z26.object({
    ...BaseMetadataSchema$1.shape,
    ...IconsSchema$1.shape,
    uri: z26.string(),
    description: z26.optional(z26.string()),
    mimeType: z26.optional(z26.string()),
    size: z26.optional(z26.number()),
    annotations: AnnotationsSchema$1.optional(),
    _meta: z26.optional(z26.looseObject({}))
  });
  const ResourceTemplateSchema$1 = z26.object({
    ...BaseMetadataSchema$1.shape,
    ...IconsSchema$1.shape,
    uriTemplate: z26.string(),
    description: z26.optional(z26.string()),
    mimeType: z26.optional(z26.string()),
    annotations: AnnotationsSchema$1.optional(),
    _meta: z26.optional(z26.looseObject({}))
  });
  const ResourceListChangedNotificationSchema$1 = NotificationSchema$1.extend({
    method: z26.literal("notifications/resources/list_changed"),
    params: NotificationsParamsSchema$1.optional()
  });
  const ResourceUpdatedNotificationParamsSchema$1 = NotificationsParamsSchema$1.extend({ uri: z26.string() });
  const ResourceUpdatedNotificationSchema$1 = NotificationSchema$1.extend({
    method: z26.literal("notifications/resources/updated"),
    params: ResourceUpdatedNotificationParamsSchema$1
  });
  const PromptArgumentSchema$1 = z26.object({
    name: z26.string(),
    description: z26.optional(z26.string()),
    required: z26.optional(z26.boolean())
  });
  const PromptSchema$1 = z26.object({
    ...BaseMetadataSchema$1.shape,
    ...IconsSchema$1.shape,
    description: z26.optional(z26.string()),
    arguments: z26.optional(z26.array(PromptArgumentSchema$1)),
    _meta: z26.optional(z26.looseObject({}))
  });
  const PromptListChangedNotificationSchema$1 = NotificationSchema$1.extend({
    method: z26.literal("notifications/prompts/list_changed"),
    params: NotificationsParamsSchema$1.optional()
  });
  const TextContentSchema$1 = z26.object({
    type: z26.literal("text"),
    text: z26.string(),
    annotations: AnnotationsSchema$1.optional(),
    _meta: z26.record(z26.string(), z26.unknown()).optional()
  });
  const ImageContentSchema$1 = z26.object({
    type: z26.literal("image"),
    data: Base64Schema2,
    mimeType: z26.string(),
    annotations: AnnotationsSchema$1.optional(),
    _meta: z26.record(z26.string(), z26.unknown()).optional()
  });
  const AudioContentSchema$1 = z26.object({
    type: z26.literal("audio"),
    data: Base64Schema2,
    mimeType: z26.string(),
    annotations: AnnotationsSchema$1.optional(),
    _meta: z26.record(z26.string(), z26.unknown()).optional()
  });
  const ToolUseContentSchema$1 = z26.object({
    type: z26.literal("tool_use"),
    name: z26.string(),
    id: z26.string(),
    input: z26.record(z26.string(), z26.unknown()),
    _meta: z26.record(z26.string(), z26.unknown()).optional()
  });
  const EmbeddedResourceSchema$1 = z26.object({
    type: z26.literal("resource"),
    resource: z26.union([TextResourceContentsSchema$1, BlobResourceContentsSchema$1]),
    annotations: AnnotationsSchema$1.optional(),
    _meta: z26.record(z26.string(), z26.unknown()).optional()
  });
  const ResourceLinkSchema$1 = ResourceSchema$1.extend({ type: z26.literal("resource_link") });
  const ContentBlockSchema$1 = z26.union([
    TextContentSchema$1,
    ImageContentSchema$1,
    AudioContentSchema$1,
    ResourceLinkSchema$1,
    EmbeddedResourceSchema$1
  ]);
  const PromptMessageSchema$1 = z26.object({
    role: RoleSchema$1,
    content: ContentBlockSchema$1
  });
  const ToolAnnotationsSchema$1 = z26.object({
    title: z26.string().optional(),
    readOnlyHint: z26.boolean().optional(),
    destructiveHint: z26.boolean().optional(),
    idempotentHint: z26.boolean().optional(),
    openWorldHint: z26.boolean().optional()
  });
  const ToolListChangedNotificationSchema$1 = NotificationSchema$1.extend({
    method: z26.literal("notifications/tools/list_changed"),
    params: NotificationsParamsSchema$1.optional()
  });
  const ModelHintSchema$1 = z26.object({ name: z26.string().optional() });
  const ModelPreferencesSchema$1 = z26.object({
    hints: z26.array(ModelHintSchema$1).optional(),
    costPriority: z26.number().min(0).max(1).optional(),
    speedPriority: z26.number().min(0).max(1).optional(),
    intelligencePriority: z26.number().min(0).max(1).optional()
  });
  const ToolChoiceSchema$1 = z26.object({ mode: z26.enum([
    "auto",
    "required",
    "none"
  ]).optional() });
  const BooleanSchemaSchema$1 = z26.object({
    type: z26.literal("boolean"),
    title: z26.string().optional(),
    description: z26.string().optional(),
    default: z26.boolean().optional()
  });
  const StringSchemaSchema$1 = z26.object({
    type: z26.literal("string"),
    title: z26.string().optional(),
    description: z26.string().optional(),
    minLength: z26.number().optional(),
    maxLength: z26.number().optional(),
    format: z26.enum([
      "email",
      "uri",
      "date",
      "date-time"
    ]).optional(),
    default: z26.string().optional()
  });
  const NumberSchemaSchema$1 = z26.object({
    type: z26.enum(["number", "integer"]),
    title: z26.string().optional(),
    description: z26.string().optional(),
    minimum: z26.number().optional(),
    maximum: z26.number().optional(),
    default: z26.number().optional()
  });
  const UntitledSingleSelectEnumSchemaSchema$1 = z26.object({
    type: z26.literal("string"),
    title: z26.string().optional(),
    description: z26.string().optional(),
    enum: z26.array(z26.string()),
    default: z26.string().optional()
  });
  const TitledSingleSelectEnumSchemaSchema$1 = z26.object({
    type: z26.literal("string"),
    title: z26.string().optional(),
    description: z26.string().optional(),
    oneOf: z26.array(z26.object({
      const: z26.string(),
      title: z26.string()
    })),
    default: z26.string().optional()
  });
  const LegacyTitledEnumSchemaSchema$1 = z26.object({
    type: z26.literal("string"),
    title: z26.string().optional(),
    description: z26.string().optional(),
    enum: z26.array(z26.string()),
    enumNames: z26.array(z26.string()).optional(),
    default: z26.string().optional()
  });
  const SingleSelectEnumSchemaSchema$1 = z26.union([UntitledSingleSelectEnumSchemaSchema$1, TitledSingleSelectEnumSchemaSchema$1]);
  const UntitledMultiSelectEnumSchemaSchema$1 = z26.object({
    type: z26.literal("array"),
    title: z26.string().optional(),
    description: z26.string().optional(),
    minItems: z26.number().optional(),
    maxItems: z26.number().optional(),
    items: z26.object({
      type: z26.literal("string"),
      enum: z26.array(z26.string())
    }),
    default: z26.array(z26.string()).optional()
  });
  const TitledMultiSelectEnumSchemaSchema$1 = z26.object({
    type: z26.literal("array"),
    title: z26.string().optional(),
    description: z26.string().optional(),
    minItems: z26.number().optional(),
    maxItems: z26.number().optional(),
    items: z26.object({ anyOf: z26.array(z26.object({
      const: z26.string(),
      title: z26.string()
    })) }),
    default: z26.array(z26.string()).optional()
  });
  const MultiSelectEnumSchemaSchema$1 = z26.union([UntitledMultiSelectEnumSchemaSchema$1, TitledMultiSelectEnumSchemaSchema$1]);
  const EnumSchemaSchema$1 = z26.union([
    LegacyTitledEnumSchemaSchema$1,
    SingleSelectEnumSchemaSchema$1,
    MultiSelectEnumSchemaSchema$1
  ]);
  const PrimitiveSchemaDefinitionSchema$1 = z26.union([
    EnumSchemaSchema$1,
    BooleanSchemaSchema$1,
    StringSchemaSchema$1,
    NumberSchemaSchema$1
  ]);
  const ElicitRequestFormParamsSchema$1 = TaskAugmentedRequestParamsSchema$1.extend({
    mode: z26.literal("form").optional(),
    message: z26.string(),
    requestedSchema: z26.object({
      type: z26.literal("object"),
      properties: z26.record(z26.string(), PrimitiveSchemaDefinitionSchema$1),
      required: z26.array(z26.string()).optional()
    }).catchall(z26.unknown())
  });
  const ResourceTemplateReferenceSchema$1 = z26.object({
    type: z26.literal("ref/resource"),
    uri: z26.string()
  });
  const PromptReferenceSchema$1 = z26.object({
    type: z26.literal("ref/prompt"),
    name: z26.string()
  });
  const RootSchema$1 = z26.object({
    uri: z26.string().startsWith("file://"),
    name: z26.string().optional(),
    _meta: z26.record(z26.string(), z26.unknown()).optional()
  });
  const sharedClientCapabilityShape = ClientCapabilitiesSchema$1.shape;
  const ClientCapabilities2026Schema = z26.object({
    experimental: sharedClientCapabilityShape.experimental,
    sampling: sharedClientCapabilityShape.sampling,
    elicitation: sharedClientCapabilityShape.elicitation,
    roots: sharedClientCapabilityShape.roots,
    extensions: sharedClientCapabilityShape.extensions
  });
  const sharedServerCapabilityShape = ServerCapabilitiesSchema$1.shape;
  const ServerCapabilities2026Schema = z26.object({
    experimental: sharedServerCapabilityShape.experimental,
    logging: sharedServerCapabilityShape.logging,
    completions: sharedServerCapabilityShape.completions,
    prompts: sharedServerCapabilityShape.prompts,
    resources: sharedServerCapabilityShape.resources,
    tools: sharedServerCapabilityShape.tools,
    extensions: sharedServerCapabilityShape.extensions
  });
  const RequestMetaEnvelopeSchema = z26.looseObject({
    progressToken: ProgressTokenSchema$1.optional(),
    [PROTOCOL_VERSION_META_KEY]: z26.string(),
    [CLIENT_INFO_META_KEY]: ImplementationSchema$1.optional(),
    [CLIENT_CAPABILITIES_META_KEY]: ClientCapabilities2026Schema,
    [LOG_LEVEL_META_KEY]: LoggingLevelSchema$1.optional()
  });
  const ToolSchema$1 = z26.object({
    ...BaseMetadataSchema$1.shape,
    ...IconsSchema$1.shape,
    description: z26.string().optional(),
    inputSchema: z26.looseObject({
      $schema: z26.string().optional(),
      type: z26.literal("object")
    }),
    outputSchema: z26.looseObject({ $schema: z26.string().optional() }).optional(),
    annotations: ToolAnnotationsSchema$1.optional(),
    _meta: z26.record(z26.string(), z26.unknown()).optional()
  });
  const ToolResultContentSchema$1 = z26.object({
    type: z26.literal("tool_result"),
    toolUseId: z26.string(),
    content: z26.array(ContentBlockSchema$1),
    structuredContent: z26.unknown().optional(),
    isError: z26.boolean().optional(),
    _meta: z26.record(z26.string(), z26.unknown()).optional()
  });
  const SamplingMessageContentBlockSchema$1 = z26.union([
    TextContentSchema$1,
    ImageContentSchema$1,
    AudioContentSchema$1,
    ToolUseContentSchema$1,
    ToolResultContentSchema$1
  ]);
  const SamplingMessageSchema$1 = z26.object({
    role: RoleSchema$1,
    content: z26.union([SamplingMessageContentBlockSchema$1, z26.array(SamplingMessageContentBlockSchema$1)]),
    _meta: z26.record(z26.string(), z26.unknown()).optional()
  });
  const ResultTypeSchema = z26.string();
  const ResultMetaSchema = z26.looseObject({ [SERVER_INFO_META_KEY]: ImplementationSchema$1.optional().catch(void 0) });
  const wireMeta = ResultMetaSchema.optional();
  function wireResult(shape) {
    return z26.looseObject({
      _meta: wireMeta,
      resultType: ResultTypeSchema.default("complete"),
      ...shape
    });
  }
  const ResultSchema$1 = wireResult({});
  const PaginatedResultSchema$1 = wireResult({ nextCursor: CursorSchema$1.optional() });
  const CallToolResultSchema$1 = wireResult({
    content: z26.array(ContentBlockSchema$1),
    structuredContent: z26.unknown().optional(),
    isError: z26.boolean().optional()
  });
  const ListToolsResultSchema$1 = wireResult({
    ttlMs: z26.number().int().min(0),
    cacheScope: z26.enum(["public", "private"]),
    tools: z26.array(ToolSchema$1),
    nextCursor: CursorSchema$1.optional()
  });
  const ListPromptsResultSchema$1 = wireResult({
    ttlMs: z26.number().int().min(0),
    cacheScope: z26.enum(["public", "private"]),
    prompts: z26.array(PromptSchema$1),
    nextCursor: CursorSchema$1.optional()
  });
  const GetPromptResultSchema$1 = wireResult({
    description: z26.string().optional(),
    messages: z26.array(PromptMessageSchema$1)
  });
  const ListResourcesResultSchema$1 = wireResult({
    ttlMs: z26.number().int().min(0),
    cacheScope: z26.enum(["public", "private"]),
    resources: z26.array(ResourceSchema$1),
    nextCursor: CursorSchema$1.optional()
  });
  const ListResourceTemplatesResultSchema$1 = wireResult({
    ttlMs: z26.number().int().min(0),
    cacheScope: z26.enum(["public", "private"]),
    resourceTemplates: z26.array(ResourceTemplateSchema$1),
    nextCursor: CursorSchema$1.optional()
  });
  const ReadResourceResultSchema$1 = wireResult({
    ttlMs: z26.number().int().min(0),
    cacheScope: z26.enum(["public", "private"]),
    contents: z26.array(z26.union([TextResourceContentsSchema$1, BlobResourceContentsSchema$1]))
  });
  const CompleteResultSchema$1 = wireResult({ completion: z26.object({
    values: z26.array(z26.string()).max(100),
    total: z26.number().int().optional(),
    hasMore: z26.boolean().optional()
  }).loose() });
  const CacheableResultSchema = wireResult({
    ttlMs: z26.number().int().min(0),
    cacheScope: z26.enum(["public", "private"])
  });
  const DiscoverResultSchema$1 = wireResult({
    ttlMs: z26.number().int().min(0).catch(0),
    cacheScope: z26.enum(["public", "private"]).catch("private"),
    supportedVersions: z26.array(z26.string()),
    capabilities: ServerCapabilities2026Schema,
    instructions: z26.string().optional()
  });
  const CreateMessageRequestParamsSchema$1 = z26.object({
    messages: z26.array(SamplingMessageSchema$1),
    modelPreferences: ModelPreferencesSchema$1.optional(),
    systemPrompt: z26.string().optional(),
    includeContext: z26.enum([
      "none",
      "thisServer",
      "allServers"
    ]).optional(),
    temperature: z26.number().optional(),
    maxTokens: z26.number().int(),
    stopSequences: z26.array(z26.string()).optional(),
    metadata: JSONObjectSchema$1.optional(),
    tools: z26.array(ToolSchema$1).optional(),
    toolChoice: ToolChoiceSchema$1.optional()
  });
  const CreateMessageRequestSchema$1 = z26.object({
    method: z26.literal("sampling/createMessage"),
    params: CreateMessageRequestParamsSchema$1
  });
  const ListRootsRequestSchema$1 = z26.object({
    method: z26.literal("roots/list"),
    params: z26.object({ _meta: z26.record(z26.string(), z26.unknown()).optional() }).optional()
  });
  const CreateMessageResultSchema$1 = z26.object({
    ...SamplingMessageSchema$1.shape,
    model: z26.string(),
    stopReason: z26.string().optional()
  });
  const ListRootsResultSchema$1 = z26.object({ roots: z26.array(RootSchema$1) });
  const ElicitResultSchema$1 = z26.object({
    action: z26.enum([
      "accept",
      "decline",
      "cancel"
    ]),
    content: z26.record(z26.string(), z26.union([
      z26.string(),
      z26.number(),
      z26.boolean(),
      z26.array(z26.string())
    ])).optional()
  });
  const ElicitRequestURLParamsSchema$1 = z26.object({
    mode: z26.literal("url"),
    message: z26.string(),
    url: z26.string().url()
  });
  const ElicitRequestParamsSchema$1 = z26.union([ElicitRequestFormParamsSchema$1, ElicitRequestURLParamsSchema$1]);
  const ElicitRequestSchema$1 = z26.object({
    method: z26.literal("elicitation/create"),
    params: ElicitRequestParamsSchema$1
  });
  const InputRequestSchema = z26.union([
    CreateMessageRequestSchema$1,
    ListRootsRequestSchema$1,
    ElicitRequestSchema$1
  ]);
  const InputResponseSchema = z26.union([
    CreateMessageResultSchema$1,
    ListRootsResultSchema$1,
    ElicitResultSchema$1
  ]);
  const InputRequestsSchema = z26.record(z26.string(), InputRequestSchema);
  const InputResponsesSchema = z26.record(z26.string(), InputResponseSchema);
  const InputRequiredResultSchema = wireResult({
    inputRequests: InputRequestsSchema.optional(),
    requestState: z26.string().optional()
  });
  const retryParamsShape = {
    inputResponses: InputResponsesSchema.optional(),
    requestState: z26.string().optional()
  };
  const InputResponseRequestParamsSchema = z26.object({
    _meta: RequestMetaEnvelopeSchema,
    ...retryParamsShape
  });
  const DispatchRequestMetaSchema = z26.looseObject({ progressToken: ProgressTokenSchema$1.optional() });
  function wireRequest(method, paramsShape) {
    return z26.object({
      method: z26.literal(method),
      params: z26.object({
        _meta: RequestMetaEnvelopeSchema,
        ...paramsShape
      })
    });
  }
  function dispatchRequest(method, paramsShape) {
    return z26.object({
      method: z26.literal(method),
      params: z26.object({
        _meta: DispatchRequestMetaSchema.optional(),
        ...paramsShape
      }).optional()
    });
  }
  const callToolParamsShape = {
    name: z26.string(),
    arguments: z26.record(z26.string(), z26.unknown()).optional(),
    ...retryParamsShape
  };
  const paginatedParamsShape = { cursor: CursorSchema$1.optional() };
  const CallToolRequestSchema$1 = wireRequest("tools/call", callToolParamsShape);
  const ListToolsRequestSchema$1 = wireRequest("tools/list", paginatedParamsShape);
  const ListPromptsRequestSchema$1 = wireRequest("prompts/list", paginatedParamsShape);
  const GetPromptRequestSchema$1 = wireRequest("prompts/get", {
    name: z26.string(),
    arguments: z26.record(z26.string(), z26.string()).optional(),
    ...retryParamsShape
  });
  const ListResourcesRequestSchema$1 = wireRequest("resources/list", paginatedParamsShape);
  const ListResourceTemplatesRequestSchema$1 = wireRequest("resources/templates/list", paginatedParamsShape);
  const ReadResourceRequestSchema$1 = wireRequest("resources/read", {
    uri: z26.string(),
    ...retryParamsShape
  });
  const completeParamsShape = {
    ref: z26.union([PromptReferenceSchema$1, ResourceTemplateReferenceSchema$1]),
    argument: z26.object({
      name: z26.string(),
      value: z26.string()
    }),
    context: z26.object({ arguments: z26.record(z26.string(), z26.string()).optional() }).optional()
  };
  const CompleteRequestSchema$1 = wireRequest("completion/complete", completeParamsShape);
  const DiscoverRequestSchema$1 = wireRequest("server/discover", {});
  const SubscriptionFilterSchema$1 = z26.object({
    toolsListChanged: z26.boolean().optional(),
    promptsListChanged: z26.boolean().optional(),
    resourcesListChanged: z26.boolean().optional(),
    resourceSubscriptions: z26.array(z26.string()).optional()
  });
  const subscriptionsListenParamsShape = { notifications: SubscriptionFilterSchema$1 };
  const SubscriptionsListenRequestSchema$1 = wireRequest("subscriptions/listen", subscriptionsListenParamsShape);
  const SubscriptionsListenResultMetaSchema$1 = ResultMetaSchema.extend({ "io.modelcontextprotocol/subscriptionId": RequestIdSchema$1 });
  const SubscriptionsListenResultSchema$1 = z26.looseObject({
    _meta: SubscriptionsListenResultMetaSchema$1,
    resultType: ResultTypeSchema.default("complete")
  });
  const dispatchRequestSchemas = {
    "tools/call": dispatchRequest("tools/call", callToolParamsShape),
    "tools/list": dispatchRequest("tools/list", paginatedParamsShape),
    "prompts/get": dispatchRequest("prompts/get", {
      name: z26.string(),
      arguments: z26.record(z26.string(), z26.string()).optional()
    }),
    "prompts/list": dispatchRequest("prompts/list", paginatedParamsShape),
    "resources/list": dispatchRequest("resources/list", paginatedParamsShape),
    "resources/templates/list": dispatchRequest("resources/templates/list", paginatedParamsShape),
    "resources/read": dispatchRequest("resources/read", { uri: z26.string() }),
    "completion/complete": dispatchRequest("completion/complete", completeParamsShape),
    "server/discover": dispatchRequest("server/discover", {}),
    "subscriptions/listen": dispatchRequest("subscriptions/listen", subscriptionsListenParamsShape)
  };
  function liftedResult(shape) {
    return z26.looseObject({
      _meta: wireMeta,
      ...shape
    });
  }
  const dispatchResultSchemas = {
    "tools/call": liftedResult({
      content: z26.array(ContentBlockSchema$1),
      structuredContent: z26.unknown().optional(),
      isError: z26.boolean().optional()
    }),
    "tools/list": liftedResult({
      ttlMs: z26.number().int().min(0),
      cacheScope: z26.enum(["public", "private"]),
      tools: z26.array(ToolSchema$1),
      nextCursor: CursorSchema$1.optional()
    }),
    "prompts/get": liftedResult({
      description: z26.string().optional(),
      messages: z26.array(PromptMessageSchema$1)
    }),
    "prompts/list": liftedResult({
      ttlMs: z26.number().int().min(0),
      cacheScope: z26.enum(["public", "private"]),
      prompts: z26.array(PromptSchema$1),
      nextCursor: CursorSchema$1.optional()
    }),
    "resources/list": liftedResult({
      ttlMs: z26.number().int().min(0),
      cacheScope: z26.enum(["public", "private"]),
      resources: z26.array(ResourceSchema$1),
      nextCursor: CursorSchema$1.optional()
    }),
    "resources/templates/list": liftedResult({
      ttlMs: z26.number().int().min(0),
      cacheScope: z26.enum(["public", "private"]),
      resourceTemplates: z26.array(ResourceTemplateSchema$1),
      nextCursor: CursorSchema$1.optional()
    }),
    "resources/read": liftedResult({
      ttlMs: z26.number().int().min(0),
      cacheScope: z26.enum(["public", "private"]),
      contents: z26.array(z26.union([TextResourceContentsSchema$1, BlobResourceContentsSchema$1]))
    }),
    "completion/complete": liftedResult({ completion: z26.object({
      values: z26.array(z26.string()).max(100),
      total: z26.number().int().optional(),
      hasMore: z26.boolean().optional()
    }).loose() }),
    "server/discover": liftedResult({
      ttlMs: z26.number().int().min(0).catch(0),
      cacheScope: z26.enum(["public", "private"]).catch("private"),
      supportedVersions: z26.array(z26.string()),
      capabilities: ServerCapabilities2026Schema,
      instructions: z26.string().optional()
    }),
    "subscriptions/listen": liftedResult({})
  };
  const NotificationMetaSchema = z26.looseObject({ "io.modelcontextprotocol/subscriptionId": RequestIdSchema$1.optional() });
  const SubscriptionsAcknowledgedNotificationSchema$1 = z26.object({
    method: z26.literal("notifications/subscriptions/acknowledged"),
    params: z26.object({
      _meta: NotificationMetaSchema.optional(),
      notifications: SubscriptionFilterSchema$1
    })
  });
  const CancelledNotificationParamsSchema$1 = z26.object({
    _meta: NotificationMetaSchema.optional(),
    requestId: RequestIdSchema$1,
    reason: z26.string().optional()
  });
  const CancelledNotificationSchema$1 = z26.object({
    method: z26.literal("notifications/cancelled"),
    params: CancelledNotificationParamsSchema$1
  });
  const notificationSchemas2026 = {
    "notifications/cancelled": CancelledNotificationSchema$1,
    "notifications/progress": ProgressNotificationSchema$1,
    "notifications/message": LoggingMessageNotificationSchema$1,
    "notifications/resources/updated": ResourceUpdatedNotificationSchema$1,
    "notifications/resources/list_changed": ResourceListChangedNotificationSchema$1,
    "notifications/tools/list_changed": ToolListChangedNotificationSchema$1,
    "notifications/prompts/list_changed": PromptListChangedNotificationSchema$1,
    "notifications/subscriptions/acknowledged": SubscriptionsAcknowledgedNotificationSchema$1
  };
  const wireResultResponse = (result) => z26.object({
    jsonrpc: z26.literal("2.0"),
    id: z26.union([z26.string(), z26.number().int()]),
    result
  }).strict();
  return {
    JSONValueSchema: JSONValueSchema$1,
    JSONObjectSchema: JSONObjectSchema$1,
    ProgressTokenSchema: ProgressTokenSchema$1,
    CursorSchema: CursorSchema$1,
    RequestIdSchema: RequestIdSchema$1,
    RoleSchema: RoleSchema$1,
    LoggingLevelSchema: LoggingLevelSchema$1,
    TaskMetadataSchema: TaskMetadataSchema$1,
    RelatedTaskMetadataSchema: RelatedTaskMetadataSchema$1,
    RequestMetaSchema: RequestMetaSchema$1,
    BaseRequestParamsSchema: BaseRequestParamsSchema$1,
    TaskAugmentedRequestParamsSchema: TaskAugmentedRequestParamsSchema$1,
    NotificationsParamsSchema: NotificationsParamsSchema$1,
    NotificationSchema: NotificationSchema$1,
    IconSchema: IconSchema$1,
    IconsSchema: IconsSchema$1,
    BaseMetadataSchema: BaseMetadataSchema$1,
    ImplementationSchema: ImplementationSchema$1,
    ClientTasksCapabilitySchema: ClientTasksCapabilitySchema$1,
    ServerTasksCapabilitySchema: ServerTasksCapabilitySchema$1,
    ClientCapabilitiesSchema: ClientCapabilitiesSchema$1,
    ServerCapabilitiesSchema: ServerCapabilitiesSchema$1,
    ProgressSchema: ProgressSchema$1,
    ProgressNotificationParamsSchema: ProgressNotificationParamsSchema$1,
    ProgressNotificationSchema: ProgressNotificationSchema$1,
    LoggingMessageNotificationParamsSchema: LoggingMessageNotificationParamsSchema$1,
    LoggingMessageNotificationSchema: LoggingMessageNotificationSchema$1,
    ResourceContentsSchema: ResourceContentsSchema$1,
    TextResourceContentsSchema: TextResourceContentsSchema$1,
    BlobResourceContentsSchema: BlobResourceContentsSchema$1,
    AnnotationsSchema: AnnotationsSchema$1,
    ResourceSchema: ResourceSchema$1,
    ResourceTemplateSchema: ResourceTemplateSchema$1,
    ResourceListChangedNotificationSchema: ResourceListChangedNotificationSchema$1,
    ResourceUpdatedNotificationParamsSchema: ResourceUpdatedNotificationParamsSchema$1,
    ResourceUpdatedNotificationSchema: ResourceUpdatedNotificationSchema$1,
    PromptArgumentSchema: PromptArgumentSchema$1,
    PromptSchema: PromptSchema$1,
    PromptListChangedNotificationSchema: PromptListChangedNotificationSchema$1,
    TextContentSchema: TextContentSchema$1,
    ImageContentSchema: ImageContentSchema$1,
    AudioContentSchema: AudioContentSchema$1,
    ToolUseContentSchema: ToolUseContentSchema$1,
    EmbeddedResourceSchema: EmbeddedResourceSchema$1,
    ResourceLinkSchema: ResourceLinkSchema$1,
    ContentBlockSchema: ContentBlockSchema$1,
    PromptMessageSchema: PromptMessageSchema$1,
    ToolAnnotationsSchema: ToolAnnotationsSchema$1,
    ToolListChangedNotificationSchema: ToolListChangedNotificationSchema$1,
    ModelHintSchema: ModelHintSchema$1,
    ModelPreferencesSchema: ModelPreferencesSchema$1,
    ToolChoiceSchema: ToolChoiceSchema$1,
    BooleanSchemaSchema: BooleanSchemaSchema$1,
    StringSchemaSchema: StringSchemaSchema$1,
    NumberSchemaSchema: NumberSchemaSchema$1,
    UntitledSingleSelectEnumSchemaSchema: UntitledSingleSelectEnumSchemaSchema$1,
    TitledSingleSelectEnumSchemaSchema: TitledSingleSelectEnumSchemaSchema$1,
    LegacyTitledEnumSchemaSchema: LegacyTitledEnumSchemaSchema$1,
    SingleSelectEnumSchemaSchema: SingleSelectEnumSchemaSchema$1,
    UntitledMultiSelectEnumSchemaSchema: UntitledMultiSelectEnumSchemaSchema$1,
    TitledMultiSelectEnumSchemaSchema: TitledMultiSelectEnumSchemaSchema$1,
    MultiSelectEnumSchemaSchema: MultiSelectEnumSchemaSchema$1,
    EnumSchemaSchema: EnumSchemaSchema$1,
    PrimitiveSchemaDefinitionSchema: PrimitiveSchemaDefinitionSchema$1,
    ElicitRequestFormParamsSchema: ElicitRequestFormParamsSchema$1,
    ResourceTemplateReferenceSchema: ResourceTemplateReferenceSchema$1,
    PromptReferenceSchema: PromptReferenceSchema$1,
    RootSchema: RootSchema$1,
    ClientCapabilities2026Schema,
    ServerCapabilities2026Schema,
    RequestMetaEnvelopeSchema,
    ToolSchema: ToolSchema$1,
    ToolResultContentSchema: ToolResultContentSchema$1,
    SamplingMessageContentBlockSchema: SamplingMessageContentBlockSchema$1,
    SamplingMessageSchema: SamplingMessageSchema$1,
    ResultTypeSchema,
    ResultMetaSchema,
    ResultSchema: ResultSchema$1,
    PaginatedResultSchema: PaginatedResultSchema$1,
    CallToolResultSchema: CallToolResultSchema$1,
    ListToolsResultSchema: ListToolsResultSchema$1,
    ListPromptsResultSchema: ListPromptsResultSchema$1,
    GetPromptResultSchema: GetPromptResultSchema$1,
    ListResourcesResultSchema: ListResourcesResultSchema$1,
    ListResourceTemplatesResultSchema: ListResourceTemplatesResultSchema$1,
    ReadResourceResultSchema: ReadResourceResultSchema$1,
    CompleteResultSchema: CompleteResultSchema$1,
    CacheableResultSchema,
    DiscoverResultSchema: DiscoverResultSchema$1,
    CreateMessageRequestParamsSchema: CreateMessageRequestParamsSchema$1,
    CreateMessageRequestSchema: CreateMessageRequestSchema$1,
    ListRootsRequestSchema: ListRootsRequestSchema$1,
    CreateMessageResultSchema: CreateMessageResultSchema$1,
    ListRootsResultSchema: ListRootsResultSchema$1,
    ElicitResultSchema: ElicitResultSchema$1,
    ElicitRequestURLParamsSchema: ElicitRequestURLParamsSchema$1,
    ElicitRequestParamsSchema: ElicitRequestParamsSchema$1,
    ElicitRequestSchema: ElicitRequestSchema$1,
    InputRequestSchema,
    InputResponseSchema,
    InputRequestsSchema,
    InputResponsesSchema,
    InputRequiredResultSchema,
    InputResponseRequestParamsSchema,
    CallToolRequestSchema: CallToolRequestSchema$1,
    ListToolsRequestSchema: ListToolsRequestSchema$1,
    ListPromptsRequestSchema: ListPromptsRequestSchema$1,
    GetPromptRequestSchema: GetPromptRequestSchema$1,
    ListResourcesRequestSchema: ListResourcesRequestSchema$1,
    ListResourceTemplatesRequestSchema: ListResourceTemplatesRequestSchema$1,
    ReadResourceRequestSchema: ReadResourceRequestSchema$1,
    CompleteRequestSchema: CompleteRequestSchema$1,
    DiscoverRequestSchema: DiscoverRequestSchema$1,
    SubscriptionFilterSchema: SubscriptionFilterSchema$1,
    SubscriptionsListenRequestSchema: SubscriptionsListenRequestSchema$1,
    SubscriptionsListenResultMetaSchema: SubscriptionsListenResultMetaSchema$1,
    SubscriptionsListenResultSchema: SubscriptionsListenResultSchema$1,
    dispatchRequestSchemas,
    dispatchResultSchemas,
    NotificationMetaSchema,
    SubscriptionsAcknowledgedNotificationSchema: SubscriptionsAcknowledgedNotificationSchema$1,
    CancelledNotificationParamsSchema: CancelledNotificationParamsSchema$1,
    CancelledNotificationSchema: CancelledNotificationSchema$1,
    notificationSchemas2026,
    JSONRPCResultResponseSchema: wireResultResponse(ResultSchema$1),
    CallToolResultResponseSchema: wireResultResponse(z26.union([CallToolResultSchema$1, InputRequiredResultSchema])),
    ListToolsResultResponseSchema: wireResultResponse(ListToolsResultSchema$1),
    ListPromptsResultResponseSchema: wireResultResponse(ListPromptsResultSchema$1),
    GetPromptResultResponseSchema: wireResultResponse(z26.union([GetPromptResultSchema$1, InputRequiredResultSchema])),
    ListResourcesResultResponseSchema: wireResultResponse(ListResourcesResultSchema$1),
    ListResourceTemplatesResultResponseSchema: wireResultResponse(ListResourceTemplatesResultSchema$1),
    ReadResourceResultResponseSchema: wireResultResponse(z26.union([ReadResourceResultSchema$1, InputRequiredResultSchema])),
    CompleteResultResponseSchema: wireResultResponse(CompleteResultSchema$1),
    DiscoverResultResponseSchema: wireResultResponse(DiscoverResultSchema$1)
  };
}
var memo;
function buildSchemas2026() {
  return memo ??= build();
}
var CACHEABLE_RESULT_METHODS = [
  "tools/list",
  "prompts/list",
  "resources/list",
  "resources/templates/list",
  "resources/read",
  "server/discover"
];
function isCacheableResultMethod(method) {
  return CACHEABLE_RESULT_METHODS.includes(method);
}
var RESULT_CACHE_HINT_FALLBACK = Symbol("modelcontextprotocol.resultCacheHintFallback");
function attachCacheHintFallback(result, hint) {
  if (hint === void 0) return result;
  const attached = result[RESULT_CACHE_HINT_FALLBACK];
  if (attached === void 0) return {
    ...result,
    [RESULT_CACHE_HINT_FALLBACK]: hint
  };
  const merged = {};
  const ttlMs = attached.ttlMs ?? hint.ttlMs;
  if (ttlMs !== void 0) merged.ttlMs = ttlMs;
  const cacheScope = attached.cacheScope ?? hint.cacheScope;
  if (cacheScope !== void 0) merged.cacheScope = cacheScope;
  return {
    ...result,
    [RESULT_CACHE_HINT_FALLBACK]: merged
  };
}
function cacheHintFallbackOf(result) {
  return result[RESULT_CACHE_HINT_FALLBACK];
}
function isValidCacheTtlMs(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isValidCacheScope(value) {
  return value === "public" || value === "private";
}
function assertValidCacheHint(hint, context) {
  if (hint.ttlMs !== void 0 && !isValidCacheTtlMs(hint.ttlMs)) throw new RangeError(`Invalid cache hint for ${context}: ttlMs must be a non-negative safe integer (got ${String(hint.ttlMs)})`);
  if (hint.cacheScope !== void 0 && !isValidCacheScope(hint.cacheScope)) throw new RangeError(`Invalid cache hint for ${context}: cacheScope must be 'public' or 'private' (got ${String(hint.cacheScope)})`);
}
var ProtocolErrorCode = /* @__PURE__ */ function(ProtocolErrorCode$1) {
  ProtocolErrorCode$1[ProtocolErrorCode$1["ParseError"] = -32700] = "ParseError";
  ProtocolErrorCode$1[ProtocolErrorCode$1["InvalidRequest"] = -32600] = "InvalidRequest";
  ProtocolErrorCode$1[ProtocolErrorCode$1["MethodNotFound"] = -32601] = "MethodNotFound";
  ProtocolErrorCode$1[ProtocolErrorCode$1["InvalidParams"] = -32602] = "InvalidParams";
  ProtocolErrorCode$1[ProtocolErrorCode$1["InternalError"] = -32603] = "InternalError";
  ProtocolErrorCode$1[ProtocolErrorCode$1["ResourceNotFound"] = -32002] = "ResourceNotFound";
  ProtocolErrorCode$1[ProtocolErrorCode$1["MissingRequiredClientCapability"] = -32021] = "MissingRequiredClientCapability";
  ProtocolErrorCode$1[ProtocolErrorCode$1["UnsupportedProtocolVersion"] = -32022] = "UnsupportedProtocolVersion";
  ProtocolErrorCode$1[ProtocolErrorCode$1["UrlElicitationRequired"] = -32042] = "UrlElicitationRequired";
  return ProtocolErrorCode$1;
}({});
var ProtocolError = class ProtocolError2 extends Error {
  static {
    Object.defineProperty(this, "mcpBrand", { value: "mcp.ProtocolError" });
  }
  static [Symbol.hasInstance](value) {
    return brandedHasInstance(this, value);
  }
  /**
  * Brand-based type guard: equivalent to `value instanceof this`, as an
  * explicit static predicate (the axios/AWS-SDK `isInstance` style). Reads
  * the caller's own brand via `this`, so every branded subclass gets a
  * correctly-scoped guard by inheritance. Must be invoked on the class —
  * in callback position write `v => SdkError.isInstance(v)`, not
  * `.filter(SdkError.isInstance)` (detached calls throw rather than
  * silently matching nothing).
  */
  static isInstance(value) {
    if (typeof this !== "function") throw new TypeError("isInstance must be called on the class (e.g. `SdkError.isInstance(value)`); for callbacks use `v => SdkError.isInstance(v)`");
    return brandedHasInstance(this, value);
  }
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
    this.name = "ProtocolError";
    stampErrorBrands(this, new.target);
  }
  /**
  * Factory method to create the appropriate error type based on the error code and data
  */
  static fromError(code, message, data) {
    if (code === ProtocolErrorCode.UrlElicitationRequired && data) {
      const errorData = data;
      if (errorData.elicitations) return new UrlElicitationRequiredError(errorData.elicitations, message);
    }
    if (code === ProtocolErrorCode.UnsupportedProtocolVersion && data) {
      const errorData = data;
      if (Array.isArray(errorData.supported) && typeof errorData.requested === "string") return new UnsupportedProtocolVersionError({
        supported: errorData.supported,
        requested: errorData.requested
      }, message);
    }
    if (code === ProtocolErrorCode.InvalidParams || code === ProtocolErrorCode.ResourceNotFound) {
      const errorData = data;
      if (typeof errorData?.uri === "string" && (code === ProtocolErrorCode.ResourceNotFound || Object.keys(errorData).length === 1)) return new ResourceNotFoundError(errorData.uri, message);
    }
    if (code === ProtocolErrorCode.MissingRequiredClientCapability && data) {
      const errorData = data;
      if (errorData.requiredCapabilities !== null && typeof errorData.requiredCapabilities === "object" && !Array.isArray(errorData.requiredCapabilities)) return new MissingRequiredClientCapabilityError({ requiredCapabilities: errorData.requiredCapabilities }, message);
    }
    return new ProtocolError2(code, message, data);
  }
};
var ResourceNotFoundError = class extends ProtocolError {
  static {
    Object.defineProperty(this, "mcpBrand", { value: "mcp.ResourceNotFoundError" });
  }
  constructor(uri, message = `Resource not found: ${uri}`) {
    super(ProtocolErrorCode.InvalidParams, message, { uri });
  }
  /** The URI that was requested and not found. */
  get uri() {
    return this.data.uri;
  }
};
var UrlElicitationRequiredError = class extends ProtocolError {
  static {
    Object.defineProperty(this, "mcpBrand", { value: "mcp.UrlElicitationRequiredError" });
  }
  constructor(elicitations, message = `URL elicitation${elicitations.length > 1 ? "s" : ""} required`) {
    super(ProtocolErrorCode.UrlElicitationRequired, message, { elicitations });
  }
  get elicitations() {
    return this.data?.elicitations ?? [];
  }
};
var UnsupportedProtocolVersionError = class extends ProtocolError {
  static {
    Object.defineProperty(this, "mcpBrand", { value: "mcp.UnsupportedProtocolVersionError" });
  }
  constructor(data, message = `Unsupported protocol version: ${data.requested}`) {
    super(ProtocolErrorCode.UnsupportedProtocolVersion, message, data);
  }
  /**
  * Protocol versions the receiver supports.
  */
  get supported() {
    return this.data.supported;
  }
  /**
  * The protocol version that was requested.
  */
  get requested() {
    return this.data.requested;
  }
};
var MissingRequiredClientCapabilityError = class extends ProtocolError {
  static {
    Object.defineProperty(this, "mcpBrand", { value: "mcp.MissingRequiredClientCapabilityError" });
  }
  constructor(data, message = `Missing required client capabilities: ${Object.keys(data.requiredCapabilities).join(", ")}`) {
    super(ProtocolErrorCode.MissingRequiredClientCapability, message, data);
  }
  /**
  * The capabilities the server requires from the client to process the
  * request (only the missing capabilities are listed).
  */
  get requiredCapabilities() {
    return this.data.requiredCapabilities;
  }
};
var DEFAULT_CACHE_TTL_MS = 0;
var DEFAULT_CACHE_SCOPE = "private";
var EXTENDED_RESULT_TYPE_METHODS = [
  "tools/call",
  "prompts/get",
  "resources/read"
];
function stampResultType(method, result) {
  const provided = result["resultType"];
  if (provided === void 0) return {
    ...result,
    resultType: "complete"
  };
  if (provided === "complete") return result;
  if (EXTENDED_RESULT_TYPE_METHODS.includes(method)) return result;
  throw new ProtocolError(ProtocolErrorCode.InternalError, `Handler for ${method} returned resultType '${String(provided)}', but results of ${method} only support 'complete' on protocol revision 2026-07-28`);
}
function fillCacheFields(method, result) {
  const fallback = cacheHintFallbackOf(result);
  if (result["resultType"] !== "complete" || !isCacheableResultMethod(method)) return fallback === void 0 ? result : stripCacheHintFallback(result);
  const provided = result;
  const ttlMs = isValidCacheTtlMs(provided["ttlMs"]) ? provided["ttlMs"] : resolveTtlMs(fallback);
  const cacheScope = isValidCacheScope(provided["cacheScope"]) ? provided["cacheScope"] : resolveCacheScope(fallback);
  const filled = {
    ...provided,
    ttlMs,
    cacheScope
  };
  delete filled[RESULT_CACHE_HINT_FALLBACK];
  return filled;
}
function isPlainObject$5(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function stampServerInfoMeta(result, serverInfo) {
  if (serverInfo === void 0) return result;
  const meta = result["_meta"];
  if (meta === void 0) return {
    ...result,
    _meta: { [SERVER_INFO_META_KEY]: serverInfo }
  };
  if (!isPlainObject$5(meta)) return result;
  if (meta[SERVER_INFO_META_KEY] !== void 0) return result;
  return {
    ...result,
    _meta: {
      ...meta,
      [SERVER_INFO_META_KEY]: serverInfo
    }
  };
}
function resolveTtlMs(fallback) {
  return fallback !== void 0 && isValidCacheTtlMs(fallback.ttlMs) ? fallback.ttlMs : DEFAULT_CACHE_TTL_MS;
}
function resolveCacheScope(fallback) {
  return fallback !== void 0 && isValidCacheScope(fallback.cacheScope) ? fallback.cacheScope : DEFAULT_CACHE_SCOPE;
}
function stripCacheHintFallback(result) {
  const copy = { ...result };
  delete copy[RESULT_CACHE_HINT_FALLBACK];
  return copy;
}
var INPUT_REQUEST_METHODS_2026 = [
  "elicitation/create",
  "sampling/createMessage",
  "roots/list"
];
var maps;
function inputSchemaMaps() {
  if (maps) return maps;
  const s = buildSchemas2026();
  maps = {
    request: {
      "elicitation/create": z26.object({
        method: z26.literal("elicitation/create"),
        params: s.ElicitRequestParamsSchema
      }),
      "sampling/createMessage": z26.object({
        method: z26.literal("sampling/createMessage"),
        params: s.CreateMessageRequestParamsSchema
      }),
      "roots/list": z26.object({
        method: z26.literal("roots/list"),
        params: z26.looseObject({}).optional()
      })
    },
    response: {
      "elicitation/create": s.ElicitResultSchema,
      "sampling/createMessage": s.CreateMessageResultSchema,
      "roots/list": s.ListRootsResultSchema
    }
  };
  return maps;
}
function isInputRequestMethod2026(method) {
  return INPUT_REQUEST_METHODS_2026.includes(method);
}
function getInputRequestSchema2026(method) {
  return isInputRequestMethod2026(method) ? inputSchemaMaps().request[method] : void 0;
}
function getInputResponseSchema2026(method) {
  return isInputRequestMethod2026(method) ? inputSchemaMaps().response[method] : void 0;
}
var requestMethodKeys = {
  "tools/call": null,
  "tools/list": null,
  "prompts/get": null,
  "prompts/list": null,
  "resources/list": null,
  "resources/templates/list": null,
  "resources/read": null,
  "completion/complete": null,
  "server/discover": null,
  "subscriptions/listen": null
};
var notificationMethodKeys = {
  "notifications/cancelled": null,
  "notifications/progress": null,
  "notifications/message": null,
  "notifications/resources/updated": null,
  "notifications/resources/list_changed": null,
  "notifications/tools/list_changed": null,
  "notifications/prompts/list_changed": null,
  "notifications/subscriptions/acknowledged": null
};
function hasRequestMethod2026(method) {
  return Object.prototype.hasOwnProperty.call(requestMethodKeys, method);
}
function hasNotificationMethod2026(method) {
  return Object.prototype.hasOwnProperty.call(notificationMethodKeys, method);
}
function hasResultMethod2026(method) {
  return Object.prototype.hasOwnProperty.call(requestMethodKeys, method);
}
function getRequestSchema2026(method) {
  return hasRequestMethod2026(method) ? buildSchemas2026().dispatchRequestSchemas[method] : void 0;
}
function getResultSchema2026(method) {
  return hasResultMethod2026(method) ? buildSchemas2026().dispatchResultSchemas[method] : void 0;
}
function getNotificationSchema2026(method) {
  return hasNotificationMethod2026(method) ? buildSchemas2026().notificationSchemas2026[method] : void 0;
}
var rev2026RequestMethods = Object.keys(requestMethodKeys);
var rev2026NotificationMethods = Object.keys(notificationMethodKeys);
function isPlainObject$4(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function triState(schema, raw) {
  if (schema === void 0) return {
    ok: false,
    reason: "not-in-era"
  };
  const parsed = schema.safeParse(raw);
  return parsed.success ? {
    ok: true,
    value: parsed.data
  } : {
    ok: false,
    reason: "invalid",
    message: String(parsed.error)
  };
}
var NOT_IN_ERA = {
  ok: false,
  reason: "not-in-era"
};
var REQUIRED_ENVELOPE_KEYS = [PROTOCOL_VERSION_META_KEY, CLIENT_CAPABILITIES_META_KEY];
function enforceDeletedFields(method, result) {
  let next = result;
  let copied = false;
  const copy = () => {
    if (!copied) {
      next = { ...next };
      copied = true;
    }
    return next;
  };
  const tools = result.tools;
  if (method === "tools/list" && Array.isArray(tools) && tools.some((tool) => isPlainObject$4(tool) && "execution" in tool)) copy().tools = tools.map((tool) => {
    if (!isPlainObject$4(tool) || !("execution" in tool)) return tool;
    const rest = { ...tool };
    delete rest["execution"];
    return rest;
  });
  const capabilities = result.capabilities;
  if (isPlainObject$4(capabilities) && "tasks" in capabilities) {
    const rest = { ...capabilities };
    delete rest["tasks"];
    copy().capabilities = rest;
  }
  return next;
}
var rev2026Codec = {
  era: "2026-07-28",
  hasRequestMethod: hasRequestMethod2026,
  hasNotificationMethod: hasNotificationMethod2026,
  hasInputRequestMethod: (method) => getInputRequestSchema2026(method) !== void 0,
  validateRequest: (method, raw) => triState(getRequestSchema2026(method), raw),
  validateResult: (method, raw) => triState(getResultSchema2026(method), raw),
  validateNotification: (method, raw) => triState(getNotificationSchema2026(method), raw),
  validateInputRequest: (method, raw) => triState(getInputRequestSchema2026(method), raw),
  validateInputResponse: (method, raw) => triState(getInputResponseSchema2026(method), raw),
  samplingResultVariant: () => NOT_IN_ERA,
  outboundEnvelope(material) {
    return {
      [PROTOCOL_VERSION_META_KEY]: material.protocolVersion,
      [CLIENT_INFO_META_KEY]: material.clientInfo,
      [CLIENT_CAPABILITIES_META_KEY]: material.clientCapabilities,
      ...material.logLevel !== void 0 && { [LOG_LEVEL_META_KEY]: material.logLevel }
    };
  },
  validateEnvelopeMeta(meta) {
    const issues = [];
    for (const key of REQUIRED_ENVELOPE_KEYS) if (!(key in meta)) issues.push({
      key,
      problem: "missing"
    });
    const parsed = buildSchemas2026().RequestMetaEnvelopeSchema.safeParse(meta);
    if (!parsed.success) for (const issue of parsed.error.issues) {
      const path = issue.path.map(String);
      const key = path.length > 0 ? path.join(".") : "_meta";
      if (path.length === 1 && issues.some((existing) => existing.key === key && existing.problem === "missing")) continue;
      issues.push({
        key,
        problem: issue.message
      });
    }
    return issues;
  },
  projectCallToolResult: (result) => appendTextFallbackForNonObject(result),
  inputRequestSchema: getInputRequestSchema2026,
  decodeResult(method, raw) {
    if (!isPlainObject$4(raw)) return {
      kind: "invalid",
      error: new SdkError(SdkErrorCode.InvalidResult, `Invalid result for ${method}: not an object`, { method })
    };
    const rawResultType = raw["resultType"];
    if (rawResultType === void 0) return {
      kind: "invalid",
      error: new SdkError(SdkErrorCode.InvalidResult, `Invalid result for ${method}: missing required resultType \u2014 servers implementing protocol revision 2026-07-28 MUST include it (the absent-means-complete bridge applies only to earlier-revision servers)`, {
        method,
        violation: "missing-resultType"
      })
    };
    if (typeof rawResultType !== "string") return {
      kind: "invalid",
      error: new SdkError(SdkErrorCode.InvalidResult, `Invalid result for ${method}: non-string resultType`, {
        method,
        resultType: rawResultType
      })
    };
    if (rawResultType === "input_required") {
      const rawInputRequests = raw["inputRequests"];
      const inputRequests = isPlainObject$4(rawInputRequests) ? rawInputRequests : {};
      const requestState = raw["requestState"];
      if (Object.keys(inputRequests).length === 0 && typeof requestState !== "string") return {
        kind: "invalid",
        error: new SdkError(SdkErrorCode.InvalidResult, `Invalid result for ${method}: input_required carries neither inputRequests nor requestState (every input_required result must include at least one of the two)`, {
          method,
          violation: "input-required-missing-both"
        })
      };
      return {
        kind: "input_required",
        inputRequests,
        ...typeof requestState === "string" && { requestState }
      };
    }
    if (rawResultType !== "complete") return {
      kind: "invalid",
      error: new SdkError(SdkErrorCode.UnsupportedResultType, `Unsupported result type '${rawResultType}' for ${method}`, {
        resultType: rawResultType,
        method
      })
    };
    const wireResultSchemas = getWireResultSchemas();
    const wireSchema = Object.hasOwn(wireResultSchemas, method) ? wireResultSchemas[method] : void 0;
    if (wireSchema !== void 0) {
      const parsed = wireSchema.safeParse(raw);
      if (!parsed.success) return {
        kind: "invalid",
        error: new SdkError(SdkErrorCode.InvalidResult, `Invalid result for ${method}: ${parsed.error}`, { method })
      };
    }
    const lifted = { ...raw };
    delete lifted["resultType"];
    return {
      kind: "complete",
      result: lifted
    };
  },
  encodeResult(method, result, serverInfo) {
    return stampServerInfoMeta(fillCacheFields(method, stampResultType(method, enforceDeletedFields(method, result))), serverInfo);
  },
  encodeErrorCode: (code) => code === -32002 ? -32602 : code,
  checkInboundEnvelope(material) {
    if (material.envelope === void 0) return "Request is missing the required _meta envelope for protocol revision 2026-07-28 (io.modelcontextprotocol/protocolVersion, io.modelcontextprotocol/clientCapabilities)";
    const parsed = buildSchemas2026().RequestMetaEnvelopeSchema.safeParse(material.envelope);
    if (!parsed.success) return `Invalid _meta envelope for protocol revision 2026-07-28: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`;
  }
};
var wireResultSchemasMemo;
function getWireResultSchemas() {
  if (wireResultSchemasMemo) return wireResultSchemasMemo;
  const s = buildSchemas2026();
  wireResultSchemasMemo = {
    "tools/call": s.CallToolResultSchema,
    "tools/list": s.ListToolsResultSchema,
    "prompts/get": s.GetPromptResultSchema,
    "prompts/list": s.ListPromptsResultSchema,
    "resources/list": s.ListResourcesResultSchema,
    "resources/templates/list": s.ListResourceTemplatesResultSchema,
    "resources/read": s.ReadResourceResultSchema,
    "completion/complete": s.CompleteResultSchema,
    "server/discover": s.DiscoverResultSchema
  };
  return wireResultSchemasMemo;
}
var MODERN_WIRE_REVISION = "2026-07-28";
function codecForVersion(version) {
  return version !== void 0 && isModernProtocolVersion(version) ? rev2026Codec : rev2025Codec;
}
function classifiedWireEra(classification) {
  if (classification.revision !== void 0) return codecForVersion(classification.revision).era;
  return classification.era === "modern" ? rev2026Codec.era : rev2025Codec.era;
}
function isSpecRequestMethod(method) {
  return ALL_CODECS.some((codec) => codec.hasRequestMethod(method));
}
function isSpecNotificationMethod(method) {
  return ALL_CODECS.some((codec) => codec.hasNotificationMethod(method));
}
var ALL_CODECS = [rev2025Codec, rev2026Codec];
var schemas_exports = /* @__PURE__ */ __exportAll({
  AnnotationsSchema: () => AnnotationsSchema,
  AudioContentSchema: () => AudioContentSchema,
  BaseMetadataSchema: () => BaseMetadataSchema,
  BaseRequestParamsSchema: () => BaseRequestParamsSchema,
  BlobResourceContentsSchema: () => BlobResourceContentsSchema,
  BooleanSchemaSchema: () => BooleanSchemaSchema,
  CallToolRequestParamsSchema: () => CallToolRequestParamsSchema,
  CallToolRequestSchema: () => CallToolRequestSchema,
  CallToolResultSchema: () => CallToolResultSchema,
  CancelTaskRequestSchema: () => CancelTaskRequestSchema,
  CancelTaskResultSchema: () => CancelTaskResultSchema,
  CancelledNotificationParamsSchema: () => CancelledNotificationParamsSchema,
  CancelledNotificationSchema: () => CancelledNotificationSchema,
  ClientCapabilitiesSchema: () => ClientCapabilitiesSchema,
  ClientNotificationSchema: () => ClientNotificationSchema,
  ClientRequestSchema: () => ClientRequestSchema,
  ClientResultSchema: () => ClientResultSchema,
  ClientTasksCapabilitySchema: () => ClientTasksCapabilitySchema,
  CompatibilityCallToolResultSchema: () => CompatibilityCallToolResultSchema,
  CompleteRequestParamsSchema: () => CompleteRequestParamsSchema,
  CompleteRequestSchema: () => CompleteRequestSchema,
  CompleteResultSchema: () => CompleteResultSchema,
  ContentBlockSchema: () => ContentBlockSchema,
  CreateMessageRequestParamsSchema: () => CreateMessageRequestParamsSchema,
  CreateMessageRequestSchema: () => CreateMessageRequestSchema,
  CreateMessageResultSchema: () => CreateMessageResultSchema,
  CreateMessageResultWithToolsSchema: () => CreateMessageResultWithToolsSchema,
  CreateTaskResultSchema: () => CreateTaskResultSchema,
  CursorSchema: () => CursorSchema,
  DiscoverRequestSchema: () => DiscoverRequestSchema,
  DiscoverResultSchema: () => DiscoverResultSchema,
  ElicitRequestFormParamsSchema: () => ElicitRequestFormParamsSchema,
  ElicitRequestParamsSchema: () => ElicitRequestParamsSchema,
  ElicitRequestSchema: () => ElicitRequestSchema,
  ElicitRequestURLParamsSchema: () => ElicitRequestURLParamsSchema,
  ElicitResultSchema: () => ElicitResultSchema,
  ElicitationCompleteNotificationParamsSchema: () => ElicitationCompleteNotificationParamsSchema,
  ElicitationCompleteNotificationSchema: () => ElicitationCompleteNotificationSchema,
  EmbeddedResourceSchema: () => EmbeddedResourceSchema,
  EmptyResultSchema: () => EmptyResultSchema,
  EnumSchemaSchema: () => EnumSchemaSchema,
  GetPromptRequestParamsSchema: () => GetPromptRequestParamsSchema,
  GetPromptRequestSchema: () => GetPromptRequestSchema,
  GetPromptResultSchema: () => GetPromptResultSchema,
  GetTaskPayloadRequestSchema: () => GetTaskPayloadRequestSchema,
  GetTaskPayloadResultSchema: () => GetTaskPayloadResultSchema,
  GetTaskRequestSchema: () => GetTaskRequestSchema,
  GetTaskResultSchema: () => GetTaskResultSchema,
  IconSchema: () => IconSchema,
  IconsSchema: () => IconsSchema,
  ImageContentSchema: () => ImageContentSchema,
  ImplementationSchema: () => ImplementationSchema,
  InitializeRequestParamsSchema: () => InitializeRequestParamsSchema,
  InitializeRequestSchema: () => InitializeRequestSchema,
  InitializeResultSchema: () => InitializeResultSchema,
  InitializedNotificationSchema: () => InitializedNotificationSchema,
  JSONArraySchema: () => JSONArraySchema,
  JSONObjectSchema: () => JSONObjectSchema,
  JSONRPCErrorResponseSchema: () => JSONRPCErrorResponseSchema,
  JSONRPCMessageSchema: () => JSONRPCMessageSchema,
  JSONRPCNotificationSchema: () => JSONRPCNotificationSchema,
  JSONRPCRequestSchema: () => JSONRPCRequestSchema,
  JSONRPCResponseSchema: () => JSONRPCResponseSchema,
  JSONRPCResultResponseSchema: () => JSONRPCResultResponseSchema,
  JSONValueSchema: () => JSONValueSchema,
  LegacyTitledEnumSchemaSchema: () => LegacyTitledEnumSchemaSchema,
  ListChangedOptionsBaseSchema: () => ListChangedOptionsBaseSchema,
  ListPromptsRequestSchema: () => ListPromptsRequestSchema,
  ListPromptsResultSchema: () => ListPromptsResultSchema,
  ListResourceTemplatesRequestSchema: () => ListResourceTemplatesRequestSchema,
  ListResourceTemplatesResultSchema: () => ListResourceTemplatesResultSchema,
  ListResourcesRequestSchema: () => ListResourcesRequestSchema,
  ListResourcesResultSchema: () => ListResourcesResultSchema,
  ListRootsRequestSchema: () => ListRootsRequestSchema,
  ListRootsResultSchema: () => ListRootsResultSchema,
  ListTasksRequestSchema: () => ListTasksRequestSchema,
  ListTasksResultSchema: () => ListTasksResultSchema,
  ListToolsRequestSchema: () => ListToolsRequestSchema,
  ListToolsResultSchema: () => ListToolsResultSchema,
  LoggingLevelSchema: () => LoggingLevelSchema,
  LoggingMessageNotificationParamsSchema: () => LoggingMessageNotificationParamsSchema,
  LoggingMessageNotificationSchema: () => LoggingMessageNotificationSchema,
  ModelHintSchema: () => ModelHintSchema,
  ModelPreferencesSchema: () => ModelPreferencesSchema,
  MultiSelectEnumSchemaSchema: () => MultiSelectEnumSchemaSchema,
  NotificationSchema: () => NotificationSchema,
  NotificationsParamsSchema: () => NotificationsParamsSchema,
  NumberSchemaSchema: () => NumberSchemaSchema,
  PaginatedRequestParamsSchema: () => PaginatedRequestParamsSchema,
  PaginatedRequestSchema: () => PaginatedRequestSchema,
  PaginatedResultSchema: () => PaginatedResultSchema,
  PingRequestSchema: () => PingRequestSchema,
  PrimitiveSchemaDefinitionSchema: () => PrimitiveSchemaDefinitionSchema,
  ProgressNotificationParamsSchema: () => ProgressNotificationParamsSchema,
  ProgressNotificationSchema: () => ProgressNotificationSchema,
  ProgressSchema: () => ProgressSchema,
  ProgressTokenSchema: () => ProgressTokenSchema,
  PromptArgumentSchema: () => PromptArgumentSchema,
  PromptListChangedNotificationSchema: () => PromptListChangedNotificationSchema,
  PromptMessageSchema: () => PromptMessageSchema,
  PromptReferenceSchema: () => PromptReferenceSchema,
  PromptSchema: () => PromptSchema,
  ReadResourceRequestParamsSchema: () => ReadResourceRequestParamsSchema,
  ReadResourceRequestSchema: () => ReadResourceRequestSchema,
  ReadResourceResultSchema: () => ReadResourceResultSchema,
  RelatedTaskMetadataSchema: () => RelatedTaskMetadataSchema,
  RequestIdSchema: () => RequestIdSchema,
  RequestMetaSchema: () => RequestMetaSchema,
  RequestSchema: () => RequestSchema,
  ResourceContentsSchema: () => ResourceContentsSchema,
  ResourceLinkSchema: () => ResourceLinkSchema,
  ResourceListChangedNotificationSchema: () => ResourceListChangedNotificationSchema,
  ResourceRequestParamsSchema: () => ResourceRequestParamsSchema,
  ResourceSchema: () => ResourceSchema,
  ResourceTemplateReferenceSchema: () => ResourceTemplateReferenceSchema,
  ResourceTemplateSchema: () => ResourceTemplateSchema,
  ResourceUpdatedNotificationParamsSchema: () => ResourceUpdatedNotificationParamsSchema,
  ResourceUpdatedNotificationSchema: () => ResourceUpdatedNotificationSchema,
  ResultMetaObjectSchema: () => ResultMetaObjectSchema,
  ResultSchema: () => ResultSchema,
  RoleSchema: () => RoleSchema,
  RootSchema: () => RootSchema,
  RootsListChangedNotificationSchema: () => RootsListChangedNotificationSchema,
  SamplingContentSchema: () => SamplingContentSchema,
  SamplingMessageContentBlockSchema: () => SamplingMessageContentBlockSchema,
  SamplingMessageSchema: () => SamplingMessageSchema,
  ServerCapabilitiesSchema: () => ServerCapabilitiesSchema,
  ServerNotificationSchema: () => ServerNotificationSchema,
  ServerRequestSchema: () => ServerRequestSchema,
  ServerResultSchema: () => ServerResultSchema,
  ServerTasksCapabilitySchema: () => ServerTasksCapabilitySchema,
  SetLevelRequestParamsSchema: () => SetLevelRequestParamsSchema,
  SetLevelRequestSchema: () => SetLevelRequestSchema,
  SingleSelectEnumSchemaSchema: () => SingleSelectEnumSchemaSchema,
  StringSchemaSchema: () => StringSchemaSchema,
  SubscribeRequestParamsSchema: () => SubscribeRequestParamsSchema,
  SubscribeRequestSchema: () => SubscribeRequestSchema,
  SubscriptionFilterSchema: () => SubscriptionFilterSchema,
  SubscriptionsAcknowledgedNotificationParamsSchema: () => SubscriptionsAcknowledgedNotificationParamsSchema,
  SubscriptionsAcknowledgedNotificationSchema: () => SubscriptionsAcknowledgedNotificationSchema,
  SubscriptionsListenRequestParamsSchema: () => SubscriptionsListenRequestParamsSchema,
  SubscriptionsListenRequestSchema: () => SubscriptionsListenRequestSchema,
  SubscriptionsListenResultMetaSchema: () => SubscriptionsListenResultMetaSchema,
  SubscriptionsListenResultSchema: () => SubscriptionsListenResultSchema,
  TaskAugmentedRequestParamsSchema: () => TaskAugmentedRequestParamsSchema,
  TaskCreationParamsSchema: () => TaskCreationParamsSchema,
  TaskMetadataSchema: () => TaskMetadataSchema,
  TaskSchema: () => TaskSchema,
  TaskStatusNotificationParamsSchema: () => TaskStatusNotificationParamsSchema,
  TaskStatusNotificationSchema: () => TaskStatusNotificationSchema,
  TaskStatusSchema: () => TaskStatusSchema,
  TextContentSchema: () => TextContentSchema,
  TextResourceContentsSchema: () => TextResourceContentsSchema,
  TitledMultiSelectEnumSchemaSchema: () => TitledMultiSelectEnumSchemaSchema,
  TitledSingleSelectEnumSchemaSchema: () => TitledSingleSelectEnumSchemaSchema,
  ToolAnnotationsSchema: () => ToolAnnotationsSchema,
  ToolChoiceSchema: () => ToolChoiceSchema,
  ToolExecutionSchema: () => ToolExecutionSchema,
  ToolListChangedNotificationSchema: () => ToolListChangedNotificationSchema,
  ToolResultContentSchema: () => ToolResultContentSchema,
  ToolSchema: () => ToolSchema,
  ToolUseContentSchema: () => ToolUseContentSchema,
  UnsubscribeRequestParamsSchema: () => UnsubscribeRequestParamsSchema,
  UnsubscribeRequestSchema: () => UnsubscribeRequestSchema,
  UntitledMultiSelectEnumSchemaSchema: () => UntitledMultiSelectEnumSchemaSchema,
  UntitledSingleSelectEnumSchemaSchema: () => UntitledSingleSelectEnumSchemaSchema
});
var isJSONRPCRequest = (value) => JSONRPCRequestSchema.safeParse(value).success;
var isJSONRPCNotification = (value) => JSONRPCNotificationSchema.safeParse(value).success;
var isJSONRPCResultResponse = (value) => JSONRPCResultResponseSchema.safeParse(value).success;
var isJSONRPCErrorResponse = (value) => JSONRPCErrorResponseSchema.safeParse(value).success;
var isInputRequiredResult = (value) => typeof value === "object" && value !== null && !Array.isArray(value) && value.resultType === "input_required";
var isInitializeRequest = (value) => InitializeRequestSchema.safeParse(value).success;
var HEADER_MISMATCH_ERROR_CODE = -32020;
var INBOUND_VALIDATION_LADDER = [
  {
    rung: "http-method",
    order: 1,
    evaluatedAt: "edge",
    codes: [-32e3],
    conformance: [],
    rationale: "The modern era is POST-only; GET/DELETE are body-less 2025-era session operations and are method-routed to legacy serving (405 when legacy serving is not configured), before any body is read."
  },
  {
    rung: "jsonrpc-shape",
    order: 2,
    evaluatedAt: "edge",
    codes: [ProtocolErrorCode.InvalidRequest],
    conformance: ["server-stateless"],
    rationale: "The body must be a JSON-RPC request or notification: posted responses and batch arrays containing a modern or invalid element are rejected before classification (element-wise batch rule); all-legacy arrays stay legacy traffic."
  },
  {
    rung: "era-classification",
    order: 3,
    evaluatedAt: "edge",
    codes: [HEADER_MISMATCH_ERROR_CODE, ProtocolErrorCode.UnsupportedProtocolVersion],
    conformance: [
      "server-stateless",
      "http-header-validation",
      "http-custom-header-server-validation"
    ],
    rationale: "Body-primary era classification with the protocol-version header as a cross-check; a header/body disagreement is rejected with -32020 (HeaderMismatch), and an envelope-less request on a modern-only endpoint is answered with the unsupported-protocol-version error naming the supported revisions."
  },
  {
    rung: "envelope",
    order: 4,
    evaluatedAt: "edge",
    codes: [ProtocolErrorCode.InvalidParams],
    conformance: ["server-stateless"],
    rationale: "A present envelope claim with a malformed envelope \u2014 and a missing envelope on a request whose protocol-version header names a modern revision \u2014 is an invalid-params rejection naming the offending or missing key(s); never a silent fall back to legacy handling. This is the only place an invalid-params rejection maps to HTTP 400."
  },
  {
    rung: "method-registry",
    order: 5,
    evaluatedAt: "dispatch",
    codes: [ProtocolErrorCode.MethodNotFound],
    conformance: ["server-stateless"],
    rationale: "Method existence outranks parameter validity: a method absent from the negotiated revision\u2019s registry (or with no handler installed) answers method-not-found before params or capabilities are looked at."
  },
  {
    rung: "request-params",
    order: 6,
    evaluatedAt: "dispatch",
    codes: [ProtocolErrorCode.InvalidParams],
    conformance: [],
    rationale: "Per-method params validation; emitted in-band by the dispatch layer (HTTP 200), never via the ladder status table."
  },
  {
    rung: "standard-header-validation",
    order: 7,
    evaluatedAt: "pre-dispatch",
    codes: [HEADER_MISMATCH_ERROR_CODE],
    conformance: ["http-header-validation"],
    rationale: "SEP-2243 standard `Mcp-Method` / `Mcp-Name` headers \u2014 presence, sentinel decoding, and `Mcp-Name` \u2194 body cross-check \u2014 are validated by the HTTP entry on a modern-classified request after the supported-revision gate and before dispatch. The classifier\u2019s own header-mismatch cells (protocol-version, `Mcp-Method` mismatch) stay on the edge `era-classification` rung; this rung carries the entry-layer presence/`Mcp-Name` half. Evaluated before the capability gate, the factory call, and the `Mcp-Param-*` rung so a request that fails several rungs is answered by the standard-header rung first. The documented order (after method-registry 5 and request-params 6) is NOT the observed precedence: serveModern evaluates this rung immediately after the supported-revision gate, so a request that also fails a dispatch rung is answered here before the dispatch rungs (5\u20136) are consulted."
  },
  {
    rung: "client-capabilities",
    order: 8,
    evaluatedAt: "pre-dispatch",
    codes: [ProtocolErrorCode.MissingRequiredClientCapability],
    conformance: ["server-stateless"],
    rationale: "The capability requirement is checked by the HTTP entry, pre-dispatch, against the validated envelope the classifier produced \u2014 pinning the spec-mandated HTTP 400 independently of how dispatch- and handler-produced errors are mapped. The documented order (after method resolution and params validation) is preserved observably only while the requirement table is empty: once a served method gains a requirement entry, a request that is missing the capability and would also fail a dispatch rung is answered by this gate first, so the entry must consult the method registry before the gate if the documented precedence is to stay observable."
  },
  {
    rung: "param-header-validation",
    order: 9,
    evaluatedAt: "pre-dispatch",
    codes: [HEADER_MISMATCH_ERROR_CODE],
    conformance: ["http-custom-header-server-validation"],
    rationale: "SEP-2243 `Mcp-Param-*` headers are validated against the named tool\u2019s `x-mcp-header` declarations and the body `arguments` after the tool registry is known and before dispatch reaches the handler; a missing/disagreeing/malformed header is rejected 400 / -32020 with the same shape as the standard-header cross-checks. The documented order (after method resolution and params validation) is preserved observably only when the body `arguments` would otherwise validate: the check runs pre-dispatch, so a `tools/call` that fails BOTH this rung and a dispatch-time rung (e.g. order-6 `request-params`, -32602) is answered by this gate first with 400 / -32020, not by the earlier-ordered rung."
  }
];
var LADDER_ERROR_HTTP_STATUS = {
  [ProtocolErrorCode.ParseError]: 400,
  [ProtocolErrorCode.InvalidRequest]: 400,
  [ProtocolErrorCode.MethodNotFound]: 404,
  [ProtocolErrorCode.UnsupportedProtocolVersion]: 400,
  [ProtocolErrorCode.MissingRequiredClientCapability]: 400,
  [HEADER_MISMATCH_ERROR_CODE]: 400
};
function parseSchema(schema, data) {
  return z26.safeParse(schema, data);
}
function shapeKeys(schemas) {
  return new Set(schemas.flatMap((schema) => Object.keys(schema.shape)));
}
function isStandardSchema(schema) {
  if (schema == null) return false;
  const schemaType = typeof schema;
  if (schemaType !== "object" && schemaType !== "function") return false;
  if (!("~standard" in schema)) return false;
  return typeof schema["~standard"]?.validate === "function";
}
var warnedZodFallback = false;
var JSON_SCHEMA_CONVERSION_TARGET = "draft-2020-12";
function standardSchemaToJsonSchema(schema, io = "input") {
  const std = schema["~standard"];
  let result;
  if (std.jsonSchema) result = std.jsonSchema[io]({ target: JSON_SCHEMA_CONVERSION_TARGET });
  else if (std.vendor === "zod") {
    if (!("_zod" in schema)) throw new Error("Schema appears to be from zod 3, which the SDK cannot convert to JSON Schema. Upgrade to zod >=4.2.0, or wrap your JSON Schema with fromJsonSchema().");
    if (!warnedZodFallback) {
      warnedZodFallback = true;
      console.warn("[mcp-sdk] Your zod version does not implement `~standard.jsonSchema` (added in zod 4.2.0). Falling back to z.toJSONSchema(). Upgrade to zod >=4.2.0 to silence this warning.");
    }
    result = z26.toJSONSchema(schema, {
      target: JSON_SCHEMA_CONVERSION_TARGET,
      io
    });
  } else throw new Error(`Schema library "${std.vendor}" does not implement StandardJSONSchemaV1 (\`~standard.jsonSchema\`). Upgrade to a version that does, or wrap your JSON Schema with fromJsonSchema().`);
  if (io === "output") {
    if (result.type !== void 0) return result;
    return isProvablyObjectShapedRoot(result) ? {
      type: "object",
      ...result
    } : result;
  }
  if (result.type !== void 0 && result.type !== "object") throw new Error(`MCP tool and prompt schemas must describe objects (got type: ${JSON.stringify(result.type)}). Wrap your schema in z.object({...}) or equivalent.`);
  return {
    type: "object",
    ...result
  };
}
function isProvablyObjectShapedRoot(schema) {
  if ("properties" in schema || "patternProperties" in schema || "additionalProperties" in schema || "required" in schema) return true;
  for (const key of [
    "oneOf",
    "anyOf",
    "allOf"
  ]) {
    const members = schema[key];
    if (Array.isArray(members) && members.length > 0) return members.every((m) => m !== null && typeof m === "object" && (m.type === "object" || isProvablyObjectShapedRoot(m)));
  }
  return false;
}
function formatIssue(issue) {
  if (!issue.path?.length) return issue.message;
  return `${issue.path.map((p) => String(typeof p === "object" ? p.key : p)).join(".")}: ${issue.message}`;
}
async function validateStandardSchema(schema, data) {
  const result = await schema["~standard"].validate(data);
  if (result.issues && result.issues.length > 0) return {
    success: false,
    error: result.issues.map((i) => formatIssue(i)).join(", ")
  };
  return {
    success: true,
    data: result.value
  };
}
function zodEmittedPattern(schema) {
  const jsonSchema = z26.toJSONSchema(schema, {
    target: JSON_SCHEMA_CONVERSION_TARGET,
    io: "input"
  });
  return typeof jsonSchema.pattern === "string" ? jsonSchema.pattern : void 0;
}
var DATETIME_FRACTION_DIGITS = /\\\.\\d\{(\d+)\}/;
function datetimeReferenceSchemas(pattern) {
  const fractionDigits = DATETIME_FRACTION_DIGITS.exec(pattern);
  const precisions = [
    void 0,
    -1,
    0
  ];
  if (fractionDigits) precisions.push(Number(fractionDigits[1]));
  return [false, true].flatMap((local) => [false, true].flatMap((offset) => precisions.map((precision) => z26.iso.datetime({
    local,
    offset,
    precision
  }))));
}
function referencePatternsForFormat(format, pattern) {
  let referenceSchemas;
  switch (format) {
    case "email":
      referenceSchemas = [z26.email()];
      break;
    case "uri":
      referenceSchemas = [z26.url()];
      break;
    case "date":
      referenceSchemas = [z26.iso.date()];
      break;
    case "date-time":
      referenceSchemas = datetimeReferenceSchemas(pattern);
      break;
  }
  return new Set(referenceSchemas.map((schema) => zodEmittedPattern(schema)).filter((emitted) => emitted !== void 0));
}
function isLibraryFormatPattern(format, pattern, vendor) {
  if (vendor !== "zod") return true;
  return referencePatternsForFormat(format, pattern).has(pattern);
}
function isJsonObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function convertStandardElicitationSchema(schema) {
  try {
    return standardSchemaToJsonSchema(schema, "input");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Elicitation requestedSchema must describe an object with flat primitive properties: ${detail}`);
  }
}
var ANNOTATION_ONLY_JSON_SCHEMA_KEYWORDS = /* @__PURE__ */ new Set([
  "$comment",
  "deprecated",
  "description",
  "examples",
  "readOnly",
  "title",
  "writeOnly"
]);
function isAnnotationOnlyJsonSchemaKeyword(key) {
  return ANNOTATION_ONLY_JSON_SCHEMA_KEYWORDS.has(key) || key.startsWith("x-");
}
var ROOT_KEYS = /* @__PURE__ */ new Set(["$schema", ...Object.keys(ElicitRequestFormParamsSchema.shape.requestedSchema.shape)]);
var PROPERTY_KEYS_BY_TYPE = {
  string: shapeKeys([
    StringSchemaSchema,
    UntitledSingleSelectEnumSchemaSchema,
    TitledSingleSelectEnumSchemaSchema,
    LegacyTitledEnumSchemaSchema
  ]),
  number: shapeKeys([NumberSchemaSchema]),
  integer: shapeKeys([NumberSchemaSchema]),
  boolean: shapeKeys([BooleanSchemaSchema]),
  array: shapeKeys([UntitledMultiSelectEnumSchemaSchema, TitledMultiSelectEnumSchemaSchema])
};
var SUPPORTED_STRING_FORMATS = new Set(StringSchemaSchema.shape.format.unwrap().options);
function walkProperty(node, path, vendor, unsupported) {
  if (!isJsonObject(node)) return node;
  const allowedKeys = typeof node.type === "string" && Object.hasOwn(PROPERTY_KEYS_BY_TYPE, node.type) ? PROPERTY_KEYS_BY_TYPE[node.type] : void 0;
  if (allowedKeys === void 0) return node;
  const pruned = {};
  for (const [key, value] of Object.entries(node)) if (allowedKeys.has(key) || isAnnotationOnlyJsonSchemaKeyword(key)) pruned[key] = value;
  else if (key === "pattern" && node.type === "string" && typeof node.format === "string") {
    if (!SUPPORTED_STRING_FORMATS.has(node.format)) pruned[key] = value;
    else if (typeof value !== "string" || !isLibraryFormatPattern(node.format, value, vendor)) unsupported.push(`${path}.${key}`);
  } else unsupported.push(`${path}.${key}`);
  return pruned;
}
function walkRequestedSchema(converted, vendor) {
  const pruned = {};
  const unsupported = [];
  for (const [key, value] of Object.entries(converted)) if (key === "properties" && isJsonObject(value)) pruned[key] = Object.fromEntries(Object.entries(value).map(([name, node]) => [name, walkProperty(node, `properties.${name}`, vendor, unsupported)]));
  else if (ROOT_KEYS.has(key)) pruned[key] = value;
  else if (!isAnnotationOnlyJsonSchemaKeyword(key)) unsupported.push(key);
  if (unsupported.length > 0) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Elicitation requestedSchema contains unsupported JSON Schema constraint(s) after Standard Schema conversion: ${unsupported.join(", ")}`);
  return pruned;
}
function describeUnsupportedProperties(pruned, fallback) {
  if (!isJsonObject(pruned.properties)) return fallback;
  const offenders = Object.entries(pruned.properties).filter(([, node]) => !parseSchema(PrimitiveSchemaDefinitionSchema, node).success).map(([name]) => `properties.${name}`);
  return offenders.length > 0 ? offenders.join(", ") : fallback;
}
function findDroppedConstraintPaths(original, parsed, path = "") {
  if (Array.isArray(original) && Array.isArray(parsed)) return original.flatMap((item, index) => findDroppedConstraintPaths(item, parsed[index], `${path}[${index}]`));
  if (!isJsonObject(original) || !isJsonObject(parsed)) return [];
  return Object.entries(original).flatMap(([key, value]) => {
    const childPath = path ? `${path}.${key}` : key;
    if (!Object.prototype.hasOwnProperty.call(parsed, key)) return isAnnotationOnlyJsonSchemaKeyword(key) ? [] : [childPath];
    return findDroppedConstraintPaths(value, parsed[key], childPath);
  });
}
function normalizeElicitInputParams(input) {
  if (!isStandardSchema(input.requestedSchema)) return {
    ...input,
    mode: "form",
    requestedSchema: input.requestedSchema
  };
  const vendor = input.requestedSchema["~standard"].vendor;
  const pruned = walkRequestedSchema(convertStandardElicitationSchema(input.requestedSchema), vendor);
  const parsed = parseSchema(ElicitRequestFormParamsSchema.shape.requestedSchema, pruned);
  if (!parsed.success) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Elicitation requestedSchema only supports flat primitive properties (string, number, integer, boolean, and string enums): ${describeUnsupportedProperties(pruned, parsed.error.message)}`);
  const droppedConstraints = findDroppedConstraintPaths(pruned, parsed.data);
  if (droppedConstraints.length > 0) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Elicitation requestedSchema contains unsupported JSON Schema constraint(s) after Standard Schema conversion: ${droppedConstraints.join(", ")}`);
  const danglingRequired = (parsed.data.required ?? []).filter((key) => !Object.prototype.hasOwnProperty.call(parsed.data.properties, key));
  if (danglingRequired.length > 0) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Elicitation requestedSchema lists required properties that are not defined in properties: ${danglingRequired.join(", ")}`);
  return {
    ...input,
    mode: "form",
    requestedSchema: parsed.data
  };
}
function buildInputRequired(spec) {
  const hasInputRequests = spec.inputRequests !== void 0 && Object.keys(spec.inputRequests).length > 0;
  const hasRequestState = typeof spec.requestState === "string";
  if (!hasInputRequests && !hasRequestState) throw new TypeError("inputRequired() requires at least one of inputRequests (with at least one entry) or requestState (spec: every InputRequiredResult MUST include at least one of the two)");
  return {
    resultType: "input_required",
    ...spec.inputRequests !== void 0 && { inputRequests: spec.inputRequests },
    ...spec.requestState !== void 0 && { requestState: spec.requestState }
  };
}
var inputRequired = Object.assign(buildInputRequired, {
  elicit(params) {
    try {
      return {
        method: "elicitation/create",
        params: normalizeElicitInputParams(params)
      };
    } catch (error) {
      throw error instanceof ProtocolError ? new TypeError(error.message, { cause: error }) : error;
    }
  },
  elicitUrl(params) {
    return {
      method: "elicitation/create",
      params: {
        ...params,
        mode: "url"
      }
    };
  },
  createMessage(params) {
    return {
      method: "sampling/createMessage",
      params
    };
  },
  listRoots() {
    return { method: "roots/list" };
  }
});
function acceptedContent(responses, key, schema) {
  const view = inputResponse(responses, key);
  if (view.kind !== "elicit" || view.action !== "accept" || view.content === void 0) return void 0;
  if (schema === void 0) return view.content;
  const outcome = schema["~standard"].validate(view.content);
  if (outcome instanceof Promise) throw new TypeError("acceptedContent(responses, key, schema) requires a synchronously-validating schema");
  return outcome.issues === void 0 ? outcome.value : void 0;
}
function inputResponse(responses, key) {
  if (responses === void 0 || typeof responses !== "object" || responses === null) return { kind: "missing" };
  const entry = responses[key];
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return { kind: "missing" };
  const candidate = entry;
  if (candidate["action"] === "accept" || candidate["action"] === "decline" || candidate["action"] === "cancel") {
    const content = candidate["content"];
    return {
      kind: "elicit",
      action: candidate["action"],
      ...content !== null && typeof content === "object" && !Array.isArray(content) && { content }
    };
  }
  if (Array.isArray(candidate["roots"])) return {
    kind: "roots",
    roots: candidate["roots"]
  };
  if (typeof candidate["role"] === "string" && candidate["content"] !== void 0) return {
    kind: "sampling",
    result: candidate
  };
  return { kind: "missing" };
}
var REQUEST_STATE_ONLY_LEG_PACING_MS = 250;
function inputRequiredRoundsExceededMessage(method, maxRounds) {
  return `Multi-round-trip request '${method}' still required input after ${maxRounds} rounds (inputRequired.maxRounds)`;
}
function sleep2(ms, signal) {
  return new Promise((resolve2, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof SdkError ? signal.reason : new SdkError(SdkErrorCode.RequestTimeout, String(signal.reason)));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve2();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof SdkError ? signal.reason : new SdkError(SdkErrorCode.RequestTimeout, String(signal?.reason)));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
function linkedRoundAbort(outer) {
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort(outer?.reason);
  outer?.addEventListener("abort", onOuterAbort, { once: true });
  if (outer?.aborted) controller.abort(outer.reason);
  return {
    signal: controller.signal,
    abort: (reason) => controller.abort(reason),
    dispose: () => outer?.removeEventListener("abort", onOuterAbort)
  };
}
var SPEC_SCHEMA_KEYS = [
  "AnnotationsSchema",
  "AudioContentSchema",
  "BaseMetadataSchema",
  "BlobResourceContentsSchema",
  "BooleanSchemaSchema",
  "CallToolRequestSchema",
  "CallToolRequestParamsSchema",
  "CallToolResultSchema",
  "CancelledNotificationSchema",
  "CancelledNotificationParamsSchema",
  "CancelTaskRequestSchema",
  "CancelTaskResultSchema",
  "ClientCapabilitiesSchema",
  "ClientNotificationSchema",
  "ClientRequestSchema",
  "ClientResultSchema",
  "CompatibilityCallToolResultSchema",
  "CompleteRequestSchema",
  "CompleteRequestParamsSchema",
  "CompleteResultSchema",
  "ContentBlockSchema",
  "CreateMessageRequestSchema",
  "CreateMessageRequestParamsSchema",
  "CreateMessageResultSchema",
  "CreateMessageResultWithToolsSchema",
  "CreateTaskResultSchema",
  "CursorSchema",
  "DiscoverRequestSchema",
  "DiscoverResultSchema",
  "ElicitationCompleteNotificationSchema",
  "ElicitationCompleteNotificationParamsSchema",
  "ElicitRequestSchema",
  "ElicitRequestFormParamsSchema",
  "ElicitRequestParamsSchema",
  "ElicitRequestURLParamsSchema",
  "ElicitResultSchema",
  "EmbeddedResourceSchema",
  "EmptyResultSchema",
  "EnumSchemaSchema",
  "GetPromptRequestSchema",
  "GetPromptRequestParamsSchema",
  "GetPromptResultSchema",
  "GetTaskPayloadRequestSchema",
  "GetTaskPayloadResultSchema",
  "GetTaskRequestSchema",
  "GetTaskResultSchema",
  "IconSchema",
  "IconsSchema",
  "ImageContentSchema",
  "ImplementationSchema",
  "InitializedNotificationSchema",
  "InitializeRequestSchema",
  "InitializeRequestParamsSchema",
  "InitializeResultSchema",
  "JSONArraySchema",
  "JSONObjectSchema",
  "JSONRPCErrorResponseSchema",
  "JSONRPCMessageSchema",
  "JSONRPCNotificationSchema",
  "JSONRPCRequestSchema",
  "JSONRPCResponseSchema",
  "JSONRPCResultResponseSchema",
  "JSONValueSchema",
  "LegacyTitledEnumSchemaSchema",
  "ListPromptsRequestSchema",
  "ListPromptsResultSchema",
  "ListResourcesRequestSchema",
  "ListResourcesResultSchema",
  "ListResourceTemplatesRequestSchema",
  "ListResourceTemplatesResultSchema",
  "ListRootsRequestSchema",
  "ListRootsResultSchema",
  "ListTasksRequestSchema",
  "ListTasksResultSchema",
  "ListToolsRequestSchema",
  "ListToolsResultSchema",
  "LoggingLevelSchema",
  "LoggingMessageNotificationSchema",
  "LoggingMessageNotificationParamsSchema",
  "ModelHintSchema",
  "ModelPreferencesSchema",
  "MultiSelectEnumSchemaSchema",
  "NotificationSchema",
  "NumberSchemaSchema",
  "PaginatedRequestSchema",
  "PaginatedRequestParamsSchema",
  "PaginatedResultSchema",
  "PingRequestSchema",
  "PrimitiveSchemaDefinitionSchema",
  "ProgressSchema",
  "ProgressNotificationSchema",
  "ProgressNotificationParamsSchema",
  "ProgressTokenSchema",
  "PromptSchema",
  "PromptArgumentSchema",
  "PromptListChangedNotificationSchema",
  "PromptMessageSchema",
  "PromptReferenceSchema",
  "ReadResourceRequestSchema",
  "ReadResourceRequestParamsSchema",
  "ReadResourceResultSchema",
  "RelatedTaskMetadataSchema",
  "RequestSchema",
  "RequestIdSchema",
  "RequestMetaSchema",
  "ResourceSchema",
  "ResourceContentsSchema",
  "ResourceLinkSchema",
  "ResourceListChangedNotificationSchema",
  "ResourceRequestParamsSchema",
  "ResourceTemplateSchema",
  "ResourceTemplateReferenceSchema",
  "ResourceUpdatedNotificationSchema",
  "ResourceUpdatedNotificationParamsSchema",
  "ResultMetaObjectSchema",
  "ResultSchema",
  "RoleSchema",
  "RootSchema",
  "RootsListChangedNotificationSchema",
  "SamplingContentSchema",
  "SamplingMessageSchema",
  "SamplingMessageContentBlockSchema",
  "ServerCapabilitiesSchema",
  "ServerNotificationSchema",
  "ServerRequestSchema",
  "ServerResultSchema",
  "SetLevelRequestSchema",
  "SetLevelRequestParamsSchema",
  "SingleSelectEnumSchemaSchema",
  "StringSchemaSchema",
  "SubscribeRequestSchema",
  "SubscribeRequestParamsSchema",
  "SubscriptionFilterSchema",
  "SubscriptionsAcknowledgedNotificationSchema",
  "SubscriptionsAcknowledgedNotificationParamsSchema",
  "SubscriptionsListenRequestSchema",
  "SubscriptionsListenRequestParamsSchema",
  "SubscriptionsListenResultSchema",
  "SubscriptionsListenResultMetaSchema",
  "TaskAugmentedRequestParamsSchema",
  "TaskCreationParamsSchema",
  "TaskMetadataSchema",
  "TaskSchema",
  "TaskStatusSchema",
  "TaskStatusNotificationSchema",
  "TaskStatusNotificationParamsSchema",
  "TextContentSchema",
  "TextResourceContentsSchema",
  "TitledMultiSelectEnumSchemaSchema",
  "TitledSingleSelectEnumSchemaSchema",
  "ToolSchema",
  "ToolAnnotationsSchema",
  "ToolChoiceSchema",
  "ToolExecutionSchema",
  "ToolListChangedNotificationSchema",
  "ToolResultContentSchema",
  "ToolUseContentSchema",
  "UnsubscribeRequestSchema",
  "UnsubscribeRequestParamsSchema",
  "UntitledMultiSelectEnumSchemaSchema",
  "UntitledSingleSelectEnumSchemaSchema"
];
var authSchemas = {
  IdJagTokenExchangeResponseSchema,
  OAuthClientInformationFullSchema,
  OAuthClientInformationSchema,
  OAuthClientMetadataSchema,
  OAuthClientRegistrationErrorSchema,
  OAuthErrorResponseSchema,
  OAuthMetadataSchema,
  OAuthProtectedResourceMetadataSchema,
  OAuthTokenRevocationRequestSchema,
  OAuthTokensSchema,
  OpenIdProviderDiscoveryMetadataSchema,
  OpenIdProviderMetadataSchema
};
var _specTypeSchemas = {};
var _isSpecType = {};
function register(key, schema) {
  const name = key.slice(0, -6);
  _specTypeSchemas[name] = schema;
  _isSpecType[name] = (v) => schema.safeParse(v).success;
}
for (const key of SPEC_SCHEMA_KEYS) register(key, schemas_exports[key]);
for (const [key, schema] of Object.entries(authSchemas)) register(key, schema);
var specTypeSchemas = Object.freeze(_specTypeSchemas);
var isSpecType = Object.freeze(_isSpecType);
function bootstrapOutboundCodec(method) {
  switch (method) {
    case "initialize":
    case "notifications/initialized":
      return codecForVersion(void 0);
    case "server/discover":
      return codecForVersion(MODERN_WIRE_REVISION);
    default:
      return;
  }
}
var DEFAULT_REQUEST_TIMEOUT_MSEC = 6e4;
var RESERVED_ENVELOPE_META_KEYS = [
  PROTOCOL_VERSION_META_KEY,
  CLIENT_INFO_META_KEY,
  CLIENT_CAPABILITIES_META_KEY,
  LOG_LEVEL_META_KEY
];
var RETRY_PARAMS_KEYS = ["inputResponses", "requestState"];
function liftWireOnlyMaterial(message, kind) {
  const params = message.params;
  if (!isPlainObject$1(params)) return {
    message,
    lifted: {}
  };
  const meta = params._meta;
  const envelopeKeys = isPlainObject$1(meta) ? RESERVED_ENVELOPE_META_KEYS.filter((key) => key in meta) : [];
  const retryKeys = kind === "request" ? RETRY_PARAMS_KEYS.filter((key) => key in params) : [];
  if (envelopeKeys.length === 0 && retryKeys.length === 0) return {
    message,
    lifted: {}
  };
  const lifted = {};
  const nextParams = { ...params };
  if (envelopeKeys.length > 0 && isPlainObject$1(meta)) {
    const envelope = {};
    const nextMeta = { ...meta };
    for (const key of envelopeKeys) {
      envelope[key] = meta[key];
      delete nextMeta[key];
    }
    lifted.envelope = envelope;
    if (Object.keys(nextMeta).length > 0) nextParams._meta = nextMeta;
    else delete nextParams._meta;
  }
  for (const key of retryKeys) {
    if (key === "inputResponses") lifted.inputResponses = nextParams[key];
    if (key === "requestState") lifted.requestState = nextParams[key];
    delete nextParams[key];
  }
  return {
    message: {
      ...message,
      params: nextParams
    },
    lifted
  };
}
function codecResultValidator(codec, method) {
  const probe = codec.validateResult(method, void 0);
  if (!probe.ok && probe.reason === "not-in-era") return void 0;
  return { "~standard": {
    version: 1,
    vendor: "mcp-wire-codec",
    validate(value) {
      const outcome = codec.validateResult(method, value);
      if (outcome.ok) return { value: outcome.value };
      return { issues: [{ message: outcome.reason === "invalid" ? outcome.message : `not-in-era: ${method}` }] };
    }
  } };
}
function requestStateAccessor(value) {
  return () => value;
}
var NO_REQUEST_STATE = requestStateAccessor(void 0);
function withRequestStateValue(ctx, value) {
  return {
    ...ctx,
    mcpReq: {
      ...ctx.mcpReq,
      requestState: requestStateAccessor(value)
    }
  };
}
var writeNegotiatedProtocolVersion;
var Protocol = class {
  _transport;
  _requestMessageId = 0;
  _requestHandlers = /* @__PURE__ */ new Map();
  _requestHandlerAbortControllers = /* @__PURE__ */ new Map();
  _notificationHandlers = /* @__PURE__ */ new Map();
  _responseHandlers = /* @__PURE__ */ new Map();
  _progressHandlers = /* @__PURE__ */ new Map();
  _timeoutInfo = /* @__PURE__ */ new Map();
  _pendingDebouncedNotifications = /* @__PURE__ */ new Set();
  /**
  * The protocol version negotiated for the current connection (`undefined`
  * before negotiation completes), which determines the wire era this
  * instance speaks. Set by the SDK's negotiation and initialize paths
  * (`Client.connect`, `Server._oninitialize`).
  */
  _negotiatedProtocolVersion;
  static {
    writeNegotiatedProtocolVersion = (instance, version) => {
      instance._negotiatedProtocolVersion = version;
    };
  }
  _supportedProtocolVersions;
  /**
  * Callback for when the connection is closed for any reason.
  *
  * This is invoked when {@linkcode Protocol.close | close()} is called as well.
  */
  onclose;
  /**
  * Callback for when an error occurs.
  *
  * Note that errors are not necessarily fatal; they are used for reporting any kind of exceptional condition out of band.
  */
  onerror;
  /**
  * A handler to invoke for any request types that do not have their own handler installed.
  */
  fallbackRequestHandler;
  /**
  * A handler to invoke for any notification types that do not have their own handler installed.
  */
  fallbackNotificationHandler;
  constructor(_options) {
    this._options = _options;
    this._supportedProtocolVersions = _options?.supportedProtocolVersions ?? SUPPORTED_PROTOCOL_VERSIONS;
    this.setNotificationHandler("notifications/cancelled", (notification) => {
      this._oncancel(notification);
    });
    this.setNotificationHandler("notifications/progress", (notification) => {
      this._onprogress(notification);
    });
    this.setRequestHandler("ping", (_request) => ({}));
  }
  /**
  * Drop consult for inbound messages whose transport did not classify them
  * at the edge — long-lived channels such as stdio, where a role class may
  * need to decline traffic the negotiated era has no answer for (the
  * client-side inbound-request drop on modern-era connections: the
  * 2026-07-28 era has no server→client request channel, and on stdio the
  * client must never write JSON-RPC responses).
  *
  * Consulted ONLY when the transport supplied no
  * {@linkcode MessageExtraInfo.classification}: edge-classified traffic
  * never reaches the hook. Returning `'drop'` discards the message without
  * writing any response (requests are surfaced via `onerror`). The base
  * implementation returns `undefined`: unclassified traffic keeps today's
  * dispatch path unchanged. Era selection never happens here — era is
  * instance state, owned by the serving entry that constructed and
  * connected the instance.
  */
  _shouldDropInbound(_message) {
  }
  /**
  * The per-request `_meta` envelope this instance attaches to every outgoing
  * request and notification, when one applies. The base implementation
  * returns `undefined` (no envelope — the 2025-era posture, so legacy-era
  * outbound traffic is byte-identical to a build without this seam).
  * `Client` overrides it on a connection that negotiated a modern (2026-07-28+)
  * era to return the reserved protocol-version / client-info /
  * client-capabilities keys. User-supplied `_meta` keys take precedence over
  * the auto-attached ones.
  */
  _outboundMetaEnvelope() {
  }
  /**
  * Attach this instance's outbound `_meta` envelope (when one is configured)
  * to a request or notification. A no-op when the seam returns `undefined`
  * — the message returns by reference, so the legacy-era wire stays
  * byte-identical. User-supplied `_meta` keys are spread last so they win
  * over the auto-attached envelope keys.
  */
  _envelopeOutbound(message) {
    const envelope = this._outboundMetaEnvelope();
    if (envelope === void 0) return message;
    const params = message.params ?? {};
    return {
      ...message,
      params: {
        ...params,
        _meta: {
          ...envelope,
          ...params._meta
        }
      }
    };
  }
  /**
  * Extension point for non-`complete` decoded results in the response
  * funnel: a result the wire codec discriminated into a kind other than
  * `'complete'` or `'invalid'` is handed here for the role class to
  * resolve. The base default surfaces it as a typed
  * {@linkcode SdkErrorCode.UnsupportedResultType} error (no retry).
  *
  * Intended consumers (named so the seam stays accountable):
  * - the `Client`'s multi-round-trip auto-fulfilment engine, which fulfils
  *   `'input_required'` results through the registered
  *   elicitation/sampling/roots handlers and retries via `flow.retry`;
  * - a future client-side terminal-result handler for
  *   `subscriptions/listen`, when the spec defines one.
  *
  * `Server` instances never receive `input_required` responses on their
  * outbound legs and leave the base behavior in place.
  */
  _resolveNonCompleteResult(decoded, flow) {
    return Promise.reject(new SdkError(SdkErrorCode.UnsupportedResultType, `Unsupported result type '${decoded.kind}' for ${flow.request.method}`, {
      resultType: decoded.kind,
      method: flow.request.method
    }));
  }
  /**
  * Protected accessor for a registered request handler. Used by role
  * classes that dispatch synthesized requests through the same stored
  * handler chain (e.g. the `Client` fulfilling an embedded multi-round-trip
  * input request).
  */
  _getRequestHandler(method) {
    return this._requestHandlers.get(method);
  }
  async _oncancel(notification) {
    if (!notification.params.requestId) return;
    this._requestHandlerAbortControllers.get(notification.params.requestId)?.abort(notification.params.reason);
  }
  _setupTimeout(messageId, timeout, maxTotalTimeout, onTimeout, resetTimeoutOnProgress = false) {
    this._timeoutInfo.set(messageId, {
      timeoutId: setTimeout(onTimeout, timeout),
      startTime: Date.now(),
      timeout,
      maxTotalTimeout,
      resetTimeoutOnProgress,
      onTimeout
    });
  }
  _resetTimeout(messageId) {
    const info = this._timeoutInfo.get(messageId);
    if (!info) return false;
    const totalElapsed = Date.now() - info.startTime;
    if (info.maxTotalTimeout && totalElapsed >= info.maxTotalTimeout) {
      this._timeoutInfo.delete(messageId);
      throw new SdkError(SdkErrorCode.RequestTimeout, "Maximum total timeout exceeded", {
        maxTotalTimeout: info.maxTotalTimeout,
        totalElapsed
      });
    }
    clearTimeout(info.timeoutId);
    info.timeoutId = setTimeout(info.onTimeout, info.timeout);
    return true;
  }
  _cleanupTimeout(messageId) {
    const info = this._timeoutInfo.get(messageId);
    if (info) {
      clearTimeout(info.timeoutId);
      this._timeoutInfo.delete(messageId);
    }
  }
  /**
  * Attaches to the given transport, starts it, and starts listening for messages.
  *
  * The caller assumes ownership of the {@linkcode Transport}, replacing any callbacks that have already been set, and expects that it is the only user of the {@linkcode Transport} instance going forward.
  */
  async connect(transport) {
    this._transport = transport;
    const _onclose = this.transport?.onclose;
    this._transport.onclose = () => {
      try {
        _onclose?.();
      } finally {
        this._onclose();
      }
    };
    const _onerror = this.transport?.onerror;
    this._transport.onerror = (error) => {
      _onerror?.(error);
      this._onerror(error);
    };
    const _onmessage = this._transport?.onmessage;
    this._transport.onmessage = (message, extra) => {
      _onmessage?.(message, extra);
      if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) this._onresponse(message);
      else if (isJSONRPCRequest(message)) this._onrequest(message, extra);
      else if (isJSONRPCNotification(message)) this._onnotification(message, extra);
      else this._onerror(/* @__PURE__ */ new Error(`Unknown message type: ${JSON.stringify(message)}`));
    };
    transport.setSupportedProtocolVersions?.(this._supportedProtocolVersions);
    await this._transport.start();
  }
  /**
  * Transport-close hook. Subclass overrides MUST call `super._onclose()`
  * after their own cleanup — base teardown (response-handler settlement,
  * timeout clearing, in-flight request abort) does not run otherwise.
  */
  _onclose() {
    const responseHandlers = this._responseHandlers;
    this._responseHandlers = /* @__PURE__ */ new Map();
    this._progressHandlers.clear();
    this._pendingDebouncedNotifications.clear();
    for (const info of this._timeoutInfo.values()) clearTimeout(info.timeoutId);
    this._timeoutInfo.clear();
    const requestHandlerAbortControllers = this._requestHandlerAbortControllers;
    this._requestHandlerAbortControllers = /* @__PURE__ */ new Map();
    const error = new SdkError(SdkErrorCode.ConnectionClosed, "Connection closed");
    this._transport = void 0;
    try {
      this.onclose?.();
    } finally {
      for (const handler of responseHandlers.values()) handler(error);
      for (const controller of requestHandlerAbortControllers.values()) controller.abort(error);
    }
  }
  _onerror(error) {
    this.onerror?.(error);
  }
  /**
  * Inbound-notification dispatch. Subclass overrides MUST delegate
  * unmatched traffic to `super._onnotification(rawNotification, extra)` —
  * an override that consumes only what it owns and falls through to base
  * dispatch for everything else.
  */
  _onnotification(rawNotification, extra) {
    const { message: notification } = liftWireOnlyMaterial(rawNotification, "notification");
    const codec = this._negotiatedWireCodec();
    if (extra?.classification === void 0 && this._shouldDropInbound(rawNotification) === "drop") return;
    if (extra?.classification !== void 0) {
      const classified = classifiedWireEra(extra.classification);
      if (classified !== codec.era) {
        this._onerror(/* @__PURE__ */ new Error(`Era mismatch on inbound notification '${notification.method}': classified as ${classified} but this instance serves ${codec.era}`));
        return;
      }
    }
    if (isSpecNotificationMethod(notification.method) && !codec.hasNotificationMethod(notification.method)) return;
    const handler = this._notificationHandlers.get(notification.method);
    const fallback = this.fallbackNotificationHandler;
    if (handler === void 0 && fallback === void 0) return;
    Promise.resolve().then(() => handler === void 0 ? fallback(notification) : handler(notification, codec)).catch((error) => this._onerror(/* @__PURE__ */ new Error(`Uncaught error in notification handler: ${error}`)));
  }
  _onrequest(rawRequest, extra) {
    const { message: request, lifted } = liftWireOnlyMaterial(rawRequest, "request");
    const codec = this._negotiatedWireCodec();
    if (extra?.classification === void 0 && this._shouldDropInbound(rawRequest) === "drop") {
      this._onerror(/* @__PURE__ */ new Error(`Dropped inbound request '${rawRequest.method}': not servable on this connection's protocol era`));
      return;
    }
    const capturedTransport = this._transport;
    const sendErrorResponse = (code, message, data) => {
      const errorResponse = {
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code,
          message,
          ...data !== void 0 && { data }
        }
      };
      capturedTransport?.send(errorResponse).catch((error) => this._onerror(/* @__PURE__ */ new Error(`Failed to send an error response: ${error}`)));
    };
    if (extra?.classification !== void 0) {
      const classified = classifiedWireEra(extra.classification);
      if (classified !== codec.era) {
        this._onerror(/* @__PURE__ */ new Error(`Era mismatch on inbound request '${request.method}': classified as ${classified} but this instance serves ${codec.era}`));
        const requested = extra.classification.revision ?? classified;
        sendErrorResponse(ProtocolErrorCode.UnsupportedProtocolVersion, `Unsupported protocol version: ${requested}`, {
          supported: this._supportedProtocolVersions,
          requested
        });
        return;
      }
    }
    if (isSpecRequestMethod(request.method) && !codec.hasRequestMethod(request.method)) {
      sendErrorResponse(ProtocolErrorCode.MethodNotFound, "Method not found");
      return;
    }
    const handler = this._requestHandlers.get(request.method) ?? this.fallbackRequestHandler;
    if (handler === void 0) {
      sendErrorResponse(ProtocolErrorCode.MethodNotFound, "Method not found");
      return;
    }
    const envelopeError = codec.checkInboundEnvelope(lifted);
    if (envelopeError !== void 0) {
      sendErrorResponse(ProtocolErrorCode.InvalidParams, envelopeError);
      return;
    }
    const sendNotification = (notification, options) => this._notificationViaCodec(this._resolveOutboundCodec(notification.method), notification, {
      ...options,
      relatedRequestId: request.id
    });
    const sendRequest = (r, resultSchema, options) => this._requestWithSchemaViaCodec(this._resolveOutboundCodec(r.method), r, resultSchema, {
      ...options,
      relatedRequestId: request.id
    });
    const abortController = new AbortController();
    this._requestHandlerAbortControllers.set(request.id, abortController);
    const partitionedInputResponses = lifted.inputResponses === void 0 ? void 0 : partitionInputResponses(lifted.inputResponses);
    const baseCtx = {
      sessionId: capturedTransport?.sessionId,
      mcpReq: {
        id: request.id,
        method: request.method,
        _meta: request.params?._meta,
        ...lifted.envelope !== void 0 && { envelope: lifted.envelope },
        ...partitionedInputResponses !== void 0 && { inputResponses: partitionedInputResponses.accepted },
        ...partitionedInputResponses !== void 0 && partitionedInputResponses.droppedKeys.length > 0 && { droppedInputResponseKeys: partitionedInputResponses.droppedKeys },
        requestState: lifted.requestState === void 0 ? NO_REQUEST_STATE : requestStateAccessor(lifted.requestState),
        signal: abortController.signal,
        send: (r, schemaOrOptions, maybeOptions) => {
          const sendCodec = this._resolveOutboundCodec(r.method);
          this._assertOutboundRequestInEra(sendCodec, r.method);
          if (isStandardSchema(schemaOrOptions)) return sendRequest(r, schemaOrOptions, maybeOptions);
          const validate = codecResultValidator(sendCodec, r.method);
          if (validate === void 0) throw new TypeError(`'${r.method}' is not a spec method; pass a result schema as the second argument to ctx.mcpReq.send().`);
          return sendRequest(r, validate, schemaOrOptions);
        },
        notify: sendNotification
      },
      http: extra?.authInfo ? { authInfo: extra.authInfo } : void 0
    };
    const ctx = this.buildContext(baseCtx, extra);
    Promise.resolve().then(() => handler(request, ctx)).then(async (result) => {
      if (abortController.signal.aborted) return;
      let encoded;
      try {
        encoded = codec.encodeResult(request.method, result, this._outboundServerInfo());
      } catch (error) {
        this._onerror(/* @__PURE__ */ new Error(`Failed to encode result for ${request.method}: ${error}`));
        sendErrorResponse(ProtocolErrorCode.InternalError, "Internal error");
        return;
      }
      const response = {
        result: encoded,
        jsonrpc: "2.0",
        id: request.id
      };
      await capturedTransport?.send(response);
    }, async (error) => {
      if (abortController.signal.aborted) return;
      const thrownCode = Number.isSafeInteger(error["code"]) ? error["code"] : ProtocolErrorCode.InternalError;
      const errorResponse = {
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: codec.encodeErrorCode(thrownCode),
          message: error.message ?? "Internal error",
          ...error["data"] !== void 0 && { data: error["data"] }
        }
      };
      await capturedTransport?.send(errorResponse);
    }).catch((error) => this._onerror(/* @__PURE__ */ new Error(`Failed to send response: ${error}`))).finally(() => {
      if (this._requestHandlerAbortControllers.get(request.id) === abortController) this._requestHandlerAbortControllers.delete(request.id);
    });
  }
  _onprogress(notification) {
    const { progressToken, ...params } = notification.params;
    const messageId = Number(progressToken);
    const handler = this._progressHandlers.get(messageId);
    if (!handler) {
      this._onerror(/* @__PURE__ */ new Error(`Received a progress notification for an unknown token: ${JSON.stringify(notification)}`));
      return;
    }
    const responseHandler = this._responseHandlers.get(messageId);
    const timeoutInfo = this._timeoutInfo.get(messageId);
    if (timeoutInfo && responseHandler && timeoutInfo.resetTimeoutOnProgress) try {
      this._resetTimeout(messageId);
    } catch (error) {
      this._responseHandlers.delete(messageId);
      this._progressHandlers.delete(messageId);
      this._cleanupTimeout(messageId);
      responseHandler(error);
      return;
    }
    handler(params);
  }
  /**
  * Inbound-response dispatch. Subclass overrides MUST delegate unmatched
  * traffic to `super._onresponse(response)` — an override that consumes
  * only what it owns and falls through to base dispatch for everything
  * else.
  */
  _onresponse(response) {
    const messageId = Number(response.id);
    const handler = this._responseHandlers.get(messageId);
    if (handler === void 0) {
      this._onerror(/* @__PURE__ */ new Error(`Received a response for an unknown message ID: ${JSON.stringify(response)}`));
      return;
    }
    this._responseHandlers.delete(messageId);
    this._cleanupTimeout(messageId);
    this._progressHandlers.delete(messageId);
    if (isJSONRPCResultResponse(response)) handler(response);
    else handler(ProtocolError.fromError(response.error.code, response.error.message, response.error.data));
  }
  get transport() {
    return this._transport;
  }
  /**
  * Closes the connection.
  */
  async close() {
    await this._transport?.close();
  }
  request(request, schemaOrOptions, maybeOptions) {
    const codec = this._resolveOutboundCodec(request.method);
    this._assertOutboundRequestInEra(codec, request.method);
    if (isStandardSchema(schemaOrOptions)) return this._requestWithSchemaViaCodec(codec, request, schemaOrOptions, maybeOptions);
    const validate = codecResultValidator(codec, request.method);
    if (validate === void 0) throw new TypeError(`'${request.method}' is not a spec method; pass a result schema as the second argument to request().`);
    return this._requestWithSchemaViaCodec(codec, request, validate, schemaOrOptions);
  }
  /**
  * The wire codec for this instance's negotiated era — the phase-2 truth:
  * everything an established connection sends and receives resolves
  * through it. Legacy until a version has been negotiated.
  */
  _negotiatedWireCodec() {
    return codecForVersion(this._negotiatedProtocolVersion);
  }
  /**
  * Protected accessor for the instance's negotiated wire codec, for role
  * classes (Client/Server/McpServer) routing era-dependent behavior
  * through the codec's function-only surface — `samplingResultVariant`,
  * `outboundEnvelope`, `projectCallToolResult` — instead of branching on
  * the protocol version themselves.
  */
  _wireCodec() {
    return this._negotiatedWireCodec();
  }
  /**
  * Outbound codec resolution: while the negotiated version is still unset
  * (the negotiation window), lifecycle messages are bootstrap-pinned BY
  * METHOD — they self-identify their era (`initialize` IS the legacy
  * handshake, `server/discover` IS the modern probe). Once a version has
  * been negotiated, the instance era is authoritative for everything — a
  * negotiated session never re-routes a method onto the other era.
  */
  _resolveOutboundCodec(method) {
    if (this._negotiatedProtocolVersion === void 0) {
      const pinned = bootstrapOutboundCodec(method);
      if (pinned) return pinned;
    }
    return this._negotiatedWireCodec();
  }
  /**
  * Era gate for outbound requests — deletions are physical in BOTH
  * directions: sending a spec method that the resolved era does not define
  * dies locally with a typed error before anything reaches the transport.
  * Methods outside the spec universe are consumer-owned extension methods
  * and stay era-blind.
  */
  _assertOutboundRequestInEra(codec, method) {
    if (isSpecRequestMethod(method) && !codec.hasRequestMethod(method)) throw new SdkError(SdkErrorCode.MethodNotSupportedByProtocolVersion, `Method '${method}' is not supported by the negotiated protocol version (wire era ${codec.era})`, {
      method,
      era: codec.era
    });
  }
  /**
  * Sends a request and waits for a response, using the provided schema for
  * validation instead of the era registry's method-keyed entry.
  *
  * This is the internal implementation used by SDK methods whose result
  * schema cannot be expressed as a method-keyed registry entry — the one
  * surviving case is `server.createMessage`, whose result schema depends
  * on the REQUEST params (tools vs no tools) — and by callers passing
  * explicit compatibility schemas. Spec methods are still era-gated here:
  * an explicit schema never smuggles a deleted method onto the wire.
  */
  _requestWithSchema(request, resultSchema, options) {
    const codec = this._resolveOutboundCodec(request.method);
    this._assertOutboundRequestInEra(codec, request.method);
    return this._requestWithSchemaViaCodec(codec, request, resultSchema, options);
  }
  /**
  * The request funnel proper, keyed by the resolved era codec: the codec
  * owns result decoding (raw-first `resultType` discrimination — V-1 —
  * and the era's lift posture) before the schema validation step.
  */
  _requestWithSchemaViaCodec(codec, request, resultSchema, options) {
    const { relatedRequestId, resumptionToken, onresumptiontoken, headers } = options ?? {};
    const flowStartedAt = Date.now();
    let onAbort;
    let cleanupMessageId;
    return new Promise((resolve2, reject) => {
      const earlyReject = (error) => {
        reject(error);
      };
      if (!this._transport) {
        earlyReject(/* @__PURE__ */ new Error("Not connected"));
        return;
      }
      if (this._options?.enforceStrictCapabilities === true) try {
        this.assertCapabilityForMethod(request.method);
      } catch (error) {
        earlyReject(error);
        return;
      }
      if (options?.signal?.aborted) {
        const reason = options.signal.reason;
        throw reason instanceof SdkError ? reason : new SdkError(SdkErrorCode.RequestTimeout, String(reason));
      }
      const requestAbort = codec.era === MODERN_WIRE_REVISION && this._transport.hasPerRequestStream === true ? new AbortController() : void 0;
      const messageId = this._requestMessageId++;
      cleanupMessageId = messageId;
      const jsonrpcRequest = {
        ...request,
        jsonrpc: "2.0",
        id: messageId
      };
      if (options?.onprogress) {
        this._progressHandlers.set(messageId, options.onprogress);
        jsonrpcRequest.params = {
          ...request.params,
          _meta: {
            ...request.params?._meta,
            progressToken: messageId
          }
        };
      }
      const outbound = this._envelopeOutbound(jsonrpcRequest);
      let responseReceived = false;
      const cancel = (reason) => {
        if (responseReceived) return;
        this._progressHandlers.delete(messageId);
        if (requestAbort === void 0) this._transport?.send(this._envelopeOutbound({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: {
            requestId: messageId,
            reason: String(reason)
          }
        }), {
          relatedRequestId,
          resumptionToken,
          onresumptiontoken
        }).catch((error) => this._onerror(/* @__PURE__ */ new Error(`Failed to send cancellation: ${error}`)));
        else requestAbort.abort();
        reject(reason instanceof SdkError ? reason : new SdkError(SdkErrorCode.RequestTimeout, String(reason)));
      };
      this._responseHandlers.set(messageId, (response) => {
        if (options?.signal?.aborted) return;
        responseReceived = true;
        if (response instanceof Error) return reject(response);
        let decoded;
        try {
          decoded = codec.decodeResult(request.method, response.result);
        } catch (error) {
          return reject(error instanceof Error ? error : new Error(String(error)));
        }
        if (decoded.kind === "invalid") return reject(decoded.error);
        if (decoded.kind === "input_required") {
          if (options?.allowInputRequired === true) return resolve2(manualInputRequiredValue(decoded));
          const flow = {
            codec,
            request,
            resultSchema,
            options,
            flowStartedAt,
            retry: (params, legOptions) => this._requestWithSchemaViaCodec(codec, params === void 0 ? { method: request.method } : {
              method: request.method,
              params
            }, resultSchema, legOptions)
          };
          return resolve2(this._resolveNonCompleteResult(decoded, flow));
        }
        const result = decoded.result;
        validateStandardSchema(resultSchema, result).then((parseResult) => {
          if (parseResult.success) resolve2(parseResult.data);
          else reject(new SdkError(SdkErrorCode.InvalidResult, `Invalid result for ${request.method}: ${parseResult.error}`));
        }, reject);
      });
      onAbort = () => cancel(options?.signal?.reason);
      options?.signal?.addEventListener("abort", onAbort, { once: true });
      const timeout = options?.timeout ?? DEFAULT_REQUEST_TIMEOUT_MSEC;
      const timeoutHandler = () => cancel(new SdkError(SdkErrorCode.RequestTimeout, "Request timed out", { timeout }));
      this._setupTimeout(messageId, timeout, options?.maxTotalTimeout, timeoutHandler, options?.resetTimeoutOnProgress ?? false);
      this._transport.send(outbound, {
        relatedRequestId,
        resumptionToken,
        onresumptiontoken,
        headers,
        requestSignal: requestAbort?.signal
      }).catch((error) => {
        this._progressHandlers.delete(messageId);
        reject(error);
      });
    }).finally(() => {
      if (onAbort) options?.signal?.removeEventListener("abort", onAbort);
      if (cleanupMessageId !== void 0) {
        this._responseHandlers.delete(cleanupMessageId);
        this._cleanupTimeout(cleanupMessageId);
      }
    });
  }
  /**
  * Emits a notification, which is a one-way message that does not expect a response.
  */
  async notification(notification, options) {
    return this._notificationViaCodec(this._resolveOutboundCodec(notification.method), notification, options);
  }
  /**
  * The notification funnel proper, keyed by the resolved era codec —
  * direct sends and related notifications (`ctx.mcpReq.notify`) alike
  * resolve through the instance's negotiated era at send time.
  */
  async _notificationViaCodec(codec, notification, options) {
    if (!this._transport) throw new SdkError(SdkErrorCode.NotConnected, "Not connected");
    if (isSpecNotificationMethod(notification.method) && !codec.hasNotificationMethod(notification.method)) throw new SdkError(SdkErrorCode.MethodNotSupportedByProtocolVersion, `Notification '${notification.method}' is not supported by the negotiated protocol version (wire era ${codec.era})`, {
      method: notification.method,
      era: codec.era
    });
    this.assertNotificationCapability(notification.method);
    const jsonrpcNotification = this._envelopeOutbound({
      jsonrpc: "2.0",
      ...notification
    });
    if ((this._options?.debouncedNotificationMethods ?? []).includes(notification.method) && !notification.params && !options?.relatedRequestId) {
      if (this._pendingDebouncedNotifications.has(notification.method)) return;
      this._pendingDebouncedNotifications.add(notification.method);
      Promise.resolve().then(() => {
        this._pendingDebouncedNotifications.delete(notification.method);
        if (!this._transport) return;
        this._transport?.send(jsonrpcNotification, options).catch((error) => this._onerror(error));
      });
      return;
    }
    await this._transport.send(jsonrpcNotification, options);
  }
  setRequestHandler(method, schemasOrHandler, maybeHandler) {
    this.assertRequestHandlerCapability(method);
    let stored;
    if (typeof schemasOrHandler === "function") {
      if (!isSpecRequestMethod(method)) throw new TypeError(`'${method}' is not a spec request method; pass schemas as the second argument to setRequestHandler().`);
      stored = (request, ctx) => {
        const dispatchCodec = this._negotiatedWireCodec();
        let outcome = dispatchCodec.validateRequest(method, request);
        if (!outcome.ok && outcome.reason === "not-in-era") outcome = dispatchCodec.validateInputRequest(method, request);
        if (!outcome.ok) {
          if (outcome.reason === "not-in-era") throw new ProtocolError(ProtocolErrorCode.InternalError, `No wire schema for ${method} in the resolved era`);
          throw new Error(outcome.message);
        }
        return Promise.resolve(schemasOrHandler(outcome.value, ctx));
      };
    } else if (maybeHandler) stored = async (request, ctx) => {
      const parsed = await validateStandardSchema(schemasOrHandler.params, { ...request.params });
      if (!parsed.success) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid params for ${method}: ${parsed.error}`);
      return maybeHandler(parsed.data, ctx);
    };
    else throw new TypeError("setRequestHandler: handler is required");
    this._requestHandlers.set(method, this._wrapHandler(method, stored));
  }
  /**
  * Hook for subclasses to wrap a registered request handler with role-specific
  * validation or behavior (e.g. `Server` validates `tools/call` results, `Client`
  * validates `elicitation/create` mode and result). Runs for both the 2-arg and
  * 3-arg registration paths. The default implementation is identity.
  *
  * Subclasses overriding this hook avoid redeclaring `setRequestHandler`'s overload set.
  */
  _wrapHandler(_method, handler) {
    return handler;
  }
  /**
  * Hook for subclasses to supply the implementation identity the 2026-era
  * encode seam stamps into outbound result `_meta` under
  * `io.modelcontextprotocol/serverInfo` (spec PR #3002: servers SHOULD
  * identify themselves on every response). The default is `undefined` — no
  * stamp. Only `Server` overrides this: the key identifies the software
  * producing a response, and the 2025-era codec never stamps anything
  * regardless (the never-stamp guarantee).
  */
  _outboundServerInfo() {
  }
  /**
  * Removes the request handler for the given method.
  */
  removeRequestHandler(method) {
    this._requestHandlers.delete(method);
  }
  /**
  * Asserts that a request handler has not already been set for the given method, in preparation for a new one being automatically installed.
  */
  assertCanSetRequestHandler(method) {
    if (this._requestHandlers.has(method)) throw new Error(`A request handler for ${method} already exists, which would be overridden`);
  }
  setNotificationHandler(method, schemasOrHandler, maybeHandler) {
    if (typeof schemasOrHandler === "function") {
      if (!isSpecNotificationMethod(method)) throw new TypeError(`'${method}' is not a spec notification method; pass schemas as the second argument to setNotificationHandler().`);
      this._notificationHandlers.set(method, (notification, codec) => {
        const outcome = codec.validateNotification(method, notification);
        if (!outcome.ok) {
          if (outcome.reason === "not-in-era") throw new ProtocolError(ProtocolErrorCode.InternalError, `No wire schema for ${method} in the resolved era`);
          throw new Error(outcome.message);
        }
        return Promise.resolve(schemasOrHandler(outcome.value));
      });
      return;
    }
    if (!maybeHandler) throw new TypeError("setNotificationHandler: handler is required");
    this._notificationHandlers.set(method, async (notification) => {
      const parsed = await validateStandardSchema(schemasOrHandler.params, { ...notification.params });
      if (!parsed.success) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid params for notification ${method}: ${parsed.error}`);
      await maybeHandler(parsed.data, notification);
    });
  }
  /**
  * Removes the notification handler for the given method.
  */
  removeNotificationHandler(method) {
    this._notificationHandlers.delete(method);
  }
};
function isPlainObject$1(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function mergeCapabilities(base, additional) {
  const result = { ...base };
  for (const key in additional) {
    const k = key;
    const addValue = additional[k];
    if (addValue === void 0) continue;
    const baseValue = result[k];
    result[k] = isPlainObject$1(baseValue) && isPlainObject$1(addValue) ? {
      ...baseValue,
      ...addValue
    } : addValue;
  }
  return result;
}
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function partitionInputResponses(inputResponses) {
  const accepted = {};
  const droppedKeys = [];
  if (!isPlainObject(inputResponses)) return {
    accepted,
    droppedKeys
  };
  for (const [key, entry] of Object.entries(inputResponses)) {
    if (!isPlainObject(entry) || "method" in entry || "result" in entry) {
      droppedKeys.push(key);
      continue;
    }
    accepted[key] = entry;
  }
  return {
    accepted,
    droppedKeys
  };
}
function manualInputRequiredValue(decoded) {
  return {
    resultType: "input_required",
    inputRequests: decoded.inputRequests,
    ...decoded.requestState !== void 0 && { requestState: decoded.requestState }
  };
}
var require_content_type = /* @__PURE__ */ __commonJSMin((exports) => {
  var PARAM_REGEXP = /; *([!#$%&'*+.^_`|~0-9A-Za-z-]+) *= *("(?:[\u000b\u0020\u0021\u0023-\u005b\u005d-\u007e\u0080-\u00ff]|\\[\u000b\u0020-\u00ff])*"|[!#$%&'*+.^_`|~0-9A-Za-z-]+) */g;
  var QESC_REGEXP = /\\([\u000b\u0020-\u00ff])/g;
  var TYPE_REGEXP = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
  exports.parse = parse;
  function parse(string3) {
    if (!string3) throw new TypeError("argument string is required");
    var header = typeof string3 === "object" ? getcontenttype(string3) : string3;
    if (typeof header !== "string") throw new TypeError("argument string is required to be a string");
    var index = header.indexOf(";");
    var type = index !== -1 ? header.slice(0, index).trim() : header.trim();
    if (!TYPE_REGEXP.test(type)) throw new TypeError("invalid media type");
    var obj = new ContentType(type.toLowerCase());
    if (index !== -1) {
      var key;
      var match;
      var value;
      PARAM_REGEXP.lastIndex = index;
      while (match = PARAM_REGEXP.exec(header)) {
        if (match.index !== index) throw new TypeError("invalid parameter format");
        index += match[0].length;
        key = match[1].toLowerCase();
        value = match[2];
        if (value.charCodeAt(0) === 34) {
          value = value.slice(1, -1);
          if (value.indexOf("\\") !== -1) value = value.replace(QESC_REGEXP, "$1");
        }
        obj.parameters[key] = value;
      }
      if (index !== header.length) throw new TypeError("invalid parameter format");
    }
    return obj;
  }
  function getcontenttype(obj) {
    var header;
    if (typeof obj.getHeader === "function") header = obj.getHeader("content-type");
    else if (typeof obj.headers === "object") header = obj.headers && obj.headers["content-type"];
    if (typeof header !== "string") throw new TypeError("content-type header is missing from object");
    return header;
  }
  function ContentType(type) {
    this.parameters = /* @__PURE__ */ Object.create(null);
    this.type = type;
  }
});
var import_content_type = /* @__PURE__ */ __toESM(require_content_type(), 1);
function mediaTypeEssence(header) {
  if (!header) return;
  try {
    return import_content_type.parse(header).type;
  } catch {
    const essence = (header.split(";", 1)[0] ?? "").trim().toLowerCase();
    if (essence === "" || header.slice(essence.length).includes(",")) return;
    return essence;
  }
}
function isJsonContentType(header) {
  if (header === "application/json") return true;
  return mediaTypeEssence(header) === "application/json";
}
var STDIO_DEFAULT_MAX_BUFFER_SIZE = 10 * 1024 * 1024;
var ReadBuffer = class {
  _buffer;
  _maxBufferSize;
  constructor(options) {
    this._maxBufferSize = options?.maxBufferSize ?? STDIO_DEFAULT_MAX_BUFFER_SIZE;
  }
  append(chunk) {
    if ((this._buffer?.length ?? 0) + chunk.length > this._maxBufferSize) {
      this.clear();
      throw new Error(`ReadBuffer exceeded maximum size of ${this._maxBufferSize} bytes`);
    }
    this._buffer = this._buffer ? Buffer.concat([this._buffer, chunk]) : chunk;
  }
  readMessage() {
    while (this._buffer) {
      const index = this._buffer.indexOf("\n");
      if (index === -1) return null;
      const line = this._buffer.toString("utf8", 0, index).replace(/\r$/, "");
      this._buffer = this._buffer.subarray(index + 1);
      try {
        return deserializeMessage(line);
      } catch (error) {
        if (error instanceof SyntaxError) continue;
        throw error;
      }
    }
    return null;
  }
  clear() {
    this._buffer = void 0;
  }
};
function deserializeMessage(line) {
  return JSONRPCMessageSchema.parse(JSON.parse(line));
}
function serializeMessage(message) {
  return JSON.stringify(message) + "\n";
}

// ../../node_modules/@modelcontextprotocol/server/dist/ajvProvider-CEoC__sr.mjs
var require_code$1 = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.regexpCode = exports.getEsmExportName = exports.getProperty = exports.safeStringify = exports.stringify = exports.strConcat = exports.addCodeArg = exports.str = exports._ = exports.nil = exports._Code = exports.Name = exports.IDENTIFIER = exports._CodeOrName = void 0;
  var _CodeOrName = class {
  };
  exports._CodeOrName = _CodeOrName;
  exports.IDENTIFIER = /^[a-z$_][a-z$_0-9]*$/i;
  var Name = class extends _CodeOrName {
    constructor(s) {
      super();
      if (!exports.IDENTIFIER.test(s)) throw new Error("CodeGen: name must be a valid identifier");
      this.str = s;
    }
    toString() {
      return this.str;
    }
    emptyStr() {
      return false;
    }
    get names() {
      return { [this.str]: 1 };
    }
  };
  exports.Name = Name;
  var _Code = class extends _CodeOrName {
    constructor(code) {
      super();
      this._items = typeof code === "string" ? [code] : code;
    }
    toString() {
      return this.str;
    }
    emptyStr() {
      if (this._items.length > 1) return false;
      const item = this._items[0];
      return item === "" || item === '""';
    }
    get str() {
      var _a;
      return (_a = this._str) !== null && _a !== void 0 ? _a : this._str = this._items.reduce((s, c) => `${s}${c}`, "");
    }
    get names() {
      var _a;
      return (_a = this._names) !== null && _a !== void 0 ? _a : this._names = this._items.reduce((names, c) => {
        if (c instanceof Name) names[c.str] = (names[c.str] || 0) + 1;
        return names;
      }, {});
    }
  };
  exports._Code = _Code;
  exports.nil = new _Code("");
  function _(strs, ...args) {
    const code = [strs[0]];
    let i = 0;
    while (i < args.length) {
      addCodeArg(code, args[i]);
      code.push(strs[++i]);
    }
    return new _Code(code);
  }
  exports._ = _;
  const plus = new _Code("+");
  function str(strs, ...args) {
    const expr = [safeStringify(strs[0])];
    let i = 0;
    while (i < args.length) {
      expr.push(plus);
      addCodeArg(expr, args[i]);
      expr.push(plus, safeStringify(strs[++i]));
    }
    optimize(expr);
    return new _Code(expr);
  }
  exports.str = str;
  function addCodeArg(code, arg) {
    if (arg instanceof _Code) code.push(...arg._items);
    else if (arg instanceof Name) code.push(arg);
    else code.push(interpolate(arg));
  }
  exports.addCodeArg = addCodeArg;
  function optimize(expr) {
    let i = 1;
    while (i < expr.length - 1) {
      if (expr[i] === plus) {
        const res = mergeExprItems(expr[i - 1], expr[i + 1]);
        if (res !== void 0) {
          expr.splice(i - 1, 3, res);
          continue;
        }
        expr[i++] = "+";
      }
      i++;
    }
  }
  function mergeExprItems(a, b) {
    if (b === '""') return a;
    if (a === '""') return b;
    if (typeof a == "string") {
      if (b instanceof Name || a[a.length - 1] !== '"') return;
      if (typeof b != "string") return `${a.slice(0, -1)}${b}"`;
      if (b[0] === '"') return a.slice(0, -1) + b.slice(1);
      return;
    }
    if (typeof b == "string" && b[0] === '"' && !(a instanceof Name)) return `"${a}${b.slice(1)}`;
  }
  function strConcat(c1, c2) {
    return c2.emptyStr() ? c1 : c1.emptyStr() ? c2 : str`${c1}${c2}`;
  }
  exports.strConcat = strConcat;
  function interpolate(x) {
    return typeof x == "number" || typeof x == "boolean" || x === null ? x : safeStringify(Array.isArray(x) ? x.join(",") : x);
  }
  function stringify(x) {
    return new _Code(safeStringify(x));
  }
  exports.stringify = stringify;
  function safeStringify(x) {
    return JSON.stringify(x).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  }
  exports.safeStringify = safeStringify;
  function getProperty(key) {
    return typeof key == "string" && exports.IDENTIFIER.test(key) ? new _Code(`.${key}`) : _`[${key}]`;
  }
  exports.getProperty = getProperty;
  function getEsmExportName(key) {
    if (typeof key == "string" && exports.IDENTIFIER.test(key)) return new _Code(`${key}`);
    throw new Error(`CodeGen: invalid export name: ${key}, use explicit $id name mapping`);
  }
  exports.getEsmExportName = getEsmExportName;
  function regexpCode(rx) {
    return new _Code(rx.toString());
  }
  exports.regexpCode = regexpCode;
});
var require_scope = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.ValueScope = exports.ValueScopeName = exports.Scope = exports.varKinds = exports.UsedValueState = void 0;
  const code_1 = require_code$1();
  var ValueError = class extends Error {
    constructor(name) {
      super(`CodeGen: "code" for ${name} not defined`);
      this.value = name.value;
    }
  };
  var UsedValueState;
  (function(UsedValueState2) {
    UsedValueState2[UsedValueState2["Started"] = 0] = "Started";
    UsedValueState2[UsedValueState2["Completed"] = 1] = "Completed";
  })(UsedValueState || (exports.UsedValueState = UsedValueState = {}));
  exports.varKinds = {
    const: new code_1.Name("const"),
    let: new code_1.Name("let"),
    var: new code_1.Name("var")
  };
  var Scope = class {
    constructor({ prefixes, parent } = {}) {
      this._names = {};
      this._prefixes = prefixes;
      this._parent = parent;
    }
    toName(nameOrPrefix) {
      return nameOrPrefix instanceof code_1.Name ? nameOrPrefix : this.name(nameOrPrefix);
    }
    name(prefix) {
      return new code_1.Name(this._newName(prefix));
    }
    _newName(prefix) {
      const ng = this._names[prefix] || this._nameGroup(prefix);
      return `${prefix}${ng.index++}`;
    }
    _nameGroup(prefix) {
      var _a, _b;
      if (((_b = (_a = this._parent) === null || _a === void 0 ? void 0 : _a._prefixes) === null || _b === void 0 ? void 0 : _b.has(prefix)) || this._prefixes && !this._prefixes.has(prefix)) throw new Error(`CodeGen: prefix "${prefix}" is not allowed in this scope`);
      return this._names[prefix] = {
        prefix,
        index: 0
      };
    }
  };
  exports.Scope = Scope;
  var ValueScopeName = class extends code_1.Name {
    constructor(prefix, nameStr) {
      super(nameStr);
      this.prefix = prefix;
    }
    setValue(value, { property, itemIndex }) {
      this.value = value;
      this.scopePath = (0, code_1._)`.${new code_1.Name(property)}[${itemIndex}]`;
    }
  };
  exports.ValueScopeName = ValueScopeName;
  const line = (0, code_1._)`\n`;
  var ValueScope = class extends Scope {
    constructor(opts) {
      super(opts);
      this._values = {};
      this._scope = opts.scope;
      this.opts = {
        ...opts,
        _n: opts.lines ? line : code_1.nil
      };
    }
    get() {
      return this._scope;
    }
    name(prefix) {
      return new ValueScopeName(prefix, this._newName(prefix));
    }
    value(nameOrPrefix, value) {
      var _a;
      if (value.ref === void 0) throw new Error("CodeGen: ref must be passed in value");
      const name = this.toName(nameOrPrefix);
      const { prefix } = name;
      const valueKey = (_a = value.key) !== null && _a !== void 0 ? _a : value.ref;
      let vs = this._values[prefix];
      if (vs) {
        const _name = vs.get(valueKey);
        if (_name) return _name;
      } else vs = this._values[prefix] = /* @__PURE__ */ new Map();
      vs.set(valueKey, name);
      const s = this._scope[prefix] || (this._scope[prefix] = []);
      const itemIndex = s.length;
      s[itemIndex] = value.ref;
      name.setValue(value, {
        property: prefix,
        itemIndex
      });
      return name;
    }
    getValue(prefix, keyOrRef) {
      const vs = this._values[prefix];
      if (!vs) return;
      return vs.get(keyOrRef);
    }
    scopeRefs(scopeName, values = this._values) {
      return this._reduceValues(values, (name) => {
        if (name.scopePath === void 0) throw new Error(`CodeGen: name "${name}" has no value`);
        return (0, code_1._)`${scopeName}${name.scopePath}`;
      });
    }
    scopeCode(values = this._values, usedValues, getCode) {
      return this._reduceValues(values, (name) => {
        if (name.value === void 0) throw new Error(`CodeGen: name "${name}" has no value`);
        return name.value.code;
      }, usedValues, getCode);
    }
    _reduceValues(values, valueCode, usedValues = {}, getCode) {
      let code = code_1.nil;
      for (const prefix in values) {
        const vs = values[prefix];
        if (!vs) continue;
        const nameSet = usedValues[prefix] = usedValues[prefix] || /* @__PURE__ */ new Map();
        vs.forEach((name) => {
          if (nameSet.has(name)) return;
          nameSet.set(name, UsedValueState.Started);
          let c = valueCode(name);
          if (c) {
            const def = this.opts.es5 ? exports.varKinds.var : exports.varKinds.const;
            code = (0, code_1._)`${code}${def} ${name} = ${c};${this.opts._n}`;
          } else if (c = getCode === null || getCode === void 0 ? void 0 : getCode(name)) code = (0, code_1._)`${code}${c}${this.opts._n}`;
          else throw new ValueError(name);
          nameSet.set(name, UsedValueState.Completed);
        });
      }
      return code;
    }
  };
  exports.ValueScope = ValueScope;
});
var require_codegen = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.or = exports.and = exports.not = exports.CodeGen = exports.operators = exports.varKinds = exports.ValueScopeName = exports.ValueScope = exports.Scope = exports.Name = exports.regexpCode = exports.stringify = exports.getProperty = exports.nil = exports.strConcat = exports.str = exports._ = void 0;
  const code_1 = require_code$1();
  const scope_1 = require_scope();
  var code_2 = require_code$1();
  Object.defineProperty(exports, "_", {
    enumerable: true,
    get: function() {
      return code_2._;
    }
  });
  Object.defineProperty(exports, "str", {
    enumerable: true,
    get: function() {
      return code_2.str;
    }
  });
  Object.defineProperty(exports, "strConcat", {
    enumerable: true,
    get: function() {
      return code_2.strConcat;
    }
  });
  Object.defineProperty(exports, "nil", {
    enumerable: true,
    get: function() {
      return code_2.nil;
    }
  });
  Object.defineProperty(exports, "getProperty", {
    enumerable: true,
    get: function() {
      return code_2.getProperty;
    }
  });
  Object.defineProperty(exports, "stringify", {
    enumerable: true,
    get: function() {
      return code_2.stringify;
    }
  });
  Object.defineProperty(exports, "regexpCode", {
    enumerable: true,
    get: function() {
      return code_2.regexpCode;
    }
  });
  Object.defineProperty(exports, "Name", {
    enumerable: true,
    get: function() {
      return code_2.Name;
    }
  });
  var scope_2 = require_scope();
  Object.defineProperty(exports, "Scope", {
    enumerable: true,
    get: function() {
      return scope_2.Scope;
    }
  });
  Object.defineProperty(exports, "ValueScope", {
    enumerable: true,
    get: function() {
      return scope_2.ValueScope;
    }
  });
  Object.defineProperty(exports, "ValueScopeName", {
    enumerable: true,
    get: function() {
      return scope_2.ValueScopeName;
    }
  });
  Object.defineProperty(exports, "varKinds", {
    enumerable: true,
    get: function() {
      return scope_2.varKinds;
    }
  });
  exports.operators = {
    GT: new code_1._Code(">"),
    GTE: new code_1._Code(">="),
    LT: new code_1._Code("<"),
    LTE: new code_1._Code("<="),
    EQ: new code_1._Code("==="),
    NEQ: new code_1._Code("!=="),
    NOT: new code_1._Code("!"),
    OR: new code_1._Code("||"),
    AND: new code_1._Code("&&"),
    ADD: new code_1._Code("+")
  };
  var Node = class {
    optimizeNodes() {
      return this;
    }
    optimizeNames(_names, _constants) {
      return this;
    }
  };
  var Def = class extends Node {
    constructor(varKind, name, rhs) {
      super();
      this.varKind = varKind;
      this.name = name;
      this.rhs = rhs;
    }
    render({ es5, _n }) {
      const varKind = es5 ? scope_1.varKinds.var : this.varKind;
      const rhs = this.rhs === void 0 ? "" : ` = ${this.rhs}`;
      return `${varKind} ${this.name}${rhs};` + _n;
    }
    optimizeNames(names, constants) {
      if (!names[this.name.str]) return;
      if (this.rhs) this.rhs = optimizeExpr(this.rhs, names, constants);
      return this;
    }
    get names() {
      return this.rhs instanceof code_1._CodeOrName ? this.rhs.names : {};
    }
  };
  var Assign = class extends Node {
    constructor(lhs, rhs, sideEffects) {
      super();
      this.lhs = lhs;
      this.rhs = rhs;
      this.sideEffects = sideEffects;
    }
    render({ _n }) {
      return `${this.lhs} = ${this.rhs};` + _n;
    }
    optimizeNames(names, constants) {
      if (this.lhs instanceof code_1.Name && !names[this.lhs.str] && !this.sideEffects) return;
      this.rhs = optimizeExpr(this.rhs, names, constants);
      return this;
    }
    get names() {
      return addExprNames(this.lhs instanceof code_1.Name ? {} : { ...this.lhs.names }, this.rhs);
    }
  };
  var AssignOp = class extends Assign {
    constructor(lhs, op, rhs, sideEffects) {
      super(lhs, rhs, sideEffects);
      this.op = op;
    }
    render({ _n }) {
      return `${this.lhs} ${this.op}= ${this.rhs};` + _n;
    }
  };
  var Label = class extends Node {
    constructor(label) {
      super();
      this.label = label;
      this.names = {};
    }
    render({ _n }) {
      return `${this.label}:` + _n;
    }
  };
  var Break = class extends Node {
    constructor(label) {
      super();
      this.label = label;
      this.names = {};
    }
    render({ _n }) {
      return `break${this.label ? ` ${this.label}` : ""};` + _n;
    }
  };
  var Throw = class extends Node {
    constructor(error) {
      super();
      this.error = error;
    }
    render({ _n }) {
      return `throw ${this.error};` + _n;
    }
    get names() {
      return this.error.names;
    }
  };
  var AnyCode = class extends Node {
    constructor(code) {
      super();
      this.code = code;
    }
    render({ _n }) {
      return `${this.code};` + _n;
    }
    optimizeNodes() {
      return `${this.code}` ? this : void 0;
    }
    optimizeNames(names, constants) {
      this.code = optimizeExpr(this.code, names, constants);
      return this;
    }
    get names() {
      return this.code instanceof code_1._CodeOrName ? this.code.names : {};
    }
  };
  var ParentNode = class extends Node {
    constructor(nodes = []) {
      super();
      this.nodes = nodes;
    }
    render(opts) {
      return this.nodes.reduce((code, n) => code + n.render(opts), "");
    }
    optimizeNodes() {
      const { nodes } = this;
      let i = nodes.length;
      while (i--) {
        const n = nodes[i].optimizeNodes();
        if (Array.isArray(n)) nodes.splice(i, 1, ...n);
        else if (n) nodes[i] = n;
        else nodes.splice(i, 1);
      }
      return nodes.length > 0 ? this : void 0;
    }
    optimizeNames(names, constants) {
      const { nodes } = this;
      let i = nodes.length;
      while (i--) {
        const n = nodes[i];
        if (n.optimizeNames(names, constants)) continue;
        subtractNames(names, n.names);
        nodes.splice(i, 1);
      }
      return nodes.length > 0 ? this : void 0;
    }
    get names() {
      return this.nodes.reduce((names, n) => addNames(names, n.names), {});
    }
  };
  var BlockNode = class extends ParentNode {
    render(opts) {
      return "{" + opts._n + super.render(opts) + "}" + opts._n;
    }
  };
  var Root = class extends ParentNode {
  };
  var Else = class extends BlockNode {
  };
  Else.kind = "else";
  var If = class If2 extends BlockNode {
    constructor(condition, nodes) {
      super(nodes);
      this.condition = condition;
    }
    render(opts) {
      let code = `if(${this.condition})` + super.render(opts);
      if (this.else) code += "else " + this.else.render(opts);
      return code;
    }
    optimizeNodes() {
      super.optimizeNodes();
      const cond = this.condition;
      if (cond === true) return this.nodes;
      let e = this.else;
      if (e) {
        const ns = e.optimizeNodes();
        e = this.else = Array.isArray(ns) ? new Else(ns) : ns;
      }
      if (e) {
        if (cond === false) return e instanceof If2 ? e : e.nodes;
        if (this.nodes.length) return this;
        return new If2(not(cond), e instanceof If2 ? [e] : e.nodes);
      }
      if (cond === false || !this.nodes.length) return void 0;
      return this;
    }
    optimizeNames(names, constants) {
      var _a;
      this.else = (_a = this.else) === null || _a === void 0 ? void 0 : _a.optimizeNames(names, constants);
      if (!(super.optimizeNames(names, constants) || this.else)) return;
      this.condition = optimizeExpr(this.condition, names, constants);
      return this;
    }
    get names() {
      const names = super.names;
      addExprNames(names, this.condition);
      if (this.else) addNames(names, this.else.names);
      return names;
    }
  };
  If.kind = "if";
  var For = class extends BlockNode {
  };
  For.kind = "for";
  var ForLoop = class extends For {
    constructor(iteration) {
      super();
      this.iteration = iteration;
    }
    render(opts) {
      return `for(${this.iteration})` + super.render(opts);
    }
    optimizeNames(names, constants) {
      if (!super.optimizeNames(names, constants)) return;
      this.iteration = optimizeExpr(this.iteration, names, constants);
      return this;
    }
    get names() {
      return addNames(super.names, this.iteration.names);
    }
  };
  var ForRange = class extends For {
    constructor(varKind, name, from, to) {
      super();
      this.varKind = varKind;
      this.name = name;
      this.from = from;
      this.to = to;
    }
    render(opts) {
      const varKind = opts.es5 ? scope_1.varKinds.var : this.varKind;
      const { name, from, to } = this;
      return `for(${varKind} ${name}=${from}; ${name}<${to}; ${name}++)` + super.render(opts);
    }
    get names() {
      return addExprNames(addExprNames(super.names, this.from), this.to);
    }
  };
  var ForIter = class extends For {
    constructor(loop, varKind, name, iterable) {
      super();
      this.loop = loop;
      this.varKind = varKind;
      this.name = name;
      this.iterable = iterable;
    }
    render(opts) {
      return `for(${this.varKind} ${this.name} ${this.loop} ${this.iterable})` + super.render(opts);
    }
    optimizeNames(names, constants) {
      if (!super.optimizeNames(names, constants)) return;
      this.iterable = optimizeExpr(this.iterable, names, constants);
      return this;
    }
    get names() {
      return addNames(super.names, this.iterable.names);
    }
  };
  var Func = class extends BlockNode {
    constructor(name, args, async) {
      super();
      this.name = name;
      this.args = args;
      this.async = async;
    }
    render(opts) {
      return `${this.async ? "async " : ""}function ${this.name}(${this.args})` + super.render(opts);
    }
  };
  Func.kind = "func";
  var Return = class extends ParentNode {
    render(opts) {
      return "return " + super.render(opts);
    }
  };
  Return.kind = "return";
  var Try = class extends BlockNode {
    render(opts) {
      let code = "try" + super.render(opts);
      if (this.catch) code += this.catch.render(opts);
      if (this.finally) code += this.finally.render(opts);
      return code;
    }
    optimizeNodes() {
      var _a, _b;
      super.optimizeNodes();
      (_a = this.catch) === null || _a === void 0 || _a.optimizeNodes();
      (_b = this.finally) === null || _b === void 0 || _b.optimizeNodes();
      return this;
    }
    optimizeNames(names, constants) {
      var _a, _b;
      super.optimizeNames(names, constants);
      (_a = this.catch) === null || _a === void 0 || _a.optimizeNames(names, constants);
      (_b = this.finally) === null || _b === void 0 || _b.optimizeNames(names, constants);
      return this;
    }
    get names() {
      const names = super.names;
      if (this.catch) addNames(names, this.catch.names);
      if (this.finally) addNames(names, this.finally.names);
      return names;
    }
  };
  var Catch = class extends BlockNode {
    constructor(error) {
      super();
      this.error = error;
    }
    render(opts) {
      return `catch(${this.error})` + super.render(opts);
    }
  };
  Catch.kind = "catch";
  var Finally = class extends BlockNode {
    render(opts) {
      return "finally" + super.render(opts);
    }
  };
  Finally.kind = "finally";
  var CodeGen = class {
    constructor(extScope, opts = {}) {
      this._values = {};
      this._blockStarts = [];
      this._constants = {};
      this.opts = {
        ...opts,
        _n: opts.lines ? "\n" : ""
      };
      this._extScope = extScope;
      this._scope = new scope_1.Scope({ parent: extScope });
      this._nodes = [new Root()];
    }
    toString() {
      return this._root.render(this.opts);
    }
    name(prefix) {
      return this._scope.name(prefix);
    }
    scopeName(prefix) {
      return this._extScope.name(prefix);
    }
    scopeValue(prefixOrName, value) {
      const name = this._extScope.value(prefixOrName, value);
      (this._values[name.prefix] || (this._values[name.prefix] = /* @__PURE__ */ new Set())).add(name);
      return name;
    }
    getScopeValue(prefix, keyOrRef) {
      return this._extScope.getValue(prefix, keyOrRef);
    }
    scopeRefs(scopeName) {
      return this._extScope.scopeRefs(scopeName, this._values);
    }
    scopeCode() {
      return this._extScope.scopeCode(this._values);
    }
    _def(varKind, nameOrPrefix, rhs, constant) {
      const name = this._scope.toName(nameOrPrefix);
      if (rhs !== void 0 && constant) this._constants[name.str] = rhs;
      this._leafNode(new Def(varKind, name, rhs));
      return name;
    }
    const(nameOrPrefix, rhs, _constant) {
      return this._def(scope_1.varKinds.const, nameOrPrefix, rhs, _constant);
    }
    let(nameOrPrefix, rhs, _constant) {
      return this._def(scope_1.varKinds.let, nameOrPrefix, rhs, _constant);
    }
    var(nameOrPrefix, rhs, _constant) {
      return this._def(scope_1.varKinds.var, nameOrPrefix, rhs, _constant);
    }
    assign(lhs, rhs, sideEffects) {
      return this._leafNode(new Assign(lhs, rhs, sideEffects));
    }
    add(lhs, rhs) {
      return this._leafNode(new AssignOp(lhs, exports.operators.ADD, rhs));
    }
    code(c) {
      if (typeof c == "function") c();
      else if (c !== code_1.nil) this._leafNode(new AnyCode(c));
      return this;
    }
    object(...keyValues) {
      const code = ["{"];
      for (const [key, value] of keyValues) {
        if (code.length > 1) code.push(",");
        code.push(key);
        if (key !== value || this.opts.es5) {
          code.push(":");
          (0, code_1.addCodeArg)(code, value);
        }
      }
      code.push("}");
      return new code_1._Code(code);
    }
    if(condition, thenBody, elseBody) {
      this._blockNode(new If(condition));
      if (thenBody && elseBody) this.code(thenBody).else().code(elseBody).endIf();
      else if (thenBody) this.code(thenBody).endIf();
      else if (elseBody) throw new Error('CodeGen: "else" body without "then" body');
      return this;
    }
    elseIf(condition) {
      return this._elseNode(new If(condition));
    }
    else() {
      return this._elseNode(new Else());
    }
    endIf() {
      return this._endBlockNode(If, Else);
    }
    _for(node, forBody) {
      this._blockNode(node);
      if (forBody) this.code(forBody).endFor();
      return this;
    }
    for(iteration, forBody) {
      return this._for(new ForLoop(iteration), forBody);
    }
    forRange(nameOrPrefix, from, to, forBody, varKind = this.opts.es5 ? scope_1.varKinds.var : scope_1.varKinds.let) {
      const name = this._scope.toName(nameOrPrefix);
      return this._for(new ForRange(varKind, name, from, to), () => forBody(name));
    }
    forOf(nameOrPrefix, iterable, forBody, varKind = scope_1.varKinds.const) {
      const name = this._scope.toName(nameOrPrefix);
      if (this.opts.es5) {
        const arr = iterable instanceof code_1.Name ? iterable : this.var("_arr", iterable);
        return this.forRange("_i", 0, (0, code_1._)`${arr}.length`, (i) => {
          this.var(name, (0, code_1._)`${arr}[${i}]`);
          forBody(name);
        });
      }
      return this._for(new ForIter("of", varKind, name, iterable), () => forBody(name));
    }
    forIn(nameOrPrefix, obj, forBody, varKind = this.opts.es5 ? scope_1.varKinds.var : scope_1.varKinds.const) {
      if (this.opts.ownProperties) return this.forOf(nameOrPrefix, (0, code_1._)`Object.keys(${obj})`, forBody);
      const name = this._scope.toName(nameOrPrefix);
      return this._for(new ForIter("in", varKind, name, obj), () => forBody(name));
    }
    endFor() {
      return this._endBlockNode(For);
    }
    label(label) {
      return this._leafNode(new Label(label));
    }
    break(label) {
      return this._leafNode(new Break(label));
    }
    return(value) {
      const node = new Return();
      this._blockNode(node);
      this.code(value);
      if (node.nodes.length !== 1) throw new Error('CodeGen: "return" should have one node');
      return this._endBlockNode(Return);
    }
    try(tryBody, catchCode, finallyCode) {
      if (!catchCode && !finallyCode) throw new Error('CodeGen: "try" without "catch" and "finally"');
      const node = new Try();
      this._blockNode(node);
      this.code(tryBody);
      if (catchCode) {
        const error = this.name("e");
        this._currNode = node.catch = new Catch(error);
        catchCode(error);
      }
      if (finallyCode) {
        this._currNode = node.finally = new Finally();
        this.code(finallyCode);
      }
      return this._endBlockNode(Catch, Finally);
    }
    throw(error) {
      return this._leafNode(new Throw(error));
    }
    block(body, nodeCount) {
      this._blockStarts.push(this._nodes.length);
      if (body) this.code(body).endBlock(nodeCount);
      return this;
    }
    endBlock(nodeCount) {
      const len = this._blockStarts.pop();
      if (len === void 0) throw new Error("CodeGen: not in self-balancing block");
      const toClose = this._nodes.length - len;
      if (toClose < 0 || nodeCount !== void 0 && toClose !== nodeCount) throw new Error(`CodeGen: wrong number of nodes: ${toClose} vs ${nodeCount} expected`);
      this._nodes.length = len;
      return this;
    }
    func(name, args = code_1.nil, async, funcBody) {
      this._blockNode(new Func(name, args, async));
      if (funcBody) this.code(funcBody).endFunc();
      return this;
    }
    endFunc() {
      return this._endBlockNode(Func);
    }
    optimize(n = 1) {
      while (n-- > 0) {
        this._root.optimizeNodes();
        this._root.optimizeNames(this._root.names, this._constants);
      }
    }
    _leafNode(node) {
      this._currNode.nodes.push(node);
      return this;
    }
    _blockNode(node) {
      this._currNode.nodes.push(node);
      this._nodes.push(node);
    }
    _endBlockNode(N1, N2) {
      const n = this._currNode;
      if (n instanceof N1 || N2 && n instanceof N2) {
        this._nodes.pop();
        return this;
      }
      throw new Error(`CodeGen: not in block "${N2 ? `${N1.kind}/${N2.kind}` : N1.kind}"`);
    }
    _elseNode(node) {
      const n = this._currNode;
      if (!(n instanceof If)) throw new Error('CodeGen: "else" without "if"');
      this._currNode = n.else = node;
      return this;
    }
    get _root() {
      return this._nodes[0];
    }
    get _currNode() {
      const ns = this._nodes;
      return ns[ns.length - 1];
    }
    set _currNode(node) {
      const ns = this._nodes;
      ns[ns.length - 1] = node;
    }
  };
  exports.CodeGen = CodeGen;
  function addNames(names, from) {
    for (const n in from) names[n] = (names[n] || 0) + (from[n] || 0);
    return names;
  }
  function addExprNames(names, from) {
    return from instanceof code_1._CodeOrName ? addNames(names, from.names) : names;
  }
  function optimizeExpr(expr, names, constants) {
    if (expr instanceof code_1.Name) return replaceName(expr);
    if (!canOptimize(expr)) return expr;
    return new code_1._Code(expr._items.reduce((items, c) => {
      if (c instanceof code_1.Name) c = replaceName(c);
      if (c instanceof code_1._Code) items.push(...c._items);
      else items.push(c);
      return items;
    }, []));
    function replaceName(n) {
      const c = constants[n.str];
      if (c === void 0 || names[n.str] !== 1) return n;
      delete names[n.str];
      return c;
    }
    function canOptimize(e) {
      return e instanceof code_1._Code && e._items.some((c) => c instanceof code_1.Name && names[c.str] === 1 && constants[c.str] !== void 0);
    }
  }
  function subtractNames(names, from) {
    for (const n in from) names[n] = (names[n] || 0) - (from[n] || 0);
  }
  function not(x) {
    return typeof x == "boolean" || typeof x == "number" || x === null ? !x : (0, code_1._)`!${par(x)}`;
  }
  exports.not = not;
  const andCode = mappend(exports.operators.AND);
  function and(...args) {
    return args.reduce(andCode);
  }
  exports.and = and;
  const orCode = mappend(exports.operators.OR);
  function or(...args) {
    return args.reduce(orCode);
  }
  exports.or = or;
  function mappend(op) {
    return (x, y) => x === code_1.nil ? y : y === code_1.nil ? x : (0, code_1._)`${par(x)} ${op} ${par(y)}`;
  }
  function par(x) {
    return x instanceof code_1.Name ? x : (0, code_1._)`(${x})`;
  }
});
var require_util = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.checkStrictMode = exports.getErrorPath = exports.Type = exports.useFunc = exports.setEvaluated = exports.evaluatedPropsToName = exports.mergeEvaluated = exports.eachItem = exports.unescapeJsonPointer = exports.escapeJsonPointer = exports.escapeFragment = exports.unescapeFragment = exports.schemaRefOrVal = exports.schemaHasRulesButRef = exports.schemaHasRules = exports.checkUnknownRules = exports.alwaysValidSchema = exports.toHash = void 0;
  const codegen_1 = require_codegen();
  const code_1 = require_code$1();
  function toHash(arr) {
    const hash = {};
    for (const item of arr) hash[item] = true;
    return hash;
  }
  exports.toHash = toHash;
  function alwaysValidSchema(it, schema) {
    if (typeof schema == "boolean") return schema;
    if (Object.keys(schema).length === 0) return true;
    checkUnknownRules(it, schema);
    return !schemaHasRules(schema, it.self.RULES.all);
  }
  exports.alwaysValidSchema = alwaysValidSchema;
  function checkUnknownRules(it, schema = it.schema) {
    const { opts, self } = it;
    if (!opts.strictSchema) return;
    if (typeof schema === "boolean") return;
    const rules = self.RULES.keywords;
    for (const key in schema) if (!rules[key]) checkStrictMode(it, `unknown keyword: "${key}"`);
  }
  exports.checkUnknownRules = checkUnknownRules;
  function schemaHasRules(schema, rules) {
    if (typeof schema == "boolean") return !schema;
    for (const key in schema) if (rules[key]) return true;
    return false;
  }
  exports.schemaHasRules = schemaHasRules;
  function schemaHasRulesButRef(schema, RULES) {
    if (typeof schema == "boolean") return !schema;
    for (const key in schema) if (key !== "$ref" && RULES.all[key]) return true;
    return false;
  }
  exports.schemaHasRulesButRef = schemaHasRulesButRef;
  function schemaRefOrVal({ topSchemaRef, schemaPath }, schema, keyword, $data) {
    if (!$data) {
      if (typeof schema == "number" || typeof schema == "boolean") return schema;
      if (typeof schema == "string") return (0, codegen_1._)`${schema}`;
    }
    return (0, codegen_1._)`${topSchemaRef}${schemaPath}${(0, codegen_1.getProperty)(keyword)}`;
  }
  exports.schemaRefOrVal = schemaRefOrVal;
  function unescapeFragment(str) {
    return unescapeJsonPointer(decodeURIComponent(str));
  }
  exports.unescapeFragment = unescapeFragment;
  function escapeFragment(str) {
    return encodeURIComponent(escapeJsonPointer(str));
  }
  exports.escapeFragment = escapeFragment;
  function escapeJsonPointer(str) {
    if (typeof str == "number") return `${str}`;
    return str.replace(/~/g, "~0").replace(/\//g, "~1");
  }
  exports.escapeJsonPointer = escapeJsonPointer;
  function unescapeJsonPointer(str) {
    return str.replace(/~1/g, "/").replace(/~0/g, "~");
  }
  exports.unescapeJsonPointer = unescapeJsonPointer;
  function eachItem(xs, f) {
    if (Array.isArray(xs)) for (const x of xs) f(x);
    else f(xs);
  }
  exports.eachItem = eachItem;
  function makeMergeEvaluated({ mergeNames, mergeToName, mergeValues, resultToName }) {
    return (gen, from, to, toName) => {
      const res = to === void 0 ? from : to instanceof codegen_1.Name ? (from instanceof codegen_1.Name ? mergeNames(gen, from, to) : mergeToName(gen, from, to), to) : from instanceof codegen_1.Name ? (mergeToName(gen, to, from), from) : mergeValues(from, to);
      return toName === codegen_1.Name && !(res instanceof codegen_1.Name) ? resultToName(gen, res) : res;
    };
  }
  exports.mergeEvaluated = {
    props: makeMergeEvaluated({
      mergeNames: (gen, from, to) => gen.if((0, codegen_1._)`${to} !== true && ${from} !== undefined`, () => {
        gen.if((0, codegen_1._)`${from} === true`, () => gen.assign(to, true), () => gen.assign(to, (0, codegen_1._)`${to} || {}`).code((0, codegen_1._)`Object.assign(${to}, ${from})`));
      }),
      mergeToName: (gen, from, to) => gen.if((0, codegen_1._)`${to} !== true`, () => {
        if (from === true) gen.assign(to, true);
        else {
          gen.assign(to, (0, codegen_1._)`${to} || {}`);
          setEvaluated(gen, to, from);
        }
      }),
      mergeValues: (from, to) => from === true ? true : {
        ...from,
        ...to
      },
      resultToName: evaluatedPropsToName
    }),
    items: makeMergeEvaluated({
      mergeNames: (gen, from, to) => gen.if((0, codegen_1._)`${to} !== true && ${from} !== undefined`, () => gen.assign(to, (0, codegen_1._)`${from} === true ? true : ${to} > ${from} ? ${to} : ${from}`)),
      mergeToName: (gen, from, to) => gen.if((0, codegen_1._)`${to} !== true`, () => gen.assign(to, from === true ? true : (0, codegen_1._)`${to} > ${from} ? ${to} : ${from}`)),
      mergeValues: (from, to) => from === true ? true : Math.max(from, to),
      resultToName: (gen, items) => gen.var("items", items)
    })
  };
  function evaluatedPropsToName(gen, ps) {
    if (ps === true) return gen.var("props", true);
    const props = gen.var("props", (0, codegen_1._)`{}`);
    if (ps !== void 0) setEvaluated(gen, props, ps);
    return props;
  }
  exports.evaluatedPropsToName = evaluatedPropsToName;
  function setEvaluated(gen, props, ps) {
    Object.keys(ps).forEach((p) => gen.assign((0, codegen_1._)`${props}${(0, codegen_1.getProperty)(p)}`, true));
  }
  exports.setEvaluated = setEvaluated;
  const snippets = {};
  function useFunc(gen, f) {
    return gen.scopeValue("func", {
      ref: f,
      code: snippets[f.code] || (snippets[f.code] = new code_1._Code(f.code))
    });
  }
  exports.useFunc = useFunc;
  var Type;
  (function(Type2) {
    Type2[Type2["Num"] = 0] = "Num";
    Type2[Type2["Str"] = 1] = "Str";
  })(Type || (exports.Type = Type = {}));
  function getErrorPath(dataProp, dataPropType, jsPropertySyntax) {
    if (dataProp instanceof codegen_1.Name) {
      const isNumber = dataPropType === Type.Num;
      return jsPropertySyntax ? isNumber ? (0, codegen_1._)`"[" + ${dataProp} + "]"` : (0, codegen_1._)`"['" + ${dataProp} + "']"` : isNumber ? (0, codegen_1._)`"/" + ${dataProp}` : (0, codegen_1._)`"/" + ${dataProp}.replace(/~/g, "~0").replace(/\\//g, "~1")`;
    }
    return jsPropertySyntax ? (0, codegen_1.getProperty)(dataProp).toString() : "/" + escapeJsonPointer(dataProp);
  }
  exports.getErrorPath = getErrorPath;
  function checkStrictMode(it, msg, mode = it.opts.strictSchema) {
    if (!mode) return;
    msg = `strict mode: ${msg}`;
    if (mode === true) throw new Error(msg);
    it.self.logger.warn(msg);
  }
  exports.checkStrictMode = checkStrictMode;
});
var require_names = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const codegen_1 = require_codegen();
  const names = {
    data: new codegen_1.Name("data"),
    valCxt: new codegen_1.Name("valCxt"),
    instancePath: new codegen_1.Name("instancePath"),
    parentData: new codegen_1.Name("parentData"),
    parentDataProperty: new codegen_1.Name("parentDataProperty"),
    rootData: new codegen_1.Name("rootData"),
    dynamicAnchors: new codegen_1.Name("dynamicAnchors"),
    vErrors: new codegen_1.Name("vErrors"),
    errors: new codegen_1.Name("errors"),
    this: new codegen_1.Name("this"),
    self: new codegen_1.Name("self"),
    scope: new codegen_1.Name("scope"),
    json: new codegen_1.Name("json"),
    jsonPos: new codegen_1.Name("jsonPos"),
    jsonLen: new codegen_1.Name("jsonLen"),
    jsonPart: new codegen_1.Name("jsonPart")
  };
  exports.default = names;
});
var require_errors = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.extendErrors = exports.resetErrorsCount = exports.reportExtraError = exports.reportError = exports.keyword$DataError = exports.keywordError = void 0;
  const codegen_1 = require_codegen();
  const util_1 = require_util();
  const names_1 = require_names();
  exports.keywordError = { message: ({ keyword }) => (0, codegen_1.str)`must pass "${keyword}" keyword validation` };
  exports.keyword$DataError = { message: ({ keyword, schemaType }) => schemaType ? (0, codegen_1.str)`"${keyword}" keyword must be ${schemaType} ($data)` : (0, codegen_1.str)`"${keyword}" keyword is invalid ($data)` };
  function reportError(cxt, error = exports.keywordError, errorPaths, overrideAllErrors) {
    const { it } = cxt;
    const { gen, compositeRule, allErrors } = it;
    const errObj = errorObjectCode(cxt, error, errorPaths);
    if (overrideAllErrors !== null && overrideAllErrors !== void 0 ? overrideAllErrors : compositeRule || allErrors) addError(gen, errObj);
    else returnErrors(it, (0, codegen_1._)`[${errObj}]`);
  }
  exports.reportError = reportError;
  function reportExtraError(cxt, error = exports.keywordError, errorPaths) {
    const { it } = cxt;
    const { gen, compositeRule, allErrors } = it;
    addError(gen, errorObjectCode(cxt, error, errorPaths));
    if (!(compositeRule || allErrors)) returnErrors(it, names_1.default.vErrors);
  }
  exports.reportExtraError = reportExtraError;
  function resetErrorsCount(gen, errsCount) {
    gen.assign(names_1.default.errors, errsCount);
    gen.if((0, codegen_1._)`${names_1.default.vErrors} !== null`, () => gen.if(errsCount, () => gen.assign((0, codegen_1._)`${names_1.default.vErrors}.length`, errsCount), () => gen.assign(names_1.default.vErrors, null)));
  }
  exports.resetErrorsCount = resetErrorsCount;
  function extendErrors({ gen, keyword, schemaValue, data, errsCount, it }) {
    if (errsCount === void 0) throw new Error("ajv implementation error");
    const err = gen.name("err");
    gen.forRange("i", errsCount, names_1.default.errors, (i) => {
      gen.const(err, (0, codegen_1._)`${names_1.default.vErrors}[${i}]`);
      gen.if((0, codegen_1._)`${err}.instancePath === undefined`, () => gen.assign((0, codegen_1._)`${err}.instancePath`, (0, codegen_1.strConcat)(names_1.default.instancePath, it.errorPath)));
      gen.assign((0, codegen_1._)`${err}.schemaPath`, (0, codegen_1.str)`${it.errSchemaPath}/${keyword}`);
      if (it.opts.verbose) {
        gen.assign((0, codegen_1._)`${err}.schema`, schemaValue);
        gen.assign((0, codegen_1._)`${err}.data`, data);
      }
    });
  }
  exports.extendErrors = extendErrors;
  function addError(gen, errObj) {
    const err = gen.const("err", errObj);
    gen.if((0, codegen_1._)`${names_1.default.vErrors} === null`, () => gen.assign(names_1.default.vErrors, (0, codegen_1._)`[${err}]`), (0, codegen_1._)`${names_1.default.vErrors}.push(${err})`);
    gen.code((0, codegen_1._)`${names_1.default.errors}++`);
  }
  function returnErrors(it, errs) {
    const { gen, validateName, schemaEnv } = it;
    if (schemaEnv.$async) gen.throw((0, codegen_1._)`new ${it.ValidationError}(${errs})`);
    else {
      gen.assign((0, codegen_1._)`${validateName}.errors`, errs);
      gen.return(false);
    }
  }
  const E = {
    keyword: new codegen_1.Name("keyword"),
    schemaPath: new codegen_1.Name("schemaPath"),
    params: new codegen_1.Name("params"),
    propertyName: new codegen_1.Name("propertyName"),
    message: new codegen_1.Name("message"),
    schema: new codegen_1.Name("schema"),
    parentSchema: new codegen_1.Name("parentSchema")
  };
  function errorObjectCode(cxt, error, errorPaths) {
    const { createErrors } = cxt.it;
    if (createErrors === false) return (0, codegen_1._)`{}`;
    return errorObject(cxt, error, errorPaths);
  }
  function errorObject(cxt, error, errorPaths = {}) {
    const { gen, it } = cxt;
    const keyValues = [errorInstancePath(it, errorPaths), errorSchemaPath(cxt, errorPaths)];
    extraErrorProps(cxt, error, keyValues);
    return gen.object(...keyValues);
  }
  function errorInstancePath({ errorPath }, { instancePath }) {
    const instPath = instancePath ? (0, codegen_1.str)`${errorPath}${(0, util_1.getErrorPath)(instancePath, util_1.Type.Str)}` : errorPath;
    return [names_1.default.instancePath, (0, codegen_1.strConcat)(names_1.default.instancePath, instPath)];
  }
  function errorSchemaPath({ keyword, it: { errSchemaPath } }, { schemaPath, parentSchema }) {
    let schPath = parentSchema ? errSchemaPath : (0, codegen_1.str)`${errSchemaPath}/${keyword}`;
    if (schemaPath) schPath = (0, codegen_1.str)`${schPath}${(0, util_1.getErrorPath)(schemaPath, util_1.Type.Str)}`;
    return [E.schemaPath, schPath];
  }
  function extraErrorProps(cxt, { params, message }, keyValues) {
    const { keyword, data, schemaValue, it } = cxt;
    const { opts, propertyName, topSchemaRef, schemaPath } = it;
    keyValues.push([E.keyword, keyword], [E.params, typeof params == "function" ? params(cxt) : params || (0, codegen_1._)`{}`]);
    if (opts.messages) keyValues.push([E.message, typeof message == "function" ? message(cxt) : message]);
    if (opts.verbose) keyValues.push([E.schema, schemaValue], [E.parentSchema, (0, codegen_1._)`${topSchemaRef}${schemaPath}`], [names_1.default.data, data]);
    if (propertyName) keyValues.push([E.propertyName, propertyName]);
  }
});
var require_boolSchema = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.boolOrEmptySchema = exports.topBoolOrEmptySchema = void 0;
  const errors_1 = require_errors();
  const codegen_1 = require_codegen();
  const names_1 = require_names();
  const boolError = { message: "boolean schema is false" };
  function topBoolOrEmptySchema(it) {
    const { gen, schema, validateName } = it;
    if (schema === false) falseSchemaError(it, false);
    else if (typeof schema == "object" && schema.$async === true) gen.return(names_1.default.data);
    else {
      gen.assign((0, codegen_1._)`${validateName}.errors`, null);
      gen.return(true);
    }
  }
  exports.topBoolOrEmptySchema = topBoolOrEmptySchema;
  function boolOrEmptySchema(it, valid) {
    const { gen, schema } = it;
    if (schema === false) {
      gen.var(valid, false);
      falseSchemaError(it);
    } else gen.var(valid, true);
  }
  exports.boolOrEmptySchema = boolOrEmptySchema;
  function falseSchemaError(it, overrideAllErrors) {
    const { gen, data } = it;
    const cxt = {
      gen,
      keyword: "false schema",
      data,
      schema: false,
      schemaCode: false,
      schemaValue: false,
      params: {},
      it
    };
    (0, errors_1.reportError)(cxt, boolError, void 0, overrideAllErrors);
  }
});
var require_rules = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.getRules = exports.isJSONType = void 0;
  const jsonTypes = /* @__PURE__ */ new Set([
    "string",
    "number",
    "integer",
    "boolean",
    "null",
    "object",
    "array"
  ]);
  function isJSONType(x) {
    return typeof x == "string" && jsonTypes.has(x);
  }
  exports.isJSONType = isJSONType;
  function getRules() {
    const groups = {
      number: {
        type: "number",
        rules: []
      },
      string: {
        type: "string",
        rules: []
      },
      array: {
        type: "array",
        rules: []
      },
      object: {
        type: "object",
        rules: []
      }
    };
    return {
      types: {
        ...groups,
        integer: true,
        boolean: true,
        null: true
      },
      rules: [
        { rules: [] },
        groups.number,
        groups.string,
        groups.array,
        groups.object
      ],
      post: { rules: [] },
      all: {},
      keywords: {}
    };
  }
  exports.getRules = getRules;
});
var require_applicability = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.shouldUseRule = exports.shouldUseGroup = exports.schemaHasRulesForType = void 0;
  function schemaHasRulesForType({ schema, self }, type) {
    const group = self.RULES.types[type];
    return group && group !== true && shouldUseGroup(schema, group);
  }
  exports.schemaHasRulesForType = schemaHasRulesForType;
  function shouldUseGroup(schema, group) {
    return group.rules.some((rule) => shouldUseRule(schema, rule));
  }
  exports.shouldUseGroup = shouldUseGroup;
  function shouldUseRule(schema, rule) {
    var _a;
    return schema[rule.keyword] !== void 0 || ((_a = rule.definition.implements) === null || _a === void 0 ? void 0 : _a.some((kwd) => schema[kwd] !== void 0));
  }
  exports.shouldUseRule = shouldUseRule;
});
var require_dataType = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.reportTypeError = exports.checkDataTypes = exports.checkDataType = exports.coerceAndCheckDataType = exports.getJSONTypes = exports.getSchemaTypes = exports.DataType = void 0;
  const rules_1 = require_rules();
  const applicability_1 = require_applicability();
  const errors_1 = require_errors();
  const codegen_1 = require_codegen();
  const util_1 = require_util();
  var DataType;
  (function(DataType2) {
    DataType2[DataType2["Correct"] = 0] = "Correct";
    DataType2[DataType2["Wrong"] = 1] = "Wrong";
  })(DataType || (exports.DataType = DataType = {}));
  function getSchemaTypes(schema) {
    const types = getJSONTypes(schema.type);
    if (types.includes("null")) {
      if (schema.nullable === false) throw new Error("type: null contradicts nullable: false");
    } else {
      if (!types.length && schema.nullable !== void 0) throw new Error('"nullable" cannot be used without "type"');
      if (schema.nullable === true) types.push("null");
    }
    return types;
  }
  exports.getSchemaTypes = getSchemaTypes;
  function getJSONTypes(ts) {
    const types = Array.isArray(ts) ? ts : ts ? [ts] : [];
    if (types.every(rules_1.isJSONType)) return types;
    throw new Error("type must be JSONType or JSONType[]: " + types.join(","));
  }
  exports.getJSONTypes = getJSONTypes;
  function coerceAndCheckDataType(it, types) {
    const { gen, data, opts } = it;
    const coerceTo = coerceToTypes(types, opts.coerceTypes);
    const checkTypes = types.length > 0 && !(coerceTo.length === 0 && types.length === 1 && (0, applicability_1.schemaHasRulesForType)(it, types[0]));
    if (checkTypes) {
      const wrongType = checkDataTypes(types, data, opts.strictNumbers, DataType.Wrong);
      gen.if(wrongType, () => {
        if (coerceTo.length) coerceData(it, types, coerceTo);
        else reportTypeError(it);
      });
    }
    return checkTypes;
  }
  exports.coerceAndCheckDataType = coerceAndCheckDataType;
  const COERCIBLE = /* @__PURE__ */ new Set([
    "string",
    "number",
    "integer",
    "boolean",
    "null"
  ]);
  function coerceToTypes(types, coerceTypes) {
    return coerceTypes ? types.filter((t) => COERCIBLE.has(t) || coerceTypes === "array" && t === "array") : [];
  }
  function coerceData(it, types, coerceTo) {
    const { gen, data, opts } = it;
    const dataType = gen.let("dataType", (0, codegen_1._)`typeof ${data}`);
    const coerced = gen.let("coerced", (0, codegen_1._)`undefined`);
    if (opts.coerceTypes === "array") gen.if((0, codegen_1._)`${dataType} == 'object' && Array.isArray(${data}) && ${data}.length == 1`, () => gen.assign(data, (0, codegen_1._)`${data}[0]`).assign(dataType, (0, codegen_1._)`typeof ${data}`).if(checkDataTypes(types, data, opts.strictNumbers), () => gen.assign(coerced, data)));
    gen.if((0, codegen_1._)`${coerced} !== undefined`);
    for (const t of coerceTo) if (COERCIBLE.has(t) || t === "array" && opts.coerceTypes === "array") coerceSpecificType(t);
    gen.else();
    reportTypeError(it);
    gen.endIf();
    gen.if((0, codegen_1._)`${coerced} !== undefined`, () => {
      gen.assign(data, coerced);
      assignParentData(it, coerced);
    });
    function coerceSpecificType(t) {
      switch (t) {
        case "string":
          gen.elseIf((0, codegen_1._)`${dataType} == "number" || ${dataType} == "boolean"`).assign(coerced, (0, codegen_1._)`"" + ${data}`).elseIf((0, codegen_1._)`${data} === null`).assign(coerced, (0, codegen_1._)`""`);
          return;
        case "number":
          gen.elseIf((0, codegen_1._)`${dataType} == "boolean" || ${data} === null
              || (${dataType} == "string" && ${data} && ${data} == +${data})`).assign(coerced, (0, codegen_1._)`+${data}`);
          return;
        case "integer":
          gen.elseIf((0, codegen_1._)`${dataType} === "boolean" || ${data} === null
              || (${dataType} === "string" && ${data} && ${data} == +${data} && !(${data} % 1))`).assign(coerced, (0, codegen_1._)`+${data}`);
          return;
        case "boolean":
          gen.elseIf((0, codegen_1._)`${data} === "false" || ${data} === 0 || ${data} === null`).assign(coerced, false).elseIf((0, codegen_1._)`${data} === "true" || ${data} === 1`).assign(coerced, true);
          return;
        case "null":
          gen.elseIf((0, codegen_1._)`${data} === "" || ${data} === 0 || ${data} === false`);
          gen.assign(coerced, null);
          return;
        case "array":
          gen.elseIf((0, codegen_1._)`${dataType} === "string" || ${dataType} === "number"
              || ${dataType} === "boolean" || ${data} === null`).assign(coerced, (0, codegen_1._)`[${data}]`);
      }
    }
  }
  function assignParentData({ gen, parentData, parentDataProperty }, expr) {
    gen.if((0, codegen_1._)`${parentData} !== undefined`, () => gen.assign((0, codegen_1._)`${parentData}[${parentDataProperty}]`, expr));
  }
  function checkDataType(dataType, data, strictNums, correct = DataType.Correct) {
    const EQ = correct === DataType.Correct ? codegen_1.operators.EQ : codegen_1.operators.NEQ;
    let cond;
    switch (dataType) {
      case "null":
        return (0, codegen_1._)`${data} ${EQ} null`;
      case "array":
        cond = (0, codegen_1._)`Array.isArray(${data})`;
        break;
      case "object":
        cond = (0, codegen_1._)`${data} && typeof ${data} == "object" && !Array.isArray(${data})`;
        break;
      case "integer":
        cond = numCond((0, codegen_1._)`!(${data} % 1) && !isNaN(${data})`);
        break;
      case "number":
        cond = numCond();
        break;
      default:
        return (0, codegen_1._)`typeof ${data} ${EQ} ${dataType}`;
    }
    return correct === DataType.Correct ? cond : (0, codegen_1.not)(cond);
    function numCond(_cond = codegen_1.nil) {
      return (0, codegen_1.and)((0, codegen_1._)`typeof ${data} == "number"`, _cond, strictNums ? (0, codegen_1._)`isFinite(${data})` : codegen_1.nil);
    }
  }
  exports.checkDataType = checkDataType;
  function checkDataTypes(dataTypes, data, strictNums, correct) {
    if (dataTypes.length === 1) return checkDataType(dataTypes[0], data, strictNums, correct);
    let cond;
    const types = (0, util_1.toHash)(dataTypes);
    if (types.array && types.object) {
      const notObj = (0, codegen_1._)`typeof ${data} != "object"`;
      cond = types.null ? notObj : (0, codegen_1._)`!${data} || ${notObj}`;
      delete types.null;
      delete types.array;
      delete types.object;
    } else cond = codegen_1.nil;
    if (types.number) delete types.integer;
    for (const t in types) cond = (0, codegen_1.and)(cond, checkDataType(t, data, strictNums, correct));
    return cond;
  }
  exports.checkDataTypes = checkDataTypes;
  const typeError = {
    message: ({ schema }) => `must be ${schema}`,
    params: ({ schema, schemaValue }) => typeof schema == "string" ? (0, codegen_1._)`{type: ${schema}}` : (0, codegen_1._)`{type: ${schemaValue}}`
  };
  function reportTypeError(it) {
    const cxt = getTypeErrorContext(it);
    (0, errors_1.reportError)(cxt, typeError);
  }
  exports.reportTypeError = reportTypeError;
  function getTypeErrorContext(it) {
    const { gen, data, schema } = it;
    const schemaCode = (0, util_1.schemaRefOrVal)(it, schema, "type");
    return {
      gen,
      keyword: "type",
      data,
      schema: schema.type,
      schemaCode,
      schemaValue: schemaCode,
      parentSchema: schema,
      params: {},
      it
    };
  }
});
var require_defaults = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.assignDefaults = void 0;
  const codegen_1 = require_codegen();
  const util_1 = require_util();
  function assignDefaults(it, ty) {
    const { properties, items } = it.schema;
    if (ty === "object" && properties) for (const key in properties) assignDefault(it, key, properties[key].default);
    else if (ty === "array" && Array.isArray(items)) items.forEach((sch, i) => assignDefault(it, i, sch.default));
  }
  exports.assignDefaults = assignDefaults;
  function assignDefault(it, prop, defaultValue) {
    const { gen, compositeRule, data, opts } = it;
    if (defaultValue === void 0) return;
    const childData = (0, codegen_1._)`${data}${(0, codegen_1.getProperty)(prop)}`;
    if (compositeRule) {
      (0, util_1.checkStrictMode)(it, `default is ignored for: ${childData}`);
      return;
    }
    let condition = (0, codegen_1._)`${childData} === undefined`;
    if (opts.useDefaults === "empty") condition = (0, codegen_1._)`${condition} || ${childData} === null || ${childData} === ""`;
    gen.if(condition, (0, codegen_1._)`${childData} = ${(0, codegen_1.stringify)(defaultValue)}`);
  }
});
var require_code = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.validateUnion = exports.validateArray = exports.usePattern = exports.callValidateCode = exports.schemaProperties = exports.allSchemaProperties = exports.noPropertyInData = exports.propertyInData = exports.isOwnProperty = exports.hasPropFunc = exports.reportMissingProp = exports.checkMissingProp = exports.checkReportMissingProp = void 0;
  const codegen_1 = require_codegen();
  const util_1 = require_util();
  const names_1 = require_names();
  const util_2 = require_util();
  function checkReportMissingProp(cxt, prop) {
    const { gen, data, it } = cxt;
    gen.if(noPropertyInData(gen, data, prop, it.opts.ownProperties), () => {
      cxt.setParams({ missingProperty: (0, codegen_1._)`${prop}` }, true);
      cxt.error();
    });
  }
  exports.checkReportMissingProp = checkReportMissingProp;
  function checkMissingProp({ gen, data, it: { opts } }, properties, missing) {
    return (0, codegen_1.or)(...properties.map((prop) => (0, codegen_1.and)(noPropertyInData(gen, data, prop, opts.ownProperties), (0, codegen_1._)`${missing} = ${prop}`)));
  }
  exports.checkMissingProp = checkMissingProp;
  function reportMissingProp(cxt, missing) {
    cxt.setParams({ missingProperty: missing }, true);
    cxt.error();
  }
  exports.reportMissingProp = reportMissingProp;
  function hasPropFunc(gen) {
    return gen.scopeValue("func", {
      ref: Object.prototype.hasOwnProperty,
      code: (0, codegen_1._)`Object.prototype.hasOwnProperty`
    });
  }
  exports.hasPropFunc = hasPropFunc;
  function isOwnProperty(gen, data, property) {
    return (0, codegen_1._)`${hasPropFunc(gen)}.call(${data}, ${property})`;
  }
  exports.isOwnProperty = isOwnProperty;
  function propertyInData(gen, data, property, ownProperties) {
    const cond = (0, codegen_1._)`${data}${(0, codegen_1.getProperty)(property)} !== undefined`;
    return ownProperties ? (0, codegen_1._)`${cond} && ${isOwnProperty(gen, data, property)}` : cond;
  }
  exports.propertyInData = propertyInData;
  function noPropertyInData(gen, data, property, ownProperties) {
    const cond = (0, codegen_1._)`${data}${(0, codegen_1.getProperty)(property)} === undefined`;
    return ownProperties ? (0, codegen_1.or)(cond, (0, codegen_1.not)(isOwnProperty(gen, data, property))) : cond;
  }
  exports.noPropertyInData = noPropertyInData;
  function allSchemaProperties(schemaMap) {
    return schemaMap ? Object.keys(schemaMap).filter((p) => p !== "__proto__") : [];
  }
  exports.allSchemaProperties = allSchemaProperties;
  function schemaProperties(it, schemaMap) {
    return allSchemaProperties(schemaMap).filter((p) => !(0, util_1.alwaysValidSchema)(it, schemaMap[p]));
  }
  exports.schemaProperties = schemaProperties;
  function callValidateCode({ schemaCode, data, it: { gen, topSchemaRef, schemaPath, errorPath }, it }, func, context, passSchema) {
    const dataAndSchema = passSchema ? (0, codegen_1._)`${schemaCode}, ${data}, ${topSchemaRef}${schemaPath}` : data;
    const valCxt = [
      [names_1.default.instancePath, (0, codegen_1.strConcat)(names_1.default.instancePath, errorPath)],
      [names_1.default.parentData, it.parentData],
      [names_1.default.parentDataProperty, it.parentDataProperty],
      [names_1.default.rootData, names_1.default.rootData]
    ];
    if (it.opts.dynamicRef) valCxt.push([names_1.default.dynamicAnchors, names_1.default.dynamicAnchors]);
    const args = (0, codegen_1._)`${dataAndSchema}, ${gen.object(...valCxt)}`;
    return context !== codegen_1.nil ? (0, codegen_1._)`${func}.call(${context}, ${args})` : (0, codegen_1._)`${func}(${args})`;
  }
  exports.callValidateCode = callValidateCode;
  const newRegExp = (0, codegen_1._)`new RegExp`;
  function usePattern({ gen, it: { opts } }, pattern) {
    const u = opts.unicodeRegExp ? "u" : "";
    const { regExp } = opts.code;
    const rx = regExp(pattern, u);
    return gen.scopeValue("pattern", {
      key: rx.toString(),
      ref: rx,
      code: (0, codegen_1._)`${regExp.code === "new RegExp" ? newRegExp : (0, util_2.useFunc)(gen, regExp)}(${pattern}, ${u})`
    });
  }
  exports.usePattern = usePattern;
  function validateArray(cxt) {
    const { gen, data, keyword, it } = cxt;
    const valid = gen.name("valid");
    if (it.allErrors) {
      const validArr = gen.let("valid", true);
      validateItems(() => gen.assign(validArr, false));
      return validArr;
    }
    gen.var(valid, true);
    validateItems(() => gen.break());
    return valid;
    function validateItems(notValid) {
      const len = gen.const("len", (0, codegen_1._)`${data}.length`);
      gen.forRange("i", 0, len, (i) => {
        cxt.subschema({
          keyword,
          dataProp: i,
          dataPropType: util_1.Type.Num
        }, valid);
        gen.if((0, codegen_1.not)(valid), notValid);
      });
    }
  }
  exports.validateArray = validateArray;
  function validateUnion(cxt) {
    const { gen, schema, keyword, it } = cxt;
    if (!Array.isArray(schema)) throw new Error("ajv implementation error");
    if (schema.some((sch) => (0, util_1.alwaysValidSchema)(it, sch)) && !it.opts.unevaluated) return;
    const valid = gen.let("valid", false);
    const schValid = gen.name("_valid");
    gen.block(() => schema.forEach((_sch, i) => {
      const schCxt = cxt.subschema({
        keyword,
        schemaProp: i,
        compositeRule: true
      }, schValid);
      gen.assign(valid, (0, codegen_1._)`${valid} || ${schValid}`);
      if (!cxt.mergeValidEvaluated(schCxt, schValid)) gen.if((0, codegen_1.not)(valid));
    }));
    cxt.result(valid, () => cxt.reset(), () => cxt.error(true));
  }
  exports.validateUnion = validateUnion;
});
var require_keyword = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.validateKeywordUsage = exports.validSchemaType = exports.funcKeywordCode = exports.macroKeywordCode = void 0;
  const codegen_1 = require_codegen();
  const names_1 = require_names();
  const code_1 = require_code();
  const errors_1 = require_errors();
  function macroKeywordCode(cxt, def) {
    const { gen, keyword, schema, parentSchema, it } = cxt;
    const macroSchema = def.macro.call(it.self, schema, parentSchema, it);
    const schemaRef = useKeyword(gen, keyword, macroSchema);
    if (it.opts.validateSchema !== false) it.self.validateSchema(macroSchema, true);
    const valid = gen.name("valid");
    cxt.subschema({
      schema: macroSchema,
      schemaPath: codegen_1.nil,
      errSchemaPath: `${it.errSchemaPath}/${keyword}`,
      topSchemaRef: schemaRef,
      compositeRule: true
    }, valid);
    cxt.pass(valid, () => cxt.error(true));
  }
  exports.macroKeywordCode = macroKeywordCode;
  function funcKeywordCode(cxt, def) {
    var _a;
    const { gen, keyword, schema, parentSchema, $data, it } = cxt;
    checkAsyncKeyword(it, def);
    const validateRef = useKeyword(gen, keyword, !$data && def.compile ? def.compile.call(it.self, schema, parentSchema, it) : def.validate);
    const valid = gen.let("valid");
    cxt.block$data(valid, validateKeyword);
    cxt.ok((_a = def.valid) !== null && _a !== void 0 ? _a : valid);
    function validateKeyword() {
      if (def.errors === false) {
        assignValid();
        if (def.modifying) modifyData(cxt);
        reportErrs(() => cxt.error());
      } else {
        const ruleErrs = def.async ? validateAsync() : validateSync();
        if (def.modifying) modifyData(cxt);
        reportErrs(() => addErrs(cxt, ruleErrs));
      }
    }
    function validateAsync() {
      const ruleErrs = gen.let("ruleErrs", null);
      gen.try(() => assignValid((0, codegen_1._)`await `), (e) => gen.assign(valid, false).if((0, codegen_1._)`${e} instanceof ${it.ValidationError}`, () => gen.assign(ruleErrs, (0, codegen_1._)`${e}.errors`), () => gen.throw(e)));
      return ruleErrs;
    }
    function validateSync() {
      const validateErrs = (0, codegen_1._)`${validateRef}.errors`;
      gen.assign(validateErrs, null);
      assignValid(codegen_1.nil);
      return validateErrs;
    }
    function assignValid(_await = def.async ? (0, codegen_1._)`await ` : codegen_1.nil) {
      const passCxt = it.opts.passContext ? names_1.default.this : names_1.default.self;
      const passSchema = !("compile" in def && !$data || def.schema === false);
      gen.assign(valid, (0, codegen_1._)`${_await}${(0, code_1.callValidateCode)(cxt, validateRef, passCxt, passSchema)}`, def.modifying);
    }
    function reportErrs(errors) {
      var _a$1;
      gen.if((0, codegen_1.not)((_a$1 = def.valid) !== null && _a$1 !== void 0 ? _a$1 : valid), errors);
    }
  }
  exports.funcKeywordCode = funcKeywordCode;
  function modifyData(cxt) {
    const { gen, data, it } = cxt;
    gen.if(it.parentData, () => gen.assign(data, (0, codegen_1._)`${it.parentData}[${it.parentDataProperty}]`));
  }
  function addErrs(cxt, errs) {
    const { gen } = cxt;
    gen.if((0, codegen_1._)`Array.isArray(${errs})`, () => {
      gen.assign(names_1.default.vErrors, (0, codegen_1._)`${names_1.default.vErrors} === null ? ${errs} : ${names_1.default.vErrors}.concat(${errs})`).assign(names_1.default.errors, (0, codegen_1._)`${names_1.default.vErrors}.length`);
      (0, errors_1.extendErrors)(cxt);
    }, () => cxt.error());
  }
  function checkAsyncKeyword({ schemaEnv }, def) {
    if (def.async && !schemaEnv.$async) throw new Error("async keyword in sync schema");
  }
  function useKeyword(gen, keyword, result) {
    if (result === void 0) throw new Error(`keyword "${keyword}" failed to compile`);
    return gen.scopeValue("keyword", typeof result == "function" ? { ref: result } : {
      ref: result,
      code: (0, codegen_1.stringify)(result)
    });
  }
  function validSchemaType(schema, schemaType, allowUndefined = false) {
    return !schemaType.length || schemaType.some((st) => st === "array" ? Array.isArray(schema) : st === "object" ? schema && typeof schema == "object" && !Array.isArray(schema) : typeof schema == st || allowUndefined && typeof schema == "undefined");
  }
  exports.validSchemaType = validSchemaType;
  function validateKeywordUsage({ schema, opts, self, errSchemaPath }, def, keyword) {
    if (Array.isArray(def.keyword) ? !def.keyword.includes(keyword) : def.keyword !== keyword) throw new Error("ajv implementation error");
    const deps = def.dependencies;
    if (deps === null || deps === void 0 ? void 0 : deps.some((kwd) => !Object.prototype.hasOwnProperty.call(schema, kwd))) throw new Error(`parent schema must have dependencies of ${keyword}: ${deps.join(",")}`);
    if (def.validateSchema) {
      if (!def.validateSchema(schema[keyword])) {
        const msg = `keyword "${keyword}" value is invalid at path "${errSchemaPath}": ` + self.errorsText(def.validateSchema.errors);
        if (opts.validateSchema === "log") self.logger.error(msg);
        else throw new Error(msg);
      }
    }
  }
  exports.validateKeywordUsage = validateKeywordUsage;
});
var require_subschema = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.extendSubschemaMode = exports.extendSubschemaData = exports.getSubschema = void 0;
  const codegen_1 = require_codegen();
  const util_1 = require_util();
  function getSubschema(it, { keyword, schemaProp, schema, schemaPath, errSchemaPath, topSchemaRef }) {
    if (keyword !== void 0 && schema !== void 0) throw new Error('both "keyword" and "schema" passed, only one allowed');
    if (keyword !== void 0) {
      const sch = it.schema[keyword];
      return schemaProp === void 0 ? {
        schema: sch,
        schemaPath: (0, codegen_1._)`${it.schemaPath}${(0, codegen_1.getProperty)(keyword)}`,
        errSchemaPath: `${it.errSchemaPath}/${keyword}`
      } : {
        schema: sch[schemaProp],
        schemaPath: (0, codegen_1._)`${it.schemaPath}${(0, codegen_1.getProperty)(keyword)}${(0, codegen_1.getProperty)(schemaProp)}`,
        errSchemaPath: `${it.errSchemaPath}/${keyword}/${(0, util_1.escapeFragment)(schemaProp)}`
      };
    }
    if (schema !== void 0) {
      if (schemaPath === void 0 || errSchemaPath === void 0 || topSchemaRef === void 0) throw new Error('"schemaPath", "errSchemaPath" and "topSchemaRef" are required with "schema"');
      return {
        schema,
        schemaPath,
        topSchemaRef,
        errSchemaPath
      };
    }
    throw new Error('either "keyword" or "schema" must be passed');
  }
  exports.getSubschema = getSubschema;
  function extendSubschemaData(subschema, it, { dataProp, dataPropType: dpType, data, dataTypes, propertyName }) {
    if (data !== void 0 && dataProp !== void 0) throw new Error('both "data" and "dataProp" passed, only one allowed');
    const { gen } = it;
    if (dataProp !== void 0) {
      const { errorPath, dataPathArr, opts } = it;
      dataContextProps(gen.let("data", (0, codegen_1._)`${it.data}${(0, codegen_1.getProperty)(dataProp)}`, true));
      subschema.errorPath = (0, codegen_1.str)`${errorPath}${(0, util_1.getErrorPath)(dataProp, dpType, opts.jsPropertySyntax)}`;
      subschema.parentDataProperty = (0, codegen_1._)`${dataProp}`;
      subschema.dataPathArr = [...dataPathArr, subschema.parentDataProperty];
    }
    if (data !== void 0) {
      dataContextProps(data instanceof codegen_1.Name ? data : gen.let("data", data, true));
      if (propertyName !== void 0) subschema.propertyName = propertyName;
    }
    if (dataTypes) subschema.dataTypes = dataTypes;
    function dataContextProps(_nextData) {
      subschema.data = _nextData;
      subschema.dataLevel = it.dataLevel + 1;
      subschema.dataTypes = [];
      it.definedProperties = /* @__PURE__ */ new Set();
      subschema.parentData = it.data;
      subschema.dataNames = [...it.dataNames, _nextData];
    }
  }
  exports.extendSubschemaData = extendSubschemaData;
  function extendSubschemaMode(subschema, { jtdDiscriminator, jtdMetadata, compositeRule, createErrors, allErrors }) {
    if (compositeRule !== void 0) subschema.compositeRule = compositeRule;
    if (createErrors !== void 0) subschema.createErrors = createErrors;
    if (allErrors !== void 0) subschema.allErrors = allErrors;
    subschema.jtdDiscriminator = jtdDiscriminator;
    subschema.jtdMetadata = jtdMetadata;
  }
  exports.extendSubschemaMode = extendSubschemaMode;
});
var require_fast_deep_equal = /* @__PURE__ */ __commonJSMin((exports, module) => {
  module.exports = function equal(a, b) {
    if (a === b) return true;
    if (a && b && typeof a == "object" && typeof b == "object") {
      if (a.constructor !== b.constructor) return false;
      var length, i, keys;
      if (Array.isArray(a)) {
        length = a.length;
        if (length != b.length) return false;
        for (i = length; i-- !== 0; ) if (!equal(a[i], b[i])) return false;
        return true;
      }
      if (a.constructor === RegExp) return a.source === b.source && a.flags === b.flags;
      if (a.valueOf !== Object.prototype.valueOf) return a.valueOf() === b.valueOf();
      if (a.toString !== Object.prototype.toString) return a.toString() === b.toString();
      keys = Object.keys(a);
      length = keys.length;
      if (length !== Object.keys(b).length) return false;
      for (i = length; i-- !== 0; ) if (!Object.prototype.hasOwnProperty.call(b, keys[i])) return false;
      for (i = length; i-- !== 0; ) {
        var key = keys[i];
        if (!equal(a[key], b[key])) return false;
      }
      return true;
    }
    return a !== a && b !== b;
  };
});
var require_json_schema_traverse = /* @__PURE__ */ __commonJSMin((exports, module) => {
  var traverse = module.exports = function(schema, opts, cb) {
    if (typeof opts == "function") {
      cb = opts;
      opts = {};
    }
    cb = opts.cb || cb;
    var pre = typeof cb == "function" ? cb : cb.pre || function() {
    };
    var post = cb.post || function() {
    };
    _traverse(opts, pre, post, schema, "", schema);
  };
  traverse.keywords = {
    additionalItems: true,
    items: true,
    contains: true,
    additionalProperties: true,
    propertyNames: true,
    not: true,
    if: true,
    then: true,
    else: true
  };
  traverse.arrayKeywords = {
    items: true,
    allOf: true,
    anyOf: true,
    oneOf: true
  };
  traverse.propsKeywords = {
    $defs: true,
    definitions: true,
    properties: true,
    patternProperties: true,
    dependencies: true
  };
  traverse.skipKeywords = {
    default: true,
    enum: true,
    const: true,
    required: true,
    maximum: true,
    minimum: true,
    exclusiveMaximum: true,
    exclusiveMinimum: true,
    multipleOf: true,
    maxLength: true,
    minLength: true,
    pattern: true,
    format: true,
    maxItems: true,
    minItems: true,
    uniqueItems: true,
    maxProperties: true,
    minProperties: true
  };
  function _traverse(opts, pre, post, schema, jsonPtr, rootSchema, parentJsonPtr, parentKeyword, parentSchema, keyIndex) {
    if (schema && typeof schema == "object" && !Array.isArray(schema)) {
      pre(schema, jsonPtr, rootSchema, parentJsonPtr, parentKeyword, parentSchema, keyIndex);
      for (var key in schema) {
        var sch = schema[key];
        if (Array.isArray(sch)) {
          if (key in traverse.arrayKeywords) for (var i = 0; i < sch.length; i++) _traverse(opts, pre, post, sch[i], jsonPtr + "/" + key + "/" + i, rootSchema, jsonPtr, key, schema, i);
        } else if (key in traverse.propsKeywords) {
          if (sch && typeof sch == "object") for (var prop in sch) _traverse(opts, pre, post, sch[prop], jsonPtr + "/" + key + "/" + escapeJsonPtr(prop), rootSchema, jsonPtr, key, schema, prop);
        } else if (key in traverse.keywords || opts.allKeys && !(key in traverse.skipKeywords)) _traverse(opts, pre, post, sch, jsonPtr + "/" + key, rootSchema, jsonPtr, key, schema);
      }
      post(schema, jsonPtr, rootSchema, parentJsonPtr, parentKeyword, parentSchema, keyIndex);
    }
  }
  function escapeJsonPtr(str) {
    return str.replace(/~/g, "~0").replace(/\//g, "~1");
  }
});
var require_resolve = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.getSchemaRefs = exports.resolveUrl = exports.normalizeId = exports._getFullPath = exports.getFullPath = exports.inlineRef = void 0;
  const util_1 = require_util();
  const equal = require_fast_deep_equal();
  const traverse = require_json_schema_traverse();
  const SIMPLE_INLINED = /* @__PURE__ */ new Set([
    "type",
    "format",
    "pattern",
    "maxLength",
    "minLength",
    "maxProperties",
    "minProperties",
    "maxItems",
    "minItems",
    "maximum",
    "minimum",
    "uniqueItems",
    "multipleOf",
    "required",
    "enum",
    "const"
  ]);
  function inlineRef(schema, limit = true) {
    if (typeof schema == "boolean") return true;
    if (limit === true) return !hasRef(schema);
    if (!limit) return false;
    return countKeys(schema) <= limit;
  }
  exports.inlineRef = inlineRef;
  const REF_KEYWORDS = /* @__PURE__ */ new Set([
    "$ref",
    "$recursiveRef",
    "$recursiveAnchor",
    "$dynamicRef",
    "$dynamicAnchor"
  ]);
  function hasRef(schema) {
    for (const key in schema) {
      if (REF_KEYWORDS.has(key)) return true;
      const sch = schema[key];
      if (Array.isArray(sch) && sch.some(hasRef)) return true;
      if (typeof sch == "object" && hasRef(sch)) return true;
    }
    return false;
  }
  function countKeys(schema) {
    let count = 0;
    for (const key in schema) {
      if (key === "$ref") return Infinity;
      count++;
      if (SIMPLE_INLINED.has(key)) continue;
      if (typeof schema[key] == "object") (0, util_1.eachItem)(schema[key], (sch) => count += countKeys(sch));
      if (count === Infinity) return Infinity;
    }
    return count;
  }
  function getFullPath(resolver, id = "", normalize) {
    if (normalize !== false) id = normalizeId(id);
    return _getFullPath(resolver, resolver.parse(id));
  }
  exports.getFullPath = getFullPath;
  function _getFullPath(resolver, p) {
    return resolver.serialize(p).split("#")[0] + "#";
  }
  exports._getFullPath = _getFullPath;
  const TRAILING_SLASH_HASH = /#\/?$/;
  function normalizeId(id) {
    return id ? id.replace(TRAILING_SLASH_HASH, "") : "";
  }
  exports.normalizeId = normalizeId;
  function resolveUrl(resolver, baseId, id) {
    id = normalizeId(id);
    return resolver.resolve(baseId, id);
  }
  exports.resolveUrl = resolveUrl;
  const ANCHOR = /^[a-z_][-a-z0-9._]*$/i;
  function getSchemaRefs(schema, baseId) {
    if (typeof schema == "boolean") return {};
    const { schemaId, uriResolver } = this.opts;
    const schId = normalizeId(schema[schemaId] || baseId);
    const baseIds = { "": schId };
    const pathPrefix = getFullPath(uriResolver, schId, false);
    const localRefs = {};
    const schemaRefs = /* @__PURE__ */ new Set();
    traverse(schema, { allKeys: true }, (sch, jsonPtr, _, parentJsonPtr) => {
      if (parentJsonPtr === void 0) return;
      const fullPath = pathPrefix + jsonPtr;
      let innerBaseId = baseIds[parentJsonPtr];
      if (typeof sch[schemaId] == "string") innerBaseId = addRef.call(this, sch[schemaId]);
      addAnchor.call(this, sch.$anchor);
      addAnchor.call(this, sch.$dynamicAnchor);
      baseIds[jsonPtr] = innerBaseId;
      function addRef(ref) {
        const _resolve = this.opts.uriResolver.resolve;
        ref = normalizeId(innerBaseId ? _resolve(innerBaseId, ref) : ref);
        if (schemaRefs.has(ref)) throw ambiguos(ref);
        schemaRefs.add(ref);
        let schOrRef = this.refs[ref];
        if (typeof schOrRef == "string") schOrRef = this.refs[schOrRef];
        if (typeof schOrRef == "object") checkAmbiguosRef(sch, schOrRef.schema, ref);
        else if (ref !== normalizeId(fullPath)) if (ref[0] === "#") {
          checkAmbiguosRef(sch, localRefs[ref], ref);
          localRefs[ref] = sch;
        } else this.refs[ref] = fullPath;
        return ref;
      }
      function addAnchor(anchor) {
        if (typeof anchor == "string") {
          if (!ANCHOR.test(anchor)) throw new Error(`invalid anchor "${anchor}"`);
          addRef.call(this, `#${anchor}`);
        }
      }
    });
    return localRefs;
    function checkAmbiguosRef(sch1, sch2, ref) {
      if (sch2 !== void 0 && !equal(sch1, sch2)) throw ambiguos(ref);
    }
    function ambiguos(ref) {
      return /* @__PURE__ */ new Error(`reference "${ref}" resolves to more than one schema`);
    }
  }
  exports.getSchemaRefs = getSchemaRefs;
});
var require_validate = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.getData = exports.KeywordCxt = exports.validateFunctionCode = void 0;
  const boolSchema_1 = require_boolSchema();
  const dataType_1 = require_dataType();
  const applicability_1 = require_applicability();
  const dataType_2 = require_dataType();
  const defaults_1 = require_defaults();
  const keyword_1 = require_keyword();
  const subschema_1 = require_subschema();
  const codegen_1 = require_codegen();
  const names_1 = require_names();
  const resolve_1 = require_resolve();
  const util_1 = require_util();
  const errors_1 = require_errors();
  function validateFunctionCode(it) {
    if (isSchemaObj(it)) {
      checkKeywords(it);
      if (schemaCxtHasRules(it)) {
        topSchemaObjCode(it);
        return;
      }
    }
    validateFunction(it, () => (0, boolSchema_1.topBoolOrEmptySchema)(it));
  }
  exports.validateFunctionCode = validateFunctionCode;
  function validateFunction({ gen, validateName, schema, schemaEnv, opts }, body) {
    if (opts.code.es5) gen.func(validateName, (0, codegen_1._)`${names_1.default.data}, ${names_1.default.valCxt}`, schemaEnv.$async, () => {
      gen.code((0, codegen_1._)`"use strict"; ${funcSourceUrl(schema, opts)}`);
      destructureValCxtES5(gen, opts);
      gen.code(body);
    });
    else gen.func(validateName, (0, codegen_1._)`${names_1.default.data}, ${destructureValCxt(opts)}`, schemaEnv.$async, () => gen.code(funcSourceUrl(schema, opts)).code(body));
  }
  function destructureValCxt(opts) {
    return (0, codegen_1._)`{${names_1.default.instancePath}="", ${names_1.default.parentData}, ${names_1.default.parentDataProperty}, ${names_1.default.rootData}=${names_1.default.data}${opts.dynamicRef ? (0, codegen_1._)`, ${names_1.default.dynamicAnchors}={}` : codegen_1.nil}}={}`;
  }
  function destructureValCxtES5(gen, opts) {
    gen.if(names_1.default.valCxt, () => {
      gen.var(names_1.default.instancePath, (0, codegen_1._)`${names_1.default.valCxt}.${names_1.default.instancePath}`);
      gen.var(names_1.default.parentData, (0, codegen_1._)`${names_1.default.valCxt}.${names_1.default.parentData}`);
      gen.var(names_1.default.parentDataProperty, (0, codegen_1._)`${names_1.default.valCxt}.${names_1.default.parentDataProperty}`);
      gen.var(names_1.default.rootData, (0, codegen_1._)`${names_1.default.valCxt}.${names_1.default.rootData}`);
      if (opts.dynamicRef) gen.var(names_1.default.dynamicAnchors, (0, codegen_1._)`${names_1.default.valCxt}.${names_1.default.dynamicAnchors}`);
    }, () => {
      gen.var(names_1.default.instancePath, (0, codegen_1._)`""`);
      gen.var(names_1.default.parentData, (0, codegen_1._)`undefined`);
      gen.var(names_1.default.parentDataProperty, (0, codegen_1._)`undefined`);
      gen.var(names_1.default.rootData, names_1.default.data);
      if (opts.dynamicRef) gen.var(names_1.default.dynamicAnchors, (0, codegen_1._)`{}`);
    });
  }
  function topSchemaObjCode(it) {
    const { schema, opts, gen } = it;
    validateFunction(it, () => {
      if (opts.$comment && schema.$comment) commentKeyword(it);
      checkNoDefault(it);
      gen.let(names_1.default.vErrors, null);
      gen.let(names_1.default.errors, 0);
      if (opts.unevaluated) resetEvaluated(it);
      typeAndKeywords(it);
      returnResults(it);
    });
  }
  function resetEvaluated(it) {
    const { gen, validateName } = it;
    it.evaluated = gen.const("evaluated", (0, codegen_1._)`${validateName}.evaluated`);
    gen.if((0, codegen_1._)`${it.evaluated}.dynamicProps`, () => gen.assign((0, codegen_1._)`${it.evaluated}.props`, (0, codegen_1._)`undefined`));
    gen.if((0, codegen_1._)`${it.evaluated}.dynamicItems`, () => gen.assign((0, codegen_1._)`${it.evaluated}.items`, (0, codegen_1._)`undefined`));
  }
  function funcSourceUrl(schema, opts) {
    const schId = typeof schema == "object" && schema[opts.schemaId];
    return schId && (opts.code.source || opts.code.process) ? (0, codegen_1._)`/*# sourceURL=${schId} */` : codegen_1.nil;
  }
  function subschemaCode(it, valid) {
    if (isSchemaObj(it)) {
      checkKeywords(it);
      if (schemaCxtHasRules(it)) {
        subSchemaObjCode(it, valid);
        return;
      }
    }
    (0, boolSchema_1.boolOrEmptySchema)(it, valid);
  }
  function schemaCxtHasRules({ schema, self }) {
    if (typeof schema == "boolean") return !schema;
    for (const key in schema) if (self.RULES.all[key]) return true;
    return false;
  }
  function isSchemaObj(it) {
    return typeof it.schema != "boolean";
  }
  function subSchemaObjCode(it, valid) {
    const { schema, gen, opts } = it;
    if (opts.$comment && schema.$comment) commentKeyword(it);
    updateContext(it);
    checkAsyncSchema(it);
    const errsCount = gen.const("_errs", names_1.default.errors);
    typeAndKeywords(it, errsCount);
    gen.var(valid, (0, codegen_1._)`${errsCount} === ${names_1.default.errors}`);
  }
  function checkKeywords(it) {
    (0, util_1.checkUnknownRules)(it);
    checkRefsAndKeywords(it);
  }
  function typeAndKeywords(it, errsCount) {
    if (it.opts.jtd) return schemaKeywords(it, [], false, errsCount);
    const types = (0, dataType_1.getSchemaTypes)(it.schema);
    schemaKeywords(it, types, !(0, dataType_1.coerceAndCheckDataType)(it, types), errsCount);
  }
  function checkRefsAndKeywords(it) {
    const { schema, errSchemaPath, opts, self } = it;
    if (schema.$ref && opts.ignoreKeywordsWithRef && (0, util_1.schemaHasRulesButRef)(schema, self.RULES)) self.logger.warn(`$ref: keywords ignored in schema at path "${errSchemaPath}"`);
  }
  function checkNoDefault(it) {
    const { schema, opts } = it;
    if (schema.default !== void 0 && opts.useDefaults && opts.strictSchema) (0, util_1.checkStrictMode)(it, "default is ignored in the schema root");
  }
  function updateContext(it) {
    const schId = it.schema[it.opts.schemaId];
    if (schId) it.baseId = (0, resolve_1.resolveUrl)(it.opts.uriResolver, it.baseId, schId);
  }
  function checkAsyncSchema(it) {
    if (it.schema.$async && !it.schemaEnv.$async) throw new Error("async schema in sync schema");
  }
  function commentKeyword({ gen, schemaEnv, schema, errSchemaPath, opts }) {
    const msg = schema.$comment;
    if (opts.$comment === true) gen.code((0, codegen_1._)`${names_1.default.self}.logger.log(${msg})`);
    else if (typeof opts.$comment == "function") {
      const schemaPath = (0, codegen_1.str)`${errSchemaPath}/$comment`;
      const rootName = gen.scopeValue("root", { ref: schemaEnv.root });
      gen.code((0, codegen_1._)`${names_1.default.self}.opts.$comment(${msg}, ${schemaPath}, ${rootName}.schema)`);
    }
  }
  function returnResults(it) {
    const { gen, schemaEnv, validateName, ValidationError, opts } = it;
    if (schemaEnv.$async) gen.if((0, codegen_1._)`${names_1.default.errors} === 0`, () => gen.return(names_1.default.data), () => gen.throw((0, codegen_1._)`new ${ValidationError}(${names_1.default.vErrors})`));
    else {
      gen.assign((0, codegen_1._)`${validateName}.errors`, names_1.default.vErrors);
      if (opts.unevaluated) assignEvaluated(it);
      gen.return((0, codegen_1._)`${names_1.default.errors} === 0`);
    }
  }
  function assignEvaluated({ gen, evaluated, props, items }) {
    if (props instanceof codegen_1.Name) gen.assign((0, codegen_1._)`${evaluated}.props`, props);
    if (items instanceof codegen_1.Name) gen.assign((0, codegen_1._)`${evaluated}.items`, items);
  }
  function schemaKeywords(it, types, typeErrors, errsCount) {
    const { gen, schema, data, allErrors, opts, self } = it;
    const { RULES } = self;
    if (schema.$ref && (opts.ignoreKeywordsWithRef || !(0, util_1.schemaHasRulesButRef)(schema, RULES))) {
      gen.block(() => keywordCode(it, "$ref", RULES.all.$ref.definition));
      return;
    }
    if (!opts.jtd) checkStrictTypes(it, types);
    gen.block(() => {
      for (const group of RULES.rules) groupKeywords(group);
      groupKeywords(RULES.post);
    });
    function groupKeywords(group) {
      if (!(0, applicability_1.shouldUseGroup)(schema, group)) return;
      if (group.type) {
        gen.if((0, dataType_2.checkDataType)(group.type, data, opts.strictNumbers));
        iterateKeywords(it, group);
        if (types.length === 1 && types[0] === group.type && typeErrors) {
          gen.else();
          (0, dataType_2.reportTypeError)(it);
        }
        gen.endIf();
      } else iterateKeywords(it, group);
      if (!allErrors) gen.if((0, codegen_1._)`${names_1.default.errors} === ${errsCount || 0}`);
    }
  }
  function iterateKeywords(it, group) {
    const { gen, schema, opts: { useDefaults } } = it;
    if (useDefaults) (0, defaults_1.assignDefaults)(it, group.type);
    gen.block(() => {
      for (const rule of group.rules) if ((0, applicability_1.shouldUseRule)(schema, rule)) keywordCode(it, rule.keyword, rule.definition, group.type);
    });
  }
  function checkStrictTypes(it, types) {
    if (it.schemaEnv.meta || !it.opts.strictTypes) return;
    checkContextTypes(it, types);
    if (!it.opts.allowUnionTypes) checkMultipleTypes(it, types);
    checkKeywordTypes(it, it.dataTypes);
  }
  function checkContextTypes(it, types) {
    if (!types.length) return;
    if (!it.dataTypes.length) {
      it.dataTypes = types;
      return;
    }
    types.forEach((t) => {
      if (!includesType(it.dataTypes, t)) strictTypesError(it, `type "${t}" not allowed by context "${it.dataTypes.join(",")}"`);
    });
    narrowSchemaTypes(it, types);
  }
  function checkMultipleTypes(it, ts) {
    if (ts.length > 1 && !(ts.length === 2 && ts.includes("null"))) strictTypesError(it, "use allowUnionTypes to allow union type keyword");
  }
  function checkKeywordTypes(it, ts) {
    const rules = it.self.RULES.all;
    for (const keyword in rules) {
      const rule = rules[keyword];
      if (typeof rule == "object" && (0, applicability_1.shouldUseRule)(it.schema, rule)) {
        const { type } = rule.definition;
        if (type.length && !type.some((t) => hasApplicableType(ts, t))) strictTypesError(it, `missing type "${type.join(",")}" for keyword "${keyword}"`);
      }
    }
  }
  function hasApplicableType(schTs, kwdT) {
    return schTs.includes(kwdT) || kwdT === "number" && schTs.includes("integer");
  }
  function includesType(ts, t) {
    return ts.includes(t) || t === "integer" && ts.includes("number");
  }
  function narrowSchemaTypes(it, withTypes) {
    const ts = [];
    for (const t of it.dataTypes) if (includesType(withTypes, t)) ts.push(t);
    else if (withTypes.includes("integer") && t === "number") ts.push("integer");
    it.dataTypes = ts;
  }
  function strictTypesError(it, msg) {
    const schemaPath = it.schemaEnv.baseId + it.errSchemaPath;
    msg += ` at "${schemaPath}" (strictTypes)`;
    (0, util_1.checkStrictMode)(it, msg, it.opts.strictTypes);
  }
  var KeywordCxt = class {
    constructor(it, def, keyword) {
      (0, keyword_1.validateKeywordUsage)(it, def, keyword);
      this.gen = it.gen;
      this.allErrors = it.allErrors;
      this.keyword = keyword;
      this.data = it.data;
      this.schema = it.schema[keyword];
      this.$data = def.$data && it.opts.$data && this.schema && this.schema.$data;
      this.schemaValue = (0, util_1.schemaRefOrVal)(it, this.schema, keyword, this.$data);
      this.schemaType = def.schemaType;
      this.parentSchema = it.schema;
      this.params = {};
      this.it = it;
      this.def = def;
      if (this.$data) this.schemaCode = it.gen.const("vSchema", getData(this.$data, it));
      else {
        this.schemaCode = this.schemaValue;
        if (!(0, keyword_1.validSchemaType)(this.schema, def.schemaType, def.allowUndefined)) throw new Error(`${keyword} value must be ${JSON.stringify(def.schemaType)}`);
      }
      if ("code" in def ? def.trackErrors : def.errors !== false) this.errsCount = it.gen.const("_errs", names_1.default.errors);
    }
    result(condition, successAction, failAction) {
      this.failResult((0, codegen_1.not)(condition), successAction, failAction);
    }
    failResult(condition, successAction, failAction) {
      this.gen.if(condition);
      if (failAction) failAction();
      else this.error();
      if (successAction) {
        this.gen.else();
        successAction();
        if (this.allErrors) this.gen.endIf();
      } else if (this.allErrors) this.gen.endIf();
      else this.gen.else();
    }
    pass(condition, failAction) {
      this.failResult((0, codegen_1.not)(condition), void 0, failAction);
    }
    fail(condition) {
      if (condition === void 0) {
        this.error();
        if (!this.allErrors) this.gen.if(false);
        return;
      }
      this.gen.if(condition);
      this.error();
      if (this.allErrors) this.gen.endIf();
      else this.gen.else();
    }
    fail$data(condition) {
      if (!this.$data) return this.fail(condition);
      const { schemaCode } = this;
      this.fail((0, codegen_1._)`${schemaCode} !== undefined && (${(0, codegen_1.or)(this.invalid$data(), condition)})`);
    }
    error(append, errorParams, errorPaths) {
      if (errorParams) {
        this.setParams(errorParams);
        this._error(append, errorPaths);
        this.setParams({});
        return;
      }
      this._error(append, errorPaths);
    }
    _error(append, errorPaths) {
      (append ? errors_1.reportExtraError : errors_1.reportError)(this, this.def.error, errorPaths);
    }
    $dataError() {
      (0, errors_1.reportError)(this, this.def.$dataError || errors_1.keyword$DataError);
    }
    reset() {
      if (this.errsCount === void 0) throw new Error('add "trackErrors" to keyword definition');
      (0, errors_1.resetErrorsCount)(this.gen, this.errsCount);
    }
    ok(cond) {
      if (!this.allErrors) this.gen.if(cond);
    }
    setParams(obj, assign) {
      if (assign) Object.assign(this.params, obj);
      else this.params = obj;
    }
    block$data(valid, codeBlock, $dataValid = codegen_1.nil) {
      this.gen.block(() => {
        this.check$data(valid, $dataValid);
        codeBlock();
      });
    }
    check$data(valid = codegen_1.nil, $dataValid = codegen_1.nil) {
      if (!this.$data) return;
      const { gen, schemaCode, schemaType, def } = this;
      gen.if((0, codegen_1.or)((0, codegen_1._)`${schemaCode} === undefined`, $dataValid));
      if (valid !== codegen_1.nil) gen.assign(valid, true);
      if (schemaType.length || def.validateSchema) {
        gen.elseIf(this.invalid$data());
        this.$dataError();
        if (valid !== codegen_1.nil) gen.assign(valid, false);
      }
      gen.else();
    }
    invalid$data() {
      const { gen, schemaCode, schemaType, def, it } = this;
      return (0, codegen_1.or)(wrong$DataType(), invalid$DataSchema());
      function wrong$DataType() {
        if (schemaType.length) {
          if (!(schemaCode instanceof codegen_1.Name)) throw new Error("ajv implementation error");
          const st = Array.isArray(schemaType) ? schemaType : [schemaType];
          return (0, codegen_1._)`${(0, dataType_2.checkDataTypes)(st, schemaCode, it.opts.strictNumbers, dataType_2.DataType.Wrong)}`;
        }
        return codegen_1.nil;
      }
      function invalid$DataSchema() {
        if (def.validateSchema) {
          const validateSchemaRef = gen.scopeValue("validate$data", { ref: def.validateSchema });
          return (0, codegen_1._)`!${validateSchemaRef}(${schemaCode})`;
        }
        return codegen_1.nil;
      }
    }
    subschema(appl, valid) {
      const subschema = (0, subschema_1.getSubschema)(this.it, appl);
      (0, subschema_1.extendSubschemaData)(subschema, this.it, appl);
      (0, subschema_1.extendSubschemaMode)(subschema, appl);
      const nextContext = {
        ...this.it,
        ...subschema,
        items: void 0,
        props: void 0
      };
      subschemaCode(nextContext, valid);
      return nextContext;
    }
    mergeEvaluated(schemaCxt, toName) {
      const { it, gen } = this;
      if (!it.opts.unevaluated) return;
      if (it.props !== true && schemaCxt.props !== void 0) it.props = util_1.mergeEvaluated.props(gen, schemaCxt.props, it.props, toName);
      if (it.items !== true && schemaCxt.items !== void 0) it.items = util_1.mergeEvaluated.items(gen, schemaCxt.items, it.items, toName);
    }
    mergeValidEvaluated(schemaCxt, valid) {
      const { it, gen } = this;
      if (it.opts.unevaluated && (it.props !== true || it.items !== true)) {
        gen.if(valid, () => this.mergeEvaluated(schemaCxt, codegen_1.Name));
        return true;
      }
    }
  };
  exports.KeywordCxt = KeywordCxt;
  function keywordCode(it, keyword, def, ruleType) {
    const cxt = new KeywordCxt(it, def, keyword);
    if ("code" in def) def.code(cxt, ruleType);
    else if (cxt.$data && def.validate) (0, keyword_1.funcKeywordCode)(cxt, def);
    else if ("macro" in def) (0, keyword_1.macroKeywordCode)(cxt, def);
    else if (def.compile || def.validate) (0, keyword_1.funcKeywordCode)(cxt, def);
  }
  const JSON_POINTER = /^\/(?:[^~]|~0|~1)*$/;
  const RELATIVE_JSON_POINTER = /^([0-9]+)(#|\/(?:[^~]|~0|~1)*)?$/;
  function getData($data, { dataLevel, dataNames, dataPathArr }) {
    let jsonPointer;
    let data;
    if ($data === "") return names_1.default.rootData;
    if ($data[0] === "/") {
      if (!JSON_POINTER.test($data)) throw new Error(`Invalid JSON-pointer: ${$data}`);
      jsonPointer = $data;
      data = names_1.default.rootData;
    } else {
      const matches = RELATIVE_JSON_POINTER.exec($data);
      if (!matches) throw new Error(`Invalid JSON-pointer: ${$data}`);
      const up = +matches[1];
      jsonPointer = matches[2];
      if (jsonPointer === "#") {
        if (up >= dataLevel) throw new Error(errorMsg("property/index", up));
        return dataPathArr[dataLevel - up];
      }
      if (up > dataLevel) throw new Error(errorMsg("data", up));
      data = dataNames[dataLevel - up];
      if (!jsonPointer) return data;
    }
    let expr = data;
    const segments = jsonPointer.split("/");
    for (const segment of segments) if (segment) {
      data = (0, codegen_1._)`${data}${(0, codegen_1.getProperty)((0, util_1.unescapeJsonPointer)(segment))}`;
      expr = (0, codegen_1._)`${expr} && ${data}`;
    }
    return expr;
    function errorMsg(pointerType, up) {
      return `Cannot access ${pointerType} ${up} levels up, current level is ${dataLevel}`;
    }
  }
  exports.getData = getData;
});
var require_validation_error = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  var ValidationError = class extends Error {
    constructor(errors) {
      super("validation failed");
      this.errors = errors;
      this.ajv = this.validation = true;
    }
  };
  exports.default = ValidationError;
});
var require_ref_error = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const resolve_1 = require_resolve();
  var MissingRefError = class extends Error {
    constructor(resolver, baseId, ref, msg) {
      super(msg || `can't resolve reference ${ref} from id ${baseId}`);
      this.missingRef = (0, resolve_1.resolveUrl)(resolver, baseId, ref);
      this.missingSchema = (0, resolve_1.normalizeId)((0, resolve_1.getFullPath)(resolver, this.missingRef));
    }
  };
  exports.default = MissingRefError;
});
var require_compile = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.resolveSchema = exports.getCompilingSchema = exports.resolveRef = exports.compileSchema = exports.SchemaEnv = void 0;
  const codegen_1 = require_codegen();
  const validation_error_1 = require_validation_error();
  const names_1 = require_names();
  const resolve_1 = require_resolve();
  const util_1 = require_util();
  const validate_1 = require_validate();
  var SchemaEnv = class {
    constructor(env) {
      var _a;
      this.refs = {};
      this.dynamicAnchors = {};
      let schema;
      if (typeof env.schema == "object") schema = env.schema;
      this.schema = env.schema;
      this.schemaId = env.schemaId;
      this.root = env.root || this;
      this.baseId = (_a = env.baseId) !== null && _a !== void 0 ? _a : (0, resolve_1.normalizeId)(schema === null || schema === void 0 ? void 0 : schema[env.schemaId || "$id"]);
      this.schemaPath = env.schemaPath;
      this.localRefs = env.localRefs;
      this.meta = env.meta;
      this.$async = schema === null || schema === void 0 ? void 0 : schema.$async;
      this.refs = {};
    }
  };
  exports.SchemaEnv = SchemaEnv;
  function compileSchema(sch) {
    const _sch = getCompilingSchema.call(this, sch);
    if (_sch) return _sch;
    const rootId = (0, resolve_1.getFullPath)(this.opts.uriResolver, sch.root.baseId);
    const { es5, lines } = this.opts.code;
    const { ownProperties } = this.opts;
    const gen = new codegen_1.CodeGen(this.scope, {
      es5,
      lines,
      ownProperties
    });
    let _ValidationError;
    if (sch.$async) _ValidationError = gen.scopeValue("Error", {
      ref: validation_error_1.default,
      code: (0, codegen_1._)`require("ajv/dist/runtime/validation_error").default`
    });
    const validateName = gen.scopeName("validate");
    sch.validateName = validateName;
    const schemaCxt = {
      gen,
      allErrors: this.opts.allErrors,
      data: names_1.default.data,
      parentData: names_1.default.parentData,
      parentDataProperty: names_1.default.parentDataProperty,
      dataNames: [names_1.default.data],
      dataPathArr: [codegen_1.nil],
      dataLevel: 0,
      dataTypes: [],
      definedProperties: /* @__PURE__ */ new Set(),
      topSchemaRef: gen.scopeValue("schema", this.opts.code.source === true ? {
        ref: sch.schema,
        code: (0, codegen_1.stringify)(sch.schema)
      } : { ref: sch.schema }),
      validateName,
      ValidationError: _ValidationError,
      schema: sch.schema,
      schemaEnv: sch,
      rootId,
      baseId: sch.baseId || rootId,
      schemaPath: codegen_1.nil,
      errSchemaPath: sch.schemaPath || (this.opts.jtd ? "" : "#"),
      errorPath: (0, codegen_1._)`""`,
      opts: this.opts,
      self: this
    };
    let sourceCode;
    try {
      this._compilations.add(sch);
      (0, validate_1.validateFunctionCode)(schemaCxt);
      gen.optimize(this.opts.code.optimize);
      const validateCode = gen.toString();
      sourceCode = `${gen.scopeRefs(names_1.default.scope)}return ${validateCode}`;
      if (this.opts.code.process) sourceCode = this.opts.code.process(sourceCode, sch);
      const validate = new Function(`${names_1.default.self}`, `${names_1.default.scope}`, sourceCode)(this, this.scope.get());
      this.scope.value(validateName, { ref: validate });
      validate.errors = null;
      validate.schema = sch.schema;
      validate.schemaEnv = sch;
      if (sch.$async) validate.$async = true;
      if (this.opts.code.source === true) validate.source = {
        validateName,
        validateCode,
        scopeValues: gen._values
      };
      if (this.opts.unevaluated) {
        const { props, items } = schemaCxt;
        validate.evaluated = {
          props: props instanceof codegen_1.Name ? void 0 : props,
          items: items instanceof codegen_1.Name ? void 0 : items,
          dynamicProps: props instanceof codegen_1.Name,
          dynamicItems: items instanceof codegen_1.Name
        };
        if (validate.source) validate.source.evaluated = (0, codegen_1.stringify)(validate.evaluated);
      }
      sch.validate = validate;
      return sch;
    } catch (e) {
      delete sch.validate;
      delete sch.validateName;
      if (sourceCode) this.logger.error("Error compiling schema, function code:", sourceCode);
      throw e;
    } finally {
      this._compilations.delete(sch);
    }
  }
  exports.compileSchema = compileSchema;
  function resolveRef(root, baseId, ref) {
    var _a;
    ref = (0, resolve_1.resolveUrl)(this.opts.uriResolver, baseId, ref);
    const schOrFunc = root.refs[ref];
    if (schOrFunc) return schOrFunc;
    let _sch = resolve2.call(this, root, ref);
    if (_sch === void 0) {
      const schema = (_a = root.localRefs) === null || _a === void 0 ? void 0 : _a[ref];
      const { schemaId } = this.opts;
      if (schema) _sch = new SchemaEnv({
        schema,
        schemaId,
        root,
        baseId
      });
    }
    if (_sch === void 0) return;
    return root.refs[ref] = inlineOrCompile.call(this, _sch);
  }
  exports.resolveRef = resolveRef;
  function inlineOrCompile(sch) {
    if ((0, resolve_1.inlineRef)(sch.schema, this.opts.inlineRefs)) return sch.schema;
    return sch.validate ? sch : compileSchema.call(this, sch);
  }
  function getCompilingSchema(schEnv) {
    for (const sch of this._compilations) if (sameSchemaEnv(sch, schEnv)) return sch;
  }
  exports.getCompilingSchema = getCompilingSchema;
  function sameSchemaEnv(s1, s2) {
    return s1.schema === s2.schema && s1.root === s2.root && s1.baseId === s2.baseId;
  }
  function resolve2(root, ref) {
    let sch;
    while (typeof (sch = this.refs[ref]) == "string") ref = sch;
    return sch || this.schemas[ref] || resolveSchema.call(this, root, ref);
  }
  function resolveSchema(root, ref) {
    const p = this.opts.uriResolver.parse(ref);
    const refPath = (0, resolve_1._getFullPath)(this.opts.uriResolver, p);
    let baseId = (0, resolve_1.getFullPath)(this.opts.uriResolver, root.baseId, void 0);
    if (Object.keys(root.schema).length > 0 && refPath === baseId) return getJsonPointer.call(this, p, root);
    const id = (0, resolve_1.normalizeId)(refPath);
    const schOrRef = this.refs[id] || this.schemas[id];
    if (typeof schOrRef == "string") {
      const sch = resolveSchema.call(this, root, schOrRef);
      if (typeof (sch === null || sch === void 0 ? void 0 : sch.schema) !== "object") return;
      return getJsonPointer.call(this, p, sch);
    }
    if (typeof (schOrRef === null || schOrRef === void 0 ? void 0 : schOrRef.schema) !== "object") return;
    if (!schOrRef.validate) compileSchema.call(this, schOrRef);
    if (id === (0, resolve_1.normalizeId)(ref)) {
      const { schema } = schOrRef;
      const { schemaId } = this.opts;
      const schId = schema[schemaId];
      if (schId) baseId = (0, resolve_1.resolveUrl)(this.opts.uriResolver, baseId, schId);
      return new SchemaEnv({
        schema,
        schemaId,
        root,
        baseId
      });
    }
    return getJsonPointer.call(this, p, schOrRef);
  }
  exports.resolveSchema = resolveSchema;
  const PREVENT_SCOPE_CHANGE = /* @__PURE__ */ new Set([
    "properties",
    "patternProperties",
    "enum",
    "dependencies",
    "definitions"
  ]);
  function getJsonPointer(parsedRef, { baseId, schema, root }) {
    var _a;
    if (((_a = parsedRef.fragment) === null || _a === void 0 ? void 0 : _a[0]) !== "/") return;
    for (const part of parsedRef.fragment.slice(1).split("/")) {
      if (typeof schema === "boolean") return;
      const partSchema = schema[(0, util_1.unescapeFragment)(part)];
      if (partSchema === void 0) return;
      schema = partSchema;
      const schId = typeof schema === "object" && schema[this.opts.schemaId];
      if (!PREVENT_SCOPE_CHANGE.has(part) && schId) baseId = (0, resolve_1.resolveUrl)(this.opts.uriResolver, baseId, schId);
    }
    let env;
    if (typeof schema != "boolean" && schema.$ref && !(0, util_1.schemaHasRulesButRef)(schema, this.RULES)) {
      const $ref = (0, resolve_1.resolveUrl)(this.opts.uriResolver, baseId, schema.$ref);
      env = resolveSchema.call(this, root, $ref);
    }
    const { schemaId } = this.opts;
    env = env || new SchemaEnv({
      schema,
      schemaId,
      root,
      baseId
    });
    if (env.schema !== env.root.schema) return env;
  }
});
var require_data = /* @__PURE__ */ __commonJSMin((exports, module) => {
  module.exports = {
    "$id": "https://raw.githubusercontent.com/ajv-validator/ajv/master/lib/refs/data.json#",
    "description": "Meta-schema for $data reference (JSON AnySchema extension proposal)",
    "type": "object",
    "required": ["$data"],
    "properties": { "$data": {
      "type": "string",
      "anyOf": [{ "format": "relative-json-pointer" }, { "format": "json-pointer" }]
    } },
    "additionalProperties": false
  };
});
var require_utils = /* @__PURE__ */ __commonJSMin((exports, module) => {
  const isUUID = RegExp.prototype.test.bind(/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu);
  const isIPv4 = RegExp.prototype.test.bind(/^(?:(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]\d|\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]\d|\d)$/u);
  function stringArrayToHexStripped(input) {
    let acc = "";
    let code = 0;
    let i = 0;
    for (i = 0; i < input.length; i++) {
      code = input[i].charCodeAt(0);
      if (code === 48) continue;
      if (!(code >= 48 && code <= 57 || code >= 65 && code <= 70 || code >= 97 && code <= 102)) return "";
      acc += input[i];
      break;
    }
    for (i += 1; i < input.length; i++) {
      code = input[i].charCodeAt(0);
      if (!(code >= 48 && code <= 57 || code >= 65 && code <= 70 || code >= 97 && code <= 102)) return "";
      acc += input[i];
    }
    return acc;
  }
  const nonSimpleDomain = RegExp.prototype.test.bind(/[^!"$&'()*+,\-.;=_`a-z{}~]/u);
  function consumeIsZone(buffer) {
    buffer.length = 0;
    return true;
  }
  function consumeHextets(buffer, address, output) {
    if (buffer.length) {
      const hex = stringArrayToHexStripped(buffer);
      if (hex !== "") address.push(hex);
      else {
        output.error = true;
        return false;
      }
      buffer.length = 0;
    }
    return true;
  }
  function getIPV6(input) {
    let tokenCount = 0;
    const output = {
      error: false,
      address: "",
      zone: ""
    };
    const address = [];
    const buffer = [];
    let endipv6Encountered = false;
    let endIpv6 = false;
    let consume = consumeHextets;
    for (let i = 0; i < input.length; i++) {
      const cursor = input[i];
      if (cursor === "[" || cursor === "]") continue;
      if (cursor === ":") {
        if (endipv6Encountered === true) endIpv6 = true;
        if (!consume(buffer, address, output)) break;
        if (++tokenCount > 7) {
          output.error = true;
          break;
        }
        if (i > 0 && input[i - 1] === ":") endipv6Encountered = true;
        address.push(":");
        continue;
      } else if (cursor === "%") {
        if (!consume(buffer, address, output)) break;
        consume = consumeIsZone;
      } else {
        buffer.push(cursor);
        continue;
      }
    }
    if (buffer.length) if (consume === consumeIsZone) output.zone = buffer.join("");
    else if (endIpv6) address.push(buffer.join(""));
    else address.push(stringArrayToHexStripped(buffer));
    output.address = address.join("");
    return output;
  }
  function normalizeIPv6(host) {
    if (findToken(host, ":") < 2) return {
      host,
      isIPV6: false
    };
    const ipv6 = getIPV6(host);
    if (!ipv6.error) {
      let newHost = ipv6.address;
      let escapedHost = ipv6.address;
      if (ipv6.zone) {
        newHost += "%" + ipv6.zone;
        escapedHost += "%25" + ipv6.zone;
      }
      return {
        host: newHost,
        isIPV6: true,
        escapedHost
      };
    } else return {
      host,
      isIPV6: false
    };
  }
  function findToken(str, token) {
    let ind = 0;
    for (let i = 0; i < str.length; i++) if (str[i] === token) ind++;
    return ind;
  }
  function removeDotSegments(path) {
    let input = path;
    const output = [];
    let nextSlash = -1;
    let len = 0;
    while (len = input.length) {
      if (len === 1) if (input === ".") break;
      else if (input === "/") {
        output.push("/");
        break;
      } else {
        output.push(input);
        break;
      }
      else if (len === 2) {
        if (input[0] === ".") {
          if (input[1] === ".") break;
          else if (input[1] === "/") {
            input = input.slice(2);
            continue;
          }
        } else if (input[0] === "/") {
          if (input[1] === "." || input[1] === "/") {
            output.push("/");
            break;
          }
        }
      } else if (len === 3) {
        if (input === "/..") {
          if (output.length !== 0) output.pop();
          output.push("/");
          break;
        }
      }
      if (input[0] === ".") {
        if (input[1] === ".") {
          if (input[2] === "/") {
            input = input.slice(3);
            continue;
          }
        } else if (input[1] === "/") {
          input = input.slice(2);
          continue;
        }
      } else if (input[0] === "/") {
        if (input[1] === ".") {
          if (input[2] === "/") {
            input = input.slice(2);
            continue;
          } else if (input[2] === ".") {
            if (input[3] === "/") {
              input = input.slice(3);
              if (output.length !== 0) output.pop();
              continue;
            }
          }
        }
      }
      if ((nextSlash = input.indexOf("/", 1)) === -1) {
        output.push(input);
        break;
      } else {
        output.push(input.slice(0, nextSlash));
        input = input.slice(nextSlash);
      }
    }
    return output.join("");
  }
  function normalizeComponentEncoding(component, esc) {
    const func = esc !== true ? escape : unescape;
    if (component.scheme !== void 0) component.scheme = func(component.scheme);
    if (component.userinfo !== void 0) component.userinfo = func(component.userinfo);
    if (component.host !== void 0) component.host = func(component.host);
    if (component.path !== void 0) component.path = func(component.path);
    if (component.query !== void 0) component.query = func(component.query);
    if (component.fragment !== void 0) component.fragment = func(component.fragment);
    return component;
  }
  function recomposeAuthority(component) {
    const uriTokens = [];
    if (component.userinfo !== void 0) {
      uriTokens.push(component.userinfo);
      uriTokens.push("@");
    }
    if (component.host !== void 0) {
      let host = unescape(component.host);
      if (!isIPv4(host)) {
        const ipV6res = normalizeIPv6(host);
        if (ipV6res.isIPV6 === true) host = `[${ipV6res.escapedHost}]`;
        else host = component.host;
      }
      uriTokens.push(host);
    }
    if (typeof component.port === "number" || typeof component.port === "string") {
      uriTokens.push(":");
      uriTokens.push(String(component.port));
    }
    return uriTokens.length ? uriTokens.join("") : void 0;
  }
  module.exports = {
    nonSimpleDomain,
    recomposeAuthority,
    normalizeComponentEncoding,
    removeDotSegments,
    isIPv4,
    isUUID,
    normalizeIPv6,
    stringArrayToHexStripped
  };
});
var require_schemes = /* @__PURE__ */ __commonJSMin((exports, module) => {
  const { isUUID } = require_utils();
  const URN_REG = /([\da-z][\d\-a-z]{0,31}):((?:[\w!$'()*+,\-.:;=@]|%[\da-f]{2})+)/iu;
  const supportedSchemeNames = [
    "http",
    "https",
    "ws",
    "wss",
    "urn",
    "urn:uuid"
  ];
  function isValidSchemeName(name) {
    return supportedSchemeNames.indexOf(name) !== -1;
  }
  function wsIsSecure(wsComponent) {
    if (wsComponent.secure === true) return true;
    else if (wsComponent.secure === false) return false;
    else if (wsComponent.scheme) return wsComponent.scheme.length === 3 && (wsComponent.scheme[0] === "w" || wsComponent.scheme[0] === "W") && (wsComponent.scheme[1] === "s" || wsComponent.scheme[1] === "S") && (wsComponent.scheme[2] === "s" || wsComponent.scheme[2] === "S");
    else return false;
  }
  function httpParse(component) {
    if (!component.host) component.error = component.error || "HTTP URIs must have a host.";
    return component;
  }
  function httpSerialize(component) {
    const secure = String(component.scheme).toLowerCase() === "https";
    if (component.port === (secure ? 443 : 80) || component.port === "") component.port = void 0;
    if (!component.path) component.path = "/";
    return component;
  }
  function wsParse(wsComponent) {
    wsComponent.secure = wsIsSecure(wsComponent);
    wsComponent.resourceName = (wsComponent.path || "/") + (wsComponent.query ? "?" + wsComponent.query : "");
    wsComponent.path = void 0;
    wsComponent.query = void 0;
    return wsComponent;
  }
  function wsSerialize(wsComponent) {
    if (wsComponent.port === (wsIsSecure(wsComponent) ? 443 : 80) || wsComponent.port === "") wsComponent.port = void 0;
    if (typeof wsComponent.secure === "boolean") {
      wsComponent.scheme = wsComponent.secure ? "wss" : "ws";
      wsComponent.secure = void 0;
    }
    if (wsComponent.resourceName) {
      const [path, query] = wsComponent.resourceName.split("?");
      wsComponent.path = path && path !== "/" ? path : void 0;
      wsComponent.query = query;
      wsComponent.resourceName = void 0;
    }
    wsComponent.fragment = void 0;
    return wsComponent;
  }
  function urnParse(urnComponent, options) {
    if (!urnComponent.path) {
      urnComponent.error = "URN can not be parsed";
      return urnComponent;
    }
    const matches = urnComponent.path.match(URN_REG);
    if (matches) {
      const scheme = options.scheme || urnComponent.scheme || "urn";
      urnComponent.nid = matches[1].toLowerCase();
      urnComponent.nss = matches[2];
      const schemeHandler = getSchemeHandler(`${scheme}:${options.nid || urnComponent.nid}`);
      urnComponent.path = void 0;
      if (schemeHandler) urnComponent = schemeHandler.parse(urnComponent, options);
    } else urnComponent.error = urnComponent.error || "URN can not be parsed.";
    return urnComponent;
  }
  function urnSerialize(urnComponent, options) {
    if (urnComponent.nid === void 0) throw new Error("URN without nid cannot be serialized");
    const scheme = options.scheme || urnComponent.scheme || "urn";
    const nid = urnComponent.nid.toLowerCase();
    const schemeHandler = getSchemeHandler(`${scheme}:${options.nid || nid}`);
    if (schemeHandler) urnComponent = schemeHandler.serialize(urnComponent, options);
    const uriComponent = urnComponent;
    const nss = urnComponent.nss;
    uriComponent.path = `${nid || options.nid}:${nss}`;
    options.skipEscape = true;
    return uriComponent;
  }
  function urnuuidParse(urnComponent, options) {
    const uuidComponent = urnComponent;
    uuidComponent.uuid = uuidComponent.nss;
    uuidComponent.nss = void 0;
    if (!options.tolerant && (!uuidComponent.uuid || !isUUID(uuidComponent.uuid))) uuidComponent.error = uuidComponent.error || "UUID is not valid.";
    return uuidComponent;
  }
  function urnuuidSerialize(uuidComponent) {
    const urnComponent = uuidComponent;
    urnComponent.nss = (uuidComponent.uuid || "").toLowerCase();
    return urnComponent;
  }
  const http = {
    scheme: "http",
    domainHost: true,
    parse: httpParse,
    serialize: httpSerialize
  };
  const https = {
    scheme: "https",
    domainHost: http.domainHost,
    parse: httpParse,
    serialize: httpSerialize
  };
  const ws = {
    scheme: "ws",
    domainHost: true,
    parse: wsParse,
    serialize: wsSerialize
  };
  const wss = {
    scheme: "wss",
    domainHost: ws.domainHost,
    parse: ws.parse,
    serialize: ws.serialize
  };
  const urn = {
    scheme: "urn",
    parse: urnParse,
    serialize: urnSerialize,
    skipNormalize: true
  };
  const urnuuid = {
    scheme: "urn:uuid",
    parse: urnuuidParse,
    serialize: urnuuidSerialize,
    skipNormalize: true
  };
  const SCHEMES = {
    http,
    https,
    ws,
    wss,
    urn,
    "urn:uuid": urnuuid
  };
  Object.setPrototypeOf(SCHEMES, null);
  function getSchemeHandler(scheme) {
    return scheme && (SCHEMES[scheme] || SCHEMES[scheme.toLowerCase()]) || void 0;
  }
  module.exports = {
    wsIsSecure,
    SCHEMES,
    isValidSchemeName,
    getSchemeHandler
  };
});
var require_fast_uri = /* @__PURE__ */ __commonJSMin((exports, module) => {
  const { normalizeIPv6, removeDotSegments, recomposeAuthority, normalizeComponentEncoding, isIPv4, nonSimpleDomain } = require_utils();
  const { SCHEMES, getSchemeHandler } = require_schemes();
  function normalize(uri, options) {
    if (typeof uri === "string") uri = serialize(parse(uri, options), options);
    else if (typeof uri === "object") uri = parse(serialize(uri, options), options);
    return uri;
  }
  function resolve2(baseURI, relativeURI, options) {
    const schemelessOptions = options ? Object.assign({ scheme: "null" }, options) : { scheme: "null" };
    const resolved = resolveComponent(parse(baseURI, schemelessOptions), parse(relativeURI, schemelessOptions), schemelessOptions, true);
    schemelessOptions.skipEscape = true;
    return serialize(resolved, schemelessOptions);
  }
  function resolveComponent(base, relative, options, skipNormalization) {
    const target = {};
    if (!skipNormalization) {
      base = parse(serialize(base, options), options);
      relative = parse(serialize(relative, options), options);
    }
    options = options || {};
    if (!options.tolerant && relative.scheme) {
      target.scheme = relative.scheme;
      target.userinfo = relative.userinfo;
      target.host = relative.host;
      target.port = relative.port;
      target.path = removeDotSegments(relative.path || "");
      target.query = relative.query;
    } else {
      if (relative.userinfo !== void 0 || relative.host !== void 0 || relative.port !== void 0) {
        target.userinfo = relative.userinfo;
        target.host = relative.host;
        target.port = relative.port;
        target.path = removeDotSegments(relative.path || "");
        target.query = relative.query;
      } else {
        if (!relative.path) {
          target.path = base.path;
          if (relative.query !== void 0) target.query = relative.query;
          else target.query = base.query;
        } else {
          if (relative.path[0] === "/") target.path = removeDotSegments(relative.path);
          else {
            if ((base.userinfo !== void 0 || base.host !== void 0 || base.port !== void 0) && !base.path) target.path = "/" + relative.path;
            else if (!base.path) target.path = relative.path;
            else target.path = base.path.slice(0, base.path.lastIndexOf("/") + 1) + relative.path;
            target.path = removeDotSegments(target.path);
          }
          target.query = relative.query;
        }
        target.userinfo = base.userinfo;
        target.host = base.host;
        target.port = base.port;
      }
      target.scheme = base.scheme;
    }
    target.fragment = relative.fragment;
    return target;
  }
  function equal(uriA, uriB, options) {
    if (typeof uriA === "string") {
      uriA = unescape(uriA);
      uriA = serialize(normalizeComponentEncoding(parse(uriA, options), true), {
        ...options,
        skipEscape: true
      });
    } else if (typeof uriA === "object") uriA = serialize(normalizeComponentEncoding(uriA, true), {
      ...options,
      skipEscape: true
    });
    if (typeof uriB === "string") {
      uriB = unescape(uriB);
      uriB = serialize(normalizeComponentEncoding(parse(uriB, options), true), {
        ...options,
        skipEscape: true
      });
    } else if (typeof uriB === "object") uriB = serialize(normalizeComponentEncoding(uriB, true), {
      ...options,
      skipEscape: true
    });
    return uriA.toLowerCase() === uriB.toLowerCase();
  }
  function serialize(cmpts, opts) {
    const component = {
      host: cmpts.host,
      scheme: cmpts.scheme,
      userinfo: cmpts.userinfo,
      port: cmpts.port,
      path: cmpts.path,
      query: cmpts.query,
      nid: cmpts.nid,
      nss: cmpts.nss,
      uuid: cmpts.uuid,
      fragment: cmpts.fragment,
      reference: cmpts.reference,
      resourceName: cmpts.resourceName,
      secure: cmpts.secure,
      error: ""
    };
    const options = Object.assign({}, opts);
    const uriTokens = [];
    const schemeHandler = getSchemeHandler(options.scheme || component.scheme);
    if (schemeHandler && schemeHandler.serialize) schemeHandler.serialize(component, options);
    if (component.path !== void 0) if (!options.skipEscape) {
      component.path = escape(component.path);
      if (component.scheme !== void 0) component.path = component.path.split("%3A").join(":");
    } else component.path = unescape(component.path);
    if (options.reference !== "suffix" && component.scheme) uriTokens.push(component.scheme, ":");
    const authority = recomposeAuthority(component);
    if (authority !== void 0) {
      if (options.reference !== "suffix") uriTokens.push("//");
      uriTokens.push(authority);
      if (component.path && component.path[0] !== "/") uriTokens.push("/");
    }
    if (component.path !== void 0) {
      let s = component.path;
      if (!options.absolutePath && (!schemeHandler || !schemeHandler.absolutePath)) s = removeDotSegments(s);
      if (authority === void 0 && s[0] === "/" && s[1] === "/") s = "/%2F" + s.slice(2);
      uriTokens.push(s);
    }
    if (component.query !== void 0) uriTokens.push("?", component.query);
    if (component.fragment !== void 0) uriTokens.push("#", component.fragment);
    return uriTokens.join("");
  }
  const URI_PARSE = /^(?:([^#/:?]+):)?(?:\/\/((?:([^#/?@]*)@)?(\[[^#/?\]]+\]|[^#/:?]*)(?::(\d*))?))?([^#?]*)(?:\?([^#]*))?(?:#((?:.|[\n\r])*))?/u;
  function parse(uri, opts) {
    const options = Object.assign({}, opts);
    const parsed = {
      scheme: void 0,
      userinfo: void 0,
      host: "",
      port: void 0,
      path: "",
      query: void 0,
      fragment: void 0
    };
    let isIP2 = false;
    if (options.reference === "suffix") if (options.scheme) uri = options.scheme + ":" + uri;
    else uri = "//" + uri;
    const matches = uri.match(URI_PARSE);
    if (matches) {
      parsed.scheme = matches[1];
      parsed.userinfo = matches[3];
      parsed.host = matches[4];
      parsed.port = parseInt(matches[5], 10);
      parsed.path = matches[6] || "";
      parsed.query = matches[7];
      parsed.fragment = matches[8];
      if (isNaN(parsed.port)) parsed.port = matches[5];
      if (parsed.host) if (isIPv4(parsed.host) === false) {
        const ipv6result = normalizeIPv6(parsed.host);
        parsed.host = ipv6result.host.toLowerCase();
        isIP2 = ipv6result.isIPV6;
      } else isIP2 = true;
      if (parsed.scheme === void 0 && parsed.userinfo === void 0 && parsed.host === void 0 && parsed.port === void 0 && parsed.query === void 0 && !parsed.path) parsed.reference = "same-document";
      else if (parsed.scheme === void 0) parsed.reference = "relative";
      else if (parsed.fragment === void 0) parsed.reference = "absolute";
      else parsed.reference = "uri";
      if (options.reference && options.reference !== "suffix" && options.reference !== parsed.reference) parsed.error = parsed.error || "URI is not a " + options.reference + " reference.";
      const schemeHandler = getSchemeHandler(options.scheme || parsed.scheme);
      if (!options.unicodeSupport && (!schemeHandler || !schemeHandler.unicodeSupport)) {
        if (parsed.host && (options.domainHost || schemeHandler && schemeHandler.domainHost) && isIP2 === false && nonSimpleDomain(parsed.host)) try {
          parsed.host = URL.domainToASCII(parsed.host.toLowerCase());
        } catch (e) {
          parsed.error = parsed.error || "Host's domain name can not be converted to ASCII: " + e;
        }
      }
      if (!schemeHandler || schemeHandler && !schemeHandler.skipNormalize) {
        if (uri.indexOf("%") !== -1) {
          if (parsed.scheme !== void 0) parsed.scheme = unescape(parsed.scheme);
          if (parsed.host !== void 0) parsed.host = unescape(parsed.host);
        }
        if (parsed.path) parsed.path = escape(unescape(parsed.path));
        if (parsed.fragment) parsed.fragment = encodeURI(decodeURIComponent(parsed.fragment));
      }
      if (schemeHandler && schemeHandler.parse) schemeHandler.parse(parsed, options);
    } else parsed.error = parsed.error || "URI can not be parsed.";
    return parsed;
  }
  const fastUri = {
    SCHEMES,
    normalize,
    resolve: resolve2,
    resolveComponent,
    equal,
    serialize,
    parse
  };
  module.exports = fastUri;
  module.exports.default = fastUri;
  module.exports.fastUri = fastUri;
});
var require_uri = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const uri = require_fast_uri();
  uri.code = 'require("ajv/dist/runtime/uri").default';
  exports.default = uri;
});
var require_core$3 = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.CodeGen = exports.Name = exports.nil = exports.stringify = exports.str = exports._ = exports.KeywordCxt = void 0;
  var validate_1 = require_validate();
  Object.defineProperty(exports, "KeywordCxt", {
    enumerable: true,
    get: function() {
      return validate_1.KeywordCxt;
    }
  });
  var codegen_1 = require_codegen();
  Object.defineProperty(exports, "_", {
    enumerable: true,
    get: function() {
      return codegen_1._;
    }
  });
  Object.defineProperty(exports, "str", {
    enumerable: true,
    get: function() {
      return codegen_1.str;
    }
  });
  Object.defineProperty(exports, "stringify", {
    enumerable: true,
    get: function() {
      return codegen_1.stringify;
    }
  });
  Object.defineProperty(exports, "nil", {
    enumerable: true,
    get: function() {
      return codegen_1.nil;
    }
  });
  Object.defineProperty(exports, "Name", {
    enumerable: true,
    get: function() {
      return codegen_1.Name;
    }
  });
  Object.defineProperty(exports, "CodeGen", {
    enumerable: true,
    get: function() {
      return codegen_1.CodeGen;
    }
  });
  const validation_error_1 = require_validation_error();
  const ref_error_1 = require_ref_error();
  const rules_1 = require_rules();
  const compile_1 = require_compile();
  const codegen_2 = require_codegen();
  const resolve_1 = require_resolve();
  const dataType_1 = require_dataType();
  const util_1 = require_util();
  const $dataRefSchema = require_data();
  const uri_1 = require_uri();
  const defaultRegExp = (str, flags) => new RegExp(str, flags);
  defaultRegExp.code = "new RegExp";
  const META_IGNORE_OPTIONS = [
    "removeAdditional",
    "useDefaults",
    "coerceTypes"
  ];
  const EXT_SCOPE_NAMES = /* @__PURE__ */ new Set([
    "validate",
    "serialize",
    "parse",
    "wrapper",
    "root",
    "schema",
    "keyword",
    "pattern",
    "formats",
    "validate$data",
    "func",
    "obj",
    "Error"
  ]);
  const removedOptions = {
    errorDataPath: "",
    format: "`validateFormats: false` can be used instead.",
    nullable: '"nullable" keyword is supported by default.',
    jsonPointers: "Deprecated jsPropertySyntax can be used instead.",
    extendRefs: "Deprecated ignoreKeywordsWithRef can be used instead.",
    missingRefs: "Pass empty schema with $id that should be ignored to ajv.addSchema.",
    processCode: "Use option `code: {process: (code, schemaEnv: object) => string}`",
    sourceCode: "Use option `code: {source: true}`",
    strictDefaults: "It is default now, see option `strict`.",
    strictKeywords: "It is default now, see option `strict`.",
    uniqueItems: '"uniqueItems" keyword is always validated.',
    unknownFormats: "Disable strict mode or pass `true` to `ajv.addFormat` (or `formats` option).",
    cache: "Map is used as cache, schema object as key.",
    serialize: "Map is used as cache, schema object as key.",
    ajvErrors: "It is default now."
  };
  const deprecatedOptions = {
    ignoreKeywordsWithRef: "",
    jsPropertySyntax: "",
    unicode: '"minLength"/"maxLength" account for unicode characters by default.'
  };
  const MAX_EXPRESSION = 200;
  function requiredOptions(o) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z, _0;
    const s = o.strict;
    const _optz = (_a = o.code) === null || _a === void 0 ? void 0 : _a.optimize;
    const optimize = _optz === true || _optz === void 0 ? 1 : _optz || 0;
    const regExp = (_c = (_b = o.code) === null || _b === void 0 ? void 0 : _b.regExp) !== null && _c !== void 0 ? _c : defaultRegExp;
    const uriResolver = (_d = o.uriResolver) !== null && _d !== void 0 ? _d : uri_1.default;
    return {
      strictSchema: (_f = (_e = o.strictSchema) !== null && _e !== void 0 ? _e : s) !== null && _f !== void 0 ? _f : true,
      strictNumbers: (_h = (_g = o.strictNumbers) !== null && _g !== void 0 ? _g : s) !== null && _h !== void 0 ? _h : true,
      strictTypes: (_k = (_j = o.strictTypes) !== null && _j !== void 0 ? _j : s) !== null && _k !== void 0 ? _k : "log",
      strictTuples: (_m = (_l = o.strictTuples) !== null && _l !== void 0 ? _l : s) !== null && _m !== void 0 ? _m : "log",
      strictRequired: (_p = (_o = o.strictRequired) !== null && _o !== void 0 ? _o : s) !== null && _p !== void 0 ? _p : false,
      code: o.code ? {
        ...o.code,
        optimize,
        regExp
      } : {
        optimize,
        regExp
      },
      loopRequired: (_q = o.loopRequired) !== null && _q !== void 0 ? _q : MAX_EXPRESSION,
      loopEnum: (_r = o.loopEnum) !== null && _r !== void 0 ? _r : MAX_EXPRESSION,
      meta: (_s = o.meta) !== null && _s !== void 0 ? _s : true,
      messages: (_t = o.messages) !== null && _t !== void 0 ? _t : true,
      inlineRefs: (_u = o.inlineRefs) !== null && _u !== void 0 ? _u : true,
      schemaId: (_v = o.schemaId) !== null && _v !== void 0 ? _v : "$id",
      addUsedSchema: (_w = o.addUsedSchema) !== null && _w !== void 0 ? _w : true,
      validateSchema: (_x = o.validateSchema) !== null && _x !== void 0 ? _x : true,
      validateFormats: (_y = o.validateFormats) !== null && _y !== void 0 ? _y : true,
      unicodeRegExp: (_z = o.unicodeRegExp) !== null && _z !== void 0 ? _z : true,
      int32range: (_0 = o.int32range) !== null && _0 !== void 0 ? _0 : true,
      uriResolver
    };
  }
  var Ajv2 = class {
    constructor(opts = {}) {
      this.schemas = {};
      this.refs = {};
      this.formats = {};
      this._compilations = /* @__PURE__ */ new Set();
      this._loading = {};
      this._cache = /* @__PURE__ */ new Map();
      opts = this.opts = {
        ...opts,
        ...requiredOptions(opts)
      };
      const { es5, lines } = this.opts.code;
      this.scope = new codegen_2.ValueScope({
        scope: {},
        prefixes: EXT_SCOPE_NAMES,
        es5,
        lines
      });
      this.logger = getLogger(opts.logger);
      const formatOpt = opts.validateFormats;
      opts.validateFormats = false;
      this.RULES = (0, rules_1.getRules)();
      checkOptions.call(this, removedOptions, opts, "NOT SUPPORTED");
      checkOptions.call(this, deprecatedOptions, opts, "DEPRECATED", "warn");
      this._metaOpts = getMetaSchemaOptions.call(this);
      if (opts.formats) addInitialFormats.call(this);
      this._addVocabularies();
      this._addDefaultMetaSchema();
      if (opts.keywords) addInitialKeywords.call(this, opts.keywords);
      if (typeof opts.meta == "object") this.addMetaSchema(opts.meta);
      addInitialSchemas.call(this);
      opts.validateFormats = formatOpt;
    }
    _addVocabularies() {
      this.addKeyword("$async");
    }
    _addDefaultMetaSchema() {
      const { $data, meta, schemaId } = this.opts;
      let _dataRefSchema = $dataRefSchema;
      if (schemaId === "id") {
        _dataRefSchema = { ...$dataRefSchema };
        _dataRefSchema.id = _dataRefSchema.$id;
        delete _dataRefSchema.$id;
      }
      if (meta && $data) this.addMetaSchema(_dataRefSchema, _dataRefSchema[schemaId], false);
    }
    defaultMeta() {
      const { meta, schemaId } = this.opts;
      return this.opts.defaultMeta = typeof meta == "object" ? meta[schemaId] || meta : void 0;
    }
    validate(schemaKeyRef, data) {
      let v;
      if (typeof schemaKeyRef == "string") {
        v = this.getSchema(schemaKeyRef);
        if (!v) throw new Error(`no schema with key or ref "${schemaKeyRef}"`);
      } else v = this.compile(schemaKeyRef);
      const valid = v(data);
      if (!("$async" in v)) this.errors = v.errors;
      return valid;
    }
    compile(schema, _meta) {
      const sch = this._addSchema(schema, _meta);
      return sch.validate || this._compileSchemaEnv(sch);
    }
    compileAsync(schema, meta) {
      if (typeof this.opts.loadSchema != "function") throw new Error("options.loadSchema should be a function");
      const { loadSchema } = this.opts;
      return runCompileAsync.call(this, schema, meta);
      async function runCompileAsync(_schema, _meta) {
        await loadMetaSchema.call(this, _schema.$schema);
        const sch = this._addSchema(_schema, _meta);
        return sch.validate || _compileAsync.call(this, sch);
      }
      async function loadMetaSchema($ref) {
        if ($ref && !this.getSchema($ref)) await runCompileAsync.call(this, { $ref }, true);
      }
      async function _compileAsync(sch) {
        try {
          return this._compileSchemaEnv(sch);
        } catch (e) {
          if (!(e instanceof ref_error_1.default)) throw e;
          checkLoaded.call(this, e);
          await loadMissingSchema.call(this, e.missingSchema);
          return _compileAsync.call(this, sch);
        }
      }
      function checkLoaded({ missingSchema: ref, missingRef }) {
        if (this.refs[ref]) throw new Error(`AnySchema ${ref} is loaded but ${missingRef} cannot be resolved`);
      }
      async function loadMissingSchema(ref) {
        const _schema = await _loadSchema.call(this, ref);
        if (!this.refs[ref]) await loadMetaSchema.call(this, _schema.$schema);
        if (!this.refs[ref]) this.addSchema(_schema, ref, meta);
      }
      async function _loadSchema(ref) {
        const p = this._loading[ref];
        if (p) return p;
        try {
          return await (this._loading[ref] = loadSchema(ref));
        } finally {
          delete this._loading[ref];
        }
      }
    }
    addSchema(schema, key, _meta, _validateSchema = this.opts.validateSchema) {
      if (Array.isArray(schema)) {
        for (const sch of schema) this.addSchema(sch, void 0, _meta, _validateSchema);
        return this;
      }
      let id;
      if (typeof schema === "object") {
        const { schemaId } = this.opts;
        id = schema[schemaId];
        if (id !== void 0 && typeof id != "string") throw new Error(`schema ${schemaId} must be string`);
      }
      key = (0, resolve_1.normalizeId)(key || id);
      this._checkUnique(key);
      this.schemas[key] = this._addSchema(schema, _meta, key, _validateSchema, true);
      return this;
    }
    addMetaSchema(schema, key, _validateSchema = this.opts.validateSchema) {
      this.addSchema(schema, key, true, _validateSchema);
      return this;
    }
    validateSchema(schema, throwOrLogError) {
      if (typeof schema == "boolean") return true;
      let $schema;
      $schema = schema.$schema;
      if ($schema !== void 0 && typeof $schema != "string") throw new Error("$schema must be a string");
      $schema = $schema || this.opts.defaultMeta || this.defaultMeta();
      if (!$schema) {
        this.logger.warn("meta-schema not available");
        this.errors = null;
        return true;
      }
      const valid = this.validate($schema, schema);
      if (!valid && throwOrLogError) {
        const message = "schema is invalid: " + this.errorsText();
        if (this.opts.validateSchema === "log") this.logger.error(message);
        else throw new Error(message);
      }
      return valid;
    }
    getSchema(keyRef) {
      let sch;
      while (typeof (sch = getSchEnv.call(this, keyRef)) == "string") keyRef = sch;
      if (sch === void 0) {
        const { schemaId } = this.opts;
        const root = new compile_1.SchemaEnv({
          schema: {},
          schemaId
        });
        sch = compile_1.resolveSchema.call(this, root, keyRef);
        if (!sch) return;
        this.refs[keyRef] = sch;
      }
      return sch.validate || this._compileSchemaEnv(sch);
    }
    removeSchema(schemaKeyRef) {
      if (schemaKeyRef instanceof RegExp) {
        this._removeAllSchemas(this.schemas, schemaKeyRef);
        this._removeAllSchemas(this.refs, schemaKeyRef);
        return this;
      }
      switch (typeof schemaKeyRef) {
        case "undefined":
          this._removeAllSchemas(this.schemas);
          this._removeAllSchemas(this.refs);
          this._cache.clear();
          return this;
        case "string": {
          const sch = getSchEnv.call(this, schemaKeyRef);
          if (typeof sch == "object") this._cache.delete(sch.schema);
          delete this.schemas[schemaKeyRef];
          delete this.refs[schemaKeyRef];
          return this;
        }
        case "object": {
          const cacheKey2 = schemaKeyRef;
          this._cache.delete(cacheKey2);
          let id = schemaKeyRef[this.opts.schemaId];
          if (id) {
            id = (0, resolve_1.normalizeId)(id);
            delete this.schemas[id];
            delete this.refs[id];
          }
          return this;
        }
        default:
          throw new Error("ajv.removeSchema: invalid parameter");
      }
    }
    addVocabulary(definitions) {
      for (const def of definitions) this.addKeyword(def);
      return this;
    }
    addKeyword(kwdOrDef, def) {
      let keyword;
      if (typeof kwdOrDef == "string") {
        keyword = kwdOrDef;
        if (typeof def == "object") {
          this.logger.warn("these parameters are deprecated, see docs for addKeyword");
          def.keyword = keyword;
        }
      } else if (typeof kwdOrDef == "object" && def === void 0) {
        def = kwdOrDef;
        keyword = def.keyword;
        if (Array.isArray(keyword) && !keyword.length) throw new Error("addKeywords: keyword must be string or non-empty array");
      } else throw new Error("invalid addKeywords parameters");
      checkKeyword.call(this, keyword, def);
      if (!def) {
        (0, util_1.eachItem)(keyword, (kwd) => addRule.call(this, kwd));
        return this;
      }
      keywordMetaschema.call(this, def);
      const definition = {
        ...def,
        type: (0, dataType_1.getJSONTypes)(def.type),
        schemaType: (0, dataType_1.getJSONTypes)(def.schemaType)
      };
      (0, util_1.eachItem)(keyword, definition.type.length === 0 ? (k) => addRule.call(this, k, definition) : (k) => definition.type.forEach((t) => addRule.call(this, k, definition, t)));
      return this;
    }
    getKeyword(keyword) {
      const rule = this.RULES.all[keyword];
      return typeof rule == "object" ? rule.definition : !!rule;
    }
    removeKeyword(keyword) {
      const { RULES } = this;
      delete RULES.keywords[keyword];
      delete RULES.all[keyword];
      for (const group of RULES.rules) {
        const i = group.rules.findIndex((rule) => rule.keyword === keyword);
        if (i >= 0) group.rules.splice(i, 1);
      }
      return this;
    }
    addFormat(name, format) {
      if (typeof format == "string") format = new RegExp(format);
      this.formats[name] = format;
      return this;
    }
    errorsText(errors = this.errors, { separator = ", ", dataVar = "data" } = {}) {
      if (!errors || errors.length === 0) return "No errors";
      return errors.map((e) => `${dataVar}${e.instancePath} ${e.message}`).reduce((text, msg) => text + separator + msg);
    }
    $dataMetaSchema(metaSchema, keywordsJsonPointers) {
      const rules = this.RULES.all;
      metaSchema = JSON.parse(JSON.stringify(metaSchema));
      for (const jsonPointer of keywordsJsonPointers) {
        const segments = jsonPointer.split("/").slice(1);
        let keywords = metaSchema;
        for (const seg of segments) keywords = keywords[seg];
        for (const key in rules) {
          const rule = rules[key];
          if (typeof rule != "object") continue;
          const { $data } = rule.definition;
          const schema = keywords[key];
          if ($data && schema) keywords[key] = schemaOrData(schema);
        }
      }
      return metaSchema;
    }
    _removeAllSchemas(schemas, regex) {
      for (const keyRef in schemas) {
        const sch = schemas[keyRef];
        if (!regex || regex.test(keyRef)) {
          if (typeof sch == "string") delete schemas[keyRef];
          else if (sch && !sch.meta) {
            this._cache.delete(sch.schema);
            delete schemas[keyRef];
          }
        }
      }
    }
    _addSchema(schema, meta, baseId, validateSchema = this.opts.validateSchema, addSchema = this.opts.addUsedSchema) {
      let id;
      const { schemaId } = this.opts;
      if (typeof schema == "object") id = schema[schemaId];
      else if (this.opts.jtd) throw new Error("schema must be object");
      else if (typeof schema != "boolean") throw new Error("schema must be object or boolean");
      let sch = this._cache.get(schema);
      if (sch !== void 0) return sch;
      baseId = (0, resolve_1.normalizeId)(id || baseId);
      const localRefs = resolve_1.getSchemaRefs.call(this, schema, baseId);
      sch = new compile_1.SchemaEnv({
        schema,
        schemaId,
        meta,
        baseId,
        localRefs
      });
      this._cache.set(sch.schema, sch);
      if (addSchema && !baseId.startsWith("#")) {
        if (baseId) this._checkUnique(baseId);
        this.refs[baseId] = sch;
      }
      if (validateSchema) this.validateSchema(schema, true);
      return sch;
    }
    _checkUnique(id) {
      if (this.schemas[id] || this.refs[id]) throw new Error(`schema with key or id "${id}" already exists`);
    }
    _compileSchemaEnv(sch) {
      if (sch.meta) this._compileMetaSchema(sch);
      else compile_1.compileSchema.call(this, sch);
      if (!sch.validate) throw new Error("ajv implementation error");
      return sch.validate;
    }
    _compileMetaSchema(sch) {
      const currentOpts = this.opts;
      this.opts = this._metaOpts;
      try {
        compile_1.compileSchema.call(this, sch);
      } finally {
        this.opts = currentOpts;
      }
    }
  };
  Ajv2.ValidationError = validation_error_1.default;
  Ajv2.MissingRefError = ref_error_1.default;
  exports.default = Ajv2;
  function checkOptions(checkOpts, options, msg, log = "error") {
    for (const key in checkOpts) {
      const opt = key;
      if (opt in options) this.logger[log](`${msg}: option ${key}. ${checkOpts[opt]}`);
    }
  }
  function getSchEnv(keyRef) {
    keyRef = (0, resolve_1.normalizeId)(keyRef);
    return this.schemas[keyRef] || this.refs[keyRef];
  }
  function addInitialSchemas() {
    const optsSchemas = this.opts.schemas;
    if (!optsSchemas) return;
    if (Array.isArray(optsSchemas)) this.addSchema(optsSchemas);
    else for (const key in optsSchemas) this.addSchema(optsSchemas[key], key);
  }
  function addInitialFormats() {
    for (const name in this.opts.formats) {
      const format = this.opts.formats[name];
      if (format) this.addFormat(name, format);
    }
  }
  function addInitialKeywords(defs) {
    if (Array.isArray(defs)) {
      this.addVocabulary(defs);
      return;
    }
    this.logger.warn("keywords option as map is deprecated, pass array");
    for (const keyword in defs) {
      const def = defs[keyword];
      if (!def.keyword) def.keyword = keyword;
      this.addKeyword(def);
    }
  }
  function getMetaSchemaOptions() {
    const metaOpts = { ...this.opts };
    for (const opt of META_IGNORE_OPTIONS) delete metaOpts[opt];
    return metaOpts;
  }
  const noLogs = {
    log() {
    },
    warn() {
    },
    error() {
    }
  };
  function getLogger(logger) {
    if (logger === false) return noLogs;
    if (logger === void 0) return console;
    if (logger.log && logger.warn && logger.error) return logger;
    throw new Error("logger must implement log, warn and error methods");
  }
  const KEYWORD_NAME = /^[a-z_$][a-z0-9_$:-]*$/i;
  function checkKeyword(keyword, def) {
    const { RULES } = this;
    (0, util_1.eachItem)(keyword, (kwd) => {
      if (RULES.keywords[kwd]) throw new Error(`Keyword ${kwd} is already defined`);
      if (!KEYWORD_NAME.test(kwd)) throw new Error(`Keyword ${kwd} has invalid name`);
    });
    if (!def) return;
    if (def.$data && !("code" in def || "validate" in def)) throw new Error('$data keyword must have "code" or "validate" function');
  }
  function addRule(keyword, definition, dataType) {
    var _a;
    const post = definition === null || definition === void 0 ? void 0 : definition.post;
    if (dataType && post) throw new Error('keyword with "post" flag cannot have "type"');
    const { RULES } = this;
    let ruleGroup = post ? RULES.post : RULES.rules.find(({ type: t }) => t === dataType);
    if (!ruleGroup) {
      ruleGroup = {
        type: dataType,
        rules: []
      };
      RULES.rules.push(ruleGroup);
    }
    RULES.keywords[keyword] = true;
    if (!definition) return;
    const rule = {
      keyword,
      definition: {
        ...definition,
        type: (0, dataType_1.getJSONTypes)(definition.type),
        schemaType: (0, dataType_1.getJSONTypes)(definition.schemaType)
      }
    };
    if (definition.before) addBeforeRule.call(this, ruleGroup, rule, definition.before);
    else ruleGroup.rules.push(rule);
    RULES.all[keyword] = rule;
    (_a = definition.implements) === null || _a === void 0 || _a.forEach((kwd) => this.addKeyword(kwd));
  }
  function addBeforeRule(ruleGroup, rule, before) {
    const i = ruleGroup.rules.findIndex((_rule) => _rule.keyword === before);
    if (i >= 0) ruleGroup.rules.splice(i, 0, rule);
    else {
      ruleGroup.rules.push(rule);
      this.logger.warn(`rule ${before} is not defined`);
    }
  }
  function keywordMetaschema(def) {
    let { metaSchema } = def;
    if (metaSchema === void 0) return;
    if (def.$data && this.opts.$data) metaSchema = schemaOrData(metaSchema);
    def.validateSchema = this.compile(metaSchema, true);
  }
  const $dataRef = { $ref: "https://raw.githubusercontent.com/ajv-validator/ajv/master/lib/refs/data.json#" };
  function schemaOrData(schema) {
    return { anyOf: [schema, $dataRef] };
  }
});
var require_id = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const def = {
    keyword: "id",
    code() {
      throw new Error('NOT SUPPORTED: keyword "id", use "$id" for schema ID');
    }
  };
  exports.default = def;
});
var require_ref = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.callRef = exports.getValidate = void 0;
  const ref_error_1 = require_ref_error();
  const code_1 = require_code();
  const codegen_1 = require_codegen();
  const names_1 = require_names();
  const compile_1 = require_compile();
  const util_1 = require_util();
  const def = {
    keyword: "$ref",
    schemaType: "string",
    code(cxt) {
      const { gen, schema: $ref, it } = cxt;
      const { baseId, schemaEnv: env, validateName, opts, self } = it;
      const { root } = env;
      if (($ref === "#" || $ref === "#/") && baseId === root.baseId) return callRootRef();
      const schOrEnv = compile_1.resolveRef.call(self, root, baseId, $ref);
      if (schOrEnv === void 0) throw new ref_error_1.default(it.opts.uriResolver, baseId, $ref);
      if (schOrEnv instanceof compile_1.SchemaEnv) return callValidate(schOrEnv);
      return inlineRefSchema(schOrEnv);
      function callRootRef() {
        if (env === root) return callRef(cxt, validateName, env, env.$async);
        const rootName = gen.scopeValue("root", { ref: root });
        return callRef(cxt, (0, codegen_1._)`${rootName}.validate`, root, root.$async);
      }
      function callValidate(sch) {
        callRef(cxt, getValidate(cxt, sch), sch, sch.$async);
      }
      function inlineRefSchema(sch) {
        const schName = gen.scopeValue("schema", opts.code.source === true ? {
          ref: sch,
          code: (0, codegen_1.stringify)(sch)
        } : { ref: sch });
        const valid = gen.name("valid");
        const schCxt = cxt.subschema({
          schema: sch,
          dataTypes: [],
          schemaPath: codegen_1.nil,
          topSchemaRef: schName,
          errSchemaPath: $ref
        }, valid);
        cxt.mergeEvaluated(schCxt);
        cxt.ok(valid);
      }
    }
  };
  function getValidate(cxt, sch) {
    const { gen } = cxt;
    return sch.validate ? gen.scopeValue("validate", { ref: sch.validate }) : (0, codegen_1._)`${gen.scopeValue("wrapper", { ref: sch })}.validate`;
  }
  exports.getValidate = getValidate;
  function callRef(cxt, v, sch, $async) {
    const { gen, it } = cxt;
    const { allErrors, schemaEnv: env, opts } = it;
    const passCxt = opts.passContext ? names_1.default.this : codegen_1.nil;
    if ($async) callAsyncRef();
    else callSyncRef();
    function callAsyncRef() {
      if (!env.$async) throw new Error("async schema referenced by sync schema");
      const valid = gen.let("valid");
      gen.try(() => {
        gen.code((0, codegen_1._)`await ${(0, code_1.callValidateCode)(cxt, v, passCxt)}`);
        addEvaluatedFrom(v);
        if (!allErrors) gen.assign(valid, true);
      }, (e) => {
        gen.if((0, codegen_1._)`!(${e} instanceof ${it.ValidationError})`, () => gen.throw(e));
        addErrorsFrom(e);
        if (!allErrors) gen.assign(valid, false);
      });
      cxt.ok(valid);
    }
    function callSyncRef() {
      cxt.result((0, code_1.callValidateCode)(cxt, v, passCxt), () => addEvaluatedFrom(v), () => addErrorsFrom(v));
    }
    function addErrorsFrom(source) {
      const errs = (0, codegen_1._)`${source}.errors`;
      gen.assign(names_1.default.vErrors, (0, codegen_1._)`${names_1.default.vErrors} === null ? ${errs} : ${names_1.default.vErrors}.concat(${errs})`);
      gen.assign(names_1.default.errors, (0, codegen_1._)`${names_1.default.vErrors}.length`);
    }
    function addEvaluatedFrom(source) {
      var _a;
      if (!it.opts.unevaluated) return;
      const schEvaluated = (_a = sch === null || sch === void 0 ? void 0 : sch.validate) === null || _a === void 0 ? void 0 : _a.evaluated;
      if (it.props !== true) if (schEvaluated && !schEvaluated.dynamicProps) {
        if (schEvaluated.props !== void 0) it.props = util_1.mergeEvaluated.props(gen, schEvaluated.props, it.props);
      } else {
        const props = gen.var("props", (0, codegen_1._)`${source}.evaluated.props`);
        it.props = util_1.mergeEvaluated.props(gen, props, it.props, codegen_1.Name);
      }
      if (it.items !== true) if (schEvaluated && !schEvaluated.dynamicItems) {
        if (schEvaluated.items !== void 0) it.items = util_1.mergeEvaluated.items(gen, schEvaluated.items, it.items);
      } else {
        const items = gen.var("items", (0, codegen_1._)`${source}.evaluated.items`);
        it.items = util_1.mergeEvaluated.items(gen, items, it.items, codegen_1.Name);
      }
    }
  }
  exports.callRef = callRef;
  exports.default = def;
});
var require_core$2 = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const id_1 = require_id();
  const ref_1 = require_ref();
  const core = [
    "$schema",
    "$id",
    "$defs",
    "$vocabulary",
    { keyword: "$comment" },
    "definitions",
    id_1.default,
    ref_1.default
  ];
  exports.default = core;
});
var require_limitNumber = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const codegen_1 = require_codegen();
  const ops = codegen_1.operators;
  const KWDs = {
    maximum: {
      okStr: "<=",
      ok: ops.LTE,
      fail: ops.GT
    },
    minimum: {
      okStr: ">=",
      ok: ops.GTE,
      fail: ops.LT
    },
    exclusiveMaximum: {
      okStr: "<",
      ok: ops.LT,
      fail: ops.GTE
    },
    exclusiveMinimum: {
      okStr: ">",
      ok: ops.GT,
      fail: ops.LTE
    }
  };
  const def = {
    keyword: Object.keys(KWDs),
    type: "number",
    schemaType: "number",
    $data: true,
    error: {
      message: ({ keyword, schemaCode }) => (0, codegen_1.str)`must be ${KWDs[keyword].okStr} ${schemaCode}`,
      params: ({ keyword, schemaCode }) => (0, codegen_1._)`{comparison: ${KWDs[keyword].okStr}, limit: ${schemaCode}}`
    },
    code(cxt) {
      const { keyword, data, schemaCode } = cxt;
      cxt.fail$data((0, codegen_1._)`${data} ${KWDs[keyword].fail} ${schemaCode} || isNaN(${data})`);
    }
  };
  exports.default = def;
});
var require_multipleOf = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const codegen_1 = require_codegen();
  const def = {
    keyword: "multipleOf",
    type: "number",
    schemaType: "number",
    $data: true,
    error: {
      message: ({ schemaCode }) => (0, codegen_1.str)`must be multiple of ${schemaCode}`,
      params: ({ schemaCode }) => (0, codegen_1._)`{multipleOf: ${schemaCode}}`
    },
    code(cxt) {
      const { gen, data, schemaCode, it } = cxt;
      const prec = it.opts.multipleOfPrecision;
      const res = gen.let("res");
      const invalid = prec ? (0, codegen_1._)`Math.abs(Math.round(${res}) - ${res}) > 1e-${prec}` : (0, codegen_1._)`${res} !== parseInt(${res})`;
      cxt.fail$data((0, codegen_1._)`(${schemaCode} === 0 || (${res} = ${data}/${schemaCode}, ${invalid}))`);
    }
  };
  exports.default = def;
});
var require_ucs2length = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  function ucs2length(str) {
    const len = str.length;
    let length = 0;
    let pos = 0;
    let value;
    while (pos < len) {
      length++;
      value = str.charCodeAt(pos++);
      if (value >= 55296 && value <= 56319 && pos < len) {
        value = str.charCodeAt(pos);
        if ((value & 64512) === 56320) pos++;
      }
    }
    return length;
  }
  exports.default = ucs2length;
  ucs2length.code = 'require("ajv/dist/runtime/ucs2length").default';
});
var require_limitLength = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const codegen_1 = require_codegen();
  const util_1 = require_util();
  const ucs2length_1 = require_ucs2length();
  const def = {
    keyword: ["maxLength", "minLength"],
    type: "string",
    schemaType: "number",
    $data: true,
    error: {
      message({ keyword, schemaCode }) {
        const comp = keyword === "maxLength" ? "more" : "fewer";
        return (0, codegen_1.str)`must NOT have ${comp} than ${schemaCode} characters`;
      },
      params: ({ schemaCode }) => (0, codegen_1._)`{limit: ${schemaCode}}`
    },
    code(cxt) {
      const { keyword, data, schemaCode, it } = cxt;
      const op = keyword === "maxLength" ? codegen_1.operators.GT : codegen_1.operators.LT;
      const len = it.opts.unicode === false ? (0, codegen_1._)`${data}.length` : (0, codegen_1._)`${(0, util_1.useFunc)(cxt.gen, ucs2length_1.default)}(${data})`;
      cxt.fail$data((0, codegen_1._)`${len} ${op} ${schemaCode}`);
    }
  };
  exports.default = def;
});
var require_pattern = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const code_1 = require_code();
  const util_1 = require_util();
  const codegen_1 = require_codegen();
  const def = {
    keyword: "pattern",
    type: "string",
    schemaType: "string",
    $data: true,
    error: {
      message: ({ schemaCode }) => (0, codegen_1.str)`must match pattern "${schemaCode}"`,
      params: ({ schemaCode }) => (0, codegen_1._)`{pattern: ${schemaCode}}`
    },
    code(cxt) {
      const { gen, data, $data, schema, schemaCode, it } = cxt;
      const u = it.opts.unicodeRegExp ? "u" : "";
      if ($data) {
        const { regExp } = it.opts.code;
        const regExpCode = regExp.code === "new RegExp" ? (0, codegen_1._)`new RegExp` : (0, util_1.useFunc)(gen, regExp);
        const valid = gen.let("valid");
        gen.try(() => gen.assign(valid, (0, codegen_1._)`${regExpCode}(${schemaCode}, ${u}).test(${data})`), () => gen.assign(valid, false));
        cxt.fail$data((0, codegen_1._)`!${valid}`);
      } else {
        const regExp = (0, code_1.usePattern)(cxt, schema);
        cxt.fail$data((0, codegen_1._)`!${regExp}.test(${data})`);
      }
    }
  };
  exports.default = def;
});
var require_limitProperties = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const codegen_1 = require_codegen();
  const def = {
    keyword: ["maxProperties", "minProperties"],
    type: "object",
    schemaType: "number",
    $data: true,
    error: {
      message({ keyword, schemaCode }) {
        const comp = keyword === "maxProperties" ? "more" : "fewer";
        return (0, codegen_1.str)`must NOT have ${comp} than ${schemaCode} properties`;
      },
      params: ({ schemaCode }) => (0, codegen_1._)`{limit: ${schemaCode}}`
    },
    code(cxt) {
      const { keyword, data, schemaCode } = cxt;
      const op = keyword === "maxProperties" ? codegen_1.operators.GT : codegen_1.operators.LT;
      cxt.fail$data((0, codegen_1._)`Object.keys(${data}).length ${op} ${schemaCode}`);
    }
  };
  exports.default = def;
});
var require_required = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const code_1 = require_code();
  const codegen_1 = require_codegen();
  const util_1 = require_util();
  const def = {
    keyword: "required",
    type: "object",
    schemaType: "array",
    $data: true,
    error: {
      message: ({ params: { missingProperty } }) => (0, codegen_1.str)`must have required property '${missingProperty}'`,
      params: ({ params: { missingProperty } }) => (0, codegen_1._)`{missingProperty: ${missingProperty}}`
    },
    code(cxt) {
      const { gen, schema, schemaCode, data, $data, it } = cxt;
      const { opts } = it;
      if (!$data && schema.length === 0) return;
      const useLoop = schema.length >= opts.loopRequired;
      if (it.allErrors) allErrorsMode();
      else exitOnErrorMode();
      if (opts.strictRequired) {
        const props = cxt.parentSchema.properties;
        const { definedProperties } = cxt.it;
        for (const requiredKey of schema) if ((props === null || props === void 0 ? void 0 : props[requiredKey]) === void 0 && !definedProperties.has(requiredKey)) {
          const msg = `required property "${requiredKey}" is not defined at "${it.schemaEnv.baseId + it.errSchemaPath}" (strictRequired)`;
          (0, util_1.checkStrictMode)(it, msg, it.opts.strictRequired);
        }
      }
      function allErrorsMode() {
        if (useLoop || $data) cxt.block$data(codegen_1.nil, loopAllRequired);
        else for (const prop of schema) (0, code_1.checkReportMissingProp)(cxt, prop);
      }
      function exitOnErrorMode() {
        const missing = gen.let("missing");
        if (useLoop || $data) {
          const valid = gen.let("valid", true);
          cxt.block$data(valid, () => loopUntilMissing(missing, valid));
          cxt.ok(valid);
        } else {
          gen.if((0, code_1.checkMissingProp)(cxt, schema, missing));
          (0, code_1.reportMissingProp)(cxt, missing);
          gen.else();
        }
      }
      function loopAllRequired() {
        gen.forOf("prop", schemaCode, (prop) => {
          cxt.setParams({ missingProperty: prop });
          gen.if((0, code_1.noPropertyInData)(gen, data, prop, opts.ownProperties), () => cxt.error());
        });
      }
      function loopUntilMissing(missing, valid) {
        cxt.setParams({ missingProperty: missing });
        gen.forOf(missing, schemaCode, () => {
          gen.assign(valid, (0, code_1.propertyInData)(gen, data, missing, opts.ownProperties));
          gen.if((0, codegen_1.not)(valid), () => {
            cxt.error();
            gen.break();
          });
        }, codegen_1.nil);
      }
    }
  };
  exports.default = def;
});
var require_limitItems = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const codegen_1 = require_codegen();
  const def = {
    keyword: ["maxItems", "minItems"],
    type: "array",
    schemaType: "number",
    $data: true,
    error: {
      message({ keyword, schemaCode }) {
        const comp = keyword === "maxItems" ? "more" : "fewer";
        return (0, codegen_1.str)`must NOT have ${comp} than ${schemaCode} items`;
      },
      params: ({ schemaCode }) => (0, codegen_1._)`{limit: ${schemaCode}}`
    },
    code(cxt) {
      const { keyword, data, schemaCode } = cxt;
      const op = keyword === "maxItems" ? codegen_1.operators.GT : codegen_1.operators.LT;
      cxt.fail$data((0, codegen_1._)`${data}.length ${op} ${schemaCode}`);
    }
  };
  exports.default = def;
});
var require_equal = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const equal = require_fast_deep_equal();
  equal.code = 'require("ajv/dist/runtime/equal").default';
  exports.default = equal;
});
var require_uniqueItems = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const dataType_1 = require_dataType();
  const codegen_1 = require_codegen();
  const util_1 = require_util();
  const equal_1 = require_equal();
  const def = {
    keyword: "uniqueItems",
    type: "array",
    schemaType: "boolean",
    $data: true,
    error: {
      message: ({ params: { i, j } }) => (0, codegen_1.str)`must NOT have duplicate items (items ## ${j} and ${i} are identical)`,
      params: ({ params: { i, j } }) => (0, codegen_1._)`{i: ${i}, j: ${j}}`
    },
    code(cxt) {
      const { gen, data, $data, schema, parentSchema, schemaCode, it } = cxt;
      if (!$data && !schema) return;
      const valid = gen.let("valid");
      const itemTypes = parentSchema.items ? (0, dataType_1.getSchemaTypes)(parentSchema.items) : [];
      cxt.block$data(valid, validateUniqueItems, (0, codegen_1._)`${schemaCode} === false`);
      cxt.ok(valid);
      function validateUniqueItems() {
        const i = gen.let("i", (0, codegen_1._)`${data}.length`);
        const j = gen.let("j");
        cxt.setParams({
          i,
          j
        });
        gen.assign(valid, true);
        gen.if((0, codegen_1._)`${i} > 1`, () => (canOptimize() ? loopN : loopN2)(i, j));
      }
      function canOptimize() {
        return itemTypes.length > 0 && !itemTypes.some((t) => t === "object" || t === "array");
      }
      function loopN(i, j) {
        const item = gen.name("item");
        const wrongType = (0, dataType_1.checkDataTypes)(itemTypes, item, it.opts.strictNumbers, dataType_1.DataType.Wrong);
        const indices = gen.const("indices", (0, codegen_1._)`{}`);
        gen.for((0, codegen_1._)`;${i}--;`, () => {
          gen.let(item, (0, codegen_1._)`${data}[${i}]`);
          gen.if(wrongType, (0, codegen_1._)`continue`);
          if (itemTypes.length > 1) gen.if((0, codegen_1._)`typeof ${item} == "string"`, (0, codegen_1._)`${item} += "_"`);
          gen.if((0, codegen_1._)`typeof ${indices}[${item}] == "number"`, () => {
            gen.assign(j, (0, codegen_1._)`${indices}[${item}]`);
            cxt.error();
            gen.assign(valid, false).break();
          }).code((0, codegen_1._)`${indices}[${item}] = ${i}`);
        });
      }
      function loopN2(i, j) {
        const eql = (0, util_1.useFunc)(gen, equal_1.default);
        const outer = gen.name("outer");
        gen.label(outer).for((0, codegen_1._)`;${i}--;`, () => gen.for((0, codegen_1._)`${j} = ${i}; ${j}--;`, () => gen.if((0, codegen_1._)`${eql}(${data}[${i}], ${data}[${j}])`, () => {
          cxt.error();
          gen.assign(valid, false).break(outer);
        })));
      }
    }
  };
  exports.default = def;
});
var require_const = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const codegen_1 = require_codegen();
  const util_1 = require_util();
  const equal_1 = require_equal();
  const def = {
    keyword: "const",
    $data: true,
    error: {
      message: "must be equal to constant",
      params: ({ schemaCode }) => (0, codegen_1._)`{allowedValue: ${schemaCode}}`
    },
    code(cxt) {
      const { gen, data, $data, schemaCode, schema } = cxt;
      if ($data || schema && typeof schema == "object") cxt.fail$data((0, codegen_1._)`!${(0, util_1.useFunc)(gen, equal_1.default)}(${data}, ${schemaCode})`);
      else cxt.fail((0, codegen_1._)`${schema} !== ${data}`);
    }
  };
  exports.default = def;
});
var require_enum = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const codegen_1 = require_codegen();
  const util_1 = require_util();
  const equal_1 = require_equal();
  const def = {
    keyword: "enum",
    schemaType: "array",
    $data: true,
    error: {
      message: "must be equal to one of the allowed values",
      params: ({ schemaCode }) => (0, codegen_1._)`{allowedValues: ${schemaCode}}`
    },
    code(cxt) {
      const { gen, data, $data, schema, schemaCode, it } = cxt;
      if (!$data && schema.length === 0) throw new Error("enum must have non-empty array");
      const useLoop = schema.length >= it.opts.loopEnum;
      let eql;
      const getEql = () => eql !== null && eql !== void 0 ? eql : eql = (0, util_1.useFunc)(gen, equal_1.default);
      let valid;
      if (useLoop || $data) {
        valid = gen.let("valid");
        cxt.block$data(valid, loopEnum);
      } else {
        if (!Array.isArray(schema)) throw new Error("ajv implementation error");
        const vSchema = gen.const("vSchema", schemaCode);
        valid = (0, codegen_1.or)(...schema.map((_x, i) => equalCode(vSchema, i)));
      }
      cxt.pass(valid);
      function loopEnum() {
        gen.assign(valid, false);
        gen.forOf("v", schemaCode, (v) => gen.if((0, codegen_1._)`${getEql()}(${data}, ${v})`, () => gen.assign(valid, true).break()));
      }
      function equalCode(vSchema, i) {
        const sch = schema[i];
        return typeof sch === "object" && sch !== null ? (0, codegen_1._)`${getEql()}(${data}, ${vSchema}[${i}])` : (0, codegen_1._)`${data} === ${sch}`;
      }
    }
  };
  exports.default = def;
});
var require_validation$2 = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const limitNumber_1 = require_limitNumber();
  const multipleOf_1 = require_multipleOf();
  const limitLength_1 = require_limitLength();
  const pattern_1 = require_pattern();
  const limitProperties_1 = require_limitProperties();
  const required_1 = require_required();
  const limitItems_1 = require_limitItems();
  const uniqueItems_1 = require_uniqueItems();
  const const_1 = require_const();
  const enum_1 = require_enum();
  const validation = [
    limitNumber_1.default,
    multipleOf_1.default,
    limitLength_1.default,
    pattern_1.default,
    limitProperties_1.default,
    required_1.default,
    limitItems_1.default,
    uniqueItems_1.default,
    {
      keyword: "type",
      schemaType: ["string", "array"]
    },
    {
      keyword: "nullable",
      schemaType: "boolean"
    },
    const_1.default,
    enum_1.default
  ];
  exports.default = validation;
});
var require_additionalItems = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.validateAdditionalItems = void 0;
  const codegen_1 = require_codegen();
  const util_1 = require_util();
  const def = {
    keyword: "additionalItems",
    type: "array",
    schemaType: ["boolean", "object"],
    before: "uniqueItems",
    error: {
      message: ({ params: { len } }) => (0, codegen_1.str)`must NOT have more than ${len} items`,
      params: ({ params: { len } }) => (0, codegen_1._)`{limit: ${len}}`
    },
    code(cxt) {
      const { parentSchema, it } = cxt;
      const { items } = parentSchema;
      if (!Array.isArray(items)) {
        (0, util_1.checkStrictMode)(it, '"additionalItems" is ignored when "items" is not an array of schemas');
        return;
      }
      validateAdditionalItems(cxt, items);
    }
  };
  function validateAdditionalItems(cxt, items) {
    const { gen, schema, data, keyword, it } = cxt;
    it.items = true;
    const len = gen.const("len", (0, codegen_1._)`${data}.length`);
    if (schema === false) {
      cxt.setParams({ len: items.length });
      cxt.pass((0, codegen_1._)`${len} <= ${items.length}`);
    } else if (typeof schema == "object" && !(0, util_1.alwaysValidSchema)(it, schema)) {
      const valid = gen.var("valid", (0, codegen_1._)`${len} <= ${items.length}`);
      gen.if((0, codegen_1.not)(valid), () => validateItems(valid));
      cxt.ok(valid);
    }
    function validateItems(valid) {
      gen.forRange("i", items.length, len, (i) => {
        cxt.subschema({
          keyword,
          dataProp: i,
          dataPropType: util_1.Type.Num
        }, valid);
        if (!it.allErrors) gen.if((0, codegen_1.not)(valid), () => gen.break());
      });
    }
  }
  exports.validateAdditionalItems = validateAdditionalItems;
  exports.default = def;
});
var require_items = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.validateTuple = void 0;
  const codegen_1 = require_codegen();
  const util_1 = require_util();
  const code_1 = require_code();
  const def = {
    keyword: "items",
    type: "array",
    schemaType: [
      "object",
      "array",
      "boolean"
    ],
    before: "uniqueItems",
    code(cxt) {
      const { schema, it } = cxt;
      if (Array.isArray(schema)) return validateTuple(cxt, "additionalItems", schema);
      it.items = true;
      if ((0, util_1.alwaysValidSchema)(it, schema)) return;
      cxt.ok((0, code_1.validateArray)(cxt));
    }
  };
  function validateTuple(cxt, extraItems, schArr = cxt.schema) {
    const { gen, parentSchema, data, keyword, it } = cxt;
    checkStrictTuple(parentSchema);
    if (it.opts.unevaluated && schArr.length && it.items !== true) it.items = util_1.mergeEvaluated.items(gen, schArr.length, it.items);
    const valid = gen.name("valid");
    const len = gen.const("len", (0, codegen_1._)`${data}.length`);
    schArr.forEach((sch, i) => {
      if ((0, util_1.alwaysValidSchema)(it, sch)) return;
      gen.if((0, codegen_1._)`${len} > ${i}`, () => cxt.subschema({
        keyword,
        schemaProp: i,
        dataProp: i
      }, valid));
      cxt.ok(valid);
    });
    function checkStrictTuple(sch) {
      const { opts, errSchemaPath } = it;
      const l = schArr.length;
      const fullTuple = l === sch.minItems && (l === sch.maxItems || sch[extraItems] === false);
      if (opts.strictTuples && !fullTuple) {
        const msg = `"${keyword}" is ${l}-tuple, but minItems or maxItems/${extraItems} are not specified or different at path "${errSchemaPath}"`;
        (0, util_1.checkStrictMode)(it, msg, opts.strictTuples);
      }
    }
  }
  exports.validateTuple = validateTuple;
  exports.default = def;
});
var require_prefixItems = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const items_1 = require_items();
  const def = {
    keyword: "prefixItems",
    type: "array",
    schemaType: ["array"],
    before: "uniqueItems",
    code: (cxt) => (0, items_1.validateTuple)(cxt, "items")
  };
  exports.default = def;
});
var require_items2020 = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const codegen_1 = require_codegen();
  const util_1 = require_util();
  const code_1 = require_code();
  const additionalItems_1 = require_additionalItems();
  const def = {
    keyword: "items",
    type: "array",
    schemaType: ["object", "boolean"],
    before: "uniqueItems",
    error: {
      message: ({ params: { len } }) => (0, codegen_1.str)`must NOT have more than ${len} items`,
      params: ({ params: { len } }) => (0, codegen_1._)`{limit: ${len}}`
    },
    code(cxt) {
      const { schema, parentSchema, it } = cxt;
      const { prefixItems } = parentSchema;
      it.items = true;
      if ((0, util_1.alwaysValidSchema)(it, schema)) return;
      if (prefixItems) (0, additionalItems_1.validateAdditionalItems)(cxt, prefixItems);
      else cxt.ok((0, code_1.validateArray)(cxt));
    }
  };
  exports.default = def;
});
var require_contains = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const codegen_1 = require_codegen();
  const util_1 = require_util();
  const def = {
    keyword: "contains",
    type: "array",
    schemaType: ["object", "boolean"],
    before: "uniqueItems",
    trackErrors: true,
    error: {
      message: ({ params: { min, max } }) => max === void 0 ? (0, codegen_1.str)`must contain at least ${min} valid item(s)` : (0, codegen_1.str)`must contain at least ${min} and no more than ${max} valid item(s)`,
      params: ({ params: { min, max } }) => max === void 0 ? (0, codegen_1._)`{minContains: ${min}}` : (0, codegen_1._)`{minContains: ${min}, maxContains: ${max}}`
    },
    code(cxt) {
      const { gen, schema, parentSchema, data, it } = cxt;
      let min;
      let max;
      const { minContains, maxContains } = parentSchema;
      if (it.opts.next) {
        min = minContains === void 0 ? 1 : minContains;
        max = maxContains;
      } else min = 1;
      const len = gen.const("len", (0, codegen_1._)`${data}.length`);
      cxt.setParams({
        min,
        max
      });
      if (max === void 0 && min === 0) {
        (0, util_1.checkStrictMode)(it, `"minContains" == 0 without "maxContains": "contains" keyword ignored`);
        return;
      }
      if (max !== void 0 && min > max) {
        (0, util_1.checkStrictMode)(it, `"minContains" > "maxContains" is always invalid`);
        cxt.fail();
        return;
      }
      if ((0, util_1.alwaysValidSchema)(it, schema)) {
        let cond = (0, codegen_1._)`${len} >= ${min}`;
        if (max !== void 0) cond = (0, codegen_1._)`${cond} && ${len} <= ${max}`;
        cxt.pass(cond);
        return;
      }
      it.items = true;
      const valid = gen.name("valid");
      if (max === void 0 && min === 1) validateItems(valid, () => gen.if(valid, () => gen.break()));
      else if (min === 0) {
        gen.let(valid, true);
        if (max !== void 0) gen.if((0, codegen_1._)`${data}.length > 0`, validateItemsWithCount);
      } else {
        gen.let(valid, false);
        validateItemsWithCount();
      }
      cxt.result(valid, () => cxt.reset());
      function validateItemsWithCount() {
        const schValid = gen.name("_valid");
        const count = gen.let("count", 0);
        validateItems(schValid, () => gen.if(schValid, () => checkLimits(count)));
      }
      function validateItems(_valid, block) {
        gen.forRange("i", 0, len, (i) => {
          cxt.subschema({
            keyword: "contains",
            dataProp: i,
            dataPropType: util_1.Type.Num,
            compositeRule: true
          }, _valid);
          block();
        });
      }
      function checkLimits(count) {
        gen.code((0, codegen_1._)`${count}++`);
        if (max === void 0) gen.if((0, codegen_1._)`${count} >= ${min}`, () => gen.assign(valid, true).break());
        else {
          gen.if((0, codegen_1._)`${count} > ${max}`, () => gen.assign(valid, false).break());
          if (min === 1) gen.assign(valid, true);
          else gen.if((0, codegen_1._)`${count} >= ${min}`, () => gen.assign(valid, true));
        }
      }
    }
  };
  exports.default = def;
});
var require_dependencies = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.validateSchemaDeps = exports.validatePropertyDeps = exports.error = void 0;
  const codegen_1 = require_codegen();
  const util_1 = require_util();
  const code_1 = require_code();
  exports.error = {
    message: ({ params: { property, depsCount, deps } }) => {
      const property_ies = depsCount === 1 ? "property" : "properties";
      return (0, codegen_1.str)`must have ${property_ies} ${deps} when property ${property} is present`;
    },
    params: ({ params: { property, depsCount, deps, missingProperty } }) => (0, codegen_1._)`{property: ${property},
    missingProperty: ${missingProperty},
    depsCount: ${depsCount},
    deps: ${deps}}`
  };
  const def = {
    keyword: "dependencies",
    type: "object",
    schemaType: "object",
    error: exports.error,
    code(cxt) {
      const [propDeps, schDeps] = splitDependencies(cxt);
      validatePropertyDeps(cxt, propDeps);
      validateSchemaDeps(cxt, schDeps);
    }
  };
  function splitDependencies({ schema }) {
    const propertyDeps = {};
    const schemaDeps = {};
    for (const key in schema) {
      if (key === "__proto__") continue;
      const deps = Array.isArray(schema[key]) ? propertyDeps : schemaDeps;
      deps[key] = schema[key];
    }
    return [propertyDeps, schemaDeps];
  }
  function validatePropertyDeps(cxt, propertyDeps = cxt.schema) {
    const { gen, data, it } = cxt;
    if (Object.keys(propertyDeps).length === 0) return;
    const missing = gen.let("missing");
    for (const prop in propertyDeps) {
      const deps = propertyDeps[prop];
      if (deps.length === 0) continue;
      const hasProperty = (0, code_1.propertyInData)(gen, data, prop, it.opts.ownProperties);
      cxt.setParams({
        property: prop,
        depsCount: deps.length,
        deps: deps.join(", ")
      });
      if (it.allErrors) gen.if(hasProperty, () => {
        for (const depProp of deps) (0, code_1.checkReportMissingProp)(cxt, depProp);
      });
      else {
        gen.if((0, codegen_1._)`${hasProperty} && (${(0, code_1.checkMissingProp)(cxt, deps, missing)})`);
        (0, code_1.reportMissingProp)(cxt, missing);
        gen.else();
      }
    }
  }
  exports.validatePropertyDeps = validatePropertyDeps;
  function validateSchemaDeps(cxt, schemaDeps = cxt.schema) {
    const { gen, data, keyword, it } = cxt;
    const valid = gen.name("valid");
    for (const prop in schemaDeps) {
      if ((0, util_1.alwaysValidSchema)(it, schemaDeps[prop])) continue;
      gen.if((0, code_1.propertyInData)(gen, data, prop, it.opts.ownProperties), () => {
        const schCxt = cxt.subschema({
          keyword,
          schemaProp: prop
        }, valid);
        cxt.mergeValidEvaluated(schCxt, valid);
      }, () => gen.var(valid, true));
      cxt.ok(valid);
    }
  }
  exports.validateSchemaDeps = validateSchemaDeps;
  exports.default = def;
});
var require_propertyNames = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const codegen_1 = require_codegen();
  const util_1 = require_util();
  const def = {
    keyword: "propertyNames",
    type: "object",
    schemaType: ["object", "boolean"],
    error: {
      message: "property name must be valid",
      params: ({ params }) => (0, codegen_1._)`{propertyName: ${params.propertyName}}`
    },
    code(cxt) {
      const { gen, schema, data, it } = cxt;
      if ((0, util_1.alwaysValidSchema)(it, schema)) return;
      const valid = gen.name("valid");
      gen.forIn("key", data, (key) => {
        cxt.setParams({ propertyName: key });
        cxt.subschema({
          keyword: "propertyNames",
          data: key,
          dataTypes: ["string"],
          propertyName: key,
          compositeRule: true
        }, valid);
        gen.if((0, codegen_1.not)(valid), () => {
          cxt.error(true);
          if (!it.allErrors) gen.break();
        });
      });
      cxt.ok(valid);
    }
  };
  exports.default = def;
});
var require_additionalProperties = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const code_1 = require_code();
  const codegen_1 = require_codegen();
  const names_1 = require_names();
  const util_1 = require_util();
  const def = {
    keyword: "additionalProperties",
    type: ["object"],
    schemaType: ["boolean", "object"],
    allowUndefined: true,
    trackErrors: true,
    error: {
      message: "must NOT have additional properties",
      params: ({ params }) => (0, codegen_1._)`{additionalProperty: ${params.additionalProperty}}`
    },
    code(cxt) {
      const { gen, schema, parentSchema, data, errsCount, it } = cxt;
      if (!errsCount) throw new Error("ajv implementation error");
      const { allErrors, opts } = it;
      it.props = true;
      if (opts.removeAdditional !== "all" && (0, util_1.alwaysValidSchema)(it, schema)) return;
      const props = (0, code_1.allSchemaProperties)(parentSchema.properties);
      const patProps = (0, code_1.allSchemaProperties)(parentSchema.patternProperties);
      checkAdditionalProperties();
      cxt.ok((0, codegen_1._)`${errsCount} === ${names_1.default.errors}`);
      function checkAdditionalProperties() {
        gen.forIn("key", data, (key) => {
          if (!props.length && !patProps.length) additionalPropertyCode(key);
          else gen.if(isAdditional(key), () => additionalPropertyCode(key));
        });
      }
      function isAdditional(key) {
        let definedProp;
        if (props.length > 8) {
          const propsSchema = (0, util_1.schemaRefOrVal)(it, parentSchema.properties, "properties");
          definedProp = (0, code_1.isOwnProperty)(gen, propsSchema, key);
        } else if (props.length) definedProp = (0, codegen_1.or)(...props.map((p) => (0, codegen_1._)`${key} === ${p}`));
        else definedProp = codegen_1.nil;
        if (patProps.length) definedProp = (0, codegen_1.or)(definedProp, ...patProps.map((p) => (0, codegen_1._)`${(0, code_1.usePattern)(cxt, p)}.test(${key})`));
        return (0, codegen_1.not)(definedProp);
      }
      function deleteAdditional(key) {
        gen.code((0, codegen_1._)`delete ${data}[${key}]`);
      }
      function additionalPropertyCode(key) {
        if (opts.removeAdditional === "all" || opts.removeAdditional && schema === false) {
          deleteAdditional(key);
          return;
        }
        if (schema === false) {
          cxt.setParams({ additionalProperty: key });
          cxt.error();
          if (!allErrors) gen.break();
          return;
        }
        if (typeof schema == "object" && !(0, util_1.alwaysValidSchema)(it, schema)) {
          const valid = gen.name("valid");
          if (opts.removeAdditional === "failing") {
            applyAdditionalSchema(key, valid, false);
            gen.if((0, codegen_1.not)(valid), () => {
              cxt.reset();
              deleteAdditional(key);
            });
          } else {
            applyAdditionalSchema(key, valid);
            if (!allErrors) gen.if((0, codegen_1.not)(valid), () => gen.break());
          }
        }
      }
      function applyAdditionalSchema(key, valid, errors) {
        const subschema = {
          keyword: "additionalProperties",
          dataProp: key,
          dataPropType: util_1.Type.Str
        };
        if (errors === false) Object.assign(subschema, {
          compositeRule: true,
          createErrors: false,
          allErrors: false
        });
        cxt.subschema(subschema, valid);
      }
    }
  };
  exports.default = def;
});
var require_properties = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const validate_1 = require_validate();
  const code_1 = require_code();
  const util_1 = require_util();
  const additionalProperties_1 = require_additionalProperties();
  const def = {
    keyword: "properties",
    type: "object",
    schemaType: "object",
    code(cxt) {
      const { gen, schema, parentSchema, data, it } = cxt;
      if (it.opts.removeAdditional === "all" && parentSchema.additionalProperties === void 0) additionalProperties_1.default.code(new validate_1.KeywordCxt(it, additionalProperties_1.default, "additionalProperties"));
      const allProps = (0, code_1.allSchemaProperties)(schema);
      for (const prop of allProps) it.definedProperties.add(prop);
      if (it.opts.unevaluated && allProps.length && it.props !== true) it.props = util_1.mergeEvaluated.props(gen, (0, util_1.toHash)(allProps), it.props);
      const properties = allProps.filter((p) => !(0, util_1.alwaysValidSchema)(it, schema[p]));
      if (properties.length === 0) return;
      const valid = gen.name("valid");
      for (const prop of properties) {
        if (hasDefault(prop)) applyPropertySchema(prop);
        else {
          gen.if((0, code_1.propertyInData)(gen, data, prop, it.opts.ownProperties));
          applyPropertySchema(prop);
          if (!it.allErrors) gen.else().var(valid, true);
          gen.endIf();
        }
        cxt.it.definedProperties.add(prop);
        cxt.ok(valid);
      }
      function hasDefault(prop) {
        return it.opts.useDefaults && !it.compositeRule && schema[prop].default !== void 0;
      }
      function applyPropertySchema(prop) {
        cxt.subschema({
          keyword: "properties",
          schemaProp: prop,
          dataProp: prop
        }, valid);
      }
    }
  };
  exports.default = def;
});
var require_patternProperties = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const code_1 = require_code();
  const codegen_1 = require_codegen();
  const util_1 = require_util();
  const util_2 = require_util();
  const def = {
    keyword: "patternProperties",
    type: "object",
    schemaType: "object",
    code(cxt) {
      const { gen, schema, data, parentSchema, it } = cxt;
      const { opts } = it;
      const patterns = (0, code_1.allSchemaProperties)(schema);
      const alwaysValidPatterns = patterns.filter((p) => (0, util_1.alwaysValidSchema)(it, schema[p]));
      if (patterns.length === 0 || alwaysValidPatterns.length === patterns.length && (!it.opts.unevaluated || it.props === true)) return;
      const checkProperties = opts.strictSchema && !opts.allowMatchingProperties && parentSchema.properties;
      const valid = gen.name("valid");
      if (it.props !== true && !(it.props instanceof codegen_1.Name)) it.props = (0, util_2.evaluatedPropsToName)(gen, it.props);
      const { props } = it;
      validatePatternProperties();
      function validatePatternProperties() {
        for (const pat of patterns) {
          if (checkProperties) checkMatchingProperties(pat);
          if (it.allErrors) validateProperties(pat);
          else {
            gen.var(valid, true);
            validateProperties(pat);
            gen.if(valid);
          }
        }
      }
      function checkMatchingProperties(pat) {
        for (const prop in checkProperties) if (new RegExp(pat).test(prop)) (0, util_1.checkStrictMode)(it, `property ${prop} matches pattern ${pat} (use allowMatchingProperties)`);
      }
      function validateProperties(pat) {
        gen.forIn("key", data, (key) => {
          gen.if((0, codegen_1._)`${(0, code_1.usePattern)(cxt, pat)}.test(${key})`, () => {
            const alwaysValid = alwaysValidPatterns.includes(pat);
            if (!alwaysValid) cxt.subschema({
              keyword: "patternProperties",
              schemaProp: pat,
              dataProp: key,
              dataPropType: util_2.Type.Str
            }, valid);
            if (it.opts.unevaluated && props !== true) gen.assign((0, codegen_1._)`${props}[${key}]`, true);
            else if (!alwaysValid && !it.allErrors) gen.if((0, codegen_1.not)(valid), () => gen.break());
          });
        });
      }
    }
  };
  exports.default = def;
});
var require_not = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const util_1 = require_util();
  const def = {
    keyword: "not",
    schemaType: ["object", "boolean"],
    trackErrors: true,
    code(cxt) {
      const { gen, schema, it } = cxt;
      if ((0, util_1.alwaysValidSchema)(it, schema)) {
        cxt.fail();
        return;
      }
      const valid = gen.name("valid");
      cxt.subschema({
        keyword: "not",
        compositeRule: true,
        createErrors: false,
        allErrors: false
      }, valid);
      cxt.failResult(valid, () => cxt.reset(), () => cxt.error());
    },
    error: { message: "must NOT be valid" }
  };
  exports.default = def;
});
var require_anyOf = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const def = {
    keyword: "anyOf",
    schemaType: "array",
    trackErrors: true,
    code: require_code().validateUnion,
    error: { message: "must match a schema in anyOf" }
  };
  exports.default = def;
});
var require_oneOf = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const codegen_1 = require_codegen();
  const util_1 = require_util();
  const def = {
    keyword: "oneOf",
    schemaType: "array",
    trackErrors: true,
    error: {
      message: "must match exactly one schema in oneOf",
      params: ({ params }) => (0, codegen_1._)`{passingSchemas: ${params.passing}}`
    },
    code(cxt) {
      const { gen, schema, parentSchema, it } = cxt;
      if (!Array.isArray(schema)) throw new Error("ajv implementation error");
      if (it.opts.discriminator && parentSchema.discriminator) return;
      const schArr = schema;
      const valid = gen.let("valid", false);
      const passing = gen.let("passing", null);
      const schValid = gen.name("_valid");
      cxt.setParams({ passing });
      gen.block(validateOneOf);
      cxt.result(valid, () => cxt.reset(), () => cxt.error(true));
      function validateOneOf() {
        schArr.forEach((sch, i) => {
          let schCxt;
          if ((0, util_1.alwaysValidSchema)(it, sch)) gen.var(schValid, true);
          else schCxt = cxt.subschema({
            keyword: "oneOf",
            schemaProp: i,
            compositeRule: true
          }, schValid);
          if (i > 0) gen.if((0, codegen_1._)`${schValid} && ${valid}`).assign(valid, false).assign(passing, (0, codegen_1._)`[${passing}, ${i}]`).else();
          gen.if(schValid, () => {
            gen.assign(valid, true);
            gen.assign(passing, i);
            if (schCxt) cxt.mergeEvaluated(schCxt, codegen_1.Name);
          });
        });
      }
    }
  };
  exports.default = def;
});
var require_allOf = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const util_1 = require_util();
  const def = {
    keyword: "allOf",
    schemaType: "array",
    code(cxt) {
      const { gen, schema, it } = cxt;
      if (!Array.isArray(schema)) throw new Error("ajv implementation error");
      const valid = gen.name("valid");
      schema.forEach((sch, i) => {
        if ((0, util_1.alwaysValidSchema)(it, sch)) return;
        const schCxt = cxt.subschema({
          keyword: "allOf",
          schemaProp: i
        }, valid);
        cxt.ok(valid);
        cxt.mergeEvaluated(schCxt);
      });
    }
  };
  exports.default = def;
});
var require_if = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const codegen_1 = require_codegen();
  const util_1 = require_util();
  const def = {
    keyword: "if",
    schemaType: ["object", "boolean"],
    trackErrors: true,
    error: {
      message: ({ params }) => (0, codegen_1.str)`must match "${params.ifClause}" schema`,
      params: ({ params }) => (0, codegen_1._)`{failingKeyword: ${params.ifClause}}`
    },
    code(cxt) {
      const { gen, parentSchema, it } = cxt;
      if (parentSchema.then === void 0 && parentSchema.else === void 0) (0, util_1.checkStrictMode)(it, '"if" without "then" and "else" is ignored');
      const hasThen = hasSchema(it, "then");
      const hasElse = hasSchema(it, "else");
      if (!hasThen && !hasElse) return;
      const valid = gen.let("valid", true);
      const schValid = gen.name("_valid");
      validateIf();
      cxt.reset();
      if (hasThen && hasElse) {
        const ifClause = gen.let("ifClause");
        cxt.setParams({ ifClause });
        gen.if(schValid, validateClause("then", ifClause), validateClause("else", ifClause));
      } else if (hasThen) gen.if(schValid, validateClause("then"));
      else gen.if((0, codegen_1.not)(schValid), validateClause("else"));
      cxt.pass(valid, () => cxt.error(true));
      function validateIf() {
        const schCxt = cxt.subschema({
          keyword: "if",
          compositeRule: true,
          createErrors: false,
          allErrors: false
        }, schValid);
        cxt.mergeEvaluated(schCxt);
      }
      function validateClause(keyword, ifClause) {
        return () => {
          const schCxt = cxt.subschema({ keyword }, schValid);
          gen.assign(valid, schValid);
          cxt.mergeValidEvaluated(schCxt, valid);
          if (ifClause) gen.assign(ifClause, (0, codegen_1._)`${keyword}`);
          else cxt.setParams({ ifClause: keyword });
        };
      }
    }
  };
  function hasSchema(it, keyword) {
    const schema = it.schema[keyword];
    return schema !== void 0 && !(0, util_1.alwaysValidSchema)(it, schema);
  }
  exports.default = def;
});
var require_thenElse = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const util_1 = require_util();
  const def = {
    keyword: ["then", "else"],
    schemaType: ["object", "boolean"],
    code({ keyword, parentSchema, it }) {
      if (parentSchema.if === void 0) (0, util_1.checkStrictMode)(it, `"${keyword}" without "if" is ignored`);
    }
  };
  exports.default = def;
});
var require_applicator$2 = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const additionalItems_1 = require_additionalItems();
  const prefixItems_1 = require_prefixItems();
  const items_1 = require_items();
  const items2020_1 = require_items2020();
  const contains_1 = require_contains();
  const dependencies_1 = require_dependencies();
  const propertyNames_1 = require_propertyNames();
  const additionalProperties_1 = require_additionalProperties();
  const properties_1 = require_properties();
  const patternProperties_1 = require_patternProperties();
  const not_1 = require_not();
  const anyOf_1 = require_anyOf();
  const oneOf_1 = require_oneOf();
  const allOf_1 = require_allOf();
  const if_1 = require_if();
  const thenElse_1 = require_thenElse();
  function getApplicator(draft2020 = false) {
    const applicator = [
      not_1.default,
      anyOf_1.default,
      oneOf_1.default,
      allOf_1.default,
      if_1.default,
      thenElse_1.default,
      propertyNames_1.default,
      additionalProperties_1.default,
      dependencies_1.default,
      properties_1.default,
      patternProperties_1.default
    ];
    if (draft2020) applicator.push(prefixItems_1.default, items2020_1.default);
    else applicator.push(additionalItems_1.default, items_1.default);
    applicator.push(contains_1.default);
    return applicator;
  }
  exports.default = getApplicator;
});
var require_format$2 = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const codegen_1 = require_codegen();
  const def = {
    keyword: "format",
    type: ["number", "string"],
    schemaType: "string",
    $data: true,
    error: {
      message: ({ schemaCode }) => (0, codegen_1.str)`must match format "${schemaCode}"`,
      params: ({ schemaCode }) => (0, codegen_1._)`{format: ${schemaCode}}`
    },
    code(cxt, ruleType) {
      const { gen, data, $data, schema, schemaCode, it } = cxt;
      const { opts, errSchemaPath, schemaEnv, self } = it;
      if (!opts.validateFormats) return;
      if ($data) validate$DataFormat();
      else validateFormat();
      function validate$DataFormat() {
        const fmts = gen.scopeValue("formats", {
          ref: self.formats,
          code: opts.code.formats
        });
        const fDef = gen.const("fDef", (0, codegen_1._)`${fmts}[${schemaCode}]`);
        const fType = gen.let("fType");
        const format = gen.let("format");
        gen.if((0, codegen_1._)`typeof ${fDef} == "object" && !(${fDef} instanceof RegExp)`, () => gen.assign(fType, (0, codegen_1._)`${fDef}.type || "string"`).assign(format, (0, codegen_1._)`${fDef}.validate`), () => gen.assign(fType, (0, codegen_1._)`"string"`).assign(format, fDef));
        cxt.fail$data((0, codegen_1.or)(unknownFmt(), invalidFmt()));
        function unknownFmt() {
          if (opts.strictSchema === false) return codegen_1.nil;
          return (0, codegen_1._)`${schemaCode} && !${format}`;
        }
        function invalidFmt() {
          const callFormat = schemaEnv.$async ? (0, codegen_1._)`(${fDef}.async ? await ${format}(${data}) : ${format}(${data}))` : (0, codegen_1._)`${format}(${data})`;
          const validData = (0, codegen_1._)`(typeof ${format} == "function" ? ${callFormat} : ${format}.test(${data}))`;
          return (0, codegen_1._)`${format} && ${format} !== true && ${fType} === ${ruleType} && !${validData}`;
        }
      }
      function validateFormat() {
        const formatDef = self.formats[schema];
        if (!formatDef) {
          unknownFormat();
          return;
        }
        if (formatDef === true) return;
        const [fmtType, format, fmtRef] = getFormat(formatDef);
        if (fmtType === ruleType) cxt.pass(validCondition());
        function unknownFormat() {
          if (opts.strictSchema === false) {
            self.logger.warn(unknownMsg());
            return;
          }
          throw new Error(unknownMsg());
          function unknownMsg() {
            return `unknown format "${schema}" ignored in schema at path "${errSchemaPath}"`;
          }
        }
        function getFormat(fmtDef) {
          const code = fmtDef instanceof RegExp ? (0, codegen_1.regexpCode)(fmtDef) : opts.code.formats ? (0, codegen_1._)`${opts.code.formats}${(0, codegen_1.getProperty)(schema)}` : void 0;
          const fmt = gen.scopeValue("formats", {
            key: schema,
            ref: fmtDef,
            code
          });
          if (typeof fmtDef == "object" && !(fmtDef instanceof RegExp)) return [
            fmtDef.type || "string",
            fmtDef.validate,
            (0, codegen_1._)`${fmt}.validate`
          ];
          return [
            "string",
            fmtDef,
            fmt
          ];
        }
        function validCondition() {
          if (typeof formatDef == "object" && !(formatDef instanceof RegExp) && formatDef.async) {
            if (!schemaEnv.$async) throw new Error("async format in sync schema");
            return (0, codegen_1._)`await ${fmtRef}(${data})`;
          }
          return typeof format == "function" ? (0, codegen_1._)`${fmtRef}(${data})` : (0, codegen_1._)`${fmtRef}.test(${data})`;
        }
      }
    }
  };
  exports.default = def;
});
var require_format$1 = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const format = [require_format$2().default];
  exports.default = format;
});
var require_metadata = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.contentVocabulary = exports.metadataVocabulary = void 0;
  exports.metadataVocabulary = [
    "title",
    "description",
    "default",
    "deprecated",
    "readOnly",
    "writeOnly",
    "examples"
  ];
  exports.contentVocabulary = [
    "contentMediaType",
    "contentEncoding",
    "contentSchema"
  ];
});
var require_draft7 = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const core_1 = require_core$2();
  const validation_1 = require_validation$2();
  const applicator_1 = require_applicator$2();
  const format_1 = require_format$1();
  const metadata_1 = require_metadata();
  const draft7Vocabularies = [
    core_1.default,
    validation_1.default,
    (0, applicator_1.default)(),
    format_1.default,
    metadata_1.metadataVocabulary,
    metadata_1.contentVocabulary
  ];
  exports.default = draft7Vocabularies;
});
var require_types = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.DiscrError = void 0;
  var DiscrError;
  (function(DiscrError2) {
    DiscrError2["Tag"] = "tag";
    DiscrError2["Mapping"] = "mapping";
  })(DiscrError || (exports.DiscrError = DiscrError = {}));
});
var require_discriminator = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const codegen_1 = require_codegen();
  const types_1 = require_types();
  const compile_1 = require_compile();
  const ref_error_1 = require_ref_error();
  const util_1 = require_util();
  const def = {
    keyword: "discriminator",
    type: "object",
    schemaType: "object",
    error: {
      message: ({ params: { discrError, tagName } }) => discrError === types_1.DiscrError.Tag ? `tag "${tagName}" must be string` : `value of tag "${tagName}" must be in oneOf`,
      params: ({ params: { discrError, tag, tagName } }) => (0, codegen_1._)`{error: ${discrError}, tag: ${tagName}, tagValue: ${tag}}`
    },
    code(cxt) {
      const { gen, data, schema, parentSchema, it } = cxt;
      const { oneOf } = parentSchema;
      if (!it.opts.discriminator) throw new Error("discriminator: requires discriminator option");
      const tagName = schema.propertyName;
      if (typeof tagName != "string") throw new Error("discriminator: requires propertyName");
      if (schema.mapping) throw new Error("discriminator: mapping is not supported");
      if (!oneOf) throw new Error("discriminator: requires oneOf keyword");
      const valid = gen.let("valid", false);
      const tag = gen.const("tag", (0, codegen_1._)`${data}${(0, codegen_1.getProperty)(tagName)}`);
      gen.if((0, codegen_1._)`typeof ${tag} == "string"`, () => validateMapping(), () => cxt.error(false, {
        discrError: types_1.DiscrError.Tag,
        tag,
        tagName
      }));
      cxt.ok(valid);
      function validateMapping() {
        const mapping = getMapping();
        gen.if(false);
        for (const tagValue in mapping) {
          gen.elseIf((0, codegen_1._)`${tag} === ${tagValue}`);
          gen.assign(valid, applyTagSchema(mapping[tagValue]));
        }
        gen.else();
        cxt.error(false, {
          discrError: types_1.DiscrError.Mapping,
          tag,
          tagName
        });
        gen.endIf();
      }
      function applyTagSchema(schemaProp) {
        const _valid = gen.name("valid");
        const schCxt = cxt.subschema({
          keyword: "oneOf",
          schemaProp
        }, _valid);
        cxt.mergeEvaluated(schCxt, codegen_1.Name);
        return _valid;
      }
      function getMapping() {
        var _a;
        const oneOfMapping = {};
        const topRequired = hasRequired(parentSchema);
        let tagRequired = true;
        for (let i = 0; i < oneOf.length; i++) {
          let sch = oneOf[i];
          if ((sch === null || sch === void 0 ? void 0 : sch.$ref) && !(0, util_1.schemaHasRulesButRef)(sch, it.self.RULES)) {
            const ref = sch.$ref;
            sch = compile_1.resolveRef.call(it.self, it.schemaEnv.root, it.baseId, ref);
            if (sch instanceof compile_1.SchemaEnv) sch = sch.schema;
            if (sch === void 0) throw new ref_error_1.default(it.opts.uriResolver, it.baseId, ref);
          }
          const propSch = (_a = sch === null || sch === void 0 ? void 0 : sch.properties) === null || _a === void 0 ? void 0 : _a[tagName];
          if (typeof propSch != "object") throw new Error(`discriminator: oneOf subschemas (or referenced schemas) must have "properties/${tagName}"`);
          tagRequired = tagRequired && (topRequired || hasRequired(sch));
          addMappings(propSch, i);
        }
        if (!tagRequired) throw new Error(`discriminator: "${tagName}" must be required`);
        return oneOfMapping;
        function hasRequired({ required }) {
          return Array.isArray(required) && required.includes(tagName);
        }
        function addMappings(sch, i) {
          if (sch.const) addMapping(sch.const, i);
          else if (sch.enum) for (const tagValue of sch.enum) addMapping(tagValue, i);
          else throw new Error(`discriminator: "properties/${tagName}" must have "const" or "enum"`);
        }
        function addMapping(tagValue, i) {
          if (typeof tagValue != "string" || tagValue in oneOfMapping) throw new Error(`discriminator: "${tagName}" values must be unique strings`);
          oneOfMapping[tagValue] = i;
        }
      }
    }
  };
  exports.default = def;
});
var require_json_schema_draft_07 = /* @__PURE__ */ __commonJSMin((exports, module) => {
  module.exports = {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "$id": "http://json-schema.org/draft-07/schema#",
    "title": "Core schema meta-schema",
    "definitions": {
      "schemaArray": {
        "type": "array",
        "minItems": 1,
        "items": { "$ref": "#" }
      },
      "nonNegativeInteger": {
        "type": "integer",
        "minimum": 0
      },
      "nonNegativeIntegerDefault0": { "allOf": [{ "$ref": "#/definitions/nonNegativeInteger" }, { "default": 0 }] },
      "simpleTypes": { "enum": [
        "array",
        "boolean",
        "integer",
        "null",
        "number",
        "object",
        "string"
      ] },
      "stringArray": {
        "type": "array",
        "items": { "type": "string" },
        "uniqueItems": true,
        "default": []
      }
    },
    "type": ["object", "boolean"],
    "properties": {
      "$id": {
        "type": "string",
        "format": "uri-reference"
      },
      "$schema": {
        "type": "string",
        "format": "uri"
      },
      "$ref": {
        "type": "string",
        "format": "uri-reference"
      },
      "$comment": { "type": "string" },
      "title": { "type": "string" },
      "description": { "type": "string" },
      "default": true,
      "readOnly": {
        "type": "boolean",
        "default": false
      },
      "examples": {
        "type": "array",
        "items": true
      },
      "multipleOf": {
        "type": "number",
        "exclusiveMinimum": 0
      },
      "maximum": { "type": "number" },
      "exclusiveMaximum": { "type": "number" },
      "minimum": { "type": "number" },
      "exclusiveMinimum": { "type": "number" },
      "maxLength": { "$ref": "#/definitions/nonNegativeInteger" },
      "minLength": { "$ref": "#/definitions/nonNegativeIntegerDefault0" },
      "pattern": {
        "type": "string",
        "format": "regex"
      },
      "additionalItems": { "$ref": "#" },
      "items": {
        "anyOf": [{ "$ref": "#" }, { "$ref": "#/definitions/schemaArray" }],
        "default": true
      },
      "maxItems": { "$ref": "#/definitions/nonNegativeInteger" },
      "minItems": { "$ref": "#/definitions/nonNegativeIntegerDefault0" },
      "uniqueItems": {
        "type": "boolean",
        "default": false
      },
      "contains": { "$ref": "#" },
      "maxProperties": { "$ref": "#/definitions/nonNegativeInteger" },
      "minProperties": { "$ref": "#/definitions/nonNegativeIntegerDefault0" },
      "required": { "$ref": "#/definitions/stringArray" },
      "additionalProperties": { "$ref": "#" },
      "definitions": {
        "type": "object",
        "additionalProperties": { "$ref": "#" },
        "default": {}
      },
      "properties": {
        "type": "object",
        "additionalProperties": { "$ref": "#" },
        "default": {}
      },
      "patternProperties": {
        "type": "object",
        "additionalProperties": { "$ref": "#" },
        "propertyNames": { "format": "regex" },
        "default": {}
      },
      "dependencies": {
        "type": "object",
        "additionalProperties": { "anyOf": [{ "$ref": "#" }, { "$ref": "#/definitions/stringArray" }] }
      },
      "propertyNames": { "$ref": "#" },
      "const": true,
      "enum": {
        "type": "array",
        "items": true,
        "minItems": 1,
        "uniqueItems": true
      },
      "type": { "anyOf": [{ "$ref": "#/definitions/simpleTypes" }, {
        "type": "array",
        "items": { "$ref": "#/definitions/simpleTypes" },
        "minItems": 1,
        "uniqueItems": true
      }] },
      "format": { "type": "string" },
      "contentMediaType": { "type": "string" },
      "contentEncoding": { "type": "string" },
      "if": { "$ref": "#" },
      "then": { "$ref": "#" },
      "else": { "$ref": "#" },
      "allOf": { "$ref": "#/definitions/schemaArray" },
      "anyOf": { "$ref": "#/definitions/schemaArray" },
      "oneOf": { "$ref": "#/definitions/schemaArray" },
      "not": { "$ref": "#" }
    },
    "default": true
  };
});
var require_ajv = /* @__PURE__ */ __commonJSMin((exports, module) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.MissingRefError = exports.ValidationError = exports.CodeGen = exports.Name = exports.nil = exports.stringify = exports.str = exports._ = exports.KeywordCxt = exports.Ajv = void 0;
  const core_1 = require_core$3();
  const draft7_1 = require_draft7();
  const discriminator_1 = require_discriminator();
  const draft7MetaSchema = require_json_schema_draft_07();
  const META_SUPPORT_DATA = ["/properties"];
  const META_SCHEMA_ID = "http://json-schema.org/draft-07/schema";
  var Ajv2 = class extends core_1.default {
    _addVocabularies() {
      super._addVocabularies();
      draft7_1.default.forEach((v) => this.addVocabulary(v));
      if (this.opts.discriminator) this.addKeyword(discriminator_1.default);
    }
    _addDefaultMetaSchema() {
      super._addDefaultMetaSchema();
      if (!this.opts.meta) return;
      const metaSchema = this.opts.$data ? this.$dataMetaSchema(draft7MetaSchema, META_SUPPORT_DATA) : draft7MetaSchema;
      this.addMetaSchema(metaSchema, META_SCHEMA_ID, false);
      this.refs["http://json-schema.org/schema"] = META_SCHEMA_ID;
    }
    defaultMeta() {
      return this.opts.defaultMeta = super.defaultMeta() || (this.getSchema(META_SCHEMA_ID) ? META_SCHEMA_ID : void 0);
    }
  };
  exports.Ajv = Ajv2;
  module.exports = exports = Ajv2;
  module.exports.Ajv = Ajv2;
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.default = Ajv2;
  var validate_1 = require_validate();
  Object.defineProperty(exports, "KeywordCxt", {
    enumerable: true,
    get: function() {
      return validate_1.KeywordCxt;
    }
  });
  var codegen_1 = require_codegen();
  Object.defineProperty(exports, "_", {
    enumerable: true,
    get: function() {
      return codegen_1._;
    }
  });
  Object.defineProperty(exports, "str", {
    enumerable: true,
    get: function() {
      return codegen_1.str;
    }
  });
  Object.defineProperty(exports, "stringify", {
    enumerable: true,
    get: function() {
      return codegen_1.stringify;
    }
  });
  Object.defineProperty(exports, "nil", {
    enumerable: true,
    get: function() {
      return codegen_1.nil;
    }
  });
  Object.defineProperty(exports, "Name", {
    enumerable: true,
    get: function() {
      return codegen_1.Name;
    }
  });
  Object.defineProperty(exports, "CodeGen", {
    enumerable: true,
    get: function() {
      return codegen_1.CodeGen;
    }
  });
  var validation_error_1 = require_validation_error();
  Object.defineProperty(exports, "ValidationError", {
    enumerable: true,
    get: function() {
      return validation_error_1.default;
    }
  });
  var ref_error_1 = require_ref_error();
  Object.defineProperty(exports, "MissingRefError", {
    enumerable: true,
    get: function() {
      return ref_error_1.default;
    }
  });
});
var require_dynamicAnchor = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.dynamicAnchor = void 0;
  const codegen_1 = require_codegen();
  const names_1 = require_names();
  const compile_1 = require_compile();
  const ref_1 = require_ref();
  const def = {
    keyword: "$dynamicAnchor",
    schemaType: "string",
    code: (cxt) => dynamicAnchor(cxt, cxt.schema)
  };
  function dynamicAnchor(cxt, anchor) {
    const { gen, it } = cxt;
    it.schemaEnv.root.dynamicAnchors[anchor] = true;
    const v = (0, codegen_1._)`${names_1.default.dynamicAnchors}${(0, codegen_1.getProperty)(anchor)}`;
    const validate = it.errSchemaPath === "#" ? it.validateName : _getValidate(cxt);
    gen.if((0, codegen_1._)`!${v}`, () => gen.assign(v, validate));
  }
  exports.dynamicAnchor = dynamicAnchor;
  function _getValidate(cxt) {
    const { schemaEnv, schema, self } = cxt.it;
    const { root, baseId, localRefs, meta } = schemaEnv.root;
    const { schemaId } = self.opts;
    const sch = new compile_1.SchemaEnv({
      schema,
      schemaId,
      root,
      baseId,
      localRefs,
      meta
    });
    compile_1.compileSchema.call(self, sch);
    return (0, ref_1.getValidate)(cxt, sch);
  }
  exports.default = def;
});
var require_dynamicRef = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.dynamicRef = void 0;
  const codegen_1 = require_codegen();
  const names_1 = require_names();
  const ref_1 = require_ref();
  const def = {
    keyword: "$dynamicRef",
    schemaType: "string",
    code: (cxt) => dynamicRef(cxt, cxt.schema)
  };
  function dynamicRef(cxt, ref) {
    const { gen, keyword, it } = cxt;
    if (ref[0] !== "#") throw new Error(`"${keyword}" only supports hash fragment reference`);
    const anchor = ref.slice(1);
    if (it.allErrors) _dynamicRef();
    else {
      const valid = gen.let("valid", false);
      _dynamicRef(valid);
      cxt.ok(valid);
    }
    function _dynamicRef(valid) {
      if (it.schemaEnv.root.dynamicAnchors[anchor]) {
        const v = gen.let("_v", (0, codegen_1._)`${names_1.default.dynamicAnchors}${(0, codegen_1.getProperty)(anchor)}`);
        gen.if(v, _callRef(v, valid), _callRef(it.validateName, valid));
      } else _callRef(it.validateName, valid)();
    }
    function _callRef(validate, valid) {
      return valid ? () => gen.block(() => {
        (0, ref_1.callRef)(cxt, validate);
        gen.let(valid, true);
      }) : () => (0, ref_1.callRef)(cxt, validate);
    }
  }
  exports.dynamicRef = dynamicRef;
  exports.default = def;
});
var require_recursiveAnchor = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const dynamicAnchor_1 = require_dynamicAnchor();
  const util_1 = require_util();
  const def = {
    keyword: "$recursiveAnchor",
    schemaType: "boolean",
    code(cxt) {
      if (cxt.schema) (0, dynamicAnchor_1.dynamicAnchor)(cxt, "");
      else (0, util_1.checkStrictMode)(cxt.it, "$recursiveAnchor: false is ignored");
    }
  };
  exports.default = def;
});
var require_recursiveRef = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const dynamicRef_1 = require_dynamicRef();
  const def = {
    keyword: "$recursiveRef",
    schemaType: "string",
    code: (cxt) => (0, dynamicRef_1.dynamicRef)(cxt, cxt.schema)
  };
  exports.default = def;
});
var require_dynamic = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const dynamicAnchor_1 = require_dynamicAnchor();
  const dynamicRef_1 = require_dynamicRef();
  const recursiveAnchor_1 = require_recursiveAnchor();
  const recursiveRef_1 = require_recursiveRef();
  const dynamic = [
    dynamicAnchor_1.default,
    dynamicRef_1.default,
    recursiveAnchor_1.default,
    recursiveRef_1.default
  ];
  exports.default = dynamic;
});
var require_dependentRequired = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const dependencies_1 = require_dependencies();
  const def = {
    keyword: "dependentRequired",
    type: "object",
    schemaType: "object",
    error: dependencies_1.error,
    code: (cxt) => (0, dependencies_1.validatePropertyDeps)(cxt)
  };
  exports.default = def;
});
var require_dependentSchemas = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const dependencies_1 = require_dependencies();
  const def = {
    keyword: "dependentSchemas",
    type: "object",
    schemaType: "object",
    code: (cxt) => (0, dependencies_1.validateSchemaDeps)(cxt)
  };
  exports.default = def;
});
var require_limitContains = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const util_1 = require_util();
  const def = {
    keyword: ["maxContains", "minContains"],
    type: "array",
    schemaType: "number",
    code({ keyword, parentSchema, it }) {
      if (parentSchema.contains === void 0) (0, util_1.checkStrictMode)(it, `"${keyword}" without "contains" is ignored`);
    }
  };
  exports.default = def;
});
var require_next = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const dependentRequired_1 = require_dependentRequired();
  const dependentSchemas_1 = require_dependentSchemas();
  const limitContains_1 = require_limitContains();
  const next = [
    dependentRequired_1.default,
    dependentSchemas_1.default,
    limitContains_1.default
  ];
  exports.default = next;
});
var require_unevaluatedProperties = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const codegen_1 = require_codegen();
  const util_1 = require_util();
  const names_1 = require_names();
  const def = {
    keyword: "unevaluatedProperties",
    type: "object",
    schemaType: ["boolean", "object"],
    trackErrors: true,
    error: {
      message: "must NOT have unevaluated properties",
      params: ({ params }) => (0, codegen_1._)`{unevaluatedProperty: ${params.unevaluatedProperty}}`
    },
    code(cxt) {
      const { gen, schema, data, errsCount, it } = cxt;
      if (!errsCount) throw new Error("ajv implementation error");
      const { allErrors, props } = it;
      if (props instanceof codegen_1.Name) gen.if((0, codegen_1._)`${props} !== true`, () => gen.forIn("key", data, (key) => gen.if(unevaluatedDynamic(props, key), () => unevaluatedPropCode(key))));
      else if (props !== true) gen.forIn("key", data, (key) => props === void 0 ? unevaluatedPropCode(key) : gen.if(unevaluatedStatic(props, key), () => unevaluatedPropCode(key)));
      it.props = true;
      cxt.ok((0, codegen_1._)`${errsCount} === ${names_1.default.errors}`);
      function unevaluatedPropCode(key) {
        if (schema === false) {
          cxt.setParams({ unevaluatedProperty: key });
          cxt.error();
          if (!allErrors) gen.break();
          return;
        }
        if (!(0, util_1.alwaysValidSchema)(it, schema)) {
          const valid = gen.name("valid");
          cxt.subschema({
            keyword: "unevaluatedProperties",
            dataProp: key,
            dataPropType: util_1.Type.Str
          }, valid);
          if (!allErrors) gen.if((0, codegen_1.not)(valid), () => gen.break());
        }
      }
      function unevaluatedDynamic(evaluatedProps, key) {
        return (0, codegen_1._)`!${evaluatedProps} || !${evaluatedProps}[${key}]`;
      }
      function unevaluatedStatic(evaluatedProps, key) {
        const ps = [];
        for (const p in evaluatedProps) if (evaluatedProps[p] === true) ps.push((0, codegen_1._)`${key} !== ${p}`);
        return (0, codegen_1.and)(...ps);
      }
    }
  };
  exports.default = def;
});
var require_unevaluatedItems = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const codegen_1 = require_codegen();
  const util_1 = require_util();
  const def = {
    keyword: "unevaluatedItems",
    type: "array",
    schemaType: ["boolean", "object"],
    error: {
      message: ({ params: { len } }) => (0, codegen_1.str)`must NOT have more than ${len} items`,
      params: ({ params: { len } }) => (0, codegen_1._)`{limit: ${len}}`
    },
    code(cxt) {
      const { gen, schema, data, it } = cxt;
      const items = it.items || 0;
      if (items === true) return;
      const len = gen.const("len", (0, codegen_1._)`${data}.length`);
      if (schema === false) {
        cxt.setParams({ len: items });
        cxt.fail((0, codegen_1._)`${len} > ${items}`);
      } else if (typeof schema == "object" && !(0, util_1.alwaysValidSchema)(it, schema)) {
        const valid = gen.var("valid", (0, codegen_1._)`${len} <= ${items}`);
        gen.if((0, codegen_1.not)(valid), () => validateItems(valid, items));
        cxt.ok(valid);
      }
      it.items = true;
      function validateItems(valid, from) {
        gen.forRange("i", from, len, (i) => {
          cxt.subschema({
            keyword: "unevaluatedItems",
            dataProp: i,
            dataPropType: util_1.Type.Num
          }, valid);
          if (!it.allErrors) gen.if((0, codegen_1.not)(valid), () => gen.break());
        });
      }
    }
  };
  exports.default = def;
});
var require_unevaluated$1 = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const unevaluatedProperties_1 = require_unevaluatedProperties();
  const unevaluatedItems_1 = require_unevaluatedItems();
  const unevaluated = [unevaluatedProperties_1.default, unevaluatedItems_1.default];
  exports.default = unevaluated;
});
var require_schema$1 = /* @__PURE__ */ __commonJSMin((exports, module) => {
  module.exports = {
    "$schema": "https://json-schema.org/draft/2019-09/schema",
    "$id": "https://json-schema.org/draft/2019-09/schema",
    "$vocabulary": {
      "https://json-schema.org/draft/2019-09/vocab/core": true,
      "https://json-schema.org/draft/2019-09/vocab/applicator": true,
      "https://json-schema.org/draft/2019-09/vocab/validation": true,
      "https://json-schema.org/draft/2019-09/vocab/meta-data": true,
      "https://json-schema.org/draft/2019-09/vocab/format": false,
      "https://json-schema.org/draft/2019-09/vocab/content": true
    },
    "$recursiveAnchor": true,
    "title": "Core and Validation specifications meta-schema",
    "allOf": [
      { "$ref": "meta/core" },
      { "$ref": "meta/applicator" },
      { "$ref": "meta/validation" },
      { "$ref": "meta/meta-data" },
      { "$ref": "meta/format" },
      { "$ref": "meta/content" }
    ],
    "type": ["object", "boolean"],
    "properties": {
      "definitions": {
        "$comment": "While no longer an official keyword as it is replaced by $defs, this keyword is retained in the meta-schema to prevent incompatible extensions as it remains in common use.",
        "type": "object",
        "additionalProperties": { "$recursiveRef": "#" },
        "default": {}
      },
      "dependencies": {
        "$comment": '"dependencies" is no longer a keyword, but schema authors should avoid redefining it to facilitate a smooth transition to "dependentSchemas" and "dependentRequired"',
        "type": "object",
        "additionalProperties": { "anyOf": [{ "$recursiveRef": "#" }, { "$ref": "meta/validation#/$defs/stringArray" }] }
      }
    }
  };
});
var require_applicator$1 = /* @__PURE__ */ __commonJSMin((exports, module) => {
  module.exports = {
    "$schema": "https://json-schema.org/draft/2019-09/schema",
    "$id": "https://json-schema.org/draft/2019-09/meta/applicator",
    "$vocabulary": { "https://json-schema.org/draft/2019-09/vocab/applicator": true },
    "$recursiveAnchor": true,
    "title": "Applicator vocabulary meta-schema",
    "type": ["object", "boolean"],
    "properties": {
      "additionalItems": { "$recursiveRef": "#" },
      "unevaluatedItems": { "$recursiveRef": "#" },
      "items": { "anyOf": [{ "$recursiveRef": "#" }, { "$ref": "#/$defs/schemaArray" }] },
      "contains": { "$recursiveRef": "#" },
      "additionalProperties": { "$recursiveRef": "#" },
      "unevaluatedProperties": { "$recursiveRef": "#" },
      "properties": {
        "type": "object",
        "additionalProperties": { "$recursiveRef": "#" },
        "default": {}
      },
      "patternProperties": {
        "type": "object",
        "additionalProperties": { "$recursiveRef": "#" },
        "propertyNames": { "format": "regex" },
        "default": {}
      },
      "dependentSchemas": {
        "type": "object",
        "additionalProperties": { "$recursiveRef": "#" }
      },
      "propertyNames": { "$recursiveRef": "#" },
      "if": { "$recursiveRef": "#" },
      "then": { "$recursiveRef": "#" },
      "else": { "$recursiveRef": "#" },
      "allOf": { "$ref": "#/$defs/schemaArray" },
      "anyOf": { "$ref": "#/$defs/schemaArray" },
      "oneOf": { "$ref": "#/$defs/schemaArray" },
      "not": { "$recursiveRef": "#" }
    },
    "$defs": { "schemaArray": {
      "type": "array",
      "minItems": 1,
      "items": { "$recursiveRef": "#" }
    } }
  };
});
var require_content$1 = /* @__PURE__ */ __commonJSMin((exports, module) => {
  module.exports = {
    "$schema": "https://json-schema.org/draft/2019-09/schema",
    "$id": "https://json-schema.org/draft/2019-09/meta/content",
    "$vocabulary": { "https://json-schema.org/draft/2019-09/vocab/content": true },
    "$recursiveAnchor": true,
    "title": "Content vocabulary meta-schema",
    "type": ["object", "boolean"],
    "properties": {
      "contentMediaType": { "type": "string" },
      "contentEncoding": { "type": "string" },
      "contentSchema": { "$recursiveRef": "#" }
    }
  };
});
var require_core$1 = /* @__PURE__ */ __commonJSMin((exports, module) => {
  module.exports = {
    "$schema": "https://json-schema.org/draft/2019-09/schema",
    "$id": "https://json-schema.org/draft/2019-09/meta/core",
    "$vocabulary": { "https://json-schema.org/draft/2019-09/vocab/core": true },
    "$recursiveAnchor": true,
    "title": "Core vocabulary meta-schema",
    "type": ["object", "boolean"],
    "properties": {
      "$id": {
        "type": "string",
        "format": "uri-reference",
        "$comment": "Non-empty fragments not allowed.",
        "pattern": "^[^#]*#?$"
      },
      "$schema": {
        "type": "string",
        "format": "uri"
      },
      "$anchor": {
        "type": "string",
        "pattern": "^[A-Za-z][-A-Za-z0-9.:_]*$"
      },
      "$ref": {
        "type": "string",
        "format": "uri-reference"
      },
      "$recursiveRef": {
        "type": "string",
        "format": "uri-reference"
      },
      "$recursiveAnchor": {
        "type": "boolean",
        "default": false
      },
      "$vocabulary": {
        "type": "object",
        "propertyNames": {
          "type": "string",
          "format": "uri"
        },
        "additionalProperties": { "type": "boolean" }
      },
      "$comment": { "type": "string" },
      "$defs": {
        "type": "object",
        "additionalProperties": { "$recursiveRef": "#" },
        "default": {}
      }
    }
  };
});
var require_format = /* @__PURE__ */ __commonJSMin((exports, module) => {
  module.exports = {
    "$schema": "https://json-schema.org/draft/2019-09/schema",
    "$id": "https://json-schema.org/draft/2019-09/meta/format",
    "$vocabulary": { "https://json-schema.org/draft/2019-09/vocab/format": true },
    "$recursiveAnchor": true,
    "title": "Format vocabulary meta-schema",
    "type": ["object", "boolean"],
    "properties": { "format": { "type": "string" } }
  };
});
var require_meta_data$1 = /* @__PURE__ */ __commonJSMin((exports, module) => {
  module.exports = {
    "$schema": "https://json-schema.org/draft/2019-09/schema",
    "$id": "https://json-schema.org/draft/2019-09/meta/meta-data",
    "$vocabulary": { "https://json-schema.org/draft/2019-09/vocab/meta-data": true },
    "$recursiveAnchor": true,
    "title": "Meta-data vocabulary meta-schema",
    "type": ["object", "boolean"],
    "properties": {
      "title": { "type": "string" },
      "description": { "type": "string" },
      "default": true,
      "deprecated": {
        "type": "boolean",
        "default": false
      },
      "readOnly": {
        "type": "boolean",
        "default": false
      },
      "writeOnly": {
        "type": "boolean",
        "default": false
      },
      "examples": {
        "type": "array",
        "items": true
      }
    }
  };
});
var require_validation$1 = /* @__PURE__ */ __commonJSMin((exports, module) => {
  module.exports = {
    "$schema": "https://json-schema.org/draft/2019-09/schema",
    "$id": "https://json-schema.org/draft/2019-09/meta/validation",
    "$vocabulary": { "https://json-schema.org/draft/2019-09/vocab/validation": true },
    "$recursiveAnchor": true,
    "title": "Validation vocabulary meta-schema",
    "type": ["object", "boolean"],
    "properties": {
      "multipleOf": {
        "type": "number",
        "exclusiveMinimum": 0
      },
      "maximum": { "type": "number" },
      "exclusiveMaximum": { "type": "number" },
      "minimum": { "type": "number" },
      "exclusiveMinimum": { "type": "number" },
      "maxLength": { "$ref": "#/$defs/nonNegativeInteger" },
      "minLength": { "$ref": "#/$defs/nonNegativeIntegerDefault0" },
      "pattern": {
        "type": "string",
        "format": "regex"
      },
      "maxItems": { "$ref": "#/$defs/nonNegativeInteger" },
      "minItems": { "$ref": "#/$defs/nonNegativeIntegerDefault0" },
      "uniqueItems": {
        "type": "boolean",
        "default": false
      },
      "maxContains": { "$ref": "#/$defs/nonNegativeInteger" },
      "minContains": {
        "$ref": "#/$defs/nonNegativeInteger",
        "default": 1
      },
      "maxProperties": { "$ref": "#/$defs/nonNegativeInteger" },
      "minProperties": { "$ref": "#/$defs/nonNegativeIntegerDefault0" },
      "required": { "$ref": "#/$defs/stringArray" },
      "dependentRequired": {
        "type": "object",
        "additionalProperties": { "$ref": "#/$defs/stringArray" }
      },
      "const": true,
      "enum": {
        "type": "array",
        "items": true
      },
      "type": { "anyOf": [{ "$ref": "#/$defs/simpleTypes" }, {
        "type": "array",
        "items": { "$ref": "#/$defs/simpleTypes" },
        "minItems": 1,
        "uniqueItems": true
      }] }
    },
    "$defs": {
      "nonNegativeInteger": {
        "type": "integer",
        "minimum": 0
      },
      "nonNegativeIntegerDefault0": {
        "$ref": "#/$defs/nonNegativeInteger",
        "default": 0
      },
      "simpleTypes": { "enum": [
        "array",
        "boolean",
        "integer",
        "null",
        "number",
        "object",
        "string"
      ] },
      "stringArray": {
        "type": "array",
        "items": { "type": "string" },
        "uniqueItems": true,
        "default": []
      }
    }
  };
});
var require_json_schema_2019_09 = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const metaSchema = require_schema$1();
  const applicator = require_applicator$1();
  const content = require_content$1();
  const core = require_core$1();
  const format = require_format();
  const metadata = require_meta_data$1();
  const validation = require_validation$1();
  const META_SUPPORT_DATA = ["/properties"];
  function addMetaSchema2019($data) {
    [
      metaSchema,
      applicator,
      content,
      core,
      with$data(this, format),
      metadata,
      with$data(this, validation)
    ].forEach((sch) => this.addMetaSchema(sch, void 0, false));
    return this;
    function with$data(ajv, sch) {
      return $data ? ajv.$dataMetaSchema(sch, META_SUPPORT_DATA) : sch;
    }
  }
  exports.default = addMetaSchema2019;
});
var require__2019 = /* @__PURE__ */ __commonJSMin((exports, module) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.MissingRefError = exports.ValidationError = exports.CodeGen = exports.Name = exports.nil = exports.stringify = exports.str = exports._ = exports.KeywordCxt = exports.Ajv2019 = void 0;
  const core_1 = require_core$3();
  const draft7_1 = require_draft7();
  const dynamic_1 = require_dynamic();
  const next_1 = require_next();
  const unevaluated_1 = require_unevaluated$1();
  const discriminator_1 = require_discriminator();
  const json_schema_2019_09_1 = require_json_schema_2019_09();
  const META_SCHEMA_ID = "https://json-schema.org/draft/2019-09/schema";
  var Ajv2019 = class extends core_1.default {
    constructor(opts = {}) {
      super({
        ...opts,
        dynamicRef: true,
        next: true,
        unevaluated: true
      });
    }
    _addVocabularies() {
      super._addVocabularies();
      this.addVocabulary(dynamic_1.default);
      draft7_1.default.forEach((v) => this.addVocabulary(v));
      this.addVocabulary(next_1.default);
      this.addVocabulary(unevaluated_1.default);
      if (this.opts.discriminator) this.addKeyword(discriminator_1.default);
    }
    _addDefaultMetaSchema() {
      super._addDefaultMetaSchema();
      const { $data, meta } = this.opts;
      if (!meta) return;
      json_schema_2019_09_1.default.call(this, $data);
      this.refs["http://json-schema.org/schema"] = META_SCHEMA_ID;
    }
    defaultMeta() {
      return this.opts.defaultMeta = super.defaultMeta() || (this.getSchema(META_SCHEMA_ID) ? META_SCHEMA_ID : void 0);
    }
  };
  exports.Ajv2019 = Ajv2019;
  module.exports = exports = Ajv2019;
  module.exports.Ajv2019 = Ajv2019;
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.default = Ajv2019;
  var validate_1 = require_validate();
  Object.defineProperty(exports, "KeywordCxt", {
    enumerable: true,
    get: function() {
      return validate_1.KeywordCxt;
    }
  });
  var codegen_1 = require_codegen();
  Object.defineProperty(exports, "_", {
    enumerable: true,
    get: function() {
      return codegen_1._;
    }
  });
  Object.defineProperty(exports, "str", {
    enumerable: true,
    get: function() {
      return codegen_1.str;
    }
  });
  Object.defineProperty(exports, "stringify", {
    enumerable: true,
    get: function() {
      return codegen_1.stringify;
    }
  });
  Object.defineProperty(exports, "nil", {
    enumerable: true,
    get: function() {
      return codegen_1.nil;
    }
  });
  Object.defineProperty(exports, "Name", {
    enumerable: true,
    get: function() {
      return codegen_1.Name;
    }
  });
  Object.defineProperty(exports, "CodeGen", {
    enumerable: true,
    get: function() {
      return codegen_1.CodeGen;
    }
  });
  var validation_error_1 = require_validation_error();
  Object.defineProperty(exports, "ValidationError", {
    enumerable: true,
    get: function() {
      return validation_error_1.default;
    }
  });
  var ref_error_1 = require_ref_error();
  Object.defineProperty(exports, "MissingRefError", {
    enumerable: true,
    get: function() {
      return ref_error_1.default;
    }
  });
});
var require_draft2020 = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const core_1 = require_core$2();
  const validation_1 = require_validation$2();
  const applicator_1 = require_applicator$2();
  const dynamic_1 = require_dynamic();
  const next_1 = require_next();
  const unevaluated_1 = require_unevaluated$1();
  const format_1 = require_format$1();
  const metadata_1 = require_metadata();
  const draft2020Vocabularies = [
    dynamic_1.default,
    core_1.default,
    validation_1.default,
    (0, applicator_1.default)(true),
    format_1.default,
    metadata_1.metadataVocabulary,
    metadata_1.contentVocabulary,
    next_1.default,
    unevaluated_1.default
  ];
  exports.default = draft2020Vocabularies;
});
var require_schema = /* @__PURE__ */ __commonJSMin((exports, module) => {
  module.exports = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://json-schema.org/draft/2020-12/schema",
    "$vocabulary": {
      "https://json-schema.org/draft/2020-12/vocab/core": true,
      "https://json-schema.org/draft/2020-12/vocab/applicator": true,
      "https://json-schema.org/draft/2020-12/vocab/unevaluated": true,
      "https://json-schema.org/draft/2020-12/vocab/validation": true,
      "https://json-schema.org/draft/2020-12/vocab/meta-data": true,
      "https://json-schema.org/draft/2020-12/vocab/format-annotation": true,
      "https://json-schema.org/draft/2020-12/vocab/content": true
    },
    "$dynamicAnchor": "meta",
    "title": "Core and Validation specifications meta-schema",
    "allOf": [
      { "$ref": "meta/core" },
      { "$ref": "meta/applicator" },
      { "$ref": "meta/unevaluated" },
      { "$ref": "meta/validation" },
      { "$ref": "meta/meta-data" },
      { "$ref": "meta/format-annotation" },
      { "$ref": "meta/content" }
    ],
    "type": ["object", "boolean"],
    "$comment": "This meta-schema also defines keywords that have appeared in previous drafts in order to prevent incompatible extensions as they remain in common use.",
    "properties": {
      "definitions": {
        "$comment": '"definitions" has been replaced by "$defs".',
        "type": "object",
        "additionalProperties": { "$dynamicRef": "#meta" },
        "deprecated": true,
        "default": {}
      },
      "dependencies": {
        "$comment": '"dependencies" has been split and replaced by "dependentSchemas" and "dependentRequired" in order to serve their differing semantics.',
        "type": "object",
        "additionalProperties": { "anyOf": [{ "$dynamicRef": "#meta" }, { "$ref": "meta/validation#/$defs/stringArray" }] },
        "deprecated": true,
        "default": {}
      },
      "$recursiveAnchor": {
        "$comment": '"$recursiveAnchor" has been replaced by "$dynamicAnchor".',
        "$ref": "meta/core#/$defs/anchorString",
        "deprecated": true
      },
      "$recursiveRef": {
        "$comment": '"$recursiveRef" has been replaced by "$dynamicRef".',
        "$ref": "meta/core#/$defs/uriReferenceString",
        "deprecated": true
      }
    }
  };
});
var require_applicator = /* @__PURE__ */ __commonJSMin((exports, module) => {
  module.exports = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://json-schema.org/draft/2020-12/meta/applicator",
    "$vocabulary": { "https://json-schema.org/draft/2020-12/vocab/applicator": true },
    "$dynamicAnchor": "meta",
    "title": "Applicator vocabulary meta-schema",
    "type": ["object", "boolean"],
    "properties": {
      "prefixItems": { "$ref": "#/$defs/schemaArray" },
      "items": { "$dynamicRef": "#meta" },
      "contains": { "$dynamicRef": "#meta" },
      "additionalProperties": { "$dynamicRef": "#meta" },
      "properties": {
        "type": "object",
        "additionalProperties": { "$dynamicRef": "#meta" },
        "default": {}
      },
      "patternProperties": {
        "type": "object",
        "additionalProperties": { "$dynamicRef": "#meta" },
        "propertyNames": { "format": "regex" },
        "default": {}
      },
      "dependentSchemas": {
        "type": "object",
        "additionalProperties": { "$dynamicRef": "#meta" },
        "default": {}
      },
      "propertyNames": { "$dynamicRef": "#meta" },
      "if": { "$dynamicRef": "#meta" },
      "then": { "$dynamicRef": "#meta" },
      "else": { "$dynamicRef": "#meta" },
      "allOf": { "$ref": "#/$defs/schemaArray" },
      "anyOf": { "$ref": "#/$defs/schemaArray" },
      "oneOf": { "$ref": "#/$defs/schemaArray" },
      "not": { "$dynamicRef": "#meta" }
    },
    "$defs": { "schemaArray": {
      "type": "array",
      "minItems": 1,
      "items": { "$dynamicRef": "#meta" }
    } }
  };
});
var require_unevaluated = /* @__PURE__ */ __commonJSMin((exports, module) => {
  module.exports = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://json-schema.org/draft/2020-12/meta/unevaluated",
    "$vocabulary": { "https://json-schema.org/draft/2020-12/vocab/unevaluated": true },
    "$dynamicAnchor": "meta",
    "title": "Unevaluated applicator vocabulary meta-schema",
    "type": ["object", "boolean"],
    "properties": {
      "unevaluatedItems": { "$dynamicRef": "#meta" },
      "unevaluatedProperties": { "$dynamicRef": "#meta" }
    }
  };
});
var require_content = /* @__PURE__ */ __commonJSMin((exports, module) => {
  module.exports = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://json-schema.org/draft/2020-12/meta/content",
    "$vocabulary": { "https://json-schema.org/draft/2020-12/vocab/content": true },
    "$dynamicAnchor": "meta",
    "title": "Content vocabulary meta-schema",
    "type": ["object", "boolean"],
    "properties": {
      "contentEncoding": { "type": "string" },
      "contentMediaType": { "type": "string" },
      "contentSchema": { "$dynamicRef": "#meta" }
    }
  };
});
var require_core = /* @__PURE__ */ __commonJSMin((exports, module) => {
  module.exports = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://json-schema.org/draft/2020-12/meta/core",
    "$vocabulary": { "https://json-schema.org/draft/2020-12/vocab/core": true },
    "$dynamicAnchor": "meta",
    "title": "Core vocabulary meta-schema",
    "type": ["object", "boolean"],
    "properties": {
      "$id": {
        "$ref": "#/$defs/uriReferenceString",
        "$comment": "Non-empty fragments not allowed.",
        "pattern": "^[^#]*#?$"
      },
      "$schema": { "$ref": "#/$defs/uriString" },
      "$ref": { "$ref": "#/$defs/uriReferenceString" },
      "$anchor": { "$ref": "#/$defs/anchorString" },
      "$dynamicRef": { "$ref": "#/$defs/uriReferenceString" },
      "$dynamicAnchor": { "$ref": "#/$defs/anchorString" },
      "$vocabulary": {
        "type": "object",
        "propertyNames": { "$ref": "#/$defs/uriString" },
        "additionalProperties": { "type": "boolean" }
      },
      "$comment": { "type": "string" },
      "$defs": {
        "type": "object",
        "additionalProperties": { "$dynamicRef": "#meta" }
      }
    },
    "$defs": {
      "anchorString": {
        "type": "string",
        "pattern": "^[A-Za-z_][-A-Za-z0-9._]*$"
      },
      "uriString": {
        "type": "string",
        "format": "uri"
      },
      "uriReferenceString": {
        "type": "string",
        "format": "uri-reference"
      }
    }
  };
});
var require_format_annotation = /* @__PURE__ */ __commonJSMin((exports, module) => {
  module.exports = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://json-schema.org/draft/2020-12/meta/format-annotation",
    "$vocabulary": { "https://json-schema.org/draft/2020-12/vocab/format-annotation": true },
    "$dynamicAnchor": "meta",
    "title": "Format vocabulary meta-schema for annotation results",
    "type": ["object", "boolean"],
    "properties": { "format": { "type": "string" } }
  };
});
var require_meta_data = /* @__PURE__ */ __commonJSMin((exports, module) => {
  module.exports = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://json-schema.org/draft/2020-12/meta/meta-data",
    "$vocabulary": { "https://json-schema.org/draft/2020-12/vocab/meta-data": true },
    "$dynamicAnchor": "meta",
    "title": "Meta-data vocabulary meta-schema",
    "type": ["object", "boolean"],
    "properties": {
      "title": { "type": "string" },
      "description": { "type": "string" },
      "default": true,
      "deprecated": {
        "type": "boolean",
        "default": false
      },
      "readOnly": {
        "type": "boolean",
        "default": false
      },
      "writeOnly": {
        "type": "boolean",
        "default": false
      },
      "examples": {
        "type": "array",
        "items": true
      }
    }
  };
});
var require_validation = /* @__PURE__ */ __commonJSMin((exports, module) => {
  module.exports = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://json-schema.org/draft/2020-12/meta/validation",
    "$vocabulary": { "https://json-schema.org/draft/2020-12/vocab/validation": true },
    "$dynamicAnchor": "meta",
    "title": "Validation vocabulary meta-schema",
    "type": ["object", "boolean"],
    "properties": {
      "type": { "anyOf": [{ "$ref": "#/$defs/simpleTypes" }, {
        "type": "array",
        "items": { "$ref": "#/$defs/simpleTypes" },
        "minItems": 1,
        "uniqueItems": true
      }] },
      "const": true,
      "enum": {
        "type": "array",
        "items": true
      },
      "multipleOf": {
        "type": "number",
        "exclusiveMinimum": 0
      },
      "maximum": { "type": "number" },
      "exclusiveMaximum": { "type": "number" },
      "minimum": { "type": "number" },
      "exclusiveMinimum": { "type": "number" },
      "maxLength": { "$ref": "#/$defs/nonNegativeInteger" },
      "minLength": { "$ref": "#/$defs/nonNegativeIntegerDefault0" },
      "pattern": {
        "type": "string",
        "format": "regex"
      },
      "maxItems": { "$ref": "#/$defs/nonNegativeInteger" },
      "minItems": { "$ref": "#/$defs/nonNegativeIntegerDefault0" },
      "uniqueItems": {
        "type": "boolean",
        "default": false
      },
      "maxContains": { "$ref": "#/$defs/nonNegativeInteger" },
      "minContains": {
        "$ref": "#/$defs/nonNegativeInteger",
        "default": 1
      },
      "maxProperties": { "$ref": "#/$defs/nonNegativeInteger" },
      "minProperties": { "$ref": "#/$defs/nonNegativeIntegerDefault0" },
      "required": { "$ref": "#/$defs/stringArray" },
      "dependentRequired": {
        "type": "object",
        "additionalProperties": { "$ref": "#/$defs/stringArray" }
      }
    },
    "$defs": {
      "nonNegativeInteger": {
        "type": "integer",
        "minimum": 0
      },
      "nonNegativeIntegerDefault0": {
        "$ref": "#/$defs/nonNegativeInteger",
        "default": 0
      },
      "simpleTypes": { "enum": [
        "array",
        "boolean",
        "integer",
        "null",
        "number",
        "object",
        "string"
      ] },
      "stringArray": {
        "type": "array",
        "items": { "type": "string" },
        "uniqueItems": true,
        "default": []
      }
    }
  };
});
var require_json_schema_2020_12 = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const metaSchema = require_schema();
  const applicator = require_applicator();
  const unevaluated = require_unevaluated();
  const content = require_content();
  const core = require_core();
  const format = require_format_annotation();
  const metadata = require_meta_data();
  const validation = require_validation();
  const META_SUPPORT_DATA = ["/properties"];
  function addMetaSchema2020($data) {
    [
      metaSchema,
      applicator,
      unevaluated,
      content,
      core,
      with$data(this, format),
      metadata,
      with$data(this, validation)
    ].forEach((sch) => this.addMetaSchema(sch, void 0, false));
    return this;
    function with$data(ajv, sch) {
      return $data ? ajv.$dataMetaSchema(sch, META_SUPPORT_DATA) : sch;
    }
  }
  exports.default = addMetaSchema2020;
});
var require__2020 = /* @__PURE__ */ __commonJSMin((exports, module) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.MissingRefError = exports.ValidationError = exports.CodeGen = exports.Name = exports.nil = exports.stringify = exports.str = exports._ = exports.KeywordCxt = exports.Ajv2020 = void 0;
  const core_1 = require_core$3();
  const draft2020_1 = require_draft2020();
  const discriminator_1 = require_discriminator();
  const json_schema_2020_12_1 = require_json_schema_2020_12();
  const META_SCHEMA_ID = "https://json-schema.org/draft/2020-12/schema";
  var Ajv2020 = class extends core_1.default {
    constructor(opts = {}) {
      super({
        ...opts,
        dynamicRef: true,
        next: true,
        unevaluated: true
      });
    }
    _addVocabularies() {
      super._addVocabularies();
      draft2020_1.default.forEach((v) => this.addVocabulary(v));
      if (this.opts.discriminator) this.addKeyword(discriminator_1.default);
    }
    _addDefaultMetaSchema() {
      super._addDefaultMetaSchema();
      const { $data, meta } = this.opts;
      if (!meta) return;
      json_schema_2020_12_1.default.call(this, $data);
      this.refs["http://json-schema.org/schema"] = META_SCHEMA_ID;
    }
    defaultMeta() {
      return this.opts.defaultMeta = super.defaultMeta() || (this.getSchema(META_SCHEMA_ID) ? META_SCHEMA_ID : void 0);
    }
  };
  exports.Ajv2020 = Ajv2020;
  module.exports = exports = Ajv2020;
  module.exports.Ajv2020 = Ajv2020;
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.default = Ajv2020;
  var validate_1 = require_validate();
  Object.defineProperty(exports, "KeywordCxt", {
    enumerable: true,
    get: function() {
      return validate_1.KeywordCxt;
    }
  });
  var codegen_1 = require_codegen();
  Object.defineProperty(exports, "_", {
    enumerable: true,
    get: function() {
      return codegen_1._;
    }
  });
  Object.defineProperty(exports, "str", {
    enumerable: true,
    get: function() {
      return codegen_1.str;
    }
  });
  Object.defineProperty(exports, "stringify", {
    enumerable: true,
    get: function() {
      return codegen_1.stringify;
    }
  });
  Object.defineProperty(exports, "nil", {
    enumerable: true,
    get: function() {
      return codegen_1.nil;
    }
  });
  Object.defineProperty(exports, "Name", {
    enumerable: true,
    get: function() {
      return codegen_1.Name;
    }
  });
  Object.defineProperty(exports, "CodeGen", {
    enumerable: true,
    get: function() {
      return codegen_1.CodeGen;
    }
  });
  var validation_error_1 = require_validation_error();
  Object.defineProperty(exports, "ValidationError", {
    enumerable: true,
    get: function() {
      return validation_error_1.default;
    }
  });
  var ref_error_1 = require_ref_error();
  Object.defineProperty(exports, "MissingRefError", {
    enumerable: true,
    get: function() {
      return ref_error_1.default;
    }
  });
});
var require_formats = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.formatNames = exports.fastFormats = exports.fullFormats = void 0;
  function fmtDef(validate, compare) {
    return {
      validate,
      compare
    };
  }
  exports.fullFormats = {
    date: fmtDef(date, compareDate),
    time: fmtDef(getTime(true), compareTime),
    "date-time": fmtDef(getDateTime(true), compareDateTime),
    "iso-time": fmtDef(getTime(), compareIsoTime),
    "iso-date-time": fmtDef(getDateTime(), compareIsoDateTime),
    duration: /^P(?!$)((\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+S)?)?|(\d+W)?)$/,
    uri,
    "uri-reference": /^(?:[a-z][a-z0-9+\-.]*:)?(?:\/?\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:]|%[0-9a-f]{2})*@)?(?:\[(?:(?:(?:(?:[0-9a-f]{1,4}:){6}|::(?:[0-9a-f]{1,4}:){5}|(?:[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){4}|(?:(?:[0-9a-f]{1,4}:){0,1}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){3}|(?:(?:[0-9a-f]{1,4}:){0,2}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){2}|(?:(?:[0-9a-f]{1,4}:){0,3}[0-9a-f]{1,4})?::[0-9a-f]{1,4}:|(?:(?:[0-9a-f]{1,4}:){0,4}[0-9a-f]{1,4})?::)(?:[0-9a-f]{1,4}:[0-9a-f]{1,4}|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?))|(?:(?:[0-9a-f]{1,4}:){0,5}[0-9a-f]{1,4})?::[0-9a-f]{1,4}|(?:(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4})?::)|[Vv][0-9a-f]+\.[a-z0-9\-._~!$&'()*+,;=:]+)\]|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)|(?:[a-z0-9\-._~!$&'"()*+,;=]|%[0-9a-f]{2})*)(?::\d*)?(?:\/(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})*)*|\/(?:(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})*)*)?|(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})*)*)?(?:\?(?:[a-z0-9\-._~!$&'"()*+,;=:@/?]|%[0-9a-f]{2})*)?(?:#(?:[a-z0-9\-._~!$&'"()*+,;=:@/?]|%[0-9a-f]{2})*)?$/i,
    "uri-template": /^(?:(?:[^\x00-\x20"'<>%\\^`{|}]|%[0-9a-f]{2})|\{[+#./;?&=,!@|]?(?:[a-z0-9_]|%[0-9a-f]{2})+(?::[1-9][0-9]{0,3}|\*)?(?:,(?:[a-z0-9_]|%[0-9a-f]{2})+(?::[1-9][0-9]{0,3}|\*)?)*\})*$/i,
    url: /^(?:https?|ftp):\/\/(?:\S+(?::\S*)?@)?(?:(?!(?:10|127)(?:\.\d{1,3}){3})(?!(?:169\.254|192\.168)(?:\.\d{1,3}){2})(?!172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2})(?:[1-9]\d?|1\d\d|2[01]\d|22[0-3])(?:\.(?:1?\d{1,2}|2[0-4]\d|25[0-5])){2}(?:\.(?:[1-9]\d?|1\d\d|2[0-4]\d|25[0-4]))|(?:(?:[a-z0-9\u{00a1}-\u{ffff}]+-)*[a-z0-9\u{00a1}-\u{ffff}]+)(?:\.(?:[a-z0-9\u{00a1}-\u{ffff}]+-)*[a-z0-9\u{00a1}-\u{ffff}]+)*(?:\.(?:[a-z\u{00a1}-\u{ffff}]{2,})))(?::\d{2,5})?(?:\/[^\s]*)?$/iu,
    email: /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i,
    hostname: /^(?=.{1,253}\.?$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[-0-9a-z]{0,61}[0-9a-z])?)*\.?$/i,
    ipv4: /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/,
    ipv6: /^((([0-9a-f]{1,4}:){7}([0-9a-f]{1,4}|:))|(([0-9a-f]{1,4}:){6}(:[0-9a-f]{1,4}|((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9a-f]{1,4}:){5}(((:[0-9a-f]{1,4}){1,2})|:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9a-f]{1,4}:){4}(((:[0-9a-f]{1,4}){1,3})|((:[0-9a-f]{1,4})?:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){3}(((:[0-9a-f]{1,4}){1,4})|((:[0-9a-f]{1,4}){0,2}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){2}(((:[0-9a-f]{1,4}){1,5})|((:[0-9a-f]{1,4}){0,3}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){1}(((:[0-9a-f]{1,4}){1,6})|((:[0-9a-f]{1,4}){0,4}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(:(((:[0-9a-f]{1,4}){1,7})|((:[0-9a-f]{1,4}){0,5}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:)))$/i,
    regex,
    uuid: /^(?:urn:uuid:)?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i,
    "json-pointer": /^(?:\/(?:[^~/]|~0|~1)*)*$/,
    "json-pointer-uri-fragment": /^#(?:\/(?:[a-z0-9_\-.!$&'()*+,;:=@]|%[0-9a-f]{2}|~0|~1)*)*$/i,
    "relative-json-pointer": /^(?:0|[1-9][0-9]*)(?:#|(?:\/(?:[^~/]|~0|~1)*)*)$/,
    byte,
    int32: {
      type: "number",
      validate: validateInt32
    },
    int64: {
      type: "number",
      validate: validateInt64
    },
    float: {
      type: "number",
      validate: validateNumber
    },
    double: {
      type: "number",
      validate: validateNumber
    },
    password: true,
    binary: true
  };
  exports.fastFormats = {
    ...exports.fullFormats,
    date: fmtDef(/^\d\d\d\d-[0-1]\d-[0-3]\d$/, compareDate),
    time: fmtDef(/^(?:[0-2]\d:[0-5]\d:[0-5]\d|23:59:60)(?:\.\d+)?(?:z|[+-]\d\d(?::?\d\d)?)$/i, compareTime),
    "date-time": fmtDef(/^\d\d\d\d-[0-1]\d-[0-3]\dt(?:[0-2]\d:[0-5]\d:[0-5]\d|23:59:60)(?:\.\d+)?(?:z|[+-]\d\d(?::?\d\d)?)$/i, compareDateTime),
    "iso-time": fmtDef(/^(?:[0-2]\d:[0-5]\d:[0-5]\d|23:59:60)(?:\.\d+)?(?:z|[+-]\d\d(?::?\d\d)?)?$/i, compareIsoTime),
    "iso-date-time": fmtDef(/^\d\d\d\d-[0-1]\d-[0-3]\d[t\s](?:[0-2]\d:[0-5]\d:[0-5]\d|23:59:60)(?:\.\d+)?(?:z|[+-]\d\d(?::?\d\d)?)?$/i, compareIsoDateTime),
    uri: /^(?:[a-z][a-z0-9+\-.]*:)(?:\/?\/)?[^\s]*$/i,
    "uri-reference": /^(?:(?:[a-z][a-z0-9+\-.]*:)?\/?\/)?(?:[^\\\s#][^\s#]*)?(?:#[^\\\s]*)?$/i,
    email: /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i
  };
  exports.formatNames = Object.keys(exports.fullFormats);
  function isLeapYear(year) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  }
  const DATE = /^(\d\d\d\d)-(\d\d)-(\d\d)$/;
  const DAYS = [
    0,
    31,
    28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31
  ];
  function date(str) {
    const matches = DATE.exec(str);
    if (!matches) return false;
    const year = +matches[1];
    const month = +matches[2];
    const day = +matches[3];
    return month >= 1 && month <= 12 && day >= 1 && day <= (month === 2 && isLeapYear(year) ? 29 : DAYS[month]);
  }
  function compareDate(d1, d2) {
    if (!(d1 && d2)) return void 0;
    if (d1 > d2) return 1;
    if (d1 < d2) return -1;
    return 0;
  }
  const TIME = /^(\d\d):(\d\d):(\d\d(?:\.\d+)?)(z|([+-])(\d\d)(?::?(\d\d))?)?$/i;
  function getTime(strictTimeZone) {
    return function time(str) {
      const matches = TIME.exec(str);
      if (!matches) return false;
      const hr = +matches[1];
      const min = +matches[2];
      const sec = +matches[3];
      const tz = matches[4];
      const tzSign = matches[5] === "-" ? -1 : 1;
      const tzH = +(matches[6] || 0);
      const tzM = +(matches[7] || 0);
      if (tzH > 23 || tzM > 59 || strictTimeZone && !tz) return false;
      if (hr <= 23 && min <= 59 && sec < 60) return true;
      const utcMin = min - tzM * tzSign;
      const utcHr = hr - tzH * tzSign - (utcMin < 0 ? 1 : 0);
      return (utcHr === 23 || utcHr === -1) && (utcMin === 59 || utcMin === -1) && sec < 61;
    };
  }
  function compareTime(s1, s2) {
    if (!(s1 && s2)) return void 0;
    const t1 = (/* @__PURE__ */ new Date("2020-01-01T" + s1)).valueOf();
    const t2 = (/* @__PURE__ */ new Date("2020-01-01T" + s2)).valueOf();
    if (!(t1 && t2)) return void 0;
    return t1 - t2;
  }
  function compareIsoTime(t1, t2) {
    if (!(t1 && t2)) return void 0;
    const a1 = TIME.exec(t1);
    const a2 = TIME.exec(t2);
    if (!(a1 && a2)) return void 0;
    t1 = a1[1] + a1[2] + a1[3];
    t2 = a2[1] + a2[2] + a2[3];
    if (t1 > t2) return 1;
    if (t1 < t2) return -1;
    return 0;
  }
  const DATE_TIME_SEPARATOR = /t|\s/i;
  function getDateTime(strictTimeZone) {
    const time = getTime(strictTimeZone);
    return function date_time(str) {
      const dateTime = str.split(DATE_TIME_SEPARATOR);
      return dateTime.length === 2 && date(dateTime[0]) && time(dateTime[1]);
    };
  }
  function compareDateTime(dt1, dt2) {
    if (!(dt1 && dt2)) return void 0;
    const d1 = new Date(dt1).valueOf();
    const d2 = new Date(dt2).valueOf();
    if (!(d1 && d2)) return void 0;
    return d1 - d2;
  }
  function compareIsoDateTime(dt1, dt2) {
    if (!(dt1 && dt2)) return void 0;
    const [d1, t1] = dt1.split(DATE_TIME_SEPARATOR);
    const [d2, t2] = dt2.split(DATE_TIME_SEPARATOR);
    const res = compareDate(d1, d2);
    if (res === void 0) return void 0;
    return res || compareTime(t1, t2);
  }
  const NOT_URI_FRAGMENT = /\/|:/;
  const URI = /^(?:[a-z][a-z0-9+\-.]*:)(?:\/?\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:]|%[0-9a-f]{2})*@)?(?:\[(?:(?:(?:(?:[0-9a-f]{1,4}:){6}|::(?:[0-9a-f]{1,4}:){5}|(?:[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){4}|(?:(?:[0-9a-f]{1,4}:){0,1}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){3}|(?:(?:[0-9a-f]{1,4}:){0,2}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){2}|(?:(?:[0-9a-f]{1,4}:){0,3}[0-9a-f]{1,4})?::[0-9a-f]{1,4}:|(?:(?:[0-9a-f]{1,4}:){0,4}[0-9a-f]{1,4})?::)(?:[0-9a-f]{1,4}:[0-9a-f]{1,4}|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?))|(?:(?:[0-9a-f]{1,4}:){0,5}[0-9a-f]{1,4})?::[0-9a-f]{1,4}|(?:(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4})?::)|[Vv][0-9a-f]+\.[a-z0-9\-._~!$&'()*+,;=:]+)\]|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)|(?:[a-z0-9\-._~!$&'()*+,;=]|%[0-9a-f]{2})*)(?::\d*)?(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*|\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*)?|(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*)(?:\?(?:[a-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9a-f]{2})*)?(?:#(?:[a-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9a-f]{2})*)?$/i;
  function uri(str) {
    return NOT_URI_FRAGMENT.test(str) && URI.test(str);
  }
  const BYTE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/gm;
  function byte(str) {
    BYTE.lastIndex = 0;
    return BYTE.test(str);
  }
  const MIN_INT32 = -(2 ** 31);
  const MAX_INT32 = 2 ** 31 - 1;
  function validateInt32(value) {
    return Number.isInteger(value) && value <= MAX_INT32 && value >= MIN_INT32;
  }
  function validateInt64(value) {
    return Number.isInteger(value);
  }
  function validateNumber() {
    return true;
  }
  const Z_ANCHOR = /[^\\]\\Z/;
  function regex(str) {
    if (Z_ANCHOR.test(str)) return false;
    try {
      new RegExp(str);
      return true;
    } catch (e) {
      return false;
    }
  }
});
var require_limit = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.formatLimitDefinition = void 0;
  const ajv_1 = require_ajv();
  const codegen_1 = require_codegen();
  const ops = codegen_1.operators;
  const KWDs = {
    formatMaximum: {
      okStr: "<=",
      ok: ops.LTE,
      fail: ops.GT
    },
    formatMinimum: {
      okStr: ">=",
      ok: ops.GTE,
      fail: ops.LT
    },
    formatExclusiveMaximum: {
      okStr: "<",
      ok: ops.LT,
      fail: ops.GTE
    },
    formatExclusiveMinimum: {
      okStr: ">",
      ok: ops.GT,
      fail: ops.LTE
    }
  };
  const error = {
    message: ({ keyword, schemaCode }) => (0, codegen_1.str)`should be ${KWDs[keyword].okStr} ${schemaCode}`,
    params: ({ keyword, schemaCode }) => (0, codegen_1._)`{comparison: ${KWDs[keyword].okStr}, limit: ${schemaCode}}`
  };
  exports.formatLimitDefinition = {
    keyword: Object.keys(KWDs),
    type: "string",
    schemaType: "string",
    $data: true,
    error,
    code(cxt) {
      const { gen, data, schemaCode, keyword, it } = cxt;
      const { opts, self } = it;
      if (!opts.validateFormats) return;
      const fCxt = new ajv_1.KeywordCxt(it, self.RULES.all.format.definition, "format");
      if (fCxt.$data) validate$DataFormat();
      else validateFormat();
      function validate$DataFormat() {
        const fmts = gen.scopeValue("formats", {
          ref: self.formats,
          code: opts.code.formats
        });
        const fmt = gen.const("fmt", (0, codegen_1._)`${fmts}[${fCxt.schemaCode}]`);
        cxt.fail$data((0, codegen_1.or)((0, codegen_1._)`typeof ${fmt} != "object"`, (0, codegen_1._)`${fmt} instanceof RegExp`, (0, codegen_1._)`typeof ${fmt}.compare != "function"`, compareCode(fmt)));
      }
      function validateFormat() {
        const format = fCxt.schema;
        const fmtDef = self.formats[format];
        if (!fmtDef || fmtDef === true) return;
        if (typeof fmtDef != "object" || fmtDef instanceof RegExp || typeof fmtDef.compare != "function") throw new Error(`"${keyword}": format "${format}" does not define "compare" function`);
        const fmt = gen.scopeValue("formats", {
          key: format,
          ref: fmtDef,
          code: opts.code.formats ? (0, codegen_1._)`${opts.code.formats}${(0, codegen_1.getProperty)(format)}` : void 0
        });
        cxt.fail$data(compareCode(fmt));
      }
      function compareCode(fmt) {
        return (0, codegen_1._)`${fmt}.compare(${data}, ${schemaCode}) ${KWDs[keyword].fail} 0`;
      }
    },
    dependencies: ["format"]
  };
  const formatLimitPlugin = (ajv) => {
    ajv.addKeyword(exports.formatLimitDefinition);
    return ajv;
  };
  exports.default = formatLimitPlugin;
});
var require_dist = /* @__PURE__ */ __commonJSMin((exports, module) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const formats_1 = require_formats();
  const limit_1 = require_limit();
  const codegen_1 = require_codegen();
  const fullName = new codegen_1.Name("fullFormats");
  const fastName = new codegen_1.Name("fastFormats");
  const formatsPlugin = (ajv, opts = { keywords: true }) => {
    if (Array.isArray(opts)) {
      addFormats2(ajv, opts, formats_1.fullFormats, fullName);
      return ajv;
    }
    const [formats, exportName] = opts.mode === "fast" ? [formats_1.fastFormats, fastName] : [formats_1.fullFormats, fullName];
    addFormats2(ajv, opts.formats || formats_1.formatNames, formats, exportName);
    if (opts.keywords) (0, limit_1.default)(ajv);
    return ajv;
  };
  formatsPlugin.get = (name, mode = "full") => {
    const f = (mode === "fast" ? formats_1.fastFormats : formats_1.fullFormats)[name];
    if (!f) throw new Error(`Unknown format "${name}"`);
    return f;
  };
  function addFormats2(ajv, list, fs, exportName) {
    var _a;
    var _b;
    (_a = (_b = ajv.opts.code).formats) !== null && _a !== void 0 || (_b.formats = (0, codegen_1._)`require("ajv-formats/dist/formats").${exportName}`);
    for (const f of list) ajv.addFormat(f, fs[f]);
  }
  module.exports = exports = formatsPlugin;
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.default = formatsPlugin;
});
var import_ajv = require_ajv();
var import__2019 = require__2019();
var import__2020 = require__2020();
var import_dist = /* @__PURE__ */ __toESM(require_dist(), 1);
var addFormats = import_dist.default;
function createDefaultAjvInstance(engineClass) {
  const ajv = new engineClass({
    strict: false,
    validateFormats: true,
    validateSchema: false,
    allErrors: true
  });
  addFormats(ajv);
  return ajv;
}
var AjvJsonSchemaValidator = class {
  _ajv;
  /** Lazy classic (draft-07) engine, built on the first draft-07/draft-06-declared schema. */
  _ajvDraft7;
  /** Lazy 2019-09 engine, built on the first 2019-09-declared schema. */
  _ajv2019;
  /** True iff the constructor received a caller-supplied engine; the `$schema` dispatch is skipped. */
  _userAjv;
  /**
  * @param ajv - Optional pre-configured AJV-compatible instance. When supplied, this instance is
  * used for **every** schema regardless of its declared `$schema` (the caller owns dialect
  * choice). When omitted, the provider constructs per-dialect engines (`Ajv2020`, `Ajv2019`,
  * and the classic draft-07 `Ajv` for draft-07/06-declared schemas) with
  * `strict: false`, `validateFormats: true`, `validateSchema: false`, `allErrors: true`, and
  * `ajv-formats` registered — **lazily, on the first {@linkcode getValidator} call needing each**, so
  * constructing the provider (e.g. as the default validator of a `Client`/`Server` that never
  * validates a JSON Schema) does not pay the ajv + ajv-formats instantiation cost. The parameter
  * is typed structurally so consumers who don't pass an instance need not have `ajv` installed.
  */
  constructor(ajv) {
    this._userAjv = ajv !== void 0;
    this._ajv = ajv;
  }
  /** The underlying 2020-12 engine — the default instance is created on first use. */
  get ajv() {
    return this._ajv ??= createDefaultAjvInstance(import__2020.Ajv2020);
  }
  /**
  * Pick the engine for a schema's declared dialect. A caller-supplied engine is used for
  * every schema — do not second-guess by `$schema` (bring-your-own-validator means
  * bring-your-own-dialect). Otherwise: no `$schema` or 2020-12 → `Ajv2020`; 2019-09 →
  * `Ajv2019`; draft-07 or draft-06 → classic `Ajv`; anything else → `Error`.
  */
  _engineFor(schema) {
    if (this._userAjv) return this.ajv;
    const dialect = declaredDialect(schema, "pass a pre-configured Ajv instance to AjvJsonSchemaValidator(ajv) to validate other dialects.");
    if (dialect === "2020-12") return this.ajv;
    if (dialect === "2019-09") return this._ajv2019 ??= createDefaultAjvInstance(import__2019.Ajv2019);
    return this._ajvDraft7 ??= createDefaultAjvInstance(import_ajv.Ajv);
  }
  getValidator(schema) {
    const engine = this._engineFor(schema);
    const ajvValidator = "$id" in schema && typeof schema.$id === "string" ? engine.getSchema(schema.$id) ?? engine.compile(schema) : engine.compile(schema);
    return (input) => {
      return ajvValidator(input) ? {
        valid: true,
        data: input,
        errorMessage: void 0
      } : {
        valid: false,
        data: void 0,
        errorMessage: engine.errorsText(ajvValidator.errors)
      };
    };
  }
};
var Ajv = import_ajv.Ajv;

// ../../node_modules/@modelcontextprotocol/server/dist/shimsNode.mjs
import process2 from "node:process";

// ../../node_modules/@modelcontextprotocol/server/dist/mcp-DXXb3Vv3.mjs
var COMPLETABLE_SYMBOL = Symbol.for("mcp.completable");
var DEFAULT_SSE_KEEP_ALIVE_MS = 15e3;
var MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
function armSseKeepAlive(intervalMs, onTick) {
  if (!Number.isFinite(intervalMs) || intervalMs < 1) return;
  const timer = setInterval(onTick, Math.min(intervalMs, MAX_TIMER_DELAY_MS));
  timer.unref?.();
  return timer;
}
var DEFAULT_LEGACY_SHIM_MAX_ROUNDS = 8;
var DEFAULT_LEGACY_SHIM_ROUND_TIMEOUT_MS = 6e5;
function resolveLegacyShimOptions(options) {
  if (options?.maxRounds !== void 0 && (!Number.isInteger(options.maxRounds) || options.maxRounds < 1)) throw new RangeError(`inputRequired.maxRounds must be a positive integer (got ${options.maxRounds})`);
  if (options?.roundTimeoutMs !== void 0 && (!Number.isFinite(options.roundTimeoutMs) || options.roundTimeoutMs <= 0)) throw new RangeError(`inputRequired.roundTimeoutMs must be a positive number (got ${options.roundTimeoutMs})`);
  return {
    maxRounds: options?.maxRounds ?? DEFAULT_LEGACY_SHIM_MAX_ROUNDS,
    roundTimeoutMs: options?.roundTimeoutMs ?? DEFAULT_LEGACY_SHIM_ROUND_TIMEOUT_MS,
    legacyShim: options?.legacyShim ?? true
  };
}
function coerceEmbeddedInputRequest(method, key, entry) {
  if (entry === null || typeof entry !== "object" || typeof entry.method !== "string") throw new ProtocolError(ProtocolErrorCode.InternalError, `Handler for ${method} returned an invalid input request '${key}': each inputRequests entry must be an embedded elicitation/create, sampling/createMessage, or roots/list request`);
  const embedded = entry;
  const required = requiredClientCapabilitiesForInputRequest(embedded);
  if (required === void 0) throw new ProtocolError(ProtocolErrorCode.InternalError, `Handler for ${method} returned an input request '${key}' of kind '${embedded.method}', which is not an embedded request the 2026-07-28 revision defines`);
  return {
    embedded,
    required
  };
}
function syntheticElicitationId() {
  const webCrypto = globalThis.crypto;
  if (webCrypto?.randomUUID !== void 0) return webCrypto.randomUUID();
  const bytes = new Uint8Array(16);
  webCrypto.getRandomValues(bytes);
  bytes[6] = bytes[6] & 15 | 64;
  bytes[8] = bytes[8] & 63 | 128;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function legacyShimFailure(method, message) {
  if (method === "tools/call") return {
    content: [{
      type: "text",
      text: message
    }],
    isError: true
  };
  throw new ProtocolError(ProtocolErrorCode.InternalError, message);
}
var LegacyInputRequiredShim = class {
  constructor(_host) {
    this._host = _host;
  }
  async fulfill(method, handler, request, ctx, firstResult) {
    const { maxRounds, roundTimeoutMs } = this._host;
    const outerSignal = ctx.mcpReq.signal;
    let current = firstResult;
    let round = 0;
    while (true) {
      round += 1;
      if (round > maxRounds) return legacyShimFailure(method, inputRequiredRoundsExceededMessage(method, maxRounds));
      const inputRequests = current.inputRequests;
      const hasInputRequests = inputRequests != null && Object.keys(inputRequests).length > 0;
      const requestState = typeof current.requestState === "string" ? current.requestState : void 0;
      if (!hasInputRequests && requestState === void 0) throw new ProtocolError(ProtocolErrorCode.InternalError, `Handler for ${method} returned an input-required result with neither inputRequests nor requestState (every InputRequiredResult must include at least one of the two)`);
      let responses;
      if (hasInputRequests) {
        const declared = this._host.resolvedClientCapabilities(ctx);
        const coerced = [];
        for (const [key, entry] of Object.entries(inputRequests)) {
          const { embedded, required } = coerceEmbeddedInputRequest(method, key, entry);
          if (embedded.method !== "roots/list" && embedded.params === void 0) throw new ProtocolError(ProtocolErrorCode.InternalError, `Handler for ${method} returned an input request '${key}' of kind '${embedded.method}' without params`);
          if (missingClientCapabilities(required, declared) !== void 0) return legacyShimFailure(method, `Cannot request input '${key}' (${embedded.method}): the client on this 2025-era connection did not declare the required capability${declared === void 0 ? " (no client capabilities are available on this connection \u2014 per-request legacy serving cannot receive server-to-client requests)" : ""}`);
          coerced.push([key, embedded]);
        }
        const roundAbort = linkedRoundAbort(outerSignal);
        try {
          const legOptions = {
            relatedRequestId: ctx.mcpReq.id,
            timeout: roundTimeoutMs,
            resetTimeoutOnProgress: true,
            onprogress: () => {
            },
            signal: roundAbort.signal
          };
          const fulfilled = await Promise.all(coerced.map(async ([key, embedded]) => {
            try {
              return [key, await this._dispatchLeg(embedded, legOptions)];
            } catch (error) {
              roundAbort.abort(error);
              throw error;
            }
          }));
          responses = Object.fromEntries(fulfilled);
        } catch (error) {
          if (outerSignal.aborted) throw error;
          return legacyShimFailure(method, `Fulfilling input required by '${method}' failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          roundAbort.dispose();
        }
      } else await sleep2(REQUEST_STATE_ONLY_LEG_PACING_MS, outerSignal);
      let ctxNext = {
        ...ctx,
        mcpReq: {
          ...ctx.mcpReq,
          inputResponses: responses,
          droppedInputResponseKeys: void 0,
          requestState: requestStateAccessor(requestState)
        }
      };
      if (requestState !== void 0) {
        const decoded = await this._host.verifyRequestState(requestState, ctxNext, method);
        if (decoded !== void 0) ctxNext = withRequestStateValue(ctxNext, decoded);
      }
      const next = await handler(request, ctxNext);
      if (!isInputRequiredResult(next)) return next;
      current = next;
    }
  }
  /** Routes one embedded request through the host's existing 2025-era senders (gate already ran). */
  async _dispatchLeg(embedded, options) {
    switch (embedded.method) {
      case "elicitation/create": {
        let params = embedded.params;
        if (params.mode === "url" && params.elicitationId === void 0) params = {
          ...params,
          elicitationId: syntheticElicitationId()
        };
        return await this._host.sendElicitation(params, options);
      }
      case "sampling/createMessage":
        return await this._host.sendSampling(embedded.params, options);
      case "roots/list":
        return await this._host.listRoots(embedded.params, options);
    }
  }
};
var INPUT_REQUIRED_CAPABLE_METHODS = /* @__PURE__ */ new Set([
  "tools/call",
  "prompts/get",
  "resources/read"
]);
var writeClientIdentity;
var installDiscoverHandler;
var readServerIdentity;
var Server = class extends Protocol {
  _clientCapabilities;
  _clientVersion;
  static {
    writeClientIdentity = (server, identity) => {
      if (identity.clientCapabilities !== void 0) server._clientCapabilities = identity.clientCapabilities;
      if (identity.clientInfo !== void 0) server._clientVersion = identity.clientInfo;
    };
    installDiscoverHandler = (server, servedModernVersions) => {
      const missing = servedModernVersions.filter((version) => !server._supportedProtocolVersions.includes(version));
      if (missing.length > 0) server._supportedProtocolVersions = [...server._supportedProtocolVersions, ...missing];
      server.setRequestHandler("server/discover", () => server._ondiscover());
    };
    readServerIdentity = (server) => server._serverInfo;
  }
  _capabilities;
  _instructions;
  _jsonSchemaValidator;
  _cacheHints;
  _requestStateVerify;
  _inputRequiredServing;
  _legacyShim;
  /** Lazily-built legacy shim; the loop lives in legacyInputRequiredShim.ts behind a narrow host contract. */
  _legacyInputRequiredShim() {
    return this._legacyShim ??= new LegacyInputRequiredShim({
      maxRounds: this._inputRequiredServing.maxRounds,
      roundTimeoutMs: this._inputRequiredServing.roundTimeoutMs,
      resolvedClientCapabilities: (ctx) => this._inputRequestCapabilityView(ctx),
      verifyRequestState: (state, ctx, method) => this._verifyRequestState(state, ctx, method),
      sendElicitation: (params, options) => this._sendElicitationLeg(params, options, { validateAcceptedContent: false }),
      sendSampling: (params, options) => this.createMessage(params, options),
      listRoots: (params, options) => this.listRoots(params, options)
    });
  }
  /**
  * Callback for when initialization has fully completed (i.e., the client has sent an `notifications/initialized` notification).
  */
  oninitialized;
  /**
  * Initializes this server with the given name and version information.
  */
  constructor(_serverInfo, options) {
    super(options);
    this._serverInfo = _serverInfo;
    this._capabilities = options?.capabilities ? { ...options.capabilities } : {};
    this._instructions = options?.instructions;
    this._jsonSchemaValidator = options?.jsonSchemaValidator ?? new AjvJsonSchemaValidator();
    this._requestStateVerify = options?.requestState?.verify;
    this._inputRequiredServing = resolveLegacyShimOptions(options?.inputRequired);
    if (options?.cacheHints !== void 0) {
      for (const [operation, hint] of Object.entries(options.cacheHints)) if (hint !== void 0) assertValidCacheHint(hint, `cacheHints['${operation}']`);
      this._cacheHints = options.cacheHints;
    }
    this.setRequestHandler("initialize", (request) => this._oninitialize(request));
    this.setNotificationHandler("notifications/initialized", () => this.oninitialized?.());
    if (modernProtocolVersions(this._supportedProtocolVersions).length > 0) this.setRequestHandler("server/discover", () => this._ondiscover());
    if (this._capabilities.logging) this._registerLoggingHandler();
  }
  /**
  * Registers the built-in `logging/setLevel` request handler.
  *
  * @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577).
  * Remains functional during the deprecation window (at least twelve months).
  * Migrate to stderr logging (STDIO servers) or OpenTelemetry.
  */
  _registerLoggingHandler() {
    this.setRequestHandler("logging/setLevel", async (request, ctx) => {
      const transportSessionId = ctx.sessionId || ctx.http?.req?.headers.get("mcp-session-id") || void 0;
      const { level } = request.params;
      const parseResult = parseSchema(LoggingLevelSchema, level);
      if (parseResult.success) this._loggingLevels.set(transportSessionId, parseResult.data);
      return {};
    });
  }
  buildContext(ctx, transportInfo) {
    const hasHttpInfo = ctx.http || transportInfo?.request || transportInfo?.closeSSEStream || transportInfo?.closeStandaloneSSEStream;
    return {
      ...ctx,
      mcpReq: {
        ...ctx.mcpReq,
        log: (level, data, logger) => {
          if (!this._capabilities.logging) return Promise.resolve();
          let threshold;
          if (this._servedModernEra()) {
            threshold = ctx.mcpReq.envelope?.[LOG_LEVEL_META_KEY];
            if (threshold === void 0) return Promise.resolve();
          } else threshold = this._loggingLevels.get(ctx.sessionId) ?? this._loggingLevels.get(void 0);
          if (threshold !== void 0 && this.LOG_LEVEL_SEVERITY.get(level) < this.LOG_LEVEL_SEVERITY.get(threshold)) return Promise.resolve();
          return ctx.mcpReq.notify({
            method: "notifications/message",
            params: {
              level,
              data,
              logger
            }
          });
        },
        elicitInput: (params, options) => this.elicitInput(params, options),
        requestSampling: (params, options) => this.createMessage(params, options)
      },
      http: hasHttpInfo ? {
        ...ctx.http,
        req: transportInfo?.request,
        closeSSE: transportInfo?.closeSSEStream,
        closeStandaloneSSE: transportInfo?.closeStandaloneSSEStream
      } : void 0
    };
  }
  _loggingLevels = /* @__PURE__ */ new Map();
  LOG_LEVEL_SEVERITY = new Map(LoggingLevelSchema.options.map((level, index) => [level, index]));
  isMessageIgnored = (level, sessionId) => {
    const currentLevel = this._loggingLevels.get(sessionId);
    return currentLevel ? this.LOG_LEVEL_SEVERITY.get(level) < this.LOG_LEVEL_SEVERITY.get(currentLevel) : false;
  };
  /**
  * Registers new capabilities. This can only be called before connecting to a transport.
  *
  * The new capabilities will be merged with any existing capabilities previously given (e.g., at initialization).
  */
  registerCapabilities(capabilities) {
    if (this.transport) throw new SdkError(SdkErrorCode.AlreadyConnected, "Cannot register capabilities after connecting to transport");
    const hadLogging = !!this._capabilities.logging;
    this._capabilities = mergeCapabilities(this._capabilities, capabilities);
    if (!hadLogging && this._capabilities.logging) this._registerLoggingHandler();
  }
  /**
  * Enforces server-side validation for `tools/call` results regardless of how the
  * handler was registered, attaches the configured per-operation cache hint
  * (when one exists) so the 2026-07-28 encode seam can fill `ttlMs`/`cacheScope`
  * for results that do not provide their own, and owns the multi-round-trip
  * seam: on the methods whose 2026-07-28 result vocabulary includes
  * `input_required` (`tools/call`, `prompts/get`, `resources/read`) an
  * input-required return skips result-schema validation and is checked
  * against the served era, the at-least-one rule, and the request's own
  * declared client capabilities; on every other method an input-required
  * return is a server bug and fails loudly. The hint rides a symbol-keyed
  * property that is never serialized, so 2025-era responses are unaffected.
  */
  _wrapHandler(method, handler) {
    if (method !== "tools/call") {
      const cacheHint = this._cacheHints?.[method];
      const isInputRequiredCapable = INPUT_REQUIRED_CAPABLE_METHODS.has(method);
      if (cacheHint === void 0 && !isInputRequiredCapable) return async (request, ctx) => {
        const result = await handler(request, ctx);
        if (isInputRequiredResult(result)) throw new ProtocolError(ProtocolErrorCode.InternalError, `Handler for ${method} returned an input-required result, but only tools/call, prompts/get and resources/read support input_required (protocol revision 2026-07-28)`);
        return result;
      };
      return async (request, ctx) => {
        const result = isInputRequiredCapable ? await this._invokeInputRequiredCapableHandler(method, handler, request, ctx) : await handler(request, ctx);
        if (isInputRequiredResult(result)) {
          if (!isInputRequiredCapable) throw new ProtocolError(ProtocolErrorCode.InternalError, `Handler for ${method} returned an input-required result, but only tools/call, prompts/get and resources/read support input_required (protocol revision 2026-07-28)`);
          return result;
        }
        return cacheHint === void 0 ? result : attachCacheHintFallback(result, cacheHint);
      };
    }
    return async (request, ctx) => {
      const codec = codecForVersion(this._negotiatedProtocolVersion);
      const validatedRequest = codec.validateRequest("tools/call", request);
      if (!validatedRequest.ok) throw new ProtocolError(validatedRequest.reason === "not-in-era" ? ProtocolErrorCode.InternalError : ProtocolErrorCode.InvalidParams, validatedRequest.reason === "not-in-era" ? "No wire schema for tools/call in the resolved era" : `Invalid tools/call request: ${validatedRequest.message}`);
      const result = await this._invokeInputRequiredCapableHandler("tools/call", handler, request, ctx);
      if (isInputRequiredResult(result)) return result;
      const normalizedResult = normalizeContentlessToolResult(result);
      const validationResult = codec.validateResult("tools/call", normalizedResult);
      if (!validationResult.ok) throw new ProtocolError(validationResult.reason === "not-in-era" ? ProtocolErrorCode.InternalError : ProtocolErrorCode.InvalidParams, validationResult.reason === "not-in-era" ? "No wire schema for tools/call in the resolved era" : `Invalid tools/call result: ${validationResult.message}`);
      return validationResult.value;
    };
  }
  /**
  * Whether this instance is bound to a 2026-07-28-or-later protocol
  * revision. Era is instance state — a serving entry (`createMcpHandler`,
  * `serveStdio`) marks the instance modern at construction; a 2025-era
  * `initialize` handshake binds it legacy. The multi-round-trip seam reads
  * this directly: there is no per-request era consult.
  */
  _servedModernEra() {
    return this._negotiatedProtocolVersion !== void 0 && isModernProtocolVersion(this._negotiatedProtocolVersion);
  }
  /**
  * Invokes a handler for one of the multi-round-trip methods and applies
  * the input-required seam:
  *
  * - a `UrlElicitationRequiredError` (or any 2025-style server→client
  *   request idiom) escaping the handler on a request served on the
  *   2026-07-28 era fails LOUDLY with a clear steer to
  *   `inputRequired.elicitUrl(...)` — the `-32042` error never reaches the
  *   2026-07-28 wire and the throw is not silently converted. Requests
  *   served on the 2025 era keep today's `-32042` behavior byte-exact (the
  *   error is rethrown unchanged).
  * - an input-required RETURN toward a 2026-07-28 request must satisfy
  *   the at-least-one rule, and every embedded request must be covered by
  *   the capabilities declared on the request's envelope (violations
  *   answer the typed `-32021` error). Toward a 2025-era request the
  *   return is fulfilled by the default-on legacy shim, whose own gate
  *   consults the initialize-declared capabilities and surfaces
  *   violations per family; `inputRequired.legacyShim: false` restores
  *   the pre-shim loud failure.
  */
  async _invokeInputRequiredCapableHandler(method, handler, request, ctx) {
    const servedModern = this._servedModernEra();
    const rawRequestState = ctx.mcpReq.requestState();
    if (rawRequestState !== void 0 && typeof rawRequestState !== "string") throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Invalid or expired requestState", { reason: "invalid_request_state" });
    let ctxForHandler = ctx;
    if (typeof rawRequestState === "string") {
      const decoded = await this._verifyRequestState(rawRequestState, ctx, method);
      if (decoded !== void 0) ctxForHandler = withRequestStateValue(ctx, decoded);
    }
    let result;
    try {
      result = await handler(request, ctxForHandler);
    } catch (error) {
      if (error instanceof ProtocolError && error.code === ProtocolErrorCode.UrlElicitationRequired) {
        if (!servedModern) throw error;
        throw new ProtocolError(ProtocolErrorCode.InternalError, `URL elicitation cannot be signalled by throwing UrlElicitationRequiredError on protocol revision ${this._negotiatedProtocolVersion}: return inputRequired({ inputRequests: { \u2026: inputRequired.elicitUrl(...) } }) from the handler instead. The urlElicitationRequired error (-32042) of earlier revisions is not available on this revision.`);
      }
      throw error;
    }
    if (!isInputRequiredResult(result)) return result;
    if (!servedModern) {
      if (!this._inputRequiredServing.legacyShim) throw new ProtocolError(ProtocolErrorCode.InternalError, `Handler for ${method} returned an input-required result, but this request is served on protocol revision ${this._negotiatedProtocolVersion ?? LATEST_PROTOCOL_VERSION}, which has no input_required vocabulary`);
      return await this._legacyInputRequiredShim().fulfill(method, handler, request, ctxForHandler, result);
    }
    const inputRequests = result.inputRequests;
    const hasInputRequests = inputRequests != null && Object.keys(inputRequests).length > 0;
    const hasRequestState = typeof result.requestState === "string";
    if (!hasInputRequests && !hasRequestState) throw new ProtocolError(ProtocolErrorCode.InternalError, `Handler for ${method} returned an input-required result with neither inputRequests nor requestState (every InputRequiredResult must include at least one of the two)`);
    if (hasInputRequests) {
      const declared = this._inputRequestCapabilityView(ctx);
      for (const [key, entry] of Object.entries(inputRequests)) {
        const { embedded, required } = coerceEmbeddedInputRequest(method, key, entry);
        const missing = missingClientCapabilities(required, declared);
        if (missing !== void 0) throw new MissingRequiredClientCapabilityError({ requiredCapabilities: missing }, `Cannot request input '${key}' (${embedded.method}): the request's client capabilities do not declare the required capability`);
      }
    }
    return result;
  }
  /**
  * Runs the configured `requestState.verify` hook and returns its
  * resolved value (`undefined` when unconfigured or the hook returns
  * nothing). Deny-on-error: any hook failure answers the frozen `-32602`;
  * the reason goes to `onerror` only.
  */
  async _verifyRequestState(state, ctx, method) {
    if (this._requestStateVerify === void 0) return;
    try {
      return await this._requestStateVerify(state, ctx);
    } catch (error) {
      this.onerror?.(/* @__PURE__ */ new Error(`requestState verification rejected ${method}: ${error instanceof Error ? error.message : String(error)}`));
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Invalid or expired requestState", { reason: "invalid_request_state" });
    }
  }
  /**
  * The per-request resolved client-capabilities view: the request's own
  * `_meta` envelope on the 2026 era; the `initialize`-declared state on a
  * 2025-era connection. Per-request instances that never saw an
  * initialize (stateless legacy) hold nothing, so gates refuse there.
  */
  _inputRequestCapabilityView(ctx) {
    return this._servedModernEra() ? ctx.mcpReq.envelope?.[CLIENT_CAPABILITIES_META_KEY] : this._clientCapabilities;
  }
  /**
  * Guard for the push-style server→client request APIs ({@linkcode createMessage},
  * {@linkcode elicitInput}, {@linkcode listRoots}, {@linkcode ping}) on a
  * modern-era instance: the 2026-07-28 revision has no server→client request
  * channel, so the call fails before any wire traffic with a typed error
  * whose message steers to `inputRequired(...)`. The base era gate would
  * also reject it; this guard runs first to carry the steer.
  */
  _assertPushApiInServedEra(method) {
    if (this._servedModernEra()) throw new SdkError(SdkErrorCode.MethodNotSupportedByProtocolVersion, `Server-to-client requests are not available on protocol revision ${this._negotiatedProtocolVersion}: '${method}' cannot be sent while serving a request on that revision. Return inputRequired({ ... }) from the handler instead \u2014 the client fulfils the embedded requests and retries the original request (multi round-trip requests).`, {
      method,
      era: "2026-07-28"
    });
  }
  assertCapabilityForMethod(method) {
    switch (method) {
      case "sampling/createMessage":
        if (!this._clientCapabilities?.sampling) throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Client does not support sampling (required for ${method})`);
        break;
      case "elicitation/create":
        if (!this._clientCapabilities?.elicitation) throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Client does not support elicitation (required for ${method})`);
        break;
      case "roots/list":
        if (!this._clientCapabilities?.roots) throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Client does not support listing roots (required for ${method})`);
        break;
      case "ping":
        break;
    }
  }
  assertNotificationCapability(method) {
    switch (method) {
      case "notifications/message":
        if (!this._capabilities.logging) throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support logging (required for ${method})`);
        break;
      case "notifications/resources/updated":
      case "notifications/resources/list_changed":
        if (!this._capabilities.resources) throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support notifying about resources (required for ${method})`);
        break;
      case "notifications/tools/list_changed":
        if (!this._capabilities.tools) throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support notifying of tool list changes (required for ${method})`);
        break;
      case "notifications/prompts/list_changed":
        if (!this._capabilities.prompts) throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support notifying of prompt list changes (required for ${method})`);
        break;
      case "notifications/elicitation/complete":
        if (!this._clientCapabilities?.elicitation?.url) throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Client does not support URL elicitation (required for ${method})`);
        break;
      case "notifications/cancelled":
        break;
      case "notifications/progress":
        break;
    }
  }
  assertRequestHandlerCapability(method) {
    switch (method) {
      case "completion/complete":
        if (!this._capabilities.completions) throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support completions (required for ${method})`);
        break;
      case "logging/setLevel":
        if (!this._capabilities.logging) throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support logging (required for ${method})`);
        break;
      case "prompts/get":
      case "prompts/list":
        if (!this._capabilities.prompts) throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support prompts (required for ${method})`);
        break;
      case "resources/list":
      case "resources/templates/list":
      case "resources/read":
        if (!this._capabilities.resources) throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support resources (required for ${method})`);
        break;
      case "tools/call":
      case "tools/list":
        if (!this._capabilities.tools) throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support tools (required for ${method})`);
        break;
      case "ping":
      case "initialize":
        break;
    }
  }
  async _oninitialize(request) {
    const requestedVersion = request.params.protocolVersion;
    this._clientCapabilities = request.params.capabilities;
    this._clientVersion = request.params.clientInfo;
    const legacyVersions = legacyProtocolVersions(this._supportedProtocolVersions);
    const protocolVersion = legacyVersions.includes(requestedVersion) ? requestedVersion : legacyVersions[0] ?? LATEST_PROTOCOL_VERSION;
    this._negotiatedProtocolVersion = protocolVersion;
    this.transport?.setProtocolVersion?.(protocolVersion);
    return {
      protocolVersion,
      capabilities: this.getCapabilities(),
      serverInfo: this._serverInfo,
      ...this._instructions && { instructions: this._instructions }
    };
  }
  /**
  * Answers `server/discover` (protocol revision 2026-07-28). `supportedVersions`
  * lists only modern revisions (2025-era versions are negotiated via `initialize`);
  * the capabilities are advertised as-is, listChanged/subscribe bits included
  * (see {@linkcode discoverAdvertisedCapabilities}).
  */
  _ondiscover() {
    return {
      supportedVersions: modernProtocolVersions(this._supportedProtocolVersions),
      capabilities: discoverAdvertisedCapabilities(this.getCapabilities()),
      ...this._instructions && { instructions: this._instructions }
    };
  }
  /**
  * The identity the 2026-era encode seam stamps into every outbound
  * result's `_meta` under `io.modelcontextprotocol/serverInfo` (spec PR
  * #3002: servers SHOULD identify themselves on every response).
  */
  _outboundServerInfo() {
    return this._serverInfo;
  }
  /**
  * After initialization has completed, this will be populated with the client's reported capabilities.
  *
  * @deprecated Read client identity from the per-request handler context instead: on
  * 2026-07-28 (per-request envelope) requests `ctx.mcpReq.envelope` carries the client's
  * declared capabilities, while on 2025-era connections this accessor keeps returning the
  * `initialize`-scoped value. The accessor remains functional — instances serving the
  * 2026-07-28 era are backfilled per request from the validated envelope.
  */
  getClientCapabilities() {
    return this._clientCapabilities;
  }
  /**
  * After initialization has completed, this will be populated with information about the client's name and version.
  *
  * @deprecated Read client identity from the per-request handler context instead: on
  * 2026-07-28 (per-request envelope) requests `ctx.mcpReq.envelope` carries the client's
  * name and version, while on 2025-era connections this accessor keeps returning the
  * `initialize`-scoped value. The accessor remains functional — instances serving the
  * 2026-07-28 era are backfilled per request from the validated envelope.
  */
  getClientVersion() {
    return this._clientVersion;
  }
  /**
  * After initialization has completed, this will be populated with the protocol version negotiated
  * with the client (the version the server responded with during the initialize handshake), or
  * `undefined` before initialization.
  *
  * @deprecated Read the protocol revision from the per-request handler context instead: on
  * 2026-07-28 (per-request envelope) requests `ctx.mcpReq.envelope` names the revision the
  * request was sent for, while on 2025-era connections this accessor keeps returning the
  * `initialize`-negotiated version. The accessor remains functional — instances serving the
  * 2026-07-28 era report that revision.
  */
  getNegotiatedProtocolVersion() {
    return this._negotiatedProtocolVersion;
  }
  /**
  * Project a `tools/call` result through this instance's negotiated wire
  * codec — the era-agnostic SEP-2106 §4.3 TextContent auto-append, plus on
  * the 2025 era the `{result:…}` wrap when `structuredContent` is a
  * non-object value or the advertised `outputSchema` had a non-object root.
  * Identity for object-shaped `structuredContent` on the 2026 era.
  *
  * `McpServer`'s built-in `tools/call` handler routes through this method.
  * Low-level `setRequestHandler('tools/call', …)` authors call it
  * themselves so the projection lives in one place (the codec) and the
  * server-side handler stays era-blind.
  *
  * This is the only codec function exposed on `Server` — the full
  * `WireCodec` is intentionally not part of the public surface.
  */
  projectCallToolResult(result, advertisedOutputSchema) {
    return this._wireCodec().projectCallToolResult(result, advertisedOutputSchema);
  }
  /**
  * Returns the current server capabilities.
  */
  getCapabilities() {
    return this._capabilities;
  }
  /**
  * Sends a `ping` request to the connected client.
  *
  * @deprecated The 2026-07-28 protocol removed ping; it throws on a 2026-07-28-era instance.
  * If your factory serves both eras, this only works on the legacy path.
  */
  async ping() {
    this._assertPushApiInServedEra("ping");
    return this.request({ method: "ping" });
  }
  async createMessage(params, options) {
    this._assertPushApiInServedEra("sampling/createMessage");
    if ((params.tools || params.toolChoice) && !this._clientCapabilities?.sampling?.tools) throw new SdkError(SdkErrorCode.CapabilityNotSupported, "Client does not support sampling tools capability.");
    if (params.messages.length > 0) {
      const lastMessage = params.messages.at(-1);
      const lastContent = Array.isArray(lastMessage.content) ? lastMessage.content : [lastMessage.content];
      const hasToolResults = lastContent.some((c) => c.type === "tool_result");
      const previousMessage = params.messages.length > 1 ? params.messages.at(-2) : void 0;
      const previousContent = previousMessage ? Array.isArray(previousMessage.content) ? previousMessage.content : [previousMessage.content] : [];
      const hasPreviousToolUse = previousContent.some((c) => c.type === "tool_use");
      if (hasToolResults) {
        if (lastContent.some((c) => c.type !== "tool_result")) throw new ProtocolError(ProtocolErrorCode.InvalidParams, "The last message must contain only tool_result content if any is present");
        if (!hasPreviousToolUse) throw new ProtocolError(ProtocolErrorCode.InvalidParams, "tool_result blocks are not matching any tool_use from the previous message");
      }
      if (hasPreviousToolUse) {
        const toolUseIds = new Set(previousContent.filter((c) => c.type === "tool_use").map((c) => c.id));
        const toolResultIds = new Set(lastContent.filter((c) => c.type === "tool_result").map((c) => c.toolUseId));
        if (toolUseIds.size !== toolResultIds.size || ![...toolUseIds].every((id) => toolResultIds.has(id))) throw new ProtocolError(ProtocolErrorCode.InvalidParams, "ids of tool_result blocks and tool_use blocks from previous message do not match");
      }
    }
    const hasTools = Boolean(params.tools || params.toolChoice);
    const wide = await this.request({
      method: "sampling/createMessage",
      params
    }, options);
    const outcome = this._wireCodec().samplingResultVariant(hasTools, wide);
    if (!outcome.ok) throw new SdkError(SdkErrorCode.InvalidResult, `Invalid sampling/createMessage result: ${outcome.reason === "invalid" ? outcome.message : outcome.reason}`);
    return outcome.value;
  }
  /**
  * Creates an elicitation request for the given parameters.
  * For backwards compatibility, `mode` may be omitted for form requests and will default to `"form"`.
  * @param params The parameters for the elicitation request.
  * @param options Optional request options.
  * @returns The result of the elicitation request.
  *
  * @deprecated Throws on a 2026-07-28-era request — use {@link index.inputRequired | inputRequired} (multi-round-trip)
  * instead. The 2025 push-style server-to-client request model is replaced by input_required
  * results in the 2026-07-28 protocol. If your factory serves both eras, this only works on the
  * legacy path.
  */
  async elicitInput(params, options) {
    this._assertPushApiInServedEra("elicitation/create");
    switch (params.mode ?? "form") {
      case "url":
        if (!this._clientCapabilities?.elicitation?.url) throw new SdkError(SdkErrorCode.CapabilityNotSupported, "Client does not support url elicitation.");
        break;
      case "form":
        if (!this._clientCapabilities?.elicitation?.form) throw new SdkError(SdkErrorCode.CapabilityNotSupported, "Client does not support form elicitation.");
        break;
    }
    return this._sendElicitationLeg(params, options);
  }
  /**
  * The capability-check-free core of {@linkcode elicitInput}. The shim
  * uses it because its gate differs from the public checks: a bare
  * `elicitation: {}` counts as form support (the pre-mode rule), and
  * accepted content passes through unvalidated for parity with the
  * modern client driver (handlers validate via the schema-aware
  * `acceptedContent` overload and can re-ask).
  */
  async _sendElicitationLeg(params, options, behavior) {
    const mode = params.mode ?? "form";
    const validateAcceptedContent = behavior?.validateAcceptedContent ?? true;
    switch (mode) {
      case "url": {
        const urlParams = params;
        return this.request({
          method: "elicitation/create",
          params: urlParams
        }, options);
      }
      case "form": {
        const formParams = params.mode === "form" ? params : {
          ...params,
          mode: "form"
        };
        const result = await this.request({
          method: "elicitation/create",
          params: formParams
        }, options);
        if (validateAcceptedContent && result.action === "accept" && result.content && formParams.requestedSchema) try {
          const validationResult = this._jsonSchemaValidator.getValidator(formParams.requestedSchema)(result.content);
          if (!validationResult.valid) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Elicitation response content does not match requested schema: ${validationResult.errorMessage}`);
        } catch (error) {
          if (error instanceof ProtocolError) throw error;
          throw new ProtocolError(ProtocolErrorCode.InternalError, `Error validating elicitation response: ${error instanceof Error ? error.message : String(error)}`);
        }
        return result;
      }
    }
  }
  /**
  * Creates a reusable callback that, when invoked, will send a `notifications/elicitation/complete`
  * notification for the specified elicitation ID.
  *
  * The notification (and the `elicitationId` it references) exists only on protocol revision
  * 2025-11-25 — the 2026-07-28 revision removed both. On a connection negotiated at 2026-07-28 the
  * returned callback rejects with a typed local error before anything reaches the transport
  * (the method is not part of that revision's wire registry).
  *
  * @param elicitationId The ID of the elicitation to mark as complete.
  * @param options Optional notification options. Useful when the completion notification should be related to a prior request.
  * @returns A function that emits the completion notification when awaited.
  */
  createElicitationCompletionNotifier(elicitationId, options) {
    if (!this._clientCapabilities?.elicitation?.url) throw new SdkError(SdkErrorCode.CapabilityNotSupported, "Client does not support URL elicitation (required for notifications/elicitation/complete)");
    return () => this.notification({
      method: "notifications/elicitation/complete",
      params: { elicitationId }
    }, options);
  }
  /**
  * Requests the list of roots from the client.
  *
  * @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577).
  * Throws on a 2026-07-28-era request — use {@link index.inputRequired | inputRequired} (multi-round-trip) instead,
  * or migrate to passing paths via tool parameters, resource URIs, or configuration. The 2025
  * push-style server-to-client request model is replaced by input_required results in the
  * 2026-07-28 protocol. If your factory serves both eras, this only works on the legacy path.
  */
  async listRoots(params, options) {
    this._assertPushApiInServedEra("roots/list");
    return this.request({
      method: "roots/list",
      params
    }, options);
  }
  /**
  * Sends a logging message to the client, if connected.
  * Note: You only need to send the parameters object, not the entire JSON-RPC message.
  * @see {@linkcode LoggingMessageNotification}
  * @param params
  * @param sessionId Optional for stateless transports and backward compatibility.
  *
  * @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577).
  * Remains functional during the deprecation window (at least twelve months).
  * Migrate to stderr logging (STDIO servers) or OpenTelemetry.
  */
  async sendLoggingMessage(params, sessionId) {
    if (this._capabilities.logging && !this.isMessageIgnored(params.level, sessionId)) return this.notification({
      method: "notifications/message",
      params
    });
  }
  async sendResourceUpdated(params) {
    return this.notification({
      method: "notifications/resources/updated",
      params
    });
  }
  async sendResourceListChanged() {
    return this.notification({ method: "notifications/resources/list_changed" });
  }
  async sendToolListChanged() {
    return this.notification({ method: "notifications/tools/list_changed" });
  }
  async sendPromptListChanged() {
    return this.notification({ method: "notifications/prompts/list_changed" });
  }
};
function discoverAdvertisedCapabilities(capabilities) {
  return { ...capabilities };
}

// ../../node_modules/@modelcontextprotocol/server/dist/index.mjs
var WebStandardStreamableHTTPServerTransport = class {
  sessionIdGenerator;
  _started = false;
  _closed = false;
  _streamMapping = /* @__PURE__ */ new Map();
  _requestToStreamMapping = /* @__PURE__ */ new Map();
  _requestResponseMap = /* @__PURE__ */ new Map();
  _initialized = false;
  _enableJsonResponse = false;
  _standaloneSseStreamId = "_GET_stream";
  _eventStore;
  _onsessioninitialized;
  _onsessionclosed;
  _allowedHosts;
  _allowedOrigins;
  _enableDnsRebindingProtection;
  _retryInterval;
  _supportedProtocolVersions;
  _keepAliveMs;
  sessionId;
  onclose;
  onerror;
  onmessage;
  constructor(options = {}) {
    this.sessionIdGenerator = options.sessionIdGenerator;
    this._enableJsonResponse = options.enableJsonResponse ?? false;
    this._eventStore = options.eventStore;
    this._onsessioninitialized = options.onsessioninitialized;
    this._onsessionclosed = options.onsessionclosed;
    this._allowedHosts = options.allowedHosts;
    this._allowedOrigins = options.allowedOrigins;
    this._enableDnsRebindingProtection = options.enableDnsRebindingProtection ?? false;
    this._retryInterval = options.retryInterval;
    this._supportedProtocolVersions = options.supportedProtocolVersions ?? SUPPORTED_PROTOCOL_VERSIONS;
    this._keepAliveMs = options.keepAliveMs ?? DEFAULT_SSE_KEEP_ALIVE_MS;
  }
  startKeepAlive(controller, encoder) {
    if (this._closed) return void 0;
    const timer = armSseKeepAlive(this._keepAliveMs, () => {
      try {
        controller.enqueue(encoder.encode(": keepalive\n\n"));
      } catch {
        if (timer !== void 0) clearInterval(timer);
      }
    });
    return timer;
  }
  /**
  * Starts the transport. This is required by the {@linkcode Transport} interface but is a no-op
  * for the Streamable HTTP transport as connections are managed per-request.
  */
  async start() {
    if (this._started) throw new Error("Transport already started");
    this._started = true;
  }
  /**
  * Sets the supported protocol versions for header validation.
  * Called by the server during {@linkcode server/server.Server.connect | connect()} to pass its supported versions.
  */
  setSupportedProtocolVersions(versions) {
    this._supportedProtocolVersions = versions;
  }
  /**
  * Helper to create a JSON error response
  */
  createJsonErrorResponse(status, code, message, options) {
    const error = {
      code,
      message
    };
    if (options?.data !== void 0) error.data = options.data;
    return Response.json({
      jsonrpc: "2.0",
      error,
      id: null
    }, {
      status,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers
      }
    });
  }
  /**
  * Validates request headers for DNS rebinding protection.
  * @returns Error response if validation fails, `undefined` if validation passes.
  */
  validateRequestHeaders(req) {
    if (!this._enableDnsRebindingProtection) return;
    if (this._allowedHosts && this._allowedHosts.length > 0) {
      const hostHeader = req.headers.get("host");
      if (!hostHeader || !this._allowedHosts.includes(hostHeader)) {
        const error = `Invalid Host header: ${hostHeader}`;
        this.onerror?.(new Error(error));
        return this.createJsonErrorResponse(403, -32e3, error);
      }
    }
    if (this._allowedOrigins && this._allowedOrigins.length > 0) {
      const originHeader = req.headers.get("origin");
      if (originHeader && !this._allowedOrigins.includes(originHeader)) {
        const error = `Invalid Origin header: ${originHeader}`;
        this.onerror?.(new Error(error));
        return this.createJsonErrorResponse(403, -32e3, error);
      }
    }
  }
  /**
  * Handles an incoming HTTP request, whether `GET`, `POST`, or `DELETE`
  * Returns a `Response` object (Web Standard)
  */
  async handleRequest(req, options) {
    if (this._closed) return this.createJsonErrorResponse(404, -32001, "Session not found");
    const validationError = this.validateRequestHeaders(req);
    if (validationError) return validationError;
    switch (req.method) {
      case "POST":
        return this.handlePostRequest(req, options);
      case "GET":
        return this.handleGetRequest(req);
      case "DELETE":
        return this.handleDeleteRequest(req);
      default:
        return this.handleUnsupportedRequest();
    }
  }
  /**
  * Returns true if the client's protocol version supports empty SSE data in
  * priming events (the fix shipped with protocol version `2025-11-25`).
  *
  * The version is checked for membership in this transport instance's
  * supported protocol versions rather than with an open-ended
  * `>= '2025-11-25'` comparison: the value may come from an `initialize`
  * request body, which (unlike the `MCP-Protocol-Version` header) is not
  * validated against `supportedProtocolVersions` before reaching this
  * check. An unknown future version string must not silently enable
  * behavior reserved for versions this transport actually supports.
  */
  supportsEmptySSEData(protocolVersion) {
    return this._supportedProtocolVersions.includes(protocolVersion) && protocolVersion >= "2025-11-25";
  }
  /**
  * Writes a priming event to establish resumption capability.
  * Only sends if `eventStore` is configured (opt-in for resumability) and
  * the client's protocol version supports empty SSE data (a supported
  * version that is >= `2025-11-25`).
  */
  async writePrimingEvent(controller, encoder, streamId, protocolVersion) {
    if (!this._eventStore) return;
    if (!this.supportsEmptySSEData(protocolVersion)) return;
    const primingEventId = await this._eventStore.storeEvent(streamId, {});
    let primingEvent = `id: ${primingEventId}
data: 

`;
    if (this._retryInterval !== void 0) primingEvent = `id: ${primingEventId}
retry: ${this._retryInterval}
data: 

`;
    controller.enqueue(encoder.encode(primingEvent));
  }
  /**
  * Handles `GET` requests for SSE stream
  */
  async handleGetRequest(req) {
    if (!req.headers.get("accept")?.includes("text/event-stream")) {
      this.onerror?.(/* @__PURE__ */ new Error("Not Acceptable: Client must accept text/event-stream"));
      return this.createJsonErrorResponse(406, -32e3, "Not Acceptable: Client must accept text/event-stream");
    }
    const sessionError = this.validateSession(req);
    if (sessionError) return sessionError;
    const protocolError = this.validateProtocolVersion(req);
    if (protocolError) return protocolError;
    if (this._eventStore) {
      const lastEventId = req.headers.get("last-event-id");
      if (lastEventId) return this.replayEvents(lastEventId);
    }
    if (this._streamMapping.get(this._standaloneSseStreamId) !== void 0) {
      this.onerror?.(/* @__PURE__ */ new Error("Conflict: Only one SSE stream is allowed per session"));
      return this.createJsonErrorResponse(409, -32e3, "Conflict: Only one SSE stream is allowed per session");
    }
    const encoder = new TextEncoder();
    let streamController;
    let keepAliveTimer;
    const readable = new ReadableStream({
      start: (controller) => {
        streamController = controller;
      },
      cancel: () => {
        if (keepAliveTimer !== void 0) clearInterval(keepAliveTimer);
        if (this._streamMapping.get(this._standaloneSseStreamId)?.controller === streamController) this._streamMapping.delete(this._standaloneSseStreamId);
      }
    });
    const headers = {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    };
    if (this.sessionId !== void 0) headers["mcp-session-id"] = this.sessionId;
    this._streamMapping.set(this._standaloneSseStreamId, {
      controller: streamController,
      encoder,
      cleanup: () => {
        if (keepAliveTimer !== void 0) clearInterval(keepAliveTimer);
        this._streamMapping.delete(this._standaloneSseStreamId);
        try {
          streamController.close();
        } catch {
        }
      }
    });
    keepAliveTimer = this.startKeepAlive(streamController, encoder);
    return new Response(readable, { headers });
  }
  /**
  * Replays events that would have been sent after the specified event ID
  * Only used when resumability is enabled
  */
  async replayEvents(lastEventId) {
    if (!this._eventStore) {
      this.onerror?.(/* @__PURE__ */ new Error("Event store not configured"));
      return this.createJsonErrorResponse(400, -32e3, "Event store not configured");
    }
    try {
      let streamId;
      if (this._eventStore.getStreamIdForEventId) {
        streamId = await this._eventStore.getStreamIdForEventId(lastEventId);
        if (!streamId) {
          this.onerror?.(/* @__PURE__ */ new Error("Invalid event ID format"));
          return this.createJsonErrorResponse(400, -32e3, "Invalid event ID format");
        }
        if (this._streamMapping.get(streamId) !== void 0) {
          this.onerror?.(/* @__PURE__ */ new Error("Conflict: Stream already has an active connection"));
          return this.createJsonErrorResponse(409, -32e3, "Conflict: Stream already has an active connection");
        }
      }
      const headers = {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no"
      };
      if (this.sessionId !== void 0) headers["mcp-session-id"] = this.sessionId;
      const encoder = new TextEncoder();
      let streamController;
      let keepAliveTimer;
      let cancelled = false;
      let replayedStreamId;
      const readable = new ReadableStream({
        start: (controller) => {
          streamController = controller;
        },
        cancel: () => {
          cancelled = true;
          if (keepAliveTimer !== void 0) clearInterval(keepAliveTimer);
          if (replayedStreamId !== void 0 && this._streamMapping.get(replayedStreamId)?.controller === streamController) this._streamMapping.delete(replayedStreamId);
        }
      });
      const replayedEventIds = /* @__PURE__ */ new Set();
      replayedStreamId = await this._eventStore.replayEventsAfter(lastEventId, { send: async (eventId, message) => {
        replayedEventIds.add(eventId);
        if (!this.writeSSEEvent(streamController, encoder, message, eventId)) try {
          streamController.close();
        } catch {
        }
      } });
      if (this._closed || cancelled) {
        try {
          streamController.close();
        } catch {
        }
        return this.createJsonErrorResponse(404, -32001, "Session not found");
      }
      this._streamMapping.get(replayedStreamId)?.cleanup();
      this._streamMapping.set(replayedStreamId, {
        controller: streamController,
        encoder,
        replayedEventIds,
        cleanup: () => {
          if (keepAliveTimer !== void 0) clearInterval(keepAliveTimer);
          this._streamMapping.delete(replayedStreamId);
          try {
            streamController.close();
          } catch {
          }
        }
      });
      if (replayedStreamId !== this._standaloneSseStreamId) {
        if (![...this._requestToStreamMapping.values()].includes(replayedStreamId)) {
          this._streamMapping.delete(replayedStreamId);
          try {
            streamController.close();
          } catch {
          }
        }
      }
      if (this._streamMapping.get(replayedStreamId)?.controller === streamController) keepAliveTimer = this.startKeepAlive(streamController, encoder);
      return new Response(readable, { headers });
    } catch (error) {
      this.onerror?.(error);
      return this.createJsonErrorResponse(500, -32e3, "Error replaying events");
    }
  }
  /**
  * Writes an event to an SSE stream via controller with proper formatting
  */
  writeSSEEvent(controller, encoder, message, eventId) {
    try {
      let eventData = `event: message
`;
      if (eventId) eventData += `id: ${eventId}
`;
      eventData += `data: ${JSON.stringify(message)}

`;
      controller.enqueue(encoder.encode(eventData));
      return true;
    } catch (error) {
      this.onerror?.(error);
      return false;
    }
  }
  /**
  * Handles unsupported requests (`PUT`, `PATCH`, etc.)
  */
  handleUnsupportedRequest() {
    this.onerror?.(/* @__PURE__ */ new Error("Method not allowed."));
    return Response.json({
      jsonrpc: "2.0",
      error: {
        code: -32e3,
        message: "Method not allowed."
      },
      id: null
    }, {
      status: 405,
      headers: {
        Allow: "GET, POST, DELETE",
        "Content-Type": "application/json"
      }
    });
  }
  /**
  * Handles `POST` requests containing JSON-RPC messages
  */
  async handlePostRequest(req, options) {
    try {
      const acceptHeader = req.headers.get("accept");
      if (!acceptHeader?.includes("application/json") || !acceptHeader.includes("text/event-stream")) {
        this.onerror?.(/* @__PURE__ */ new Error("Not Acceptable: Client must accept both application/json and text/event-stream"));
        return this.createJsonErrorResponse(406, -32e3, "Not Acceptable: Client must accept both application/json and text/event-stream");
      }
      if (!isJsonContentType(req.headers.get("content-type"))) {
        this.onerror?.(/* @__PURE__ */ new Error("Unsupported Media Type: Content-Type must be application/json"));
        return this.createJsonErrorResponse(415, -32e3, "Unsupported Media Type: Content-Type must be application/json");
      }
      const request = req;
      let rawMessage;
      if (options?.parsedBody === void 0) try {
        rawMessage = await req.json();
      } catch (error) {
        this.onerror?.(error);
        return this.createJsonErrorResponse(400, -32700, "Parse error: Invalid JSON");
      }
      else rawMessage = options.parsedBody;
      let messages;
      try {
        messages = Array.isArray(rawMessage) ? rawMessage.map((msg) => JSONRPCMessageSchema.parse(msg)) : [JSONRPCMessageSchema.parse(rawMessage)];
      } catch (error) {
        this.onerror?.(error);
        return this.createJsonErrorResponse(400, -32700, "Parse error: Invalid JSON-RPC message");
      }
      if (this._closed) return this.createJsonErrorResponse(404, -32001, "Session not found");
      const isInitializationRequest = messages.some((element) => isInitializeRequest(element));
      if (isInitializationRequest) {
        if (this._initialized && this.sessionId !== void 0) {
          this.onerror?.(/* @__PURE__ */ new Error("Invalid Request: Server already initialized"));
          return this.createJsonErrorResponse(400, -32600, "Invalid Request: Server already initialized");
        }
        if (messages.length > 1) {
          this.onerror?.(/* @__PURE__ */ new Error("Invalid Request: Only one initialization request is allowed"));
          return this.createJsonErrorResponse(400, -32600, "Invalid Request: Only one initialization request is allowed");
        }
        this.sessionId = this.sessionIdGenerator?.();
        this._initialized = true;
        if (this.sessionId && this._onsessioninitialized) await Promise.resolve(this._onsessioninitialized(this.sessionId));
      }
      if (!isInitializationRequest) {
        const sessionError = this.validateSession(req);
        if (sessionError) return sessionError;
        const protocolError = this.validateProtocolVersion(req);
        if (protocolError) return protocolError;
      }
      if (this._closed) return this.createJsonErrorResponse(404, -32001, "Session not found");
      if (!messages.some((element) => isJSONRPCRequest(element))) {
        for (const message of messages) this.onmessage?.(message, {
          authInfo: options?.authInfo,
          request
        });
        return new Response(null, { status: 202 });
      }
      const streamId = crypto.randomUUID();
      const initRequest = messages.find((m) => isInitializeRequest(m));
      const clientProtocolVersion = initRequest ? initRequest.params.protocolVersion : req.headers.get("mcp-protocol-version") ?? DEFAULT_NEGOTIATED_PROTOCOL_VERSION;
      if (this._enableJsonResponse) return new Promise((resolve2) => {
        this._streamMapping.set(streamId, {
          resolveJson: resolve2,
          cleanup: () => {
            this._streamMapping.delete(streamId);
          }
        });
        for (const message of messages) if (isJSONRPCRequest(message)) this._requestToStreamMapping.set(message.id, streamId);
        for (const message of messages) this.onmessage?.(message, {
          authInfo: options?.authInfo,
          request
        });
      });
      const encoder = new TextEncoder();
      let streamController;
      let keepAliveTimer;
      const readable = new ReadableStream({
        start: (controller) => {
          streamController = controller;
        },
        cancel: () => {
          if (keepAliveTimer !== void 0) clearInterval(keepAliveTimer);
          if (this._streamMapping.get(streamId)?.controller === streamController) this._streamMapping.delete(streamId);
        }
      });
      const headers = {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no"
      };
      if (this.sessionId !== void 0) headers["mcp-session-id"] = this.sessionId;
      for (const message of messages) if (isJSONRPCRequest(message)) {
        this._streamMapping.set(streamId, {
          controller: streamController,
          encoder,
          cleanup: () => {
            if (keepAliveTimer !== void 0) clearInterval(keepAliveTimer);
            this._streamMapping.delete(streamId);
            try {
              streamController.close();
            } catch {
            }
          }
        });
        this._requestToStreamMapping.set(message.id, streamId);
      }
      await this.writePrimingEvent(streamController, encoder, streamId, clientProtocolVersion);
      for (const message of messages) {
        let closeSSEStream;
        let closeStandaloneSSEStream;
        if (isJSONRPCRequest(message) && this._eventStore && this.supportsEmptySSEData(clientProtocolVersion)) {
          closeSSEStream = () => {
            this.closeSSEStream(message.id);
          };
          closeStandaloneSSEStream = () => {
            this.closeStandaloneSSEStream();
          };
        }
        this.onmessage?.(message, {
          authInfo: options?.authInfo,
          request,
          closeSSEStream,
          closeStandaloneSSEStream
        });
      }
      if (this._streamMapping.get(streamId)?.controller === streamController) keepAliveTimer = this.startKeepAlive(streamController, encoder);
      return new Response(readable, {
        status: 200,
        headers
      });
    } catch (error) {
      this.onerror?.(error);
      return this.createJsonErrorResponse(400, -32700, "Parse error", { data: String(error) });
    }
  }
  /**
  * Handles `DELETE` requests to terminate sessions
  */
  async handleDeleteRequest(req) {
    const sessionError = this.validateSession(req);
    if (sessionError) return sessionError;
    const protocolError = this.validateProtocolVersion(req);
    if (protocolError) return protocolError;
    try {
      await Promise.resolve(this._onsessionclosed?.(this.sessionId));
      return new Response(null, { status: 200 });
    } finally {
      await this.close();
    }
  }
  /**
  * Validates session ID for non-initialization requests.
  * Returns `Response` error if invalid, `undefined` otherwise
  */
  validateSession(req) {
    if (this.sessionIdGenerator === void 0) return;
    if (!this._initialized) {
      this.onerror?.(/* @__PURE__ */ new Error("Bad Request: Server not initialized"));
      return this.createJsonErrorResponse(400, -32e3, "Bad Request: Server not initialized");
    }
    const sessionId = req.headers.get("mcp-session-id");
    if (!sessionId) {
      this.onerror?.(/* @__PURE__ */ new Error("Bad Request: Mcp-Session-Id header is required"));
      return this.createJsonErrorResponse(400, -32e3, "Bad Request: Mcp-Session-Id header is required");
    }
    if (sessionId !== this.sessionId) {
      this.onerror?.(/* @__PURE__ */ new Error("Session not found"));
      return this.createJsonErrorResponse(404, -32001, "Session not found");
    }
  }
  /**
  * Validates the `MCP-Protocol-Version` header on incoming requests.
  *
  * For initialization: Version negotiation handles unknown versions gracefully
  * (server responds with its supported version).
  *
  * For subsequent requests with `MCP-Protocol-Version` header:
  * - Accept if in supported list
  * - 400 if unsupported
  *
  * For HTTP requests without the `MCP-Protocol-Version` header:
  * - Accept and default to the version negotiated at initialization
  */
  validateProtocolVersion(req) {
    const protocolVersion = req.headers.get("mcp-protocol-version");
    if (protocolVersion !== null && !this._supportedProtocolVersions.includes(protocolVersion)) {
      const error = `Bad Request: Unsupported protocol version: ${protocolVersion} (supported versions: ${this._supportedProtocolVersions.join(", ")})`;
      this.onerror?.(new Error(error));
      return this.createJsonErrorResponse(400, -32e3, error);
    }
  }
  async close() {
    if (this._closed) return;
    this._closed = true;
    for (const { cleanup } of this._streamMapping.values()) cleanup();
    this._streamMapping.clear();
    this._requestResponseMap.clear();
    this.onclose?.();
  }
  /**
  * Close an SSE stream for a specific request, triggering client reconnection.
  * Use this to implement polling behavior during long-running operations -
  * client will reconnect after the retry interval specified in the priming event.
  */
  closeSSEStream(requestId) {
    const streamId = this._requestToStreamMapping.get(requestId);
    if (!streamId) return;
    const stream = this._streamMapping.get(streamId);
    if (stream) stream.cleanup();
  }
  /**
  * Close the standalone `GET` SSE stream, triggering client reconnection.
  * Use this to implement polling behavior for server-initiated notifications.
  */
  closeStandaloneSSEStream() {
    const stream = this._streamMapping.get(this._standaloneSseStreamId);
    if (stream) stream.cleanup();
  }
  async send(message, options) {
    let requestId = options?.relatedRequestId;
    if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) requestId = message.id;
    if (requestId === void 0) {
      if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) throw new Error("Cannot send a response on a standalone SSE stream unless resuming a previous client request");
      let eventId;
      if (this._eventStore) eventId = await this._eventStore.storeEvent(this._standaloneSseStreamId, message);
      const standaloneSse = this._streamMapping.get(this._standaloneSseStreamId);
      if (standaloneSse === void 0) return;
      if (standaloneSse.controller && standaloneSse.encoder && (eventId === void 0 || !standaloneSse.replayedEventIds?.has(eventId))) this.writeSSEEvent(standaloneSse.controller, standaloneSse.encoder, message, eventId);
      return;
    }
    const streamId = this._requestToStreamMapping.get(requestId);
    if (!streamId) throw new Error(`No connection established for request ID: ${String(requestId)}`);
    let stream = this._streamMapping.get(streamId);
    if (!this._enableJsonResponse) {
      let eventId;
      if (this._eventStore) {
        eventId = await this._eventStore.storeEvent(streamId, message);
        stream = this._streamMapping.get(streamId);
      }
      if (stream?.controller && stream?.encoder && (eventId === void 0 || !stream.replayedEventIds?.has(eventId))) this.writeSSEEvent(stream.controller, stream.encoder, message, eventId);
    }
    if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
      this._requestResponseMap.set(requestId, message);
      const relatedIds = [...this._requestToStreamMapping.entries()].filter(([_, sid]) => sid === streamId).map(([id]) => id);
      if (relatedIds.every((id) => this._requestResponseMap.has(id))) {
        if (!stream) {
          if (this._enableJsonResponse) throw new Error(`No connection established for request ID: ${String(requestId)}`);
          if (!this._eventStore) {
            this.onerror?.(/* @__PURE__ */ new Error(`Response for request ID ${String(requestId)} is undeliverable: per-request stream is disconnected and no eventStore is configured`));
            for (const id of relatedIds) {
              this._requestResponseMap.delete(id);
              this._requestToStreamMapping.delete(id);
            }
            return;
          }
          for (const id of relatedIds) {
            this._requestResponseMap.delete(id);
            this._requestToStreamMapping.delete(id);
          }
          return;
        }
        if (this._enableJsonResponse && stream.resolveJson) {
          const headers = { "Content-Type": "application/json" };
          if (this.sessionId !== void 0) headers["mcp-session-id"] = this.sessionId;
          const responses = relatedIds.map((id) => this._requestResponseMap.get(id));
          if (responses.length === 1) stream.resolveJson(Response.json(responses[0], {
            status: 200,
            headers
          }));
          else stream.resolveJson(Response.json(responses, {
            status: 200,
            headers
          }));
          stream.cleanup();
        } else stream.cleanup();
        for (const id of relatedIds) {
          this._requestResponseMap.delete(id);
          this._requestToStreamMapping.delete(id);
        }
      }
    }
  }
};

// ../../node_modules/@modelcontextprotocol/server/dist/stdio.mjs
var StdioServerTransport = class {
  _readBuffer;
  _started = false;
  _closed = false;
  constructor(_stdin = process2.stdin, _stdout = process2.stdout, options) {
    this._stdin = _stdin;
    this._stdout = _stdout;
    this._readBuffer = new ReadBuffer({ maxBufferSize: options?.maxBufferSize });
  }
  onclose;
  onerror;
  onmessage;
  _ondata = (chunk) => {
    try {
      this._readBuffer.append(chunk);
      this.processReadBuffer();
    } catch (error) {
      this.onerror?.(error);
      this.close().catch(() => {
      });
    }
  };
  _onerror = (error) => {
    this.onerror?.(error);
  };
  _onstdouterror = (error) => {
    this.onerror?.(error);
    this.close().catch(() => {
    });
  };
  /**
  * Starts listening for messages on `stdin`.
  */
  async start() {
    if (this._started) throw new Error("StdioServerTransport already started! If using Server class, note that connect() calls start() automatically.");
    this._started = true;
    this._stdin.on("data", this._ondata);
    this._stdin.on("error", this._onerror);
    this._stdout.on("error", this._onstdouterror);
  }
  processReadBuffer() {
    while (true) try {
      const message = this._readBuffer.readMessage();
      if (message === null) break;
      this.onmessage?.(message);
    } catch (error) {
      this.onerror?.(error);
    }
  }
  async close() {
    if (this._closed) return;
    this._closed = true;
    this._stdin.off("data", this._ondata);
    this._stdin.off("error", this._onerror);
    this._stdout.off("error", this._onstdouterror);
    if (this._stdin.listenerCount("data") === 0) this._stdin.pause();
    this._readBuffer.clear();
    this.onclose?.();
  }
  send(message) {
    if (this._closed) return Promise.reject(/* @__PURE__ */ new Error("StdioServerTransport is closed"));
    return new Promise((resolve2, reject) => {
      const json = serializeMessage(message);
      let settled = false;
      const onError = (error) => {
        if (settled) return;
        settled = true;
        this._stdout.off("error", onError);
        this._stdout.off("drain", onDrain);
        reject(error);
      };
      const onDrain = () => {
        if (settled) return;
        settled = true;
        this._stdout.off("error", onError);
        this._stdout.off("drain", onDrain);
        resolve2();
      };
      this._stdout.once("error", onError);
      if (this._stdout.write(json)) {
        if (settled) return;
        settled = true;
        this._stdout.off("error", onError);
        resolve2();
      } else if (!settled) this._stdout.once("drain", onDrain);
    });
  }
};

// src/discovery.ts
import { z as z27 } from "zod";

// src/upload-widget.ts
var UPLOAD_WIDGET_MIME = "text/html;profile=mcp-app";
var UPLOAD_WIDGET_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Kie.ai media upload</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, -apple-system, sans-serif; }
    body { margin: 0; padding: 16px; background: Canvas; color: CanvasText; }
    main { max-width: 560px; margin: 0 auto; }
    h1 { margin: 0 0 6px; font-size: 1.15rem; }
    p { margin: 0 0 14px; color: GrayText; line-height: 1.45; }
    form { display: grid; gap: 12px; }
    label { font-weight: 650; }
    input, button { font: inherit; }
    input[type=file] { width: 100%; padding: 12px; border: 1px solid GrayText; border-radius: 8px; box-sizing: border-box; }
    button { min-height: 42px; padding: 9px 14px; border: 0; border-radius: 8px; background: #2563eb; color: white; font-weight: 700; cursor: pointer; }
    button:disabled { opacity: .55; cursor: wait; }
    progress { width: 100%; height: 10px; }
    #status { min-height: 1.5em; margin-top: 12px; color: CanvasText; }
    #result { display: none; margin-top: 10px; padding: 10px; border-radius: 8px; background: color-mix(in srgb, CanvasText 8%, Canvas); overflow-wrap: anywhere; user-select: all; }
    .hint { font-size: .875rem; }
  </style>
</head>
<body>
  <main>
    <h1>Upload reference media</h1>
    <p>Select one image, video, or audio file. The temporary URL is added to the conversation after a verified upload.</p>
    <form id="upload-form">
      <label for="file">Media file</label>
      <input id="file" name="file" type="file" required accept="image/jpeg,image/png,image/webp,video/mp4,video/webm,video/quicktime,audio/mpeg,audio/wav,audio/x-wav,audio/ogg,audio/aac,audio/mp4">
      <span class="hint">Maximum 25 MiB. The server verifies size, MIME type, and file signature.</span>
      <button id="submit" type="submit">Upload</button>
      <progress id="progress" max="100" value="0" aria-label="Upload progress"></progress>
    </form>
    <div id="status" role="status" aria-live="polite">Connecting to the MCP host...</div>
    <code id="result" aria-label="Temporary download URL"></code>
  </main>
  <script>
    (() => {
      "use strict";
      const form = document.getElementById("upload-form");
      const fileInput = document.getElementById("file");
      const submit = document.getElementById("submit");
      const progress = document.getElementById("progress");
      const status = document.getElementById("status");
      const result = document.getElementById("result");
      const pending = new Map();
      let requestId = 0;
      let initialized = false;
      let appGrant = null;

      function inferContentType(file) {
        if (file.type) return file.type;
        const extension = file.name.toLowerCase().split(".").pop();
        const types = {
          jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
          mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
          mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", aac: "audio/aac", m4a: "audio/mp4"
        };
        return Object.prototype.hasOwnProperty.call(types, extension)
          ? types[extension]
          : "application/octet-stream";
      }

      function request(method, params) {
        const id = ++requestId;
        window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
        return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      }

      window.addEventListener("message", (event) => {
        if (event.source !== window.parent) return;
        const message = event.data;
        if (!message || message.jsonrpc !== "2.0") return;
        if (message.method === "ui/notifications/tool-result") {
          const grant = message.params && message.params._meta && message.params._meta.upload && message.params._meta.upload.app_grant;
          if (typeof grant === "string") {
            appGrant = grant;
            status.textContent = "Ready to upload.";
          }
          return;
        }
        if (message.id === undefined) return;
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message || "MCP host request failed"));
        else waiter.resolve(message.result);
      });

      async function initialize() {
        await request("ui/initialize", {
          protocolVersion: "2026-01-26",
          appCapabilities: { availableDisplayModes: ["inline"] },
          clientInfo: { name: "kie-upload-widget", version: "1.0.0" }
        });
        window.parent.postMessage({
          jsonrpc: "2.0",
          method: "ui/notifications/initialized",
          params: {}
        }, "*");
        initialized = true;
        status.textContent = "Waiting for the secure widget grant...";
      }

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const file = fileInput.files && fileInput.files[0];
        if (!file || !initialized || !appGrant) {
          status.textContent = "The secure widget grant is unavailable. Reopen the uploader.";
          return;
        }
        if (file.size <= 0 || file.size > 25 * 1024 * 1024) {
          status.textContent = "Choose a non-empty file no larger than 25 MiB.";
          return;
        }
        submit.disabled = true;
        progress.value = 15;
        result.style.display = "none";
        try {
          const contentType = inferContentType(file);
          status.textContent = "Creating a secure upload capability...";
          const toolResult = await request("tools/call", {
            name: "get_upload_url",
            arguments: {
              app_grant: appGrant,
              filename: file.name,
              content_type: contentType,
              size: file.size
            }
          });
          const textBlock = toolResult && toolResult.content && toolResult.content.find((block) => block.type === "text");
          if (!textBlock) throw new Error("The server returned no upload capability.");
          const capability = JSON.parse(textBlock.text);
          const privateUpload = toolResult && toolResult._meta && toolResult._meta.upload;
          if (!capability.success || !privateUpload || !privateUpload.upload_url || !capability.media_id) {
            throw new Error(capability.error || capability.message || "Upload capability unavailable.");
          }
          progress.value = 35;
          status.textContent = "Uploading and validating media...";
          const response = await fetch(privateUpload.upload_url, {
            method: "PUT",
            headers: { "Content-Type": contentType },
            body: file,
            credentials: "omit",
            referrerPolicy: "no-referrer"
          });
          if (!response.ok) throw new Error("Upload failed validation.");
          progress.value = 75;
          status.textContent = "Finalizing media with Kie.ai...";
          const finalizeResult = await request("tools/call", {
            name: "finalize_upload",
            arguments: {
              app_grant: appGrant,
              media_id: capability.media_id
            }
          });
          const finalizeText = finalizeResult && finalizeResult.content && finalizeResult.content.find((block) => block.type === "text");
          if (!finalizeText) throw new Error("The server returned no finalized media URL.");
          const finalized = JSON.parse(finalizeText.text);
          if (!finalized.success || !finalized.download_url) {
            throw new Error(finalized.error || finalized.message || "Media finalization failed.");
          }
          progress.value = 90;
          result.textContent = finalized.download_url;
          result.style.display = "block";
          progress.value = 100;
          try {
            await request("ui/update-model-context", {
              content: [{
                type: "text",
                text: "Uploaded reference media URL: " + finalized.download_url
              }],
              structuredContent: {
                download_url: finalized.download_url,
                filename: file.name,
                content_type: contentType,
                size: file.size
              }
            });
            status.textContent = "Upload complete. The URL was added to model context.";
          } catch {
            status.textContent = "Upload complete. This host could not update model context; copy the URL shown below.";
          }
        } catch (error) {
          progress.value = 0;
          status.textContent = error instanceof Error ? error.message : "Upload failed.";
        } finally {
          submit.disabled = false;
        }
      });

      initialize().catch((error) => {
        status.textContent = error instanceof Error ? error.message : "This host does not support MCP Apps.";
      });
    })();
  </script>
</body>
</html>`;

// src/discovery.ts
var APPS_EXTENSION_NAME = "io.modelcontextprotocol/ui";
var appsExtensions = {
  [APPS_EXTENSION_NAME]: { mimeTypes: [UPLOAD_WIDGET_MIME] }
};
function buildDiscoverPayload(instructions) {
  return {
    supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
    capabilities: {
      tools: {},
      resources: {},
      prompts: {},
      extensions: appsExtensions
    },
    instructions
  };
}
var TASK_OUTPUT_SCHEMA = z27.toJSONSchema(
  z27.object({
    task_id: z27.string(),
    status: z27.string().optional(),
    api_type: z27.string().optional(),
    error: z27.string().optional()
  })
);
var UPLOAD_OUTPUT_SCHEMA = z27.toJSONSchema(z27.object({ media_id: z27.string() }));
var PREPARE_OUTPUT_SCHEMA = z27.toJSONSchema(
  z27.object({
    plan_id: z27.string(),
    status: z27.enum(["prepared", "approved"]),
    approved: z27.boolean(),
    input_required: z27.boolean().optional()
  })
);
var FINALIZE_OUTPUT_SCHEMA = z27.toJSONSchema(
  z27.object({
    download_url: z27.string(),
    filename: z27.string(),
    content_type: z27.string(),
    size: z27.number()
  })
);
var SUBMIT_OUTPUT_SCHEMA = z27.toJSONSchema(
  z27.object({
    plan_id: z27.string(),
    request_hash: z27.string(),
    results: z27.array(
      z27.object({
        index: z27.number(),
        tool: z27.string(),
        taskId: z27.string().optional(),
        error: z27.string().optional(),
        result: z27.unknown().optional()
      })
    )
  })
);
var TASK_BEARING_CATEGORIES = /* @__PURE__ */ new Set(["image", "video", "audio"]);
function toolOutputSchema(tool) {
  if (tool.name === "prepare_media_generation") return PREPARE_OUTPUT_SCHEMA;
  if (tool.name === "get_upload_url") return UPLOAD_OUTPUT_SCHEMA;
  if (tool.name === "finalize_upload") return FINALIZE_OUTPUT_SCHEMA;
  if (tool.name === "submit_media_generation") return SUBMIT_OUTPUT_SCHEMA;
  if (TASK_BEARING_CATEGORIES.has(tool.category)) return TASK_OUTPUT_SCHEMA;
  return void 0;
}

// src/http-transport.ts
import { randomUUID as randomUUID2, timingSafeEqual } from "node:crypto";

// ../../node_modules/@hono/node-server/dist/index.mjs
import { Http2ServerRequest as Http2ServerRequest2, constants as h2constants } from "http2";
import { Http2ServerRequest } from "http2";
import { Readable } from "stream";
import crypto2 from "crypto";
var RequestError = class extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "RequestError";
  }
};
var toRequestError = (e) => {
  if (e instanceof RequestError) {
    return e;
  }
  return new RequestError(e.message, { cause: e });
};
var GlobalRequest = global.Request;
var Request2 = class extends GlobalRequest {
  constructor(input, options) {
    if (typeof input === "object" && getRequestCache in input) {
      input = input[getRequestCache]();
    }
    if (typeof options?.body?.getReader !== "undefined") {
      ;
      options.duplex ??= "half";
    }
    super(input, options);
  }
};
var newHeadersFromIncoming = (incoming) => {
  const headerRecord = [];
  const rawHeaders = incoming.rawHeaders;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const { [i]: key, [i + 1]: value } = rawHeaders;
    if (key.charCodeAt(0) !== /*:*/
    58) {
      headerRecord.push([key, value]);
    }
  }
  return new Headers(headerRecord);
};
var wrapBodyStream = Symbol("wrapBodyStream");
var newRequestFromIncoming = (method, url3, headers, incoming, abortController) => {
  const init = {
    method,
    headers,
    signal: abortController.signal
  };
  if (method === "TRACE") {
    init.method = "GET";
    const req = new Request2(url3, init);
    Object.defineProperty(req, "method", {
      get() {
        return "TRACE";
      }
    });
    return req;
  }
  if (!(method === "GET" || method === "HEAD")) {
    if ("rawBody" in incoming && incoming.rawBody instanceof Buffer) {
      init.body = new ReadableStream({
        start(controller) {
          controller.enqueue(incoming.rawBody);
          controller.close();
        }
      });
    } else if (incoming[wrapBodyStream]) {
      let reader;
      init.body = new ReadableStream({
        async pull(controller) {
          try {
            reader ||= Readable.toWeb(incoming).getReader();
            const { done, value } = await reader.read();
            if (done) {
              controller.close();
            } else {
              controller.enqueue(value);
            }
          } catch (error) {
            controller.error(error);
          }
        }
      });
    } else {
      init.body = Readable.toWeb(incoming);
    }
  }
  return new Request2(url3, init);
};
var getRequestCache = Symbol("getRequestCache");
var requestCache = Symbol("requestCache");
var incomingKey = Symbol("incomingKey");
var urlKey = Symbol("urlKey");
var headersKey = Symbol("headersKey");
var abortControllerKey = Symbol("abortControllerKey");
var getAbortController = Symbol("getAbortController");
var requestPrototype = {
  get method() {
    return this[incomingKey].method || "GET";
  },
  get url() {
    return this[urlKey];
  },
  get headers() {
    return this[headersKey] ||= newHeadersFromIncoming(this[incomingKey]);
  },
  [getAbortController]() {
    this[getRequestCache]();
    return this[abortControllerKey];
  },
  [getRequestCache]() {
    this[abortControllerKey] ||= new AbortController();
    return this[requestCache] ||= newRequestFromIncoming(
      this.method,
      this[urlKey],
      this.headers,
      this[incomingKey],
      this[abortControllerKey]
    );
  }
};
[
  "body",
  "bodyUsed",
  "cache",
  "credentials",
  "destination",
  "integrity",
  "mode",
  "redirect",
  "referrer",
  "referrerPolicy",
  "signal",
  "keepalive"
].forEach((k) => {
  Object.defineProperty(requestPrototype, k, {
    get() {
      return this[getRequestCache]()[k];
    }
  });
});
["arrayBuffer", "blob", "clone", "formData", "json", "text"].forEach((k) => {
  Object.defineProperty(requestPrototype, k, {
    value: function() {
      return this[getRequestCache]()[k]();
    }
  });
});
Object.defineProperty(requestPrototype, Symbol.for("nodejs.util.inspect.custom"), {
  value: function(depth, options, inspectFn) {
    const props = {
      method: this.method,
      url: this.url,
      headers: this.headers,
      nativeRequest: this[requestCache]
    };
    return `Request (lightweight) ${inspectFn(props, { ...options, depth: depth == null ? null : depth - 1 })}`;
  }
});
Object.setPrototypeOf(requestPrototype, Request2.prototype);
var newRequest = (incoming, defaultHostname) => {
  const req = Object.create(requestPrototype);
  req[incomingKey] = incoming;
  const incomingUrl = incoming.url || "";
  if (incomingUrl[0] !== "/" && // short-circuit for performance. most requests are relative URL.
  (incomingUrl.startsWith("http://") || incomingUrl.startsWith("https://"))) {
    if (incoming instanceof Http2ServerRequest) {
      throw new RequestError("Absolute URL for :path is not allowed in HTTP/2");
    }
    try {
      const url22 = new URL(incomingUrl);
      req[urlKey] = url22.href;
    } catch (e) {
      throw new RequestError("Invalid absolute URL", { cause: e });
    }
    return req;
  }
  const host = (incoming instanceof Http2ServerRequest ? incoming.authority : incoming.headers.host) || defaultHostname;
  if (!host) {
    throw new RequestError("Missing host header");
  }
  let scheme;
  if (incoming instanceof Http2ServerRequest) {
    scheme = incoming.scheme;
    if (!(scheme === "http" || scheme === "https")) {
      throw new RequestError("Unsupported scheme");
    }
  } else {
    scheme = incoming.socket && incoming.socket.encrypted ? "https" : "http";
  }
  const url3 = new URL(`${scheme}://${host}${incomingUrl}`);
  if (url3.hostname.length !== host.length && url3.hostname !== host.replace(/:\d+$/, "")) {
    throw new RequestError("Invalid host header");
  }
  req[urlKey] = url3.href;
  return req;
};
var responseCache = Symbol("responseCache");
var getResponseCache = Symbol("getResponseCache");
var cacheKey = Symbol("cache");
var GlobalResponse = global.Response;
var Response2 = class _Response {
  #body;
  #init;
  [getResponseCache]() {
    delete this[cacheKey];
    return this[responseCache] ||= new GlobalResponse(this.#body, this.#init);
  }
  constructor(body, init) {
    let headers;
    this.#body = body;
    if (init instanceof _Response) {
      const cachedGlobalResponse = init[responseCache];
      if (cachedGlobalResponse) {
        this.#init = cachedGlobalResponse;
        this[getResponseCache]();
        return;
      } else {
        this.#init = init.#init;
        headers = new Headers(init.#init.headers);
      }
    } else {
      this.#init = init;
    }
    if (typeof body === "string" || typeof body?.getReader !== "undefined" || body instanceof Blob || body instanceof Uint8Array) {
      ;
      this[cacheKey] = [init?.status || 200, body, headers || init?.headers];
    }
  }
  get headers() {
    const cache = this[cacheKey];
    if (cache) {
      if (!(cache[2] instanceof Headers)) {
        cache[2] = new Headers(
          cache[2] || { "content-type": "text/plain; charset=UTF-8" }
        );
      }
      return cache[2];
    }
    return this[getResponseCache]().headers;
  }
  get status() {
    return this[cacheKey]?.[0] ?? this[getResponseCache]().status;
  }
  get ok() {
    const status = this.status;
    return status >= 200 && status < 300;
  }
};
["body", "bodyUsed", "redirected", "statusText", "trailers", "type", "url"].forEach((k) => {
  Object.defineProperty(Response2.prototype, k, {
    get() {
      return this[getResponseCache]()[k];
    }
  });
});
["arrayBuffer", "blob", "clone", "formData", "json", "text"].forEach((k) => {
  Object.defineProperty(Response2.prototype, k, {
    value: function() {
      return this[getResponseCache]()[k]();
    }
  });
});
Object.defineProperty(Response2.prototype, Symbol.for("nodejs.util.inspect.custom"), {
  value: function(depth, options, inspectFn) {
    const props = {
      status: this.status,
      headers: this.headers,
      ok: this.ok,
      nativeResponse: this[responseCache]
    };
    return `Response (lightweight) ${inspectFn(props, { ...options, depth: depth == null ? null : depth - 1 })}`;
  }
});
Object.setPrototypeOf(Response2, GlobalResponse);
Object.setPrototypeOf(Response2.prototype, GlobalResponse.prototype);
async function readWithoutBlocking(readPromise) {
  return Promise.race([readPromise, Promise.resolve().then(() => Promise.resolve(void 0))]);
}
function writeFromReadableStreamDefaultReader(reader, writable, currentReadPromise) {
  const cancel = (error) => {
    reader.cancel(error).catch(() => {
    });
  };
  writable.on("close", cancel);
  writable.on("error", cancel);
  (currentReadPromise ?? reader.read()).then(flow, handleStreamError);
  return reader.closed.finally(() => {
    writable.off("close", cancel);
    writable.off("error", cancel);
  });
  function handleStreamError(error) {
    if (error) {
      writable.destroy(error);
    }
  }
  function onDrain() {
    reader.read().then(flow, handleStreamError);
  }
  function flow({ done, value }) {
    try {
      if (done) {
        writable.end();
      } else if (!writable.write(value)) {
        writable.once("drain", onDrain);
      } else {
        return reader.read().then(flow, handleStreamError);
      }
    } catch (e) {
      handleStreamError(e);
    }
  }
}
function writeFromReadableStream(stream, writable) {
  if (stream.locked) {
    throw new TypeError("ReadableStream is locked.");
  } else if (writable.destroyed) {
    return;
  }
  return writeFromReadableStreamDefaultReader(stream.getReader(), writable);
}
var buildOutgoingHttpHeaders = (headers) => {
  const res = {};
  if (!(headers instanceof Headers)) {
    headers = new Headers(headers ?? void 0);
  }
  const cookies = [];
  for (const [k, v] of headers) {
    if (k === "set-cookie") {
      cookies.push(v);
    } else {
      res[k] = v;
    }
  }
  if (cookies.length > 0) {
    res["set-cookie"] = cookies;
  }
  res["content-type"] ??= "text/plain; charset=UTF-8";
  return res;
};
var X_ALREADY_SENT = "x-hono-already-sent";
if (typeof global.crypto === "undefined") {
  global.crypto = crypto2;
}
var outgoingEnded = Symbol("outgoingEnded");
var incomingDraining = Symbol("incomingDraining");
var DRAIN_TIMEOUT_MS = 500;
var MAX_DRAIN_BYTES = 64 * 1024 * 1024;
var drainIncoming = (incoming) => {
  const incomingWithDrainState = incoming;
  if (incoming.destroyed || incomingWithDrainState[incomingDraining]) {
    return;
  }
  incomingWithDrainState[incomingDraining] = true;
  if (incoming instanceof Http2ServerRequest2) {
    try {
      ;
      incoming.stream?.close?.(h2constants.NGHTTP2_NO_ERROR);
    } catch {
    }
    return;
  }
  let bytesRead = 0;
  const cleanup = () => {
    clearTimeout(timer);
    incoming.off("data", onData);
    incoming.off("end", cleanup);
    incoming.off("error", cleanup);
  };
  const forceClose = () => {
    cleanup();
    const socket = incoming.socket;
    if (socket && !socket.destroyed) {
      socket.destroySoon();
    }
  };
  const timer = setTimeout(forceClose, DRAIN_TIMEOUT_MS);
  timer.unref?.();
  const onData = (chunk) => {
    bytesRead += chunk.length;
    if (bytesRead > MAX_DRAIN_BYTES) {
      forceClose();
    }
  };
  incoming.on("data", onData);
  incoming.on("end", cleanup);
  incoming.on("error", cleanup);
  incoming.resume();
};
var handleRequestError = () => new Response(null, {
  status: 400
});
var handleFetchError = (e) => new Response(null, {
  status: e instanceof Error && (e.name === "TimeoutError" || e.constructor.name === "TimeoutError") ? 504 : 500
});
var handleResponseError = (e, outgoing) => {
  const err = e instanceof Error ? e : new Error("unknown error", { cause: e });
  if (err.code === "ERR_STREAM_PREMATURE_CLOSE") {
    console.info("The user aborted a request.");
  } else {
    console.error(e);
    if (!outgoing.headersSent) {
      outgoing.writeHead(500, { "Content-Type": "text/plain" });
    }
    outgoing.end(`Error: ${err.message}`);
    outgoing.destroy(err);
  }
};
var flushHeaders = (outgoing) => {
  if ("flushHeaders" in outgoing && outgoing.writable) {
    outgoing.flushHeaders();
  }
};
var responseViaCache = async (res, outgoing) => {
  let [status, body, header] = res[cacheKey];
  let hasContentLength = false;
  if (!header) {
    header = { "content-type": "text/plain; charset=UTF-8" };
  } else if (header instanceof Headers) {
    hasContentLength = header.has("content-length");
    header = buildOutgoingHttpHeaders(header);
  } else if (Array.isArray(header)) {
    const headerObj = new Headers(header);
    hasContentLength = headerObj.has("content-length");
    header = buildOutgoingHttpHeaders(headerObj);
  } else {
    for (const key in header) {
      if (key.length === 14 && key.toLowerCase() === "content-length") {
        hasContentLength = true;
        break;
      }
    }
  }
  if (!hasContentLength) {
    if (typeof body === "string") {
      header["Content-Length"] = Buffer.byteLength(body);
    } else if (body instanceof Uint8Array) {
      header["Content-Length"] = body.byteLength;
    } else if (body instanceof Blob) {
      header["Content-Length"] = body.size;
    }
  }
  outgoing.writeHead(status, header);
  if (typeof body === "string" || body instanceof Uint8Array) {
    outgoing.end(body);
  } else if (body instanceof Blob) {
    outgoing.end(new Uint8Array(await body.arrayBuffer()));
  } else {
    flushHeaders(outgoing);
    await writeFromReadableStream(body, outgoing)?.catch(
      (e) => handleResponseError(e, outgoing)
    );
  }
  ;
  outgoing[outgoingEnded]?.();
};
var isPromise = (res) => typeof res.then === "function";
var responseViaResponseObject = async (res, outgoing, options = {}) => {
  if (isPromise(res)) {
    if (options.errorHandler) {
      try {
        res = await res;
      } catch (err) {
        const errRes = await options.errorHandler(err);
        if (!errRes) {
          return;
        }
        res = errRes;
      }
    } else {
      res = await res.catch(handleFetchError);
    }
  }
  if (cacheKey in res) {
    return responseViaCache(res, outgoing);
  }
  const resHeaderRecord = buildOutgoingHttpHeaders(res.headers);
  if (res.body) {
    const reader = res.body.getReader();
    const values = [];
    let done = false;
    let currentReadPromise = void 0;
    if (resHeaderRecord["transfer-encoding"] !== "chunked") {
      let maxReadCount = 2;
      for (let i = 0; i < maxReadCount; i++) {
        currentReadPromise ||= reader.read();
        const chunk = await readWithoutBlocking(currentReadPromise).catch((e) => {
          console.error(e);
          done = true;
        });
        if (!chunk) {
          if (i === 1) {
            await new Promise((resolve2) => setTimeout(resolve2));
            maxReadCount = 3;
            continue;
          }
          break;
        }
        currentReadPromise = void 0;
        if (chunk.value) {
          values.push(chunk.value);
        }
        if (chunk.done) {
          done = true;
          break;
        }
      }
      if (done && !("content-length" in resHeaderRecord)) {
        resHeaderRecord["content-length"] = values.reduce((acc, value) => acc + value.length, 0);
      }
    }
    outgoing.writeHead(res.status, resHeaderRecord);
    values.forEach((value) => {
      ;
      outgoing.write(value);
    });
    if (done) {
      outgoing.end();
    } else {
      if (values.length === 0) {
        flushHeaders(outgoing);
      }
      await writeFromReadableStreamDefaultReader(reader, outgoing, currentReadPromise);
    }
  } else if (resHeaderRecord[X_ALREADY_SENT]) {
  } else {
    outgoing.writeHead(res.status, resHeaderRecord);
    outgoing.end();
  }
  ;
  outgoing[outgoingEnded]?.();
};
var getRequestListener = (fetchCallback, options = {}) => {
  const autoCleanupIncoming = options.autoCleanupIncoming ?? true;
  if (options.overrideGlobalObjects !== false && global.Request !== Request2) {
    Object.defineProperty(global, "Request", {
      value: Request2
    });
    Object.defineProperty(global, "Response", {
      value: Response2
    });
  }
  return async (incoming, outgoing) => {
    let res, req;
    try {
      req = newRequest(incoming, options.hostname);
      let incomingEnded = !autoCleanupIncoming || incoming.method === "GET" || incoming.method === "HEAD";
      if (!incomingEnded) {
        ;
        incoming[wrapBodyStream] = true;
        incoming.on("end", () => {
          incomingEnded = true;
        });
        if (incoming instanceof Http2ServerRequest2) {
          ;
          outgoing[outgoingEnded] = () => {
            if (!incomingEnded) {
              setTimeout(() => {
                if (!incomingEnded) {
                  setTimeout(() => {
                    drainIncoming(incoming);
                  });
                }
              });
            }
          };
        }
        outgoing.on("finish", () => {
          if (!incomingEnded) {
            drainIncoming(incoming);
          }
        });
      }
      outgoing.on("close", () => {
        const abortController = req[abortControllerKey];
        if (abortController) {
          if (incoming.errored) {
            req[abortControllerKey].abort(incoming.errored.toString());
          } else if (!outgoing.writableFinished) {
            req[abortControllerKey].abort("Client connection prematurely closed.");
          }
        }
        if (!incomingEnded) {
          setTimeout(() => {
            if (!incomingEnded) {
              setTimeout(() => {
                drainIncoming(incoming);
              });
            }
          });
        }
      });
      res = fetchCallback(req, { incoming, outgoing });
      if (cacheKey in res) {
        return responseViaCache(res, outgoing);
      }
    } catch (e) {
      if (!res) {
        if (options.errorHandler) {
          res = await options.errorHandler(req ? e : toRequestError(e));
          if (!res) {
            return;
          }
        } else if (!req) {
          res = handleRequestError();
        } else {
          res = handleFetchError(e);
        }
      } else {
        return handleResponseError(e, outgoing);
      }
    }
    try {
      return await responseViaResponseObject(res, outgoing, options);
    } catch (e) {
      return handleResponseError(e, outgoing);
    }
  };
};

// ../../node_modules/@modelcontextprotocol/node/dist/index.mjs
var NodeStreamableHTTPServerTransport = class {
  _webStandardTransport;
  _requestListener;
  _requestContext = /* @__PURE__ */ new WeakMap();
  constructor(options = {}) {
    this._webStandardTransport = new WebStandardStreamableHTTPServerTransport(options);
    this._requestListener = getRequestListener(async (webRequest) => {
      const context = this._requestContext.get(webRequest);
      return this._webStandardTransport.handleRequest(webRequest, {
        authInfo: context?.authInfo,
        parsedBody: context?.parsedBody
      });
    }, { overrideGlobalObjects: false });
  }
  /**
  * Gets the session ID for this transport instance.
  */
  get sessionId() {
    return this._webStandardTransport.sessionId;
  }
  /**
  * Sets callback for when the transport is closed.
  */
  set onclose(handler) {
    this._webStandardTransport.onclose = handler;
  }
  get onclose() {
    return this._webStandardTransport.onclose;
  }
  /**
  * Sets callback for transport errors.
  */
  set onerror(handler) {
    this._webStandardTransport.onerror = handler;
  }
  get onerror() {
    return this._webStandardTransport.onerror;
  }
  /**
  * Sets callback for incoming messages.
  */
  set onmessage(handler) {
    this._webStandardTransport.onmessage = handler;
  }
  get onmessage() {
    return this._webStandardTransport.onmessage;
  }
  /**
  * Starts the transport. This is required by the {@linkcode Transport} interface but is a no-op
  * for the Streamable HTTP transport as connections are managed per-request.
  */
  async start() {
    return this._webStandardTransport.start();
  }
  /**
  * Closes the transport and all active connections.
  */
  async close() {
    return this._webStandardTransport.close();
  }
  /**
  * Sends a JSON-RPC message through the transport.
  */
  async send(message, options) {
    return this._webStandardTransport.send(message, options);
  }
  /**
  * Forwards the supported protocol versions to the wrapped Web Standard
  * transport for `MCP-Protocol-Version` header validation. Called by the
  * protocol layer during connect; without this delegation a server's
  * `supportedProtocolVersions` option never reached the Node adapter's
  * header validation.
  */
  setSupportedProtocolVersions(versions) {
    this._webStandardTransport.setSupportedProtocolVersions(versions);
  }
  /**
  * Handles an incoming HTTP request, whether `GET` or `POST`.
  *
  * This method converts Node.js HTTP objects to Web Standard Request/Response
  * and delegates to the underlying {@linkcode WebStandardStreamableHTTPServerTransport}.
  *
  * @param req - Node.js `IncomingMessage`, optionally with `auth` property from middleware
  * @param res - Node.js `ServerResponse`
  * @param parsedBody - Optional pre-parsed body from body-parser middleware
  */
  async handleRequest(req, res, parsedBody) {
    const authInfo = req.auth;
    await getRequestListener(async (webRequest) => {
      return this._webStandardTransport.handleRequest(webRequest, {
        authInfo,
        parsedBody
      });
    }, { overrideGlobalObjects: false })(req, res);
  }
  /**
  * Close an SSE stream for a specific request, triggering client reconnection.
  * Use this to implement polling behavior during long-running operations -
  * client will reconnect after the retry interval specified in the priming event.
  */
  closeSSEStream(requestId) {
    this._webStandardTransport.closeSSEStream(requestId);
  }
  /**
  * Close the standalone GET SSE stream, triggering client reconnection.
  * Use this to implement polling behavior for server-initiated notifications.
  */
  closeStandaloneSSEStream() {
    this._webStandardTransport.closeStandaloneSSEStream();
  }
};

// src/http-transport.ts
import express from "express";
function envList(name) {
  return (process.env[name] || "").split(",").map((value) => value.trim()).filter(Boolean);
}
function resolveOptions(opts) {
  return {
    ...opts,
    host: opts.host ?? process.env.MCP_HTTP_HOST ?? "127.0.0.1",
    port: opts.port ?? parseInt(process.env.MCP_HTTP_PORT || "3000", 10),
    token: opts.token ?? process.env.KIE_MCP_HTTP_TOKEN ?? "",
    allowedHosts: opts.allowedHosts ?? envList("MCP_ALLOWED_HOSTS"),
    allowedOrigins: opts.allowedOrigins ?? envList("MCP_ALLOWED_ORIGINS"),
    uploadAllowedOrigins: opts.uploadAllowedOrigins ?? envList("MCP_UPLOAD_ALLOWED_ORIGINS")
  };
}
function validateHttpTransportSecurity({
  host,
  token,
  allowedHosts,
  allowedOrigins = [],
  uploadAllowedOrigins = [],
  uploadEnabled = false
}) {
  const isLoopbackHost = host === "127.0.0.1" || host === "localhost" || host === "::1";
  const missing = [
    ...!isLoopbackHost && allowedHosts.length === 0 ? ["MCP_ALLOWED_HOSTS"] : [],
    ...!isLoopbackHost && !token ? ["KIE_MCP_HTTP_TOKEN"] : [],
    ...uploadEnabled && allowedHosts.length === 0 ? ["MCP_ALLOWED_HOSTS"] : [],
    ...uploadEnabled && !token ? ["KIE_MCP_HTTP_TOKEN"] : [],
    ...uploadEnabled && allowedOrigins.length === 0 ? ["MCP_ALLOWED_ORIGINS"] : [],
    ...uploadEnabled && uploadAllowedOrigins.length === 0 ? ["MCP_UPLOAD_ALLOWED_ORIGINS"] : []
  ];
  const unique = [...new Set(missing)];
  if (unique.length > 0) {
    throw new Error(
      `${unique.join(" and ")} ${unique.length === 1 ? "is" : "are"} required ${uploadEnabled ? "when temporary HTTP uploads are enabled" : `when MCP_HTTP_HOST is non-loopback (got "${host}")`}.`
    );
  }
}
function normalizeHost(value) {
  try {
    return new URL(`http://${value}`).hostname.toLowerCase();
  } catch {
    return "";
  }
}
function isAllowedHost(value, allowedHosts) {
  if (!value) return false;
  const normalized = normalizeHost(value);
  return allowedHosts.some(
    (allowed) => allowed.toLowerCase() === value.toLowerCase() || normalizeHost(allowed) === normalized
  );
}
function createHttpApp(options) {
  const opts = resolveOptions(options);
  validateHttpTransportSecurity({
    host: opts.host,
    token: opts.token,
    allowedHosts: opts.allowedHosts,
    allowedOrigins: opts.allowedOrigins,
    uploadAllowedOrigins: opts.uploadAllowedOrigins,
    uploadEnabled: Boolean(opts.uploadStore)
  });
  const app = express();
  const transports = /* @__PURE__ */ new Map();
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      transport: "streamable-http",
      sessions: transports.size,
      version: opts.version
    });
  });
  app.use((req, res, next) => {
    if (opts.allowedHosts.length > 0 && !isAllowedHost(req.headers.host, opts.allowedHosts)) {
      res.status(403).json({ error: "Invalid Host header" });
      return;
    }
    next();
  });
  if (opts.uploadStore) {
    const allowUploadOrigin = (req, res) => {
      const origin = req.headers.origin;
      if (!origin) return true;
      if (!opts.uploadAllowedOrigins.includes(origin)) {
        res.status(403).json({ error: "Origin is not allowed" });
        return false;
      }
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      return true;
    };
    app.options("/upload/:token", (req, res) => {
      if (!allowUploadOrigin(req, res)) return;
      res.setHeader("Access-Control-Allow-Methods", "PUT, OPTIONS");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Content-Length"
      );
      res.setHeader("Access-Control-Max-Age", "600");
      res.status(204).end();
    });
    app.put("/upload/:token", async (req, res) => {
      if (!allowUploadOrigin(req, res)) return;
      await opts.uploadStore.handleUpload(req, res, req.params.token);
    });
    app.get("/media/:token", async (req, res) => {
      await opts.uploadStore.handleDownload(req, res, req.params.token);
    });
    app.head("/media/:token", async (req, res) => {
      await opts.uploadStore.handleDownload(req, res, req.params.token);
    });
  }
  const requireAuth = (req, res) => {
    if (!opts.token) return true;
    const header = req.headers.authorization || "";
    const expected = Buffer.from(`Bearer ${opts.token}`);
    const supplied = Buffer.from(header);
    if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) {
      return true;
    }
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized" },
      id: null
    });
    return false;
  };
  const authorizeMcpRequest = (req, res, next) => {
    if (!requireAuth(req, res)) return;
    const origin = req.headers.origin;
    if (origin && opts.allowedOrigins.length > 0 && !opts.allowedOrigins.includes(origin)) {
      res.status(403).json({
        jsonrpc: "2.0",
        error: { code: -32002, message: "Origin is not allowed" },
        id: null
      });
      return;
    }
    next();
  };
  const mcpJsonParser = express.json({ limit: "10mb" });
  const securityOpts = opts.allowedHosts.length > 0 ? {
    enableDnsRebindingProtection: true,
    allowedHosts: opts.allowedHosts,
    ...opts.allowedOrigins.length > 0 ? { allowedOrigins: opts.allowedOrigins } : {}
  } : {};
  const onError = (res, error) => {
    console.error("[Kie.ai MCP] HTTP handler error:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null
      });
    }
  };
  app.post(
    "/mcp",
    authorizeMcpRequest,
    mcpJsonParser,
    async (req, res) => {
      const sessionId = req.headers["mcp-session-id"];
      let transport = sessionId ? transports.get(sessionId) : void 0;
      try {
        if (!transport) {
          if (sessionId) {
            res.status(404).json({
              jsonrpc: "2.0",
              error: { code: -32001, message: "Session not found" },
              id: null
            });
            return;
          }
          if (!isInitializeRequest(req.body)) {
            res.status(400).json({
              jsonrpc: "2.0",
              error: {
                code: -32e3,
                message: "Bad Request: missing session ID for a non-init request"
              },
              id: null
            });
            return;
          }
          const newSessionId = randomUUID2();
          transport = new NodeStreamableHTTPServerTransport({
            sessionIdGenerator: () => newSessionId,
            onsessioninitialized: () => {
              transports.set(newSessionId, transport);
            },
            ...securityOpts
          });
          transport.onclose = () => {
            if (transport.sessionId) transports.delete(transport.sessionId);
          };
          await opts.createServer(newSessionId).connect(transport);
        }
        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        onError(res, error);
      }
    }
  );
  const handleSessionRequest = async (req, res) => {
    if (!requireAuth(req, res)) return;
    const sessionId = req.headers["mcp-session-id"];
    if (!sessionId) {
      res.status(400).send("Missing Mcp-Session-Id header");
      return;
    }
    const transport = transports.get(sessionId);
    if (!transport) {
      res.status(404).send("Session not found");
      return;
    }
    try {
      await transport.handleRequest(req, res);
    } catch (error) {
      onError(res, error);
    }
  };
  app.get("/mcp", handleSessionRequest);
  app.delete("/mcp", handleSessionRequest);
  return app;
}
function startHttpServer(options) {
  const opts = resolveOptions(options);
  const app = createHttpApp(opts);
  const server = app.listen(opts.port, opts.host, () => {
    console.error(
      `[Kie.ai MCP] Streamable HTTP transport listening on http://${opts.host}:${opts.port}/mcp (health: /health, auth: ${opts.token ? "bearer token" : "none"}, dns-rebind protection: ${opts.allowedHosts.length > 0 ? "on" : "off"}, temporary uploads: ${opts.uploadStore ? "on" : "off"})`
    );
  });
  if (opts.uploadStore) {
    server.on("close", () => void opts.uploadStore.close());
  }
  return server;
}

// src/plan-approval.ts
function priceSummary(plan) {
  return plan.total.status === "exact" ? `${plan.total.credits} credits total (verified exact quote)` : "total price unknown because one or more request dimensions lack a verified formula";
}
function formatPlanApprovalMessage(plan) {
  const items = plan.items.map((item) => {
    const price = item.price.status === "exact" ? `${item.price.credits} credits` : "price unknown";
    return [
      `${item.index + 1}. ${item.tool}: ${item.model}, ${item.mode}, ${item.outputCount} output(s), ${price}`,
      `Resolved settings: ${JSON.stringify(item.effectiveSettings)}`
    ].join("\n");
  }).join("\n");
  return [
    `Approve media generation plan ${plan.id}?`,
    `Expires: ${plan.expiresAt}. Max concurrent creates: ${plan.maxConcurrency}.`,
    `Price: ${priceSummary(plan)}.`,
    items,
    "No provider task has been created. Confirming will record approval only; submission is a separate call."
  ].join("\n");
}
var APPROVAL_FORM_SCHEMA = {
  type: "object",
  properties: {
    confirm: {
      type: "boolean",
      title: "Approve this media generation plan",
      default: false
    }
  },
  required: ["confirm"]
};
var MODERN_PROTOCOL_SINCE = "2026-07-28";
function isModernEra(server) {
  const negotiated = server.getNegotiatedProtocolVersion();
  return negotiated !== void 0 && negotiated >= MODERN_PROTOCOL_SINCE;
}
async function requestMcpPlanApproval(server, plan, serverCtx) {
  if (isModernEra(server)) {
    const responses = serverCtx?.mcpReq?.inputResponses;
    if (responses && "confirm" in responses) {
      const accepted = acceptedContent(
        responses,
        "confirm"
      );
      return accepted ? {
        approved: accepted.confirm === true,
        reason: "Host confirmed the plan."
      } : {
        approved: false,
        reason: "Host declined the approval request."
      };
    }
    return {
      approved: false,
      reason: "Host approval required for media generation plan.",
      inputRequired: true
    };
  }
  if (!server.getClientCapabilities()?.elicitation) {
    return {
      approved: false,
      reason: "MCP client does not support form elicitation, so this plan remains unapproved."
    };
  }
  const response = await server.elicitInput({
    mode: "form",
    message: formatPlanApprovalMessage(plan),
    requestedSchema: APPROVAL_FORM_SCHEMA
  });
  if (response.action === "accept" && response.content?.confirm === true) {
    return { approved: true, reason: "Host confirmed the plan." };
  }
  return {
    approved: false,
    reason: response.action === "accept" ? "Host accepted the form without confirming the plan." : response.action === "cancel" ? "Host cancelled the approval request." : "Host declined the approval request."
  };
}
function approvalInputRequired(plan) {
  return inputRequired({
    inputRequests: {
      confirm: inputRequired.elicit({
        message: formatPlanApprovalMessage(plan),
        requestedSchema: APPROVAL_FORM_SCHEMA
      })
    }
  });
}

// src/principal.ts
import { createHash as createHash2 } from "node:crypto";
var STDIO_PRINCIPAL = "stdio";
function principalApprovalId(principal) {
  return createHash2("sha256").update(`mcp-principal:${principal}`).digest("hex");
}

// src/result-normalization.ts
function normalizeToolResult(result) {
  if (result.structuredContent !== void 0) return result;
  const text = result.content[0]?.text;
  if (!text) return result;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return result;
  }
  if (typeof parsed !== "object" || parsed === null) return result;
  const record3 = parsed;
  if (typeof record3.task_id !== "string") return result;
  const structuredContent = {
    task_id: record3.task_id
  };
  for (const key of ["status", "api_type", "error"]) {
    if (typeof record3[key] === "string") {
      structuredContent[key] = record3[key];
    }
  }
  return { ...result, structuredContent };
}

// src/tasks.ts
import { randomUUID as randomUUID3 } from "node:crypto";
var DEFAULT_TTL_MS = 15 * 60 * 1e3;
var DEFAULT_POLL_INTERVAL_MS = 1e3;
var TaskEngine = class {
  byId = /* @__PURE__ */ new Map();
  db;
  now;
  constructor(db, now = Date.now) {
    this.db = db;
    this.now = now;
  }
  start(toolName, run, options = {}) {
    const now = this.now();
    const ttl = Math.max(1, options.ttl ?? DEFAULT_TTL_MS);
    const task = {
      taskId: randomUUID3(),
      status: "working",
      ttl,
      pollInterval: Math.max(
        100,
        options.pollInterval ?? DEFAULT_POLL_INTERVAL_MS
      ),
      createdAt: new Date(now),
      lastUpdatedAt: new Date(now),
      expiresAt: now + ttl,
      toolName
    };
    this.byId.set(task.taskId, task);
    void this.db.createTask({
      task_id: task.taskId,
      api_type: "mcp-task",
      status: "processing"
    }).catch(() => void 0);
    task.status = "working";
    task.lastUpdatedAt = new Date(now);
    void run().then((result) => {
      task.status = "completed";
      task.result = result;
      task.lastUpdatedAt = new Date(this.now());
      void this.db.updateTask(task.taskId, { status: "completed" }).catch(() => void 0);
    }).catch((error) => {
      task.status = "failed";
      task.error = error instanceof Error ? error.message : String(error);
      task.lastUpdatedAt = new Date(this.now());
      void this.db.updateTask(task.taskId, {
        status: "failed",
        error_message: task.error
      }).catch(() => void 0);
    });
    return task;
  }
  get(taskId) {
    const task = this.byId.get(taskId);
    if (!task) return void 0;
    if (task.expiresAt <= this.now()) return void 0;
    return task;
  }
  cancel(taskId) {
    const task = this.byId.get(taskId);
    if (!task) return void 0;
    if (task.status === "completed" || task.status === "failed") return task;
    task.status = "cancelled";
    task.error = "Task cancelled by the client.";
    task.lastUpdatedAt = new Date(this.now());
    void this.db.updateTask(task.taskId, {
      status: "failed",
      error_message: task.error
    }).catch(() => void 0);
    return task;
  }
  list() {
    const now = this.now();
    const tasks = [];
    for (const task of this.byId.values()) {
      if (task.expiresAt > now) tasks.push(task);
    }
    return tasks.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }
};
function taskToWire(task) {
  return {
    taskId: task.taskId,
    status: task.status,
    ttl: task.ttl,
    createdAt: task.createdAt.toISOString(),
    lastUpdatedAt: task.lastUpdatedAt.toISOString(),
    pollInterval: task.pollInterval,
    ...task.statusMessage ? { statusMessage: task.statusMessage } : {}
  };
}

// src/tool-access.ts
function allowsDirectGeneration() {
  return process.env.KIE_AI_ALLOW_DIRECT_GENERATION === "true";
}
function isMcpToolCallable(tool, enabledTools, allowDirectGeneration = allowsDirectGeneration()) {
  return enabledTools.has(tool.name) && (tool.category === "utility" || allowDirectGeneration);
}

// src/upload-storage.ts
import { createHash as createHash3, randomBytes, randomUUID as randomUUID4 } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  mkdirSync as mkdirSync2,
  readdirSync,
  rmSync,
  statSync
} from "node:fs";
import { open, rename, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
var TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
function tokenHash(token) {
  return createHash3("sha256").update(token).digest("hex");
}
function createToken() {
  return randomBytes(32).toString("base64url");
}
function validatePublicBaseUrl(value) {
  const url3 = new URL(value);
  const loopback = url3.hostname === "127.0.0.1" || url3.hostname === "localhost" || url3.hostname === "::1";
  if (url3.username || url3.password || url3.search || url3.hash || url3.protocol !== "https:" && !(url3.protocol === "http:" && loopback)) {
    throw new Error(
      "KIE_MCP_PUBLIC_BASE_URL must be HTTPS without credentials, query, or fragment."
    );
  }
  if (url3.pathname !== "/" && url3.pathname !== "") {
    throw new Error(
      "KIE_MCP_PUBLIC_BASE_URL must be an origin without a path."
    );
  }
  url3.pathname = "/";
  return url3;
}
var TemporaryUploadStore = class {
  baseUrl;
  rootDirectory;
  directory;
  byUpload = /* @__PURE__ */ new Map();
  byDownload = /* @__PURE__ */ new Map();
  records = /* @__PURE__ */ new Set();
  maxFileBytes;
  maxFiles;
  maxTotalBytes;
  maxOwnerFiles;
  maxOwnerBytes;
  uploadTtlMs;
  downloadTtlMs;
  maxDownloadRequests;
  uploadIdleTimeoutMs;
  uploadMaxDurationMs;
  now;
  cleanupTimer;
  reservedBytes = 0;
  constructor(options) {
    this.baseUrl = validatePublicBaseUrl(options.publicBaseUrl);
    this.maxFileBytes = options.maxFileBytes ?? 25 * 1024 * 1024;
    this.maxFiles = options.maxFiles ?? 64;
    this.maxTotalBytes = options.maxTotalBytes ?? 500 * 1024 * 1024;
    this.maxOwnerFiles = options.maxOwnerFiles ?? 4;
    this.maxOwnerBytes = options.maxOwnerBytes ?? 100 * 1024 * 1024;
    this.uploadTtlMs = options.uploadTtlMs ?? 10 * 60 * 1e3;
    this.downloadTtlMs = options.downloadTtlMs ?? 60 * 60 * 1e3;
    this.maxDownloadRequests = options.maxDownloadRequests ?? 32;
    this.uploadIdleTimeoutMs = options.uploadIdleTimeoutMs ?? 3e4;
    this.uploadMaxDurationMs = options.uploadMaxDurationMs ?? 2 * 6e4;
    this.now = options.now ?? Date.now;
    this.rootDirectory = join(
      options.storageRoot ?? tmpdir(),
      "kie-mcp-uploads"
    );
    mkdirSync2(this.rootDirectory, { recursive: true, mode: 448 });
    this.directory = join(this.rootDirectory, `instance-${randomUUID4()}`);
    mkdirSync2(this.directory, { recursive: true, mode: 448 });
    this.sweepStaleInstances();
    this.cleanupTimer = setInterval(() => void this.cleanup(), 6e4);
    this.cleanupTimer.unref();
  }
  get publicOrigin() {
    return this.baseUrl.origin;
  }
  async createCapability(request) {
    await this.cleanup();
    const contentType = normalizeUploadMimeType(request.contentType);
    if (!contentType) throw new Error("Unsupported upload content type.");
    if (!Number.isSafeInteger(request.size) || request.size <= 0) {
      throw new Error("Upload size must be a positive integer.");
    }
    if (request.size > this.maxFileBytes) {
      throw new Error("Upload exceeds the per-file limit.");
    }
    const ownerRecords = [...this.records].filter(
      (record4) => record4.owner === request.owner
    );
    const ownerBytes = ownerRecords.reduce(
      (sum, record4) => sum + record4.size,
      0
    );
    if (ownerRecords.length >= this.maxOwnerFiles || ownerBytes + request.size > this.maxOwnerBytes) {
      throw new Error("Upload owner quota exceeded.");
    }
    if (this.records.size >= this.maxFiles || this.reservedBytes + request.size > this.maxTotalBytes) {
      throw new Error("Temporary upload storage capacity exceeded.");
    }
    const id = randomUUID4();
    const uploadToken = createToken();
    const now = this.now();
    const record3 = {
      id,
      owner: request.owner,
      filename: request.filename,
      contentType,
      size: request.size,
      uploadHash: tokenHash(uploadToken),
      uploadExpiresAt: now + this.uploadTtlMs,
      storageExpiresAt: now + this.downloadTtlMs,
      partPath: join(this.directory, `${id}.part`),
      finalPath: join(this.directory, `${id}.media`),
      state: "pending",
      downloadRequests: 0,
      egressBytes: 0
    };
    this.records.add(record3);
    this.byUpload.set(record3.uploadHash, record3);
    this.reservedBytes += record3.size;
    return {
      uploadUrl: new URL(`upload/${uploadToken}`, this.baseUrl).toString(),
      mediaId: record3.id,
      uploadExpiresAt: new Date(record3.uploadExpiresAt).toISOString()
    };
  }
  async createProviderDownload(request) {
    await this.cleanup();
    const record3 = [...this.records].find(
      (candidate) => candidate.id === request.mediaId && candidate.owner === request.owner
    );
    if (!record3 || record3.state !== "complete" || record3.storageExpiresAt <= this.now()) {
      throw new Error("Media not found or not ready.");
    }
    if (record3.downloadHash) this.byDownload.delete(record3.downloadHash);
    const token = createToken();
    record3.downloadHash = tokenHash(token);
    record3.downloadExpiresAt = Math.min(
      this.now() + this.downloadTtlMs,
      record3.storageExpiresAt
    );
    record3.downloadRequests = 0;
    record3.egressBytes = 0;
    this.byDownload.set(record3.downloadHash, record3);
    return {
      url: new URL(`media/${token}`, this.baseUrl).toString(),
      filename: record3.filename,
      contentType: record3.contentType,
      size: record3.size
    };
  }
  async removeMedia(mediaId, owner) {
    const record3 = [...this.records].find(
      (candidate) => candidate.id === mediaId && candidate.owner === owner
    );
    if (record3) await this.removeRecord(record3);
  }
  async handleUpload(req, res, token) {
    if (!TOKEN_PATTERN.test(token)) {
      res.status(404).end();
      return;
    }
    const hash = tokenHash(token);
    const record3 = this.byUpload.get(hash);
    if (!record3 || record3.state !== "pending" || record3.uploadExpiresAt <= this.now()) {
      res.status(404).end();
      return;
    }
    const declaredLength = Number(req.headers["content-length"]);
    if (Number.isFinite(declaredLength) && declaredLength !== record3.size) {
      res.status(413).json({ error: "Upload byte count does not match the capability." });
      return;
    }
    const requestType = normalizeUploadMimeType(
      String(req.headers["content-type"] ?? "")
    );
    if (!requestType || requestType !== record3.contentType) {
      res.status(415).json({ error: "Content-Type does not match the capability." });
      return;
    }
    this.byUpload.delete(hash);
    record3.state = "uploading";
    let timedOut = false;
    req.setTimeout(this.uploadIdleTimeoutMs, () => {
      timedOut = true;
      req.destroy(new Error("Upload inactivity timeout."));
    });
    const absoluteTimeout = setTimeout(() => {
      timedOut = true;
      req.destroy(new Error("Upload duration timeout."));
    }, this.uploadMaxDurationMs);
    absoluteTimeout.unref();
    let received = 0;
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (received > record3.size) {
          callback(new Error("Upload exceeded the declared byte count."));
          return;
        }
        callback(null, chunk);
      }
    });
    try {
      await pipeline(
        req,
        limiter,
        createWriteStream(record3.partPath, { flags: "wx", mode: 384 })
      );
      if (received !== record3.size) {
        throw new Error("Upload ended before the declared byte count.");
      }
      const handle = await open(record3.partPath, "r");
      try {
        const head = Buffer.alloc(Math.min(64, record3.size));
        const { bytesRead } = await handle.read(head, 0, head.length, 0);
        validateUploadBytes(head.subarray(0, bytesRead), record3.contentType);
      } finally {
        await handle.close();
      }
      await rename(record3.partPath, record3.finalPath);
      record3.state = "complete";
      res.status(201).json({
        success: true,
        media_id: record3.id,
        expires_at: new Date(record3.storageExpiresAt).toISOString()
      });
    } catch {
      await this.removeRecord(record3);
      if (!res.headersSent) {
        res.status(timedOut ? 408 : received > record3.size ? 413 : 400).json({
          error: "Upload failed validation or did not complete."
        });
      }
    } finally {
      clearTimeout(absoluteTimeout);
      req.setTimeout(0);
    }
  }
  async handleDownload(req, res, token) {
    if (!TOKEN_PATTERN.test(token)) {
      res.status(404).end();
      return;
    }
    const record3 = this.byDownload.get(tokenHash(token));
    const isHead = req.method === "HEAD";
    if (!record3 || record3.state !== "complete" || !record3.downloadExpiresAt || record3.downloadExpiresAt <= this.now() || record3.downloadRequests >= this.maxDownloadRequests || !isHead && record3.egressBytes + record3.size > record3.size * 4) {
      res.status(404).end();
      return;
    }
    record3.downloadRequests += 1;
    if (!isHead) record3.egressBytes += record3.size;
    res.setHeader("Content-Type", record3.contentType);
    res.setHeader("Content-Length", String(record3.size));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(record3.filename)}`
    );
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (isHead) {
      res.status(200).end();
      return;
    }
    createReadStream(record3.finalPath).on("error", () => {
      if (!res.headersSent) res.status(404).end();
      else res.destroy();
    }).pipe(res);
  }
  async cleanup() {
    this.sweepStaleInstances();
    const now = this.now();
    await Promise.all(
      [...this.records].filter(
        (record3) => record3.storageExpiresAt <= now || record3.state !== "complete" && record3.uploadExpiresAt <= now
      ).map((record3) => this.removeRecord(record3))
    );
  }
  async close() {
    clearInterval(this.cleanupTimer);
    await rm(this.directory, { recursive: true, force: true });
    this.byUpload.clear();
    this.byDownload.clear();
    this.records.clear();
    this.reservedBytes = 0;
  }
  async removeRecord(record3) {
    if (!this.records.delete(record3)) return;
    this.byUpload.delete(record3.uploadHash);
    if (record3.downloadHash) this.byDownload.delete(record3.downloadHash);
    this.reservedBytes -= record3.size;
    await Promise.all([
      unlink(record3.partPath).catch(() => void 0),
      unlink(record3.finalPath).catch(() => void 0)
    ]);
  }
  sweepStaleInstances() {
    for (const entry of readdirSync(this.rootDirectory)) {
      const candidate = join(this.rootDirectory, entry);
      if (candidate === this.directory) continue;
      try {
        if (entry.startsWith("instance-") && statSync(candidate).mtimeMs < this.now() - this.downloadTtlMs) {
          rmSync(candidate, { recursive: true, force: true });
        }
      } catch {
      }
    }
  }
};

// src/widget-grants.ts
import { createHash as createHash4, randomBytes as randomBytes2 } from "node:crypto";
var GRANT_TTL_MS = 10 * 60 * 1e3;
var MAX_ACTIVE_GRANTS_PER_OWNER = 16;
var MAX_USES_PER_GRANT = 4;
var TOKEN_BYTES = 32;
var WidgetGrantService = class {
  byOwner = /* @__PURE__ */ new Map();
  now;
  constructor(now = Date.now) {
    this.now = now;
  }
  createGrant(owner) {
    const grants = this.grantsFor(owner);
    const currentTime = this.now();
    for (const [key, record3] of grants) {
      if (record3.expiresAt <= currentTime) grants.delete(key);
    }
    while (grants.size >= MAX_ACTIVE_GRANTS_PER_OWNER) {
      const oldest = grants.keys().next().value;
      if (!oldest) break;
      grants.delete(oldest);
    }
    const grant = randomBytes2(TOKEN_BYTES).toString("base64url");
    grants.set(this.hash(grant), {
      expiresAt: currentTime + GRANT_TTL_MS,
      uses: 0
    });
    return grant;
  }
  validateGrant(owner, grant) {
    const grants = this.grantsFor(owner);
    const key = this.hash(grant);
    const record3 = grants.get(key);
    if (!record3 || record3.expiresAt <= this.now() || record3.uses >= MAX_USES_PER_GRANT) {
      grants.delete(key);
      if (grants.size === 0) this.byOwner.delete(owner);
      return false;
    }
    record3.uses += 1;
    return true;
  }
  grantsFor(owner) {
    let grants = this.byOwner.get(owner);
    if (!grants) {
      grants = /* @__PURE__ */ new Map();
      this.byOwner.set(owner, grants);
    }
    return grants;
  }
  hash(value) {
    return createHash4("sha256").update(value).digest("hex");
  }
};

// src/index.ts
var KieAiMcpServer = class _KieAiMcpServer {
  server;
  client;
  db;
  config;
  enabledTools;
  toolContext;
  widgetGrants = new WidgetGrantService();
  taskEngine;
  tasksEnabled = process.env.KIE_AI_MCP_TASKS === "true";
  // Utility tools are derived from the registry's `category` field, not a
  // hardcoded list, so they are always-on by definition: any tool marked
  // `category: "utility"` (get_task_status, list_tasks, wait_for_task) cannot be
  // disabled or filtered out, and adding a new one never needs mirroring here.
  static UTILITY_TOOLS = TOOL_REGISTRY.filter(
    (t) => t.category === "utility"
  ).map((t) => t.name);
  static TOOL_CATEGORIES = {
    image: [
      "nano_banana_image",
      "bytedance_seedream_image",
      "qwen_image",
      "gpt_image_2",
      "flux_kontext_image",
      "flux2_image",
      "z_image",
      "topaz_upscale_image",
      "recraft_remove_background",
      "ideogram_reframe",
      "midjourney_generate"
      // Also generates images (6 modes: txt2img, img2img, style ref, omni ref, video SD/HD)
    ],
    video: [
      "veo3_generate_video",
      "veo3_get_1080p_video",
      "bytedance_seedance_video",
      "wan_video",
      "wan_animate",
      "happyhorse_video",
      "hailuo_video",
      "kling_video",
      "runway_aleph_video",
      "grok_imagine",
      // xAI multimodal: text/image-to-image, text/image-to-video, upscale
      "infinitalk_lip_sync",
      // MeiGen-AI lip sync video generator
      "kling_avatar",
      // Kuaishou talking avatar video generator
      "midjourney_generate"
      // Also generates videos (mj_video, mj_video_hd modes)
    ],
    audio: ["suno_generate_music", "elevenlabs_tts", "elevenlabs_ttsfx"],
    utility: _KieAiMcpServer.UTILITY_TOOLS
  };
  // Derived from the registry so every registered tool is always enabled-eligible.
  // TOOL_CATEGORIES (above) only drives the optional KIE_AI_TOOL_CATEGORIES filter;
  // a tool missing from it can still run, it just isn't selectable by category.
  static ALL_TOOLS = TOOL_REGISTRY.map((t) => t.name);
  static VERSION = "5.1.0";
  constructor() {
    this.config = {
      apiKey: process.env.KIE_AI_API_KEY || "",
      baseUrl: process.env.KIE_AI_BASE_URL || "https://api.kie.ai/api/v1",
      timeout: parseInt(process.env.KIE_AI_TIMEOUT || "60000"),
      callbackUrlFallback: process.env.KIE_AI_CALLBACK_URL_FALLBACK || "https://proxy.kie.ai/mcp-callback",
      fileUploadBaseUrl: process.env.KIE_AI_FILE_UPLOAD_BASE_URL
    };
    if (!this.config.apiKey) {
      throw new Error("KIE_AI_API_KEY environment variable is required");
    }
    this.client = new KieAiClient(this.config);
    this.db = new TaskDatabase(process.env.KIE_AI_DB_PATH);
    this.taskEngine = new TaskEngine(this.db);
    this.enabledTools = this.getEnabledTools();
    this.toolContext = {
      client: this.client,
      db: this.db,
      getCallbackUrl: (url3) => this.getCallbackUrl(url3),
      formatError: formatToolError,
      // Plan utilities must resolve through the server's enabled-tool boundary,
      // not the unrestricted registry used to construct the server.
      getTool: (name) => this.enabledTools.has(name) ? getTool(name) : void 0
    };
    this.server = this.createServer();
  }
  // Build a fresh MCP Server with all handlers wired to the shared client/db
  // context. State ownership is derived from the caller principal, never from
  // the Server instance: same principal across instances => same approval
  // owner, the same widget grant space, and the same plan/upload state. This
  // keeps subsequent stateless (SDK v2) requests resolveable.
  createServer(principal = STDIO_PRINCIPAL) {
    const approvalContext = principalApprovalId(principal);
    const server = new Server(
      {
        name: "kie-ai-mcp-server",
        version: _KieAiMcpServer.VERSION
      },
      {
        // SDK v2: declare the capabilities whose request handlers are
        // registered below, the MCP Apps extension used by the upload widget,
        // and the modern cache hints for stable list/discovery results.
        capabilities: {
          tools: {},
          resources: {},
          prompts: {},
          extensions: appsExtensions,
          ...this.tasksEnabled ? { tasks: {} } : {}
        },
        cacheHints: {
          "tools/list": { cacheScope: "private", ttlMs: 6e4 },
          "server/discover": { cacheScope: "private", ttlMs: 6e4 }
        }
      }
    );
    this.setupHandlers(
      server,
      {
        ...this.toolContext,
        approvalContext
      },
      principal
    );
    return server;
  }
  validateToolNames(tools) {
    const invalidTools = tools.filter(
      (tool) => !_KieAiMcpServer.ALL_TOOLS.includes(tool)
    );
    if (invalidTools.length > 0) {
      throw new Error(
        `Invalid tool names: ${invalidTools.join(", ")}. Valid tools are: ${_KieAiMcpServer.ALL_TOOLS.join(", ")}`
      );
    }
  }
  validateCategories(categories) {
    const validCategories = Object.keys(_KieAiMcpServer.TOOL_CATEGORIES);
    const invalidCategories = categories.filter(
      (cat) => !validCategories.includes(cat)
    );
    if (invalidCategories.length > 0) {
      throw new Error(
        `Invalid categories: ${invalidCategories.join(", ")}. Valid categories are: ${validCategories.join(", ")}`
      );
    }
  }
  getEnabledTools() {
    const enabledToolsEnv = process.env.KIE_AI_ENABLED_TOOLS;
    const categoriesEnv = process.env.KIE_AI_TOOL_CATEGORIES;
    const disabledToolsEnv = process.env.KIE_AI_DISABLED_TOOLS;
    if (enabledToolsEnv) {
      const tools = enabledToolsEnv.split(",").map((t) => t.trim()).filter(Boolean);
      this.validateToolNames(tools);
      const allTools = [
        .../* @__PURE__ */ new Set([...tools, ..._KieAiMcpServer.TOOL_CATEGORIES.utility])
      ];
      console.error(
        `[Kie.ai MCP] Tool filtering enabled: whitelist mode (${tools.length} specified + ${_KieAiMcpServer.TOOL_CATEGORIES.utility.length} utility = ${allTools.length} tools)`
      );
      return new Set(allTools);
    }
    if (categoriesEnv) {
      const categories = categoriesEnv.split(",").map((c) => c.trim()).filter(Boolean);
      this.validateCategories(categories);
      const tools = [];
      for (const category of categories) {
        const categoryTools = _KieAiMcpServer.TOOL_CATEGORIES[category];
        tools.push(...categoryTools);
      }
      tools.push(..._KieAiMcpServer.TOOL_CATEGORIES.utility);
      const uniqueTools = [...new Set(tools)];
      console.error(
        `[Kie.ai MCP] Tool filtering enabled: category mode (${categories.join(", ")}) - ${uniqueTools.length} tools (includes utility)`
      );
      return new Set(uniqueTools);
    }
    if (disabledToolsEnv) {
      const disabledTools = disabledToolsEnv.split(",").map((t) => t.trim()).filter(Boolean);
      this.validateToolNames(disabledTools);
      const disabledUtilityTools = disabledTools.filter(
        (t) => _KieAiMcpServer.TOOL_CATEGORIES.utility.includes(t)
      );
      if (disabledUtilityTools.length > 0) {
        console.error(
          `[Kie.ai MCP] Warning: Cannot disable utility tools (${disabledUtilityTools.join(", ")}). These tools are always enabled for server monitoring.`
        );
      }
      const nonUtilityDisabled = disabledTools.filter(
        (t) => !_KieAiMcpServer.TOOL_CATEGORIES.utility.includes(t)
      );
      const tools = _KieAiMcpServer.ALL_TOOLS.filter(
        (t) => !nonUtilityDisabled.includes(t)
      );
      console.error(
        `[Kie.ai MCP] Tool filtering enabled: blacklist mode (${nonUtilityDisabled.length} tools disabled, ${tools.length} enabled, utility always on)`
      );
      return new Set(tools);
    }
    console.error(
      `[Kie.ai MCP] Tool filtering: all tools enabled (${_KieAiMcpServer.ALL_TOOLS.length} tools)`
    );
    return new Set(_KieAiMcpServer.ALL_TOOLS);
  }
  getCallbackUrl(userUrl) {
    return userUrl || process.env.KIE_AI_CALLBACK_URL || this.config.callbackUrlFallback;
  }
  setupHandlers(server, toolContext, principal) {
    const owner = principalApprovalId(principal);
    const scopedContext = {
      ...toolContext,
      createWidgetGrant: () => this.widgetGrants.createGrant(owner),
      validateWidgetGrant: (grant) => this.widgetGrants.validateGrant(owner, grant)
    };
    server.setRequestHandler("tools/list", async () => {
      const tools = TOOL_REGISTRY.filter(
        (t) => isMcpToolCallable(t, this.enabledTools)
      ).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: toInputJsonSchema(
          t.schema
        ),
        ...this.tasksEnabled ? { execution: { taskSupport: "optional" } } : {},
        ...toolOutputSchema(t) ? {
          outputSchema: toolOutputSchema(
            t
          )
        } : {},
        ...t.ui ? {
          _meta: {
            ui: {
              ...t.ui.resourceUri ? { resourceUri: t.ui.resourceUri } : {},
              ...t.ui.visibility ? { visibility: t.ui.visibility } : {}
            },
            ...t.ui.resourceUri ? { "ui/resourceUri": t.ui.resourceUri } : {}
          }
        } : {}
      }));
      return { tools };
    });
    server.setRequestHandler("tools/call", async (request, serverCtx) => {
      try {
        const { name, arguments: args } = request.params;
        const tool = getTool(name);
        if (!tool) {
          throw new ProtocolError(
            ProtocolErrorCode.MethodNotFound,
            `Unknown tool: ${name}`
          );
        }
        if (!this.enabledTools.has(name)) {
          throw new ProtocolError(
            ProtocolErrorCode.InvalidRequest,
            `Tool '${name}' is not enabled. This tool has been disabled by server configuration. Please check KIE_AI_ENABLED_TOOLS, KIE_AI_TOOL_CATEGORIES, or KIE_AI_DISABLED_TOOLS environment variables.`
          );
        }
        if (!isMcpToolCallable(tool, this.enabledTools)) {
          throw new ProtocolError(
            ProtocolErrorCode.InvalidRequest,
            `Tool '${name}' requires prepare_media_generation, host approval, and submit_media_generation. Set KIE_AI_ALLOW_DIRECT_GENERATION=true only to explicitly bypass approval safeguards.`
          );
        }
        const progressToken = request.params._meta?.progressToken;
        const requestContext = {
          ...scopedContext,
          requestPlanApproval: (plan) => requestMcpPlanApproval(server, plan, serverCtx)
        };
        const ctx = progressToken === void 0 ? requestContext : {
          ...requestContext,
          onProgress: async (update) => {
            try {
              await serverCtx.mcpReq.notify({
                method: "notifications/progress",
                params: { progressToken, ...update }
              });
            } catch {
            }
          }
        };
        const taskParam = request.params.task;
        if (taskParam) {
          if (!this.tasksEnabled) {
            throw new ProtocolError(
              ProtocolErrorCode.InvalidRequest,
              "Task mode is disabled. Set KIE_AI_MCP_TASKS=true to enable official MCP Tasks."
            );
          }
          const negotiated = server.getNegotiatedProtocolVersion();
          if (negotiated === void 0 || negotiated < "2026-07-28") {
            throw new ProtocolError(
              ProtocolErrorCode.InvalidRequest,
              "Task mode requires the 2026-07-28 protocol revision, which the installed MCP SDK cannot negotiate yet."
            );
          }
          const task = this.taskEngine.start(
            name,
            async () => normalizeToolResult(await tool.run(args, requestContext)),
            taskParam
          );
          return { task: taskToWire(task) };
        }
        const toolResult = normalizeToolResult(await tool.run(args, ctx));
        if (toolResult.structuredContent?.input_required === true) {
          const plan = toolResult._meta?.["kie/approval-plan"];
          if (plan) return approvalInputRequired(plan);
        }
        return toolResult;
      } catch (error) {
        if (error instanceof ProtocolError) {
          throw error;
        }
        const message = error instanceof Error ? error.message : "Unknown error";
        throw new ProtocolError(ProtocolErrorCode.InternalError, message);
      }
    });
    server.setRequestHandler("resources/list", async () => {
      const toolResources = TOOL_REGISTRY.filter(
        (t) => isMcpToolCallable(t, this.enabledTools) && (!t.ui?.visibility || t.ui.visibility.includes("model"))
      ).map((t) => ({
        uri: `kie://tools/${t.name}`,
        name: t.name,
        description: t.description,
        mimeType: "text/markdown",
        annotations: { audience: ["assistant"], priority: 0.6 }
      }));
      const appsSupported = Boolean(
        server.getClientCapabilities()?.extensions?.["io.modelcontextprotocol/ui"]
      );
      const guideResources = [
        ...appsSupported && isMcpToolCallable(getTool("upload_widget"), this.enabledTools) ? [
          {
            uri: UPLOAD_WIDGET_URI,
            name: "Secure Media Upload",
            description: "Minimal MCP Apps file picker for temporary media uploads",
            mimeType: UPLOAD_WIDGET_MIME,
            annotations: { audience: ["user"], priority: 0.8 }
          }
        ] : [],
        {
          uri: "kie://guides/image-models-comparison",
          name: "Image Models Comparison",
          description: "Feature matrix comparing all image generation models",
          mimeType: "text/markdown",
          annotations: { audience: ["assistant"], priority: 0.5 }
        },
        {
          uri: "kie://guides/video-models-comparison",
          name: "Video Models Comparison",
          description: "Feature matrix comparing all video generation models",
          mimeType: "text/markdown",
          annotations: { audience: ["assistant"], priority: 0.5 }
        },
        {
          uri: "kie://guides/quality-optimization",
          name: "Quality & Cost Optimization",
          description: "Resolution settings, quality levels, and cost control strategies",
          mimeType: "text/markdown",
          annotations: { audience: ["assistant"], priority: 0.6 }
        },
        {
          uri: "kie://tasks/active",
          name: "Active Generation Tasks",
          description: "Real-time status of all currently active AI generation tasks",
          mimeType: "application/json",
          annotations: { audience: ["user", "assistant"], priority: 0.4 }
        },
        {
          uri: "kie://stats/usage",
          name: "Usage Statistics",
          description: "Current usage statistics and cost tracking",
          mimeType: "application/json",
          annotations: { audience: ["user"], priority: 0.3 }
        }
      ];
      return {
        resources: [...toolResources, ...guideResources]
      };
    });
    server.setRequestHandler("resources/read", async (request) => {
      const { uri } = request.params;
      if (uri === UPLOAD_WIDGET_URI) {
        const widgetTool = getTool("upload_widget");
        if (!widgetTool || !isMcpToolCallable(widgetTool, this.enabledTools)) {
          throw new ProtocolError(
            ProtocolErrorCode.InvalidParams,
            `Resource not found: ${uri}`
          );
        }
        const publicOrigin = scopedContext.getUploadPublicOrigin?.();
        return {
          contents: [
            {
              uri,
              mimeType: UPLOAD_WIDGET_MIME,
              text: UPLOAD_WIDGET_HTML,
              _meta: {
                ui: {
                  csp: {
                    connectDomains: publicOrigin ? [publicOrigin] : [],
                    resourceDomains: [],
                    frameDomains: [],
                    baseUriDomains: []
                  },
                  prefersBorder: true
                }
              }
            }
          ]
        };
      }
      const toolMatch = uri.match(/^kie:\/\/tools\/(.+)$/);
      if (toolMatch) {
        const tool = getTool(toolMatch[1]);
        if (!tool) {
          throw new ProtocolError(
            ProtocolErrorCode.InvalidParams,
            `Resource not found: ${uri}`
          );
        }
        if (!isMcpToolCallable(tool, this.enabledTools)) {
          throw new ProtocolError(
            ProtocolErrorCode.InvalidParams,
            `Resource not found: ${uri}`
          );
        }
        return {
          contents: [
            { uri, mimeType: "text/markdown", text: toolToMarkdown(tool) }
          ]
        };
      }
      switch (uri) {
        case "kie://guides/image-models-comparison":
          return {
            contents: [
              {
                uri,
                mimeType: "text/markdown",
                text: this.getImageModelsComparison()
              }
            ]
          };
        case "kie://guides/video-models-comparison":
          return {
            contents: [
              {
                uri,
                mimeType: "text/markdown",
                text: this.getVideoModelsComparison()
              }
            ]
          };
        case "kie://guides/quality-optimization":
          return {
            contents: [
              {
                uri,
                mimeType: "text/markdown",
                text: this.getQualityOptimizationGuide()
              }
            ]
          };
        case "kie://tasks/active":
          return {
            contents: [
              {
                uri,
                mimeType: "application/json",
                text: await this.getActiveTasks()
              }
            ]
          };
        case "kie://stats/usage":
          return {
            contents: [
              {
                uri,
                mimeType: "application/json",
                text: await this.getUsageStats()
              }
            ]
          };
        default:
          throw new ProtocolError(
            ProtocolErrorCode.InvalidParams,
            `Resource not found: ${uri}`
          );
      }
    });
    server.setRequestHandler("prompts/list", async () => {
      return {
        prompts: [
          {
            name: "image",
            title: "\u{1F3A8} Create Images",
            description: "Generate, edit, or enhance images using AI models. Just describe what you want and include any image URLs in your message."
          },
          {
            name: "video",
            title: "\u{1F3AC} Create Videos",
            description: "Generate videos from text or images. Describe what you want and include any image URLs to animate."
          }
        ]
      };
    });
    server.setRequestHandler("prompts/get", async (request) => {
      const { name } = request.params;
      if (name !== "image" && name !== "video") {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          `Unknown prompt: ${name}`
        );
      }
      const text = categoryPromptText(
        name,
        TOOL_REGISTRY.filter((t) => this.enabledTools.has(t.name))
      );
      return {
        description: name === "image" ? "Generate, edit, or enhance images using AI models" : "Generate videos from text or images",
        messages: [
          {
            role: "user",
            content: { type: "text", text }
          }
        ]
      };
    });
    server.setRequestHandler("server/discover", async () => {
      return buildDiscoverPayload(
        "Kie.ai media generation. Prepare media plans explicitly and approve them before submission; poll with get_task_status."
      );
    });
    if (this.tasksEnabled) {
      const notFoundTask = () => ({
        taskId: "not-found",
        status: "failed",
        ttl: 0,
        pollInterval: 0,
        createdAt: (/* @__PURE__ */ new Date(0)).toISOString(),
        lastUpdatedAt: (/* @__PURE__ */ new Date(0)).toISOString(),
        statusMessage: "Task not found or expired."
      });
      server.setRequestHandler(
        "tasks/result",
        { params: GetTaskPayloadRequestSchema, result: void 0 },
        async (request) => {
          const task = this.taskEngine.get(request.params.taskId);
          if (!task) return notFoundTask();
          if (task.status === "completed" && task.result) return task.result;
          return taskToWire(task);
        }
      );
      server.setRequestHandler(
        "tasks/list",
        { params: ListTasksRequestSchema, result: void 0 },
        async () => ({
          tasks: this.taskEngine.list().map(taskToWire)
        })
      );
      server.setRequestHandler(
        "tasks/cancel",
        { params: CancelTaskRequestSchema, result: void 0 },
        async (request) => {
          const task = this.taskEngine.cancel(request.params.taskId);
          if (!task) return { task: notFoundTask() };
          return { task: taskToWire(task) };
        }
      );
    }
  }
  // Dynamic Resource Methods
  async getActiveTasks() {
    try {
      const activeTasks = await this.db.getTasksByStatus("pending", 50);
      const processingTasks = await this.db.getTasksByStatus("processing", 50);
      return JSON.stringify(
        {
          timestamp: (/* @__PURE__ */ new Date()).toISOString(),
          active_tasks: {
            pending: activeTasks.length,
            processing: processingTasks.length,
            total: activeTasks.length + processingTasks.length
          },
          tasks: {
            pending: activeTasks.map((task) => ({
              task_id: task.task_id,
              api_type: task.api_type,
              created_at: task.created_at
            })),
            processing: processingTasks.map((task) => ({
              task_id: task.task_id,
              api_type: task.api_type,
              created_at: task.created_at
            }))
          }
        },
        null,
        2
      );
    } catch (error) {
      return JSON.stringify(
        {
          error: "Failed to retrieve active tasks",
          message: error instanceof Error ? error.message : "Unknown error",
          timestamp: (/* @__PURE__ */ new Date()).toISOString()
        },
        null,
        2
      );
    }
  }
  async getUsageStats() {
    try {
      const allTasks = await this.db.getAllTasks(1e3);
      const completedTasks = await this.db.getTasksByStatus("completed", 1e3);
      const failedTasks = await this.db.getTasksByStatus("failed", 1e3);
      const usageByType = {};
      allTasks.forEach((task) => {
        usageByType[task.api_type] = (usageByType[task.api_type] || 0) + 1;
      });
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1e3);
      const recentTasks = allTasks.filter(
        (task) => new Date(task.created_at) > oneDayAgo
      );
      return JSON.stringify(
        {
          timestamp: (/* @__PURE__ */ new Date()).toISOString(),
          total_tasks: allTasks.length,
          completed_tasks: completedTasks.length,
          failed_tasks: failedTasks.length,
          success_rate: allTasks.length > 0 ? (completedTasks.length / allTasks.length * 100).toFixed(2) + "%" : "0%",
          recent_activity: {
            last_24_hours: recentTasks.length,
            by_type: recentTasks.reduce(
              (acc, task) => {
                acc[task.api_type] = (acc[task.api_type] || 0) + 1;
                return acc;
              },
              {}
            )
          },
          usage_by_type: usageByType,
          most_used_model: Object.keys(usageByType).reduce(
            (a, b) => usageByType[a] > usageByType[b] ? a : b,
            ""
          )
        },
        null,
        2
      );
    } catch (error) {
      return JSON.stringify(
        {
          error: "Failed to retrieve usage statistics",
          message: error instanceof Error ? error.message : "Unknown error",
          timestamp: (/* @__PURE__ */ new Date()).toISOString()
        },
        null,
        2
      );
    }
  }
  async getModelsStatus() {
    const models = [
      {
        name: "veo3",
        status: "available",
        category: "video",
        quality: "premium"
      },
      {
        name: "veo3_fast",
        status: "available",
        category: "video",
        quality: "standard"
      },
      {
        name: "bytedance_seedance",
        status: "available",
        category: "video",
        quality: "professional"
      },
      {
        name: "wan_video",
        status: "available",
        category: "video",
        quality: "standard"
      },
      {
        name: "happyhorse_video",
        status: "available",
        category: "video",
        quality: "standard"
      },
      {
        name: "runway_aleph",
        status: "available",
        category: "video",
        quality: "professional"
      },
      {
        name: "nano_banana",
        status: "available",
        category: "image",
        quality: "standard"
      },
      {
        name: "qwen_image",
        status: "available",
        category: "image",
        quality: "professional"
      },
      {
        name: "gpt_image_2",
        status: "available",
        category: "image",
        quality: "professional"
      },
      {
        name: "flux_kontext",
        status: "available",
        category: "image",
        quality: "premium"
      },
      {
        name: "bytedance_seedream",
        status: "available",
        category: "image",
        quality: "professional"
      },
      {
        name: "midjourney",
        status: "available",
        category: "image",
        quality: "premium"
      },
      {
        name: "topaz_upscale_image",
        status: "available",
        category: "image",
        quality: "professional"
      },
      {
        name: "recraft_remove_background",
        status: "available",
        category: "image",
        quality: "professional"
      },
      {
        name: "ideogram_reframe",
        status: "available",
        category: "image",
        quality: "professional"
      },
      {
        name: "suno_v5",
        status: "available",
        category: "audio",
        quality: "professional"
      },
      {
        name: "elevenlabs_tts",
        status: "available",
        category: "audio",
        quality: "professional"
      },
      {
        name: "elevenlabs_sound_effects",
        status: "available",
        category: "audio",
        quality: "professional"
      }
    ];
    return JSON.stringify(
      {
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        total_models: models.length,
        available_models: models.filter((m) => m.status === "available").length,
        models_by_category: {
          video: models.filter((m) => m.category === "video"),
          image: models.filter((m) => m.category === "image"),
          audio: models.filter((m) => m.category === "audio")
        },
        models_by_quality: {
          premium: models.filter((m) => m.quality === "premium"),
          professional: models.filter((m) => m.quality === "professional"),
          standard: models.filter((m) => m.quality === "standard")
        },
        models
      },
      null,
      2
    );
  }
  async getConfigLimits() {
    const config = {
      api_config: {
        base_url: process.env.KIE_AI_BASE_URL || "https://api.kie.ai",
        timeout: parseInt(process.env.KIE_AI_TIMEOUT || "120000"),
        callback_url: process.env.KIE_AI_CALLBACK_URL || null
      },
      rate_limits: {
        requests_per_minute: 60,
        requests_per_hour: 1e3,
        concurrent_tasks: 5,
        max_file_size: "50MB",
        max_video_duration: 60,
        max_image_resolution: "4K"
      },
      model_limits: {
        video: {
          max_duration_seconds: 60,
          max_resolution: "1080p",
          supported_formats: ["mp4", "mov", "avi"],
          max_file_size: "100MB"
        },
        image: {
          max_resolution: "4K",
          supported_formats: ["png", "jpeg", "webp"],
          max_file_size: "10MB",
          max_batch_size: 4
        },
        audio: {
          max_duration_seconds: 300,
          supported_formats: ["mp3", "wav", "m4a"],
          max_file_size: "20MB"
        }
      },
      quotas: {
        daily_generation_limit: 100,
        monthly_generation_limit: 2e3,
        storage_retention_days: 30,
        max_concurrent_generations: 5
      },
      cost_controls: {
        default_quality: "standard",
        auto_upscale_enabled: false,
        cost_alert_threshold: 50,
        monthly_budget_limit: 500
      },
      features: {
        callback_support: true,
        batch_processing: true,
        status_tracking: true,
        error_recovery: true,
        quality_optimization: true
      },
      database: {
        path: process.env.KIE_AI_DB_PATH || "./tasks.db",
        max_tasks_stored: 1e4,
        cleanup_enabled: true,
        cleanup_after_days: 30
      }
    };
    return JSON.stringify(
      {
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        server_version: "1.2.0",
        configuration: config,
        warnings: [
          "Rate limits are enforced per API key",
          "Large files may take longer to process",
          "HD quality content costs significantly more",
          "Callback URLs must be publicly accessible"
        ],
        recommendations: [
          "Use standard quality for testing",
          "Monitor task status to avoid duplicate requests",
          "Clean up completed tasks regularly",
          "Set up cost alerts for production use"
        ]
      },
      null,
      2
    );
  }
  async loadQualityGuidelines() {
    return `# Quality Control Guidelines

## \u{1F3AF} Cost-Effective Defaults

### **Standard Default Settings**
- **Resolution**: Use each model's 720 tier with its exact enum spelling (\`720P\` for Wan, \`720p\` where documented elsewhere)
- **Quality**: Lite/Pro models based on user intent detection
- **Duration**: 5 seconds (optimal for most content)
- **Format**: Standard output formats

### **Quality Detection Logic**
The system automatically detects user intent:

#### **High Quality Indicators**
- Keywords: "high quality", "professional", "premium", "cinematic", "best"
- Action: Upgrade to pro models and each model's documented 1080 tier
- Cost Impact: ~2-4x higher than defaults

#### **Speed Indicators**  
- Keywords: "fast", "quick", "rapid", "social media", "draft"
- Action: Use lite/fast models and each model's documented 720 tier
- Cost Impact: Standard (cost-effective)

#### **Standard Requests**
- No quality keywords mentioned
- Action: Use default settings with model-specific resolution values
- Cost Impact: Lowest possible

## \u{1F4B0} Cost Management Strategy

### **Video Generation Costs**
| Quality | Resolution | Model | Cost Multiplier |
|---------|------------|-------|-----------------|
| Lite | 720p | Fast models | 1x (baseline) |
| Lite | 1080p | Fast models | ~2x |
| Pro | 720p | Pro models | ~2x |
| Pro | 1080p | Pro models | ~4x |

### **Image Generation Costs**
| Quality | Model | Features | Cost Multiplier |
|---------|-------|----------|-----------------|
| Standard | Nano Banana Pro | Fast generation | 1x (baseline) |
| Artistic | Qwen Image | High quality | ~1.5x |
| Professional | OpenAI 4o | Advanced features | ~2x |
| Premium | Flux Kontext | Professional grade | ~2.5x |

### **Audio Generation Costs**
| Type | Model | Quality | Cost Multiplier |
|------|-------|---------|-----------------|
| Speech | ElevenLabs Turbo | Fast | 1x (baseline) |
| Speech | ElevenLabs Pro | High quality | ~1.5x |
| Music | Suno V5 | Professional | ~2x |
| Sound Effects | ElevenLabs SFX | Standard | ~1x |

## \u{1F527} Intelligent Parameter Selection

### **Video Parameters**
- **ByteDance Seedance 2.5**:
  - Use one prompt with optional first/last frames or multimodal image/video/audio references.
  - Frame inputs and multimodal references cannot be combined.
  - The official example uses \`resolution: "720p"\` and \`duration: 15\`; no defaults are imposed by this server.

- **Veo3**:
  - Default: \`model: "veo3_fast"\`
  - High Quality: \`model: "veo3"\`

- **Wan Video**:
  - Default: \`resolution: "1080P"\`, \`aspect_ratio: "adaptive"\`
  - Lower Resolution: \`resolution: "720P"\` or \`"480P"\`
  - Duration: 2-30 seconds, or \`-1\` for smart duration

### **Image Parameters**
- **Nano Banana Pro**: Automatic mode detection, cost-effective by default
- **OpenAI 4o**: Multiple variants (default 4) for cost efficiency
- **Flux Kontext**: Professional quality with cost controls

### **Audio Parameters**
- **ElevenLabs**: Turbo model for cost-effective speech
- **Suno**: Custom mode for professional music generation

## \u{1F3AF} Use Case Optimization

### **Social Media Content**
- **Video**: Wan Video, 720P, 5 seconds
- **Images**: Nano Banana Pro, lite quality
- **Audio**: ElevenLabs Turbo for voiceovers
- **Cost Strategy**: Lowest cost, fast generation

### **Professional Commercial Work**
- **Video**: ByteDance Seedance 2.5 with the documented input scenario
- **Images**: OpenAI 4o or Flux Kontext, professional quality
- **Audio**: ElevenLabs Pro or Suno V5
- **Cost Strategy**: Balanced quality and cost

### **Premium Cinematic Content**
- **Video**: Veo3, highest quality settings
- **Images**: Flux Kontext Max, premium quality
- **Audio**: Suno V5 custom mode
- **Cost Strategy**: Quality prioritized over cost

### **Internal Prototyping**
- **Video**: Wan Video at 720P or ByteDance Seedance at 720p
- **Images**: Nano Banana Pro, fast generation
- **Audio**: ElevenLabs Turbo
- **Cost Strategy**: Maximum cost efficiency

## \u26A0\uFE0F Cost Prevention Measures

### **Automatic Safeguards**
- **Resolution Control**: Explicit 720 tier prevents accidental 1080 output; use 720P for Wan and 720p for Seedance
- **Quality Defaults**: Lite models prevent accidental pro usage
- **Duration Limits**: 5-second default prevents excessive generation
- **Parameter Validation**: Prevents invalid expensive combinations

### **User Intent Confirmation**
- **High Quality Detection**: Requires explicit keywords
- **Specific Requests**: A requested 720 tier prevents unnecessary 1080-tier output
- **Professional Context**: "professional" triggers pro models but maintains the model-specific 720 tier

### **Budget Monitoring**
- **Task Tracking**: Database tracks all generation costs
- **Status Monitoring**: Prevents duplicate expensive generations
- **Error Handling**: Graceful failure prevents wasted costs

## \u{1F680} Optimization Recommendations

### **For Cost-Conscious Projects**
1. Use default settings whenever possible
2. Prefer lite models for iterative work
3. Use each model's documented 720 tier unless its 1080 tier is essential
4. Limit video duration to 5 seconds
5. Batch similar requests for efficiency

### **For Quality-Critical Projects**
1. Upgrade to pro models selectively
2. Use each model's documented 1080 tier only for final deliverables
3. Test with lite models before pro generation
4. Use consistent parameters for batch work
5. Plan generation costs in project budget

### **For Balanced Projects**
1. Use pro models with their documented 720 tier
2. Upgrade specific elements rather than entire project
3. Mix lite and pro models strategically
4. Monitor costs through task database
5. Optimize workflows based on results

## \u{1F4CA} Cost Tracking

### **Database Monitoring**
- **Task Records**: All tasks stored with parameters and costs
- **Status Tracking**: Monitor expensive operations
- **Result Analysis**: Compare quality vs cost effectiveness

### **Performance Metrics**
- **Success Rates**: Track failed vs successful generations
- **Cost per Quality**: Analyze quality improvement vs cost increase
- **Time Analysis**: Compare generation speed vs quality

These guidelines ensure optimal balance between quality requirements and cost management while maintaining excellent user experience.`;
  }
  getImageModelsComparison() {
    return `# Image Models Comparison

| Model | Resolution | Batch Size | Speed | Editing | Key Strengths |
|-------|-----------|------------|-------|---------|---------------|
| **ByteDance Seedream V4** | Up to 4K | 1-6 images | Medium | \u2705 Yes (1-10 images) | Professional quality, batch processing, high resolution |
| **Qwen Image** | HD | 1-4 images | Fast | \u2705 Yes (multi-image) | Fast processing, multi-image editing, pose transfer |
| **Flux Kontext** | HD | Single | Medium | \u2705 Yes | Advanced controls, technical precision, safety tolerance |
| **OpenAI GPT-4o** | Limited AR | 1-4 variants | Medium | \u2705 Yes (with mask) | Creative variants, mask editing, fallback support |
| **Nano Banana Pro** | Custom | 1-10 images | Fastest | \u2705 Yes (simple) | Bulk edits, 4x upscaling, face enhancement |
| **Recraft BG Removal** | Original | Single | Fast | N/A | Background removal only |
| **Ideogram Reframe** | HD | 1-4 images | Medium | N/A | Aspect ratio changes, intelligent composition |

## Use Case Recommendations

- **Professional/Commercial Work**: ByteDance Seedream V4 (4K, batch processing)
- **Multi-Image Editing**: Qwen Image (pose transfer, style consistency)  
- **Technical Precision**: Flux Kontext (advanced controls, safety settings)
- **Creative Exploration**: OpenAI GPT-4o (4 variants, creative prompts)
- **Bulk Simple Edits**: Nano Banana Pro (fastest, bulk processing)
- **Product Photography**: Recraft BG Removal \u2192 Nano Banana Pro upscale
- **Aspect Ratio Changes**: Ideogram Reframe (intelligent composition)

## Parameter Compatibility

### Image Input
- **filesUrl/image_urls**: ByteDance, Qwen, OpenAI, Nano Banana Pro
- **inputImage**: Flux Kontext
- **image_url**: Qwen, Ideogram, Recraft
- **image**: Nano Banana Pro (upscale mode)

### Quality Control
- **Resolution**: ByteDance (1K/2K/4K), Qwen (6 presets), Ideogram (6 presets)
- **Guidance Scale**: Qwen (0-20), Flux (implicit)
- **Safety**: Flux (tolerance 0-6), Qwen (checker on/off)

### Output Quantity
- **max_images**: ByteDance (1-6)
- **num_images**: Qwen (1-4 string), Ideogram (1-4)
- **nVariants**: OpenAI (1/2/4 string)
`;
  }
  getVideoModelsComparison() {
    return `# Video Models Comparison

| Model | Max Resolution | Quality Modes | Duration | Speed | Key Strengths |
|-------|---------------|---------------|----------|-------|---------------|
| **Google Veo3** | 1080p | veo3/veo3_fast | Default | Medium | Premium cinematic quality, 1080p support |
| **ByteDance Seedance 2.5** | Example: 720p | Single model | Example: 15s | Medium | Text, first/last frames, or multimodal refs |
| **Wan Video 3.0** | 480P-1080P | Multimodal | 2-30s | Flexible | References, keyframes, documents, webpages |
| **Runway Aleph** | 1080p | Single | Source | Medium | Video-to-video editing, style transfer |

## Quality & Cost Trade-offs

### Default Settings (Cost-Effective)
- **Resolution**: Use the selected model's documented 720 tier unless the user requests high quality
- **Quality Mode**: standard/fast (unless user requests "fast" explicitly)
- **Model**: ByteDance Seedance 2.5

### High Quality Upgrades
- **User says "high quality"**: Use the requested documented Seedance 2.5 inputs
- **User says "cinematic"**: Veo3 model
- **User says "fast/quick"**: Choose a speed-oriented model with documented fast behavior

## Use Case Recommendations

- **Cinematic/Premium Content**: Veo3 (model: "veo3")
- **Professional/Commercial**: ByteDance Seedance 2.5
- **Multimodal/Long-form**: Wan Video 3.0
- **Multimodal (refs + audio)**: ByteDance Seedance 2.5 with reference URLs
- **Video Editing**: Runway Aleph (existing video transformation)

## Parameter Mapping

### Input Methods
- **Text-to-Video**: All models (prompt only)
- **Image-to-Video**: Veo3 (imageUrls), Seedance (first_frame_url), Wan (first_frame_url and optional last_frame_url)
- **Video-to-Video**: Runway Aleph (videoUrl)
- **Multimodal Refs**: Seedance 2.5 and Wan 3.0 (reference_image_urls, reference_video_urls, reference_audio_urls)

### Quality Control
- **Veo3**: model selection (veo3 vs veo3_fast)
- **Seedance 2.5**: one fixed model with optional resolution
- **Wan**: resolution parameter only
- **Runway**: implicit (no quality settings)

### Aspect Ratios
- **Veo3**: 16:9, 9:16, Auto
- **ByteDance**: 16:9, 9:16, 1:1, 4:3, 3:4, 21:9, 9:21
- **Wan**: adaptive, 16:9, 4:3, 1:1, 3:4, 9:16
- **Runway**: 16:9, 9:16, 1:1, 4:3, 3:4, 21:9
`;
  }
  getQualityOptimizationGuide() {
    return `# Quality & Cost Optimization Guide

## \u{1F3AF} Default Settings (Cost-Effective)

### **CRITICAL COST CONTROL RULES**
- **Resolution**: Use the model's 720 tier unless the user requests high quality: \`"720p"\` for Seedance and \`"720P"\` for Wan
- **Quality Level**: ALWAYS use **lite/fast** versions unless user requests "high quality"
- **Model Selection**: bytedance_seedance_video uses the fixed Seedance 2.5 model

### **Quality Upgrade Logic**

#### **When User Says "high quality"**
- Upgrade to: Pro versions plus each model's documented 1080 tier
- ByteDance: \`"resolution": "1080p"\`
- Wan Video: \`"resolution": "1080P"\`
- Veo3: \`model: "veo3"\`

#### **When User Says "high quality in 720p"**
- Upgrade to: Pro versions while keeping each model's documented 720 tier
- ByteDance: \`"resolution": "720p"\`
- Wan Video: \`"resolution": "720P"\`
- Veo3: \`model: "veo3"\`

#### **When User Says "fast" or "quick"**
- Keep: Lite versions with each model's documented 720 tier
- ByteDance: \`quality: "lite"\` + \`"resolution": "720p"\`
- Veo3: \`model: "veo3_fast"\` + \`"resolution": "720p"\`

## \u{1F4B0} Cost Impact Matrix

### **Video Generation**
| Quality | Resolution | Model | Relative Cost |
|---------|-----------|-------|---------------|
| Lite | 720p | Default | 1x (baseline) |
| Lite | 1080p | Upgraded | ~2x |
| Pro | 720p | Upgraded | ~2x |
| Pro | 1080p | Maximum | ~4x |

### **Image Generation**
| Model | Resolution | Relative Cost |
|-------|-----------|---------------|
| Nano Banana Pro | Standard | 1x |
| Qwen | HD | 1.5x |
| ByteDance Seedream | 2K | 2x |
| ByteDance Seedream | 4K | 3x |
| Flux Kontext | Pro | 2.5x |

## \u{1F3AF} Parameter Selection Strategy

### **For Cost-Sensitive Projects**
1. Use lite models with their documented 720 tier
2. Avoid each model's 1080 tier unless explicitly needed
3. Use batch processing when possible
4. Monitor costs through task database

### **For Quality-Focused Projects**
1. Use pro models with their documented 1080 tier
2. Accept 2-4x cost increase
3. Use professional models (Veo3, Flux Kontext Max)
4. Optimize selectively (not all content needs max quality)

### **For Balanced Projects**
1. Use pro models with their documented 720 tier
2. Upgrade specific elements rather than entire project
3. Mix lite and pro models strategically
4. Monitor costs through task database

## \u{1F4CA} Cost Tracking

### **Database Monitoring**
- **Task Records**: All tasks stored with parameters and costs
- **Status Tracking**: Monitor expensive operations
- **Result Analysis**: Compare quality vs cost effectiveness

### **Performance Metrics**
- **Success Rates**: Track failed vs successful generations
- **Cost per Quality**: Analyze quality improvement vs cost increase
- **Time Analysis**: Compare generation speed vs quality
`;
  }
  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }
  // Streamable HTTP transport (remote access). Each session gets its own Server
  // via createServer(); the shared client/db context is reused across sessions.
  runHttp() {
    const publicBaseUrl = process.env.KIE_MCP_PUBLIC_BASE_URL;
    const uploadStore = publicBaseUrl ? new TemporaryUploadStore({
      publicBaseUrl,
      storageRoot: process.env.KIE_MCP_UPLOAD_DIR,
      maxFileBytes: parseInt(
        process.env.KIE_MCP_MAX_UPLOAD_BYTES || String(25 * 1024 * 1024),
        10
      )
    }) : void 0;
    if (uploadStore) {
      this.toolContext = {
        ...this.toolContext,
        createUploadCapability: (request) => uploadStore.createCapability(request),
        finalizeUpload: async (request) => {
          const staged = await uploadStore.createProviderDownload({
            mediaId: request.mediaId,
            owner: request.owner
          });
          const response = await this.client.uploadFromUrl({
            fileUrl: staged.url,
            uploadPath: uploadPathForMimeType(staged.contentType),
            fileName: staged.filename
          });
          const downloadUrl = response.data?.downloadUrl ?? response.data?.fileUrl;
          if (response.code !== 200 && response.code !== 0 || !downloadUrl) {
            throw new Error(
              response.msg || "Kie.ai did not return a finalized downloadUrl."
            );
          }
          await uploadStore.removeMedia(request.mediaId, request.owner);
          return {
            downloadUrl,
            filename: staged.filename,
            contentType: staged.contentType,
            size: staged.size
          };
        },
        getUploadPublicOrigin: () => uploadStore.publicOrigin
      };
    }
    startHttpServer({
      createServer: (principal) => this.createServer(principal),
      version: _KieAiMcpServer.VERSION,
      uploadStore
    });
  }
};
async function startMcpServer() {
  const useHttp = process.env.MCP_TRANSPORT === "http" || process.argv.includes("--http");
  const server = new KieAiMcpServer();
  if (useHttp) {
    server.runHttp();
  } else {
    await server.run();
  }
}
function isMcpEntrypoint(entrypoint, modulePath) {
  if (!entrypoint) return false;
  try {
    return realpathSync(entrypoint) === realpathSync(modulePath);
  } catch {
    return false;
  }
}
if (isMcpEntrypoint(process.argv[1], fileURLToPath(import.meta.url))) {
  startMcpServer().catch(console.error);
}
export {
  KieAiMcpServer,
  isMcpEntrypoint,
  startMcpServer
};
/*! Bundled license information:

@modelcontextprotocol/server/dist/src-CX2iR2pK.mjs:
  (*!
  * content-type
  * Copyright(c) 2015 Douglas Christopher Wilson
  * MIT Licensed
  *)
*/
