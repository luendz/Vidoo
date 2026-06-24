# Bóveda — Video Vault

Web personal para subir videos desde el celular o cualquier dispositivo, sin
pérdida de calidad (se guarda el archivo original, sin recompresión), con
acceso protegido por contraseña.

- **Frontend** → se hostea gratis en GitHub Pages
- **Backend** → un Cloudflare Worker (gratis hasta 100,000 requests/día)
- **Almacenamiento** → Cloudflare R2 (10 GB gratis, sin costo por descarga)

---

## 1. Crear cuenta de Cloudflare

Si no tienes una: https://dash.cloudflare.com/sign-up (gratis, no pide tarjeta
para el plan free de Workers/R2).

## 2. Instalar Wrangler (CLI de Cloudflare)

```bash
npm install -g wrangler
wrangler login
```

Esto abre el navegador para autenticar tu cuenta.

## 3. Crear el bucket de R2

```bash
cd worker
wrangler r2 bucket create video-vault
```

## 4. Configurar los secretos

Vas a definir dos secretos: la contraseña de acceso y una clave para firmar
las sesiones (puede ser cualquier string largo y random).

```bash
wrangler secret put SITE_PASSWORD
# te va a pedir que escribas la contraseña, ej: "miclave2026"

wrangler secret put AUTH_SECRET
# escribe cualquier string largo y random, ej: "x7f9k2m1p8q3w5e7r2t4y6u8"
```

Vidoo también limita los intentos de login fallidos por IP usando Workers KV. Antes
de desplegar, creá el namespace:

```bash
wrangler kv namespace create rate-limit-kv
```

Ese comando devuelve un `id`. Abrí `wrangler.toml` y pegalo en el bloque
`[[kv_namespaces]]`, reemplazando `PENDIENTE_pegar_id_real_de_wrangler_kv_namespace_create`.

## 5. Desplegar el Worker

```bash
wrangler deploy
```

Al terminar te va a dar una URL tipo:

```
https://video-vault-api.tu-usuario.workers.dev
```

**Copia esa URL**, la necesitas en el siguiente paso.

## 6. Conectar el frontend con tu Worker

Abre `frontend/index.html` y busca esta línea cerca del final:

```js
const API_BASE = "https://video-vault-api.TU-SUBDOMINIO.workers.dev";
```

Remplázala con la URL real que te dio `wrangler deploy`.

## 7. Subir el código a GitHub

```bash
cd ..  # vuelve a la raíz del proyecto
git init
git add .
git commit -m "Bóveda de videos inicial"
git branch -M main
git remote add origin https://github.com/TU-USUARIO/TU-REPO.git
git push -u origin main
```

## 8. Activar GitHub Pages

1. Ve a tu repo en GitHub → **Settings** → **Pages**
2. En "Build and deployment" → Source: **Deploy from a branch**
3. Branch: `main`, carpeta: `/frontend` (o muévela a `/docs` si prefieres,
   ajustando la opción de carpeta)
4. Guarda. En 1-2 minutos tu web estará en:
   `https://TU-USUARIO.github.io/TU-REPO/`

## 9. Listo

Abre esa URL desde el celular, escribe la contraseña, y empieza a subir
videos. Funciona igual desde cualquier dispositivo con navegador.

## 10. (Opcional) Notificaciones por correo

Para recibir un email cada vez que se sube o elimina un video, usa
[Resend](https://resend.com) (gratis, sin tarjeta, 100 emails/día):

1. Crea cuenta en https://resend.com con el correo donde quieres recibir
   las notificaciones (en el plan sin dominio verificado, solo se puede
   enviar a ese mismo correo de registro)
2. En el dashboard de Resend, ve a **API Keys** → **Create API Key**
3. Copia la key (empieza con `re_...`)
4. Ve a tu Worker en Cloudflare → **Settings** → **Variables and Secrets**
   y agrega dos secretos:
   - `RESEND_API_KEY` → la key que copiaste
   - `NOTIFY_EMAIL` → el correo donde quieres recibir las notificaciones
     (debe ser el mismo con el que te registraste en Resend)
5. Guarda — listo, ya deberías recibir un correo en cada subida/eliminación

Si en algún momento quieres notificar a *cualquier* correo (no solo el de
registro), necesitas verificar un dominio propio en Resend y cambiar el
`from` en `worker/src/index.js` por una dirección de ese dominio.

---

## Notas técnicas

- **Sin pérdida de calidad:** el archivo se sube y guarda binario, tal cual
  sale del celular. No hay ningún paso de compresión ni recodificación.
- **Streaming con range requests:** el reproductor puede saltar a cualquier
  punto del video sin descargar el archivo completo (soporte de `Range`
  headers implementado en el Worker).
- **Seguridad:** la protección es por contraseña simple compartida — adecuada
  para uso personal/amigos, no para datos sensibles de terceros. El token de
  sesión dura 30 días.
- **Costos:** con uso personal/de unos pocos amigos, esto se mantiene 100%
  dentro de las capas gratuitas de Cloudflare (R2: 10GB storage + Workers:
  100k requests/día).
- **Límite de tamaño por video:** Cloudflare Workers tiene un límite de
  request body de ~300MB en el plan free para subidas vía Worker. Si subes
  videos en 4K muy largos y se cae la subida, dime y te paso una variante
  con subida directa a R2 desde el navegador (presigned URLs) que no tiene
  ese límite.

## Estructura del proyecto

```
.
├── frontend/
│   └── index.html        ← la web (GitHub Pages sirve esto)
└── worker/
    ├── src/
    │   └── index.js       ← backend (Cloudflare Worker)
    └── wrangler.toml       ← configuración de despliegue
```
