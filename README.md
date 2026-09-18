# 🎓 Sistema de Control de Asistencia Universitaria

Aplicación integral para la toma y gestión de asistencia de alumnos universitarios con **tecnología de QR de uso único instantáneo (Anti-WhatsApp)**, portal móvil para alumnos, panel de control docente protegido por contraseña y exportación de planillas a Excel (`.xlsx`).

---

## 🚀 ¿Cómo iniciar la aplicación? (Para el día a día)

1. Abre la carpeta del proyecto en tu computadora (`Asistencia-frontend`).
2. Haz **doble clic en el archivo `iniciar.bat`**.
3. Se abrirá automáticamente tu navegador en: `http://localhost:3000`.
4. Cuando termines la clase, simplemente cierra la ventana negra. Todos los datos quedan guardados de forma permanente en tu equipo (`asistencia.db`).

---

## 🛡️ Seguridad Anti-WhatsApp (QR de Uso Único)

- **Un solo uso por código:** Cada vez que un alumno escanea el código proyectado y se le registra el presente, ese código se **quema e invalida inmediatamente**.
- **Regeneración instantánea:** El proyector actualiza la pantalla al instante mostrando un nuevo código QR para el siguiente alumno.
- **Protección total:** Si un alumno le saca una foto al proyector y se la envía a un compañero ausente por WhatsApp, cuando el compañero intente usarla el sistema la rechazará: *"⚠️ Este código QR ya fue utilizado por otro compañero"*.
- **Rotación por tiempo:** Si nadie escanea durante 60 segundos, el código también rota automáticamente.

---

## 👥 Los Dos Modos del Sistema

### 1. 📱 Portal del Alumno (Desde el celular)
- El alumno ingresa su **DNI o Legajo Universitario**.
- La aplicación valida su inscripción y activa la **cámara del celular**.
- El alumno apunta hacia la pantalla del proyector en el aula y escanea el QR.
- Recibe la confirmación en pantalla: *"¡Presente Registrado! (Nombre, DNI y Hora)"*.

### 2. 👨‍🏫 Panel del Docente (Acceso con Contraseña)
- **Contraseña por defecto:** `profesor2026` (se accede desde el botón *"🔐 Acceso Docente"* en la esquina superior derecha).
- **Proyector QR Dinámico:**
  - Elige la materia y presiona *"▶️ Iniciar Proyector QR"*.
  - Muestra el código QR gigante con barra de tiempo regresiva y botón de pantalla completa.
  - Feed en vivo que lista a los alumnos que van ingresando en tiempo real.
  - Botón para pausar o finalizar la toma de lista en cualquier momento.
- **Nómina y Asistencia Manual:**
  - Permite revisar los presentes del día y cambiar manualmente el estado de cualquier estudiante (`[P]` Presente, `[T]` Tarde, `[A]` Ausente).
- **Gestión de Cursos y Alumnos:**
  - Crear materias, comisiones y cargar alumnos (individualmente o pegando listas completas de Excel con la *Carga Masiva*).
- **Reportes y Planilla Excel:**
  - Selecciona un rango de fechas ("Desde / Hasta"), previsualiza la matriz de asistencias y descarga el archivo oficial `.xlsx` con un solo clic.

---

## 🛠️ Tecnologías Utilizadas

- **Frontend:** HTML5, CSS3 responsivo y JavaScript moderno (SPA) con `html5-qrcode` y *Server-Sent Events (SSE)*.
- **Backend:** Node.js con Express.js y API REST.
- **Base de Datos:** SQLite (`asistencia.db`), relacional, local y segura.
- **Exportador:** Librería `exceljs` para generación de planillas `.xlsx` con estilos y fórmulas.