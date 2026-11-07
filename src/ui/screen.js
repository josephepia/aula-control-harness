/**
 * Aula Control — Ventana independiente de visualización de pantalla.
 * Recibe fotogramas en vivo del estudiante y los renderiza en un <img>.
 */
(function () {
  'use strict';

  const api = window.aulaControl;
  const img = document.getElementById('screen-image');
  const status = document.getElementById('screen-status');

  api.on('student-live-frame', (frame) => {
    if (frame && frame.dataUrl) {
      img.src = frame.dataUrl;
      status.classList.add('hidden');
    }
  });

  api.on('screen-capture-error', (payload) => {
    status.textContent = `No se pudo capturar la pantalla: ${(payload && payload.reason) || 'permisos'}`;
    status.classList.remove('hidden');
  });
})();
