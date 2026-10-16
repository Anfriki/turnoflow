-- ═════════════════════════════════════════════════════════════
--  TurnoFlow — Adaptación "Atención al Ciudadano" (Ministerio)
--
--  · service_categories  → attention_reasons (motivos administrables)
--  · desk_categories     → desk_reasons
--  · desks               + number (Taquilla N°)
--  · tickets             + cédula (origen/número), nombre del ciudadano,
--                          atención preferencial, instantánea de taquilla
--                          y funcionario, resolución de la petición,
--                          desglose temporal (año/mes/día/hora/día semana)
--                          y duraciones precalculadas
--  · daily_counters      numeración por (sede, prefijo, día)
--  · citizens            cache local de ciudadanos
--
--  Es segura sobre una base con datos: los turnos existentes se
--  completan (backfill) antes de aplicar NOT NULL. Las validaciones
--  de formato se crean NOT VALID: rigen para filas nuevas y no
--  rechazan el histórico.
-- ═════════════════════════════════════════════════════════════

-- ── Enums ────────────────────────────────────────────────────
CREATE TYPE "IdOrigin" AS ENUM ('V', 'E', 'J', 'G');
CREATE TYPE "ResolutionStatus" AS ENUM ('RESUELTO', 'EN_TRAMITE', 'REMITIDO', 'NO_PROCEDE', 'PENDIENTE_RECAUDOS');
CREATE TYPE "PreferentialType" AS ENUM ('TERCERA_EDAD', 'EMBARAZADA', 'DISCAPACIDAD');

-- ── 1. Motivos de atención ───────────────────────────────────
ALTER TABLE "service_categories" RENAME TO "attention_reasons";
ALTER TABLE "attention_reasons" RENAME CONSTRAINT "service_categories_pkey" TO "attention_reasons_pkey";
ALTER TABLE "attention_reasons" RENAME CONSTRAINT "service_categories_branch_id_fkey" TO "attention_reasons_branch_id_fkey";
ALTER TABLE "attention_reasons" RENAME CONSTRAINT "ck_categories_prefix" TO "ck_reasons_prefix";
ALTER TABLE "attention_reasons" RENAME CONSTRAINT "ck_categories_duration" TO "ck_reasons_duration";

-- El prefijo deja de ser único: varios motivos pueden compartir numeración (N-001, N-002…)
DROP INDEX "service_categories_branch_id_prefix_letter_key";
DROP INDEX "service_categories_branch_id_idx";

ALTER TABLE "attention_reasons"
  ALTER COLUMN "name" TYPE VARCHAR(120),
  ADD COLUMN "code"        VARCHAR(20),
  ADD COLUMN "description" TEXT,
  ADD COLUMN "department"  VARCHAR(150),
  ADD COLUMN "updated_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill: el prefijo era único por sede, así que "<prefijo>-01" también lo es
UPDATE "attention_reasons" SET "code" = "prefix_letter" || '-01' WHERE "code" IS NULL;
UPDATE "attention_reasons" SET "department" = 'Sin asignar' WHERE "department" IS NULL;

ALTER TABLE "attention_reasons"
  ALTER COLUMN "code" SET NOT NULL,
  ALTER COLUMN "department" SET NOT NULL,
  ADD CONSTRAINT "ck_reasons_code" CHECK ("code" ~ '^[A-Z0-9][A-Z0-9_-]{1,19}$');

CREATE UNIQUE INDEX "attention_reasons_branch_id_code_key" ON "attention_reasons"("branch_id", "code");
CREATE INDEX "attention_reasons_branch_id_is_active_idx" ON "attention_reasons"("branch_id", "is_active");

-- ── 2. Taquillas ↔ motivos ───────────────────────────────────
ALTER TABLE "desk_categories" RENAME TO "desk_reasons";
ALTER TABLE "desk_reasons" RENAME COLUMN "category_id" TO "reason_id";
ALTER TABLE "desk_reasons" RENAME CONSTRAINT "desk_categories_pkey" TO "desk_reasons_pkey";
ALTER TABLE "desk_reasons" RENAME CONSTRAINT "desk_categories_desk_id_fkey" TO "desk_reasons_desk_id_fkey";
ALTER TABLE "desk_reasons" RENAME CONSTRAINT "desk_categories_category_id_fkey" TO "desk_reasons_reason_id_fkey";
ALTER INDEX "desk_categories_category_id_idx" RENAME TO "desk_reasons_reason_id_idx";

-- ── 3. Taquillas: número ─────────────────────────────────────
ALTER TABLE "desks" ADD COLUMN "number" INTEGER;
UPDATE "desks" d
   SET "number" = s.rn
  FROM (SELECT "id", row_number() OVER (PARTITION BY "branch_id" ORDER BY "identifier") AS rn FROM "desks") s
 WHERE s."id" = d."id";
ALTER TABLE "desks"
  ALTER COLUMN "number" SET NOT NULL,
  ADD CONSTRAINT "ck_desks_number" CHECK ("number" > 0);
CREATE UNIQUE INDEX "desks_branch_id_number_key" ON "desks"("branch_id", "number");

-- ── 4. Turnos / atenciones ───────────────────────────────────
ALTER TABLE "tickets" RENAME COLUMN "category_id" TO "reason_id";
ALTER TABLE "tickets" RENAME CONSTRAINT "tickets_category_id_fkey" TO "tickets_reason_id_fkey";

ALTER TABLE "tickets"
  ADD COLUMN "id_origin"              "IdOrigin",
  ADD COLUMN "id_number"              VARCHAR(12),
  ADD COLUMN "citizen_name"           VARCHAR(150),
  ADD COLUMN "preferential_type"      "PreferentialType",
  ADD COLUMN "desk_number"            INTEGER,
  ADD COLUMN "operator_name"          VARCHAR(120),
  ADD COLUMN "resolution_status"      "ResolutionStatus",
  ADD COLUMN "resolution_notes"       TEXT,
  ADD COLUMN "destination_department" VARCHAR(150),
  ADD COLUMN "year"                   INTEGER,
  ADD COLUMN "month"                  INTEGER,
  ADD COLUMN "day"                    INTEGER,
  ADD COLUMN "hour"                   INTEGER,
  ADD COLUMN "day_of_week"            INTEGER,
  ADD COLUMN "wait_seconds"           INTEGER,
  ADD COLUMN "service_seconds"        INTEGER;

-- Backfill del histórico ------------------------------------------------
-- Ciudadano: se rescatan los dígitos del identificador genérico anterior.
UPDATE "tickets"
   SET "id_origin"    = 'V',
       "id_number"    = COALESCE(NULLIF(regexp_replace(COALESCE("customer_identifier", ''), '\D', '', 'g'), ''), '0'),
       "citizen_name" = COALESCE(NULLIF("customer_identifier", ''), '(sin registro)')
 WHERE "id_origin" IS NULL;

-- Desglose temporal. Para el HISTÓRICO se usa America/Caracas; los turnos
-- nuevos los calcula la aplicación con APP_TIMEZONE.
UPDATE "tickets" t
   SET "year"        = EXTRACT(YEAR    FROM x.local)::int,
       "month"       = EXTRACT(MONTH   FROM x.local)::int,
       "day"         = EXTRACT(DAY     FROM x.local)::int,
       "hour"        = EXTRACT(HOUR    FROM x.local)::int,
       "day_of_week" = EXTRACT(ISODOW  FROM x.local)::int
  FROM (SELECT "id", COALESCE("scheduled_at", "created_at") AT TIME ZONE 'America/Caracas' AS local FROM "tickets") x
 WHERE x."id" = t."id";

-- Instantánea de taquilla y funcionario
UPDATE "tickets" t SET "desk_number" = d."number" FROM "desks" d WHERE d."id" = t."desk_id";
UPDATE "tickets" t SET "operator_name" = u."name" FROM "users" u WHERE u."id" = t."operator_id";

-- Duraciones
UPDATE "tickets"
   SET "wait_seconds" = GREATEST(0, EXTRACT(EPOCH FROM "called_at" - COALESCE("checked_in_at", "created_at")))::int
 WHERE "called_at" IS NOT NULL;
UPDATE "tickets"
   SET "service_seconds" = GREATEST(0, EXTRACT(EPOCH FROM "finished_at" - "started_at"))::int
 WHERE "status" = 'ATTENDED' AND "started_at" IS NOT NULL AND "finished_at" IS NOT NULL;

-- Atenciones ya finalizadas antes de existir el campo de resolución
UPDATE "tickets"
   SET "resolution_status" = 'RESUELTO',
       "resolution_notes"  = 'Atención registrada antes de la migración (sin resolución detallada).'
 WHERE "status" = 'ATTENDED' AND "resolution_status" IS NULL;

ALTER TABLE "tickets"
  ALTER COLUMN "id_origin"    SET NOT NULL,
  ALTER COLUMN "id_number"    SET NOT NULL,
  ALTER COLUMN "citizen_name" SET NOT NULL,
  ALTER COLUMN "year"         SET NOT NULL,
  ALTER COLUMN "month"        SET NOT NULL,
  ALTER COLUMN "day"          SET NOT NULL,
  ALTER COLUMN "hour"         SET NOT NULL,
  ALTER COLUMN "day_of_week"  SET NOT NULL;

-- Reemplazo del identificador genérico
DROP INDEX "idx_tickets_customer_day";
ALTER TABLE "tickets" DROP COLUMN "customer_identifier";

-- La numeración ahora es por (sede, prefijo, día): el código es único por sede y día
DROP INDEX "uq_tickets_daily_code";
CREATE UNIQUE INDEX "uq_tickets_daily_code" ON "tickets"("branch_id", "code", "service_date");

-- Índices de consulta y reportería
CREATE INDEX "idx_tickets_citizen"      ON "tickets"("id_origin", "id_number", "service_date");
CREATE INDEX "idx_tickets_report_date"  ON "tickets"("branch_id", "year", "month", "day");
CREATE INDEX "idx_tickets_reason_day"   ON "tickets"("reason_id", "service_date");
CREATE INDEX "idx_tickets_operator_day" ON "tickets"("operator_id", "service_date");
CREATE INDEX "idx_tickets_resolution"   ON "tickets"("branch_id", "resolution_status");

-- Reglas de integridad
ALTER TABLE "tickets"
  ADD CONSTRAINT "ck_tickets_temporal" CHECK (
        "month" BETWEEN 1 AND 12
    AND "day" BETWEEN 1 AND 31
    AND "hour" BETWEEN 0 AND 23
    AND "day_of_week" BETWEEN 1 AND 7),
  ADD CONSTRAINT "ck_tickets_referral_destination" CHECK (
    "resolution_status" IS DISTINCT FROM 'REMITIDO' OR "destination_department" IS NOT NULL),
  ADD CONSTRAINT "ck_tickets_durations" CHECK (
    COALESCE("wait_seconds", 0) >= 0 AND COALESCE("service_seconds", 0) >= 0);

-- Sólo para filas nuevas (el histórico puede tener identificadores no numéricos)
ALTER TABLE "tickets"
  ADD CONSTRAINT "ck_tickets_id_number" CHECK ("id_number" ~ '^[0-9]{4,10}$') NOT VALID,
  ADD CONSTRAINT "ck_tickets_attended_resolution" CHECK (
    "status" <> 'ATTENDED' OR "resolution_status" IS NOT NULL) NOT VALID;

-- ── 5. Correlativos diarios por (sede, prefijo, día) ─────────
DROP TABLE "daily_counters";

CREATE TABLE "daily_counters" (
    "branch_id"    UUID NOT NULL,
    "prefix"       VARCHAR(3) NOT NULL,
    "service_date" DATE NOT NULL,
    "last_number"  INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "daily_counters_pkey" PRIMARY KEY ("branch_id", "prefix", "service_date"),
    CONSTRAINT "ck_counters_positive" CHECK ("last_number" >= 0)
);
ALTER TABLE "daily_counters" ADD CONSTRAINT "daily_counters_branch_id_fkey"
  FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Reconstruye los contadores desde los turnos existentes (continúa la numeración del día)
INSERT INTO "daily_counters" ("branch_id", "prefix", "service_date", "last_number")
SELECT "branch_id", split_part("code", '-', 1), "service_date", MAX("ticket_number")
  FROM "tickets"
 GROUP BY 1, 2, 3;

-- ── 6. Cache local de ciudadanos ─────────────────────────────
CREATE TABLE "citizens" (
    "id_origin"     "IdOrigin" NOT NULL,
    "id_number"     VARCHAR(12) NOT NULL,
    "full_name"     VARCHAR(150) NOT NULL,
    "source"        VARCHAR(20) NOT NULL DEFAULT 'LOCAL',
    "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_visit_at" TIMESTAMPTZ(6),

    CONSTRAINT "citizens_pkey" PRIMARY KEY ("id_origin", "id_number"),
    CONSTRAINT "ck_citizens_id_number" CHECK ("id_number" ~ '^[0-9]{4,10}$')
);
