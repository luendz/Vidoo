// Video Vault — Cloudflare Worker
// Maneja: login con contraseña, subida a R2, listado y streaming de videos.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Filename",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// Genera un token simple firmado con HMAC usando el SECRET (no es JWT completo,
// pero es suficiente para "yo y mis amigos" sin meter una librería externa).
async function signToken(secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const exp = Date.now() + 1000 * 60 * 60 * 24 * 30; // 30 días
  const payload = `${exp}`;
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  const sigHex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
  return `${payload}.${sigHex}`;
}

async function verifyToken(token, secret) {
  if (!token || !token.includes(".")) return false;
  const [payload, sigHex] = token.split(".");
  const exp = Number(payload);
  if (!exp || Date.now() > exp) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  const expectedHex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
  return expectedHex === sigHex;
}

async function requireAuth(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.replace("Bearer ", "");
  return await verifyToken(token, env.AUTH_SECRET);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // --- LOGIN ---
    if (path === "/api/login" && request.method === "POST") {
      const { password } = await request.json().catch(() => ({}));
      if (password !== env.SITE_PASSWORD) {
        return json({ error: "Contraseña incorrecta" }, 401);
      }
      const token = await signToken(env.AUTH_SECRET);
      return json({ token });
    }

    // Todo lo demás requiere auth
    if (!(await requireAuth(request, env))) {
      return json({ error: "No autorizado" }, 401);
    }

    // --- LISTAR VIDEOS ---
    if (path === "/api/videos" && request.method === "GET") {
      const listed = await env.VIDEO_BUCKET.list();
      const videos = listed.objects
        .filter(obj => !obj.key.endsWith(".meta.json"))
        .map(obj => ({
          key: obj.key,
          size: obj.size,
          uploaded: obj.uploaded,
        }))
        .sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded));
      return json({ videos });
    }

    // --- SUBIR VIDEO ---
    if (path === "/api/upload" && request.method === "POST") {
      const filename = request.headers.get("X-Filename") || `video-${Date.now()}.mp4`;
      const safeKey = `${Date.now()}-${filename.replace(/[^a-zA-Z0-9.\-_]/g, "_")}`;

      await env.VIDEO_BUCKET.put(safeKey, request.body, {
        httpMetadata: {
          contentType: request.headers.get("Content-Type") || "video/mp4",
        },
      });

      return json({ ok: true, key: safeKey });
    }

    // --- VER / STREAMEAR VIDEO (con soporte de Range para que el video se pueda
    // adelantar/atrasar sin descargar todo) ---
    if (path.startsWith("/api/video/") && request.method === "GET") {
      const key = decodeURIComponent(path.replace("/api/video/", ""));
      const range = request.headers.get("Range");

      const object = await env.VIDEO_BUCKET.get(key, range ? {
        range: parseRange(range, await getObjectSize(env.VIDEO_BUCKET, key)),
      } : undefined);

      if (!object) return json({ error: "No encontrado" }, 404);

      const headers = new Headers(CORS_HEADERS);
      object.writeHttpMetadata(headers);
      headers.set("Accept-Ranges", "bytes");

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

    // --- BORRAR VIDEO ---
    if (path.startsWith("/api/video/") && request.method === "DELETE") {
      const key = decodeURIComponent(path.replace("/api/video/", ""));
      await env.VIDEO_BUCKET.delete(key);
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
