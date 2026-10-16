# 🎫 TurnoFlow — Sistema de Turnos y Gestión de Colas

Sistema de turnos para atención al cliente, en **Node.js + TypeScript**, **PostgreSQL**, **Prisma** y **Socket.io**. Es marca blanca: cualquier empresa lo adapta a su identidad editando un solo archivo.

Gestiona:

- **Turnos presenciales del día**: el cliente saca un ticket en el tótem (`A-001`, `R-015`…).
- **Citas previas agendadas por web**: el cliente reserva una franja horaria y el día de la cita registra su llegada en el tótem.
- **Despacho a boxes/ventanillas**: el operador presiona *Llamar siguiente* y el sistema asigna el próximo turno de forma segura aunque varios boxes llamen al mismo tiempo.
- **Pantalla de sala (TV)**: muestra el turno llamado al instante, con sonido *ding‑dong* y aviso por voz.

| Vista | URL | Quién la usa |
|---|---|---|
| Tótem / Web de clientes | `/totem.html` | Clientes (tótem táctil o celular) |
| Agendar cita (enlace web) | `/totem.html?mode=web` | Clientes desde la web institucional |
| Seguimiento del turno | `/totem.html?track=<id>` | Cliente en su celular (se muestra en el ticket) |
| Panel de operador | `/operator.html` | Operadores, supervisores |
| Pantalla de sala | `/display.html?branch=CENTRAL` | TV de la sala de espera |

---

## Índice

1. [Requisitos previos](#1-requisitos-previos)
2. [Configuración de la base de datos](#2-configuración-de-la-base-de-datos)
3. [Despliegue local](#3-despliegue-local)
4. [Despliegue en producción](#4-despliegue-en-producción)
5. [Personalización y cambio de marca](#5-personalización-y-cambio-de-marca)
6. [Arquitectura](#6-arquitectura)
7. [Concurrencia: cómo funciona "Llamar siguiente"](#7-concurrencia-cómo-funciona-llamar-siguiente)
8. [Referencia de la API y de los eventos en tiempo real](#8-referencia-de-la-api-y-de-los-eventos-en-tiempo-real)

---

## 1. Requisitos previos

| Herramienta | Versión | Notas |
|---|---|---|
| **Node.js** | 20 LTS o superior (probado con 22 y 26) | `node -v` |
| **npm** | 10+ (o **pnpm** 9+) | viene con Node |
| **PostgreSQL** | 15+ recomendado (funciona desde 13) | se necesita `gen_random_uuid()`, nativo desde la 13 |
| **Docker** *(opcional)* | Docker Desktop / Engine 24+ con Compose v2 | para levantar PostgreSQL con un comando |

---

## 2. Configuración de la base de datos

### 2.1 Levantar PostgreSQL

**Opción A, con Docker (recomendada):**

```bash
docker compose up -d db
```

Esto crea la base `turnos_db` con usuario `turnos` y contraseña `turnos` en `localhost:5432`. Los datos persisten en el volumen `pgdata`.

**Opción B, con un PostgreSQL instalado:**

```sql
-- psql -U postgres
CREATE USER turnos WITH PASSWORD 'turnos';
CREATE DATABASE turnos_db OWNER turnos;
```

### 2.2 Archivo `.env`

```bash
cp .env.example .env        # en Windows (PowerShell): Copy-Item .env.example .env
```

| Variable | Ejemplo | Qué hace |
|---|---|---|
| `NODE_ENV` | `development` | `production` activa caché de estáticos y oculta detalles de errores. |
| `PORT` | `3000` | Puerto HTTP. API, frontend y Socket.io comparten este puerto. |
| `DATABASE_URL` | `postgresql://turnos:turnos@localhost:5432/turnos_db?schema=public` | Conexión con el formato `postgresql://USUARIO:CLAVE@HOST:PUERTO/BASE`. Si la clave tiene caracteres especiales, codificalos en URL (`@` → `%40`). |
| `JWT_SECRET` | *(32+ caracteres)* | Firma los tokens de sesión. **Obligatorio y único por instalación.** Generalo con `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`. |
| `JWT_EXPIRES_IN` | `12h` | Duración de la sesión del operador (un turno laboral). |
| `APP_TIMEZONE` | `America/Argentina/Buenos_Aires` | Zona horaria IANA del negocio. Define **cuándo empieza el día** (reinicio de `A-001`) y la hora de las citas. |
| `RATE_LIMIT_PUBLIC_PER_MIN` | `120` | Máximo de turnos o citas emitidos por minuto desde una misma IP. Sólo aplica en producción. Si varios tótems salen por la misma IP (NAT), subilo. |
| `CORS_ORIGINS` | `https://turnos.miempresa.com` | Sólo si el frontend se sirve desde otro dominio. Vacío = mismo origen. |
| `COMPANY_NAME`, `COMPANY_TAGLINE`, `BRAND_PRIMARY_COLOR`, `BRAND_SECONDARY_COLOR` | — | *Opcionales.* Reemplazan los valores de `brand.config.js` sin tocar código. |

El servidor valida estas variables con Zod al arrancar. Si falta alguna o es inválida, se detiene con un mensaje claro.

### 2.3 Migraciones y datos de prueba

```bash
npm install
npm run db:migrate     # prisma migrate deploy → crea tablas, enums, índices y restricciones
npm run db:seed        # datos de ejemplo (idempotente: se puede correr varias veces)
```

Para borrar todo y empezar de cero (**destruye los datos**): `npm run db:reset`.

**El seed crea:**

- **Sucursales:** `CENTRAL` (Casa Central) y `NORTE` (Sucursal Norte).
- **Colas de CENTRAL:** `P` Atención Prioritaria (prioridad 10), `A` Cajas, `C` Atención Comercial y `R` Reclamos.
- **Boxes de CENTRAL:** Box 1 a Box 5. Cada uno atiende ciertas colas; Box 5 atiende todas.

| Usuario | Contraseña | Rol | Sucursal |
|---|---|---|---|
| `admin@turnos.local` | `Admin123!` | ADMIN | todas |
| `supervisor@turnos.local` | `Super123!` | SUPERVISOR | CENTRAL |
| `operador1@turnos.local` / `operador2@…` / `operador3@…` | `Operador123!` | OPERATOR | CENTRAL |
| `norte@turnos.local` | `Operador123!` | OPERATOR | NORTE |

> ⚠️ Cambiá o desactivá estos usuarios antes de pasar a producción (`PATCH /api/admin/users/:id`).

### 2.4 Esquema

- **Esquema Prisma:** [`prisma/schema.prisma`](prisma/schema.prisma)
- **SQL de la migración inicial:** [`prisma/migrations/20261016000000_init/migration.sql`](prisma/migrations/20261016000000_init/migration.sql)

| Tabla | Contenido |
|---|---|
| `branches` | Sucursales |
| `service_categories` | Colas o trámites, con letra de prefijo, prioridad y duración estimada |
| `desks` | Boxes o ventanillas, con el operador actual (`current_operator_id` UNIQUE: un operador ocupa un solo box) |
| `desk_categories` | Qué colas atiende cada box. Un box sin filas aquí atiende todas. |
| `users` | Operadores, supervisores y admins. La contraseña se guarda con bcrypt. |
| `tickets` | Turnos, con estado, tipo, métricas de tiempo y `service_date` (día de negocio) |
| `daily_counters` | Correlativo diario por cola, para la numeración atómica |

**Índices y restricciones clave:**

| Nombre | Definición | Para qué sirve |
|---|---|---|
| `idx_tickets_dispatch` | `(branch_id, status, priority_level DESC, created_at ASC)` | Índice del despacho "Llamar siguiente" |
| `idx_tickets_waiting` | parcial `WHERE status='WAITING'` | Índice más chico para la cola viva |
| `uq_tickets_daily_code` | `UNIQUE(branch_id, category_id, code, service_date)` | Un código no se repite en el mismo día |
| `uq_tickets_desk_active` | `UNIQUE(desk_id) WHERE status IN ('CALLED','IN_SERVICE')` | Un box nunca tiene dos turnos activos |
| `ck_tickets_scheduled_at` | `CHECK` | Una cita (`SCHEDULED`) siempre tiene `scheduled_at` |

> **¿Por qué `service_date` y no `DATE(created_at)`?** En PostgreSQL, `DATE(timestamptz)` depende de la zona horaria de la sesión. Por eso no es `IMMUTABLE` y no se puede usar en un índice único. Además, una cita se agenda hoy para otro día. `service_date` guarda explícitamente el **día de negocio** en `APP_TIMEZONE`, y la restricción diaria se apoya en esa columna.

**Para cambiar el esquema más adelante:**

```bash
npx prisma migrate dev --create-only --name agrega_campo_x
# Revisá el SQL generado: Prisma no conoce los índices parciales ni los CHECK
# de la migración inicial y podría proponer borrarlos. Quitá esas líneas.
npx prisma migrate dev
```

---

## 3. Despliegue local

```bash
# 1. Dependencias
npm install

# 2. Base de datos (ver sección 2)
docker compose up -d db
cp .env.example .env
npm run db:migrate
npm run db:seed

# 3. Backend + frontend (monolito con recarga automática)
npm run dev
```

El backend sirve también el frontend: no hay un segundo servidor que levantar. Abrí:

- **Inicio:** http://localhost:3000
- **Tótem:** http://localhost:3000/totem.html?branch=CENTRAL
- **Operador:** http://localhost:3000/operator.html (entrá con `operador1@turnos.local` / `Operador123!`)
- **TV:** http://localhost:3000/display.html?branch=CENTRAL. Tocá la pantalla una vez para habilitar el sonido.

**Prueba rápida:** abrí la TV, el tótem y dos operadores (en ventanas de incógnito distintas). Sacá varios turnos y presioná *Llamar siguiente* en los dos boxes.

### Prueba de concurrencia automatizada

Con el servidor corriendo y el seed cargado:

```bash
npm run test:concurrency          # N=40 por defecto; ej.: N=200 npm run test:concurrency
```

El script hace lo siguiente:

1. Emite N turnos **en paralelo** y verifica que no haya códigos duplicados.
2. Pone a tres boxes a llamar y finalizar turnos al mismo tiempo, a máxima velocidad.
3. Verifica que **ningún turno se haya asignado dos veces**.

### Scripts disponibles

| Script | Acción |
|---|---|
| `npm run dev` | Servidor en modo desarrollo (tsx watch) |
| `npm run build` | `prisma generate` + compilación TypeScript a `dist/` |
| `npm start` | Ejecuta el build de producción |
| `npm run typecheck` | Verificación de tipos sin emitir archivos |
| `npm run db:migrate` | Aplica las migraciones pendientes |
| `npm run db:seed` | Carga los datos de ejemplo |
| `npm run db:reset` | Borra la base y vuelve a migrar y sembrar |
| `npm run db:studio` | Prisma Studio (explorador visual de la base) |
| `npm run test:concurrency` | Prueba de carrera de "Llamar siguiente" |

---

## 4. Despliegue en producción

### 4.1 Variables críticas

| Variable | Requisito en producción |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | Base gestionada o con backups. Agregá `?sslmode=require` si el proveedor lo exige. Para pools tipo PgBouncer, sumá `&pgbouncer=true&connection_limit=10`. |
| `JWT_SECRET` | Aleatorio, 48+ bytes, **distinto en cada entorno** y nunca versionado |
| `APP_TIMEZONE` | La zona horaria real de las sucursales |
| `PORT` | El que asigne la plataforma (Render y Railway lo inyectan solos) |

### 4.2 Build

```bash
npm ci
npm run build              # genera el cliente Prisma y compila a dist/
npm run db:migrate         # prisma migrate deploy (nunca "migrate dev" en producción)
npm start                  # node dist/src/server.js
```

El frontend es HTML/CSS/JS con ES Modules y **no necesita bundling**. Se sirve tal cual desde `public/` con caché de 1 hora. Los textos y colores de marca se leen en tiempo de ejecución desde `/api/brand` y `/brand.css`, así que cambiar la marca **no requiere recompilar**: basta con reiniciar el proceso.

### 4.3 Opción A: VPS con PM2 + Nginx

```bash
npm i -g pm2
npm run build && npm run db:migrate
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup     # arranque automático al reiniciar el servidor
pm2 logs turnoflow
```

Nginx como proxy inverso, con soporte de WebSocket (indispensable para Socket.io):

```nginx
server {
    server_name turnos.miempresa.com;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host $host;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 1h;     # conexiones de la TV abiertas todo el día
    }

    listen 443 ssl;   # certbot --nginx -d turnos.miempresa.com
}
```

### 4.4 Opción B: Docker

```bash
JWT_SECRET=$(openssl rand -hex 48) docker compose --profile app up -d --build
```

- La imagen aplica `prisma migrate deploy` al arrancar.
- Para cargar el seed una vez: `docker compose exec app npx tsx prisma/seed.ts`. Requiere dependencias de desarrollo; como alternativa, corré `npm run db:seed` desde tu equipo apuntando a la base.
- `brand.config.js` y `public/assets/` se montan como volúmenes: cambiás la marca sin reconstruir la imagen.

### 4.5 Opción C: Render o Railway

| Campo | Valor |
|---|---|
| Build command | `npm ci && npm run build` |
| Pre-deploy / Release command | `npx prisma migrate deploy` |
| Start command | `npm start` |
| Base de datos | PostgreSQL gestionado. Copiá su URL interna a `DATABASE_URL`. |
| Health check | `GET /health` |

Ambas plataformas soportan WebSockets sin configuración extra.

### 4.6 Recomendaciones operativas

- **HTTPS siempre.** Lo necesitan el JWT y la API de voz en algunos navegadores.
- **TV de sala:** usá Chrome en modo kiosco, por ejemplo `chrome --kiosk --autoplay-policy=no-user-gesture-required "https://…/display.html?branch=CENTRAL"`. Con ese flag no hace falta tocar la pantalla para habilitar el sonido. La TV se reconecta sola si se corta la red.
- **Tótem:** modo kiosco con `?branch=CODIGO` fijo en la URL.
- **Backups:** `pg_dump` diario de `turnos_db`.
- **Escalado horizontal:** el proceso es *stateful* para Socket.io. Si necesitás más de una instancia, agregá [`@socket.io/redis-adapter`](https://socket.io/docs/v4/redis-adapter/) en `src/sockets/index.ts` y *sticky sessions* en el balanceador. La lógica de despacho ya es segura entre instancias porque se apoya en los locks de PostgreSQL.

---

## 5. Personalización y cambio de marca

Todo lo visual se controla desde **un archivo** y **una carpeta**:

```
turnoflow/
├── brand.config.js            ← nombre, eslogan, colores, voz, horarios de citas
└── public/assets/
    ├── logo.png               ← logotipo (reemplazar manteniendo el nombre)
    ├── favicon.ico            ← ícono de la pestaña
    └── audio/
        └── ding-dong.mp3      ← sonido del llamado en la TV
```

Después de editar, **reiniciá el servidor** (`pm2 restart turnoflow`, o se recarga solo con `npm run dev`) y refrescá los navegadores.

### 5.1 Nombre de la empresa y eslogan

En [`brand.config.js`](brand.config.js):

```js
companyName: 'Banco Regional',
tagline: 'Atención al Cliente',
```

También podés definirlos en `.env` (`COMPANY_NAME`, `COMPANY_TAGLINE`), que tiene prioridad. Así una misma imagen Docker sirve para varios clientes.

### 5.2 Sucursales, colas y boxes

Son datos de la base, no de configuración:

- **Para la instalación inicial:** editá los arreglos `BRANCHES` y `USERS` en [`prisma/seed.ts`](prisma/seed.ts) y ejecutá `npm run db:seed`.
- **Con el sistema en marcha:** usá la API de administración con un token de ADMIN (ver [sección 8](#8-referencia-de-la-api-y-de-los-eventos-en-tiempo-real)). Por ejemplo:

```bash
TOKEN=$(curl -s localhost:3000/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"admin@turnos.local","password":"Admin123!"}' | jq -r .token)

curl -X POST localhost:3000/api/admin/categories -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"branchId":"<uuid>","name":"Seguros","prefixLetter":"S","priorityLevel":0,"estimatedDurationMin":20}'
```

### 5.3 Logotipo, favicon y sonido

| Asset | Ruta exacta | Recomendación |
|---|---|---|
| Logotipo | `public/assets/logo.png` | PNG con fondo transparente, unos 512×512 px o apaisado (se muestra con 44 px de alto) |
| Favicon | `public/assets/favicon.ico` | ICO de 32×32 y 48×48 |
| Sonido del llamado | `public/assets/audio/ding-dong.mp3` | MP3 de 1 a 3 s, volumen normalizado |

Para usar otro nombre o formato (SVG, WAV…), cambiá las rutas en `brand.config.js → assets`. Si el MP3 del llamado no existe, la TV **genera un ding‑dong sintético** con Web Audio: el sistema suena igual desde el primer día.

### 5.4 Colores corporativos

En `brand.config.js → colors`. Cada clave se convierte en un token CSS `--brand-<clave-en-kebab-case>`, que el servidor publica en `/brand.css`:

| Clave | Token CSS | Dónde se ve |
|---|---|---|
| `primary` | `--brand-primary` | Barra superior, botones principales, códigos de turno |
| `primaryContrast` | `--brand-primary-contrast` | Texto sobre el color primario |
| `secondary` | `--brand-secondary` | Recuadro "turno llamado" de la TV, colas prioritarias |
| `background` / `surface` | `--brand-background` / `--brand-surface` | Fondo general y tarjetas |
| `text` / `muted` | `--brand-text` / `--brand-muted` | Texto principal y secundario |
| `success` / `warning` / `danger` | `--brand-success` … | Estados y acciones |
| `displayBackground` / `displayText` | `--brand-display-*` | Tema oscuro de la TV |

También son configurables `fontFamily` y `borderRadius`. Los estilos de [`public/css/app.css`](public/css/app.css) sólo consumen estos tokens: **no hace falta editar CSS** para cambiar de marca.

### 5.5 Otros ajustes de `brand.config.js`

| Sección | Opciones |
|---|---|
| `display` | `voiceEnabled`, `voiceTemplate` (`'Turno {code}, diríjase a {desk}'`), `voiceLang`, `historySize`, `ticker` (marquesina inferior) |
| `totem` | `resetSeconds` (tiempo que se muestra el ticket emitido), `customerIdentifierLabel` |
| `appointments` | `openingTime`, `closingTime`, `slotMinutes`, `workingDays`, `maxDaysAhead`, `checkInEarlyMinutes` |

---

## 6. Arquitectura

```
turnoflow/
├── brand.config.js                 # Marca blanca
├── docker-compose.yml · Dockerfile · ecosystem.config.cjs
├── prisma/
│   ├── schema.prisma               # Modelo de datos
│   ├── migrations/…_init/migration.sql   # DDL + índices parciales + CHECKs
│   └── seed.ts                     # Datos de ejemplo
├── scripts/concurrency-test.ts     # Prueba de carrera
├── src/
│   ├── server.ts                   # Arranque HTTP + Socket.io
│   ├── app.ts                      # Express: seguridad, rutas, estáticos, /brand.css
│   ├── config/  env.ts (Zod) · brand.ts
│   ├── db/prisma.ts
│   ├── lib/     errors.ts · time.ts (día de negocio, formato A-001)
│   ├── middleware/  auth.ts (JWT + roles) · validate.ts (Zod) · error.ts
│   ├── sockets/index.ts            # ★ Servicio de tiempo real (salas y eventos)
│   └── modules/
│       ├── auth/        login, /me
│       ├── public/      tótem, citas, seguimiento, snapshot para la TV
│       ├── tickets/     tickets.service.ts (emisión atómica, citas, check-in)
│       │                queue.service.ts (snapshot de la cola) · ticket.dto.ts
│       ├── operator/    dispatcher.service.ts ★ (Llamar siguiente, ciclo de vida, boxes)
│       └── admin/       ABM de sucursales/colas/boxes/usuarios, métricas, anulación
└── public/                          # Frontend (sin build)
    ├── index.html · totem.html · operator.html · display.html
    ├── css/app.css
    ├── js/  api.js · brand.js · sound.js · totem.js · operator.js · display.js
    └── assets/  logo.png · favicon.ico · audio/
```

### Ciclo de vida de un turno

```
               ┌──────── cancelar (cliente / supervisor) ───────► CANCELLED
               │
 WALK_IN ──► WAITING ──Llamar siguiente──► CALLED ──Iniciar──► IN_SERVICE ──Finalizar──► ATTENDED
               ▲                  (ticket:called → TV)  │  │
 SCHEDULED ──► │ (despachable                           │  └──Ausente──► ABSENT
 (cita web)    │  tras check-in)                        │
               └────────────── Devolver a la cola ──────┘   Re-llamar: CALLED → CALLED (vuelve a sonar)
```

- **Orden de despacho:** `priority_level DESC, created_at ASC`. Las colas prioritarias pasan primero. Dentro de una misma prioridad, una cita presentada en el tótem conserva la antigüedad de su reserva, así que pasa antes que los presenciales que llegaron ese día.
- **Numeración:** `prefijo + correlativo de 3 dígitos` (`A-001` … `A-999`, luego `A-1000`). Se reinicia sola cada día de negocio.
- **Métricas:** `created_at`, `checked_in_at`, `called_at`, `started_at` y `finished_at` permiten calcular la espera (`called − llegada`) y la duración de la atención (`finished − started`), disponibles en `GET /api/admin/branches/:id/stats`.

### Seguridad

- Contraseñas con **bcryptjs** (cost 12) y JWT con expiración. Los roles `ADMIN`, `SUPERVISOR` y `OPERATOR` se verifican en cada ruta.
- Operadores y supervisores sólo acceden a **su sucursal**. ADMIN tiene alcance global.
- **Zod** valida body, query, params y variables de entorno.
- **Helmet** (CSP estricta, sin scripts inline) y rate‑limit en login y en la emisión pública.
- Los eventos públicos de Socket.io **no incluyen el DNI ni el teléfono** del cliente. Ese dato sólo llega al operador por la API autenticada.

---

## 7. Concurrencia: cómo funciona "Llamar siguiente"

Implementación: [`src/modules/operator/dispatcher.service.ts`](src/modules/operator/dispatcher.service.ts)

```sql
BEGIN;  -- READ COMMITTED

-- 1) Serializa clics repetidos del MISMO box (doble clic, dos pestañas)
SELECT id, branch_id, current_operator_id FROM desks WHERE id = $desk FOR UPDATE;

-- 2) Toma el próximo turno saltando los que otro box está tomando en este instante
SELECT t.id
FROM tickets t
WHERE t.branch_id = $branch
  AND t.status = 'WAITING'
  AND t.service_date = $hoy
  AND (t.type = 'WALK_IN' OR t.checked_in_at IS NOT NULL)
  AND (<la cola es atendida por este box>)
ORDER BY t.priority_level DESC, t.created_at ASC
LIMIT 1
FOR UPDATE SKIP LOCKED;

-- 3) Asigna
UPDATE tickets SET status='CALLED', desk_id=$desk, operator_id=$op, called_at=now() WHERE id=$id;
COMMIT;

-- 4) Recién después del COMMIT: emit 'ticket:called' + 'queue:updated'
```

- `FOR UPDATE` bloquea la fila elegida hasta el `COMMIT`.
- `SKIP LOCKED` hace que otra transacción simultánea **no espere ni lea la misma fila**: pasa al siguiente candidato. Así diez boxes pueden llamar en el mismo milisegundo y cada uno recibe un turno distinto, sin bloqueos en cadena.
- El índice único parcial `uq_tickets_desk_active` es la red de seguridad en la base: un box no puede tener dos turnos `CALLED`/`IN_SERVICE` aunque hubiera un bug en la aplicación.
- Las demás transiciones (iniciar, finalizar, ausente) usan **UPDATE condicional** (`WHERE status IN (…)`). Si dos acciones compiten, sólo una aplica y la otra recibe `409`.

**Numeración atómica.** Un único `UPSERT` sobre `daily_counters`. La fila bloqueada garantiza números consecutivos sin duplicados aunque varios tótems emitan a la vez:

```sql
INSERT INTO daily_counters (category_id, service_date, last_number) VALUES ($cat, $hoy, 1)
ON CONFLICT (category_id, service_date) DO UPDATE SET last_number = daily_counters.last_number + 1
RETURNING last_number;
```

**Citas.** `pg_advisory_xact_lock(hashtext(categoría|fecha|hora))` serializa las reservas de una misma franja, así que no se puede superar la capacidad (cantidad de boxes que atienden esa cola).

---

## 8. Referencia de la API y de los eventos en tiempo real

### REST

Rutas públicas (sin autenticación):

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/brand` · `/brand.css` | Configuración de marca y tokens CSS |
| GET | `/api/public/branches` | Sucursales activas |
| GET | `/api/public/branches/:code` | Sucursal y sus colas |
| GET | `/api/public/branches/:id/queue` | Snapshot de la cola (TV) |
| POST | `/api/public/tickets` | Sacar turno `{ branchId, categoryId, customerIdentifier? }` |
| GET | `/api/public/tickets/:id` | Estado, posición y espera estimada |
| POST | `/api/public/tickets/:id/cancel` | El cliente cancela su turno |
| GET | `/api/public/appointments/availability?branchId&categoryId&date` | Franjas libres |
| POST | `/api/public/appointments` | Agendar `{ branchId, categoryId, customerIdentifier, date: 'YYYY-MM-DD', time: 'HH:mm' }` |
| POST | `/api/public/appointments/check-in` | Registrar llegada `{ branchId, customerIdentifier }` |

Autenticación:

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/api/auth/login` | `{ email, password }` → `{ token, user }` |
| GET | `/api/auth/me` | Usuario actual y box ocupado |

Operador (`Authorization: Bearer <token>`, cualquier rol):

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/operator/desks` | Boxes de la sucursal |
| POST | `/api/operator/desks/:id/claim` · `/release` | Tomar o liberar un box |
| GET | `/api/operator/desks/:id/state` | Turno en curso y atendidos hoy |
| POST | `/api/operator/desks/:id/call-next` | ★ **Llamar siguiente**: `200` con el ticket, o `204` si no hay nadie esperando |
| POST | `/api/operator/tickets/:id/start` · `/finish` · `/absent` · `/recall` · `/requeue` | Ciclo de vida del turno |

Administración y supervisión:

| Método | Ruta | Rol |
|---|---|---|
| GET/POST/PATCH | `/api/admin/branches` · `/categories` · `/desks` · `/users` | ADMIN (los GET de sucursales, colas y boxes también SUPERVISOR) |
| GET | `/api/admin/branches/:id/tickets?status=&date=` | SUPERVISOR+ |
| GET | `/api/admin/branches/:id/stats?date=` | SUPERVISOR+: espera media, atención media, por cola, por operador y por hora |
| POST | `/api/admin/tickets/:id/cancel` | SUPERVISOR+ |
| GET | `/health` | Healthcheck (incluye un ping a la base) |

### Socket.io

Definidos en [`src/sockets/index.ts`](src/sockets/index.ts).

| Dirección | Evento | Payload |
|---|---|---|
| cliente → servidor | `branch:join` | `{ branchId }` → ack `{ ok, snapshot }` |
| cliente → servidor | `branch:leave` | `{ branchId }` |
| cliente → servidor | `ticket:watch` | `{ ticketId }`: el celular del cliente sigue su turno |
| servidor → cliente | **`ticket:called`** | `{ ticket, isRecall }`: la TV muestra el turno, suena y lo anuncia |
| servidor → cliente | **`queue:updated`** | Snapshot: colas con espera, boxes abiertos, últimos llamados y totales (agrupado cada 150 ms) |
| servidor → cliente | `ticket:updated` | `{ ticket }` en cada cambio de estado |

Salas: `branch:<id>` (TV, operadores y tótems de la sucursal) y `ticket:<id>` (seguimiento individual). La autenticación del socket es opcional: si se envía `auth.token`, debe ser un JWT válido.
