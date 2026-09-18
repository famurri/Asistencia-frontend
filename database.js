const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_PATH = path.join(__dirname, 'asistencia.db');

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('Error al conectar con la base de datos SQLite:', err.message);
  } else {
    console.log('Conectado exitosamente a la base de datos SQLite:', DB_PATH);
  }
});

// Habilitar soporte de claves foráneas
db.run('PRAGMA foreign_keys = ON');

// Funciones auxiliares con Promesas
db.runAsync = function (sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
};

db.allAsync = function (sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

db.getAsync = function (sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
};

// Inicialización y migración de tablas
async function inicializarBaseDeDatos() {
  // 1. Tabla de Configuración (Contraseña del profesor y opciones)
  await db.runAsync(`
    CREATE TABLE IF NOT EXISTS configuracion (
      clave TEXT PRIMARY KEY,
      valor TEXT NOT NULL
    )
  `);

  // Insertar contraseña por defecto si no existe ('profesor2026')
  await db.runAsync(`
    INSERT OR IGNORE INTO configuracion (clave, valor) VALUES ('password_docente', 'profesor2026')
  `);

  // 2. Tabla de Cursos
  await db.runAsync(`
    CREATE TABLE IF NOT EXISTS cursos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      comision TEXT,
      anio INTEGER,
      fecha_creacion DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 3. Tabla de Alumnos
  await db.runAsync(`
    CREATE TABLE IF NOT EXISTS alumnos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      curso_id INTEGER NOT NULL,
      legajo_dni TEXT NOT NULL,
      nombre_completo TEXT NOT NULL,
      email TEXT,
      fecha_creacion DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (curso_id) REFERENCES cursos(id) ON DELETE CASCADE,
      UNIQUE(curso_id, legajo_dni)
    )
  `);

  // 4. Tabla de Clases / Sesiones
  await db.runAsync(`
    CREATE TABLE IF NOT EXISTS clases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      curso_id INTEGER NOT NULL,
      fecha TEXT NOT NULL, -- Formato YYYY-MM-DD
      tema TEXT,
      asistencia_activa INTEGER DEFAULT 0, -- 1 si el proyector está abierto
      fecha_creacion DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (curso_id) REFERENCES cursos(id) ON DELETE CASCADE,
      UNIQUE(curso_id, fecha)
    )
  `);

  // Migración segura si la tabla ya existía sin la columna asistencia_activa
  try {
    await db.runAsync(`ALTER TABLE clases ADD COLUMN asistencia_activa INTEGER DEFAULT 0`);
  } catch (e) {
    // La columna ya existe, continuar normalmente
  }

  // 5. Tabla de Asistencias
  await db.runAsync(`
    CREATE TABLE IF NOT EXISTS asistencias (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      clase_id INTEGER NOT NULL,
      alumno_id INTEGER NOT NULL,
      estado TEXT NOT NULL DEFAULT 'PRESENTE', -- PRESENTE, AUSENTE, TARDE
      hora_registro TEXT,
      metodo TEXT DEFAULT 'QR_ALUMNO', -- QR_ALUMNO, MANUAL, QR_DOCENTE
      FOREIGN KEY (clase_id) REFERENCES clases(id) ON DELETE CASCADE,
      FOREIGN KEY (alumno_id) REFERENCES alumnos(id) ON DELETE CASCADE,
      UNIQUE(clase_id, alumno_id)
    )
  `);

  // 6. Tabla de Tokens QR Usados (Para asegurar uso único y evitar reenvío por WhatsApp)
  await db.runAsync(`
    CREATE TABLE IF NOT EXISTS tokens_usados (
      token TEXT PRIMARY KEY,
      curso_id INTEGER NOT NULL,
      alumno_id INTEGER NOT NULL,
      fecha_uso DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  console.log('Tablas de la base de datos inicializadas y verificadas.');
}

module.exports = { db, inicializarBaseDeDatos };
