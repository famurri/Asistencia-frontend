require('dotenv').config();
const { Pool } = require('pg');

// Nos conectamos a PostgreSQL (Supabase) usando la variable de entorno
const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/postgres';

const pool = new Pool({
  connectionString,
  ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false }
});

pool.on('error', (err) => {
  console.error('Error inesperado de PostgreSQL:', err);
});

// Emulamos la interfaz de db.runAsync, allAsync y getAsync para no reescribir todo el backend
const db = {
  runAsync: async (sql, params = []) => {
    let counter = 1;
    // Reemplaza los ? por $1, $2, $3... que es el formato que usa Postgres
    const pgSql = sql.replace(/\?/g, () => `$${counter++}`);
    const result = await pool.query(pgSql, params);
    // Si la query inserta y retorna id, lo mandamos como lastID
    return { 
      lastID: result.rows.length > 0 ? result.rows[0].id : null, 
      changes: result.rowCount 
    };
  },
  allAsync: async (sql, params = []) => {
    let counter = 1;
    const pgSql = sql.replace(/\?/g, () => `$${counter++}`);
    const result = await pool.query(pgSql, params);
    return result.rows;
  },
  getAsync: async (sql, params = []) => {
    let counter = 1;
    const pgSql = sql.replace(/\?/g, () => `$${counter++}`);
    const result = await pool.query(pgSql, params);
    return result.rows[0] || null;
  }
};

// Inicialización y migración de tablas para PostgreSQL
async function inicializarBaseDeDatos() {
  try {
    // 1. Tabla de Configuración (Contraseña del profesor y opciones)
    await db.runAsync(`
      CREATE TABLE IF NOT EXISTS configuracion (
        clave TEXT PRIMARY KEY,
        valor TEXT NOT NULL
      )
    `);

    // Insertar contraseña por defecto si no existe ('profesor2026')
    await db.runAsync(`
      INSERT INTO configuracion (clave, valor) 
      VALUES ('password_docente', 'profesor2026') 
      ON CONFLICT (clave) DO NOTHING
    `);

    // 2. Tabla de Cursos
    await db.runAsync(`
      CREATE TABLE IF NOT EXISTS cursos (
        id SERIAL PRIMARY KEY,
        nombre TEXT NOT NULL,
        comision TEXT,
        anio INTEGER,
        fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 3. Tabla de Alumnos
    await db.runAsync(`
      CREATE TABLE IF NOT EXISTS alumnos (
        id SERIAL PRIMARY KEY,
        curso_id INTEGER NOT NULL REFERENCES cursos(id) ON DELETE CASCADE,
        legajo_dni TEXT NOT NULL,
        nombre_completo TEXT NOT NULL,
        email TEXT,
        fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(curso_id, legajo_dni)
      )
    `);

    // 4. Tabla de Clases / Sesiones
    await db.runAsync(`
      CREATE TABLE IF NOT EXISTS clases (
        id SERIAL PRIMARY KEY,
        curso_id INTEGER NOT NULL REFERENCES cursos(id) ON DELETE CASCADE,
        fecha TEXT NOT NULL,
        tema TEXT,
        asistencia_activa INTEGER DEFAULT 0,
        fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(curso_id, fecha)
      )
    `);

    // Migración segura si la columna asistencia_activa no existía 
    try {
      await db.runAsync(`ALTER TABLE clases ADD COLUMN asistencia_activa INTEGER DEFAULT 0`);
    } catch (e) {
      // Ignoramos el error porque la columna ya existe en Postgres
    }

    // 5. Tabla de Asistencias
    await db.runAsync(`
      CREATE TABLE IF NOT EXISTS asistencias (
        id SERIAL PRIMARY KEY,
        clase_id INTEGER NOT NULL REFERENCES clases(id) ON DELETE CASCADE,
        alumno_id INTEGER NOT NULL REFERENCES alumnos(id) ON DELETE CASCADE,
        estado TEXT NOT NULL DEFAULT 'PRESENTE',
        hora_registro TEXT,
        metodo TEXT DEFAULT 'QR_ALUMNO',
        UNIQUE(clase_id, alumno_id)
      )
    `);

    // 6. Tabla de Tokens QR Usados (Para asegurar uso único y evitar reenvío por WhatsApp)
    await db.runAsync(`
      CREATE TABLE IF NOT EXISTS tokens_usados (
        token TEXT PRIMARY KEY,
        curso_id INTEGER NOT NULL,
        alumno_id INTEGER NOT NULL,
        fecha_uso TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('Tablas de la base de datos PostgreSQL inicializadas y verificadas.');
  } catch (err) {
    console.error('Error inicializando las tablas en Postgres:', err);
  }
}

module.exports = { db, inicializarBaseDeDatos };
