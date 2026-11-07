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

  // Streaming WebRTC
  const livePeers = new Map(); // Maestro: studentSocketId -> RTCPeerConnection
  let studentPc = null;        // Estudiante: conexión WebRTC hacia el maestro
  let studentStream = null;    // Estudiante: flujo de pantalla compartida

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
  const chatMessages = $('chat-messages');
  const chatInput = $('chat-input');
  const btnSendChat = $('btn-send-chat');

  const btnRefreshList = $('btn-refresh-list');
  const btnToggleView = $('btn-toggle-view');
  const studentCount = $('student-count');
  const dnsInput = $('dns-input');
  const btnBlockDns = $('btn-block-dns');
  const btnUnblockDns = $('btn-unblock-dns');
  const dnsFeedback = $('dns-feedback');
  const studentsContainer = $('students-container');
  const studentsEmpty = $('students-empty');

  const loginModal = $('login-modal');
  const loginUser = $('login-user');
  const loginPass = $('login-pass');
  const loginError = $('login-error');
  const btnCancelLogin = $('btn-cancel-login');
  const btnSubmitLogin = $('btn-submit-login');

  const liveModal = $('live-modal');
  const liveVideo = $('live-video');
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
    const div = document.createElement('div');
    const isOwn = message.sender === state.hostname;
    div.className = `chat-message${isOwn ? ' own' : ''}`;
    div.innerHTML = `
      <div class="meta">${escapeHtml(message.sender || 'Desconocido')} · ${formatTime(message.timestamp)}</div>
      <div>${escapeHtml(message.text || '')}</div>
    `;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function sendChat() {
    const text = chatInput.value.trim();
    if (!text) return;
    api.sendChat(text);
    chatInput.value = '';
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
  }

  function switchToTeacherView() {
    state.role = 'teacher';
    roleBadge.textContent = 'Maestro';
    roleBadge.className = 'badge badge-teacher';
    studentView.classList.add('hidden');
    teacherView.classList.remove('hidden');
    btnOpenLogin.classList.add('hidden');
    btnLogout.classList.remove('hidden');
    refreshStudentList();
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
        <button class="btn btn-live" data-action="live">🔴 Ver en vivo</button>
        <button class="btn btn-secondary" data-action="files">📁 Archivos</button>
      </div>
    `;

    card.querySelector('[data-action="live"]').addEventListener('click', () => startLiveView(student.socketId));
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
  // Vista maestro: DNS
  // ---------------------------------------------------------------------------
  async function runDnsCommand(action) {
    const domain = dnsInput.value.trim();
    if (!domain) {
      showToast('Escribe un dominio primero.', 'error');
      return;
    }

    const result = await api.dnsCommand(action, domain);
    if (result && result.success) {
      showToast(result.message, 'success');
    } else {
      showToast(result && result.error ? result.error : 'Error al ejecutar la acción.', 'error');
    }
  }

  // ---------------------------------------------------------------------------
  // WebRTC: maestro inicia la visualización en vivo
  // ---------------------------------------------------------------------------
  async function startLiveView(socketId) {
    closeLiveView();

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
      showLiveModal();
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

  function showLiveModal() {
    liveModal.classList.remove('hidden');
  }

  // ---------------------------------------------------------------------------
  // WebRTC: estudiante responde compartiendo su pantalla
  // ---------------------------------------------------------------------------
  async function startStudentShare(offerSdp) {
    await stopStudentShare();

    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    } catch (err) {
      console.error('[ui] El estudiante canceló o no pudo compartir pantalla:', err);
      return;
    }

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

    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.addEventListener('ended', () => stopStudentShare());
    }

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
    if (studentStream) {
      for (const track of studentStream.getTracks()) {
        track.stop();
      }
      studentStream = null;
    }
    sharingBanner.classList.add('hidden');
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
      const icon = entry.isDirectory ? '📁' : '📄';
      li.innerHTML = `<span>${icon}</span><span>${escapeHtml(entry.name)}</span>`;
      li.addEventListener('click', () => {
        const targetPath = joinPath(fileManager.currentPath, entry.name);
        if (entry.isDirectory) {
          listRemoteDirectory(targetPath);
        } else {
          readRemoteFile(targetPath);
        }
      });
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
    btnSendChat.addEventListener('click', sendChat);
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendChat();
    });
    btnStopShare.addEventListener('click', stopStudentShare);

    // Maestro
    btnRefreshList.addEventListener('click', refreshStudentList);
    btnToggleView.addEventListener('click', () => {
      isGridView = !isGridView;
      btnToggleView.textContent = isGridView ? '⣿ Ver en lista' : '⊞ Ver en grilla';
      renderStudents();
    });
    btnBlockDns.addEventListener('click', () => runDnsCommand('block'));
    btnUnblockDns.addEventListener('click', () => runDnsCommand('unblock'));
    dnsInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') runDnsCommand('block');
    });

    // Visualización en vivo
    btnCloseLive.addEventListener('click', closeLiveView);

    // Gestor de archivos
    btnCloseFiles.addEventListener('click', () => filesModal.classList.add('hidden'));
    btnFilesList.addEventListener('click', () => listRemoteDirectory(filesPath.value.trim()));
    btnFilesUp.addEventListener('click', () => listRemoteDirectory(parentPath(fileManager.currentPath)));
    btnFilesSave.addEventListener('click', saveRemoteFile);
    btnFilesCloseEditor.addEventListener('click', closeFileEditor);
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
