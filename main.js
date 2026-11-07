const { app, BrowserWindow, desktopCapturer, ipcMain, screen, dialog } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { exec } = require('child_process');
const { io } = require('socket.io-client');

const {
  RadarBroadcaster,
  RadarListener,
  getLocalIPv4Addresses,
  MASTER_PORT
} = require('./src/shared/radar');
const MasterServer = require('./src/shared/server');

// ---------------------------------------------------------------------------
// Identidad de la instancia (única por arranque)
// ---------------------------------------------------------------------------
const instanceId = crypto.randomUUID();
const hostname = os.hostname();
const localIps = getLocalIPv4Addresses();

// Credenciales del Maestro (según memoria de arquitectura)
const ADMIN_USER = 'admin';
const ADMIN_PASS = 'admin123';

// ---------------------------------------------------------------------------
// Estado de la aplicación
// ---------------------------------------------------------------------------
let mainWindow = null;
let role = 'student'; // 'student' | 'teacher'

let radarListener = null;   // Modo estudiante: descubre al maestro
let radarBroadcaster = null; // Modo maestro: anuncia su presencia
let masterServer = null;    // Modo maestro: servidor Express + Socket.io
let studentSocket = null;   // Modo estudiante: cliente socket.io hacia el maestro
let connectedMasterUrl = null; // URL del maestro al que está conectado el estudiante

// Ventanas independientes de visualización de pantalla (socketId -> BrowserWindow).
const screenWindows = new Map();

const chatHistory = [];
const MAX_CHAT_HISTORY = 200;

// Dominios bloqueados en la sesión actual del maestro (refleja el archivo hosts).
const blockedDomains = new Set();

// Tamaño de fragmento para la transferencia de archivos por streaming (64 KB).
const FILE_CHUNK_SIZE = 64 * 1024;

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
function pushToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function getPublicState() {
  return {
    instanceId,
    hostname,
    role,
    localIps,
    chatHistory: chatHistory.slice()
  };
}

function appendChatMessage(message) {
  chatHistory.push(message);
  if (chatHistory.length > MAX_CHAT_HISTORY) {
    chatHistory.shift();
  }
  pushToRenderer('chat-message', message);
}

// ---------------------------------------------------------------------------
// Bloqueo DNS (modificación del archivo hosts del sistema operativo)
// ---------------------------------------------------------------------------
function hostsFilePath() {
  return process.platform === 'win32'
    ? 'C:\\Windows\\System32\\drivers\\etc\\hosts'
    : '/etc/hosts';
}

/**
 * Vacía la caché DNS del sistema operativo tras modificar el archivo hosts.
 * Windows: `ipconfig /flushdns` · macOS: `dscacheutil -flushcache` + reinicio de mDNSResponder.
 */
function flushDnsCache() {
  let command = null;
  if (process.platform === 'win32') {
    command = 'ipconfig /flushdns';
  } else if (process.platform === 'darwin') {
    command = 'dscacheutil -flushcache; killall -HUP mDNSResponder';
  }

  if (!command) {
    return; // Linux/otros: sin comando estándar, se omite.
  }

  exec(command, (error, stdout, stderr) => {
    if (error) {
      console.error('[dns] Error al vaciar la caché DNS:', error.message);
    } else if (stderr) {
      console.warn('[dns] Aviso al vaciar la caché DNS:', stderr.trim());
    }
  });
}

// Marcas que delimitan el bloque de hosts gestionado por la aplicación.
const HOSTS_START = '# AULA_CONTROL_START';
const HOSTS_END = '# AULA_CONTROL_END';
const HOSTS_BLOCK_REGEX = /# AULA_CONTROL_START[\s\S]*?# AULA_CONTROL_END/g;

/**
 * Reescribe de forma segura ÚNICAMENTE el bloque de hosts gestionado por la
 * app (entre # AULA_CONTROL_START y # AULA_CONTROL_END), preservando las
 * reglas previas del equipo y los loopbacks del sistema.
 */
async function syncBlockedDomains(domains) {
  const filePath = hostsFilePath();
  const list = Array.isArray(domains) ? domains : [];
  try {
    let content = await fs.promises.readFile(filePath, 'utf8');
    content = content.replace(HOSTS_BLOCK_REGEX, '').trimEnd();
    content += '\n';

    const entries = [];
    for (const raw of list) {
      const domain = normalizeDomain(raw);
      if (!domain) {
        continue;
      }
      entries.push(`127.0.0.1 ${domain}`);
      entries.push(`127.0.0.1 www.${domain}`);
    }

    content += `${HOSTS_START}\n${entries.join('\n')}\n${HOSTS_END}\n`;
    await fs.promises.writeFile(filePath, content, 'utf8');
    flushDnsCache();
    return { success: true };
  } catch (err) {
    return { success: false, error: `No se pudo actualizar hosts: ${err.message}` };
  }
}

/**
 * Normaliza un dominio ingresado por el usuario:
 * elimina espacios, protocolo (http/https) y rutas.
 */
function normalizeDomain(domain) {
  return String(domain || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
}

function getBlockedDomains() {
  return Array.from(blockedDomains);
}

/**
 * Aplica el bloqueo DNS local (segmentado) y sincroniza el estado a los
 * estudiantes conectados y a los paneles docentes.
 */
async function applyLocalAndBroadcastDns() {
  await syncBlockedDomains(getBlockedDomains());
  if (masterServer) {
    masterServer.setBlockedDomains(getBlockedDomains());
    masterServer.syncDns(getBlockedDomains());
  }
}

/**
 * Bloquea un dominio: lo registra en memoria, escribe el hosts local y
 * propaga la lista completa a todos los estudiantes conectados.
 */
async function addBlockedDomain(domain) {
  const clean = normalizeDomain(domain);
  if (!clean) {
    return { success: false, error: 'Dominio no especificado.', domains: getBlockedDomains() };
  }
  blockedDomains.add(clean);
  await applyLocalAndBroadcastDns();
  return { success: true, message: `Dominio ${clean} bloqueado.`, domains: getBlockedDomains() };
}

/**
 * Desbloquea un dominio: lo elimina de memoria, reescribe el hosts local y
 * propaga la lista completa a todos los estudiantes conectados.
 */
async function removeBlockedDomain(domain) {
  const clean = normalizeDomain(domain);
  blockedDomains.delete(clean);
  await applyLocalAndBroadcastDns();
  return { success: true, message: `Dominio ${clean} desbloqueado.`, domains: getBlockedDomains() };
}

// ---------------------------------------------------------------------------
// Captura de miniaturas de pantalla
// ---------------------------------------------------------------------------
// Las miniaturas de la grilla se generan ahora en el RENDERER del estudiante:
// el stream de pantalla se dibuja en un <canvas> y se convierte a JPEG de
// calidad media; el fotograma llega aquí vía IPC 'send-thumbnail-frame' y se
// reenvía por socket.io. Ver `src/ui/app.js` (captura de fondo) y el handler
// 'send-thumbnail-frame' más abajo.

// ---------------------------------------------------------------------------
// Conexión del estudiante al Maestro (socket.io-client)
// ---------------------------------------------------------------------------
function connectToMaster(masterIp, masterPort) {
  const url = `http://${masterIp}:${masterPort}`;

  // Si ya está conectado al mismo maestro, no se reconecta.
  if (connectedMasterUrl === url && studentSocket && studentSocket.connected) {
    return;
  }

  if (studentSocket) {
    studentSocket.removeAllListeners();
    studentSocket.disconnect();
    studentSocket = null;
  }

  connectedMasterUrl = url;

  studentSocket = io(url, {
    reconnection: true,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 10000
  });

  studentSocket.on('connect', () => {
    pushToRenderer('radar-status', { status: 'connected', masterIp, masterPort });

    studentSocket.emit('register-student', {
      instanceId,
      hostname,
      ip: localIps[0] || '127.0.0.1',
      role: 'student'
    });
  });

  studentSocket.on('register-rejected', () => {
    // Nuestro propio anuncio fue rechazado: se evita el bucle.
    studentSocket.disconnect();
    connectedMasterUrl = null;
    pushToRenderer('radar-status', { status: 'searching' });
  });

  studentSocket.on('chat-message', (message) => {
    appendChatMessage(message);
  });

  studentSocket.on('sync-dns', async (data) => {
    const result = await syncBlockedDomains(data && data.blockedDomains);
    pushToRenderer('dns-command-result', { ...(data || {}), ...result });
  });

  studentSocket.on('sync-global-state', async (config) => {
    if (config && Array.isArray(config.blockedDomains)) {
      await syncBlockedDomains(config.blockedDomains);
    }
  });

  studentSocket.on('teacher-lower-hand', () => {
    pushToRenderer('teacher-lower-hand', {});
  });

  studentSocket.on('live-watch-start', () => {
    pushToRenderer('live-watch-start', {});
  });

  studentSocket.on('live-watch-stop', () => {
    pushToRenderer('live-watch-stop', {});
  });

  studentSocket.on('file-command', async (data) => {
    await handleIncomingFileCommand(data);
  });

  studentSocket.on('broadcast-file', async (payload) => {
    await handleIncomingBroadcast(payload);
  });

  studentSocket.on('disconnect', () => {
    connectedMasterUrl = null;
    pushToRenderer('radar-status', { status: 'searching' });
  });

  studentSocket.on('connect_error', () => {
    connectedMasterUrl = null;
    pushToRenderer('radar-status', { status: 'searching' });
  });
}

// ---------------------------------------------------------------------------
// Gestor de archivos remotos (estudiante ejecuta comandos fs locales)
// ---------------------------------------------------------------------------
/**
 * Resuelve una ruta proveniente del Maestro contra el directorio personal del
 * estudiante. Evita resolver rutas relativas contra el directorio del proyecto
 * (causa de errores ENOENT).
 */
function resolveStudentPath(userPath) {
  if (!userPath) {
    return os.homedir();
  }
  return path.isAbsolute(userPath) ? userPath : path.join(os.homedir(), userPath);
}

async function handleIncomingFileCommand(data) {
  if (!data || !data.action) {
    return;
  }

  // Descarga con streaming por fragmentos (no bloquea el event loop).
  if (data.action === 'download') {
    await handleFileDownload(data.requestId, data.path);
    return;
  }

  const response = {
    requestId: data.requestId,
    action: data.action,
    targetSocketId: 'teacher'
  };

  try {
    if (data.action === 'list') {
      const dirPath = resolveStudentPath(data.path);
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      response.result = entries
        .filter((entry) => !entry.name.startsWith('.'))
        .map((entry) => ({
          name: entry.name,
          isDirectory: entry.isDirectory(),
          isFile: entry.isFile(),
          isSymbolicLink: entry.isSymbolicLink()
        }))
        .sort((a, b) => {
          if (a.isDirectory && !b.isDirectory) return -1;
          if (!a.isDirectory && b.isDirectory) return 1;
          return a.name.localeCompare(b.name);
        });
    } else if (data.action === 'read') {
      if (!data.path) {
        throw new Error('Ruta de archivo no especificada.');
      }
      response.result = await fs.promises.readFile(resolveStudentPath(data.path), 'utf8');
    } else if (data.action === 'write') {
      if (!data.path) {
        throw new Error('Ruta de archivo no especificada.');
      }
      await fs.promises.writeFile(resolveStudentPath(data.path), data.content || '', 'utf8');
      response.result = 'ok';
    } else if (data.action === 'upload') {
      if (!data.filename) {
        throw new Error('Nombre de archivo no especificado.');
      }
      const targetDir = resolveStudentPath(data.path || '');
      const targetPath = path.join(targetDir, data.filename);
      await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.promises.writeFile(targetPath, Buffer.from(data.data || '', 'base64'));
      response.result = 'ok';
    } else {
      throw new Error(`Acción desconocida: ${data.action}`);
    }
  } catch (err) {
    response.error = err.message;
  }

  if (studentSocket && studentSocket.connected) {
    studentSocket.emit('file-response', response);
  }
}

/**
 * Descarga un archivo del estudiante por streaming, enviando fragmentos
 * (chunks) separados en lugar de un único buffer completo, para no bloquear
 * el event loop de Socket.io ni provocar timeouts.
 */
async function handleFileDownload(requestId, userPath) {
  const sendError = (error) => {
    if (studentSocket && studentSocket.connected) {
      studentSocket.emit('file-response', {
        requestId,
        action: 'download',
        targetSocketId: 'teacher',
        error
      });
    }
  };

  if (!userPath) {
    sendError('Ruta de archivo no especificada.');
    return;
  }

  const filePath = resolveStudentPath(userPath);

  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) {
      sendError('La ruta no es un archivo.');
      return;
    }

    const filename = path.basename(filePath);
    const totalChunks = Math.max(1, Math.ceil(stat.size / FILE_CHUNK_SIZE));

    // Metadatos primero (sin contenido).
    if (studentSocket && studentSocket.connected) {
      studentSocket.emit('file-response', {
        requestId,
        action: 'download',
        targetSocketId: 'teacher',
        result: { filename, size: stat.size, chunked: true, totalChunks }
      });
    }

    // Streaming por fragmentos de FILE_CHUNK_SIZE bytes.
    let index = 0;
    const readStream = fs.createReadStream(filePath, { highWaterMark: FILE_CHUNK_SIZE });

    readStream.on('data', (chunk) => {
      if (studentSocket && studentSocket.connected) {
        studentSocket.emit('file-chunk', {
          requestId,
          index,
          data: chunk.toString('base64')
        });
        index += 1;
      }
    });

    readStream.on('end', () => {
      if (studentSocket && studentSocket.connected) {
        studentSocket.emit('file-chunk-end', {
          requestId,
          filename,
          totalChunks: index
        });
      }
    });

    readStream.on('error', (err) => {
      if (studentSocket && studentSocket.connected) {
        studentSocket.emit('file-chunk-end', {
          requestId,
          filename,
          totalChunks: index,
          error: err.message
        });
      }
    });
  } catch (err) {
    sendError(err.message);
  }
}

// ---------------------------------------------------------------------------
// Difusión masiva de archivos (Maestro -> todos los estudiantes)
// ---------------------------------------------------------------------------
/**
 * Lee de forma recursiva un archivo o carpeta local y devuelve un payload
 * listo para emitir por socket.io (cada archivo en base64).
 */
async function buildBroadcastPayload(paths) {
  const files = [];

  for (const p of paths) {
    const resolved = path.resolve(p);
    const stat = await fs.promises.stat(resolved);

    if (stat.isFile()) {
      const data = await fs.promises.readFile(resolved);
      files.push({ relPath: path.basename(resolved), data: data.toString('base64') });
    } else if (stat.isDirectory()) {
      await collectDirectoryFiles(resolved, resolved, files);
    } else {
      throw new Error(`La ruta "${resolved}" no es ni un archivo ni un directorio.`);
    }
  }

  return { files };
}

async function collectDirectoryFiles(root, dir, files) {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectDirectoryFiles(root, full, files);
    } else if (entry.isFile()) {
      const data = await fs.promises.readFile(full);
      files.push({
        relPath: path.relative(root, full),
        data: data.toString('base64')
      });
    }
  }
}

/**
 * Escribe en el estudiante los archivos recibidos por difusión masiva,
 * siempre bajo `os.homedir()/AulaControl/recibidos/<nombre>`.
 */
async function handleIncomingBroadcast(payload) {
  if (!payload || !Array.isArray(payload.files)) {
    return;
  }

  const destRel = String(payload.destination || '').trim();
  const baseDir = destRel
    ? path.join(os.homedir(), destRel)
    : path.join(os.homedir(), 'AulaControl', 'recibidos');
  let written = 0;
  const errors = [];

  for (const file of payload.files) {
    const targetPath = path.join(baseDir, file.relPath);
    try {
      await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.promises.writeFile(targetPath, Buffer.from(file.data, 'base64'));
      written += 1;
    } catch (err) {
      errors.push(`${file.relPath}: ${err.message}`);
    }
  }

  pushToRenderer('file-broadcast-received', {
    success: errors.length === 0,
    written,
    total: payload.files.length,
    destDir: baseDir,
    error: errors.length ? errors.join('; ') : null
  });
}

// ---------------------------------------------------------------------------
// Transiciones de rol
// ---------------------------------------------------------------------------
function startStudentMode() {
  role = 'student';

  // Cerrar ventanas de pantalla independientes.
  for (const win of screenWindows.values()) {
    if (!win.isDestroyed()) {
      win.close();
    }
  }
  screenWindows.clear();

  // Detener artefactos del modo maestro.
  if (radarBroadcaster) {
    radarBroadcaster.stop();
    radarBroadcaster = null;
  }
  if (masterServer) {
    masterServer.stop();
    masterServer = null;
  }

  // Iniciar listener de radar UDP.
  if (radarListener) {
    radarListener.stop();
  }
  radarListener = new RadarListener({
    instanceId,
    onMasterDiscovered: (masterInfo) => {
      pushToRenderer('radar-status', {
        status: 'discovered',
        masterIp: masterInfo.ip,
        masterPort: masterInfo.port
      });
      connectToMaster(masterInfo.ip, masterInfo.port);
    }
  });
  radarListener.start();

  pushToRenderer('radar-status', { status: 'searching' });
}

function startTeacherMode() {
  role = 'teacher';

  // Detener artefactos del modo estudiante.
  if (radarListener) {
    radarListener.stop();
    radarListener = null;
  }
  if (studentSocket) {
    studentSocket.removeAllListeners();
    studentSocket.disconnect();
    studentSocket = null;
  }
  connectedMasterUrl = null;

  // Iniciar servidor maestro (Express + Socket.io en puerto 3000).
  const configStorePath = path.join(app.getPath('userData'), 'config-store.json');
  masterServer = new MasterServer({ instanceId, port: MASTER_PORT, configStorePath });

  // Sincronizar el set local de dominios con la configuración persistente cargada.
  blockedDomains.clear();
  for (const d of (masterServer.config.blockedDomains || [])) {
    blockedDomains.add(d);
  }

  masterServer.on('student-list', (list) => {
    pushToRenderer('student-list-update', list);
  });
  masterServer.on('sync-global-state', (config) => {
    pushToRenderer('sync-global-state', config);
  });
  masterServer.on('chat-message', (message) => {
    appendChatMessage(message);
  });
  masterServer.on('screen-frame', (frame) => {
    pushToRenderer('screen-frame-update', frame);
  });
  masterServer.on('student-live-frame', (frame) => {
    const win = screenWindows.get(frame.socketId);
    if (win && !win.isDestroyed()) {
      win.webContents.send('student-live-frame', frame);
    }
  });
  masterServer.on('file-response', (response) => {
    pushToRenderer('file-response', response);
  });
  masterServer.on('file-chunk', (chunk) => {
    pushToRenderer('file-chunk', chunk);
  });
  masterServer.on('file-chunk-end', (end) => {
    pushToRenderer('file-chunk-end', end);
  });
  masterServer.on('screen-capture-error', (payload) => {
    const win = screenWindows.get(payload.studentSocketId);
    if (win && !win.isDestroyed()) {
      win.webContents.send('screen-capture-error', payload);
    }
  });

  masterServer.start().catch((err) => {
    console.error('[main] No se pudo iniciar el servidor maestro:', err.message);
  });

  // Iniciar emisor de radar UDP broadcast.
  radarBroadcaster = new RadarBroadcaster({ instanceId });
  radarBroadcaster.start();
}

// ---------------------------------------------------------------------------
// IPC (comunicación con la interfaz de usuario)
// ---------------------------------------------------------------------------
function registerIpcHandlers() {
  ipcMain.handle('get-initial-state', () => getPublicState());

  ipcMain.handle('login', (event, credentials) => {
    const username = credentials?.username;
    const password = credentials?.password;

    if (username === ADMIN_USER && password === ADMIN_PASS) {
      startTeacherMode();
      return { success: true, role: 'teacher' };
    }
    return { success: false, error: 'Credenciales incorrectas.' };
  });

  ipcMain.handle('logout', () => {
    startStudentMode();
    return { success: true, role: 'student' };
  });

  ipcMain.handle('send-chat', (event, text) => {
    const cleanText = String(text || '').trim();
    if (!cleanText) {
      return { success: false, error: 'Mensaje vacío.' };
    }

    const message = {
      id: `${Date.now()}-local`,
      sender: hostname,
      text: cleanText,
      timestamp: Date.now()
    };

    if (role === 'teacher' && masterServer) {
      // El maestro transmite a todos los estudiantes conectados.
      masterServer.io.emit('chat-message', message);
      appendChatMessage(message);
    } else if (role === 'student' && studentSocket && studentSocket.connected) {
      studentSocket.emit('send-chat-message', message);
    } else {
      appendChatMessage(message);
    }

    return { success: true };
  });

  ipcMain.handle('raise-hand', (event, raised) => {
    if (role === 'student' && studentSocket && studentSocket.connected) {
      studentSocket.emit('raise-hand', { raised: Boolean(raised) });
      return { success: true };
    }
    return { success: false, error: 'No conectado al maestro.' };
  });

  ipcMain.handle('lower-hand', (event, studentSocketId) => {
    if (role === 'teacher' && masterServer) {
      masterServer.lowerHand(studentSocketId);
      return { success: true };
    }
    return { success: false, error: 'Solo disponible en modo maestro.' };
  });

  ipcMain.handle('assign-custom-name', (event, payload) => {
    const instanceId = payload?.instanceId;
    const customName = payload?.customName;
    if (role === 'teacher' && masterServer && instanceId) {
      masterServer.assignCustomName(instanceId, customName);
      return { success: true };
    }
    return { success: false, error: 'Solo disponible en modo maestro.' };
  });

  ipcMain.handle('reapply-dns-rules', async (event, payload) => {
    const targetSocketId = payload?.targetSocketId || null;
    if (role === 'teacher' && masterServer) {
      await applyLocalAndBroadcastDns();
      masterServer.syncDns(getBlockedDomains(), targetSocketId);
      return { success: true, domains: getBlockedDomains() };
    }
    return { success: false, error: 'Solo disponible en modo maestro.' };
  });

  ipcMain.handle('update-config', (event, cfg) => {
    if (role === 'teacher' && masterServer) {
      masterServer.updateAndBroadcastState(cfg || {});
      return { success: true };
    }
    return { success: false, error: 'Solo disponible en modo maestro.' };
  });

  ipcMain.handle('request-student-list', () => {
    if (role === 'teacher' && masterServer) {
      // Fuerza la re-emisión manual de la lista.
      masterServer._emitStudentList();
      return { success: true, students: masterServer.getStudentList() };
    }
    return { success: false, students: [] };
  });

  ipcMain.handle('get-dns-state', () => {
    return { domains: getBlockedDomains() };
  });

  ipcMain.handle('add-dns-domain', async (event, rawDomain) => {
    const domain = normalizeDomain(rawDomain);
    if (!domain) {
      return { success: false, error: 'Dominio no especificado.' };
    }
    if (role !== 'teacher' || !masterServer) {
      return { success: false, error: 'Solo disponible en modo maestro.' };
    }
    return await addBlockedDomain(domain);
  });

  ipcMain.handle('remove-dns-domain', async (event, rawDomain) => {
    const domain = normalizeDomain(rawDomain);
    if (!domain) {
      return { success: false, error: 'Dominio no especificado.' };
    }
    if (role !== 'teacher' || !masterServer) {
      return { success: false, error: 'Solo disponible en modo maestro.' };
    }
    return await removeBlockedDomain(domain);
  });

  // ---------- Captura de pantalla (desktopCapturer de Electron) ----------
  ipcMain.handle('get-screen-sources', async () => {
    try {
      const primaryDisplayId = screen.getPrimaryDisplay().id;
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 320, height: 180 }
      });

      // Ordena la pantalla principal activa al inicio y marca cada fuente.
      const mapped = sources
        .map((source) => ({
          id: source.id,
          name: source.name,
          displayId: source.display_id,
          isPrimary: source.display_id === primaryDisplayId,
          thumbnailDataUrl: source.thumbnail && source.thumbnail.getSize().width > 0
            ? source.thumbnail.toDataURL()
            : null
        }))
        .sort((a, b) => (a.isPrimary === b.isPrimary ? 0 : (a.isPrimary ? -1 : 1)));

      if (mapped.length === 0) {
        return {
          sources: [],
          error: 'No se detectaron pantallas. Revisa el permiso de grabación de pantalla del sistema operativo.'
        };
      }

      return { sources: mapped, primaryDisplayId };
    } catch (err) {
      console.error('[main] Error al obtener fuentes de pantalla:', err.message);
      return {
        sources: [],
        error: 'No se pudo acceder a la captura de pantalla. Revisa el permiso de grabación de pantalla del sistema operativo.'
      };
    }
  });

  // ---------- Ventana independiente para pantalla de un estudiante ----------
  ipcMain.handle('open-student-screen-window', (event, payload) => {
    const socketId = payload?.socketId;
    const hostname = payload?.hostname || 'Estudiante';
    if (role !== 'teacher' || !masterServer || !socketId) {
      return { success: false, error: 'No disponible en este momento.' };
    }

    const existing = screenWindows.get(socketId);
    if (existing && !existing.isDestroyed()) {
      existing.focus();
      return { success: true, focused: true };
    }

    const win = new BrowserWindow({
      width: 1280,
      height: 720,
      title: `Pantalla: ${hostname}`,
      backgroundColor: '#000000',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        nodeIntegration: false,
        contextIsolation: true
      }
    });

    win.loadFile(path.join(__dirname, 'src', 'ui', 'screen.html'));
    screenWindows.set(socketId, win);

    win.on('closed', () => {
      screenWindows.delete(socketId);
      if (masterServer) {
        masterServer.io.to(socketId).emit('live-watch-stop');
      }
    });

    // Inicia la transmisión en vivo del estudiante.
    masterServer.io.to(socketId).emit('live-watch-start');
    return { success: true };
  });

  ipcMain.handle('send-live-frame', (event, dataUrl) => {
    if (role === 'student' && studentSocket && studentSocket.connected) {
      studentSocket.emit('student-live-frame', { dataUrl: String(dataUrl || '') });
      return { success: true };
    }
    return { success: false, error: 'No hay conexión activa.' };
  });

  // ---------- Gestor de archivos remotos ----------
  ipcMain.handle('file-command', (event, command) => {
    const targetSocketId = command?.targetSocketId;
    const action = command?.action;
    const requestId = command?.requestId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    if (!targetSocketId || !action) {
      return { success: false, error: 'Comando incompleto.' };
    }

    if (role === 'teacher' && masterServer) {
      masterServer.io.to(targetSocketId).emit('file-command', {
        fromSocketId: 'teacher',
        requestId,
        action,
        path: command.path,
        content: command.content,
        filename: command.filename,
        data: command.data
      });
      return { success: true, requestId };
    }

    return { success: false, error: 'Solo disponible en modo maestro.' };
  });

  // ---------- Difusión masiva de archivos (Maestro -> todos los estudiantes) ----------
  ipcMain.handle('broadcast-file', async (event, payload) => {
    const paths = (payload && Array.isArray(payload.paths)) ? payload.paths : [];
    const destination = String((payload && payload.destination) || '').trim();

    if (paths.length === 0) {
      return { success: false, error: 'No se seleccionaron archivos o carpetas.' };
    }
    if (role !== 'teacher' || !masterServer) {
      return { success: false, error: 'Solo disponible en modo maestro.' };
    }

    try {
      const broadcastPayload = await buildBroadcastPayload(paths);
      const studentCount = masterServer.connectedStudents.size;
      if (studentCount === 0) {
        return { success: false, error: 'No hay estudiantes conectados.' };
      }
      masterServer.io.emit('broadcast-file', {
        destination,
        files: broadcastPayload.files
      });
      return {
        success: true,
        files: broadcastPayload.files.length,
        students: studentCount,
        destination
      };
    } catch (err) {
      return { success: false, error: `No se pudo leer la ruta: ${err.message}` };
    }
  });

  // ---------- Selección de rutas (archivos/carpetas) para difusión masiva ----------
  ipcMain.handle('select-paths', async () => {
    if (role !== 'teacher') {
      return { success: false, paths: [] };
    }
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Seleccionar archivos o carpetas',
      properties: ['openFile', 'openDirectory', 'multiSelections']
    });
    if (result.canceled) {
      return { success: false, paths: [] };
    }
    return { success: true, paths: result.filePaths };
  });

  // ---------- Guardar archivo descargado (diálogo nativo de guardar) ----------
  ipcMain.handle('save-downloaded-file', async (event, payload) => {
    const filename = path.basename(String((payload && payload.filename) || 'archivo'));
    const data = (payload && payload.data) || '';
    if (!data) {
      return { success: false, error: 'Sin datos para guardar.' };
    }

    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Guardar archivo descargado',
      defaultPath: path.join(app.getPath('downloads'), filename),
      buttonLabel: 'Guardar'
    });

    if (result.canceled || !result.filePath) {
      return { canceled: true };
    }

    try {
      await fs.promises.writeFile(result.filePath, Buffer.from(data, 'base64'));
      return { success: true, path: result.filePath };
    } catch (err) {
      return { success: false, error: `No se pudo guardar: ${err.message}` };
    }
  });

  // ---------- Miniatura de pantalla generada en el renderer (canvas/JPEG) ----------
  ipcMain.handle('send-thumbnail-frame', (event, dataUrl) => {
    if (role === 'student' && studentSocket && studentSocket.connected) {
      studentSocket.emit('student-screen-frame', { dataUrl: String(dataUrl || '') });
      return { success: true };
    }
    return { success: false, error: 'No hay conexión activa.' };
  });

  // ---------- Reporte de error de captura de pantalla (estudiante -> maestro) ----------
  ipcMain.handle('report-screen-capture-error', (event, reason) => {
    if (role === 'student' && studentSocket && studentSocket.connected) {
      studentSocket.emit('screen-capture-error', {
        reason: String(reason || 'Error de captura de pantalla.')
      });
      return { success: true };
    }
    return { success: false, error: 'No hay conexión activa.' };
  });
}

// ---------------------------------------------------------------------------
// Ciclo de vida de Electron
// ---------------------------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: 'Aula Control',
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'ui', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  registerIpcHandlers();
  startStudentMode();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  for (const win of screenWindows.values()) {
    if (!win.isDestroyed()) {
      win.close();
    }
  }
  screenWindows.clear();
  if (radarListener) {
    radarListener.stop();
  }
  if (radarBroadcaster) {
    radarBroadcaster.stop();
  }
  if (studentSocket) {
    studentSocket.removeAllListeners();
    studentSocket.disconnect();
  }
  if (masterServer) {
    masterServer.stop();
  }
});
