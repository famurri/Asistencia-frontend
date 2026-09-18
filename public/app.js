// =======================================================
// ESTADO GLOBAL DE LA APLICACIÓN
// =======================================================
let docenteAutenticado = false;
let sesionProyectorActiva = false;
let sseProyector = null;
let countdownTimer = null;
let segundosRestantes = 60;

// Estado del Alumno
let alumnoActual = null;
let cursoAlumnoActual = null;
let html5QrAlumno = null;
let escaneandoAlumno = false;
let ultimoEscaneoTimestamp = 0;

// Estado del Docente
let cursos = [];
let cursoDocenteActivoId = null;

// =======================================================
// INICIALIZACIÓN
// =======================================================
document.addEventListener('DOMContentLoaded', () => {
  const hoy = new Date().toISOString().slice(0, 10);
  const primerDiaMes = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);

  const fechaProy = document.getElementById('fechaProyector');
  if (fechaProy) fechaProy.value = hoy;

  const repDesde = document.getElementById('reporteDesdeDocente');
  if (repDesde) repDesde.value = primerDiaMes;

  const repHasta = document.getElementById('reporteHastaDocente');
  if (repHasta) repHasta.value = hoy;

  const anioInput = document.getElementById('nuevoCursoAnio');
  if (anioInput) anioInput.value = new Date().getFullYear();

  // Comprobar cursos disponibles para la vista del alumno
  verificarClasesActivasAlumno();
});

// =======================================================
// SONIDO (Web Audio API)
// =======================================================
function emitirSonido(exito = true) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    if (exito) {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      gain.gain.setValueAtTime(0.2, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);
      osc.start();
      osc.stop(ctx.currentTime + 0.2);
    } else {
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(220, ctx.currentTime);
      gain.gain.setValueAtTime(0.25, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.35);
      osc.start();
      osc.stop(ctx.currentTime + 0.35);
    }
  } catch (e) {}
}

// =======================================================
// 1. PORTAL DEL ALUMNO (MÓVIL)
// =======================================================
async function verificarClasesActivasAlumno() {
  try {
    const res = await fetch('/api/alumnos/clases-activas');
    const data = await res.json();
    const selMateria = document.getElementById('selectMateriaAlumno');
    const campoMateria = document.getElementById('campoSeleccionMateriaAlumno');

    if (data.success && data.clases && data.clases.length > 1) {
      selMateria.innerHTML = data.clases.map(c => `
        <option value="${c.id}">${c.nombre} ${c.comision ? `(${c.comision})` : ''}</option>
      `).join('');
      campoMateria.style.display = 'block';
    } else {
      campoMateria.style.display = 'none';
    }
  } catch (e) {}
}

async function validarIdentidadAlumno() {
  const inputLegajo = document.getElementById('inputLegajoAlumno');
  const legajo = inputLegajo.value.trim();
  const alerta = document.getElementById('alertaAlumnoPaso1');

  if (!legajo) {
    mostrarAlertaPaso1(false, 'Por favor ingresa tu número de DNI o Legajo.');
    return;
  }

  const selMateria = document.getElementById('selectMateriaAlumno');
  const cursoId = selMateria ? selMateria.value : null;

  try {
    const res = await fetch('/api/alumnos/validar-legajo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ legajo_dni: legajo, curso_id: cursoId })
    });
    const data = await res.json();

    if (data.success) {
      alumnoActual = data.alumno;
      cursoAlumnoActual = data.curso;

      if (data.yaRegistrado) {
        mostrarAlertaPaso1(true, `ℹ️ ${data.mensaje}`);
        return;
      }

      // Pasar a la pantalla de la cámara
      cambiarPasoAlumno('pasoAlumnoCamara');
      document.getElementById('textoSaludoAlumno').innerText = `Hola, ${alumnoActual.nombre_completo}`;
      document.getElementById('textoMateriaAlumno').innerText = `Materia: ${cursoAlumnoActual.nombre} ${cursoAlumnoActual.comision ? `(${cursoAlumnoActual.comision})` : ''}`;

      iniciarCamaraAlumno();
    } else {
      mostrarAlertaPaso1(false, data.error);
    }
  } catch (err) {
    mostrarAlertaPaso1(false, 'Error de conexión con el servidor.');
  }
}

function mostrarAlertaPaso1(exito, texto) {
  const alerta = document.getElementById('alertaAlumnoPaso1');
  alerta.style.display = 'block';
  alerta.style.background = exito ? '#d1fae5' : '#fee2e2';
  alerta.style.color = exito ? '#065f46' : '#991b1b';
  alerta.style.border = exito ? '1px solid #a7f3d0' : '1px solid #fecaca';
  alerta.innerText = texto;
}

function iniciarCamaraAlumno() {
  detenerCamaraAlumno();

  html5QrAlumno = new Html5Qrcode('reader-alumno');
  escaneandoAlumno = true;

  html5QrAlumno.start(
    { facingMode: 'environment' }, // Cámara trasera del celular
    { fps: 12, qrbox: { width: 260, height: 260 } },
    onScanQrAlumno,
    () => {}
  ).catch(err => {
    console.error('Error al encender cámara:', err);
    mostrarAlertaScanAlumno(false, 'No se pudo acceder a la cámara. Asegúrate de dar permisos de cámara en el navegador.');
  });
}

function detenerCamaraAlumno() {
  if (html5QrAlumno) {
    try {
      html5QrAlumno.stop().then(() => html5QrAlumno.clear()).catch(() => {});
    } catch(e) {}
    html5QrAlumno = null;
  }
  escaneandoAlumno = false;
}

async function onScanQrAlumno(codigoDecodificado) {
  const ahora = Date.now();
  if (ahora - ultimoEscaneoTimestamp < 2500) return; // Evitar re-escaneos continuos
  ultimoEscaneoTimestamp = ahora;

  if (!alumnoActual || !cursoAlumnoActual) return;

  try {
    const res = await fetch('/api/alumnos/registrar-asistencia', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        legajo_dni: alumnoActual.legajo_dni,
        curso_id: cursoAlumnoActual.id,
        codigo_escaneado: codigoDecodificado
      })
    });
    const data = await res.json();

    if (data.success) {
      emitirSonido(true);
      detenerCamaraAlumno();

      // Mostrar pantalla de éxito
      document.getElementById('exitoNombreAlumno').innerText = data.alumno.nombre_completo;
      document.getElementById('exitoDniAlumno').innerText = data.alumno.legajo_dni;
      document.getElementById('exitoHoraAlumno').innerText = data.alumno.hora;
      cambiarPasoAlumno('pasoAlumnoExito');
    } else {
      emitirSonido(false);
      mostrarAlertaScanAlumno(false, data.error);
    }
  } catch (err) {
    emitirSonido(false);
    mostrarAlertaScanAlumno(false, 'Error procesando asistencia: ' + err.message);
  }
}

function mostrarAlertaScanAlumno(exito, texto) {
  const alerta = document.getElementById('alertaAlumnoScan');
  alerta.style.display = 'block';
  alerta.style.background = exito ? '#d1fae5' : '#fee2e2';
  alerta.style.color = exito ? '#065f46' : '#991b1b';
  alerta.style.border = exito ? '1px solid #a7f3d0' : '1px solid #fecaca';
  alerta.innerText = texto;

  setTimeout(() => {
    alerta.style.display = 'none';
  }, 4500);
}

function cancelarEscaneoAlumno() {
  detenerCamaraAlumno();
  cambiarPasoAlumno('pasoAlumnoIdentificacion');
}

function reiniciarPortalAlumno() {
  detenerCamaraAlumno();
  alumnoActual = null;
  cursoAlumnoActual = null;
  document.getElementById('inputLegajoAlumno').value = '';
  document.getElementById('alertaAlumnoPaso1').style.display = 'none';
  cambiarPasoAlumno('pasoAlumnoIdentificacion');
}

function cambiarPasoAlumno(idPaso) {
  document.querySelectorAll('.alumno-step').forEach(s => s.classList.remove('active'));
  const paso = document.getElementById(idPaso);
  if (paso) paso.classList.add('active');
}

// =======================================================
// 2. AUTENTICACIÓN Y MODO DOCENTE
// =======================================================
function toggleAccesoDocente() {
  if (docenteAutenticado) {
    if (confirm('¿Deseas salir del panel docente y volver a la pantalla de alumnos?')) {
      cerrarSesionDocente();
    }
  } else {
    document.getElementById('inputPasswordDocente').value = '';
    document.getElementById('alertaLoginDocente').style.display = 'none';
    abrirModal('modalLoginDocente');
    setTimeout(() => document.getElementById('inputPasswordDocente').focus(), 150);
  }
}

async function autenticarDocente() {
  const pwd = document.getElementById('inputPasswordDocente').value;
  const alerta = document.getElementById('alertaLoginDocente');

  if (!pwd) {
    alerta.innerText = 'Por favor ingresa tu contraseña.';
    alerta.style.display = 'block';
    return;
  }

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pwd })
    });
    const data = await res.json();

    if (data.success) {
      docenteAutenticado = true;
      cerrarModal('modalLoginDocente');

      // Intercambiar vistas
      document.getElementById('seccionAlumno').style.display = 'none';
      document.getElementById('seccionDocente').style.display = 'block';
      document.getElementById('navTabsDocente').style.display = 'flex';
      document.getElementById('btnAccesoDocente').innerText = '🔓 Salir Docente';
      document.getElementById('btnAccesoDocente').classList.replace('btn-secondary', 'btn-danger');

      await cargarCursosDocente();
      cambiarPestanaDocente('proyector');
    } else {
      alerta.innerText = data.error || 'Contraseña incorrecta';
      alerta.style.display = 'block';
    }
  } catch (err) {
    alerta.innerText = 'Error al conectar: ' + err.message;
    alerta.style.display = 'block';
  }
}

function cerrarSesionDocente() {
  docenteAutenticado = false;
  if (sseProyector) {
    sseProyector.close();
    sseProyector = null;
  }
  clearInterval(countdownTimer);

  document.getElementById('seccionDocente').style.display = 'none';
  document.getElementById('navTabsDocente').style.display = 'none';
  document.getElementById('seccionAlumno').style.display = 'block';
  document.getElementById('btnAccesoDocente').innerText = '🔐 Acceso Docente';
  document.getElementById('btnAccesoDocente').classList.replace('btn-danger', 'btn-secondary');

  verificarClasesActivasAlumno();
}

function cambiarPestanaDocente(pestana) {
  document.querySelectorAll('#navTabsDocente .nav-tab').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('#seccionDocente .tab-content').forEach(c => c.classList.remove('active'));

  const tab = document.getElementById(`tabDocente-${pestana}`);
  if (tab) tab.classList.add('active');

  const idx = pestana === 'proyector' ? 0 : (pestana === 'nomina' ? 1 : (pestana === 'cursos' ? 2 : 3));
  const btn = document.querySelectorAll('#navTabsDocente .nav-tab')[idx];
  if (btn) btn.classList.add('active');

  if (pestana === 'nomina') recargarNominaDia();
}

// =======================================================
// 3. PROYECTOR QR DINÁMICO (ANTI-WHATSAPP CON USO ÚNICO)
// =======================================================
async function cambioCursoProyector() {
  if (sesionProyectorActiva) {
    await toggleHabilitarSesion(); // Pausar previa
  }
  actualizarInfoProyector();
}

function actualizarInfoProyector() {
  const sel = document.getElementById('selectCursoProyector');
  const cursoId = sel.value;
  const curso = cursos.find(c => c.id == cursoId);
  const fecha = document.getElementById('fechaProyector').value;

  if (curso) {
    document.getElementById('tituloProyectorMateria').innerText = `${curso.nombre} ${curso.comision ? `(${curso.comision})` : ''}`;
    document.getElementById('subtituloProyectorFecha').innerText = `Clase del día: ${fecha}`;
  }
  const spanUrl = document.getElementById('urlParaAlumnos');
  if (spanUrl) spanUrl.innerText = window.location.origin;
}

async function toggleHabilitarSesion() {
  const cursoId = document.getElementById('selectCursoProyector').value;
  const fecha = document.getElementById('fechaProyector').value;

  if (!cursoId) {
    alert('Primero selecciona un curso.');
    return;
  }

  const btn = document.getElementById('btnHabilitarAsistencia');

  if (!sesionProyectorActiva) {
    // Iniciar toma de asistencia
    try {
      const res = await fetch('/api/docente/habilitar-sesion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ curso_id: cursoId, fecha })
      });
      const data = await res.json();

      if (data.success) {
        sesionProyectorActiva = true;
        btn.innerText = '⏸️ Pausar Asistencia';
        btn.classList.replace('btn-success', 'btn-danger');

        document.getElementById('boxQrProyector').style.display = 'inline-block';
        document.getElementById('boxTimerProyector').style.display = 'block';
        document.getElementById('badgeSeguridad').style.display = 'inline-flex';
        document.getElementById('boxPausadoProyector').style.display = 'none';

        conectarSseProyector(cursoId);
      }
    } catch (err) {
      alert('Error iniciando asistencia: ' + err.message);
    }
  } else {
    // Pausar toma de asistencia
    try {
      await fetch('/api/docente/pausar-sesion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ curso_id: cursoId })
      });

      sesionProyectorActiva = false;
      btn.innerText = '▶️ Iniciar Proyector QR';
      btn.classList.replace('btn-danger', 'btn-success');

      if (sseProyector) { sseProyector.close(); sseProyector = null; }
      clearInterval(countdownTimer);

      document.getElementById('boxQrProyector').style.display = 'none';
      document.getElementById('boxTimerProyector').style.display = 'none';
      document.getElementById('badgeSeguridad').style.display = 'none';
      document.getElementById('boxPausadoProyector').style.display = 'block';
    } catch (err) {
      alert('Error pausando: ' + err.message);
    }
  }
}

function conectarSseProyector(cursoId) {
  if (sseProyector) sseProyector.close();

  sseProyector = new EventSource(`/api/docente/stream-qr?curso_id=${cursoId}`);

  sseProyector.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);

      if (data.tipo === 'NUEVO_QR') {
        const imgQr = document.getElementById('imgQrProyector');
        imgQr.src = data.qrDataUrl;

        // Efecto visual de parpadeo suave al cambiar el QR
        const box = document.getElementById('boxQrProyector');
        box.style.transform = 'scale(0.96)';
        setTimeout(() => box.style.transform = 'scale(1)', 150);

        if (data.motivo === 'alumno_escaneo') {
          emitirSonido(true);
        }

        // Actualizar feed en vivo
        document.getElementById('badgeTotalPresentesVivo').innerText = `${data.totalPresentes} Alumnos`;
        renderizarFeedVivo(data.ultimosPresentes);

        // Reiniciar cronómetro regresivo de 60s
        reiniciarCronometro(data.segundosValidez || 60);
      } else if (data.tipo === 'SESION_PAUSADA') {
        if (sesionProyectorActiva) toggleHabilitarSesion();
      }
    } catch (e) {}
  };

  sseProyector.onerror = () => {
    // Si se interrumpe la conexión, EventSource se reconecta automáticamente
  };
}

function reiniciarCronometro(segundosIniciales) {
  clearInterval(countdownTimer);
  segundosRestantes = segundosIniciales;

  const contadorSpan = document.getElementById('contadorSegundosRestantes');
  const barFill = document.getElementById('timerBarFill');

  actualizarVisualCronometro();

  countdownTimer = setInterval(() => {
    segundosRestantes--;
    if (segundosRestantes <= 0) {
      segundosRestantes = 60;
    }
    actualizarVisualCronometro();
  }, 1000);

  function actualizarVisualCronometro() {
    if (contadorSpan) contadorSpan.innerText = segundosRestantes;
    if (barFill) {
      const pct = (segundosRestantes / 60) * 100;
      barFill.style.width = `${pct}%`;
      if (pct > 40) barFill.style.background = '#2563eb';
      else if (pct > 15) barFill.style.background = '#f59e0b';
      else barFill.style.background = '#ef4444';
    }
  }
}

function renderizarFeedVivo(lista) {
  const cont = document.getElementById('listaPresentesVivo');
  if (!lista || lista.length === 0) {
    cont.innerHTML = `<div style="text-align: center; color: #94a3b8; padding: 2rem 0; font-size: 0.9rem;">Esperando registros de alumnos...</div>`;
    return;
  }

  cont.innerHTML = lista.map(al => `
    <div class="live-feed-item">
      <div>
        <div class="alumno-info">${al.nombre_completo}</div>
        <div style="font-size: 0.78rem; color: #64748b;">DNI: ${al.legajo_dni}</div>
      </div>
      <div class="alumno-hora">${al.hora}</div>
    </div>
  `).join('');
}

function togglePantallaCompleta() {
  const elem = document.getElementById('contenedorProyectorCompleto');
  if (!document.fullscreenElement) {
    elem.requestFullscreen().catch(err => {
      alert(`No se pudo activar pantalla completa: ${err.message}`);
    });
  } else {
    document.exitFullscreen();
  }
}

// =======================================================
// 4. GESTIÓN DE CURSOS Y ALUMNOS (DOCENTE)
// =======================================================
async function cargarCursosDocente() {
  try {
    const res = await fetch('/api/cursos');
    const data = await res.json();
    if (data.success) {
      cursos = data.cursos;
      actualizarSelectoresDocente();
      renderizarListaCursosDocente();
    }
  } catch (err) {}
}

function actualizarSelectoresDocente() {
  const selProy = document.getElementById('selectCursoProyector');
  const selRep = document.getElementById('selectCursoReporteDocente');

  const options = ['<option value="">-- Selecciona un Curso --</option>'];
  cursos.forEach(c => {
    const com = c.comision ? ` (${c.comision})` : '';
    options.push(`<option value="${c.id}">${c.nombre}${com}</option>`);
  });

  const html = options.join('');
  if (selProy) {
    selProy.innerHTML = html;
    if (cursos.length > 0) {
      selProy.value = cursos[0].id;
      actualizarInfoProyector();
    }
  }
  if (selRep) {
    selRep.innerHTML = html;
    if (cursos.length > 0) selRep.value = cursos[0].id;
  }
}

function renderizarListaCursosDocente() {
  const cont = document.getElementById('listaCursosDocente');
  if (!cont) return;

  if (cursos.length === 0) {
    cont.innerHTML = `<div style="padding: 1.5rem; text-align: center; color: #64748b;">No tienes cursos creados.</div>`;
    return;
  }

  cont.innerHTML = cursos.map(c => `
    <div style="padding: 1rem; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; cursor: pointer; background: ${c.id === cursoDocenteActivoId ? '#eff6ff' : 'white'};"
         onclick="seleccionarCursoDocente(${c.id})">
      <div>
        <div style="font-weight: 700; color: #1e293b; font-size: 0.95rem;">${c.nombre}</div>
        <div style="font-size: 0.8rem; color: #64748b;">${c.comision ? `${c.comision} • ` : ''}👥 ${c.total_alumnos} alumnos</div>
      </div>
      <button class="btn btn-secondary btn-sm" style="color: #dc2626;" onclick="event.stopPropagation(); eliminarCursoDocente(${c.id}, '${c.nombre}')">🗑️</button>
    </div>
  `).join('');

  if (!cursoDocenteActivoId && cursos.length > 0) {
    seleccionarCursoDocente(cursos[0].id);
  }
}

async function seleccionarCursoDocente(id) {
  cursoDocenteActivoId = id;
  renderizarListaCursosDocente();

  const c = cursos.find(x => x.id === id);
  if (c) {
    document.getElementById('tituloCursoDocenteSeleccionado').innerText = `Alumnos de: ${c.nombre} ${c.comision ? `(${c.comision})` : ''}`;
  }

  try {
    const res = await fetch(`/api/cursos/${id}/alumnos`);
    const data = await res.json();
    if (data.success) {
      renderizarTablaAlumnosDocente(data.alumnos);
    }
  } catch (e) {}
}

function renderizarTablaAlumnosDocente(alumnos) {
  const tbody = document.getElementById('tablaAlumnosDocenteCuerpo');
  if (!tbody) return;

  if (alumnos.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: #64748b; padding: 2rem;">No hay alumnos registrados en este curso.</td></tr>`;
    return;
  }

  tbody.innerHTML = alumnos.map(al => `
    <tr>
      <td style="font-weight: 600;">${al.legajo_dni}</td>
      <td>${al.nombre_completo}</td>
      <td style="color: #64748b;">${al.email || '-'}</td>
      <td style="text-align: center;">
        <button class="btn btn-secondary btn-sm" style="color: #dc2626;" onclick="eliminarAlumnoDocente(${al.id}, '${al.nombre_completo}')">🗑️</button>
      </td>
    </tr>
  `).join('');
}

async function guardarNuevoCurso() {
  const nom = document.getElementById('nuevoCursoNombre').value.trim();
  const com = document.getElementById('nuevoCursoComision').value.trim();
  const anio = document.getElementById('nuevoCursoAnio').value.trim();

  if (!nom) return alert('Ingresa el nombre del curso');

  try {
    const res = await fetch('/api/cursos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre: nom, comision: com, anio })
    });
    const data = await res.json();
    if (data.success) {
      cerrarModal('modalNuevoCurso');
      document.getElementById('nuevoCursoNombre').value = '';
      document.getElementById('nuevoCursoComision').value = '';
      await cargarCursosDocente();
      seleccionarCursoDocente(data.curso.id);
    }
  } catch (e) {}
}

async function eliminarCursoDocente(id, nom) {
  if (!confirm(`¿Eliminar el curso "${nom}"?`)) return;
  try {
    const res = await fetch(`/api/cursos/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      cursoDocenteActivoId = null;
      await cargarCursosDocente();
    }
  } catch (e) {}
}

async function guardarNuevoAlumno() {
  if (!cursoDocenteActivoId) return alert('Selecciona un curso primero.');

  const dni = document.getElementById('nuevoAlumnoDni').value.trim();
  const nom = document.getElementById('nuevoAlumnoNombre').value.trim();
  const email = document.getElementById('nuevoAlumnoEmail').value.trim();

  if (!dni || !nom) return alert('DNI y Nombre son obligatorios');

  try {
    const res = await fetch(`/api/cursos/${cursoDocenteActivoId}/alumnos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ legajo_dni: dni, nombre_completo: nom, email })
    });
    const data = await res.json();
    if (data.success) {
      cerrarModal('modalNuevoAlumno');
      document.getElementById('nuevoAlumnoDni').value = '';
      document.getElementById('nuevoAlumnoNombre').value = '';
      document.getElementById('nuevoAlumnoEmail').value = '';
      seleccionarCursoDocente(cursoDocenteActivoId);
      cargarCursosDocente();
    } else {
      alert(data.error);
    }
  } catch (e) {}
}

async function procesarCargaMasiva() {
  if (!cursoDocenteActivoId) return alert('Selecciona un curso');
  const texto = document.getElementById('textoCargaMasiva').value.trim();
  if (!texto) return alert('Pega el texto con los alumnos');

  try {
    const res = await fetch(`/api/cursos/${cursoDocenteActivoId}/alumnos/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texto })
    });
    const data = await res.json();
    if (data.success) {
      alert(`¡Carga exitosa! Se importaron ${data.importados} alumnos.`);
      cerrarModal('modalCargaMasiva');
      document.getElementById('textoCargaMasiva').value = '';
      seleccionarCursoDocente(cursoDocenteActivoId);
      cargarCursosDocente();
    }
  } catch (e) {}
}

async function eliminarAlumnoDocente(id, nom) {
  if (!confirm(`¿Eliminar al alumno "${nom}"?`)) return;
  try {
    await fetch(`/api/alumnos/${id}`, { method: 'DELETE' });
    seleccionarCursoDocente(cursoDocenteActivoId);
    cargarCursosDocente();
  } catch (e) {}
}

// =======================================================
// 5. NÓMINA DEL DÍA Y ASISTENCIA MANUAL (DOCENTE)
// =======================================================
async function recargarNominaDia() {
  const cursoId = document.getElementById('selectCursoProyector').value;
  const fecha = document.getElementById('fechaProyector').value;
  if (!cursoId || !fecha) return;

  try {
    const res = await fetch(`/api/clases/asistencias-dia?curso_id=${cursoId}&fecha=${fecha}`);
    const data = await res.json();
    if (data.success) {
      const tbody = document.getElementById('tablaNominaDocenteCuerpo');
      if (data.alumnos.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: #64748b; padding: 2rem;">No hay alumnos inscriptos.</td></tr>`;
        return;
      }

      tbody.innerHTML = data.alumnos.map(al => `
        <tr>
          <td style="font-weight: 600;">${al.legajo_dni}</td>
          <td>${al.nombre_completo}</td>
          <td>
            <span class="badge ${al.estado === 'PRESENTE' ? 'badge-presente' : (al.estado === 'TARDE' ? 'badge-tarde' : 'badge-ausente')}">
              ${al.estado === 'NO_REGISTRADO' ? 'Ausente' : al.estado}
            </span>
          </td>
          <td>${al.hora_registro || '-'}</td>
          <td style="color: #64748b; font-size: 0.8rem;">${al.metodo || '-'}</td>
          <td>
            <div class="status-actions">
              <button class="btn-status btn-p ${al.estado === 'PRESENTE' ? 'active' : ''}" onclick="marcarManualDocente(${al.alumno_id}, 'PRESENTE')">P</button>
              <button class="btn-status btn-t ${al.estado === 'TARDE' ? 'active' : ''}" onclick="marcarManualDocente(${al.alumno_id}, 'TARDE')">T</button>
              <button class="btn-status btn-a ${al.estado === 'AUSENTE' ? 'active' : ''}" onclick="marcarManualDocente(${al.alumno_id}, 'AUSENTE')">A</button>
            </div>
          </td>
        </tr>
      `).join('');
    }
  } catch (e) {}
}

async function marcarManualDocente(alumnoId, estado) {
  const cursoId = document.getElementById('selectCursoProyector').value;
  const fecha = document.getElementById('fechaProyector').value;

  try {
    const res = await fetch('/api/asistencias/manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ curso_id: cursoId, fecha, alumno_id: alumnoId, estado })
    });
    const data = await res.json();
    if (data.success) {
      recargarNominaDia();
    }
  } catch (e) {}
}

// =======================================================
// 6. REPORTES Y PLANILLAS EXCEL (.XLSX)
// =======================================================
async function generarVistaPreviaReporteDocente() {
  const cursoId = document.getElementById('selectCursoReporteDocente').value;
  const desde = document.getElementById('reporteDesdeDocente').value;
  const hasta = document.getElementById('reporteHastaDocente').value;

  if (!cursoId) return alert('Selecciona un curso');

  try {
    const url = `/api/reportes/asistencia-datos?curso_id=${cursoId}&desde=${desde}&hasta=${hasta}`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.success) {
      document.getElementById('tituloReporteDocente').innerText = `Planilla: ${data.curso.nombre} (${data.curso.comision || 'Comisión Única'})`;
      document.getElementById('badgeReporteTotalClasesDocente').innerText = `${data.clases.length} Clases registradas`;

      const headerRow = document.getElementById('headerReporteDocenteMatriz');
      let headerHtml = `<th>N°</th><th>DNI / Legajo</th><th>Apellido y Nombre</th>`;

      data.clases.forEach(c => {
        const partes = c.fecha.split('-');
        const fCorta = partes.length === 3 ? `${partes[2]}/${partes[1]}` : c.fecha;
        headerHtml += `<th style="text-align: center; min-width: 50px;">${fCorta}</th>`;
      });
      headerHtml += `<th>Total Clases</th><th>Presentes</th><th>Tardes</th><th>Ausentes</th><th>% Asistencia</th>`;
      headerRow.innerHTML = headerHtml;

      const cuerpo = document.getElementById('cuerpoReporteDocenteMatriz');
      if (data.filas.length === 0) {
        cuerpo.innerHTML = `<tr><td colspan="8" style="text-align: center; padding: 2rem;">No hay alumnos registrados.</td></tr>`;
        return;
      }

      let cuerpoHtml = '';
      data.filas.forEach(f => {
        cuerpoHtml += `<tr><td>${f.num}</td><td style="font-weight: 600;">${f.legajo_dni}</td><td>${f.nombre_completo}</td>`;
        data.clases.forEach(c => {
          const est = f.estadosPorClase[c.id];
          if (est === 'PRESENTE') cuerpoHtml += `<td class="matrix-cell-P">P</td>`;
          else if (est === 'TARDE') cuerpoHtml += `<td class="matrix-cell-T">T</td>`;
          else cuerpoHtml += `<td class="matrix-cell-A">A</td>`;
        });
        cuerpoHtml += `
          <td style="text-align: center; font-weight: 600;">${f.totalClases}</td>
          <td style="text-align: center; color: #059669; font-weight: 600;">${f.presentes}</td>
          <td style="text-align: center; color: #d97706; font-weight: 600;">${f.tardes}</td>
          <td style="text-align: center; color: #dc2626; font-weight: 600;">${f.ausentes}</td>
          <td style="text-align: center; font-weight: 700; color: ${f.porcentaje >= 75 ? '#059669' : '#dc2626'};">${f.porcentaje}%</td>
        </tr>`;
      });
      cuerpo.innerHTML = cuerpoHtml;
    }
  } catch (e) {
    alert('Error al generar vista previa: ' + e.message);
  }
}

function descargarExcelReporteDocente() {
  const cursoId = document.getElementById('selectCursoReporteDocente').value;
  const desde = document.getElementById('reporteDesdeDocente').value;
  const hasta = document.getElementById('reporteHastaDocente').value;

  if (!cursoId) return alert('Selecciona un curso');

  window.location.href = `/api/reportes/asistencia-excel?curso_id=${cursoId}&desde=${desde}&hasta=${hasta}`;
}

// =======================================================
// 7. MODALES
// =======================================================
function abrirModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}

function cerrarModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('active');
}
