// Konfigurasi aplikasi web Firebase dan URL Realtime Database.
// Skema Realtime Database yang digunakan:
// devices/esp32-01/telemetry/{temperature,humidity,timestamp}
// devices/esp32-01/control/{mode,pump}
// devices/esp32-01/status/{online,lastSeen}
// devices/esp32-01/history/{pushId}/{temperature,humidity,pump,timestamp}
const firebaseConfig = {
  apiKey: "AIzaSyAaCPhoQOB-vp5cral9oSDC6FgczGbwkpM",
  authDomain: "tauge-iot.firebaseapp.com",
  databaseURL:
    "https://tauge-iot-default-rtdb.asia-southeast1.firebasedatabase.app/",
  projectId: "tauge-iot",
  storageBucket: "tauge-iot.firebasestorage.app",
  messagingSenderId: "592907465977",
  appId: "1:592907465977:web:639d4414aeabcae7fa9e28",
  measurementId: "G-EX5FNVF0G0",
};
const deviceId = "esp32-01";
const MANUAL_WATERING_COOLDOWN_MS = 3 * 60 * 60 * 1000;
const DEVICE_OFFLINE_AFTER_MS = 45 * 1000;
const TELEMETRY_STALE_AFTER_MS = 60 * 1000;
const paths = {
  telemetry: `devices/${deviceId}/telemetry`,
  control: `devices/${deviceId}/control`,
  status: `devices/${deviceId}/status`,
  history: `devices/${deviceId}/history`,
};
let db = null,
  connected = false,
  mode = "auto",
  autoPaused = true,
  currentPump = false,
  pumpUpdatedAt = null,
  lastWateringStartedAt = 0,
  chartRange = 24,
  chartHoverIndex = null,
  chartPoints = [],
  readings = [],
  knownHistoryEvents = null,
  deviceOnline = false,
  latestStatus = null,
  latestTelemetry = null,
  historyExpanded = false,
  historyCache = {};
const $ = (id) => document.getElementById(id);
const isConfigured = !Object.values(firebaseConfig).some((v) =>
  String(v).includes("GANTI_DENGAN"),
);
const dateText = new Intl.DateTimeFormat("id-ID", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
}).format(new Date());
$("today").textContent = dateText;

function showToast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2600);
}
function formatUptime(seconds) {
  const totalMinutes = Math.floor(Number(seconds || 0) / 60);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  return `${days} hari ${hours} jam ${minutes} menit`;
}
function timestampMs(value) {
  if (value === undefined || value === null || value === "") return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
function renderTelemetry() {
  if (!$('temperature') || !$('humidity')) return;
  const time = timestampMs(latestTelemetry?.timestamp);
  const fresh = deviceOnline && time > 0 && Date.now() - time <= TELEMETRY_STALE_AFTER_MS;
  if (!fresh) {
    $('temperature').innerHTML = '—<small> °C</small>';
    $('humidity').innerHTML = '—<small> %</small>';
    $('temperatureNote').textContent = deviceOnline ? 'Menunggu data sensor terbaru' : 'ESP32 offline';
    $('humidityNote').textContent = deviceOnline ? 'Menunggu data sensor terbaru' : 'ESP32 offline';
    if ($('sensorStatus')) $('sensorStatus').textContent = deviceOnline ? 'Menunggu pembacaan terbaru' : 'Sensor tidak tersedia · ESP32 offline';
    return;
  }
  const temp = Number(latestTelemetry.temperature);
  const hum = Number(latestTelemetry.humidity);
  if (!Number.isFinite(temp) || !Number.isFinite(hum)) return;
  $('temperature').innerHTML = `${temp.toFixed(1)}<small> °C</small>`;
  $('humidity').innerHTML = `${hum.toFixed(1)}<small> %</small>`;
  $('temperatureNote').textContent = `Terakhir diperbarui ${formatTime(latestTelemetry.timestamp)}`;
  $('humidityNote').textContent = `Terakhir diperbarui ${formatTime(latestTelemetry.timestamp)}`;
  if ($('sensorStatus')) $('sensorStatus').textContent = `Suhu ${temp.toFixed(1)} °C · RH ${hum.toFixed(1)} %`;
}
function refreshDeviceStatus() {
  const seenAt = timestampMs(latestStatus?.lastSeen);
  const online = !!latestStatus?.online && seenAt > 0 && Date.now() - seenAt <= DEVICE_OFFLINE_AFTER_MS;
  if (online !== deviceOnline) {
    deviceOnline = online;
    if (!online) {
      readings = [];
      drawChart();
    }
  }
  document.querySelectorAll('.device-mini').forEach((card) => {
    const label = card.querySelector('strong');
    const detail = card.querySelector('p');
    const dot = card.querySelector('.dot');
    if (label) label.textContent = `ESP32 · ${online ? 'Online' : 'Offline'}`;
    if (detail) detail.textContent = online ? 'Terhubung ke Firebase' : 'Tidak terhubung';
    if (dot) dot.classList.toggle('offline', !online);
  });
  if ($('espStatus')) $('espStatus').textContent = online
    ? `Online · ${formatTime(latestStatus.lastSeen)}`
    : 'Offline · tidak ada heartbeat terbaru';
  updateOtaDeviceInfo({ ...(latestStatus || {}), online });
  renderTelemetry();
  setPump(currentPump, pumpUpdatedAt);
}
function updateOtaDeviceInfo(status = {}) {
  if (!$('otaDeviceState')) return;
  const online = !!status.online;
  $('otaDeviceState').textContent = online ? 'Online' : 'Offline / belum terdeteksi';
  $('otaDeviceState').classList.toggle('ota-online', online);
  if (online && status.ip) {
    $('otaDeviceIpSummary').textContent = status.ip;
    $('otaDeviceAddress').value = status.ip;
  } else if (!online) {
    $('otaDeviceIpSummary').textContent = 'Belum terdeteksi';
    $('otaDeviceAddress').value = '';
  }
  if (!online) {
    $('otaDeviceMac').textContent = '—';
    $('otaDeviceUptime').textContent = formatUptime(0);
  } else {
    if (status.mac) $('otaDeviceMac').textContent = status.mac;
    if (Number.isFinite(Number(status.uptimeSeconds))) {
      const lastSeenAt = timestampMs(status.lastSeen);
      const elapsedSinceHeartbeat = lastSeenAt
        ? Math.max(0, Math.floor((Date.now() - lastSeenAt) / 1000))
        : 0;
      $('otaDeviceUptime').textContent = formatUptime(Number(status.uptimeSeconds) + elapsedSinceHeartbeat);
    }
  }
  if (status.firmwareVersion) {
    $('otaCurrentVersion').textContent = `v${status.firmwareVersion}`;
    $('otaCurrentBuild').textContent = 'Versi firmware yang sedang berjalan';
  }
}
function setupOtaSettings() {
  const fileInput = $('otaFirmwareFile');
  if (!fileInput) return;
  const dropzone = $('otaDropzone');
  const uploadButton = $('otaStartButton');
  let selectedFile = null;

  function log(message, type = 'info') {
    const output = $('otaLogOutput');
    const row = document.createElement('div');
    const time = document.createElement('time');
    const label = document.createElement('span');
    const text = document.createElement('p');
    time.textContent = new Intl.DateTimeFormat('id-ID', {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).format(new Date());
    label.className = `log-${type}`;
    label.textContent = `[${type.toUpperCase()}]`;
    text.textContent = message;
    row.append(time, label, text);
    output.appendChild(row);
    output.scrollTop = output.scrollHeight;
    while (output.children.length > 80) output.firstElementChild.remove();
  }

  function updateReadyState() {
    uploadButton.disabled = !selectedFile ||
      !$('otaDeviceAddress').value.trim() ||
      !$('otaPassword').value;
  }

  function setStep(activeStep, completedThrough = 0) {
    document.querySelectorAll('[data-ota-step]').forEach((item) => {
      const number = Number(item.dataset.otaStep);
      item.classList.toggle('done', number <= completedThrough);
      item.classList.toggle('active', number === activeStep);
      item.querySelector('small').textContent = number <= completedThrough
        ? 'Selesai'
        : number === activeStep ? 'Berlangsung' : 'Menunggu';
    });
  }

  function setProgress(percent, status) {
    const safePercent = Math.max(0, Math.min(100, percent));
    $('otaProgressBar').style.width = `${safePercent}%`;
    $('otaProgressPercent').textContent = `${Math.round(safePercent)}%`;
    $('otaProgressStatus').textContent = status;
  }

  function chooseFile(file) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.bin') || file.size === 0) {
      selectedFile = null;
      $('otaFileSummary').hidden = true;
      $('otaUploadMessage').textContent = 'File harus berupa firmware .bin yang tidak kosong.';
      $('otaStatusTitle').textContent = 'File tidak valid';
      $('otaStatusDetail').textContent = 'Pilih hasil Export Compiled Binary dari Arduino IDE.';
      setStep(1);
      updateReadyState();
      log(`File ditolak: ${file.name}`, 'error');
      return;
    }
    selectedFile = file;
    $('otaFileName').textContent = file.name;
    $('otaFileSize').textContent = `${(file.size / 1024 / 1024).toFixed(2)} MB`;
    $('otaSelectedVersion').textContent = file.name.replace(/\.bin$/i, '');
    $('otaSelectedBuild').textContent = `File siap · ${(file.size / 1024 / 1024).toFixed(2)} MB`;
    $('otaFileSummary').hidden = false;
    $('otaUploadMessage').textContent = 'File dipilih. Pastikan alamat ESP32 dan kata sandi OTA sudah benar.';
    $('otaProgressCaption').textContent = 'File siap divalidasi';
    $('otaStatusTitle').textContent = 'Firmware siap diunggah';
    $('otaStatusDetail').textContent = 'Upload hanya dapat dilakukan saat pompa mati dan ESP32 satu jaringan.';
    setStep(3, 2);
    setProgress(0, 'Siap dimulai');
    updateReadyState();
    log(`File dipilih: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);
  }

  function getDeviceBaseUrl() {
    const address = $('otaDeviceAddress').value.trim()
      .replace(/^https?:\/\//i, '').replace(/\/$/, '');
    return address ? `http://${address}` : '';
  }

  fileInput.addEventListener('change', () => chooseFile(fileInput.files[0]));
  $('otaChooseFile').addEventListener('click', (event) => {
    event.stopPropagation();
    fileInput.click();
  });
  $('otaRemoveFile').addEventListener('click', () => {
    selectedFile = null;
    fileInput.value = '';
    $('otaFileSummary').hidden = true;
    $('otaSelectedVersion').textContent = 'Belum ada file';
    $('otaSelectedBuild').textContent = 'Pilih file firmware berekstensi .bin';
    $('otaUploadMessage').textContent = 'Pilih file .bin dan sambungkan ke ESP32 untuk memulai.';
    setStep(1);
    setProgress(0, 'Belum dimulai');
    updateReadyState();
  });
  dropzone.addEventListener('click', (event) => {
    if (event.target !== $('otaChooseFile')) fileInput.click();
  });
  dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      fileInput.click();
    }
  });
  ['dragenter', 'dragover'].forEach((name) => dropzone.addEventListener(name, (event) => {
    event.preventDefault();
    dropzone.classList.add('drag-over');
  }));
  ['dragleave', 'drop'].forEach((name) => dropzone.addEventListener(name, (event) => {
    event.preventDefault();
    dropzone.classList.remove('drag-over');
  }));
  dropzone.addEventListener('drop', (event) => chooseFile(event.dataTransfer.files[0]));
  $('otaDeviceAddress').addEventListener('input', updateReadyState);
  $('otaPassword').addEventListener('input', updateReadyState);

  $('otaDetectButton').addEventListener('click', async () => {
    const baseUrl = getDeviceBaseUrl();
    if (!baseUrl) {
      $('otaUploadMessage').textContent = 'Masukkan alamat IP ESP32 terlebih dahulu.';
      return;
    }
    $('otaDeviceState').textContent = 'Menghubungkan…';
    log(`Mendeteksi ESP32 di ${baseUrl}`);
    try {
      const response = await fetch(`${baseUrl}/ota/info`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const info = await response.json();
      updateOtaDeviceInfo({ ...info, online: true });
      $('otaDeviceState').textContent = 'Online';
      $('otaUploadMessage').textContent = 'ESP32 terdeteksi dan siap menerima update.';
      $('otaStatusTitle').textContent = 'ESP32 terhubung';
      $('otaStatusDetail').textContent = `Firmware saat ini v${info.firmwareVersion || '—'} · ${info.ip || baseUrl}`;
      log(`ESP32 terhubung · versi ${info.firmwareVersion || 'tidak diketahui'}`);
    } catch (error) {
      $('otaDeviceState').textContent = 'Tidak terjangkau';
      $('otaUploadMessage').textContent = 'ESP32 tidak terjangkau. Pastikan satu Wi-Fi, IP benar, dan firmware OTA sudah terpasang.';
      $('otaStatusTitle').textContent = 'ESP32 tidak terdeteksi';
      $('otaStatusDetail').textContent = 'Periksa jaringan, alamat IP, dan izin jaringan lokal browser.';
      log(`Deteksi gagal: ${error.message}`, 'error');
    }
    updateReadyState();
  });

  uploadButton.addEventListener('click', () => {
    if (!selectedFile) return;
    const baseUrl = getDeviceBaseUrl();
    if (!baseUrl) return;
    uploadButton.disabled = true;
    $('otaProgressCaption').textContent = 'Mengirim firmware ke ESP32';
    $('otaUploadMessage').textContent = 'Proses update berjalan. Jangan tutup halaman atau matikan ESP32.';
    $('otaStatusTitle').textContent = 'Sedang mengunggah firmware…';
    $('otaStatusDetail').textContent = 'Pompa tetap dalam keadaan mati selama pembaruan.';
    setStep(3, 2);
    setProgress(0, 'Mengunggah');
    log(`Memulai upload ke ${baseUrl}`);

    const request = new XMLHttpRequest();
    request.open('POST', `${baseUrl}/ota/update`);
    request.timeout = 120000;
    request.setRequestHeader('X-OTA-Password', $('otaPassword').value);
    request.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable) return;
      const percent = (event.loaded / event.total) * 94;
      setProgress(percent, `Mengunggah ${(event.loaded / 1024 / 1024).toFixed(2)} MB`);
    });
    request.addEventListener('load', () => {
      if (request.status >= 200 && request.status < 300) {
        setStep(4, 3);
        setProgress(100, 'Upload selesai · menunggu restart');
        $('otaProgressCaption').textContent = 'Firmware berhasil dikirim';
        $('otaUploadMessage').textContent = 'ESP32 akan restart. Tunggu hingga terhubung kembali ke Firebase.';
        $('otaStatusTitle').textContent = 'Update berhasil · ESP32 restart';
        $('otaStatusDetail').textContent = 'Dashboard akan menampilkan status perangkat setelah ESP32 tersambung kembali.';
        $('otaDeviceState').textContent = 'Sedang restart';
        log('Firmware valid. ESP32 akan restart.', 'info');
        showToast('Firmware berhasil diunggah. ESP32 sedang restart.');
      } else {
        let reason = `HTTP ${request.status}`;
        try { reason = JSON.parse(request.responseText).error || reason; } catch (_) {}
        const messages = {
          unauthorized: 'Kata sandi OTA salah.',
          'password-not-configured': 'Atur kata sandi OTA di firebase_secrets.h lalu unggah firmware lewat USB.',
          'pump-running': 'Matikan pompa sebelum memulai update firmware.',
          'validation-failed': 'File tidak cocok atau firmware tidak valid untuk partisi ESP32 ini.',
        };
        $('otaUploadMessage').textContent = messages[reason] || `Update gagal (${reason}).`;
        $('otaStatusTitle').textContent = 'Update gagal';
        $('otaStatusDetail').textContent = messages[reason] || 'Periksa file firmware dan koneksi ESP32.';
        $('otaProgressCaption').textContent = 'Pembaruan gagal';
        setProgress(0, 'Gagal');
        setStep(3, 2);
        uploadButton.disabled = false;
        log(`Update gagal: ${messages[reason] || reason}`, 'error');
        showToast(messages[reason] || 'Update firmware gagal.');
      }
    });
    request.addEventListener('error', () => {
      const message = 'Koneksi ke ESP32 gagal atau diblokir browser. Pastikan satu jaringan Wi-Fi dan izinkan akses jaringan lokal.';
      $('otaUploadMessage').textContent = message;
      $('otaStatusTitle').textContent = 'Tidak dapat menghubungi ESP32';
      $('otaStatusDetail').textContent = 'Pastikan IP benar dan firmware OTA sudah terpasang.';
      $('otaProgressCaption').textContent = 'Koneksi gagal';
      setProgress(0, 'Gagal');
      setStep(3, 2);
      uploadButton.disabled = false;
      log(message, 'error');
      showToast('Tidak dapat terhubung ke ESP32.');
    });
    request.addEventListener('timeout', () => {
      $('otaUploadMessage').textContent = 'Waktu unggah habis. Periksa koneksi dan kondisi ESP32.';
      $('otaStatusTitle').textContent = 'Waktu unggah habis';
      $('otaProgressCaption').textContent = 'Koneksi timeout';
      setStep(3, 2);
      uploadButton.disabled = false;
      log('Upload dihentikan karena timeout.', 'error');
    });
    const formData = new FormData();
    formData.append('firmware', selectedFile, selectedFile.name);
    request.send(formData);
  });

  $('otaClearLog').addEventListener('click', () => {
    $('otaLogOutput').replaceChildren();
    log('Log dibersihkan.');
  });
  updateReadyState();
}
function createAuthGate() {
  if ($("firebaseAuthGate")) return;
  const gate = document.createElement("section");
  gate.className = "auth-gate";
  gate.id = "firebaseAuthGate";
  gate.hidden = true;
  gate.innerHTML = `
    <div class="auth-card">
      <div class="auth-brand-mark">↟</div>
      <p class="eyebrow">Tauge IoT · Smart growing system</p>
      <h2>Masuk ke dashboard</h2>
      <p class="auth-description">Gunakan akun Firebase yang sudah didaftarkan untuk memantau sensor dan mengontrol penyiraman.</p>
      <form id="firebaseLoginForm" class="auth-form">
        <label for="firebaseEmail">Email</label>
        <input id="firebaseEmail" name="email" type="email" autocomplete="username" required>
        <label for="firebasePassword">Kata sandi</label>
        <input id="firebasePassword" name="password" type="password" autocomplete="current-password" required>
        <p class="auth-error" id="firebaseLoginError" role="alert" hidden></p>
        <button class="auth-submit" id="firebaseLoginButton" type="submit">Masuk</button>
      </form>
      <p class="auth-footnote">Akses dilindungi oleh autentikasi Firebase.</p>
    </div>`;
  document.body.appendChild(gate);

  $("firebaseLoginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("firebaseLoginButton");
    const errorBox = $("firebaseLoginError");
    errorBox.hidden = true;
    button.disabled = true;
    button.textContent = "Menghubungkan…";
    try {
      await firebase.auth().setPersistence(firebase.auth.Auth.Persistence.LOCAL);
      await firebase
        .auth()
        .signInWithEmailAndPassword($("firebaseEmail").value.trim(), $("firebasePassword").value);
    } catch (error) {
      console.error("Firebase sign-in failed:", error);
      errorBox.textContent =
        error.code === "auth/invalid-credential" || error.code === "auth/wrong-password"
          ? "Email atau kata sandi tidak cocok."
          : error.code === "auth/too-many-requests"
            ? "Terlalu banyak percobaan. Tunggu sebentar lalu coba lagi."
            : "Login gagal. Periksa akun dan pengaturan Firebase Authentication.";
      errorBox.hidden = false;
      button.disabled = false;
      button.textContent = "Masuk";
    }
  });
}

function addSignOutButton() {
  if ($("firebaseSignOut")) return;
  const button = document.createElement("button");
  button.className = "auth-signout";
  button.id = "firebaseSignOut";
  button.type = "button";
  button.textContent = "Keluar";
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await firebase.auth().signOut();
      window.location.reload();
    } catch (error) {
      console.error("Firebase sign-out failed:", error);
      showToast("Tidak bisa keluar dari akun Firebase.");
      button.disabled = false;
    }
  });
  $("refreshBtn").insertAdjacentElement("beforebegin", button);
}
function setPump(value, timestamp) {
  currentPump = !!value;
  if (timestamp !== undefined && timestamp !== null) pumpUpdatedAt = timestamp;
  // Older firmware may not yet write explicit pump history events. The
  // control node's updatedAt still gives us the time of the start command.
  if (currentPump && Number(timestamp) > 0) {
    lastWateringStartedAt = Math.max(lastWateringStartedAt, Number(timestamp));
  }
  $("pumpValue").textContent = deviceOnline ? (currentPump ? "Menyala" : "Mati") : "Offline";
  $("pumpTag").textContent = deviceOnline ? (currentPump ? "AKTIF" : "SIAGA") : "OFFLINE";
  $("pumpTag").style.color = deviceOnline ? (currentPump ? "#26734a" : "#758078") : "#c45252";
  $("pumpDot").style.background = !deviceOnline ? "#c45252" : currentPump ? "#d8883c" : "#48a96c";
  $("pumpUpdated").textContent = !deviceOnline
    ? "Status pompa tidak tersedia"
    : pumpUpdatedAt
      ? `Diperbarui ${formatTime(pumpUpdatedAt)}`
      : "Status dari Firebase";
  $("relayStatus").textContent = !deviceOnline
    ? "Status pompa tidak tersedia"
    : currentPump ? "Pompa menyala" : "Pompa mati";
  updateAction();
}
function formatTime(value) {
  const d = typeof value === "number" ? new Date(value) : new Date(value);
  return isNaN(d)
    ? "—"
    : new Intl.DateTimeFormat("id-ID", {
        hour: "2-digit",
        minute: "2-digit",
        day: "2-digit",
        month: "short",
      }).format(d);
}
function rememberReading(value) {
  const timestamp = Number(value.timestamp) || Date.now();
  const reading = {
    temperature: Number(value.temperature),
    humidity: Number(value.humidity),
    timestamp,
  };
  if (!Number.isFinite(reading.temperature) || !Number.isFinite(reading.humidity)) return;
  const existing = readings.findIndex((item) => item.timestamp === timestamp);
  if (existing >= 0) readings[existing] = reading;
  else readings.push(reading);
  readings.sort((a, b) => a.timestamp - b.timestamp);
  readings = readings.slice(-5000);
}
function updateAction() {
  const auto = mode === "auto";
  $("modeDescription").textContent = auto
    ? "Dikendalikan otomatis oleh ESP32"
    : "Kontrol pompa secara manual";
  $("modeNote").textContent = auto
    ? autoPaused
      ? "Jadwal otomatis belum berjalan atau sedang dijeda. Klik tombol untuk memulai atau melanjutkan jadwal."
      : "ESP32 menyiram otomatis setiap 4 jam. Pompa menyala selama 10 detik per siklus."
    : "Mode manual mengirim perintah ke ESP32. Pompa menyala maksimal 10 detik.";
  $("pumpAction").textContent = auto
    ? autoPaused
      ? "Mulai penyiraman otomatis"
      : "Jeda jadwal otomatis"
    : currentPump
      ? "Matikan pompa"
      : "Nyalakan pompa";
  $("pumpAction").disabled = !connected || !deviceOnline;
  if (!deviceOnline) $("pumpAction").textContent = "ESP32 offline";
}

function drawChart() {
  const canvas = $("sensorChart"),
    rect = canvas.getBoundingClientRect(),
    dpr = window.devicePixelRatio || 1;
  if (!rect.width || !rect.height) return;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const c = canvas.getContext("2d");
  c.scale(dpr, dpr);
  const w = rect.width,
    h = rect.height,
    p = { l: 34, r: 36, t: 14, b: 28 },
    cw = w - p.l - p.r,
    ch = h - p.t - p.b;
  if (cw <= 0 || ch <= 0) return;
  c.clearRect(0, 0, w, h);
  c.font = "11px system-ui, sans-serif";
  c.textBaseline = "middle";

  // Sumbu kiri menunjukkan suhu (0–60 °C), sumbu kanan kelembapan (0–100%).
  for (let i = 0; i <= 4; i++) {
    const y = p.t + (ch * i) / 4;
    c.strokeStyle = i === 4 ? "#dfe7e0" : "#e9eeea";
    c.beginPath();
    c.moveTo(p.l, y);
    c.lineTo(w - p.r, y);
    c.stroke();
    c.fillStyle = "#26734a";
    c.textAlign = "right";
    c.fillText(String(60 - i * 15), p.l - 9, y);
    c.fillStyle = "#559fbd";
    c.textAlign = "left";
    c.fillText(String(100 - i * 25), w - p.r + 9, y);
  }

  const now = Date.now();
  const rangeMs = (chartRange === 7 ? 7 * 24 : 24) * 60 * 60 * 1000;
  const filterStart = now - rangeMs;
  const vals = readings.filter((reading) => reading.timestamp >= filterStart && reading.timestamp <= now);
  const data = vals;
  // Zoom to the timestamps we actually have so a few fresh readings don't
  // collapse into a tiny cluster at the edge of a 24-hour/7-day axis.
  const firstTimestamp = Number(data[0]?.timestamp) || now;
  const lastTimestamp = Number(data.at(-1)?.timestamp) || now;
  let chartStart = firstTimestamp;
  let chartEnd = lastTimestamp;
  if (chartEnd - chartStart < 60_000) {
    chartStart -= 30_000;
    chartEnd += 30_000;
  }
  const chartDuration = chartEnd - chartStart;
  chartPoints = data.map((value, index) => ({
    index,
    value,
    x: p.l + (data.length === 1
      ? cw
      : cw * Math.max(0, Math.min(1, ((Number(value.timestamp) || now) - chartStart) / chartDuration))),
    yTemperature: p.t + ch * (1 - Math.max(0, Math.min(60, Number(value.temperature))) / 60),
    yHumidity: p.t + ch * (1 - Math.max(0, Math.min(100, Number(value.humidity))) / 100),
  }));

  function drawSeries(key, color, maxValue) {
    const yKey = key === "temperature" ? "yTemperature" : "yHumidity";
    const points = chartPoints
      .map((point) => ({ x: point.x, y: point[yKey] }))
      .filter((point) => Number.isFinite(point.y));
    if (!points.length) return;

    c.beginPath();
    c.moveTo(points[0].x, points[0].y);
    if (points.length === 2) {
      c.lineTo(points[1].x, points[1].y);
    } else if (points.length > 2) {
      // Quadratic segments keep each control point between adjacent x values,
      // avoiding the loops that non-uniform Bézier control points can create.
      for (let i = 1; i < points.length - 1; i++) {
        const current = points[i];
        const next = points[i + 1];
        const midpointX = (current.x + next.x) / 2;
        const midpointY = (current.y + next.y) / 2;
        c.quadraticCurveTo(current.x, current.y, midpointX, midpointY);
      }
      const last = points.at(-1);
      c.quadraticCurveTo(last.x, last.y, last.x, last.y);
    }
    c.strokeStyle = color;
    c.lineWidth = 2.2;
    c.lineJoin = "round";
    c.lineCap = "round";
    c.stroke();

    // Keep a single marker at the latest point so the series stays clean.
    const latest = points.at(-1);
    if (latest) {
      c.beginPath();
      c.arc(latest.x, latest.y, 4.5, 0, Math.PI * 2);
      c.fillStyle = color;
      c.fill();
      c.lineWidth = 1.5;
      c.strokeStyle = "#fff";
      c.stroke();
    }
  }

  drawSeries("temperature", "#26734a", 60);
  drawSeries("humidity", "#69b6d4", 100);

  if (chartHoverIndex !== null && chartPoints[chartHoverIndex]) {
    const point = chartPoints[chartHoverIndex];
    c.save();
    c.beginPath();
    c.setLineDash([4, 4]);
    c.strokeStyle = "#9aa9a0";
    c.lineWidth = 1;
    c.moveTo(point.x, p.t);
    c.lineTo(point.x, p.t + ch);
    c.stroke();
    c.setLineDash([]);
    [
      [point.yTemperature, "#26734a"],
      [point.yHumidity, "#69b6d4"],
    ].forEach(([y, color]) => {
      c.beginPath();
      c.arc(point.x, y, 5, 0, Math.PI * 2);
      c.fillStyle = "#fff";
      c.fill();
      c.lineWidth = 2;
      c.strokeStyle = color;
      c.stroke();
      c.beginPath();
      c.arc(point.x, y, 2.5, 0, Math.PI * 2);
      c.fillStyle = color;
      c.fill();
    });
    c.restore();
    updateChartTooltip(chartHoverIndex);
  }

  for (let i = 0; i < 4; i++) {
    const x = p.l + (cw * i) / 3;
    const date = new Date(chartStart + (chartDuration * i) / 3);
    const label = chartRange === 24
      ? new Intl.DateTimeFormat("id-ID", { hour: "2-digit", minute: "2-digit" }).format(date)
      : new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short" }).format(date);
    c.fillStyle = "#849087";
    c.textBaseline = "top";
    c.textAlign = i === 0 ? "left" : i === 3 ? "right" : "center";
    c.fillText(label, x, h - 17, Math.max(30, cw / 3));
  }
}
function updateChartTooltip(index) {
  const tooltip = $("chartTooltip");
  const wrap = document.querySelector(".chart-wrap");
  const point = chartPoints[index];
  if (!tooltip || !wrap || !point) return;

  const time = new Intl.DateTimeFormat("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(Number(point.value.timestamp) || Date.now()));
  tooltip.innerHTML = `
    <strong class="chart-tooltip-time">${time}</strong>
    <span><i class="temperature-dot"></i><span>Suhu</span><b>${Number(point.value.temperature).toFixed(1)} °C</b></span>
    <span><i class="humidity-dot"></i><span>Kelembapan</span><b>${Number(point.value.humidity).toFixed(1)}%</b></span>`;
  tooltip.hidden = false;
  const left = Math.min(
    Math.max(8, point.x + 12),
    Math.max(8, wrap.clientWidth - tooltip.offsetWidth - 8),
  );
  tooltip.style.left = `${left}px`;
  tooltip.style.top = "8px";
}
function setupChartInteraction() {
  const canvas = $("sensorChart");
  if (!canvas) return;
  const wrap = canvas.closest(".chart-wrap");
  const tooltip = document.createElement("div");
  tooltip.className = "chart-tooltip";
  tooltip.id = "chartTooltip";
  tooltip.hidden = true;
  tooltip.setAttribute("role", "status");
  wrap.appendChild(tooltip);

  canvas.addEventListener("pointermove", (event) => {
    if (!chartPoints.length) return;
    const x = event.clientX - canvas.getBoundingClientRect().left;
    let closestIndex = 0;
    let closestDistance = Infinity;
    chartPoints.forEach((point, index) => {
      const distance = Math.abs(point.x - x);
      if (distance < closestDistance) {
        closestDistance = distance;
        closestIndex = index;
      }
    });
    chartHoverIndex = closestIndex;
    drawChart();
  });
  canvas.addEventListener("pointerleave", () => {
    chartHoverIndex = null;
    tooltip.hidden = true;
    drawChart();
  });
}
function renderHistory(list) {
  const showAllHistory = document.body.classList.contains("page-history");
  historyCache = list || {};
  const allRows = Object.values(list || {}).sort(
    (a, b) => (b.timestamp || 0) - (a.timestamp || 0),
  );
  const seenRows = new Set();
  const uniqueRows = allRows.filter((row) => {
    const minute = Math.floor(timestampMs(row.timestamp) / 60000);
    const key = [
      minute,
      Number(row.temperature ?? 0).toFixed(1),
      Number(row.humidity ?? 0).toFixed(1),
      Boolean(row.pump),
    ].join("|");
    if (seenRows.has(key)) return false;
    seenRows.add(key);
    return true;
  });
  const rows = showAllHistory
    ? (historyExpanded ? uniqueRows : uniqueRows.slice(0, 10))
    : uniqueRows.slice(0, 6);
  $("historyRows").innerHTML = rows.length
    ? rows
        .map(
          (x) =>
            `<tr><td>${formatTime(x.timestamp)}</td><td>${Number(x.temperature ?? 0).toFixed(1)} °C</td><td>${Number(x.humidity ?? 0).toFixed(1)} %</td><td><span class="state" style="${x.pump ? "color:#b66a2c;background:#fff3e7" : ""}">${x.pump ? "Menyala" : "Mati"}</span></td></tr>`,
        )
        .join("")
    : '<tr><td colspan="4" class="empty">Belum ada catatan aktivitas.</td></tr>';
  const moreButton = $("historyShowMore");
  if (moreButton) {
    moreButton.hidden = !showAllHistory || uniqueRows.length <= 10;
    moreButton.textContent = historyExpanded
      ? "Tampilkan lebih sedikit"
      : "Tampilkan lebih banyak";
  }
}
function connectRealtimeDatabase() {
  if (window.databaseListenersAttached) return;
  window.databaseListenersAttached = true;
  db = firebase.database();
  const handleReadError = (error) => {
    console.error("Firebase Database read failed:", error);
    $("connectionText").textContent = "Firebase · akses ditolak";
    showToast("Firebase menolak akses. Periksa Rules Realtime Database.");
  };
  $("connectionText").textContent = "Firebase · Menghubungkan";
  $("pumpAction").textContent = "Menghubungkan…";
  db.ref(".info/connected").on("value", (s) => {
    connected = !!s.val();
    $("connectionText").textContent = connected
      ? "Firebase · Terhubung"
      : "Firebase · Terputus";
    $("connectionText").parentElement.style.color = connected
      ? "#26734a"
      : "#c45252";
    updateAction();
  });
  db.ref(paths.telemetry).on("value", (s) => {
    const v = s.val();
    latestTelemetry = v || null;
    if (v) {
      const temp = Number(v.temperature), hum = Number(v.humidity);
      if (Number.isFinite(temp) && Number.isFinite(hum)) {
        rememberReading({ temperature: temp, humidity: hum, timestamp: v.timestamp });
      }
    }
    renderTelemetry();
    drawChart();
  }, handleReadError);
  db.ref(paths.control).on("value", (s) => {
    const v = s.val() || {};
    mode = v.mode || "auto";
    autoPaused = v.autoPaused === undefined ? true : !!v.autoPaused;
    currentPump = !!v.pump;
    document.querySelectorAll("[data-mode]").forEach((b) =>
      b.classList.toggle("selected", b.dataset.mode === mode),
    );
    setPump(currentPump, v.updatedAt);
    updateAction();
  }, handleReadError);
  db.ref(paths.status).on("value", (s) => {
    latestStatus = s.val() || {};
    refreshDeviceStatus();
  }, handleReadError);
  refreshDeviceStatus();
  setInterval(refreshDeviceStatus, 1000);
  const historyRef = db.ref(paths.history);
  const historyQuery = document.body.classList.contains("page-history")
    ? historyRef
    : historyRef.limitToLast(5000);
  historyQuery.on("value", (s) => {
    const history = s.val() || {};
    const eventIds = Object.keys(history);
    Object.values(history).forEach((event) => {
      if (event.event === "pump" && event.pump === true) {
        lastWateringStartedAt = Math.max(lastWateringStartedAt, Number(event.timestamp) || 0);
      }
    });
    if (knownHistoryEvents === null) {
      knownHistoryEvents = new Set(eventIds);
    } else {
      const newEvents = eventIds
        .filter((id) => !knownHistoryEvents.has(id))
        .map((id) => ({ id, ...history[id] }))
        .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
      eventIds.forEach((id) => knownHistoryEvents.add(id));
      const pumpEvent = newEvents.filter((event) => event.event === "pump").at(-1);
      if (pumpEvent) {
        const automatic = pumpEvent.mode === "auto";
        showToast(pumpEvent.pump
          ? automatic ? "Penyiraman otomatis dimulai" : "Pompa dinyalakan secara manual"
          : automatic ? "Penyiraman selesai. Pompa berhenti menunggu jadwal berikutnya" : "Pompa dimatikan secara manual");
      }
    }
    Object.values(history).forEach(rememberReading);
    drawChart();
    renderHistory(history);
  }, handleReadError);
}

function connectFirebase() {
  if (!isConfigured) {
    drawChart();
    return;
  }
  try {
    firebase.initializeApp(firebaseConfig);
    const auth = firebase.auth();
    const observeAuthState = () => {
      $("connectionText").textContent = "Firebase - Menyiapkan akses tamu";
      auth.onAuthStateChanged((user) => {
        if (user) {
          connectRealtimeDatabase();
          return;
        }

        connected = false;
        updateAction();
        $("connectionText").textContent = "Firebase - Masuk sebagai tamu";
        auth.signInAnonymously().catch((error) => {
          console.error("Firebase anonymous sign-in failed:", error);
          $("connectionText").textContent = "Firebase - Akses tamu gagal";
          showToast("Aktifkan Anonymous pada Firebase Authentication agar dashboard dapat dibuka tanpa login.");
        });
      }, (error) => {
        console.error("Firebase Auth state error:", error);
        $("connectionText").textContent = "Firebase - Auth gagal";
      });
    };

    auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL)
      .then(observeAuthState)
      .catch((error) => {
        console.warn("Local Firebase Auth persistence unavailable:", error);
        observeAuthState();
      });
  } catch (error) {
    console.error(error);
    showToast("Gagal menghubungkan Firebase. Periksa konfigurasi.");
  }
}
async function changeMode(next) {
  mode = next;
  document
    .querySelectorAll("[data-mode]")
    .forEach((b) => b.classList.toggle("selected", b.dataset.mode === mode));
  updateAction();
  if (!connected) return;
  try {
    await db
      .ref(paths.control)
      .update({ mode, updatedAt: firebase.database.ServerValue.TIMESTAMP });
  } catch (e) {
    showToast("Tidak bisa memperbarui mode. Periksa akses database.");
  }
}
async function togglePump() {
  if (!connected || mode !== "manual") return;
  // Capture the requested state before Firebase's realtime listener updates
  // currentPump; otherwise the toast can describe the opposite action.
  const requestedPump = !currentPump;
  if (requestedPump && lastWateringStartedAt) {
    const remainingMs = MANUAL_WATERING_COOLDOWN_MS - (Date.now() - lastWateringStartedAt);
    if (remainingMs > 0) {
      const remainingMinutes = Math.ceil(remainingMs / 60000);
      showToast(`Jeda penyiraman belum terpenuhi. Tunggu sekitar ${remainingMinutes} menit lagi.`);
      return;
    }
  }
  try {
    await db
      .ref(paths.control)
      .update({
        pump: requestedPump,
        updatedAt: firebase.database.ServerValue.TIMESTAMP,
      });
    showToast(
      requestedPump
        ? "Perintah menyalakan pompa dikirim"
        : "Perintah mematikan pompa dikirim",
    );
  } catch (e) {
    console.error("Failed to write pump control:", e);
    showToast("Perintah gagal dikirim ke Firebase");
  }
}
async function toggleAutomaticSchedule() {
  if (!connected || mode !== "auto") return;
  const nextPaused = !autoPaused;
  try {
    await db.ref(paths.control).update({
      autoPaused: nextPaused,
      updatedAt: firebase.database.ServerValue.TIMESTAMP,
    });
    autoPaused = nextPaused;
    updateAction();
    showToast(nextPaused ? "Jadwal otomatis dijeda" : "Jadwal otomatis dilanjutkan");
  } catch (error) {
    console.error("Failed to toggle automatic schedule:", error);
    showToast("Tidak bisa mengubah jadwal otomatis");
  }
}
function handlePumpAction() {
  if (mode === "auto") {
    toggleAutomaticSchedule();
  } else {
    togglePump();
  }
}
document
  .querySelectorAll("[data-mode]")
  .forEach((b) =>
    b.addEventListener("click", () => changeMode(b.dataset.mode)),
  );
$("pumpAction").addEventListener("click", handlePumpAction);
$("historyShowMore")?.addEventListener("click", () => {
  historyExpanded = !historyExpanded;
  renderHistory(historyCache);
});
document.querySelectorAll("[data-range]").forEach((b) =>
  b.addEventListener("click", () => {
    chartRange = Number(b.dataset.range);
    document
      .querySelectorAll("[data-range]")
      .forEach((x) => x.classList.toggle("selected", x === b));
    drawChart();
  }),
);
$("refreshBtn").addEventListener("click", () => {
  if (db) {
    db.ref(paths.telemetry)
      .once("value")
      .then(() => showToast("Data diperbarui"));
  } else showToast("Atur konfigurasi Firebase untuk memuat data perangkat");
});
window.addEventListener("resize", drawChart);
setupOtaSettings();
setupChartInteraction();
refreshDeviceStatus();
connectFirebase();
drawChart();
