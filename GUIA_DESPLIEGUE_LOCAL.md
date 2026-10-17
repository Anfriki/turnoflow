# 📖 Guía Rápida de Despliegue y Prueba Local — TurnoFlow

Esta guía está diseñada paso a paso para que cualquier persona técnica o no técnica pueda levantar **TurnoFlow** en su computadora y probar todo el flujo de atención al ciudadano.

---

## 1. Requisitos Previos

- **Node.js**: Versión 20 LTS o superior (puedes verificar con `node -v`).
- **npm**: Viene incluido con Node.js (`npm -v`).
- **PostgreSQL**: Puedes usar cualquiera de estas opciones:
  - **Opción 1:** Docker (con Docker Desktop / Docker Compose).
  - **Opción 2:** Laragon con PostgreSQL habilitado.
  - **Opción 3:** PostgreSQL instalado de forma nativa en el sistema.

---

## 2. Preparación y Configuración

### Paso 1: Instalar dependencias del proyecto
Abre una terminal (PowerShell, Bash o CMD) en la carpeta raíz del proyecto y ejecuta:

```bash
npm install
```

### Paso 2: Crear el archivo de entorno `.env`
Copia el archivo de ejemplo `.env.example`:

- En **Windows (PowerShell)**:
  ```powershell
  Copy-Item .env.example .env
  ```
- En **Linux / macOS / Git Bash**:
  ```bash
  cp .env.example .env
  ```

Los valores por defecto de `.env` ya vienen preconfigurados para funcionar en local con la base de datos `turnos_db`, usuario `turnos` y contraseña `turnos`.

---

## 3. Base de Datos (Elegir un método)

### Método A: Usando Docker (El más rápido y aislado)
Si tienes Docker Desktop instalado:
```bash
docker compose up -d db
```
Esto levantará PostgreSQL 16 en el puerto `5432` con la base de datos `turnos_db` ya creada.

---

### Método B: Usando Laragon o PostgreSQL nativo
Si tienes PostgreSQL instalado en local o mediante Laragon:

1. Inicia el servicio de PostgreSQL.
2. Abre la consola de PostgreSQL (`psql -U postgres`) y ejecuta:
   ```sql
   CREATE USER turnos WITH PASSWORD 'turnos' SUPERUSER;
   CREATE DATABASE turnos_db OWNER turnos;
   ```
3. Verifica que el puerto en `.env` coincida con tu puerto de PostgreSQL (por defecto `5432`):
   ```env
   DATABASE_URL="postgresql://turnos:turnos@localhost:5432/turnos_db?schema=public"
   ```

---

## 4. Inicializar la Base de Datos

Aplica las migraciones y carga los datos de prueba (sedes, taquillas, motivos y usuarios):

```bash
npm run db:migrate
npm run db:seed
```

*(Si en el futuro deseas limpiar y reiniciar todos los datos desde cero, usa `npm run db:reset`).*

---

## 5. Iniciar la Aplicación

Ejecuta el servidor en modo desarrollo con recarga automática:

```bash
npm run dev
```

El servidor quedará escuchando en:
👉 **`http://localhost:3000`**

---

## 6. URLs y Vistas del Sistema

| Vista | URL de Acceso | Descripción y Uso |
|---|---|---|
| **Portal Principal** | [http://localhost:3000](http://localhost:3000) | Menú con accesos directos a todos los módulos. |
| **Tótem de Autoservicio** | [http://localhost:3000/totem.html?branch=SEDE](http://localhost:3000/totem.html?branch=SEDE) | Pantalla táctil donde el ciudadano ingresa su cédula, selecciona el trámite o check-in de cita y obtiene su ticket. |
| **Panel de Taquilla (Operador)** | [http://localhost:3000/operator.html](http://localhost:3000/operator.html) | Panel del funcionario: llama al siguiente turno, atiende y registra el resultado. |
| **Pantalla de Sala (TV)** | [http://localhost:3000/display.html?branch=SEDE](http://localhost:3000/display.html?branch=SEDE) | Pantalla para la sala de espera que muestra turnos llamados con avisos visuales y voz. *(Hacer clic en la pantalla una vez para activar el audio).* |
| **Consultas y Reportes** | [http://localhost:3000/consultas.html](http://localhost:3000/consultas.html) | Métricas, filtros avanzados por fecha/taquilla/trámite y exportación a Excel / CSV. |

---

## 7. Usuarios y Credenciales de Prueba

Todos los usuarios fueron creados automáticamente por el comando `npm run db:seed`:

| Rol | Correo Electrónico | Contraseña | Sede |
|---|---|---|---|
| **Administrador** | `admin@ministerio.local` | `Admin123!` | Todas |
| **Supervisor** | `supervisor@ministerio.local` | `Super123!` | Sede Central (`SEDE`) |
| **Taquilla 1** | `taquilla1@ministerio.local` | `Taquilla123!` | Sede Central (`SEDE`) |
| **Taquilla 2** | `taquilla2@ministerio.local` | `Taquilla123!` | Sede Central (`SEDE`) |
| **Taquilla 3** | `taquilla3@ministerio.local` | `Taquilla123!` | Sede Central (`SEDE`) |
| **Taquilla 4** | `taquilla4@ministerio.local` | `Taquilla123!` | Sede Central (`SEDE`) |
| **Taquilla Regional**| `regional@ministerio.local` | `Taquilla123!` | Oficina Regional (`REGIONAL`) |

---

## 8. Cédulas Simuladas para Pruebas

El sistema cuenta con un proveedor de identidad simulado (`mock`) para probar la búsqueda automática de datos de ciudadanos:

- `V-12345678` ➔ María Alejandra González Pérez
- `V-87654321` ➔ José Gregorio Rodríguez Méndez
- `V-5123456` ➔ Carmen Elena Silva de Ramírez
- `E-84123456` ➔ Giuseppe Antonio Russo Bianchi
- `J-123456789` ➔ Distribuidora Ejemplo C.A.

*(Cualquier otra cédula será tratada como ciudadano nuevo, permitiendo ingresar el nombre manualmente).*

---

## 9. Guía Rápida para Probar el Flujo Completo

Para ver el sistema interactuando en tiempo real:

1. **Abrir la Pantalla de Sala**:
   - Abre [http://localhost:3000/display.html?branch=SEDE](http://localhost:3000/display.html?branch=SEDE) en una pestaña y haz un clic en cualquier parte para permitir el sonido.
2. **Abrir el Panel de Operador**:
   - En otra pestaña o ventana de incógnito, ve a [http://localhost:3000/operator.html](http://localhost:3000/operator.html).
   - Inicia sesión con: `taquilla1@ministerio.local` / `Taquilla123!`.
   - Selecciona la taquilla a ocupar (ej. *Taquilla N° 1*).
3. **Emitir un Turno desde el Tótem**:
   - En otra pestaña, ve a [http://localhost:3000/totem.html?branch=SEDE](http://localhost:3000/totem.html?branch=SEDE).
   - Selecciona el origen (`V`), escribe `12345678` y pulsa **Buscar**. El nombre se completará automáticamente.
   - Elige un motivo de atención (ej. *Constancia de Trabajo*) y pulsa **Solicitar turno**.
   - Se generará un ticket con un código (ej. `OAC-001`).
4. **Llamar y Atender el Turno**:
   - Vuelve a la pestaña del Operador y pulsa **Llamar siguiente**.
   - Observa cómo la Pantalla de Sala se actualiza de inmediato llamando al ciudadano por voz y mostrando su número de taquilla.
   - En el operador, pulsa **Iniciar atención**.
   - Al terminar, selecciona el resultado de la gestión (*Resuelto*, *En trámite*, etc.) y pulsa **Finalizar atención**.
5. **Verificar Métricas y Reportes**:
   - Accede a [http://localhost:3000/consultas.html](http://localhost:3000/consultas.html) con `supervisor@ministerio.local` / `Super123!`.
   - Verás la atención recién registrada con sus tiempos de espera y duración precalculados.

---

## 10. Prueba de Concurrencia Automatizada

Para validar que el sistema soporta múltiples taquillas y emisión masiva concurrente sin duplicar números ni bloquearse:

```bash
npm run test:concurrency
```
Este script genera 40 turnos en paralelo, simula tres taquillas despachando a máxima velocidad y comprueba la integridad de la base de datos.
