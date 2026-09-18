const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const ExcelJS = require('exceljs');
const { db, inicializarBaseDeDatos } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Servir archivos estáticos del frontend desde la carpeta 'public'
app.use(express.static(path.join(__dirname, 'public')));

app.get('/main.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==========================================
// GESTOR DE SESIONES DE QR DINÁMICO (EN MEMORIA)
// ==========================================
// cursoId -> { cursoId, claseId, fecha, tokenActual, creadoEn, expiraEn, timer, sseClientes, ultimosPresentes }
const sesionesActivas = new Map();

async function generarNuevoToken(cursoId, motivo = 'rotacion') {
  const sesion = sesionesActivas.get(parseInt(cursoId));
  if (!sesion) return null;

  // Generar token único de 8 caracteres alfanuméricos
  const nuevoToken = crypto.randomBytes(4).toString('hex').toUpperCase();
  const creadoEn = Date.now();
  const expiraEn = creadoEn + 60000; // 60 segundos

  sesion.tokenActual = nuevoToken;
  sesion.creadoEn = creadoEn;
  sesion.expiraEn = expiraEn;

  // El QR codifica una carga de verificación con prefijo
  const qrTexto = `ASISTENCIA:${cursoId}:${nuevoToken}`;
  const qrDataUrl = await QRCode.toDataURL(qrTexto, {
    width: 380,
    margin: 2,
    color: { dark: '#0f172a', light: '#ffffff' }
  });

  sesion.qrDataUrl = qrDataUrl;

  // Notificar inmediatamente a todas las pantallas de proyector conectadas
  const payload = {
    tipo: 'NUEVO_QR',
    qrDataUrl,
    token: nuevoToken,
    segundosValidez: 60,
    motivo,
    totalPresentes: sesion.ultimosPresentes.length,
    ultimosPresentes: sesion.ultimosPresentes.slice(0, 10)
  };

  const dataStr = `data: ${JSON.stringify(payload)}\n\n`;
  sesion.sseClientes.forEach(client => {
    try { client.write(dataStr); } catch (e) {}
  });

  // Reiniciar el temporizador de 60 segundos
  if (sesion.timer) clearTimeout(sesion.timer);
  sesion.timer = setTimeout(() => {
    generarNuevoToken(cursoId, 'rotacion_60s');
  }, 60000);

  return { qrDataUrl, token: nuevoToken };
}

// ==========================================
// 1. AUTENTICACIÓN DEL DOCENTE
// ==========================================
app.post('/api/auth/login', async (req, res) => {
  try {
    const { password } = req.body;
    const config = await db.getAsync(`SELECT valor FROM configuracion WHERE clave = 'password_docente'`);
    const passwordGuardado = config ? config.valor : 'profesor2026';

    if (password === passwordGuardado) {
      // Token de sesión docente simple
      const tokenDocente = crypto.randomBytes(16).toString('hex');
      res.json({ success: true, token: tokenDocente });
    } else {
      res.status(401).json({ success: false, error: 'Contraseña incorrecta' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/auth/cambiar-password', async (req, res) => {
  try {
    const { actual, nueva } = req.body;
    const config = await db.getAsync(`SELECT valor FROM configuracion WHERE clave = 'password_docente'`);
    const passwordGuardado = config ? config.valor : 'profesor2026';

    if (actual !== passwordGuardado) {
      return res.status(400).json({ success: false, error: 'La contraseña actual no es correcta' });
    }
    if (!nueva || nueva.length < 4) {
      return res.status(400).json({ success: false, error: 'La nueva contraseña debe tener al menos 4 caracteres' });
    }

    await db.runAsync(`UPDATE configuracion SET valor = ? WHERE clave = 'password_docente'`, [nueva]);
    res.json({ success: true, mensaje: 'Contraseña actualizada correctamente' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 2. SESIÓN DE ASISTENCIA Y PROYECTOR QR (DOCENTE)
// ==========================================

// Habilitar la toma de asistencia para un curso en la fecha indicada
app.post('/api/docente/habilitar-sesion', async (req, res) => {
  try {
    const { curso_id, fecha } = req.body;
    if (!curso_id || !fecha) {
      return res.status(400).json({ success: false, error: 'curso_id y fecha son obligatorios' });
    }

    const idCursoNum = parseInt(curso_id);

    // Obtener o crear clase
    let clase = await db.getAsync(`SELECT * FROM clases WHERE curso_id = ? AND fecha = ?`, [idCursoNum, fecha]);
    if (!clase) {
      const resClase = await db.runAsync(`INSERT INTO clases (curso_id, fecha, asistencia_activa) VALUES (?, ?, 1)`, [idCursoNum, fecha]);
      clase = await db.getAsync(`SELECT * FROM clases WHERE id = ?`, [resClase.lastID]);
    } else {
      await db.runAsync(`UPDATE clases SET asistencia_activa = 1 WHERE id = ?`, [clase.id]);
    }

    // Traer alumnos que ya están presentes hoy
    const presentesPrevios = await db.allAsync(`
      SELECT a.nombre_completo, a.legajo_dni, ast.hora_registro AS hora
      FROM asistencias ast
      JOIN alumnos a ON a.id = ast.alumno_id
      WHERE ast.clase_id = ? AND ast.estado = 'PRESENTE'
      ORDER BY ast.id DESC
    `, [clase.id]);

    // Limpiar temporizador previo si existía
    if (sesionesActivas.has(idCursoNum)) {
      const anterior = sesionesActivas.get(idCursoNum);
      if (anterior.timer) clearTimeout(anterior.timer);
    }

    // Inicializar sesión activa
    const nuevaSesion = {
      cursoId: idCursoNum,
      claseId: clase.id,
      fecha,
      tokenActual: '',
      creadoEn: Date.now(),
      expiraEn: Date.now() + 60000,
      timer: null,
      sseClientes: (sesionesActivas.has(idCursoNum) ? sesionesActivas.get(idCursoNum).sseClientes : new Set()),
      ultimosPresentes: presentesPrevios
    };

    sesionesActivas.set(idCursoNum, nuevaSesion);

    // Generar primer QR
    const qrInicial = await generarNuevoToken(idCursoNum, 'inicio_sesion');

    res.json({
      success: true,
      mensaje: 'Toma de asistencia habilitada',
      clase,
      qrDataUrl: qrInicial.qrDataUrl,
      totalPresentes: presentesPrevios.length
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Pausar o finalizar la toma de asistencia
app.post('/api/docente/pausar-sesion', async (req, res) => {
  try {
    const { curso_id } = req.body;
    const idCursoNum = parseInt(curso_id);

    if (sesionesActivas.has(idCursoNum)) {
      const sesion = sesionesActivas.get(idCursoNum);
      if (sesion.timer) clearTimeout(sesion.timer);

      // Notificar a clientes SSE que se pausó
      const payload = { tipo: 'SESION_PAUSADA' };
      sesion.sseClientes.forEach(c => {
        try { c.write(`data: ${JSON.stringify(payload)}\n\n`); } catch(e) {}
      });

      await db.runAsync(`UPDATE clases SET asistencia_activa = 0 WHERE id = ?`, [sesion.claseId]);
      sesionesActivas.delete(idCursoNum);
    }

    res.json({ success: true, mensaje: 'Toma de asistencia pausada' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Canal de eventos en tiempo real para el proyector (Server-Sent Events)
app.get('/api/docente/stream-qr', (req, res) => {
  const { curso_id } = req.query;
  const idCursoNum = parseInt(curso_id);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  if (!sesionesActivas.has(idCursoNum)) {
    res.write(`data: ${JSON.stringify({ tipo: 'NO_ACTIVA' })}\n\n`);
  } else {
    const sesion = sesionesActivas.get(idCursoNum);
    sesion.sseClientes.add(res);

    // Enviar estado actual
    const restantes = Math.max(0, Math.round((sesion.expiraEn - Date.now()) / 1000));
    res.write(`data: ${JSON.stringify({
      tipo: 'NUEVO_QR',
      qrDataUrl: sesion.qrDataUrl,
      token: sesion.tokenActual,
      segundosValidez: restantes,
      totalPresentes: sesion.ultimosPresentes.length,
      ultimosPresentes: sesion.ultimosPresentes.slice(0, 10)
    })}\n\n`);
  }

  req.on('close', () => {
    if (sesionesActivas.has(idCursoNum)) {
      sesionesActivas.get(idCursoNum).sseClientes.delete(res);
    }
  });
});

// ==========================================
// 3. FLUJO DEL ALUMNO (DESDE SU CELULAR)
// ==========================================

// Obtener clases actualmente activas para que el alumno seleccione su curso si hay varios
app.get('/api/alumnos/clases-activas', async (req, res) => {
  try {
    const idsCursosActivos = Array.from(sesionesActivas.keys());
    if (idsCursosActivos.length === 0) {
      return res.json({ success: true, clases: [] });
    }

    const placeholders = idsCursosActivos.map(() => '?').join(',');
    const cursos = await db.allAsync(`
      SELECT id, nombre, comision FROM cursos WHERE id IN (${placeholders})
    `, idsCursosActivos);

    res.json({ success: true, clases: cursos });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Validar que el DNI / Legajo exista en el curso activo
app.post('/api/alumnos/validar-legajo', async (req, res) => {
  try {
    const { legajo_dni, curso_id } = req.body;
    if (!legajo_dni) {
      return res.status(400).json({ success: false, error: 'Ingresa tu DNI o número de legajo' });
    }

    const dniLimpio = legajo_dni.trim();

    // Si se especificó curso, buscar en ese curso; si no, buscar en cualquiera con sesión activa
    let alumno = null;
    let sesionEncontrada = null;

    if (curso_id && sesionesActivas.has(parseInt(curso_id))) {
      const idC = parseInt(curso_id);
      alumno = await db.getAsync(`SELECT * FROM alumnos WHERE curso_id = ? AND legajo_dni = ?`, [idC, dniLimpio]);
      if (alumno) sesionEncontrada = sesionesActivas.get(idC);
    } else {
      // Buscar en los cursos activos
      for (const [idC, sesion] of sesionesActivas.entries()) {
        const al = await db.getAsync(`SELECT * FROM alumnos WHERE curso_id = ? AND legajo_dni = ?`, [idC, dniLimpio]);
        if (al) {
          alumno = al;
          sesionEncontrada = sesion;
          break;
        }
      }
    }

    if (!sesionEncontrada) {
      return res.status(404).json({
        success: false,
        error: 'En este momento no hay ninguna clase habilitada para tu legajo. Aguarda a que el profesor active la lista en el proyector.'
      });
    }

    if (!alumno) {
      return res.status(404).json({
        success: false,
        error: `El legajo/DNI ${dniLimpio} no figura en la lista de alumnos de esta materia.`
      });
    }

    // Verificar si ya tiene presente hoy
    const yaPresente = await db.getAsync(`
      SELECT * FROM asistencias WHERE clase_id = ? AND alumno_id = ? AND estado = 'PRESENTE'
    `, [sesionEncontrada.claseId, alumno.id]);

    if (yaPresente) {
      return res.json({
        success: true,
        yaRegistrado: true,
        mensaje: `Hola ${alumno.nombre_completo}, ya tienes registrado tu Presente para la clase de hoy a las ${yaPresente.hora_registro}.`,
        alumno: { id: alumno.id, nombre_completo: alumno.nombre_completo, legajo_dni: alumno.legajo_dni }
      });
    }

    const curso = await db.getAsync(`SELECT * FROM cursos WHERE id = ?`, [sesionEncontrada.cursoId]);

    res.json({
      success: true,
      yaRegistrado: false,
      alumno: { id: alumno.id, nombre_completo: alumno.nombre_completo, legajo_dni: alumno.legajo_dni },
      curso: { id: curso.id, nombre: curso.nombre, comision: curso.comision }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Registrar la asistencia tras escanear el QR proyectado
app.post('/api/alumnos/registrar-asistencia', async (req, res) => {
  try {
    const { legajo_dni, curso_id, codigo_escaneado } = req.body;
    if (!legajo_dni || !curso_id || !codigo_escaneado) {
      return res.status(400).json({ success: false, error: 'Faltan datos obligatorios para el registro' });
    }

    const idCursoNum = parseInt(curso_id);
    const sesion = sesionesActivas.get(idCursoNum);

    if (!sesion) {
      return res.status(400).json({
        success: false,
        error: 'La toma de asistencia para esta materia ya ha finalizado o está pausada.'
      });
    }

    // 1. Parsear el contenido del QR escaneado
    // Formato esperado: ASISTENCIA:cursoId:TOKEN
    let tokenEscaneado = codigo_escaneado.trim();
    if (tokenEscaneado.startsWith('ASISTENCIA:')) {
      const partes = tokenEscaneado.split(':');
      tokenEscaneado = partes[2] || '';
    }

    // 2. Comprobar si el token ya fue utilizado por otro alumno (Anti-WhatsApp)
    const tokenUsado = await db.getAsync(`SELECT * FROM tokens_usados WHERE token = ?`, [tokenEscaneado]);
    if (tokenUsado) {
      return res.status(403).json({
        success: false,
        error: '⚠️ Este código QR ya fue utilizado por otro compañero. Enfoca el nuevo código que aparece en la pantalla del proyector.'
      });
    }

    // 3. Comprobar si coincide con el token activo actual de la sesión
    if (tokenEscaneado !== sesion.tokenActual) {
      return res.status(400).json({
        success: false,
        error: '⚠️ El código QR ha expirado o no es válido. Enfoca el código vigente en la pantalla del aula.'
      });
    }

    // 4. Buscar al alumno en la base de datos
    const alumno = await db.getAsync(`
      SELECT * FROM alumnos WHERE curso_id = ? AND legajo_dni = ?
    `, [idCursoNum, legajo_dni.trim()]);

    if (!alumno) {
      return res.status(404).json({ success: false, error: 'Alumno no registrado en esta materia.' });
    }

    // 5. Registrar el token en la tabla de tokens usados para QUEMARLO
    await db.runAsync(`
      INSERT INTO tokens_usados (token, curso_id, alumno_id) VALUES (?, ?, ?)
    `, [tokenEscaneado, idCursoNum, alumno.id]);

    // 6. Guardar la asistencia como PRESENTE
    const hora = new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    await db.runAsync(`
      INSERT INTO asistencias (clase_id, alumno_id, estado, hora_registro, metodo)
      VALUES (?, ?, 'PRESENTE', ?, 'QR_ALUMNO')
      ON CONFLICT(clase_id, alumno_id)
      DO UPDATE SET estado = 'PRESENTE', hora_registro = ?, metodo = 'QR_ALUMNO'
    `, [sesion.claseId, alumno.id, hora, hora]);

    // 7. Agregar al historial reciente de la sesión para el proyector
    sesion.ultimosPresentes.unshift({
      nombre_completo: alumno.nombre_completo,
      legajo_dni: alumno.legajo_dni,
      hora
    });

    // 8. ¡PASO CRÍTICO DE SEGURIDAD!: Inmediatamente generar un NUEVO QR en el proyector
    await generarNuevoToken(idCursoNum, 'alumno_escaneo');

    res.json({
      success: true,
      mensaje: '¡Presente registrado exitosamente!',
      alumno: {
        nombre_completo: alumno.nombre_completo,
        legajo_dni: alumno.legajo_dni,
        hora
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 4. ENDPOINTS: GESTIÓN DE CURSOS
// ==========================================
app.get('/api/cursos', async (req, res) => {
  try {
    const cursos = await db.allAsync(`
      SELECT c.*, COUNT(a.id) AS total_alumnos
      FROM cursos c
      LEFT JOIN alumnos a ON a.curso_id = c.id
      GROUP BY c.id
      ORDER BY c.nombre ASC
    `);
    res.json({ success: true, cursos });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/cursos', async (req, res) => {
  try {
    const { nombre, comision, anio } = req.body;
    if (!nombre || !nombre.trim()) {
      return res.status(400).json({ success: false, error: 'El nombre del curso es obligatorio' });
    }
    const result = await db.runAsync(
      `INSERT INTO cursos (nombre, comision, anio) VALUES (?, ?, ?)`,
      [nombre.trim(), comision ? comision.trim() : '', anio ? parseInt(anio) : new Date().getFullYear()]
    );
    const nuevoCurso = await db.getAsync(`SELECT * FROM cursos WHERE id = ?`, [result.lastID]);
    res.json({ success: true, curso: nuevoCurso });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/cursos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await db.runAsync(`DELETE FROM cursos WHERE id = ?`, [id]);
    res.json({ success: true, message: 'Curso eliminado correctamente' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 5. ENDPOINTS: GESTIÓN DE ALUMNOS
// ==========================================
app.get('/api/cursos/:cursoId/alumnos', async (req, res) => {
  try {
    const { cursoId } = req.params;
    const alumnos = await db.allAsync(
      `SELECT * FROM alumnos WHERE curso_id = ? ORDER BY nombre_completo ASC`,
      [cursoId]
    );
    res.json({ success: true, alumnos });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/cursos/:cursoId/alumnos', async (req, res) => {
  try {
    const { cursoId } = req.params;
    const { legajo_dni, nombre_completo, email } = req.body;

    if (!legajo_dni || !nombre_completo) {
      return res.status(400).json({ success: false, error: 'DNI/Legajo y Nombre son obligatorios' });
    }

    const result = await db.runAsync(
      `INSERT INTO alumnos (curso_id, legajo_dni, nombre_completo, email) VALUES (?, ?, ?, ?)`,
      [cursoId, legajo_dni.trim(), nombre_completo.trim(), email ? email.trim() : '']
    );

    const nuevoAlumno = await db.getAsync(`SELECT * FROM alumnos WHERE id = ?`, [result.lastID]);
    res.json({ success: true, alumno: nuevoAlumno });
  } catch (err) {
    if (err.message.includes('UNIQUE constraint')) {
      return res.status(400).json({ success: false, error: 'Ya existe un alumno con ese DNI en este curso' });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/cursos/:cursoId/alumnos/bulk', async (req, res) => {
  try {
    const { cursoId } = req.params;
    const { texto } = req.body;

    if (!texto || !texto.trim()) {
      return res.status(400).json({ success: false, error: 'No se envió texto para importar' });
    }

    const lineas = texto.split(/\r?\n/);
    let importados = 0;

    for (let linea of lineas) {
      linea = linea.trim();
      if (!linea) continue;

      let partes = [];
      if (linea.includes('\t')) partes = linea.split('\t');
      else if (linea.includes(';')) partes = linea.split(';');
      else if (linea.includes(',')) partes = linea.split(',');
      else partes = [linea];

      partes = partes.map(p => p.trim());

      let dni = '';
      let nombre = '';
      let email = '';

      if (partes.length >= 2) {
        if (/^\d+$/.test(partes[0])) {
          dni = partes[0];
          nombre = partes[1];
          email = partes[2] || '';
        } else {
          dni = partes[1];
          nombre = partes[0];
          email = partes[2] || '';
        }
      } else {
        dni = partes[0];
        nombre = partes[0];
      }

      if (dni && nombre) {
        try {
          await db.runAsync(
            `INSERT OR IGNORE INTO alumnos (curso_id, legajo_dni, nombre_completo, email) VALUES (?, ?, ?, ?)`,
            [cursoId, dni, nombre, email]
          );
          importados++;
        } catch (e) {}
      }
    }

    res.json({ success: true, importados });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/alumnos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await db.runAsync(`DELETE FROM alumnos WHERE id = ?`, [id]);
    res.json({ success: true, message: 'Alumno eliminado' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 6. ASISTENCIA MANUAL Y CONSULTA DE CLASE
// ==========================================
app.get('/api/clases/asistencias-dia', async (req, res) => {
  try {
    const { curso_id, fecha } = req.query;
    if (!curso_id || !fecha) {
      return res.status(400).json({ success: false, error: 'curso_id y fecha son obligatorios' });
    }

    let clase = await db.getAsync(`SELECT * FROM clases WHERE curso_id = ? AND fecha = ?`, [curso_id, fecha]);
    if (!clase) {
      const resClase = await db.runAsync(`INSERT INTO clases (curso_id, fecha) VALUES (?, ?)`, [curso_id, fecha]);
      clase = await db.getAsync(`SELECT * FROM clases WHERE id = ?`, [resClase.lastID]);
    }

    const alumnos = await db.allAsync(`
      SELECT 
        a.id AS alumno_id,
        a.legajo_dni,
        a.nombre_completo,
        a.email,
        COALESCE(ast.estado, 'NO_REGISTRADO') AS estado,
        ast.hora_registro,
        ast.metodo,
        ast.id AS asistencia_id
      FROM alumnos a
      LEFT JOIN asistencias ast ON ast.alumno_id = a.id AND ast.clase_id = ?
      WHERE a.curso_id = ?
      ORDER BY a.nombre_completo ASC
    `, [clase.id, curso_id]);

    res.json({ success: true, clase, alumnos });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/asistencias/manual', async (req, res) => {
  try {
    const { curso_id, fecha, alumno_id, estado } = req.body;
    let clase = await db.getAsync(`SELECT * FROM clases WHERE curso_id = ? AND fecha = ?`, [curso_id, fecha]);
    if (!clase) {
      const resClase = await db.runAsync(`INSERT INTO clases (curso_id, fecha) VALUES (?, ?)`, [curso_id, fecha]);
      clase = await db.getAsync(`SELECT * FROM clases WHERE id = ?`, [resClase.lastID]);
    }

    const hora = new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    await db.runAsync(`
      INSERT INTO asistencias (clase_id, alumno_id, estado, hora_registro, metodo)
      VALUES (?, ?, ?, ?, 'MANUAL')
      ON CONFLICT(clase_id, alumno_id) 
      DO UPDATE SET estado = ?, hora_registro = ?, metodo = 'MANUAL'
    `, [clase.id, alumno_id, estado, hora, estado, hora]);

    res.json({ success: true, estado, hora });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 7. REPORTES Y EXPORTACIÓN A EXCEL (.XLSX)
// ==========================================
async function compilarMatrizAsistencia(cursoId, desde, hasta) {
  const curso = await db.getAsync(`SELECT * FROM cursos WHERE id = ?`, [cursoId]);
  if (!curso) throw new Error('Curso no encontrado');

  let queryClases = `SELECT * FROM clases WHERE curso_id = ?`;
  const paramsClases = [cursoId];

  if (desde && hasta) {
    queryClases += ` AND fecha BETWEEN ? AND ? ORDER BY fecha ASC`;
    paramsClases.push(desde, hasta);
  } else if (desde) {
    queryClases += ` AND fecha >= ? ORDER BY fecha ASC`;
    paramsClases.push(desde);
  } else if (hasta) {
    queryClases += ` AND fecha <= ? ORDER BY fecha ASC`;
    paramsClases.push(hasta);
  } else {
    queryClases += ` ORDER BY fecha ASC`;
  }

  const clases = await db.allAsync(queryClases, paramsClases);
  const alumnos = await db.allAsync(`SELECT * FROM alumnos WHERE curso_id = ? ORDER BY nombre_completo ASC`, [cursoId]);

  const asistencias = await db.allAsync(`
    SELECT ast.*, c.fecha
    FROM asistencias ast
    JOIN clases c ON c.id = ast.clase_id
    WHERE c.curso_id = ?
  `, [cursoId]);

  const mapaAsistencias = {};
  for (const a of asistencias) {
    mapaAsistencias[`${a.alumno_id}_${a.clase_id}`] = a.estado;
  }

  const filas = alumnos.map((al, idx) => {
    let presentes = 0;
    let ausentes = 0;
    let tardes = 0;
    const estadosPorClase = {};

    clases.forEach(c => {
      const estado = mapaAsistencias[`${al.id}_${c.id}`] || 'AUSENTE';
      estadosPorClase[c.id] = estado;
      if (estado === 'PRESENTE') presentes++;
      else if (estado === 'TARDE') tardes++;
      else ausentes++;
    });

    const totalClases = clases.length;
    const puntos = presentes + (tardes * 0.5);
    const porcentaje = totalClases > 0 ? Math.round((puntos / totalClases) * 100) : 0;

    return {
      num: idx + 1,
      id: al.id,
      legajo_dni: al.legajo_dni,
      nombre_completo: al.nombre_completo,
      email: al.email || '',
      estadosPorClase,
      presentes,
      tardes,
      ausentes,
      totalClases,
      porcentaje
    };
  });

  return { curso, clases, filas };
}

app.get('/api/reportes/asistencia-datos', async (req, res) => {
  try {
    const { curso_id, desde, hasta } = req.query;
    if (!curso_id) return res.status(400).json({ success: false, error: 'curso_id es obligatorio' });
    const datos = await compilarMatrizAsistencia(curso_id, desde, hasta);
    res.json({ success: true, ...datos });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/reportes/asistencia-excel', async (req, res) => {
  try {
    const { curso_id, desde, hasta } = req.query;
    if (!curso_id) return res.status(400).send('curso_id es obligatorio');

    const { curso, clases, filas } = await compilarMatrizAsistencia(curso_id, desde, hasta);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Sistema de Asistencia Universitaria';
    workbook.created = new Date();

    const worksheet = workbook.addWorksheet('Planilla de Asistencias', {
      views: [{ showGridLines: true }]
    });

    // 1. Título y encabezado
    worksheet.mergeCells('A1:G1');
    const titleCell = worksheet.getCell('A1');
    titleCell.value = 'REGISTRO Y CONTROL DE ASISTENCIA UNIVERSITARIA';
    titleCell.font = { name: 'Calibri', size: 16, bold: true, color: { argb: 'FFFFFFFF' } };
    titleCell.alignment = { vertical: 'middle', horizontal: 'center' };
    titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F172A' } };
    worksheet.getRow(1).height = 35;

    worksheet.getCell('A2').value = `Curso / Materia: ${curso.nombre}`;
    worksheet.getCell('A2').font = { bold: true, size: 11 };
    worksheet.getCell('D2').value = `Comisión: ${curso.comision || 'Única'} | Año: ${curso.anio || new Date().getFullYear()}`;
    worksheet.getCell('D2').font = { bold: true, size: 11 };

    const periodoTexto = (desde && hasta) ? `Período: ${desde} al ${hasta}` : (desde ? `Desde: ${desde}` : 'Período completo');
    worksheet.getCell('A3').value = periodoTexto;
    worksheet.getCell('D3').value = `Generado el: ${new Date().toLocaleDateString('es-AR')} ${new Date().toLocaleTimeString('es-AR')}`;

    worksheet.addRow([]);

    // 2. Encabezados de tabla
    const encabezados = ['N°', 'DNI / Legajo', 'Apellido y Nombre'];
    clases.forEach(c => {
      const partes = c.fecha.split('-');
      const fechaCorta = partes.length === 3 ? `${partes[2]}/${partes[1]}` : c.fecha;
      encabezados.push(fechaCorta);
    });
    encabezados.push('Total Clases', 'Presentes', 'Tardes', 'Ausentes', '% Asistencia');

    const headerRow = worksheet.addRow(encabezados);
    headerRow.height = 25;
    headerRow.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
      cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'medium' }, right: { style: 'thin' } };
    });

    // 3. Filas de alumnos
    filas.forEach((f) => {
      const filaValores = [f.num, f.legajo_dni, f.nombre_completo];
      clases.forEach(c => {
        const est = f.estadosPorClase[c.id];
        if (est === 'PRESENTE') filaValores.push('P');
        else if (est === 'TARDE') filaValores.push('T');
        else filaValores.push('A');
      });
      filaValores.push(f.totalClases, f.presentes, f.tardes, f.ausentes, `${f.porcentaje}%`);

      const r = worksheet.addRow(filaValores);
      r.height = 20;

      r.eachCell((cell, colNumber) => {
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          right: { style: 'thin', color: { argb: 'FFE2E8F0' } }
        };

        if (colNumber === 3) {
          cell.alignment = { vertical: 'middle', horizontal: 'left' };
        } else {
          cell.alignment = { vertical: 'middle', horizontal: 'center' };
        }

        const val = cell.value;
        if (val === 'P') {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1FAE5' } };
          cell.font = { bold: true, color: { argb: 'FF065F46' } };
        } else if (val === 'T') {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
          cell.font = { bold: true, color: { argb: 'FF92400E' } };
        } else if (val === 'A') {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
          cell.font = { bold: true, color: { argb: 'FF991B1B' } };
        }

        if (colNumber === filaValores.length) {
          cell.font = { bold: true, color: f.porcentaje >= 75 ? { argb: 'FF065F46' } : { argb: 'FFDC2626' } };
        }
      });
    });

    // Anchos de columna
    worksheet.getColumn(1).width = 6;
    worksheet.getColumn(2).width = 16;
    worksheet.getColumn(3).width = 32;
    for (let i = 4; i <= 3 + clases.length; i++) {
      worksheet.getColumn(i).width = 10;
    }
    const offset = 4 + clases.length;
    worksheet.getColumn(offset).width = 14;
    worksheet.getColumn(offset + 1).width = 12;
    worksheet.getColumn(offset + 2).width = 10;
    worksheet.getColumn(offset + 3).width = 10;
    worksheet.getColumn(offset + 4).width = 15;

    const nombreArchivo = `Asistencia_${curso.nombre.replace(/[^a-zA-Z0-9]/g, '_')}_${desde || 'inicio'}_al_${hasta || 'fin'}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${nombreArchivo}"`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    res.status(500).send('Error generando planilla: ' + err.message);
  }
});

// Obtener IP local para que el profesor la vea en consola
const os = require('os');
function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// Inicializar base de datos y arrancar servidor
inicializarBaseDeDatos()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      const localIp = getLocalIp();
      console.log(`====================================================`);
      console.log(` Sistema de Control de Asistencia Iniciado con Éxito`);
      console.log(` Para el profesor (esta PC): http://localhost:${PORT}`);
      console.log(` Para alumnos en la misma red: http://${localIp}:${PORT}`);
      console.log(` Presiona Ctrl + C para detener el servidor`);
      console.log(`====================================================`);
    });
  })
  .catch((err) => {
    console.error('Error fatal inicializando la base de datos:', err);
  });
