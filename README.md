# 🎫 TurnoFlow — Atención al Ciudadano

Sistema de turnos y gestión de colas para la **Oficina de Atención al Ciudadano** de un Ministerio u Organismo Público. Usa **Node.js + TypeScript**, **PostgreSQL**, **Prisma** y **Socket.io**, y es marca blanca: se adapta a cualquier institución editando un archivo.

Qué cubre:

- **Registro de entrada en 3 pasos** (catálogo real del MPPE, ver [sección 7](#7-motivos-de-atención)):
  1. **Identificación:** cédula `V` o `E`, con el nombre **autocompletado** desde un servicio de identidad (SAIME, nómina o padrón) o desde la cache local. El nombre sigue siendo editable. Incluye un check opcional de atención preferencial.
  2. **Dependencia:** 🏢 Zona Educativa (Caracas / Distrito Capital) o 🏛️ Atención al Ciudadano (nacional / otros estados). La dependencia define el prefijo del turno: `ZE-001` u `OAC-001`.
  3. **Trámite:** las 7 Direcciones (Ingreso, Egreso, Nómina, Gremiales, Registro de Personal, Asesoría Jurídica, Registro y Control de Estudio) y sus 38 trámites.
- **Motivos y dependencias administrables:** tablas maestras que gestiona el propio ministerio, sin trámites fijos en el código.
- **Atención preferencial** para adultos mayores, embarazadas y personas con discapacidad, con prioridad en la cola.
- **Citas previas por web**, con check-in por cédula el día de la cita.
- **Despacho a 12 taquillas especializadas** por dependencia y Dirección, seguro ante concurrencia (`FOR UPDATE SKIP LOCKED`).
- **Pantalla de sala:** *"Turno ZE-001 · V-12.345.678 · pase a · Taquilla N° 3"*, con sonido y voz.
- **Cierre obligatorio con resultado de la petición:** resuelto, en trámite, remitido, no procede o pendiente de recaudos; con observaciones y la dependencia de destino cuando se remite.
- **Reportería ministerial:** filtros por fecha, año, mes, día, taquilla, funcionario, dependencia, trámite, Dirección, estatus y resultado; resúmenes y exportación CSV para Excel.

| Vista | URL | Quién la usa |
|---|---|---|
| Tótem / Registro de entrada | `/totem.html?branch=SEDE` | Ciudadanos (tótem táctil con teclado numérico) |
| Agendar cita (enlace web) | `/totem.html?branch=SEDE&mode=web` | Ciudadanos desde el portal institucional |
| Seguimiento del turno | `/totem.html?track=<id>` | Ciudadano en su celular (el enlace se muestra en el ticket) |
| Panel de taquilla | `/operator.html` | Funcionarios de taquilla |
| Pantalla de sala | `/display.html?branch=SEDE` | TV de la sala de espera |
| Consultas y reportes | `/consultas.html` | Supervisores y administradores |

---

## Índice

1. [Requisitos previos](#1-requisitos-previos)
2. [Configuración de la base de datos](#2-configuración-de-la-base-de-datos)
3. [Despliegue local](#3-despliegue-local)
4. [Despliegue en producción](#4-despliegue-en-producción)
5. [Personalización institucional](#5-personalización-institucional)
6. [Identificación del ciudadano y consulta de cédula](#6-identificación-del-ciudadano-y-consulta-de-cédula)
7. [Motivos de atención](#7-motivos-de-atención)
8. [Taquillas y resolución de la petición](#8-taquillas-y-resolución-de-la-petición)
9. [Reportería](#9-reportería)
10. [Arquitectura](#10-arquitectura)
11. [Concurrencia: cómo funciona "Llamar siguiente"](#11-concurrencia-cómo-funciona-llamar-siguiente)
12. [Referencia de la API y eventos en tiempo real](#12-referencia-de-la-api-y-eventos-en-tiempo-real)

---

## 1. Requisitos previos

| Herramienta | Versión | Notas |
|---|---|---|
| **Node.js** | 20 LTS o superior (probado con 22 y 26) | `node -v` |
| **npm** | 10+ (o **pnpm** 9+) | En npm 11 los scripts de instalación de Prisma y esbuild ya están aprobados en `package.json → allowScripts` |
| **PostgreSQL** | 15+ recomendado (funciona desde 13; probado en 14) | Se usa `gen_random_uuid()`, nativo desde la 13 |
| **Docker** *(opcional)* | Engine 24+ con Compose v2 | Para levantar PostgreSQL con un comando |

---

## 2. Configuración de la base de datos

### 2.1 Levantar PostgreSQL

**Con Docker:**

```bash
docker compose up -d db          # base turnos_db, usuario turnos / clave turnos, puerto 5432
```

**Con un PostgreSQL ya instalado:**

```sql
CREATE USER turnos WITH PASSWORD 'turnos';
CREATE DATABASE turnos_db OWNER turnos;
```

### 2.2 Archivo `.env`

```bash
cp .env.example .env        # PowerShell: Copy-Item .env.example .env
```

| Variable | Ejemplo | Qué hace |
|---|---|---|
| `NODE_ENV` | `development` | `production` activa caché de estáticos, límites de pedidos y oculta detalles de errores |
| `PORT` | `3000` | Puerto HTTP. API, vistas y Socket.io comparten el puerto. |
| `DATABASE_URL` | `postgresql://turnos:turnos@localhost:5432/turnos_db?schema=public` | Conexión a PostgreSQL. Si la clave tiene caracteres especiales, codificalos en URL (`@` → `%40`). |
| `JWT_SECRET` | *(32+ caracteres)* | Firma de sesiones. **Obligatorio y único por instalación.** Generalo con `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`. |
| `JWT_EXPIRES_IN` | `12h` | Duración de la sesión del funcionario |
| `APP_TIMEZONE` | `America/Caracas` | Zona horaria del organismo. Define cuándo empieza el día (reinicio de `N-001`), los horarios de citas y el desglose año, mes, día y hora. |
| `RATE_LIMIT_PUBLIC_PER_MIN` | `120` | Turnos o citas por minuto y por IP. Sólo aplica en producción. Si varios tótems salen por la misma IP (NAT), subilo. |
| `CORS_ORIGINS` | `https://turnos.gob.ve` | Sólo si las vistas se sirven desde otro dominio |
| `CITIZEN_LOOKUP_PROVIDER` | `mock` | `mock` (registro simulado), `http` (servicio real) o `none` (sólo cache local). Ver [sección 6](#6-identificación-del-ciudadano-y-consulta-de-cédula). |
| `CITIZEN_LOOKUP_URL` / `CITIZEN_LOOKUP_TOKEN` | — | Endpoint y token del servicio de identidad. Obligatorios con `http`. |
| `CITIZEN_LOOKUP_TIMEOUT_MS` | `3000` | Si el servicio externo no responde en ese tiempo, se sigue con la cache |
| `CITIZEN_CACHE_TTL_DAYS` | `180` | Días que un nombre obtenido del servicio externo se reutiliza sin volver a consultar |
| `CITIZEN_LOOKUP_MASK_PUBLIC` | `false` | `true` hace que el tótem reciba el nombre enmascarado (`M**** G*******`) |
| `RATE_LIMIT_LOOKUP_PER_MIN` | `30` | Consultas públicas de cédula por minuto y por IP. Frena la enumeración de datos personales. |
| `COMPANY_NAME`, `COMPANY_TAGLINE`, `BRAND_*_COLOR` | — | *Opcionales.* Reemplazan los valores de `brand.config.js`. |

El servidor valida estas variables con Zod al arrancar. Si alguna falta o es inválida, se detiene con un mensaje claro.

### 2.3 Migraciones y datos de prueba

```bash
npm install
npm run db:migrate     # aplica las migraciones pendientes
npm run db:seed        # datos de ejemplo (idempotente)
```

| Migración | Contenido |
|---|---|
| `20261016000000_init` | Esquema base: sedes, colas, boxes, usuarios, turnos, contadores e índices de despacho |
| `20261017000000_ministerio_atencion_ciudadano` | Adaptación ministerial. Ver detalle abajo. |
| `20261018000000_dependencias_atencion` | Tablas `dependencies` y `desk_dependencies`, `tickets.dependency_id` y orden de los trámites (`sort_order`). Es solo aditiva: no modifica datos existentes. |

La segunda migración hace lo siguiente:

- Renombra `service_categories` → `attention_reasons` y `desk_categories` → `desk_reasons`.
- Agrega el número de taquilla.
- Agrega a `tickets` la cédula (origen y número), el nombre del ciudadano, la atención preferencial, la instantánea de taquilla y funcionario, la resolución, el desglose temporal y las duraciones.
- Crea la cache `citizens` y cambia la numeración a sede + prefijo + día.

**Actualizar una instalación anterior.** Si la instalación ya tenía datos, `npm run db:migrate` la actualiza sin perderlos:

- Los turnos existentes se completan: se rescatan los dígitos del identificador viejo, se calcula el desglose temporal con `America/Caracas`, y las atenciones finalizadas quedan como `RESUELTO` con una nota.
- Las nuevas validaciones de formato se crean `NOT VALID`: rigen para registros nuevos y no rechazan el histórico.

Para borrar todo y empezar de cero (**destruye los datos**): `npm run db:reset`.

**El seed crea** el catálogo del MPPE según el documento *PROCESOS POR DIRECCION.xlsx*. Es idempotente: si la base ya tenía otros motivos, el seed los **desactiva** (no los borra, para conservar el histórico de reportes).

**Sedes:**
- `SEDE` (Sede Central): 2 dependencias, 38 trámites y 12 taquillas.
- `REGIONAL` (Oficina Regional): sólo Atención al Ciudadano, 38 trámites y 2 taquillas polivalentes.

**Dependencias (paso 2 del tótem):**

| Código | Dependencia | Prefijo | Para quién |
|---|---|---|---|
| `ZE` | 🏢 Zona Educativa (Caracas / Distrito Capital) | `ZE-001` | Personal docente, administrativo u obrero de planteles de Caracas |
| `OAC` | 🏛️ Atención al Ciudadano (Nacional / Otros Estados) | `OAC-001` | Personal de los estados del interior, usuarios externos o trámites generales |

**Direcciones y trámites (paso 3 del tótem):**

| Dirección | Códigos | Trámites |
|---|---|---|
| Ingreso | `ING-01` … `ING-13` | Clasificación, corrección o cambio de cuenta bancaria, sinceración de personal, traslado, incremento de horas, concentración de carga horaria, regularización de cargo, ingresos, desafiliación de sindicatos, corrección de datos, prima por profesionalización, prima geográfica, prima por hijos |
| Egreso | `EGR-01` … `EGR-08` | Solicitud de jubilación ⚑, pensión de sobreviviente ⚑, FP023, autorización al cobro, solicitud 14100, solicitud 1408, renuncia, egreso por fallecimiento |
| Nómina | `NOM-01` … `NOM-03` | Consulta de estatus del personal, constancia de trabajo, recibo de pago |
| Gremiales | `GRE-01` … `GRE-09` | Reconocimiento de años privados y públicos, reactivación, permisos (cuido, pre y post natal, fallecimiento, estudios, matrimonio), salarios no cancelados, cambio de modalidad de pago |
| Registro de Personal | `REG-01` | Vacaciones |
| Asesoría Jurídica | `JUR-01` | Consultas y asesoría jurídica laboral |
| Registro y Control de Estudio | `EST-01` … `EST-03` | Legalización de título de bachiller, legalización de notas certificadas, copia certificada del título (CCRT) |

⚑ = prioridad alta: se atiende antes que otros trámites de la misma taquilla.

Las duraciones estimadas (6 a 25 min) no vienen en el documento: son valores iniciales razonables que se ajustan desde *Consultas → Motivos de atención*.

**Distribución de taquillas (Sede Central):**

| Taquillas | Dependencia | Direcciones |
|---|---|---|
| 1 a 3 | Zona Educativa | Nómina, Ingreso y Registro de Personal |
| 4 y 5 | Zona Educativa | Gremiales (permisos) y Asesoría Jurídica |
| 6 a 8 | Atención al Ciudadano | Ingreso, Nómina, Gremiales, Registro de Personal y Asesoría Jurídica |
| 9 y 10 | Ambas | Egreso / Seguridad Social (jubilaciones, pensiones, FP023, 14100, 1408) |
| 11 | Ambas | Registro y Control de Estudio (títulos, notas, CCRT) |
| 12 | Ambas | **Polivalente:** cualquier trámite, de apoyo en alta demanda |

**Funcionarios:**

| Usuario | Contraseña | Rol | Sede |
|---|---|---|---|
| `admin@ministerio.local` | `Admin123!` | ADMIN | todas |
| `supervisor@ministerio.local` | `Super123!` | SUPERVISOR | SEDE |
| `taquilla1@ministerio.local` … `taquilla12@ministerio.local` | `Taquilla123!` | OPERATOR | SEDE (uno por taquilla) |
| `regional@ministerio.local` | `Taquilla123!` | OPERATOR | REGIONAL |

**Cédulas del registro simulado (`mock`):**

| Cédula | Nombre |
|---|---|
| `V-12345678` | María Alejandra González Pérez |
| `V-87654321` | José Gregorio Rodríguez Méndez |
| `V-5123456` | Carmen Elena Silva de Ramírez |
| `E-84123456` | Giuseppe Antonio Russo Bianchi |

Cualquier otra cédula responde "no registrada" y el ciudadano escribe su nombre.

> ⚠️ Cambiá o desactivá los usuarios de prueba antes de pasar a producción (`PATCH /api/admin/users/:id`).

### 2.4 Esquema

- **Esquema Prisma:** [`prisma/schema.prisma`](prisma/schema.prisma)
- **SQL:** [`prisma/migrations/`](prisma/migrations/)

| Tabla | Contenido |
|---|---|
| `branches` | Sedes u oficinas de atención |
| `dependencies` | **Dependencias** (Zona Educativa, Atención al Ciudadano): código, nombre, descripción, ícono, **prefijo del turno**, orden, activa |
| `desk_dependencies` | Qué dependencias atiende cada taquilla. Sin filas, atiende todas. |
| `attention_reasons` | **Motivos de atención (trámites)**: código, nombre, descripción, Dirección, prefijo de respaldo, prioridad, duración estimada, si admite citas, orden, activo |
| `desks` | **Taquillas**: número (`Taquilla N° 3`), etiqueta y funcionario actual |
| `desk_reasons` | Qué motivos atiende cada taquilla. Sin filas, atiende todos. |
| `users` | Funcionarios (ADMIN, SUPERVISOR, OPERATOR), con contraseña bcrypt |
| `citizens` | Cache local de ciudadanos: cédula, nombre, origen del dato y última visita |
| `tickets` | Turnos y atenciones (detalle abajo) |
| `daily_counters` | Correlativo diario por sede, prefijo y día |

**Campos de `tickets`:**

| Grupo | Columnas |
|---|---|
| Ciudadano | `id_origin` (`V`/`E`/`J`/`G`), `id_number`, `citizen_name`, `preferential_type` |
| Flujo | `status` (`WAITING` → `CALLED` → `IN_SERVICE` → `ATTENDED` / `ABSENT` / `CANCELLED`), `type` (`WALK_IN` / `SCHEDULED`), `scheduled_at`, `priority_level` |
| Asignación | `desk_id`, `desk_number`, `operator_id`, `operator_name`. Número y nombre son una **instantánea** tomada al llamar, para que la auditoría no cambie si después se renumera una taquilla o se renombra un usuario. |
| Resolución | `resolution_status`, `resolution_notes`, `destination_department` |
| Marcas de tiempo | `created_at`, `checked_in_at`, `called_at`, `started_at` (inicio de la atención), `finished_at` |
| Desglose temporal | `year`, `month`, `day`, `hour`, `day_of_week` (ISO: 1 = lunes … 7 = domingo), en `APP_TIMEZONE` |
| Duraciones | `wait_seconds` (llegada → llamado) y `service_seconds` (inicio → fin), precalculadas |

**Índices y restricciones clave:**

| Nombre | Definición | Para qué |
|---|---|---|
| `idx_tickets_dispatch` | `(branch_id, status, priority_level DESC, created_at ASC)` | "Llamar siguiente" |
| `uq_tickets_daily_code` | `UNIQUE(branch_id, code, service_date)` | Un código no se repite en el día |
| `uq_tickets_desk_active` | `UNIQUE(desk_id) WHERE status IN ('CALLED','IN_SERVICE')` | Una taquilla nunca tiene dos turnos activos |
| `idx_tickets_citizen` | `(id_origin, id_number, service_date)` | Búsqueda por cédula |
| `idx_tickets_report_date` | `(branch_id, year, month, day)` | Reportes por año, mes y día |
| `ck_tickets_attended_resolution` | `CHECK` | No se puede cerrar una atención sin resultado |
| `ck_tickets_referral_destination` | `CHECK` | `REMITIDO` exige dependencia de destino |
| `ck_tickets_id_number`, `ck_tickets_temporal` | `CHECK` | Formato de la cédula y rangos de mes, día, hora y día de la semana |

> **¿Por qué el desglose temporal se guarda y no se calcula en cada consulta?** Para que los reportes y las auditorías filtren con `WHERE year = 2026 AND month = 10` directamente, con índice y sin conversiones de zona horaria en SQL. En las citas, el desglose refleja la hora agendada de la atención y no la hora en que se reservó.

**Para cambiar el esquema más adelante:**

```bash
npx prisma migrate dev --create-only --name agrega_campo_x
# Revisá el SQL: Prisma no conoce los índices parciales ni los CHECK y podría proponer borrarlos.
npx prisma migrate dev
```

---

## 3. Despliegue local

```bash
npm install
docker compose up -d db
cp .env.example .env
npm run db:migrate
npm run db:seed
npm run dev                     # backend + vistas con recarga automática
```

El backend sirve también las vistas, así que no hay un segundo servidor que levantar.

- **Inicio:** http://localhost:3000
- **Tótem:** http://localhost:3000/totem.html?branch=SEDE. Probá la cédula `V` `12345678` (el nombre se completa solo), elegí Zona Educativa y un trámite de Ingreso: el turno sale `ZE-001` y lo llama la Taquilla N° 1.
- **Taquilla:** http://localhost:3000/operator.html (`taquilla1@ministerio.local` / `Taquilla123!`)
- **TV:** http://localhost:3000/display.html?branch=SEDE. Tocá la pantalla una vez para habilitar el sonido.
- **Consultas:** http://localhost:3000/consultas.html (`supervisor@ministerio.local` / `Super123!`)

### Prueba de concurrencia automatizada

```bash
npm run test:concurrency          # N=40 por defecto; ej.: N=200 npm run test:concurrency
```

El script hace lo siguiente:

1. Emite N turnos en paralelo, con cédulas distintas, y verifica que no haya códigos duplicados.
2. Pone a tres taquillas a llamar y cerrar atenciones a máxima velocidad.
3. Verifica que **ningún ciudadano se asigne dos veces**.

| Script | Acción |
|---|---|
| `npm run dev` | Servidor de desarrollo (tsx watch) |
| `npm run build` / `npm start` | Build de producción y ejecución |
| `npm run typecheck` | Verificación de tipos |
| `npm run db:migrate` / `db:seed` / `db:reset` / `db:studio` | Base de datos |
| `npm run test:concurrency` | Prueba de carrera de "Llamar siguiente" |

---

## 4. Despliegue en producción

### 4.1 Variables críticas

| Variable | Requisito |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | Base con respaldos. Agregá `?sslmode=require` si corresponde. |
| `JWT_SECRET` | Aleatorio, 48+ bytes, distinto en cada entorno y nunca versionado |
| `APP_TIMEZONE` | La zona horaria real del organismo |
| `CITIZEN_LOOKUP_PROVIDER` | `http` (con URL y token) o `none`. **No dejes `mock` en producción.** |

### 4.2 Build

```bash
npm ci
npm run build          # prisma generate + compilación TypeScript a dist/
npm run db:migrate     # prisma migrate deploy (nunca "migrate dev" en producción)
npm start
```

Las vistas son HTML/CSS/JS con ES Modules y no necesitan bundling. Textos, colores y reglas de `brand.config.js` se leen en tiempo de ejecución: cambiarlos sólo requiere reiniciar el proceso.

### 4.3 VPS con PM2 + Nginx

```bash
npm i -g pm2
npm run build && npm run db:migrate
pm2 start ecosystem.config.cjs && pm2 save && pm2 startup
```

Nginx con soporte de WebSocket (indispensable para Socket.io):

```nginx
server {
    server_name turnos.ministerio.gob.ve;
    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host $host;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 1h;
    }
    listen 443 ssl;
}
```

### 4.4 Docker

```bash
JWT_SECRET=$(openssl rand -hex 48) docker compose --profile app up -d --build
```

La imagen aplica las migraciones al arrancar. `brand.config.js` y `public/assets/` se montan como volúmenes.

### 4.5 Render o Railway

| Campo | Valor |
|---|---|
| Build | `npm ci && npm run build` |
| Pre-deploy | `npx prisma migrate deploy` |
| Start | `npm start` |
| Health check | `GET /health` |

### 4.6 Recomendaciones operativas

- **HTTPS siempre.** El sistema maneja datos personales: cédula y nombre.
- **TV:** usá Chrome en modo kiosco, por ejemplo `chrome --kiosk --autoplay-policy=no-user-gesture-required "https://…/display.html?branch=SEDE"`.
- **Tótem:** modo kiosco con `?branch=CODIGO` fijo y pantalla táctil. El teclado numérico está en pantalla.
- **Respaldos:** `pg_dump` diario. La tabla `tickets` es el registro de auditoría de la atención.
- **Más de una instancia:** agregá `@socket.io/redis-adapter`. El despacho ya es seguro entre instancias porque se apoya en los locks de PostgreSQL.

---

## 5. Personalización institucional

```
turnoflow/
├── brand.config.js            ← nombre, eslogan, colores, llamado en TV, reglas de atención y de citas
└── public/assets/
    ├── logo.png               ← escudo o logotipo (reemplazar manteniendo el nombre)
    ├── favicon.ico
    └── audio/ding-dong.mp3    ← sonido del llamado (si no existe, se genera uno sintético)
```

Después de editar, reiniciá el servidor.

| Clave de `brand.config.js` | Qué controla |
|---|---|
| `companyName`, `tagline` | Nombre del organismo y de la oficina. También se pueden definir por `.env`. |
| `colors.*` | Paleta institucional. Cada clave se convierte en el token CSS `--brand-<clave>`, servido en `/brand.css`. |
| `citizen.allowedOrigins` | Orígenes de documento habilitados, por ejemplo `['V', 'E']` si no se atiende a personas jurídicas |
| `citizen.originLabels` | Textos de ayuda de cada origen |
| `deskLabel` | Formato del nombre de la taquilla: `'Taquilla N° {number}'` o `'Taquilla {number2}'` (con dos dígitos: 01, 02…) |
| `display.callBy` | La TV muestra siempre turno (`ZE-001`), cédula y taquilla. `'cedula'` destaca la cédula; `'ticket'` destaca el número de turno. |
| `display.maskCedula` | `true` muestra `V-12.345.***` en la TV. En ese caso la voz anuncia el turno y el número completo **nunca** llega a la pantalla. |
| `display.voiceTemplateCedula` / `voiceTemplateTicket` | Texto de la voz. Variables: `{cedula}`, `{code}`, `{deskNumber}`, `{desk}`, `{reason}`. |
| `totem.preferentialEnabled` | Mostrar la opción de atención preferencial |
| `attention.preferentialBoost` | Puntos de prioridad que suma la atención preferencial (por defecto 50) |
| `attention.minResolutionNotes` | Largo mínimo de las observaciones al cerrar una atención |
| `appointments.*` | Horario, duración de franja, días hábiles y anticipación de las citas web |

Las **sedes y taquillas** se cargan en [`prisma/seed.ts`](prisma/seed.ts) o con la API de administración. Los **motivos** se administran desde la vista de Consultas (ver [sección 7](#7-motivos-de-atención)).

---

## 6. Identificación del ciudadano y consulta de cédula

**Formato y validación (backend y frontend):**

| Origen | Significado | Número |
|---|---|---|
| `V` | Venezolano | 4 a 8 dígitos |
| `E` | Extranjero | 4 a 10 dígitos |
| `J` | Persona jurídica (RIF) | 8 a 9 dígitos, con el verificador |
| `G` | Ente gubernamental (RIF) | 8 a 9 dígitos |

- Se aceptan puntos y guiones al escribir (`12.345.678`), pero se guardan sólo los dígitos.
- Se muestra como `V-12.345.678` o `J-12345678-9`.
- **Un ciudadano no puede tener dos turnos activos el mismo día en la misma sede.** Si tiene una cita sin presentar, el tótem le indica que use "Tengo cita".

### `citizenLookupService`

Implementación: [`src/modules/citizens/citizen-lookup.service.ts`](src/modules/citizens/citizen-lookup.service.ts)

Al completar la cédula, el tótem consulta `GET /api/public/citizens/lookup?idOrigin=V&idNumber=12345678`. El servicio resuelve en este orden:

1. **Cache local con dato externo vigente** (menos de `CITIZEN_CACHE_TTL_DAYS`). No sale a la red.
2. **Proveedor externo** (SAIME, nómina, padrón o mock). Si responde, el dato se guarda en la cache.
3. **Cache con dato cargado a mano** en un registro anterior, o con un dato externo vencido.
4. **No encontrado.** El ciudadano escribe su nombre.

Si el servicio externo falla o tarda más de `CITIZEN_LOOKUP_TIMEOUT_MS`, el error se registra y **nunca bloquea la emisión del turno**. El nombre confirmado en el tótem se guarda en la cache (`citizens`) junto con la fecha de la última visita.

### Conectar el servicio real

Los proveedores están en [`src/modules/citizens/citizen-providers.ts`](src/modules/citizens/citizen-providers.ts). Hay dos formas de conectar el servicio del organismo.

**A. Servicio HTTP.**

1. Definí en el `.env`:

   ```env
   CITIZEN_LOOKUP_PROVIDER=http
   CITIZEN_LOOKUP_URL=https://servicio-identidad.interno/api/ciudadanos
   CITIZEN_LOOKUP_TOKEN=<token>
   ```

2. El sistema llama a `GET <URL>?nacionalidad=V&cedula=12345678` con `Authorization: Bearer <token>`.
3. Adaptá `mapHttpResponse()` al formato de respuesta del servicio. Por defecto entiende:
   - `{ nombreCompleto }`
   - `{ nombres, apellidos }`
   - `{ primer_nombre, …, segundo_apellido }`
   - cualquiera de ellos envuelto en `{ data: … }`

   Un `404` se interpreta como "no registrado".

**B. Proveedor propio.** Por ejemplo, una consulta SQL a la base de nómina:

```ts
export class NominaProvider implements CitizenProvider {
  readonly name = 'NOMINA';
  async lookup(idOrigin, idNumber) {
    const row = await nominaDb.query('SELECT nombres || \' \' || apellidos AS n FROM trabajadores WHERE cedula = $1', [idNumber]);
    return row ? { fullName: row.n } : null;
  }
}
```

Registralo en `createProvider()`.

**Protección de datos personales:**

- El endpoint público de consulta tiene su propio límite de pedidos (`RATE_LIMIT_LOOKUP_PER_MIN`) contra la enumeración de cédulas.
- Con `CITIZEN_LOOKUP_MASK_PUBLIC=true` el tótem sólo ve el nombre enmascarado.
- Los eventos que recibe la TV **no incluyen el nombre**, y pueden ocultar la cédula (`display.maskCedula`).
- Nombre y cédula completos sólo llegan a funcionarios autenticados.

---

## 7. Motivos de atención

### Flujo del tótem (3 pasos)

| Paso | Qué hace el ciudadano o la recepcionista |
|---|---|
| **1. Identificación** | Elige `V` o `E` (configurable en `brand.config.js → citizen.allowedOrigins`; el servidor rechaza los orígenes no habilitados) y escribe el número en el teclado en pantalla. El nombre se autocompleta y sigue siendo editable. Opcionalmente marca **"Requiere atención preferencial"** y elige adulto mayor, embarazada o discapacidad. |
| **2. Dependencia** | Toca la tarjeta de **Zona Educativa** o de **Atención al Ciudadano**. Si la sede no tiene dependencias cargadas, este paso se saltea. |
| **3. Trámite** | Toca una de las 7 Direcciones y luego el trámite. "Obtener turno" emite `ZE-###` u `OAC-###`. |

**Reglas del turno:**
- **Código:** prefijo de la dependencia más correlativo diario. Cada dependencia numera por separado (`ZE-001`, `OAC-001`, `ZE-002`…).
- **Prioridad:** la prioridad del trámite (jubilación y pensión de sobreviviente) más el bono preferencial (`attention.preferentialBoost`). Dentro de una misma prioridad se atiende por orden de llegada.
- **Ruteo:** una taquilla sólo llama turnos de **las dependencias y los trámites que atiende**. Por ejemplo, la Taquilla 1 (Zona Educativa) nunca toma un `OAC-…`, y un trámite de Egreso sólo lo toman las taquillas 9, 10 y 12.

### Administración

Dependencias y trámites son tablas maestras por sede, administrables sin tocar código.

- **Trámites:** se gestionan desde *Consultas → Motivos de atención*: alta, edición (incluido el **orden en el tótem**), activar y desactivar. Pueden hacerlo ADMIN y los SUPERVISOR de esa sede.
- **Orden de las Direcciones en el tótem:** el de su primer trámite (`sortOrder`).
- **Eliminar un trámite:** sólo se permite si no tiene atenciones registradas. Si las tiene, se **desactiva**, para preservar el histórico de los reportes.
- **Dependencias:** las gestiona ADMIN por API. Se pueden agregar otras (por ejemplo, una tercera oficina) con su propio prefijo.
- **Taquillas:** cada una puede limitarse a un subconjunto de trámites (`desk_reasons`) y de dependencias (`desk_dependencies`). Sin asignación, atiende todos.

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/admin/reasons?branchId=&includeInactive=` | Listado, con la cantidad de usos |
| POST | `/api/admin/reasons` | `{ branchId, code, name, department, prefixLetter, description?, priorityLevel?, estimatedDurationMin?, allowAppointments?, isActive?, sortOrder? }` |
| PATCH | `/api/admin/reasons/:id` | Edición parcial; `{ isActive: false }` lo desactiva |
| DELETE | `/api/admin/reasons/:id` | `204`, o `409 REASON_IN_USE` si tiene atenciones |
| GET | `/api/admin/departments` | Direcciones ya cargadas, para autocompletar |
| GET | `/api/admin/dependencies?branchId=` | Dependencias de la sede (SUPERVISOR+) |
| POST / PATCH | `/api/admin/dependencies` · `/:id` | `{ branchId, code, name, prefix, description?, icon?, sortOrder?, isActive? }` (ADMIN) |
| PATCH | `/api/admin/desks/:id` | `{ reasonIds?, dependencyIds? }`: especialización de la taquilla (ADMIN) |

---

## 8. Taquillas y resolución de la petición

**Panel de taquilla:**

- El encabezado muestra *"Taquilla N° 3 — Funcionario: Carmen Rosa Linares"*.
- Al llamar a un ciudadano, la tarjeta muestra la cédula grande, el nombre, el motivo con su código, la Dirección, si es preferencial o cita, y las horas de llegada y llamado.
- Acciones disponibles: **Iniciar atención**, **Re-llamar**, **Ausente**, **Devolver a la cola** y **Finalizar atención**.
- Atajos de teclado: `Espacio` llama al siguiente, `I` inicia, `F` finaliza, `R` vuelve a llamar y `A` marca ausente.

**Cierre obligatorio.** "Finalizar atención" abre un modal que no se puede saltear:

| Estatus de la petición | Uso |
|---|---|
| `RESUELTO` | Trámite concluido satisfactoriamente |
| `EN_TRAMITE` | Requiere seguimiento |
| `REMITIDO` | Enviado a otra Dirección u organismo. Exige **Remitido a**, con autocompletado de dependencias conocidas. |
| `NO_PROCEDE` | No aplica o le faltan requisitos |
| `PENDIENTE_RECAUDOS` | El ciudadano debe consignar documentos |

- Las observaciones son obligatorias (mínimo `attention.minResolutionNotes` caracteres).
- La validación se aplica tres veces: en el modal, en la API (Zod) y en la base de datos (`CHECK`).
- Al llamar se guardan la instantánea de taquilla y funcionario (`desk_number`, `operator_name`) y el tiempo de espera. Al cerrar se guarda la duración de la atención.

---

## 9. Reportería

### Vista *Consultas* (`/consultas.html`)

Es para SUPERVISOR (su sede) y ADMIN (todas las sedes).

**Filtros combinables:**

| Grupo | Filtros |
|---|---|
| Ciudadano | Cédula (origen y número), nombre parcial |
| Fechas | Rango desde/hasta, año, mes, día |
| Atención | Taquilla, funcionario, dependencia (ZE / OAC), trámite, Dirección |
| Estado | Estatus del flujo, resultado de la petición, tipo (presencial o cita), preferencial |

**Pestañas:**

- **Atenciones:** listado paginado. Al hacer clic en una fila se abre el **detalle completo** con las observaciones y en qué quedó la petición.
- **Resumen:** totales del período, resultado de las peticiones, y desgloses por Dirección, motivo, taquilla, funcionario, hora de llegada, día de la semana y día. Cada desglose incluye atendidos, ausentes, espera media y atención media.
- **Exportar CSV:** respeta los filtros. Usa separador `;` y UTF-8 con BOM para abrirse directo en Excel en español. Se neutralizan las fórmulas (inyección CSV) y el máximo es de 50.000 filas.

### API

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/reports/attentions?…&page=&pageSize=` | Listado paginado (máx. 200 por página) |
| GET | `/api/reports/attentions?…&format=csv` | Exportación CSV |
| GET | `/api/reports/summary?…` | Totales y desgloses |
| GET | `/api/reports/options` | Valores para los selectores: taquillas, funcionarios, motivos, Direcciones y sedes |

**Parámetros de filtro:**

| Tipo | Parámetros |
|---|---|
| Fecha y hora | `from`, `to` (YYYY-MM-DD, día de atención), `year`, `month`, `day`, `dayOfWeek` (1–7), `hour` (0–23) |
| Taquilla y funcionario | `deskId`, `deskNumber`, `operatorId` |
| Trámite | `dependencyId`, `reasonId`, `department` |
| Estado | `status`, `resolutionStatus`, `type` (`WALK_IN`/`SCHEDULED`), `preferential` (`true`/`false`) |
| Ciudadano | `idOrigin`, `idNumber`, `name` |
| Alcance | `branchId` (sólo ADMIN) |

Ejemplo: atenciones remitidas por la Taquilla N° 3 en octubre de 2026:

```
GET /api/reports/attentions?year=2026&month=10&deskNumber=3&resolutionStatus=REMITIDO
```

---

## 10. Arquitectura

```
turnoflow/
├── brand.config.js                       # Configuración institucional
├── prisma/
│   ├── schema.prisma
│   ├── migrations/                       # init + ministerio_atencion_ciudadano
│   └── seed.ts                           # Sedes, motivos por Dirección, taquillas, funcionarios
├── scripts/concurrency-test.ts
├── src/
│   ├── server.ts · app.ts
│   ├── config/   env.ts (Zod) · brand.ts
│   ├── lib/      cedula.ts (validación/formato/máscara) · time.ts (día de negocio, desglose temporal)
│   ├── middleware/  auth.ts (JWT + roles) · validate.ts · error.ts
│   ├── sockets/index.ts                  # ticket:called · queue:updated · ticket:updated
│   └── modules/
│       ├── citizens/   citizen-lookup.service.ts ★ · citizen-providers.ts (mock / http / propio)
│       ├── tickets/    tickets.service.ts (emisión, citas, check-in) · queue.service.ts · ticket.dto.ts
│       ├── operator/   dispatcher.service.ts ★ (llamar siguiente, cierre con resolución)
│       ├── reports/    reports.service.ts · reports.routes.ts ★
│       ├── admin/      motivos (CRUD) · taquillas · usuarios · sedes
│       ├── public/     tótem, consulta de cédula, citas, seguimiento, TV
│       └── auth/
└── public/
    ├── totem.html · operator.html · display.html · consultas.html · index.html
    ├── css/app.css
    └── js/  citizen-form.js (cédula + autocompletado + teclado) · labels.js · totem.js
             operator.js · display.js · consultas.js · sound.js · api.js · brand.js
```

### Ciclo de vida de una atención

```
 Tótem (cédula + motivo) ─► WAITING ──Llamar siguiente──► CALLED ──Iniciar──► IN_SERVICE ──Finalizar + resolución──► ATTENDED
 Cita web ─(check-in)──────►   ▲          (TV: "Cédula … pase a Taquilla N° X")  │    RESUELTO · EN_TRAMITE · REMITIDO
                               │                                                  │    NO_PROCEDE · PENDIENTE_RECAUDOS
                               └──────────── Devolver a la cola ──────────────────┤
                                                                     Ausente ──────┴──► ABSENT
 Cancelar (ciudadano / supervisor) ──► CANCELLED
```

### Seguridad

- **Credenciales y roles:** bcrypt (cost 12), JWT y roles `ADMIN`, `SUPERVISOR`, `OPERATOR` verificados en cada ruta. Supervisores y funcionarios quedan limitados a su sede.
- **Validación:** Zod valida body, query, params y entorno; los `CHECK` de PostgreSQL refuerzan las reglas de negocio.
- **Cabeceras y límites:** Helmet con CSP estricta (sin scripts inline) y límite de pedidos en login, emisión y consulta de cédula.
- **Datos personales:** la TV no recibe nombres y la cédula puede ir enmascarada. El CSV exportado está protegido contra inyección de fórmulas.

---

## 11. Concurrencia: cómo funciona "Llamar siguiente"

Implementación: [`src/modules/operator/dispatcher.service.ts`](src/modules/operator/dispatcher.service.ts)

```sql
BEGIN;
SELECT … FROM desks WHERE id = $taquilla FOR UPDATE;           -- serializa clics de la MISMA taquilla
SELECT t.id FROM tickets t
 WHERE t.branch_id = $sede AND t.status = 'WAITING' AND t.service_date = $hoy
   AND (t.type = 'WALK_IN' OR t.checked_in_at IS NOT NULL)
   AND (<el motivo es atendido por esta taquilla>)
 ORDER BY t.priority_level DESC, t.created_at ASC
 LIMIT 1
 FOR UPDATE SKIP LOCKED;                                        -- las demás taquillas saltean esta fila
UPDATE tickets SET status='CALLED', desk_id, desk_number, operator_id, operator_name, called_at, wait_seconds …;
COMMIT;                                                         -- recién ahora: emit 'ticket:called'
```

- `SKIP LOCKED` permite que N taquillas llamen en el mismo milisegundo sin recibir nunca el mismo ciudadano y sin bloquearse entre sí.
- El índice único parcial `uq_tickets_desk_active` es la red de seguridad en la base de datos.
- Las demás transiciones usan `UPDATE … WHERE status IN (…)`: si dos acciones compiten, una gana y la otra recibe `409`.
- **Numeración atómica:** `INSERT … ON CONFLICT (branch_id, prefix, service_date) DO UPDATE SET last_number = last_number + 1 RETURNING`.
- **Un turno activo por ciudadano:** `pg_advisory_xact_lock` por cédula evita duplicados ante dobles toques en el tótem.
- **Citas:** un lock por motivo, fecha y hora impide superar la capacidad de la franja (la cantidad de taquillas que atienden ese motivo).

---

## 12. Referencia de la API y eventos en tiempo real

### Rutas públicas (sin autenticación)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/brand` · `/brand.css` | Configuración institucional y tokens CSS |
| GET | `/api/public/branches` · `/api/public/branches/:code` | Sedes y motivos activos |
| GET | `/api/public/branches/:id/queue` | Snapshot de la cola, para la TV |
| GET | `/api/public/citizens/lookup?idOrigin&idNumber` | Autocompletado del nombre: `{ found, fullName, source, masked }` |
| POST | `/api/public/tickets` | `{ branchId, dependencyId, reasonId, idOrigin, idNumber, citizenName, preferentialType? }`. `dependencyId` es obligatorio si la sede tiene dependencias. |
| GET | `/api/public/tickets/:id` | Estado, posición y espera estimada |
| POST | `/api/public/tickets/:id/cancel` | El ciudadano cancela su turno |
| GET | `/api/public/appointments/availability?branchId&dependencyId&reasonId&date` | Franjas libres (capacidad = taquillas que atienden esa dependencia y trámite) |
| POST | `/api/public/appointments` | `{ branchId, dependencyId, reasonId, date, time, idOrigin, idNumber, citizenName, preferentialType? }` |
| POST | `/api/public/appointments/check-in` | `{ branchId, idOrigin, idNumber }` |

### Autenticación

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/api/auth/login` | `{ email, password }` → `{ token, user }` |
| GET | `/api/auth/me` | Usuario actual y taquilla ocupada |

### Taquilla (`Authorization: Bearer <token>`)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/operator/desks` | Taquillas de la sede |
| GET | `/api/operator/departments` | Dependencias, para "Remitido a" |
| POST | `/api/operator/desks/:id/claim` · `/release` | Tomar o liberar la taquilla |
| GET | `/api/operator/desks/:id/state` | Atención en curso y atendidos hoy |
| POST | `/api/operator/desks/:id/call-next` | ★ Llamar siguiente: `200` con el ticket, o `204` si no hay nadie |
| POST | `/api/operator/tickets/:id/start` · `/absent` · `/recall` · `/requeue` | Ciclo de vida |
| POST | `/api/operator/tickets/:id/finish` | ★ `{ resolutionStatus, resolutionNotes, destinationDepartment? }` |

### Administración y supervisión

| Método | Ruta | Rol |
|---|---|---|
| GET/POST/PATCH/DELETE | `/api/admin/reasons` | ADMIN, SUPERVISOR (su sede) |
| GET/POST/PATCH | `/api/admin/branches` · `/desks` · `/users` | ADMIN (los GET de sedes y taquillas también SUPERVISOR) |
| POST | `/api/admin/tickets/:id/cancel` | SUPERVISOR+ |
| GET | `/api/reports/*` | SUPERVISOR+ (ver [sección 9](#9-reportería)) |
| GET | `/health` | Healthcheck |

### Socket.io

| Dirección | Evento | Payload |
|---|---|---|
| cliente → servidor | `branch:join` | `{ branchId }`, con ack `{ ok, snapshot }` |
| cliente → servidor | `ticket:watch` | `{ ticketId }` (seguimiento desde el celular) |
| servidor → cliente | **`ticket:called`** | `{ ticket, isRecall }`, donde `ticket` incluye `citizen.display` (cédula formateada o enmascarada), `desk.number` y `reason`. **Sin nombre.** |
| servidor → cliente | **`queue:updated`** | Espera por motivo, preferenciales, taquillas abiertas, últimos llamados y totales |
| servidor → cliente | `ticket:updated` | Cambio de estado de un turno |
