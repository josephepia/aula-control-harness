/**
 * Aula Control — Lógica de la interfaz (proceso de renderizado).
 * Interactúa exclusivamente con el proceso principal a través de
 * `window.aulaControl` (expuesta por preload.js).
 */
(function () {
  'use strict';

  const api = window.aulaControl;

  // ---------------------------------------------------------------------------
  // Estado de la interfaz
  // ---------------------------------------------------------------------------
  const state = {
    role: 'student',
    instanceId: null,
    hostname: null
  };

  let isGridView = true;
  let handRaised = false;
  let students = [];
  let blockedDomains = [];
  let broadcastSelectedPaths = [];
  let activeTeacherTab = 'students';

  // Streaming WebRTC
  const livePeers = new Map(); // Maestro: studentSocketId -> RTCPeerConnection
  let studentPc = null;        // Estudiante: conexión WebRTC hacia el maestro
  let studentStream = null;    // Estudiante: flujo de pantalla compartida

  // Captura de fondo (miniaturas por canvas/JPEG + reuso en WebRTC)
  let backgroundStream = null;
  let thumbnailTimer = null;
  let thumbnailVideo = null;
  const thumbnailCanvas = document.createElement('canvas');

  // Gestor de archivos remoto
  const fileManager = {
    studentSocketId: null,
    currentPath: '',
    currentFile: null
  };
  const pendingFileRequests = new Map();

  // ---------------------------------------------------------------------------
  // Referencias al DOM
  // ---------------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);

  const roleBadge = $('role-badge');
  const hostnameLabel = $('hostname-label');
  const btnOpenLogin = $('btn-open-login');
  const btnLogout = $('btn-logout');

  const studentView = $('student-view');
  const teacherView = $('teacher-view');

  const radarDot = $('radar-dot');
  const radarText = $('radar-text');
  const btnRaiseHand = $('btn-raise-hand');
  const sharingBanner = $('sharing-banner');
  const btnStopShare = $('btn-stop-share');
  const broadcastNotice = $('broadcast-notice');
  const broadcastNoticeText = $('broadcast-notice-text');
  const chatMessages = $('chat-messages');
  const chatInput = $('chat-input');
  const btnSendChat = $('btn-send-chat');

  const btnRefreshList = $('btn-refresh-list');
  const btnToggleView = $('btn-toggle-view');
  const studentCount = $('student-count');
  const studentsContainer = $('students-container');
  const studentsEmpty = $('students-empty');

  const dnsInput = $('dns-input');
  const btnAddDns = $('btn-add-dns');
  const dnsChips = $('dns-chips');
  const dnsEmpty = $('dns-empty');
  const dnsFeedback = $('dns-feedback');

  const tabStudents = $('tab-students');
  const tabBroadcast = $('tab-broadcast');
  const studentsTab = $('students-tab');
  const broadcastTab = $('broadcast-tab');
  const studentsToolbar = $('students-toolbar');

  const broadcastDropzone = $('broadcast-dropzone');
  const btnSelectPaths = $('btn-select-paths');
  const broadcastFiles = $('broadcast-files');
  const broadcastFilesEmpty = $('broadcast-files-empty');
  const broadcastDest = $('broadcast-dest');
  const btnBroadcastSend = $('btn-broadcast-send');
  const broadcastStatus = $('broadcast-status');

  const teacherChatMessages = $('teacher-chat-messages');
  const teacherChatInput = $('teacher-chat-input');
  const btnTeacherSendChat = $('btn-teacher-send-chat');

  const loginModal = $('login-modal');
  const loginUser = $('login-user');
  const loginPass = $('login-pass');
  const loginError = $('login-error');
  const btnCancelLogin = $('btn-cancel-login');
  const btnSubmitLogin = $('btn-submit-login');

  const liveModal = $('live-modal');
  const liveVideo = $('live-video');
  const liveTitle = $('live-title');
  const liveStatus = $('live-status');
  const btnCloseLive = $('btn-close-live');

  const filesModal = $('files-modal');
  const filesPath = $('files-path');
  const btnFilesList = $('btn-files-list');
  const btnFilesUp = $('btn-files-up');
  const filesListing = $('files-listing');
  const filesEditor = $('files-editor');
  const filesStatus = $('files-status');
  const filesEditorActions = $('files-editor-actions');
  const btnFilesSave = $('btn-files-save');
  const btnFilesCloseEditor = $('btn-files-close-editor');
  const btnCloseFiles = $('btn-close-files');
  const btnFilesUpload = $('btn-files-upload');
  const uploadFileInput = $('upload-file-input');

  // ---------------------------------------------------------------------------
  // Utilidades
  // ---------------------------------------------------------------------------
  function formatTime(timestamp) {
    const date = new Date(timestamp || Date.now());
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function joinPath(base, name) {
    if (!base) return name;
    return base.endsWith('/') ? base + name : base + '/' + name;
  }

  function parentPath(p) {
    const parts = String(p || '').replace(/\/+$/, '').split('/').filter(Boolean);
    parts.pop();
    return parts.join('/');
  }

  function showToast(message, kind) {
    dnsFeedback.textContent = message;
    dnsFeedback.className = `toast ${kind === 'error' ? 'error' : 'success'}`;
    dnsFeedback.classList.remove('hidden');
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => dnsFeedback.classList.add('hidden'), 4000);
  }

  // ---------------------------------------------------------------------------
  // Chat
  // ---------------------------------------------------------------------------
  function renderChatMessage(message) {
    for (const container of [chatMessages, teacherChatMessages]) {
      container.appendChild(buildChatElement(message));
      container.scrollTop = container.scrollHeight;
    }
  }

  function buildChatElement(message) {
    const div = document.createElement('div');
    const isOwn = message.sender === state.hostname;
    div.className = `chat-message${isOwn ? ' own' : ''}`;
    div.innerHTML = `
      <div class="meta">${escapeHtml(message.sender || 'Desconocido')} · ${formatTime(message.timestamp)}</div>
      <div>${escapeHtml(message.text || '')}</div>
    `;
    return div;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function sendChatFrom(input) {
    const text = input.value.trim();
    if (!text) return;
    api.sendChat(text);
    input.value = '';
  }

  // ---------------------------------------------------------------------------
  // Estado del radar (estudiante)
  // ---------------------------------------------------------------------------
  function setRadarStatus(status, masterIp, masterPort) {
    radarDot.className = 'dot';
    switch (status) {
      case 'connected':
        radarDot.classList.add('dot-connected');
        radarText.textContent = `Conectado al maestro en ${masterIp}:${masterPort}`;
        break;
      case 'discovered':
        radarDot.classList.add('dot-discovered');
        radarText.textContent = `Maestro detectado en ${masterIp}:${masterPort}, conectando…`;
        break;
      case 'searching':
      default:
        radarDot.classList.add('dot-searching');
        radarText.textContent = 'Buscando maestro en la red local…';
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Cambio de rol (vistas)
  // ---------------------------------------------------------------------------
  function switchToStudentView() {
    state.role = 'student';
    roleBadge.textContent = 'Estudiante';
    roleBadge.className = 'badge badge-student';
    teacherView.classList.add('hidden');
    studentView.classList.remove('hidden');
    btnOpenLogin.classList.remove('hidden');
    btnLogout.classList.add('hidden');
    closeLiveView();
    stopStudentShare();
    stopBackgroundCapture();
  }

  function switchToTeacherView() {
    state.role = 'teacher';
    roleBadge.textContent = 'Maestro';
    roleBadge.className = 'badge badge-teacher';
    studentView.classList.add('hidden');
    teacherView.classList.remove('hidden');
    btnOpenLogin.classList.add('hidden');
    btnLogout.classList.remove('hidden');
    stopStudentShare();
    stopBackgroundCapture();
    switchTeacherTab('students');
    refreshStudentList();
    loadDnsDomains();
  }

  // ---------------------------------------------------------------------------
  // Vista maestro: lista de estudiantes
  // ---------------------------------------------------------------------------
  function renderStudents() {
    studentsContainer.innerHTML = '';
    studentsContainer.className = isGridView ? 'students-grid' : 'students-list';

    const hasStudents = students && students.length > 0;
    studentsEmpty.classList.toggle('hidden', hasStudents);
    studentCount.textContent = hasStudents
      ? `${students.length} estudiante${students.length === 1 ? '' : 's'} conectado${students.length === 1 ? '' : 's'}`
      : '';

    for (const student of students) {
      studentsContainer.appendChild(renderStudentCard(student));
    }
  }

  function renderStudentCard(student) {
    const card = document.createElement('div');
    card.className = `student-card${student.handRaised ? ' hand-raised' : ''}`;
    card.dataset.socketId = student.socketId;

    const thumbContent = student.screenFrame
      ? `<img src="${student.screenFrame}" alt="pantalla" />`
      : '<span>Sin transmisión</span>';

    card.innerHTML = `
      <div class="student-card-header">
        <span class="name">${escapeHtml(student.hostname)}</span>
        ${student.handRaised ? '<span class="hand-badge">✋ Mano alzada</span>' : ''}
      </div>
      <div class="student-meta">
        <span>IP: ${escapeHtml(student.ip)}</span>
        <span>Conectado: ${formatTime(student.connectedAt)}</span>
      </div>
      <div class="thumbnail">${thumbContent}</div>
      <div class="student-card-actions">
        <button class="btn btn-live" data-action="live">🖥️ Ver pantalla</button>
        <button class="btn btn-secondary" data-action="files">📁 Archivos</button>
      </div>
    `;

    card.querySelector('[data-action="live"]').addEventListener('click', () => startLiveView(student));
    card.querySelector('[data-action="files"]').addEventListener('click', () => openFileManager(student.socketId));

    return card;
  }

  function updateThumbnail(socketId, dataUrl) {
    const card = studentsContainer.querySelector(`[data-socket-id="${socketId}"]`);
    if (!card) return;
    const thumb = card.querySelector('.thumbnail');
    if (thumb && dataUrl) {
      thumb.innerHTML = `<img src="${dataUrl}" alt="pantalla" />`;
    }
    const student = students.find((s) => s.socketId === socketId);
    if (student) {
      student.screenFrame = dataUrl;
    }
  }

  async function refreshStudentList() {
    const result = await api.requestStudentList();
    if (result && result.students) {
      students = result.students;
      renderStudents();
    }
  }

  // ---------------------------------------------------------------------------
  // Vista maestro: Bloqueo DNS (lista interactiva de dominios con chips)
  // ---------------------------------------------------------------------------
  async function loadDnsDomains() {
    const result = await api.getDnsDomains();
    blockedDomains = (result && result.domains) || [];
    renderDnsChips();
  }

  function renderDnsChips() {
    dnsChips.innerHTML = '';
    dnsEmpty.classList.toggle('hidden', blockedDomains.length > 0);

    for (const domain of blockedDomains) {
      const chip = document.createElement('span');
      chip.className = 'dns-chip';
      chip.innerHTML = `
        <span>${escapeHtml(domain)}</span>
        <button class="chip-remove" title="Quitar bloqueo">×</button>
      `;
      chip.querySelector('.chip-remove').addEventListener('click', () => removeDnsDomain(domain));
      dnsChips.appendChild(chip);
    }
  }

  async function addDnsDomain() {
    const domain = dnsInput.value.trim();
    if (!domain) {
      showToast('Escribe un dominio para bloquear.', 'error');
      return;
    }

    const result = await api.addDnsDomain(domain);
    if (result && result.success) {
      blockedDomains = result.domains || [];
      dnsInput.value = '';
      renderDnsChips();
      showToast(`Dominio "${domain}" bloqueado.`, 'success');
    } else {
      showToast(result && result.error ? result.error : 'Error al bloquear el dominio.', 'error');
    }
  }

  async function removeDnsDomain(domain) {
    const result = await api.removeDnsDomain(domain);
    if (result && result.success) {
      blockedDomains = result.domains || [];
      renderDnsChips();
      showToast(`Dominio "${domain}" desbloqueado.`, 'success');
    } else {
      showToast(result && result.error ? result.error : 'Error al desbloquear el dominio.', 'error');
    }
  }

  // ---------------------------------------------------------------------------
  // WebRTC: maestro inicia la visualización en vivo (modal flotante amplio)
  // ---------------------------------------------------------------------------
  async function startLiveView(student) {
    closeLiveView();

    const socketId = student.socketId;
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });
    livePeers.set(socketId, pc);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        api.sendWebrtcSignal(socketId, { candidate: event.candidate });
      }
    };

    pc.ontrack = (event) => {
      liveVideo.srcObject = event.streams[0] || new MediaStream([event.track]);
      liveStatus.classList.add('hidden');
    };

    pc.onconnectionstatechange = () => {
      if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
        closeLiveView();
      }
    };

    try {
      const offer = await pc.createOffer({ offerToReceiveVideo: true, offerToReceiveAudio: false });
      await pc.setLocalDescription(offer);
      await api.sendWebrtcSignal(socketId, { sdp: offer });
      showLiveModal(student.hostname);
    } catch (err) {
      console.error('[ui] Error al iniciar la visualización:', err);
      closeLiveView();
    }
  }

  function closeLiveView() {
    for (const pc of livePeers.values()) {
      try { pc.close(); } catch (err) { /* ignore */ }
    }
    livePeers.clear();
    liveVideo.srcObject = null;
    liveModal.classList.add('hidden');
  }

  function showLiveModal(studentHostname) {
    liveTitle.textContent = `🖥️ Pantalla: ${studentHostname || 'Estudiante'}`;
    liveStatus.textContent = 'Solicitando pantalla del estudiante…';
    liveStatus.classList.remove('error-text');
    liveStatus.classList.remove('hidden');
    liveVideo.srcObject = null;
    liveModal.classList.remove('hidden');
  }

  // ---------------------------------------------------------------------------
  // WebRTC: estudiante responde compartiendo su pantalla
  // ---------------------------------------------------------------------------
  /**
   * Obtiene el flujo de pantalla del estudiante usando desktopCapturer de
   * Electron (solicitado al proceso principal vía IPC) y getUserMedia con
   * chromeMediaSource='desktop' + chromeMediaSourceId.
   */
  async function getStudentScreenStream() {
    const result = await api.getScreenSources();
    if (result && result.error) {
      throw new Error(result.error);
    }

    const sources = (result && result.sources) || [];
    if (sources.length === 0) {
      throw new Error('No se encontraron pantallas para capturar. Revisa el permiso de grabación de pantalla del sistema operativo.');
    }

    // Selecciona la pantalla principal activa (marcada por el proceso principal).
    const primarySource = sources.find((source) => source.isPrimary) || sources[0];
    const sourceId = primarySource.id;

    return await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
          maxFrameRate: 30
        }
      }
    });
  }

  // --- Captura de fondo para miniaturas (canvas -> JPEG) y reuso en WebRTC ---
  async function startBackgroundCapture() {
    if (backgroundStream) {
      return;
    }
    try {
      backgroundStream = await getStudentScreenStream();
      const track = backgroundStream.getVideoTracks()[0];
      if (track) {
        track.addEventListener('ended', () => stopBackgroundCapture());
      }
      setupThumbnailVideo(backgroundStream);
      startThumbnailLoop();
    } catch (err) {
      console.error('[ui] No se pudo iniciar la captura de fondo:', err);
    }
  }

  function setupThumbnailVideo(stream) {
    if (!thumbnailVideo) {
      thumbnailVideo = document.createElement('video');
      thumbnailVideo.muted = true;
      thumbnailVideo.playsInline = true;
      thumbnailVideo.style.display = 'none';
      document.body.appendChild(thumbnailVideo);
    }
    if (thumbnailVideo.srcObject !== stream) {
      thumbnailVideo.srcObject = stream;
      thumbnailVideo.play().catch(() => {});
    }
  }

  function startThumbnailLoop() {
    stopThumbnailLoop();
    thumbnailTimer = setInterval(() => {
      const frame = captureThumbnailFrame();
      if (frame) {
        api.sendThumbnailFrame(frame);
      }
    }, 2000);
  }

  function stopThumbnailLoop() {
    if (thumbnailTimer) {
      clearInterval(thumbnailTimer);
      thumbnailTimer = null;
    }
  }

  function captureThumbnailFrame() {
    if (!thumbnailVideo || !thumbnailVideo.videoWidth) {
      return null;
    }
    const scale = Math.min(1, 320 / thumbnailVideo.videoWidth);
    const width = Math.max(1, Math.round(thumbnailVideo.videoWidth * scale));
    const height = Math.max(1, Math.round(thumbnailVideo.videoHeight * scale));
    thumbnailCanvas.width = width;
    thumbnailCanvas.height = height;
    thumbnailCanvas.getContext('2d').drawImage(thumbnailVideo, 0, 0, width, height);
    return thumbnailCanvas.toDataURL('image/jpeg', 0.6);
  }

  function stopBackgroundCapture() {
    stopThumbnailLoop();
    if (backgroundStream) {
      for (const track of backgroundStream.getTracks()) {
        track.stop();
      }
      backgroundStream = null;
    }
    if (thumbnailVideo) {
      thumbnailVideo.srcObject = null;
    }
  }

  async function startStudentShare(offerSdp) {
    await stopStudentShare();

    // Reutiliza la captura de fondo (miniaturas) si existe; si no, la crea.
    if (!backgroundStream) {
      await startBackgroundCapture();
    }
    if (!backgroundStream) {
      notifyCaptureError('No se pudo iniciar la captura de pantalla.');
      return;
    }

    const stream = backgroundStream;
    studentStream = stream;
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });
    studentPc = pc;

    for (const track of stream.getTracks()) {
      pc.addTrack(track, stream);
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        api.sendWebrtcSignal('teacher', { candidate: event.candidate });
      }
    };

    pc.onconnectionstatechange = () => {
      if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
        stopStudentShare();
      }
    };

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offerSdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await api.sendWebrtcSignal('teacher', { sdp: answer });
      sharingBanner.classList.remove('hidden');
    } catch (err) {
      console.error('[ui] Error al compartir pantalla:', err);
      await stopStudentShare();
    }
  }

  function stopStudentShare() {
    if (studentPc) {
      try { studentPc.close(); } catch (err) { /* ignore */ }
      studentPc = null;
    }
    studentStream = null; // No detiene tracks: pertenecen a la captura de fondo.
    sharingBanner.classList.add('hidden');
  }

  function showStudentNotice(text) {
    broadcastNoticeText.textContent = text || '';
    broadcastNotice.classList.remove('hidden');
    clearTimeout(showStudentNotice._timer);
    showStudentNotice._timer = setTimeout(() => broadcastNotice.classList.add('hidden'), 8000);
  }

  function notifyCaptureError(reason) {
    showStudentNotice(`⚠️ ${reason}`);
    api.reportScreenCaptureError(reason);
  }

  // ---------------------------------------------------------------------------
  // Gestor de archivos remoto
  // ---------------------------------------------------------------------------
  function waitForFileResponse(requestId, timeoutMs = 15000) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingFileRequests.delete(requestId);
        resolve({ error: 'Tiempo de espera agotado.' });
      }, timeoutMs);
      pendingFileRequests.set(requestId, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
    });
  }

  function setFilesStatus(message, isError) {
    filesStatus.textContent = message || '';
    filesStatus.className = `muted${isError ? ' error-text' : ''}`;
  }

  async function listRemoteDirectory(dirPath) {
    const result = await api.fileCommand({
      targetSocketId: fileManager.studentSocketId,
      action: 'list',
      path: dirPath
    });

    if (!result || !result.success) {
      setFilesStatus(result && result.error ? result.error : 'Error al listar.', true);
      return;
    }

    setFilesStatus('Solicitando listado…', false);
    const response = await waitForFileResponse(result.requestId);

    if (response.error) {
      setFilesStatus(response.error, true);
      return;
    }

    fileManager.currentPath = dirPath || '';
    filesPath.value = dirPath || '';
    renderFileListing(response.result || []);
    setFilesStatus('', false);
  }

  function renderFileListing(entries) {
    filesListing.innerHTML = '';
    filesListing.classList.remove('hidden');
    filesEditor.classList.add('hidden');
    filesEditorActions.classList.add('hidden');

    for (const entry of entries) {
      const li = document.createElement('li');
      li.className = 'file-entry';
      const icon = entry.isDirectory ? '📁' : '📄';
      li.innerHTML = `<span>${icon}</span><span class="file-name">${escapeHtml(entry.name)}</span>`;

      const targetPath = joinPath(fileManager.currentPath, entry.name);

      if (entry.isDirectory) {
        li.addEventListener('click', () => listRemoteDirectory(targetPath));
      } else {
        // Archivo: clic = descargar; botones = editar / descargar.
        const actions = document.createElement('span');
        actions.className = 'file-actions';

        const editBtn = document.createElement('button');
        editBtn.className = 'file-action';
        editBtn.title = 'Editar';
        editBtn.textContent = '✏️';
        editBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          readRemoteFile(targetPath);
        });

        const dlBtn = document.createElement('button');
        dlBtn.className = 'file-action';
        dlBtn.title = 'Descargar';
        dlBtn.textContent = '⬇️';
        dlBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          downloadRemoteFile(targetPath);
        });

        actions.appendChild(editBtn);
        actions.appendChild(dlBtn);
        li.appendChild(actions);

        li.addEventListener('click', () => downloadRemoteFile(targetPath));
      }

      filesListing.appendChild(li);
    }
  }

  async function readRemoteFile(filePath) {
    const result = await api.fileCommand({
      targetSocketId: fileManager.studentSocketId,
      action: 'read',
      path: filePath
    });

    if (!result || !result.success) {
      setFilesStatus(result && result.error ? result.error : 'Error al leer.', true);
      return;
    }

    setFilesStatus('Leyendo archivo…', false);
    const response = await waitForFileResponse(result.requestId);

    if (response.error) {
      setFilesStatus(response.error, true);
      return;
    }

    fileManager.currentFile = filePath;
    filesEditor.value = response.result || '';
    filesListing.classList.add('hidden');
    filesEditor.classList.remove('hidden');
    filesEditorActions.classList.remove('hidden');
    setFilesStatus(filePath, false);
  }

  async function saveRemoteFile() {
    const result = await api.fileCommand({
      targetSocketId: fileManager.studentSocketId,
      action: 'write',
      path: fileManager.currentFile,
      content: filesEditor.value
    });

    if (!result || !result.success) {
      setFilesStatus(result && result.error ? result.error : 'Error al guardar.', true);
      return;
    }

    setFilesStatus('Guardando…', false);
    const response = await waitForFileResponse(result.requestId);

    if (response.error) {
      setFilesStatus(response.error, true);
    } else {
      setFilesStatus('Archivo guardado correctamente.', false);
    }
  }

  function closeFileEditor() {
    fileManager.currentFile = null;
    filesEditor.value = '';
    filesEditor.classList.add('hidden');
    filesEditorActions.classList.add('hidden');
    filesListing.classList.remove('hidden');
    setFilesStatus('', false);
  }

  async function downloadRemoteFile(filePath) {
    setFilesStatus(`Descargando "${filePath}"…`, false);

    const result = await api.fileCommand({
      targetSocketId: fileManager.studentSocketId,
      action: 'download',
      path: filePath
    });

    if (!result || !result.success) {
      setFilesStatus(result && result.error ? result.error : 'Error al descargar.', true);
      return;
    }

    const response = await waitForFileResponse(result.requestId);
    if (response.error) {
      setFilesStatus(response.error, true);
      return;
    }

    const saved = await api.saveToDownloads(response.result.filename, response.result.data);
    if (saved && saved.success) {
      setFilesStatus(`Descargado en ${saved.path}`, false);
    } else {
      setFilesStatus(saved && saved.error ? saved.error : 'Error al guardar la descarga.', true);
    }
  }

  function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result || '');
        const base64 = dataUrl.split(',')[1] || '';
        resolve(base64);
      };
      reader.onerror = () => reject(new Error('No se pudo leer el archivo local.'));
      reader.readAsDataURL(file);
    });
  }

  async function handleUploadFile() {
    const file = uploadFileInput.files[0];
    uploadFileInput.value = '';
    if (!file) {
      return;
    }

    setFilesStatus(`Subiendo "${file.name}"…`, false);
    try {
      const data = await readFileAsBase64(file);
      const result = await api.fileCommand({
        targetSocketId: fileManager.studentSocketId,
        action: 'upload',
        path: fileManager.currentPath,
        filename: file.name,
        data
      });

      if (!result || !result.success) {
        setFilesStatus(result && result.error ? result.error : 'Error al subir.', true);
        return;
      }

      const response = await waitForFileResponse(result.requestId);
      if (response.error) {
        setFilesStatus(response.error, true);
      } else {
        setFilesStatus(`"${file.name}" subido correctamente.`, false);
        await listRemoteDirectory(fileManager.currentPath);
      }
    } catch (err) {
      setFilesStatus(err && err.message ? err.message : 'Error al subir el archivo.', true);
    }
  }

  async function openFileManager(studentSocketId) {
    fileManager.studentSocketId = studentSocketId;
    fileManager.currentPath = '';
    fileManager.currentFile = null;
    filesPath.value = '';
    closeFileEditor();
    filesModal.classList.remove('hidden');
    await listRemoteDirectory('');
  }

  // ---------------------------------------------------------------------------
  // Pestañas del Maestro
  // ---------------------------------------------------------------------------
  function switchTeacherTab(tab) {
    activeTeacherTab = tab;
    const isStudents = tab === 'students';

    studentsTab.classList.toggle('hidden', !isStudents);
    broadcastTab.classList.toggle('hidden', isStudents);
    studentsToolbar.classList.toggle('hidden', !isStudents);

    tabStudents.classList.toggle('active', isStudents);
    tabStudents.classList.toggle('btn-secondary', !isStudents);
    tabBroadcast.classList.toggle('active', !isStudents);
    tabBroadcast.classList.toggle('btn-secondary', isStudents);
  }

  // ---------------------------------------------------------------------------
  // Difusión masiva de archivos (Maestro -> todos los estudiantes)
  // ---------------------------------------------------------------------------
  function renderBroadcastFiles() {
    broadcastFiles.innerHTML = '';
    broadcastFilesEmpty.classList.toggle('hidden', broadcastSelectedPaths.length > 0);

    for (const p of broadcastSelectedPaths) {
      const li = document.createElement('li');
      li.className = 'broadcast-file-item';
      li.innerHTML = `<span title="${escapeHtml(p)}">${escapeHtml(p)}</span>`;

      const removeBtn = document.createElement('button');
      removeBtn.className = 'chip-remove';
      removeBtn.title = 'Quitar';
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', () => {
        broadcastSelectedPaths = broadcastSelectedPaths.filter((x) => x !== p);
        renderBroadcastFiles();
      });

      li.appendChild(removeBtn);
      broadcastFiles.appendChild(li);
    }
  }

  function addBroadcastPaths(paths) {
    for (const p of paths) {
      if (p && !broadcastSelectedPaths.includes(p)) {
        broadcastSelectedPaths.push(p);
      }
    }
    renderBroadcastFiles();
  }

  async function selectBroadcastPaths() {
    const result = await api.selectPaths();
    if (result && result.success && result.paths.length > 0) {
      addBroadcastPaths(result.paths);
    }
  }

  function setupDragAndDrop() {
    broadcastDropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      broadcastDropzone.classList.add('dragover');
    });
    broadcastDropzone.addEventListener('dragleave', () => {
      broadcastDropzone.classList.remove('dragover');
    });
    broadcastDropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      broadcastDropzone.classList.remove('dragover');
      const paths = [];
      for (const file of e.dataTransfer.files) {
        const p = api.getPathForFile(file);
        if (p) {
          paths.push(p);
        }
      }
      addBroadcastPaths(paths);
    });
  }

  async function sendBroadcast() {
    if (broadcastSelectedPaths.length === 0) {
      broadcastStatus.textContent = 'Selecciona al menos un archivo o carpeta.';
      broadcastStatus.className = 'muted error-text';
      return;
    }

    const destination = broadcastDest.value.trim();
    broadcastStatus.textContent = 'Enviando a todos los estudiantes…';
    broadcastStatus.className = 'muted';

    const result = await api.broadcastFile({ paths: broadcastSelectedPaths, destination });
    if (result && result.success) {
      broadcastStatus.textContent = `Enviado: ${result.files} archivo(s) a ${result.students} estudiante(s)${destination ? ` → ${destination}` : ''}.`;
      broadcastStatus.className = 'muted';
    } else {
      broadcastStatus.textContent = result && result.error ? result.error : 'Error al enviar.';
      broadcastStatus.className = 'muted error-text';
    }
  }

  // ---------------------------------------------------------------------------
  // Enrutado de señales WebRTC entrantes
  // ---------------------------------------------------------------------------
  function handleWebrtcSignal(fromSocketId, signal) {
    if (state.role === 'teacher') {
      const pc = livePeers.get(fromSocketId);
      if (!pc) return;
      if (signal.sdp) {
        pc.setRemoteDescription(new RTCSessionDescription(signal.sdp)).catch((err) => {
          console.error('[ui] Error SDP (maestro):', err);
        });
      } else if (signal.candidate) {
        pc.addIceCandidate(new RTCIceCandidate(signal.candidate)).catch((err) => {
          console.error('[ui] Error ICE (maestro):', err);
        });
      }
    } else if (state.role === 'student') {
      if (signal.sdp && signal.sdp.type === 'offer') {
        startStudentShare(signal.sdp);
      } else if (signal.candidate && studentPc) {
        studentPc.addIceCandidate(new RTCIceCandidate(signal.candidate)).catch(() => {});
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Suscripciones a eventos del proceso principal
  // ---------------------------------------------------------------------------
  function subscribeToEvents() {
    api.on('chat-message', (message) => renderChatMessage(message));

    api.on('radar-status', (status) => {
      setRadarStatus(status.status, status.masterIp, status.masterPort);
      if (status.status === 'connected') {
        startBackgroundCapture();
      } else {
        stopBackgroundCapture();
      }
    });

    api.on('student-list-update', (list) => {
      students = list || [];
      renderStudents();
    });

    api.on('screen-frame-update', (frame) => {
      updateThumbnail(frame.socketId, frame.dataUrl);
    });

    api.on('webrtc-signal', (payload) => {
      handleWebrtcSignal(payload.fromSocketId, payload.signal);
    });

    api.on('file-response', (response) => {
      const resolver = pendingFileRequests.get(response.requestId);
      if (resolver) {
        pendingFileRequests.delete(response.requestId);
        resolver(response);
      }
    });

    api.on('file-broadcast-received', (info) => {
      if (state.role === 'student') {
        const text = info.success
          ? `📥 Se recibieron ${info.written} archivo(s) del maestro en ${info.destDir}.`
          : `⚠️ Error al recibir archivos: ${info.error}`;
        showStudentNotice(text);
      }
    });

    api.on('screen-capture-error', (payload) => {
      if (state.role === 'teacher') {
        liveStatus.textContent = `El estudiante "${payload.hostname || 'Desconocido'}" no pudo compartir pantalla: ${payload.reason}`;
        liveStatus.classList.add('error-text');
        liveStatus.classList.remove('hidden');
      }
    });

    api.on('dns-command-result', (result) => {
      if (state.role === 'student') {
        showToast(result.success ? result.message : result.error, result.success ? 'success' : 'error');
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Vinculación de controles
  // ---------------------------------------------------------------------------
  function bindControls() {
    // Login / logout
    btnOpenLogin.addEventListener('click', () => {
      loginError.classList.add('hidden');
      loginModal.classList.remove('hidden');
    });
    btnCancelLogin.addEventListener('click', () => loginModal.classList.add('hidden'));
    btnSubmitLogin.addEventListener('click', submitLogin);
    loginPass.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitLogin();
    });
    btnLogout.addEventListener('click', async () => {
      await api.logout();
      switchToStudentView();
    });

    // Estudiante
    btnRaiseHand.addEventListener('click', toggleHand);
    btnSendChat.addEventListener('click', () => sendChatFrom(chatInput));
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendChatFrom(chatInput);
    });
    btnStopShare.addEventListener('click', stopStudentShare);

    // Maestro
    btnRefreshList.addEventListener('click', refreshStudentList);
    btnToggleView.addEventListener('click', () => {
      isGridView = !isGridView;
      btnToggleView.textContent = isGridView ? '⣿ Ver en lista' : '⊞ Ver en grilla';
      renderStudents();
    });
    btnAddDns.addEventListener('click', addDnsDomain);
    dnsInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addDnsDomain();
    });
    btnTeacherSendChat.addEventListener('click', () => sendChatFrom(teacherChatInput));
    teacherChatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendChatFrom(teacherChatInput);
    });

    // Pestañas del Maestro
    tabStudents.addEventListener('click', () => switchTeacherTab('students'));
    tabBroadcast.addEventListener('click', () => switchTeacherTab('broadcast'));

    // Difusión masiva
    btnSelectPaths.addEventListener('click', selectBroadcastPaths);
    btnBroadcastSend.addEventListener('click', sendBroadcast);
    setupDragAndDrop();

    // Visualización en vivo
    btnCloseLive.addEventListener('click', closeLiveView);

    // Gestor de archivos
    btnCloseFiles.addEventListener('click', () => filesModal.classList.add('hidden'));
    btnFilesList.addEventListener('click', () => listRemoteDirectory(filesPath.value.trim()));
    btnFilesUp.addEventListener('click', () => listRemoteDirectory(parentPath(fileManager.currentPath)));
    btnFilesSave.addEventListener('click', saveRemoteFile);
    btnFilesCloseEditor.addEventListener('click', closeFileEditor);
    btnFilesUpload.addEventListener('click', () => uploadFileInput.click());
    uploadFileInput.addEventListener('change', handleUploadFile);
  }

  async function submitLogin() {
    const username = loginUser.value.trim();
    const password = loginPass.value;
    const result = await api.login(username, password);

    if (result && result.success) {
      loginModal.classList.add('hidden');
      loginPass.value = '';
      loginError.classList.add('hidden');
      switchToTeacherView();
    } else {
      loginError.classList.remove('hidden');
    }
  }

  function toggleHand() {
    handRaised = !handRaised;
    btnRaiseHand.classList.toggle('active', handRaised);
    btnRaiseHand.textContent = handRaised ? '🙋 Mano alzada' : '✋ Alzar la mano';
    api.raiseHand(handRaised);
  }

  // ---------------------------------------------------------------------------
  // Inicialización
  // ---------------------------------------------------------------------------
  async function init() {
    bindControls();
    subscribeToEvents();

    const initialState = await api.getInitialState();
    state.instanceId = initialState.instanceId;
    state.hostname = initialState.hostname;
    state.role = initialState.role || 'student';

    hostnameLabel.textContent = `${state.hostname} · ${state.instanceId.slice(0, 8)}`;

    // Renderiza el historial de chat acumulado.
    for (const message of initialState.chatHistory || []) {
      renderChatMessage(message);
    }

    if (state.role === 'teacher') {
      switchToTeacherView();
    } else {
      switchToStudentView();
    }
  }

  window.addEventListener('DOMContentLoaded', init);
})();
