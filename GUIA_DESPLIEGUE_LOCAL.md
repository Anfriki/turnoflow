# 📖 Guía Rápida de Despliegue y Prueba Local — TurnoFlow (MPPE)

Esta guía describe paso a paso cómo desplegar, configurar y probar localmente el sistema de turnos de la **Oficina de Atención al Ciudadano** del **Ministerio del Poder Popular para la Educación (MPPE)**.

---

## 1. Requisitos Previos

- **Node.js**: Versión 20 LTS o superior (`node -v`).
- **npm**: Viene con Node.js (`npm -v`).
- **PostgreSQL**: Puede ejecutarse de cualquiera de estas formas:
  - **Opción A:** Con Docker (Docker Compose).
  - **Opción B:** Con Laragon (habilitando el servicio PostgreSQL en el puerto 5432).
  - **Opción C:** PostgreSQL instalado de forma nativa en el sistema.

---

## 2. Preparación y Configuración

### Paso 1: Instalar dependencias
Abre una terminal en la raíz del proyecto y ejecuta:
```bash
npm install
```

### Paso 2: Crear el archivo de entorno `.env`
Copia el archivo base `.env.example`:

- En **Windows (PowerShell)**:
  ```powershell
  Copy-Item .env.example .env
  ```
- En **Linux / macOS / Git Bash**:
  ```bash
  cp .env.example .env
  ```

El archivo `.env` ya viene configurado para desarrollo local:
```env
DATABASE_URL="postgresql://turnos:turnos@localhost:5432/turnos_db?schema=public"
APP_TIMEZONE="America/Caracas"
CITIZEN_LOOKUP_PROVIDER="mock"
```

---

## 3. Base de Datos (Elegir un método)

### Método A: Usando Docker
Si tienes Docker instalado:
```bash
docker compose up -d db
```
Esto levantará un contenedor con PostgreSQL 16 y la base de datos `turnos_db` lista en el puerto `5432`.

---

### Método B: Usando Laragon o PostgreSQL Local
Si utilizas Laragon o PostgreSQL nativo:

1. Inicia PostgreSQL (en Laragon: *Menu → PostgreSQL → Iniciar*).
2. Abre la consola de PostgreSQL (`psql -U postgres`) y crea el usuario y la base:
   ```sql
   CREATE USER turnos WITH PASSWORD 'turnos' SUPERUSER;
   CREATE DATABASE turnos_db OWNER turnos;
   ```

---

## 4. Migraciones y Carga de Trámites del MPPE

Ejecuta las migraciones y la carga inicial (seed):

```bash
npm run db:migrate
npm run db:seed
```

Esto ejecutará las 3 migraciones del sistema:
1. `20261016000000_init`: Esquema base (sedes, colas, taquillas, turnos).
2. `20261017000000_ministerio_atencion_ciudadano`: Cédula V/E, desglose temporal y auditoría.
3. `20261018000000_dependencias_atencion`: Dependencias (Zona Educativa y Atención al Ciudadano), orden de trámites y asignación de taquillas.

Y cargará el catálogo del MPPE:
- **2 Dependencias:**
  - 🏢 **Zona Educativa (Caracas / Distrito Capital)** (Prefijo: `ZE-001`)
  - 🏛️ **Atención al Ciudadano (Nacional / Otros Estados)** (Prefijo: `OAC-001`)
- **38 Trámites oficiales** distribuidos en 7 Direcciones:
  - *Ingreso* (13 trámites: clasificación, cuentas bancarias, traslados, primas, etc.)
  - *Egreso / Seguridad Social* (8 trámites: jubilaciones, pensiones, FP023, 14100, 1408, etc.)
  - *Nómina* (3 trámites: estatus, constancias, recibos de pago)
  - *Gremiales* (9 trámites: reconocimientos, reactivaciones, permisos, salarios)
  - *Registro de Personal* (vacaciones)
  - *Asesoría Jurídica* (consultas laborales)
  - *Registro y Control de Estudio* (títulos, notas certificadas, CCRT)
- **12 Taquillas especializadas** en Sede Central.

*(Si deseas borrar y reiniciar toda la base desde cero: `npm run db:reset`).*

---

## 5. Iniciar la Aplicación

Inicia el servidor en modo desarrollo:

```bash
npm run dev
```

El servidor quedará disponible en:
👉 **`http://localhost:3000`**

---

## 6. URLs y Vistas del Sistema

| Vista | URL de Acceso | Descripción y Uso |
|---|---|---|
| **Portal Principal** | [http://localhost:3000](http://localhost:3000) | Accesos directos a todos los módulos. |
| **Tótem de Autoservicio** | [http://localhost:3000/totem.html?branch=SEDE](http://localhost:3000/totem.html?branch=SEDE) | Pantalla táctil en 3 pasos: Cédula (V/E) ➔ Dependencia (Zona Educativa / OAC) ➔ Trámite. |
| **Panel de Taquilla (Operador)** | [http://localhost:3000/operator.html](http://localhost:3000/operator.html) | Panel del funcionario: llama al siguiente turno por prioridad/cola, atiende y registra resolución. |
| **Pantalla de Sala (TV)** | [http://localhost:3000/display.html?branch=SEDE](http://localhost:3000/display.html?branch=SEDE) | Pantalla para la sala de espera que anuncia el llamado por voz y muestra el turno en pantalla. *(Hacer clic en la pantalla una vez para habilitar sonido).* |
| **Consultas y Reportes** | [http://localhost:3000/consultas.html](http://localhost:3000/consultas.html) | Métricas, filtros avanzados por fecha/taquilla/trámite y exportación a Excel / CSV. |

---

## 7. Usuarios y Credenciales de Prueba

Todos los usuarios fueron creados con la clave por defecto:

| Rol | Correo Electrónico | Contraseña | Asignación / Especialidad |
|---|---|---|---|
| **Administrador** | `admin@ministerio.local` | `Admin123!` | Acceso total al sistema y configuración. |
| **Supervisor** | `supervisor@ministerio.local` | `Super123!` | Métricas, reportes, colas en vivo y exportaciones. |
| **Taquillas 1 a 3** | `taquilla1@ministerio.local` … `taquilla3@ministerio.local` | `Taquilla123!` | Zona Educativa Caracas (Nómina, Ingreso, Personal). |
| **Taquillas 4 y 5** | `taquilla4@ministerio.local` … `taquilla5@ministerio.local` | `Taquilla123!` | Zona Educativa Caracas (Gremiales, Asesoría Jurídica). |
| **Taquillas 6 a 8** | `taquilla6@ministerio.local` … `taquilla8@ministerio.local` | `Taquilla123!` | Atención al Ciudadano (Nacional: Ingreso, Nómina, etc.). |
| **Taquillas 9 y 10** | `taquilla9@ministerio.local` … `taquilla10@ministerio.local` | `Taquilla123!` | Egreso / Seguridad Social (Jubilaciones, Pensiones, FP023). |
| **Taquilla 11** | `taquilla11@ministerio.local` | `Taquilla123!` | Registro y Control de Estudio (Títulos, Notas, CCRT). |
| **Taquilla 12** | `taquilla12@ministerio.local` | `Taquilla123!` | Taquilla Polivalente (apoyo a todos los trámites). |
| **Taquilla Regional**| `regional@ministerio.local` | `Taquilla123!` | Taquilla Oficina Regional. |

---

## 8. Cédulas de Prueba (Servicio Simulado)

Para probar la búsqueda automática de nombres en el tótem:

- `V-12345678` ➔ María Alejandra González Pérez
- `V-87654321` ➔ José Gregorio Rodríguez Méndez
- `V-5123456` ➔ Carmen Elena Silva de Ramírez
- `E-84123456` ➔ Giuseppe Antonio Russo Bianchi

*(Cualquier otra cédula será tratada como ciudadano nuevo, permitiendo ingresar el nombre manualmente).*

---

## 9. Flujo Paso a Paso para Probar el Sistema Completo

1. **Abrir la Pantalla de Sala (TV)**:
   - Abre [http://localhost:3000/display.html?branch=SEDE](http://localhost:3000/display.html?branch=SEDE).
   - Haz un clic en cualquier parte de la pantalla para autorizar el audio del navegador.
2. **Abrir el Panel de Operador**:
   - En otra pestaña, abre [http://localhost:3000/operator.html](http://localhost:3000/operator.html).
   - Inicia sesión con `taquilla1@ministerio.local` / `Taquilla123!`.
   - Selecciona **Taquilla N° 1**.
3. **Emitir un Turno desde el Tótem (Flujo MPPE de 3 Pasos)**:
   - En otra pestaña, abre [http://localhost:3000/totem.html?branch=SEDE](http://localhost:3000/totem.html?branch=SEDE).
   - **Paso 1 (Identificación):** Elige `V`, escribe `12345678` y pulsa **Buscar**. Aparecerá el nombre completo.
   - **Paso 2 (Dependencia):** Selecciona **Zona Educativa (Caracas)** o **Atención al Ciudadano (Nacional)**.
   - **Paso 3 (Trámite):** Escoge la Dirección (ej. *Nómina*) y luego el trámite específico (ej. *Constancia de trabajo*).
   - Pulsa **Solicitar turno**. Se generará el ticket (ej. `ZE-001` o `OAC-001`).
4. **Llamar y Atender el Turno**:
   - Vuelve a la pestaña del Operador y pulsa **Llamar siguiente**.
   - Escucharás el llamado por voz en la pantalla de TV y verás el número de turno y taquilla destacados.
   - En el operador, pulsa **Iniciar atención**.
   - Al finalizar, indica el resultado (*Resuelto*, *En trámite*, etc.) y guarda.
5. **Revisar Estadísticas y Tiempos**:
   - Accede a [http://localhost:3000/consultas.html](http://localhost:3000/consultas.html) con `supervisor@ministerio.local` / `Super123!`.
   - Verás el turno registrado con sus tiempos de espera y atención calculados automáticamente.

---

## 10. Prueba de Concurrencia Automatizada

Para verificar la integridad ante múltiples taquillas simultáneas despachando sin colisiones:

```bash
npm run test:concurrency
```
Este test emite turnos en paralelo, simula varias taquillas llamando a máxima velocidad y certifica que ningún turno sea duplicado ni asignado dos veces.
