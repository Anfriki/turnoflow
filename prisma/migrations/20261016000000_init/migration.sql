-- ═════════════════════════════════════════════════════════════
--  TurnoFlow — Migración inicial (PostgreSQL 13+; recomendado 15+)
--  Parte 1: generada desde schema.prisma
--  Parte 2 (al final): restricciones que Prisma no puede expresar
-- ═════════════════════════════════════════════════════════════

-- CreateSchema

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'SUPERVISOR', 'OPERATOR');

-- CreateEnum
CREATE TYPE "TicketType" AS ENUM ('WALK_IN', 'SCHEDULED');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('WAITING', 'CALLED', 'IN_SERVICE', 'ATTENDED', 'ABSENT', 'CANCELLED');

-- CreateTable
CREATE TABLE "branches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(120) NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "address" VARCHAR(255),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "branches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_categories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "branch_id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "prefix_letter" VARCHAR(3) NOT NULL,
    "priority_level" INTEGER NOT NULL DEFAULT 0,
    "estimated_duration_min" INTEGER NOT NULL DEFAULT 10,
    "allow_appointments" BOOLEAN NOT NULL DEFAULT true,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "desks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "branch_id" UUID NOT NULL,
    "identifier" VARCHAR(40) NOT NULL,
    "current_operator_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "desks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "desk_categories" (
    "desk_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,

    CONSTRAINT "desk_categories_pkey" PRIMARY KEY ("desk_id","category_id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(120) NOT NULL,
    "email" VARCHAR(160) NOT NULL,
    "password_hash" VARCHAR(100) NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'OPERATOR',
    "branch_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tickets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "branch_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "desk_id" UUID,
    "operator_id" UUID,
    "ticket_number" INTEGER NOT NULL,
    "code" VARCHAR(12) NOT NULL,
    "customer_identifier" VARCHAR(80),
    "type" "TicketType" NOT NULL DEFAULT 'WALK_IN',
    "scheduled_at" TIMESTAMPTZ(6),
    "status" "TicketStatus" NOT NULL DEFAULT 'WAITING',
    "priority_level" INTEGER NOT NULL DEFAULT 0,
    "service_date" DATE NOT NULL,
    "recall_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checked_in_at" TIMESTAMPTZ(6),
    "called_at" TIMESTAMPTZ(6),
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_counters" (
    "category_id" UUID NOT NULL,
    "service_date" DATE NOT NULL,
    "last_number" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "daily_counters_pkey" PRIMARY KEY ("category_id","service_date")
);

-- CreateIndex
CREATE UNIQUE INDEX "branches_code_key" ON "branches"("code");

-- CreateIndex
CREATE INDEX "service_categories_branch_id_idx" ON "service_categories"("branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "service_categories_branch_id_prefix_letter_key" ON "service_categories"("branch_id", "prefix_letter");

-- CreateIndex
CREATE UNIQUE INDEX "desks_current_operator_id_key" ON "desks"("current_operator_id");

-- CreateIndex
CREATE UNIQUE INDEX "desks_branch_id_identifier_key" ON "desks"("branch_id", "identifier");

-- CreateIndex
CREATE INDEX "desk_categories_category_id_idx" ON "desk_categories"("category_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "idx_tickets_dispatch" ON "tickets"("branch_id", "status", "priority_level" DESC, "created_at" ASC);

-- CreateIndex
CREATE INDEX "idx_tickets_branch_day" ON "tickets"("branch_id", "service_date");

-- CreateIndex
CREATE INDEX "idx_tickets_desk_status" ON "tickets"("desk_id", "status");

-- CreateIndex
CREATE INDEX "idx_tickets_customer_day" ON "tickets"("customer_identifier", "service_date");

-- CreateIndex
CREATE UNIQUE INDEX "uq_tickets_daily_code" ON "tickets"("branch_id", "category_id", "code", "service_date");

-- AddForeignKey
ALTER TABLE "service_categories" ADD CONSTRAINT "service_categories_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "desks" ADD CONSTRAINT "desks_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "desks" ADD CONSTRAINT "desks_current_operator_id_fkey" FOREIGN KEY ("current_operator_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "desk_categories" ADD CONSTRAINT "desk_categories_desk_id_fkey" FOREIGN KEY ("desk_id") REFERENCES "desks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "desk_categories" ADD CONSTRAINT "desk_categories_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "service_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "service_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_desk_id_fkey" FOREIGN KEY ("desk_id") REFERENCES "desks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_counters" ADD CONSTRAINT "daily_counters_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "service_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ═════════════════════════════════════════════════════════════
--  Parte 2 — Restricciones avanzadas (mantener a mano)
-- ═════════════════════════════════════════════════════════════

-- Red de seguridad del despacho: un box no puede tener dos turnos activos a la vez.
CREATE UNIQUE INDEX "uq_tickets_desk_active"
  ON "tickets" ("desk_id")
  WHERE "status" IN ('CALLED', 'IN_SERVICE');

-- Índice parcial de la cola viva: sólo indexa los turnos en espera (mucho más chico
-- que idx_tickets_dispatch a medida que crece el histórico).
CREATE INDEX "idx_tickets_waiting"
  ON "tickets" ("branch_id", "service_date", "priority_level" DESC, "created_at" ASC)
  WHERE "status" = 'WAITING';

-- Integridad de datos
ALTER TABLE "tickets"
  ADD CONSTRAINT "ck_tickets_scheduled_at"
    CHECK ("type" <> 'SCHEDULED' OR "scheduled_at" IS NOT NULL),
  ADD CONSTRAINT "ck_tickets_number_positive"
    CHECK ("ticket_number" > 0),
  ADD CONSTRAINT "ck_tickets_called_has_desk"
    CHECK ("status" NOT IN ('CALLED', 'IN_SERVICE') OR "desk_id" IS NOT NULL);

ALTER TABLE "service_categories"
  ADD CONSTRAINT "ck_categories_prefix"
    CHECK ("prefix_letter" ~ '^[A-Z]{1,3}$'),
  ADD CONSTRAINT "ck_categories_duration"
    CHECK ("estimated_duration_min" > 0);

ALTER TABLE "daily_counters"
  ADD CONSTRAINT "ck_counters_positive" CHECK ("last_number" >= 0);
