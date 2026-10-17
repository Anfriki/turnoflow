-- ═════════════════════════════════════════════════════════════
--  TurnoFlow — Dependencias de atención (bifurcación del tótem)
--
--  · dependencies        Zona Educativa (ZE), Atención al Ciudadano (OAC)…
--                        con su prefijo de turno (ZE-001, OAC-001)
--  · desk_dependencies   qué dependencias atiende cada taquilla
--                        (sin filas = todas)
--  · tickets             + dependency_id (null en turnos anteriores)
--  · attention_reasons   + sort_order (orden de Direcciones y trámites)
--
--  Migración puramente aditiva: no modifica datos existentes.
-- ═════════════════════════════════════════════════════════════

-- AlterTable
ALTER TABLE "attention_reasons" ADD COLUMN     "sort_order" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "tickets" ADD COLUMN     "dependency_id" UUID;

-- CreateTable
CREATE TABLE "dependencies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "branch_id" UUID NOT NULL,
    "code" VARCHAR(10) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" TEXT,
    "icon" VARCHAR(8),
    "prefix" VARCHAR(3) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dependencies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "desk_dependencies" (
    "desk_id" UUID NOT NULL,
    "dependency_id" UUID NOT NULL,

    CONSTRAINT "desk_dependencies_pkey" PRIMARY KEY ("desk_id","dependency_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "dependencies_branch_id_code_key" ON "dependencies"("branch_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "dependencies_branch_id_prefix_key" ON "dependencies"("branch_id", "prefix");

-- CreateIndex
CREATE INDEX "desk_dependencies_dependency_id_idx" ON "desk_dependencies"("dependency_id");

-- CreateIndex
CREATE INDEX "idx_tickets_dependency_day" ON "tickets"("dependency_id", "service_date");

-- AddForeignKey
ALTER TABLE "dependencies" ADD CONSTRAINT "dependencies_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "desk_dependencies" ADD CONSTRAINT "desk_dependencies_desk_id_fkey" FOREIGN KEY ("desk_id") REFERENCES "desks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "desk_dependencies" ADD CONSTRAINT "desk_dependencies_dependency_id_fkey" FOREIGN KEY ("dependency_id") REFERENCES "dependencies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_dependency_id_fkey" FOREIGN KEY ("dependency_id") REFERENCES "dependencies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── Reglas de integridad ─────────────────────────────────────
ALTER TABLE "dependencies"
  ADD CONSTRAINT "ck_dependencies_prefix" CHECK ("prefix" ~ '^[A-Z]{1,3}$'),
  ADD CONSTRAINT "ck_dependencies_code" CHECK ("code" ~ '^[A-Z0-9][A-Z0-9_-]{0,9}$');
