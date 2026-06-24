// Video Vault — Cloudflare Worker
// Maneja: login con contraseña + rate limiting, tokens por scope (full/view/share),
// subida simple y resumible (multipart) a R2, miniaturas, metadata (nombre/carpeta/
// favorito), compartir por link temporal, borrado individual y por lote, y streaming
// con soporte de Range.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Filename",
};

const QUOTA_BYTES = 10 * 1024 * 1024 * 1024; // cuota free de R2

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...extraHeaders },
  });
}

function isAuxiliaryKey(key) {
  return key.endsWith(".thumb.jpg") || key.endsWith(".meta.json");
}

// ---------- Tokens por scope: "full" (sesión, 30 días), "view" (solo streaming,
// 6h, va en URLs en vez del token de sesión), "share" (acotado a una sola key,
// TTL configurable, no requiere login). scope y resource van DENTRO del payload
// firmado — si no, serían falsificables (alguien podría reescribir el scope de
// un token "view" a "full" sin invalidar la firma).
async function signToken(secret, { scope, resource = "", ttlMs } = {}) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const defaultTtl = scope === "full" ? 1000 * 60 * 60 * 24 * 30 : 1000 * 60 * 60 * 6;
  const exp = Date.now() + (ttlMs ?? defaultTtl);
  const resourceB64 = resource
    ? btoa(resource).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
    : "";
  const payload = `${exp}.${scope}.${resourceB64}`;
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  const sigHex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
  return `${payload}.${sigHex}`;
}

async function verifyToken(token, secret) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [expStr, scope, resourceB64, sigHex] = parts;
  const exp = Number(expStr);
  if (!exp || Date.now() > exp) return null;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${expStr}.${scope}.${resourceB64}`));
  const expectedHex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
  if (expectedHex !== sigHex) return null;

  const resource = resourceB64 ? atob(resourceB64.replace(/-/g, "+").replace(/_/g, "/")) : "";
  return { scope, resource, exp };
}

async function requireFullAuth(request, env) {
  const token = (request.headers.get("Authorization") || "").replace("Bearer ", "");
  const claims = await verifyToken(token, env.AUTH_SECRET);
  return claims?.scope === "full" ? claims : null;
}

// Streaming acepta: scope "full"/"view" (cualquier key) o "share" (solo si coincide
// con la key pedida). El token puede venir por header o por ?token= — <video>/<img>
// no pueden mandar headers, así que la URL sigue siendo necesaria para esos casos.
async function requireStreamAuth(request, env, requestedKey) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token")
    || (request.headers.get("Authorization") || "").replace("Bearer ", "");
  const claims = await verifyToken(token, env.AUTH_SECRET);
  if (!claims) return null;
  if (claims.scope === "full" || claims.scope === "view") return claims;
  if (claims.scope === "share" && claims.resource === requestedKey) return claims;
  return null;
}

// ---------- Rate limiting de /api/login vía KV. Si el binding RATE_LIMIT_KV no
// existe todavía (namespace no creado) o KV falla, el caller debe envolver esto en
// try/catch y degradar a "no bloqueado" — un fallo de KV nunca debe tumbar el login.
async function checkRateLimit(env, ip) {
  const windowMinutes = 15;
  const maxAttempts = 5;
  const windowBucket = Math.floor(Date.now() / (windowMinutes * 60 * 1000));
  const rlKey = `login_fail:${ip}:${windowBucket}`;
  const current = Number(await env.RATE_LIMIT_KV.get(rlKey)) || 0;
  if (current >= maxAttempts) {
    const msIntoWindow = Date.now() % (windowMinutes * 60 * 1000);
    const retryAfterSec = Math.ceil((windowMinutes * 60 * 1000 - msIntoWindow) / 1000);
    return { blocked: true, retryAfterSec, current };
  }
  return { blocked: false, current };
}

async function recordFailedLogin(env, ip, current) {
  const windowMinutes = 15;
  const windowBucket = Math.floor(Date.now() / (windowMinutes * 60 * 1000));
  const rlKey = `login_fail:${ip}:${windowBucket}`;
  await env.RATE_LIMIT_KV.put(rlKey, String(current + 1), { expirationTtl: windowMinutes * 60 });
}

// R2 no tiene "actualizar solo metadata": hay que volver a poner el objeto con el
// mismo body (stream, no se descarga a memoria) y el customMetadata nuevo.
async function updateVideoMetadata(env, key, patch) {
  const object = await env.VIDEO_BUCKET.get(key);
  if (!object) return null;
  const customMetadata = { ...object.customMetadata, ...patch };
  await env.VIDEO_BUCKET.put(key, object.body, {
    httpMetadata: object.httpMetadata,
    customMetadata,
  });
  return customMetadata;
}

// Envía una notificación por correo vía la API de Resend.
// No lanza error si falla — una notificación caída no debe romper la subida/borrado real.
async function notify(env, { subject, message }) {
  if (!env.RESEND_API_KEY || !env.NOTIFY_EMAIL) return;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Vidoo <onboarding@resend.dev>",
        to: [env.NOTIFY_EMAIL],
        subject,
        text: message,
      }),
    });
  } catch (err) {
    console.error("Error enviando notificación:", err);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // --- LOGIN (con rate limiting por IP) ---
    if (path === "/api/login" && request.method === "POST") {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      let rl = { blocked: false, current: 0 };
      try {
        rl = await checkRateLimit(env, ip);
      } catch (err) {
        console.error("Rate limit check falló:", err);
      }
      if (rl.blocked) {
        return json({ error: "Demasiados intentos, esperá un momento" }, 429, {
          "Retry-After": String(rl.retryAfterSec),
        });
      }

      const { password } = await request.json().catch(() => ({}));
      if (password !== env.SITE_PASSWORD) {
        try {
          await recordFailedLogin(env, ip, rl.current);
        } catch (err) {
          console.error("No se pudo registrar intento fallido:", err);
        }
        return json({ error: "Contraseña incorrecta" }, 401);
      }

      const token = await signToken(env.AUTH_SECRET, { scope: "full" });
      const viewToken = await signToken(env.AUTH_SECRET, { scope: "view" });
      return json({ token, viewToken });
    }

    // --- REFRESCAR SESIÓN ---
    if (path === "/api/refresh" && request.method === "POST") {
      const claims = await requireFullAuth(request, env);
      if (!claims) return json({ error: "No autorizado" }, 401);
      const token = await signToken(env.AUTH_SECRET, { scope: "full" });
      const viewToken = await signToken(env.AUTH_SECRET, { scope: "view" });
      return json({ token, viewToken });
    }

    // --- CREAR LINK DE COMPARTIR (sin requerir login para verlo) ---
    if (path === "/api/share" && request.method === "POST") {
      const claims = await requireFullAuth(request, env);
      if (!claims) return json({ error: "No autorizado" }, 401);
      const { key, ttlHours } = await request.json().catch(() => ({}));
      if (!key) return json({ error: "Falta key" }, 400);
      const head = await env.VIDEO_BUCKET.head(key);
      if (!head) return json({ error: "Video no encontrado" }, 404);
      const clampedHours = Math.min(Math.max(Number(ttlHours) || 24, 1), 24 * 7);
      const ttlMs = clampedHours * 60 * 60 * 1000;
      const shareToken = await signToken(env.AUTH_SECRET, { scope: "share", resource: key, ttlMs });
      return json({ shareToken, expiresAt: Date.now() + ttlMs });
    }

    // --- LISTAR VIDEOS (+ espacio usado) ---
    if (path === "/api/videos" && request.method === "GET") {
      const claims = await requireFullAuth(request, env);
      if (!claims) return json({ error: "No autorizado" }, 401);

      let allObjects = [];
      let cursor;
      do {
        const listed = await env.VIDEO_BUCKET.list({ include: ["customMetadata", "httpMetadata"], cursor });
        allObjects = allObjects.concat(listed.objects);
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);

      const auxKeys = new Set(allObjects.filter(o => isAuxiliaryKey(o.key)).map(o => o.key));
      const videos = allObjects
        .filter(o => !isAuxiliaryKey(o.key))
        .map(o => ({
          key: o.key,
          size: o.size,
          uploaded: o.uploaded,
          displayName: o.customMetadata?.displayName || o.key,
          folder: o.customMetadata?.folder || "",
          favorite: o.customMetadata?.favorite === "1",
          contentType: o.httpMetadata?.contentType || "video/mp4",
          hasThumbnail: auxKeys.has(`${o.key}.thumb.jpg`),
        }))
        .sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded));

      const totalBytes = videos.reduce((sum, v) => sum + v.size, 0);
      return json({
        videos,
        usage: {
          usedBytes: totalBytes,
          quotaBytes: QUOTA_BYTES,
          percent: Math.min(100, Math.round((totalBytes / QUOTA_BYTES) * 100)),
        },
      });
    }

    // --- BORRADO POR LOTE ---
    if (path === "/api/videos/delete" && request.method === "POST") {
      const claims = await requireFullAuth(request, env);
      if (!claims) return json({ error: "No autorizado" }, 401);
      const { keys } = await request.json().catch(() => ({}));
      if (!Array.isArray(keys) || keys.length === 0) return json({ error: "Faltan keys" }, 400);

      const results = await Promise.allSettled(
        keys.map(async (key) => {
          await env.VIDEO_BUCKET.delete(key);
          await env.VIDEO_BUCKET.delete(`${key}.thumb.jpg`).catch(() => {});
        })
      );
      const succeeded = results.filter(r => r.status === "fulfilled").length;

      ctx.waitUntil(notify(env, {
        subject: "Vidoo · Videos eliminados",
        message: `Se eliminaron ${succeeded} de ${keys.length} videos solicitados.\n\nFecha: ${new Date().toLocaleString("es")}`,
      }));

      return json({ ok: true, deleted: succeeded, total: keys.length });
    }

    // --- SUBIR VIDEO (ruta simple, para archivos chicos) ---
    if (path === "/api/upload" && request.method === "POST") {
      const claims = await requireFullAuth(request, env);
      if (!claims) return json({ error: "No autorizado" }, 401);
      const filename = request.headers.get("X-Filename") || `video-${Date.now()}.mp4`;
      const safeKey = `${Date.now()}-${filename.replace(/[^a-zA-Z0-9.\-_]/g, "_")}`;

      await env.VIDEO_BUCKET.put(safeKey, request.body, {
        httpMetadata: { contentType: request.headers.get("Content-Type") || "video/mp4" },
        customMetadata: { displayName: filename, originalName: filename, folder: "", favorite: "0" },
      });

      ctx.waitUntil(notify(env, {
        subject: "Vidoo · Nuevo video subido",
        message: `Se subió un nuevo video a tu bóveda:\n\n${filename}\n\nFecha: ${new Date().toLocaleString("es")}`,
      }));

      return json({ ok: true, key: safeKey });
    }

    // --- SUBIR MINIATURA de un video ya existente ---
    const thumbMatch = path.match(/^\/api\/upload-thumb\/([^/]+)$/);
    if (thumbMatch && request.method === "POST") {
      const claims = await requireFullAuth(request, env);
      if (!claims) return json({ error: "No autorizado" }, 401);
      const videoKey = decodeURIComponent(thumbMatch[1]);
      const head = await env.VIDEO_BUCKET.head(videoKey);
      if (!head) return json({ error: "Video no encontrado" }, 404);
      await env.VIDEO_BUCKET.put(`${videoKey}.thumb.jpg`, request.body, {
        httpMetadata: { contentType: "image/jpeg" },
      });
      return json({ ok: true });
    }

    // --- SUBIDA RESUMIBLE (multipart R2) ---
    if (path === "/api/upload/start" && request.method === "POST") {
      const claims = await requireFullAuth(request, env);
      if (!claims) return json({ error: "No autorizado" }, 401);
      const { filename, contentType } = await request.json().catch(() => ({}));
      const safeFilename = (filename || `video-${Date.now()}.mp4`).replace(/[^a-zA-Z0-9.\-_]/g, "_");
      const safeKey = `${Date.now()}-${safeFilename}`;
      const multipartUpload = await env.VIDEO_BUCKET.createMultipartUpload(safeKey, {
        httpMetadata: { contentType: contentType || "video/mp4" },
        customMetadata: {
          displayName: filename || safeFilename,
          originalName: filename || safeFilename,
          folder: "",
          favorite: "0",
        },
      });
      return json({ key: safeKey, uploadId: multipartUpload.uploadId });
    }

    if (path === "/api/upload/part" && request.method === "POST") {
      const claims = await requireFullAuth(request, env);
      if (!claims) return json({ error: "No autorizado" }, 401);
      const key = url.searchParams.get("key");
      const uploadId = url.searchParams.get("uploadId");
      const partNumber = Number(url.searchParams.get("partNumber"));
      if (!key || !uploadId || !partNumber) return json({ error: "Faltan parámetros" }, 400);
      const multipartUpload = env.VIDEO_BUCKET.resumeMultipartUpload(key, uploadId);
      const uploadedPart = await multipartUpload.uploadPart(partNumber, request.body);
      return json({ partNumber: uploadedPart.partNumber, etag: uploadedPart.etag });
    }

    if (path === "/api/upload/complete" && request.method === "POST") {
      const claims = await requireFullAuth(request, env);
      if (!claims) return json({ error: "No autorizado" }, 401);
      const { key, uploadId, parts } = await request.json().catch(() => ({}));
      if (!key || !uploadId || !Array.isArray(parts)) return json({ error: "Faltan parámetros" }, 400);
      const multipartUpload = env.VIDEO_BUCKET.resumeMultipartUpload(key, uploadId);
      await multipartUpload.complete(parts);

      ctx.waitUntil(notify(env, {
        subject: "Vidoo · Nuevo video subido",
        message: `Se subió un nuevo video a tu bóveda:\n\n${key}\n\nFecha: ${new Date().toLocaleString("es")}`,
      }));

      return json({ ok: true, key });
    }

    if (path === "/api/upload/abort" && request.method === "POST") {
      const claims = await requireFullAuth(request, env);
      if (!claims) return json({ error: "No autorizado" }, 401);
      const { key, uploadId } = await request.json().catch(() => ({}));
      if (!key || !uploadId) return json({ error: "Faltan parámetros" }, 400);
      const multipartUpload = env.VIDEO_BUCKET.resumeMultipartUpload(key, uploadId);
      await multipartUpload.abort();
      return json({ ok: true });
    }

    // --- EDITAR METADATA (renombrar / mover de carpeta / favorito) ---
    const patchMatch = path.match(/^\/api\/video\/([^/]+)\/(rename|folder|favorite)$/);
    if (patchMatch && request.method === "PATCH") {
      const claims = await requireFullAuth(request, env);
      if (!claims) return json({ error: "No autorizado" }, 401);
      const key = decodeURIComponent(patchMatch[1]);
      const field = patchMatch[2];
      const body = await request.json().catch(() => ({}));
      const patch = field === "rename" ? { displayName: String(body.displayName || "").slice(0, 200) }
                  : field === "folder" ? { folder: String(body.folder || "").slice(0, 100) }
                  : { favorite: body.favorite ? "1" : "0" };
      const updated = await updateVideoMetadata(env, key, patch);
      if (!updated) return json({ error: "No encontrado" }, 404);
      return json({ ok: true, customMetadata: updated });
    }

    // --- VER / STREAMEAR VIDEO O MINIATURA (con soporte de Range para que el video
    // se pueda adelantar/atrasar sin descargar todo, y ?download=1 para forzar
    // descarga con el nombre original) ---
    if (path.startsWith("/api/video/") && request.method === "GET") {
      const key = decodeURIComponent(path.replace("/api/video/", ""));
      const claims = await requireStreamAuth(request, env, key);
      if (!claims) return json({ error: "No autorizado" }, 401);

      const range = request.headers.get("Range");
      const object = await env.VIDEO_BUCKET.get(key, range ? {
        range: parseRange(range, await getObjectSize(env.VIDEO_BUCKET, key)),
      } : undefined);

      if (!object) return json({ error: "No encontrado" }, 404);

      const headers = new Headers(CORS_HEADERS);
      object.writeHttpMetadata(headers);
      headers.set("Accept-Ranges", "bytes");

      if (url.searchParams.get("download") === "1") {
        const filename = (object.customMetadata?.originalName || key).replace(/"/g, "");
        headers.set("Content-Disposition", `attachment; filename="${filename}"`);
      }

      if (range && object.range) {
        const { offset, length } = object.range;
        const total = object.size + offset; // tamaño total real
        headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${total}`);
        headers.set("Content-Length", length);
        return new Response(object.body, { status: 206, headers });
      }

      headers.set("Content-Length", object.size);
      return new Response(object.body, { status: 200, headers });
    }

    // --- BORRAR VIDEO (+ su miniatura, si tiene) ---
    if (path.startsWith("/api/video/") && request.method === "DELETE") {
      const claims = await requireFullAuth(request, env);
      if (!claims) return json({ error: "No autorizado" }, 401);
      const key = decodeURIComponent(path.replace("/api/video/", ""));
      await env.VIDEO_BUCKET.delete(key);
      await env.VIDEO_BUCKET.delete(`${key}.thumb.jpg`).catch(() => {});

      ctx.waitUntil(notify(env, {
        subject: "Vidoo · Video eliminado",
        message: `Se eliminó un video de tu bóveda:\n\n${key}\n\nFecha: ${new Date().toLocaleString("es")}`,
      }));

      return json({ ok: true });
    }

    return json({ error: "Ruta no encontrada" }, 404);
  },
};

async function getObjectSize(bucket, key) {
  const head = await bucket.head(key);
  return head ? head.size : 0;
}

function parseRange(rangeHeader, totalSize) {
  const match = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
  if (!match) return undefined;
  const offset = parseInt(match[1], 10);
  const end = match[2] ? parseInt(match[2], 10) : totalSize - 1;
  return { offset, length: end - offset + 1 };
}
